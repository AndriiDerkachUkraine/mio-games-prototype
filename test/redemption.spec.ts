import { randomUUID } from 'node:crypto';
import { type DevTenantId } from '../src/db/seed';
import { DeliveryProcessor } from '../src/modules/redemption/delivery.processor';
import { DeliveryWorker } from '../src/modules/redemption/delivery.worker';
import { RedemptionsRepository } from '../src/modules/redemption/redemptions.repository';
import { countRows } from './support/db';
import { startMockCasino, type MockCasinoHandle } from './support/mock-casino';
import { asPlayer, creditCoins, grantSpins, playerToken } from './support/players';
import { createTestApp, resetDatabase, type TestContext } from './support/test-app';

describe('Bonus Store and reward delivery', () => {
  let ctx: TestContext;
  let casino: MockCasinoHandle;
  let worker: DeliveryWorker;

  beforeAll(async () => {
    ctx = await createTestApp();
    casino = await startMockCasino();
    worker = ctx.app.get(DeliveryWorker);
  });
  afterAll(async () => {
    await ctx.app.close();
    await casino.close();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.db, casino.url);
    await casino.reset();
  });

  const player = (tenantId: DevTenantId = 'casino-a', externalId = 'player-1') =>
    asPlayer(ctx.app, playerToken(tenantId, externalId));
  const itemBySku = async (tenantId: DevTenantId, sku: string): Promise<{ itemId: string; priceCoins: number }> =>
    (await player(tenantId).get('/v1/store/items').expect(200)).body.items.find((i: { sku: string }) => i.sku === sku);
  const redeem = (tenantId: DevTenantId, itemId: string, key: string | null = randomUUID(), externalId?: string) => {
    const req = player(tenantId, externalId).post('/v1/me/redemptions').send({ itemId });
    return key === null ? req : req.set('idempotency-key', key);
  };
  const status = async (tenantId: DevTenantId, redemptionId: string) =>
    (await player(tenantId).get(`/v1/me/redemptions/${redemptionId}`).expect(200)).body;
  const balance = async (tenantId: DevTenantId = 'casino-a') =>
    (await player(tenantId).get('/v1/me/wallet').expect(200)).body.balance;
  /** Runs the worker until no delivery is due (retry delays are 0 in tests). */
  const deliverAll = async () => {
    for (let i = 0; i < 20 && (await worker.runOnce()) > 0; i++);
  };

  describe('happy path', () => {
    it('lists only the tenant’s own items', async () => {
      const skus = (await player('casino-a').get('/v1/store/items').expect(200)).body.items.map(
        (i: { sku: string }) => i.sku,
      );
      expect(skus).toEqual(['free-spins-10', 'bonus-5-eur']);
    });

    it('Casino A: deposit → spins → coins → redeem → issued synchronously', async () => {
      const spinIds = await grantSpins(ctx.app, 'casino-a', 'player-1', 2);
      for (const id of spinIds) await player().post(`/v1/me/spins/${id}/play`).expect(200);
      const before = await balance();
      const item = await itemBySku('casino-a', 'free-spins-10');

      const accepted = await redeem('casino-a', item.itemId).expect(202);
      expect(accepted.body).toMatchObject({ status: 'PENDING', priceCoins: 20, attempts: 0 });
      expect(await balance()).toBe(before - 20);

      await deliverAll();
      const done = await status('casino-a', accepted.body.redemptionId);
      const [grant] = await casino.grants('platform-a');
      expect(done).toMatchObject({ status: 'ISSUED', externalReference: expect.any(String), attempts: 1 });
      expect(grant).toMatchObject({
        reference: accepted.body.redemptionId,
        playerId: 'player-1',
        reward: { type: 'free_spins', count: 10, game: 'book-of-mio' },
      });
      expect(done.history.map((h: { to: string }) => h.to)).toEqual(['PENDING', 'ISSUED']);
    });

    it('Casino B: accepted asynchronously, confirmed by polling, in its own reward format', async () => {
      await creditCoins(ctx.app, 'casino-b', 20);
      const item = await itemBySku('casino-b', 'cash-bonus-5-usd');
      const { body } = await redeem('casino-b', item.itemId).expect(202);

      await worker.runOnce();
      expect(await status('casino-b', body.redemptionId)).toMatchObject({ status: 'AWAITING_CONFIRMATION' });
      await worker.runOnce();
      expect(await status('casino-b', body.redemptionId)).toMatchObject({ status: 'ISSUED', attempts: 2 });
      expect((await casino.grants('platform-b'))[0]).toMatchObject({
        reference: body.redemptionId,
        reward: { kind: 'CASH_BONUS', value: '5.00', currency: 'USD' },
        state: 'COMPLETED',
      });
    });
  });

  describe('validation', () => {
    it('refuses to redeem without enough coins and records nothing', async () => {
      await creditCoins(ctx.app, 'casino-a', 19);
      const item = await itemBySku('casino-a', 'free-spins-10');
      expect((await redeem('casino-a', item.itemId).expect(409)).body.error).toBe('INSUFFICIENT_BALANCE');
      expect(await countRows(ctx.db, 'redemptions')).toBe(0);
      expect(await balance()).toBe(19);
    });

    it.each([
      ['an unknown item', async () => randomUUID()],
      ['another casino’s item', async () => (await itemBySku('casino-b', 'cash-bonus-5-usd')).itemId],
      ['a malformed item id', async () => 'not-a-uuid'],
    ])('answers 404 for %s', async (_name, itemId) => {
      await creditCoins(ctx.app, 'casino-a', 500);
      expect((await redeem('casino-a', await itemId()).expect(404)).body.error).toBe('ITEM_NOT_FOUND');
    });

    it('answers 404 when the body names no item', async () => {
      const res = await player().post('/v1/me/redemptions').set('idempotency-key', 'k').send({}).expect(404);
      expect(res.body.error).toBe('ITEM_NOT_FOUND');
    });

    it('answers 404 for a malformed redemption id', async () => {
      expect((await player().get('/v1/me/redemptions/not-a-uuid').expect(404)).body.error).toBe('REDEMPTION_NOT_FOUND');
    });

    it('requires an Idempotency-Key', async () => {
      const item = await itemBySku('casino-a', 'free-spins-10');
      expect((await redeem('casino-a', item.itemId, null).expect(400)).body.error).toBe('INVALID_IDEMPOTENCY_KEY');
    });
  });

  describe('C3 — duplicate redemption requests', () => {
    it('a repeated Idempotency-Key returns the original redemption and debits once', async () => {
      await creditCoins(ctx.app, 'casino-a', 100);
      const item = await itemBySku('casino-a', 'free-spins-10');
      const first = await redeem('casino-a', item.itemId, 'buy-1').expect(202);
      const second = await redeem('casino-a', item.itemId, 'buy-1').expect(200);
      expect(second.body.redemptionId).toBe(first.body.redemptionId);
      expect(await balance()).toBe(80);
    });

    it('10 concurrent requests with one key create one redemption and one debit', async () => {
      await creditCoins(ctx.app, 'casino-a', 100);
      const item = await itemBySku('casino-a', 'free-spins-10');
      const responses = await Promise.all(Array.from({ length: 10 }, () => redeem('casino-a', item.itemId, 'buy-1')));
      expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 202]);
      expect(new Set(responses.map((r) => r.body.redemptionId)).size).toBe(1);
      expect(await countRows(ctx.db, 'redemptions')).toBe(1);
      expect(await balance()).toBe(80);
    });

    it('reusing a key for a different item is rejected', async () => {
      await creditCoins(ctx.app, 'casino-a', 500);
      const cheap = await itemBySku('casino-a', 'free-spins-10');
      const pricey = await itemBySku('casino-a', 'bonus-5-eur');
      await redeem('casino-a', cheap.itemId, 'buy-1').expect(202);
      expect((await redeem('casino-a', pricey.itemId, 'buy-1').expect(422)).body.error).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await balance()).toBe(480);
    });

    it('concurrent purchases never overdraw the balance', async () => {
      await creditCoins(ctx.app, 'casino-a', 50);
      const item = await itemBySku('casino-a', 'free-spins-10');
      const responses = await Promise.all(Array.from({ length: 5 }, () => redeem('casino-a', item.itemId)));
      expect(responses.map((r) => r.status).sort()).toEqual([202, 202, 409, 409, 409]);
      expect(await balance()).toBe(10);
    });
  });

  describe('C4 — external API timeouts', () => {
    it.each([
      ['the casino issued but the answer was lost', 'lost-response'],
      ['the casino never processed the call', 'timeout'],
    ])('%s: retried with the same reference, issued exactly once', async (_name, mode) => {
      await creditCoins(ctx.app, 'casino-a', 20);
      const item = await itemBySku('casino-a', 'free-spins-10');
      const { body } = await redeem('casino-a', item.itemId).expect(202);
      await casino.fail('platform-a', [mode]);

      await worker.runOnce();
      expect(await status('casino-a', body.redemptionId)).toMatchObject({ status: 'PENDING', attempts: 1 });
      await worker.runOnce();
      expect(await status('casino-a', body.redemptionId)).toMatchObject({ status: 'ISSUED', attempts: 2 });
      expect(await casino.grants('platform-a')).toHaveLength(1);
      expect(await balance()).toBe(0);
    });
  });

  describe('C5 — failed reward issuance', () => {
    it('Casino A rejects: FAILED and the coins come back through a compensating entry', async () => {
      await creditCoins(ctx.app, 'casino-a', 20);
      const item = await itemBySku('casino-a', 'free-spins-10');
      const { body } = await redeem('casino-a', item.itemId).expect(202);
      await casino.fail('platform-a', ['reject']);

      await deliverAll();
      expect(await status('casino-a', body.redemptionId)).toMatchObject({
        status: 'FAILED',
        failureReason: expect.stringContaining('422'),
      });
      const { balance: coins, entries } = (await player().get('/v1/me/wallet').expect(200)).body;
      expect(coins).toBe(20);
      expect(entries.map((e: { kind: string }) => e.kind)).toEqual(
        expect.arrayContaining(['SPIN_REWARD', 'REDEMPTION_DEBIT', 'REDEMPTION_REFUND']),
      );
    });

    it('wrong casino credentials are a definitive refusal: FAILED and refunded', async () => {
      await ctx.db.updateTable('tenants').set({ reward_api_key: 'wrong-key' }).where('id', '=', 'casino-a').execute();
      await creditCoins(ctx.app, 'casino-a', 20);
      const item = await itemBySku('casino-a', 'free-spins-10');
      const { body } = await redeem('casino-a', item.itemId).expect(202);
      await deliverAll();
      expect(await status('casino-a', body.redemptionId)).toMatchObject({
        status: 'FAILED',
        failureReason: expect.stringContaining('401'),
      });
      expect(await balance()).toBe(20);
    });

    it('Casino B accepts, then rejects on completion: refunded after polling', async () => {
      await creditCoins(ctx.app, 'casino-b', 20);
      const item = await itemBySku('casino-b', 'cash-bonus-5-usd');
      const { body } = await redeem('casino-b', item.itemId).expect(202);
      await casino.fail('platform-b', ['reject-later']);

      await deliverAll();
      expect(await status('casino-b', body.redemptionId)).toMatchObject({ status: 'FAILED' });
      expect(await balance('casino-b')).toBe(20);
    });
  });

  describe('C6 — retries and eventual recovery', () => {
    const redeemOne = async () => {
      await creditCoins(ctx.app, 'casino-a', 20);
      const item = await itemBySku('casino-a', 'free-spins-10');
      return (await redeem('casino-a', item.itemId).expect(202)).body.redemptionId as string;
    };

    it('recovers after transient 5xx errors', async () => {
      const id = await redeemOne();
      await casino.fail('platform-a', ['error-500', 'error-500']);
      await deliverAll();
      const done = await status('casino-a', id);
      expect(done).toMatchObject({ status: 'ISSUED', attempts: 3 });
      expect(done.history.map((h: { to: string }) => h.to)).toEqual(['PENDING', 'PENDING', 'PENDING', 'ISSUED']);
    });

    it('out of attempts, reconciliation finds the reward was issued: ISSUED, no refund', async () => {
      const id = await redeemOne();
      await casino.fail('platform-a', Array(5).fill('lost-response'));
      await deliverAll();
      expect(await status('casino-a', id)).toMatchObject({ status: 'ISSUED', attempts: 5 });
      expect(await casino.grants('platform-a')).toHaveLength(1);
      expect(await balance()).toBe(0);
    });

    it('out of attempts, the casino confirms it holds nothing: FAILED and refunded', async () => {
      const id = await redeemOne();
      await casino.fail('platform-a', Array(5).fill('error-500'));
      await deliverAll();
      expect(await status('casino-a', id)).toMatchObject({
        status: 'FAILED',
        failureReason: 'casino has no record of the reward',
      });
      expect(await balance()).toBe(20);
    });

    it('out of attempts and the casino is unreachable: MANUAL_REVIEW, coins stay debited', async () => {
      const id = await redeemOne();
      await casino.fail('platform-a', Array(5).fill('error-500'));
      await casino.fail('platform-a', ['error-500'], 'status');
      await deliverAll();
      expect(await status('casino-a', id)).toMatchObject({ status: 'MANUAL_REVIEW' });
      expect(await balance()).toBe(0);
    });

    it('a job leased by a crashed worker is picked up again once the lease expires', async () => {
      const id = await redeemOne();
      const [claimed] = await ctx.app.get(RedemptionsRepository).claimDue(10, 30); // the "crashed" worker
      expect(claimed.id).toBe(id);
      expect(await worker.runOnce()).toBe(0); // still leased

      await ctx.db
        .updateTable('redemptions')
        .set({ lease_expires_at: new Date(Date.now() - 1000) })
        .execute();
      await deliverAll();
      expect(await status('casino-a', id)).toMatchObject({ status: 'ISSUED' });
      expect(await casino.grants('platform-a')).toHaveLength(1);
    });

    it('a worker that lost its lease cannot overwrite the new owner’s result', async () => {
      await redeemOne();
      const [stale] = await ctx.app.get(RedemptionsRepository).claimDue(10, 30);
      await ctx.db
        .updateTable('redemptions')
        .set({ lease_expires_at: new Date(Date.now() - 1000) })
        .execute();
      await deliverAll(); // the new owner issues the reward

      await casino.fail('platform-a', ['reject']); // what the stale worker would now hear back
      await ctx.app.get(DeliveryProcessor).process(stale);
      expect(await status('casino-a', stale.id)).toMatchObject({ status: 'ISSUED' });
      expect(await balance()).toBe(0); // no refund from the stale worker
    });

    it('an attempt that crashes keeps its lease and is retried after it expires', async () => {
      const id = await redeemOne();
      await ctx.db.updateTable('tenants').set({ platform: 'platform-x' }).where('id', '=', 'casino-a').execute();
      expect(await worker.runOnce()).toBe(1); // the processor throws; the worker survives
      expect(await worker.runOnce()).toBe(0);

      await ctx.db.updateTable('tenants').set({ platform: 'platform-a' }).where('id', '=', 'casino-a').execute();
      await ctx.db
        .updateTable('redemptions')
        .set({ lease_expires_at: new Date(Date.now() - 1000) })
        .execute();
      await deliverAll();
      expect(await status('casino-a', id)).toMatchObject({ status: 'ISSUED', attempts: 2 });
    });
  });

  describe('tenant and player isolation', () => {
    it('a redemption is visible only to its own player', async () => {
      await creditCoins(ctx.app, 'casino-a', 20);
      const item = await itemBySku('casino-a', 'free-spins-10');
      const { body } = await redeem('casino-a', item.itemId).expect(202);

      await player('casino-a', 'player-2').get(`/v1/me/redemptions/${body.redemptionId}`).expect(404);
      await player('casino-b', 'player-1').get(`/v1/me/redemptions/${body.redemptionId}`).expect(404);
      expect((await player('casino-a', 'player-2').get('/v1/me/redemptions').expect(200)).body).toEqual([]);
    });
  });
});

describe('Delivery worker in the background', () => {
  let ctx: TestContext;
  let casino: MockCasinoHandle;

  beforeAll(async () => {
    ctx = await createTestApp({ WORKER_ENABLED: 'true', WORKER_POLL_INTERVAL_MS: '50' });
    casino = await startMockCasino();
    await resetDatabase(ctx.db, casino.url);
  });
  afterAll(async () => {
    await ctx.app.close();
    await casino.close();
  });

  it('delivers without being driven by the test', async () => {
    await creditCoins(ctx.app, 'casino-b', 20);
    const player = asPlayer(ctx.app, playerToken('casino-b'));
    const [item] = (await player.get('/v1/store/items').expect(200)).body.items;
    const { body } = await player
      .post('/v1/me/redemptions')
      .set('idempotency-key', 'bg-1')
      .send({ itemId: item.itemId });

    let current = body.status;
    for (let i = 0; i < 50 && current !== 'ISSUED'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      current = (await player.get(`/v1/me/redemptions/${body.redemptionId}`).expect(200)).body.status;
    }
    expect(current).toBe('ISSUED');
  });
});
