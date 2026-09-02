import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { authHeaders, boot, DEFAULT_TENANT, type Harness } from '../harness/boot';

/**
 * admin-limits — the super-admin tier raising a tenant's ceiling end to end.
 *
 * The raise is persisted in the writable state volume (state.json), never in
 * the read-only tenants.json, so the proofs are: GET /quota reports the new
 * limit on the running process, and state.json carries the override for a
 * restart to replay.
 */

const ADMIN_KEY = 'p'.repeat(48);
const PASSWORD = 'Workspace-Passw0rd!x';

const adminHeaders = (key: string = ADMIN_KEY): Record<string, string> => ({ 'x-admin-key': key });

async function listening(
  env: Record<string, string> = { PANADOL_KEY: ADMIN_KEY },
): Promise<{ harness: Harness; http: ReturnType<typeof request> }> {
  const harness = await boot({ env });
  await harness.app.listen(0, '127.0.0.1');
  return { harness, http: request(harness.app.getHttpServer()) };
}

const stateOnDisk = (harness: Harness) =>
  JSON.parse(readFileSync(join(harness.baseDir, 'state', 'state.json'), 'utf8'));
const overrideFor = (harness: Harness, id: string) =>
  stateOnDisk(harness).tenants?.[id]?.limitOverrides;

