import { randomUUID } from 'node:crypto';
import { DEFAULT_SEGMENTS } from '../src/db/seed';
import { pickSegment } from '../src/modules/wheel/spin-outcome';
import { countRows } from './support/db';
import { asPlayer, grantSpins, playerToken } from './support/players';
import { createTestApp, resetDatabase, TEST_SPIN_SEED_SECRET, type TestContext } from './support/test-app';

describe('Wheel of Fortune', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(() => resetDatabase(ctx.db));

  const playerA = () => asPlayer(ctx.app, playerToken('casino-a'));
  const play = (spinId: string, player = playerA()) => player.post(`/v1/me/spins/${spinId}/play`);
  const expectedSegment = (spinId: string) => pickSegment(TEST_SPIN_SEED_SECRET, spinId, DEFAULT_SEGMENTS);
  const wallet = async (player = playerA()) => (await player.get('/v1/me/wallet').expect(200)).body;

  describe('deposit → spin → coins, for both platforms', () => {
    it.each(['casino-a', 'casino-b'] as const)('%s: plays a granted spin and credits the ledger', async (tenantId) => {
      const [spinId] = await grantSpins(ctx.app, tenantId);
      const player = asPlayer(ctx.app, playerToken(tenantId));

      const res = await play(spinId, player).expect(200);
      const { key, label, coins } = expectedSegment(spinId);
      expect(res.body).toEqual({
        spinId,
        segment: { key, label, coins },
        rewardTableVersion: 1,
        playedAt: expect.any(String),
      });

      expect(await wallet(player)).toEqual({
        balance: coins,
        entries: [
          {
            kind: 'SPIN_REWARD',
            amount: coins,
            balanceAfter: coins,
            referenceId: spinId,
            createdAt: expect.any(String),
          },
        ],
      });
      expect((await player.get('/v1/me/spins').expect(200)).body).toEqual({ available: [] });
    });
  });

  describe('server authority', () => {
    it('the outcome is HMAC-derived and verifiable, never taken from the request', async () => {
      const [spinId] = await grantSpins(ctx.app, 'casino-a');
      const res = await play(spinId).send({ segment: 'coins-200', coins: 999999, weight: 1 }).expect(200);
      expect(res.body.segment.key).toBe(expectedSegment(spinId).key);
      expect((await wallet()).balance).toBe(expectedSegment(spinId).coins);
    });

    it('does not expose segment weights', async () => {
      const [spinId] = await grantSpins(ctx.app, 'casino-a');
      const res = await play(spinId).expect(200);
      expect(Object.keys(res.body.segment).sort()).toEqual(['coins', 'key', 'label']);
    });

    it('records the reward table version; replays keep it after the table changes', async () => {
      const [first, second] = await grantSpins(ctx.app, 'casino-a', 'player-1', 2);
      const v1 = await play(first).expect(200);

      await ctx.db.updateTable('reward_tables').set({ active: false }).where('tenant_id', '=', 'casino-a').execute();
      await ctx.db
        .insertInto('reward_tables')
        .values({
          tenant_id: 'casino-a',
          version: 2,
          segments: JSON.stringify([{ key: 'v2-only', label: 'v2', coins: 7, weight: 1 }]),
          active: true,
          created_by: 'test',
        })
        .execute();

      expect((await play(first).expect(200)).body).toEqual(v1.body);
      const v2 = await play(second).expect(200);
      expect(v2.body).toMatchObject({ rewardTableVersion: 2, segment: { key: 'v2-only', coins: 7 } });
    });

    it('answers 409 and keeps the spin when the tenant has no active reward table', async () => {
      const [spinId] = await grantSpins(ctx.app, 'casino-a');
      await ctx.db.updateTable('reward_tables').set({ active: false }).where('tenant_id', '=', 'casino-a').execute();
      const res = await play(spinId).expect(409);
      expect(res.body.error).toBe('WHEEL_NOT_CONFIGURED');
      expect((await playerA().get('/v1/me/spins').expect(200)).body.available).toHaveLength(1);
    });
  });

  describe('C2 — concurrent and repeated spin requests', () => {
    it('replaying a played spin returns the same outcome and credits nothing', async () => {
      const [spinId] = await grantSpins(ctx.app, 'casino-a');
      const first = await play(spinId).expect(200);
      const second = await play(spinId).expect(200);
      expect(second.body).toEqual(first.body);
      expect(await countRows(ctx.db, 'ledger_entries')).toBe(1);
    });

    it('20 concurrent plays of one spin credit exactly once and all see the same outcome', async () => {
      const [spinId] = await grantSpins(ctx.app, 'casino-a');
      const responses = await Promise.all(Array.from({ length: 20 }, () => play(spinId)));
      expect(new Set(responses.map((r) => r.status))).toEqual(new Set([200]));
      expect(new Set(responses.map((r) => JSON.stringify(r.body))).size).toBe(1);
      expect(await countRows(ctx.db, 'ledger_entries')).toBe(1);
      expect((await wallet()).balance).toBe(expectedSegment(spinId).coins);
    });

    it('concurrent plays of different spins each credit once', async () => {
      const spinIds = await grantSpins(ctx.app, 'casino-a', 'player-1', 3);
      await Promise.all(spinIds.map((id) => play(id).expect(200)));
      const expectedTotal = spinIds.reduce((sum, id) => sum + expectedSegment(id).coins, 0);
      const { balance, entries } = await wallet();
      expect(balance).toBe(expectedTotal);
      expect(entries).toHaveLength(3);
    });
  });

  describe('unauthorized spins', () => {
    it.each([
      ['another player of the same casino', () => asPlayer(ctx.app, playerToken('casino-a', 'player-2'))],
      ['a same-named player of another casino', () => asPlayer(ctx.app, playerToken('casino-b', 'player-1'))],
    ])('%s cannot play the spin (404) and it stays available', async (_name, intruder) => {
      const [spinId] = await grantSpins(ctx.app, 'casino-a');
      const res = await play(spinId, intruder()).expect(404);
      expect(res.body.error).toBe('SPIN_NOT_FOUND');
      expect((await playerA().get('/v1/me/spins').expect(200)).body.available).toEqual([
        { spinId, grantedAt: expect.any(String) },
      ]);
      expect(await countRows(ctx.db, 'ledger_entries')).toBe(0);
    });

    it.each([
      ['an unknown spin id', () => randomUUID()],
      ['a non-uuid spin id', () => 'not-a-uuid'],
    ])('%s is 404', async (_name, spinId) => {
      await grantSpins(ctx.app, 'casino-a');
      expect((await play(spinId()).expect(404)).body.error).toBe('SPIN_NOT_FOUND');
    });
  });
});
