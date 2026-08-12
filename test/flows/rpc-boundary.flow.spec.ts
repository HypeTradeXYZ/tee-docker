import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { PassThrough } from 'node:stream';
import request from 'supertest';
import { Network } from 'wative-core';
import { JwtService } from '../../src/auth/jwt.service';
import { OperatorConfigService } from '../../src/config/operator-config.service';
import { RpcBoundaryService, type RpcHttpsRequester } from '../../src/session/rpc-boundary.service';
import { SessionRegistry } from '../../src/session/session.registry';
import { authHeaders, boot, DEFAULT_TENANT, type Harness } from '../harness/boot';

const PASSWORD = 'Rpc-Boundary-Passw0rd!';
const TARGET = 'https://rpc.public.test/v1/tenant-key?project=alpha';
const ETH_BUILTIN = 'https://ethereum-rpc.publicnode.com/';

function maliciousRequester(observed: string[]): RpcHttpsRequester {
  return ((
    url: URL,
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ): ClientRequest => {
    const request = new EventEmitter() as EventEmitter & { end(body?: unknown): void };
    request.end = (body): void => {
      observed.push(`${url.href}|${String(body)}`);
      const lookup = options.lookup as unknown as (
        hostname: string,
        options: unknown,
        callback: (error: Error | null, address: string, family: number) => void,
      ) => void;
      lookup(url.hostname, {}, (error) => {
        if (error) {
          request.emit('error', error);
          return;
        }
        const response = new PassThrough() as PassThrough & IncomingMessage;
        response.statusCode = 200;
        response.headers = { 'content-type': 'application/json' };
        callback(response);
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              status: '0x1',
              SECRET: 'internal-service-data',
              nested: { credentials: 'must-not-reflect' },
            },
          }),
        );
      });
    };
    return request as unknown as ClientRequest;
  }) as unknown as RpcHttpsRequester;
}

