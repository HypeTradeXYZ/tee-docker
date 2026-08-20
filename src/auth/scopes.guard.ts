import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  SetMetadata,
  applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AppRequest } from '../common/http';
import { TeeError } from '../common/tee-error';

const SCOPES_KEY = 'tee:required-scopes';
const ANY_SCOPE_KEY = 'tee:any-workspace-scope';
const DENIAL_AUDIT_KEY = 'tee:audit-scope-denial';

interface DenialAudit {
  readonly event: string;
  readonly target: string;
}

/** Declare the scopes a route needs. Enforced by ScopesGuard. */
export const RequireScopes = (...scopes: string[]) =>
  applyDecorators(SetMetadata(SCOPES_KEY, scopes));

/**
 * Mark an authenticated workspace route as lifecycle-only and intentionally
 * independent of its token's operation scopes.
 */
export const AllowAnyWorkspaceScope = () =>
  applyDecorators(SetMetadata(ANY_SCOPE_KEY, true));

/**
 * Audit refusals on this route under `event`, so a route whose denial is itself
 * a signal leaves a trace the generic 403 warning cannot carry.
 */
export const AuditScopeDenial = (event: string, target: string) =>
  applyDecorators(SetMetadata(DENIAL_AUDIT_KEY, { event, target }));

@Injectable()
export class ScopesGuard implements CanActivate {
  private readonly logger = new Logger(ScopesGuard.name);

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
      this.auditDenial(context, req, required);
      throw new TeeError('TEE_SCOPE_DENIED', `token is missing scope: ${missing.join(', ')}`, {
        required,
      });
    }
    return true;
  }

  /** Only the route's own declared constants are recorded; caller values are not. */
  private auditDenial(context: ExecutionContext, req: AppRequest, required: string[]): void {
    const marked = this.reflector.getAllAndOverride<DenialAudit | undefined>(DENIAL_AUDIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!marked) return;
    this.logger.warn({
      event: marked.event,
      outcome: 'DENIED',
      tenantId: req.tenant?.id,
      workspaceSlug: req.session?.workspaceSlug,
      target: marked.target,
      required,
      requestId: req.requestId,
    });
  }
}
