import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AppRequest } from '../common/http';
import { TeeError } from '../common/tee-error';

const SCOPES_KEY = 'tee:required-scopes';
const ANY_SCOPE_KEY = 'tee:any-workspace-scope';

/** Declare the scopes a route needs. Enforced by ScopesGuard. */
export const RequireScopes = (...scopes: string[]) =>
  applyDecorators(SetMetadata(SCOPES_KEY, scopes));

/**
 * Mark an authenticated workspace route as lifecycle-only and intentionally
 * independent of its token's operation scopes.
 */
export const AllowAnyWorkspaceScope = () =>
  applyDecorators(SetMetadata(ANY_SCOPE_KEY, true));

@Injectable()
export class ScopesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowAny = this.reflector.getAllAndOverride<boolean | undefined>(ANY_SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowAny === true) return true;

    const required = this.reflector.getAllAndOverride<string[] | undefined>(SCOPES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      throw new Error('ScopesGuard route must declare required scopes or an explicit exemption');
    }

    const req = context.switchToHttp().getRequest<AppRequest>();
    const granted = new Set(req.scopes ?? []);
    const missing = required.filter((s) => !granted.has(s));

    if (missing.length > 0) {
      throw new TeeError('TEE_SCOPE_DENIED', `token is missing scope: ${missing.join(', ')}`, {
        required,
      });
    }
    return true;
  }
}
