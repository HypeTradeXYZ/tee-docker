import request from 'supertest';
import { authHeaders, boot, DEFAULT_TENANT, type Harness } from '../harness/boot';

const WS_PASSWORD = 'Workspace-Passw0rd!x';

/**
 * unknown-body-fields-flow — a misspelled field must fail, not be ignored.
 *
 * Zod strips unknown keys unless a schema opts out, and every route below once
 * did. The failure mode was never a visible error: the request succeeded and the
 * service acted on a body the caller did not send. A misspelled `scopes` handed
 * back a token carrying the default grant instead of the narrower one asked for;
 * a misspelled `tokenMint` built a native transfer instead of a token transfer;
 * a misspelled `hasOwnPassword` created an account sharing the workspace
 * password. Each case is one keystroke away from a working request.
 *
 * These cases are the reason the schemas are strict, so they belong in the same
 * place. The assertions name the field deliberately: the message is what makes a
 * strict rejection actionable rather than merely loud.
 */
describe('unknown-body-fields-flow', () => {
  let harness: Harness;
  let token: string;
  let address: string;
  const http = () => request(harness.app.getHttpServer());
  const bearer = () => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    harness = await boot({
      tenants: [{ ...DEFAULT_TENANT, limits: { maxWorkspaces: 2, maxWallets: 8 } }],
    });
    await http()
      .post('/v1/workspaces')
      .set(authHeaders())
      .send({ slug: 'desk-a', password: WS_PASSWORD })
      .expect(201);
    token = (
      await http()
        .post('/v1/auth/token')
        .set(authHeaders())
        .send({ workspace: 'desk-a', password: WS_PASSWORD, scopes: ['read', 'write', 'sign'] })
        .expect(201)
    ).body.token;
    await http()
      .post('/v1/accounts')
      .set(bearer())
      .send({ displayName: 'Signing Desk', kind: 'HD' })
      .expect(201);
    const slug = (await http().get('/v1/accounts').set(bearer())).body.accounts[0].slug;
    const wallets = await http().get(`/v1/accounts/${slug}/wallets`).set(bearer());
    address = wallets.body.wallets[0].addresses.find(
      (a: { vm: string }) => a.vm === 'evm',
    ).publicKey;
  });

  afterAll(async () => {
    await harness?.close();
  });

  // The scope case is the sharpest: the old behaviour widened the grant rather
  // than narrowing it, so a caller asking for less silently received more.
  it('refuses a misspelled scopes key instead of granting the default scopes', async () => {
    const res = await http()
      .post('/v1/auth/token')
      .set(authHeaders())
      .send({ workspace: 'desk-a', password: WS_PASSWORD, scope: ['read'] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_body');
    expect(res.body.error.message).toContain('unexpected field "scope"');
    expect(res.body.token).toBeUndefined();
  });

  it('still grants exactly the scopes a correctly spelled request asks for', async () => {
    const res = await http()
      .post('/v1/auth/token')
      .set(authHeaders())
      .send({ workspace: 'desk-a', password: WS_PASSWORD, scopes: ['read'] })
      .expect(201);

    const claims = JSON.parse(
      Buffer.from(String(res.body.token).split('.')[1], 'base64url').toString('utf8'),
    );
    expect(claims.scp).toEqual(['read']);
  });

  it.each([
    ['account create', '/v1/accounts', { displayName: 'Cold Vault', hasOwnPasword: true }, 'hasOwnPasword'],
    ['wallet derive', '/v1/accounts/signing-desk/wallets', { conut: 1 }, 'conut'],
    ['message sign', '/v1/sign/message', { address: '0x0', message: 'hi', encodings: 'raw' }, 'encodings'],
    ['typed-data sign', '/v1/sign/typed-data', { address: '0x0', typedDat: {} }, 'typedDat'],
  ])('refuses a misspelled field on %s', async (_name, path, body, field) => {
    const res = await http().post(path).set(bearer()).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_body');
    expect(res.body.error.message).toContain(`unexpected field "${field}"`);
  });

  // A dropped `value` built a zero-value transaction and a dropped `tokenMint`
  // built a native transfer — both signable, both wrong, neither reported.
  it.each([
    [
      'a misspelled value',
      () => ({ address, to: '0x0000000000000000000000000000000000000001', valu: '1000' }),
      'valu',
    ],
    [
      'a misspelled tokenMint',
      () => ({ address, recipient: 'r', amount: '1', tokenMintt: 'X' }),
      'tokenMintt',
    ],
  ])('refuses %s on a transaction build', async (_name, body, field) => {
    const res = await http().post('/v1/transactions/build').set(bearer()).send(body());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_body');
    expect(res.body.error.message).toContain(`unexpected field "${field}"`);
  });

  // The EIP-712 payload is the deliberate exception: core signs payloads that
  // carry keys it does not recognise, so tightening it would refuse requests
  // that work today. Only the envelope around it is strict.
  it('still signs a typed-data payload carrying unrecognised keys', async () => {
    const res = await http()
      .post('/v1/sign/typed-data')
      .set(bearer())
      .send({
        address,
        chainId: 1,
        typedData: {
          domain: { name: 'T', version: '1', chainId: 1 },
          types: { Msg: [{ name: 'content', type: 'string' }] },
          primaryType: 'Msg',
          message: { content: 'hi' },
          extra: 'ignored by core, and that is deliberate',
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.signature).toMatch(/^0x[0-9a-f]+$/i);
  });
});
