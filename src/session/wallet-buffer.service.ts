import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Account, Wallet } from 'wative-core';
import { TeeError } from '../common/tee-error';
import type { Tenant } from '../config/schemas';
import { ServiceStateService } from '../config/service-state.service';
import { AccountsService } from './accounts.service';
import { SessionRegistry, type Session } from './session.registry';
import { WalletTagsService } from './wallet-tags.service';
import { ALLOCATED_TAG } from './reserved-tags';
import { BUFFER_CONFIG, type BufferConfig } from './buffer-config';

/**
 * Buffer mode: pre-derive wallets under a shared HD account and hand out the
 * next unallocated one, so a creation request pays no key derivation on its
 * critical path.
 *
 * `allocate` runs inside the request's workspace mutex — the scan for the next
 * free wallet and the mark are therefore atomic against other requests on the
 * same workspace. The depth check and the refill both run OFF the request path,
 * as a single deduplicated background job per account. Rough mode (BUFFER_SIZE
 * unset or 0) keeps today's derive-on-demand behavior.
 */
@Injectable()
export class WalletBufferService {
  private readonly logger = new Logger(WalletBufferService.name);
  readonly #replenishing = new Set<string>();

  constructor(
    @Inject(BUFFER_CONFIG) private readonly config: BufferConfig,
    private readonly sessions: SessionRegistry,
    private readonly accounts: AccountsService,
    private readonly walletTags: WalletTagsService,
    private readonly state: ServiceStateService,
  ) {}

  async allocate(session: Session, tenant: Tenant, slug: string): Promise<Wallet> {
    const account = await this.sessions.requireAccount(session, slug);
    if (account.organizationType !== 'HD') {
      throw new TeeError('TEE_UNSUPPORTED_FOR_KIND', 'only an HD account can allocate wallets');
    }
    // Rough mode, or a buffer drained faster than it refills: derive on demand.
    if (!this.config.enabled) return this.deriveOne(session, tenant, slug, account);
    const wallet = this.firstUnallocated(account) ?? (await this.deriveOne(session, tenant, slug, account));
    await this.walletTags.setReservedTag(session, wallet, ALLOCATED_TAG);
    this.scheduleReplenish(session, tenant, slug);
    return wallet;
  }

  private firstUnallocated(account: Account): Wallet | undefined {
    return walletsOf(account).find((wallet) => !wallet.tags.includes(ALLOCATED_TAG));
  }

  private unallocatedCount(account: Account): number {
    return walletsOf(account).filter((wallet) => !wallet.tags.includes(ALLOCATED_TAG)).length;
  }

  /** Derive exactly one wallet and return it, identified by diff so wallet-id numbering is irrelevant. */
  private async deriveOne(
    session: Session,
    tenant: Tenant,
    slug: string,
    account: Account,
  ): Promise<Wallet> {
    const before = new Set(walletsOf(account).map((wallet) => wallet.id));
    await this.accounts.deriveWallets(session, tenant, slug, 1);
    const derived = walletsOf(account).find((wallet) => !before.has(wallet.id));
    if (!derived) throw new Error('derived wallet is missing from the account');
    return derived;
  }

  private scheduleReplenish(session: Session, tenant: Tenant, slug: string): void {
    // O(1) dedup keeps the request path cheap and stops concurrent requests
    // stacking multiple batch derives for the same account.
    const key = `${tenant.id}/${session.workspaceSlug}/${slug}`;
    if (this.#replenishing.has(key)) return;
    this.#replenishing.add(key);
    this.sessions.scheduleBackground(
      session,
      `buffer-replenish ${key}`,
      () => this.replenish(session, tenant, slug),
      () => this.#replenishing.delete(key),
    );
  }

  /** Background, under the session mutex: refill to a batch when below watermark. */
  private async replenish(session: Session, tenant: Tenant, slug: string): Promise<void> {
    const account = await this.sessions.requireAccount(session, slug);
    if (account.organizationType !== 'HD') return;
    // A prior job may have already refilled while this one waited on the mutex.
    if (this.unallocatedCount(account) >= this.config.lowWatermark) return;
    const walletTotal = this.state.tenant(tenant.id).walletTotal;
    const headroom = Math.max(0, tenant.limits.maxWallets - walletTotal);
    const toDerive = Math.min(this.config.batchSize, headroom);
    if (toDerive <= 0) return;
    await this.accounts.deriveWallets(session, tenant, slug, toDerive);
    this.logger.log(`buffer replenished ${tenant.id}/${slug} by ${toDerive}`);
  }
}

/** Materialize the account's wallet collection as an array (it exposes .map). */
function walletsOf(account: Account): Wallet[] {
  return account.wallets.map((wallet) => wallet);
}
