import request from 'supertest';
import { authHeaders, boot, DEFAULT_TENANT, type Harness } from '../harness/boot';
import { newRecipient } from '../harness/unseal';

const WS_PASSWORD = 'Workspace-Passw0rd!x';
const HD_DISPLAY_NAME = 'a'.repeat(64);
const PK_DISPLAY_NAME = 'b'.repeat(64);
const privateKey = (digit: string) => `0x${digit.repeat(64)}`;

describe('account-slug-flow', () => {
  let harness: Harness;
  let token: string;
  let hdSlug: string;
  let pkSlug: string;
  const recipient = newRecipient();
  const http = () => request(harness.app.getHttpServer());
  const bearer = () => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    harness = await boot({
      tenants: [
        {
          ...DEFAULT_TENANT,
          exportPublicKey: recipient.configured,
          limits: { maxWorkspaces: 2, maxWallets: 10 },
        },
      ],
    });
    await http()
      .post('/v1/workspaces')
      .set(authHeaders())
      .send({ slug: 'desk-a', password: WS_PASSWORD })
      .expect(201);
    token = await mint();

    const firstHd = await http()
      .post('/v1/accounts')
      .set(bearer())
      .send({ displayName: HD_DISPLAY_NAME, kind: 'HD' })
      .expect(201);
    const secondHd = await http()
      .post('/v1/accounts')
      .set(bearer())
      .send({ displayName: HD_DISPLAY_NAME, kind: 'HD' })
      .expect(201);
    await http()
      .post('/v1/accounts')
      .set(bearer())
      .send({ displayName: PK_DISPLAY_NAME, kind: 'PK', secret: privateKey('5') })
      .expect(201);
    const secondPk = await http()
      .post('/v1/accounts')
      .set(bearer())
      .send({ displayName: PK_DISPLAY_NAME, kind: 'PK', secret: privateKey('6') })
      .expect(201);

    expect(firstHd.body.account.slug).toBe('a'.repeat(58));
    hdSlug = secondHd.body.account.slug as string;
    pkSlug = secondPk.body.account.slug as string;
    expect(hdSlug).toHaveLength(64);
    expect(hdSlug).toMatch(/^a{58}-\d{5}$/);
    expect(pkSlug).toHaveLength(64);
    expect(pkSlug).toMatch(/^b{58}-\d{5}$/);

    // Close the only lease so the next mint proves the persisted account is
    // still addressable through a genuine core reopen.
    await http().delete('/v1/auth/token').set(bearer()).expect(204);
    token = await mint();
  });

  afterAll(async () => {
    await harness?.close();
  });

  async function mint(): Promise<string> {
    return (
      await http()
        .post('/v1/auth/token')
        .set(authHeaders())
        .send({
          workspace: 'desk-a',
          password: WS_PASSWORD,
          scopes: ['read', 'write', 'sign', 'export'],
        })
        .expect(201)
    ).body.token as string;
  }

  it('keeps a generated 64-character account reachable through every account path', async () => {
    const reopened = await http().get('/v1/accounts').set(bearer()).expect(200);
    expect(reopened.body.accounts.map((account: { slug: string }) => account.slug)).toEqual(
      expect.arrayContaining([hdSlug, pkSlug]),
    );

    await http().get(`/v1/accounts/${hdSlug}`).set(bearer()).expect(200);
    await http().post(`/v1/accounts/${hdSlug}/lock`).set(bearer()).expect(204);
    await http()
      .post(`/v1/accounts/${hdSlug}/unlock`)
      .set(bearer())
      .send({ accountPassword: WS_PASSWORD })
      .expect(204);

    const initial = await http()
      .get(`/v1/accounts/${hdSlug}/wallets`)
      .set(bearer())
      .expect(200);
    const walletId = initial.body.wallets[0].id as number;

    await http()
      .post(`/v1/accounts/${hdSlug}/wallets`)
      .set(bearer())
      .send({ count: 1 })
      .expect(201);
    await http()
      .post(`/v1/accounts/${pkSlug}/wallets/import`)
      .set(bearer())
      .send({ privateKey: privateKey('7') })
      .expect(201);
    await http()
      .get(`/v1/accounts/${hdSlug}/wallets/${walletId}/addresses`)
      .set(bearer())
      .expect(200);
    await http()
      .put(`/v1/accounts/${hdSlug}/wallets/${walletId}/tags`)
      .set(bearer())
      .send({ tags: ['long-slug'] })
      .expect(200);
    await http().post(`/v1/accounts/${hdSlug}/export`).set(bearer()).expect(200);
    const pkWallets = await http()
      .get(`/v1/accounts/${pkSlug}/wallets`)
      .set(bearer())
      .expect(200);
    const pkWalletId = pkWallets.body.wallets[0].id as number;
    await http()
      .post(`/v1/accounts/${pkSlug}/wallets/${pkWalletId}/export?vm=evm`)
      .set(bearer())
      .expect(200);
    await http().delete(`/v1/accounts/${hdSlug}`).set(bearer()).expect(204);
    await http().delete(`/v1/accounts/${pkSlug}`).set(bearer()).expect(204);

    await http().get(`/v1/accounts/${hdSlug}`).set(bearer()).expect(404);
    await http().get(`/v1/accounts/${pkSlug}`).set(bearer()).expect(404);
  });

  it('rejects an over-limit account path', async () => {
    const response = await http()
      .get(`/v1/accounts/${'a'.repeat(65)}`)
      .set(bearer());
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_slug');
  });
});
