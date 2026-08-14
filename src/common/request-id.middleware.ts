import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import type { AppRequest } from './http';

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Stamps every application request with an id echoed in the response. Error
 * responses and their ErrorFilter log records carry the same id, providing a
 * safe correlation thread while internal 5xx bodies remain opaque.
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
