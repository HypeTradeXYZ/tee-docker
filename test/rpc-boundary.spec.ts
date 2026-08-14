import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { PassThrough } from 'node:stream';
import { OperatorConfigService } from '../src/config/operator-config.service';
import type { Tenant } from '../src/config/schemas';
import {
  isGlobalRpcAddress,
  parseRpcTarget,
  pinnedLookup,
  RpcBoundaryService,
  type RpcDnsResolver,
  type RpcHttpsRequester,
} from '../src/session/rpc-boundary.service';

const KEY = Buffer.alloc(32, 7);

interface FakeReply {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Buffer | string;
}

function fakeRequester(
  reply: FakeReply,
  observed: Array<{ hostname: string; address: string; family: number; host: string }>,
): RpcHttpsRequester {
  return ((
    rawUrl: URL,
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ): ClientRequest => {
    const request = new EventEmitter() as EventEmitter & { end(body?: unknown): void };
    request.end = (): void => {
      const lookup = options.lookup as unknown as (
        hostname: string,
        options: unknown,
        callback: (error: Error | null, address: string, family: number) => void,
      ) => void;
      lookup(rawUrl.hostname, {}, (error, address, family) => {
        if (error) {
          request.emit('error', error);
          return;
        }
        observed.push({
          hostname: rawUrl.hostname,
          address,
          family,
          host: String((options.headers as Record<string, unknown>).host),
        });
        const response = new PassThrough() as PassThrough & IncomingMessage;
        response.statusCode = reply.status ?? 200;
        response.headers = { ...(reply.headers ?? {}) };
        callback(response);
        response.end(reply.body ?? '{"jsonrpc":"2.0","id":1,"result":null}');
      });
    };
    return request as unknown as ClientRequest;
  }) as unknown as RpcHttpsRequester;
}

function boundary(
  resolver: RpcDnsResolver,
  requester?: RpcHttpsRequester,
  tenants: OperatorConfigService = new OperatorConfigService([]),
): RpcBoundaryService {
  return new RpcBoundaryService(KEY, tenants, resolver, requester);
}

