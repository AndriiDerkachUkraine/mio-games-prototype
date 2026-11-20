import request from 'supertest';
import { createTestApp, type TestContext } from './support/test-app';

describe('Health and correlation id', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.app.close());

  it('reports ok when the database is reachable', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('echoes a well-formed X-Request-Id', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/health').set('x-request-id', 'casino-a.req-42');
    expect(res.headers['x-request-id']).toBe('casino-a.req-42');
  });

  it.each([['with spaces'], ['x'.repeat(129)], ['<script>']])('replaces a malformed X-Request-Id (%#)', async (id) => {
    const res = await request(ctx.app.getHttpServer()).get('/health').set('x-request-id', id);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('generates an id when none is sent', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/health');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
