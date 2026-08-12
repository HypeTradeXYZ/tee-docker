import { Body, Controller, Get, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import type { Address, Transaction } from 'wative-core';
import { TeeError } from '../common/tee-error';
import { CurrentSession, CurrentTokenTenant, WorkspaceGuard } from '../auth/workspace.guard';
import { RequireScopes, ScopesGuard } from '../auth/scopes.guard';
import type { Tenant } from '../config/schemas';
import { requireRpc } from './rpc';
import { SessionRegistry, type Session } from './session.registry';
import { RpcBoundaryService } from './rpc-boundary.service';
import { projectBuiltTransaction } from './transaction-projector';

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
  ) {}

  @Post('build')
  @HttpCode(200)
  async build(
    @CurrentSession() session: Session,
    @CurrentTokenTenant() tenant: Tenant,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ raw: unknown; vm: string; network: string }> {
    const { address, tx } = await this.prepare(session, tenant, body, res);
    return {
      raw: await projectBuiltTransaction(tx),
      vm: address.vm,
      network: String(address.network.slug),
    };
  }

  @Post('simulate')
  @HttpCode(200)
  async simulate(
    @CurrentSession() session: Session,
    @CurrentTokenTenant() tenant: Tenant,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ success: boolean; error?: string; gasUsed?: string; logs?: readonly string[] }> {
    const { address, tx } = await this.prepare(session, tenant, body, res);
    const sim = await address.simulateTransaction(tx);
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
  async send(
    @CurrentSession() session: Session,
    @CurrentTokenTenant() tenant: Tenant,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ hash: string; status: string; network: string }> {
    const { address, tx } = await this.prepare(session, tenant, body, res);

    const signed = address.signTransaction(tx);
    const tracker = address.sendTransaction(signed);
    const hash = await tracker.whenSubmitted();

    return { hash, status: tracker.status, network: String(address.network.slug) };
  }

  /** Stateless status lookup — one RPC call, no stored state. */
  @Get(':hash')
  async status(
    @CurrentSession() session: Session,
    @CurrentTokenTenant() tenant: Tenant,
    @Param('hash') hash: string,
    @Query('network') network: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ hash: string; found: boolean; status: string }> {
    if (!network) {
      throw new TeeError('TEE_INVALID_SLUG', 'a ?network= query parameter is required');
    }

    const rpc = requireRpc(session, tenant, network, this.rpcBoundary);
    res.setHeader('x-rpc-source', rpc.source);

    const net = session.handle.networks.bySlug(network as never);
    const isEvm = net?.vm === 'evm';

    const payload = isEvm
      ? { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash] }
      : { jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses', params: [[hash], { searchTransactionHistory: true }] };

    const raw = await jsonRpc(rpc.url as string, payload);
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
      throw new TeeError('TEE_INVALID_SLUG', 'body must name an address and a destination');
    }

    const address = await this.resolveAddress(session, parsed.data.address);
    const slug = String(address.network.slug);
    const rpc = requireRpc(session, tenant, slug, this.rpcBoundary);
    res.setHeader('x-rpc-source', rpc.source);

    const d = parsed.data;
    if (address.vm === 'evm') {
      if (!d.to) throw new TeeError('TEE_INVALID_SLUG', 'an EVM transaction needs "to"');
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
      throw new TeeError('TEE_INVALID_SLUG', 'an SVM transaction needs "recipient" and "amount"');
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

async function jsonRpc(url: string, payload: unknown): Promise<unknown> {
  let response: globalThis.Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
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
