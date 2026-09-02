import { adminKeyFromEnv, verifyAdminKey } from '../src/admin/admin-key';

const VALID = 'k'.repeat(32);

describe('adminKeyFromEnv', () => {
  it.each([undefined, ''])('treats %p as the tier being switched off', (value) => {
    expect(adminKeyFromEnv({ PANADOL_KEY: value } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('refuses a key short enough to guess rather than running a weak tier', () => {
    expect(() => adminKeyFromEnv({ PANADOL_KEY: 'short' } as NodeJS.ProcessEnv))
      .toThrow(/at least 16 characters/);
  });

  it('accepts a key at the floor', () => {
    expect(adminKeyFromEnv({ PANADOL_KEY: 'a'.repeat(16) } as NodeJS.ProcessEnv))
      .toEqual(Buffer.from('a'.repeat(16)));
  });
});

describe('verifyAdminKey', () => {
  const configured = adminKeyFromEnv({ PANADOL_KEY: VALID } as NodeJS.ProcessEnv);

  it('accepts the configured key', () => {
    expect(verifyAdminKey(VALID, configured)).toBe(true);
  });

  it('rejects a wrong key of the same length', () => {
    expect(verifyAdminKey('j'.repeat(32), configured)).toBe(false);
  });

  it('rejects a wrong key of a different length without throwing', () => {
    // timingSafeEqual throws on unequal lengths, so a comparison that fed it
    // raw input would turn a short guess into a 500 instead of a denial.
    expect(verifyAdminKey('x', configured)).toBe(false);
    expect(verifyAdminKey('x'.repeat(500), configured)).toBe(false);
  });

  it('rejects every key when no key is configured, including the empty string', () => {
    expect(verifyAdminKey(VALID, null)).toBe(false);
    expect(verifyAdminKey('', null)).toBe(false);
  });
});
