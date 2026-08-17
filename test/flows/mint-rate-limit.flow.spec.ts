import request from 'supertest';
import { authHeaders, boot, DEFAULT_TENANT, type Harness } from '../harness/boot';
import { MintRateLimiter } from '../../src/auth/mint-rate-limit';

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

  describe('what the budget is charged for (L-10)', () => {
    async function bootWithWorkspace(limit: string): Promise<Harness> {
      const h = await boot({ env: { TEE_MINT_RATE_LIMIT: limit } });
      await request(h.app.getHttpServer())
        .post('/v1/workspaces')
        .set(authHeaders())
        .send({ slug: 'desk-a', password: WS_PASSWORD })
        .expect(201);
      return h;
    }

    const uncharged: [string, Record<string, unknown>, number][] = [
      ['a malformed body', { nope: 1 }, 400],
      ['a malformed slug', { workspace: 'BAD SLUG', password: 'pw' }, 400],
      ['an unknown scope', { workspace: 'desk-a', password: 'pw', scopes: ['fly'] }, 400],
      ['an unknown workspace', { workspace: 'no-such-desk', password: 'pw' }, 404],
    ];

    it.each(uncharged)('does not spend the budget on %s', async (_name, body, status) => {
      const h = await bootWithWorkspace('2');
      try {
        for (let i = 0; i < 6; i++) {
          const res = await request(h.app.getHttpServer())
            .post('/v1/auth/token')
            .set(authHeaders())
            .send(body);
          expect(res.status).toBe(status);
          expect(res.body.error.code).not.toBe('mint_rate_limited');
        }
        // Budget untouched, so a real mint still succeeds.
        await request(h.app.getHttpServer())
          .post('/v1/auth/token')
          .set(authHeaders())
          .send({ workspace: 'desk-a', password: WS_PASSWORD })
          .expect(201);
      } finally {
        await h.close();
      }
    });

    it('still charges a wrong password once the session is warm', async () => {
      const h = await bootWithWorkspace('2');
      try {
        const mintWith = (password: string) =>
          request(h.app.getHttpServer())
            .post('/v1/auth/token')
            .set(authHeaders())
            .send({ workspace: 'desk-a', password });
        // Warm the singleton so the reuse path pays no KDF. It is the only
        // throttle on an online workspace-password guess.
        await mintWith(WS_PASSWORD).expect(201);
        await mintWith('Wrong-Passw0rd!x').expect(401);
        const third = await mintWith('Wrong-Passw0rd!x');
        expect(third.status).toBe(429);
        expect(third.body.error.code).toBe('mint_rate_limited');
      } finally {
        await h.close();
      }
    });

    it('leaves the budget intact for account unlock after malformed mints', async () => {
      const h = await bootWithWorkspace('3');
      try {
        for (let i = 0; i < 6; i++) {
          await request(h.app.getHttpServer())
            .post('/v1/auth/token')
            .set(authHeaders())
            .send({ workspace: 'BAD SLUG', password: 'pw' });
        }
        await request(h.app.getHttpServer())
          .post('/v1/auth/token')
          .set(authHeaders())
          .send({ workspace: 'desk-a', password: WS_PASSWORD })
          .expect(201);
      } finally {
        await h.close();
      }
    });
  });

  it('boots at the maximum limit', async () => {
    const capped = await boot({ env: { TEE_MINT_RATE_LIMIT: '10000' } });
    try {
      expect(capped.app.get(MintRateLimiter).limit).toBe(10_000);
    } finally {
      await capped.close();
    }
  });

  it.each(['', ' ', '0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992', '10001'])(
    'refuses to boot with invalid TEE_MINT_RATE_LIMIT=%p',
    async (value) => {
      await expect(boot({ env: { TEE_MINT_RATE_LIMIT: value } })).rejects.toThrow(
        'TEE_MINT_RATE_LIMIT must be an integer between 1 and 10000',
      );
    },
  );
});
