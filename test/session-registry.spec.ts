import { Workspace } from 'wative-core';
import type { Paths } from '../src/config/paths';
import type { Tenant } from '../src/config/schemas';
import type { ServiceStateService } from '../src/config/service-state.service';
import { SessionRegistry } from '../src/session/session.registry';
import type { WalletTagsService } from '../src/session/wallet-tags.service';
import { WorkspaceStorageService } from '../src/workspaces/workspace-storage.service';

const testStorage = {
  assertExisting: async () => ({ device: 1, inode: 1, realPath: '/test/workspace' }),
  openExisting: async (
    _tenantId: string,
    slug: string,
    password: string,
    onOpened: (
      handle: Workspace,
      identity: { device: number; inode: number; realPath: string },
    ) => void,
  ) => {
    const handle = await Workspace.open({ path: slug, password });
    onOpened(handle, { device: 1, inode: 1, realPath: '/test/workspace' });
    return handle;
  },
  remove: async () => undefined,
} as unknown as WorkspaceStorageService;

function tenantFixture(maxUnlockedWorkspaces = 2): Tenant {
  return {
    id: 'acme',
    apiKey: 'ak_test_0123456789abcdef',
    secretHash: '0'.repeat(64),
    limits: { maxWorkspaces: 3, maxWallets: 10, maxUnlockedWorkspaces },
    ttl: { workspaceIdleSec: 900, workspaceAbsoluteSec: 3600, accountAbsoluteSec: 300 },
    rpc: {},
    allowDefaultRpc: true,
    exportEnabled: false,
  };
}

