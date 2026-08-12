import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from './config/config.module';
import { ErrorMapService } from './config/error-map.service';
import { ErrorFilter } from './common/error.filter';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { SERVER_KEY, ServerKeyProvider } from './auth/server-key';
import { TenantGuard } from './auth/tenant.guard';
import { AuthController } from './auth/auth.controller';
import { JwtService } from './auth/jwt.service';
import { MintRateLimiter } from './auth/mint-rate-limit';
import { WorkspaceGuard } from './auth/workspace.guard';
import { SessionRegistry } from './session/session.registry';
import { SESSION_CAPACITY, sessionCapacityFromEnv } from './session/session-capacity';
import { WorkspaceMutexInterceptor } from './session/workspace-mutex.interceptor';
import { WorkspaceController } from './session/workspace.controller';
import { AccountsController } from './session/accounts.controller';
import { AccountsService } from './session/accounts.service';
import { SignController } from './session/sign.controller';
import { NetworksController } from './session/networks.controller';
import { ExportController } from './export/export.controller';
import { TransactionsController } from './session/transactions.controller';
import { BalancesController } from './session/balances.controller';
import { ScopesGuard } from './auth/scopes.guard';
import { HealthController } from './health/health.controller';
import { KdfCheckService } from './kdf/kdf-check.service';
import { WorkspacesController } from './workspaces/workspaces.controller';
import { WorkspacesService } from './workspaces/workspaces.service';
import { WorkspaceStorageService } from './workspaces/workspace-storage.service';
import {
  RPC_DNS_RESOLVER,
  RPC_HTTPS_REQUESTER,
  RpcBoundaryService,
  systemRpcDnsResolver,
} from './session/rpc-boundary.service';
import { request as httpsRequest } from 'node:https';

@Module({
  imports: [ConfigModule],
  controllers: [HealthController, WorkspacesController, AuthController, WorkspaceController, AccountsController, SignController, NetworksController, ExportController, TransactionsController, BalancesController],
  providers: [
    { provide: SERVER_KEY, useFactory: () => ServerKeyProvider.fromEnv() },
    TenantGuard,
    WorkspaceGuard,
    JwtService,
    {
      provide: MintRateLimiter,
      useFactory: () => new MintRateLimiter(Number(process.env.TEE_MINT_RATE_LIMIT ?? 10)),
    },
    SessionRegistry,
    { provide: SESSION_CAPACITY, useFactory: sessionCapacityFromEnv },
    { provide: APP_INTERCEPTOR, useClass: WorkspaceMutexInterceptor },
    AccountsService,
    // NOT global: Nest runs global guards BEFORE controller-level ones, so a
    // global ScopesGuard would read req.scopes before WorkspaceGuard sets it
    // and deny every scoped route. Applied per-controller, after the guard
    // that populates the scopes.
    ScopesGuard,
    WorkspacesService,
    WorkspaceStorageService,
    { provide: RPC_DNS_RESOLVER, useValue: systemRpcDnsResolver },
    { provide: RPC_HTTPS_REQUESTER, useValue: httpsRequest },
    RpcBoundaryService,
    KdfCheckService,
    // Global, but registered as a provider so it can inject the config-driven
    // error map rather than reaching for a singleton.
    {
      provide: APP_FILTER,
      useFactory: (errors: ErrorMapService) => new ErrorFilter(errors),
      inject: [ErrorMapService],
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*path');
  }
}
