import { Logger } from '@nestjs/common';
import request from 'supertest';
import { boot, type Harness } from '../harness/boot';

describe('body-parser error boundary', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await boot();
  });

  afterAll(async () => h.close());

  it.each([
    ['anonymous', {}],
    ['credential-shaped', { 'x-api-key': 'not-a-key', 'x-api-secret': 'not-a-secret' }],
  ])('correlates malformed JSON for %s callers without leaking it', async (_name, headers) => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const marker = 'SECRET-malformed-marker';
    try {
      const res = await request(h.app.getHttpServer())
        .post('/v1/auth/token')
        .set(headers)
        .set('content-type', 'application/json')
        .set('x-request-id', 'parser.malformed-01')
        .send(`{"marker":"${marker}"`);

      expect(res.status).toBe(400);
      expect(res.headers['x-request-id']).toBe('parser.malformed-01');
      expect(res.body).toEqual({
        error: {
          code: 'bad_request',
          message: 'bad request',
          status: 400,
          requestId: 'parser.malformed-01',
        },
      });
      expect(JSON.stringify(res.body)).not.toContain(marker);
      expect(warn).toHaveBeenCalledWith('[parser.malformed-01] bad_request 400');
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('returns a correlated 413 above the JSON limit and parses the boundary below it', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    try {
      const below = JSON.stringify({ value: 'x'.repeat(102_300) });
      const parsed = await request(h.app.getHttpServer())
        .post('/v1/auth/token')
        .set('content-type', 'application/json')
        .set('x-request-id', 'parser.below-limit')
        .send(below);
      expect(parsed.status).toBe(401);

      const marker = 'SECRET-oversize-marker';
      const above = JSON.stringify({ marker, value: 'x'.repeat(102_500) });
      const res = await request(h.app.getHttpServer())
        .post('/v1/auth/token')
        .set('content-type', 'application/json')
        .set('x-request-id', 'parser.oversize-01')
        .send(above);

      expect(res.status).toBe(413);
      expect(res.headers['x-request-id']).toBe('parser.oversize-01');
      expect(res.body).toEqual({
        error: {
          code: 'payload_too_large',
          message: 'payload too large',
          status: 413,
          requestId: 'parser.oversize-01',
        },
      });
      expect(JSON.stringify(res.body)).not.toContain(marker);
      expect(warn).toHaveBeenCalledWith('[parser.oversize-01] payload_too_large 413');
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('generates one safe id before parsing when the supplied id is unsafe', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const unsafe = 'comma,joined';
    try {
      const res = await request(h.app.getHttpServer())
        .post('/v1/auth/token')
        .set('content-type', 'application/json')
        .set('x-request-id', unsafe)
        .send('{');
      const id = res.headers['x-request-id'];
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(res.body.error.requestId).toBe(id);
      expect(warn).toHaveBeenCalledWith(`[${id}] bad_request 400`);
      expect(JSON.stringify({ headers: res.headers, body: res.body, logs: warn.mock.calls }))
        .not.toContain(unsafe);
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ['absent', undefined, false],
    ['valid-128', 'A'.repeat(128), true],
    ['invalid-129', 'A'.repeat(129), false],
  ] as const)('correlates parser errors for an %s request id', async (_name, supplied, preserved) => {
    const call = request(h.app.getHttpServer())
      .post('/v1/auth/token')
      .set('content-type', 'application/json');
    if (supplied !== undefined) call.set('x-request-id', supplied);
    const res = await call.send('{');
    const id = res.headers['x-request-id'];
    expect(res.body.error.requestId).toBe(id);
    if (preserved) expect(id).toBe(supplied);
    else expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects joined duplicate request ids and mints one correlated UUID', async () => {
    const res = await request(h.app.getHttpServer())
      .post('/v1/auth/token')
      .set('content-type', 'application/json')
      .set({ 'x-request-id': ['safe-one', 'safe-two'] } as unknown as Record<string, string>)
      .send('{');
    const id = res.headers['x-request-id'];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.error.requestId).toBe(id);
    expect(JSON.stringify(res.body)).not.toContain('safe-one');
    expect(JSON.stringify(res.body)).not.toContain('safe-two');
  });

  it('stamps successful application responses too', async () => {
    const res = await request(h.app.getHttpServer())
      .get('/v1/health')
      .set('x-request-id', 'health.trace-01');
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBe('health.trace-01');
  });
});
