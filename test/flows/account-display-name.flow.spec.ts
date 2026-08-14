import request from 'supertest';
import { authHeaders, boot, type Harness } from '../harness/boot';

const PASSWORD = 'Workspace-Passw0rd!x';

describe('account display-name flow', () => {
  let harness: Harness;
  let token: string;
  const http = () => request(harness.app.getHttpServer());
  const bearer = () => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    harness = await boot();
    await http().post('/v1/workspaces').set(authHeaders())
      .send({ slug: 'desk-a', password: PASSWORD }).expect(201);
    token = (await http().post('/v1/auth/token').set(authHeaders())
      .send({ workspace: 'desk-a', password: PASSWORD }).expect(201)).body.token as string;
  });

  afterAll(async () => harness?.close());

  it('rejects a known invalid name before quota and returns no core wording or input', async () => {
    const rejected = await http().post('/v1/accounts').set(bearer())
      .send({ displayName: '中文中文', kind: 'HD' }).expect(400);
    expect(rejected.body.error).toMatchObject({ code: 'invalid_parameter' });
    expect(JSON.stringify(rejected.body)).not.toContain('中文中文');
    expect(JSON.stringify(rejected.body)).not.toContain('produces an empty slug');

    const quota = await http().get('/v1/quota').set(authHeaders()).expect(200);
    expect(quota.body.wallets.used).toBe(0);
    const accounts = await http().get('/v1/accounts').set(bearer()).expect(200);
    expect(accounts.body.accounts).toEqual([]);
  });

  it('accepts raw input longer than 64 when normalization yields a valid 64-character name', async () => {
    const raw = 'e\u0301'.repeat(64);
    expect(raw.length).toBe(128);
    const created = await http().post('/v1/accounts').set(bearer())
      .send({ displayName: raw, kind: 'HD' }).expect(201);
    expect(created.body.account.displayName).toBe('é'.repeat(64));
    expect(created.body.account.slug).toBe('e'.repeat(58));
  });
});
