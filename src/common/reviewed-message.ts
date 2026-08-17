// A message is renderable only if tee-docker authored it. The brand is a
// module-private symbol so a dependency cannot forge or copy it, and it is
// non-enumerable so it never reaches a response body or a log line.
const REVIEWED = Symbol('tee-docker.reviewedMessage');

/** Longest message tee-docker will render; longer fails closed to fixed text. */
export const MAX_PUBLIC_MESSAGE = 200;

export function markReviewedMessage(error: object): void {
  Object.defineProperty(error, REVIEWED, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
}

export function hasReviewedMessage(value: unknown): boolean {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false;
  try {
    return (value as Record<symbol, unknown>)[REVIEWED] === true;
  } catch {
    return false;
  }
}

/** Total: coerces, rejects non-strings and over-long text rather than truncating. */
export function reviewedMessageOrUndefined(value: unknown): string | undefined {
  if (!hasReviewedMessage(value)) return undefined;
  let message: unknown;
  try {
    message = (value as { message?: unknown }).message;
  } catch {
    return undefined;
  }
  if (typeof message !== 'string') return undefined;
  if (message.length === 0 || message.length > MAX_PUBLIC_MESSAGE) return undefined;
  return message;
}
