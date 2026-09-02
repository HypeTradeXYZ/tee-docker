import { Inject, Injectable, Logger } from '@nestjs/common';
import { retryAfterSeconds } from '../common/retry-after';
import { TeeError } from '../common/tee-error';

export const ADMIN_RATE_CLOCK = Symbol('ADMIN_RATE_CLOCK');
export type AdminRateClock = () => number;

const WINDOW_MS = 60_000;
const MAX_FAILURES_PER_WINDOW = 5;

/**
 * Sliding window over FAILED super-admin attempts.
 *
 * One process-wide bucket, deliberately not keyed per source address: the
 * caller is unauthenticated at this point, so a per-address map would let
 * spoofed sources grow the key set without bound and give each forged address
 * its own fresh budget. There is only ever one admin key, so one bucket is the
 * whole population.
 *
 * Only failures are recorded. A successful lift costs no budget, so an
 * operator working through several tenants cannot lock themselves out.
 */
@Injectable()
export class AdminRateLimiter {
  private readonly logger = new Logger(AdminRateLimiter.name);
  readonly #failures: number[] = [];
  private readonly now: AdminRateClock;

  constructor(@Inject(ADMIN_RATE_CLOCK) clock: AdminRateClock) {
    this.now = clock;
  }

  /** Retained failure timestamps, so the bound can be asserted rather than read. */
  get bucketSize(): number {
    return this.#failures.length;
  }

  /** Throw if the tier is already over its failure budget. */
  check(): void {
    const now = this.now();
    this.prune(now);
    if (this.#failures.length < MAX_FAILURES_PER_WINDOW) return;

    // A rejected attempt records nothing, so a burst cannot extend itself into
    // a rolling lockout.
    this.logger.warn('super-admin rate limit hit');
    throw new TeeError(
      'TEE_ADMIN_RATE',
      `too many failed admin attempts; limit is ${MAX_FAILURES_PER_WINDOW} per minute`,
      { retryAfterSec: retryAfterSeconds(this.#failures[0]! + WINDOW_MS, now, WINDOW_MS / 1000) },
    );
  }

  /** Record a rejected key. Called only after `check` has admitted the attempt. */
  recordFailure(): void {
    const now = this.now();
    this.prune(now);
    this.#failures.push(now);
  }

  private prune(now: number): void {
    const cutoff = now - WINDOW_MS;
    while (this.#failures.length > 0 && this.#failures[0]! <= cutoff) this.#failures.shift();
  }
}