describe('SessionRegistry close failure', () => {
  it('replays pending wallet tags before publishing a cold session', async () => {
    const events: string[] = [];
    const handle = {
      accounts: [],
      lock: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    } as unknown as Workspace;
    const storage = {
      assertExisting: jest.fn(async () => ({ device: 1, inode: 1, realPath: '/test/workspace' })),
      openExisting: jest.fn(async (
        _tenantId: string,
        _slug: string,
        _password: string,
        onOpened: (workspace: Workspace, identity: {
          device: number; inode: number; realPath: string;
        }) => void,
      ) => {
        onOpened(handle, { device: 1, inode: 1, realPath: '/test/workspace' });
        return handle;
      }),
    } as unknown as WorkspaceStorageService;
    const draft = {
      tenants: {
        acme: {
          walletTotal: 0,
          workspaces: [
            { slug: 'desk-a', createdAt: new Date(0).toISOString(), walletCount: 0 },
          ],
        },
      },
    };
    const state = {
      close: async () => undefined,
      tenant: () => draft.tenants.acme,
      mutate: async <T>(fn: (value: typeof draft) => T): Promise<T> => {
        events.push('ledger');
        return fn(draft);
      },
    } as unknown as ServiceStateService;
    const walletTags = {
      recoverWorkspace: jest.fn(async () => { events.push('recover'); }),
    } as unknown as WalletTagsService;
    const registry = new SessionRegistry(
      { dataRoot: '/tmp/session-registry-tag-recovery-test' } as Paths,
      state,
      { process: 2, leasesPerWorkspace: 2 },
      storage,
      undefined,
      undefined,
      undefined,
      walletTags,
    );

    await registry.create(tenantFixture(), 'desk-a', 'password', ['read']);
    expect(events).toEqual(['recover', 'ledger']);
    expect(walletTags.recoverWorkspace).toHaveBeenCalledTimes(1);
    await registry.onApplicationShutdown();
  });

  it('retains a failed provisional handle and closes it before a successor provision', async () => {
    const lock = jest.fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error('first provisional lock failed'))
      .mockRejectedValueOnce(new Error('cleanup retry failed'))
      .mockResolvedValue(undefined);
    const handle = { accounts: [], lock } as unknown as Workspace;
    const state = {
      close: async () => undefined,
      tenant: () => ({ walletTotal: 0, workspaces: [] }),
    } as unknown as ServiceStateService;
    const registry = new SessionRegistry(
      { dataRoot: '/tmp/session-registry-provision-lock-test' } as Paths,
      state,
      { process: 2, leasesPerWorkspace: 2 },
      testStorage,
    );
    const tenant = tenantFixture();

    await expect(
      registry.provisionWorkspace(tenant, 'desk-a', async (retain) => {
        retain(handle);
        return 'created';
      }),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(registry.workspaceCount).toBe(1);

    await expect(
      registry.provisionWorkspace(tenant, 'desk-a', async () => 'successor'),
    ).resolves.toBe('successor');
    expect(lock).toHaveBeenCalledTimes(3);
    expect(registry.workspaceCount).toBe(0);
    await registry.onApplicationShutdown();
  });

  it('drains a directly in-flight provision before releasing state ownership', async () => {
    let entered!: () => void;
    let release!: () => void;
    const provisionEntered = new Promise<void>((resolve) => { entered = resolve; });
    const provisionBarrier = new Promise<void>((resolve) => { release = resolve; });
    const stateClose = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const state = {
      close: stateClose,
      tenant: () => ({ walletTotal: 0, workspaces: [] }),
      mutate: async <T>(fn: (value: { tenants: Record<string, never> }) => T): Promise<T> =>
        fn({ tenants: {} }),
    } as unknown as ServiceStateService;
    const registry = new SessionRegistry(
      { dataRoot: '/tmp/session-registry-provision-shutdown-test' } as Paths,
      state,
      { process: 2, leasesPerWorkspace: 2 },
      testStorage,
    );

    const provision = registry.provisionWorkspace(tenantFixture(), 'desk-a', async () => {
      entered();
      await provisionBarrier;
      return 'created';
    });
    await provisionEntered;
    const shutdown = registry.onApplicationShutdown();
    await Promise.resolve();
    expect(stateClose).not.toHaveBeenCalled();

    release();
    await expect(provision).resolves.toBe('created');
    await expect(shutdown).resolves.toBeUndefined();
    expect(stateClose).toHaveBeenCalledTimes(1);
  });

  it('keeps a tombstone and retries the old lock before opening a successor', async () => {
    const firstLock = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error('lock probe'))
      .mockResolvedValue(undefined);
    const secondLock = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const first = { accounts: [], lock: firstLock } as unknown as Workspace;
    const second = { accounts: [], lock: secondLock } as unknown as Workspace;
    const open = jest
      .spyOn(Workspace, 'open')
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    const draft = {
      tenants: {
        acme: {
          walletTotal: 0,
          workspaces: [
            { slug: 'desk-a', createdAt: new Date(0).toISOString(), walletCount: 0 },
          ],
        },
      },
    };
    const stateClose = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const state = {
      close: stateClose,
      tenant: () => draft.tenants.acme,
      mutate: async <T>(fn: (value: typeof draft) => T): Promise<T> => fn(draft),
    } as unknown as ServiceStateService;
    const tenant: Tenant = {
      id: 'acme',
      apiKey: 'ak_test_0123456789abcdef',
      secretHash: '0'.repeat(64),
      limits: { maxWorkspaces: 2, maxWallets: 10, maxUnlockedWorkspaces: 2 },
      ttl: { workspaceIdleSec: 900, workspaceAbsoluteSec: 3600, accountAbsoluteSec: 300 },
      rpc: {},
      allowDefaultRpc: true,
      exportEnabled: false,
    };
    const registry = new SessionRegistry(
      { dataRoot: '/tmp/session-registry-test' } as Paths,
      state,
      { process: 2, leasesPerWorkspace: 2 },
      testStorage,
    );

    const initial = await registry.create(tenant, 'desk-a', 'password', ['read']);
    await expect(registry.release(initial.session.sid, initial.lease.jti)).rejects.toThrow(
      'lock probe',
    );
    expect(registry.size).toBe(0);
    expect(registry.workspaceCount).toBe(1);
    expect(open).toHaveBeenCalledTimes(1);

    const replacement = await registry.create(tenant, 'desk-a', 'password', ['read']);
    expect(replacement.session.sid).not.toBe(initial.session.sid);
    expect(firstLock).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledTimes(2);
    expect(registry.workspaceCount).toBe(1);

    await registry.onApplicationShutdown();
    expect(secondLock).toHaveBeenCalledTimes(1);
    expect(stateClose).toHaveBeenCalledTimes(1);
    open.mockRestore();
  });

  it('retains an unpublished handle when reconciliation and cleanup lock both fail', async () => {
    const firstLock = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error('cleanup lock probe'))
      .mockResolvedValue(undefined);
    const secondLock = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const first = { accounts: [], lock: firstLock } as unknown as Workspace;
    const second = { accounts: [], lock: secondLock } as unknown as Workspace;
    const open = jest
      .spyOn(Workspace, 'open')
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    const draft = {
      tenants: {
        acme: {
          walletTotal: 0,
          workspaces: [
            { slug: 'desk-a', createdAt: new Date(0).toISOString(), walletCount: 0 },
          ],
        },
      },
    };
    let failReconcile = true;
    const stateClose = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const state = {
      close: stateClose,
      tenant: () => draft.tenants.acme,
      mutate: async <T>(fn: (value: typeof draft) => T): Promise<T> => {
        if (failReconcile) {
          failReconcile = false;
          throw new Error('reconcile probe');
        }
        return fn(draft);
      },
    } as unknown as ServiceStateService;
    const tenant: Tenant = {
      id: 'acme',
      apiKey: 'ak_test_0123456789abcdef',
      secretHash: '0'.repeat(64),
      limits: { maxWorkspaces: 2, maxWallets: 10, maxUnlockedWorkspaces: 2 },
      ttl: { workspaceIdleSec: 900, workspaceAbsoluteSec: 3600, accountAbsoluteSec: 300 },
      rpc: {},
      allowDefaultRpc: true,
      exportEnabled: false,
    };
    const registry = new SessionRegistry(
      { dataRoot: '/tmp/session-registry-open-failure-test' } as Paths,
      state,
      { process: 2, leasesPerWorkspace: 2 },
      testStorage,
    );

    await expect(registry.create(tenant, 'desk-a', 'password', ['read'])).rejects.toThrow(
      'failed to initialize and close singleton workspace',
    );
    expect(registry.size).toBe(0);
    expect(registry.workspaceCount).toBe(1);
    expect(open).toHaveBeenCalledTimes(1);

    await registry.create(tenant, 'desk-a', 'password', ['read']);
    expect(firstLock).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledTimes(2);
    expect(stateClose).not.toHaveBeenCalled();
    expect(registry.size).toBe(1);
    expect(registry.workspaceCount).toBe(1);

    await registry.onApplicationShutdown();
    expect(secondLock).toHaveBeenCalledTimes(1);
    expect(stateClose).toHaveBeenCalledTimes(1);
    open.mockRestore();
  });

  it('attempts every shutdown lock and reports any workspace that cannot drain', async () => {
    const failedLock = jest.fn<Promise<void>, []>().mockRejectedValue(new Error('drain probe'));
    const successfulLock = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const first = { accounts: [], lock: failedLock } as unknown as Workspace;
    const second = { accounts: [], lock: successfulLock } as unknown as Workspace;
    const open = jest
      .spyOn(Workspace, 'open')
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    const draft = {
      tenants: {
        acme: {
          walletTotal: 0,
          workspaces: ['desk-a', 'desk-b'].map((slug) => ({
            slug,
            createdAt: new Date(0).toISOString(),
            walletCount: 0,
          })),
        },
      },
    };
    const stateClose = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const state = {
      close: stateClose,
      tenant: () => draft.tenants.acme,
      mutate: async <T>(fn: (value: typeof draft) => T): Promise<T> => fn(draft),
    } as unknown as ServiceStateService;
    const tenant: Tenant = {
      id: 'acme',
      apiKey: 'ak_test_0123456789abcdef',
      secretHash: '0'.repeat(64),
      limits: { maxWorkspaces: 2, maxWallets: 10, maxUnlockedWorkspaces: 2 },
      ttl: { workspaceIdleSec: 900, workspaceAbsoluteSec: 3600, accountAbsoluteSec: 300 },
      rpc: {},
      allowDefaultRpc: true,
      exportEnabled: false,
    };
    const registry = new SessionRegistry(
      { dataRoot: '/tmp/session-registry-shutdown-failure-test' } as Paths,
      state,
      { process: 2, leasesPerWorkspace: 2 },
      testStorage,
    );

    await registry.create(tenant, 'desk-a', 'password', ['read']);
    await registry.create(tenant, 'desk-b', 'password', ['read']);

    await expect(registry.onApplicationShutdown()).rejects.toThrow(
      'failed to lock 1 workspace session(s)',
    );
    expect(failedLock).toHaveBeenCalledTimes(1);
    expect(successfulLock).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
    expect(registry.workspaceCount).toBe(1);
    expect(stateClose).not.toHaveBeenCalled();
    await expect(registry.create(tenant, 'desk-b', 'password', ['read'])).rejects.toMatchObject({
      code: 'TEE_SESSION_EXPIRED',
    });
    expect(open).toHaveBeenCalledTimes(2);
    open.mockRestore();
  });

  it('continues sweeping independent expired sessions after one lock fails', async () => {
    const failedLock = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error('sweep drain probe'))
      .mockResolvedValue(undefined);
    const successfulLock = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const open = jest
      .spyOn(Workspace, 'open')
      .mockResolvedValueOnce({ accounts: [], lock: failedLock } as unknown as Workspace)
      .mockResolvedValueOnce({ accounts: [], lock: successfulLock } as unknown as Workspace);

    const draft = {
      tenants: {
        acme: {
          walletTotal: 0,
          workspaces: ['desk-a', 'desk-b'].map((slug) => ({
            slug,
            createdAt: new Date(0).toISOString(),
            walletCount: 0,
          })),
        },
      },
    };
    const state = {
      close: async () => undefined,
      tenant: () => draft.tenants.acme,
      mutate: async <T>(fn: (value: typeof draft) => T): Promise<T> => fn(draft),
    } as unknown as ServiceStateService;
    const tenant: Tenant = {
      id: 'acme',
      apiKey: 'ak_test_0123456789abcdef',
      secretHash: '0'.repeat(64),
      limits: { maxWorkspaces: 2, maxWallets: 10, maxUnlockedWorkspaces: 2 },
      ttl: { workspaceIdleSec: 900, workspaceAbsoluteSec: 3600, accountAbsoluteSec: 300 },
      rpc: {},
      allowDefaultRpc: true,
      exportEnabled: false,
    };
    const registry = new SessionRegistry(
      { dataRoot: '/tmp/session-registry-sweep-failure-test' } as Paths,
      state,
      { process: 2, leasesPerWorkspace: 2 },
      testStorage,
    );
    const first = await registry.create(tenant, 'desk-a', 'password', ['read']);
    const second = await registry.create(tenant, 'desk-b', 'password', ['read']);
    first.session.idleExpiresAt = 0;
    second.session.idleExpiresAt = 0;

    await expect(
      (registry as unknown as { sweep(): Promise<void> }).sweep(),
    ).rejects.toThrow('failed to sweep 1 workspace session(s)');
    expect(failedLock).toHaveBeenCalledTimes(1);
    expect(successfulLock).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
    expect(registry.workspaceCount).toBe(1);

    await registry.onApplicationShutdown();
    expect(failedLock).toHaveBeenCalledTimes(2);
    expect(registry.workspaceCount).toBe(0);
    open.mockRestore();
  });

  it('waits for an in-flight sweep before locking workspace handles on shutdown', async () => {
    let entered!: () => void;
    let release!: () => void;
    const lockEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const lockBarrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstLock = jest.fn(async () => {
      entered();
      await lockBarrier;
    });
    const secondLock = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const accountLock = jest.fn();
    const secondAccounts = Object.assign([], {
      bySlug: () => ({ lock: accountLock }),
    });
    const open = jest
      .spyOn(Workspace, 'open')
      .mockResolvedValueOnce({ accounts: [], lock: firstLock } as unknown as Workspace)
      .mockResolvedValueOnce({ accounts: secondAccounts, lock: secondLock } as unknown as Workspace);

    const draft = {
      tenants: {
        acme: {
          walletTotal: 0,
          workspaces: ['desk-a', 'desk-b'].map((slug) => ({
            slug,
            createdAt: new Date(0).toISOString(),
            walletCount: 0,
          })),
        },
      },
    };
    const state = {
      close: async () => undefined,
      tenant: () => draft.tenants.acme,
      mutate: async <T>(fn: (value: typeof draft) => T): Promise<T> => fn(draft),
    } as unknown as ServiceStateService;
    const tenant: Tenant = {
      id: 'acme',
      apiKey: 'ak_test_0123456789abcdef',
      secretHash: '0'.repeat(64),
      limits: { maxWorkspaces: 2, maxWallets: 10, maxUnlockedWorkspaces: 2 },
      ttl: { workspaceIdleSec: 900, workspaceAbsoluteSec: 3600, accountAbsoluteSec: 300 },
      rpc: {},
      allowDefaultRpc: true,
      exportEnabled: false,
    };
    const registry = new SessionRegistry(
      { dataRoot: '/tmp/session-registry-sweep-shutdown-test' } as Paths,
      state,
      { process: 2, leasesPerWorkspace: 2 },
      testStorage,
    );
    const first = await registry.create(tenant, 'desk-a', 'password', ['read']);
    const second = await registry.create(tenant, 'desk-b', 'password', ['read']);
    first.session.idleExpiresAt = 0;
    second.session.accounts.set('vault', { state: 'live', expiresAt: 0 });

    const sweeping = (registry as unknown as { runSweep(): Promise<void> }).runSweep();
    await lockEntered;
    let shutdownFinished = false;
    const shutdown = registry.onApplicationShutdown().then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);
    expect(secondLock).not.toHaveBeenCalled();
    expect(accountLock).not.toHaveBeenCalled();
    release();

    await sweeping;
    await shutdown;
    expect(accountLock).toHaveBeenCalledTimes(1);
    expect(secondLock).toHaveBeenCalledTimes(1);
    expect(accountLock.mock.invocationCallOrder[0]).toBeLessThan(
      secondLock.mock.invocationCallOrder[0]!,
    );
    expect(registry.workspaceCount).toBe(0);
    open.mockRestore();
  });

  it('refuses refresh at idle or absolute expiry without extending the lease', async () => {
    const tenant: Tenant = {
      id: 'acme',
      apiKey: 'ak_test_0123456789abcdef',
      secretHash: '0'.repeat(64),
      limits: { maxWorkspaces: 2, maxWallets: 10, maxUnlockedWorkspaces: 2 },
      ttl: { workspaceIdleSec: 900, workspaceAbsoluteSec: 3600, accountAbsoluteSec: 300 },
      rpc: {},
      allowDefaultRpc: true,
      exportEnabled: false,
    };
    const handle = {
      accounts: [],
      lock: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    } as unknown as Workspace;
    const open = jest.spyOn(Workspace, 'open').mockResolvedValue(handle);
    const draft = {
      tenants: {
        acme: {
          walletTotal: 0,
          workspaces: [
            { slug: 'desk-a', createdAt: new Date(0).toISOString(), walletCount: 0 },
          ],
        },
      },
    };
    const state = {
      close: async () => undefined,
      tenant: () => draft.tenants.acme,
      mutate: async <T>(fn: (value: typeof draft) => T): Promise<T> => fn(draft),
    } as unknown as ServiceStateService;
    const registry = new SessionRegistry(
      { dataRoot: '/tmp/session-registry-refresh-expiry-test' } as Paths,
      state,
      { process: 2, leasesPerWorkspace: 2 },
      testStorage,
    );
    const idle = await registry.create(tenant, 'desk-a', 'password', ['read']);
    const idleLeaseExpiry = idle.lease.expiresAt;
    idle.session.idleExpiresAt = Date.now() - 1;
    await expect(
      registry.refresh(idle.session, idle.lease.jti, tenant.ttl.workspaceIdleSec),
    ).rejects.toMatchObject({ code: 'TEE_SESSION_EXPIRED' });
    expect(idle.lease.expiresAt).toBe(idleLeaseExpiry);
    await registry.destroy(idle.session.sid);

    const absolute = await registry.create(tenant, 'desk-a', 'password', ['read']);
    const absoluteLeaseExpiry = absolute.lease.expiresAt;
    (absolute.session as { absoluteExpiresAt: number }).absoluteExpiresAt = Date.now() - 1;
    await expect(
      registry.refresh(absolute.session, absolute.lease.jti, tenant.ttl.workspaceIdleSec),
    ).rejects.toMatchObject({ code: 'TEE_SESSION_EXPIRED' });
    expect(absolute.lease.expiresAt).toBe(absoluteLeaseExpiry);

    await registry.onApplicationShutdown();
    open.mockRestore();
  });
});

