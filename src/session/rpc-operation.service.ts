import { Inject, Injectable, SetMetadata } from '@nestjs/common';
import { WativeError } from 'wative-core';
import { z } from 'zod';
import { TeeError } from '../common/tee-error';
import type { Session } from './session.registry';
import { RpcBoundaryService } from './rpc-boundary.service';

export const RPC_OPERATION = 'tee:rpc-operation';
export const RpcOperation = () => SetMetadata(RPC_OPERATION, true);
export const RPC_OPERATION_CONFIG = Symbol('tee:rpc-operation-config');

export interface RpcOperationConfig {
  readonly deadlineMs: number;
  readonly maxPerTenant: number;
}

const PositiveSafeInteger = z.coerce.number().int().positive().safe();

export function rpcOperationConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RpcOperationConfig {
  const deadlineMs = parse(env, 'TEE_RPC_DEADLINE_MS', 15_000);
  if (deadlineMs > 15_000) {
    throw new Error('TEE_RPC_DEADLINE_MS must be at most 15000');
  }
  return {
    deadlineMs,
    maxPerTenant: parse(env, 'TEE_MAX_RPC_OPERATIONS_PER_TENANT', 8),
  };
}

function parse(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name];
  const parsed = PositiveSafeInteger.safeParse(value === undefined ? fallback : value);
  if (!parsed.success) throw new Error(`${name} must be a positive safe integer`);
  return parsed.data;
}

@Injectable()
export class RpcOperationService {
  readonly #activeByTenant = new Map<string, number>();

  constructor(
    @Inject(RPC_OPERATION_CONFIG) readonly config: RpcOperationConfig,
    private readonly boundary: RpcBoundaryService,
  ) {}

  /** Fail-fast tenant admission. The interceptor calls this before the workspace mutex. */
  async withPermit<T>(tenantId: string, operation: () => Promise<T>): Promise<T> {
    const active = this.#activeByTenant.get(tenantId) ?? 0;
    if (active >= this.config.maxPerTenant) {
      throw new TeeError('TEE_RPC_CAPACITY', 'tenant RPC operation capacity reached', {
        scope: 'tenant',
        limit: this.config.maxPerTenant,
      });
    }
    this.#activeByTenant.set(tenantId, active + 1);
    try {
      return await operation();
    } finally {
      const remaining = (this.#activeByTenant.get(tenantId) ?? 1) - 1;
      if (remaining <= 0) this.#activeByTenant.delete(tenantId);
      else this.#activeByTenant.set(tenantId, remaining);
    }
  }

  /**
   * Apply tee-docker's shorter operation deadline while retaining the permit
   * and workspace mutex until core actually settles. The timer aborts the
   * relay transport; it never calls TransactionTracker.abort(), which can
   * destroy an uncertain broadcast outcome without cancelling its fetch.
   */
  async run<T>(
    session: Session,
    kind: 'transaction' | 'read',
    operation: () => Promise<T>,
  ): Promise<T> {
    let expired = false;
    let releaseAbortBlock: (() => void) | undefined;
    const timer = setTimeout(() => {
      expired = true;
      releaseAbortBlock = this.boundary.abortWorkspace(
        session.tenantId,
        session.workspaceSlug,
      );
    }, this.config.deadlineMs);
    timer.unref();

    try {
      const result = await operation();
      if (expired) throw timeout(kind);
      return result;
    } catch (error) {
      if (expired) throw timeout(kind);
      throw error;
    } finally {
      clearTimeout(timer);
      releaseAbortBlock?.();
    }
  }
}

function timeout(kind: 'transaction' | 'read'): Error {
  return kind === 'transaction'
    ? new WativeError('TX_TIMEOUT', 'RPC operation deadline exceeded')
    : new TeeError('TEE_RPC_UNREACHABLE', 'RPC operation deadline exceeded');
}
