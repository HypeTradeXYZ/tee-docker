import { Injectable } from '@nestjs/common';
import { newMnemonic, PasswordPolicy, type Account, type Wallet } from 'wative-core';
import { TeeError } from '../common/tee-error';
import type { Tenant } from '../config/schemas';
import { ServiceStateService } from '../config/service-state.service';
import { SessionRegistry, type Session } from './session.registry';
import { normalizeAccountDisplayName } from './account-display-name';
import { hasDamagedAccounts } from './damaged-accounts';

const ACCOUNT_PASSWORD_POLICY = new PasswordPolicy();

export interface CreateAccountInput {
  displayName: string;
  kind: 'HD' | 'PK';
  /** Mnemonic (HD) or private key (PK). Generated for HD when absent. */
  secret?: string;
  defaultNetwork?: string;
  /** DESIGN §3's Cold Vault tier: the account locks separately from the session. */
  hasOwnPassword?: boolean;
  /** Required when hasOwnPassword is set. */
  accountPassword?: string;
}

@Injectable()
export class AccountsService {
  constructor(
    private readonly sessions: SessionRegistry,
    private readonly state: ServiceStateService,
  ) {}

  async create(session: Session, tenant: Tenant, input: CreateAccountInput): Promise<Account> {
    const displayName = await normalizeAccountDisplayName(input.displayName);
    if (input.kind === 'PK' && !input.secret) {
      throw new TeeError('TEE_INVALID_BODY', 'a PK account requires a private key');
    }
    // Without a distinct password the flag would grant nothing: the account
    // would be "separately locked" by the very secret that opened the session.
    if (input.hasOwnPassword === true && !input.accountPassword) {
      throw new TeeError('TEE_INVALID_BODY', 'hasOwnPassword requires accountPassword');
    }
    // The same policy the workspace tier enforces. Without it the Cold Vault's
    // only secret could be one character, while the password guarding the
    // workspace around it could not.
    if (input.accountPassword !== undefined) {
      ACCOUNT_PASSWORD_POLICY.enforce(input.accountPassword);
    }
    if (input.hasOwnPassword !== true && input.accountPassword !== undefined) {
      throw new TeeError('TEE_INVALID_BODY', 'accountPassword requires hasOwnPassword');
    }

    return this.mutateWalletIncrease(
      session,
      tenant,
      1,
      async () => {
        // Generate sensitive entropy only after persisted quota admission.
        const secret = input.secret ?? newMnemonic();
        // Always passed explicitly: wative-core defaults it to TRUE, so
        // omitting it would silently give every account its own password and
        // break the session model. See DESIGN.md §3.
        const ownPassword = input.hasOwnPassword === true;
        const account = await session.handle.accounts.create(
          displayName,
          ownPassword ? input.accountPassword! : session.password,
          secret,
          input.defaultNetwork,
          { kind: input.kind, hasOwnPassword: ownPassword },
        );
        // Creating a Cold Vault account is not unlocking it. Recording an
        // exposure episode here would hand the account to every lease on this
        // session — requireAccount returns a live-custody account before it
        // reaches the hasOwnPassword gate — for the whole account TTL, which
        // is the tier this flag exists to provide.
        if (ownPassword) {
          // Core hands it back decrypted because we supplied the password. With
          // no custody entry the expiry timer never sees it, so without this the
          // strictest tier would keep plaintext key material resident LONGEST —
          // until the workspace handle closes rather than for accountAbsoluteSec.
          try {
            await account.lock();
          } catch (lockError) {
            this.sessions.markUnusable(session);
            throw lockError;
          }
        } else {
          this.sessions.recordAccountExposure(session, String(account.slug));
        }
        return account;
      },
    );
  }

  async drop(session: Session, slug: string): Promise<void> {
    await this.mutateWalletState(session, async () => {
      const account = await this.sessions.requireAccount(session, slug);
      await account.drop();
      this.sessions.clearAccountCustody(session, slug);
    });
  }

  /**
   * Derive `count` more wallets, refusing if the tenant's cross-workspace
   * wallet allowance cannot cover them.
   */
  async deriveWallets(
    session: Session,
    tenant: Tenant,
    slug: string,
    count: number,
  ): Promise<{ before: number; after: number }> {
    const account = await this.sessions.requireAccount(session, slug);
    if (account.organizationType !== 'HD') {
      throw new TeeError('TEE_UNSUPPORTED_FOR_KIND', 'only an HD account can derive wallets');
    }

    return this.mutateWalletIncrease(session, tenant, count, () => account.deriveWallets(count));
  }

