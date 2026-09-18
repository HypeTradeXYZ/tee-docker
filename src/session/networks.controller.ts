import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentSession, WorkspaceGuard } from '../auth/workspace.guard';
import { RequireScopes, ScopesGuard } from '../auth/scopes.guard';
import { AccountScopeGuard, WalletScopeGuard } from '../auth/scope-binding.guard';
import { type Session } from './session.registry';

interface NetworkView {
  slug: string;
  name: string;
  chainId: number;
  vm: string;
}

/**
 * The networks a workspace knows, from wative-core's built-ins. tee-docker
 * signs but never relays chain RPC, so this is a read-only registry view — a
 * network's RPC endpoint is the caller's to hold and call.
 */
@Controller('workspace/networks')
@UseGuards(WorkspaceGuard, ScopesGuard, AccountScopeGuard, WalletScopeGuard)
export class NetworksController {
  @Get()
  @RequireScopes('read')
  list(@CurrentSession() session: Session): { networks: NetworkView[] } {
    return {
      networks: session.handle.networks.map((n) => ({
        slug: String(n.slug),
        name: n.name,
        chainId: Number(n.chainId),
        vm: n.vm,
      })),
    };
  }
}
