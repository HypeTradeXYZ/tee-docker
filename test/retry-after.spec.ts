import { retryAfterSeconds } from '../src/common/retry-after';
import { MintRateLimiter } from '../src/auth/mint-rate-limit';

describe('retryAfterSeconds clamp (L-11)', () => {
  afterEach(() => jest.useRealTimers());

  it.each([Number.NaN, Infinity, -Infinity])('returns the ceiling for %p', (bad) => {
    expect(retryAfterSeconds(bad, 0, 60)).toBe(60);
  });

  it('clamps a backwards clock jump to the window', () => {
    // A one-day NTP correction previously yielded 86460s against a 60s window.
    expect(retryAfterSeconds(0 + 60_000, -86_400_000, 60)).toBe(60);
  });

  it('floors at one and keeps ordinary values exact', () => {
    expect(retryAfterSeconds(1_000, 999, 60)).toBe(1);
    expect(retryAfterSeconds(60_000, 31_000, 60)).toBe(29);
  });

  it('bounds the mint limiter under a backwards clock', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-16T12:00:00.000Z'));
    const limiter = new MintRateLimiter(1);
    limiter.check('acme');
    jest.setSystemTime(new Date('2026-08-15T12:00:00.000Z'));
    try {
      limiter.check('acme');
      throw new Error('expected a rejection');
    } catch (err) {
      const details = (err as { details?: { retryAfterSec?: number } }).details;
      expect(details!.retryAfterSec).toBeLessThanOrEqual(60);
      expect(details!.retryAfterSec).toBeGreaterThanOrEqual(1);
    }
  });
});
