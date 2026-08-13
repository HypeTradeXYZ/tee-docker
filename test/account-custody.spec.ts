import { WativeError, type Account, type Workspace } from 'wative-core';
import type { AccountUnlockLimiter } from '../src/auth/account-unlock-limiter';
import type { Paths } from '../src/config/paths';
import type { ServiceStateService } from '../src/config/service-state.service';
import { AsyncMutex } from '../src/session/async-mutex';
import {
  SessionRegistry,
  type AccountCustodyScheduler,
  type Session,
} from '../src/session/session.registry';
import type { WorkspaceStorageService } from '../src/workspaces/workspace-storage.service';

describe('fixed account unlock episodes', () => {
  let now: number;
  let locked: boolean;
  let account: Account;
  let session: Session;
  let registry: SessionRegistry;
  let tryUnlock: jest.Mock;
  let lock: jest.Mock;

  beforeEach(() => {
    now = 1_000;
    locked = true;
    tryUnlock = jest.fn(async (password?: string) => {
      if (password !== undefined && password !== 'correct') {
        throw new WativeError('BAD_PASSWORD', 'wrong password');
      }
      locked = false;
      return account;
    });
    lock = jest.fn(() => {
      locked = true;
    });
    account = {
      slug: 'shared',
      hasOwnPassword: false,
      get locked() { return locked; },
      tryUnlock,
      lock,
    } as unknown as Account;
    const accounts = Object.assign([account], { bySlug: () => account });
    session = {
      sid: 'sid',
      tenantId: 'acme',
      workspaceSlug: 'desk-a',
      handle: { accounts } as unknown as Workspace,
      password: 'workspace-password',
      passwordDigest: Buffer.alloc(32),
      idleExpiresAt: 20_000,
      absoluteExpiresAt: 10_000,
      accountTtlSec: 2,
      leases: new Map(),
      mutex: new AsyncMutex(),
      storageIdentity: { device: 1, inode: 1, realPath: '/workspace' },
      unusable: false,
      accounts: new Map(),
      unlockFailures: new Map(),
      accountTimer: null,
      accountTimerGeneration: 0,
    };
    registry = new SessionRegistry(
      { dataRoot: '/tmp/account-custody-test' } as Paths,
      { close: async () => undefined } as unknown as ServiceStateService,
      { process: 2, leasesPerWorkspace: 2 },
      {} as WorkspaceStorageService,
      undefined,
      () => now,
    );
  });

  afterEach(async () => {
    await registry.onApplicationShutdown();
  });

  it('allows one shared-account lazy unlock without sliding its deadline', async () => {
    await expect(registry.requireAccount(session, 'shared')).resolves.toBe(account);
    expect(session.accounts.get('shared')).toEqual({ state: 'live', expiresAt: 3_000 });
    expect(tryUnlock).toHaveBeenCalledTimes(1);

    now = 2_999;
    await expect(registry.requireAccount(session, 'shared')).resolves.toBe(account);
    expect(session.accounts.get('shared')).toEqual({ state: 'live', expiresAt: 3_000 });

    now = 3_000;
    await expect(registry.requireAccount(session, 'shared')).rejects.toMatchObject({
      code: 'TEE_ACCOUNT_LOCKED',
    });
    expect(session.accounts.get('shared')).toEqual({ state: 'locked', reason: 'expired' });
    expect(lock).toHaveBeenCalledTimes(1);
    await expect(registry.requireAccount(session, 'shared')).rejects.toMatchObject({
      code: 'TEE_ACCOUNT_LOCKED',
    });
    expect(tryUnlock).toHaveBeenCalledTimes(1);
  });

  it('samples completion time and rejects a lazy unlock that crosses session expiry', async () => {
    tryUnlock.mockImplementationOnce(async () => {
      locked = false;
      now = 10_000;
      return account;
    });
    await expect(registry.requireAccount(session, 'shared')).rejects.toMatchObject({
      code: 'TEE_SESSION_EXPIRED',
    });
    expect(session.unusable).toBe(true);
    expect(session.accounts.get('shared')).toEqual({ state: 'locked', reason: 'expired' });
  });

  it('starts lazy exposure when unlock completes, not when it was admitted', async () => {
    tryUnlock.mockImplementationOnce(async () => {
      locked = false;
      now = 2_500;
      return account;
    });
    await registry.requireAccount(session, 'shared');
    expect(session.accounts.get('shared')).toEqual({ state: 'live', expiresAt: 4_500 });
  });

  it('does not let bearer-only use reverse a manual lock', async () => {
    await registry.requireAccount(session, 'shared');
    registry.lockAccount(session, 'shared');
    expect(session.accounts.get('shared')).toEqual({ state: 'locked', reason: 'manual' });
    await expect(registry.requireAccount(session, 'shared')).rejects.toMatchObject({
      code: 'TEE_ACCOUNT_LOCKED',
    });
    expect(lock).toHaveBeenCalledTimes(1);
    expect(tryUnlock).toHaveBeenCalledTimes(1);
  });

  it('starts a new fixed episode only after successful explicit authentication', async () => {
    await registry.requireAccount(session, 'shared');
    registry.lockAccount(session, 'shared');
    const limiter = {
      verify: async <T>(_session: unknown, _slug: string, attempt: () => T | Promise<T>) => attempt(),
    } as unknown as AccountUnlockLimiter;

    now = 2_000;
    await registry.unlockAccount(session, 'shared', 'correct', limiter, 30);
    expect(session.accounts.get('shared')).toEqual({ state: 'live', expiresAt: 4_000 });

    now = 2_500;
    await registry.unlockAccount(session, 'shared', 'correct', limiter, 30);
    expect(session.accounts.get('shared')).toEqual({ state: 'live', expiresAt: 4_000 });

    await expect(
      registry.unlockAccount(session, 'shared', 'wrong', limiter, 30),
    ).rejects.toMatchObject({ code: 'BAD_PASSWORD' });
    expect(session.accounts.get('shared')).toEqual({ state: 'live', expiresAt: 4_000 });
  });

  it('starts a new episode with one correct re-auth after the prior deadline', async () => {
    await registry.requireAccount(session, 'shared');
    expect(session.accounts.get('shared')).toEqual({ state: 'live', expiresAt: 3_000 });
    now = 3_000;
    const limiter = {
      verify: async <T>(_session: unknown, _slug: string, attempt: () => T | Promise<T>) => attempt(),
    } as unknown as AccountUnlockLimiter;

    await registry.unlockAccount(session, 'shared', 'correct', limiter, 30);
    expect(session.accounts.get('shared')).toEqual({ state: 'live', expiresAt: 5_000 });
    expect(tryUnlock).toHaveBeenCalledTimes(2);

    now = 5_000;
    await expect(
      registry.unlockAccount(session, 'shared', 'wrong', limiter, 30),
    ).rejects.toMatchObject({ code: 'BAD_PASSWORD' });
    expect(session.accounts.get('shared')).toEqual({ state: 'locked', reason: 'expired' });
  });

  it('requires explicit authentication for a never-exposed own-password account', async () => {
    Object.defineProperty(account, 'hasOwnPassword', { value: true });
    await expect(registry.requireAccount(session, 'shared')).rejects.toMatchObject({
      code: 'TEE_ACCOUNT_LOCKED',
    });
    expect(tryUnlock).not.toHaveBeenCalled();

    const limiter = {
      verify: async <T>(_session: unknown, _slug: string, attempt: () => T | Promise<T>) => attempt(),
    } as unknown as AccountUnlockLimiter;
    await registry.unlockAccount(session, 'shared', 'correct', limiter, 30);
    expect(session.accounts.get('shared')).toEqual({ state: 'live', expiresAt: 3_000 });
  });

  it('clamps creation exposure to the workspace ceiling and clears custody on drop', () => {
    now = 9_000;
    registry.recordAccountExposure(session, 'shared');
    expect(session.accounts.get('shared')).toEqual({ state: 'live', expiresAt: 10_000 });
    session.unlockFailures.set('shared', {
      failures: 1,
      lastFailureAt: now,
      nextAllowedAt: now + 1,
      expiresAt: now + 10,
    });
    registry.clearAccountCustody(session, 'shared');
    expect(session.accounts.has('shared')).toBe(false);
    expect(session.unlockFailures.has('shared')).toBe(false);
  });

  it('retires the session if manual zeroization fails', async () => {
    await registry.requireAccount(session, 'shared');
    lock.mockImplementationOnce(() => { throw new Error('lock failure'); });
    expect(() => registry.lockAccount(session, 'shared')).toThrow('lock failure');
    expect(session.unusable).toBe(true);
    expect(session.accounts.get('shared')).toEqual({ state: 'locked', reason: 'manual' });
  });

  it('cleans up a synchronous unlock-then-throw and retires if cleanup fails', async () => {
    const limiter = {
      verify: async <T>(_session: unknown, _slug: string, attempt: () => T | Promise<T>) => attempt(),
    } as unknown as AccountUnlockLimiter;
    tryUnlock.mockImplementationOnce(() => {
      locked = false;
      throw new Error('sync ambiguous unlock');
    });
    await expect(
      registry.unlockAccount(session, 'shared', 'correct', limiter, 30),
    ).rejects.toThrow('sync ambiguous unlock');
    expect(lock).toHaveBeenCalledTimes(1);
    expect(locked).toBe(true);
    expect(session.accounts.has('shared')).toBe(false);

    tryUnlock.mockImplementationOnce(() => {
      locked = false;
      throw new Error('second ambiguous unlock');
    });
    lock.mockImplementationOnce(() => { throw new Error('cleanup failure'); });
    await expect(
      registry.unlockAccount(session, 'shared', 'correct', limiter, 30),
    ).rejects.toThrow('second ambiguous unlock');
    expect(session.unusable).toBe(true);
  });
});

