// A message is renderable only if tee-docker authored it. The brand is a
// module-private symbol, checked as an OWN property so it cannot arrive by
// inheritance, and non-enumerable so it never reaches a body or a log line.
// It stops a dependency's message propagating accidentally; it is not a
// capability check — code inside this process can reach the symbol reflectively.
const REVIEWED = Symbol('tee-docker.reviewedMessage');

/** Longest message tee-docker will render; longer fails closed to fixed text. */
export const MAX_PUBLIC_MESSAGE = 200;

export function markReviewedMessage(error: object): void {
  // Total: a frozen or sealed target must not turn a reviewed 4xx into a 500.
  try {
    Object.defineProperty(error, REVIEWED, {
      value: true,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  } catch {
    // Unbranded is the fail-safe state; the message simply stays opaque.
  }
}

export function hasReviewedMessage(value: unknown): boolean {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false;
  try {
    // Own, not inherited: Object.create(teeError) and setPrototypeOf would
    // otherwise inherit the brand and render an attacker-supplied message.
    if (!Object.prototype.hasOwnProperty.call(value, REVIEWED)) return false;
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
