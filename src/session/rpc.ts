import { TeeError } from '../common/tee-error';
import type { Tenant } from '../config/schemas';
import type { Session } from './session.registry';
import type { RpcBoundaryService } from './rpc-boundary.service';

export type RpcSource = 'tenant' | 'builtin' | 'none';

export interface ResolvedRpc {
  url: string | null;
  source: RpcSource;
}

/**
 * RPC resolution (DESIGN §6). tee-docker ships no RPC service.
 *
 * The workspace network registry is authoritative — a tenant's configured map
 * is seeded INTO it at workspace creation, so there is one source of truth at
 * read time rather than two that can disagree.
 *
 * The authenticated relay capability carries provenance. Explicit PUTs and
 * operator-config seeds are always `tenant`, even if their target happens to
 * equal a shipped URL. Only an implicit core default is `builtin`, and that
 * source is usable only when `allowDefaultRpc` is on.
 */
export function resolveRpc(
  session: Session,
  tenant: Tenant,
  slug: string,
  boundary: RpcBoundaryService,
): ResolvedRpc {
  const network = session.handle.networks.bySlug(slug as never);
  if (!network?.rpcUrl) return { url: null, source: 'none' };

  const capability = boundary.inspect(
    network.rpcUrl,
    tenant.id,
    session.workspaceSlug,
  );
  if (capability.source === 'builtin' && !tenant.allowDefaultRpc) {
    return { url: null, source: 'none' };
  }
  return { url: network.rpcUrl, source: capability.source };
}

/** Resolve or refuse. Every chain-touching route goes through this. */
export function requireRpc(
  session: Session,
  tenant: Tenant,
  slug: string,
  boundary: RpcBoundaryService,
): ResolvedRpc {
  const resolved = resolveRpc(session, tenant, slug, boundary);
  if (!resolved.url) {
    throw new TeeError(
      'TEE_RPC_NOT_CONFIGURED',
      `no RPC endpoint configured for network "${slug}"`,
      { network: slug },
    );
  }
  return resolved;
}
