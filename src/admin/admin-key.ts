import { createHash, timingSafeEqual } from 'node:crypto';

export const ADMIN_KEY = Symbol('tee-docker:admin-key');

/** The configured super-admin key, or null when the tier is switched off. */
export type AdminKey = Buffer | null;

// Matches the floor TEE_SECRET_HMAC_KEY holds its own material to. A key short
// enough to guess would make every tenant's ceiling writable by anyone.
const MIN_KEY_BYTES = 16;

/**
 * Load PANADOL_KEY, the super-admin tier's single credential.
 *
 * Absent is the supported default and switches the tier off — making it
 * required would refuse the boot of every existing deployment. Present but too
 * short is a hard boot failure instead of a weak admin tier, because an
 * operator who set the variable believes the tier is protected.
 */
export function adminKeyFromEnv(env: NodeJS.ProcessEnv = process.env): AdminKey {
  const raw = env.PANADOL_KEY;
  if (raw === undefined || raw === '') return null;

  const key = Buffer.from(raw, 'utf8');
  if (key.length < MIN_KEY_BYTES) {
    throw new Error(`PANADOL_KEY must be at least ${MIN_KEY_BYTES} characters`);
  }
  return key;
}

/**
 * Constant-time comparison of the presented key against the configured one.
 *
 * Both sides are digested first so the comparison is over fixed-width bytes:
 * timingSafeEqual throws on a length mismatch, and branching on that would
 * leak the configured key's length to anyone who can time a request.
 */
export function verifyAdminKey(presented: string, configured: AdminKey): boolean {
  const actual = digest(Buffer.from(presented, 'utf8'));
  // No configured key still costs a full comparison, so "tier off" and "wrong
  // key" are indistinguishable by latency.
  const expected = digest(configured ?? Buffer.alloc(0));
  const matched = timingSafeEqual(actual, expected);
  return configured !== null && matched;
}

function digest(value: Buffer): Buffer {
  return createHash('sha256').update(value).digest();
}
