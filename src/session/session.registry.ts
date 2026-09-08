import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger, Optional, type OnApplicationShutdown } from '@nestjs/common';
import { Workspace, WativeError, type Account, type Slug } from 'wative-core';
import { TeeError } from '../common/tee-error';
import { PATHS, type Paths } from '../config/paths';
import type { Tenant } from '../config/schemas';
import { ServiceStateService } from '../config/service-state.service';
import {
  WorkspaceStorageService,
  type WorkspaceStorageIdentity,
} from '../workspaces/workspace-storage.service';
import { workspacePath } from '../workspaces/workspace-paths';
import { AsyncMutex, KeyedMutex } from './async-mutex';
import { SESSION_CAPACITY, type SessionCapacity } from './session-capacity';
import { RpcBoundaryService } from './rpc-boundary.service';
import type { AccountUnlockFailure, AccountUnlockLimiter } from '../auth/account-unlock-limiter';
import { WalletTagsService } from './wallet-tags.service';
import { damagedAccountSlugs } from './damaged-accounts';

/** How a token lease is confined below the workspace: to an account, or to one wallet. */
export interface LeaseBinding {
  /** Account slug an account- or wallet-scoped token may act within. */
  readonly account?: string;
  /** The single wallet a wallet-scoped token may act on. */
  readonly wallet?: { readonly acct: string; readonly wid: number };
  /**
   * An optional inquiry key (an X25519 recipient) that unlocks the sensitive
   * functionality list for this token and is the recipient its output seals to.
   */
  readonly inquiryKey?: string;
  /** When the inquiry key's capability expires (absolute ms); absent with no key. */
  readonly inquiryExpiresAt?: number;
  /**
   * A durable ("stay-exposed") lease pins its session and bound account unlocked
   * until process restart: neither the workspace TTLs nor the account custody TTL
   * auto-lock while it is live. In-memory only; a restart voids it.
   */
  readonly durable?: boolean;
}

export interface TokenLease {
  readonly jti: string;
  readonly scopes: readonly string[];
  /** Present on an account- or wallet-scoped lease; absent on a workspace lease. */
  readonly account?: string;
  /** Present only on a wallet-scoped lease. */
  readonly wallet?: { readonly acct: string; readonly wid: number };
  /** Inquiry key that unlocks this lease's sensitive functionality list, if any. */
  readonly inquiryKey?: string;
  /** Absolute ms at which the inquiry key's capability lapses. */
  readonly inquiryExpiresAt?: number;
  /** A durable lease pins its session + bound account unlocked until restart. */
  readonly durable?: boolean;
  expiresAt: number;
}

export type AccountCustody =
  | { readonly state: 'live'; readonly expiresAt: number }
  | { readonly state: 'locked'; readonly reason: 'manual' | 'expired' };

export const ACCOUNT_CUSTODY_CLOCK = Symbol('ACCOUNT_CUSTODY_CLOCK');
export type AccountCustodyClock = () => number;
export const ACCOUNT_CUSTODY_SCHEDULER = Symbol('ACCOUNT_CUSTODY_SCHEDULER');
export interface AccountCustodyScheduler {
  set(callback: () => void, delayMs: number): NodeJS.Timeout;
  clear(timer: NodeJS.Timeout): void;
}

export const systemAccountCustodyScheduler: AccountCustodyScheduler = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (timer) => clearTimeout(timer),
};

export interface Session {
  readonly sid: string;
  readonly tenantId: string;
  readonly workspaceSlug: string;
  readonly handle: Workspace;
  /** Needed by account creation; the unlocked core handle already retains it. */
  readonly password: string;
  readonly passwordDigest: Buffer;
  readonly absoluteExpiresAt: number;
  readonly accountTtlSec: number;
  readonly leases: Map<string, TokenLease>;
  readonly mutex: AsyncMutex;
  readonly storageIdentity: WorkspaceStorageIdentity;
  idleExpiresAt: number;
  unusable: boolean;
  /** Last time a lease on this session was minted or validated; drives LRU eviction. */
  lastUsedAt: number;
  /** Account unlock episodes and deny tombstones. Live deadlines never slide. */
  readonly accounts: Map<string, AccountCustody>;
  /** Explicit-unlock failure state, shared by every lease on this session. */
  readonly unlockFailures: Map<string, AccountUnlockFailure>;
  accountTimer: NodeJS.Timeout | null;
  accountTimerGeneration: number;
}

export interface SessionGrant {
  readonly session: Session;
  readonly lease: TokenLease;
  readonly exp: number;
}

interface WorkspaceEntry {
  readonly key: string;
  readonly tenantId: string;
  readonly workspaceSlug: string;
  state: 'opening' | 'active' | 'closing' | 'deleting';
  session?: Session;
  /** Temporary core handle retained while tenant-tier provisioning settles. */
  provisioningHandle?: Workspace;
}

const SWEEP_INTERVAL_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/**
 * The effective deadline a durable lease and its pinned account custody carry.
 * A hundred years out is "forever until restart" in practice while staying a
 * safe integer in both seconds and milliseconds. The durability predicates —
 * not this value — are authoritative; the far deadline only keeps the ordinary
 * per-lease and per-custody expiry arithmetic from ever firing on a pin.
 */
const DURABLE_HORIZON_MS = 100 * 365 * 24 * 3600 * 1000;

/**
 * Owns the one wative-core handle allowed for each tenant/workspace in this
 * process. wative-core is used as a singleton; tee-docker supplies admission,
 * lifecycle, and request serialization around it.
 */
@Injectable()
export class SessionRegistry implements OnApplicationShutdown {
  private readonly logger = new Logger(SessionRegistry.name);
  readonly #sessions = new Map<string, Session>();
  readonly #workspaces = new Map<string, WorkspaceEntry>();
  readonly #lifecycle = new KeyedMutex();
  readonly #lifecycleJobs = new Set<Promise<unknown>>();
  readonly #accountExpiryTasks = new Set<Promise<void>>();
  #sweeper: NodeJS.Timeout | null = null;
  #sweepInFlight: Promise<void> | null = null;
  #shuttingDown = false;
  readonly #now: AccountCustodyClock;
  readonly #accountScheduler: AccountCustodyScheduler;

