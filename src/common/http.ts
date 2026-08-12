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
export interface AppRequest extends Request {
  requestId?: string;
  tenant?: Tenant;
  session?: Session;
  scopes?: string[];
  leaseId?: string;
}
