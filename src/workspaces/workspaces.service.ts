import { Inject, Injectable, Logger } from '@nestjs/common';
import { Network, PasswordPolicy, Workspace, WativeError } from 'wative-core';
import { TeeError } from '../common/tee-error';
import { PATHS, type Paths } from '../config/paths';
import type { Tenant, WorkspaceState } from '../config/schemas';
import { ServiceStateService } from '../config/service-state.service';
import { SessionRegistry } from '../session/session.registry';
import { WorkspaceStorageService } from './workspace-storage.service';
import { workspacePath } from './workspace-paths';
import { RpcBoundaryService } from '../session/rpc-boundary.service';
import { WorkspaceCreationLimiter } from './workspace-creation-limiter';

const WORKSPACE_PASSWORD_POLICY = new PasswordPolicy();

@Injectable()
export class WorkspacesService {
  private readonly logger = new Logger(WorkspacesService.name);

  constructor(
    @Inject(PATHS) private readonly paths: Paths,
    private readonly state: ServiceStateService,
    private readonly sessions: SessionRegistry,
    private readonly storage: WorkspaceStorageService,
    private readonly rpcBoundary: RpcBoundaryService,
    private readonly creationLimiter: WorkspaceCreationLimiter,
  ) {}

  list(tenant: Tenant): readonly WorkspaceState[] {
    return this.state.tenant(tenant.id).workspaces;
  }

  quota(tenant: Tenant): {
    workspaces: { used: number; limit: number };
    wallets: { used: number; limit: number };
  } {
    const s = this.state.tenant(tenant.id);
    return {
      workspaces: { used: s.workspaces.length, limit: tenant.limits.maxWorkspaces },
      wallets: { used: s.walletTotal, limit: tenant.limits.maxWallets },
    };
  }

  async create(tenant: Tenant, slug: string, password: string): Promise<WorkspaceState> {
    // The policy is pure and intentionally runs before lifecycle/capacity,
    // quota, rate admission, filesystem access, or the expensive core KDF.
    // Preserve the caller's exact password bytes: no trim or normalization.
    WORKSPACE_PASSWORD_POLICY.enforce(password);
    return this.sessions.provisionWorkspace(tenant, slug, async (retainHandle) => {
      const path = workspacePath(this.paths.dataRoot, tenant.id, slug);

      // Reserve the slot BEFORE the expensive create, inside the state mutation
      // queue. Checking the quota outside it would let two concurrent requests
      // both pass a check for the last remaining slot.
      let refundCreationHit: (() => void) | undefined;
      let reserved: WorkspaceState;
      try {
        reserved = await this.state.mutate((draft): WorkspaceState => {
          const t = (draft.tenants[tenant.id] ??= { walletTotal: 0, workspaces: [] });

          if (t.workspaces.some((w) => w.slug === slug)) {
            throw new TeeError('TEE_WORKSPACE_EXISTS', `workspace "${slug}" already exists`);
          }
          if (t.workspaces.length >= tenant.limits.maxWorkspaces) {
            throw new TeeError(
              'TEE_QUOTA_WORKSPACES',
              `workspace limit reached (${tenant.limits.maxWorkspaces})`,
            );
          }

          const now = this.creationLimiter.now();
          const cooldowns = (t.workspaceCooldowns ??= {});
          for (const [candidate, deadline] of Object.entries(cooldowns)) {
            if (deadline <= now) delete cooldowns[candidate];
          }
          refundCreationHit = this.creationLimiter.admit(tenant.id, cooldowns[slug]);

          const entry: WorkspaceState = {
            slug,
            createdAt: new Date().toISOString(),
            walletCount: 0,
          };
          t.workspaces.push(entry);
          return entry;
        });
      } catch (err) {
        // A failed state commit reaches no core KDF and therefore should not
        // consume a creation attempt. Admission errors never return a refund.
        refundCreationHit?.();
        throw err;
      }

      try {
        // Workspace creation is the sole path allowed to initialize storage.
        const ws = await Workspace.open({ path, password });
        retainHandle(ws);
        // Seed the tenant's RPC endpoints into the workspace registry, which is
        // the single source of truth at read time (DESIGN §6).
        await this.seedRpc(ws, tenant, slug);
        await this.rpcBoundary.hardenWorkspace(ws, tenant.id, slug, tenant.rpc);
      } catch (err) {
        // Roll the reservation back, or a failed create permanently consumes a
        // quota slot for a workspace that does not exist.
        await this.state
          .mutate((draft) => {
            const t = draft.tenants[tenant.id];
            if (t) t.workspaces = t.workspaces.filter((w) => w.slug !== slug);
          })
          .catch((rollbackErr: unknown) => {
            this.logger.error(
              `quota rollback failed for ${tenant.id}/${slug}: ${String(rollbackErr)}`,
            );
          });
        throw err;
      } finally {
        // Provisioning never publishes an unlocked session, so its temporary
        // relay capabilities must not outlive the create-and-lock operation.
        this.rpcBoundary.revokeWorkspace(tenant.id, slug);
      }

      this.logger.log(`workspace created: ${tenant.id}/${slug}`);
      return reserved;
    });
  }

  /** Copy configured endpoints into the registry; a bad slug is skipped, not fatal. */
  private async seedRpc(ws: Workspace, tenant: Tenant, workspaceSlug: string): Promise<void> {
    for (const [slug, rpcUrl] of Object.entries(tenant.rpc)) {
      const network = ws.networks.bySlug(slug as never);
      if (!network) {
        this.logger.warn(`tenant ${tenant.id} configured RPC for unknown network "${slug}"`);
        continue;
      }
      const target = await this.rpcBoundary.admit(rpcUrl);
      await ws.networks.update(
        new Network({
          ...network,
          rpcUrl: this.rpcBoundary.relayUrl(
            target,
            tenant.id,
            workspaceSlug,
            'tenant',
          ),
        }),
      );
    }
  }

  async remove(tenant: Tenant, slug: string, force: boolean): Promise<void> {
    await this.sessions.deleteWorkspace(
      tenant.id,
      slug,
      force,
      () => this.state.tenant(tenant.id).workspaces.some((workspace) => workspace.slug === slug),
      async () => {
        // Storage first is fail-closed now that mint has an existing-only
        // preflight. A removal failure leaves the conservative ledger intact;
        // a later ledger failure leaves missing storage that mint cannot open.
        await this.storage.remove(tenant.id, slug);
        try {
          await this.state.mutate((draft) => {
            const t = draft.tenants[tenant.id];
            if (!t) return;
            t.workspaces = t.workspaces.filter((workspace) => workspace.slug !== slug);
            t.walletTotal = t.workspaces.reduce(
              (sum, workspace) => sum + workspace.walletCount,
              0,
            );
            const now = this.creationLimiter.now();
            const cooldowns = (t.workspaceCooldowns ??= {});
            for (const [candidate, deadline] of Object.entries(cooldowns)) {
              if (deadline <= now) delete cooldowns[candidate];
            }
            cooldowns[slug] = this.creationLimiter.recreateAfter();
            if (t.walletTagRecoveries) {
              delete t.walletTagRecoveries[slug];
              if (Object.keys(t.walletTagRecoveries).length === 0) {
                delete t.walletTagRecoveries;
              }
            }
          });
        } catch (err) {
          this.logger.error(`workspace ledger removal failed for ${tenant.id}/${slug}: ${String(err)}`);
          throw new WativeError('PROVIDER_IO', 'workspace deletion could not be persisted', {
            cause: err,
          });
        }
        this.logger.log(`workspace removed: ${tenant.id}/${slug}`);
      },
    );
  }
}
