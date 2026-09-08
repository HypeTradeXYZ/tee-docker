import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { authHeaders, boot, type Harness } from '../harness/boot';

const WS_PASSWORD = 'Workspace-Passw0rd!x';

/** A browser-style X25519 inquiry key: raw base64 public key with the x25519: scheme. */
function inquiryKey(): string {
  const kp = generateKeyPairSync('x25519');
  const raw = kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return `x25519:${raw.toString('base64')}`;
}

/**
 * Wave 2 — the inquiry-key capability gate + whoami introspection. Proves that
 * an inquiry key unlocks the sensitive functionality list for a bounded window,
 * that its absence leaves it locked, and that whoami reports either state.
 */
describe('api-key-inquiry-flow', () => {
  let harness: Harness;
  let wsToken: string;
  let acctX: string;

  const http = () => request(harness.app.getHttpServer());
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  const mint = (body: Record<string, unknown>) =>
    http()
      .post('/v1/auth/api-key')
      .set(authHeaders())
      .send({ workspace: 'desk-a', password: WS_PASSWORD, account: acctX, ...body });

  beforeAll(async () => {
    harness = await boot();
    await http()
      .post('/v1/workspaces')
      .set(authHeaders())
      .send({ slug: 'desk-a', password: WS_PASSWORD })
      .expect(201);
    wsToken = (
      await http()
        .post('/v1/auth/token')
        .set(authHeaders())
        .send({ workspace: 'desk-a', password: WS_PASSWORD })
        .expect(201)
    ).body.token;
    const rx = await http()
      .post('/v1/accounts')
      .set(bearer(wsToken))
      .send({ displayName: 'Acct X', kind: 'HD' })
      .expect(201);
    acctX = rx.body.account.slug;
    await http().post(`/v1/accounts/${acctX}/wallets`).set(bearer(wsToken)).send({ count: 1 }).expect(201);
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('mint without an inquiry key leaves sensitive functions locked', async () => {
    const res = await mint({}).expect(201);
    expect(res.body.sensitiveEnabled).toBe(false);
    expect(res.body.functions).toEqual([]);
    expect(res.body.inquiryExpiresAt).toBeUndefined();
  });

  it('mint with an inquiry key unlocks the export function and reports the window', async () => {
    const res = await mint({ inquiryKey: inquiryKey(), validationDuration: 600 }).expect(201);
    expect(res.body.sensitiveEnabled).toBe(true);
    expect(res.body.functions).toEqual(['export']);
    const at = Date.parse(res.body.inquiryExpiresAt);
    expect(at).toBeGreaterThan(Date.now() + 590 * 1000);
    expect(at).toBeLessThan(Date.now() + 610 * 1000);
  });

  it('defaults the inquiry-key window to 4h when validationDuration is omitted', async () => {
    const res = await mint({ inquiryKey: inquiryKey() }).expect(201);
    const at = Date.parse(res.body.inquiryExpiresAt);
    expect(at).toBeGreaterThan(Date.now() + 3.9 * 3600 * 1000);
    expect(at).toBeLessThan(Date.now() + 4.1 * 3600 * 1000);
  });

  it('rejects a malformed inquiry key as a 400, minting nothing', async () => {
    const res = await mint({ inquiryKey: 'not-a-real-key' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_body');
    expect(res.body.token).toBeUndefined();
  });

  it('whoami reports the unlocked functions for an inquiry-key token', async () => {
    const t = (await mint({ inquiryKey: inquiryKey(), validationDuration: 600 }).expect(201)).body.token;
    const who = await http().get('/v1/auth/whoami').set(bearer(t)).expect(200);
    expect(who.body.level).toBe('account');
    expect(who.body.account).toBe(acctX);
    expect(who.body.sensitiveEnabled).toBe(true);
    expect(who.body.functions).toEqual(['export']);
    expect(typeof who.body.inquiryExpiresAt).toBe('string');
    expect(typeof who.body.expiresAt).toBe('string');
  });

  it('whoami reports no sensitive functions for a plain token', async () => {
    const t = (await mint({}).expect(201)).body.token;
    const who = await http().get('/v1/auth/whoami').set(bearer(t)).expect(200);
    expect(who.body.sensitiveEnabled).toBe(false);
    expect(who.body.functions).toEqual([]);
    expect(who.body.inquiryExpiresAt).toBeUndefined();
  });
});
