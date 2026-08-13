import request from 'supertest';
import { authHeaders, boot, DEFAULT_TENANT, type Harness } from '../harness/boot';

const PASSWORD = 'Workspace-Passw0rd!x';

describe('account physical TTL flow', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await boot({
      tenants: [{
        ...DEFAULT_TENANT,
        ttl: { workspaceIdleSec: 30, workspaceAbsoluteSec: 60, accountAbsoluteSec: 1 },
      }],
    });
  });

  afterAll(async () => harness.close());

  it('physically locks a created account after a one-second TTL without a key request', async () => {
    const http = () => request(harness.app.getHttpServer());
    await http()
      .post('/v1/workspaces')
      .set(authHeaders())
      .send({ slug: 'desk-a', password: PASSWORD })
      .expect(201);
    const token = (
      await http()
        .post('/v1/auth/token')
        .set(authHeaders())
        .send({ workspace: 'desk-a', password: PASSWORD })
        .expect(201)
    ).body.token as string;
    const bearer = { authorization: `Bearer ${token}` };
    const created = await http()
      .post('/v1/accounts')
      .set(bearer)
      .send({ displayName: 'Short Lived', kind: 'HD' })
      .expect(201);
    expect(created.body.account.locked).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1_150));

    const listed = await http().get('/v1/accounts').set(bearer).expect(200);
    expect(listed.body.accounts).toEqual([
      expect.objectContaining({ slug: created.body.account.slug, locked: true }),
    ]);
    const denied = await http()
      .get(`/v1/accounts/${created.body.account.slug}`)
      .set(bearer)
      .expect(423);
    expect(denied.body.error.code).toBe('account_locked');
  });
});
