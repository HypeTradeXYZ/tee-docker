import request from 'supertest';
import { DEFAULT_TENANT, authHeaders, boot, type Harness } from '../harness/boot';

const ALLOWED = 'https://app.example.com';
const OTHER = 'https://evil.example.com';

describe('cors-flow', () => {
  describe('with tenant origins configured', () => {
    let harness: Harness;
    const http = () => request(harness.app.getHttpServer());

    beforeAll(async () => {
      harness = await boot({
        tenants: [{ ...DEFAULT_TENANT, origins: [ALLOWED] }],
      });
    });

    afterAll(async () => {
      await harness?.close();
    });

    it('answers a preflight from an allowed origin', async () => {
      const res = await http()
        .options('/v1/workspaces')
        .set('origin', ALLOWED)
        .set('access-control-request-method', 'POST')
        .set('access-control-request-headers', 'x-api-key,x-api-secret,content-type');

      expect(res.status).toBeLessThan(300);
      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
      const allowedHeaders = String(res.headers['access-control-allow-headers'])
        .toLowerCase()
        .split(',')
        .map((header) => header.trim())
        .sort();
      expect(allowedHeaders).toEqual([
        'authorization',
        'content-type',
        'x-api-key',
        'x-api-secret',
        'x-request-id',
      ]);
      // Exact set, not `toContain` per method: a containment check passes just
      // as happily when a method is added or dropped, which is the drift worth
      // catching. OPTIONS is advertised because the preflight is itself OPTIONS.
      const allowedMethods = String(res.headers['access-control-allow-methods'])
        .toUpperCase()
        .split(',')
        .map((method) => method.trim())
        .sort();
      expect(allowedMethods).toEqual(['DELETE', 'GET', 'OPTIONS', 'POST', 'PUT']);
    });

    // A refused preflight is not short-circuited, so it falls through to the
    // unrouted OPTIONS and 404s. The status a developer sees is what they paste
    // into a search box, so it is pinned rather than left to a dependency default.
    it('refuses a preflight from an origin no tenant registered', async () => {
      const res = await http()
        .options('/v1/workspaces')
        .set('origin', OTHER)
        .set('access-control-request-method', 'POST');
      expect(res.status).toBe(404);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('still serves a non-allowlisted origin, leaving the browser to refuse it', async () => {
      const res = await http().get('/v1/health').set('origin', OTHER).expect(200);
      expect(res.body).toHaveProperty('status');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('exposes the three headers a caller is documented to read, and no others', async () => {
      const res = await http().get('/v1/health').set('origin', ALLOWED).expect(200);
      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
      // Exact set for the same reason the methods are: containment passes just
      // as happily when a fourth header is added, and this list decides what a
      // cross-origin script may read. `toContain` on a string is also substring
      // matching, so `x-request-id-internal` would satisfy a check for
      // `x-request-id` — the drift is invisible twice over.
      const exposed = String(res.headers['access-control-expose-headers'])
        .toLowerCase()
        .split(',')
        .map((header) => header.trim())
        .sort();
      expect(exposed).toEqual(['retry-after', 'x-request-id', 'x-rpc-source']);
    });

    it('never allows credentials, because nothing here reads a cookie', async () => {
      const res = await http().get('/v1/health').set('origin', ALLOWED).expect(200);
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('adds no CORS header to a request that carries no origin', async () => {
      const res = await http().get('/v1/health').expect(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('still serves ordinary authenticated traffic', async () => {
      await http().get('/v1/quota').set(authHeaders()).expect(200);
    });

    // route-manifest.spec.ts boots without origins, so CORS is off there and it
    // cannot see a preflight route. Enabling CORS must stay middleware-only or
    // the published surface would grow 32 OPTIONS entries nobody documents.
    it('registers no route, so the published surface is unchanged', () => {
      const instance = harness.app.getHttpAdapter().getInstance() as Record<string, unknown>;
      const router = (instance.router ?? instance._router) as {
        stack?: Array<{ route?: { methods?: Record<string, boolean> } }>;
      };
      const methods = new Set<string>();
      for (const layer of router.stack ?? []) {
        for (const [method, enabled] of Object.entries(layer.route?.methods ?? {})) {
          if (enabled) methods.add(method.toUpperCase());
        }
      }
      expect([...methods].sort()).toEqual(['DELETE', 'GET', 'POST', 'PUT']);
    });
  });

  describe('with no tenant origins configured', () => {
    let harness: Harness;
    const http = () => request(harness.app.getHttpServer());

    beforeAll(async () => {
      harness = await boot();
    });

    afterAll(async () => {
      await harness?.close();
    });

    it('leaves CORS entirely off', async () => {
      const res = await http().get('/v1/health').set('origin', ALLOWED).expect(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    // Identical to a configured allowlist that simply does not contain the
    // caller: both 404. Nothing in the response distinguishes "no origins are
    // configured at all" from "yours is missing", so diagnosis needs the config.
    it('leaves preflight unrouted, exactly as a non-allowlisted origin is', async () => {
      const res = await http()
        .options('/v1/workspaces')
        .set('origin', ALLOWED)
        .set('access-control-request-method', 'POST');
      expect(res.status).toBe(404);
    });
  });
});
