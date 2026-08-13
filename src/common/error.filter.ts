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

    let rendered: { status: number; body: ErrorBody };
    try {
      rendered = this.render(exception, requestId);
    } catch {
      // Exception values are untrusted too: proxies can throw from
      // instanceof, property access, or string conversion. The error boundary
      // must remain total and still write an opaque response.
      rendered = this.genericError(requestId);
    }
    const { status, body } = rendered;

    // 5xx diagnostics stay in logs. A few caller-actionable responses use only
    // reviewed fixed public text; their real exception detail still stays here.
    if (status >= 500) {
      this.logger.error(
        `[${requestId}] ${body.error.code} ${status}: ${redactForLog(describe(exception))}`,
        safeStack(exception),
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
      if (!Number.isSafeInteger(status) || status < 400 || status > 599) {
        return this.genericError(requestId);
      }
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
          // Raw 5xx messages may carry internal state. Only fixed reviewed text
          // from the error map is eligible for a server-error response.
          message: mapped.status >= 500
            ? mapped.exposeMessage && mapped.publicMessage
              ? mapped.publicMessage
              : 'internal error'
            : exception.message,
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

    // Express body parsers use ordinary Error objects carrying numeric status
    // fields. Only accept a narrow, internally consistent HTTP status shape;
    // never reflect their message or parser metadata to the caller.
    const plainStatus = numericErrorStatus(exception);
    if (plainStatus !== undefined) {
      return {
        status: plainStatus,
        body: {
          error: {
            code: httpCodeSlug(plainStatus),
            message: httpPublicMessage(plainStatus),
            status: plainStatus,
            requestId,
          },
        },
      };
    }

    return this.genericError(requestId);
  }

  private genericError(requestId: string): { status: number; body: ErrorBody } {
    const status = this.errors.defaultStatus;
    return {
      status,
      body: { error: { code: 'internal_error', message: 'internal error', status, requestId } },
    };
  }
}

function numericErrorStatus(exception: unknown): number | undefined {
  if ((typeof exception !== 'object' || exception === null) && typeof exception !== 'function') {
    return undefined;
  }

  const status = readStatusField(exception, 'status');
  const statusCode = readStatusField(exception, 'statusCode');
  if (!status.present && !statusCode.present) return undefined;
  if (!status.valid || !statusCode.valid) return undefined;
  if (status.present && statusCode.present && status.value !== statusCode.value) return undefined;
  return status.present ? status.value : statusCode.value;
}

function readStatusField(
  value: object | Function,
  key: 'status' | 'statusCode',
): { present: boolean; valid: boolean; value?: number } {
  try {
    if (!(key in value)) return { present: false, valid: true };
    const candidate = Reflect.get(value, key);
    if (
      typeof candidate !== 'number'
      || !Number.isSafeInteger(candidate)
      || candidate < 400
      || candidate > 599
    ) {
      return { present: true, valid: false };
    }
    return { present: true, valid: true, value: candidate };
  } catch {
    return { present: true, valid: false };
  }
}

function httpPublicMessage(status: number): string {
  switch (status) {
    case 400:
      return 'bad request';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not found';
    case 413:
      return 'payload too large';
    default:
      return status >= 500 ? 'internal error' : 'request failed';
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
  try {
    if (exception instanceof Error) return `${exception.name}: ${exception.message}`;
    return String(exception);
  } catch {
    return 'uninspectable exception';
  }
}

function safeStack(exception: unknown): string | undefined {
  try {
    return exception instanceof Error ? redactForLog(exception.stack ?? '') : undefined;
  } catch {
    return undefined;
  }
}

/** Relay capabilities are bearer authority even though they are loopback-only. */
function redactForLog(value: string): string {
  return value.replace(
    /http:\/\/127\.0\.0\.1:\d+\/rpc\/[A-Za-z0-9_-]+/g,
    '[rpc-relay]',
  );
}
