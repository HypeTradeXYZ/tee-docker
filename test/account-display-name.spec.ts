import { WativeError } from 'wative-core';
import { normalizeAccountDisplayName } from '../src/session/account-display-name';

describe('wative-core 2.4.4 account display-name boundary', () => {
  it.each([
    ['abcd', 'abcd'],
    ['a'.repeat(64), 'a'.repeat(64)],
    ['  alpha    desk  ', 'alpha desk'],
    ['éééé', 'éééé'],
    ['e\u0301e\u0301e\u0301e\u0301', 'éééé'],
    ['ａｂｃｄ', 'ａｂｃｄ'],
    ['ⓐⓑⓒⓓ', 'ⓐⓑⓒⓓ'],
    ['東京Vault', '東京Vault'],
    ['ab\u200bcd', 'abcd'],
    ['javascript:valid-name', 'valid-name'],
    [`${'e\u0301'.repeat(64)}`, 'é'.repeat(64)],
  ])('accepts and returns the core-normalized form of %p', async (input, normalized) => {
    await expect(normalizeAccountDisplayName(input)).resolves.toBe(normalized);
  });

  it.each([
    'abc',
    'a'.repeat(65),
    '  a b  ',
    '中文中文',
    'абвг',
    'العرب',
    '😀😀',
    '!!!!',
    '1234',
    'øøøø',
    'ßßßß',
    'ÆÆÆÆ',
    'ŁŁŁŁ',
    'javascript:abc',
  ])('rejects %p with fixed parameter semantics', async (input) => {
    let caught: unknown;
    try {
      await normalizeAccountDisplayName(input);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WativeError);
    expect(caught).toMatchObject({
      code: 'PARAMETER_ERROR',
      message: 'displayName must normalize to 4–64 characters and produce an account slug',
    });
    expect(JSON.stringify(caught)).not.toContain(input);
  });

  it('counts astral characters as two UTF-16 code units, like the pinned core', async () => {
    await expect(normalizeAccountDisplayName(`a${'😀'.repeat(31)}b`)).resolves.toBe(
      `a${'😀'.repeat(31)}b`,
    );
    await expect(normalizeAccountDisplayName(`a${'😀'.repeat(32)}b`))
      .rejects.toMatchObject({ code: 'PARAMETER_ERROR' });
  });
});
