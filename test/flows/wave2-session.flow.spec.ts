import request from 'supertest';
import { Workspace } from 'wative-core';
import { hashApiSecret } from '../../src/auth/secret';
import { OperatorConfigService } from '../../src/config/operator-config.service';
import { SessionRegistry } from '../../src/session/session.registry';
import {
  authHeaders,
  boot,
  DEFAULT_TENANT,
  TEST_SERVER_KEY,
  type Harness,
} from '../harness/boot';

const WS_PASSWORD = 'Workspace-Passw0rd!x';
const privateKey = (digit: string) => `0x${digit.repeat(64)}`;

interface Claims {
  tid: string;
  ws: string;
  sid: string;
  jti: string;
  scp: string[];
  iat: number;
  exp: number;
}

const claims = (token: string): Claims =>
  JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Claims;

describe('wave-2 singleton session', () => {
  let harness: Harness;
  const http = () => request(harness.app.getHttpServer());
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    harness = await boot({
      tenants: [{ ...DEFAULT_TENANT, limits: { ...DEFAULT_TENANT.limits, maxWorkspaces: 4 } }],
    });
    await http()
      .post('/v1/workspaces')
      .set(authHeaders())
      .send({ slug: 'desk-a', password: WS_PASSWORD })
      .expect(201);
  });

  afterAll(async () => harness?.close());

  it('single-flights mints, preserves concurrent writes, and refcounts leases', async () => {
    const open = jest.spyOn(Workspace, 'open');
    const mint = () =>
      http()
        .post('/v1/auth/token')
        .set(authHeaders())
        .send({ workspace: 'desk-a', password: WS_PASSWORD });

    const minted = await Promise.all([mint(), mint(), mint(), mint()]);
    expect(minted.map((res) => res.status)).toEqual([201, 201, 201, 201]);
    const tokens = minted.map((res) => res.body.token as string);
    const decoded = tokens.map(claims);
    expect(new Set(decoded.map((item) => item.sid)).size).toBe(1);
    expect(new Set(decoded.map((item) => item.jti)).size).toBe(4);
    expect(open).toHaveBeenCalledTimes(1);

    const registry = harness.app.get(SessionRegistry);
    expect(registry.size).toBe(1);
    expect(registry.workspaceCount).toBe(1);
    expect(registry.leaseCount).toBe(4);

    const wrong = await http()
      .post('/v1/auth/token')
      .set(authHeaders())
      .send({ workspace: 'desk-a', password: 'wrong-password' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('bad_password');
    expect(registry.leaseCount).toBe(4);
    await http().get('/v1/workspace').set(bearer(tokens[0]!)).expect(200);

    const created = await http()
      .post('/v1/accounts')
      .set(bearer(tokens[0]!))
      .send({ displayName: 'Singleton Vault', kind: 'PK', secret: privateKey('1') })
      .expect(201);
    const slug = created.body.account.slug as string;

    const results = await Promise.all([
      http()
        .post(`/v1/accounts/${slug}/wallets/import`)
        .set(bearer(tokens[0]!))
        .send({ privateKey: privateKey('2') }),
      http()
        .post(`/v1/accounts/${slug}/wallets/import`)
        .set(bearer(tokens[1]!))
        .send({ privateKey: privateKey('3') }),
      http()
        .put('/v1/workspace/networks/base')
        .set(bearer(tokens[2]!))
        .send({ rpcUrl: 'https://1.1.1.1/wave-2' }),
      http()
        .post('/v1/accounts')
        .set(bearer(tokens[3]!))
        .send({ displayName: 'Concurrent Desk', kind: 'HD' }),
    ]);
    expect(results.map((res) => res.status)).toEqual([201, 201, 200, 201]);
    const concurrentSlug = results[3]!.body.account.slug as string;

    const wallets = await http()
      .get(`/v1/accounts/${slug}/wallets`)
      .set(bearer(tokens[0]!))
      .expect(200);
    expect(wallets.body.wallets).toHaveLength(3);
    const evmAddresses = wallets.body.wallets.map(
      (wallet: { addresses: Array<{ vm: string; publicKey: string }> }) =>
        wallet.addresses.find((address) => address.vm === 'evm')!.publicKey,
    );
    for (const address of evmAddresses) {
      await http()
        .post('/v1/sign/message')
        .set(bearer(tokens[1]!))
        .send({ address, message: 'singleton-proof' })
        .expect(200);
    }

    const quota = await http().get('/v1/quota').set(authHeaders()).expect(200);
    const accounts = await http().get('/v1/accounts').set(bearer(tokens[0]!)).expect(200);
    const actualWallets = accounts.body.accounts.reduce(
      (sum: number, account: { wallets: number }) => sum + account.wallets,
      0,
    );
    expect(quota.body.wallets.used).toBe(actualWallets);

    const disposable = await http()
      .post('/v1/accounts')
      .set(bearer(tokens[0]!))
      .send({ displayName: 'Disposable Desk', kind: 'HD' })
      .expect(201);
    const beforeDrop = (await http().get('/v1/quota').set(authHeaders()).expect(200)).body.wallets.used;
    await http()
      .delete(`/v1/accounts/${disposable.body.account.slug as string}`)
      .set(bearer(tokens[1]!))
      .expect(204);
    const afterDrop = (await http().get('/v1/quota').set(authHeaders()).expect(200)).body.wallets.used;
    expect(afterDrop).toBe(beforeDrop - 1);

    const duplicateLogout = await Promise.all([
      http().delete('/v1/auth/token').set(bearer(tokens[0]!)),
      http().delete('/v1/auth/token').set(bearer(tokens[0]!)),
    ]);
    expect(duplicateLogout.some((res) => res.status === 204)).toBe(true);
    expect(duplicateLogout.every((res) => res.status === 204 || res.status === 401)).toBe(true);
    expect(registry.leaseCount).toBe(3);
    await http().get('/v1/workspace').set(bearer(tokens[0]!)).expect(401);

    for (const token of tokens.slice(1, 3)) {
      await http().delete('/v1/auth/token').set(bearer(token)).expect(204);
    }
    await http().get('/v1/workspace').set(bearer(tokens[3]!)).expect(200);
    expect(registry.size).toBe(1);

    const lastClaims = claims(tokens[3]!);
    const active = registry.get(
      lastClaims.sid,
      lastClaims.jti,
      lastClaims.tid,
      lastClaims.ws,
      lastClaims.scp,
      900,
    )!.session;
    const originalLock = active.handle.lock.bind(active.handle);
    let releaseLock!: () => void;
    let lockStarted!: () => void;
    const lockBarrier = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const enteredLock = new Promise<void>((resolve) => {
      lockStarted = resolve;
    });
    const lock = jest.spyOn(active.handle, 'lock').mockImplementation(async () => {
      lockStarted();
      await lockBarrier;
      return originalLock();
    });

    const closing = http()
      .delete('/v1/auth/token')
      .set(bearer(tokens[3]!))
      .then((res) => res);
    await enteredLock;
    const reopening = mint().then((res) => res);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(open).toHaveBeenCalledTimes(1);
    releaseLock();
    expect((await closing).status).toBe(204);
    const reopened = await reopening;
    expect(reopened.status).toBe(201);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(2);
    expect(registry.size).toBe(1);
    expect(registry.workspaceCount).toBe(1);

    expect(claims(reopened.body.token).sid).not.toBe(decoded[0]!.sid);
    const persisted = await http()
      .get(`/v1/accounts/${slug}/wallets`)
      .set(bearer(reopened.body.token))
      .expect(200);
    expect(persisted.body.wallets).toHaveLength(3);
    const reopenedAddresses = persisted.body.wallets.map(
      (wallet: { addresses: Array<{ vm: string; publicKey: string }> }) =>
        wallet.addresses.find((address) => address.vm === 'evm')!.publicKey,
    );
    expect([...reopenedAddresses].sort()).toEqual([...evmAddresses].sort());
    for (const address of reopenedAddresses) {
      await http()
        .post('/v1/sign/message')
        .set(bearer(reopened.body.token))
        .send({ address, message: 'reopen-proof' })
        .expect(200);
    }
    const persistedAccounts = await http()
      .get('/v1/accounts')
      .set(bearer(reopened.body.token))
      .expect(200);
    expect(persistedAccounts.body.accounts).toEqual(
      expect.arrayContaining([expect.objectContaining({ slug: concurrentSlug })]),
    );
    expect(JSON.stringify(persistedAccounts.body.accounts)).not.toContain(
      disposable.body.account.slug as string,
    );
    const networks = await http()
      .get('/v1/workspace/networks')
      .set(bearer(reopened.body.token))
      .expect(200);
    expect(
      networks.body.networks.find((item: { slug: string }) => item.slug === 'base').rpcSource,
    ).toBe('tenant');
    open.mockRestore();
  });

  it('queues a wrong-password mint behind a correct in-flight singleton open', async () => {
    await http()
      .post('/v1/workspaces')
      .set(authHeaders())
      .send({ slug: 'desk-race', password: WS_PASSWORD })
      .expect(201);

    const originalOpen = Workspace.open.bind(Workspace);
    let entered!: () => void;
    let release!: () => void;
    const openEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let raceOpens = 0;
    const open = jest.spyOn(Workspace, 'open').mockImplementation(async (options) => {
      const path =
        options && typeof options === 'object' && 'path' in options
          ? options.path
          : options && typeof options === 'object' && 'provider' in options
            ? options.provider?.rootDescriptor
            : options;
      if (String(path).endsWith('/desk-race')) {
        raceOpens += 1;
        entered();
        await barrier;
      }
      return originalOpen(options);
    });

    const correct = http()
      .post('/v1/auth/token')
      .set(authHeaders())
      .send({ workspace: 'desk-race', password: WS_PASSWORD })
      .then((res) => res);
    await openEntered;
    const wrong = http()
      .post('/v1/auth/token')
      .set(authHeaders())
      .send({ workspace: 'desk-race', password: 'wrong-password' })
      .then((res) => res);
    release();

    expect((await correct).status).toBe(201);
    const rejected = await wrong;
    expect(rejected.status).toBe(401);
    expect(rejected.body.error.code).toBe('bad_password');
    expect(raceOpens).toBe(1);
    open.mockRestore();
  });

});

