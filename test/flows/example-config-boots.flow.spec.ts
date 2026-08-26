import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { boot, type Harness } from '../harness/boot';

/**
 * example-config-boots-flow — the README's first instruction must work.
 *
 * Quick start says to copy `config/tenants.example.json` and start the service.
 * That file used to ship a live `rpc` block pointing at `rpc.example.com`, and
 * every tenant endpoint is resolved over DNS at startup, so the documented first
 * run failed closed on a host that does not resolve. The placeholder is now
 * parked under `_rpc`, inert in the same way `_exportPublicKey` is.
 *
 * Schema validation alone cannot catch this — the old file passed it. Only a
 * real boot can, which is why this lives with the flows.
 */
describe('example-config-boots-flow', () => {
  let harness: Harness | undefined;

  afterAll(async () => {
    await harness?.close();
  });

  it('boots the service on the shipped example tenant and answers health', async () => {
    const example = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'config', 'tenants.example.json'), 'utf8'),
    );

    harness = await boot({ tenants: example.tenants });

    const res = await request(harness.app.getHttpServer()).get('/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  // The guard above only means something while the placeholders stay inert. A
  // real `rpc` or `exportPublicKey` key here would be resolved or parsed at
  // boot, which is exactly the failure this file exists to prevent.
  it('keeps every placeholder in the example inert', () => {
    const example = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'config', 'tenants.example.json'), 'utf8'),
    );

    for (const tenant of example.tenants) {
      expect(tenant.rpc).toBeUndefined();
      expect(tenant.exportPublicKey).toBeUndefined();
    }
  });
});
