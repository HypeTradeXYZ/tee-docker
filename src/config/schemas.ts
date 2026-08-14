import { z } from 'zod';
import { SECRET_HASH_RE } from '../auth/secret';

/** Tenant ids and workspace slugs become path components — keep them boring. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const TtlSchema = z.object({
  workspaceIdleSec: z.number().int().positive().default(900),
  workspaceAbsoluteSec: z.number().int().positive().default(28_800),
  accountAbsoluteSec: z.number().int().positive().default(300),
});

export const LimitsSchema = z.object({
  maxWorkspaces: z.number().int().nonnegative(),
  maxWallets: z.number().int().nonnegative(),
  maxUnlockedWorkspaces: z.number().int().positive().safe().default(8),
});

export const TenantSchema = z.object({
  id: z.string().regex(SLUG_RE, 'tenant id must be a lowercase slug'),
  apiKey: z.string().min(16),
  /** HMAC-SHA256 of the API secret. Not a slow KDF — see DESIGN.md §10. */
  secretHash: z.string().regex(SECRET_HASH_RE, 'expected exactly 64 hexadecimal characters'),
  /** Absent disables export for this tenant. Doubles as the enable flag. */
  exportPublicKey: z
    .string()
    .regex(/^x25519:[A-Za-z0-9+/]{43}=$/, 'expected a canonical X25519 public key')
    .optional(),
  limits: LimitsSchema,
  ttl: TtlSchema.optional(),
  /** Seeds a new workspace's network registry at creation. */
  rpc: z.record(z.string(), z.url()).optional(),
  allowDefaultRpc: z.boolean().optional(),
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
  if (mapping.status >= 500 && mapping.exposeMessage === true && !mapping.publicMessage) {
    ctx.addIssue({
      code: 'custom',
      path: ['publicMessage'],
      message: 'a 5xx exposeMessage mapping requires a fixed publicMessage',
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

export const TenantStateSchema = z.object({
  walletTotal: z.number().int().nonnegative(),
  workspaces: z.array(WorkspaceStateSchema),
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
}
