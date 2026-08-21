import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { hashApiSecret } from '../../src/auth/secret';
import {
  RPC_DNS_RESOLVER,
  RPC_HTTPS_REQUESTER,
  type RpcDnsResolver,
  type RpcHttpsRequester,
} from '../../src/session/rpc-boundary.service';
import { ACCOUNT_UNLOCK_CLOCK, type AccountUnlockClock } from '../../src/auth/account-unlock-limiter';
import { installRequestIdMiddleware } from '../../src/common/request-id.middleware';
import { installCors } from '../../src/common/cors';
import {
  WORKSPACE_CREATION_CLOCK,
  type WorkspaceCreationClock,
} from '../../src/workspaces/workspace-creation-limiter';

/** Fixed so every flow's secretHash is reproducible. */
export const TEST_SERVER_KEY = 'a'.repeat(64);

export const TEST_API_KEY = 'ak_test_0123456789abcdef';
export const TEST_API_SECRET = 'sk_test_super_secret_value_0123456789';

/** A valid single-tenant operator config. Flows override what they care about. */
export const DEFAULT_TENANT = {
  id: 'acme',
  apiKey: TEST_API_KEY,
  secretHash: hashApiSecret(TEST_API_SECRET, Buffer.from(TEST_SERVER_KEY, 'hex')),
  limits: { maxWorkspaces: 2, maxWallets: 10 },
} as const;

/** Headers that authenticate as DEFAULT_TENANT on the tenant tier. */
export const authHeaders = (
  key: string = TEST_API_KEY,
  secret: string = TEST_API_SECRET,
): Record<string, string> => ({ 'x-api-key': key, 'x-api-secret': secret });

export interface Harness {
  readonly app: INestApplication;
  /** Isolated root for this flow's config, state, and workspace data. */
  readonly baseDir: string;
  close(): Promise<void>;
}

export interface BootOptions {
  /** Replaces the default tenant list. */
  readonly tenants?: readonly unknown[];
  /** Extra environment applied before the module is built. */
  readonly env?: Readonly<Record<string, string>>;
  /** Deterministic H-01 resolver/request transport overrides. */
  readonly rpcDnsResolver?: RpcDnsResolver;
  readonly rpcHttpsRequester?: RpcHttpsRequester;
  /** Deterministic H-02 backoff clock override. */
  readonly accountUnlockClock?: AccountUnlockClock;
  /** Deterministic M-10 creation-window and recreation-cooldown clock. */
  readonly workspaceCreationClock?: WorkspaceCreationClock;
}

/**
 * Boot a real Nest app against a throwaway data root.
 *
 * Every flow gets its own temp directory, so a flow that creates workspaces
 * can never see or corrupt another flow's state. Jest runs these serially
 * (`maxWorkers: 1`) because they also share `process.env`.
 */
export async function boot(options: BootOptions = {}): Promise<Harness> {
  const baseDir = mkdtempSync(join(tmpdir(), 'tee-docker-flow-'));
  const configDir = join(baseDir, 'config');
  mkdirSync(configDir, { recursive: true });

  const tenants = options.tenants ?? [DEFAULT_TENANT];
  writeFileSync(join(configDir, 'tenants.json'), JSON.stringify({ tenants }, null, 2));

  // Use the real shipped error map rather than a fixture — a flow that gets a
  // status wrong should fail here, not in production.
  copyFileSync(resolve(__dirname, '../../config/errors.json'), join(configDir, 'errors.json'));

  // Snapshot and restore ONLY the keys we touch. Replacing process.env
  // wholesale means a suite that aborts mid-setup can leave the global env
  // pointing at a deleted temp directory, which surfaces later as an
  // unrelated flow failing for no visible reason.
  const overrides: Record<string, string | undefined> = {
    TEE_CONFIG_DIR: configDir,
    TEE_STATE_DIR: join(baseDir, 'state'),
    WATIVE_DATA_ROOT: join(baseDir, 'data'),
    TEE_SECRET_HMAC_KEY: TEST_SERVER_KEY,
    TEE_SKIP_KDF_CHECK: undefined,
    // Flows mint freely; the limit itself is exercised by its own flow with a
    // deliberately low value.
    TEE_MINT_RATE_LIMIT: '1000',
    TEE_MAX_UNLOCKED_WORKSPACES: '32',
    TEE_MAX_TOKEN_LEASES_PER_WORKSPACE: '64',
    ...(options.env ?? {}),
  };

  const previous = new Map<string, string | undefined>(
    Object.keys(overrides).map((k) => [k, process.env[k]]),
  );

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const restoreEnv = (): void => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  let app: INestApplication;
  try {
    let builder = Test.createTestingModule({ imports: [AppModule] });
    if (options.rpcDnsResolver) {
      builder = builder.overrideProvider(RPC_DNS_RESOLVER).useValue(options.rpcDnsResolver);
    }
    if (options.rpcHttpsRequester) {
      builder = builder.overrideProvider(RPC_HTTPS_REQUESTER).useValue(options.rpcHttpsRequester);
    }
    if (options.accountUnlockClock) {
      builder = builder.overrideProvider(ACCOUNT_UNLOCK_CLOCK).useValue(options.accountUnlockClock);
    }
    if (options.workspaceCreationClock) {
      builder = builder
        .overrideProvider(WORKSPACE_CREATION_CLOCK)
        .useValue(options.workspaceCreationClock);
    }
    const moduleRef = await builder.compile();
    app = moduleRef.createNestApplication();
    installRequestIdMiddleware(app);
    installCors(
      app,
      tenants.flatMap((tenant) => (tenant as { origins?: string[] }).origins ?? []),
    );
    app.setGlobalPrefix('v1');
    await app.init();
  } catch (err) {
    restoreEnv();
    rmSync(baseDir, { recursive: true, force: true });
    throw err;
  }

  return {
    app,
    baseDir,
    async close(): Promise<void> {
      await app.close();
      restoreEnv();
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}