describe('wave-2 refresh', () => {
  let harness: Harness;
  const http = () => request(harness.app.getHttpServer());
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    harness = await boot({
      tenants: [
        {
          ...DEFAULT_TENANT,
          ttl: { workspaceIdleSec: 2, workspaceAbsoluteSec: 6, accountAbsoluteSec: 2 },
        },
      ],
      env: { TEE_MINT_RATE_LIMIT: '2' },
    });
    await http()
      .post('/v1/workspaces')
      .set(authHeaders())
      .send({ slug: 'desk-a', password: WS_PASSWORD })
      .expect(201);
  });

  afterAll(async () => harness?.close());

  it('refreshes a stable lease without scope escalation or affecting its sibling', async () => {
    const open = jest.spyOn(Workspace, 'open');
    const mint = (scopes: string[]) =>
      http()
        .post('/v1/auth/token')
        .set(authHeaders())
        .send({ workspace: 'desk-a', password: WS_PASSWORD, scopes });
    const a = await mint(['read']).expect(201);
    const aClaims = claims(a.body.token);
    const registry = harness.app.get(SessionRegistry);
    const originalSession = registry.get(
      aClaims.sid,
      aClaims.jti,
      aClaims.tid,
      aClaims.ws,
      aClaims.scp,
      2,
    )!.session;
    const absoluteExpiresAt = originalSession.absoluteExpiresAt;
    const b = await mint(['write']).expect(201);
    const bClaims = claims(b.body.token);
    expect(aClaims.sid).toBe(bClaims.sid);
    expect(aClaims.jti).not.toBe(bClaims.jti);
    expect(originalSession.absoluteExpiresAt).toBe(absoluteExpiresAt);

    await http()
      .post('/v1/auth/token/refresh')
      .set(bearer(a.body.token))
      .send({ scopes: ['export'] })
      .expect(400);
    await http()
      .post('/v1/auth/token/refresh')
      .set(bearer(a.body.token))
      .set('content-type', 'application/json')
      .send('null')
      .expect(400);

    const refreshed = await Promise.all([
      http().post('/v1/auth/token/refresh').set(bearer(a.body.token)).send({}),
      http().post('/v1/auth/token/refresh').set(bearer(a.body.token)).send({}),
    ]);
    expect(refreshed.map((res) => res.status)).toEqual([200, 200]);
    for (const result of refreshed) {
      expect(claims(result.body.token)).toMatchObject({
        sid: aClaims.sid,
        jti: aClaims.jti,
        scp: ['read'],
      });
      expect(claims(result.body.token).exp).toBeGreaterThanOrEqual(aClaims.exp);
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.headers.pragma).toBe('no-cache');
    }
    expect(registry.leaseCount).toBe(2);
    expect(originalSession.absoluteExpiresAt).toBe(absoluteExpiresAt);
    expect(open).toHaveBeenCalledTimes(1);
    expect(claims(refreshed[0]!.body.token).exp).toBeLessThanOrEqual(
      Math.floor(Date.parse(refreshed[0]!.body.sessionExpiresAt) / 1000),
    );
    await http().get('/v1/workspace').set(bearer(a.body.token)).expect(200);
    const limited = await mint(['read']);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('mint_rate_limited');

    await http().delete('/v1/auth/token').set(bearer(a.body.token)).expect(204);
    await http().get('/v1/workspace').set(bearer(refreshed[0]!.body.token)).expect(401);
    await http().get('/v1/workspace').set(bearer(b.body.token)).expect(403);
    await http()
      .put('/v1/workspace/networks/base')
      .set(bearer(b.body.token))
      .send({ rpcUrl: 'https://1.1.1.1/refresh' })
      .expect(200);
    await http().post('/v1/auth/token/refresh').set(bearer(b.body.token)).send({}).expect(200);
    await http().delete('/v1/auth/token').set(bearer(b.body.token)).expect(204);
    expect(harness.app.get(SessionRegistry).size).toBe(0);
    open.mockRestore();
  });
});

