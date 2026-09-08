import request from 'supertest';
import { authHeaders, boot, DEFAULT_TENANT, type Harness } from '../harness/boot';

const WS_PASSWORD = 'Workspace-Passw0rd!x';
// Far beyond any workspace absolute/idle TTL, so a non-durable session is long
// past expiry while a durable one must still answer.
const ADVANCE_MS = 400 * 24 * 3600 * 1000;

/**
 * Wave 5 — durability ("stay-exposed"). A minted key pins its workspace unlocked
 * until process restart: advancing the custody clock past every TTL neither
 * expires the durable key nor its session, while an ordinary workspace token on
 * an unpinned session does expire. Also proves the coarse-revocation contract:
 * DELETE /auth/token is a no-op for a durable key.
 */
describe('api-key-durability-flow', () => {
  let harness: Harness;
  let now = Date.now();
  let acct: string;
  let walletAcct: string;
  let walletId: number;
  let durableKey: string;
  let walletKey: string;
  let plainToken: string;

  const custodyClock = (): number => now;
  const http = () => request(harness.app.getHttpServer());
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

  beforeAll(async () => {
    harness = await boot({
      custodyClock,
      tenants: [{ ...DEFAULT_TENANT, limits: { maxWorkspaces: 2, maxWallets: 10 } }],
    });

    // desk-a carries the durable key; desk-b is an unpinned control.
    for (const slug of ['desk-a', 'desk-b']) {
      await http()
        .post('/v1/workspaces')
        .set(authHeaders())
        .send({ slug, password: WS_PASSWORD })
        .expect(201);
    }

    const wsToken = (
      await http()
        .post('/v1/auth/token')
        .set(authHeaders())
        .send({ workspace: 'desk-a', password: WS_PASSWORD })
        .expect(201)
    ).body.token as string;
    acct = (
      await http()
        .post('/v1/accounts')
        .set(bearer(wsToken))
        .send({ displayName: 'Durable', kind: 'HD' })
        .expect(201)
    ).body.account.slug as string;

    durableKey = (
      await http()
        .post('/v1/auth/api-key')
        .set(authHeaders())
        .send({ workspace: 'desk-a', password: WS_PASSWORD, account: acct })
        .expect(201)
    ).body.token as string;

    // A second account pinned ONLY by a wallet-scoped key, so its survival past
    // the TTL exercises the wallet-binding branch of the account pin.
    walletAcct = (
      await http()
        .post('/v1/accounts')
        .set(bearer(wsToken))
        .send({ displayName: 'WalletPinned', kind: 'HD' })
        .expect(201)
    ).body.account.slug as string;
    await http()
      .post(`/v1/accounts/${walletAcct}/wallets`)
      .set(bearer(wsToken))
      .send({ count: 1 })
      .expect(201);
    walletId = (
      await http().get(`/v1/accounts/${walletAcct}/wallets`).set(bearer(wsToken)).expect(200)
    ).body.wallets[0].id as number;
    walletKey = (
      await http()
        .post('/v1/auth/api-key')
        .set(authHeaders())
        .send({ workspace: 'desk-a', password: WS_PASSWORD, account: walletAcct, walletId })
        .expect(201)
    ).body.token as string;

    plainToken = (
      await http()
        .post('/v1/auth/token')
        .set(authHeaders())
        .send({ workspace: 'desk-b', password: WS_PASSWORD })
        .expect(201)
    ).body.token as string;
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('reports a minted key as durable with a far-future expiry', async () => {
    const mint = await http()
      .post('/v1/auth/api-key')
      .set(authHeaders())
      .send({ workspace: 'desk-a', password: WS_PASSWORD, account: acct })
      .expect(201);
    expect(mint.body.durable).toBe(true);
    // A hundred-year horizon: comfortably more than a decade out.
    expect(new Date(mint.body.expiresAt).getTime() - Date.now()).toBeGreaterThan(
      10 * 365 * 24 * 3600 * 1000,
    );

    const who = await http().get('/v1/auth/whoami').set(bearer(durableKey)).expect(200);
    expect(who.body.durable).toBe(true);

    // A plain workspace token is not durable.
    const plain = await http().get('/v1/auth/whoami').set(bearer(plainToken)).expect(200);
    expect(plain.body.durable).toBe(false);
  });

  it('keeps a durable key live past every TTL while an unpinned session expires', async () => {
    now += ADVANCE_MS;

    // The durable key still answers: its session and account stay pinned.
    await http().get(`/v1/accounts/${acct}`).set(bearer(durableKey)).expect(200);

    // The wallet-scoped key's account stays pinned through its wallet binding,
    // so a wallet operation still resolves the account past every TTL.
    await http()
      .get(`/v1/accounts/${walletAcct}/wallets/${walletId}/addresses`)
      .set(bearer(walletKey))
      .expect(200);

    // The control workspace token, on a session with no durable lease, is gone.
    const expired = await http().get('/v1/workspace').set(bearer(plainToken));
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe('session_expired');
  });

  it('treats DELETE /auth/token as a no-op for a durable key', async () => {
    await http().delete('/v1/auth/token').set(bearer(durableKey)).expect(204);
    // Coarse revocation: only a restart voids it, so the key still works.
    await http().get(`/v1/accounts/${acct}`).set(bearer(durableKey)).expect(200);
  });
});
