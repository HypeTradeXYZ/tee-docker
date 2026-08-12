import { randomUUID } from 'node:crypto';
import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import type { AppRequest } from './http';

/**
 * Stamps every request with an id, echoed in the response and in every log
 * line. 5xx bodies say only "internal error", so this id is the sole thread
 * from a caller's failed request back to the real cause in the logs.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: AppRequest, res: Response, next: NextFunction): void {
    const incoming = req.header('x-request-id');
    // Accept a caller-supplied id for tracing, but bound it — it lands in log
    // lines, and an unbounded header is a log-injection vector.
    req.requestId = incoming && incoming.length <= 128 ? incoming : randomUUID();
    res.setHeader('x-request-id', req.requestId);
    next();
  }
}
