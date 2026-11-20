import { createDb, type Db } from '../src/db/db.provider';
import { seed } from '../src/db/seed';
import { TEST_DATABASE_URL } from './support/env';
import { resetDatabase } from './support/test-app';

// These tests bypass the application on purpose: the guarantees must hold even if application code is wrong.
describe('Schema-level invariants', () => {
  let db: Db;
  let playerA: string;
  let playerB: string;

  beforeAll(() => {
    db = createDb(TEST_DATABASE_URL, 2);
  });
  afterAll(() => db.destroy());

  beforeEach(async () => {
    await resetDatabase(db);
    playerA = await insertPlayer('casino-a', 'p-1');
    playerB = await insertPlayer('casino-b', 'p-1');
  });

  async function insertPlayer(tenantId: string, externalId: string): Promise<string> {
    const { id } = await db
      .insertInto('players')
      .values({ tenant_id: tenantId, external_player_id: externalId })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db.insertInto('wallets').values({ tenant_id: tenantId, player_id: id }).execute();
    return id;
  }

  const ledgerEntry = (playerId: string, key: string) => ({
    tenant_id: 'casino-a',
    player_id: playerId,
    amount: 10,
    balance_after: 10,
    kind: 'SPIN_REWARD' as const,
    reference_id: playerId,
    idempotency_key: key,
  });

  it('maps the same external player id to distinct players per tenant', () => {
    expect(playerA).not.toEqual(playerB);
  });

  it('rejects a duplicate external player id within one tenant', async () => {
    await expect(insertPlayer('casino-a', 'p-1')).rejects.toThrow(/players_tenant_id_external_player_id_key/);
  });

  it('rejects a negative wallet balance', async () => {
    await expect(
      db.updateTable('wallets').set({ balance: -1 }).where('player_id', '=', playerA).execute(),
    ).rejects.toThrow(/wallets_balance_check/);
  });

  it('keeps the ledger append-only', async () => {
    await db.insertInto('ledger_entries').values(ledgerEntry(playerA, 'k-1')).execute();
    await expect(db.updateTable('ledger_entries').set({ amount: 999 }).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('ledger_entries').execute()).rejects.toThrow(/append-only/);
  });

  it('rejects a second ledger entry with the same idempotency key', async () => {
    await db.insertInto('ledger_entries').values(ledgerEntry(playerA, 'k-1')).execute();
    await expect(db.insertInto('ledger_entries').values(ledgerEntry(playerA, 'k-1')).execute()).rejects.toThrow(
      /ledger_entries_tenant_id_idempotency_key_key/,
    );
  });

  it('rejects rows that reference another tenant’s player', async () => {
    // casino-a ledger row pointing at casino-b's player.
    await expect(db.insertInto('ledger_entries').values(ledgerEntry(playerB, 'k-x')).execute()).rejects.toThrow(
      /violates foreign key constraint/,
    );
  });

  it('rejects a spin marked USED without a complete outcome', async () => {
    const event = await db
      .insertInto('inbound_events')
      .values({
        tenant_id: 'casino-a',
        external_event_id: 'e-1',
        event_type: 'DEPOSIT',
        status: 'PROCESSED',
        ignore_reason: null,
        player_id: playerA,
        payload: JSON.stringify({}),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const rule = await db
      .selectFrom('gamification_rules')
      .select('id')
      .where('tenant_id', '=', 'casino-a')
      .executeTakeFirstOrThrow();
    const spin = await db
      .insertInto('spins')
      .values({ tenant_id: 'casino-a', player_id: playerA, source_event_id: event.id, rule_id: rule.id })
      .returning('id')
      .executeTakeFirstOrThrow();

    await expect(
      db.updateTable('spins').set({ status: 'USED', used_at: new Date() }).where('id', '=', spin.id).execute(),
    ).rejects.toThrow(/spins_check/);
  });

  it('allows only one active reward table per tenant', async () => {
    await expect(
      db
        .insertInto('reward_tables')
        .values({ tenant_id: 'casino-a', version: 2, segments: '[]', active: true, created_by: 'test' })
        .execute(),
    ).rejects.toThrow(/reward_tables_one_active/);
  });

  it('seeding is idempotent', async () => {
    await seed(db, { mockCasinoUrl: 'http://127.0.0.1:1' });
    const countRows = async (table: 'tenants' | 'gamification_rules' | 'reward_tables' | 'store_items') =>
      (
        await db
          .selectFrom(table)
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .executeTakeFirstOrThrow()
      ).n;
    expect(await countRows('tenants')).toBe(2);
    expect(await countRows('gamification_rules')).toBe(2);
    expect(await countRows('reward_tables')).toBe(2);
    expect(await countRows('store_items')).toBe(4);
  });
});