describe('SessionRegistry workspace deletion lifecycle', () => {
  function fixture(
    handles: Workspace[],
    processCapacity = 2,
  ): {
    registry: SessionRegistry;
    tenant: Tenant;
    open: jest.Mock;
  } {
    const tenant = tenantFixture(processCapacity);
    const draft = {
      tenants: {
        acme: {
          walletTotal: 0,
          workspaces: ['desk-a', 'desk-b'].map((slug) => ({
            slug,
            createdAt: new Date(0).toISOString(),
            walletCount: 0,
          })),
        },
      },
    };
    const state = {
      close: async () => undefined,
      tenant: () => draft.tenants.acme,
      mutate: async <T>(fn: (value: typeof draft) => T): Promise<T> => fn(draft),
    } as unknown as ServiceStateService;
    const open = jest.fn(async (
      _tenantId: string,
      _slug: string,
      _password: string,
      onOpened: (
        handle: Workspace,
        identity: { device: number; inode: number; realPath: string },
      ) => void,
    ) => {
      const handle = handles.shift();
      if (!handle) throw new Error('unexpected open');
      onOpened(handle, { device: 1, inode: 1, realPath: '/test/workspace' });
      return handle;
    });
    const storage = {
      assertExisting: async () => ({ device: 1, inode: 1, realPath: '/test/workspace' }),
      openExisting: open,
      remove: async () => undefined,
    } as unknown as WorkspaceStorageService;
    const registry = new SessionRegistry(
      { dataRoot: '/tmp/session-registry-delete-test' } as Paths,
      state,
      { process: processCapacity, leasesPerWorkspace: 4 },
      storage,
    );
    return { registry, tenant, open };
  }

  afterEach(() => jest.restoreAllMocks());

  it('rejects ordinary deletion of a leased singleton and force revokes every lease', async () => {
    const lock = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const { registry, tenant } = fixture([{ accounts: [], lock } as unknown as Workspace]);
    const first = await registry.create(tenant, 'desk-a', 'password', ['read']);
    const second = await registry.create(tenant, 'desk-a', 'password', ['write']);
    const remove = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);

    await expect(
      registry.deleteWorkspace('acme', 'desk-a', false, () => true, remove),
    ).rejects.toMatchObject({ code: 'TEE_WORKSPACE_IN_USE' });
    expect(remove).not.toHaveBeenCalled();
    expect(registry.get(first.session.sid, first.lease.jti, 'acme', 'desk-a', ['read'], 900)).not.toBeNull();

    await registry.deleteWorkspace('acme', 'desk-a', true, () => true, remove);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(registry.get(first.session.sid, first.lease.jti, 'acme', 'desk-a', ['read'], 900)).toBeNull();
    expect(registry.get(second.session.sid, second.lease.jti, 'acme', 'desk-a', ['write'], 900)).toBeNull();
    expect(registry.workspaceCount).toBe(0);
  });

  it('retains a capacity-charged closing tombstone when lock fails and retries it first', async () => {
    const lock = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error('lock failed'))
      .mockResolvedValue(undefined);
    const { registry, tenant, open } = fixture([
      { accounts: [], lock } as unknown as Workspace,
    ]);
    const grant = await registry.create(tenant, 'desk-a', 'password', ['read']);
    const remove = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);

    await expect(
      registry.deleteWorkspace('acme', 'desk-a', true, () => true, remove),
    ).rejects.toThrow('lock failed');
    expect(remove).not.toHaveBeenCalled();
    expect(registry.workspaceCount).toBe(1);
    expect(registry.get(grant.session.sid, grant.lease.jti, 'acme', 'desk-a', ['read'], 900)).toBeNull();

    await registry.deleteWorkspace('acme', 'desk-a', true, () => true, remove);
    expect(lock).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(registry.workspaceCount).toBe(0);
  });

  it('keeps a failed deletion tombstone but does not charge it as an unlocked handle', async () => {
    const firstLock = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const secondLock = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const { registry, tenant } = fixture(
      [
        { accounts: [], lock: firstLock } as unknown as Workspace,
        { accounts: [], lock: secondLock } as unknown as Workspace,
      ],
      1,
    );
    await registry.create(tenant, 'desk-a', 'password', ['read']);
    const failedRemove = jest.fn<Promise<void>, []>().mockRejectedValue(new Error('rm failed'));

    await expect(
      registry.deleteWorkspace('acme', 'desk-a', true, () => true, failedRemove),
    ).rejects.toThrow('rm failed');
    expect(registry.workspaceCount).toBe(1);
    await expect(
      registry.provisionWorkspace(tenant, 'desk-a', async () => undefined),
    ).rejects.toMatchObject({ code: 'TEE_WORKSPACE_IN_USE' });

    await registry.create(tenant, 'desk-b', 'password', ['read']);
    await registry.deleteWorkspace('acme', 'desk-a', true, () => true, async () => undefined);
    expect(registry.workspaceCount).toBe(1);
    await registry.onApplicationShutdown();
  });

  it('revokes before draining: active work finishes, later queued work cannot reach core', async () => {
    let releaseActive!: () => void;
    let activeEntered!: () => void;
    const activeBarrier = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      activeEntered = resolve;
    });
    const lock = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const { registry, tenant } = fixture([{ accounts: [], lock } as unknown as Workspace]);
    const grant = await registry.create(tenant, 'desk-a', 'password', ['write']);
    const events: string[] = [];
    const active = registry.withSession(grant.session, async () => {
      events.push('active');
      activeEntered();
      await activeBarrier;
    });
    await entered;

    const deleting = registry.deleteWorkspace(
      'acme',
      'desk-a',
      true,
      () => true,
      async () => {
        events.push('remove');
      },
    );
    await Promise.resolve();
    const queuedCore = jest.fn();
    const queued = registry.withSession(grant.session, queuedCore);
    releaseActive();

    await active;
    await expect(queued).rejects.toMatchObject({ code: 'TEE_SESSION_EXPIRED' });
    await deleting;
    expect(queuedCore).not.toHaveBeenCalled();
    expect(events).toEqual(['active', 'remove']);
    expect(lock).toHaveBeenCalledTimes(1);
  });

  it('serializes provisioning behind the complete delete callback', async () => {
    const { registry, tenant } = fixture([]);
    let releaseDelete!: () => void;
    let deletionEntered!: () => void;
    const deleteBarrier = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      deletionEntered = resolve;
    });
    const events: string[] = [];
    const deleting = registry.deleteWorkspace('acme', 'desk-a', true, () => true, async () => {
      events.push('delete-start');
      deletionEntered();
      await deleteBarrier;
      events.push('delete-end');
    });
    await entered;
    const provisioning = registry.provisionWorkspace(tenant, 'desk-a', async () => {
      events.push('provision');
    });
    await Promise.resolve();
    expect(events).toEqual(['delete-start']);
    releaseDelete();
    await Promise.all([deleting, provisioning]);
    expect(events).toEqual(['delete-start', 'delete-end', 'provision']);
    await registry.onApplicationShutdown();
  });
});

