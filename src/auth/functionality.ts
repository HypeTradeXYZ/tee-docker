import type { TokenLease } from '../session/session.registry';

/**
 * The sensitive functions an inquiry key unlocks. Today only key export; the
 * list is the single extension point for future sensitive operations gated the
 * same way (present + unexpired inquiry key required).
 */
export const INQUIRY_FUNCTIONS = ['export'] as const;
export type InquiryFunction = (typeof INQUIRY_FUNCTIONS)[number];

/**
 * The live functionality list for a lease at `now`. Empty unless the lease
 * carries an inquiry key whose validity window has not lapsed — so a token minted
 * without an inquiry key, or one whose window expired, can reach none of them.
 */
export function unlockedFunctions(
  lease: Pick<TokenLease, 'inquiryKey' | 'inquiryExpiresAt'>,
  now: number,
): InquiryFunction[] {
  if (lease.inquiryKey === undefined) return [];
  // Treat a missing expiry as already lapsed: the capability is only ever live
  // inside an explicit window, never permanently — the gate stays fail-closed
  // even if some future caller sets a key without a window.
  if (lease.inquiryExpiresAt === undefined || now >= lease.inquiryExpiresAt) return [];
  return [...INQUIRY_FUNCTIONS];
}
