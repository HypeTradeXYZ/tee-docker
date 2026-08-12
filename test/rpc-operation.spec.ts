import { WativeError } from 'wative-core';
import {
  RpcOperationService,
  rpcOperationConfigFromEnv,
} from '../src/session/rpc-operation.service';
import type { Session } from '../src/session/session.registry';

describe('RPC operation configuration', () => {
  it('applies finite defaults', () => {
    expect(rpcOperationConfigFromEnv({})).toEqual({ deadlineMs: 15_000, maxPerTenant: 8 });
  });

  it.each(['', '0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992'])(
    'rejects invalid tenant capacity %p',
    (value) => {
      expect(() =>
        rpcOperationConfigFromEnv({ TEE_MAX_RPC_OPERATIONS_PER_TENANT: value }),
      ).toThrow('TEE_MAX_RPC_OPERATIONS_PER_TENANT must be a positive safe integer');
    },
  );

  it.each(['', '0', '-1', '1.5', 'NaN', 'Infinity', '15001'])(
    'rejects invalid deadline %p',
    (value) => {
      expect(() => rpcOperationConfigFromEnv({ TEE_RPC_DEADLINE_MS: value })).toThrow(
        /TEE_RPC_DEADLINE_MS/,
      );
    },
  );
});

describe('RpcOperationService', () => {
  const session = { tenantId: 'acme', workspaceSlug: 'desk-a' } as Session;

  it('fails fast per tenant, isolates tenants, and releases the permit', async () => {
    const service = new RpcOperationService(
      { deadlineMs: 100, maxPerTenant: 1 },
      { abortWorkspace: jest.fn() } as never,
    );
    let finish!: () => void;
    const held = service.withPermit(
      'acme',
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    await Promise.resolve();

    await expect(service.withPermit('acme', async () => undefined)).rejects.toMatchObject({
      code: 'TEE_RPC_CAPACITY',
      details: { scope: 'tenant', limit: 1 },
    });
    await expect(service.withPermit('globex', async () => 'ok')).resolves.toBe('ok');

    finish();
    await held;
    await expect(service.withPermit('acme', async () => 'again')).resolves.toBe('again');
  });

  it('aborts transport at the deadline but retains the permit until core settles', async () => {
    const releaseAbortBlock = jest.fn();
    const boundary = { abortWorkspace: jest.fn(() => releaseAbortBlock) };
    const service = new RpcOperationService(
      { deadlineMs: 10, maxPerTenant: 1 },
      boundary as never,
    );
    let settle!: () => void;
    const operation = service.withPermit('acme', () =>
      service.run(
        session,
        'transaction',
        () => new Promise<void>((resolve) => (settle = resolve)),
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(boundary.abortWorkspace).toHaveBeenCalledWith('acme', 'desk-a');
    await expect(service.withPermit('acme', async () => undefined)).rejects.toMatchObject({
      code: 'TEE_RPC_CAPACITY',
    });

    settle();
    await expect(operation).rejects.toMatchObject({ code: 'TX_TIMEOUT' });
    expect(releaseAbortBlock).toHaveBeenCalledTimes(1);
    await expect(service.withPermit('acme', async () => undefined)).resolves.toBeUndefined();
  });

  it('preserves prompt transport errors and maps read deadlines separately', async () => {
    const boundary = { abortWorkspace: jest.fn(() => jest.fn()) };
    const service = new RpcOperationService(
      { deadlineMs: 10, maxPerTenant: 1 },
      boundary as never,
    );
    const prompt = new WativeError('RPC_UNREACHABLE', 'fast failure');
    await expect(
      service.run(session, 'transaction', async () => Promise.reject(prompt)),
    ).rejects.toBe(prompt);

    await expect(
      service.run(
        session,
        'read',
        () => new Promise<void>((resolve) => setTimeout(resolve, 20)),
      ),
    ).rejects.toMatchObject({ code: 'TEE_RPC_UNREACHABLE' });
  });
});
