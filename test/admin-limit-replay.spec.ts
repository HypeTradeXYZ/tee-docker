import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LimitOverrideReplay } from '../src/admin/limit-override-replay';
import { OperatorConfigService } from '../src/config/operator-config.service';
import { ServiceStateService } from '../src/config/service-state.service';
import { hashApiSecret } from '../src/auth/secret';
import type { Paths } from '../src/config/paths';
import type { Tenant } from '../src/config/schemas';

/**
 * Proves the boot-time replay: a raise persisted in state.json is re-applied
 * onto the in-memory operator config, so a restart does not drop the ceiling.
 */
const SERVER_KEY = Buffer.from('a'.repeat(64), 'hex');

function tenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: 'acme',
    apiKey: 'ak_test',
    secretHash: hashApiSecret('secret', SERVER_KEY),
    limits: { maxWorkspaces: 2, maxWallets: 10, maxUnlockedWorkspaces: 8 },
    ttl: { workspaceIdleSec: 900, workspaceAbsoluteSec: 28_800, accountAbsoluteSec: 300 },
    rpc: {},
    allowDefaultRpc: true,
    exportEnabled: false,
    origins: [],
    ...overrides,
  };
}

describe('LimitOverrideReplay', () => {
  let dir: string;
  let state: ServiceStateService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tee-replay-'));
    const paths = { stateFile: join(dir, 'state.json') } as Paths;
    state = ServiceStateService.fromFile(paths);
  });

  afterEach(async () => {
    await state.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function seedOverride(id: string, limitOverrides: Record<string, number>): Promise<void> {
    await state.mutate((draft) => {
      draft.tenants[id] = { walletTotal: 0, workspaces: [], limitOverrides };
    });
  }

  it('raises the in-memory config to a persisted override', async () => {
    await seedOverride('acme', { maxWallets: 500 });
    const config = new OperatorConfigService([tenant()]);

    new LimitOverrideReplay(config, state).apply();

    expect(config.byId('acme')!.limits.maxWallets).toBe(500);
    // Untouched fields keep their configured values.
    expect(config.byId('acme')!.limits.maxWorkspaces).toBe(2);
    expect(config.byId('acme')!.limits.maxUnlockedWorkspaces).toBe(8);
  });

  it('never lowers a configured limit that already exceeds the override', async () => {
    await seedOverride('acme', { maxWallets: 5 });
    const config = new OperatorConfigService([tenant()]); // configured maxWallets 10

    new LimitOverrideReplay(config, state).apply();

    expect(config.byId('acme')!.limits.maxWallets).toBe(10);
  });

  it('ignores an override for a tenant no longer in the config', async () => {
    await seedOverride('ghost', { maxWallets: 500 });
    const config = new OperatorConfigService([tenant()]);

    expect(() => new LimitOverrideReplay(config, state).apply()).not.toThrow();
    expect(config.byId('acme')!.limits.maxWallets).toBe(10);
  });

  it('is a no-op when no tenant has an override', async () => {
    const config = new OperatorConfigService([tenant()]);
    new LimitOverrideReplay(config, state).apply();
    expect(config.byId('acme')!.limits).toMatchObject({ maxWorkspaces: 2, maxWallets: 10 });
  });
});
