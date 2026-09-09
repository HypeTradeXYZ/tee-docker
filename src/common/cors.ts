import type { INestApplication } from '@nestjs/common';

type OriginCallback = (err: Error | null, allow?: boolean) => void;

interface CorsOptions {
  origin: string | ((origin: string | undefined, cb: OriginCallback) => void);
  methods: readonly string[];
  allowedHeaders: readonly string[];
  exposedHeaders: readonly string[];
  credentials: boolean;
  maxAge: number;
}

type CorsCallback = (err: Error | null, options?: CorsOptions) => void;

interface CorsRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}

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

// Tenant-credential routes: browser reads stay allowlisted. Every other route is
// where a scoped API key (an end user's browser credential) operates, so it is
// open to any origin. A preflight cannot see the credential, only the path and
// method, which is exactly what separates these two sets.
function isTenantRoute(method: string, path: string): boolean {
  if (path === '/v1/workspaces' || path.startsWith('/v1/workspaces/')) return true;
  if (path === '/v1/quota') return true;
  if (path === '/v1/auth/api-key') return true;
  // POST mints a token (tenant); DELETE revokes one (a scoped key may send it).
  if (path === '/v1/auth/token') return method === 'POST';
  return false;
}

// A preflight's real verb is its Access-Control-Request-Method, not OPTIONS.
function effectiveMethod(req: CorsRequest): string {
  const raw = (req.method ?? 'GET').toUpperCase();
  if (raw !== 'OPTIONS') return raw;
  const requested = req.headers['access-control-request-method'];
  const value = Array.isArray(requested) ? requested[0] : requested;
  return (value ?? 'OPTIONS').toUpperCase();
}

function pathOf(req: CorsRequest): string {
  const url = req.url ?? '/';
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

/**
 * Browser access, split by route. The scoped-key routes (accounts, wallets,
 * signing, transactions, export, and the rest of the bearer surface) allow any
 * origin, because a scoped API key is designed to be held in an end user's
 * browser on a domain the operator does not know. The six tenant-credential
 * routes keep the per-tenant `origins` allowlist, because those credentials are
 * server-side only and must never be wielded cross-origin from a page.
 *
 * Credentials stay off throughout: authentication is header-based and nothing
 * reads a cookie, so no origin gains authority it did not already hold a key for.
 */
export function installCors(app: INestApplication, origins: readonly string[]): void {
  const allowed = new Set(origins);
  const base = {
    methods: METHODS,
    allowedHeaders: ALLOWED_HEADERS,
    exposedHeaders: EXPOSED_HEADERS,
    credentials: false,
    maxAge: 600,
  } as const;

  const delegate = (req: CorsRequest, callback: CorsCallback): void => {
    if (isTenantRoute(effectiveMethod(req), pathOf(req))) {
      callback(null, {
        ...base,
        origin: (origin: string | undefined, cb: OriginCallback): void =>
          cb(null, typeof origin === 'string' && allowed.has(origin)),
      });
      return;
    }
    callback(null, { ...base, origin: '*' });
  };

  app.enableCors(delegate as Parameters<INestApplication['enableCors']>[0]);
}
