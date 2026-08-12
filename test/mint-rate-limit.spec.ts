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
        'TEE_MINT_RATE_LIMIT must be a positive safe integer',
      );
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 9_007_199_254_740_992])(
    'rejects invalid programmatic limit %p',
    (value) => {
      expect(() => new MintRateLimiter(value)).toThrow(
        'mint rate limit must be a positive safe integer',
      );
    },
  );

  it.each(['1', 1n, [1], { valueOf: () => 1 }])(
    'does not coerce programmatic limit %p',
    (value) => {
      expect(() => new MintRateLimiter(value as never)).toThrow(
        'mint rate limit must be a positive safe integer',
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
