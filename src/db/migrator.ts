import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'kysely';
import type { Db } from './db.provider';

const MIGRATION_LOCK_ID = 7041977;

/**
 * Forward-only migrator over plain .sql files. Pending files run in one transaction under an advisory lock,
 * so concurrently starting containers cannot apply a migration twice.
 */
export async function migrate(db: Db, migrationsDir: string): Promise<string[]> {
  return db.transaction().execute(async (tx) => {
    await sql`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_ID})`.execute(tx);
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`.execute(tx);
    const { rows } = await sql<{ name: string }>`SELECT name FROM schema_migrations`.execute(tx);
    const applied = new Set(rows.map((r) => r.name));
    const pending = readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql') && !applied.has(file))
      .sort();
    for (const file of pending) {
      await sql.raw(readFileSync(join(migrationsDir, file), 'utf8')).execute(tx);
      await sql`INSERT INTO schema_migrations (name) VALUES (${file})`.execute(tx);
    }
    return pending;
  });
}
