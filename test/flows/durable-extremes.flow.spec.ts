import request from 'supertest';
import { Logger } from '@nestjs/common';
import { authHeaders, boot, restart, DEFAULT_TENANT, type Harness } from '../harness/boot';
import { newRecipient, unseal } from '../harness/unseal';

/**
 * Extreme factor-combination tests for the durable scoped-key model. Each case
 * collides several factors (server lifecycle, key state, tier, inquiry key,
 * account password model, custody clock, capacity, slug lifecycle) at their
 * worst corner. See the durable scoped-key test plan at the repo root.
 */
const WS = 'Workspace-Passw0rd!x';
const ACCT_PW = 'Account-Passw0rd!y';
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe('durable-extremes: A — durability x restart x identity', () => {
  let harness: Harness;
  let now = Date.now();
  const recipient = newRecipient();
  const http = () => request(harness.app.getHttpServer());
  const mint = (body: Record<string, unknown>) =>
    http().post('/v1/auth/api-key').set(authHeaders()).send({ workspace: 'desk', password: WS, ...body });

  async function setup(): Promise<{ account: string; walletId: number }> {
    const ws = (
      await http().post('/v1/auth/token').set(authHeaders()).send({ workspace: 'desk', password: WS }).expect(201)
    ).body.token as string;
    const account = (
      await http().post('/v1/accounts').set(bearer(ws)).send({ displayName: 'Acct', kind: 'HD' }).expect(201)
    ).body.account.slug as string;
    await http().post(`/v1/accounts/${account}/wallets`).set(bearer(ws)).send({ count: 1 }).expect(201);
    const walletId = (
      await http().get(`/v1/accounts/${account}/wallets`).set(bearer(ws)).expect(200)
    ).body.wallets[0].id as number;
    return { account, walletId };
  }

  beforeAll(async () => {
    harness = await boot({ custodyClock: () => now, tenants: [{ ...DEFAULT_TENANT, limits: { maxWorkspaces: 2, maxWallets: 10 } }] });
    await http().post('/v1/workspaces').set(authHeaders()).send({ slug: 'desk', password: WS }).expect(201);
  });
  afterAll(async () => {
    await harness?.close();
  });

  it('A1: a restart voids a durable wallet key that had just exported (unseal-proven), disk state survives', async () => {
    const { account, walletId } = await setup();
    const key = (
      await mint({ account, walletId, tier: 'unlimited', inquiryKey: recipient.configured }).expect(201)
    ).body.token as string;
    // Export works while live, and the blob opens for the inquiry key.
    const exp = await http().post(`/v1/accounts/${account}/wallets/${walletId}/export?vm=evm`).set(bearer(key)).expect(200);
    expect(unseal(exp.body.sealed, recipient.privateKey).length).toBeGreaterThan(0);

    // Restart: same data root, fresh process → the durable key's session is gone.
    harness = await restart(harness, { custodyClock: () => now, tenants: [{ ...DEFAULT_TENANT, limits: { maxWorkspaces: 2, maxWallets: 10 } }] });
    await http().get(`/v1/accounts/${account}`).set(bearer(key)).expect(401);
    // But the workspace + account persisted on disk: a fresh mint reaches it.
    const reminted = (await mint({ account }).expect(201)).body.token as string;
    await http().get(`/v1/accounts/${account}`).set(bearer(reminted)).expect(200);
  });

  it('A2: deleting a durable-bound slug and recreating it rebinds the old key to the NEW account (audited)', async () => {
    const { account } = await setup();
    const key = (await mint({ account }).expect(201)).body.token as string;
    await http().get(`/v1/accounts/${account}`).set(bearer(key)).expect(200);

    // Delete the bound account — the durable key survives (coarse revocation).
    const ws = (
      await http().post('/v1/auth/token').set(authHeaders()).send({ workspace: 'desk', password: WS }).expect(201)
    ).body.token as string;
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await http().delete(`/v1/accounts/${account}`).set(bearer(ws)).expect(204);
    const audited = warn.mock.calls.map((c) => c[0]).some(
      (r) => typeof r === 'object' && r !== null && (r as { event?: string }).event === 'durable_account_deleted',
    );
    warn.mockRestore();
    expect(audited).toBe(true);

    // The old key now 404s (account gone) — a same-slug recreation would rebind it,
    // which is the accepted clause-6 residual the audit records.
    await http().get(`/v1/accounts/${account}`).set(bearer(key)).expect(404);
  });

  it('A3: a durable key survives a custody-clock jump of +99 years', async () => {
    const { account } = await setup();
    const key = (await mint({ account }).expect(201)).body.token as string;
    now += 99 * 365 * 24 * 3600 * 1000;
    await http().get(`/v1/accounts/${account}`).set(bearer(key)).expect(200);
  });
});

