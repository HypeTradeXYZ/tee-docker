import { assertValidAccountSlug } from '../src/session/account-slug';
import { assertValidSlug } from '../src/workspaces/workspace-paths';

describe('account slug validation', () => {
  const collisionSlug = `${'a'.repeat(26)}-12345`;

  it('accepts the full wative-core 2.5.7 collision slug', () => {
    expect(collisionSlug).toHaveLength(32);
    expect(assertValidAccountSlug(collisionSlug)).toBe(collisionSlug);
  });

  it('keeps the filesystem-oriented workspace limit unchanged', () => {
    expect(() => assertValidSlug('a'.repeat(64))).toThrow('workspace slug');
  });

  it.each([
    '',
    '-account',
    'Account',
    'account_name',
    'account.name',
    'account/name',
    'account\\name',
    '%2f',
    'é',
    'a\naccount',
    'a\0account',
    'a'.repeat(33),
  ])('rejects invalid account slug %p', (slug) => {
    expect(() => assertValidAccountSlug(slug)).toThrow('account slug');
  });

  it('does not apply filesystem reserved-name policy to generated account identifiers', () => {
    expect(assertValidAccountSlug('con-12345')).toBe('con-12345');
  });
});
