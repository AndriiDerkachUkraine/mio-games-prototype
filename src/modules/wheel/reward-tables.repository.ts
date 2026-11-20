import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DomainError } from '../../common/domain-error';
import { DB, type Db } from '../../db/db.provider';
import { RewardSegmentsSchema, type RewardSegment } from './reward-segments';

export interface RewardTable {
  id: string;
  version: number;
  segments: RewardSegment[];
}

export type RewardTableVersion = RewardTable & { active: boolean; createdBy: string; createdAt: Date };

@Injectable()
export class RewardTablesRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async getActive(tenantId: string): Promise<RewardTable> {
    const row = await this.db
      .selectFrom('reward_tables')
      .select(['id', 'version', 'segments'])
      .where('tenant_id', '=', tenantId)
      .where('active', '=', true)
      .executeTakeFirst();
    if (!row) throw new DomainError(HttpStatus.CONFLICT, 'WHEEL_NOT_CONFIGURED', 'no active reward table');
    return { id: row.id, version: row.version, segments: RewardSegmentsSchema.parse(row.segments) };
  }

  async list(tenantId: string): Promise<RewardTableVersion[]> {
    const rows = await this.db
      .selectFrom('reward_tables')
      .select(['id', 'version', 'segments', 'active', 'created_by', 'created_at'])
      .where('tenant_id', '=', tenantId)
      .orderBy('version', 'desc')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      version: r.version,
      segments: RewardSegmentsSchema.parse(r.segments),
      active: r.active,
      createdBy: r.created_by,
      createdAt: r.created_at,
    }));
  }

  /**
   * Publishes a new immutable version and makes it the only active one. Earlier versions stay untouched, so every
   * played spin can still be audited against the exact table it was drawn from.
   */
  publish(tenantId: string, segments: RewardSegment[], createdBy: string): Promise<{ version: number }> {
    return this.db.transaction().execute(async (tx) => {
      // Per-tenant lock: concurrent publishes get consecutive versions instead of a unique-key failure.
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`reward-tables:${tenantId}`}))`.execute(tx);
      const { latest } = await tx
        .selectFrom('reward_tables')
        .select((eb) => eb.fn.max('version').as('latest'))
        .where('tenant_id', '=', tenantId)
        .executeTakeFirstOrThrow();
      await tx
        .updateTable('reward_tables')
        .set({ active: false })
        .where('tenant_id', '=', tenantId)
        .where('active', '=', true)
        .execute();
      return tx
        .insertInto('reward_tables')
        .values({
          tenant_id: tenantId,
          version: (latest ?? 0) + 1,
          segments: JSON.stringify(segments),
          active: true,
          created_by: createdBy,
        })
        .returning('version')
        .executeTakeFirstOrThrow();
    });
  }
}
