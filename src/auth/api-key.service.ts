import { Injectable, Logger } from '@nestjs/common';
import { TeeError } from '../common/tee-error';
import type { Tenant } from '../config/schemas';
import { SessionRegistry, type LeaseBinding } from '../session/session.registry';
import { JwtService } from './jwt.service';

/** A scoped token carries the same base scopes as a workspace token, confined by its binding. */
const SCOPED_SCOPES = ['read', 'write', 'sign'];

export interface MintApiKeyRequest {
  readonly workspace: string;
  readonly password: string;
  readonly account: string;
  /** Present for a wallet-scoped key; absent for an account-scoped key. */
  readonly walletId?: number;
}

export interface ApiKeyResult {
  readonly token: string;
  readonly expiresAt: string;
  readonly level: 'account' | 'wallet';
  readonly workspace: string;
  readonly account: string;
  readonly walletId?: number;
  readonly scopes: string[];
}

/**
 * Mints a single-string token bound to one account, or one wallet within it.
 * The workspace password is presented by the tenant at mint; the token's lease
 * carries the authoritative binding, so the token itself only names its scope.
 */
@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger(ApiKeyService.name);

  constructor(
    private readonly sessions: SessionRegistry,
    private readonly jwt: JwtService,
  ) {}

  async mint(tenant: Tenant, req: MintApiKeyRequest): Promise<ApiKeyResult> {
    const level: 'account' | 'wallet' = req.walletId !== undefined ? 'wallet' : 'account';
    const binding: LeaseBinding =
      req.walletId !== undefined
        ? { account: req.account, wallet: { acct: req.account, wid: req.walletId } }
        : { account: req.account };

    const grant = await this.sessions.create(
      tenant,
      req.workspace,
      req.password,
      SCOPED_SCOPES,
      binding,
    );
    // The lease is live now. Verify the target on the shared core handle UNDER
    // the session mutex, so the read is serialized against any concurrent
    // core-backed request on the same singleton; then sign outside the mutex.
    // release() takes #lifecycle, so it is only ever called after the mutex is
    // dropped — preserving the global #lifecycle -> session.mutex order and
    // never inverting it (which would risk the closeEntry ABBA deadlock).
    try {
      await this.sessions.withSession(grant.session, () => {
        const account = grant.session.handle.accounts.bySlug(req.account as never);
        if (!account || String(account.slug) !== req.account) {
          throw new TeeError('TEE_ACCOUNT_NOT_FOUND', `account "${req.account}" not found`);
        }
        if (account.hasOwnPassword) {
          // A scoped token cannot unlock a Cold Vault account; refuse rather than
          // mint a token that could never act.
          throw new TeeError(
            'TEE_ACCOUNT_LOCKED',
            'an api key cannot be minted for an account with its own password',
          );
        }
        if (req.walletId !== undefined && !account.wallets.byId(req.walletId)) {
          throw new TeeError('TEE_ACCOUNT_NOT_FOUND', `wallet ${req.walletId} not found`);
        }
      });

      const signed = this.jwt.sign(
        {
          tid: tenant.id,
          ws: req.workspace,
          sid: grant.session.sid,
          jti: grant.lease.jti,
          scp: [...grant.lease.scopes],
          acc: req.account,
          ...(req.walletId !== undefined ? { wal: { acct: req.account, wid: req.walletId } } : {}),
        },
        grant.exp,
      );

      this.logger.log(
        `api-key minted: tenant=${tenant.id} workspace=${req.workspace} `
          + `account=${req.account} level=${level}`,
      );
      return {
        token: signed.token,
        expiresAt: new Date(signed.exp * 1000).toISOString(),
        level,
        workspace: req.workspace,
        account: req.account,
        ...(req.walletId !== undefined ? { walletId: req.walletId } : {}),
        scopes: [...grant.lease.scopes],
      };
    } catch (err) {
      await this.sessions.release(grant.session.sid, grant.lease.jti);
      throw err;
    }
  }
}
