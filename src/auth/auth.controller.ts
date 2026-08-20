import { Body, Controller, Delete, HttpCode, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { TeeError } from '../common/tee-error';
import type { Tenant } from '../config/schemas';
import type { Session } from '../session/session.registry';
import { SessionRegistry } from '../session/session.registry';
import { assertValidSlug } from '../workspaces/workspace-paths';
import { JwtService } from './jwt.service';
import { MintRateLimiter } from './mint-rate-limit';
import { CurrentTenant, TenantGuard } from './tenant.guard';
import {
  CurrentLeaseId,
  CurrentSession,
  CurrentTokenTenant,
  WorkspaceGuard,
} from './workspace.guard';
import { SkipWorkspaceMutex } from '../session/workspace-mutex.interceptor';

/** Granted by default. `export` must be asked for explicitly — see DESIGN §9. */
const DEFAULT_SCOPES = ['read', 'write', 'sign'];
const GRANTABLE_SCOPES = new Set([...DEFAULT_SCOPES, 'export']);

const TokenBody = z.object({
  workspace: z.string(),
  password: z.string().min(1),
  // Bounded so an oversized array cannot buy CPU on the uncharged path.
  scopes: z.array(z.string().max(32)).min(1).max(GRANTABLE_SCOPES.size).optional(),
});
const RefreshBody = z.object({}).strict();

@Controller('auth')
export class AuthController {
  constructor(
    private readonly sessions: SessionRegistry,
    private readonly jwt: JwtService,
    private readonly rateLimit: MintRateLimiter,
  ) {}

  /**
   * Mint a workspace-scoped token.
   *
   * Authenticated by the tenant tier, because minting is where the workspace
   * password is presented. The token's lifetime IS the unlock session: if the
   * token is valid, the workspace is unlocked.
   */
  @Post('token')
  @HttpCode(201)
  @UseGuards(TenantGuard)
  async token(
    @CurrentTenant() tenant: Tenant,
    @Body() body: unknown,
  ): Promise<{ token: string; expiresAt: string; workspace: string; scopes: string[] }> {
    const parsed = TokenBody.safeParse(body);
    if (!parsed.success) {
      throw new TeeError('TEE_INVALID_BODY', 'body must be { workspace, password, scopes? }');
    }

    const workspace = assertValidSlug(parsed.data.workspace);
    const scopes = resolveScopes(parsed.data.scopes, tenant);
    if (!this.sessions.knowsWorkspace(tenant.id, workspace)) {
      throw new TeeError('TEE_WORKSPACE_NOT_FOUND', `workspace "${workspace}" not found`);
    }

    // Charge once the request is well formed and names a known workspace, and
    // still before create(), so every password comparison is charged even on
    // the warm path that pays no KDF.
    this.rateLimit.check(tenant.id);

    const grant = await this.sessions.create(tenant, workspace, parsed.data.password, scopes);
    let signed: { token: string; exp: number };
    try {
      signed = this.jwt.sign(
        {
          tid: tenant.id,
          ws: workspace,
          sid: grant.session.sid,
          jti: grant.lease.jti,
          scp: [...grant.lease.scopes],
        },
        grant.exp,
      );
    } catch (err) {
      await this.sessions.release(grant.session.sid, grant.lease.jti);
      throw err;
    }

    return {
      token: signed.token,
      expiresAt: new Date(signed.exp * 1000).toISOString(),
      workspace,
      scopes,
    };
  }

  @Post('token/refresh')
  @HttpCode(200)
  @UseGuards(WorkspaceGuard)
  @SkipWorkspaceMutex()
  async refresh(
    @CurrentTokenTenant() tenant: Tenant,
    @CurrentSession() session: Session,
    @CurrentLeaseId() jti: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{
    token: string;
    expiresAt: string;
    sessionExpiresAt: string;
    workspace: string;
    scopes: string[];
  }> {
    if (!RefreshBody.safeParse(body === undefined ? {} : body).success) {
      throw new TeeError('TEE_INVALID_BODY', 'refresh body must be empty');
    }
    const grant = await this.sessions.refresh(session, jti, tenant.ttl.workspaceIdleSec);
    const signed = this.jwt.sign(
      {
        tid: tenant.id,
        ws: session.workspaceSlug,
        sid: session.sid,
        jti: grant.lease.jti,
        scp: [...grant.lease.scopes],
      },
      grant.exp,
    );
    res.setHeader('cache-control', 'no-store');
    res.setHeader('pragma', 'no-cache');
    return {
      token: signed.token,
      expiresAt: new Date(signed.exp * 1000).toISOString(),
      sessionExpiresAt: new Date(session.absoluteExpiresAt).toISOString(),
      workspace: session.workspaceSlug,
      scopes: [...grant.lease.scopes],
    };
  }

  /** Release this bearer lease. The workspace locks when its last lease goes. */
  @Delete('token')
  @HttpCode(204)
  @UseGuards(WorkspaceGuard)
  @SkipWorkspaceMutex()
  async release(
    @CurrentSession() session: Session,
    @CurrentLeaseId() jti: string,
  ): Promise<void> {
    await this.sessions.release(session.sid, jti);
  }
}

function resolveScopes(requested: string[] | undefined, tenant: Tenant): string[] {
  if (!requested) return [...DEFAULT_SCOPES];

  const unknown = requested.filter((s) => !GRANTABLE_SCOPES.has(s));
  if (unknown.length > 0) {
    throw new TeeError('TEE_INVALID_BODY', 'requested scopes are not supported');
  }

  // Export is refused at mint time when the tenant has no registered public
  // key, so a token can never carry a scope the tenant cannot actually use.
  if (requested.includes('export') && !tenant.exportEnabled) {
    throw new TeeError('TEE_EXPORT_DISABLED', 'no exportPublicKey registered for this tenant');
  }
  return [...new Set(requested)];
}
