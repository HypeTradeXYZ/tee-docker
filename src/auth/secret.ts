import { createHmac, timingSafeEqual } from 'node:crypto';

export const SECRET_HASH_RE = /^[0-9a-f]{64}$/i;

/**
 * API secrets are verified with HMAC-SHA256 under a server key — deliberately
 * NOT a slow KDF.
 *
 * Argon2 exists to make low-entropy human passwords expensive to brute-force.
 * An API secret is high-entropy machine-generated material, so brute force is
 * already infeasible and a slow KDF would only add cost to the hottest path in
 * the service. See docs/DESIGN.md §10.
 */
export function hashApiSecret(secret: string, serverKey: Buffer): string {
  return createHmac('sha256', serverKey).update(secret, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of canonical HMAC encodings. Validate before
 * Buffer decoding because Node's hex decoder silently truncates invalid text.
 */
export function verifyApiSecret(secret: string, expectedHash: string, serverKey: Buffer): boolean {
  const actual = Buffer.from(hashApiSecret(secret, serverKey), 'hex');
  if (!SECRET_HASH_RE.test(expectedHash)) return false;
  const expected = Buffer.from(expectedHash, 'hex');
  if (expected.length !== actual.length) return false;

  return timingSafeEqual(actual, expected);
}

/**
 * Burn an equivalent HMAC when no tenant matched, so "unknown API key" and
 * "wrong secret" take the same time. Without it, response latency is an oracle
 * for which API keys exist.
 */
export function burnComparison(secret: string, serverKey: Buffer): void {
  verifyApiSecret(secret, '00'.repeat(32), serverKey);
}