  async importPrivateKey(session: Session, tenant: Tenant, slug: string, pk: string): Promise<Wallet> {
    const account = await this.sessions.requireAccount(session, slug);
    // Mirror the derive guard. Without it core's UNSUPPORTED_OP surfaces as a
    // 501, telling the caller the server lacks the feature rather than that
    // they addressed an HD account — after their key was transmitted and
    // quota headroom was reserved.
    if (account.organizationType !== 'PK') {
      throw new TeeError('TEE_UNSUPPORTED_FOR_KIND', 'only a PK account can import a private key');
    }

    // vm is inferred from the key since 2.4.2, and a PK wallet now carries an
    // address on both chains.
    return this.mutateWalletIncrease(session, tenant, 1, () => account.importPrivateKey(pk));
  }

  private liveWalletCount(session: Session): number {
    let n = 0;
    for (const account of session.handle.accounts) n += account.wallets.length;
    return n;
  }

  /** Persist tenant-wide headroom before any wallet-producing core call. */
  private async reserveWallets(session: Session, tenant: Tenant, adding: number): Promise<void> {
    const liveBefore = this.liveWalletCount(session);
    const damaged = hasDamagedAccounts(session.handle);
    await this.state.mutate((draft) => {
      if (!Object.hasOwn(draft.tenants, tenant.id)) {
        throw new Error(`missing ledger tenant ${tenant.id}`);
      }
      const ledgerTenant = draft.tenants[tenant.id];
      const workspace = ledgerTenant.workspaces.find((entry) => entry.slug === session.workspaceSlug);
      if (!workspace) throw new Error(`missing ledger workspace ${session.workspaceSlug}`);

      // Repair this singleton's row before admission. Other rows may contain
      // reservations owned by their own workspace mutexes and must be kept.
      // A damaged account is absent from the live collection, so the repair
      // would understate the row and hand quota back to nobody.
      if (!damaged) workspace.walletCount = liveBefore;
      ledgerTenant.walletTotal = ledgerTenant.workspaces.reduce(
        (sum, entry) => sum + entry.walletCount,
        0,
      );
      if (adding > tenant.limits.maxWallets - ledgerTenant.walletTotal) {
        throw new TeeError(
          'TEE_QUOTA_WALLETS',
          `wallet limit reached (${tenant.limits.maxWallets})`,
        );
      }
      workspace.walletCount += adding;
      ledgerTenant.walletTotal += adding;
    });
  }

  private async mutateWalletIncrease<T>(
    session: Session,
    tenant: Tenant,
    adding: number,
    mutate: () => Promise<T>,
  ): Promise<T> {
    await this.reserveWallets(session, tenant, adding);

    let result: T;
    try {
      result = await mutate();
    } catch (coreError) {
      // In 2.4.4 the provider can persist bytes and then throw before updating
      // the live collection for account create, derive, or import. Even the
      // error code is not evidence of write ordering: a provider can commit
      // and then surface any WativeError. Once core starts, keep the
      // reservation and force a genuine reopen for authoritative settlement.
      this.sessions.markUnusable(session);
      throw coreError;
    }

    await this.settleOrRetire(session);
    return result;
  }

  private async settleOrRetire(session: Session, coreError?: unknown): Promise<void> {
    try {
      await this.sessions.syncWalletCount(session);
    } catch (ledgerError) {
      this.sessions.markUnusable(session);
      if (coreError !== undefined) {
        throw new AggregateError(
          [coreError, ledgerError],
          'wallet mutation and ledger settlement both failed',
        );
      }
      throw ledgerError;
    }
  }

  /** Drops do not reserve positive headroom, but still settle their exact result. */
  private async mutateWalletState<T>(session: Session, mutate: () => Promise<T>): Promise<T> {
    try {
      const result = await mutate();
      await this.sessions.syncWalletCount(session);
      return result;
    } catch (err) {
      try {
        await this.sessions.syncWalletCount(session);
      } catch {
        this.sessions.markUnusable(session);
      }
      throw err;
    }
  }
}
