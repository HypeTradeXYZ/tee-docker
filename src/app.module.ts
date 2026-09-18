import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from './config/config.module';
import { ErrorMapService } from './config/error-map.service';
import { ErrorFilter } from './common/error.filter';
import { SERVER_KEY, ServerKeyProvider } from './auth/server-key';
import { TenantGuard } from './auth/tenant.guard';
import { AuthController } from './auth/auth.controller';
import { ApiKeyController } from './auth/api-key.controller';
import { ApiKeyService } from './auth/api-key.service';
import { AccountScopeGuard, WalletScopeGuard } from './auth/scope-binding.guard';
import { FunctionGateGuard } from './auth/function-gate.guard';
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
import { WalletBufferService } from './session/wallet-buffer.service';
import { BUFFER_CONFIG, bufferConfigFromEnv } from './session/buffer-config';
import { WorkspaceController } from './session/workspace.controller';
import { AccountsController } from './session/accounts.controller';
import { AccountsService } from './session/accounts.service';
import { WalletTagsService } from './session/wallet-tags.service';
import { SignController } from './session/sign.controller';
import { NetworksController } from './session/networks.controller';
import { ExportController } from './export/export.controller';
import { ScopesGuard } from './auth/scopes.guard';
import { HealthController } from './health/health.controller';
import { ShutdownState } from './health/shutdown.state';
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
import { AdminController } from './admin/admin.controller';
import { DiagnosticsService } from './admin/diagnostics.service';
import { AdminService } from './admin/admin.service';
import { AdminGuard } from './admin/admin.guard';
import { LimitOverrideReplay } from './admin/limit-override-replay';
import { ADMIN_RATE_CLOCK, AdminRateLimiter } from './admin/admin-rate-limit';
import { ADMIN_KEY, adminKeyFromEnv } from './admin/admin-key';
import {
  WORKSPACE_CREATION_CLOCK,
  WORKSPACE_CREATION_CONFIG,
  WorkspaceCreationLimiter,
  workspaceCreationConfigFromEnv,
} from './workspaces/workspace-creation-limiter';
import { ActivityLog } from './observability/activity-log.service';
import { ACTIVITY_CONFIG, activityConfigFromEnv } from './observability/activity-config';
import { RequestActivityInterceptor } from './observability/request-activity.interceptor';

@Module({
  imports: [ConfigModule],
  controllers: [HealthController, WorkspacesController, AuthController, ApiKeyController, WorkspaceController, AccountsController, SignController, NetworksController, ExportController, AdminController],
  providers: [
    { provide: SERVER_KEY, useFactory: () => ServerKeyProvider.fromEnv() },
    // Same env-timing reason as the limiters: parse inside the factory.
    { provide: ACTIVITY_CONFIG, useFactory: () => activityConfigFromEnv() },
    ActivityLog,
    { provide: APP_INTERCEPTOR, useClass: RequestActivityInterceptor },
    ShutdownState,
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
    // Env parsed inside the factory (main.ts loads env after the static import).
    { provide: BUFFER_CONFIG, useFactory: () => bufferConfigFromEnv() },
    WalletBufferService,
    // NOT global: Nest runs global guards BEFORE controller-level ones, so a
    // global ScopesGuard would read req.scopes before WorkspaceGuard sets it
    // and deny every scoped route. Applied per-controller, after the guard
    // that populates the scopes.
    ScopesGuard,
    // Same per-controller reasoning: these read the credential level/binding
    // that WorkspaceGuard derives, so they run after it, never globally.
    AccountScopeGuard,
    WalletScopeGuard,
    FunctionGateGuard,
    ApiKeyService,
    WorkspacesService,
    // Same reason as MintRateLimiter: env files are loaded after AppModule is
    // statically imported but before providers are constructed.
    { provide: ADMIN_KEY, useFactory: () => adminKeyFromEnv() },
    { provide: ADMIN_RATE_CLOCK, useValue: Date.now },
    AdminRateLimiter,
    AdminGuard,
    AdminService,
    DiagnosticsService,
    LimitOverrideReplay,
    { provide: WORKSPACE_CREATION_CLOCK, useValue: Date.now },
    { provide: WORKSPACE_CREATION_CONFIG, useFactory: workspaceCreationConfigFromEnv },
    WorkspaceCreationLimiter,
    WorkspaceStorageService,
    { provide: KDF_CHECK_CONFIG, useFactory: kdfCheckConfigFromEnv },
    { provide: KDF_PROBE_RUNNER, useValue: systemKdfProbeRunner },
    KdfCheckService,
    // Global, but registered as a provider so it can inject the config-driven
    // error map rather than reaching for a singleton.
    {
      provide: APP_FILTER,
      useFactory: (errors: ErrorMapService, activity: ActivityLog) =>
        new ErrorFilter(errors, activity),
      inject: [ErrorMapService, ActivityLog],
    },
  ],
})
export class AppModule {}
