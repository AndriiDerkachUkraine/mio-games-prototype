import { Kysely, PostgresDialect } from 'kysely';
import { Pool, types } from 'pg';
import type { Database } from './schema';

// int8 → number. Coin amounts and counters stay far below 2^53.
types.setTypeParser(types.builtins.INT8, (value) => Number(value));

export const DB = Symbol('DB');
export type Db = Kysely<Database>;

export function createDb(connectionString: string, maxConnections = 10): Db {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: maxConnections }) }),
  });
}
