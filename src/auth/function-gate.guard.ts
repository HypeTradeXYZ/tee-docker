import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AppRequest } from '../common/http';
import { TeeError } from '../common/tee-error';
import type { InquiryFunction } from './functionality';

const REQUIRE_FUNCTION_KEY = 'tee:require-function';

/**
 * Gate a route behind a sensitive function. The caller reaches it only if its
 * token carries a live inquiry key that unlocks that function; otherwise it is
 * denied, exactly as if the route did not exist for it. `req.functions` is set
 * by WorkspaceGuard from the authoritative lease.
 */
export const RequireFunction = (fn: InquiryFunction) => SetMetadata(REQUIRE_FUNCTION_KEY, fn);

@Injectable()
export class FunctionGateGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<InquiryFunction | undefined>(
      REQUIRE_FUNCTION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (required === undefined) return true;
    const req = context.switchToHttp().getRequest<AppRequest>();
    const functions = req.functions ?? [];
    if (!functions.includes(required)) {
      throw new TeeError(
        'TEE_SCOPE_DENIED',
        `the "${required}" function requires a valid inquiry key`,
      );
    }
    return true;
  }
}