describe('H-01 RPC boundary flow', () => {
  let harness: Harness;
  let token: string;
  let address: string;
  let svmAddress: string;
  const observed: string[] = [];
  const http = () => request(harness.app.getHttpServer());
  const bearer = () => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    harness = await boot({
      tenants: [{
        ...DEFAULT_TENANT,
        allowDefaultRpc: false,
        rpc: {
          ethereum: 'HTTPS://ETHEREUM-RPC.PUBLICNODE.COM:443/./',
          solana: TARGET,
        },
      }],
      rpcDnsResolver: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '2606:4700:4700::1111', family: 6 },
      ],
      rpcHttpsRequester: maliciousRequester(observed),
    });

    await http()
      .post('/v1/workspaces')
      .set(authHeaders())
      .send({ slug: 'rpc-desk', password: PASSWORD })
      .expect(201);
    token = (
      await http()
        .post('/v1/auth/token')
        .set(authHeaders())
        .send({ workspace: 'rpc-desk', password: PASSWORD })
        .expect(201)
    ).body.token;
    await http()
      .post('/v1/accounts')
      .set(bearer())
      .send({ displayName: 'RPC desk', kind: 'HD' })
      .expect(201);
    const account = (await http().get('/v1/accounts').set(bearer()).expect(200)).body.accounts[0];
    const wallets = await http()
      .get(`/v1/accounts/${account.slug}/wallets`)
      .set(bearer())
      .expect(200);
    address = wallets.body.wallets[0].addresses.find(
      (candidate: { vm: string }) => candidate.vm === 'evm',
    ).publicKey;
    svmAddress = wallets.body.wallets[0].addresses.find(
      (candidate: { vm: string }) => candidate.vm === 'svm',
    ).publicKey;
  });

  afterAll(async () => {
    await harness?.close();
  });

  function liveSession() {
    const claims = harness.app.get(JwtService).verify(token);
    const tenant = harness.app.get(OperatorConfigService).byId(claims.tid)!;
    return harness.app.get(SessionRegistry).get(
      claims.sid,
      claims.jti,
      claims.tid,
      claims.ws,
      claims.scp,
      tenant.ttl.workspaceIdleSec,
    )!.session;
  }

  it('stores only a loopback capability in every core Network', () => {
    const session = liveSession();
    const urls = session.handle.networks.map((network) => String(network.rpcUrl));
    const addressUrls = session.handle.accounts.flatMap((account) =>
      account.wallets.flatMap((wallet) =>
        wallet.addresses.map((coreAddress) => String(coreAddress.network.rpcUrl)),
      ),
    );
    expect(urls.length).toBeGreaterThan(1);
    expect(urls.every((url) => url.startsWith('http://127.0.0.1:'))).toBe(true);
    expect(addressUrls.every((url) => url.startsWith('http://127.0.0.1:'))).toBe(true);
    expect(JSON.stringify(urls)).not.toContain('rpc.public.test');
    expect(JSON.stringify(urls)).not.toContain('tenant-key');
  });

  it('uses authenticated provenance instead of cosmetic URL equality', async () => {
    const seeded = await http().get('/v1/workspace/networks').set(bearer()).expect(200);
    expect(seeded.body.networks.find((network: { slug: string }) => network.slug === 'ethereum'))
      .toMatchObject({ rpcSource: 'tenant' });
    expect(seeded.body.networks.find((network: { slug: string }) => network.slug === 'base'))
      .toMatchObject({ rpcSource: 'none' });

    for (const rpcUrl of [
      'https://ethereum-rpc.publicnode.com',
      'HTTPS://ETHEREUM-RPC.PUBLICNODE.COM:443/',
      'https://ethereum-rpc.publicnode.com/a/../',
    ]) {
      await http()
        .put('/v1/workspace/networks/ethereum')
        .set(bearer())
        .send({ rpcUrl })
        .expect(200)
        .expect(({ body }) => expect(body.rpcSource).toBe('tenant'));
      const listed = await http().get('/v1/workspace/networks').set(bearer()).expect(200);
      expect(listed.body.networks.find((network: { slug: string }) => network.slug === 'ethereum'))
        .toMatchObject({ rpcSource: 'tenant' });
    }

    const before = String(liveSession().handle.networks.bySlug('ethereum' as never)?.rpcUrl);
    await http()
      .put('/v1/workspace/networks/ethereum')
      .set(bearer())
      .send({ rpcUrl: `${ETH_BUILTIN}#fragment` })
      .expect(400);
    expect(String(liveSession().handle.networks.bySlug('ethereum' as never)?.rpcUrl)).toBe(before);
  });

  it('does not expose the target or relay capability in built transaction material', async () => {
    const response = await http()
      .post('/v1/transactions/build')
      .set(bearer())
      .send({
        address,
        to: '0x000000000000000000000000000000000000dEaD',
        value: '1',
      })
      .expect(200);
    const rendered = JSON.stringify(response.body);
    expect(rendered).not.toContain('rpcUrl');
    expect(rendered).not.toContain('rpc.public.test');
    expect(rendered).not.toContain('127.0.0.1');
  });

  it('projects a real SVM build without endpoint authority or core internals', async () => {
    const response = await http()
      .post('/v1/transactions/build')
      .set(bearer())
      .send({
        address: svmAddress,
        recipient: '11111111111111111111111111111111',
        amount: '1',
        recentBlockhash: '11111111111111111111111111111111',
      })
      .expect(200);
    expect(Object.keys(response.body.raw).sort()).toEqual(
      ['feePayer', 'instructions', 'nonceInfo', 'recentBlockhash', 'signers'].sort(),
    );
    const rendered = JSON.stringify(response.body);
    expect(rendered).not.toContain('rpcUrl');
    expect(rendered).not.toContain('rpc.public.test');
    expect(rendered).not.toContain('tenant-key');
    expect(rendered).not.toContain('127.0.0.1');
    expect(rendered).not.toContain('_message');
    expect(rendered).not.toContain('signatures');
  });

  it('projects status fields and never reflects arbitrary upstream data', async () => {
    const response = await http()
      .get('/v1/transactions/0xdeadbeef?network=ethereum')
      .set(bearer())
      .expect(200);

    expect(response.body).toEqual({
      hash: '0xdeadbeef',
      found: true,
      status: 'confirmed',
    });
    expect(JSON.stringify(response.body)).not.toContain('SECRET');
    expect(JSON.stringify(response.body)).not.toContain('credentials');
    expect(observed.at(-1)).toContain(ETH_BUILTIN);
  });

  it('rejects private destinations without mutating the previous endpoint', async () => {
    const session = liveSession();
    const before = String(session.handle.networks.bySlug('ethereum' as never)?.rpcUrl);
    const response = await http()
      .put('/v1/workspace/networks/ethereum')
      .set(bearer())
      .send({ rpcUrl: 'https://127.0.0.1:9200/internal/admin' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('rpc_endpoint_rejected');
    expect(String(session.handle.networks.bySlug('ethereum' as never)?.rpcUrl)).toBe(before);
  });

  it('uses immutable target capabilities across updates', async () => {
    const boundary = harness.app.get(RpcBoundaryService);
    const session = liveSession();
    const oldRelay = String(session.handle.networks.bySlug('ethereum' as never)?.rpcUrl);

    await http()
      .put('/v1/workspace/networks/ethereum')
      .set(bearer())
      .send({ rpcUrl: 'https://rpc.public.test/v2/new-key' })
      .expect(200);

    const newRelay = String(session.handle.networks.bySlug('ethereum' as never)?.rpcUrl);
    expect(newRelay).not.toBe(oldRelay);
    expect(() => boundary.inspect(oldRelay, DEFAULT_TENANT.id, 'rpc-desk')).toThrow();
    expect((await fetch(oldRelay, { method: 'POST', body: '{}' })).status).toBe(502);
    expect(boundary.inspect(newRelay, DEFAULT_TENANT.id, 'rpc-desk').target).toBe(
      'https://rpc.public.test/v2/new-key',
    );
  });

  it('keeps the previous capability active when persistence rejects an update', async () => {
    const session = liveSession();
    const oldRelay = String(session.handle.networks.bySlug('ethereum' as never)?.rpcUrl);
    const networks = session.handle.networks as typeof session.handle.networks & {
      update: typeof session.handle.networks.update;
    };
    const spy = jest.spyOn(networks, 'update').mockRejectedValueOnce(new Error('update probe'));
    try {
      await http()
        .put('/v1/workspace/networks/ethereum')
        .set(bearer())
        .send({ rpcUrl: 'https://rpc.public.test/v3/rejected-key' })
        .expect(500);
    } finally {
      spy.mockRestore();
    }
    expect(String(session.handle.networks.bySlug('ethereum' as never)?.rpcUrl)).toBe(oldRelay);
    expect((await fetch(oldRelay, { method: 'POST', body: '{}' })).status).toBe(200);
  });

  it('revokes stale capabilities on close and reissues them on genuine reopen', async () => {
    const oldSession = liveSession();
    const oldRelay = String(oldSession.handle.networks.bySlug('ethereum' as never)?.rpcUrl);
    // Simulate a pre-H-01 workspace on disk: configured raw values that match
    // built-ins must recover provenance from the operator map, while an
    // untouched built-in with no configured value remains implicit.
    const ethereum = oldSession.handle.networks.bySlug('ethereum' as never)!;
    const base = oldSession.handle.networks.bySlug('base' as never)!;
    await oldSession.handle.networks.update(
      new Network({ ...ethereum, rpcUrl: 'HTTPS://ETHEREUM-RPC.PUBLICNODE.COM:443/./' }),
    );
    await oldSession.handle.networks.update(
      new Network({ ...base, rpcUrl: 'HTTPS://MAINNET.BASE.ORG:443/./' }),
    );
    await http().delete('/v1/auth/token').set(bearer()).expect(204);
    expect((await fetch(oldRelay, { method: 'POST', body: '{}' })).status).toBe(502);

    token = (
      await http()
        .post('/v1/auth/token')
        .set(authHeaders())
        .send({ workspace: 'rpc-desk', password: PASSWORD })
        .expect(201)
    ).body.token;
    const newRelay = String(
      liveSession().handle.networks.bySlug('ethereum' as never)?.rpcUrl,
    );
    expect(newRelay).not.toBe(oldRelay);
    expect(newRelay).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/rpc\//);
    const listed = await http().get('/v1/workspace/networks').set(bearer()).expect(200);
    expect(listed.body.networks.find((network: { slug: string }) => network.slug === 'ethereum'))
      .toMatchObject({ rpcSource: 'tenant' });
    expect(listed.body.networks.find((network: { slug: string }) => network.slug === 'base'))
      .toMatchObject({ rpcSource: 'none' });
  });
});
