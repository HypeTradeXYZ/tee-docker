import request from 'supertest';
import { DEFAULT_TENANT, authHeaders, boot, type Harness } from '../harness/boot';

const ALLOWED = 'https://app.example.com';
const OTHER = 'https://evil.example.com';

describe('cors-flow', () => {
  describe('tenant-credential routes stay origin-allowlisted', () => {
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

    it('answers a workspaces preflight from an allowed origin with that origin', async () => {
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
      const allowedMethods = String(res.headers['access-control-allow-methods'])
        .toUpperCase()
        .split(',')
        .map((method) => method.trim())
        .sort();
      expect(allowedMethods).toEqual(['DELETE', 'GET', 'OPTIONS', 'POST', 'PUT']);
    });

    // A refused preflight is not short-circuited, so it falls through to the
    // unrouted OPTIONS and 404s — the same status a developer pastes into a search.
    it('refuses a workspaces preflight from an unregistered origin', async () => {
      const res = await http()
        .options('/v1/workspaces')
        .set('origin', OTHER)
        .set('access-control-request-method', 'POST');
      expect(res.status).toBe(404);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    // POST /v1/auth/token mints a token and is a tenant route; the same path's
    // DELETE (revoke) is a scoped route, so the method must decide.
    it('treats minting a token as a tenant route — refused from an unregistered origin', async () => {
      const res = await http()
        .options('/v1/auth/token')
        .set('origin', OTHER)
        .set('access-control-request-method', 'POST');
      expect(res.status).toBe(404);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('still serves ordinary authenticated tenant traffic', async () => {
      await http().get('/v1/quota').set(authHeaders()).expect(200);
    });
  });

  describe('scoped-key routes allow any origin', () => {
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

    it('answers an accounts preflight from any origin with a wildcard', async () => {
      const res = await http()
        .options('/v1/accounts')
        .set('origin', OTHER)
        .set('access-control-request-method', 'POST')
        .set('access-control-request-headers', 'authorization,content-type');
      expect(res.status).toBeLessThan(300);
      expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    // DELETE on the shared /v1/auth/token path is the scoped side of the split.
    it('treats revoking a token as a scoped route — wildcard from any origin', async () => {
      const res = await http()
        .options('/v1/auth/token')
        .set('origin', OTHER)
        .set('access-control-request-method', 'DELETE');
      expect(res.status).toBeLessThan(300);
      expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    it('serves a scoped route to any origin and lets script read it', async () => {
      const res = await http().get('/v1/health').set('origin', OTHER).expect(200);
      expect(res.body).toHaveProperty('status');
      expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    it('exposes the three documented headers on a wildcard response, and no others', async () => {
      const res = await http().get('/v1/health').set('origin', OTHER).expect(200);
      const exposed = String(res.headers['access-control-expose-headers'])
        .toLowerCase()
        .split(',')
        .map((header) => header.trim())
        .sort();
      expect(exposed).toEqual(['retry-after', 'x-request-id', 'x-rpc-source']);
    });

    it('never allows credentials, because nothing here reads a cookie', async () => {
      const res = await http().get('/v1/health').set('origin', OTHER).expect(200);
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
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

    // The scoped surface is open regardless of tenant config — a scoped key is
    // meant to work from a browser on a domain the operator never registered.
    it('still opens scoped routes to any origin', async () => {
      const res = await http().get('/v1/health').set('origin', ALLOWED).expect(200);
      expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    it('leaves a tenant preflight unrouted when no origin is allowlisted', async () => {
      const res = await http()
        .options('/v1/workspaces')
        .set('origin', ALLOWED)
        .set('access-control-request-method', 'POST');
      expect(res.status).toBe(404);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  // Enabling CORS must stay middleware-only or the published surface would grow
  // OPTIONS entries nobody documents.
  describe('published surface', () => {
    let harness: Harness;

    beforeAll(async () => {
      harness = await boot({
        tenants: [{ ...DEFAULT_TENANT, origins: [ALLOWED] }],
      });
    });

    afterAll(async () => {
      await harness?.close();
    });

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
});
