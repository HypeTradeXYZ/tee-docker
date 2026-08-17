import { SLUG_RE } from '../config/schemas';
import { teeCoreError } from '../common/tee-error';

/**
 * One network selector, in the shared lowercase-slug grammar.
 *
 * The looser rule this replaces accepted `__proto__`, NUL bytes, `../../etc/passwd`
 * and zero-width spaces, and passed them to core and into an exposed error field.
 *
 * Note core's own network grammar is looser still (underscores, 64 chars), so a
 * container written by another consumer can hold a slug this rejects — see R-13.
 */
export function parseNetworkSelector(value: unknown): string {
  if (typeof value !== 'string' || !SLUG_RE.test(value)) {
    throw teeCoreError('PARAMETER_ERROR', 'network must be one lowercase slug');
  }
  return value;
}
