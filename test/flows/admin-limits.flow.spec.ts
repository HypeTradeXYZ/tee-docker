import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { authHeaders, boot, DEFAULT_TENANT, type Harness } from '../harness/boot';

/**
 * admin-limits — the super-admin tier raising a tenant's ceiling end to end.
 *
 * The proof that a lift actually took effect is GET /quota reporting the new
 * limit on the running process, not the tenants.json bytes: a write that never
 * reached the in-memory tenant table would leave the tenant hitting the old
 * wall until the next restart.
 */

const ADMIN_KEY = 'p'.repeat(48);
const PASSWORD = 'Workspace-Passw0rd!x';

const adminHeaders = (key: string = ADMIN_KEY): Record<string, string> => ({
  'x-admin-key': key,
});

async function listening(
  env: Record<string, string> = { PANADOL_KEY: ADMIN_KEY },
): Promise<{ harness: Harness; http: ReturnType<typeof request> }> {
  const harness = await boot({ env });
  await harness.app.listen(0, '127.0.0.1');
  return { harness, http: request(harness.app.getHttpServer()) };
}

const tenantsOnDisk = (harness: Harness) =>
  JSON.parse(readFileSync(join(harness.baseDir, 'config', 'tenants.json'), 'utf8'));

describe('admin limits flow', () => {
  let harness: Harness;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    ({ harness, http } = await listening());
  });

  afterEach(async () => {
    await harness?.close();
  });

  it('raises a limit and the running service serves the new ceiling', async () => {
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

    // The running process, not just the file.
    const after = await http.get('/v1/quota').set(authHeaders()).expect(200);
    expect(after.body.wallets.limit).toBe(500);
    expect(tenantsOnDisk(harness).tenants[0].limits.maxWallets).toBe(500);
  });

  it('raises both ceilings at once', async () => {
    const res = await http
      .post(`/v1/admin/tenants/${DEFAULT_TENANT.id}/limits`)
      .set(adminHeaders())
      .send({ maxWorkspaces: 7, maxWallets: 99 })
      .expect(201);
    expect(res.body.changed.sort()).toEqual(['maxWallets', 'maxWorkspaces']);

    const quota = await http.get('/v1/quota').set(authHeaders()).expect(200);
    expect(quota.body).toMatchObject({
      workspaces: { limit: 7 },
      wallets: { limit: 99 },
    });
  });

  it('lets the tenant actually use the headroom it was just granted', async () => {
    // DEFAULT_TENANT allows 2 workspaces; fill it, then lift and create a third.
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

  it('refuses a decrease, leaving the file and the process untouched', async () => {
    const res = await http
      .post(`/v1/admin/tenants/${DEFAULT_TENANT.id}/limits`)
      .set(adminHeaders())
      .send({ maxWallets: 1 })
      .expect(409);
    expect(res.body.error.code).toBe('limit_not_raised');

    expect(tenantsOnDisk(harness).tenants[0].limits.maxWallets)
      .toBe(DEFAULT_TENANT.limits.maxWallets);
    const quota = await http.get('/v1/quota').set(authHeaders()).expect(200);
    expect(quota.body.wallets.limit).toBe(DEFAULT_TENANT.limits.maxWallets);
  });

  it('treats an unchanged value as an idempotent no-op', async () => {
    const res = await http
      .post(`/v1/admin/tenants/${DEFAULT_TENANT.id}/limits`)
      .set(adminHeaders())
      .send({ maxWallets: DEFAULT_TENANT.limits.maxWallets })
      .expect(201);
    expect(res.body.changed).toEqual([]);
  });

  it('rejects a partial raise atomically when a sibling field is a decrease', async () => {
    await http
      .post(`/v1/admin/tenants/${DEFAULT_TENANT.id}/limits`)
      .set(adminHeaders())
      .send({ maxWorkspaces: 9, maxWallets: 1 })
      .expect(409);

    // The accepted half must not have been written on its own.
    expect(tenantsOnDisk(harness).tenants[0].limits.maxWorkspaces)
      .toBe(DEFAULT_TENANT.limits.maxWorkspaces);
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
    expect(tenantsOnDisk(harness).tenants).toHaveLength(1);
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
    // Raise-only makes the outcome order-independent: whatever order the four
    // land in, the highest wins and no write is lost.
    expect(tenantsOnDisk(harness).tenants[0].limits.maxWallets).toBe(40);
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
