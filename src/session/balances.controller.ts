import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import type { Address } from 'wative-core';
import {
  CurrentSession,
  SkipWorkspaceIdleTouch,
  WorkspaceGuard,
} from '../auth/workspace.guard';
import { RequireScopes, ScopesGuard } from '../auth/scopes.guard';
import { TeeError } from '../common/tee-error';
import { BalanceCapabilityGuard } from './balance-capability';
import { RpcOperation } from './rpc-operation.service';
import { type Session, SessionRegistry } from './session.registry';

@Controller('addresses')
@UseGuards(WorkspaceGuard, ScopesGuard, BalanceCapabilityGuard)
export class BalancesController {
  constructor(private readonly sessions: SessionRegistry) {}

  /**
   * Compatibility route. Core 2.4.4 implements no balance refresh path; the
   * capability guard returns a stable 501 before this handler can run.
   */
  @Get(':publicKey/balances')
  @RequireScopes('read')
  @RpcOperation()
  @SkipWorkspaceIdleTouch()
  async balances(
    @CurrentSession() session: Session,
    @Param('publicKey') publicKey: string,
  ): Promise<never> {
    await this.resolveOwnedAddress(session, publicKey);
    throw new TeeError('TEE_BALANCES_UNAVAILABLE', 'Balance lookup is not available in this release.');
  }

  /** Dormant until the capability guard is explicitly re-audited and enabled. */
  private async resolveOwnedAddress(session: Session, publicKey: string): Promise<Address> {
    const found = session.handle.filter(publicKey, 'Address');
    if (!found) {
      throw new TeeError('TEE_ACCOUNT_NOT_FOUND', `address "${publicKey}" not found`);
    }
    const owner = session.handle.accounts.find((account) =>
      account.wallets.some((wallet) =>
        wallet.addresses.some((address) => address.publicKey === found.publicKey),
      ),
    );
    if (!owner) {
      throw new TeeError('TEE_ACCOUNT_NOT_FOUND', `address "${publicKey}" has no account`);
    }
    await this.sessions.requireAccount(session, String(owner.slug));
    return found;
  }
}