describe('SessionRegistry storage identity and admission ordering', () => {
  afterEach(() => jest.restoreAllMocks());

  it('retires the active singleton instead of leasing after its storage identity changes', async () => {
    const handle = {
      accounts: [],
      lock: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    } as unknown as Workspace;
    const identity = { device: 1, inode: 1, realPath: '/test/workspace' };
    const changed = { ...identity, inode: 2 };
    let existingChecks = 0;
    const storage = {
      assertExisting: jest.fn(async () => {
        existingChecks += 1;
        if (existingChecks === 1) return identity;
        throw Object.assign(new Error('storage changed'), { code: 'PROVIDER_IO' });
      }),
      openExisting: async (
        _tenantId: string,
        _slug: string,
        _password: string,
        onOpened: (
          workspace: Workspace,
          storageIdentity: { device: number; inode: number; realPath: string },
        ) => void,
      ) => {
        onOpened(handle, changed.inode === 2 ? identity : changed);
        return handle;
      },
    } as unknown as WorkspaceStorageService;
    const draft = {
      tenants: {
        acme: {
          walletTotal: 0,
          workspaces: [
            { slug: 'desk-a', createdAt: new Date(0).toISOString(), walletCount: 0 },
          ],
        },
      },
    };
    const state = {
      close: async () => undefined,
      tenant: () => draft.tenants.acme,
      mutate: async <T>(fn: (value: typeof draft) => T): Promise<T> => fn(draft),
    } as unknown as ServiceStateService;
    const registry = new SessionRegistry(
      { dataRoot: '/tmp/session-registry-identity-test' } as Paths,
      state,
      { process: 2, leasesPerWorkspace: 2 },
      storage,
    );

    const initial = await registry.create(tenantFixture(), 'desk-a', 'password', ['read']);
    await expect(
      registry.create(tenantFixture(), 'desk-a', 'password', ['read']),
    ).rejects.toMatchObject({ code: 'PROVIDER_IO' });
    expect(registry.leaseCount).toBe(0);
    expect(registry.size).toBe(0);
    expect(handle.lock).toHaveBeenCalledTimes(1);
    expect(
      registry.get(initial.session.sid, initial.lease.jti, 'acme', 'desk-a', ['read'], 900),
    ).toBeNull();
    await registry.onApplicationShutdown();
  });

  it('returns missing-storage before capacity without opening or reserving a second entry', async () => {
    const first = {
      accounts: [],
      lock: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    } as unknown as Workspace;
    const identity = { device: 1, inode: 1, realPath: '/test/desk-a' };
    const storage = {
      assertExisting: jest.fn(async (_tenantId: string, slug: string) => {
        if (slug === 'desk-b') {
          throw Object.assign(new Error('missing'), { code: 'TEE_WORKSPACE_NOT_FOUND' });
        }
        return identity;
      }),
      openExisting: jest.fn(async (
        _tenantId: string,
        _slug: string,
        _password: string,
        onOpened: (
          workspace: Workspace,
          storageIdentity: { device: number; inode: number; realPath: string },
        ) => void,
      ) => {
        onOpened(first, identity);
        return first;
      }),
    } as unknown as WorkspaceStorageService;
    const draft = {
      tenants: {
        acme: {
          walletTotal: 0,
          workspaces: ['desk-a', 'desk-b'].map((slug) => ({
            slug,
            createdAt: new Date(0).toISOString(),
            walletCount: 0,
          })),
        },
      },
    };
    const state = {
      close: async () => undefined,
      tenant: () => draft.tenants.acme,
      mutate: async <T>(fn: (value: typeof draft) => T): Promise<T> => fn(draft),
    } as unknown as ServiceStateService;
    const registry = new SessionRegistry(
      { dataRoot: '/tmp/session-registry-capacity-order-test' } as Paths,
      state,
      { process: 1, leasesPerWorkspace: 2 },
      storage,
    );
    const tenant = tenantFixture(1);
    await registry.create(tenant, 'desk-a', 'password', ['read']);

    await expect(registry.create(tenant, 'desk-b', 'password', ['read'])).rejects.toMatchObject({
      code: 'TEE_WORKSPACE_NOT_FOUND',
    });
    expect(storage.openExisting).toHaveBeenCalledTimes(1);
    expect(registry.workspaceCount).toBe(1);
    expect(registry.size).toBe(1);
    await registry.onApplicationShutdown();
  });
});

