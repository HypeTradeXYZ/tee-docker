import { Workspace, WativeError } from 'wative-core';
import type { Paths } from '../src/config/paths';
import type { Tenant } from '../src/config/schemas';
import type { ServiceStateService } from '../src/config/service-state.service';
import { AccountsService } from '../src/session/accounts.service';
import { SessionRegistry } from '../src/session/session.registry';
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

describe('wallet ledger serialization', () => {
  it('holds the workspace mutex through the awaited authoritative ledger write', async () => {
    const events: string[] = [];
    const accountItems: Array<{ wallets: unknown[] }> = [];
    const accounts = Object.assign(accountItems, {
      create: jest.fn(async (displayName: string) => {
        events.push(`core:${displayName}`);
        const account = { slug: displayName, wallets: [{}] };
        accounts.push(account);
        return account;
      }),
    });
    const handle = {
      accounts,
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
    let mutations = 0;
    let ledgerEntered!: () => void;
    let releaseLedger!: () => void;
    const entered = new Promise<void>((resolve) => {
      ledgerEntered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      releaseLedger = resolve;
    });
    const state = {
      close: async () => undefined,
      tenant: () => draft.tenants.acme,
      mutate: async <T>(fn: (value: typeof draft) => T): Promise<T> => {
        mutations += 1;
        if (mutations === 3) {
          events.push('ledger:first-enter');
          ledgerEntered();
          await barrier;
        }
        const result = fn(draft);
        events.push(`ledger:${draft.tenants.acme.walletTotal}`);
        return result;
      },
    } as unknown as ServiceStateService;
    const registry = new SessionRegistry(
      { dataRoot: '/tmp/wallet-ledger-serialization-test' } as Paths,
      state,
      { process: 2, leasesPerWorkspace: 2 },
      testStorage,
    );
    const service = new AccountsService(registry, state);
    const { session } = await registry.create(tenant, 'desk-a', 'password', ['write']);

    const first = registry.withSession(session, () =>
      service.create(session, tenant, { displayName: 'first', kind: 'PK', secret: 'key-one' }),
    );
    await entered;
    const second = registry.withSession(session, () =>
      service.create(session, tenant, { displayName: 'second', kind: 'PK', secret: 'key-two' }),
    );
    await Promise.resolve();
    expect(accounts.create).toHaveBeenCalledTimes(1);
    expect(draft.tenants.acme.walletTotal).toBe(1);

    releaseLedger();
    await Promise.all([first, second]);
    expect(accounts.create).toHaveBeenCalledTimes(2);
    expect(draft.tenants.acme.walletTotal).toBe(2);
    expect(session.accounts.get('first')).toMatchObject({ state: 'live' });
    expect(session.accounts.get('second')).toMatchObject({ state: 'live' });
    expect(events.indexOf('ledger:1')).toBeLessThan(events.indexOf('core:second'));

    await registry.onApplicationShutdown();
    open.mockRestore();
  });

  it('retires after a validation error and releases its reservation only on genuine reopen', async () => {
    const staleWallets: unknown[] = [{}];
    const staleAccount = {
      locked: false,
      hasOwnPassword: false,
      wallets: staleWallets,
      importPrivateKey: jest
        .fn()
        .mockRejectedValue(new WativeError('INVALID_PRIVATE_KEY', 'invalid key probe')),
    };
    const staleAccounts = Object.assign([staleAccount], {
      bySlug: () => staleAccount,
    });
    let firstLocked!: () => void;
    const firstLockCalled = new Promise<void>((resolve) => {
      firstLocked = resolve;
    });
    const first = {
      accounts: staleAccounts,
      lock: jest.fn(async () => firstLocked()),
    } as unknown as Workspace;
    const reopenedWallets: unknown[] = [{}];
    const reopenedAccount = {
      locked: false,
      hasOwnPassword: false,
      wallets: reopenedWallets,
      importPrivateKey: jest.fn(async () => {
        const wallet = {};
        reopenedWallets.push(wallet);
        return wallet;
      }),
    };
    const reopenedAccounts = Object.assign([reopenedAccount], {
      bySlug: () => reopenedAccount,
    });
    const second = {
      accounts: reopenedAccounts,
      lock: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    } as unknown as Workspace;
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
    const state = {
      close: async () => undefined,
      tenant: () => draft.tenants.acme,
      mutate: async <T>(fn: (value: typeof draft) => T): Promise<T> => fn(draft),
    } as unknown as ServiceStateService;
    const registry = new SessionRegistry(
      { dataRoot: '/tmp/wallet-ledger-partial-failure-test' } as Paths,
      state,
      { process: 2, leasesPerWorkspace: 2 },
      testStorage,
    );
    const service = new AccountsService(registry, state);
    const initial = await registry.create(tenant, 'desk-a', 'password', ['write']);
    initial.session.accounts.set('vault', { state: 'live', expiresAt: Date.now() + 60_000 });

    await expect(
      registry.withSession(initial.session, () =>
        service.importPrivateKey(initial.session, tenant, 'vault', 'key-one'),
      ),
    ).rejects.toThrow('invalid key probe');
    await firstLockCalled;
    expect(draft.tenants.acme.walletTotal).toBe(2);
    expect(registry.size).toBe(0);

    const reopened = await registry.create(tenant, 'desk-a', 'password', ['write']);
    expect(draft.tenants.acme.walletTotal).toBe(1);
    reopened.session.accounts.set('vault', { state: 'live', expiresAt: Date.now() + 60_000 });
    await registry.withSession(reopened.session, () =>
      service.importPrivateKey(reopened.session, tenant, 'vault', 'key-two'),
    );
    expect(draft.tenants.acme.walletTotal).toBe(2);
    expect(open).toHaveBeenCalledTimes(2);

    await registry.onApplicationShutdown();
    open.mockRestore();
  });

  it('retires the singleton after repeated ledger failure and reconciles on a genuine reopen', async () => {
    const accountItems: Array<{ wallets: unknown[] }> = [];
    const accounts = Object.assign(accountItems, {
      create: jest.fn(async () => {
        const account = { wallets: [{}] };
        accounts.push(account);
        return account;
      }),
    });
    let locked!: () => void;
    const lockCalled = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const handle = {
      accounts,
      lock: jest.fn(async () => locked()),
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
    let mutations = 0;
    const state = {
      close: async () => undefined,
      tenant: () => draft.tenants.acme,
      mutate: async <T>(fn: (value: typeof draft) => T): Promise<T> => {
        mutations += 1;
        if (mutations === 3) throw new Error('ledger unavailable');
        return fn(draft);
      },
    } as unknown as ServiceStateService;
    const registry = new SessionRegistry(
      { dataRoot: '/tmp/wallet-ledger-reopen-test' } as Paths,
      state,
      { process: 2, leasesPerWorkspace: 2 },
      testStorage,
    );
    const service = new AccountsService(registry, state);
    const initial = await registry.create(tenant, 'desk-a', 'password', ['write']);

    await expect(
      registry.withSession(initial.session, () =>
        service.create(initial.session, tenant, {
          displayName: 'persisted',
          kind: 'PK',
          secret: 'key-one',
        }),
      ),
    ).rejects.toThrow('ledger unavailable');
    await lockCalled;
    expect(registry.size).toBe(0);
    expect(draft.tenants.acme.walletTotal).toBe(1);

    const reopened = await registry.create(tenant, 'desk-a', 'password', ['read']);
    expect(reopened.session.sid).not.toBe(initial.session.sid);
    expect(open).toHaveBeenCalledTimes(2);
    expect(draft.tenants.acme.walletTotal).toBe(1);

    await registry.onApplicationShutdown();
    open.mockRestore();
  });

  it('does not call core when reservation persistence fails and allows a later admission', async () => {
    const accountItems: Array<{ wallets: unknown[] }> = [];
    const accounts = Object.assign(accountItems, {
      create: jest.fn(async () => {
        const account = { wallets: [{}] };
        accounts.push(account);
        return account;
      }),
    });
    const handle = {
      accounts,
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
    let failAdmission = false;
    const state = {
      close: async () => undefined,
      tenant: () => draft.tenants.acme,
      mutate: async <T>(fn: (value: typeof draft) => T): Promise<T> => {
        if (failAdmission) throw new Error('admission persistence probe');
        return fn(draft);
      },
    } as unknown as ServiceStateService;
    const registry = new SessionRegistry(
      { dataRoot: '/tmp/wallet-reservation-failure-test' } as Paths,
      state,
      { process: 2, leasesPerWorkspace: 2 },
      testStorage,
    );
    const service = new AccountsService(registry, state);
    const { session } = await registry.create(tenant, 'desk-a', 'password', ['write']);

    failAdmission = true;
    await expect(
      registry.withSession(session, () =>
        service.create(session, tenant, {
          displayName: 'denied',
          kind: 'PK',
          secret: 'key-one',
        }),
      ),
    ).rejects.toThrow('admission persistence probe');
    expect(accounts.create).not.toHaveBeenCalled();
    expect(draft.tenants.acme.walletTotal).toBe(0);

    failAdmission = false;
    await registry.withSession(session, () =>
      service.create(session, tenant, {
        displayName: 'accepted',
        kind: 'PK',
        secret: 'key-two',
      }),
    );
    expect(accounts.create).toHaveBeenCalledTimes(1);
    expect(draft.tenants.acme.walletTotal).toBe(1);

    await registry.onApplicationShutdown();
    open.mockRestore();
  });

  it('keeps an account reservation when core may persist before throwing', async () => {
    const firstAccounts = Object.assign([], {
      create: jest.fn<Promise<never>, []>().mockRejectedValue(new Error('persist-then-throw probe')),
    });
    let firstLocked!: () => void;
    const firstLockCalled = new Promise<void>((resolve) => {
      firstLocked = resolve;
    });
    const first = {
      accounts: firstAccounts,
      lock: jest.fn(async () => firstLocked()),
    } as unknown as Workspace;
    const second = {
      accounts: [{ wallets: [{}] }],
      lock: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    } as unknown as Workspace;
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
    const state = {
      close: async () => undefined,
      tenant: () => draft.tenants.acme,
      mutate: async <T>(fn: (value: typeof draft) => T): Promise<T> => fn(draft),
    } as unknown as ServiceStateService;
    const registry = new SessionRegistry(
      { dataRoot: '/tmp/account-create-ambiguous-failure-test' } as Paths,
      state,
      { process: 2, leasesPerWorkspace: 2 },
      testStorage,
    );
    const service = new AccountsService(registry, state);
    const initial = await registry.create(tenant, 'desk-a', 'password', ['write']);

    await expect(
      registry.withSession(initial.session, () =>
        service.create(initial.session, tenant, {
          displayName: 'ambiguous',
          kind: 'PK',
          secret: 'key-one',
        }),
      ),
    ).rejects.toThrow('persist-then-throw probe');
    await firstLockCalled;
    expect(draft.tenants.acme.walletTotal).toBe(1);
    expect(registry.size).toBe(0);

    const reopened = await registry.create(tenant, 'desk-a', 'password', ['read']);
    expect(reopened.session.sid).not.toBe(initial.session.sid);
    expect(draft.tenants.acme.walletTotal).toBe(1);
    expect(open).toHaveBeenCalledTimes(2);

    await registry.onApplicationShutdown();
    open.mockRestore();
  });

  it.each(['derive', 'import'] as const)(
    'keeps a %s reservation when disk changes but the live collection stays stale',
    async (kind) => {
      const staleWallets: unknown[] = [{}];
      const firstAccount = {
        locked: false,
        hasOwnPassword: false,
        organizationType: 'HD',
        wallets: staleWallets,
        deriveWallets: jest.fn().mockRejectedValue(new Error('commit-then-throw probe')),
        importPrivateKey: jest.fn().mockRejectedValue(new Error('commit-then-throw probe')),
      };
      const firstAccounts = Object.assign([firstAccount], {
        bySlug: () => firstAccount,
      });
      let firstLocked!: () => void;
      const firstLockCalled = new Promise<void>((resolve) => {
        firstLocked = resolve;
      });
      const first = {
        accounts: firstAccounts,
        lock: jest.fn(async () => firstLocked()),
      } as unknown as Workspace;
      const reopenedAccount = { wallets: [{}, {}] };
      const second = {
        accounts: [reopenedAccount],
        lock: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
      } as unknown as Workspace;
      const open = jest
        .spyOn(Workspace, 'open')
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second);
      const draft = {
        tenants: {
          acme: {
            walletTotal: 1,
            workspaces: [
              { slug: 'desk-a', createdAt: new Date(0).toISOString(), walletCount: 1 },
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
        { dataRoot: `/tmp/${kind}-ambiguous-failure-test` } as Paths,
        state,
        { process: 2, leasesPerWorkspace: 2 },
        testStorage,
      );
      const service = new AccountsService(registry, state);
      const initial = await registry.create(tenant, 'desk-a', 'password', ['write']);
      initial.session.accounts.set('vault', { state: 'live', expiresAt: Date.now() + 60_000 });

      await expect(
        registry.withSession<unknown>(initial.session, async () => {
          if (kind === 'derive') {
            return service.deriveWallets(initial.session, tenant, 'vault', 1);
          }
          return service.importPrivateKey(initial.session, tenant, 'vault', 'key-two');
        }),
      ).rejects.toThrow('commit-then-throw probe');
      await firstLockCalled;
      expect(staleWallets).toHaveLength(1);
      expect(draft.tenants.acme.walletTotal).toBe(2);
      expect(registry.size).toBe(0);

      await registry.create(tenant, 'desk-a', 'password', ['read']);
      expect(open).toHaveBeenCalledTimes(2);
      expect(draft.tenants.acme.walletTotal).toBe(2);

      await registry.onApplicationShutdown();
      open.mockRestore();
    },
  );
});