describe('RPC egress boundary', () => {
  it('pins both scalar and Node autoSelectFamily lookup overloads', () => {
    const lookup = pinnedLookup({ address: '8.8.4.4', family: 4 });
    const scalar = jest.fn();
    lookup('rpc.test', { all: false }, scalar);
    expect(scalar).toHaveBeenCalledWith(null, '8.8.4.4', 4);

    const all = jest.fn();
    lookup('rpc.test', { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: '8.8.4.4', family: 4 }]);
  });

  it('fails boot before binding when operator config contains an unsafe target', async () => {
    const tenant: Tenant = {
      id: 'tenant-a',
      apiKey: 'a'.repeat(16),
      secretHash: 'b'.repeat(64),
      limits: { maxWorkspaces: 1, maxWallets: 1, maxUnlockedWorkspaces: 1 },
      ttl: { workspaceIdleSec: 60, workspaceAbsoluteSec: 120, accountAbsoluteSec: 30 },
      rpc: { ethereum: 'https://127.0.0.1/internal' },
      allowDefaultRpc: false,
      exportEnabled: false,
    };
    const service = boundary(
      async () => [{ address: '8.8.8.8', family: 4 }],
      undefined,
      new OperatorConfigService([tenant]),
    );
    await expect(service.onModuleInit()).rejects.toThrow('unsafe RPC endpoint');
  });

  it.each([
    'https://127.0.0.1/rpc',
    'https://2130706433/rpc',
    'https://0x7f000001/rpc',
    'https://0177.0.0.1/rpc',
    'https://0.0.0.0/rpc',
    'https://10.1.2.3/rpc',
    'https://172.16.0.1/rpc',
    'https://192.168.0.1/rpc',
    'https://169.254.169.254/rpc',
    'https://100.64.0.1/rpc',
    'https://192.0.2.1/rpc',
    'https://198.18.0.1/rpc',
    'https://198.51.100.1/rpc',
    'https://203.0.113.1/rpc',
    'https://224.0.0.1/rpc',
    'https://[::]/rpc',
    'https://[::1]/rpc',
    'https://[fc00::1]/rpc',
    'https://[fe80::1]/rpc',
    'https://[::ffff:127.0.0.1]/rpc',
    'https://[64:ff9b::7f00:1]/rpc',
    'https://[2002:7f00:1::]/rpc',
    'https://[2001:1::1]/rpc',
    'https://[2001:20::1]/rpc',
    'https://[2001:db8::1]/rpc',
    'https://[3fff::1]/rpc',
    'http://8.8.8.8/rpc',
    'ws://8.8.8.8/rpc',
    'wss://8.8.8.8/rpc',
    'file:///etc/passwd',
    'https://user:secret@8.8.8.8/rpc',
    'https://8.8.8.8/rpc#fragment',
  ])('rejects unsafe target %s', async (url) => {
    const service = boundary(async () => [{ address: '8.8.8.8', family: 4 }]);
    await expect(service.admit(url)).rejects.toMatchObject({ code: 'TEE_RPC_UNSAFE' });
  });

  it('accepts only hostnames whose complete A/AAAA set is public', async () => {
    const resolver: RpcDnsResolver = async (hostname) => {
      if (hostname === 'mixed.test') {
        return [
          { address: '8.8.8.8', family: 4 },
          { address: '10.0.0.1', family: 4 },
        ];
      }
      if (hostname === 'empty.test') return [];
      return [
        { address: '8.8.8.8', family: 4 },
        { address: '2606:4700:4700::1111', family: 6 },
      ];
    };
    const service = boundary(resolver);

    await expect(service.admit('https://public.test/rpc')).resolves.toBe(
      'https://public.test/rpc',
    );
    await expect(service.admit('https://mixed.test/rpc')).rejects.toMatchObject({
      code: 'TEE_RPC_UNSAFE',
    });
    await expect(service.admit('https://empty.test/rpc')).rejects.toMatchObject({
      code: 'TEE_RPC_UNSAFE',
    });
  });

  it('canonicalizes alternate IP spellings before classification', () => {
    expect(() => parseRpcTarget('https://2130706433')).toThrow();
    expect(() => parseRpcTarget('https://0x7f000001')).toThrow();
    expect(isGlobalRpcAddress('8.8.8.8')).toBe(true);
    expect(isGlobalRpcAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('re-resolves per request and refuses a public-to-private DNS rebind', async () => {
    let resolution = 0;
    const resolver: RpcDnsResolver = async () => {
      resolution += 1;
      return resolution === 1
        ? [{ address: '8.8.8.8', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }];
    };
    const observed: Array<{ hostname: string; address: string; family: number; host: string }> = [];
    const requester = jest.fn(fakeRequester({}, observed)) as unknown as RpcHttpsRequester;
    const service = boundary(resolver, requester);
    await service.onModuleInit();
    try {
      const target = await service.admit('https://rpc.public.test/secret-key');
      const relay = service.relayUrl(target, 'tenant-a', 'desk-a', 'tenant');
      const response = await fetch(relay, {
        method: 'POST',
        body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}',
      });
      expect(response.status).toBe(502);
      expect(requester).not.toHaveBeenCalled();
      expect(observed).toEqual([]);
    } finally {
      await service.onApplicationShutdown();
    }
  });

  it('pins the validated address while preserving the original TLS host', async () => {
    const resolver: RpcDnsResolver = async () => [{ address: '8.8.4.4', family: 4 }];
    const observed: Array<{ hostname: string; address: string; family: number; host: string }> = [];
    const service = boundary(resolver, fakeRequester({}, observed));
    await service.onModuleInit();
    try {
      const relay = service.relayUrl(
        'https://rpc.public.test/key?project=one',
        'tenant-a',
        'desk-a',
        'tenant',
      );
      expect(relay).not.toContain('rpc.public.test');
      expect(relay).not.toContain('project=one');
      const response = await fetch(relay, {
        method: 'POST',
        body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}',
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: null });
      expect(observed).toEqual([
        {
          hostname: 'rpc.public.test',
          address: '8.8.4.4',
          family: 4,
          host: 'rpc.public.test',
        },
      ]);
    } finally {
      await service.onApplicationShutdown();
    }
  });

  it.each([301, 302, 303, 307, 308])('does not follow an upstream %s redirect', async (status) => {
    const observed: Array<{ hostname: string; address: string; family: number; host: string }> = [];
    const requester = jest.fn(
      fakeRequester(
        { status, headers: { location: 'https://127.0.0.1/internal' } },
        observed,
      ),
    ) as unknown as RpcHttpsRequester;
    const service = boundary(
      async () => [{ address: '8.8.8.8', family: 4 }],
      requester,
    );
    await service.onModuleInit();
    try {
      const relay = service.relayUrl('https://public.test/rpc', 'a', 'b', 'tenant');
      const response = await fetch(relay, { method: 'POST', body: '{}' });
      expect(response.status).toBe(502);
      expect(requester).toHaveBeenCalledTimes(1);
    } finally {
      await service.onApplicationShutdown();
    }
  });

  it('rejects declared and streamed oversized responses', async () => {
    for (const reply of [
      { headers: { 'content-length': String(1024 * 1024 + 1) }, body: '' },
      { body: Buffer.alloc(1024 * 1024 + 1, 0x20) },
    ]) {
      const service = boundary(
        async () => [{ address: '8.8.8.8', family: 4 }],
        fakeRequester(reply, []),
      );
      await service.onModuleInit();
      try {
        const relay = service.relayUrl('https://public.test/rpc', 'a', 'b', 'tenant');
        const response = await fetch(relay, { method: 'POST', body: '{}' });
        expect(response.status).toBe(502);
      } finally {
        await service.onApplicationShutdown();
      }
    }
  });

  it('binds capabilities to a tenant/workspace and rejects tampering', async () => {
    const service = boundary(async () => [{ address: '8.8.8.8', family: 4 }]);
    await service.onModuleInit();
    try {
      const relay = service.relayUrl('https://8.8.8.8/rpc', 'tenant-a', 'desk-a', 'tenant');
      expect(service.inspect(relay, 'tenant-a', 'desk-a')).toMatchObject({
        target: 'https://8.8.8.8/rpc',
        source: 'tenant',
      });
      expect(() => service.inspect(relay, 'tenant-b', 'desk-a')).toThrow();
      const rebased = new URL(relay);
      rebased.protocol = 'https:';
      rebased.hostname = 'attacker.example';
      rebased.port = '';
      expect(() => service.inspect(rebased.href, 'tenant-a', 'desk-a')).toThrow();
      const tampered = `${relay.slice(0, -1)}${relay.endsWith('A') ? 'B' : 'A'}`;
      expect(() => service.inspect(tampered, 'tenant-a', 'desk-a')).toThrow();
      service.revokeWorkspace('tenant-a', 'desk-a');
      expect(() => service.inspect(relay, 'tenant-a', 'desk-a')).toThrow();
      const stale = await fetch(relay, { method: 'POST', body: '{}' });
      expect(stale.status).toBe(502);
    } finally {
      await service.onApplicationShutdown();
    }
  });

  it('aborts and drains an in-flight outbound request before shutdown resolves', async () => {
    let started = false;
    let aborted = false;
    const requester = ((
      _url: URL,
      options: RequestOptions,
      _callback: (response: IncomingMessage) => void,
    ): ClientRequest => {
      const request = new EventEmitter() as EventEmitter & { end(): void };
      request.end = (): void => {
        started = true;
        options.signal?.addEventListener('abort', () => {
          aborted = true;
          request.emit('error', new Error('aborted'));
        });
      };
      return request as unknown as ClientRequest;
    }) as unknown as RpcHttpsRequester;
    const service = boundary(
      async () => [{ address: '8.8.8.8', family: 4 }],
      requester,
    );
    await service.onModuleInit();
    const relay = service.relayUrl('https://public.test/rpc', 'a', 'b', 'tenant');
    const responsePromise = fetch(relay, { method: 'POST', body: '{}' });
    while (!started) await new Promise<void>((resolve) => setImmediate(resolve));

    await service.onApplicationShutdown();
    expect(aborted).toBe(true);
    await expect(responsePromise).rejects.toThrow();
  });

  it('does not start outbound HTTPS when shutdown wins an in-flight DNS race', async () => {
    let releaseDns: (() => void) | undefined;
    let dnsStarted = false;
    let dnsCalls = 0;
    const requester = jest.fn(fakeRequester({}, [])) as unknown as RpcHttpsRequester;
    const service = boundary(
      async () => {
        dnsCalls += 1;
        dnsStarted = true;
        if (dnsCalls === 1) {
          await new Promise<void>((resolve) => {
            releaseDns = resolve;
          });
        }
        return [{ address: '8.8.8.8', family: 4 }];
      },
      requester,
    );
    await service.onModuleInit();
    const relay = service.relayUrl('https://public.test/rpc', 'a', 'b', 'tenant');
    const responsePromise = fetch(relay, { method: 'POST', body: '{}' });
    while (!dnsStarted) await new Promise<void>((resolve) => setImmediate(resolve));

    const shutdown = service.onApplicationShutdown();
    releaseDns?.();
    await shutdown;
    expect(requester).not.toHaveBeenCalled();
    await expect(responsePromise).rejects.toThrow();
  });

  it('does not start outbound HTTPS when a workspace deadline wins an in-flight DNS race', async () => {
    let releaseDns: (() => void) | undefined;
    let dnsStarted = false;
    let dnsCalls = 0;
    const requester = jest.fn(fakeRequester({}, [])) as unknown as RpcHttpsRequester;
    const service = boundary(
      async () => {
        dnsCalls += 1;
        dnsStarted = true;
        if (dnsCalls === 1) {
          await new Promise<void>((resolve) => {
            releaseDns = resolve;
          });
        }
        return [{ address: '8.8.8.8', family: 4 }];
      },
      requester,
    );
    await service.onModuleInit();
    const relay = service.relayUrl('https://public.test/rpc', 'a', 'b', 'tenant');
    const responsePromise = fetch(relay, { method: 'POST', body: '{}' });
    while (!dnsStarted) await new Promise<void>((resolve) => setImmediate(resolve));
    let drained = false;
    const drain = service.waitForWorkspaceDrain('a', 'b').then(() => {
      drained = true;
    });

    const releaseAbortBlock = service.abortWorkspace('a', 'b');
    // Session close revokes capabilities before it can acquire the workspace
    // mutex. That lifecycle transition must not erase the in-flight abort.
    service.revokeWorkspace('a', 'b');
    expect(drained).toBe(false);
    releaseDns?.();
    const abortedResponse = await responsePromise;
    expect(abortedResponse.status).toBe(502);
    await drain;
    expect(drained).toBe(true);
    expect(requester).not.toHaveBeenCalled();

    const blocked = service.relayUrl('https://public.test/rpc', 'a', 'b', 'tenant');
    await fetch(blocked, { method: 'POST', body: '{}' }).then(
      (res) => expect(res.status).toBe(502),
    );
    expect(requester).not.toHaveBeenCalled();

    // A newly issued capability after the old operation drains remains usable.
    releaseAbortBlock();
    const replacement = service.relayUrl('https://public.test/rpc', 'a', 'b', 'tenant');
    await fetch(replacement, { method: 'POST', body: '{}' }).then(
      (res) => expect(res.status).toBe(200),
    );
    expect(requester).toHaveBeenCalledTimes(1);
    await service.onApplicationShutdown();
  });
});
