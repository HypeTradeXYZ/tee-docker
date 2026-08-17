import type { Workspace } from 'wative-core';
import { damagedAccountSlugs, hasDamagedAccounts } from '../src/session/damaged-accounts';

describe('damaged account detection (L-13)', () => {
  it('reports the slugs core omitted from the collection', () => {
    const handle = { damagedAccountSlugs: ['alpha'] } as unknown as Workspace;
    expect(damagedAccountSlugs(handle)).toEqual(['alpha']);
    expect(hasDamagedAccounts(handle)).toBe(true);
  });

  it.each([
    ['the getter is absent', {}],
    ['the getter throws', Object.defineProperty({}, 'damagedAccountSlugs', {
      get() { throw new Error('core changed'); },
    })],
    ['the value is not an array', { damagedAccountSlugs: 'alpha' }],
    ['the value is a Set', { damagedAccountSlugs: new Set(['alpha']) }],
  ])('reads defensively when %s', (_name, handle) => {
    // A core version without the getter must not throw; it reads as undamaged,
    // which is the pre-L-13 behaviour rather than a new failure mode.
    expect(() => damagedAccountSlugs(handle as unknown as Workspace)).not.toThrow();
    expect(damagedAccountSlugs(handle as unknown as Workspace)).toEqual([]);
  });

  it('treats an empty list as undamaged', () => {
    const handle = { damagedAccountSlugs: [] } as unknown as Workspace;
    expect(hasDamagedAccounts(handle)).toBe(false);
  });
});
