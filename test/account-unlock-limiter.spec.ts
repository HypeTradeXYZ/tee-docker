import { WativeError } from 'wative-core';
import {
  AccountUnlockLimiter,
  type AccountUnlockSubject,
} from '../src/auth/account-unlock-limiter';
import { MintRateLimiter } from '../src/auth/mint-rate-limit';

describe('AccountUnlockLimiter', () => {
  let now = 1_000_000;

  const subject = (overrides: Partial<AccountUnlockSubject> = {}): AccountUnlockSubject => ({
    tenantId: 'acme',
    sid: 'sid-a',
    absoluteExpiresAt: now + 600_000,
    unlockFailures: new Map(),
    unusable: false,
    ...overrides,
  });
  const badPassword = () => {
    throw new WativeError('BAD_PASSWORD', 'wrong password');
  };

  it('backs off exponentially without extending or charging blocked retries', async () => {
    const shared = new MintRateLimiter(2);
    const limiter = new AccountUnlockLimiter(shared, () => now);
    const session = subject();

    await expect(limiter.verify(session, 'vault', badPassword)).rejects.toMatchObject({
      code: 'BAD_PASSWORD',
    });
    const first = session.unlockFailures.get('vault')!;
    expect(first.nextAllowedAt - now).toBe(1_000);

    await expect(limiter.verify(session, 'vault', badPassword)).rejects.toMatchObject({
      code: 'TEE_ACCOUNT_UNLOCK_RATE',
      details: { retryAfterSec: 1 },
    });
    expect(session.unlockFailures.get('vault')).toEqual(first);

    now += 1_000;
    await expect(limiter.verify(session, 'vault', badPassword)).rejects.toMatchObject({
      code: 'BAD_PASSWORD',
    });
    expect(session.unlockFailures.get('vault')!.nextAllowedAt - now).toBe(2_000);
    expect(session.unusable).toBe(true); // threshold is min(5, shared limit 2)

    // Exactly two admitted attempts spent the budget; the blocked retry did not.
    expect(() => shared.check('acme')).toThrow(expect.objectContaining({ code: 'TEE_UNLOCK_CAPACITY' }));
  });

  it('caps backoff at eight seconds and invalidates on the fifth failure', async () => {
    const limiter = new AccountUnlockLimiter(new MintRateLimiter(10), () => now);
    const session = subject();
    const delays = [1_000, 2_000, 4_000, 8_000, 8_000];

    for (const [index, delay] of delays.entries()) {
      await expect(limiter.verify(session, 'vault', badPassword)).rejects.toMatchObject({
        code: 'BAD_PASSWORD',
      });
      expect(session.unlockFailures.get('vault')!.nextAllowedAt - now).toBe(delay);
      expect(session.unusable).toBe(index === delays.length - 1);
      now += delay;
    }
  });

  it('clears only the successful account and keeps account/session/tenant isolation', async () => {
    const limiter = new AccountUnlockLimiter(new MintRateLimiter(20), () => now);
    const a = subject();
    const siblingSession = subject({ sid: 'sid-b' });
    const otherTenant = subject({ tenantId: 'globex', sid: 'sid-c' });

    await expect(limiter.verify(a, 'vault-a', badPassword)).rejects.toBeInstanceOf(WativeError);
    await expect(limiter.verify(a, 'vault-b', badPassword)).rejects.toBeInstanceOf(WativeError);
    await expect(limiter.verify(siblingSession, 'vault-a', badPassword)).rejects.toBeInstanceOf(
      WativeError,
    );
    await expect(limiter.verify(otherTenant, 'vault-a', badPassword)).rejects.toBeInstanceOf(
      WativeError,
    );

    now += 1_000;
    await expect(limiter.verify(a, 'vault-a', async () => 'ok')).resolves.toBe('ok');
    expect(a.unlockFailures.has('vault-a')).toBe(false);
    expect(a.unlockFailures.has('vault-b')).toBe(true);
    expect(siblingSession.unlockFailures.has('vault-a')).toBe(true);
    expect(otherTenant.unlockFailures.has('vault-a')).toBe(true);
  });

  it('expires a quiet streak without blocked requests extending retention', async () => {
    const limiter = new AccountUnlockLimiter(new MintRateLimiter(10), () => now);
    const session = subject();
    await expect(limiter.verify(session, 'vault', badPassword)).rejects.toBeInstanceOf(WativeError);
    const expiry = session.unlockFailures.get('vault')!.expiresAt;

    now += 500;
    await expect(limiter.verify(session, 'vault', badPassword)).rejects.toMatchObject({
      code: 'TEE_ACCOUNT_UNLOCK_RATE',
    });
    expect(session.unlockFailures.get('vault')!.expiresAt).toBe(expiry);

    now = expiry;
    await expect(limiter.verify(session, 'vault', async () => 'ok')).resolves.toBe('ok');
    expect(session.unlockFailures.size).toBe(0);
  });

  it('does not count non-password core failures as strikes', async () => {
    const limiter = new AccountUnlockLimiter(new MintRateLimiter(10), () => now);
    const session = subject();
    const failure = new WativeError('PROVIDER_IO', 'storage failed');

    await expect(limiter.verify(session, 'vault', async () => Promise.reject(failure))).rejects.toBe(
      failure,
    );
    expect(session.unlockFailures.size).toBe(0);
    expect(session.unusable).toBe(false);
  });
});