describe('account expiry scheduling', () => {
  it('locks at the nearest deadline without a request and reschedules an early firing', async () => {
    let now = 1_000;
    let locked = false;
    const lock = jest.fn(() => { locked = true; });
    const account = {
      slug: 'vault',
      hasOwnPassword: false,
      wallets: [],
      get locked() { return locked; },
      lock,
    } as unknown as Account;
    const accounts = Object.assign([account], { bySlug: () => account });
    const handle = {
      accounts,
      lock: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    } as unknown as Workspace;
    const callbacks: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];
    const timers = new Map<NodeJS.Timeout, number>();
    const scheduler: AccountCustodyScheduler = {
      set: (callback, delay) => {
        const timer = { unref: jest.fn() } as unknown as NodeJS.Timeout;
        callbacks.push({ callback, delay, cleared: false });
        timers.set(timer, callbacks.length - 1);
        return timer;
      },
      clear: (timer) => {
        const index = timers.get(timer);
        if (index !== undefined) callbacks[index]!.cleared = true;
      },
    };
    const tenant = {
      id: 'acme',
      apiKey: 'ak_test_0123456789abcdef',
      secretHash: '0'.repeat(64),
      limits: { maxWorkspaces: 1, maxWallets: 10, maxUnlockedWorkspaces: 1 },
      ttl: { workspaceIdleSec: 100, workspaceAbsoluteSec: 100, accountAbsoluteSec: 1 },
      rpc: {},
      allowDefaultRpc: true,
      exportEnabled: false,
    } as const;
    const draft = {
      tenants: {
        acme: {
          walletTotal: 1,
          workspaces: [{ slug: 'desk-a', createdAt: new Date(0).toISOString(), walletCount: 1 }],
        },
      },
    };
    const state = {
      close: async () => undefined,
      tenant: () => draft.tenants.acme,
      mutate: async <T>(fn: (value: typeof draft) => T): Promise<T> => fn(draft),
    } as unknown as ServiceStateService;
    const storage = {
      assertExisting: async () => ({ device: 1, inode: 1, realPath: '/workspace' }),
      openExisting: async (
        _tenantId: string,
        _slug: string,
        _password: string,
        onOpened: (workspace: Workspace, identity: {
          device: number; inode: number; realPath: string;
        }) => void,
      ) => {
        onOpened(handle, { device: 1, inode: 1, realPath: '/workspace' });
        return handle;
      },
    } as unknown as WorkspaceStorageService;
    const registry = new SessionRegistry(
      { dataRoot: '/tmp/account-expiry-scheduler-test' } as Paths,
      state,
      { process: 1, leasesPerWorkspace: 2 },
      storage,
      undefined,
      () => now,
      scheduler,
    );
    const { session } = await registry.create(tenant, 'desk-a', 'password', ['read']);
    registry.recordAccountExposure(session, 'vault');
    expect(callbacks.at(-1)?.delay).toBe(1_000);

    const stale = callbacks.at(-1)!;
    now = 1_100;
    registry.recordAccountExposure(session, 'vault');
    const replacementTimer = session.accountTimer;
    expect(stale.cleared).toBe(true);
    stale.callback();
    await Promise.resolve();
    expect(session.accountTimer).toBe(replacementTimer);

    now = 1_999;
    callbacks.at(-1)!.callback();
    await session.mutex.runExclusive(() => undefined);
    expect(lock).not.toHaveBeenCalled();
    expect(callbacks.at(-1)?.delay).toBe(101);

    now = 2_100;
    callbacks.at(-1)!.callback();
    await session.mutex.runExclusive(() => undefined);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(session.accounts.get('vault')).toEqual({ state: 'locked', reason: 'expired' });

    locked = false;
    now = 3_000;
    registry.recordAccountExposure(session, 'vault');
    let entered!: () => void;
    let release!: () => void;
    const operationEntered = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const operation = registry.withSession(session, async () => {
      entered();
      await barrier;
      return 'done';
    });
    await operationEntered;
    now = 4_000;
    release();
    await expect(operation).resolves.toBe('done');
    expect(lock).toHaveBeenCalledTimes(2);
    expect(session.accounts.get('vault')).toEqual({ state: 'locked', reason: 'expired' });

    await registry.onApplicationShutdown();
  });

  it.each([undefined, null, false, 0, ''])('preserves a falsy thrown operation value: %p', async (thrown) => {
    let now = 1_000;
    let locked = false;
    const account = {
      slug: 'vault',
      hasOwnPassword: false,
      wallets: [],
      get locked() { return locked; },
      lock: jest.fn(() => { locked = true; }),
    } as unknown as Account;
    const accounts = Object.assign([account], { bySlug: () => account });
    const handle = {
      accounts,
      lock: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    } as unknown as Workspace;
    const tenant = {
      id: 'acme', apiKey: 'ak_test_0123456789abcdef', secretHash: '0'.repeat(64),
      limits: { maxWorkspaces: 1, maxWallets: 1, maxUnlockedWorkspaces: 1 },
      ttl: { workspaceIdleSec: 100, workspaceAbsoluteSec: 100, accountAbsoluteSec: 1 },
      rpc: {}, allowDefaultRpc: true, exportEnabled: false,
    } as const;
    const draft = { tenants: { acme: { walletTotal: 0, workspaces: [
      { slug: 'desk-a', createdAt: new Date(0).toISOString(), walletCount: 0 },
    ] } } };
    const registry = new SessionRegistry(
      { dataRoot: '/tmp/account-expiry-falsy-throw-test' } as Paths,
      {
        close: async () => undefined,
        tenant: () => draft.tenants.acme,
        mutate: async <T>(fn: (value: typeof draft) => T): Promise<T> => fn(draft),
      } as unknown as ServiceStateService,
      { process: 1, leasesPerWorkspace: 1 },
      {
        assertExisting: async () => ({ device: 1, inode: 1, realPath: '/workspace' }),
        openExisting: async (
          _tenantId: string, _slug: string, _password: string,
          onOpened: (workspace: Workspace, identity: {
            device: number; inode: number; realPath: string;
          }) => void,
        ) => {
          onOpened(handle, { device: 1, inode: 1, realPath: '/workspace' });
          return handle;
        },
      } as unknown as WorkspaceStorageService,
      undefined,
      () => now,
    );
    const { session } = await registry.create(tenant, 'desk-a', 'password', ['read']);
    let caught = Symbol('not caught');
    try {
      await registry.withSession(session, () => { throw thrown; });
    } catch (error) {
      caught = error as typeof caught;
    }
    expect(caught).toBe(thrown);

    const lockError = new Error('zeroization failed');
    (account.lock as jest.Mock).mockImplementationOnce(() => { throw lockError; });
    session.accounts.set('vault', { state: 'live', expiresAt: now });
    let combined: unknown;
    try {
      await registry.withSession(session, () => { throw thrown; });
    } catch (error) {
      combined = error;
    }
    expect(combined).toBeInstanceOf(AggregateError);
    const operationAndExpiry = combined as AggregateError;
    expect(operationAndExpiry.errors[0]).toBe(thrown);
    expect(operationAndExpiry.errors[1]).toBeInstanceOf(AggregateError);
    expect((operationAndExpiry.errors[1] as AggregateError).errors).toEqual([lockError]);
    expect(session.unusable).toBe(true);

    now += 1;
    await registry.onApplicationShutdown();
  });
});
