import { join } from 'node:path';
import { sql } from 'kysely';
import { createDb } from '../../src/db/db.provider';
import { migrate } from '../../src/db/migrator';
import { TEST_DATABASE_URL } from './env';

// Runs once per `jest` invocation: rebuild the test schema from migrations so every run starts clean.
export default async function globalSetup(): Promise<void> {
  const db = createDb(TEST_DATABASE_URL, 1);
  try {
    try {
      await sql`SELECT 1`.execute(db);
    } catch (err) {
      throw new Error(
        `Test database is not reachable at ${TEST_DATABASE_URL}. Start it with "docker compose up -d postgres". ${String(err)}`,
      );
    }
    await sql`DROP SCHEMA public CASCADE`.execute(db);
    await sql`CREATE SCHEMA public`.execute(db);
    await migrate(db, join(__dirname, '..', '..', 'migrations'));
  } finally {
    await db.destroy();
  }
}
