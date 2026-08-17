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

export interface TokenLease {
  readonly jti: string;
  readonly scopes: readonly string[];
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

    // Release the ledger's process lock too, because skipping it converts a
    // crash with unlocked keys into a service that will not restart.
    //
    // But ONLY when nothing is still holding a decrypted handle. Releasing
    // while a handle survives invites a supervisor to start a successor that
    // opens the same directory while this process is still alive — two
    // Workspace instances over one workspace, which is the exact class the
    // lifetime lock exists to prevent and which silently destroys writes.
    // Retaining it there is C-04's fail-closed trade, and the operator gets a
    // named workspace to act on rather than corruption.
    const stillHeld = [...this.#workspaces.values()]
      .filter((entry) => entry.session ?? entry.provisioningHandle)
      .map((entry) => entry.workspaceSlug);
    if (stillHeld.length > 0) {
      note(new Error(`state lock retained: ${stillHeld.length} workspace(s) still unlocked`));
      return failures;
    }

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
  ): Promise<SessionGrant> {
    const key = workspaceKey(tenant.id, workspaceSlug);
    // Validate the authenticated path components at the registry boundary as
    // well as in the storage service.
    workspacePath(this.paths.dataRoot, tenant.id, workspaceSlug);
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
          return this.addLease(session, scopes);
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
        const grant = this.addLease(session, scopes);
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
    if (!lease || lease.expiresAt <= now || !sameScopes(lease.scopes, scopes)) {
      if (lease?.expiresAt && lease.expiresAt <= now) {
        this.releaseInBackground(sid, jti, 'expired token lease');
      }
      return null;
    }

    if (touchIdle) this.touch(session, idleSec, now);
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
      const exp = tokenExpiry(session, this.#now());
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
    if (liveDeadline !== undefined) {
      if (now >= liveDeadline) {
        this.expireAccount(session, slug, account);
        throw accountLocked(slug);
      }
      // Re-verifying an already-live account does not renew bearer custody.
      session.accounts.set(slug, { state: 'live', expiresAt: liveDeadline });
      this.scheduleAccountTimer(session);
      return;
    }
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
    session.accounts.set(slug, { state: 'live', expiresAt: this.accountExpiry(session, now) });
    this.scheduleAccountTimer(session);
  }

  clearAccountCustody(session: Session, slug: string): void {
    session.accounts.delete(slug);
    session.unlockFailures.delete(slug);
    this.scheduleAccountTimer(session);
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
        this.logger.error(`close bookkeeping ${what} failed for ${session.sid}: ${String(err)}`);
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

  private addLease(session: Session, scopes: readonly string[]): SessionGrant {
    this.assertLeaseCapacity(session);
    let jti: string;
    do jti = randomUUID(); while (session.leases.has(jti));
    const exp = tokenExpiry(session, this.#now());
    const lease: TokenLease = { jti, scopes: [...scopes], expiresAt: exp * 1000 };
    session.leases.set(jti, lease);
    return { session, lease, exp };
  }

  private assertLeaseCapacity(session: Session): void {
    if (session.leases.size >= this.capacity.leasesPerWorkspace) {
      throw capacityError('workspace', this.capacity.leasesPerWorkspace);
    }
  }

  private assertHandleCapacity(tenant: Tenant): void {
    const charged = [...this.#workspaces.values()].filter((entry) => entry.state !== 'deleting');
    const tenantCount = charged.filter((entry) => entry.tenantId === tenant.id).length;
    if (tenantCount >= tenant.limits.maxUnlockedWorkspaces) {
      throw capacityError('tenant', tenant.limits.maxUnlockedWorkspaces);
    }
    if (charged.length >= this.capacity.process) {
      throw capacityError('process', this.capacity.process);
    }
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
    return now >= session.absoluteExpiresAt || now >= session.idleExpiresAt;
  }

  private findAccount(session: Session, slug: string): Account {
    const account = session.handle.accounts.bySlug(asSlug(slug));
    if (!account) throw new TeeError('TEE_ACCOUNT_NOT_FOUND', `account "${slug}" not found`);
    return account;
  }

  private accountExpiry(session: Session, now: number): number {
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
    for (const custody of session.accounts.values()) {
      if (custody.state === 'live') earliest = Math.min(earliest, custody.expiresAt);
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
