import { CanActivate, ExecutionContext, Injectable, createParamDecorator } from '@nestjs/common';
import type { AppRequest } from '../common/http';
import { TeeError } from '../common/tee-error';
import { OperatorConfigService } from '../config/operator-config.service';
import type { Tenant } from '../config/schemas';
import type { Session } from '../session/session.registry';
import { SessionRegistry } from '../session/session.registry';
import { JwtService } from './jwt.service';

/**
 * The workspace tier. The JWT names a session; the session holds the unlocked
 * workspace.
 *
 * The workspace is taken from the token, never from the path — so a request
 * cannot address one workspace while authenticating for another.
 */
@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly sessions: SessionRegistry,
    private readonly tenants: OperatorConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AppRequest>();

    const header = req.header('authorization');
    if (!header?.startsWith('Bearer ')) {
      throw new TeeError('TEE_SESSION_EXPIRED', 'session is not valid', { reason: 'no bearer' });
    }

    const claims = this.jwt.verify(header.slice('Bearer '.length).trim());
    const tenant = this.tenants.byId(claims.tid);
    if (!tenant) {
      // The tenant was removed from the operator config while a token was live.
      throw new TeeError('TEE_SESSION_EXPIRED', 'session is not valid', { reason: 'no tenant' });
    }

    const access = this.sessions.get(
      claims.sid,
      claims.jti,
      claims.tid,
      claims.ws,
      claims.scp,
      tenant.ttl.workspaceIdleSec,
    );
    if (!access) {
      // Covers lock, idle expiry, absolute expiry, and a restart that dropped
      // every in-memory session. All indistinguishable to the caller by design.
      throw new TeeError('TEE_SESSION_EXPIRED', 'session is not valid', { reason: 'no session' });
    }

    req.session = access.session;
    req.scopes = [...access.lease.scopes];
    req.leaseId = access.lease.jti;
    req.tenant = tenant;
    return true;
  }
}

/** The tenant that owns the token's session. Set by WorkspaceGuard. */
export const CurrentTokenTenant = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): Tenant => {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    if (!req.tenant) {
      throw new TeeError('TEE_SESSION_EXPIRED', 'session is not valid', {
        reason: 'route is missing WorkspaceGuard',
      });
    }
    return req.tenant;
  },
);

export const CurrentSession = createParamDecorator((_d: unknown, ctx: ExecutionContext): Session => {
  const req = ctx.switchToHttp().getRequest<AppRequest>();
  if (!req.session) {
    throw new TeeError('TEE_SESSION_EXPIRED', 'session is not valid', {
      reason: 'route is missing WorkspaceGuard',
    });
  }
  return req.session;
});

export const CurrentLeaseId = createParamDecorator((_d: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<AppRequest>();
  if (!req.leaseId) {
    throw new TeeError('TEE_SESSION_EXPIRED', 'session is not valid', {
      reason: 'route is missing WorkspaceGuard',
    });
  }
  return req.leaseId;
});
