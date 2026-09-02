import { z } from 'zod';
import { SECRET_HASH_RE } from '../auth/secret';

/** Tenant ids and workspace slugs become path components — keep them boring. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Slugs that would be confusing or dangerous as directory names.
 *
 * `.`, `..` and `node_modules` are already excluded by the grammar; they stay
 * listed so this reads as the complete intent rather than the remainder the
 * regex happens to leave.
 */
export const RESERVED_SLUGS = new Set(['.', '..', 'con', 'prn', 'aux', 'nul', 'node_modules']);

/** The reserved names a caller can actually trip, i.e. those the grammar admits. */
export const RESERVABLE_BY_GRAMMAR = [...RESERVED_SLUGS].filter((name) => SLUG_RE.test(name));

// A browser sends scheme://host[:port] and nothing else, so anything carrying a
// path, a wildcard or credentials could never match one and is a config error.
//
// Case-sensitive on purpose. A browser lower-cases the scheme and host when it
// serializes an Origin, and the allowlist is matched by exact string, so an
// entry carrying an upper-case letter can never match anything and would sit in
// the config looking effective. Refusing it at boot is the same bargain the
// rest of this file makes: an operator finds out while they are still editing,
// rather than from a browser failing silently in production. Normalizing it
// instead would quietly turn a dead entry into a live grant on upgrade.
export const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/;

// Ten years. Bounded so `now + ttl * 1000` stays inside the Date range: a
// larger value is schema-valid but makes toISOString() throw a RangeError on
// the SUCCESS path, i.e. an opaque 500 on every token mint.
const MAX_TTL_SEC = 315_360_000;

export const TtlSchema = z.object({
  workspaceIdleSec: z.number().int().positive().max(MAX_TTL_SEC).default(900),
  workspaceAbsoluteSec: z.number().int().positive().max(MAX_TTL_SEC).default(28_800),
  accountAbsoluteSec: z.number().int().positive().max(MAX_TTL_SEC).default(300),
});

export const LimitsSchema = z.object({
  maxWorkspaces: z.number().int().nonnegative(),
  maxWallets: z.number().int().nonnegative(),
  maxUnlockedWorkspaces: z.number().int().positive().safe().default(8),
});

export const TenantSchema = z.object({
  // A tenant id becomes a directory name, so it is held to the same reserved
  // list as a workspace slug. Without this the service boots clean and then
  // refuses every workspace create and token mint with a message about the
  // *workspace* slug — pointing the operator at a caller's correct input
  // instead of at their own configuration.
  // Chained checks all run, so a `.regex().refine()` pair would report BOTH a
  // grammar failure and a reserved-name failure for `node_modules` — handing
  // the operator a reserved list that does not contain what they wrote. One
  // check, one reason.
  id: z.string().superRefine((id, ctx) => {
    if (!SLUG_RE.test(id)) {
      ctx.addIssue({ code: 'custom', message: 'tenant id must be a lowercase slug' });
      return;
    }
    if (RESERVED_SLUGS.has(id)) {
      ctx.addIssue({
        code: 'custom',
        message: `tenant id must not be a reserved name (${RESERVABLE_BY_GRAMMAR.join(', ')})`,
      });
    }
  }),
  apiKey: z.string().min(16),
  /** HMAC-SHA256 of the API secret under the server key. Deliberately not a slow KDF: it is verified on every request, and the secret is high-entropy rather than user-chosen. */
  secretHash: z.string().regex(SECRET_HASH_RE, 'expected exactly 64 hexadecimal characters'),
  /** Absent disables export for this tenant. Doubles as the enable flag. */
  exportPublicKey: z
    .string()
    .regex(/^x25519:[A-Za-z0-9+/]{43}=$/, 'expected a canonical X25519 public key')
    .optional(),
  limits: LimitsSchema,
  ttl: TtlSchema.optional(),
  /** Seeds a new workspace's network registry at creation. */
  // Keys are network slugs and are looked up by exact slug, so an unconstrained
  // key is config that can never match — the same dead-entry class the origin
  // rule refuses. Left bare, `"Ethereum"` boots clean, warns once at the first
  // workspace create, and leaves the endpoint permanently unused. The sibling
  // records below already constrain their keys this way.
  rpc: z.record(z.string().regex(SLUG_RE, 'network keys must be lowercase slugs'), z.url())
    .optional(),
  allowDefaultRpc: z.boolean().optional(),
  /** Browser origins allowed to read this tenant's responses. Absent allows none. */
  origins: z
    .array(
      z.string().regex(
        ORIGIN_RE,
        'expected an origin like https://app.example.com: http or https, a host of'
          + ' lower-case letters, digits, dots or hyphens, an optional port, and nothing'
          + ' else — no path, wildcard, credentials or trailing slash. IPv6 literals and'
          + ' underscore hosts are not supported here.',
      ),
    )
    .optional(),
});

