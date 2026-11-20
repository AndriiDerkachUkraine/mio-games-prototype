import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { addCasinoSimulator } from '../src/mock-casino/casino-simulator';
import { createMockCasino } from '../src/mock-casino/mock-casino';
import { countRows } from './support/db';
import { createTestApp, resetDatabase, type TestContext } from './support/test-app';

/** The demo helper must speak exactly the protocol MIO verifies: these calls go through the real webhook endpoint. */
describe('Casino simulator (demo helper)', () => {
  let ctx: TestContext;
  let simulator: Server;
  let simulatorUrl: string;
  let mioUrl: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    await ctx.app.listen(0);
    mioUrl = `http://127.0.0.1:${(ctx.app.getHttpServer().address() as AddressInfo).port}`;
    const app = createMockCasino({ apiKeys: { 'platform-a': 'a', 'platform-b': 'b' }, slowResponseMs: 600 });
    addCasinoSimulator(app, { mioUrl });
    simulator = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    simulatorUrl = `http://127.0.0.1:${(simulator.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    simulator.closeAllConnections();
    await new Promise((resolve) => simulator.close(resolve));
    await ctx.app.close();
  });
  beforeEach(() => resetDatabase(ctx.db));

  interface SimulatorResponse {
    sent?: unknown;
    mio?: { status: number; body: Record<string, unknown> };
    token?: string;
  }

  const simulate = async (path: string, body: object): Promise<{ status: number; body: SimulatorResponse }> => {
    const res = await fetch(`${simulatorUrl}/__simulate${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as SimulatorResponse };
  };

  it.each([
    ['casino-a', { event_id: expect.any(String), amount_cents: 2500, status: 'SUCCESS' }],
    ['casino-b', { notificationId: expect.any(String), data: expect.objectContaining({ amount: '25.00', state: 2 }) }],
  ])('%s: sends a correctly signed deposit in its own format', async (tenantId, payload) => {
    const res = await simulate(`/${tenantId}/deposit`, { playerId: 'demo-player', amount: '25.00' });
    expect(res.body.sent).toMatchObject(payload);
    expect(res.body.mio).toEqual({
      status: 200,
      body: expect.objectContaining({ status: 'processed', spinsGranted: 1 }),
    });
  });

  it('re-sending the same event id shows deduplication', async () => {
    await simulate('/casino-a/deposit', { playerId: 'p', eventId: 'evt-1' });
    const again = await simulate('/casino-a/deposit', { playerId: 'p', eventId: 'evt-1' });
    expect(again.body.mio?.body.status).toBe('duplicate');
    expect(await countRows(ctx.db, 'spins')).toBe(1);
  });

  it('can send a failed deposit', async () => {
    const res = await simulate('/casino-b/deposit', { playerId: 'p', status: 'FAILED' });
    expect(res.body.mio?.body).toMatchObject({ status: 'ignored', reason: 'deposit status FAILED' });
  });

  it('issues a player token that MIO accepts', async () => {
    const { body } = await simulate('/casino-b/player-token', { playerId: 'demo-player' });
    const spins = await fetch(`${mioUrl}/v1/me/spins`, {
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(spins.status).toBe(200);
  });

  it.each([
    ['an unknown tenant', '/casino-x/deposit', { playerId: 'p' }, 404],
    ['a prototype key as tenant', '/toString/player-token', { playerId: 'p' }, 404],
    ['a missing player id', '/casino-a/deposit', {}, 400],
  ])('rejects %s', async (_name, path, body, status) => {
    expect((await simulate(path, body)).status).toBe(status);
  });
});