describe('wave-2 tenant capacity', () => {
  let harness: Harness;
  const http = () => request(harness.app.getHttpServer());
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    harness = await boot({
      tenants: [
        {
          ...DEFAULT_TENANT,
          limits: { ...DEFAULT_TENANT.limits, maxUnlockedWorkspaces: 1 },
        },
      ],
      env: { TEE_MAX_TOKEN_LEASES_PER_WORKSPACE: '2' },
    });
    for (const slug of ['desk-a', 'desk-b']) {
      await http()
        .post('/v1/workspaces')
        .set(authHeaders())
        .send({ slug, password: WS_PASSWORD })
        .expect(201);
    }
  });

  afterAll(async () => harness?.close());

  it('counts handles rather than leases and releases capacity after the last lease', async () => {
    const mint = (workspace: string) =>
      http()
        .post('/v1/auth/token')
        .set(authHeaders())
        .send({ workspace, password: WS_PASSWORD });
    const a = await mint('desk-a').expect(201);
    const b = await mint('desk-a').expect(201);
    const leaseDenied = await mint('desk-a');
    expect(leaseDenied.status).toBe(429);
    expect(leaseDenied.body.error).toMatchObject({
      code: 'session_capacity_exceeded',
      details: { scope: 'workspace', limit: 2 },
    });
    const denied = await mint('desk-b');
    expect(denied.status).toBe(429);
    expect(denied.body.error).toMatchObject({
      code: 'session_capacity_exceeded',
      details: { scope: 'tenant', limit: 1 },
    });
    await http().delete('/v1/auth/token').set(bearer(a.body.token)).expect(204);
    await mint('desk-b').expect(429);
    await http().delete('/v1/auth/token').set(bearer(b.body.token)).expect(204);
    await mint('desk-b').expect(201);
  });
});

