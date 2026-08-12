import { Controller, HttpCode, Logger, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentSession, CurrentTokenTenant, WorkspaceGuard } from '../auth/workspace.guard';
import { RequireScopes, ScopesGuard } from '../auth/scopes.guard';
import { TeeError } from '../common/tee-error';
import type { Tenant } from '../config/schemas';
import { SessionRegistry, type Session } from '../session/session.registry';
import { assertValidSlug } from '../workspaces/workspace-paths';
import { seal, type SealedBlob } from './seal';

/**
 * Export — the highest-consequence route in the service.
 *
 * A leaked signing token moves funds within policy and leaves a trace; a
 * leaked export hands over permanent, offline, irrevocable control. So it is
 * gated three ways: a distinct token scope, a tenant-level enable, and
 * encryption to a key the operator registered by hand — meaning a stolen token
 * yields a blob the thief cannot open.
 */
@Controller()
@UseGuards(WorkspaceGuard, ScopesGuard)
@RequireScopes('export')
export class ExportController {
  private readonly logger = new Logger(ExportController.name);

  constructor(private readonly sessions: SessionRegistry) {}

  @Post('accounts/:slug/export')
  @HttpCode(200)
  async mnemonic(
    @CurrentSession() session: Session,
    @CurrentTokenTenant() tenant: Tenant,
    @Param('slug') slug: string,
  ): Promise<{ kind: 'mnemonic'; account: string; sealed: SealedBlob }> {
    const account = await this.audited(session, tenant, assertValidSlug(slug), 'mnemonic');

    if (account.organizationType !== 'HD') {
      throw new TeeError('TEE_INVALID_SLUG', 'only an HD account has a mnemonic');
    }
    return {
      kind: 'mnemonic',
      account: String(account.slug),
      sealed: seal(account.dumpMnemonic(), tenant.exportPublicKey as string),
    };
  }

  @Post('accounts/:slug/wallets/:id/export')
  @HttpCode(200)
  async privateKey(
    @CurrentSession() session: Session,
    @CurrentTokenTenant() tenant: Tenant,
    @Param('slug') slug: string,
    @Param('id') id: string,
  ): Promise<{ kind: 'privateKey'; account: string; walletId: number; sealed: SealedBlob }> {
    const account = await this.audited(session, tenant, assertValidSlug(slug), `wallet:${id}`);

    const wallet = account.wallets.byId(Number(id));
    if (!wallet) throw new TeeError('TEE_ACCOUNT_NOT_FOUND', `wallet ${id} not found`);

    const vm = wallet.addresses[0]?.vm;
    if (!vm) throw new TeeError('TEE_ACCOUNT_NOT_FOUND', `wallet ${id} has no address`);

    return {
      kind: 'privateKey',
      account: String(account.slug),
      walletId: wallet.id,
      sealed: seal(wallet.dumpPrivateKey(vm), tenant.exportPublicKey as string),
    };
  }

  /**
   * Shared gate. Logs every attempt — success and failure alike — because this
   * is the one operation where "when did this key leave" must be answerable
   * after the fact.
   */
  private async audited(session: Session, tenant: Tenant, slug: string, target: string) {
    if (!tenant.exportEnabled || !tenant.exportPublicKey) {
      this.logger.warn(
        `export DENIED (no registered key) tenant=${tenant.id} ws=${session.workspaceSlug} target=${target}`,
      );
      throw new TeeError('TEE_EXPORT_DISABLED', 'no exportPublicKey registered for this tenant');
    }

    try {
      const account = await this.sessions.requireAccount(session, slug);
      this.logger.log(
        `export GRANTED tenant=${tenant.id} ws=${session.workspaceSlug} account=${slug} target=${target}`,
      );
      return account;
    } catch (err) {
      this.logger.warn(
        `export DENIED tenant=${tenant.id} ws=${session.workspaceSlug} account=${slug} target=${target}`,
      );
      throw err;
    }
  }
}
