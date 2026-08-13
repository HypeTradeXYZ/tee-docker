import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HttpException, Logger, type ArgumentsHost } from '@nestjs/common';
import { WativeError } from 'wative-core';
import { ErrorFilter } from '../src/common/error.filter';
import { ErrorMapService } from '../src/config/error-map.service';
import { ErrorsConfigSchema } from '../src/config/schemas';
import { TeeError } from '../src/common/tee-error';

describe('reviewed transaction/RPC error rendering', () => {
  const config = ErrorsConfigSchema.parse(
    JSON.parse(readFileSync(resolve(__dirname, '../config/errors.json'), 'utf8')),
  );
  const filter = new ErrorFilter(new ErrorMapService(config));

  it.each([
    ['TX_ABORTED', 409, 'tx_aborted', 'caller-visible abort'],
    ['RPC_REJECTED', 502, 'rpc_rejected', 'the RPC endpoint rejected the request'],
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

  it.each([
    ['TEE_RPC_UNREACHABLE', 502, 'rpc_unreachable', 'the RPC endpoint could not be reached'],
    [
      'TEE_BALANCES_UNAVAILABLE',
      501,
      'not_implemented',
      'Balance lookup is not available in this release.',
    ],
  ] as const)('uses reviewed fixed text for %s', (teeCode, status, code, message) => {
    const json = jest.fn();
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status: () => ({ json }) }),
        getRequest: () => ({ requestId: 'fixed-tee-message' }),
      }),
    } as unknown as ArgumentsHost;
    filter.catch(new TeeError(teeCode, 'SECRET https://user:pass@example.test/rpc/CAP', {
      raw: 'SECRET_RAW_TX',
    }), host);
    const body = json.mock.calls[0]?.[0];
    expect(body).toEqual({
      error: { code, message, status, requestId: 'fixed-tee-message' },
    });
    expect(JSON.stringify(body)).not.toMatch(/SECRET|user:pass|\/rpc\/|RAW_TX/);
  });

  it.each([
    'PROVIDER_IO',
    'DECRYPT_FAILED',
    'ENCRYPT_FAILED',
    'ALGORITHM_IRREVERSIBLE',
    'TX_SIGN_FAILED',
    'STORAGE_NOT_DURABLE',
  ] as const)('keeps unreviewed internal code %s opaque', (coreCode) => {
    const json = jest.fn();
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status: () => ({ json }) }),
        getRequest: () => ({ requestId: 'opaque-message' }),
      }),
    } as unknown as ArgumentsHost;
    filter.catch(new WativeError(coreCode, 'SECRET provider detail', {
      details: { secret: 'SECRET_DETAIL' },
    }), host);
    expect(json.mock.calls[0]?.[0].error.message).toBe('internal error');
    expect(JSON.stringify(json.mock.calls[0]?.[0])).not.toContain('SECRET');
  });

  it('keeps the unreviewed KDF backend error opaque', () => {
    const json = jest.fn();
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status: () => ({ json }) }),
        getRequest: () => ({ requestId: 'opaque-kdf-message' }),
      }),
    } as unknown as ArgumentsHost;
    filter.catch(new TeeError('TEE_KDF_BACKEND_UNSAFE', 'SECRET backend detail', {
      backend: 'SECRET_FALLBACK',
    }), host);
    expect(json.mock.calls[0]?.[0].error.message).toBe('internal error');
    expect(JSON.stringify(json.mock.calls[0]?.[0])).not.toContain('SECRET');
  });

  it.each([
    ['DISK_FULL', 507, 'disk_full', 'storage capacity is unavailable'],
    ['TX_SUBMIT_FAILED', 502, 'tx_submit_failed', 'the RPC endpoint refused the transaction'],
    ['TX_TIMEOUT', 504, 'tx_timeout', 'the RPC operation timed out'],
    ['RPC_UNREACHABLE', 502, 'rpc_unreachable', 'the RPC endpoint could not be reached'],
    ['RPC_REJECTED', 502, 'rpc_rejected', 'the RPC endpoint rejected the request'],
    ['UNSUPPORTED_OP', 501, 'unsupported_operation', 'this operation is not supported'],
  ] as const)('uses reviewed fixed text for %s', (coreCode, status, code, message) => {
    const json = jest.fn();
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status: () => ({ json }) }),
        getRequest: () => ({ requestId: 'fixed-message' }),
      }),
    } as unknown as ArgumentsHost;
    filter.catch(new WativeError(
      coreCode,
      'SECRET /tenant/path https://user:pass@example.test http://127.0.0.1:1/rpc/CAP',
      { details: { raw: 'SECRET_RAW_TX' }, cause: new Error('SECRET_CAUSE') },
    ), host);
    const body = json.mock.calls[0]?.[0];
    expect(body).toEqual({
      error: { code, message, status, requestId: 'fixed-message' },
    });
    expect(JSON.stringify(body)).not.toMatch(/SECRET|tenant\/path|user:pass|\/rpc\/|RAW_TX/);
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

  it.each([Number.NaN, 399, 600])(
    'fails closed for an HttpException with invalid status %p',
    (status) => {
      expect(render(new HttpException('SECRET', status))).toEqual({
        status: 500,
        body: {
          error: {
            code: 'internal_error', message: 'internal error', status: 500,
            requestId: 'parser-request',
          },
        },
      });
    },
  );

  it('fails closed when HttpException.getStatus throws', () => {
    const exception = new HttpException('SECRET', 500);
    jest.spyOn(exception, 'getStatus').mockImplementation(() => { throw new Error('status trap'); });
    expect(render(exception)).toEqual({
      status: 500,
      body: {
        error: {
          code: 'internal_error', message: 'internal error', status: 500,
          requestId: 'parser-request',
        },
      },
    });
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
    ['throwing WativeError proxy', new Proxy(
      new WativeError('RPC_REJECTED', 'wrapped core secret'),
      { get: () => { throw new Error('core get trap secret'); } },
    )],
    ['throwing TeeError proxy', new Proxy(
      new TeeError('TEE_RPC_UNREACHABLE', 'wrapped tee secret'),
      { get: () => { throw new Error('tee get trap secret'); } },
    )],
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
