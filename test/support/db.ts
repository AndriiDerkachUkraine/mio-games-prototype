import type { Db } from '../../src/db/db.provider';
import type { Database } from '../../src/db/schema';

export async function countRows(db: Db, table: keyof Database): Promise<number> {
  const { n } = await db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirstOrThrow();
  return n;
}