describe('wallet reconciliation refuses an undercount (L-13)', () => {
  afterEach(() => jest.restoreAllMocks());

  function build(damaged: string[], walletsPerAccount: number) {
    const draft = {
      tenants: {
        acme: {
          walletTotal: 4,
          workspaces: [{ slug: 'desk-a', createdAt: new Date(0).toISOString(), walletCount: 4 }],
        },
      },
    };
    const mutate = jest.fn(async <T>(fn: (value: typeof draft) => T): Promise<T> => fn(draft));
    const state = {
      close: async () => undefined,
      tenant: () => draft.tenants.acme,
      mutate,
    } as unknown as ServiceStateService;
    const registry = new SessionRegistry(
      { dataRoot: '/tmp/session-registry-l13-test' } as Paths,
      state,
      { process: 2, leasesPerWorkspace: 2 },
      testStorage,
    );
    const session = {
      tenantId: 'acme',
      workspaceSlug: 'desk-a',
      handle: {
        damagedAccountSlugs: damaged,
        accounts: [{ wallets: new Array(walletsPerAccount).fill({}) }],
      },
    } as never;
    return { registry, session, draft, mutate };
  }

  it('leaves the stored count alone when an account record is damaged', async () => {
    // The live collection omits damaged accounts, so writing its count as
    // authoritative permanently lowers the tenant's quota.
    const { registry, session, draft, mutate } = build(['alpha'], 1);
    await registry.syncWalletCount(session);
    expect(mutate).not.toHaveBeenCalled();
    expect(draft.tenants.acme.workspaces[0]!.walletCount).toBe(4);
    expect(draft.tenants.acme.walletTotal).toBe(4);
  });

  it('reconciles normally when nothing is damaged', async () => {
    const { registry, session, draft } = build([], 2);
    await registry.syncWalletCount(session);
    expect(draft.tenants.acme.workspaces[0]!.walletCount).toBe(2);
    expect(draft.tenants.acme.walletTotal).toBe(2);
  });
});

