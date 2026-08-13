import request from 'supertest';
import { Workspace } from 'wative-core';
import { authHeaders, boot, DEFAULT_TENANT, type Harness } from '../harness/boot';

const PASSWORD = 'Workspace-Passw0rd!x';

describe('workspace creation KDF admission', () => {
  let harness: Harness;
  let now = 1_000;
  const http = () => request(harness.app.getHttpServer());

  beforeAll(async () => {
    harness = await boot({
      tenants: [{ ...DEFAULT_TENANT, limits: { maxWorkspaces: 10, maxWallets: 20 } }],
      env: {
        TEE_WORKSPACE_CREATE_RATE_LIMIT: '2',
        TEE_WORKSPACE_RECREATE_COOLDOWN_SEC: '10',
        TEE_MINT_RATE_LIMIT: '1',
      },
      workspaceCreationClock: () => now,
    });
  });

  afterAll(async () => harness?.close());

  it('charges only admitted creations and leaves token minting independent', async () => {
    const open = jest.spyOn(Workspace, 'open');
    const create = (slug: string) => http()
      .post('/v1/workspaces')
      .set(authHeaders())
      .send({ slug, password: PASSWORD });

    await create('desk-a').expect(201);
    await create('desk-a').expect(409);
    await create('desk-b').expect(201);
    const callsBeforeRejection = open.mock.calls.length;

    const limited = await create('desk-c').expect(429);
    expect(limited.body.error).toMatchObject({
      code: 'workspace_creation_rate_limited',
      details: { retryAfterSec: 60 },
    });
    expect(Object.keys(limited.body.error.details)).toEqual(['retryAfterSec']);
    expect(open).toHaveBeenCalledTimes(callsBeforeRejection);
    expect((await http().get('/v1/quota').set(authHeaders())).body.workspaces.used).toBe(2);

    await http()
      .post('/v1/auth/token')
      .set(authHeaders())
      .send({ workspace: 'desk-a', password: PASSWORD })
      .expect(201);
    await http()
      .post('/v1/auth/token')
      .set(authHeaders())
      .send({ workspace: 'desk-a', password: PASSWORD })
      .expect(429);

    now += 60_000;
    await create('desk-c').expect(201);
    await create('desk-d').expect(201);
    now += 60_000;
    const callsBeforeConcurrent = open.mock.calls.length;
    const concurrent = await Promise.all(['desk-e', 'desk-f', 'desk-g'].map((slug) => create(slug)));
    expect(concurrent.map((response) => response.status).sort()).toEqual([201, 201, 429]);
    expect(open.mock.calls.length - callsBeforeConcurrent).toBe(2);
    open.mockRestore();
  });
});

describe('failed workspace creation charging', () => {
  let harness: Harness;
  const http = () => request(harness.app.getHttpServer());

  beforeAll(async () => {
    harness = await boot({
      tenants: [{ ...DEFAULT_TENANT, limits: { maxWorkspaces: 10, maxWallets: 20 } }],
      env: { TEE_WORKSPACE_CREATE_RATE_LIMIT: '1' },
    });
  });

  afterAll(async () => harness?.close());

  it('retains the charge when core provisioning has begun and rolls back the row', async () => {
    const open = jest.spyOn(Workspace, 'open').mockRejectedValueOnce(new Error('core open failed'));
    const first = await http()
      .post('/v1/workspaces')
      .set(authHeaders())
      .send({ slug: 'failed', password: PASSWORD });
    expect(first.status).toBe(500);
    const second = await http()
      .post('/v1/workspaces')
      .set(authHeaders())
      .send({ slug: 'other', password: PASSWORD })
      .expect(429);
    expect(second.body.error.code).toBe('workspace_creation_rate_limited');
    expect((await http().get('/v1/quota').set(authHeaders())).body.workspaces.used).toBe(0);
    open.mockRestore();
  });
});

describe('weak workspace passwords', () => {
  let harness: Harness;
  const http = () => request(harness.app.getHttpServer());

  beforeAll(async () => {
    harness = await boot({
      tenants: [{ ...DEFAULT_TENANT, limits: { maxWorkspaces: 10, maxWallets: 20 } }],
      env: { TEE_WORKSPACE_CREATE_RATE_LIMIT: '1' },
    });
  });

  afterAll(async () => harness?.close());

  it('rejects before every creation side effect or budget charge', async () => {
    const open = jest.spyOn(Workspace, 'open');
    const password = 'M13_SECRET';
    const weak = () => http()
      .post('/v1/workspaces')
      .set(authHeaders())
      .set('x-request-id', 'm13-weak')
      .send({ slug: 'weak-desk', password });

    const rejected = await Promise.all([weak(), weak()]);
    expect(rejected.map((response) => response.status)).toEqual([422, 422]);
    for (const response of rejected) {
      expect(response.body).toEqual({
        error: {
          code: 'weak_password',
          message: expect.any(String),
          requestId: 'm13-weak',
          status: 422,
        },
      });
      expect(JSON.stringify(response.body)).not.toContain(password);
      expect(response.body.error).not.toHaveProperty('details');
    }
    expect(open).not.toHaveBeenCalled();
    expect((await http().get('/v1/quota').set(authHeaders())).body.workspaces.used).toBe(0);

    await http().post('/v1/workspaces').set(authHeaders())
      .send({ slug: 'strong-desk', password: PASSWORD }).expect(201);
    await http().post('/v1/workspaces').set(authHeaders())
      .send({ slug: 'next-desk', password: PASSWORD }).expect(429);
    expect(open).toHaveBeenCalledTimes(1);
    open.mockRestore();
  });
});