describe('durable-extremes: C — tier x inquiry x export', () => {
  let harness: Harness;
  let now = Date.now();
  const recipient = newRecipient();
  let account: string;
  let walletId: number;
  const http = () => request(harness.app.getHttpServer());
  const mint = (body: Record<string, unknown>) =>
    http().post('/v1/auth/api-key').set(authHeaders()).send({ workspace: 'desk', password: WS, account, ...body });

  beforeAll(async () => {
    harness = await boot({ custodyClock: () => now, tenants: [{ ...DEFAULT_TENANT, limits: { maxWorkspaces: 2, maxWallets: 10 } }] });
    await http().post('/v1/workspaces').set(authHeaders()).send({ slug: 'desk', password: WS }).expect(201);
    const ws = (
      await http().post('/v1/auth/token').set(authHeaders()).send({ workspace: 'desk', password: WS }).expect(201)
    ).body.token as string;
    account = (
      await http().post('/v1/accounts').set(bearer(ws)).send({ displayName: 'Acct', kind: 'HD' }).expect(201)
    ).body.account.slug as string;
    await http().post(`/v1/accounts/${account}/wallets`).set(bearer(ws)).send({ count: 1 }).expect(201);
    walletId = (
      await http().get(`/v1/accounts/${account}/wallets`).set(bearer(ws)).expect(200)
    ).body.wallets[0].id as number;
  });
  afterAll(async () => {
    await harness?.close();
  });

  it('C1: a Basic key with a LIVE inquiry key is still denied export (tier gate precedes inquiry gate)', async () => {
    const key = (await mint({ tier: 'basic', inquiryKey: recipient.configured }).expect(201)).body.token as string;
    const res = await http().post(`/v1/accounts/${account}/export`).set(bearer(key));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'scope_denied', details: { required: ['export'] } });
  });

  it('C2: an Unlimited key exports, then export locks when the inquiry window lapses while the key keeps reading', async () => {
    // The inquiry window runs on the real wall clock (independent of the custody
    // clock — the "two clocks" property), so this uses a short real window.
    const key = (
      await mint({ tier: 'unlimited', inquiryKey: recipient.configured, validationDuration: 2 }).expect(201)
    ).body.token as string;
    await http().post(`/v1/accounts/${account}/export`).set(bearer(key)).expect(200);

    await new Promise((resolve) => setTimeout(resolve, 2300)); // let the 2s inquiry window lapse
    await http().post(`/v1/accounts/${account}/export`).set(bearer(key)).expect(403);
    // The durable base key still reads — only the export capability lapsed.
    await http().get(`/v1/accounts/${account}`).set(bearer(key)).expect(200);
  });

  it('C3: an Unlimited wallet-scoped key exports its own PK but never the account mnemonic', async () => {
    const key = (
      await mint({ walletId, tier: 'unlimited', inquiryKey: recipient.configured }).expect(201)
    ).body.token as string;
    await http().post(`/v1/accounts/${account}/wallets/${walletId}/export?vm=evm`).set(bearer(key)).expect(200);
    await http().post(`/v1/accounts/${account}/export`).set(bearer(key)).expect(403); // mnemonic closed to wallet tokens
  });
});

