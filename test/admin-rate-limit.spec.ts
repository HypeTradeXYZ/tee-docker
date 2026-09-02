import { AdminRateLimiter } from '../src/admin/admin-rate-limit';
import { TeeError } from '../src/common/tee-error';

function limiter(now: () => number): AdminRateLimiter {
  return new AdminRateLimiter(now);
}

describe('AdminRateLimiter', () => {
  it('admits up to five failures, then refuses', () => {
    const limit = limiter(() => 1_000);
    for (let i = 0; i < 5; i += 1) {
      limit.check();
      limit.recordFailure();
    }
    expect(() => limit.check()).toThrow(TeeError);
  });

  it('does not spend budget on success', () => {
    const limit = limiter(() => 1_000);
    for (let i = 0; i < 50; i += 1) limit.check();
    expect(limit.bucketSize).toBe(0);
  });

  it('does not extend the window when an attempt is rejected', () => {
    let now = 1_000;
    const limit = limiter(() => now);
    for (let i = 0; i < 5; i += 1) {
      limit.check();
      limit.recordFailure();
    }
    // Hammering while locked out must not push the window forward, or a burst
    // would become a rolling lockout that never clears.
    now = 30_000;
    for (let i = 0; i < 10; i += 1) expect(() => limit.check()).toThrow(TeeError);
    expect(limit.bucketSize).toBe(5);

    now = 61_001;
    expect(() => limit.check()).not.toThrow();
  });

  it('carries a bounded retry hint', () => {
    const limit = limiter(() => 1_000);
    for (let i = 0; i < 5; i += 1) {
      limit.check();
      limit.recordFailure();
    }
    try {
      limit.check();
      throw new Error('expected a rate-limit rejection');
    } catch (error) {
      const details = (error as TeeError).details as { retryAfterSec: number };
      expect(details.retryAfterSec).toBeGreaterThan(0);
      expect(details.retryAfterSec).toBeLessThanOrEqual(60);
    }
  });

  it('drops timestamps as the window slides, so the bucket stays bounded', () => {
    let now = 0;
    const limit = limiter(() => now);
    for (let i = 0; i < 100; i += 1) {
      now += 30_000;
      limit.check();
      limit.recordFailure();
    }
    expect(limit.bucketSize).toBeLessThanOrEqual(5);
  });
});
