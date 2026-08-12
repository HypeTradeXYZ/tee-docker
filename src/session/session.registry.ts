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

export interface TokenLease {
  readonly jti: string;
  readonly scopes: readonly string[];
  expiresAt: number;
}

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
  /** account slug -> absolute expiry. Never slides. */
  readonly accounts: Map<string, number>;
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
}

const SWEEP_INTERVAL_MS = 30_000;

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
  #sweeper: NodeJS.Timeout | null = null;
  #sweepInFlight: Promise<void> | null = null;
  #shuttingDown = false;

  constructor(
    @Inject(PATHS) private readonly paths: Paths,
    private readonly state: ServiceStateService,
    @Inject(SESSION_CAPACITY) private readonly capacity: SessionCapacity,
    private readonly storage: WorkspaceStorageService,
    @Optional() private readonly rpcBoundary?: RpcBoundaryService,
  ) {
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
    // A sweep may already own or be queued for a session mutex. Let it finish
    // before locking handles so no cleanup touches core after custody drains.
    if (this.#sweepInFlight) {
      try {
        await this.#sweepInFlight;
      } catch (err) {
        failures.push(err);
      }
    }
    // Acquiring every lifecycle key also waits for opens already in flight.
    const results = await Promise.allSettled(
      [...this.#workspaces.keys()].map((key) =>
        this.#lifecycle.runExclusive(key, async () => {
          const entry = this.#workspaces.get(key);
          if (entry?.session) await this.closeEntry(entry);
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
    return this.#lifecycle.runExclusive(key, async () => {
      if (this.#shuttingDown) throw expired('application is shutting down');

      let entry = this.#workspaces.get(key);
      if (entry?.state === 'deleting') {
        throw new TeeError('TEE_WORKSPACE_NOT_FOUND', `workspace "${workspaceSlug}" not found`);
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
          const now = Date.now();
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
    });
  }

  /**
   * Run tenant-tier provisioning under the same key gate as mint and delete.
   * The callback must not call another lifecycle-acquiring registry method.
   */
  async provisionWorkspace<T>(
    tenantId: string,
    workspaceSlug: string,
    provision: () => Promise<T>,
  ): Promise<T> {
    const key = workspaceKey(tenantId, workspaceSlug);
    return this.#lifecycle.runExclusive(key, async () => {
      if (this.#shuttingDown) throw expired('application is shutting down');
      if (this.#workspaces.has(key)) {
        throw new TeeError('TEE_WORKSPACE_IN_USE', `workspace "${workspaceSlug}" is in use`);
      }
      return provision();
    });
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

    const now = Date.now();
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

    this.touch(session, idleSec, now);
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
      if (!lease || lease.expiresAt <= Date.now()) throw expired('no lease');

      this.touch(session, idleSec);
      const exp = tokenExpiry(session);
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
        if (this.#sessions.get(session.sid) !== session || session.unusable) {
          throw expired('session is closing');
        }
        return fn();
      });
    } finally {
      if (session.unusable) this.destroyInBackground(session.sid, 'unusable session');
    }
  }

  markUnusable(session: Session): void {
    session.unusable = true;
  }

  async requireAccount(session: Session, slug: string): Promise<Account> {
    const account = this.findAccount(session, slug);
    if (!account.locked && this.accountLive(session, slug)) return account;
    if (account.hasOwnPassword) {
      throw new TeeError('TEE_ACCOUNT_LOCKED', `account "${slug}" needs its own password`, {
        account: slug,
      });
    }
    await account.tryUnlock();
    session.accounts.set(slug, this.accountExpiry(session));
    return account;
  }

  async unlockAccount(session: Session, slug: string, password: string): Promise<void> {
    const account = this.findAccount(session, slug);
    await account.tryUnlock(password);
    session.accounts.set(slug, this.accountExpiry(session));
  }

  lockAccount(session: Session, slug: string): void {
    const account = this.findAccount(session, slug);
    account.lock();
    session.accounts.delete(slug);
  }

  /** Authoritatively recount one singleton handle and persist its tenant total. */
  async syncWalletCount(session: Session): Promise<void> {
    let walletCount = 0;
    for (const account of session.handle.accounts) walletCount += account.wallets.length;

    await this.state.mutate((draft) => {
      const tenant = draft.tenants[session.tenantId];
      if (!tenant) throw new Error(`missing ledger tenant ${session.tenantId}`);
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
    this.#sessions.delete(session.sid);
    session.leases.clear();
    this.rpcBoundary?.revokeWorkspace(session.tenantId, session.workspaceSlug);
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

  private addLease(session: Session, scopes: readonly string[]): SessionGrant {
    this.assertLeaseCapacity(session);
    let jti: string;
    do jti = randomUUID(); while (session.leases.has(jti));
    const exp = tokenExpiry(session);
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

  private entryInUse(entry: WorkspaceEntry, now = Date.now()): boolean {
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

  private touch(session: Session, idleSec: number, now = Date.now()): void {
    session.idleExpiresAt = Math.min(now + idleSec * 1000, session.absoluteExpiresAt);
  }

  private sessionExpired(session: Session, now = Date.now()): boolean {
    return now >= session.absoluteExpiresAt || now >= session.idleExpiresAt;
  }

  private findAccount(session: Session, slug: string): Account {
    const account = session.handle.accounts.bySlug(asSlug(slug));
    if (!account) throw new TeeError('TEE_ACCOUNT_NOT_FOUND', `account "${slug}" not found`);
    return account;
  }

  private accountLive(session: Session, slug: string): boolean {
    const expiry = session.accounts.get(slug);
    return expiry !== undefined && Date.now() < expiry;
  }

  private accountExpiry(session: Session): number {
    return Math.min(Date.now() + session.accountTtlSec * 1000, session.absoluteExpiresAt);
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
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
          for (const [slug, expiry] of session.accounts) {
            if (now < expiry) continue;
            try {
              session.handle.accounts.bySlug(asSlug(slug))?.lock();
            } catch {
              /* the account may already be gone; the map entry is what matters */
            }
            session.accounts.delete(slug);
          }
        });
      } catch (err) {
        // A failed singleton lock keeps its capacity-charged tombstone, but it
        // must not prevent unrelated expired sessions from being reaped.
        failures.push(err);
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

function tokenExpiry(session: Session): number {
  const exp = Math.floor(Math.min(session.idleExpiresAt, session.absoluteExpiresAt) / 1000);
  if (exp <= Math.floor(Date.now() / 1000)) throw expired('no token lifetime remains');
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

/** wative-core brands slugs at the type level; validation already happened. */
function asSlug(slug: string): Slug {
  return slug as Slug;
}