  constructor(
    @Inject(PATHS) private readonly paths: Paths,
    private readonly state: ServiceStateService,
    @Inject(SESSION_CAPACITY) private readonly capacity: SessionCapacity,
    private readonly storage: WorkspaceStorageService,
    @Optional() private readonly rpcBoundary?: RpcBoundaryService,
    @Optional() @Inject(ACCOUNT_CUSTODY_CLOCK) clock?: AccountCustodyClock,
    @Optional() @Inject(ACCOUNT_CUSTODY_SCHEDULER) scheduler?: AccountCustodyScheduler,
    @Optional() private readonly walletTags?: WalletTagsService,
  ) {
    this.#now = clock ?? Date.now;
    this.#accountScheduler = scheduler ?? systemAccountCustodyScheduler;
    this.#sweeper = setInterval(() => {
      void this.runSweep().catch((err) => {
        this.logger.error(`session sweep failed: ${String(err)}`);
      });
    }, SWEEP_INTERVAL_MS);
    this.#sweeper.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    this.#shuttingDown = true;
    if (this.#sweeper) clearInterval(this.#sweeper);
    const failures: unknown[] = [];
    for (const session of this.#sessions.values()) this.clearAccountTimer(session);
    if (this.#accountExpiryTasks.size > 0) {
      const timerTasks = await Promise.allSettled([...this.#accountExpiryTasks]);
      failures.push(
        ...timerTasks
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => result.reason),
      );
    }
    // A sweep may already own or be queued for a session mutex. Let it finish
    // before locking handles so no cleanup touches core after custody drains.
    if (this.#sweepInFlight) {
      try {
        await this.#sweepInFlight;
      } catch (err) {
        failures.push(err);
      }
    }
    // Ordering only; phase 2 reports custody failures. See AUDIT-FINDINGS R-02.
    while (this.#lifecycleJobs.size > 0) {
      await Promise.allSettled([...this.#lifecycleJobs]);
    }
    // Acquiring every lifecycle key also waits for opens already in flight.
    const results = await Promise.allSettled(
      [...this.#workspaces.keys()].map((key) =>
        this.#lifecycle.runExclusive(key, async () => {
          const entry = this.#workspaces.get(key);
          if (entry?.session) await this.closeEntry(entry);
          else if (entry?.provisioningHandle) await this.closeProvisioningEntry(entry);
        }),
      ),
    );
    failures.push(
      ...results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason),
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, `failed to lock ${failures.length} workspace session(s)`);
    }
    // The quota ledger's lifetime process lock is the outermost custody lock.
    // Release it only after every decrypted workspace and queued sweep drained.
    await this.state.close();
  }

  /**
   * Lock every decrypted handle, best effort, for a process that is dying.
   *
   * Never throws: a fatal-exit handler cannot let an exception escape, and one
   * workspace failing to lock must not stop the others from locking. Returns
   * what failed so the caller can log it, and gives up after `timeoutMs` so a
   * wedged handle cannot keep key material resident indefinitely.
   */
  async lockAllHandlesBestEffort(timeoutMs = 5_000): Promise<unknown[]> {
    this.#shuttingDown = true;
    const failures: unknown[] = [];
    const note = (err: unknown): void => {
      failures.push(err);
    };

    // Custody first. Book-keeping that can throw must not abort the run before
    // a single handle is locked, so every step is individually guarded.
    try {
      if (this.#sweeper) clearInterval(this.#sweeper);
    } catch (err) {
      note(err);
    }
    for (const session of this.#sessions.values()) {
      try {
        this.clearAccountTimer(session);
      } catch (err) {
        note(err);
      }
    }

    const timedOut = Symbol('timeout');
    let deadline: NodeJS.Timeout | undefined;
    const expiry = new Promise<typeof timedOut>((resolve) => {
      deadline = setTimeout(() => resolve(timedOut), timeoutMs);
      deadline.unref();
    });

    try {
      // An entry still opening holds a decrypted handle that has not been
      // published yet, so iterating #workspaces alone would report success
      // while that handle dies unlocked. Draining the jobs and taking each
      // lifecycle key is what makes an in-flight open visible — the same
      // reason onApplicationShutdown does it.
      const drain = (async () => {
        while (this.#lifecycleJobs.size > 0) {
          await Promise.allSettled([...this.#lifecycleJobs]);
        }
        const results = await Promise.allSettled(
          [...this.#workspaces.keys()].map((key) =>
            this.#lifecycle.runExclusive(key, async () => {
              const entry = this.#workspaces.get(key);
              if (entry?.session) await this.closeEntry(entry);
              else if (entry?.provisioningHandle) await this.closeProvisioningEntry(entry);
            }),
          ),
        );
        for (const result of results) {
          if (result.status === 'rejected') note(result.reason);
        }
      })();

      if ((await Promise.race([drain.then(() => 'done' as const), expiry])) === timedOut) {
        // Name what is still holding material rather than a bare "timed out":
        // the operator needs to know which workspaces are unaccounted for.
        // Count every entry, not just published ones: an entry whose open has
        // not returned still holds a decrypted handle, and reporting 0 there
        // tells the operator nothing is at risk when something is.
        const stranded = [...this.#workspaces.values()].map((entry) => entry.workspaceSlug);
        note(new Error(`locking timed out with ${stranded.length} workspace(s) unlocked`));
      }
    } catch (err) {
      note(err);
    } finally {
      if (deadline) clearTimeout(deadline);
    }

    // Release the ledger's process lock. Skipping it converts a crash with
    // unlocked keys into a service that will not restart.
    //
    // Released unconditionally, deliberately. A conditional release was tried
    // and reverted: retaining the lock whenever a handle was still held made a
    // stranded lock DETERMINISTIC on a busy service, because the RPC deadline
    // (15s) exceeds this drain deadline (5s) and closeEntry waits on the same
    // session mutex a request holds. It bought protection against a successor
    // starting inside the release-to-exit gap — measured at 0.13-0.37ms, with
    // this function's only caller exiting in its own `finally`, so no
    // supervisor can observe it. It also did not establish the invariant it
    // claimed: create() and provisionWorkspace() hold decrypted handles before
    // publishing them, so the check saw nothing during exactly those windows.
    try {
      await this.state.close();
    } catch (err) {
      note(err);
    }
    return failures;
  }

  // Deliberately wider than create()'s authoritative check, so it can never
  // turn a would-be success into a free 404. Charge/404 gate only.
  knowsWorkspace(tenantId: string, workspaceSlug: string): boolean {
    if (this.#workspaces.has(workspaceKey(tenantId, workspaceSlug))) return true;
    return this.state.tenant(tenantId).workspaces.some((w) => w.slug === workspaceSlug);
  }

  /** Authenticate, open/reuse the singleton, and create one independently revocable token lease. */
  async create(
    tenant: Tenant,
    workspaceSlug: string,
    password: string,
    scopes: readonly string[],
    binding: LeaseBinding = {},
  ): Promise<SessionGrant> {
    const key = workspaceKey(tenant.id, workspaceSlug);
    // Validate the authenticated path components at the registry boundary as
    // well as in the storage service.
    workspacePath(this.paths.dataRoot, tenant.id, workspaceSlug);
    // Only a durable admission may evict a durable pin: a transient workspace
    // token must never destroy a stay-exposed key to obtain a handle. Reclaim
    // runs BEFORE taking the key lock so eviction never nests one lifecycle key
    // inside another. (A racing admission may reclaim a slot this call then loses
    // to the in-lock capacity gate — a bounded wasted eviction, not a hazard.)
    if (binding.durable === true && !this.hasReusableSession(tenant.id, workspaceSlug)) {
      await this.reclaimCapacity(tenant);
    }
    return this.trackLifecycleJob(this.#lifecycle.runExclusive(key, async () => {
      if (this.#shuttingDown) throw expired('application is shutting down');

      let entry = this.#workspaces.get(key);
      if (entry?.state === 'deleting') {
        throw new TeeError('TEE_WORKSPACE_NOT_FOUND', `workspace "${workspaceSlug}" not found`);
      }
      if (entry?.state === 'closing' && entry.provisioningHandle) {
        await this.closeProvisioningEntry(entry);
        entry = undefined;
      }
      if (entry?.state === 'closing' && entry.session) {
        // A prior lock failure deliberately leaves a tombstone. Retry it, but
        // never admit a successor handle while the old singleton may be live.
        await this.closeEntry(entry);
        entry = undefined;
      }
      if (entry?.state === 'active' && entry.session) {
        const session = entry.session;
        if (this.sessionExpired(session) || session.unusable) {
          await this.closeEntry(entry);
          entry = undefined;
        } else {
          // Do not issue a new bearer for a singleton whose backing storage
          // has disappeared or been replaced out of band.
          try {
            await this.storage.assertExisting(tenant.id, workspaceSlug, session.storageIdentity);
          } catch (err) {
            try {
              await this.closeEntry(entry);
            } catch (lockErr) {
              throw new AggregateError(
                [err, lockErr],
                `failed to reject changed singleton workspace ${key}`,
              );
            }
            throw err;
          }
          this.assertPassword(session, password);
          this.assertLeaseCapacity(session);
          this.touch(session, tenant.ttl.workspaceIdleSec);
          return this.addLease(session, scopes, binding);
        }
      }

      const known = this.state.tenant(tenant.id).workspaces.some((w) => w.slug === workspaceSlug);
      if (!known) {
        throw new TeeError('TEE_WORKSPACE_NOT_FOUND', `workspace "${workspaceSlug}" not found`);
      }

      // Existence errors win over capacity errors and allocate no opening
      // entry. The guarded provider repeats this check at open time.
      await this.storage.assertExisting(tenant.id, workspaceSlug);
      this.assertHandleCapacity(tenant);
      entry = { key, tenantId: tenant.id, workspaceSlug, state: 'opening' };
      this.#workspaces.set(key, entry);

      try {
        let session: Session | undefined;
        await this.storage.openExisting(tenant.id, workspaceSlug, password, (handle, identity) => {
          const now = this.#now();
          session = {
            sid: randomUUID(),
            tenantId: tenant.id,
            workspaceSlug,
            handle,
            password,
            passwordDigest: digestPassword(password),
            idleExpiresAt: now + tenant.ttl.workspaceIdleSec * 1000,
            absoluteExpiresAt: now + tenant.ttl.workspaceAbsoluteSec * 1000,
            accountTtlSec: tenant.ttl.accountAbsoluteSec,
            leases: new Map(),
            mutex: new AsyncMutex(),
            storageIdentity: identity,
            unusable: false,
            lastUsedAt: now,
            accounts: new Map(),
            unlockFailures: new Map(),
            accountTimer: null,
            accountTimerGeneration: 0,
          };
          // Attach the returned handle before any fallible post-open work. If
          // storage validation, reconciliation, or shutdown cleanup fails,
          // this becomes the same fail-closed tombstone as a normal close.
          entry.session = session;
        });
        if (!session) throw new Error('workspace storage opener returned without a handle');
        if (this.#shuttingDown) throw expired('application is shutting down');

        // Never publish a core handle whose Networks can reach tenant URLs
        // directly. Existing workspaces are migrated before their first use;
        // new workspaces are already hardened by the provisioning path.
        await this.rpcBoundary?.hardenWorkspace(
          session.handle,
          tenant.id,
          workspaceSlug,
          tenant.rpc,
        );

        // A prior tag replacement may have stopped between core's individual
        // account writes. Restore its durable old-value snapshot before this
        // handle can receive a lease.
        await this.walletTags?.recoverWorkspace(session);

        // A fresh handle must agree with the ledger before it is published.
        await this.syncWalletCount(session);

        entry.state = 'active';
        entry.session = session;
        this.#sessions.set(session.sid, session);
        const grant = this.addLease(session, scopes, binding);
        this.logger.log(`session opened: ${tenant.id}/${workspaceSlug} (${session.sid})`);
        return grant;
      } catch (err) {
        if (entry.session) {
          try {
            await this.closeEntry(entry);
          } catch (lockErr) {
            throw new AggregateError(
              [err, lockErr],
              `failed to initialize and close singleton workspace ${key}`,
            );
          }
        }
        if (this.#workspaces.get(key) === entry) this.#workspaces.delete(key);
        throw err;
      }
    }));
  }

  /**
   * Run tenant-tier provisioning under the same key gate as mint and delete.
   * The callback must not call another lifecycle-acquiring registry method.
   */
  async provisionWorkspace<T>(
    tenant: Tenant,
    workspaceSlug: string,
    provision: (retainHandle: (handle: Workspace) => void) => Promise<T>,
  ): Promise<T> {
    const tenantId = tenant.id;
    const key = workspaceKey(tenantId, workspaceSlug);
    return this.trackLifecycleJob(this.#lifecycle.runExclusive(key, async () => {
      if (this.#shuttingDown) throw expired('application is shutting down');
      let existing = this.#workspaces.get(key);
      if (existing?.state === 'closing' && existing.provisioningHandle) {
        await this.closeProvisioningEntry(existing);
        existing = undefined;
      }
      if (existing) {
        throw new TeeError('TEE_WORKSPACE_IN_USE', `workspace "${workspaceSlug}" is in use`);
      }
      this.assertHandleCapacity(tenant);
      const entry: WorkspaceEntry = {
        key,
        tenantId,
        workspaceSlug,
        state: 'opening',
      };
      this.#workspaces.set(key, entry);
      try {
        const result = await provision((handle) => {
          if (entry.provisioningHandle && entry.provisioningHandle !== handle) {
            throw new Error(`provisioning attempted to replace core handle for ${key}`);
          }
          entry.provisioningHandle = handle;
        });
        if (entry.provisioningHandle) await this.closeProvisioningEntry(entry);
        else if (this.#workspaces.get(key) === entry) this.#workspaces.delete(key);
        return result;
      } catch (error) {
        if (!entry.provisioningHandle) {
          if (this.#workspaces.get(key) === entry) this.#workspaces.delete(key);
          throw error;
        }
        entry.state = 'closing';
        try {
          await this.closeProvisioningEntry(entry);
        } catch (lockError) {
          throw new AggregateError(
            [error, lockError],
            `provisioning and core-handle cleanup both failed for ${key}`,
          );
        }
        throw error;
      }
    }));
  }

  /**
   * Revoke/drain a singleton and keep storage + ledger deletion inside the
   * same lifecycle critical section. A deleting tombstone blocks mint/create
   * but consumes no unlocked-handle capacity.
   */
  async deleteWorkspace(
    tenantId: string,
    workspaceSlug: string,
    force: boolean,
    known: () => boolean,
    removeStorageAndLedger: () => Promise<void>,
  ): Promise<void> {
    const key = workspaceKey(tenantId, workspaceSlug);
    await this.#lifecycle.runExclusive(key, async () => {
      if (this.#shuttingDown) throw expired('application is shutting down');
      if (!known()) {
        throw new TeeError('TEE_WORKSPACE_NOT_FOUND', `workspace "${workspaceSlug}" not found`);
      }

      let entry = this.#workspaces.get(key);
      if (entry?.provisioningHandle) {
        await this.closeProvisioningEntry(entry);
        entry = undefined;
      }
      if (entry?.state !== 'deleting') {
        if (entry && !force && this.entryInUse(entry)) {
          throw new TeeError('TEE_WORKSPACE_IN_USE', `workspace "${workspaceSlug}" is in use`);
        }
        if (entry?.session) await this.closeEntry(entry);

        entry = { key, tenantId, workspaceSlug, state: 'deleting' };
        this.#workspaces.set(key, entry);
      }

      // Retain this tombstone on either filesystem or ledger failure. A retry
      // re-enters here, while mint and provisioning remain fail-closed.
      await removeStorageAndLedger();
      if (this.#workspaces.get(key) === entry) this.#workspaces.delete(key);
    });
  }

  /** Validate one signed token lease and slide the workspace idle deadline. */
  get(
    sid: string,
    jti: string,
    tenantId: string,
    workspaceSlug: string,
    scopes: readonly string[],
    idleSec: number,
    touchIdle = true,
    binding: LeaseBinding = {},
  ): { session: Session; lease: TokenLease } | null {
    const session = this.#sessions.get(sid);
    if (
      !session ||
      session.tenantId !== tenantId ||
      session.workspaceSlug !== workspaceSlug ||
      session.unusable
    ) {
      return null;
    }

    const now = this.#now();
    if (this.sessionExpired(session, now)) {
      this.destroyInBackground(sid, 'expired session');
      return null;
    }

    const lease = session.leases.get(jti);
    if (
      !lease ||
      lease.expiresAt <= now ||
      !sameScopes(lease.scopes, scopes) ||
      !sameBinding(lease, binding)
    ) {
      if (lease?.expiresAt && lease.expiresAt <= now) {
        this.releaseInBackground(sid, jti, 'expired token lease');
      }
      return null;
    }

    if (touchIdle) this.touch(session, idleSec, now);
    session.lastUsedAt = now;
    return { session, lease };
  }

  /** Refresh one live lease without opening a handle, checking a password, or adding a ref. */
  async refresh(session: Session, jti: string, idleSec: number): Promise<SessionGrant> {
    const key = workspaceKey(session.tenantId, session.workspaceSlug);
    return this.#lifecycle.runExclusive(key, () => {
      if (this.#sessions.get(session.sid) !== session || this.sessionExpired(session)) {
        throw expired('no session');
      }
      const lease = session.leases.get(jti);
      if (!lease || lease.expiresAt <= this.#now()) throw expired('no lease');

      this.touch(session, idleSec);
      const now = this.#now();
      const exp = lease.durable
        ? Math.floor((now + DURABLE_HORIZON_MS) / 1000)
        : tokenExpiry(session, now);
      lease.expiresAt = exp * 1000;
      return { session, lease, exp };
    });
  }

  /** Release only this bearer lease. The singleton closes after its final lease. */
  async release(sid: string, jti: string): Promise<void> {
    const session = this.#sessions.get(sid);
    if (!session) return;
    const key = workspaceKey(session.tenantId, session.workspaceSlug);
    await this.#lifecycle.runExclusive(key, async () => {
      if (this.#sessions.get(sid) !== session) return;
      session.leases.delete(jti);
      if (session.leases.size === 0) {
        const entry = this.#workspaces.get(key);
        if (entry?.session === session) await this.closeEntry(entry);
      }
    });
  }

  /** Destroy a complete shared session, revoking every lease. */
  async destroy(sid: string): Promise<void> {
    const session = this.#sessions.get(sid);
    if (!session) return;
    const key = workspaceKey(session.tenantId, session.workspaceSlug);
    await this.#lifecycle.runExclusive(key, async () => {
      const entry = this.#workspaces.get(key);
      if (entry?.session === session) await this.closeEntry(entry);
    });
  }

  /** Serialize every core-backed HTTP handler on the singleton workspace handle. */
  async withSession<T>(session: Session, fn: () => T | Promise<T>): Promise<T> {
    try {
      return await session.mutex.runExclusive(async () => {
        if (
          this.#sessions.get(session.sid) !== session
          || session.unusable
          || this.sessionExpired(session, this.#now())
        ) {
          if (this.#sessions.get(session.sid) === session) session.unusable = true;
          throw expired('session is closing');
        }
        let result: T | undefined;
        let operationFailed = false;
        let operationError: unknown;
        try {
          result = await fn();
        } catch (err) {
          operationFailed = true;
          operationError = err;
        }
        try {
          this.expireDueAccounts(session, this.#now());
        } catch (expiryError) {
          if (operationFailed) {
            throw new AggregateError(
              [operationError, expiryError],
              'operation and account zeroization both failed',
            );
          }
          throw expiryError;
        } finally {
          this.scheduleAccountTimer(session);
        }
        if (operationFailed) throw operationError;
        return result as T;
      });
    } finally {
      if (session.unusable) this.destroyInBackground(session.sid, 'unusable session');
    }
  }

  markUnusable(session: Session): void {
    session.unusable = true;
  }

  private trackLifecycleJob<T>(job: Promise<T>): Promise<T> {
    this.#lifecycleJobs.add(job);
    void job.finally(() => this.#lifecycleJobs.delete(job)).catch(() => undefined);
    return job;
  }

  async requireAccount(session: Session, slug: string): Promise<Account> {
    const account = this.findAccount(session, slug);
    const now = this.#now();
    const custody = session.accounts.get(slug);
    // A durable lease keeps its inherit-password account exposed for the life of
    // the process. Custody recorded before the key was minted carries an ordinary
    // deadline, so refresh it here rather than letting a lapsed deadline lock the
    // account out from under a live durable key. A deliberate manual lock stands.
    if (
      this.isAccountPinned(session, slug)
      && !account.hasOwnPassword
      && !(custody?.state === 'locked' && custody.reason === 'manual')
    ) {
      const wasLocked = account.locked;
      try {
        if (account.locked) await account.tryUnlock();
      } catch (err) {
        this.failClosedAccountUnlock(session, slug, account, wasLocked);
        throw err;
      }
      this.recordAccountExposure(session, slug, now);
      return account;
    }
    if (custody?.state === 'live') {
      if (now < custody.expiresAt && !account.locked) return account;
      if (now < custody.expiresAt && account.locked) {
        session.accounts.set(slug, { state: 'locked', reason: 'manual' });
        this.scheduleAccountTimer(session);
        throw accountLocked(slug);
      }
      this.expireAccount(session, slug, account);
      throw accountLocked(slug);
    }
    if (custody?.state === 'locked') throw accountLocked(slug);
    if (account.hasOwnPassword) {
      throw accountLocked(slug);
    }
    const wasLocked = account.locked;
    try {
      if (account.locked) await account.tryUnlock();
    } catch (err) {
      this.failClosedAccountUnlock(session, slug, account, wasLocked);
      throw err;
    }
    this.recordAccountExposure(session, slug, this.#now());
    return account;
  }

  async unlockAccount(
    session: Session,
    slug: string,
    password: string,
    limiter: AccountUnlockLimiter,
    idleSec: number,
  ): Promise<void> {
    const account = this.findAccount(session, slug);
    let before = session.accounts.get(slug);
    const admissionNow = this.#now();
    if (before?.state === 'live' && admissionNow >= before.expiresAt) {
      this.expireAccount(session, slug, account);
      before = session.accounts.get(slug);
    }
    const liveDeadline = before?.state === 'live' ? before.expiresAt : undefined;
    const wasLocked = account.locked;
    await limiter.verify(session, slug, async () => {
      this.touch(session, idleSec);
      try {
        await account.tryUnlock(password);
      } catch (err) {
        this.failClosedAccountUnlock(session, slug, account, wasLocked, before);
        throw err;
      }
    });
    const now = this.#now();
    if (this.sessionExpired(session, now)) {
      session.unusable = true;
      try {
        this.expireAccount(session, slug, account);
      } catch (lockError) {
        throw new AggregateError(
          [expired('session expired during account unlock'), lockError],
          'session expired and account zeroization failed',
        );
      }
      throw expired('session expired during account unlock');
    }
    if (liveDeadline !== undefined && !this.isAccountPinned(session, slug)) {
      if (now >= liveDeadline) {
        this.expireAccount(session, slug, account);
        throw accountLocked(slug);
      }
      // Re-verifying an already-live account does not renew bearer custody.
      session.accounts.set(slug, { state: 'live', expiresAt: liveDeadline });
      this.scheduleAccountTimer(session);
      return;
    }
    // A durable lease's account always (re)pins to the far-future custody, even
    // when it was already live on an ordinary deadline before the key was minted.
    this.recordAccountExposure(session, slug, now);
  }

  lockAccount(session: Session, slug: string): void {
    const account = this.findAccount(session, slug);
    session.accounts.set(slug, { state: 'locked', reason: 'manual' });
    try {
      account.lock();
    } catch (err) {
      session.unusable = true;
      throw err;
    }
    this.scheduleAccountTimer(session);
  }

  /** Start custody for an account that core has just returned unlocked. */
  recordAccountExposure(session: Session, slug: string, now = this.#now()): void {
    if (this.sessionExpired(session, now)) {
      session.unusable = true;
      const sessionError = expired('account exposure began after session expiry');
      try {
        this.expireAccount(session, slug, this.findAccount(session, slug));
      } catch (lockError) {
        throw new AggregateError(
          [sessionError, lockError],
          'account exposure crossed session expiry and zeroization failed',
        );
      }
      throw expired('account exposure began after session expiry');
    }
    session.accounts.set(slug, { state: 'live', expiresAt: this.accountExpiry(session, now, slug) });
    this.scheduleAccountTimer(session);
  }

  clearAccountCustody(session: Session, slug: string): void {
    session.accounts.delete(slug);
    session.unlockFailures.delete(slug);
    this.scheduleAccountTimer(session);
  }

  /**
   * A durable key binds an account by its slug, and a slug is reusable once the
   * account is dropped. Deleting a durable-bound account therefore lets a later
   * same-slug account inherit the old key's authority — the accepted residual of
   * the slug identity anchor. Record the deletion so that rebind is auditable.
   */
  auditDurableAccountDeletion(session: Session, slug: string): void {
    if (!this.isAccountPinned(session, slug)) return;
    let durableKeys = 0;
    for (const lease of session.leases.values()) {
      if (lease.durable && (lease.account === slug || lease.wallet?.acct === slug)) durableKeys += 1;
    }
    this.logger.warn({
      event: 'durable_account_deleted',
      tenantId: session.tenantId,
      workspaceSlug: session.workspaceSlug,
      accountSlug: slug,
      durableKeys,
    });
  }

  /** Authoritatively recount one singleton handle and persist its tenant total. */
  async syncWalletCount(session: Session): Promise<void> {
    // A damaged account is missing from the collection, so this count is an
    // undercount. Writing it as authoritative would permanently shrink the
    // tenant's quota; leave the stored value alone until the damage is fixed.
    const damaged = damagedAccountSlugs(session.handle);
    if (damaged.length > 0) {
      this.logger.error(
        `refusing to reconcile wallet count for ${session.workspaceSlug}: `
        + `${damaged.length} damaged account(s)`,
      );
      return;
    }

    let walletCount = 0;
    for (const account of session.handle.accounts) walletCount += account.wallets.length;

    await this.state.mutate((draft) => {
      if (!Object.hasOwn(draft.tenants, session.tenantId)) {
        throw new Error(`missing ledger tenant ${session.tenantId}`);
      }
      const tenant = draft.tenants[session.tenantId];
      const entry = tenant.workspaces.find((w) => w.slug === session.workspaceSlug);
      if (!entry) throw new Error(`missing ledger workspace ${session.workspaceSlug}`);
      entry.walletCount = walletCount;
      tenant.walletTotal = tenant.workspaces.reduce((sum, w) => sum + w.walletCount, 0);
    });
  }

  private async closeEntry(entry: WorkspaceEntry): Promise<void> {
    const session = entry.session;
    if (!session) {
      this.#workspaces.delete(entry.key);
      return;
    }

    entry.state = 'closing';
    // Order is load-bearing and must NOT be changed to lock-first: deleting the
    // session is the revocation fence withSession re-checks under this very
    // mutex, so locking before it would admit a request against a locked handle
    // and leave leases live on a handle whose lock just failed. Guard each step
    // instead — a book-keeping throw must not cost the lock, and must not be
    // rethrown, or the aggregate re-enters shutdown and skips state.close().
    const bookkeep = (what: string, run: () => void): void => {
      try {
        run();
      } catch (err) {
        // The catch itself must not throw: a failing logger here would abort
        // the close before handle.lock(), which is the defect these guards
        // exist to prevent, moved up one frame.
        try {
          this.logger.error(`close bookkeeping ${what} failed for ${session.sid}: ${String(err)}`);
        } catch {
          // Nothing left to report with.
        }
      }
    };
    bookkeep('clearAccountTimer', () => this.clearAccountTimer(session));
    bookkeep('sessions.delete', () => { this.#sessions.delete(session.sid); });
    bookkeep('leases.clear', () => session.leases.clear());
    bookkeep('revokeWorkspace', () => {
      this.rpcBoundary?.revokeWorkspace(session.tenantId, session.workspaceSlug);
    });
    await session.mutex.runExclusive(async () => {
      try {
        await session.handle.lock();
      } catch (err) {
        this.logger.error(`lock failed for session ${session.sid}: ${String(err)}`);
        // Keep the closing entry as a fail-closed tombstone. A later mint may
        // retry the lock under the same lifecycle mutex but cannot bypass it.
        throw err;
      }
    });
    if (this.#workspaces.get(entry.key) === entry) this.#workspaces.delete(entry.key);
    this.logger.log(`session closed: ${session.tenantId}/${session.workspaceSlug} (${session.sid})`);
  }

  private async closeProvisioningEntry(entry: WorkspaceEntry): Promise<void> {
    const handle = entry.provisioningHandle;
    if (!handle) {
      if (this.#workspaces.get(entry.key) === entry) this.#workspaces.delete(entry.key);
      return;
    }
    entry.state = 'closing';
    try {
      await handle.lock();
    } catch (err) {
      this.logger.error(
        `provisioning lock failed for ${entry.tenantId}/${entry.workspaceSlug}: ${String(err)}`,
      );
      throw err;
    }
    if (this.#workspaces.get(entry.key) === entry) this.#workspaces.delete(entry.key);
  }

  private addLease(
    session: Session,
    scopes: readonly string[],
    binding: LeaseBinding = {},
  ): SessionGrant {
    this.assertLeaseCapacity(session);
    let jti: string;
    do jti = randomUUID(); while (session.leases.has(jti));
    const now = this.#now();
    // A durable lease outlives the workspace TTLs; it carries a far-future
    // deadline instead of the session's remaining lifetime, and its very
    // presence pins the session (see hasDurableLease/sessionExpired).
    const durable = binding.durable === true;
    const exp = durable
      ? Math.floor((now + DURABLE_HORIZON_MS) / 1000)
      : tokenExpiry(session, now);
    const lease: TokenLease = {
      jti,
      scopes: [...scopes],
      expiresAt: exp * 1000,
      ...(binding.account !== undefined ? { account: binding.account } : {}),
      ...(binding.wallet !== undefined ? { wallet: binding.wallet } : {}),
      ...(binding.inquiryKey !== undefined ? { inquiryKey: binding.inquiryKey } : {}),
      ...(binding.inquiryExpiresAt !== undefined
        ? { inquiryExpiresAt: binding.inquiryExpiresAt }
        : {}),
      ...(durable ? { durable: true } : {}),
    };
    session.leases.set(jti, lease);
    session.lastUsedAt = now;
    return { session, lease, exp };
  }

  private assertLeaseCapacity(session: Session): void {
    if (session.leases.size >= this.capacity.leasesPerWorkspace) {
      throw capacityError('workspace', this.capacity.leasesPerWorkspace);
    }
  }

  private chargedEntries(): WorkspaceEntry[] {
    return [...this.#workspaces.values()].filter((entry) => entry.state !== 'deleting');
  }

  private assertHandleCapacity(tenant: Tenant): void {
    const charged = this.chargedEntries();
    const tenantCount = charged.filter((entry) => entry.tenantId === tenant.id).length;
    if (tenantCount >= tenant.limits.maxUnlockedWorkspaces) {
      throw capacityError('tenant', tenant.limits.maxUnlockedWorkspaces);
    }
    if (charged.length >= this.capacity.process) {
      throw capacityError('process', this.capacity.process);
    }
  }

  /**
   * Make room for a new workspace handle by evicting the least-recently-used
   * durable pin — the stay-exposed model's coarse capacity policy. Runs BEFORE
   * create() takes the new key's lifecycle lock, so an eviction (which locks the
   * victim's key) never nests one lifecycle key inside another and cannot deadlock
   * two concurrent evicting mints. Best-effort: if nothing durable can be evicted,
   * the in-lock assertHandleCapacity still throws the ordinary capacity error.
   */
  private async reclaimCapacity(tenant: Tenant): Promise<void> {
    if (this.#shuttingDown) return;
    const overTenant =
      this.chargedEntries().filter((e) => e.tenantId === tenant.id).length
      >= tenant.limits.maxUnlockedWorkspaces;
    if (overTenant) {
      await this.evictLruDurable((entry) => entry.tenantId === tenant.id, 'tenant');
    }
    // Process-cap eviction stays within the tenant's OWN pins — one tenant must
    // never evict another's stay-exposed key. If the process is full of other
    // tenants' pins, this admission falls through to the ordinary capacity error.
    if (this.chargedEntries().length >= this.capacity.process) {
      await this.evictLruDurable((entry) => entry.tenantId === tenant.id, 'process');
    }
  }

  /** Evict the LRU durable ("stay-exposed") session matching `match`, if any. */
  private async evictLruDurable(
    match: (entry: WorkspaceEntry) => boolean,
    reason: 'tenant' | 'process',
  ): Promise<void> {
    let victim: Session | undefined;
    for (const entry of this.#workspaces.values()) {
      if (entry.state !== 'active' || !entry.session || !match(entry)) continue;
      const session = entry.session;
      if (session.unusable || !this.hasDurableLease(session)) continue;
      if (!victim || session.lastUsedAt < victim.lastUsedAt) victim = session;
    }
    if (!victim) return;
    this.logger.warn({
      event: 'durable_key_evicted',
      reason,
      tenantId: victim.tenantId,
      workspaceSlug: victim.workspaceSlug,
      sid: victim.sid,
      keys: victim.leases.size,
    });
    await this.destroy(victim.sid);
  }

  /** True when this workspace already has a live session a new lease can reuse. */
  private hasReusableSession(tenantId: string, workspaceSlug: string): boolean {
    const entry = this.#workspaces.get(workspaceKey(tenantId, workspaceSlug));
    return (
      entry?.state === 'active'
      && entry.session !== undefined
      && !entry.session.unusable
      && !this.sessionExpired(entry.session)
    );
  }

  private entryInUse(entry: WorkspaceEntry, now = this.#now()): boolean {
    if (entry.state !== 'active' || !entry.session) return true;
    const session = entry.session;
    if (this.sessionExpired(session, now) || session.unusable) return false;
    for (const [jti, lease] of session.leases) {
      if (lease.expiresAt <= now) session.leases.delete(jti);
    }
    return session.leases.size > 0;
  }

  private assertPassword(session: Session, password: string): void {
    const candidate = digestPassword(password);
    if (!timingSafeEqual(session.passwordDigest, candidate)) {
      throw new WativeError('BAD_PASSWORD', 'workspace password is incorrect');
    }
  }

  private touch(session: Session, idleSec: number, now = this.#now()): void {
    session.idleExpiresAt = Math.min(now + idleSec * 1000, session.absoluteExpiresAt);
  }

  private sessionExpired(session: Session, now = this.#now()): boolean {
    // A live durable lease pins the session: it never idle/absolute-expires while
    // any stay-exposed key references it. A restart is the only revocation, and
    // releasing the last durable lease restores ordinary reaping on the next call.
    if (this.hasDurableLease(session)) return false;
    return now >= session.absoluteExpiresAt || now >= session.idleExpiresAt;
  }

  /** True while any live durable ("stay-exposed") lease references this session. */
  private hasDurableLease(session: Session): boolean {
    for (const lease of session.leases.values()) {
      if (lease.durable) return true;
    }
    return false;
  }

  /** True when a live durable lease binds this account, directly or via a wallet. */
  private isAccountPinned(session: Session, slug: string): boolean {
    for (const lease of session.leases.values()) {
      if (lease.durable && (lease.account === slug || lease.wallet?.acct === slug)) return true;
    }
    return false;
  }

  private findAccount(session: Session, slug: string): Account {
    const account = session.handle.accounts.bySlug(asSlug(slug));
    if (!account) throw new TeeError('TEE_ACCOUNT_NOT_FOUND', `account "${slug}" not found`);
    return account;
  }

  private accountExpiry(session: Session, now: number, slug?: string): number {
    // A durable lease's bound account stays unlocked until restart, so it carries
    // the far-future deadline rather than the ordinary custody window.
    if (slug !== undefined && this.isAccountPinned(session, slug)) {
      return now + DURABLE_HORIZON_MS;
    }
    return Math.min(now + session.accountTtlSec * 1000, session.absoluteExpiresAt);
  }

  private failClosedAccountUnlock(
    session: Session,
    slug: string,
    account: Account,
    wasLocked: boolean,
    restore?: AccountCustody,
  ): void {
    if (restore) session.accounts.set(slug, restore);
    else session.accounts.delete(slug);
    // Some providers can throw after changing the live object. If that
    // happened, zeroize it now; an unsuccessful cleanup retires the session.
    if (wasLocked && !account.locked) {
      try {
        account.lock();
      } catch {
        session.unusable = true;
      }
    }
    this.scheduleAccountTimer(session);
  }

  private expireAccount(session: Session, slug: string, account: Account): void {
    session.accounts.set(slug, { state: 'locked', reason: 'expired' });
    try {
      account.lock();
    } catch (err) {
      session.unusable = true;
      throw err;
    } finally {
      this.scheduleAccountTimer(session);
    }
  }

  private expireDueAccounts(session: Session, now: number): void {
    const failures: unknown[] = [];
    for (const [slug, custody] of session.accounts) {
      if (custody.state !== 'live' || now < custody.expiresAt) continue;
      // A durable lease's bound account never auto-locks; skip it even if its
      // recorded deadline somehow lapsed.
      if (this.isAccountPinned(session, slug)) continue;
      const account = session.handle.accounts.bySlug(asSlug(slug));
      if (!account) {
        session.accounts.delete(slug);
        continue;
      }
      try {
        this.expireAccount(session, slug, account);
      } catch (err) {
        failures.push(err);
      }
    }
    if (failures.length > 0) {
      session.unusable = true;
      throw new AggregateError(failures, `failed to lock ${failures.length} expired account(s)`);
    }
  }

  private scheduleAccountTimer(session: Session): void {
    this.clearAccountTimer(session);
    if (
      this.#shuttingDown
      || session.unusable
      || this.#sessions.get(session.sid) !== session
    ) return;
    let earliest = Number.POSITIVE_INFINITY;
    for (const [slug, custody] of session.accounts) {
      // A pinned account has no auto-lock deadline, so it never arms the timer.
      if (custody.state === 'live' && !this.isAccountPinned(session, slug)) {
        earliest = Math.min(earliest, custody.expiresAt);
      }
    }
    if (!Number.isFinite(earliest)) return;
    const delay = Math.min(Math.max(0, earliest - this.#now()), MAX_TIMER_DELAY_MS);
    const generation = ++session.accountTimerGeneration;
    session.accountTimer = this.#accountScheduler.set(
      () => this.startAccountExpiryTask(session, generation),
      delay,
    );
    session.accountTimer.unref?.();
  }

  private clearAccountTimer(session: Session): void {
    session.accountTimerGeneration += 1;
    if (!session.accountTimer) return;
    this.#accountScheduler.clear(session.accountTimer);
    session.accountTimer = null;
  }

  private startAccountExpiryTask(session: Session, generation: number): void {
    if (generation !== session.accountTimerGeneration || !session.accountTimer) return;
    session.accountTimer = null;
    const task = session.mutex.runExclusive(async () => {
      if (
        this.#shuttingDown
        || session.unusable
        || this.#sessions.get(session.sid) !== session
      ) return;
      this.expireDueAccounts(session, this.#now());
      this.scheduleAccountTimer(session);
    });
    this.#accountExpiryTasks.add(task);
    void task
      .catch((err) => {
        this.logger.error(`account expiry failed for session ${session.sid}: ${String(err)}`);
        this.destroyInBackground(session.sid, 'account expiry failure');
      })
      .finally(() => this.#accountExpiryTasks.delete(task));
  }

  private async sweep(): Promise<void> {
    const now = this.#now();
    const failures: unknown[] = [];
    for (const session of [...this.#sessions.values()]) {
      try {
        if (this.sessionExpired(session, now) || session.unusable) {
          await this.destroy(session.sid);
          continue;
        }

        for (const [jti, lease] of session.leases) {
          if (lease.expiresAt <= now) session.leases.delete(jti);
        }
        if (session.leases.size === 0) {
          await this.destroy(session.sid);
          continue;
        }

        await session.mutex.runExclusive(() => {
          if (this.#sessions.get(session.sid) !== session || session.unusable) return;
          this.expireDueAccounts(session, this.#now());
          this.scheduleAccountTimer(session);
        });
      } catch (err) {
        // A failed singleton lock keeps its capacity-charged tombstone, but it
        // must not prevent unrelated expired sessions from being reaped.
        failures.push(err);
        if (session.unusable) {
          try {
            await this.destroy(session.sid);
          } catch (closeError) {
            failures.push(closeError);
          }
        }
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `failed to sweep ${failures.length} workspace session(s)`);
    }
  }

  /** Prevent overlapping timer sweeps if one core lock is slow. */
  private runSweep(): Promise<void> {
    if (this.#sweepInFlight) return this.#sweepInFlight;
    const pending = this.sweep().finally(() => {
      if (this.#sweepInFlight === pending) this.#sweepInFlight = null;
    });
    this.#sweepInFlight = pending;
    return pending;
  }

  private destroyInBackground(sid: string, reason: string): void {
    void this.destroy(sid).catch((err) => {
      this.logger.error(`failed to close ${reason} ${sid}: ${String(err)}`);
    });
  }

  private releaseInBackground(sid: string, jti: string, reason: string): void {
    void this.release(sid, jti).catch((err) => {
      this.logger.error(`failed to release ${reason} ${sid}/${jti}: ${String(err)}`);
    });
  }

  get size(): number {
    return this.#sessions.size;
  }

  get workspaceCount(): number {
    return this.#workspaces.size;
  }

  get leaseCount(): number {
    let count = 0;
    for (const session of this.#sessions.values()) count += session.leases.size;
    return count;
  }
}

function workspaceKey(tenantId: string, workspaceSlug: string): string {
  return `${tenantId}\0${workspaceSlug}`;
}

function digestPassword(password: string): Buffer {
  return createHash('sha256').update(password, 'utf8').digest();
}

function tokenExpiry(session: Session, now = Date.now()): number {
  const exp = Math.floor(Math.min(session.idleExpiresAt, session.absoluteExpiresAt) / 1000);
  if (exp <= Math.floor(now / 1000)) throw expired('no token lifetime remains');
  return exp;
}

function sameScopes(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((scope, index) => scope === right[index]);
}

/**
 * A token's claimed binding must match its server-side lease exactly. The lease
 * is authoritative: a tampered or replayed claim that names a different account
 * or wallet than the lease was minted with is rejected, and a scoped lease can
 * never be reached by an unbound (workspace) claim.
 */
function sameBinding(lease: TokenLease, binding: LeaseBinding): boolean {
  if ((lease.account ?? undefined) !== (binding.account ?? undefined)) return false;
  const lw = lease.wallet;
  const bw = binding.wallet;
  if (lw === undefined || bw === undefined) return lw === bw;
  return lw.acct === bw.acct && lw.wid === bw.wid;
}

function capacityError(scope: 'workspace' | 'tenant' | 'process', limit: number): TeeError {
  return new TeeError(
    'TEE_SESSION_CAPACITY',
    'unlocked workspace capacity reached; close a session or retry later',
    { scope, limit },
  );
}

function expired(reason: string): TeeError {
  return new TeeError('TEE_SESSION_EXPIRED', 'session is not valid', { reason });
}

function accountLocked(slug: string): TeeError {
  return new TeeError('TEE_ACCOUNT_LOCKED', `account "${slug}" requires explicit unlock`, {
    account: slug,
  });
}

/** wative-core brands slugs at the type level; validation already happened. */
function asSlug(slug: string): Slug {
  return slug as Slug;
}
