import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { DomainError } from '../../common/domain-error';
import { DB, type Db } from '../../db/db.provider';
import { RewardSegmentsSchema, type RewardSegment } from './reward-segments';

export interface RewardTable {
  id: string;
  version: number;
  segments: RewardSegment[];
}

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
}
