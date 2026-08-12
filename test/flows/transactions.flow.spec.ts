import request from 'supertest';
import { authHeaders, boot, DEFAULT_TENANT, type Harness } from '../harness/boot';

const WS_PASSWORD = 'Workspace-Passw0rd!x';

/**
 * transactions-flow — everything provable without a live chain: address
 * resolution, EVM/SVM parameter validation, scope enforcement, and the BYO-RPC
 * gate including the x-rpc-source header.
 *
 * Build/simulate/send against a real endpoint need a funded testnet address
 * and are deliberately NOT covered here — this suite must stay offline and
 * deterministic. See DESIGN §11.
 */
describe('transactions-flow', () => {
  let harness: Harness;
  let token: string;
  let evmAddress: string;
  const http = () => request(harness.app.getHttpServer());
  const bearer = () => ({ authorization: `Bearer ${token}` });

  // allowDefaultRpc false, so an unconfigured network has no usable endpoint
  // and the RPC gate is observable without touching the network.
  const TENANT = { ...DEFAULT_TENANT, allowDefaultRpc: false };

  beforeAll(async () => {
    harness = await boot({ tenants: [TENANT] });

    await http()
      .post('/v1/workspaces')
      .set(authHeaders())
      .send({ slug: 'desk-a', password: WS_PASSWORD })
      .expect(201);

    token = (
      await http()
        .post('/v1/auth/token')
        .set(authHeaders())
        .send({ workspace: 'desk-a', password: WS_PASSWORD })
        .expect(201)
    ).body.token;

    await http()
      .post('/v1/accounts')
      .set(bearer())
      .send({ displayName: 'Desk', kind: 'HD' })
      .expect(201);

    const slug = (await http().get('/v1/accounts').set(bearer())).body.accounts[0].slug;
    const wallets = await http().get(`/v1/accounts/${slug}/wallets`).set(bearer());
    evmAddress = wallets.body.wallets[0].addresses.find(
      (a: { vm: string }) => a.vm === 'evm',
    ).publicKey;
  });

  afterAll(async () => {
    await harness?.close();
  });

  describe('the BYO-RPC gate', () => {
    it('refuses to build when the network has no configured endpoint', async () => {
      const res = await http()
        .post('/v1/transactions/build')
        .set(bearer())
        .send({ address: evmAddress, to: '0x000000000000000000000000000000000000dEaD', value: '1' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('rpc_not_configured');
      // details is opt-in for this code, and naming the network is the point.
      expect(res.body.error.details).toEqual({ network: 'ethereum' });
    });

    it('refuses a status lookup with no network parameter', async () => {
      const res = await http().get('/v1/transactions/0xabc').set(bearer());
      expect(res.status).toBe(400);
    });

    it('reports the source header once an endpoint is configured', async () => {
      await http()
        .put('/v1/workspace/networks/ethereum')
        .set(bearer())
        .send({ rpcUrl: 'https://1.1.1.1:9/unreachable' })
        .expect(200);

      const res = await http()
        .post('/v1/transactions/build')
        .set(bearer())
        .send({ address: evmAddress, to: '0x000000000000000000000000000000000000dEaD', value: '1' });

      // The gate passed, so the header is stamped regardless of what the
      // (deliberately dead) endpoint does next.
      expect(res.headers['x-rpc-source']).toBe('tenant');
      expect(res.status).not.toBe(409);
    });
  });

  describe('validation', () => {
    beforeAll(async () => {
      await http()
        .put('/v1/workspace/networks/ethereum')
        .set(bearer())
        .send({ rpcUrl: 'https://1.1.1.1:9/unreachable' })
        .expect(200);
    });

    it('requires "to" for an EVM transaction', async () => {
      const res = await http()
        .post('/v1/transactions/build')
        .set(bearer())
        .send({ address: evmAddress, value: '1' });
      expect(res.status).toBe(400);
    });

    it('rejects a non-numeric value', async () => {
      const res = await http()
        .post('/v1/transactions/build')
        .set(bearer())
        .send({ address: evmAddress, to: '0x000000000000000000000000000000000000dEaD', value: 'lots' });
      expect(res.status).toBe(400);
    });

    it('404s an address outside this workspace', async () => {
      const res = await http()
        .post('/v1/transactions/build')
        .set(bearer())
        .send({ address: '0x000000000000000000000000000000000000dEaD', to: '0x00', value: '1' });
      expect(res.status).toBe(404);
    });
  });

  describe('scopes', () => {
    it('refuses transaction routes without the sign scope', async () => {
      const readOnly = (
        await http()
          .post('/v1/auth/token')
          .set(authHeaders())
          .send({ workspace: 'desk-a', password: WS_PASSWORD, scopes: ['read'] })
          .expect(201)
      ).body.token;

      const res = await http()
        .post('/v1/transactions/build')
        .set({ authorization: `Bearer ${readOnly}` })
        .send({ address: evmAddress, to: '0x000000000000000000000000000000000000dEaD', value: '1' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('scope_denied');
    });
  });

  describe('balances', () => {
    it('reports the unavailable capability before address or RPC lookup', async () => {
      const res = await http()
        .get(`/v1/addresses/${evmAddress}/balances?network=base`)
        .set(bearer());

      expect(res.status).toBe(501);
      expect(res.body.error).toMatchObject({
        code: 'not_implemented',
        message: 'Balance lookup is not available in this release.',
      });
      expect(res.headers['x-rpc-source']).toBeUndefined();
    });

    it.each([
      `/v1/addresses/${evmAddress}/balances`,
      '/v1/addresses/0x000000000000000000000000000000000000dEaD/balances',
      '/v1/addresses/no-such-address/balances?network=no-such-network',
    ])('returns the same capability response for %s', async (path) => {
      const res = await http().get(path).set(bearer()).expect(501);
      expect(res.body.error).toMatchObject({
        code: 'not_implemented',
        message: 'Balance lookup is not available in this release.',
      });
      expect(res.headers['x-rpc-source']).toBeUndefined();
    });

    it('still enforces bearer authentication before capability reporting', async () => {
      await http().get(`/v1/addresses/${evmAddress}/balances`).expect(401);
    });
  });

  describe('unreachable RPC', () => {
    it('maps a dead endpoint to 502 rather than a 500', async () => {
      const res = await http()
        .get('/v1/transactions/0xabc?network=ethereum')
        .set(bearer());

      // Port 9 (discard) refuses immediately — no real network dependency.
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('rpc_unreachable');
    });
  });
});
