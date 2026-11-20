import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'kysely';
import { AppModule } from '../../src/app.module';
import { loadConfig } from '../../src/config';
import { DB, type Db } from '../../src/db/db.provider';
import { seed } from '../../src/db/seed';
import { TEST_DATABASE_URL } from './env';

export interface TestContext {
  app: INestApplication;
  db: Db;
}

/** Boots the real application against the real test database. */
export async function createTestApp(): Promise<TestContext> {
  const config = loadConfig({ DATABASE_URL: TEST_DATABASE_URL, LOG_LEVEL: 'silent' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] }).compile();
  const app = moduleRef.createNestApplication({ rawBody: true, logger: false });
  await app.init();
  return { app, db: app.get<Db>(DB) };
}

/**
 * Wipes all tenant data and re-seeds the two dev operators.
 * The default reward endpoint is deliberately unreachable; tests that need a casino start the mock and pass its URL.
 */
export async function resetDatabase(db: Db, mockCasinoUrl = 'http://127.0.0.1:1'): Promise<void> {
  // TRUNCATE bypasses the row-level append-only trigger on ledger_entries by design.
  await sql`TRUNCATE redemption_events, redemptions, store_items, ledger_entries, wallets, spins, reward_tables,
            gamification_rules, inbound_events, players, tenants RESTART IDENTITY CASCADE`.execute(db);
  await seed(db, { mockCasinoUrl, rewardApiTimeoutMs: 300 });
}
