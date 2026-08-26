import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { retryAfterSeconds } from '../common/retry-after';
import { TeeError } from '../common/tee-error';

/** Sliding window. Small numbers because each mint costs a real KDF. */
const WINDOW_MS = 60_000;
const DEFAULT_MAX_PER_WINDOW = 10;
// An operator-trust ceiling on a config value, matching WorkspaceCreationLimiter
// — it catches typos and keeps a bucket small. It is NOT the safety bound on
// mint cost: that is the KDF, and at this ceiling a tenant may authorise far
// more derivation than one core can serve. Setting it high is a deliberate act.
const MAX_RATE_LIMIT = 10_000;
const CoercedPositiveSafeInteger = z.coerce
  .number()
  .int()
  .positive()
  .safe()
  .max(MAX_RATE_LIMIT);
const PositiveSafeInteger = z.number().int().positive().safe().max(MAX_RATE_LIMIT);

export function mintRateLimitFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.TEE_MINT_RATE_LIMIT;
  const parsed = CoercedPositiveSafeInteger.safeParse(
    value === undefined ? DEFAULT_MAX_PER_WINDOW : value,
  );
  if (!parsed.success) {
    throw new Error(`TEE_MINT_RATE_LIMIT must be an integer between 1 and ${MAX_RATE_LIMIT}`);
  }
  return parsed.data;
}

/**
 * Rate limit on token minting, per tenant.
 *
 * Minting is the one endpoint where a single caller can consume the whole
 * service's CPU: every mint pays an Argon2 derivation (~130ms on the native
 * backend, seconds if a deployment falls back to pure JS). General request
 * limits do not help, because the cost is not in the request count.
 *
 * The budget is shared with account unlock, which pays the same derivation, so
 * one caller cannot dodge the ceiling by alternating between the two.
 */
@Injectable()
export class MintRateLimiter {
  private readonly logger = new Logger(MintRateLimiter.name);
  // Keyed only by authenticated tenant ids, so the key set is the boot-time
  // tenant table and each bucket holds at most MAX_RATE_LIMIT timestamps.
  readonly #hits = new Map<string, number[]>();
  private readonly maxPerWindow: number;

  constructor(maxPerWindow: number) {
    const parsed = PositiveSafeInteger.safeParse(maxPerWindow);
    if (!parsed.success) {
      throw new Error(`mint rate limit must be an integer between 1 and ${MAX_RATE_LIMIT}`);
    }
    this.maxPerWindow = parsed.data;
  }

  get limit(): number {
    return this.maxPerWindow;
  }

  /** Retained timestamps per tenant, so the bound can be asserted rather than read. */
  get bucketSizes(): number[] {
    return [...this.#hits.values()].map((times) => times.length);
  }

  /** Record an attempt, or throw if the tenant is over its budget. */
  check(tenantId: string): void {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;

    const recent = (this.#hits.get(tenantId) ?? []).filter((t) => t > cutoff);

    if (recent.length >= this.maxPerWindow) {
      // Keep the window as-is; a rejected attempt costs no KDF, so it must not
      // extend the penalty and turn a burst into a lockout.
      this.#hits.set(tenantId, recent);
      this.logger.warn(`mint rate limit hit for tenant=${tenantId}`);
      throw new TeeError(
        'TEE_UNLOCK_CAPACITY',
        `too many token requests; limit is ${this.maxPerWindow} per minute`,
        { retryAfterSec: retryAfterSeconds(recent[0]! + WINDOW_MS, now, WINDOW_MS / 1000) },
      );
    }

    recent.push(now);
    this.#hits.set(tenantId, recent);
  }
}
