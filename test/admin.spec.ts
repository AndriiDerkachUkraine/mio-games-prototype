import request from 'supertest';
import { DEV_TENANTS, type DevTenantId } from '../src/db/seed';
import { DeliveryWorker } from '../src/modules/redemption/delivery.worker';
import { startMockCasino, type MockCasinoHandle } from './support/mock-casino';
import { asPlayer, creditCoins, grantSpins, playerToken } from './support/players';
import { createTestApp, resetDatabase, type TestContext } from './support/test-app';
import { platformADeposit, sendPlatformA } from './support/webhooks';

describe('Admin API', () => {
  let ctx: TestContext;
  let casino: MockCasinoHandle;

  beforeAll(async () => {
    ctx = await createTestApp();
    casino = await startMockCasino();
  });
  afterAll(async () => {
    await ctx.app.close();
    await casino.close();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.db, casino.url);
    await casino.reset();
  });

  const admin = (tenantId: DevTenantId = 'casino-a', key: string = DEV_TENANTS[tenantId].adminApiKey) => {
    const server = ctx.app.getHttpServer();
    return {
      get: (path: string) => request(server).get(`/v1/admin${path}`).set('x-admin-key', key),
      post: (path: string, body: object) => request(server).post(`/v1/admin${path}`).set('x-admin-key', key).send(body),
      patch: (path: string, body: object) =>
        request(server).patch(`/v1/admin${path}`).set('x-admin-key', key).send(body),
    };
  };
  const player = (tenantId: DevTenantId = 'casino-a') => asPlayer(ctx.app, playerToken(tenantId));
  const firstRuleId = async (tenantId: DevTenantId = 'casino-a') =>
    (await admin(tenantId).get('/rules').expect(200)).body.rules[0].ruleId as string;

  describe('authentication and tenant scope', () => {
    it.each([
      ['no key', () => request(ctx.app.getHttpServer()).get('/v1/admin/rules')],
      ['a wrong key', () => admin('casino-a', 'guessed-key').get('/rules')],
    ])('rejects %s with 401', async (_name, send) => {
      const res = await send();
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHORIZED_ADMIN');
    });

    it('rejects the key of a suspended tenant', async () => {
      await ctx.db.updateTable('tenants').set({ status: 'SUSPENDED' }).where('id', '=', 'casino-a').execute();
      await admin('casino-a').get('/rules').expect(401);
    });

    it('the key decides the tenant: each admin sees only its own configuration', async () => {
      const skusA = (await admin('casino-a').get('/store-items').expect(200)).body.items.map(
        (i: { sku: string }) => i.sku,
      );
      const skusB = (await admin('casino-b').get('/store-items').expect(200)).body.items.map(
        (i: { sku: string }) => i.sku,
      );
      expect(skusA).toEqual(['free-spins-10', 'bonus-5-eur']);
      expect(skusB).toEqual(['cash-bonus-5-usd', 'free-spins-20']);
    });

    it.each([
      [
        'store item',
        (a: ReturnType<typeof admin>) => a.patch('/store-items/not-a-uuid', { active: false }),
        'ITEM_NOT_FOUND',
      ],
      ['rule', (a: ReturnType<typeof admin>) => a.patch('/rules/not-a-uuid', { active: false }), 'RULE_NOT_FOUND'],
      [
        'redemption',
        (a: ReturnType<typeof admin>) => a.post('/redemptions/not-a-uuid/resolve', { outcome: 'REFUNDED', note: 'x' }),
        'REDEMPTION_NOT_FOUND',
      ],
    ])('a malformed %s id is 404', async (_name, send, error) => {
      const res = await send(admin());
      expect(res.status).toBe(404);
      expect(res.body.error).toBe(error);
    });

    it('cannot change another tenant’s rule or item', async () => {
      const ruleB = await firstRuleId('casino-b');
      const itemB = (await admin('casino-b').get('/store-items').expect(200)).body.items[0].itemId;
      expect((await admin('casino-a').patch(`/rules/${ruleB}`, { active: false }).expect(404)).body.error).toBe(
        'RULE_NOT_FOUND',
      );
      expect((await admin('casino-a').patch(`/store-items/${itemB}`, { active: false }).expect(404)).body.error).toBe(
        'ITEM_NOT_FOUND',
      );
    });
  });

  describe('reward table versions', () => {
    const v2 = [{ key: 'v2-only', label: 'v2', coins: 7, weight: 1 }];

    it('publishes an immutable new version that the next spin uses', async () => {
      expect((await admin().post('/reward-tables', { segments: v2 }).expect(201)).body).toEqual({ version: 2 });
      const { versions } = (await admin().get('/reward-tables').expect(200)).body;
      expect(versions.map((v: { version: number; active: boolean }) => [v.version, v.active])).toEqual([
        [2, true],
        [1, false],
      ]);
      expect(versions[1].segments).toHaveLength(4); // v1 untouched

      const [spinId] = await grantSpins(ctx.app, 'casino-a');
      const res = await player().post(`/v1/me/spins/${spinId}/play`).expect(200);
      expect(res.body).toMatchObject({ rewardTableVersion: 2, segment: { key: 'v2-only', coins: 7 } });
    });

    it('does not affect other tenants', async () => {
      await admin('casino-a').post('/reward-tables', { segments: v2 }).expect(201);
      const { versions } = (await admin('casino-b').get('/reward-tables').expect(200)).body;
      expect(versions.map((v: { version: number }) => v.version)).toEqual([1]);
    });

    it('serializes concurrent publishes into consecutive versions with one active table', async () => {
      await Promise.all(Array.from({ length: 5 }, () => admin().post('/reward-tables', { segments: v2 }).expect(201)));
      const { versions } = (await admin().get('/reward-tables').expect(200)).body;
      expect(versions.map((v: { version: number }) => v.version)).toEqual([6, 5, 4, 3, 2, 1]);
      expect(versions.filter((v: { active: boolean }) => v.active)).toHaveLength(1);
    });

    it.each([
      ['no segments', []],
      ['a zero weight', [{ key: 'a', label: 'a', coins: 1, weight: 0 }]],
      ['zero coins', [{ key: 'a', label: 'a', coins: 0, weight: 1 }]],
      [
        'duplicate keys',
        [
          { key: 'a', label: 'a', coins: 1, weight: 1 },
          { key: 'a', label: 'b', coins: 2, weight: 1 },
        ],
      ],
      ['an excessive total weight', [{ key: 'a', label: 'a', coins: 1, weight: 2_000_000_000 }]],
    ])('rejects %s with 422 and publishes nothing', async (_name, segments) => {
      const res = await admin().post('/reward-tables', { segments }).expect(422);
      expect(res.body.error).toBe('INVALID_REQUEST');
      expect((await admin().get('/reward-tables').expect(200)).body.versions).toHaveLength(1);
    });
  });

  describe('store items', () => {
    const item = {
      sku: 'free-spins-50',
      name: '50 free spins',
      priceCoins: 150,
      reward: { type: 'FREE_SPINS', quantity: 50, game: 'book-of-mio' },
    };

    it('creates an item that the tenant’s players can see', async () => {
      const created = (await admin().post('/store-items', item).expect(201)).body;
      expect(created).toMatchObject({ ...item, active: true, itemId: expect.any(String) });
      const skus = (await player().get('/v1/store/items').expect(200)).body.items.map((i: { sku: string }) => i.sku);
      expect(skus).toContain('free-spins-50');
      const skusB = (await player('casino-b').get('/v1/store/items').expect(200)).body.items.map(
        (i: { sku: string }) => i.sku,
      );
      expect(skusB).not.toContain('free-spins-50');
    });

    it('refuses a duplicate sku', async () => {
      await admin().post('/store-items', item).expect(201);
      expect((await admin().post('/store-items', item).expect(409)).body.error).toBe('SKU_TAKEN');
    });

    it.each([
      ['a negative price', { ...item, priceCoins: -1 }],
      ['an unknown reward type', { ...item, reward: { type: 'CAR' } }],
      ['a malformed sku', { ...item, sku: 'Not A Sku' }],
    ])('rejects %s with 422', async (_name, body) => {
      expect((await admin().post('/store-items', body).expect(422)).body.error).toBe('INVALID_REQUEST');
    });

    it('deactivation hides an item from the store and blocks new redemptions', async () => {
      const [first] = (await admin().get('/store-items').expect(200)).body.items;
      await admin().patch(`/store-items/${first.itemId}`, { active: false }).expect(200);
      const visible = (await player().get('/v1/store/items').expect(200)).body.items.map(
        (i: { itemId: string }) => i.itemId,
      );
      expect(visible).not.toContain(first.itemId);

      await creditCoins(ctx.app, 'casino-a', 100);
      const res = await player().post('/v1/me/redemptions').set('idempotency-key', 'k').send({ itemId: first.itemId });
      expect(res.status).toBe(404);

      await admin().patch(`/store-items/${first.itemId}`, { active: true }).expect(200);
      expect((await player().get('/v1/store/items').expect(200)).body.items).toHaveLength(2);
    });
  });

  describe('rules', () => {
    const deposit = (id: string, amountCents = 5000) =>
      sendPlatformA(ctx.app, platformADeposit({ event_id: id, amount_cents: amountCents })).expect(200);

    it('changes take effect on the next event', async () => {
      const ruleId = await firstRuleId();
      await admin().patch(`/rules/${ruleId}`, { spinsGranted: 3 }).expect(200);
      expect((await deposit('d-1')).body.spinsGranted).toBe(3);

      await admin().patch(`/rules/${ruleId}`, { minAmountMinor: 10_000 }).expect(200);
      expect((await deposit('d-2')).body.spinsGranted).toBe(0);

      await admin().patch(`/rules/${ruleId}`, { minAmountMinor: 0, currency: 'USD' }).expect(200);
      expect((await deposit('d-3')).body.spinsGranted).toBe(0); // the deposit is in EUR

      await admin().patch(`/rules/${ruleId}`, { currency: null }).expect(200);
      expect((await deposit('d-4')).body.spinsGranted).toBe(3); // any currency

      await admin().patch(`/rules/${ruleId}`, { active: false }).expect(200);
      expect((await deposit('d-5')).body.spinsGranted).toBe(0);
    });

    it.each([
      ['an empty change', {}],
      ['zero spins', { spinsGranted: 0 }],
      ['a malformed currency', { currency: 'euro' }],
    ])('rejects %s with 422', async (_name, body) => {
      const ruleId = await firstRuleId();
      expect((await admin().patch(`/rules/${ruleId}`, body).expect(422)).body.error).toBe('INVALID_REQUEST');
    });
  });

  describe('manual review queue', () => {
    /** Puts one Casino A redemption into MANUAL_REVIEW: every issue attempt fails and the status check too. */
    const redemptionInReview = async (): Promise<string> => {
      await creditCoins(ctx.app, 'casino-a', 20);
      const [cheapest] = (await player().get('/v1/store/items').expect(200)).body.items;
      const { body } = await player()
        .post('/v1/me/redemptions')
        .set('idempotency-key', 'review-1')
        .send({ itemId: cheapest.itemId })
        .expect(202);
      await casino.fail('platform-a', Array(5).fill('error-500'));
      await casino.fail('platform-a', ['error-500'], 'status');
      const worker = ctx.app.get(DeliveryWorker);
      for (let i = 0; i < 10 && (await worker.runOnce()) > 0; i++);
      return body.redemptionId;
    };
    const balance = async () => (await player().get('/v1/me/wallet').expect(200)).body.balance;
    const history = async (id: string) =>
      (await player().get(`/v1/me/redemptions/${id}`).expect(200)).body.history.map((h: { to: string }) => h.to);

    it('lists redemptions awaiting a decision', async () => {
      const id = await redemptionInReview();
      const { redemptions } = (await admin().get('/redemptions').expect(200)).body;
      expect(redemptions).toEqual([
        expect.objectContaining({ redemptionId: id, externalPlayerId: 'player-1', status: 'MANUAL_REVIEW' }),
      ]);
      expect((await admin('casino-b').get('/redemptions').expect(200)).body.redemptions).toEqual([]);
    });

    it('refunding returns the coins and records the decision', async () => {
      const id = await redemptionInReview();
      expect(await balance()).toBe(0);
      const res = await admin().post(`/redemptions/${id}/resolve`, { outcome: 'REFUNDED', note: 'casino confirmed' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'FAILED' });
      expect(await balance()).toBe(20);
      expect((await history(id)).slice(-2)).toEqual(['MANUAL_REVIEW', 'FAILED']);
    });

    it('confirming delivery keeps the coins debited', async () => {
      const id = await redemptionInReview();
      await admin()
        .post(`/redemptions/${id}/resolve`, {
          outcome: 'ISSUED',
          externalReference: 'bonus-77',
          note: 'found in casino',
        })
        .expect(200);
      expect(await balance()).toBe(0);
      expect((await player().get(`/v1/me/redemptions/${id}`).expect(200)).body).toMatchObject({
        status: 'ISSUED',
        externalReference: 'bonus-77',
      });
    });

    it('two operators deciding at once: one wins, the coins are refunded once', async () => {
      const id = await redemptionInReview();
      const results = await Promise.all(
        [1, 2].map(() => admin().post(`/redemptions/${id}/resolve`, { outcome: 'REFUNDED', note: 'dup' })),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(results.find((r) => r.status === 409)?.body.error).toBe('NOT_IN_REVIEW');
      expect(await balance()).toBe(20);
    });

    it('another tenant’s admin cannot resolve it', async () => {
      const id = await redemptionInReview();
      const res = await admin('casino-b').post(`/redemptions/${id}/resolve`, { outcome: 'REFUNDED', note: 'x' });
      expect(res.status).toBe(404);
      expect(await balance()).toBe(0);
    });

    it.each([
      ['an unknown outcome', { outcome: 'MAYBE', note: 'x' }],
      ['a confirmation without the casino reference', { outcome: 'ISSUED', note: 'x' }],
      ['a decision without a note', { outcome: 'REFUNDED' }],
    ])('rejects %s with 422', async (_name, body) => {
      const id = await redemptionInReview();
      expect((await admin().post(`/redemptions/${id}/resolve`, body).expect(422)).body.error).toBe('INVALID_REQUEST');
    });

    it('rejects an unknown status filter', async () => {
      expect((await admin().get('/redemptions?status=LOST').expect(422)).body.error).toBe('INVALID_REQUEST');
    });
  });
});
