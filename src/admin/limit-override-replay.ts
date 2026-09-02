import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { OperatorConfigService } from '../config/operator-config.service';
import { ServiceStateService } from '../config/service-state.service';

/**
 * Re-applies persisted super-admin ceiling raises onto the operator config.
 *
 * tenants.json is boot-only and, in the shipped deployment, read-only, so a
 * lift lives in state.json. This replays those overrides into the in-memory
 * config at startup — before the server accepts traffic — so a restart does not
 * silently drop a ceiling back to its tenants.json value.
 *
 * Each field takes the HIGHER of the configured and the overridden value, so a
 * configured limit an operator hand-raises above the override still wins, and
 * the override can only ever raise, never lower.
 */
@Injectable()
export class LimitOverrideReplay implements OnApplicationBootstrap {
  private readonly logger = new Logger(LimitOverrideReplay.name);

  constructor(
    private readonly tenants: OperatorConfigService,
    private readonly state: ServiceStateService,
  ) {}

  onApplicationBootstrap(): void {
    this.apply();
  }

  /** Split out so a test can invoke the replay without a full bootstrap. */
  apply(): void {
    for (const { id, state } of this.state.tenants()) {
      const overrides = state.limitOverrides;
      if (!overrides) continue;

      const tenant = this.tenants.byId(id);
      if (!tenant) {
        // A raise persisted for a tenant since removed from tenants.json. Not
        // an error: the operator dropped the tenant, and the stale row is
        // harmless until the next mutation rewrites it.
        this.logger.warn(`ignoring limit override for unknown tenant=${id}`);
        continue;
      }

      const raised = {
        maxWorkspaces: Math.max(tenant.limits.maxWorkspaces, overrides.maxWorkspaces ?? 0),
        maxWallets: Math.max(tenant.limits.maxWallets, overrides.maxWallets ?? 0),
      };
      if (
        raised.maxWorkspaces === tenant.limits.maxWorkspaces &&
        raised.maxWallets === tenant.limits.maxWallets
      ) {
        continue;
      }

      this.tenants.applyLimits(id, raised);
      this.logger.warn(
        `replayed limit override for tenant=${id}: `
          + `maxWorkspaces=${raised.maxWorkspaces}, maxWallets=${raised.maxWallets}`,
      );
    }
  }
}
