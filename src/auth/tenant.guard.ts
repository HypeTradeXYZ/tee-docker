import { CanActivate, ExecutionContext, Inject, Injectable, createParamDecorator } from '@nestjs/common';
import type { AppRequest } from '../common/http';
import { OperatorConfigService } from '../config/operator-config.service';
import type { Tenant } from '../config/schemas';
import { TeeError } from '../common/tee-error';
import { SERVER_KEY } from './server-key';
import { burnComparison, verifyApiSecret } from './secret';

/**
 * The tenant tier: `X-Api-Key` identifies, `X-Api-Secret` authenticates.
 *
 * Tenant-wide scope only. Nothing here unlocks a workspace — that is the JWT
 * tier's job, and these headers never reach it.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly tenants: OperatorConfigService,
    @Inject(SERVER_KEY) private readonly serverKey: Buffer,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AppRequest>();
    const apiKey = header(req, 'x-api-key');
    const apiSecret = header(req, 'x-api-secret');

    if (!apiKey || !apiSecret) {
      throw new TeeError('TEE_BAD_API_KEY', 'missing X-Api-Key or X-Api-Secret');
    }

    const tenant = this.tenants.byApiKey(apiKey);
    if (!tenant) {
      // Same work as a real comparison, so latency does not reveal which API
      // keys exist.
      burnComparison(apiSecret, this.serverKey);
      throw new TeeError('TEE_BAD_API_KEY', 'invalid API key or secret');
    }

    if (!verifyApiSecret(apiSecret, tenant.secretHash, this.serverKey)) {
      // Deliberately the same message as the unknown-key case.
      throw new TeeError('TEE_BAD_API_KEY', 'invalid API key or secret');
    }

    req.tenant = tenant;
    return true;
  }
}

function header(req: AppRequest, name: string): string | null {
  const raw = req.header(name);
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/** Injects the tenant the guard authenticated. */
export const CurrentTenant = createParamDecorator((_data: unknown, ctx: ExecutionContext): Tenant => {
  const req = ctx.switchToHttp().getRequest<AppRequest>();
  if (!req.tenant) {
    // Reaching a handler without a tenant means the guard was not applied —
    // a wiring bug that must not degrade into an unauthenticated request.
    throw new TeeError('TEE_BAD_API_KEY', 'route is missing TenantGuard');
  }
  return req.tenant;
});
