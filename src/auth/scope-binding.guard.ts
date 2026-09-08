import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AppRequest, CredentialLevel } from '../common/http';
import { TeeError } from '../common/tee-error';
import { assertValidAccountSlug } from '../session/account-slug';
import { parseWalletId } from '../session/wallet-id';

/**
 * The account and wallet tiers' fail-closed binding guards.
 *
 * A scoped token (account- or wallet-level) may reach a workspace route ONLY if
 * that route is explicitly opened to its tier with a target decorator, and only
 * for the exact account/wallet it was minted against. A route left un-opened
 * denies every scoped token by default; workspace tokens pass straight through.
 * This is the structural least-privilege guarantee: a narrower token can never
 * be widened by reaching a route it was not granted.
 */

// ---- account tier ----

/** Where a route names the account a scoped token must match. */
export type AccountTargetKind = 'account-slug-param' | 'none';
const ACCOUNT_TARGET_KEY = 'tee:account-token-target';

/** Open a workspace route to account- (and wallet-) scoped tokens. */
export const AccountTokenTarget = (kind: AccountTargetKind) =>
  SetMetadata(ACCOUNT_TARGET_KEY, kind);

@Injectable()
export class AccountScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AppRequest>();
    // A workspace token carries no account binding and is unaffected.
    if (req.credentialLevel !== 'account' && req.credentialLevel !== 'wallet') return true;

    const kind = this.reflector.getAllAndOverride<AccountTargetKind | undefined>(
      ACCOUNT_TARGET_KEY,
      [context.getHandler(), context.getClass()],
    );
    // Fail closed: a route not opened to account tokens denies them.
    if (kind === undefined) {
      throw denied('this operation is not available to an account-scoped token');
    }
    if (kind === 'none') return true;

    const account = req.accountBinding;
    if (!account) throw denied('account binding missing');
    const target = assertValidAccountSlug(req.params.slug);
    if (target !== account) throw denied('this token cannot act on the requested account');
    return true;
  }
}

// ---- wallet tier ----

/** Where a route names the wallet a wallet-scoped token must match. */
export type WalletTargetKind = 'slug-id-param' | 'none';
const WALLET_TARGET_KEY = 'tee:wallet-token-target';

/** Open a workspace route to wallet-scoped tokens. */
export const WalletTokenTarget = (kind: WalletTargetKind) =>
  SetMetadata(WALLET_TARGET_KEY, kind);

@Injectable()
export class WalletScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AppRequest>();
    if (req.credentialLevel !== 'wallet') return true;

    const kind = this.reflector.getAllAndOverride<WalletTargetKind | undefined>(WALLET_TARGET_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // Fail closed: a route not opened to wallet tokens denies them.
    if (kind === undefined) {
      throw denied('this operation is not available to a wallet-scoped token');
    }
    if (kind === 'none') return true;

    const binding = req.walletBinding;
    if (!binding) throw denied('wallet binding missing');
    const acct = assertValidAccountSlug(req.params.slug);
    const wid = parseWalletId(String(req.params.id));
    if (acct !== binding.acct || wid !== binding.wid) {
      throw denied('this token cannot act on the requested wallet');
    }
    return true;
  }
}

/** The token's privilege level, defaulting to workspace when unset. */
export const CurrentCredentialLevel = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): CredentialLevel => {
    return ctx.switchToHttp().getRequest<AppRequest>().credentialLevel ?? 'workspace';
  },
);

function denied(message: string): TeeError {
  return new TeeError('TEE_SCOPE_DENIED', message);
}
