/**
 * Reserved wallet-tag namespace.
 *
 * Tags under this prefix are internal state (buffer allocation, ...). They are
 * managed only by the service: the caller-facing tags endpoint cannot set or
 * clear them, and they are filtered out of every wallet view. Core accepts the
 * `sys:` form verbatim, so no normalization surprise hides one.
 */
export const RESERVED_TAG_PREFIX = 'sys:';

/** Marks a wallet as handed out to a user in buffer mode. */
export const ALLOCATED_TAG = 'sys:allocated';

export function isReservedTag(tag: string): boolean {
  return tag.startsWith(RESERVED_TAG_PREFIX);
}

/** The caller-visible tags — reserved ones removed, order preserved. */
export function publicTags(tags: readonly string[]): string[] {
  return tags.filter((tag) => !isReservedTag(tag));
}

/** The reserved tags only, used to carry them across a caller replace. */
export function reservedTags(tags: readonly string[]): string[] {
  return tags.filter(isReservedTag);
}

export function hasTag(tags: readonly string[], tag: string): boolean {
  return tags.includes(tag);
}
