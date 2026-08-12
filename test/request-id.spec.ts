import type { NextFunction, Response } from 'express';
import type { AppRequest } from '../src/common/http';
import { requestIdMiddleware } from '../src/common/request-id.middleware';

describe('requestIdMiddleware', () => {
  function assign(incoming: string | undefined): string {
    const req = { header: () => incoming } as unknown as AppRequest;
    const res = { setHeader: jest.fn() } as unknown as Response;
    const next = jest.fn() as NextFunction;
    requestIdMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.setHeader).toHaveBeenCalledWith('x-request-id', req.requestId);
    return req.requestId!;
  }

  it.each([
    'a',
    'A'.repeat(128),
    'trace_01.part-two',
  ])('preserves a safe caller id: %s', (incoming) => {
    expect(assign(incoming)).toBe(incoming);
  });

  it.each([
    undefined,
    '',
    'has space',
    'comma,joined',
    'bracket[value]',
    'unicode-é',
    'line\nbreak',
    'tab\tbreak',
    'x'.repeat(129),
  ])('replaces an unsafe caller id: %s', (incoming) => {
    const id = assign(incoming);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id).not.toBe(incoming);
  });
});
