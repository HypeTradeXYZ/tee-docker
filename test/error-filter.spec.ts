import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HttpException, Logger, type ArgumentsHost } from '@nestjs/common';
import { WativeError } from 'wative-core';
import { ErrorFilter } from '../src/common/error.filter';
import { ErrorMapService } from '../src/config/error-map.service';
import { ErrorsConfigSchema } from '../src/config/schemas';
import { TeeError, teeCoreError } from '../src/common/tee-error';

describe('reviewed transaction/RPC error rendering', () => {
  const config = ErrorsConfigSchema.parse(
    JSON.parse(readFileSync(resolve(__dirname, '../config/errors.json'), 'utf8')),
  );
  const filter = new ErrorFilter(new ErrorMapService(config));

  it.each([
    // R-03: a core-thrown message is never rendered. The CODE is the contract;
    // the text falls back to fixed status wording.
    ['TX_ABORTED', 409, 'tx_aborted', 'request failed'],
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

describe('HttpException message is never reflected (R-01)', () => {
  const config = ErrorsConfigSchema.parse(
    JSON.parse(readFileSync(resolve(__dirname, '../config/errors.json'), 'utf8')),
  );
  const filter = new ErrorFilter(new ErrorMapService(config));
  const render = (exception: unknown) =>
    (filter as unknown as {
      render: (e: unknown, id: string) => { status: number; body: unknown };
    }).render(exception, 'r01-request');

  // Nest destroys every origin marker before the filter runs (no cause, no
  // err.type, no err.body), so the contract cannot be shape-based: NO
  // HttpException text may escape, whatever produced it.
  it.each([
    [400, 'bad_request', 'bad request'],
    [401, 'unauthorized', 'unauthorized'],
    [403, 'forbidden', 'forbidden'],
    [404, 'not_found', 'not found'],
    [413, 'payload_too_large', 'payload too large'],
  ])('renders fixed text for a %p HttpException', (status, code, message) => {
    const rendered = render(new HttpException('SECRET-MARKER-VALUE', status));
    expect(rendered).toEqual({
      status,
      body: { error: { code, message, status, requestId: 'r01-request' } },
    });
    expect(JSON.stringify(rendered)).not.toContain('SECRET-MARKER-VALUE');
  });

  it.each([
    // Real V8 output: a malformed body echoes up to ~10 contiguous bytes.
    ['JSON syntax error', `Unexpected token 'h', ..."password":hunter2SEC"... is not valid JSON`],
    // express@5 decode_param: leaks the whole path segment, unbounded.
    ['URIError path param', `Failed to decode param '%FFSECRET-PATH-SEGMENT'`],
    // Nest's own 404: leaks the full request line including the query string.
    ['unknown route', 'Cannot GET /v1/nope?token=SECRET-IN-QUERY'],
  ])('does not leak the %s message', (_name, message) => {
    const serialized = JSON.stringify(render(new HttpException(message, 400)));
    expect(serialized).not.toContain('SECRET');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('Cannot GET');
    expect(serialized).not.toContain('is not valid JSON');
  });

  it('keeps payload-too-large on the plain numeric-status branch', () => {
    // 413 was always green because raw-body throws a plain Error, not an
    // HttpException. Pin it so a later refactor cannot migrate it onto the
    // branch this finding sanitized.
    expect(render(Object.assign(new Error('SECRET raw-body text'), { status: 413 }))).toEqual({
      status: 413,
      body: {
        error: {
          code: 'payload_too_large', message: 'payload too large', status: 413,
          requestId: 'r01-request',
        },
      },
    });
  });
});

describe('sub-500 message gate (R-03)', () => {
  const config = ErrorsConfigSchema.parse(
    JSON.parse(readFileSync(resolve(__dirname, '../config/errors.json'), 'utf8')),
  );
  const errors = new ErrorMapService(config);
  const filter = new ErrorFilter(errors);
  const render = (exception: unknown) =>
    (filter as unknown as {
      render: (e: unknown, id: string) => { status: number; body: { error: Record<string, unknown> } };
    }).render(exception, 'r03-request');

  const POISON = '/var/data/root/acme/ws-1 ' + 'A'.repeat(4096);
  const subFiveHundred = Object.entries(config.mappings)
    .filter(([, m]) => (m as { status: number }).status < 500)
    .map(([code]) => code);

  it('has sub-500 mappings to check', () => {
    expect(subFiveHundred.length).toBeGreaterThan(20);
  });

  it.each(subFiveHundred)('never renders a dependency message for %s', (code) => {
    const rendered = render(new WativeError(code as never, POISON));
    const serialized = JSON.stringify(rendered);
    expect(serialized).not.toContain('/var/data/root');
    expect(serialized).not.toContain('AAAA');
    expect(typeof rendered.body.error.message).toBe('string');
    expect((rendered.body.error.message as string).length).toBeLessThanOrEqual(200);
  });

  it.each(subFiveHundred)('never forwards a dependency details object for %s', (code) => {
    const exception = new WativeError(code as never, 'x');
    Object.defineProperty(exception, 'details', {
      value: { path: '/var/data/root/acme', secret: 'oops' },
      enumerable: true,
    });
    const serialized = JSON.stringify(render(exception));
    expect(serialized).not.toContain('/var/data/root');
    expect(serialized).not.toContain('oops');
  });

  it('still renders a message tee-docker authored', () => {
    const rendered = render(new TeeError('TEE_INVALID_BODY', 'body must be { count }'));
    expect(rendered.body.error).toMatchObject({
      code: 'invalid_body',
      message: 'body must be { count }',
      status: 400,
    });
  });

  it('does not trust the TEE_ prefix, only the brand', () => {
    // Nothing stops a dependency constructing a TEE_ code at runtime.
    const forged = new WativeError('TEE_INVALID_SLUG' as never, 'core says: /var/data/root/acme/x');
    const serialized = JSON.stringify(render(forged));
    expect(serialized).not.toContain('/var/data/root');
  });

  it('cannot be fooled by a plain property posing as the brand', () => {
    const forged = Object.assign(
      new WativeError('PARAMETER_ERROR' as never, 'core says: /var/data/root/acme/x'),
      { reviewedMessage: true, __reviewed: true },
    );
    expect(JSON.stringify(render(forged))).not.toContain('/var/data/root');
  });

  it('fails closed on an authored message that is too long', () => {
    const rendered = render(new TeeError('TEE_INVALID_BODY', 'B'.repeat(201)));
    expect(rendered.body.error.message).toBe('bad request');
  });

  it('fails closed when message is not a string', () => {
    const exception = new TeeError('TEE_INVALID_BODY', 'placeholder');
    Object.defineProperty(exception, 'message', { value: { leak: '/var/data/root' } });
    expect(JSON.stringify(render(exception))).not.toContain('/var/data/root');
  });

  it('keeps a new unmapped core code opaque', () => {
    const rendered = render(new WativeError('NEW_CODE_IN_2_5_0' as never, POISON));
    expect(rendered.status).toBeGreaterThanOrEqual(500);
    expect(rendered.body.error.message).toBe('internal error');
  });
});

describe('tee-docker messages thrown as core errors (R-03 follow-up)', () => {
  const config = ErrorsConfigSchema.parse(
    JSON.parse(readFileSync(resolve(__dirname, '../config/errors.json'), 'utf8')),
  );
  const filter = new ErrorFilter(new ErrorMapService(config));
  const render = (exception: unknown) =>
    (filter as unknown as {
      render: (e: unknown, id: string) => { status: number; body: { error: Record<string, unknown> } };
    }).render(exception, 'r03b-request');

  it('renders a message authored by tee-docker on a core code', () => {
    // teeCoreError exists so a reviewed message on a core code is not
    // mistaken for the dependency's own text and suppressed.
    const rendered = render(teeCoreError('PARAMETER_ERROR', 'force must be exactly true or false'));
    expect(rendered.body.error).toMatchObject({
      code: 'invalid_parameter',
      message: 'force must be exactly true or false',
      status: 400,
    });
  });

  it('still suppresses the same code thrown by the dependency', () => {
    const rendered = render(new WativeError('PARAMETER_ERROR' as never, '/var/data/root/acme/x'));
    expect(JSON.stringify(rendered)).not.toContain('/var/data/root');
  });
});

describe('brand cannot arrive by inheritance (R-03 adversary)', () => {
  const config = ErrorsConfigSchema.parse(
    JSON.parse(readFileSync(resolve(__dirname, '../config/errors.json'), 'utf8')),
  );
  const filter = new ErrorFilter(new ErrorMapService(config));
  const render = (exception: unknown) =>
    (filter as unknown as {
      render: (e: unknown, id: string) => { status: number; body: { error: Record<string, unknown> } };
    }).render(exception, 'brand-request');

  const LEAK = 'CANARY_/enclave/secret/path';

  it('rejects a brand inherited via Object.create', () => {
    const forged = Object.create(new TeeError('TEE_INVALID_BODY', 'legit'));
    Object.defineProperty(forged, 'message', { value: LEAK, enumerable: true });
    expect(JSON.stringify(render(forged))).not.toContain('CANARY_');
  });

  it('rejects a brand inherited via setPrototypeOf', () => {
    const forged = new TeeError('TEE_INVALID_BODY', LEAK);
    const donor = new TeeError('TEE_INVALID_BODY', 'legit');
    Object.setPrototypeOf(forged, donor);
    // Its own brand is genuine, so prove the inherited path specifically.
    const hostile = Object.create(donor) as { message: string };
    hostile.message = LEAK;
    expect(JSON.stringify(render(hostile))).not.toContain('CANARY_');
  });

  it('still renders a genuine own-branded error', () => {
    expect(render(new TeeError('TEE_INVALID_BODY', 'body must be { count }')).body.error.message)
      .toBe('body must be { count }');
  });

  it('stays opaque rather than throwing when the target is frozen', () => {
    // markReviewedMessage must not turn a reviewed 4xx into a 500 if a
    // dependency ever freezes its error objects.
    const frozen = Object.freeze(new WativeError('PARAMETER_ERROR' as never, LEAK));
    expect(() => render(frozen)).not.toThrow();
    expect(JSON.stringify(render(frozen))).not.toContain('CANARY_');
  });
});

describe('details never serialize to a lie (L-11)', () => {
  const config = ErrorsConfigSchema.parse(
    JSON.parse(readFileSync(resolve(__dirname, '../config/errors.json'), 'utf8')),
  );
  const filter = new ErrorFilter(new ErrorMapService(config));
  const render = (exception: unknown) =>
    (filter as unknown as {
      render: (e: unknown, id: string) => { status: number; body: { error: Record<string, unknown> } };
    }).render(exception, 'l11-request');

  // TEE_UNLOCK_CAPACITY is exposeDetails:true and carries retryAfterSec.
  it.each([Number.NaN, Infinity, -Infinity])('drops a non-finite detail (%p)', (bad) => {
    const rendered = render(
      new TeeError('TEE_UNLOCK_CAPACITY', 'too many token requests', { retryAfterSec: bad }),
    );
    const serialized = JSON.stringify(rendered);
    // The old behaviour serialized these to null, which a client reading a
    // contractually numeric field cannot distinguish from "no value".
    expect(serialized).not.toContain('null');
    expect(rendered.body.error.details).toBeUndefined();
  });

  it('keeps a finite detail', () => {
    const rendered = render(
      new TeeError('TEE_UNLOCK_CAPACITY', 'too many token requests', { retryAfterSec: 42 }),
    );
    expect(rendered.body.error.details).toEqual({ retryAfterSec: 42 });
  });

  it.each([
    ['a bigint', { n: BigInt(1) }],
    ['a cyclic object', (() => { const o: Record<string, unknown> = {}; o.self = o; return o; })()],
    ['a throwing getter', Object.defineProperty({}, 'boom', { get() { throw new Error('x'); }, enumerable: true })],
  ])('renders a serializable response despite %s in details', (_name, details) => {
    const rendered = render(
      new TeeError('TEE_UNLOCK_CAPACITY', 'too many token requests', details as Record<string, unknown>),
    );
    expect(() => JSON.stringify(rendered)).not.toThrow();
    expect(rendered.body.error.details).toBeUndefined();
  });

  it('stays total when the whole body cannot serialize', () => {
    const json = jest.fn();
    const statusFn = jest.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status: statusFn }),
        getRequest: () => ({ requestId: 'l11-total' }),
      }),
    } as unknown as ArgumentsHost;
    const hostile = new TeeError('TEE_INVALID_BODY', 'x');
    Object.defineProperty(hostile, 'code', { get() { throw new Error('boom'); } });

    expect(() => filter.catch(hostile, host)).not.toThrow();
    expect(statusFn).toHaveBeenCalled();
    expect(() => JSON.stringify(json.mock.calls[0]![0])).not.toThrow();
  });
});