export const TenantsConfigSchema = z
  .object({ tenants: z.array(TenantSchema) })
  .superRefine((cfg, ctx) => {
    // Two tenants sharing an id or an API key is a cross-tenant data breach,
    // not a config typo. Refuse to boot rather than resolve it arbitrarily.
    for (const field of ['id', 'apiKey'] as const) {
      const seen = new Set<string>();
      for (const [i, tenant] of cfg.tenants.entries()) {
        if (seen.has(tenant[field])) {
          ctx.addIssue({
            code: 'custom',
            path: ['tenants', i, field],
            message: `duplicate tenant ${field}`,
          });
        }
        seen.add(tenant[field]);
      }
    }
  });

export const ErrorMappingSchema = z.object({
  status: z.number().int().min(100).max(599),
  code: z.string().min(1),
  exposeDetails: z.boolean().optional(),
  exposeMessage: z.boolean().optional(),
  /** Reviewed fixed text; never a provider/dependency exception message. */
  publicMessage: z.string().min(1).max(200).optional(),
}).strict().superRefine((mapping, ctx) => {
  // Every status, not just 5xx: the filter renders publicMessage whenever
  // exposeMessage is set, so a mapping without one would fall through to a
  // dependency's message at 4xx exactly as it used to at 5xx.
  if (mapping.exposeMessage === true && !mapping.publicMessage) {
    ctx.addIssue({
      code: 'custom',
      path: ['publicMessage'],
      message: 'an exposeMessage mapping requires a fixed publicMessage',
    });
  }
  // The message half of a 5xx is opaque by M-11's rule, so details must be too
  // — otherwise the same internal state leaves through the other channel.
  if (mapping.status >= 500 && mapping.exposeDetails === true) {
    ctx.addIssue({
      code: 'custom',
      path: ['exposeDetails'],
      message: 'a 5xx mapping must not expose details',
    });
  }
  if (mapping.publicMessage !== undefined && mapping.exposeMessage !== true) {
    ctx.addIssue({
      code: 'custom',
      path: ['publicMessage'],
      message: 'publicMessage requires exposeMessage: true',
    });
  }
});

export const ErrorsConfigSchema = z.object({
  defaultStatus: z.number().int().min(100).max(599).default(500),
  defaultExposeDetails: z.boolean().default(false),
  mappings: z.record(z.string(), ErrorMappingSchema),
}).strict();

export const WorkspaceStateSchema = z.object({
  slug: z.string().regex(SLUG_RE),
  createdAt: z.iso.datetime(),
  walletCount: z.number().int().nonnegative(),
});

export const WalletTagRecoverySchema = z.object({
  accountSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  walletId: z.number().int().nonnegative().safe(),
  oldTags: z.array(z.string().min(1).max(64)).max(32),
});

/**
 * Ceilings raised by the super-admin tier, persisted here rather than in the
 * boot-only operator config. tenants.json is mounted read-only in the shipped
 * deployment, so a lift cannot be written there; the state volume is the one
 * writable, durable home. Applied ON TOP of tenants.json at boot and after each
 * lift — never lowers a configured limit, so an absent field means "unchanged".
 */
export const LimitOverridesSchema = z.object({
  maxWorkspaces: z.number().int().nonnegative().safe().optional(),
  maxWallets: z.number().int().nonnegative().safe().optional(),
}).strict();

export const TenantStateSchema = z.object({
  walletTotal: z.number().int().nonnegative(),
  workspaces: z.array(WorkspaceStateSchema),
  /** Super-admin ceiling raises, replayed onto the operator config at boot. */
  limitOverrides: LimitOverridesSchema.optional(),
  /** Persisted absolute millisecond deadlines for recently deleted slugs. */
  workspaceCooldowns: z.record(z.string().regex(SLUG_RE), z.number().int().nonnegative().safe())
    .optional(),
  /** Pending old-tag snapshots are replayed before a reopened workspace is published. */
  walletTagRecoveries: z.record(z.string().regex(SLUG_RE), WalletTagRecoverySchema).optional(),
});

export const ServiceStateSchema = z.object({
  tenants: z.record(z.string(), TenantStateSchema),
});

export type RawTenant = z.infer<typeof TenantSchema>;
export type Ttl = z.infer<typeof TtlSchema>;
export type Limits = z.infer<typeof LimitsSchema>;
export type ErrorMapping = z.infer<typeof ErrorMappingSchema>;
export type ErrorsConfig = z.infer<typeof ErrorsConfigSchema>;
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;
export type WalletTagRecovery = z.infer<typeof WalletTagRecoverySchema>;
export type LimitOverrides = z.infer<typeof LimitOverridesSchema>;
export type TenantState = z.infer<typeof TenantStateSchema>;
export type ServiceState = z.infer<typeof ServiceStateSchema>;

/**
 * A tenant with every optional field resolved. Callers never apply defaults
 * themselves — normalization happens once, in the loader.
 */
export interface Tenant {
  readonly id: string;
  readonly apiKey: string;
  readonly secretHash: string;
  readonly exportPublicKey?: string;
  readonly limits: Limits;
  readonly ttl: Ttl;
  readonly rpc: Readonly<Record<string, string>>;
  readonly allowDefaultRpc: boolean;
  readonly exportEnabled: boolean;
  readonly origins: readonly string[];
}
