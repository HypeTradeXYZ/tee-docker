import type { INestApplication } from '@nestjs/common';

type OriginCallback = (err: Error | null, allow?: boolean) => void;

/** Unreadable from script unless named here, and all three are documented as readable. */
const EXPOSED_HEADERS = ['x-request-id', 'retry-after', 'x-rpc-source'];

const ALLOWED_HEADERS = [
  'authorization',
  'content-type',
  'x-api-key',
  'x-api-secret',
  'x-request-id',
];

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'];

/**
 * Browser access, allowlisted per tenant.
 *
 * A preflight carries no credentials, so the origin is tested against every
 * tenant's list at once rather than one tenant's. That grants nothing: CORS
 * decides only whether a browser may READ a response it was already authorized
 * to receive, and every route still requires an API key and a token.
 *
 * Origins are passed in rather than resolved from the container: reading a
 * provider here runs before the application is initialised, which reorders
 * startup for every caller and is not worth a saved argument.
 */
export function installCors(app: INestApplication, origins: readonly string[]): void {
  const allowed = new Set(origins);
  if (allowed.size === 0) return;

  app.enableCors({
    // A request without an Origin is not a browser one; leaving it unmatched
    // omits the header entirely rather than answering a question nobody asked.
    origin: (origin: string | undefined, callback: OriginCallback): void =>
      callback(null, typeof origin === 'string' && allowed.has(origin)),
    methods: METHODS,
    allowedHeaders: ALLOWED_HEADERS,
    exposedHeaders: EXPOSED_HEADERS,
    // Authentication is header-based and nothing reads a cookie, so omitting
    // Allow-Credentials is what keeps a strict allowlist sufficient.
    credentials: false,
    maxAge: 600,
  });
}
