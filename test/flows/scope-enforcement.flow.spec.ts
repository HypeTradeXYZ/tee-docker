import request from 'supertest';
import { SessionRegistry } from '../../src/session/session.registry';
import { authHeaders, boot, type Harness } from '../harness/boot';

const WS_PASSWORD = 'Workspace-Passw0rd!x';

describe('scope-enforcement-flow', () => {
  let harness: Harness;
  let readToken: string;
  let writeToken: string;
  let defaultToken: string;

  const http = () => request(harness.app.getHttpServer());
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const mint = async (scopes?: string[]): Promise<string> => {
    const res = await http()
      .post('/v1/auth/token')
      .set(authHeaders())
      .send({ workspace: 'desk-a', password: WS_PASSWORD, ...(scopes ? { scopes } : {}) })
      .expect(201);
    return res.body.token as string;
  };

  beforeAll(async () => {
    harness = await boot();
    await http()
      .post('/v1/workspaces')
      .set(authHeaders())
      .send({ slug: 'desk-a', password: WS_PASSWORD })
      .expect(201);

    defaultToken = await mint();
    readToken = await mint(['read']);
    writeToken = await mint(['write']);
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('rejects an explicitly empty scope list before creating a session', async () => {
    const sessions = harness.app.get(SessionRegistry);
    const before = sessions.size;

    const res = await http()
      .post('/v1/auth/token')
      .set(authHeaders())
      .send({ workspace: 'desk-a', password: WS_PASSWORD, scopes: [] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_slug');
    expect(res.body.token).toBeUndefined();
    expect(sessions.size).toBe(before);
  });

  it('keeps omitted scopes on the documented defaults', async () => {
    const res = await http()
      .post('/v1/auth/token')
      .set(authHeaders())
      .send({ workspace: 'desk-a', password: WS_PASSWORD })
      .expect(201);
    expect(res.body.scopes).toEqual(['read', 'write', 'sign']);
  });

  const readRoutes = [
    '/v1/workspace',
    '/v1/accounts',
    '/v1/workspace/assets',
    '/v1/accounts/no-such-account',
    '/v1/accounts/no-such-account/wallets',
    '/v1/accounts/no-such-account/wallets/0/addresses',
    '/v1/workspace/networks',
    '/v1/addresses/no-such-address/balances',
  ];

  it.each(readRoutes)('requires read for GET %s', async (path) => {
    const res = await http().get(path).set(bearer(writeToken));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      code: 'scope_denied',
      details: { required: ['read'] },
    });
  });

  const writeRoutes: Array<{
    method: 'post' | 'put' | 'delete';
    path: string;
    body?: string | object;
  }> = [
    { method: 'post', path: '/v1/accounts', body: {} },
    { method: 'delete', path: '/v1/accounts/no-such-account' },
    { method: 'post', path: '/v1/accounts/no-such-account/wallets', body: {} },
    { method: 'post', path: '/v1/accounts/no-such-account/wallets/import', body: {} },
    { method: 'put', path: '/v1/accounts/no-such-account/wallets/0/tags', body: {} },
    { method: 'put', path: '/v1/workspace/networks/no-such-network', body: {} },
  ];

  it.each(writeRoutes)('requires write for $method $path', async ({ method, path, body }) => {
    const call = http()[method](path).set(bearer(readToken));
    if (body !== undefined) call.send(body);
    const res = await call;
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      code: 'scope_denied',
      details: { required: ['write'] },
    });
  });

  it('checks authentication before route scope', async () => {
    const res = await http().get('/v1/workspace');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('session_expired');
  });

  it('does not treat write or sign as implicitly including read', async () => {
    const signOnly = await mint(['sign']);
    await http().get('/v1/workspace').set(bearer(signOnly)).expect(403);
    await http().get('/v1/workspace').set(bearer(writeToken)).expect(403);
  });

  it('allows read-only tokens on read routes', async () => {
    await http().get('/v1/workspace').set(bearer(readToken)).expect(200);
    await http().get('/v1/workspace/networks').set(bearer(readToken)).expect(200);
  });

  it('allows write-only tokens on mutation routes', async () => {
    await http()
      .put('/v1/workspace/networks/base')
      .set(bearer(writeToken))
      .send({ rpcUrl: 'https://1.1.1.1/c01' })
      .expect(200);
  });

  it('marks account lock and unlock as explicit scope-independent lifecycle routes', async () => {
    const unlock = await http()
      .post('/v1/accounts/no-such-account/unlock')
      .set(bearer(readToken))
      .send({});
    expect(unlock.status).toBe(400);
    expect(unlock.body.error.code).not.toBe('scope_denied');

    const lock = await http()
      .post('/v1/accounts/no-such-account/lock')
      .set(bearer(readToken));
    expect(lock.status).toBe(404);
    expect(lock.body.error.code).not.toBe('scope_denied');
  });

  it('does not mutate an account after a denied write request', async () => {
    const created = await http()
      .post('/v1/accounts')
      .set(bearer(defaultToken))
      .send({ displayName: 'Scope Probe', kind: 'HD' })
      .expect(201);
    const slug = created.body.account.slug as string;

    await http().delete(`/v1/accounts/${slug}`).set(bearer(readToken)).expect(403);

    const accounts = await http().get('/v1/accounts').set(bearer(defaultToken)).expect(200);
    expect(accounts.body.accounts).toEqual(
      expect.arrayContaining([expect.objectContaining({ slug })]),
    );
  });
});
