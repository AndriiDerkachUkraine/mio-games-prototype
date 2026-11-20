import { randomUUID } from 'node:crypto';
import { LedgerService, type Posting } from '../src/modules/ledger/ledger.service';
import { PlayersRepository } from '../src/modules/players/players.repository';
import { createTestApp, resetDatabase, type TestContext } from './support/test-app';

describe('Ledger', () => {
  let ctx: TestContext;
  let ledger: LedgerService;
  let playerId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    ledger = ctx.app.get(LedgerService);
  });
  afterAll(() => ctx.app.close());

  beforeEach(async () => {
    await resetDatabase(ctx.db);
    const players = ctx.app.get(PlayersRepository);
    playerId = await ctx.db.transaction().execute((tx) => players.resolve(tx, 'casino-a', 'player-1'));
  });

  const posting = (amount: number, idempotencyKey: string = randomUUID()): Posting => ({
    tenantId: 'casino-a',
    playerId,
    amount,
    kind: amount > 0 ? 'SPIN_REWARD' : 'REDEMPTION_DEBIT',
    referenceId: randomUUID(),
    idempotencyKey,
  });
  const post = (p: Posting) => ctx.db.transaction().execute((tx) => ledger.post(tx, p));
  const balance = async () => (await ledger.wallet('casino-a', playerId)).balance;

  it('keeps balance_after as the running sum of entries', async () => {
    expect(await post(posting(100))).toBe(100);
    expect(await post(posting(-30))).toBe(70);
    expect(await post(posting(5))).toBe(75);
    const { entries } = await ledger.wallet('casino-a', playerId);
    expect(entries.map((e) => [e.amount, e.balanceAfter]).sort((a, b) => a[1] - b[1])).toEqual([
      [-30, 70],
      [5, 75],
      [100, 100],
    ]);
  });

  it('refuses a debit larger than the balance and changes nothing', async () => {
    await post(posting(50));
    await expect(post(posting(-51))).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    expect(await balance()).toBe(50);
    expect((await ledger.wallet('casino-a', playerId)).entries).toHaveLength(1);
  });

  it('never goes negative under concurrent debits', async () => {
    await post(posting(100));
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => post(posting(-30))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(await balance()).toBe(10);
  });

  it('applies one financial effect per idempotency key, rolling back the duplicate', async () => {
    await post(posting(100, 'op-1'));
    await expect(post(posting(100, 'op-1'))).rejects.toThrow(/ledger_entries_tenant_id_idempotency_key_key/);
    expect(await balance()).toBe(100);
  });

  it('fails loudly instead of silently dropping a credit to a missing wallet', async () => {
    await expect(post({ ...posting(10), playerId: randomUUID() })).rejects.toThrow(/Wallet not found/);
  });

  it('rejects zero and fractional amounts as programming errors', async () => {
    await expect(post(posting(0))).rejects.toThrow(/Invalid ledger amount/);
    await expect(post(posting(1.5))).rejects.toThrow(/Invalid ledger amount/);
  });
});
