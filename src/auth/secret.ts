import { createHmac, timingSafeEqual } from 'node:crypto';

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
 * Constant-time comparison. `timingSafeEqual` throws on a length mismatch,
 * which would itself leak length, so compare digests of the candidate rather
 * than the raw strings — those are always 32 bytes.
 */
export function verifyApiSecret(secret: string, expectedHash: string, serverKey: Buffer): boolean {
  const actual = Buffer.from(hashApiSecret(secret, serverKey), 'hex');

  let expected: Buffer;
  try {
    expected = Buffer.from(expectedHash, 'hex');
  } catch {
    return false;
  }
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
