import { Network } from 'wative-core';
import type { Tenant } from '../src/config/schemas';
import { NetworksController } from '../src/session/networks.controller';
import type { RpcBoundaryService } from '../src/session/rpc-boundary.service';
import type { Session } from '../src/session/session.registry';

const OLD_RELAY = 'http://127.0.0.1:1234/rpc/old';
const NEW_RELAY = 'http://127.0.0.1:1234/rpc/new';

function network(rpcUrl = OLD_RELAY): Network {
  return new Network({
    slug: 'ethereum' as never,
    name: 'Ethereum',
    chainId: 1 as never,
    rpcUrl,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    vm: 'evm',
  });
}

function fixture() {
  const events: string[] = [];
  const old = network();
  let current = old;
  const update = jest.fn(async (next: Network) => {
    events.push(`update:${String(next.rpcUrl)}`);
    current = next;
  });
  const boundary = {
    admit: jest.fn(async () => 'https://rpc.public.test/'),
    relayUrl: jest.fn(() => NEW_RELAY),
    rebindNetwork: jest.fn(() => events.push('rebind')),
    inspect: jest.fn(() => {
      events.push('resolve');
      return { source: 'tenant', target: 'https://rpc.public.test/' };
    }),
    revokeCapability: jest.fn((url: string) => events.push(`revoke:${url}`)),
  } as unknown as RpcBoundaryService;
  const session = {
    workspaceSlug: 'desk-a',
    unusable: false,
    handle: { networks: { bySlug: () => current, update } },
  } as unknown as Session;
  const tenant = { id: 'acme', allowDefaultRpc: false } as Tenant;
  return {
    events,
    old,
    update,
    boundary,
    session,
    tenant,
    controller: new NetworksController(boundary),
    current: () => current,
  };
}

describe('network RPC source update', () => {
  it('derives source only after update/rebind and revokes old last', async () => {
    const f = fixture();
    await expect(f.controller.setRpc(
      f.session,
      f.tenant,
      'ethereum',
      { rpcUrl: 'https://rpc.public.test/' },
    )).resolves.toEqual({ network: 'ethereum', rpcSource: 'tenant' });
    expect(f.events).toEqual([
      `update:${NEW_RELAY}`,
      'rebind',
      'resolve',
      `revoke:${OLD_RELAY}`,
    ]);
    expect(String(f.current().rpcUrl)).toBe(NEW_RELAY);
  });

  it('rolls back post-persist resolution failure before revoking the new capability', async () => {
    const f = fixture();
    jest.mocked(f.boundary.inspect).mockImplementation(() => {
      f.events.push('resolve');
      throw new Error('resolution probe');
    });
    await expect(f.controller.setRpc(
      f.session,
      f.tenant,
      'ethereum',
      { rpcUrl: 'https://rpc.public.test/' },
    )).rejects.toThrow('resolution probe');
    expect(f.events).toEqual([
      `update:${NEW_RELAY}`,
      'rebind',
      'resolve',
      `update:${OLD_RELAY}`,
      'rebind',
      `revoke:${NEW_RELAY}`,
    ]);
    expect(f.current()).toBe(f.old);
    expect(f.session.unusable).toBe(false);
  });

  it('marks the singleton unusable when rollback cannot restore a valid registry', async () => {
    const f = fixture();
    jest.mocked(f.boundary.inspect).mockImplementation(() => {
      throw new Error('resolution probe');
    });
    f.update
      .mockImplementationOnce(async (next: Network) => {
        f.events.push(`update:${String(next.rpcUrl)}`);
      })
      .mockRejectedValueOnce(new Error('rollback probe'));
    await expect(f.controller.setRpc(
      f.session,
      f.tenant,
      'ethereum',
      { rpcUrl: 'https://rpc.public.test/' },
    )).rejects.toBeInstanceOf(AggregateError);
    expect(f.session.unusable).toBe(true);
    expect(f.boundary.revokeCapability).not.toHaveBeenCalledWith(NEW_RELAY);
  });
});
