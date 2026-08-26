import {
  WorkspaceCreationLimiter,
  workspaceCreationConfigFromEnv,
} from '../src/workspaces/workspace-creation-limiter';

describe('workspace creation limiter config', () => {
  it('uses safe defaults and parses explicit values', () => {
    expect(workspaceCreationConfigFromEnv({})).toEqual({
      maxPerMinute: 10,
      recreateCooldownMs: 60_000,
    });
    expect(workspaceCreationConfigFromEnv({
      TEE_WORKSPACE_CREATE_RATE_LIMIT: '3',
      TEE_WORKSPACE_RECREATE_COOLDOWN_SEC: '7',
    })).toEqual({ maxPerMinute: 3, recreateCooldownMs: 7_000 });
  });

  it.each(['', ' ', '0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992'])(
    'rejects invalid rate %p',
    (value) => expect(() => workspaceCreationConfigFromEnv({
      TEE_WORKSPACE_CREATE_RATE_LIMIT: value,
    })).toThrow('TEE_WORKSPACE_CREATE_RATE_LIMIT'),
  );

  it.each(['', ' ', '0', '-1', '1.5', 'NaN', 'Infinity', '9007199254741'])(
    'rejects invalid cooldown %p',
    (value) => expect(() => workspaceCreationConfigFromEnv({
      TEE_WORKSPACE_RECREATE_COOLDOWN_SEC: value,
    })).toThrow('TEE_WORKSPACE_RECREATE_COOLDOWN_SEC'),
  );

  it('bounds cooldown duration and absolute deadline arithmetic', () => {
    expect(() => workspaceCreationConfigFromEnv({
      TEE_WORKSPACE_CREATE_RATE_LIMIT: '10001',
    })).toThrow('TEE_WORKSPACE_CREATE_RATE_LIMIT');
    expect(() => workspaceCreationConfigFromEnv({
      TEE_WORKSPACE_RECREATE_COOLDOWN_SEC: '31536001',
    })).toThrow('TEE_WORKSPACE_RECREATE_COOLDOWN_SEC');
    const nearCeiling = new WorkspaceCreationLimiter(
      { maxPerMinute: 1, recreateCooldownMs: 1_000 },
      () => Number.MAX_SAFE_INTEGER - 500,
    );
    expect(nearCeiling.recreateAfter()).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('workspace creation limiter admission', () => {
  let now = 1_000;
  let limiter: WorkspaceCreationLimiter;

  beforeEach(() => {
    now = 1_000;
    limiter = new WorkspaceCreationLimiter(
      { maxPerMinute: 2, recreateCooldownMs: 10_000 },
      () => now,
    );
  });

  it('shares an exact non-extending window per tenant and isolates tenants', () => {
    limiter.admit('acme');
    limiter.admit('acme');
    expect(() => limiter.admit('acme')).toThrow(expect.objectContaining({
      code: 'TEE_WORKSPACE_CREATE_RATE',
      details: { retryAfterSec: 60 },
    }));
    now = 2_000;
    expect(() => limiter.admit('acme')).toThrow(expect.objectContaining({
      details: { retryAfterSec: 59 },
    }));
    expect(() => limiter.admit('other')).not.toThrow();
    now = 61_000;
    expect(() => limiter.admit('acme')).not.toThrow();
  });

  it('rejects a persisted slug cooldown without charging or extending it', () => {
    expect(() => limiter.admit('acme', 11_000)).toThrow(expect.objectContaining({
      code: 'TEE_WORKSPACE_RECREATE_COOLDOWN',
      details: { retryAfterSec: 10 },
    }));
    now = 10_500;
    expect(() => limiter.admit('acme', 11_000)).toThrow(expect.objectContaining({
      details: { retryAfterSec: 1 },
    }));
    now = 11_000;
    expect(() => limiter.admit('acme', 11_000)).not.toThrow();
    expect(() => limiter.admit('acme')).not.toThrow();
  });

  it('reports the later of cooldown and rate admission times', () => {
    limiter.admit('acme');
    limiter.admit('acme');
    expect(() => limiter.admit('acme', 121_000)).toThrow(expect.objectContaining({
      code: 'TEE_WORKSPACE_RECREATE_COOLDOWN',
      details: { retryAfterSec: 120 },
    }));
  });

  it('can refund only a pre-core state-commit failure', () => {
    // The second refund must be a no-op. Calling it against an already-empty
    // bucket cannot show that: the refund short-circuits on the missing key
    // whether or not the latch exists. Re-charge in between so a second refund
    // would cancel a DIFFERENT, later charge — which is the bug the latch is
    // there to prevent, since both charges carry the same clock value.
    const refund = limiter.admit('acme');
    refund();

    limiter.admit('acme'); // a new charge, same tick, same bucket slot
    refund(); // must not touch it

    // maxPerMinute is 2, and exactly one live charge should remain.
    expect(() => limiter.admit('acme')).not.toThrow();
    expect(() => limiter.admit('acme')).toThrow(
      expect.objectContaining({ code: 'TEE_WORKSPACE_CREATE_RATE' }),
    );
  });
});
