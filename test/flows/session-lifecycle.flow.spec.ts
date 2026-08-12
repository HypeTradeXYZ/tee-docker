import request from 'supertest';
import { Workspace } from 'wative-core';
import { join } from 'node:path';
import { authHeaders, boot, DEFAULT_TENANT, type Harness } from '../harness/boot';

const WS_PASSWORD = 'Workspace-Passw0rd!x';
const ACCOUNT_PASSWORD = 'Account-Passw0rd!x';
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/**
 * session-lifecycle-flow — mint a workspace token, use it, lock it, and prove
 * the two-tier account model behaves as DESIGN §3 now claims:
 * shared-password accounts unlock lazily and transparently; own-password
 * accounts are refused until unlocked explicitly.
 */
describe('session-lifecycle-flow', () => {
  let harness: Harness;
  const http = () => request(harness.app.getHttpServer());

  // Not async: returns supertest's chainable Test so `.expect()` still works.
  const mintToken = (workspace = 'desk-a', password = WS_PASSWORD, scopes?: string[]) =>
    http()
      .post('/v1/auth/token')
      .set(authHeaders())
      .send({ workspace, password, ...(scopes ? { scopes } : {}) });

  beforeAll(async () => {
    harness = await boot();

    await http()
      .post('/v1/workspaces')
      .set(authHeaders())
      .send({ slug: 'desk-a', password: WS_PASSWORD })
      .expect(201);

    // Seed two accounts directly through the library: one sharing the
    // workspace password, one with its own. tee-docker's own account routes
    // are a later slice; this flow is about the session model.
    const path = join(harness.baseDir, 'data', DEFAULT_TENANT.id, 'desk-a');
    const ws = await Workspace.open({ path, password: WS_PASSWORD });
    await ws.accounts.create('Shared Desk', WS_PASSWORD, MNEMONIC, undefined, {
      hasOwnPassword: false,
    });
    await ws.accounts.create('Cold Vault', ACCOUNT_PASSWORD, MNEMONIC, undefined, {
      hasOwnPassword: true,
    });
    await ws.lock();
  });

  afterAll(async () => {
    await harness?.close();
  });

  describe('minting', () => {
    it('refuses without tenant credentials', async () => {
      const res = await http()
        .post('/v1/auth/token')
        .send({ workspace: 'desk-a', password: WS_PASSWORD });
      expect(res.status).toBe(401);
    });

    it('refuses a wrong workspace password', async () => {
      const res = await mintToken('desk-a', 'not-the-password');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('bad_password');
    });

    it('404s an unknown workspace', async () => {
      const res = await mintToken('no-such-workspace');
      expect(res.status).toBe(404);
    });

    it('mints a token with default scopes', async () => {
      const res = await mintToken().expect(201);
      expect(res.body).toMatchObject({ workspace: 'desk-a', scopes: ['read', 'write', 'sign'] });
      expect(res.body.token.split('.')).toHaveLength(3);
      expect(Date.parse(res.body.expiresAt)).toBeGreaterThan(Date.now());
    });

    it('refuses the export scope when the tenant has no registered key', async () => {
      const res = await mintToken('desk-a', WS_PASSWORD, ['read', 'export']);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('export_disabled');
    });

    it('refuses an unknown scope', async () => {
      const res = await mintToken('desk-a', WS_PASSWORD, ['read', 'make-coffee']);
      expect(res.status).toBe(400);
    });
  });

  describe('using a session', () => {
    let token: string;

    beforeAll(async () => {
      token = (await mintToken().expect(201)).body.token;
    });

    const bearer = () => ({ authorization: `Bearer ${token}` });

    it('reads the workspace implied by the token — no path parameter', async () => {
      const res = await http().get('/v1/workspace').set(bearer()).expect(200);
      expect(res.body).toMatchObject({ workspace: 'desk-a', locked: false, accounts: 2 });
    });

    it('rejects a missing or malformed bearer token', async () => {
      await http().get('/v1/workspace').expect(401);
      await http().get('/v1/workspace').set({ authorization: 'Bearer not.a.token' }).expect(401);
    });

    it('rejects a tampered signature', async () => {
      const [h, p] = token.split('.');
      const forged = `${h}.${p}.${'A'.repeat(43)}`;
      const res = await http().get('/v1/workspace').set({ authorization: `Bearer ${forged}` });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('session_expired');
    });

    it('does not leak why a token was rejected', async () => {
      // "bad signature" vs "expired" vs "no session" would tell an attacker
      // which part of a forged token to fix next.
      const forged = await http()
        .get('/v1/workspace')
        .set({ authorization: `Bearer ${token.split('.').slice(0, 2).join('.')}.AAAA` });
      const absent = await http().get('/v1/workspace');
      expect(forged.body.error.message).toBe(absent.body.error.message);
      expect(forged.body.error.details).toBeUndefined();
    });

    it('rejects a tenant-tier credential on a workspace route', async () => {
      await http().get('/v1/workspace').set(authHeaders()).expect(401);
    });

    it('lists both accounts, reporting their lock state', async () => {
      const res = await http().get('/v1/accounts').set(bearer()).expect(200);
      const slugs = res.body.accounts.map((a: { slug: string }) => a.slug).sort();
      expect(slugs).toHaveLength(2);
      // Every account starts locked after a workspace unlock — the finding
      // that DESIGN §3 was rewritten around.
      expect(res.body.accounts.every((a: { locked: boolean }) => a.locked)).toBe(true);
    });
  });

  describe('two-tier account access', () => {
    let token: string;
    const bearer = () => ({ authorization: `Bearer ${token}` });
    let sharedSlug: string;
    let ownSlug: string;

    beforeAll(async () => {
      token = (await mintToken().expect(201)).body.token;
      const res = await http().get('/v1/accounts').set(bearer()).expect(200);
      sharedSlug = res.body.accounts.find((a: { hasOwnPassword: boolean }) => !a.hasOwnPassword).slug;
      ownSlug = res.body.accounts.find((a: { hasOwnPassword: boolean }) => a.hasOwnPassword).slug;
    });

    it('unlocks a shared-password account transparently on first use', async () => {
      const res = await http().get(`/v1/accounts/${sharedSlug}`).set(bearer()).expect(200);
      expect(res.body.account).toMatchObject({ locked: false, hasOwnPassword: false });
    });

    it('refuses an own-password account with 423, naming it', async () => {
      const res = await http().get(`/v1/accounts/${ownSlug}`).set(bearer()).expect(423);
      expect(res.body.error.code).toBe('account_locked');
      expect(res.body.error.details).toEqual({ account: ownSlug });
    });

    it('reaches it after an explicit unlock', async () => {
      await http()
        .post(`/v1/accounts/${ownSlug}/unlock`)
        .set(bearer())
        .send({ accountPassword: ACCOUNT_PASSWORD })
        .expect(204);

      const res = await http().get(`/v1/accounts/${ownSlug}`).set(bearer()).expect(200);
      expect(res.body.account.locked).toBe(false);
    });

    it('rejects a wrong account password', async () => {
      const res = await http()
        .post(`/v1/accounts/${ownSlug}/unlock`)
        .set(bearer())
        .send({ accountPassword: 'wrong' });
      expect(res.status).toBe(401);
    });

    it('re-locks on demand, and refuses again afterwards', async () => {
      await http().post(`/v1/accounts/${ownSlug}/lock`).set(bearer()).expect(204);
      const res = await http().get(`/v1/accounts/${ownSlug}`).set(bearer()).expect(423);
      expect(res.body.error.code).toBe('account_locked');
    });

    it('404s an unknown account', async () => {
      await http().get('/v1/accounts/no-such-account').set(bearer()).expect(404);
    });
  });

  describe('locking', () => {
    it('kills the token immediately — no revocation list', async () => {
      const token = (await mintToken().expect(201)).body.token;
      const bearer = { authorization: `Bearer ${token}` };

      await http().get('/v1/workspace').set(bearer).expect(200);
      await http().delete('/v1/auth/token').set(bearer).expect(204);

      const after = await http().get('/v1/workspace').set(bearer);
      expect(after.status).toBe(401);
      expect(after.body.error.code).toBe('session_expired');
    });

    it('leaves other sessions on the same workspace alone', async () => {
      const a = (await mintToken().expect(201)).body.token;
      const b = (await mintToken().expect(201)).body.token;

      await http().delete('/v1/auth/token').set({ authorization: `Bearer ${a}` }).expect(204);

      await http().get('/v1/workspace').set({ authorization: `Bearer ${b}` }).expect(200);
    });
  });

  describe('quota reconciliation', () => {
    it('recounts out-of-band changes on the next genuine singleton open', async () => {
      await http()
        .post('/v1/workspaces')
        .set(authHeaders())
        .send({ slug: 'desk-reconcile', password: WS_PASSWORD })
        .expect(201);
      const before = (await http().get('/v1/quota').set(authHeaders()).expect(200)).body.wallets.used;

      const path = join(harness.baseDir, 'data', DEFAULT_TENANT.id, 'desk-reconcile');
      const ws = await Workspace.open({ path, password: WS_PASSWORD });
      const account = await ws.accounts.create('Reconcile Probe', WS_PASSWORD, MNEMONIC, undefined, {
        hasOwnPassword: false,
      });
      await account.tryUnlock();
      await account.deriveWallets(2);
      const expected = ws.accounts.reduce((n, a) => n + a.wallets.length, 0);
      await ws.lock();

      await mintToken('desk-reconcile').expect(201);

      const quota = await http().get('/v1/quota').set(authHeaders()).expect(200);
      expect(quota.body.wallets.used).toBe(before + expected);
      expect(expected).toBeGreaterThan(0);
    });
  });
});
