import request from 'supertest';
import { authHeaders, boot, DEFAULT_TENANT, type Harness } from '../harness/boot';

const WS_PASSWORD = 'Workspace-Passw0rd!x';

/**
 * wallet-buffer-flow — buffer mode end to end.
 *
 * Proves: allocate hands out a wallet and refills the buffer asynchronously;
 * the internal sys:allocated tag never surfaces; a caller cannot free an
 * allocated wallet through the tags endpoint; and rough mode (BUFFER_SIZE=0)
 * still derives one on demand.
 */

type Http = () => ReturnType<typeof request>;

async function setup(env: Record<string, string>, maxWallets = 100): Promise<{
  harness: Harness;
  http: Http;
  bearer: () => { authorization: string };
  slug: string;
}> {
  const harness = await boot({
    tenants: [{ ...DEFAULT_TENANT, limits: { maxWorkspaces: 2, maxWallets } }],
    env,
  });
  const http = () => request(harness.app.getHttpServer());
  await http().post('/v1/workspaces').set(authHeaders()).send({ slug: 'desk-a', password: WS_PASSWORD }).expect(201);
  const token = (
    await http().post('/v1/auth/token').set(authHeaders())
      .send({ workspace: 'desk-a', password: WS_PASSWORD, scopes: ['read', 'write', 'sign'] }).expect(201)
  ).body.token;
  const bearer = () => ({ authorization: `Bearer ${token}` });
  const created = await http().post('/v1/accounts').set(bearer())
    .send({ displayName: 'Users', kind: 'HD' }).expect(201);
  return { harness, http, bearer, slug: created.body.account.slug };
}

const walletCount = async (
  http: Http,
  bearer: () => { authorization: string },
  slug: string,
): Promise<number> =>
  (await http().get(`/v1/accounts/${slug}/wallets`).set(bearer()).expect(200)).body.wallets.length;

/** Poll until the wallet count reaches `target` (the async replenish landed) or time out. */
async function waitForWallets(
  http: Http,
  bearer: () => { authorization: string },
  slug: string,
  target: number,
): Promise<number> {
  for (let i = 0; i < 40; i += 1) {
    const n = await walletCount(http, bearer, slug);
    if (n >= target) return n;
    await new Promise((r) => setTimeout(r, 50));
  }
  return walletCount(http, bearer, slug);
}

describe('wallet buffer mode (BUFFER_SIZE=4)', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    ctx = await setup({ BUFFER_SIZE: '4' });
  });
  afterAll(async () => {
    await ctx.harness?.close();
  });

  it('hands out a wallet and refills the buffer asynchronously', async () => {
    const { http, bearer, slug } = ctx;
    // Account seeded one wallet (index 0). Allocate it; unallocated drops to 0
    // (< watermark 2), so a batch of 4 is derived in the background.
    const res = await http().post(`/v1/accounts/${slug}/wallets/allocate`).set(bearer()).expect(201);
    expect(res.body.wallet).toMatchObject({ id: expect.any(Number) });
    expect(res.body.wallet.addresses.length).toBeGreaterThan(0);
    // The internal allocation tag never surfaces in a response.
    expect(res.body.wallet.tags).not.toContain('sys:allocated');

    const total = await waitForWallets(http, bearer, slug, 5); // 1 handed out + 4 refilled
    expect(total).toBe(5);
  });

  it('hands out distinct buffered wallets without re-deriving each time', async () => {
    const { http, bearer, slug } = ctx;
    const a = (await http().post(`/v1/accounts/${slug}/wallets/allocate`).set(bearer()).expect(201)).body.wallet.id;
    const b = (await http().post(`/v1/accounts/${slug}/wallets/allocate`).set(bearer()).expect(201)).body.wallet.id;
    expect(b).not.toBe(a);
    // Every wallet a caller can see is free of the internal tag.
    const wallets = (await http().get(`/v1/accounts/${slug}/wallets`).set(bearer()).expect(200)).body.wallets;
    for (const w of wallets) expect(w.tags).not.toContain('sys:allocated');
  });

  it('does not let a caller free an allocated wallet through the tags endpoint', async () => {
    const { http, bearer, slug } = ctx;
    const id = (await http().post(`/v1/accounts/${slug}/wallets/allocate`).set(bearer()).expect(201)).body.wallet.id;
    // Overwrite tags omitting any reserved marker.
    await http().put(`/v1/accounts/${slug}/wallets/${id}/tags`).set(bearer()).send({ tags: ['vip'] }).expect(200);
    const view = (await http().get(`/v1/accounts/${slug}/wallets/${id}/addresses`).set(bearer())).status;
    expect(view).toBe(200);
    // The caller's own tag stuck; the wallet stays allocated (proven below).
    const wallets = (await http().get(`/v1/accounts/${slug}/wallets`).set(bearer()).expect(200)).body.wallets;
    expect(wallets.find((w: { id: number }) => w.id === id).tags).toEqual(['vip']);
    // Several more allocations, and the tampered wallet is never re-handed out.
    const handed = new Set<number>();
    for (let i = 0; i < 3; i += 1) {
      handed.add((await http().post(`/v1/accounts/${slug}/wallets/allocate`).set(bearer()).expect(201)).body.wallet.id);
    }
    expect(handed.has(id)).toBe(false);
  });

  it('seeds a derive-populated account so the buffer never re-issues bound wallets', async () => {
    const { http, bearer } = ctx;
    // A "legacy" account whose wallets were bound out of band via the derive
    // path (no sys:allocated tag) — the migration hazard the seed step fixes.
    const legacy = (
      await http().post('/v1/accounts').set(bearer()).send({ displayName: 'Legacy', kind: 'HD' }).expect(201)
    ).body.account.slug;
    await http().post(`/v1/accounts/${legacy}/wallets`).set(bearer()).send({ count: 3 }).expect(201);
    // Account create seeded wallet 0; derive added 1..3 → ids 0..3, all untagged.

    const seeded = await http()
      .post(`/v1/accounts/${legacy}/wallets/seed-allocated`).set(bearer()).send({ count: 4 }).expect(200);
    expect(seeded.body).toEqual({ allocated: 4, total: 4 });

    // A count beyond the account's wallet total is rejected, not clamped.
    await http().post(`/v1/accounts/${legacy}/wallets/seed-allocated`).set(bearer()).send({ count: 99 }).expect(400);

    // Every subsequent allocation is a fresh wallet (id >= 4), never a bound one.
    const handed = new Set<number>();
    for (let i = 0; i < 3; i += 1) {
      handed.add((await http().post(`/v1/accounts/${legacy}/wallets/allocate`).set(bearer()).expect(201)).body.wallet.id);
    }
    for (const id of handed) expect(id).toBeGreaterThanOrEqual(4);
  });
});

describe('rough mode (BUFFER_SIZE=0)', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    ctx = await setup({ BUFFER_SIZE: '0' });
  });
  afterAll(async () => {
    await ctx.harness?.close();
  });

  it('derives exactly one wallet per allocate, with no async growth', async () => {
    const { http, bearer, slug } = ctx;
    const before = await walletCount(http, bearer, slug);
    const res = await http().post(`/v1/accounts/${slug}/wallets/allocate`).set(bearer()).expect(201);
    expect(res.body.wallet.tags).not.toContain('sys:allocated');
    // Give any (absent) background job a chance; count must rise by exactly one.
    await new Promise((r) => setTimeout(r, 150));
    expect(await walletCount(http, bearer, slug)).toBe(before + 1);
  });
});