describe('wave-2 process capacity', () => {
  let harness: Harness;
  const SECOND_SECRET = 'sk_second_super_secret_value_0123456789';
  const SECOND = {
    ...DEFAULT_TENANT,
    id: 'second',
    apiKey: 'ak_second_0123456789abcdef',
    secretHash: hashApiSecret(SECOND_SECRET, Buffer.from(TEST_SERVER_KEY, 'hex')),
  };
  const http = () => request(harness.app.getHttpServer());

  beforeAll(async () => {
    harness = await boot({
      tenants: [DEFAULT_TENANT, SECOND],
      env: { TEE_MAX_UNLOCKED_WORKSPACES: '1' },
    });
    await http()
      .post('/v1/workspaces')
      .set(authHeaders())
      .send({ slug: 'desk-a', password: WS_PASSWORD })
      .expect(201);
    await http()
      .post('/v1/workspaces')
      .set(authHeaders(SECOND.apiKey, SECOND_SECRET))
      .send({ slug: 'desk-a', password: WS_PASSWORD })
      .expect(201);
  });

  afterAll(async () => harness?.close());

  it('enforces process capacity without leaking occupancy', async () => {
    const failed = await http()
      .post('/v1/auth/token')
      .set(authHeaders())
      .send({ workspace: 'desk-a', password: 'wrong-password' });
    expect(failed.status).toBe(401);
    expect(harness.app.get(SessionRegistry).workspaceCount).toBe(0);

    const attempts = await Promise.all([
      http()
        .post('/v1/auth/token')
        .set(authHeaders())
        .send({ workspace: 'desk-a', password: WS_PASSWORD }),
      http()
        .post('/v1/auth/token')
        .set(authHeaders(SECOND.apiKey, SECOND_SECRET))
        .send({ workspace: 'desk-a', password: WS_PASSWORD }),
    ]);
    expect(attempts.map((res) => res.status).sort()).toEqual([201, 429]);
    const denied = attempts.find((res) => res.status === 429)!;
    expect(denied.status).toBe(429);
    expect(denied.body.error).toMatchObject({
      code: 'session_capacity_exceeded',
      details: { scope: 'process', limit: 1 },
    });
    expect(JSON.stringify(denied.body)).not.toContain(DEFAULT_TENANT.id);
  });
});

