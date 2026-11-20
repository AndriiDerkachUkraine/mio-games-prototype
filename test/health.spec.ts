import request from 'supertest';
import { createTestApp, resetDatabase, type TestContext } from './support/test-app';

describe('Health', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.db);
  });
  afterAll(() => ctx.app.close());

  it('reports ok when the database is reachable', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('seeds both simulated operators', async () => {
    const tenants = await ctx.db.selectFrom('tenants').select(['id', 'platform']).orderBy('id').execute();
    expect(tenants).toEqual([
      { id: 'casino-a', platform: 'platform-a' },
      { id: 'casino-b', platform: 'platform-b' },
    ]);
  });
});
