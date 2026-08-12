import { sessionCapacityFromEnv } from '../src/session/session-capacity';
import { LimitsSchema } from '../src/config/schemas';

describe('sessionCapacityFromEnv', () => {
  const names = ['TEE_MAX_UNLOCKED_WORKSPACES', 'TEE_MAX_TOKEN_LEASES_PER_WORKSPACE'] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));

  afterEach(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('applies finite positive defaults', () => {
    for (const name of names) delete process.env[name];
    expect(sessionCapacityFromEnv()).toEqual({ process: 32, leasesPerWorkspace: 64 });
  });

  it.each(['', '0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992'])(
    'rejects invalid process capacity %p',
    (value) => {
      process.env.TEE_MAX_UNLOCKED_WORKSPACES = value;
      expect(() => sessionCapacityFromEnv()).toThrow(
        'TEE_MAX_UNLOCKED_WORKSPACES must be a positive safe integer',
      );
    },
  );

  it('rejects an invalid token lease capacity', () => {
    process.env.TEE_MAX_TOKEN_LEASES_PER_WORKSPACE = '0';
    expect(() => sessionCapacityFromEnv()).toThrow(
      'TEE_MAX_TOKEN_LEASES_PER_WORKSPACE must be a positive safe integer',
    );
  });
});

describe('tenant unlocked workspace capacity', () => {
  const base = { maxWorkspaces: 2, maxWallets: 10 };

  it('defaults to eight unlocked workspaces', () => {
    expect(LimitsSchema.parse(base).maxUnlockedWorkspaces).toBe(8);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 9_007_199_254_740_992])(
    'rejects invalid tenant capacity %p',
    (maxUnlockedWorkspaces) => {
      expect(() => LimitsSchema.parse({ ...base, maxUnlockedWorkspaces })).toThrow();
    },
  );

  it('accepts a positive safe integer override', () => {
    expect(LimitsSchema.parse({ ...base, maxUnlockedWorkspaces: 12 }).maxUnlockedWorkspaces).toBe(
      12,
    );
  });
});
