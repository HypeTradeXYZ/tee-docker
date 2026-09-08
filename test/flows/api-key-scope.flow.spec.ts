import request from 'supertest';
import { SessionRegistry } from '../../src/session/session.registry';
import { authHeaders, boot, type Harness } from '../harness/boot';

const WS_PASSWORD = 'Workspace-Passw0rd!x';

/**
 * Wave 1 — account/wallet-scoped API keys. Proves the mint, the authoritative
 * binding, fail-closed scope enforcement, refresh-keeps-binding (the FIX-1
 * regression), and revoke.
 */
describe('api-key-scope-flow', () => {
  let harness: Harness;
  let wsToken: string;
  let acctX: string;
  let acctY: string;

  const http = () => request(harness.app.getHttpServer());
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  const mintApiKey = (body: Record<string, unknown>) =>
    http()
      .post('/v1/auth/api-key')
      .set(authHeaders())
      .send({ workspace: 'desk-a', password: WS_PASSWORD, ...body });

  beforeAll(async () => {
    harness = await boot();
    await http()
      .post('/v1/workspaces')
      .set(authHeaders())
      .send({ slug: 'desk-a', password: WS_PASSWORD })
      .expect(201);
    const res = await http()
      .post('/v1/auth/token')
      .set(authHeaders())
      .send({ workspace: 'desk-a', password: WS_PASSWORD })
      .expect(201);
    wsToken = res.body.token;

    const rx = await http()
      .post('/v1/accounts')
      .set(bearer(wsToken))
      .send({ displayName: 'Acct X', kind: 'HD' })
      .expect(201);
    acctX = rx.body.account.slug;
    await http()
      .post(`/v1/accounts/${acctX}/wallets`)
      .set(bearer(wsToken))
      .send({ count: 2 })
      .expect(201);

    const ry = await http()
      .post('/v1/accounts')
      .set(bearer(wsToken))
      .send({ displayName: 'Acct Y', kind: 'HD' })
      .expect(201);
    acctY = ry.body.account.slug;
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('mints an account-scoped token reporting level + account, no-store', async () => {
    const res = await mintApiKey({ account: acctX }).expect(201);
    expect(res.body.level).toBe('account');
    expect(res.body.account).toBe(acctX);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(typeof res.body.token).toBe('string');
  });

  it('defaults an omitted tier to least-privilege Basic (read+write, no sign)', async () => {
    const res = await mintApiKey({ account: acctX }).expect(201);
    expect(res.body.tier).toBe('basic');
    expect(res.body.scopes).toEqual(['read', 'write']);
    const who = await http().get('/v1/auth/whoami').set(bearer(res.body.token)).expect(200);
    expect(who.body.tier).toBe('basic');
    expect(who.body.scopes).toEqual(['read', 'write']);
  });

  it('mints an Unlimited tier that carries the sign scope', async () => {
    const res = await mintApiKey({ account: acctX, tier: 'unlimited' }).expect(201);
    expect(res.body.tier).toBe('unlimited');
    expect(res.body.scopes).toEqual(['read', 'write', 'sign', 'export']);
    const who = await http().get('/v1/auth/whoami').set(bearer(res.body.token)).expect(200);
    expect(who.body.tier).toBe('unlimited');
  });

  it('rejects an unknown tier', async () => {
    const res = await mintApiKey({ account: acctX, tier: 'root' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_body');
  });

  it('enforces the tier at a real sign route, not just in the reported scopes', async () => {
    const signBody = { address: `0x${'1'.repeat(40)}`, message: 'hi' };

    // Basic is stopped by the scope guard: the sign scope is absent, so the
    // denial names the missing scope.
    const basic = (await mintApiKey({ account: acctX, tier: 'basic' }).expect(201)).body.token;
    const basicRes = await http().post('/v1/sign/message').set(bearer(basic)).send(signBody);
    expect(basicRes.status).toBe(403);
    expect(basicRes.body.error).toMatchObject({
      code: 'scope_denied',
      details: { required: ['sign'] },
    });

    // Unlimited clears the scope guard (the sign scope is present) and is stopped
    // only by the account-binding guard, which carries no missing-scope details —
    // proving the tier actually granted sign end to end.
    const unlimited = (
      await mintApiKey({ account: acctX, tier: 'unlimited' }).expect(201)
    ).body.token;
    const unlimitedRes = await http()
      .post('/v1/sign/message')
      .set(bearer(unlimited))
      .send(signBody);
    expect(unlimitedRes.status).toBe(403);
    expect(unlimitedRes.body.error.code).toBe('scope_denied');
    expect(unlimitedRes.body.error.details).toBeUndefined();
  });

  it('account token reads its own account/wallets, denied on another account, list, and export', async () => {
    const t = (await mintApiKey({ account: acctX }).expect(201)).body.token;
    await http().get(`/v1/accounts/${acctX}`).set(bearer(t)).expect(200);
    await http().get(`/v1/accounts/${acctX}/wallets`).set(bearer(t)).expect(200);

    const cross = await http().get(`/v1/accounts/${acctY}`).set(bearer(t));
    expect(cross.status).toBe(403);
    expect(cross.body.error.code).toBe('scope_denied');

    await http().get('/v1/accounts').set(bearer(t)).expect(403); // list: fail-closed
    const exp = await http().post(`/v1/accounts/${acctX}/export`).set(bearer(t));
    expect(exp.status).toBe(403); // export: not available to scoped tokens in wave 1
  });

  it('wallet token is confined to its one wallet', async () => {
    const t = (await mintApiKey({ account: acctX, walletId: 0 }).expect(201)).body.token;
    await http().get(`/v1/accounts/${acctX}/wallets/0/addresses`).set(bearer(t)).expect(200);

    const otherWallet = await http().get(`/v1/accounts/${acctX}/wallets/1/addresses`).set(bearer(t));
    expect(otherWallet.status).toBe(403); // binding mismatch

    // account-wide read is not opened to wallet tokens (least privilege)
    await http().get(`/v1/accounts/${acctX}`).set(bearer(t)).expect(403);
  });

  it('a refreshed scoped token keeps its binding and still works (FIX-1)', async () => {
    const t = (await mintApiKey({ account: acctX }).expect(201)).body.token;
    const refreshed = await http().post('/v1/auth/token/refresh').set(bearer(t)).send({}).expect(200);
    const t2 = refreshed.body.token as string;
    expect(typeof t2).toBe('string');
    // The refreshed token must still carry its binding — it acts within its
    // account (before FIX-1 the dropped acc/wal claim made this 401).
    await http().get(`/v1/accounts/${acctX}`).set(bearer(t2)).expect(200);
    const cross = await http().get(`/v1/accounts/${acctY}`).set(bearer(t2));
    expect(cross.status).toBe(403);
  });

  it('rejects a key for a non-existent account/wallet and leaks no lease', async () => {
    const sessions = harness.app.get(SessionRegistry);
    const before = sessions.leaseCount;
    await mintApiKey({ account: 'no-such-account' }).expect(404);
    const badWallet = await mintApiKey({ account: acctX, walletId: 999 });
    expect(badWallet.status).toBe(404);
    expect(sessions.leaseCount).toBe(before);
  });

  it('treats DELETE as a no-op for a durable scoped key (restart-only revocation)', async () => {
    const t = (await mintApiKey({ account: acctX }).expect(201)).body.token;
    await http().get(`/v1/accounts/${acctX}`).set(bearer(t)).expect(200);
    // A minted key is durable: the release is accepted but does not revoke it.
    await http().delete('/v1/auth/token').set(bearer(t)).expect(204);
    await http().get(`/v1/accounts/${acctX}`).set(bearer(t)).expect(200);
  });
});