describe('Cold Vault accounts are not exposed by creation (L-07)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('does not record an unlock episode for an own-password account', async () => {
    // requireAccount returns a live-custody account BEFORE it reaches the
    // hasOwnPassword gate, so recording exposure at creation would hand the
    // vault to every lease on the session for the whole account TTL.
    const { AccountsService } = await import('../src/session/accounts.service');
    const recordAccountExposure = jest.fn();
    const lockAccount = jest.fn().mockResolvedValue(undefined);
    const account = { slug: 'vault-a', hasOwnPassword: true, wallets: [], lock: lockAccount };
    const handle = {
      accounts: Object.assign([], { create: jest.fn().mockResolvedValue(account) }),
    };
    const session = { handle, password: 'workspace-password', workspaceSlug: 'desk-a' } as never;
    const tenant = { id: 'acme', limits: { maxWallets: 10 } } as never;
    const state = {
      mutate: async <T>(fn: (d: unknown) => T): Promise<T> =>
        fn({ tenants: { acme: { walletTotal: 0, workspaces: [{ slug: 'desk-a', walletCount: 0 }] } } }),
    };
    const service = new AccountsService(
      {
        recordAccountExposure,
        requireAccount: jest.fn(),
        syncWalletCount: jest.fn().mockResolvedValue(undefined),
        markUnusable: jest.fn(),
      } as never,
      state as never,
    );

    await service.create(session, tenant, {
      displayName: 'Cold vault account',
      kind: 'HD',
      hasOwnPassword: true,
      accountPassword: 'Vault-Passw0rd!x',
    });
    expect(recordAccountExposure).not.toHaveBeenCalled();
    // Without a custody entry the expiry timer never sees this account, so it
    // must be locked outright or it outlives every other account's TTL.
    expect(lockAccount).toHaveBeenCalledTimes(1);
  });

  it('still records one for an ordinary account', async () => {
    const { AccountsService } = await import('../src/session/accounts.service');
    const recordAccountExposure = jest.fn();
    const account = { slug: 'plain-a', hasOwnPassword: false, wallets: [] };
    const handle = {
      accounts: Object.assign([], { create: jest.fn().mockResolvedValue(account) }),
    };
    const session = { handle, password: 'workspace-password', workspaceSlug: 'desk-a' } as never;
    const tenant = { id: 'acme', limits: { maxWallets: 10 } } as never;
    const state = {
      mutate: async <T>(fn: (d: unknown) => T): Promise<T> =>
        fn({ tenants: { acme: { walletTotal: 0, workspaces: [{ slug: 'desk-a', walletCount: 0 }] } } }),
    };
    const service = new AccountsService(
      {
        recordAccountExposure,
        requireAccount: jest.fn(),
        syncWalletCount: jest.fn().mockResolvedValue(undefined),
        markUnusable: jest.fn(),
      } as never,
      state as never,
    );

    await service.create(session, tenant, { displayName: 'Plain account', kind: 'HD' });
    expect(recordAccountExposure).toHaveBeenCalledWith(session, 'plain-a');
  });
});

