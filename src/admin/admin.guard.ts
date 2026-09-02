import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import type { AppRequest } from '../common/http';
import { TeeError } from '../common/tee-error';
import { ADMIN_KEY, type AdminKey, verifyAdminKey } from './admin-key';
import { AdminRateLimiter } from './admin-rate-limit';

/**
 * The super-admin tier: a single `X-Admin-Key` above the tenant tier.
 *
 * Named for the header it reads rather than for PANADOL_KEY, so the internal
 * variable name is not published in the API surface.
 *
 * This tier can raise any tenant's ceiling on a running service, so every
 * attempt is logged whether it succeeded or not. The key itself is never
 * logged — not even a prefix, which would narrow a brute force.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  private readonly logger = new Logger(AdminGuard.name);

  constructor(
    @Inject(ADMIN_KEY) private readonly adminKey: AdminKey,
    private readonly limiter: AdminRateLimiter,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AppRequest>();
    const presented = req.header('x-admin-key');
    const where = `${req.method} ${req.path} request=${req.requestId ?? 'unknown'}`;

    // Budget first: a rejected attempt must not consume its own budget, or a
    // burst would extend into a rolling lockout.
    this.limiter.check();

    if (typeof presented !== 'string' || presented.length === 0) {
      this.limiter.recordFailure();
      this.logger.warn(`super-admin denied (missing key): ${where}`);
      throw new TeeError('TEE_ADMIN_DENIED', 'missing or invalid X-Admin-Key');
    }

    if (!verifyAdminKey(presented, this.adminKey)) {
      this.limiter.recordFailure();
      // One message for a wrong key and for a tier that was never configured.
      // Distinguishing them would tell an attacker whether to keep guessing.
      this.logger.warn(
        `super-admin denied (${this.adminKey === null ? 'tier not configured' : 'bad key'}): ${where}`,
      );
      throw new TeeError('TEE_ADMIN_DENIED', 'missing or invalid X-Admin-Key');
    }

    this.logger.warn(`super-admin authenticated: ${where}`);
    return true;
  }
}
