import { Injectable, Logger } from '@nestjs/common';
import { TeeError } from '../common/tee-error';

/** Sliding window. Small numbers because each mint costs a real KDF. */
const WINDOW_MS = 60_000;
const DEFAULT_MAX_PER_WINDOW = 10;

/**
 * Rate limit on token minting, per tenant.
 *
 * Minting is the one endpoint where a single caller can consume the whole
 * service's CPU: every mint pays an Argon2 derivation (~130ms on the native
 * backend, seconds if a deployment falls back to pure JS). General request
 * limits do not help, because the cost is not in the request count.
 *
 * DESIGN.md §10.
 */
@Injectable()
export class MintRateLimiter {
  private readonly logger = new Logger(MintRateLimiter.name);
  readonly #hits = new Map<string, number[]>();

  constructor(private readonly maxPerWindow: number = DEFAULT_MAX_PER_WINDOW) {}

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
        { retryAfterSec: Math.ceil((recent[0]! + WINDOW_MS - now) / 1000) },
      );
    }

    recent.push(now);
    this.#hits.set(tenantId, recent);
  }

  /** Drop tenants with no recent activity, so the map cannot grow unbounded. */
  prune(): void {
    const cutoff = Date.now() - WINDOW_MS;
    for (const [tenantId, times] of this.#hits) {
      const recent = times.filter((t) => t > cutoff);
      if (recent.length === 0) this.#hits.delete(tenantId);
      else this.#hits.set(tenantId, recent);
    }
  }
}
