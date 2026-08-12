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
    const res = await request(h.app.getHttpServer())
      .post('/v1/auth/token')
      .set('content-type', 'application/json')
      .set('x-request-id', 'comma,joined')
      .send('{');
    const id = res.headers['x-request-id'];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.error.requestId).toBe(id);
    expect(res.body.error.requestId).not.toBe('unknown');
  });
});
