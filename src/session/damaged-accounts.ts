import type { Workspace } from 'wative-core';

/**
 * Accounts whose record failed to decrypt.
 *
 * Core omits them from `workspace.accounts` silently, so any count derived by
 * iterating that collection is an undercount. Writing such a count back as
 * authoritative permanently lowers the tenant's wallet total and hands the
 * quota back to nobody.
 */
export function damagedAccountSlugs(handle: Workspace): readonly string[] {
  try {
    const slugs = (handle as { damagedAccountSlugs?: readonly string[] }).damagedAccountSlugs;
    return Array.isArray(slugs) ? slugs : [];
  } catch {
    return [];
  }
}

export function hasDamagedAccounts(handle: Workspace): boolean {
  return damagedAccountSlugs(handle).length > 0;
}
