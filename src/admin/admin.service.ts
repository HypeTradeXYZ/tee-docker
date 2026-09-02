import { Inject, Injectable, Logger } from '@nestjs/common';
import { TeeError } from '../common/tee-error';
import { PATHS, type Paths } from '../config/paths';
import { OperatorConfigService } from '../config/operator-config.service';
import { TenantsConfigSchema } from '../config/schemas';
import { AsyncMutex } from '../session/async-mutex';
import { findRawTenant, readTenantsFile, writeTenantsFile } from './tenants-file';

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
  // Read-modify-write on a shared file. Without this two concurrent lifts each
  // read the same bytes and the second write silently discards the first.
  readonly #mutex = new AsyncMutex();

  constructor(
    @Inject(PATHS) private readonly paths: Paths,
    private readonly tenants: OperatorConfigService,
  ) {}

  /**
   * Raise a tenant's ceilings in tenants.json and in the running process.
   *
   * Raise-only: a value below what is already configured is refused, so a
   * leaked admin key cannot be used to freeze a tenant's growth. Lowering a
   * limit remains a hand-edit plus a restart.
   */
  async liftLimits(tenantId: string, requested: LimitRequest): Promise<LiftResult> {
    return this.#mutex.runExclusive(() => {
      if (!this.tenants.byId(tenantId)) {
        throw new TeeError('TEE_TENANT_NOT_FOUND', `no tenant "${tenantId}"`);
      }

      // Re-read rather than trusting the boot-time snapshot: an operator may
      // have hand-edited the file since, and those edits must survive this
      // write. It also makes the on-disk value the one raise-only compares
      // against, which is the value actually being replaced.
      const file = readTenantsFile(this.paths.tenantsFile);
      const entry = findRawTenant(file, tenantId);
      if (!entry) {
        throw new TeeError(
          'TEE_TENANT_NOT_FOUND',
          `tenant "${tenantId}" is no longer listed in the operator config`,
        );
      }

      const limits = entry.limits;
      if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) {
        throw new TeeError('TEE_TENANT_NOT_FOUND', `tenant "${tenantId}" has no limits block`);
      }
      const current = limits as Record<string, unknown>;

      // Every liftable field is checked, not just the requested ones: the
      // response reports both ceilings, and a file hand-edited to drop the
      // other one would otherwise be reported back as undefined.
      for (const field of LIFTABLE_LIMITS) {
        const existing = current[field];
        if (typeof existing !== 'number' || !Number.isInteger(existing)) {
          throw new TeeError('TEE_TENANT_NOT_FOUND', `tenant "${tenantId}" has no ${field} limit`);
        }
      }

      const changed: LiftableLimit[] = [];
      for (const field of LIFTABLE_LIMITS) {
        const next = requested[field];
        if (next === undefined) continue;

        const existing = current[field] as number;
        if (next < existing) {
          throw new TeeError(
            'TEE_LIMIT_NOT_RAISED',
            `${field} may only be raised; it is already ${existing}`,
            { limit: field, current: existing, requested: next },
          );
        }
        // Equal is an accepted no-op, so a retried request is idempotent.
        if (next > existing) {
          current[field] = next;
          changed.push(field);
        }
      }

      const applied = {
        maxWorkspaces: current.maxWorkspaces as number,
        maxWallets: current.maxWallets as number,
      };

      if (changed.length === 0) {
        return { tenant: tenantId, limits: applied, changed };
      }

      // Validate a THROWAWAY copy. Parsing strips the operator's _comment block
      // and inert _-prefixed markers, so the parsed graph must never be what
      // gets written back.
      TenantsConfigSchema.parse(structuredClone(file.raw));

      writeTenantsFile(this.paths.tenantsFile, file.raw);
      this.tenants.applyLimits(tenantId, applied);

      this.logger.warn(
        `super-admin raised ${changed.join(', ')} for tenant=${tenantId} `
          + `to ${changed.map((f) => `${f}=${applied[f]}`).join(', ')}`,
      );
      return { tenant: tenantId, limits: applied, changed };
    });
  }
}
