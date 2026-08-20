import { Controller, HttpCode, Logger, Param, Post, Query, UseGuards } from '@nestjs/common';
import { teeCoreError } from '../common/tee-error';
import { z } from 'zod';

import { CurrentSession, CurrentTokenTenant, WorkspaceGuard } from '../auth/workspace.guard';
import { AuditScopeDenial, RequireScopes, ScopesGuard } from '../auth/scopes.guard';
import { TeeError } from '../common/tee-error';
import type { Tenant } from '../config/schemas';
import { assertValidAccountSlug } from '../session/account-slug';
import { SessionRegistry, type Session } from '../session/session.registry';
import { parseWalletId } from '../session/wallet-id';
import { seal, type SealedBlob } from './seal';

const ExportVm = z.enum(['evm', 'svm']);

type ExportTarget =
  | { readonly kind: 'mnemonic' }
  | { readonly kind: 'privateKey'; readonly walletId: number; readonly vm: 'evm' | 'svm' };

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
  @AuditScopeDenial('key_export', 'mnemonic')
  async mnemonic(
    @CurrentSession() session: Session,
    @CurrentTokenTenant() tenant: Tenant,
    @Param('slug') slug: string,
  ): Promise<{ kind: 'mnemonic'; account: string; sealed: SealedBlob }> {
    const accountSlug = assertValidAccountSlug(slug);
    return this.audited(session, tenant, accountSlug, { kind: 'mnemonic' }, async () => {
      const account = await this.sessions.requireAccount(session, accountSlug);
      if (account.organizationType !== 'HD') {
        throw new TeeError('TEE_UNSUPPORTED_FOR_KIND', 'only an HD account has a mnemonic');
      }
      return {
        kind: 'mnemonic',
        account: String(account.slug),
        sealed: seal(account.dumpMnemonic(), tenant.exportPublicKey as string),
      };
    });
  }

  @Post('accounts/:slug/wallets/:id/export')
  @HttpCode(200)
  @AuditScopeDenial('key_export', 'privateKey')
  async privateKey(
    @CurrentSession() session: Session,
    @CurrentTokenTenant() tenant: Tenant,
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Query('vm') vm: unknown,
  ): Promise<{
    kind: 'privateKey'; account: string; walletId: number; vm: 'evm' | 'svm'; sealed: SealedBlob;
  }> {
    const accountSlug = assertValidAccountSlug(slug);
    const walletId = parseWalletId(id);
    const parsedVm = ExportVm.safeParse(vm);
    if (!parsedVm.success) {
      throw teeCoreError('PARAMETER_ERROR', 'query parameter vm must be evm or svm');
    }
    const selectedVm = parsedVm.data;

    return this.audited(
      session,
      tenant,
      accountSlug,
      { kind: 'privateKey', walletId, vm: selectedVm },
      async () => {
        const account = await this.sessions.requireAccount(session, accountSlug);
        const wallet = account.wallets.byId(walletId);
        if (!wallet) throw new TeeError('TEE_ACCOUNT_NOT_FOUND', `wallet ${walletId} not found`);

        if (!wallet.addresses.some((address) => address.vm === selectedVm)) {
          throw new TeeError(
            'TEE_UNSUPPORTED_FOR_KIND',
            'wallet does not support the selected VM',
          );
        }

        return {
          kind: 'privateKey',
          account: String(account.slug),
          walletId: wallet.id,
          vm: selectedVm,
          sealed: seal(wallet.dumpPrivateKey(selectedVm), tenant.exportPublicKey as string),
        };
      },
    );
  }

  /**
   * Shared gate. Logs every attempt — success and failure alike — because this
   * is the one operation where "when did this key leave" must be answerable
   * after the fact.
   */
  private async audited<T>(
    session: Session,
    tenant: Tenant,
    accountSlug: string,
    target: ExportTarget,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.audit('ATTEMPT', session, tenant, accountSlug, target);
    let result: T;
    try {
      if (!tenant.exportEnabled || !tenant.exportPublicKey) {
        throw new TeeError('TEE_EXPORT_DISABLED', 'no exportPublicKey registered for this tenant');
      }
      result = await operation();
    } catch (err) {
      try {
        this.audit('FAILURE', session, tenant, accountSlug, target);
      } catch {
        // Preserve the actual operation failure. The terminal audit was still
        // attempted; a broken logging sink must not relabel the API outcome.
      }
      throw err;
    }
    // A logging-sink failure is not an operation failure and must not produce
    // a contradictory FAILURE after SUCCESS was already attempted.
    this.audit('SUCCESS', session, tenant, accountSlug, target);
    return result;
  }

  private audit(
    outcome: 'ATTEMPT' | 'SUCCESS' | 'FAILURE',
    session: Session,
    tenant: Tenant,
    accountSlug: string,
    target: ExportTarget,
  ): void {
    const record = {
      event: 'key_export',
      outcome,
      tenantId: tenant.id,
      workspaceSlug: session.workspaceSlug,
      accountSlug,
      target: target.kind,
      ...(target.kind === 'privateKey' ? { walletId: target.walletId } : {}),
      ...(target.kind === 'privateKey' ? { vm: target.vm } : {}),
    };
    if (outcome === 'FAILURE') this.logger.warn(record);
    else this.logger.log(record);
  }
}
