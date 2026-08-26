import type { ZodError } from 'zod';
import { MAX_PUBLIC_MESSAGE } from './reviewed-message';

/**
 * Naming the fields that failed, so a caller sending a body with six optional
 * fields is not left to guess which one the service objected to.
 *
 * A route's fixed "body must be { ... }" text says what was expected; on its own
 * it cannot say what arrived, which is the half the caller does not already
 * know.
 */

/** Beyond this, the list stops rather than crowding out the expected-shape text. */
const MAX_NAMED_FIELDS = 3;

/**
 * A field name safe to render back: a plain identifier, short enough to bound
 * the echo. Both zod paths and unrecognized-key lists can carry caller-supplied
 * text — a record key, a mistyped body key — so nothing is reflected unchecked.
 */
const SAFE_FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The first safe-to-name field of an issue's path. Nested paths report their
 * root: a caller who sent the wrong shape needs the field they wrote, not the
 * leaf a parser reached.
 */
function fieldName(path: ReadonlyArray<PropertyKey>): string | undefined {
  const head = path[0];
  if (typeof head !== 'string' || !SAFE_FIELD.test(head)) return undefined;
  return head;
}

/**
 * Renders at most MAX_NAMED_FIELDS findings, deduplicated, in the order zod
 * reported them. Returns undefined when nothing could be named safely, which
 * leaves the caller with the fixed expected-shape text alone.
 */
export function describeBodyIssues(error: ZodError, body: unknown): string | undefined {
  const seen = new Set<string>();
  const parts: string[] = [];

  for (const issue of error.issues) {
    if (parts.length >= MAX_NAMED_FIELDS) break;

    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        if (parts.length >= MAX_NAMED_FIELDS) break;
        if (!SAFE_FIELD.test(key) || seen.has(key)) continue;
        seen.add(key);
        parts.push(`unexpected field "${key}"`);
      }
      continue;
    }

    const name = fieldName(issue.path);
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    // Absent and present-but-wrong are different mistakes to the caller, and
    // zod reports both as one issue code; the body itself is the discriminator.
    const absent = isPlainObject(body) && !Object.prototype.hasOwnProperty.call(body, name);
    parts.push(absent ? `"${name}" is required` : `"${name}" is not valid`);
  }

  return parts.length > 0 ? parts.join(', ') : undefined;
}

/**
 * The expected shape, plus what was actually wrong with this body.
 *
 * Falls back to the expected shape alone if the combined text would exceed the
 * reviewed-message budget: over-long messages are dropped entirely by the error
 * filter, so an unbounded detail would silently cost the caller the whole
 * message rather than just the detail.
 */
export function invalidBodyMessage(expected: string, error: ZodError, body: unknown): string {
  const detail = describeBodyIssues(error, body);
  if (detail === undefined) return expected;

  const combined = `${expected} — ${detail}`;
  return combined.length <= MAX_PUBLIC_MESSAGE ? combined : expected;
}
