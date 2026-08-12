import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  SkipWorkspaceIdleTouch,
  WorkspaceGuard,
} from '../auth/workspace.guard';
import { RequireScopes, ScopesGuard } from '../auth/scopes.guard';
import { TeeError } from '../common/tee-error';
import { BalanceCapabilityGuard } from './balance-capability';
import { RpcOperation } from './rpc-operation.service';

@Controller('addresses')
@UseGuards(WorkspaceGuard, ScopesGuard, BalanceCapabilityGuard)
export class BalancesController {
  /**
   * Compatibility route. Core 2.4.4 implements no balance refresh path; the
   * capability guard returns a stable 501 before this handler can run.
   */
  @Get(':publicKey/balances')
  @RequireScopes('read')
  @RpcOperation()
  @SkipWorkspaceIdleTouch()
  balances(): never {
    throw new TeeError('TEE_BALANCES_UNAVAILABLE', 'Balance lookup is not available in this release.');
  }
}
