import type { Request } from 'express';
import type { Tenant } from '../config/schemas';
import type { Session } from '../session/session.registry';

/**
 * The request shape this service actually works with.
 *
 * Declared locally rather than by augmenting `express-serve-static-core`:
 * augmentation pollutes the global Express type for every consumer, and under
 * pnpm's strict isolation that module is not even directly resolvable.
 */
/** The privilege level a bearer token carries, narrowest last. */
export type CredentialLevel = 'workspace' | 'account' | 'wallet';

export interface AppRequest extends Request {
  requestId?: string;
  tenant?: Tenant;
  session?: Session;
  scopes?: string[];
  leaseId?: string;
  /** Derived from the authoritative lease by WorkspaceGuard. */
  credentialLevel?: CredentialLevel;
  /** Account slug an account- or wallet-scoped token is confined to. */
  accountBinding?: string;
  /** The single wallet a wallet-scoped token is confined to. */
  walletBinding?: { acct: string; wid: number };
  /** Sensitive functions currently unlocked by a live inquiry key (else empty). */
  functions?: string[];
  /** When the inquiry key's capability lapses (absolute ms), if any. */
  inquiryExpiresAt?: number;
  /** The bound inquiry key (an X25519 recipient) sensitive output seals to, if any. */
  inquiryKey?: string;
}
