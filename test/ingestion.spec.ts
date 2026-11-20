import { DEV_TENANTS } from '../src/db/seed';
import { hmacSha256 } from '../src/modules/integrations/signatures';
import { countRows } from './support/db';
import { createTestApp, resetDatabase, type TestContext } from './support/test-app';
import { nowSeconds, platformADeposit, platformBDeposit, sendPlatformA, sendPlatformB } from './support/webhooks';

describe('Event ingestion', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(() => resetDatabase(ctx.db));

  const availableSpins = async (tenantId: string, externalPlayerId: string): Promise<number> => {
    const { n } = await ctx.db
      .selectFrom('spins')
      .innerJoin('players', 'players.id', 'spins.player_id')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('spins.tenant_id', '=', tenantId)
      .where('players.external_player_id', '=', externalPlayerId)
      .where('spins.status', '=', 'AVAILABLE')
      .executeTakeFirstOrThrow();
    return n;
  };

  const sendPlatformAWithTimestamp = (timestamp: string) => {
    const raw = JSON.stringify(platformADeposit());
    const signature = hmacSha256(DEV_TENANTS['casino-a'].webhookSecret, `${timestamp}.${raw}`).toString('hex');
    return sendPlatformA(ctx.app, platformADeposit(), {
      headers: { 'x-timestamp': timestamp, 'x-signature': `sha256=${signature}` },
    });
  };

  describe('happy path — both platforms feed the same core', () => {
    it('Platform A: a successful deposit grants one spin', async () => {
      const res = await sendPlatformA(ctx.app, platformADeposit()).expect(200);
      expect(res.body).toEqual({ status: 'processed', eventId: expect.any(String), spinsGranted: 1 });
      expect(await availableSpins('casino-a', 'player-1')).toBe(1);
    });

    it('Platform B: a successful deposit (different schema) grants one spin', async () => {
      const res = await sendPlatformB(ctx.app, platformBDeposit()).expect(200);
      expect(res.body).toEqual({ status: 'processed', eventId: expect.any(String), spinsGranted: 1 });
      expect(await availableSpins('casino-b', 'player-1')).toBe(1);
    });

    it('applies the rule threshold: a deposit below the minimum grants nothing', async () => {
      const resA = await sendPlatformA(ctx.app, platformADeposit({ amount_cents: 999 })).expect(200);
      expect(resA.body.spinsGranted).toBe(0);
      const resB = await sendPlatformB(ctx.app, platformBDeposit({ data: { amount: '9.99' } })).expect(200);
      expect(resB.body.spinsGranted).toBe(0);
    });

    it('applies the rule currency: a deposit in another currency grants nothing', async () => {
      const res = await sendPlatformA(ctx.app, platformADeposit({ currency: 'USD' })).expect(200);
      expect(res.body.spinsGranted).toBe(0);
    });

    it.each([
      ['Platform A FAILED', () => sendPlatformA(ctx.app, platformADeposit({ status: 'FAILED' })), 'FAILED'],
      ['Platform A PENDING', () => sendPlatformA(ctx.app, platformADeposit({ status: 'PENDING' })), 'PENDING'],
      ['Platform B declined', () => sendPlatformB(ctx.app, platformBDeposit({ data: { state: 3 } })), 'FAILED'],
      ['Platform B pending', () => sendPlatformB(ctx.app, platformBDeposit({ data: { state: 1 } })), 'PENDING'],
    ])('%s deposit is recorded but grants nothing', async (_name, send, depositStatus) => {
      const res = await send().expect(200);
      const reason = `deposit status ${depositStatus}`;
      expect(res.body).toEqual({ status: 'ignored', eventId: expect.any(String), reason });
      const event = await ctx.db
        .selectFrom('inbound_events')
        .select(['status', 'ignore_reason'])
        .where('id', '=', res.body.eventId)
        .executeTakeFirstOrThrow();
      expect(event).toEqual({ status: 'IGNORED', ignore_reason: reason });
      expect(await countRows(ctx.db, 'spins')).toBe(0);
    });

    it('acknowledges event types the core does not handle', async () => {
      const resA = await sendPlatformA(ctx.app, { event_id: 'a-wd-1', event_type: 'withdrawal' }).expect(200);
      expect(resA.body).toMatchObject({ status: 'ignored', reason: 'unsupported event type "withdrawal"' });
      const resB = await sendPlatformB(ctx.app, platformBDeposit({ data: { operation: 'WITHDRAWAL' } })).expect(200);
      expect(resB.body).toMatchObject({ status: 'ignored', reason: 'unsupported event type "PAYMENT/WITHDRAWAL"' });
      const resRefund = await sendPlatformB(ctx.app, {
        ...platformBDeposit({ notificationId: 'b-rf-1' }),
        type: 'REFUND',
      });
      expect(resRefund.body).toMatchObject({ status: 'ignored', reason: 'unsupported event type "REFUND/DEPOSIT"' });
      expect(await countRows(ctx.db, 'spins')).toBe(0);
    });
  });

  describe('player identity mapping', () => {
    it('maps the casino player id to an internal player and keeps the raw payload', async () => {
      const body = platformADeposit();
      const { body: res } = await sendPlatformA(ctx.app, body).expect(200);
      const event = await ctx.db
        .selectFrom('inbound_events')
        .innerJoin('players', 'players.id', 'inbound_events.player_id')
        .select(['inbound_events.payload', 'players.tenant_id', 'players.external_player_id'])
        .where('inbound_events.id', '=', res.eventId)
        .executeTakeFirstOrThrow();
      expect(event).toEqual({ payload: body, tenant_id: 'casino-a', external_player_id: 'player-1' });
    });

    it('concurrent first deposits of a new player converge on one player and one wallet', async () => {
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          sendPlatformA(ctx.app, platformADeposit({ event_id: `a-evt-${i}` })).expect(200),
        ),
      );
      expect(await countRows(ctx.db, 'players')).toBe(1);
      expect(await countRows(ctx.db, 'wallets')).toBe(1);
      expect(await availableSpins('casino-a', 'player-1')).toBe(10);
    });
  });

  describe('C1 — duplicate deposit events', () => {
    it('a redelivered event is acknowledged as duplicate and grants nothing more', async () => {
      const first = await sendPlatformA(ctx.app, platformADeposit()).expect(200);
      const second = await sendPlatformA(ctx.app, platformADeposit()).expect(200);
      expect(second.body).toEqual({ status: 'duplicate', eventId: first.body.eventId });
      expect(await availableSpins('casino-a', 'player-1')).toBe(1);
    });

    it('10 concurrent deliveries of one event grant exactly one spin', async () => {
      const responses = await Promise.all(Array.from({ length: 10 }, () => sendPlatformB(ctx.app, platformBDeposit())));
      const statuses = responses.map((r) => r.body.status).sort();
      expect(statuses).toEqual(['processed', ...Array(9).fill('duplicate')].sort());
      expect(await availableSpins('casino-b', 'player-1')).toBe(1);
    });

    it.each([
      ['a failed deposit', platformADeposit({ status: 'FAILED' })],
      ['an unsupported event', { event_id: 'a-wd-1', event_type: 'withdrawal' }],
    ])('a redelivered %s is a duplicate too', async (_name, body) => {
      const first = await sendPlatformA(ctx.app, body).expect(200);
      expect(first.body.status).toBe('ignored');
      const second = await sendPlatformA(ctx.app, body).expect(200);
      expect(second.body).toEqual({ status: 'duplicate', eventId: first.body.eventId });
      expect(await countRows(ctx.db, 'inbound_events')).toBe(1);
    });

    it('distinct events from the same player each grant a spin', async () => {
      await sendPlatformA(ctx.app, platformADeposit({ event_id: 'a-evt-1' })).expect(200);
      await sendPlatformA(ctx.app, platformADeposit({ event_id: 'a-evt-2' })).expect(200);
      expect(await availableSpins('casino-a', 'player-1')).toBe(2);
    });
  });

  describe('C7 — tenant isolation', () => {
    it('the same external ids in two tenants are independent players and events', async () => {
      await sendPlatformA(ctx.app, platformADeposit({ event_id: 'shared-id', player_id: 'shared-player' })).expect(200);
      const resB = await sendPlatformB(
        ctx.app,
        platformBDeposit({ notificationId: 'shared-id', data: { customer: { ref: 'shared-player' } } }),
      ).expect(200);
      expect(resB.body.status).toBe('processed'); // dedup is per tenant
      expect(await availableSpins('casino-a', 'shared-player')).toBe(1);
      expect(await availableSpins('casino-b', 'shared-player')).toBe(1);
    });

    it('an event signed with tenant A’s secret is rejected on tenant B’s endpoint', async () => {
      const res = await sendPlatformB(ctx.app, platformBDeposit(), { secret: DEV_TENANTS['casino-a'].webhookSecret });
      expect(res.status).toBe(401);
      expect(await countRows(ctx.db, 'inbound_events')).toBe(0);
    });

    it('a suspended tenant cannot submit events', async () => {
      await ctx.db.updateTable('tenants').set({ status: 'SUSPENDED' }).where('id', '=', 'casino-a').execute();
      await sendPlatformA(ctx.app, platformADeposit()).expect(401);
    });
  });

  describe('C8 — invalid or unauthorized events', () => {
    it.each([
      ['unknown tenant', () => sendPlatformA(ctx.app, platformADeposit(), { tenantId: 'casino-x' })],
      ['missing signature', () => sendPlatformA(ctx.app, platformADeposit(), { headers: {} })],
      ['wrong secret', () => sendPlatformA(ctx.app, platformADeposit(), { secret: 'attacker-secret' })],
      [
        'body tampered after signing',
        () =>
          sendPlatformA(ctx.app, platformADeposit({ amount_cents: 999999 }), {
            signedBody: JSON.stringify(platformADeposit()),
          }),
      ],
      ['non-JSON content type', () => sendPlatformA(ctx.app, platformADeposit(), { contentType: 'text/plain' })],
      [
        'Platform A replay (stale timestamp)',
        () => sendPlatformA(ctx.app, platformADeposit(), { timestamp: nowSeconds() - 3600 }),
      ],
      [
        'Platform A future timestamp',
        () => sendPlatformA(ctx.app, platformADeposit(), { timestamp: nowSeconds() + 3600 }),
      ],
      [
        'Platform B replay (stale signed body)',
        () => sendPlatformB(ctx.app, platformBDeposit({ timestamp: nowSeconds() - 3600 })),
      ],
      ['Platform B missing signature', () => sendPlatformB(ctx.app, platformBDeposit(), { headers: {} })],
      ['Platform A non-numeric timestamp (validly signed)', () => sendPlatformAWithTimestamp('soon')],
      [
        'Platform B non-numeric timestamp (validly signed)',
        () => sendPlatformB(ctx.app, { ...platformBDeposit(), timestamp: 'soon' }),
      ],
    ])('%s → 401, nothing stored', async (_name, send) => {
      const res = await send();
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHORIZED_EVENT');
      expect(await countRows(ctx.db, 'inbound_events')).toBe(0);
    });

    it.each([
      ['Platform A missing player', () => sendPlatformA(ctx.app, platformADeposit({ player_id: undefined }))],
      ['Platform A zero amount', () => sendPlatformA(ctx.app, platformADeposit({ amount_cents: 0 }))],
      ['Platform A negative amount', () => sendPlatformA(ctx.app, platformADeposit({ amount_cents: -500 }))],
      ['Platform A fractional cents', () => sendPlatformA(ctx.app, platformADeposit({ amount_cents: 10.5 }))],
      ['Platform A unknown status', () => sendPlatformA(ctx.app, platformADeposit({ status: 'MAYBE' }))],
      ['Platform A bad currency', () => sendPlatformA(ctx.app, platformADeposit({ currency: 'euro' }))],
      ['Platform B non-numeric amount', () => sendPlatformB(ctx.app, platformBDeposit({ data: { amount: 'abc' } }))],
      ['Platform B zero amount', () => sendPlatformB(ctx.app, platformBDeposit({ data: { amount: '0.00' } }))],
      ['Platform B three decimals', () => sendPlatformB(ctx.app, platformBDeposit({ data: { amount: '1.005' } }))],
      ['Platform B unknown state', () => sendPlatformB(ctx.app, platformBDeposit({ data: { state: 9 } }))],
      ['body is not an object', () => sendPlatformA(ctx.app, [])],
      [
        'Platform B missing notificationId',
        () => sendPlatformB(ctx.app, { ...platformBDeposit(), notificationId: undefined }),
      ],
      [
        'Platform A amount beyond safe integer',
        () => sendPlatformA(ctx.app, platformADeposit({ amount_cents: 2 ** 60 })),
      ],
    ])('%s → 422, nothing stored', async (_name, send) => {
      const res = await send();
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('INVALID_EVENT');
      expect(await countRows(ctx.db, 'inbound_events')).toBe(0);
    });
  });
});