describe('SessionRegistry.lockAllHandlesBestEffort (L-12)', () => {
  afterEach(() => jest.restoreAllMocks());

  function fixture(lock: jest.Mock<Promise<void>, []>) {
    const draft = {
      tenants: {
        acme: {
          walletTotal: 0,
          workspaces: ['desk-a', 'desk-b'].map((slug) => ({
            slug,
            createdAt: new Date(0).toISOString(),
            walletCount: 0,
          })),
        },
      },
    };
    const stateClose = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const state = {
      close: stateClose,
      tenant: () => draft.tenants.acme,
      mutate: async <T>(fn: (value: typeof draft) => T): Promise<T> => fn(draft),
    } as unknown as ServiceStateService;
    const registry = new SessionRegistry(
      { dataRoot: '/tmp/session-registry-l12-test' } as Paths,
      state,
      { process: 4, leasesPerWorkspace: 4 },
      testStorage,
    );
    const handle = { accounts: [], lock } as unknown as Workspace;
    jest.spyOn(Workspace, 'open').mockResolvedValue(handle);
    return { registry, stateClose, handle };
  }

  it('locks every handle and reports nothing when all succeed', async () => {
    const lock = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const { registry } = fixture(lock);
    await registry.create(tenantFixture(), 'desk-a', 'password', ['read']);
    await registry.create(tenantFixture(), 'desk-b', 'password', ['read']);

    await expect(registry.lockAllHandlesBestEffort()).resolves.toEqual([]);
    expect(lock).toHaveBeenCalledTimes(2);
    expect(registry.workspaceCount).toBe(0);
  });

  it('never throws, and one failure does not stop the others', async () => {
    // A fatal-exit handler cannot let an exception escape, and a wedged
    // workspace must not keep its siblings' keys resident.
    const lock = jest.fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error('core lock failure'))
      .mockResolvedValue(undefined);
    const { registry } = fixture(lock);
    await registry.create(tenantFixture(), 'desk-a', 'password', ['read']);
    await registry.create(tenantFixture(), 'desk-b', 'password', ['read']);

    const failures = await registry.lockAllHandlesBestEffort();
    expect(failures).toHaveLength(1);
    expect(lock).toHaveBeenCalledTimes(2);
  });

  it('gives up after the deadline rather than hanging the exit', async () => {
    const lock = jest.fn<Promise<void>, []>().mockImplementation(() => new Promise(() => {}));
    const { registry } = fixture(lock);
    await registry.create(tenantFixture(), 'desk-a', 'password', ['read']);

    const failures = await registry.lockAllHandlesBestEffort(25);
    expect(failures).toHaveLength(1);
    expect(String(failures[0])).toContain('timed out');
  });

  it('locks a workspace whose open is still in flight', async () => {
    // The defect this primitive shipped with: iterating #workspaces alone
    // misses an entry still opening, and reports total success while a fully
    // decrypted handle goes to the grave unlocked.
    const lock = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const { registry, stateClose, handle } = fixture(lock);
    let entered!: () => void;
    let release!: () => void;
    const openEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.spyOn(Workspace, 'open').mockImplementation(async () => {
      entered();
      await gate;
      return handle;
    });

    const creating = registry.create(tenantFixture(), 'desk-a', 'password', ['read']);
    await openEntered;
    const locking = registry.lockAllHandlesBestEffort();
    release();

    await expect(creating).rejects.toMatchObject({ code: 'TEE_SESSION_EXPIRED' });
    await expect(locking).resolves.toEqual([]);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(stateClose).toHaveBeenCalledTimes(1);
  });

  it('releases the ledger process lock so the next boot is not blocked', async () => {
    const lock = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const { registry, stateClose } = fixture(lock);
    await registry.create(tenantFixture(), 'desk-a', 'password', ['read']);

    await registry.lockAllHandlesBestEffort();
    expect(stateClose).toHaveBeenCalledTimes(1);
  });

  it('records book-keeping failures instead of throwing', async () => {
    const lock = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const { registry, stateClose } = fixture(lock);
    await registry.create(tenantFixture(), 'desk-a', 'password', ['read']);
    jest
      .spyOn(registry as unknown as { clearAccountTimer: () => void }, 'clearAccountTimer')
      .mockImplementation(() => {
        throw new Error('scheduler exploded');
      });

    // A fatal-exit handler cannot let this throw, and the ledger lock must
    // still be released. See R-14 for the residual: closeEntry runs fallible
    // book-keeping before handle.lock(), so this failure does cost that lock.
    const failures = await registry.lockAllHandlesBestEffort();
    expect(failures.map(String).join()).toContain('scheduler exploded');
    expect(stateClose).toHaveBeenCalledTimes(1);
  });

  it('refuses new work once it has run', async () => {
    const lock = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const { registry } = fixture(lock);
    await registry.lockAllHandlesBestEffort();
    await expect(
      registry.create(tenantFixture(), 'desk-a', 'password', ['read']),
    ).rejects.toMatchObject({ code: 'TEE_SESSION_EXPIRED' });
  });
});

