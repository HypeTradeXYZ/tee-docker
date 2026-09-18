import { publicTags, reservedTags, isReservedTag, hasTag, ALLOCATED_TAG } from '../src/session/reserved-tags';

describe('reserved-tags helpers', () => {
  it('splits reserved from public tags, preserving order', () => {
    const tags = ['vip', 'sys:allocated', 'gold', 'sys:x'];
    expect(publicTags(tags)).toEqual(['vip', 'gold']);
    expect(reservedTags(tags)).toEqual(['sys:allocated', 'sys:x']);
  });
  it('recognizes the reserved prefix and the allocated marker', () => {
    expect(isReservedTag('sys:allocated')).toBe(true);
    expect(isReservedTag('vip')).toBe(false);
    expect(ALLOCATED_TAG).toBe('sys:allocated');
    expect(hasTag(['a', ALLOCATED_TAG], ALLOCATED_TAG)).toBe(true);
  });
});
