import { Global, Module } from '@nestjs/common';
import { PATHS, resolvePaths, type Paths } from './paths';
import { OperatorConfigService } from './operator-config.service';
import { ErrorMapService } from './error-map.service';
import { ServiceStateService } from './service-state.service';

/**
 * All three config files load here, at boot. Every one of them can refuse to
 * start the process: a wallet service with an ambiguous tenant table or an
 * unreadable quota ledger should not accept traffic.
 */
@Global()
@Module({
  providers: [
    { provide: PATHS, useFactory: (): Paths => resolvePaths() },
    {
      provide: OperatorConfigService,
      useFactory: (paths: Paths) => OperatorConfigService.fromFile(paths),
      inject: [PATHS],
    },
    {
      provide: ErrorMapService,
      useFactory: (paths: Paths) => ErrorMapService.fromFile(paths),
      inject: [PATHS],
    },
    {
      provide: ServiceStateService,
      useFactory: (paths: Paths) => {
        // Published so a boot that fails later inside NestFactory.create can
        // still release the lock this process itself took. Releasing your own
        // lock is not the reclaim DESIGN forbids: no liveness is inferred, and
        // it is immune to PID reuse, containers and concurrent reapers.
        const state = ServiceStateService.fromFile(paths);
        heldServiceState = state;
        return state;
      },
      inject: [PATHS],
    },
  ],
  exports: [PATHS, OperatorConfigService, ErrorMapService, ServiceStateService],
})
export class ConfigModule {}

let heldServiceState: ServiceStateService | undefined;

/** The state service this process constructed, if it got that far. */
export function takeHeldServiceState(): ServiceStateService | undefined {
  const held = heldServiceState;
  heldServiceState = undefined;
  return held;
}
