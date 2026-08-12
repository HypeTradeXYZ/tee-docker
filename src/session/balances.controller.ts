import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentSession, CurrentTokenTenant, WorkspaceGuard } from '../auth/workspace.guard';
import { RequireScopes, ScopesGuard } from '../auth/scopes.guard';
import { TeeError } from '../common/tee-error';
import type { Tenant } from '../config/schemas';
import { requireRpc } from './rpc';
import { type Session } from './session.registry';
import { RpcBoundaryService } from './rpc-boundary.service';

interface BalanceView {
  assetId: number;
  symbol: string;
  raw: string;
  decimals: number;
  fetchedAt: number;
}

@Controller('addresses')
@UseGuards(WorkspaceGuard, ScopesGuard)
export class BalancesController {
  constructor(private readonly rpcBoundary: RpcBoundaryService) {}

  /**
   * Live balances for one address. Costs an RPC call, so it goes through the
   * same BYO-RPC gate as everything else and reports which tier answered.
   */
  @Get(':publicKey/balances')
  @RequireScopes('read')
  async balances(
    @CurrentSession() session: Session,
    @CurrentTokenTenant() tenant: Tenant,
    @Param('publicKey') publicKey: string,
    @Query('network') network: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ address: string; network: string; balances: BalanceView[] }> {
    const address = session.handle.filter(publicKey, 'Address');
    if (!address) {
      throw new TeeError('TEE_ACCOUNT_NOT_FOUND', `address "${publicKey}" not found`);
    }

    const slug = network ?? String(address.network.slug);
    const rpc = requireRpc(session, tenant, slug, this.rpcBoundary);
    res.setHeader('x-rpc-source', rpc.source);

    // refreshBalances returns a Settling — confirm() is the awaited form.
    const settling = network
      ? address.refreshBalances(slug, false)
      : address.refreshBalances(false);
    const balances = await settling.confirm();

    return {
      address: String(address.publicKey),
      network: slug,
      balances: balances.map((b): BalanceView => ({
        assetId: Number(b.assetId),
        symbol: address.assets.byId(b.assetId)?.symbol ?? String(b.assetId),
        // bigint does not survive JSON; decimals are alongside for scaling.
        raw: b.raw.toString(),
        decimals: b.decimals,
        fetchedAt: b.fetchedAt,
      })),
    };
  }
}
