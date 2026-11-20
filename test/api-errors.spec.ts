import type { ArgumentsHost } from '@nestjs/common';
import type { PinoLogger } from 'nestjs-pino';
import request from 'supertest';
import { ApiExceptionFilter } from '../src/common/api-exception.filter';
import { createTestApp, type TestContext } from './support/test-app';

describe('API error format', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.app.close());

  const events = () =>
    request(ctx.app.getHttpServer()).post('/v1/integrations/casino-a/events').set('content-type', 'application/json');

  it.each([
    ['unknown route', 404, 'NOT_FOUND', () => request(ctx.app.getHttpServer()).get('/v1/nope')],
    ['malformed JSON', 400, 'BAD_REQUEST', () => events().send('{bad')],
    ['oversized body', 413, 'PAYLOAD_TOO_LARGE', () => events().send(JSON.stringify({ x: 'a'.repeat(200_000) }))],
  ])('%s → %i %s', async (_name, status, error, send) => {
    const res = await send();
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error, message: expect.any(String) });
  });

  it.each([
    ['an Error with sensitive details', new Error('connection string with password=hunter2')],
    ['a thrown non-Error value', 'boom'],
    ['an exposed server-side error', Object.assign(new Error('upstream detail'), { status: 502, expose: true })],
  ])('turns %s into a generic 500 and logs it', (_name, failure) => {
    const logger = { error: jest.fn() } as unknown as PinoLogger;
    const json = jest.fn();
    const response = { status: jest.fn(() => ({ json })) };
    const host = { switchToHttp: () => ({ getResponse: () => response }) } as unknown as ArgumentsHost;

    new ApiExceptionFilter(logger).catch(failure, host);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: 'INTERNAL_ERROR', message: 'internal error' });
    expect(logger.error).toHaveBeenCalledWith({ err: failure }, 'unhandled error');
  });
});
