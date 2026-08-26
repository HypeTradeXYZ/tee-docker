import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { TeeError } from '../common/tee-error';
import { invalidBodyMessage } from '../common/invalid-body';
import {
  CurrentSession,
  CurrentTokenTenant,
  SkipWorkspaceIdleTouch,
  WorkspaceGuard,
} from '../auth/workspace.guard';
import { AccountUnlockLimiter } from '../auth/account-unlock-limiter';
import { AllowAnyWorkspaceScope, RequireScopes, ScopesGuard } from '../auth/scopes.guard';
import { assertValidAccountSlug } from './account-slug';
import { SessionRegistry, type Session } from './session.registry';
import type { Tenant } from '../config/schemas';
import { parseNetworkSelector } from './network-selector';
import { damagedAccountSlugs } from './damaged-accounts';

const UnlockBody = z.object({ accountPassword: z.string().min(1) });

interface AssetView {
  id: number;
  symbol: string;
  name: string;
  decimals: number;
  native: boolean;
  contractAddress: string | null;
}

interface AccountView {
  slug: string;
  displayName: string;
  kind: string;
  hasOwnPassword: boolean;
  locked: boolean;
  wallets: number;
}

/**
 * The workspace tier. Every route here is addressed by the token's `ws` claim
 * — there is no `:workspace` path parameter, so a path and a token can never
 * disagree about which workspace is in play.
 */
@Controller()
@UseGuards(WorkspaceGuard, ScopesGuard)
export class WorkspaceController {
  constructor(
    private readonly sessions: SessionRegistry,
    private readonly accountUnlocks: AccountUnlockLimiter,
  ) {}

  @Get('workspace')
  @RequireScopes('read')
  info(@CurrentSession() session: Session): {
    workspace: string;
    locked: boolean;
    accounts: number;
    damagedAccounts: number;
    expiresAt: string;
  } {
    return {
      workspace: session.workspaceSlug,
      locked: session.handle.locked,
      accounts: session.handle.accounts.length,
      // Surfaced as a count, not slugs: the caller needs to know records are
      // missing, and a silent short list is how this went unnoticed.
      damagedAccounts: damagedAccountSlugs(session.handle).length,
      expiresAt: new Date(session.idleExpiresAt).toISOString(),
    };
  }

  @Get('accounts')
  @RequireScopes('read')
  accounts(@CurrentSession() session: Session): { accounts: AccountView[] } {
    return {
      accounts: session.handle.accounts.map(
        (a): AccountView => ({
          slug: String(a.slug),
          displayName: a.displayName,
          kind: a.organizationType,
          hasOwnPassword: a.hasOwnPassword,
          locked: a.locked,
          wallets: a.wallets.length,
        }),
      ),
    };
  }

  /**
   * Assets on one network. `Workspace.assets()` is per-network, so a network
   * must be named — listing every network's assets would be an unbounded
   * response shaped by how many networks the tenant has registered.
   */
  @Get('workspace/assets')
  @RequireScopes('read')
  async assets(
    @CurrentSession() session: Session,
    @Query('network') network: unknown,
  ): Promise<{ network: string; assets: AssetView[] }> {
    const selectedNetwork = parseNetworkSelector(network);
    const assets = await session.handle.assets(selectedNetwork);
    return {
      network: selectedNetwork,
      assets: assets.map((a) => ({
        id: Number(a.id),
        symbol: a.symbol,
        name: a.name,
        decimals: a.decimals,
        native: a.native,
        contractAddress: a.contractAddress,
      })),
    };
  }

  /**
   * Explicit unlock, required only for an account with its own password.
   * A shared-password account unlocks transparently on first use.
   */
  @Post('accounts/:slug/unlock')
  @HttpCode(204)
  @AllowAnyWorkspaceScope()
  @SkipWorkspaceIdleTouch()
  async unlock(
    @CurrentSession() session: Session,
    @CurrentTokenTenant() tenant: Tenant,
    @Param('slug') slug: string,
    @Body() body: unknown,
  ): Promise<void> {
    const parsed = UnlockBody.safeParse(body);
    if (!parsed.success) {
      throw new TeeError(
        'TEE_INVALID_BODY',
        invalidBodyMessage('body must be { accountPassword }', parsed.error, body),
      );
    }
    await this.sessions.unlockAccount(
      session,
      assertValidAccountSlug(slug),
      parsed.data.accountPassword,
      this.accountUnlocks,
      tenant.ttl.workspaceIdleSec,
    );
  }

  @Post('accounts/:slug/lock')
  @HttpCode(204)
  @AllowAnyWorkspaceScope()
  lock(@CurrentSession() session: Session, @Param('slug') slug: string): void {
    this.sessions.lockAccount(session, assertValidAccountSlug(slug));
  }

  /**
   * Resolve an account, unlocking it lazily. Stands in for the domain routes
   * still to come — it is the shape every one of them will use.
   */
  @Get('accounts/:slug')
  @RequireScopes('read')
  async account(
    @CurrentSession() session: Session,
    @Param('slug') slug: string,
  ): Promise<{ account: AccountView }> {
    const a = await this.sessions.requireAccount(session, assertValidAccountSlug(slug));
    return {
      account: {
        slug: String(a.slug),
        displayName: a.displayName,
        kind: a.organizationType,
        hasOwnPassword: a.hasOwnPassword,
        locked: a.locked,
        wallets: a.wallets.length,
      },
    };
  }
}
