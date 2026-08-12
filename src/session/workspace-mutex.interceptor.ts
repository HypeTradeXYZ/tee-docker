import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, lastValueFrom, type Observable } from 'rxjs';
import type { AppRequest } from '../common/http';
import { SessionRegistry } from './session.registry';
import { RPC_OPERATION, RpcOperationService } from './rpc-operation.service';

const SKIP_WORKSPACE_MUTEX = 'tee:skip-workspace-mutex';

/** Lifecycle routes coordinate inside SessionRegistry and must not hold the core mutex. */
export const SkipWorkspaceMutex = () => SetMetadata(SKIP_WORKSPACE_MUTEX, true);

/** Serializes every core-backed HTTP handler on its singleton workspace handle. */
@Injectable()
export class WorkspaceMutexInterceptor implements NestInterceptor {
  constructor(
    private readonly sessions: SessionRegistry,
    private readonly reflector: Reflector,
    private readonly rpcOperations: RpcOperationService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const skip = this.reflector.getAllAndOverride<boolean | undefined>(SKIP_WORKSPACE_MUTEX, [
      context.getHandler(),
      context.getClass(),
    ]);
    const session = context.switchToHttp().getRequest<AppRequest>().session;
    if (!session || skip === true) return next.handle();

    const invoke = () => this.sessions.withSession(session, () => lastValueFrom(next.handle()));
    const isRpc = this.reflector.getAllAndOverride<boolean | undefined>(RPC_OPERATION, [
      context.getHandler(),
      context.getClass(),
    ]);
    return from(
      isRpc === true ? this.rpcOperations.withPermit(session.tenantId, invoke) : invoke(),
    );
  }
}
