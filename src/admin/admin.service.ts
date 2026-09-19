import { Injectable, Logger } from '@nestjs/common';
import { TeeError } from '../common/tee-error';
import { OperatorConfigService } from '../config/operator-config.service';
import { ServiceStateService } from '../config/service-state.service';
import type { LimitOverrides } from '../config/schemas';

/** The ceilings this tier may raise. maxUnlockedWorkspaces is deliberately out of reach. */
export const LIFTABLE_LIMITS = ['maxWorkspaces', 'maxWallets'] as const;
export type LiftableLimit = (typeof LIFTABLE_LIMITS)[number];

export type LimitRequest = Partial<Record<LiftableLimit, number>>;

export interface LiftResult {
  readonly tenant: string;
  readonly limits: Record<LiftableLimit, number>;
  readonly changed: LiftableLimit[];
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly tenants: OperatorConfigService,
    private readonly state: ServiceStateService,
  ) {}

  /**
   * Raise a tenant's ceilings, persisting the raise in state.json.
   *
   * tenants.json is mounted read-only in the shipped deployment, so the raise
   * is stored in the writable state volume as an override and re-applied to the
   * in-memory operator config both here and at boot. Raise-only: a value below
   * the current EFFECTIVE limit (config with any prior override already applied)
   * is refused, so a leaked admin key cannot freeze a tenant's growth.
   *
   * The write goes through ServiceStateService.mutate, which is already
   * serialized behind the state queue and the single-process lock, so
   * concurrent lifts cannot lose a write and no extra mutex is needed.
   */
  async liftLimits(tenantId: string, requested: LimitRequest): Promise<LiftResult> {
    const tenant = this.tenants.byId(tenantId);
    if (!tenant) {
      throw new TeeError('TEE_TENANT_NOT_FOUND', `no tenant "${tenantId}"`);
    }

    // The in-memory limit reflects base + any override replayed at boot, and is
    // what a raise-only request is measured against. Two concurrent lifts both
    // measure this at-request value (read before any commit), so both pass as
    // raises; the max-merge in the mutation below is what keeps a later commit
    // from regressing an earlier, higher one.
    const effective = {
      maxWorkspaces: tenant.limits.maxWorkspaces,
      maxWallets: tenant.limits.maxWallets,
    };

    const changed: LiftableLimit[] = [];
    const next = { ...effective };
    for (const field of LIFTABLE_LIMITS) {
      const value = requested[field];
      if (value === undefined) continue;
      if (value < effective[field]) {
        throw new TeeError(
          'TEE_LIMIT_NOT_RAISED',
          `${field} may only be raised; it is already ${effective[field]}`,
          { limit: field, current: effective[field], requested: value },
        );
      }
      // Equal is an accepted no-op, so a retried request is idempotent.
      if (value > effective[field]) {
        next[field] = value;
        changed.push(field);
      }
    }

    if (changed.length === 0) {
      return { tenant: tenantId, limits: effective, changed };
    }

    // Merge each raise into the override with a max, inside the serialized state
    // mutation — so a concurrent lift that committed a HIGHER ceiling first is
    // never overwritten (regressed) by this one's blind write.
    await this.state.mutate((draft) => {
      const row = Object.hasOwn(draft.tenants, tenantId)
        ? draft.tenants[tenantId]
        : (draft.tenants[tenantId] = { walletTotal: 0, workspaces: [] });
      const overrides: LimitOverrides = { ...(row.limitOverrides ?? {}) };
      for (const field of changed) {
        overrides[field] = Math.max(next[field], overrides[field] ?? next[field]);
      }
      row.limitOverrides = overrides;
    });

    // Publish to the running process, never lowering a ceiling a concurrent lift
    // may already have applied: re-read the live value and take the max.
    const running = this.tenants.byId(tenantId)?.limits ?? effective;
    const applied = {
      maxWorkspaces: Math.max(next.maxWorkspaces, running.maxWorkspaces),
      maxWallets: Math.max(next.maxWallets, running.maxWallets),
    };
    this.tenants.applyLimits(tenantId, applied);

    this.logger.warn(
      `super-admin raised ${changed.join(', ')} for tenant=${tenantId} `
        + `to ${changed.map((f) => `${f}=${applied[f]}`).join(', ')}`,
    );
    return { tenant: tenantId, limits: applied, changed };
  }
}
