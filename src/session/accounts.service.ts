import { Injectable } from '@nestjs/common';
import { newMnemonic, type Account, type Wallet } from 'wative-core';
import { TeeError } from '../common/tee-error';
import type { Tenant } from '../config/schemas';
import { ServiceStateService } from '../config/service-state.service';
import { SessionRegistry, type Session } from './session.registry';
import { normalizeAccountDisplayName } from './account-display-name';
import { hasDamagedAccounts } from './damaged-accounts';

export interface CreateAccountInput {
  displayName: string;
  kind: 'HD' | 'PK';
  /** Mnemonic (HD) or private key (PK). Generated for HD when absent. */
  secret?: string;
  defaultNetwork?: string;
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
        const account = await session.handle.accounts.create(
          displayName,
          session.password,
          secret,
          input.defaultNetwork,
          { kind: input.kind, hasOwnPassword: false },
        );
        this.sessions.recordAccountExposure(session, String(account.slug));
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
