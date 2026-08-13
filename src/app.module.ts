import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from './config/config.module';
import { ErrorMapService } from './config/error-map.service';
import { ErrorFilter } from './common/error.filter';
import { SERVER_KEY, ServerKeyProvider } from './auth/server-key';
import { TenantGuard } from './auth/tenant.guard';
import { AuthController } from './auth/auth.controller';
import { JwtService } from './auth/jwt.service';
import { MintRateLimiter, mintRateLimitFromEnv } from './auth/mint-rate-limit';
import { ACCOUNT_UNLOCK_CLOCK, AccountUnlockLimiter } from './auth/account-unlock-limiter';
import { WorkspaceGuard } from './auth/workspace.guard';
import {
  ACCOUNT_CUSTODY_CLOCK,
  ACCOUNT_CUSTODY_SCHEDULER,
  SessionRegistry,
  systemAccountCustodyScheduler,
} from './session/session.registry';
import { SESSION_CAPACITY, sessionCapacityFromEnv } from './session/session-capacity';
import { WorkspaceMutexInterceptor } from './session/workspace-mutex.interceptor';
import { WorkspaceController } from './session/workspace.controller';
import { AccountsController } from './session/accounts.controller';
import { AccountsService } from './session/accounts.service';
import { WalletTagsService } from './session/wallet-tags.service';
import { SignController } from './session/sign.controller';
import { NetworksController } from './session/networks.controller';
import { ExportController } from './export/export.controller';
import { TransactionsController } from './session/transactions.controller';
import { BalancesController } from './session/balances.controller';
import { BalanceCapabilityGuard } from './session/balance-capability';
import { ScopesGuard } from './auth/scopes.guard';
import { HealthController } from './health/health.controller';
import {
  KDF_CHECK_CONFIG,
  KDF_PROBE_RUNNER,
  KdfCheckService,
  kdfCheckConfigFromEnv,
  systemKdfProbeRunner,
} from './kdf/kdf-check.service';
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
import {
  RPC_OPERATION_CONFIG,
  RpcOperationService,
  rpcOperationConfigFromEnv,
} from './session/rpc-operation.service';
import {
  WORKSPACE_CREATION_CLOCK,
  WORKSPACE_CREATION_CONFIG,
  WorkspaceCreationLimiter,
  workspaceCreationConfigFromEnv,
} from './workspaces/workspace-creation-limiter';

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
      // Keep env parsing inside the provider factory. main.ts loads env files
      // after its static AppModule import, but before Nest constructs providers.
      useFactory: () => new MintRateLimiter(mintRateLimitFromEnv()),
    },
    { provide: ACCOUNT_UNLOCK_CLOCK, useValue: Date.now },
    AccountUnlockLimiter,
    { provide: ACCOUNT_CUSTODY_CLOCK, useValue: Date.now },
    { provide: ACCOUNT_CUSTODY_SCHEDULER, useValue: systemAccountCustodyScheduler },
    SessionRegistry,
    { provide: SESSION_CAPACITY, useFactory: sessionCapacityFromEnv },
    { provide: APP_INTERCEPTOR, useClass: WorkspaceMutexInterceptor },
    AccountsService,
    WalletTagsService,
    // NOT global: Nest runs global guards BEFORE controller-level ones, so a
    // global ScopesGuard would read req.scopes before WorkspaceGuard sets it
    // and deny every scoped route. Applied per-controller, after the guard
    // that populates the scopes.
    ScopesGuard,
    WorkspacesService,
    { provide: WORKSPACE_CREATION_CLOCK, useValue: Date.now },
    { provide: WORKSPACE_CREATION_CONFIG, useFactory: workspaceCreationConfigFromEnv },
    WorkspaceCreationLimiter,
    WorkspaceStorageService,
    { provide: RPC_DNS_RESOLVER, useValue: systemRpcDnsResolver },
    { provide: RPC_HTTPS_REQUESTER, useValue: httpsRequest },
    RpcBoundaryService,
    { provide: RPC_OPERATION_CONFIG, useFactory: rpcOperationConfigFromEnv },
    RpcOperationService,
    BalanceCapabilityGuard,
    { provide: KDF_CHECK_CONFIG, useFactory: kdfCheckConfigFromEnv },
    { provide: KDF_PROBE_RUNNER, useValue: systemKdfProbeRunner },
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
export class AppModule {}
