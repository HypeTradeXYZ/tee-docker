import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { Response } from 'express';
import type { AppRequest } from '../common/http';
import { ActivityLog } from './activity-log.service';

/**
 * Records one completion event per HTTP request — success or error — from the
 * response `finish` event, where the status is already final and the guards
 * have populated the request's tenant/credential bindings.
 *
 * It never touches the response: it only reads it, so it cannot change what a
 * caller receives. The matching internal error code/reason is joined by the
 * error filter under the same requestId.
 */
@Injectable()
export class RequestActivityInterceptor implements NestInterceptor {
  constructor(private readonly activity: ActivityLog) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const req = http.getRequest<AppRequest>();
    const res = http.getResponse<Response>();
    const startedAt = Date.now();

    // `finish` fires once the full response is written, after the filter has set
    // the status; a route template (never the filled path) keeps slugs out.
    res.once('finish', () => {
      this.activity.emit('request', {
        method: req.method,
        route: routeTemplate(req),
        op: `${context.getClass().name}.${context.getHandler().name}`,
        status: res.statusCode,
        latencyMs: Date.now() - startedAt,
        requestId: req.requestId,
        tenant: req.tenant?.id,
        level: req.credentialLevel,
        account: req.accountBinding,
        wid: req.walletBinding?.wid,
      });
    });

    return next.handle();
  }
}

function routeTemplate(req: AppRequest): string {
  const route = (req as { route?: { path?: unknown } }).route;
  return typeof route?.path === 'string' ? route.path : 'unmatched';
}
