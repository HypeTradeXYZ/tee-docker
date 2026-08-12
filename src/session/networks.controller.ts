import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Network } from 'wative-core';
import { TeeError } from '../common/tee-error';
import { CurrentSession, CurrentTokenTenant, WorkspaceGuard } from '../auth/workspace.guard';
import { RequireScopes, ScopesGuard } from '../auth/scopes.guard';
import type { Tenant } from '../config/schemas';
import { assertValidSlug } from '../workspaces/workspace-paths';
import { type Session } from './session.registry';
import { resolveRpc, type RpcSource } from './rpc';
import { RpcBoundaryService } from './rpc-boundary.service';

const SetRpc = z.object({ rpcUrl: z.string().min(1).max(2_048) }).strict();

interface NetworkView {
  slug: string;
  name: string;
  chainId: number;
  vm: string;
  rpcSource: RpcSource;
}

/**
 * Networks and their RPC endpoints.
 *
 * tee-docker ships no RPC service. Resolution is three-tier — workspace
 * registry, then the tenant's configured map, then wative-core's built-in
 * default — and every response says which tier answered, so "why is this slow"
 * is never ambiguous.
 */
@Controller('workspace/networks')
@UseGuards(WorkspaceGuard, ScopesGuard)
export class NetworksController {
  constructor(private readonly rpcBoundary: RpcBoundaryService) {}

  @Get()
  @RequireScopes('read')
  list(
    @CurrentSession() session: Session,
    @CurrentTokenTenant() tenant: Tenant,
  ): { networks: NetworkView[] } {
    return {
      networks: session.handle.networks.map((n) => ({
        slug: String(n.slug),
        name: n.name,
        chainId: Number(n.chainId),
        vm: n.vm,
        rpcSource: resolveRpc(session, tenant, String(n.slug), this.rpcBoundary).source,
      })),
    };
  }

  @Put(':slug')
  @RequireScopes('write')
  async setRpc(
    @CurrentSession() session: Session,
    @CurrentTokenTenant() tenant: Tenant,
    @Param('slug') slug: string,
    @Body() body: unknown,
  ): Promise<{ network: string; rpcSource: RpcSource }> {
    const parsed = SetRpc.safeParse(body);
    if (!parsed.success) throw new TeeError('TEE_INVALID_SLUG', 'body must be { rpcUrl }');

    const network = session.handle.networks.bySlug(assertValidSlug(slug) as never);
    if (!network) {
      throw new TeeError('TEE_ACCOUNT_NOT_FOUND', `network "${slug}" not found`);
    }

    const target = await this.rpcBoundary.admit(parsed.data.rpcUrl);
    const relayUrl = this.rpcBoundary.relayUrl(
      target,
      tenant.id,
      session.workspaceSlug,
      'tenant',
    );

    // Network fields are readonly; the documented update path is to build a
    // replacement from the existing one and hand it to the collection.
    const previous = String(network.rpcUrl ?? '');
    try {
      await session.handle.networks.update(
        new Network({ ...network, rpcUrl: relayUrl }),
      );
      this.rpcBoundary.rebindNetwork(session.handle, String(network.slug));
      this.rpcBoundary.revokeCapability(previous);
    } catch (err) {
      this.rpcBoundary.revokeCapability(relayUrl);
      throw err;
    }

    return { network: String(network.slug), rpcSource: 'tenant' };
  }
}
