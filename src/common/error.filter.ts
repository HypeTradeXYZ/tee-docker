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
import { reviewedMessageOrUndefined } from './reviewed-message';
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
      // Prove the body serializes while still inside the hardened region. The
      // write below stringifies again outside it, where a BigInt, a cycle or a
      // throwing getter would escape the filter and leave the request with no
      // reviewed response at all.
      if (typeof JSON.stringify(rendered.body) !== 'string') {
        throw new TypeError('unserializable body');
      }
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
    // Nest's own exceptions (404 on an unknown route, ...) already carry a
    // correct status; honour it and never relabel it. Their *message*, however,
    // is untrusted: Nest builds it itself from the request line ("Cannot GET
    // /path?token=..."), or by rewriting a dependency error —
    // `routes-resolver.mapExternalException` wraps SyntaxError/URIError as
    // BadRequestException(err.message), discarding the cause and every parser
    // marker, so the text is caller-controlled request bytes with no way to
    // detect its origin here. Honour the status, never the message.
    // (Body-parser's payload-too-large is NOT one of these: it stays a plain
    // Error carrying a numeric status and is rendered by numericErrorStatus.)
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
            message: httpPublicMessage(status),
            status,
            requestId,
          },
        },
      };
    }

    if (exception instanceof WativeError || exception instanceof TeeError) {
      const mapped = this.errors.resolve(exception.code);
      // One rule at every status. A dependency's message is never rendered:
      // it can name enclave paths, and a reworded string under an existing
      // code is undetectable. Only reviewed map text or a message tee-docker
      // authored and branded is eligible, and unbranded fails closed.
      const reviewed = reviewedMessageOrUndefined(exception);
      const body: ErrorBody = {
        error: {
          code: mapped.code,
          message: publicText(mapped, reviewed),
          status: mapped.status,
          requestId,
        },
      };
      // `details` is opt-in per mapping AND per author — it is an arbitrary
      // object and forwarding it blindly is how internal state leaves the
      // enclave. A future core release adding its own `details` cannot ride
      // this, because an unbranded error never reaches it.
      if (mapped.exposeDetails && reviewed !== undefined && exception.details) {
        const safe = jsonSafe(exception.details, { nodes: MAX_DETAIL_NODES });
        if (safe !== undefined) body.error.details = safe as Record<string, unknown>;
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

const MAX_DETAIL_DEPTH = 5;
const MAX_DETAIL_ITEMS = 32;
const MAX_DETAIL_NODES = 256;
const MAX_DETAIL_STRING = 200;

// NaN and Infinity serialize to null, so a client reading a contractually
// numeric field gets a silent lie. Rebuild the payload from plain accumulators
// and refuse anything that cannot be represented exactly: an exotic object that
// survives here would be serialized a second time by the response writer, where
// its toJSON could disagree with what was validated.
function jsonSafe(value: unknown, budget: { nodes: number }, depth = 0): unknown {
  if (depth > MAX_DETAIL_DEPTH) return undefined;
  if (budget.nodes <= 0) return undefined;
  budget.nodes -= 1;
  if (value === null) return null;

  switch (typeof value) {
    case 'string':
      return value.length > MAX_DETAIL_STRING ? undefined : value;
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : undefined;
    case 'object':
      break;
    default:
      return undefined;
  }

  try {
    // Boxed primitives, Date, typed arrays and every other exotic render as
    // something other than their value; only plain objects and arrays pass.
    const tag = Object.prototype.toString.call(value);
    if (tag !== '[object Object]' && tag !== '[object Array]') return undefined;

    if (Array.isArray(value)) {
      if (value.length > MAX_DETAIL_ITEMS) return undefined;
      const out: unknown[] = [];
      for (let i = 0; i < value.length; i += 1) {
        // A hole is not a value; map/some would let it through as null.
        if (!Object.prototype.hasOwnProperty.call(value, i)) return undefined;
        const safe = jsonSafe(value[i], budget, depth + 1);
        if (safe === undefined) return undefined;
        out.push(safe);
      }
      return out;
    }

    const source = value as Record<string, unknown>;
    const keys = Object.keys(source);
    if (keys.length > MAX_DETAIL_ITEMS) return undefined;
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      // Assigning this key would run a setter and rebind the accumulator.
      if (key === '__proto__') return undefined;
      const safe = jsonSafe(source[key], budget, depth + 1);
      if (safe === undefined) return undefined;
      Object.defineProperty(out, key, {
        value: safe,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  } catch {
    return undefined;
  }
}

// Reviewed map text wins everywhere. A 5xx stays opaque even when tee-docker
// authored the message, because M-11 reviewed exactly which server errors may
// speak. Below 500 an authored message is renderable; a dependency's is not.
function publicText(
  mapped: { status: number; exposeMessage?: boolean; publicMessage?: string },
  reviewed: string | undefined,
): string {
  if (mapped.exposeMessage && mapped.publicMessage) return mapped.publicMessage;
  if (mapped.status >= 500) return 'internal error';
  return reviewed ?? httpPublicMessage(mapped.status);
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
