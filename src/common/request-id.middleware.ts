import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import type { AppRequest } from './http';

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Stamps every request with an id, echoed in the response and in every log
 * line. 5xx bodies say only "internal error", so this id is the sole thread
 * from a caller's failed request back to the real cause in the logs.
 */
export function requestIdMiddleware(
  req: AppRequest,
  res: Response,
  next: NextFunction,
): void {
  const incoming = req.header('x-request-id');
  // This value is reflected into both response headers and log lines. A small
  // safe alphabet prevents control characters and delimiter spoofing.
  req.requestId = incoming && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
}

/** Install before app.init()/listen(), which is when Nest adds body parsers. */
export function installRequestIdMiddleware(app: Pick<INestApplication, 'use'>): void {
  app.use(requestIdMiddleware);
}
