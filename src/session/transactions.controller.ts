import { Body, Controller, Get, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import {
  WativeError,
  type Address,
  type Transaction,
  type TransactionTracker,
} from 'wative-core';
import { TeeError } from '../common/tee-error';
import { CurrentSession, CurrentTokenTenant, WorkspaceGuard } from '../auth/workspace.guard';
import { RequireScopes, ScopesGuard } from '../auth/scopes.guard';
import type { Tenant } from '../config/schemas';
import { requireRpc } from './rpc';
import { SessionRegistry, type Session } from './session.registry';
import { RpcBoundaryService } from './rpc-boundary.service';
import { projectBuiltTransaction } from './transaction-projector';
import { RpcOperation, RpcOperationService } from './rpc-operation.service';
import { parseNetworkSelector } from './network-selector';

/** bigint-valued fields arrive as decimal strings — JSON has no bigint. */
const bigintish = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]);

const BuildBody = z.object({
  address: z.string().min(1),
  // EVM
  to: z.string().min(1).optional(),
  value: bigintish.optional(),
  data: z.string().optional(),
  nonce: z.number().int().nonnegative().optional(),
  gasLimit: bigintish.optional(),
  maxFeePerGas: bigintish.optional(),
  maxPriorityFeePerGas: bigintish.optional(),
  // SVM
  recipient: z.string().min(1).optional(),
  amount: bigintish.optional(),
  tokenMint: z.string().optional(),
  recentBlockhash: z.string().optional(),
});

const toBig = (v: string | number | undefined): bigint | undefined =>
  v === undefined ? undefined : BigInt(v);

/**
 * Transactions — rung 3 of DESIGN §7: build, simulate, submit. No lifecycle
 * tracking, which would need durable per-tx state and background workers.
 *
 * Status is a stateless RPC passthrough instead: callers poll it if they care.
 */
@Controller('transactions')
@UseGuards(WorkspaceGuard, ScopesGuard)
@RequireScopes('sign')
export class TransactionsController {
  constructor(
    private readonly sessions: SessionRegistry,
    private readonly rpcBoundary: RpcBoundaryService,
    private readonly rpcOperations: RpcOperationService,
  ) {}

  @Post('build')
  @HttpCode(200)
  @RpcOperation()
  async build(
    @CurrentSession() session: Session,
    @CurrentTokenTenant() tenant: Tenant,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ raw: unknown; vm: string; network: string }> {
    const { address, tx } = await this.prepare(session, tenant, body, res);
    return {
      raw: await this.rpcOperations.run(session, 'transaction', () => projectBuiltTransaction(tx)),
      vm: address.vm,
      network: String(address.network.slug),
    };
  }

  @Post('simulate')
  @HttpCode(200)
  @RpcOperation()
  async simulate(
    @CurrentSession() session: Session,
    @CurrentTokenTenant() tenant: Tenant,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ success: boolean; error?: string; gasUsed?: string; logs?: readonly string[] }> {
    const { address, tx } = await this.prepare(session, tenant, body, res);
    const sim = await this.rpcOperations.run(session, 'transaction', () =>
      address.simulateTransaction(tx),
    );
    assertSimulationTransport(sim);
    return {
      success: sim.success,
      ...(sim.error !== undefined ? { error: sim.error } : {}),
      ...(sim.gasUsed !== undefined ? { gasUsed: sim.gasUsed.toString() } : {}),
      ...(sim.logs !== undefined ? { logs: sim.logs } : {}),
    };
  }

  /**
   * Build, sign, submit. Returns as soon as the network accepts it.
   *
   * The nonce is never cached: the service does not exclusively own these
   * addresses, so pretending to manage nonces would be worse than letting the
   * RPC assign one and accepting the occasional race (DESIGN §1).
   */
  @Post('send')
  @HttpCode(202)
  @RpcOperation()
  async send(
    @CurrentSession() session: Session,
    @CurrentTokenTenant() tenant: Tenant,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ hash: string; status: string; network: string }> {
    const { address, tx } = await this.prepare(session, tenant, body, res);
    return submitTransaction(
      tx,
      address,
      session,
      this.rpcOperations,
      this.rpcBoundary,
      String(address.network.slug),
    );
  }

