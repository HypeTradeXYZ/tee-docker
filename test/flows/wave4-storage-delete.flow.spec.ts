import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { Workspace } from 'wative-core';
import { authHeaders, boot, DEFAULT_TENANT, type Harness } from '../harness/boot';

const PASSWORD = 'Workspace-Passw0rd!x';
const privateKey = (digit: string) => `0x${digit.repeat(64)}`;

describe('wave-4 existing-only unlock and safe deletion', () => {
  let harness: Harness;
  let now = 1_000;
  const http = () => request(harness.app.getHttpServer());
  const workspacePath = (slug: string) =>
    join(harness.baseDir, 'data', DEFAULT_TENANT.id, slug);
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    harness = await boot({
      env: { TEE_WORKSPACE_CREATE_RATE_LIMIT: '1000' },
      workspaceCreationClock: () => now,
    });
  });

  afterAll(async () => {
    await harness?.close();
  });

  async function create(slug: string): Promise<void> {
    await http()
      .post('/v1/workspaces')
      .set(authHeaders())
      .send({ slug, password: PASSWORD })
      .expect(201);
  }

  async function mint(slug: string, password = PASSWORD): Promise<string> {
    const response = await http()
      .post('/v1/auth/token')
      .set(authHeaders())
      .send({ workspace: slug, password })
      .expect(201);
    return response.body.token as string;
  }

  async function createAndClose(slug: string): Promise<string> {
    await create(slug);
    const token = await mint(slug);
    await http().delete('/v1/auth/token').set(bearer(token)).expect(204);
    return workspacePath(slug);
  }

  it('requires force for live leases, revokes siblings, and permits only a fresh recreation', async () => {
    await create('desk-a');
    const first = await mint('desk-a');
    const second = await mint('desk-a');
    expect(decode(first).sid).toBe(decode(second).sid);

    const ordinary = await http()
      .delete('/v1/workspaces/desk-a')
      .set(authHeaders())
      .expect(409);
    expect(ordinary.body.error.code).toBe('workspace_in_use');
    await http().get('/v1/workspace').set(bearer(first)).expect(200);
    expect(existsSync(workspacePath('desk-a'))).toBe(true);

    await http()
      .delete('/v1/workspaces/desk-a?force=yes')
      .set(authHeaders())
      .expect(400);
    await http()
      .delete('/v1/workspaces/desk-a?force=true&force=false')
      .set(authHeaders())
      .expect(400);

    await http()
      .delete('/v1/workspaces/desk-a?force=true')
      .set(authHeaders())
      .expect(204);
    expect(existsSync(workspacePath('desk-a'))).toBe(false);
    await http().get('/v1/workspace').set(bearer(first)).expect(401);
    await http().get('/v1/workspace').set(bearer(second)).expect(401);
    await http().post('/v1/auth/token/refresh').set(bearer(first)).send({}).expect(401);

    const quota = await http().get('/v1/quota').set(authHeaders()).expect(200);
    expect(quota.body).toMatchObject({
      workspaces: { used: 0, limit: 2 },
      wallets: { used: 0, limit: 10 },
    });
    for (const password of [PASSWORD, 'wrong-password']) {
      const absent = await http()
        .post('/v1/auth/token')
        .set(authHeaders())
        .send({ workspace: 'desk-a', password })
        .expect(404);
      expect(absent.body.error.code).toBe('workspace_not_found');
    }
    expect(existsSync(workspacePath('desk-a'))).toBe(false);

    const cooled = await http()
      .post('/v1/workspaces')
      .set(authHeaders())
      .send({ slug: 'desk-a', password: PASSWORD })
      .expect(429);
    expect(cooled.body.error).toMatchObject({
      code: 'workspace_recreation_cooldown',
      details: { retryAfterSec: 60 },
    });
    now += 60_000;
    await create('desk-a');
    const replacement = await mint('desk-a');
    expect(decode(replacement).sid).not.toBe(decode(first).sid);
    await http().get('/v1/workspace').set(bearer(first)).expect(401);
    await http().get('/v1/workspace').set(bearer(replacement)).expect(200);
    await http()
      .delete('/v1/workspaces/desk-a?force=true')
      .set(authHeaders())
      .expect(204);
    now += 60_000;
  });

  it('never creates or repairs storage while minting a ledger-known workspace', async () => {
    const open = jest.spyOn(Workspace, 'open');

    const missing = await createAndClose('missing-box');
    rmSync(missing, { recursive: true, force: true });
    const missingCalls = open.mock.calls.length;
    for (const password of [PASSWORD, 'wrong-password']) {
      const response = await http()
        .post('/v1/auth/token')
        .set(authHeaders())
        .send({ workspace: 'missing-box', password })
        .expect(404);
      expect(response.body.error.code).toBe('workspace_not_found');
    }
    expect(open).toHaveBeenCalledTimes(missingCalls);
    expect(existsSync(missing)).toBe(false);
    await http()
      .delete('/v1/workspaces/missing-box?force=true')
      .set(authHeaders())
      .expect(204);

    const empty = await createAndClose('empty-box');
    rmSync(empty, { recursive: true, force: true });
    mkdirSync(empty, { recursive: true });
    const emptyCalls = open.mock.calls.length;
    await http()
      .post('/v1/auth/token')
      .set(authHeaders())
      .send({ workspace: 'empty-box', password: PASSWORD })
      .expect(404);
    expect(open).toHaveBeenCalledTimes(emptyCalls);
    expect(readdirSync(empty)).toEqual([]);
    await http()
      .delete('/v1/workspaces/empty-box?force=true')
      .set(authHeaders())
      .expect(204);

    const foreign = await createAndClose('foreign-box');
    rmSync(foreign, { recursive: true, force: true });
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, 'sentinel'), 'keep');
    const foreignCalls = open.mock.calls.length;
    await http()
      .post('/v1/auth/token')
      .set(authHeaders())
      .send({ workspace: 'foreign-box', password: PASSWORD })
      .expect(404);
    expect(open).toHaveBeenCalledTimes(foreignCalls);
    expect(readFileSync(join(foreign, 'sentinel'), 'utf8')).toBe('keep');
    await http()
      .delete('/v1/workspaces/foreign-box?force=true')
      .set(authHeaders())
      .expect(204);

    const partial = await createAndClose('partial-box');
    rmSync(join(partial, 'network'));
    const partialCalls = open.mock.calls.length;
    const damaged = await http()
      .post('/v1/auth/token')
      .set(authHeaders())
      .send({ workspace: 'partial-box', password: PASSWORD })
      .expect(500);
    expect(damaged.body.error.code).toBe('storage_error');
    expect(open).toHaveBeenCalledTimes(partialCalls);
    expect(existsSync(join(partial, 'network'))).toBe(false);
    await http()
      .delete('/v1/workspaces/partial-box?force=true')
      .set(authHeaders())
      .expect(204);

    const linked = await createAndClose('linked-box');
    rmSync(linked, { recursive: true, force: true });
    const target = join(harness.baseDir, 'outside-target');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'sentinel'), 'keep');
    symlinkSync(target, linked, 'dir');
    const linkedCalls = open.mock.calls.length;
    const refused = await http()
      .post('/v1/auth/token')
      .set(authHeaders())
      .send({ workspace: 'linked-box', password: PASSWORD })
      .expect(403);
    expect(refused.body.error.code).toBe('permission_denied');
    expect(open).toHaveBeenCalledTimes(linkedCalls);
    await http()
      .delete('/v1/workspaces/linked-box?force=true')
      .set(authHeaders())
      .expect(403);
    expect(readFileSync(join(target, 'sentinel'), 'utf8')).toBe('keep');
    rmSync(linked);
    await http()
      .delete('/v1/workspaces/linked-box?force=true')
      .set(authHeaders())
      .expect(204);

    open.mockRestore();
  });

  it('recomputes wallet quota from remaining rows and leaves the sibling singleton usable', async () => {
    await Promise.all([create('desk-a'), create('desk-b')]);
    const [first, second] = await Promise.all([mint('desk-a'), mint('desk-b')]);
    await Promise.all([
      http()
        .post('/v1/accounts')
        .set(bearer(first))
        .send({ displayName: 'First', kind: 'PK', secret: privateKey('1') })
        .expect(201),
      http()
        .post('/v1/accounts')
        .set(bearer(second))
        .send({ displayName: 'Second', kind: 'PK', secret: privateKey('2') })
        .expect(201),
    ]);

    await http()
      .delete('/v1/workspaces/desk-a?force=true')
      .set(authHeaders())
      .expect(204);
    const quota = await http().get('/v1/quota').set(authHeaders()).expect(200);
    expect(quota.body).toMatchObject({
      workspaces: { used: 1, limit: 2 },
      wallets: { used: 1, limit: 10 },
    });
    await http().get('/v1/workspace').set(bearer(first)).expect(401);
    await http().get('/v1/workspace').set(bearer(second)).expect(200);
    await http()
      .delete('/v1/workspaces/desk-b?force=true')
      .set(authHeaders())
      .expect(204);
  });
});

function decode(token: string): { sid: string; jti: string } {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as {
    sid: string;
    jti: string;
  };
}