describe('SessionRegistry.knowsWorkspace (L-10)', () => {
  afterEach(() => jest.restoreAllMocks());

  function build() {
    const draft = {
      tenants: {
        acme: {
          walletTotal: 0,
          workspaces: [
            { slug: 'desk-a', createdAt: new Date(0).toISOString(), walletCount: 0 },
          ],
        },
      },
    };
    const state = {
      close: async () => undefined,
      tenant: () => draft.tenants.acme,
      mutate: async <T>(fn: (value: typeof draft) => T): Promise<T> => fn(draft),
    } as unknown as ServiceStateService;
    return new SessionRegistry(
      { dataRoot: '/tmp/session-registry-knows-test' } as Paths,
      state,
      { process: 2, leasesPerWorkspace: 2 },
      testStorage,
    );
  }

  it('reports ledger rows and unknown slugs without touching core', () => {
    const open = jest.spyOn(Workspace, 'open');
    const registry = build();
    expect(registry.knowsWorkspace('acme', 'desk-a')).toBe(true);
    expect(registry.knowsWorkspace('acme', 'no-such-desk')).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it('reports a live entry as known', async () => {
    const lock = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    jest.spyOn(Workspace, 'open').mockResolvedValue(
      { accounts: [], lock } as unknown as Workspace,
    );
    const registry = build();
    await registry.create(tenantFixture(), 'desk-a', 'password', ['read']);
    expect(registry.knowsWorkspace('acme', 'desk-a')).toBe(true);
    await registry.onApplicationShutdown();
  });
});

describe('SessionRegistry shutdown drain classification (R-02)', () => {
  // Without this, a failing test here leaks its Workspace.open spy and the
  // collateral lands on the C-04 shutdown test under randomized order.
  afterEach(() => jest.restoreAllMocks());

  function fixture(lock: jest.Mock<Promise<void>, []>) {
    const draft = {
      tenants: {
        acme: {
          walletTotal: 0,
          workspaces: [
            { slug: 'desk-shutdown', createdAt: new Date(0).toISOString(), walletCount: 0 },
          ],
        },
      },
    };
    const stateClose = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const state = {
      close: stateClose,
      tenant: () => draft.tenants.acme,
      mutate: async <T>(fn: (value: typeof draft) => T): Promise<T> => fn(draft),
    } as unknown as ServiceStateService;
    const registry = new SessionRegistry(
      { dataRoot: '/tmp/session-registry-r02-test' } as Paths,
      state,
      { process: 2, leasesPerWorkspace: 2 },
      testStorage,
    );
    return { registry, stateClose, handle: { accounts: [], lock } as unknown as Workspace };
  }

  /** Park inside Workspace.open so shutdown observes a genuinely in-flight job. */
  function barrier(handle: Workspace) {
    let entered!: () => void;
    let release!: () => void;
    const openEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const open = jest.spyOn(Workspace, 'open').mockImplementation(async () => {
      entered();
      await gate;
      return handle;
    });
    return { openEntered, release, open };
  }

  it('releases the state lock when an in-flight open is correctly rejected at shutdown', async () => {
    const lock = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const { registry, stateClose, handle } = fixture(lock);
    const { openEntered, release, open } = barrier(handle);

    const creating = registry.create(tenantFixture(), 'desk-shutdown', 'password', ['read']);
    await openEntered;
    const shutdown = registry.onApplicationShutdown();
    release();

    // The registry's own shutdown gate rejects the caller. That is an admission
    // outcome, not a custody failure, so shutdown must still drain cleanly.
    await expect(creating).rejects.toMatchObject({ code: 'TEE_SESSION_EXPIRED' });
    await expect(shutdown).resolves.toBeUndefined();
    expect(lock).toHaveBeenCalledTimes(1);
    expect(stateClose).toHaveBeenCalledTimes(1);
    expect(registry.workspaceCount).toBe(0);
    open.mockRestore();
  });

  it('releases the state lock when an in-flight open fails for a non-shutdown reason', async () => {
    const lock = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const { registry, stateClose } = fixture(lock);
    let entered!: () => void;
    let release!: () => void;
    const openEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const open = jest.spyOn(Workspace, 'open').mockImplementation(async () => {
      entered();
      await gate;
      throw new Error('core refused the open');
    });

    const creating = registry.create(tenantFixture(), 'desk-shutdown', 'password', ['read']);
    await openEntered;
    const shutdown = registry.onApplicationShutdown();
    release();

    // No handle was ever produced, so there is no custody to fail. A generalized
    // fix must cover this, not just the shutdown gate's own error code.
    await expect(creating).rejects.toThrow('core refused the open');
    await expect(shutdown).resolves.toBeUndefined();
    expect(lock).not.toHaveBeenCalled();
    expect(stateClose).toHaveBeenCalledTimes(1);
    expect(registry.workspaceCount).toBe(0);
    open.mockRestore();
  });

  it('releases the state lock when in-flight provisioning is rejected after retaining a handle', async () => {
    // The provisioning path carried the identical defect: a provision that fails
    // after retainHandle used to poison shutdown even though cleanup locked.
    const lock = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const { registry, stateClose, handle } = fixture(lock);
    let entered!: () => void;
    let release!: () => void;
    const openEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const provisioning = registry.provisionWorkspace(
      tenantFixture(),
      'desk-provision',
      async (retainHandle) => {
        retainHandle(handle);
        entered();
        await gate;
        throw new Error('seeding failed after the handle was retained');
      },
    );
    await openEntered;
    const shutdown = registry.onApplicationShutdown();
    release();

    await expect(provisioning).rejects.toThrow('seeding failed after the handle was retained');
    await expect(shutdown).resolves.toBeUndefined();
    expect(lock).toHaveBeenCalledTimes(1);
    expect(stateClose).toHaveBeenCalledTimes(1);
    expect(registry.workspaceCount).toBe(0);
  });

  it('retains the entry and the state lock when provisioning cleanup genuinely fails to lock', async () => {
    const lock = jest.fn<Promise<void>, []>().mockRejectedValue(new Error('core lock failure'));
    const { registry, stateClose, handle } = fixture(lock);

    await expect(
      registry.provisionWorkspace(tenantFixture(), 'desk-provision', async (retainHandle) => {
        retainHandle(handle);
        throw new Error('seeding failed');
      }),
    ).rejects.toThrow(/provisioning and core-handle cleanup both failed/);

    await expect(registry.onApplicationShutdown()).rejects.toThrow(
      'failed to lock 1 workspace session(s)',
    );
    expect(registry.workspaceCount).toBe(1);
    expect(stateClose).not.toHaveBeenCalled();
  });

  it('retains the entry and the state lock when an in-flight open genuinely fails to lock', async () => {
    const lock = jest.fn<Promise<void>, []>().mockRejectedValue(new Error('core lock failure'));
    const { registry, stateClose, handle } = fixture(lock);
    const { openEntered, release, open } = barrier(handle);

    const creating = registry.create(tenantFixture(), 'desk-shutdown', 'password', ['read']);
    await openEntered;
    const shutdown = registry.onApplicationShutdown();
    release();

    await expect(creating).rejects.toThrow(/desk-shutdown/);
    // Phase 1 no longer reports it, so the throw-before-delete ordering is the
    // whole safety net: the entry must survive for the phase-2 snapshot.
    // Assert the aggregate carries exactly one error. Matching only the count
    // inside the message would still pass if phase 1 reported it a second time.
    const aggregate = await shutdown.then(
      () => undefined,
      (err: unknown) => err as AggregateError,
    );
    expect(aggregate).toBeInstanceOf(AggregateError);
    expect(aggregate!.errors).toHaveLength(1);
    expect(aggregate!.message).toBe('failed to lock 1 workspace session(s)');
    expect(registry.workspaceCount).toBe(1);
    expect(stateClose).not.toHaveBeenCalled();
    expect(lock.mock.calls.length).toBeGreaterThanOrEqual(2);
    open.mockRestore();
  });
});
