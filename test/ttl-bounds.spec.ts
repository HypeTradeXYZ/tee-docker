import { TtlSchema } from '../src/config/schemas';

describe('session lifetimes stay representable as dates (R-11)', () => {
  const MAX = 315_360_000;

  it.each(['workspaceIdleSec', 'workspaceAbsoluteSec', 'accountAbsoluteSec'] as const)(
    'rejects a %s that would make toISOString throw',
    (field) => {
      // 8.64e12 is the value that reproduced a RangeError on the SUCCESS path,
      // i.e. an opaque 500 on every token mint from a schema-valid config.
      for (const value of [8_640_000_000_000, 9e15, Number.MAX_SAFE_INTEGER, MAX + 1]) {
        expect(TtlSchema.safeParse({ [field]: value }).success).toBe(false);
      }
    },
  );

  it('accepts the maximum and keeps every derived date valid', () => {
    const parsed = TtlSchema.parse({
      workspaceIdleSec: MAX,
      workspaceAbsoluteSec: MAX,
      accountAbsoluteSec: MAX,
    });
    const now = Date.now();
    for (const seconds of Object.values(parsed)) {
      expect(() => new Date(now + seconds * 1000).toISOString()).not.toThrow();
    }
  });
});
