import { boundedProviderText } from '../src/session/transactions.controller';

/**
 * bounded-provider-text — a provider's revert reason, cut safely.
 *
 * This bound is the only thing standing between an untrusted upstream string
 * and a caller's response body, and nothing pinned it. Slicing by UTF-16 index
 * used to cut a surrogate pair in half; the result does not throw, because
 * `JSON.stringify` escapes a lone surrogate, so it shipped and rendered as a
 * broken character rather than failing anywhere visible.
 */
describe('bounded-provider-text', () => {
  const MAX = 200;
  const hasLoneSurrogate = (text: string): boolean =>
    [...text].some((ch) => {
      const code = ch.charCodeAt(0);
      return ch.length === 1 && code >= 0xd800 && code <= 0xdfff;
    });

  it('passes short text through untouched', () => {
    expect(boundedProviderText('execution reverted: insufficient balance')).toBe(
      'execution reverted: insufficient balance',
    );
  });

  it('coerces a non-string to empty rather than rendering it', () => {
    expect(boundedProviderText(undefined)).toBe('');
    expect(boundedProviderText({ nested: 'object' })).toBe('');
  });

  it('marks truncation so a caller can tell the text was cut', () => {
    const out = boundedProviderText('b'.repeat(300));
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(MAX + 1);
  });

  // The regression: an emoji straddling the boundary must not be halved.
  it('never emits a lone surrogate, wherever the cut lands', () => {
    for (let prefix = 190; prefix <= 205; prefix += 1) {
      const out = boundedProviderText('a'.repeat(prefix) + '😀'.repeat(20));
      expect(hasLoneSurrogate(out)).toBe(false);
    }
  });

  it('keeps a whole emoji when the pair fits inside the bound', () => {
    const out = boundedProviderText('a'.repeat(198) + '😀'.repeat(20));
    expect(out).toContain('😀');
    expect(hasLoneSurrogate(out)).toBe(false);
  });
});
