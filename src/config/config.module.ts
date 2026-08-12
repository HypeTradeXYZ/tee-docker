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
      useFactory: (paths: Paths) => ServiceStateService.fromFile(paths),
      inject: [PATHS],
    },
  ],
  exports: [PATHS, OperatorConfigService, ErrorMapService, ServiceStateService],
})
export class ConfigModule {}
