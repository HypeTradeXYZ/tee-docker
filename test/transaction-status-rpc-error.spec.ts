import { TransactionsController } from '../src/session/transactions.controller';

/**
 * transaction-status-rpc-error — a broken endpoint must not look like a mempool.
 *
 * `GET /v1/transactions/:hash` reads the `result` member of a JSON-RPC reply and
 * reports `pending` when it is absent. A JSON-RPC *error* also arrives with HTTP
 * 200 and no `result`, so an unsupported method, a rate-limited key or a
 * rejected hash used to be indistinguishable from "not mined yet" — a lookup the
 * caller would poll forever while the docs told them a pending transaction may
 * still land.
 */
describe('transaction-status-rpc-error', () => {
  const tenant = { id: 'acme', rpc: { ethereum: 'https://rpc.test/eth' } } as never;
  const res = { setHeader: jest.fn() } as never;

  /** Drives the real handler with a stubbed relay reply. */
  const statusWith = async (reply: unknown) => {
    const session = {
      handle: {
        networks: {
          bySlug: () => ({ slug: 'ethereum', vm: 'evm', rpcUrl: 'https://rpc.test/eth' }),
        },
      },
      workspaceSlug: 'desk-a',
      tenantId: 'acme',
    } as never;
    const sessions = { requireAccount: jest.fn() };
    const rpcBoundary = { inspect: () => ({ source: 'tenant' }) };
    const rpcOperations = {
      config: { deadlineMs: 1_000 },
      run: async (_s: unknown, _k: unknown, fn: () => Promise<unknown>) => fn(),
    };

    const controller = new TransactionsController(
      sessions as never,
      rpcBoundary as never,
      rpcOperations as never,
    );

    // Stand in for the network hop: the handler's own JSON-RPC helper is module
    // private, so the fetch it ultimately performs is what gets replaced.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(reply), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    try {
      return await controller.status(session, tenant, '0xabc', 'ethereum', res);
    } finally {
      globalThis.fetch = originalFetch;
    }
  };

  it('reports a JSON-RPC error as an endpoint rejection, not as pending', async () => {
    await expect(
      statusWith({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } }),
    ).rejects.toMatchObject({ code: 'RPC_REJECTED' });
  });

  it('still reports a genuinely unmined transaction as pending', async () => {
    await expect(statusWith({ jsonrpc: '2.0', id: 1, result: null })).resolves.toMatchObject({
      found: false,
      status: 'pending',
    });
  });

  it('still reports a mined transaction as confirmed', async () => {
    await expect(
      statusWith({ jsonrpc: '2.0', id: 1, result: { status: '0x1' } }),
    ).resolves.toMatchObject({ found: true, status: 'confirmed' });
  });
});
