import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger, type ArgumentsHost } from '@nestjs/common';
import { WativeError } from 'wative-core';
import { ErrorFilter } from '../src/common/error.filter';
import { ErrorMapService } from '../src/config/error-map.service';
import { ErrorsConfigSchema } from '../src/config/schemas';

describe('reviewed transaction/RPC error rendering', () => {
  const config = ErrorsConfigSchema.parse(
    JSON.parse(readFileSync(resolve(__dirname, '../config/errors.json'), 'utf8')),
  );
  const filter = new ErrorFilter(new ErrorMapService(config));

  it.each([
    ['TX_ABORTED', 409, 'tx_aborted', 'caller-visible abort'],
    ['RPC_REJECTED', 502, 'rpc_rejected', 'internal error'],
  ] as const)('renders %s intentionally', (coreCode, status, publicCode, message) => {
    const json = jest.fn();
    const statusFn = jest.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status: statusFn }),
        getRequest: () => ({ requestId: 'request-m01' }),
      }),
    } as unknown as ArgumentsHost;

    filter.catch(
      new WativeError(coreCode, 'caller-visible abort', {
        details: { secret: 'never expose' },
      }),
      host,
    );

    expect(statusFn).toHaveBeenCalledWith(status);
    expect(json).toHaveBeenCalledWith({
      error: {
        code: publicCode,
        message,
        status,
        requestId: 'request-m01',
      },
    });
  });
});

describe('plain HTTP-status error rendering', () => {
  const config = ErrorsConfigSchema.parse(
    JSON.parse(readFileSync(resolve(__dirname, '../config/errors.json'), 'utf8')),
  );
  const filter = new ErrorFilter(new ErrorMapService(config));

  function render(exception: unknown) {
    const json = jest.fn();
    const response = { status: jest.fn(() => ({ json })) };
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ requestId: 'parser-request' }),
      }),
    } as unknown as ArgumentsHost;
    filter.catch(exception, host);
    const statusCalls = response.status.mock.calls as unknown as Array<[number]>;
    return {
      status: statusCalls[0]?.[0],
      body: json.mock.calls[0]?.[0],
    };
  }

  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it.each([
    [{ status: 400 }, 400, 'bad_request', 'bad request'],
    [{ statusCode: 413 }, 413, 'payload_too_large', 'payload too large'],
    [{ status: 413, statusCode: 413 }, 413, 'payload_too_large', 'payload too large'],
  ] as const)('honors a safe numeric parser status', (exception, status, code, message) => {
    expect(render(exception)).toEqual({
      status,
      body: { error: { code, message, status, requestId: 'parser-request' } },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it.each([
    { status: '413' },
    { status: Number.NaN },
    { status: 413.5 },
    { status: 399 },
    { status: 600 },
    { status: 400, statusCode: 413 },
    Object.defineProperty({}, 'status', { get: () => { throw new Error('getter secret'); } }),
  ])('fails closed for an untrusted status shape', (exception) => {
    expect(render(exception)).toEqual({
      status: 500,
      body: {
        error: {
          code: 'internal_error',
          message: 'internal error',
          status: 500,
          requestId: 'parser-request',
        },
      },
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never reflects a parser message, body, or metadata', () => {
    const rendered = render(Object.assign(new Error('SECRET malformed body'), {
      status: 400,
      type: 'entity.parse.failed',
      body: '{"secret":"SECRET"}',
      limit: 102400,
    }));
    expect(JSON.stringify(rendered)).not.toContain('SECRET');
    expect(rendered.status).toBe(400);
  });

  it.each([
    ['getPrototypeOf proxy', new Proxy({}, {
      getPrototypeOf: () => { throw new Error('prototype trap secret'); },
    })],
    ['revoked proxy', (() => {
      const revoked = Proxy.revocable({}, {});
      revoked.revoke();
      return revoked.proxy;
    })()],
    ['throwing Error proxy', new Proxy(new Error('wrapped secret'), {
      get: () => { throw new Error('get trap secret'); },
      has: () => { throw new Error('has trap secret'); },
    })],
    ['throwing toString', { toString: () => { throw new Error('string trap secret'); } }],
  ])('always responds safely for a hostile %s', (_name, exception) => {
    expect(render(exception)).toEqual({
      status: 500,
      body: {
        error: {
          code: 'internal_error',
          message: 'internal error',
          status: 500,
          requestId: 'parser-request',
        },
      },
    });
    expect(error).toHaveBeenCalledTimes(1);
  });
});
