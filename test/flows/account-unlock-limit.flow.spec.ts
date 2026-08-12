import { join } from 'node:path';
import request from 'supertest';
import { Workspace } from 'wative-core';
import { authHeaders, boot, DEFAULT_TENANT, type Harness } from '../harness/boot';

const WS_PASSWORD = 'Workspace-Passw0rd!x';
const ACCOUNT_PASSWORD = 'Account-Passw0rd!x';
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('account-unlock-limit-flow', () => {
  let harness: Harness;
  let now = 1_000_000;
  let tokens: string[];
  let resetSlug: string;
  let lockoutSlug: string;
  const http = () => request(harness.app.getHttpServer());
  const bearer = (token = tokens[0]!) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    harness = await boot({
      env: { TEE_MINT_RATE_LIMIT: '20' },
      accountUnlockClock: () => now,
    });
    await http()
      .post('/v1/workspaces')
      .set(authHeaders())
      .send({ slug: 'desk-a', password: WS_PASSWORD })
      .expect(201);

    const path = join(harness.baseDir, 'data', DEFAULT_TENANT.id, 'desk-a');
    const ws = await Workspace.open({ path, password: WS_PASSWORD });
    resetSlug = String(
      (
        await ws.accounts.create('Reset Vault', ACCOUNT_PASSWORD, MNEMONIC, undefined, {
          hasOwnPassword: true,
        })
      ).slug,
    );
    lockoutSlug = String(
      (
        await ws.accounts.create('Lockout Vault', ACCOUNT_PASSWORD, MNEMONIC, undefined, {
          hasOwnPassword: true,
        })
      ).slug,
    );
    await ws.lock();
    tokens = await Promise.all([mint(), mint()]);
  });

  afterAll(async () => {
    await harness?.close();
  });

  async function mint(): Promise<string> {
    return (
      await http()
        .post('/v1/auth/token')
        .set(authHeaders())
        .send({ workspace: 'desk-a', password: WS_PASSWORD })
        .expect(201)
    ).body.token as string;
  }

  const unlock = (slug: string, password: string, token = tokens[0]!) =>
    http()
      .post(`/v1/accounts/${slug}/unlock`)
      .set(bearer(token))
      .send({ accountPassword: password });

  it('backs off without sleeping and resets only after successful verification', async () => {
    await unlock(resetSlug, 'wrong-1').expect(401);

    const blocked = await unlock(resetSlug, 'wrong-2');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatchObject({
      code: 'account_unlock_rate_limited',
      details: { retryAfterSec: 1 },
    });

    now += 1_000;
    await unlock(resetSlug, ACCOUNT_PASSWORD).expect(204);

    // Core 2.4.4 still verifies supplied passwords on an unlocked account.
    // Success cleared the old streak, so this reaches core rather than 429.
    await unlock(resetSlug, 'wrong-after-success').expect(401);
    await unlock(resetSlug, 'blocked-after-success').expect(429);
  });

  it('shares one bucket across sibling leases and revokes the session at five failures', async () => {
    const concurrent = await Promise.all([
      unlock(lockoutSlug, 'wrong-a', tokens[0]),
      unlock(lockoutSlug, 'wrong-b', tokens[1]),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([401, 429]);

    for (const delay of [1_000, 2_000, 4_000, 8_000]) {
      now += delay;
      await unlock(lockoutSlug, `wrong-${delay}`, tokens[0]).expect(401);
    }

    await http().get('/v1/workspace').set(bearer(tokens[0])).expect(401);
    await http().get('/v1/workspace').set(bearer(tokens[1])).expect(401);

    // A genuine remint gets a fresh session-local failure map; the tenant-wide
    // rolling KDF budget deliberately remains spent.
    const replacement = await mint();
    await http().get('/v1/workspace').set(bearer(replacement)).expect(200);
  });
});

describe('shared mint and account-unlock budget', () => {
  it('charges admitted unlocks but not invalid or unknown requests', async () => {
    let now = 2_000_000;
    const harness = await boot({
      env: { TEE_MINT_RATE_LIMIT: '3' },
      accountUnlockClock: () => now,
    });
    const http = () => request(harness.app.getHttpServer());
    try {
      await http()
        .post('/v1/workspaces')
        .set(authHeaders())
        .send({ slug: 'desk-a', password: WS_PASSWORD })
        .expect(201);
      const path = join(harness.baseDir, 'data', DEFAULT_TENANT.id, 'desk-a');
      const ws = await Workspace.open({ path, password: WS_PASSWORD });
      const slug = String(
        (
          await ws.accounts.create('Own Vault', ACCOUNT_PASSWORD, MNEMONIC, undefined, {
            hasOwnPassword: true,
          })
        ).slug,
      );
      await ws.lock();

      const mint = () =>
        http()
          .post('/v1/auth/token')
          .set(authHeaders())
          .send({ workspace: 'desk-a', password: WS_PASSWORD });
      const token = (await mint().expect(201)).body.token as string; // shared budget 1/3
      const bearer = { authorization: `Bearer ${token}` };

      await http()
        .post('/v1/accounts/no-such-account/unlock')
        .set(bearer)
        .send({ accountPassword: 'wrong' })
        .expect(404);
      await http().post(`/v1/accounts/${slug}/unlock`).set(bearer).send({}).expect(400);
      await http()
        .post(`/v1/accounts/${slug}/unlock`)
        .set(bearer)
        .send({ accountPassword: 'wrong' })
        .expect(401); // 2/3

      await mint().expect(201); // 3/3
      now += 1_000;
      const limited = await http()
        .post(`/v1/accounts/${slug}/unlock`)
        .set(bearer)
        .send({ accountPassword: 'another-wrong' });
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe('mint_rate_limited');
    } finally {
      await harness.close();
    }
  });
});
