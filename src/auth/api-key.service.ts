import { Injectable, Logger } from '@nestjs/common';
import { TeeError } from '../common/tee-error';
import type { Tenant } from '../config/schemas';
import { SessionRegistry, type LeaseBinding } from '../session/session.registry';
import { validateRecipient } from '../export/seal';
import { JwtService } from './jwt.service';
import { AccountUnlockLimiter } from './account-unlock-limiter';
import { unlockedFunctions, type InquiryFunction } from './functionality';

/**
 * The two capability tiers a tenant can mint. Basic withholds fund movement
 * (the sign scope); Unlimited grants the full set. Key export is additionally
 * gated on a live inquiry key today and is tier-gated to Unlimited in a later
 * wave. The tier is expressed as the lease's granted scopes, so it needs no
 * separate claim.
 */
export type ApiKeyTier = 'basic' | 'unlimited';

const TIER_SCOPES: Record<ApiKeyTier, readonly string[]> = {
  basic: ['read', 'write'],
  unlimited: ['read', 'write', 'sign'],
};

/** Least-privilege default when the tenant does not name a tier. */
const DEFAULT_TIER: ApiKeyTier = 'basic';

/** The tier a scoped lease represents, read back from its granted scopes. */
export function tierOf(scopes: readonly string[]): ApiKeyTier {
  return scopes.includes('sign') ? 'unlimited' : 'basic';
}

/** Inquiry-key validity when the tenant does not set one: four hours. */
const DEFAULT_VALIDATION_SEC = 4 * 60 * 60;

export interface MintApiKeyRequest {
  readonly workspace: string;
  readonly password: string;
  readonly account: string;
  /** Present for a wallet-scoped key; absent for an account-scoped key. */
  readonly walletId?: number;
  /** The account's own password, relayed by the tenant to unlock a Cold Vault account. */
  readonly accountPassword?: string;
  /** Capability tier; defaults to the least-privilege Basic when omitted. */
  readonly tier?: ApiKeyTier;
  /** Optional inquiry key (X25519 recipient) that unlocks the sensitive functions. */
  readonly inquiryKey?: string;
  /** Inquiry-key validity in seconds; defaults to four hours when omitted. */
  readonly validationDuration?: number;
}

export interface ApiKeyResult {
  readonly token: string;
  readonly expiresAt: string;
  readonly level: 'account' | 'wallet';
  readonly workspace: string;
  readonly account: string;
  readonly walletId?: number;
  readonly tier: ApiKeyTier;
  /** A durable key stays live until process restart; expiresAt is far-future. */
  readonly durable: boolean;
  readonly scopes: string[];
  /** Whether the inquiry key unlocked the sensitive functionality list. */
  readonly sensitiveEnabled: boolean;
  /** The functions unlocked by the inquiry key (empty when none). */
  readonly functions: InquiryFunction[];
  /** When the inquiry key's capability lapses (absent when no inquiry key). */
  readonly inquiryExpiresAt?: string;
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
    private readonly accountUnlocks: AccountUnlockLimiter,
  ) {}

  async mint(tenant: Tenant, req: MintApiKeyRequest): Promise<ApiKeyResult> {
    const level: 'account' | 'wallet' = req.walletId !== undefined ? 'wallet' : 'account';
    const tier: ApiKeyTier = req.tier ?? DEFAULT_TIER;

    // An inquiry key is optional. When present it is validated up front (a bad
    // key is a 4xx, not a 5xx) and pins the sensitive functionality list for a
    // bounded window; when absent, those functions stay locked and any
    // validationDuration is moot.
    let inquiry: { readonly inquiryKey: string; readonly inquiryExpiresAt: number } | undefined;
    if (req.inquiryKey !== undefined) {
      try {
        validateRecipient(req.inquiryKey);
      } catch {
        throw new TeeError('TEE_INVALID_BODY', 'inquiryKey is not a valid x25519 recipient');
      }
      const durationSec = req.validationDuration ?? DEFAULT_VALIDATION_SEC;
      inquiry = { inquiryKey: req.inquiryKey, inquiryExpiresAt: Date.now() + durationSec * 1000 };
    }

    const binding: LeaseBinding = {
      account: req.account,
      // Every minted key is durable ("stay-exposed"): it pins its workspace and
      // account unlocked until the process restarts.
      durable: true,
      ...(req.walletId !== undefined ? { wallet: { acct: req.account, wid: req.walletId } } : {}),
      ...(inquiry !== undefined ? inquiry : {}),
    };

    const grant = await this.sessions.create(
      tenant,
      req.workspace,
      req.password,
      TIER_SCOPES[tier],
      binding,
    );
    // The lease is live now. Verify the target on the shared core handle UNDER
    // the session mutex, so the read is serialized against any concurrent
    // core-backed request on the same singleton; then sign outside the mutex.
    // release() takes #lifecycle, so it is only ever called after the mutex is
    // dropped — preserving the global #lifecycle -> session.mutex order and
    // never inverting it (which would risk the closeEntry ABBA deadlock).
    try {
      await this.sessions.withSession(grant.session, async () => {
        const account = grant.session.handle.accounts.bySlug(req.account as never);
        if (!account || String(account.slug) !== req.account) {
          throw new TeeError('TEE_ACCOUNT_NOT_FOUND', `account "${req.account}" not found`);
        }
        // Validate the wallet target BEFORE any unlock, so an invalid target
        // never leaves a Cold Vault account exposed by a mint that then fails.
        if (req.walletId !== undefined && !account.wallets.byId(req.walletId)) {
          throw new TeeError('TEE_ACCOUNT_NOT_FOUND', `wallet ${req.walletId} not found`);
        }
        if (account.hasOwnPassword) {
          // A Cold Vault account has its own password; the tenant relays it to
          // unlock it as a mint prerequisite. The durable lease then keeps it
          // pinned unlocked (the password itself is used here and never stored).
          if (req.accountPassword === undefined) {
            throw new TeeError(
              'TEE_ACCOUNT_LOCKED',
              'accountPassword is required to mint for an account with its own password',
            );
          }
          await this.sessions.unlockAccount(
            grant.session,
            req.account,
            req.accountPassword,
            this.accountUnlocks,
            tenant.ttl.workspaceIdleSec,
          );
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

      const functions = unlockedFunctions(grant.lease, Date.now());
      this.logger.log(
        `api-key minted: tenant=${tenant.id} workspace=${req.workspace} `
          + `account=${req.account} level=${level} sensitive=${functions.length > 0}`,
      );
      return {
        token: signed.token,
        expiresAt: new Date(signed.exp * 1000).toISOString(),
        level,
        workspace: req.workspace,
        account: req.account,
        ...(req.walletId !== undefined ? { walletId: req.walletId } : {}),
        tier,
        durable: true,
        scopes: [...grant.lease.scopes],
        sensitiveEnabled: functions.length > 0,
        functions,
        ...(inquiry !== undefined
          ? { inquiryExpiresAt: new Date(inquiry.inquiryExpiresAt).toISOString() }
          : {}),
      };
    } catch (err) {
      await this.sessions.release(grant.session.sid, grant.lease.jti);
      throw err;
    }
  }
}
