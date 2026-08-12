import request from 'supertest';
import { authHeaders, boot, DEFAULT_TENANT, type Harness } from '../harness/boot';

const WS_PASSWORD = 'Workspace-Passw0rd!x';

/**
 * mint-rate-limit-flow — token minting is the one endpoint where a single
 * caller can consume the whole service's CPU, because every mint pays an
 * Argon2 derivation. DESIGN §10.
 */
describe('mint-rate-limit-flow', () => {
  let harness: Harness;
  const http = () => request(harness.app.getHttpServer());

  beforeAll(async () => {
    harness = await boot({ env: { TEE_MINT_RATE_LIMIT: '2' } });
    await http()
      .post('/v1/workspaces')
      .set(authHeaders())
      .send({ slug: 'desk-a', password: WS_PASSWORD })
      .expect(201);
  });

  afterAll(async () => {
    await harness?.close();
  });

  const mint = () =>
    http()
      .post('/v1/auth/token')
      .set(authHeaders())
      .send({ workspace: 'desk-a', password: WS_PASSWORD });

  it('allows mints up to the limit, then refuses with 429', async () => {
    await mint().expect(201);
    await mint().expect(201);

    const res = await mint();
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('mint_rate_limited');
    expect(res.body.error.details.retryAfterSec).toBeGreaterThan(0);
  });

  it('refuses BEFORE spending the KDF', async () => {
    // A rejected mint must be fast — if it were rejected after the derivation
    // the limit would not protect the CPU it exists to protect.
    const started = Date.now();
    await mint().expect(429);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('counts per tenant, not globally', async () => {
    const second = {
      ...DEFAULT_TENANT,
      id: 'globex',
      apiKey: 'ak_test_globex_key_abcdef',
    };
    const other = await boot({
      tenants: [DEFAULT_TENANT, second],
      env: { TEE_MINT_RATE_LIMIT: '1' },
    });
    try {
      const h = () => request(other.app.getHttpServer());
      await h().post('/v1/workspaces').set(authHeaders()).send({ slug: 'w', password: WS_PASSWORD }).expect(201);
      await h().post('/v1/workspaces').set(authHeaders(second.apiKey)).send({ slug: 'w', password: WS_PASSWORD }).expect(201);

      const body = { workspace: 'w', password: WS_PASSWORD };
      await h().post('/v1/auth/token').set(authHeaders()).send(body).expect(201);
      await h().post('/v1/auth/token').set(authHeaders()).send(body).expect(429);

      // A different tenant still has its own budget.
      await h().post('/v1/auth/token').set(authHeaders(second.apiKey)).send(body).expect(201);
    } finally {
      await other.close();
    }
  });

  it.each(['', ' ', '0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992'])(
    'refuses to boot with invalid TEE_MINT_RATE_LIMIT=%p',
    async (value) => {
      await expect(boot({ env: { TEE_MINT_RATE_LIMIT: value } })).rejects.toThrow(
        'TEE_MINT_RATE_LIMIT must be a positive safe integer',
      );
    },
  );
});
