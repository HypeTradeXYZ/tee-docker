import { Injectable } from '@nestjs/common';
import { Wallet, type Account } from 'wative-core';
import { ServiceStateService } from '../config/service-state.service';
import type { WalletTagRecovery } from '../config/schemas';
import type { Session } from './session.registry';

/**
 * Replaces wallet tags with a durable old-value recovery record.
 *
 * wative-core 2.4.4 persists clear/add operations individually. The journal
 * makes an interrupted sequence recoverable before a new session is
 * published, while ordinary failures compensate immediately.
 */
@Injectable()
export class WalletTagsService {
  constructor(private readonly state: ServiceStateService) {}

  async replace(session: Session, wallet: Wallet, requested: readonly string[]): Promise<void> {
    const desired = await normalizeWalletTags(requested);
    const oldTags = [...wallet.tags];
    if (sameTags(oldTags, desired)) return;

    const recovery: WalletTagRecovery = {
      accountSlug: String(wallet._account.slug),
      walletId: Number(wallet.id),
      oldTags,
    };
    await this.writeRecovery(session, recovery);

    try {
      await replaceAndConfirm(wallet, desired);
    } catch (operationError) {
      try {
        // Always rebuild from scratch. A provider may commit a write and then
        // throw while core restores only its in-memory snapshot.
        await replaceAndConfirm(wallet, oldTags);
      } catch (rollbackError) {
        session.unusable = true;
        throw new AggregateError(
          [operationError, rollbackError],
          'wallet tag replacement and rollback both failed',
        );
      }
      try {
        await this.clearRecovery(session);
      } catch (finalizationError) {
        // The state rename may have committed before its final fsync reported
        // failure. The old tags are already confirmed; do not start another
        // tag mutation when journal presence is indeterminate.
        session.unusable = true;
        throw new AggregateError(
          [operationError, finalizationError],
          'wallet tag rollback completed but recovery finalization failed',
        );
      }
      throw operationError;
    }

    try {
      await this.clearRecovery(session);
    } catch (finalizationError) {
      // The target is fully confirmed. If deletion committed, reopen sees the
      // target; if not, the retained journal restores the old set. Never
      // compensate here because its durable presence is indeterminate.
      session.unusable = true;
      throw finalizationError;
    }
  }

  /** Replay a pending snapshot before SessionRegistry publishes a cold handle. */
  async recoverWorkspace(session: Session): Promise<void> {
    const recovery = this.currentRecovery(session);
    if (!recovery) return;

    const account = session.handle.accounts.bySlug(recovery.accountSlug as never);
    const wallet = account?.wallets.byId(recovery.walletId);
    if (!account || !wallet) {
      throw new Error('wallet tag recovery target is missing');
    }

    await replaceAndConfirm(wallet, recovery.oldTags);
    await this.clearRecovery(session);
  }

  private currentRecovery(session: Session): WalletTagRecovery | undefined {
    return this.state.tenant(session.tenantId).walletTagRecoveries?.[session.workspaceSlug];
  }

  private async writeRecovery(session: Session, recovery: WalletTagRecovery): Promise<void> {
    await this.state.mutate((draft) => {
      const tenant = draft.tenants[session.tenantId];
      const known = tenant?.workspaces.some((workspace) => workspace.slug === session.workspaceSlug);
      if (!tenant || !known) throw new Error('wallet tag recovery workspace is missing');
      const recoveries = (tenant.walletTagRecoveries ??= {});
      if (recoveries[session.workspaceSlug]) {
        throw new Error('wallet tag recovery is already pending');
      }
      recoveries[session.workspaceSlug] = recovery;
    });
  }

  private async clearRecovery(session: Session): Promise<void> {
    await this.state.mutate((draft) => {
      const recoveries = draft.tenants[session.tenantId]?.walletTagRecoveries;
      if (!recoveries) return;
      delete recoveries[session.workspaceSlug];
      if (Object.keys(recoveries).length === 0) {
        delete draft.tenants[session.tenantId]?.walletTagRecoveries;
      }
    });
  }
}

/**
 * Ask the pinned core implementation to perform its own normalization and
 * validation against a detached, non-persisting wallet before the real write.
 */
export async function normalizeWalletTags(tags: readonly string[]): Promise<readonly string[]> {
  const validatorAccount = {
    _enqueueMutation: <T>(fn: () => Promise<T>) => fn(),
    _persistInternal: async () => undefined,
  } as unknown as Account;
  const validator = new Wallet({ id: 0, account: validatorAccount });
  for (const tag of tags) await validator.addTag(tag);
  return [...validator.tags];
}

async function replaceAndConfirm(wallet: Wallet, tags: readonly string[]): Promise<void> {
  await wallet.clearTags();
  for (const tag of tags) await wallet.addTag(tag);
  // Confirm one final full-account snapshot after the multi-step mutation.
  await wallet._account._persist();
}

function sameTags(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}