describe('details sanitizer refuses exotic shapes (L-11 adversary)', () => {
  const config = ErrorsConfigSchema.parse(
    JSON.parse(readFileSync(resolve(__dirname, '../config/errors.json'), 'utf8')),
  );
  const filter = new ErrorFilter(new ErrorMapService(config));
  const render = (details: Record<string, unknown>) =>
    (filter as unknown as {
      render: (e: unknown, id: string) => { status: number; body: { error: Record<string, unknown> } };
    }).render(new TeeError('TEE_UNLOCK_CAPACITY', 'too many', details), 'l11a-request');

  it('refuses an Array subclass whose toJSON could differ on a second pass', () => {
    class Evil extends Array {
      #calls = 0;
      toJSON(): unknown {
        this.#calls += 1;
        return this.#calls > 1 ? 'ATTACKER-CONTROLLED' : { retryAfterSec: 30 };
      }
    }
    const list = new Evil();
    list.push(1);
    const rendered = render({ list });
    // Rebuilt as a plain array, so the subclass's toJSON is gone: the value
    // survives but its behaviour does not.
    expect(rendered.body.error.details).toEqual({ list: [1] });
    const details = rendered.body.error.details as { list: unknown[] };
    expect(Object.getPrototypeOf(details.list)).toBe(Array.prototype);
    // The two serializations must agree, or the response writer escapes the filter.
    expect(JSON.stringify(rendered)).toBe(JSON.stringify(rendered));
    expect(JSON.stringify(rendered)).not.toContain('ATTACKER-CONTROLLED');
  });

  it('refuses a sparse array rather than emitting holes as null', () => {
    const sparse: unknown[] = [];
    sparse[2] = 7;
    const rendered = render({ window: sparse });
    expect(rendered.body.error.details).toBeUndefined();
    expect(JSON.stringify(rendered)).not.toContain('null');
  });

  it.each([
    ['a revoked proxy', () => { const r = Proxy.revocable({}, {}); r.revoke(); return r.proxy; }],
    ['a hostile ownKeys trap', () => new Proxy({}, { ownKeys() { throw new Error('boom'); } })],
    ['a boxed string past the cap', () => new String('a'.repeat(300))],
    ['a Date', () => new Date(0)],
    ['a typed array', () => new Uint8Array([1, 2, 3])],
  ])('refuses %s without losing the mapped status', (_name, make) => {
    const rendered = render({ hostile: make() as unknown });
    // Still the reviewed 429, not an opaque 500.
    expect(rendered.status).toBe(429);
    expect(rendered.body.error.details).toBeUndefined();
  });

  it('refuses a __proto__ key instead of rebinding the accumulator', () => {
    const rendered = render(JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>);
    expect(rendered.body.error.details).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('bounds a wide shared-subtree graph', () => {
    const leaf: Record<string, unknown> = { a: 1 };
    let level: Record<string, unknown> = leaf;
    for (let d = 0; d < 5; d += 1) {
      const next: Record<string, unknown> = {};
      for (let i = 0; i < 32; i += 1) next[`k${i}`] = level;
      level = next;
    }
    const started = Date.now();
    const rendered = render(level);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(JSON.stringify(rendered).length).toBeLessThan(100_000);
  });

  it('still passes the payloads that actually ship', () => {
    expect(render({ retryAfterSec: 42 }).body.error.details).toEqual({ retryAfterSec: 42 });
    expect(render({ scope: 'read', limit: 8 }).body.error.details).toEqual({ scope: 'read', limit: 8 });
    expect(render({ required: ['sign'] }).body.error.details).toEqual({ required: ['sign'] });
  });
});

describe('rate-limited responses carry Retry-After (R-12)', () => {
  const config = ErrorsConfigSchema.parse(
    JSON.parse(readFileSync(resolve(__dirname, '../config/errors.json'), 'utf8')),
  );
  const filter = new ErrorFilter(new ErrorMapService(config));

  function render(exception: unknown) {
    const json = jest.fn();
    const setHeader = jest.fn();
    const statusFn = jest.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status: statusFn, setHeader }),
        getRequest: () => ({ requestId: 'r12-request' }),
      }),
    } as unknown as ArgumentsHost;
    filter.catch(exception, host);
    return { setHeader, statusFn, json };
  }

  it('sets the header from the same value as the body field', () => {
    const { setHeader, statusFn } = render(
      new TeeError('TEE_UNLOCK_CAPACITY', 'too many token requests', { retryAfterSec: 17 }),
    );
    expect(statusFn).toHaveBeenCalledWith(429);
    expect(setHeader).toHaveBeenCalledWith('retry-after', '17');
  });

  it('does not set it on responses that are not rate limits', () => {
    const { setHeader } = render(new TeeError('TEE_INVALID_BODY', 'body must be { count }'));
    expect(setHeader).not.toHaveBeenCalledWith('retry-after', expect.anything());
  });

  it('omits it rather than emitting a nonsense value', () => {
    // details is refused wholesale when a member is unrepresentable, so there
    // is no number to advertise.
    const { setHeader } = render(
      new TeeError('TEE_UNLOCK_CAPACITY', 'too many', { retryAfterSec: Number.NaN }),
    );
    expect(setHeader).not.toHaveBeenCalledWith('retry-after', expect.anything());
  });
});
