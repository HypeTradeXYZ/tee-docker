import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { TeeError } from '../common/tee-error';

const WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT = 10;
const DEFAULT_COOLDOWN_SEC = 60;
const MAX_RATE_LIMIT = 10_000;
/** Operationally generous while keeping configuration mistakes bounded. */
const MAX_COOLDOWN_SEC = 31_536_000;
const PositiveSafeInteger = z.number().int().positive().safe();
const CoercedPositiveSafeInteger = z.coerce.number().int().positive().safe();

export const WORKSPACE_CREATION_CLOCK = Symbol('WORKSPACE_CREATION_CLOCK');
export type WorkspaceCreationClock = () => number;
export const WORKSPACE_CREATION_CONFIG = Symbol('WORKSPACE_CREATION_CONFIG');

export interface WorkspaceCreationConfig {
  readonly maxPerMinute: number;
  readonly recreateCooldownMs: number;
}

export function workspaceCreationConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceCreationConfig {
  const maxPerMinute = parse(
    env,
    'TEE_WORKSPACE_CREATE_RATE_LIMIT',
    DEFAULT_RATE_LIMIT,
    MAX_RATE_LIMIT,
  );
  const cooldownSec = parse(
    env,
    'TEE_WORKSPACE_RECREATE_COOLDOWN_SEC',
    DEFAULT_COOLDOWN_SEC,
    MAX_COOLDOWN_SEC,
  );
  return { maxPerMinute, recreateCooldownMs: cooldownSec * 1_000 };
}

function parse(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const value = env[name];
  const parsed = CoercedPositiveSafeInteger.max(max).safeParse(
    value === undefined ? fallback : value,
  );
  if (!parsed.success) throw new Error(`${name} must be a positive safe integer at most ${max}`);
  return parsed.data;
}

/** Dedicated tenant creation budget; token mint and account unlock remain independent. */
@Injectable()
export class WorkspaceCreationLimiter {
  readonly #hits = new Map<string, number[]>();
  readonly #now: WorkspaceCreationClock;
  readonly config: WorkspaceCreationConfig;

  constructor(
    @Inject(WORKSPACE_CREATION_CONFIG) config: WorkspaceCreationConfig,
    @Inject(WORKSPACE_CREATION_CLOCK) clock: WorkspaceCreationClock,
  ) {
    const rate = PositiveSafeInteger.max(MAX_RATE_LIMIT).safeParse(config.maxPerMinute);
    const cooldown = PositiveSafeInteger.max(Number.MAX_SAFE_INTEGER).safeParse(
      config.recreateCooldownMs,
    );
    if (!rate.success || !cooldown.success) {
      throw new Error('workspace creation limiter config must contain positive safe integers');
    }
    this.config = config;
    this.#now = clock;
  }

  /**
   * Admit and charge one creation. The returned rollback is only for a failed
   * ledger reservation before core is reached; once provisioning starts the
   * charge is deliberately permanent.
   */
  admit(tenantId: string, recreateAfter?: number): () => void {
    const now = this.#now();
    const cutoff = now - WINDOW_MS;
    const recent = (this.#hits.get(tenantId) ?? []).filter((hit) => hit > cutoff);
    if (recent.length === 0) this.#hits.delete(tenantId);
    else this.#hits.set(tenantId, recent);

    const rateRetryAt = recent.length >= this.config.maxPerMinute
      ? recent[0]! + WINDOW_MS
      : 0;
    const cooldownRetryAt = recreateAfter !== undefined && recreateAfter > now
      ? recreateAfter
      : 0;
    const retryAt = Math.max(rateRetryAt, cooldownRetryAt);
    if (retryAt > now) {
      const code = cooldownRetryAt >= rateRetryAt
        ? 'TEE_WORKSPACE_RECREATE_COOLDOWN'
        : 'TEE_WORKSPACE_CREATE_RATE';
      throw new TeeError(code, 'workspace creation is temporarily unavailable', {
        retryAfterSec: Math.max(1, Math.ceil((retryAt - now) / 1_000)),
      });
    }

    recent.push(now);
    this.#hits.set(tenantId, recent);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const hits = this.#hits.get(tenantId);
      if (!hits) return;
      const index = hits.indexOf(now);
      if (index >= 0) hits.splice(index, 1);
      if (hits.length === 0) this.#hits.delete(tenantId);
    };
  }

  now(): number {
    return this.#now();
  }

  recreateAfter(): number {
    return Math.min(Number.MAX_SAFE_INTEGER, this.#now() + this.config.recreateCooldownMs);
  }
}
