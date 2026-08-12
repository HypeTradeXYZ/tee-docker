import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AppRequest } from './http';
import { WativeError } from 'wative-core';
import { ErrorMapService } from '../config/error-map.service';
import { TeeError } from './tee-error';

interface ErrorBody {
  error: {
    code: string;
    message: string;
    status: number;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

/**
 * The single place an exception becomes an HTTP response.
 *
 * Status codes come from config/errors.json — nothing is hardcoded here, so
 * adding coverage for a new library error code is a config edit rather than a
 * redeploy.
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorFilter.name);

  constructor(private readonly errors: ErrorMapService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<AppRequest>();
    const requestId = req.requestId ?? 'unknown';

    const { status, body } = this.render(exception, requestId);

    // 5xx means we broke, not the caller — keep the real detail in logs only.
    if (status >= 500) {
      this.logger.error(
        `[${requestId}] ${body.error.code} ${status}: ${redactForLog(describe(exception))}`,
        exception instanceof Error ? redactForLog(exception.stack ?? '') : undefined,
      );
    } else {
      this.logger.warn(`[${requestId}] ${body.error.code} ${status}`);
    }

    res.status(status).json(body);
  }

  private render(exception: unknown, requestId: string): { status: number; body: ErrorBody } {
    // Nest's own exceptions (404 on an unknown route, payload-too-large, ...)
    // already carry a correct status; don't relabel them.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        status,
        body: {
          error: {
            code: httpCodeSlug(status),
            message: status >= 500 ? 'internal error' : exception.message,
            status,
            requestId,
          },
        },
      };
    }

    if (exception instanceof WativeError || exception instanceof TeeError) {
      const mapped = this.errors.resolve(exception.code);
      const body: ErrorBody = {
        error: {
          code: mapped.code,
          // A 5xx message may carry internal state; 4xx is the caller's own
          // fault and telling them why is the whole point.
          message: mapped.status >= 500 ? 'internal error' : exception.message,
          status: mapped.status,
          requestId,
        },
      };
      // `details` is opt-in per mapping — it is an arbitrary object and
      // forwarding it blindly is how paths and internal state leave the enclave.
      if (mapped.exposeDetails && exception.details) {
        body.error.details = exception.details;
      }
      return { status: mapped.status, body };
    }

    const status = this.errors.defaultStatus;
    return {
      status,
      body: { error: { code: 'internal_error', message: 'internal error', status, requestId } },
    };
  }
}

function httpCodeSlug(status: number): string {
  switch (status) {
    case 400:
      return 'bad_request';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 413:
      return 'payload_too_large';
    default:
      return status >= 500 ? 'internal_error' : 'request_failed';
  }
}

function describe(exception: unknown): string {
  if (exception instanceof Error) return `${exception.name}: ${exception.message}`;
  return String(exception);
}

/** Relay capabilities are bearer authority even though they are loopback-only. */
function redactForLog(value: string): string {
  return value.replace(
    /http:\/\/127\.0\.0\.1:\d+\/rpc\/[A-Za-z0-9_-]+/g,
    '[rpc-relay]',
  );
}
