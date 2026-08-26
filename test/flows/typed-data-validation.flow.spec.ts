import request from 'supertest';
import { authHeaders, boot, DEFAULT_TENANT, type Harness } from '../harness/boot';

const WS_PASSWORD = 'Workspace-Passw0rd!x';

/**
 * typed-data-validation-flow — the EIP-712 envelope check at the boundary.
 *
 * `/v1/sign/typed-data` used to forward the body straight into core, so every
 * malformed payload came back as one indistinguishable `invalid_parameter`
 * "bad request" and an integrator had no way to tell which part was wrong.
 *
 * The check exists to name the failure, NOT to narrow what is accepted: every
 * shape refused below is one core refuses too. The first block pins the other
 * direction — payloads core deliberately signs must keep signing, or this
 * check has silently become a breaking change for callers who already work.
 */
describe('typed-data-validation-flow', () => {
  let harness: Harness;
  let token: string;
  let address: string;
  const http = () => request(harness.app.getHttpServer());
  const bearer = () => ({ authorization: `Bearer ${token}` });

  const types = { Msg: [{ name: 'content', type: 'string' }] };
  const message = { content: 'hi' };
  const domain = { name: 'T', version: '1' };
  const sign = (typedData: unknown, chainId?: number) =>
    http()
      .post('/v1/sign/typed-data')
      .set(bearer())
      .send(chainId === undefined ? { address, typedData } : { address, typedData, chainId });

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

  describe('payloads core signs keep signing', () => {
    // A domain that is not an object is signed on purpose: other EIP-712
    // implementations sign these identically, so refusing them here would
    // break callers who are already interoperating.
    it.each([
      ['an array domain', []],
      ['a numeric domain', 42],
      ['a boolean domain', true],
    ])('signs %s', async (_name, oddDomain) => {
      const res = await sign({ domain: oddDomain, types, primaryType: 'Msg', message }, 1);
      expect(res.status).toBe(200);
      expect(res.body.signature).toMatch(/^0x[0-9a-f]+$/i);
    });

    it('signs a payload carrying keys the envelope does not name', async () => {
      const res = await sign(
        {
          domain,
          types: { ...types, Unused: [{ name: 'x', type: 'uint256' }] },
          primaryType: 'Msg',
          message,
          extra: 'ignored',
        },
        1,
      );
      expect(res.status).toBe(200);
    });

    it('signs a field object carrying an extra key', async () => {
      const res = await sign(
        {
          domain,
          types: { Msg: [{ name: 'content', type: 'string', note: 'extra' }] },
          primaryType: 'Msg',
          message,
        },
        1,
      );
      expect(res.status).toBe(200);
    });
  });

  describe('malformed envelopes are named rather than forwarded', () => {
    const expectInvalidBody = async (typedData: unknown) => {
      const res = await sign(typedData, 1);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_body');
      return res.body.error.message;
    };

    // eth_signTypedData_v4 carries the payload stringified in params[1], so a
    // client forwarding that param verbatim sends a string. That was the
    // single hardest failure to diagnose from the old opaque 400.
    it('rejects typedData sent as a JSON string', async () => {
      const message_ = await expectInvalidBody(
        JSON.stringify({ domain, types, primaryType: 'Msg', message }),
      );
      expect(message_).toBe(
        'typedData must be an EIP-712 object with domain, types, primaryType and message',
      );
    });

    it.each([
      ['no domain', { types, primaryType: 'Msg', message }],
      ['no types', { domain, primaryType: 'Msg', message }],
      ['no primaryType', { domain, types, message }],
      ['no message', { domain, types, primaryType: 'Msg' }],
      ['an array message', { domain, types, primaryType: 'Msg', message: [] }],
      ['a numeric message', { domain, types, primaryType: 'Msg', message: 42 }],
      ['array types', { domain, types: [], primaryType: 'Msg', message }],
      ['a non-array struct', { domain, types: { Msg: 'nope' }, primaryType: 'Msg', message }],
      ['a field with no type', { domain, types: { Msg: [{ name: 'c' }] }, primaryType: 'Msg', message }],
      ['a field with no name', { domain, types: { Msg: [{ type: 'string' }] }, primaryType: 'Msg', message }],
      ['an empty primaryType', { domain, types, primaryType: '', message }],
    ])('rejects %s', async (_name, typedData) => {
      await expectInvalidBody(typedData);
    });

    it('rejects a primaryType that does not name a struct, without echoing it', async () => {
      const text = await expectInvalidBody({ domain, types, primaryType: 'msg', message });
      expect(text).toBe('primaryType must name one of the structs in types');
    });

    // R-03: a caller-supplied identifier is bounded only by the envelope, so it
    // must never reach the response body.
    it('does not echo an oversized primaryType', async () => {
      const res = await sign({ domain, types, primaryType: 'A'.repeat(8_009), message }, 1);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain('AAAA');
    });
  });

  describe('a domain naming a different chain is refused distinguishably', () => {
    it('names both chains when the domain disagrees with the signing chain', async () => {
      const res = await sign(
        { domain: { ...domain, chainId: 8453 }, types, primaryType: 'Msg', message },
        1,
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('chain_id_mismatch');
      expect(res.body.error.message).toBe(
        'typedData.domain.chainId 8453 does not match the signing chain 1',
      );
    });

    // With no explicit chainId the signing chain comes from the address's own
    // network, which is what makes this failure so confusing from outside.
    it('compares against the address network when no chainId is sent', async () => {
      const res = await sign({
        domain: { ...domain, chainId: 8453 },
        types,
        primaryType: 'Msg',
        message,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('chain_id_mismatch');
    });

    it.each([
      ['a number', 8453],
      ['a decimal string', '8453'],
      ['a hex string', '0x2105'],
    ])('accepts an agreeing chain id given as %s', async (_name, chainId) => {
      const res = await sign(
        { domain: { ...domain, chainId }, types, primaryType: 'Msg', message },
        8453,
      );
      expect(res.status).toBe(200);
    });

    it('leaves an unreadable chain id to core rather than guessing', async () => {
      const res = await sign(
        { domain: { ...domain, chainId: 'ethereum' }, types, primaryType: 'Msg', message },
        1,
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_parameter');
    });

    it('signs when the domain names no chain at all', async () => {
      const res = await sign({ domain, types, primaryType: 'Msg', message }, 8453);
      expect(res.status).toBe(200);
    });
  });
});
