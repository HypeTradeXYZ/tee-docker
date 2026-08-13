import request from 'supertest';
import { boot, DEFAULT_TENANT, type Harness } from '../harness/boot';

/**
 * scaffold-flow — proves the harness itself works: a real Nest app boots
 * against an isolated data root, config loads and validates, and the error
 * map is wired. Every later flow builds on this.
 */
describe('scaffold-flow', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await boot();
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('serves liveness under the /v1 prefix', async () => {
    const res = await request(harness.app.getHttpServer()).get('/v1/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('leaks nothing about tenants from the unauthenticated health endpoint', async () => {
    const res = await request(harness.app.getHttpServer()).get('/v1/health').expect(200);
    expect(JSON.stringify(res.body)).not.toContain(DEFAULT_TENANT.id);
    expect(Object.keys(res.body)).toEqual(['status']);
  });

  it('refuses to boot when two tenants share an API key', async () => {
    await expect(
      boot({
        tenants: [DEFAULT_TENANT, { ...DEFAULT_TENANT, id: 'other' }],
      }),
    ).rejects.toThrow(/duplicate tenant apiKey/);
  });

  it('refuses to boot on a malformed tenant entry', async () => {
    await expect(
      boot({ tenants: [{ ...DEFAULT_TENANT, limits: { maxWorkspaces: -1, maxWallets: 10 } }] }),
    ).rejects.toThrow();
  });

  it('refuses to boot before listening when an export recipient is unusable', async () => {
    const configured = `x25519:${Buffer.alloc(32).toString('base64')}`;
    await expect(boot({
      tenants: [{ ...DEFAULT_TENANT, exportPublicKey: configured }],
    })).rejects.toThrow('exportPublicKey is not a usable X25519 recipient');
  });
});
