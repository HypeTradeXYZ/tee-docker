import { CanActivate, Injectable } from '@nestjs/common';
import { TeeError } from '../common/tee-error';

// Intentional dependency tripwire. A core bump must update this constant only
// after balance behavior has been characterized and the HTTP route reviewed.
export const AUDITED_BALANCE_CORE_VERSION = '2.4.4';
export const INSTALLED_BALANCE_CORE_VERSION = (
  require('wative-core/package.json') as { version?: unknown }
).version;

export function balanceCapabilityAvailable(version: unknown): boolean {
  // 2.4.4 exposes refresh methods but implements none of them. Unknown future
  // versions remain disabled until their semantics receive a dedicated audit.
  return version === AUDITED_BALANCE_CORE_VERSION && false;
}

@Injectable()
export class BalanceCapabilityGuard implements CanActivate {
  canActivate(): never {
    throw new TeeError(
      'TEE_BALANCES_UNAVAILABLE',
      'Balance lookup is not available in this release.',
    );
  }
}
