import request from 'supertest';
import {
  authHeaders,
  boot,
  DEFAULT_TENANT,
  type Harness,
} from '../harness/boot';

const PASSWORD = 'Workspace-Passw0rd!x';
const privateKey = (digit: string) => `0x${digit.repeat(64)}`;

async function listeningHarness(maxWallets: number): Promise<{
  harness: Harness;
  http: ReturnType<typeof request>;
}> {
  const harness = await boot({
    tenants: [
      {
        ...DEFAULT_TENANT,
        limits: { ...DEFAULT_TENANT.limits, maxWallets },
      },
    ],
  });
  await harness.app.listen(0, '127.0.0.1');
  return { harness, http: request(harness.app.getHttpServer()) };
}

async function createWorkspace(http: ReturnType<typeof request>, slug: string): Promise<void> {
  await http
    .post('/v1/workspaces')
    .set(authHeaders())
    .send({ slug, password: PASSWORD })
    .expect(201);
}

async function mint(http: ReturnType<typeof request>, workspace: string): Promise<string> {
  const result = await http
    .post('/v1/auth/token')
    .set(authHeaders())
    .send({ workspace, password: PASSWORD })
    .expect(201);
  return result.body.token as string;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('wave-3 account quota', () => {
  let zero: Harness;

  afterAll(async () => zero?.close());

  it('rejects generated HD and valid PK accounts before core when maxWallets is zero', async () => {
    const started = await listeningHarness(0);
    zero = started.harness;
    await createWorkspace(started.http, 'desk-zero');
    const token = await mint(started.http, 'desk-zero');

    for (const body of [
      { displayName: 'Generated', kind: 'HD' },
      { displayName: 'Imported', kind: 'PK', secret: privateKey('1') },
    ]) {
      const denied = await started.http
        .post('/v1/accounts')
        .set(bearer(token))
        .send(body);
      expect(denied.status).toBe(409);
      expect(denied.body.error.code).toBe('quota_wallets_exceeded');
    }
    const quota = await started.http.get('/v1/quota').set(authHeaders()).expect(200);
    expect(quota.body.wallets).toEqual({ used: 0, limit: 0 });
    const accounts = await started.http.get('/v1/accounts').set(bearer(token)).expect(200);
    expect(accounts.body.accounts).toEqual([]);
  });
});

describe('wave-3 cross-workspace account admission', () => {
  let harness: Harness;

  afterAll(async () => harness?.close());

  it('admits exactly one account creation for the tenant final wallet slot', async () => {
    const started = await listeningHarness(1);
    harness = started.harness;
    await Promise.all([
      createWorkspace(started.http, 'desk-a'),
      createWorkspace(started.http, 'desk-b'),
    ]);
    const [a, b] = await Promise.all([mint(started.http, 'desk-a'), mint(started.http, 'desk-b')]);

    const results = await Promise.all([
      started.http
        .post('/v1/accounts')
        .set(bearer(a))
        .send({ displayName: 'Alpha', kind: 'HD' }),
      started.http
        .post('/v1/accounts')
        .set(bearer(b))
        .send({ displayName: 'Beta', kind: 'PK', secret: privateKey('2') }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(results.find((result) => result.status === 409)!.body.error.code).toBe(
      'quota_wallets_exceeded',
    );
    const quota = await started.http.get('/v1/quota').set(authHeaders()).expect(200);
    expect(quota.body.wallets).toEqual({ used: 1, limit: 1 });

    const listings = await Promise.all(
      [a, b].map((token) => started.http.get('/v1/accounts').set(bearer(token)).expect(200)),
    );
    expect(
      listings.reduce(
        (sum, result) =>
          sum +
          result.body.accounts.reduce(
            (wallets: number, account: { wallets: number }) => wallets + account.wallets,
            0,
          ),
        0,
      ),
    ).toBe(1);
  });
});

describe('wave-3 cross-workspace derive admission', () => {
  let harness: Harness;

  afterAll(async () => harness?.close());

  it('admits exactly one concurrent derive across workspace mutexes', async () => {
    const started = await listeningHarness(3);
    harness = started.harness;
    await Promise.all([
      createWorkspace(started.http, 'desk-a'),
      createWorkspace(started.http, 'desk-b'),
    ]);
    const [a, b] = await Promise.all([mint(started.http, 'desk-a'), mint(started.http, 'desk-b')]);
    const created = await Promise.all([
      started.http
        .post('/v1/accounts')
        .set(bearer(a))
        .send({ displayName: 'Alpha', kind: 'HD' })
        .expect(201),
      started.http
        .post('/v1/accounts')
        .set(bearer(b))
        .send({ displayName: 'Beta', kind: 'HD' })
        .expect(201),
    ]);

    const results = await Promise.all([
      started.http
        .post(`/v1/accounts/${created[0].body.account.slug as string}/wallets`)
        .set(bearer(a))
        .send({ count: 1 }),
      started.http
        .post(`/v1/accounts/${created[1].body.account.slug as string}/wallets`)
        .set(bearer(b))
        .send({ count: 1 }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(results.find((result) => result.status === 409)!.body.error.code).toBe(
      'quota_wallets_exceeded',
    );
    const quota = await started.http.get('/v1/quota').set(authHeaders()).expect(200);
    expect(quota.body.wallets).toEqual({ used: 3, limit: 3 });
  });
});

describe('wave-3 cross-workspace import admission', () => {
  let harness: Harness;

  afterAll(async () => harness?.close());

  it('rolls back invalid input and admits exactly one concurrent import at the final slot', async () => {
    const started = await listeningHarness(3);
    harness = started.harness;
    await Promise.all([
      createWorkspace(started.http, 'desk-a'),
      createWorkspace(started.http, 'desk-b'),
    ]);
    let [a, b] = await Promise.all([mint(started.http, 'desk-a'), mint(started.http, 'desk-b')]);
    const created = await Promise.all([
      started.http
        .post('/v1/accounts')
        .set(bearer(a))
        .send({ displayName: 'Alpha', kind: 'PK', secret: privateKey('1') })
        .expect(201),
      started.http
        .post('/v1/accounts')
        .set(bearer(b))
        .send({ displayName: 'Beta', kind: 'PK', secret: privateKey('2') })
        .expect(201),
    ]);

    const invalid = await started.http
      .post(`/v1/accounts/${created[0].body.account.slug as string}/wallets/import`)
      .set(bearer(a))
      .send({ privateKey: 'not-a-private-key' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('invalid_private_key');
    // Once core starts, even a validation-coded error is write-order
    // ambiguous. The reservation stays fail-closed until a genuine reopen.
    a = await mint(started.http, 'desk-a');
    let quota = await started.http.get('/v1/quota').set(authHeaders()).expect(200);
    expect(quota.body.wallets).toEqual({ used: 2, limit: 3 });

    const results = await Promise.all([
      started.http
        .post(`/v1/accounts/${created[0].body.account.slug as string}/wallets/import`)
        .set(bearer(a))
        .send({ privateKey: privateKey('3') }),
      started.http
        .post(`/v1/accounts/${created[1].body.account.slug as string}/wallets/import`)
        .set(bearer(b))
        .send({ privateKey: privateKey('4') }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(results.find((result) => result.status === 409)!.body.error.code).toBe(
      'quota_wallets_exceeded',
    );
    quota = await started.http.get('/v1/quota').set(authHeaders()).expect(200);
    expect(quota.body.wallets).toEqual({ used: 3, limit: 3 });

    const walletCounts = await Promise.all(
      [
        { token: a, slug: created[0].body.account.slug as string },
        { token: b, slug: created[1].body.account.slug as string },
      ].map(({ token, slug }) =>
        started.http.get(`/v1/accounts/${slug}/wallets`).set(bearer(token)).expect(200),
      ),
    );
    expect(walletCounts.reduce((sum, result) => sum + result.body.wallets.length, 0)).toBe(3);
  });
});
