import request from 'supertest';
import { Logger } from '@nestjs/common';
import { authHeaders, boot, DEFAULT_TENANT, type Harness } from '../harness/boot';

const WS_PASSWORD = 'Workspace-Passw0rd!x';

/**
 * Wave 5B — capacity re-model. Durable pins hold their workspace handle until
 * restart, so the handle cap turns hard. The stay-exposed model resolves that by
 * evicting the least-recently-used durable pin to admit a new one, rather than
 * refusing the new key. Proven here with a tenant handle cap of 2 and three
 * workspaces: bringing the third pin online evicts the oldest-used pin, not the
 * recently-used one, and emits an eviction record.
 */
describe('api-key-capacity-flow', () => {
  let harness: Harness;
  let now = Date.now();
  const custodyClock = (): number => now;
  const http = () => request(harness.app.getHttpServer());
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

  // Provision a workspace + one account, then CLOSE the session so no handle is
  // pinned during setup. Returns the account slug for a later durable mint.
  async function provision(slug: string): Promise<string> {
    await http()
      .post('/v1/workspaces')
      .set(authHeaders())
      .send({ slug, password: WS_PASSWORD })
      .expect(201);
    const wsToken = (
      await http()
        .post('/v1/auth/token')
        .set(authHeaders())
        .send({ workspace: slug, password: WS_PASSWORD })
        .expect(201)
    ).body.token as string;
    const account = (
      await http()
        .post('/v1/accounts')
        .set(bearer(wsToken))
        .send({ displayName: 'Pinned', kind: 'HD' })
        .expect(201)
    ).body.account.slug as string;
    // Drop the workspace token so this workspace holds no handle until it is pinned.
    await http().delete('/v1/auth/token').set(bearer(wsToken)).expect(204);
    return account;
  }

  const mintDurable = (slug: string, account: string) =>
    http()
      .post('/v1/auth/api-key')
      .set(authHeaders())
      .send({ workspace: slug, password: WS_PASSWORD, account })
      .expect(201)
      .then((res) => res.body.token as string);

  beforeAll(async () => {
    harness = await boot({
      custodyClock,
      tenants: [
        {
          ...DEFAULT_TENANT,
          limits: { maxWorkspaces: 3, maxWallets: 10, maxUnlockedWorkspaces: 2 },
        },
      ],
    });
  });

  afterAll(async () => {
    await harness?.close();
  });

  const whoami = (token: string) => http().get('/v1/auth/whoami').set(bearer(token));
  const evictionCount = (warn: jest.SpyInstance, slug?: string): number =>
    warn.mock.calls
      .map((call) => call[0])
      .filter(
        (record) =>
          typeof record === 'object'
          && record !== null
          && (record as { event?: string }).event === 'durable_key_evicted'
          && (slug === undefined || (record as { workspaceSlug?: string }).workspaceSlug === slug),
      ).length;

  it('evicts the LRU pin by recency (not mint order), and never for a non-durable admission', async () => {
    const acctA = await provision('desk-a');
    const acctB = await provision('desk-b');
    const acctC = await provision('desk-c');

    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    // Pin desk-a first, then desk-b — filling the tenant handle cap of 2.
    const keyA = await mintDurable('desk-a', acctA);
    now += 1000;
    const keyB = await mintDurable('desk-b', acctB);
    now += 1000;

    // Use desk-a AFTER desk-b was minted, so desk-b — not the older-minted
    // desk-a — is the least-recently-used pin. This tells LRU apart from a naive
    // evict-by-creation-order.
    await whoami(keyA).expect(200);
    now += 1000;

    // Admitting desk-c is over the cap: it evicts the LRU pin, desk-b.
    const keyC = await mintDurable('desk-c', acctC);
    await whoami(keyB).expect(401);
    await whoami(keyA).expect(200);
    await whoami(keyC).expect(200);
    expect(evictionCount(warn, 'desk-b')).toBe(1);
    expect(evictionCount(warn, 'desk-a')).toBe(0);

    // desk-a and desk-c now hold the cap. A NON-durable workspace token on desk-b
    // must be refused with a capacity error rather than evicting a durable pin.
    const before = evictionCount(warn);
    const token = await http()
      .post('/v1/auth/token')
      .set(authHeaders())
      .send({ workspace: 'desk-b', password: WS_PASSWORD });
    expect(token.status).toBe(429);
    await whoami(keyA).expect(200);
    await whoami(keyC).expect(200);
    expect(evictionCount(warn)).toBe(before);

    warn.mockRestore();
  });
});
