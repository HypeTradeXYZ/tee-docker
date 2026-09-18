import request from 'supertest';
import { boot, type Harness } from '../harness/boot';

/**
 * activity-log — the admin-tier activity and metrics pull, end to end.
 *
 * The proof that matters: an error's internal reason (dropped from the body and
 * the 4xx log) is recoverable from GET /admin/activity, so an incident like a
 * wedged mint is one HTTP call to diagnose rather than a host sign-in.
 */

const ADMIN_KEY = 'p'.repeat(48);
const adminHeaders = { 'x-admin-key': ADMIN_KEY };

describe('activity log flow', () => {
  let harness: Harness;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    harness = await boot({ env: { PANADOL_KEY: ADMIN_KEY, TEE_ACTIVITY_PERF_INTERVAL_MS: '300' } });
    await harness.app.listen(0, '127.0.0.1');
    http = request(harness.app.getHttpServer());
  });
  afterEach(async () => {
    await harness?.close();
  });

  it('keeps the activity and metrics endpoints behind the admin key', async () => {
    await http.get('/v1/admin/activity').expect(401);
    await http.get('/v1/admin/metrics').expect(401);
  });

  it('captures a request completion and an error reason, pullable by admin', async () => {
    await http.get('/v1/health').expect(200);
    await http.get('/v1/auth/whoami').expect(401); // no bearer -> session_expired reason 'no bearer'

    const res = await http.get('/v1/admin/activity').set(adminHeaders).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(typeof res.body.lastSeq).toBe('number');
    const events: Array<Record<string, unknown>> = res.body.events;

    const health = events.find((e) => e.kind === 'request' && e.route === '/v1/health');
    expect(health).toMatchObject({ method: 'GET', status: 200 });
    expect(typeof health?.latencyMs).toBe('number');

    const denied = events.find((e) => e.kind === 'error' && e.code === 'session_expired');
    expect(denied).toMatchObject({ status: 401, reason: 'no bearer' });
    expect(typeof denied?.requestId).toBe('string');
  });

  it('filters by kind and pages incrementally by sinceSeq', async () => {
    await http.get('/v1/health').expect(200);
    const first = await http.get('/v1/admin/activity?kind=request').set(adminHeaders).expect(200);
    expect(first.body.events.every((e: { kind: string }) => e.kind === 'request')).toBe(true);

    const mark = first.body.lastSeq;
    await http.get('/v1/health').expect(200);
    const next = await http
      .get(`/v1/admin/activity?sinceSeq=${mark}`)
      .set(adminHeaders)
      .expect(200);
    expect(next.body.events.every((e: { seq: number }) => e.seq > mark)).toBe(true);
  });

  it('serves a perf sample series and buffer stats', async () => {
    await new Promise((r) => setTimeout(r, 400));
    const metrics = await http.get('/v1/admin/metrics').set(adminHeaders).expect(200);
    expect(metrics.body.samples.length).toBeGreaterThan(0);
    expect(metrics.body.samples[0]).toHaveProperty('loopLagMeanMs');

    const diag = await http.get('/v1/admin/diagnostics').set(adminHeaders).expect(200);
    expect(diag.body.activity).toMatchObject({ enabled: true, eventCap: expect.any(Number) });
  });

  it('rejects an unknown query parameter', async () => {
    await http.get('/v1/admin/activity?bogus=1').set(adminHeaders).expect(400);
  });
});
