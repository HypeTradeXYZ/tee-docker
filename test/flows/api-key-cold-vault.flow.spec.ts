import request from 'supertest';
import { authHeaders, boot, DEFAULT_TENANT, type Harness } from '../harness/boot';
import { newRecipient, unseal } from '../harness/unseal';

const WS_PASSWORD = 'Workspace-Passw0rd!x';
const ACCT_PASSWORD = 'Account-Passw0rd!y';
// Past the ~5-minute own-password account custody TTL (so an unpinned account
// would auto-lock), but within the workspace's absolute window so ordinary
// workspace tokens can still be issued. The +400d session-level pin is proven
// by the durability flow; here the point is the account staying unlocked.
const ADVANCE_MS = 10 * 60 * 1000;

/**
 * Wave 6 — Cold Vault minting. An own-password account is no longer refused at
 * mint: the tenant relays the account's own password to unlock it, the durable
 * lease then keeps it pinned unlocked, and the password is never stored. The
 * wrong password is refused, a missing one is refused before any unlock, and an
 * inherit-password account ignores a stray accountPassword.
 */
describe('api-key-cold-vault-flow', () => {
  let harness: Harness;
  let now = Date.now();
  let coldSlug: string;
  let exportSlug: string;
  let reverifySlug: string;
  let inheritSlug: string;
  const recipient = newRecipient();
  const custodyClock = (): number => now;
  const http = () => request(harness.app.getHttpServer());
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

  const mint = (body: Record<string, unknown>) =>
    http().post('/v1/auth/api-key').set(authHeaders()).send({ workspace: 'desk-a', password: WS_PASSWORD, ...body });

  async function freshWorkspaceToken(): Promise<string> {
    return (
      await http()
        .post('/v1/auth/token')
        .set(authHeaders())
        .send({ workspace: 'desk-a', password: WS_PASSWORD })
        .expect(201)
    ).body.token as string;
  }

  async function createColdAccount(displayName: string, wsToken: string): Promise<string> {
    return (
      await http()
        .post('/v1/accounts')
        .set(bearer(wsToken))
        .send({ displayName, kind: 'HD', hasOwnPassword: true, accountPassword: ACCT_PASSWORD })
        .expect(201)
    ).body.account.slug as string;
  }

  beforeAll(async () => {
    harness = await boot({
      custodyClock,
      accountUnlockClock: custodyClock,
      tenants: [{ ...DEFAULT_TENANT, limits: { maxWorkspaces: 2, maxWallets: 10 } }],
    });
    await http()
      .post('/v1/workspaces')
      .set(authHeaders())
      .send({ slug: 'desk-a', password: WS_PASSWORD })
      .expect(201);
    const wsToken = await freshWorkspaceToken();
    coldSlug = await createColdAccount('ColdVault', wsToken);
    exportSlug = await createColdAccount('ColdExport', wsToken);
    reverifySlug = await createColdAccount('ColdReverify', wsToken);
    inheritSlug = (
      await http()
        .post('/v1/accounts')
        .set(bearer(wsToken))
        .send({ displayName: 'Inherit', kind: 'HD' })
        .expect(201)
    ).body.account.slug as string;
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('refuses to mint for a Cold Vault account without the account password', async () => {
    const res = await mint({ account: coldSlug });
    expect(res.status).toBe(423);
    expect(res.body.error.code).toBe('account_locked');
  });

  it('refuses a wrong account password', async () => {
    const res = await mint({ account: coldSlug, accountPassword: 'not-the-password' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body.token).toBeUndefined();
  });

  it('mints a durable Cold Vault key with the account password and keeps it exposed past the TTL', async () => {
    // Clear the unlock backoff left by the wrong-password attempt (this session
    // persists via the beforeAll workspace token, so the backoff is real).
    now += 3600_000;
    const res = await mint({ account: coldSlug, accountPassword: ACCT_PASSWORD }).expect(201);
    expect(res.body.durable).toBe(true);
    const key = res.body.token as string;

    await http().get(`/v1/accounts/${coldSlug}`).set(bearer(key)).expect(200);
    now += ADVANCE_MS;
    await http().get(`/v1/accounts/${coldSlug}`).set(bearer(key)).expect(200);
  });

  it('exports a Cold Vault mnemonic sealed to the inquiry key', async () => {
    const key = (
      await mint({ account: exportSlug, tier: 'unlimited', accountPassword: ACCT_PASSWORD, inquiryKey: recipient.configured }).expect(201)
    ).body.token as string;
    const res = await http().post(`/v1/accounts/${exportSlug}/export`).set(bearer(key)).expect(200);
    expect(res.body.sealed).toBeDefined();
    // The blob opens only for the inquiry key holder, yielding the real mnemonic.
    const mnemonic = unseal(res.body.sealed, recipient.privateKey);
    expect(mnemonic.split(' ').length).toBeGreaterThanOrEqual(12);
  });

  it('keeps a durable Cold Vault key pinned even when the account was unlocked on an ordinary deadline first', async () => {
    // Unlock via the endpoint first: records an ordinary (~5min) custody deadline.
    const wsToken = await freshWorkspaceToken();
    await http()
      .post(`/v1/accounts/${reverifySlug}/unlock`)
      .set(bearer(wsToken))
      .send({ accountPassword: ACCT_PASSWORD })
      .expect(204);

    // Then mint a durable key: it must re-pin the account to the far-future custody,
    // not inherit the ordinary deadline (which would auto-lock it).
    const key = (
      await mint({ account: reverifySlug, accountPassword: ACCT_PASSWORD }).expect(201)
    ).body.token as string;

    now += ADVANCE_MS;
    await http().get(`/v1/accounts/${reverifySlug}`).set(bearer(key)).expect(200);
  });

  it('ignores a stray accountPassword on an inherit-password account', async () => {
    const res = await mint({ account: inheritSlug, accountPassword: 'irrelevant' }).expect(201);
    expect(res.body.durable).toBe(true);
    await http().get(`/v1/accounts/${inheritSlug}`).set(bearer(res.body.token)).expect(200);
  });
});
