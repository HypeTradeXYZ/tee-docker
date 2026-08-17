import { MintRateLimiter, mintRateLimitFromEnv } from '../src/auth/mint-rate-limit';

describe('mint rate limit configuration', () => {
  it('uses ten only when the value is unset', () => {
    expect(mintRateLimitFromEnv({})).toBe(10);
  });

  it.each(['1', '2', '10', '1000'])('accepts positive safe integer %p', (value) => {
    expect(mintRateLimitFromEnv({ TEE_MINT_RATE_LIMIT: value })).toBe(Number(value));
  });

  it.each(['', ' ', '0', '-1', '1.5', 'NaN', 'ten', '10/min', 'Infinity', '9007199254740992'])(
    'rejects invalid value %p',
    (value) => {
      expect(() => mintRateLimitFromEnv({ TEE_MINT_RATE_LIMIT: value })).toThrow(
        'TEE_MINT_RATE_LIMIT must be an integer between 1 and 10000',
      );
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 9_007_199_254_740_992])(
    'rejects invalid programmatic limit %p',
    (value) => {
      expect(() => new MintRateLimiter(value)).toThrow(
        'mint rate limit must be an integer between 1 and 10000',
      );
    },
  );

  it.each(['1', 1n, [1], { valueOf: () => 1 }])(
    'does not coerce programmatic limit %p',
    (value) => {
      expect(() => new MintRateLimiter(value as never)).toThrow(
        'mint rate limit must be an integer between 1 and 10000',
      );
    },
  );

  it('always returns a finite positive retry delay when the limit is reached', () => {
    const limiter = new MintRateLimiter(1);
    limiter.check('acme');

    try {
      limiter.check('acme');
      throw new Error('expected limiter rejection');
    } catch (error) {
      expect((error as { details?: { retryAfterSec?: number } }).details?.retryAfterSec).toEqual(
        expect.any(Number),
      );
      expect(
        Number.isFinite((error as { details: { retryAfterSec: number } }).details.retryAfterSec),
      ).toBe(true);
      expect((error as { details: { retryAfterSec: number } }).details.retryAfterSec).toBeGreaterThan(
        0,
      );
    }
  });
});

describe('mint rate limit bounds and window (L-09)', () => {
  afterEach(() => jest.useRealTimers());

  it('accepts the maximum and rejects one above it', () => {
    expect(mintRateLimitFromEnv({ TEE_MINT_RATE_LIMIT: '10000' })).toBe(10_000);
    expect(() => mintRateLimitFromEnv({ TEE_MINT_RATE_LIMIT: '10001' })).toThrow(
      'TEE_MINT_RATE_LIMIT must be an integer between 1 and 10000',
    );
    expect(() => new MintRateLimiter(10_001)).toThrow(
      'mint rate limit must be an integer between 1 and 10000',
    );
    expect(new MintRateLimiter(10_000).limit).toBe(10_000);
  });

  it.each([1, 2, 10])('admits exactly the limit per window, then refills (limit %p)', (limit) => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-16T00:00:00.000Z'));
    const limiter = new MintRateLimiter(limit);
    for (let i = 0; i < limit; i++) expect(() => limiter.check('acme')).not.toThrow();
    for (let i = 0; i < limit * 9; i++) expect(() => limiter.check('acme')).toThrow();

    jest.setSystemTime(new Date('2026-08-16T00:01:00.001Z'));
    for (let i = 0; i < limit; i++) expect(() => limiter.check('acme')).not.toThrow();
  });

  it('does not extend the window while rejecting', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-16T00:00:00.000Z'));
    const limiter = new MintRateLimiter(1);
    limiter.check('acme');
    // Hammer the whole window. A rejected attempt costs no KDF, so it must not
    // push the deadline out and turn a burst into a lockout.
    for (let s = 1; s < 60; s++) {
      jest.setSystemTime(new Date(`2026-08-16T00:00:${String(s).padStart(2, '0')}.000Z`));
      expect(() => limiter.check('acme')).toThrow();
    }
    jest.setSystemTime(new Date('2026-08-16T00:01:00.001Z'));
    expect(() => limiter.check('acme')).not.toThrow();
  });

  function retryAfterOf(fn: () => void): number {
    try {
      fn();
    } catch (err) {
      const details = (err as { details?: { retryAfterSec?: number } }).details;
      return details!.retryAfterSec!;
    }
    throw new Error('expected a rejection');
  }

  it('derives retryAfterSec from the oldest hit still in the window', () => {
    // An exact value, not a 1..60 range: a range is satisfied equally by
    // deriving it from the NEWEST hit, which overstates client backoff.
    jest.useFakeTimers().setSystemTime(new Date('2026-08-16T00:00:00.000Z'));
    const limiter = new MintRateLimiter(2);
    limiter.check('acme');
    jest.setSystemTime(new Date('2026-08-16T00:00:20.000Z'));
    limiter.check('acme');

    jest.setSystemTime(new Date('2026-08-16T00:00:31.000Z'));
    expect(retryAfterOf(() => limiter.check('acme'))).toBe(29);
  });

  it('expires hits individually, not the whole bucket at once', () => {
    // The defining property of a sliding window. Accepting every timestamp at
    // one instant cannot distinguish this from all-or-nothing expiry keyed on
    // the oldest entry.
    jest.useFakeTimers().setSystemTime(new Date('2026-08-16T00:00:00.000Z'));
    const limiter = new MintRateLimiter(4);
    limiter.check('acme');
    limiter.check('acme');

    jest.setSystemTime(new Date('2026-08-16T00:00:30.000Z'));
    limiter.check('acme');
    limiter.check('acme');
    expect(() => limiter.check('acme')).toThrow();

    // The two oldest have aged out; the two from +30s have not.
    jest.setSystemTime(new Date('2026-08-16T00:01:00.001Z'));
    expect(() => limiter.check('acme')).not.toThrow();
    expect(() => limiter.check('acme')).not.toThrow();
    expect(() => limiter.check('acme')).toThrow();
    expect(Math.max(...limiter.bucketSizes)).toBe(4);
  });

  it('counts each tenant separately', () => {
    const limiter = new MintRateLimiter(1);
    limiter.check('acme');
    expect(() => limiter.check('acme')).toThrow();
    expect(() => limiter.check('globex')).not.toThrow();
  });

  it('never retains more timestamps than the limit', () => {
    // The property the acceptance line demands. Without this, a store that
    // appends without filtering keeps every decision correct while the bucket
    // grows forever.
    jest.useFakeTimers().setSystemTime(new Date('2026-08-16T00:00:00.000Z'));
    const limiter = new MintRateLimiter(3);
    for (let i = 0; i < 50; i++) {
      try {
        limiter.check('acme');
      } catch {
        // rejections are expected once the window is full
      }
      expect(Math.max(...limiter.bucketSizes)).toBeLessThanOrEqual(3);
    }
    jest.setSystemTime(new Date('2026-08-16T00:01:00.001Z'));
    for (let i = 0; i < 50; i++) {
      try {
        limiter.check('acme');
      } catch {
        // same in the next window
      }
      expect(Math.max(...limiter.bucketSizes)).toBeLessThanOrEqual(3);
    }
    expect(limiter.bucketSizes).toHaveLength(1);
  });

  it('no longer exposes a pruner', () => {
    // The map is bounded by the boot-time tenant table, so the sweep it
    // advertised was never wired and never needed.
    expect((MintRateLimiter.prototype as unknown as Record<string, unknown>).prune).toBeUndefined();
  });
});
