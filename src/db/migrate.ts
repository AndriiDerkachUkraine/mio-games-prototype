import { join } from 'node:path';
import { createDb } from './db.provider';
import { migrate } from './migrator';
import { seed } from './seed';

// CLI entrypoint: `node dist/db/migrate.js [--seed]`
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const db = createDb(url, 1);
  try {
    const applied = await migrate(db, join(__dirname, '..', '..', 'migrations'));
    console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Schema is up to date');
    if (process.argv.includes('--seed')) {
      await seed(db, { mockCasinoUrl: process.env.MOCK_CASINO_URL ?? 'http://localhost:4100' });
      console.log('Seed data is in place');
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
