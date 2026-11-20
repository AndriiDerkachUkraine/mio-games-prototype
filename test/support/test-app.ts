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

export const TEST_SPIN_SEED_SECRET = 'test-spin-seed-secret-0123456789abcdef';

/** Boots the real application against the real test database. */
export async function createTestApp(overrides: Record<string, string> = {}): Promise<TestContext> {
  const config = loadConfig({
    DATABASE_URL: TEST_DATABASE_URL,
    LOG_LEVEL: 'silent',
    SPIN_SEED_SECRET: TEST_SPIN_SEED_SECRET,
    WORKER_ENABLED: 'false',
    RETRY_BASE_DELAY_MS: '0',
    RETRY_MAX_DELAY_MS: '0',
    ...overrides,
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] }).compile();
  const app = moduleRef.createNestApplication({ rawBody: true, logger: false });
  await app.init();
  return { app, db: app.get<Db>(DB) };
}

/** Wipes tenant data and re-seeds both dev operators (reward URL unreachable by default). */
export async function resetDatabase(db: Db, mockCasinoUrl = 'http://127.0.0.1:1'): Promise<void> {
  // TRUNCATE bypasses the row-level append-only trigger on ledger_entries by design.
  await sql`TRUNCATE redemption_events, redemptions, store_items, ledger_entries, wallets, spins, reward_tables,
            gamification_rules, inbound_events, players, tenants RESTART IDENTITY CASCADE`.execute(db);
  await seed(db, { mockCasinoUrl, rewardApiTimeoutMs: 300 });
}
