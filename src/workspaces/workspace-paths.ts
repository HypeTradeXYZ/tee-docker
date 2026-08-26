import { resolve, sep } from 'node:path';
import { TeeError } from '../common/tee-error';
import { RESERVABLE_BY_GRAMMAR, RESERVED_SLUGS, SLUG_RE } from '../config/schemas';

const GRAMMAR = 'lowercase letters, digits and hyphens; must start alphanumeric; max 63 chars';

export function assertValidSlug(slug: unknown): string {
  // A reserved name satisfies the grammar, so reporting the grammar back would
  // describe a rule the caller already met — an error they cannot act on.
  // Name the real reason instead.
  if (typeof slug === 'string' && SLUG_RE.test(slug) && RESERVED_SLUGS.has(slug)) {
    throw new TeeError('TEE_INVALID_SLUG', 'slug is reserved and cannot be used', {
      expected: `${GRAMMAR}; and not one of: ${RESERVABLE_BY_GRAMMAR.join(', ')}`,
    });
  }
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new TeeError('TEE_INVALID_SLUG', 'workspace slug must be a lowercase slug', {
      expected: GRAMMAR,
    });
  }
  return slug;
}

/**
 * Derive a workspace's directory from the AUTHENTICATED tenant and a validated
 * slug. No path component ever comes from raw client input.
 *
 * The slug regex already excludes `.` and `/`, so traversal is impossible by
 * construction — the containment assertion below is a second lock on the same
 * door, because this path is passed to recursive delete.
 */
export function workspacePath(dataRoot: string, tenantId: string, slug: string): string {
  const root = resolve(dataRoot);
  const tenantRoot = resolve(root, assertValidSlug(tenantId));
  const path = resolve(tenantRoot, assertValidSlug(slug));

  if (path !== tenantRoot && !path.startsWith(tenantRoot + sep)) {
    throw new TeeError('TEE_INVALID_SLUG', 'resolved workspace path escaped the tenant root');
  }
  return path;
}

export function tenantRootPath(dataRoot: string, tenantId: string): string {
  return resolve(resolve(dataRoot), assertValidSlug(tenantId));
}