describe('wave-2 tenant isolation', () => {
  let harness: Harness;
  const SECOND_SECRET = 'sk_second_super_secret_value_0123456789';
  const SECOND = {
    ...DEFAULT_TENANT,
    id: 'second',
    apiKey: 'ak_second_0123456789abcdef',
    secretHash: hashApiSecret(SECOND_SECRET, Buffer.from(TEST_SERVER_KEY, 'hex')),
  };
  const http = () => request(harness.app.getHttpServer());

  beforeAll(async () => {
    harness = await boot({ tenants: [DEFAULT_TENANT, SECOND] });
    for (const headers of [authHeaders(), authHeaders(SECOND.apiKey, SECOND_SECRET)]) {
      await http()
        .post('/v1/workspaces')
        .set(headers)
        .send({ slug: 'shared-slug', password: WS_PASSWORD })
        .expect(201);
    }
  });

  afterAll(async () => harness?.close());

  it('keeps identical workspace slugs in different tenants on different singleton handles', async () => {
    const [first, second] = await Promise.all([
      http()
        .post('/v1/auth/token')
        .set(authHeaders())
        .send({ workspace: 'shared-slug', password: WS_PASSWORD }),
      http()
        .post('/v1/auth/token')
        .set(authHeaders(SECOND.apiKey, SECOND_SECRET))
        .send({ workspace: 'shared-slug', password: WS_PASSWORD }),
    ]);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(claims(first.body.token).sid).not.toBe(claims(second.body.token).sid);
    expect(harness.app.get(SessionRegistry).workspaceCount).toBe(2);
  });
});

describe('wave-2 shutdown drain', () => {
  let harness: Harness;
  const http = () => request(harness.app.getHttpServer());

  beforeAll(async () => {
    harness = await boot();
    await http()
      .post('/v1/workspaces')
      .set(authHeaders())
      .send({ slug: 'desk-shutdown', password: WS_PASSWORD })
      .expect(201);
  });

  afterAll(async () => harness?.close());

  it('waits for an in-flight open and locks it instead of publishing after shutdown starts', async () => {
    const registry = harness.app.get(SessionRegistry);
    const tenant = harness.app.get(OperatorConfigService).byId(DEFAULT_TENANT.id)!;
    const originalOpen = Workspace.open.bind(Workspace);
    let entered!: () => void;
    let release!: () => void;
    const openEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const open = jest.spyOn(Workspace, 'open').mockImplementation(async (options) => {
      entered();
      await barrier;
      return originalOpen(options);
    });

    const creating = registry.create(tenant, 'desk-shutdown', WS_PASSWORD, ['read']);
    await openEntered;
    let shutdownFinished = false;
    const shutdown = registry.onApplicationShutdown().then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);
    release();

    await expect(creating).rejects.toMatchObject({ code: 'TEE_SESSION_EXPIRED' });
    await shutdown;
    expect(registry.size).toBe(0);
    expect(registry.workspaceCount).toBe(0);
    expect(open).toHaveBeenCalledTimes(1);
    open.mockRestore();
  });
});
