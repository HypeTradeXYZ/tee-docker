import { Inject, Injectable } from '@nestjs/common';
import { WativeError } from 'wative-core';
import { TeeError } from '../common/tee-error';
import { MintRateLimiter } from './mint-rate-limit';
import { retryAfterSeconds } from '../common/retry-after';

export const ACCOUNT_UNLOCK_CLOCK = Symbol('ACCOUNT_UNLOCK_CLOCK');
export type AccountUnlockClock = () => number;

export interface AccountUnlockFailure {
  readonly failures: number;
  readonly lastFailureAt: number;
  readonly nextAllowedAt: number;
  readonly expiresAt: number;
}

export interface AccountUnlockSubject {
  readonly tenantId: string;
  readonly sid: string;
  readonly absoluteExpiresAt: number;
  readonly unlockFailures: Map<string, AccountUnlockFailure>;
  unusable: boolean;
}

const RETENTION_MS = 60_000;
const MAX_FAILURES = 5;
const MAX_BACKOFF_MS = 8_000;

/**
 * Admission and authentication-failure state for explicit account unlocks.
 * Each Session owns its map, so sibling token leases share it and closure
 * discards it without a process-global attacker-controlled key set.
 */
@Injectable()
export class AccountUnlockLimiter {
  private readonly now: AccountUnlockClock;

  constructor(
    private readonly sharedBudget: MintRateLimiter,
    @Inject(ACCOUNT_UNLOCK_CLOCK) clock: AccountUnlockClock,
  ) {
    this.now = clock;
  }

  async verify<T>(
    session: AccountUnlockSubject,
    accountSlug: string,
    attempt: () => T | Promise<T>,
  ): Promise<T> {
    const now = this.now();
    const failure = session.unlockFailures.get(accountSlug);
    if (failure && now >= failure.expiresAt) session.unlockFailures.delete(accountSlug);
    else if (failure && now < failure.nextAllowedAt) {
      throw new TeeError('TEE_ACCOUNT_UNLOCK_RATE', 'account unlock temporarily unavailable', {
        retryAfterSec: retryAfterSeconds(failure.nextAllowedAt, now, MAX_BACKOFF_MS / 1000),
      });
    }

    // Token mint and explicit account unlock spend the same tenant-wide KDF
    // allowance. Backoff rejection happens first and never consumes it.
    this.sharedBudget.check(session.tenantId);

    try {
      const result = await attempt();
      session.unlockFailures.delete(accountSlug);
      return result;
    } catch (error) {
      if (error instanceof WativeError && error.code === 'BAD_PASSWORD') {
        this.recordFailure(session, accountSlug, now);
      }
      throw error;
    }
  }

  private recordFailure(
    session: AccountUnlockSubject,
    accountSlug: string,
    now: number,
  ): void {
    const previous = session.unlockFailures.get(accountSlug);
    const failures = (previous && now < previous.expiresAt ? previous.failures : 0) + 1;
    const backoffMs = Math.min(1_000 * 2 ** (failures - 1), MAX_BACKOFF_MS);
    const expiresAt = Math.min(now + RETENTION_MS, session.absoluteExpiresAt);
    session.unlockFailures.set(accountSlug, {
      failures,
      lastFailureAt: now,
      nextAllowedAt: Math.min(now + backoffMs, expiresAt),
      expiresAt,
    });

    if (failures >= Math.min(MAX_FAILURES, this.sharedBudget.limit)) {
      // The handler already owns Session.mutex. Marking unusable makes all
      // leases fail immediately; withSession queues safe destruction after it
      // releases the non-reentrant mutex.
      session.unusable = true;
    }
  }
}
