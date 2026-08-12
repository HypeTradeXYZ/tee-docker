import { existsSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import {
  authHeaders,
  boot,
  DEFAULT_TENANT,
  TEST_API_SECRET,
  type Harness,
} from '../harness/boot';

const WS_PASSWORD = 'Workspace-Passw0rd!x';

/**
 * tenant-provision-flow — the tenant tier end to end:
 * authenticate with API key + secret, create workspaces, hit the quota, and
 * confirm one tenant cannot see or reach another's.
 */
describe('tenant-provision-flow', () => {
  let harness: Harness;
  const http = () => request(harness.app.getHttpServer());

  beforeAll(async () => {
    harness = await boot();
  });

  afterAll(async () => {
    await harness?.close();
  });

  describe('authentication', () => {
    it('rejects a request with no credentials', async () => {
      const res = await http().get('/v1/workspaces').expect(401);
      expect(res.body.error.code).toBe('bad_api_key');
      expect(res.body.error.requestId).toEqual(expect.any(String));
    });

    it('rejects an unknown API key', async () => {
      const res = await http().get('/v1/workspaces').set(authHeaders('ak_nope', 'whatever'));
      expect(res.status).toBe(401);
    });

    it('rejects a valid key with the wrong secret', async () => {
      const res = await http().get('/v1/workspaces').set(authHeaders(undefined, 'wrong-secret'));
      expect(res.status).toBe(401);
    });

    it('gives the same message for unknown key and wrong secret', async () => {
      // Distinguishable errors would turn this endpoint into an oracle for
      // which API keys exist.
      const unknownKey = await http().get('/v1/workspaces').set(authHeaders('ak_nope', 'x'));
      const wrongSecret = await http().get('/v1/workspaces').set(authHeaders(undefined, 'x'));
      expect(unknownKey.body.error).toMatchObject({ code: wrongSecret.body.error.code });
      expect(unknownKey.body.error.message).toBe(wrongSecret.body.error.message);
    });

    it('accepts correct credentials', async () => {
      const res = await http().get('/v1/workspaces').set(authHeaders()).expect(200);
      expect(res.body).toEqual({ workspaces: [] });
    });

    it('never echoes the secret back', async () => {
      const res = await http().get('/v1/quota').set(authHeaders()).expect(200);
      expect(JSON.stringify(res.body)).not.toContain(TEST_API_SECRET);
    });
  });

  describe('provisioning', () => {
    it('creates a workspace on disk under the tenant root', async () => {
      const res = await http()
        .post('/v1/workspaces')
        .set(authHeaders())
        .send({ slug: 'desk-a', password: WS_PASSWORD })
        .expect(201);

      expect(res.body.workspace).toMatchObject({ slug: 'desk-a', walletCount: 0 });
      expect(existsSync(join(harness.baseDir, 'data', DEFAULT_TENANT.id, 'desk-a'))).toBe(true);
    });

    it('lists it, and counts it against quota', async () => {
      const list = await http().get('/v1/workspaces').set(authHeaders()).expect(200);
      expect(list.body.workspaces.map((w: { slug: string }) => w.slug)).toEqual(['desk-a']);

      const quota = await http().get('/v1/quota').set(authHeaders()).expect(200);
      expect(quota.body.workspaces).toEqual({ used: 1, limit: 2 });
    });

    it('refuses a duplicate slug', async () => {
      const res = await http()
        .post('/v1/workspaces')
        .set(authHeaders())
        .send({ slug: 'desk-a', password: WS_PASSWORD })
        .expect(409);
      expect(res.body.error.code).toBe('workspace_exists');
    });

    it('refuses past maxWorkspaces', async () => {
      await http()
        .post('/v1/workspaces')
        .set(authHeaders())
        .send({ slug: 'desk-b', password: WS_PASSWORD })
        .expect(201);

      const res = await http()
        .post('/v1/workspaces')
        .set(authHeaders())
        .send({ slug: 'desk-c', password: WS_PASSWORD })
        .expect(409);
      expect(res.body.error.code).toBe('quota_workspaces_exceeded');
    });

    it('frees the slot again on delete', async () => {
      await http().delete('/v1/workspaces/desk-b').set(authHeaders()).expect(204);
      expect(existsSync(join(harness.baseDir, 'data', DEFAULT_TENANT.id, 'desk-b'))).toBe(false);

      const quota = await http().get('/v1/quota').set(authHeaders()).expect(200);
      expect(quota.body.workspaces.used).toBe(1);
    });

    it('404s deleting a workspace that does not exist', async () => {
      const res = await http().delete('/v1/workspaces/never-existed').set(authHeaders());
      expect(res.status).toBe(404);
    });
  });

  describe('path safety', () => {
    it.each([
      ['..', 'traversal'],
      ['../escape', 'traversal with segment'],
      ['UPPER', 'uppercase'],
      ['has space', 'whitespace'],
      ['-leading-hyphen', 'leading hyphen'],
      ['', 'empty'],
    ])('rejects slug %p (%s)', async (slug) => {
      const res = await http()
        .post('/v1/workspaces')
        .set(authHeaders())
        .send({ slug, password: WS_PASSWORD });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_slug');
    });

    it('keeps a traversal attempt out of the parent directory', async () => {
      await http()
        .post('/v1/workspaces')
        .set(authHeaders())
        .send({ slug: '../../etc-escape', password: WS_PASSWORD });
      expect(existsSync(join(harness.baseDir, 'etc-escape'))).toBe(false);
      expect(existsSync(join(harness.baseDir, 'data', 'etc-escape'))).toBe(false);
    });
  });
});

describe('tenant-provision-flow: isolation between tenants', () => {
  let harness: Harness;

  const SECOND = {
    id: 'globex',
    apiKey: 'ak_test_globex_key_abcdef',
    secretHash: DEFAULT_TENANT.secretHash, // same secret, different tenant
    limits: { maxWorkspaces: 1, maxWallets: 5 },
  };

  beforeAll(async () => {
    harness = await boot({ tenants: [DEFAULT_TENANT, SECOND] });
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('does not show one tenant the other’s workspaces', async () => {
    const http = () => request(harness.app.getHttpServer());

    await http()
      .post('/v1/workspaces')
      .set(authHeaders())
      .send({ slug: 'shared-name', password: WS_PASSWORD })
      .expect(201);

    // Same slug, different tenant — must succeed, in its own directory.
    await http()
      .post('/v1/workspaces')
      .set(authHeaders(SECOND.apiKey))
      .send({ slug: 'shared-name', password: WS_PASSWORD })
      .expect(201);

    const theirs = await http().get('/v1/workspaces').set(authHeaders(SECOND.apiKey)).expect(200);
    expect(theirs.body.workspaces).toHaveLength(1);

    expect(existsSync(join(harness.baseDir, 'data', 'acme', 'shared-name'))).toBe(true);
    expect(existsSync(join(harness.baseDir, 'data', 'globex', 'shared-name'))).toBe(true);
  });

  it('applies each tenant’s own quota', async () => {
    const res = await request(harness.app.getHttpServer())
      .get('/v1/quota')
      .set(authHeaders(SECOND.apiKey))
      .expect(200);
    expect(res.body.workspaces).toEqual({ used: 1, limit: 1 });
    expect(res.body.wallets).toEqual({ used: 0, limit: 5 });
  });
});
