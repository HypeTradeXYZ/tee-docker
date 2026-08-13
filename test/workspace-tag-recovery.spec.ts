import type { Paths } from '../src/config/paths';
import type { ServiceState, Tenant } from '../src/config/schemas';
import type { ServiceStateService } from '../src/config/service-state.service';
import type { RpcBoundaryService } from '../src/session/rpc-boundary.service';
import type { SessionRegistry } from '../src/session/session.registry';
import type { WorkspaceStorageService } from '../src/workspaces/workspace-storage.service';
import { WorkspaceCreationLimiter } from '../src/workspaces/workspace-creation-limiter';
import { WorkspacesService } from '../src/workspaces/workspaces.service';

it('removes a deleted workspace tag-recovery record with its ledger row', async () => {
  const data: ServiceState = {
    tenants: {
      acme: {
        walletTotal: 2,
        workspaces: [
          { slug: 'desk-a', createdAt: new Date(0).toISOString(), walletCount: 1 },
          { slug: 'desk-b', createdAt: new Date(0).toISOString(), walletCount: 1 },
        ],
        walletTagRecoveries: {
          'desk-a': { accountSlug: 'account-a', walletId: 0, oldTags: ['old'] },
          'desk-b': { accountSlug: 'account-b', walletId: 0, oldTags: ['keep'] },
        },
      },
    },
  };
  const state = {
    tenant: () => data.tenants.acme,
    mutate: async (fn: (draft: ServiceState) => unknown) => fn(data),
  } as unknown as ServiceStateService;
  const storage = { remove: jest.fn(async () => undefined) } as unknown as WorkspaceStorageService;
  const sessions = {
    deleteWorkspace: jest.fn(async (
      _tenantId: string,
      _workspaceSlug: string,
      _force: boolean,
      _known: () => boolean,
      remove: () => Promise<void>,
    ) => remove()),
  } as unknown as SessionRegistry;
  const limiter = new WorkspaceCreationLimiter(
    { maxPerMinute: 10, recreateCooldownMs: 1_000 },
    () => 1_000,
  );
  const service = new WorkspacesService(
    { dataRoot: '/tmp/workspace-tag-recovery-test' } as Paths,
    state,
    sessions,
    storage,
    {} as RpcBoundaryService,
    limiter,
  );
  const tenant = {
    id: 'acme',
    limits: { maxWorkspaces: 3, maxWallets: 10, maxUnlockedWorkspaces: 2 },
  } as Tenant;

  await service.remove(tenant, 'desk-a', true);

  expect(data.tenants.acme.workspaces.map((entry) => entry.slug)).toEqual(['desk-b']);
  expect(data.tenants.acme.walletTotal).toBe(1);
  expect(data.tenants.acme.walletTagRecoveries).toEqual({
    'desk-b': { accountSlug: 'account-b', walletId: 0, oldTags: ['keep'] },
  });
});