  /** Stateless status lookup — one RPC call, no stored state. */
  @Get(':hash')
  @RpcOperation()
  async status(
    @CurrentSession() session: Session,
    @CurrentTokenTenant() tenant: Tenant,
    @Param('hash') hash: string,
    @Query('network') network: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ hash: string; found: boolean; status: string }> {
    const selectedNetwork = parseNetworkSelector(network);

    const rpc = requireRpc(session, tenant, selectedNetwork, this.rpcBoundary);
    res.setHeader('x-rpc-source', rpc.source);

    const net = session.handle.networks.bySlug(selectedNetwork as never);
    const isEvm = net?.vm === 'evm';

    const payload = isEvm
      ? { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash] }
      : { jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses', params: [[hash], { searchTransactionHistory: true }] };

    const raw = await this.rpcOperations.run(session, 'read', () =>
      jsonRpc(rpc.url as string, payload, this.rpcOperations.config.deadlineMs),
    );
    const result = isEvm
      ? (raw as { result?: { status?: string } | null }).result
      : ((raw as { result?: { value?: unknown[] } }).result?.value?.[0] ?? null);

    if (!result) return { hash, found: false, status: 'pending' };

    const status = isEvm
      ? (result as { status?: string }).status === '0x1'
        ? 'confirmed'
        : 'failed'
      : ((result as { err?: unknown }).err ? 'failed' : 'confirmed');

    return { hash, found: true, status };
  }

  /** Resolve the address, build the tx with the tenant's RPC, stamp the source. */
  private async prepare(
    session: Session,
    tenant: Tenant,
    body: unknown,
    res: Response,
  ): Promise<{ address: Address; tx: Transaction }> {
    const parsed = BuildBody.safeParse(body);
    if (!parsed.success) {
      throw new TeeError('TEE_INVALID_BODY', 'body must name an address and a destination');
    }

    const address = await this.resolveAddress(session, parsed.data.address);
    const slug = String(address.network.slug);
    const rpc = requireRpc(session, tenant, slug, this.rpcBoundary);
    res.setHeader('x-rpc-source', rpc.source);

    const d = parsed.data;
    if (address.vm === 'evm') {
      if (!d.to) throw new TeeError('TEE_INVALID_BODY', 'an EVM transaction needs "to"');
      return {
        address,
        tx: address.buildTransaction({
          to: d.to,
          value: toBig(d.value),
          data: d.data,
          nonce: d.nonce,
          gasLimit: toBig(d.gasLimit),
          maxFeePerGas: toBig(d.maxFeePerGas),
          maxPriorityFeePerGas: toBig(d.maxPriorityFeePerGas),
          rpcUrl: rpc.url as string,
        }),
      };
    }

    if (!d.recipient || d.amount === undefined) {
      throw new TeeError('TEE_INVALID_BODY', 'an SVM transaction needs "recipient" and "amount"');
    }
    return {
      address,
      tx: address.buildTransaction({
        recipient: d.recipient,
        amount: toBig(d.amount) as bigint,
        tokenMint: d.tokenMint,
        recentBlockhash: d.recentBlockhash,
        rpcUrl: rpc.url as string,
      }),
    };
  }

  private async resolveAddress(session: Session, publicKey: string): Promise<Address> {
    const found = session.handle.filter(publicKey, 'Address');
    if (!found) throw new TeeError('TEE_ACCOUNT_NOT_FOUND', `address "${publicKey}" not found`);

    const owner = session.handle.accounts.find((a) =>
      a.wallets.some((w) => w.addresses.some((addr) => addr.publicKey === found.publicKey)),
    );
    if (!owner) throw new TeeError('TEE_ACCOUNT_NOT_FOUND', `address "${publicKey}" has no account`);

    await this.sessions.requireAccount(session, String(owner.slug));
    return found;
  }
}

interface SendAddress {
  sendTransaction(transaction: Transaction): TransactionTracker;
}

interface SendOperations {
  run<T>(
    session: Session,
    kind: 'transaction',
    operation: () => Promise<T>,
  ): Promise<T>;
}

interface SendBoundary {
  abortWorkspace(tenantId: string, workspaceSlug: string): () => void;
  waitForWorkspaceDrain(tenantId: string, workspaceSlug: string): Promise<void>;
}

export interface SendView {
  readonly hash: string;
  readonly status: 'pending' | 'unknown';
  readonly network: string;
}

/**
 * Capture the offline-signed lookup identifier before submission. A terminal
 * core `timeout` means the bytes may have left the process, so return 202 with
 * `unknown` and require a status lookup before retrying. A terminal `failed`
 * is an explicit endpoint refusal and remains the mapped error.
 */