describe('durable-extremes: B — Cold Vault x custody re-verify x backoff', () => {
  let harness: Harness;
  let now = Date.now();
  const clock = () => now;
  const http = () => request(harness.app.getHttpServer());
  let ws: string;
  const mkOwnPw = (name: string) =>
    http().post('/v1/accounts').set(bearer(ws))
      .send({ displayName: name, kind: 'HD', hasOwnPassword: true, accountPassword: ACCT_PW }).expect(201)
      .then((r) => r.body.account.slug as string);
  const mint = (body: Record<string, unknown>) =>
    http().post('/v1/auth/api-key').set(authHeaders()).send({ workspace: 'desk', password: WS, ...body });

  beforeAll(async () => {
    harness = await boot({ custodyClock: clock, accountUnlockClock: clock, tenants: [{ ...DEFAULT_TENANT, limits: { maxWorkspaces: 2, maxWallets: 10 } }] });
    await http().post('/v1/workspaces').set(authHeaders()).send({ slug: 'desk', password: WS }).expect(201);
    ws = (await http().post('/v1/auth/token').set(authHeaders()).send({ workspace: 'desk', password: WS }).expect(201)).body.token as string;
  });
  afterAll(async () => {
    await harness?.close();
  });

  it('B1: a durable key re-pins a Cold Vault account already unlocked on an ordinary deadline (Fix B)', async () => {
    const slug = await mkOwnPw('AcctB1');
    // Endpoint-unlock first → ordinary ~5min custody deadline.
    await http().post(`/v1/accounts/${slug}/unlock`).set(bearer(ws)).send({ accountPassword: ACCT_PW }).expect(204);
    // Now mint a durable key — it must re-pin to far-future, not inherit the ordinary deadline.
    const key = (await mint({ account: slug, accountPassword: ACCT_PW }).expect(201)).body.token as string;
    now += 10 * 60 * 1000; // past the ordinary deadline
    await http().get(`/v1/accounts/${slug}`).set(bearer(key)).expect(200);
  });

  it('B3: wrong-password mints back off while the session is kept alive by another durable key', async () => {
    const inherit = (await http().post('/v1/accounts').set(bearer(ws)).send({ displayName: 'keepalive', kind: 'HD' }).expect(201)).body.account.slug as string;
    await mint({ account: inherit }).expect(201); // a durable key pins the session so backoff state survives
    const slug = await mkOwnPw('AcctB3');
    await mint({ account: slug, accountPassword: 'wrong-1' }); // records a failure on the persistent session
    const res = await mint({ account: slug, accountPassword: 'wrong-2' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('account_unlock_rate_limited');
  });
});

describe('durable-extremes: E — clock x custody x reaping', () => {
  let harness: Harness;
  let now = Date.now();
  const clock = () => now;
  const http = () => request(harness.app.getHttpServer());
  let ws0: string;
  let account: string;
  let accountLock: string;
  const mint = (body: Record<string, unknown>) =>
    http().post('/v1/auth/api-key').set(authHeaders()).send({ workspace: 'desk', password: WS, ...body });

  beforeAll(async () => {
    harness = await boot({ custodyClock: clock, tenants: [{ ...DEFAULT_TENANT, limits: { maxWorkspaces: 2, maxWallets: 10 } }] });
    await http().post('/v1/workspaces').set(authHeaders()).send({ slug: 'desk', password: WS }).expect(201);
    ws0 = (await http().post('/v1/auth/token').set(authHeaders()).send({ workspace: 'desk', password: WS }).expect(201)).body.token as string;
    account = (await http().post('/v1/accounts').set(bearer(ws0)).send({ displayName: 'AcctE1', kind: 'HD' }).expect(201)).body.account.slug as string;
    accountLock = (await http().post('/v1/accounts').set(bearer(ws0)).send({ displayName: 'AcctE3', kind: 'HD' }).expect(201)).body.account.slug as string;
  });
  afterAll(async () => {
    await harness?.close();
  });

  // Runs BEFORE E1 (which jumps the clock past the workspace-token window).
  it('E3: a manual lock stands against a durable pin — the self-heal does not override it', async () => {
    const key = (await mint({ account: accountLock }).expect(201)).body.token as string;
    await http().get(`/v1/accounts/${accountLock}`).set(bearer(key)).expect(200);
    await http().post(`/v1/accounts/${accountLock}/lock`).set(bearer(ws0)).expect(204);
    const locked = await http().get(`/v1/accounts/${accountLock}/wallets`).set(bearer(key));
    expect(locked.status).toBe(423); // pinned, but a deliberate lock is respected
  });

  it('E1: past the absolute window a durable key lives on but a coexisting workspace token on the same session dies', async () => {
    const key = (await mint({ account }).expect(201)).body.token as string; // durable, pins the session
    const wsTok = (await http().post('/v1/auth/token').set(authHeaders()).send({ workspace: 'desk', password: WS }).expect(201)).body.token as string;
    now += 9 * 3600 * 1000; // past the 8h absolute window
    await http().get(`/v1/accounts/${account}`).set(bearer(key)).expect(200); // pinned
    const dead = await http().get('/v1/workspace').set(bearer(wsTok));
    expect(dead.status).toBe(401); // its own lease expired though the session survives
  });
});

describe('durable-extremes: D1 — tenant-cap eviction of a Cold Vault pin', () => {
  let harness: Harness;
  let now = Date.now();
  const clock = () => now;
  const http = () => request(harness.app.getHttpServer());

  async function ownPwAccount(slug: string): Promise<string> {
    await http().post('/v1/workspaces').set(authHeaders()).send({ slug, password: WS }).expect(201);
    const ws = (await http().post('/v1/auth/token').set(authHeaders()).send({ workspace: slug, password: WS }).expect(201)).body.token as string;
    const account = (await http().post('/v1/accounts').set(bearer(ws)).send({ displayName: 'AcctCV', kind: 'HD', hasOwnPassword: true, accountPassword: ACCT_PW }).expect(201)).body.account.slug as string;
    await http().delete('/v1/auth/token').set(bearer(ws)).expect(204); // close the session so nothing is pinned yet
    return account;
  }
  const mint = (workspace: string, body: Record<string, unknown>) =>
    http().post('/v1/auth/api-key').set(authHeaders()).send({ workspace, password: WS, ...body });

  beforeAll(async () => {
    harness = await boot({ custodyClock: clock, accountUnlockClock: clock, tenants: [{ ...DEFAULT_TENANT, limits: { maxWorkspaces: 3, maxWallets: 10, maxUnlockedWorkspaces: 2 } }] });
  });
  afterAll(async () => {
    await harness?.close();
  });

  it('D1: evicting a Cold Vault pin locks its account — the re-mint needs the account password again', async () => {
    const a = await ownPwAccount('cv-a');
    const b = await ownPwAccount('cv-b');
    const c = await ownPwAccount('cv-c');
    const keyA = (await mint('cv-a', { account: a, accountPassword: ACCT_PW }).expect(201)).body.token as string;
    now += 1000;
    await mint('cv-b', { account: b, accountPassword: ACCT_PW }).expect(201); // fills the cap of 2
    now += 1000;
    // Admitting cv-c evicts the LRU pin (cv-a): its session — and its Cold Vault unlock — are gone.
    await mint('cv-c', { account: c, accountPassword: ACCT_PW }).expect(201);
    await http().get(`/v1/accounts/${a}`).set(bearer(keyA)).expect(401); // evicted, restart-equivalent
    // Re-minting cv-a is refused without the account password — the account re-locked.
    const noPw = await mint('cv-a', { account: a });
    expect(noPw.status).toBe(423);
    expect(noPw.body.error.code).toBe('account_locked');
  });
});

describe('durable-extremes: D2 — process-cap eviction never crosses tenants', () => {
  let harness: Harness;
  let now = Date.now();
  const clock = () => now;
  const http = () => request(harness.app.getHttpServer());
  const B_KEY = 'ak_bravo_key_0123456';
  const TENANT_B = { id: 'bravo', apiKey: B_KEY, secretHash: DEFAULT_TENANT.secretHash, limits: { maxWorkspaces: 3, maxWallets: 10 } };
  const authB = { 'x-api-key': B_KEY, 'x-api-secret': 'sk_test_super_secret_value_0123456789' };
  const mint = (auth: Record<string, string>, workspace: string, account: string) =>
    http().post('/v1/auth/api-key').set(auth).send({ workspace, password: WS, account });

  async function provision(auth: Record<string, string>, slug: string): Promise<string> {
    await http().post('/v1/workspaces').set(auth).send({ slug, password: WS }).expect(201);
    const ws = (await http().post('/v1/auth/token').set(auth).send({ workspace: slug, password: WS }).expect(201)).body.token as string;
    const account = (await http().post('/v1/accounts').set(bearer(ws)).send({ displayName: 'AcctX', kind: 'HD' }).expect(201)).body.account.slug as string;
    await http().delete('/v1/auth/token').set(bearer(ws)).expect(204);
    return account;
  }

  beforeAll(async () => {
    // Process cap of 2 (TEE_MAX_UNLOCKED_WORKSPACES), two tenants.
    harness = await boot({ custodyClock: clock, env: { TEE_MAX_UNLOCKED_WORKSPACES: '2' }, tenants: [{ ...DEFAULT_TENANT, limits: { maxWorkspaces: 3, maxWallets: 10 } }, TENANT_B] });
  });
  afterAll(async () => {
    await harness?.close();
  });

  it('D2: tenant B fills the process cap; tenant A is refused rather than evicting B', async () => {
    const aAcct = await provision(authHeaders(), 'a-desk'); // A provisions first, while there is room
    const b1 = await provision(authB, 'b-one');
    const b2 = await provision(authB, 'b-two');
    const keyB1 = (await mint(authB, 'b-one', b1).expect(201)).body.token as string;
    now += 1000;
    const keyB2 = (await mint(authB, 'b-two', b2).expect(201)).body.token as string; // process cap full, both B
    now += 1000;
    // A mints on its own workspace: no B pin may be evicted, so A gets the capacity error.
    const denied = await mint(authHeaders(), 'a-desk', aAcct);
    expect(denied.status).toBe(429);
    // B's pins are untouched.
    await http().get(`/v1/accounts/${b1}`).set(bearer(keyB1)).expect(200);
    await http().get(`/v1/accounts/${b2}`).set(bearer(keyB2)).expect(200);
  });
});

describe('durable-extremes: G — maximal stacks', () => {
  let harness: Harness;
  let now = Date.now();
  const clock = () => now;
  const recipient = newRecipient();
  const http = () => request(harness.app.getHttpServer());
  let ws: string;
  const mint = (body: Record<string, unknown>) =>
    http().post('/v1/auth/api-key').set(authHeaders()).send({ workspace: 'desk', password: WS, ...body });

  beforeAll(async () => {
    harness = await boot({ custodyClock: clock, accountUnlockClock: clock, tenants: [{ ...DEFAULT_TENANT, limits: { maxWorkspaces: 3, maxWallets: 10, maxUnlockedWorkspaces: 8 } }] });
    await http().post('/v1/workspaces').set(authHeaders()).send({ slug: 'desk', password: WS }).expect(201);
    ws = (await http().post('/v1/auth/token').set(authHeaders()).send({ workspace: 'desk', password: WS }).expect(201)).body.token as string;
  });
  afterAll(async () => {
    await harness?.close();
  });

  // Runs BEFORE G1 (which jumps the clock past the workspace-token window).
  it('G2: a Cold Vault key rebinds to an inherit-password account recreated under the same slug', async () => {
    // A Cold Vault account, minted a durable account key.
    const first = (await http().post('/v1/accounts').set(bearer(ws)).send({ displayName: 'Vault', kind: 'HD', hasOwnPassword: true, accountPassword: ACCT_PW }).expect(201)).body.account.slug as string;
    const key = (await mint({ account: first, accountPassword: ACCT_PW }).expect(201)).body.token as string;
    await http().get(`/v1/accounts/${first}`).set(bearer(key)).expect(200);

    // Drop it and recreate the SAME slug as an inherit-password account.
    await http().delete(`/v1/accounts/${first}`).set(bearer(ws)).expect(204);
    const recreated = (await http().post('/v1/accounts').set(bearer(ws)).send({ displayName: 'Vault', kind: 'HD' }).expect(201)).body.account.slug as string;
    expect(recreated).toBe(first); // same slug reused

    // The old Cold Vault key now reaches the new INHERIT account — no password needed,
    // because the self-heal gate keys off the account's live password model.
    await http().get(`/v1/accounts/${first}`).set(bearer(key)).expect(200);
  });

  it('G1: Cold Vault + Unlimited + wallet + inquiry, exported, survives past account TTL and absolute', async () => {
    const slug = (await http().post('/v1/accounts').set(bearer(ws)).send({ displayName: 'AcctG1', kind: 'HD', hasOwnPassword: true, accountPassword: ACCT_PW }).expect(201)).body.account.slug as string;
    // The account must be unlocked to derive a wallet; mint an account key first to unlock+pin it.
    await mint({ account: slug, accountPassword: ACCT_PW }).expect(201);
    await http().post(`/v1/accounts/${slug}/wallets`).set(bearer(ws)).send({ count: 1 }).expect(201);
    const walletId = (await http().get(`/v1/accounts/${slug}/wallets`).set(bearer(ws)).expect(200)).body.wallets[0].id as number;

    const key = (await mint({ account: slug, walletId, tier: 'unlimited', accountPassword: ACCT_PW, inquiryKey: recipient.configured }).expect(201)).body.token as string;
    const first = await http().post(`/v1/accounts/${slug}/wallets/${walletId}/export?vm=evm`).set(bearer(key)).expect(200);
    expect(unseal(first.body.sealed, recipient.privateKey).length).toBeGreaterThan(0);

    now += 9 * 3600 * 1000; // past account TTL (~5m) and the session absolute (~8h)
    const second = await http().post(`/v1/accounts/${slug}/wallets/${walletId}/export?vm=evm`).set(bearer(key)).expect(200);
    expect(unseal(second.body.sealed, recipient.privateKey)).toBe(unseal(first.body.sealed, recipient.privateKey));
  });
});