describe('admin limits flow', () => {
  let harness: Harness;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    ({ harness, http } = await listening());
  });

  afterEach(async () => {
    await harness?.close();
  });

  it('raises a limit; the running service and state.json both reflect it', async () => {
    const before = await http.get('/v1/quota').set(authHeaders()).expect(200);
    expect(before.body.wallets.limit).toBe(DEFAULT_TENANT.limits.maxWallets);

    const lifted = await http
      .post(`/v1/admin/tenants/${DEFAULT_TENANT.id}/limits`)
      .set(adminHeaders())
      .send({ maxWallets: 500 })
      .expect(201);

    expect(lifted.body).toEqual({
      tenant: DEFAULT_TENANT.id,
      limits: { maxWorkspaces: DEFAULT_TENANT.limits.maxWorkspaces, maxWallets: 500 },
      changed: ['maxWallets'],
    });

    const after = await http.get('/v1/quota').set(authHeaders()).expect(200);
    expect(after.body.wallets.limit).toBe(500);
    // Persisted for a restart to replay — and NOT in tenants.json.
    expect(overrideFor(harness, DEFAULT_TENANT.id)).toEqual({ maxWallets: 500 });
  });

  it('raises both ceilings at once', async () => {
    const res = await http
      .post(`/v1/admin/tenants/${DEFAULT_TENANT.id}/limits`)
      .set(adminHeaders())
      .send({ maxWorkspaces: 7, maxWallets: 99 })
      .expect(201);
    expect(res.body.changed.sort()).toEqual(['maxWallets', 'maxWorkspaces']);
    expect(overrideFor(harness, DEFAULT_TENANT.id)).toEqual({ maxWorkspaces: 7, maxWallets: 99 });

    const quota = await http.get('/v1/quota').set(authHeaders()).expect(200);
    expect(quota.body).toMatchObject({ workspaces: { limit: 7 }, wallets: { limit: 99 } });
  });

  it('lets the tenant actually use the headroom it was just granted', async () => {
    for (const slug of ['desk-a', 'desk-b']) {
      await http
        .post('/v1/workspaces')
        .set(authHeaders())
        .send({ slug, password: PASSWORD })
        .expect(201);
    }
    const refused = await http
      .post('/v1/workspaces')
      .set(authHeaders())
      .send({ slug: 'desk-c', password: PASSWORD })
      .expect(409);
    expect(refused.body.error.code).toBe('quota_workspaces_exceeded');

    await http
      .post(`/v1/admin/tenants/${DEFAULT_TENANT.id}/limits`)
      .set(adminHeaders())
      .send({ maxWorkspaces: 3 })
      .expect(201);

    await http
      .post('/v1/workspaces')
      .set(authHeaders())
      .send({ slug: 'desk-c', password: PASSWORD })
      .expect(201);
  });

  it('refuses a decrease, writing no override and leaving the process unchanged', async () => {
    const res = await http
      .post(`/v1/admin/tenants/${DEFAULT_TENANT.id}/limits`)
      .set(adminHeaders())
      .send({ maxWallets: 1 })
      .expect(409);
    expect(res.body.error.code).toBe('limit_not_raised');

    expect(overrideFor(harness, DEFAULT_TENANT.id)).toBeUndefined();
    const quota = await http.get('/v1/quota').set(authHeaders()).expect(200);
    expect(quota.body.wallets.limit).toBe(DEFAULT_TENANT.limits.maxWallets);
  });

  it('treats an unchanged value as an idempotent no-op that writes nothing', async () => {
    const res = await http
      .post(`/v1/admin/tenants/${DEFAULT_TENANT.id}/limits`)
      .set(adminHeaders())
      .send({ maxWallets: DEFAULT_TENANT.limits.maxWallets })
      .expect(201);
    expect(res.body.changed).toEqual([]);
    expect(overrideFor(harness, DEFAULT_TENANT.id)).toBeUndefined();
  });

  it('rejects a partial raise atomically when a sibling field is a decrease', async () => {
    await http
      .post(`/v1/admin/tenants/${DEFAULT_TENANT.id}/limits`)
      .set(adminHeaders())
      .send({ maxWorkspaces: 9, maxWallets: 1 })
      .expect(409);
    // The accepted half must not have been persisted on its own.
    expect(overrideFor(harness, DEFAULT_TENANT.id)).toBeUndefined();
    const quota = await http.get('/v1/quota').set(authHeaders()).expect(200);
    expect(quota.body.workspaces.limit).toBe(DEFAULT_TENANT.limits.maxWorkspaces);
  });

  it.each([
    ['a wrong key', { 'x-admin-key': 'q'.repeat(48) }],
    ['no key at all', {}],
  ])('refuses %s', async (_label, headers) => {
    const res = await http
      .post(`/v1/admin/tenants/${DEFAULT_TENANT.id}/limits`)
      .set(headers as Record<string, string>)
      .send({ maxWallets: 500 })
      .expect(401);
    expect(res.body.error.code).toBe('admin_denied');
  });

  it('rate-limits repeated failures, then reports a retry hint', async () => {
    for (let i = 0; i < 5; i += 1) {
      await http
        .post(`/v1/admin/tenants/${DEFAULT_TENANT.id}/limits`)
        .set(adminHeaders('wrong-key-that-is-long-enough'))
        .send({ maxWallets: 500 })
        .expect(401);
    }
    const limited = await http
      .post(`/v1/admin/tenants/${DEFAULT_TENANT.id}/limits`)
      .set(adminHeaders('wrong-key-that-is-long-enough'))
      .send({ maxWallets: 500 })
      .expect(429);
    expect(limited.body.error.code).toBe('admin_rate_limited');
    expect(limited.body.error.details.retryAfterSec).toBeGreaterThan(0);

    // A correct key is refused too while the budget is spent: the limiter
    // guards the tier, not one guess.
    await http
      .post(`/v1/admin/tenants/${DEFAULT_TENANT.id}/limits`)
      .set(adminHeaders())
      .send({ maxWallets: 500 })
      .expect(429);
  });

  it('reports an unknown tenant rather than creating one', async () => {
    const res = await http
      .post('/v1/admin/tenants/ghost/limits')
      .set(adminHeaders())
      .send({ maxWallets: 500 })
      .expect(404);
    expect(res.body.error.code).toBe('tenant_not_found');
    expect(overrideFor(harness, 'ghost')).toBeUndefined();
  });

  it.each([
    ['an empty body', {}],
    ['an unknown field', { maxAccounts: 5 }],
    ['a negative limit', { maxWallets: -1 }],
    ['a fractional limit', { maxWallets: 1.5 }],
    ['maxUnlockedWorkspaces, which this tier may not set', { maxUnlockedWorkspaces: 99 }],
  ])('refuses %s', async (_label, body) => {
    const res = await http
      .post(`/v1/admin/tenants/${DEFAULT_TENANT.id}/limits`)
      .set(adminHeaders())
      .send(body)
      .expect(400);
    expect(res.body.error.code).toBe('invalid_body');
  });

  it('serializes concurrent lifts so none is silently discarded', async () => {
    await Promise.all(
      [10, 20, 30, 40].map((maxWallets) =>
        http
          .post(`/v1/admin/tenants/${DEFAULT_TENANT.id}/limits`)
          .set(adminHeaders())
          .send({ maxWallets })
          .expect(201),
      ),
    );
    // Raise-only makes the outcome order-independent: the highest wins, none lost.
    expect(overrideFor(harness, DEFAULT_TENANT.id)).toEqual({ maxWallets: 40 });
    const quota = await http.get('/v1/quota').set(authHeaders()).expect(200);
    expect(quota.body.wallets.limit).toBe(40);
  });
});

describe('admin limits flow with no key configured', () => {
  let harness: Harness;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    ({ harness, http } = await listening({ PANADOL_KEY: '' }));
  });

  afterAll(async () => harness?.close());

  it('refuses every request, including an empty key, when the tier is off', async () => {
    for (const headers of [{}, { 'x-admin-key': '' }, adminHeaders()]) {
      const res = await http
        .post(`/v1/admin/tenants/${DEFAULT_TENANT.id}/limits`)
        .set(headers as Record<string, string>)
        .send({ maxWallets: 500 })
        .expect(401);
      expect(res.body.error.code).toBe('admin_denied');
    }
  });
});