export async function submitTransaction(
  tx: Transaction,
  address: SendAddress,
  session: Session,
  operations: SendOperations,
  boundary: SendBoundary,
  network: string,
): Promise<SendView> {
  let signedHash: string | null = null;
  let tracker: TransactionTracker | undefined;
  let sendStarted = false;
  let submissionKnown = false;

  try {
    return await operations.run(session, 'transaction', async () => {
      // Transaction.sign() is the awaitable primitive. Address.signTransaction
      // returns before async signing has populated the canonical hash in 2.4.4.
      const signed = await tx.sign();
      signedHash = requireSignedTransactionId(signed);
      sendStarted = true;
      tracker = address.sendTransaction(signed);
      await tracker.whenSubmitted();

      // SVM can resolve the waiter after detecting an unusable acknowledgement;
      // tracker state, not the returned endpoint value, is authoritative.
      if (tracker.status === 'timeout') {
        return { hash: signedHash, status: 'unknown', network };
      }
      if (tracker.status === 'failed') {
        throw new WativeError('TX_SUBMIT_FAILED', 'transaction was refused by the endpoint');
      }

      submissionKnown = true;
      try {
        await stopSubmittedTracker(tracker, boundary, session);
      } catch {
        // Never suppress a network-known identifier with an internal cleanup
        // failure. Retire the singleton after the interceptor releases its
        // mutex so no failed tracker can overlap later core work.
        session.unusable = true;
      }
      return { hash: signedHash, status: 'pending', network };
    });
  } catch (error) {
    // The H-06 timer may win after validated submission while cleanup drains.
    // A known lookup identifier always takes precedence over an internal 5xx.
    if (submissionKnown && signedHash) {
      return { hash: signedHash, status: 'pending', network };
    }
    if (
      sendStarted &&
      signedHash &&
      (tracker === undefined || tracker.status === 'timeout')
    ) {
      return { hash: signedHash, status: 'unknown', network };
    }
    throw error;
  }
}

function requireSignedTransactionId(
  transaction: Transaction,
): string {
  const hash = (transaction as Transaction & { readonly hash?: unknown }).hash;
  const valid = transaction.vm === 'evm'
    ? typeof hash === 'string' && /^0x[0-9a-f]{64}$/.test(hash)
    : transaction.vm === 'svm'
      ? typeof hash === 'string' && isBase58Bytes(hash, 64)
      : false;
  if (!valid) {
    throw new WativeError('TX_SIGN_FAILED', 'signed transaction has no canonical identifier');
  }
  return hash as string;
}

function isBase58Bytes(value: string, expectedBytes: number): boolean {
  if (!value || value.length > 96) return false;
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let decoded = 0n;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) return false;
    decoded = decoded * 58n + BigInt(digit);
  }
  let bodyBytes = 0;
  while (decoded > 0n) {
    bodyBytes += 1;
    decoded >>= 8n;
  }
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === '1') leadingZeroes += 1;
  return leadingZeroes + bodyBytes === expectedBytes;
}

/**
 * A network-known identifier makes it safe to stop background receipt polling.
 * Block the relay first, abort the tracker, then drain a poll already in flight
 * before the workspace mutex and tenant permit can be released.
 */
export async function stopSubmittedTracker(
  tracker: Pick<TransactionTracker, 'abort'>,
  boundary: SendBoundary,
  session: Pick<Session, 'tenantId' | 'workspaceSlug'>,
): Promise<void> {
  const releaseAbortBlock = boundary.abortWorkspace(session.tenantId, session.workspaceSlug);
  const failures: unknown[] = [];
  try {
    try {
      tracker.abort();
    } catch (error) {
      failures.push(error);
    }
    try {
      await boundary.waitForWorkspaceDrain(session.tenantId, session.workspaceSlug);
    } catch (error) {
      failures.push(error);
    }
  } finally {
    try {
      releaseAbortBlock();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'transaction tracker cleanup failed');
}

export function assertSimulationTransport(sim: {
  readonly success: boolean;
  readonly raw?: unknown;
}): void {
  if (sim.success) return;
  if (
    sim.raw instanceof WativeError &&
    ['RPC_UNREACHABLE', 'RPC_REJECTED', 'TX_TIMEOUT'].includes(sim.raw.code)
  ) {
    throw sim.raw;
  }
  // wative-core 2.4.4's SVM adapter returns a plain Error for transport
  // rejection, while ordinary on-chain simulation failures carry structured
  // RPC data. Never render the transport failure as HTTP 200.
  if (sim.raw instanceof Error) {
    throw new TeeError('TEE_RPC_UNREACHABLE', 'RPC simulation did not complete');
  }
}

async function jsonRpc(url: string, payload: unknown, deadlineMs: number): Promise<unknown> {
  let response: globalThis.Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(deadlineMs),
      redirect: 'error',
    });
  } catch (cause) {
    throw new TeeError('TEE_RPC_UNREACHABLE', 'RPC endpoint did not respond');
  }

  if (!response.ok) {
    throw new TeeError('TEE_RPC_UNREACHABLE', `RPC endpoint returned ${response.status}`);
  }
  return response.json();
}
