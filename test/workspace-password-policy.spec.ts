import { PasswordPolicy, Workspace } from 'wative-core';
import type { ServiceState, Tenant } from '../src/config/schemas';
import type { ServiceStateService } from '../src/config/service-state.service';
import { WorkspacesService } from '../src/workspaces/workspaces.service';
import { DEFAULT_TENANT } from './harness/boot';

describe('workspace password policy', () => {
  const policy = new PasswordPolicy();

  it('preserves the exact wative-core 2.4.4 default boundary', () => {
    expect(() => policy.enforce('Abcdef1!xyz')).toThrow(expect.objectContaining({
      code: 'WEAK_PASSWORD',
    }));
    expect(() => policy.enforce('Abcdef1!xyzw')).not.toThrow();
    expect(() => policy.enforce('Workspace-Passw0rd!x')).not.toThrow();
  });

  it('does not invent slug/tenant username context or normalize Unicode', () => {
    expect(() => policy.enforce('desk-a-Strong1!')).not.toThrow();
    expect(() => policy.enforce('éééééééééééé')).not.toThrow();
    expect(() => policy.enforce('e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301')).toThrow(
      expect.objectContaining({ code: 'WEAK_PASSWORD' }),
    );
  });

  it('rejects before provisioning even when the controller is bypassed', async () => {
    const provisionWorkspace = jest.fn();
    const service = new WorkspacesService(
      {} as never,
      {} as never,
      { provisionWorkspace } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(service.create(DEFAULT_TENANT as never, 'desk-a', 'weak'))
      .rejects.toMatchObject({ code: 'WEAK_PASSWORD' });
    expect(provisionWorkspace).not.toHaveBeenCalled();
  });

  it('creates an own ledger row for the valid tenant id constructor', async () => {
    const data: ServiceState = { tenants: {} };
    const state = {
      tenant: (id: string) => Object.hasOwn(data.tenants, id)
        ? structuredClone(data.tenants[id])
        : { walletTotal: 0, workspaces: [] },
      mutate: async <T>(fn: (draft: ServiceState) => T): Promise<T> => fn(data),
    } as ServiceStateService;
    const provisionWorkspace = jest.fn(async (
      _tenant: Tenant,
      _slug: string,
      operation: (retain: (handle: Workspace) => void) => Promise<unknown>,
    ) => operation(() => undefined));
    const rpcBoundary = { revokeWorkspace: jest.fn() };
    const admit = jest.fn(() => () => undefined);
    const stop = new Error('stop after reservation');
    const open = jest.spyOn(Workspace, 'open').mockRejectedValueOnce(stop);
    const service = new WorkspacesService(
      { dataRoot: '/tmp/workspace-password-policy' } as never,
      state,
      { provisionWorkspace } as never,
      {} as never,
      rpcBoundary as never,
      { now: () => 0, admit } as never,
    );
    const tenant = {
      ...DEFAULT_TENANT,
      id: 'constructor',
      limits: { maxWorkspaces: 2, maxWallets: 2, maxUnlockedWorkspaces: 1 },
      rpc: {},
    } as Tenant;

    await expect(service.create(tenant, 'constructor', 'Workspace-Passw0rd!x')).rejects.toBe(stop);

    expect(open).toHaveBeenCalledTimes(1);
    expect(admit).toHaveBeenCalledWith('constructor', undefined);
    expect(Object.hasOwn(data.tenants, 'constructor')).toBe(true);
    expect(service.list(tenant)).toEqual([]);
    expect(service.quota(tenant)).toEqual({
      workspaces: { used: 0, limit: 2 },
      wallets: { used: 0, limit: 2 },
    });
  });
});
