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

  it('a scoped token can be revoked and then fails closed', async () => {
    const t = (await mintApiKey({ account: acctX }).expect(201)).body.token;
    await http().get(`/v1/accounts/${acctX}`).set(bearer(t)).expect(200);
    await http().delete('/v1/auth/token').set(bearer(t)).expect(204);
    await http().get(`/v1/accounts/${acctX}`).set(bearer(t)).expect(401);
  });
});
