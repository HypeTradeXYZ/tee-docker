import { Injectable, Logger } from '@nestjs/common';
import { Wallet, type Account } from 'wative-core';
import { ServiceStateService } from '../config/service-state.service';
import type { WalletTagRecovery } from '../config/schemas';
import type { Session } from './session.registry';
import { isReservedTag, reservedTags } from './reserved-tags';

/**
 * Replaces wallet tags with a durable old-value recovery record.
 *
 * wative-core 2.5.1 persists clear/add operations individually. The journal
 * makes an interrupted sequence recoverable before a new session is
 * published, while ordinary failures compensate immediately.
 */
@Injectable()
export class WalletTagsService {
  private readonly logger = new Logger(WalletTagsService.name);

  constructor(private readonly state: ServiceStateService) {}

  /**
   * The caller-facing tag replacement. Reserved (sys:*) tags are internal state:
   * they are stripped from the caller's request AFTER core normalization — so no
   * whitespace or Unicode variant can normalize into the namespace past the
   * filter — and the wallet's existing ones are carried across unchanged, so a
   * caller can neither set nor clear them through this path.
   */
  async replace(session: Session, wallet: Wallet, requested: readonly string[]): Promise<void> {
    const callerTags = (await normalizeWalletTags(requested)).filter((tag) => !isReservedTag(tag));
    await this.writeTags(session, wallet, [...callerTags, ...reservedTags(wallet.tags)]);
  }

  /** Add a reserved tag, keeping every other tag. Idempotent. Service-only. */
  async setReservedTag(session: Session, wallet: Wallet, tag: string): Promise<void> {
    if (wallet.tags.includes(tag)) return;
    await this.writeTags(session, wallet, [...wallet.tags, tag]);
  }

  private async writeTags(session: Session, wallet: Wallet, desired: readonly string[]): Promise<void> {
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
      // Target gone — a damaged/undecryptable account is omitted from the
      // handle, so its tags can never be restored. Quarantine the unrecoverable
      // journal instead of hard-failing every reopen (which would leave the
      // workspace permanently un-openable), matching syncWalletCount's tolerance.
      this.logger.warn(
        `discarding unrecoverable wallet-tag journal for ${session.workspaceSlug}: `
          + `${recovery.accountSlug}#${recovery.walletId} is missing`,
      );
      await this.clearRecovery(session);
      return;
    }

    await replaceAndConfirm(wallet, recovery.oldTags);
    await this.clearRecovery(session);
  }

  private currentRecovery(session: Session): WalletTagRecovery | undefined {
    const recoveries = this.state.tenant(session.tenantId).walletTagRecoveries;
    return recoveries && Object.hasOwn(recoveries, session.workspaceSlug)
      ? recoveries[session.workspaceSlug]
      : undefined;
  }

  private async writeRecovery(session: Session, recovery: WalletTagRecovery): Promise<void> {
    await this.state.mutate((draft) => {
      if (!Object.hasOwn(draft.tenants, session.tenantId)) {
        throw new Error('wallet tag recovery workspace is missing');
      }
      const tenant = draft.tenants[session.tenantId];
      const known = tenant.workspaces.some((workspace) => workspace.slug === session.workspaceSlug);
      if (!known) throw new Error('wallet tag recovery workspace is missing');
      const recoveries = (tenant.walletTagRecoveries ??= {});
      if (Object.hasOwn(recoveries, session.workspaceSlug)) {
        throw new Error('wallet tag recovery is already pending');
      }
      recoveries[session.workspaceSlug] = recovery;
    });
  }

  private async clearRecovery(session: Session): Promise<void> {
    await this.state.mutate((draft) => {
      if (!Object.hasOwn(draft.tenants, session.tenantId)) return;
      const tenant = draft.tenants[session.tenantId];
      const recoveries = tenant.walletTagRecoveries;
      if (!recoveries) return;
      delete recoveries[session.workspaceSlug];
      if (Object.keys(recoveries).length === 0) {
        delete tenant.walletTagRecoveries;
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
