import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DB, type Db, type Tx } from '../../db/db.provider';
import type { SpinGrant } from '../rules/rules.engine';
import { RewardSegmentsSchema, type RewardSegment } from './reward-segments';

interface SpinOwner {
  tenantId: string;
  playerId: string;
}

/** What a player may see of a segment: weights stay server-side. */
export type SegmentView = Pick<RewardSegment, 'key' | 'label' | 'coins'>;

export interface PlayedSpin {
  segment: SegmentView;
  rewardTableVersion: number;
  playedAt: Date;
}

@Injectable()
export class SpinsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** A spin always traces back to a verified event (`source_event_id` is mandatory). */
  async grant(tx: Tx, owner: SpinOwner & { sourceEventId: string }, grants: SpinGrant[]): Promise<number> {
    const rows = grants.flatMap((g) =>
      Array.from({ length: g.spins }, () => ({
        tenant_id: owner.tenantId,
        player_id: owner.playerId,
        source_event_id: owner.sourceEventId,
        rule_id: g.ruleId,
      })),
    );
    if (rows.length === 0) return 0;
    await tx.insertInto('spins').values(rows).execute();
    return rows.length;
  }

  listAvailable(owner: SpinOwner): Promise<{ id: string; granted_at: Date }[]> {
    return this.db
      .selectFrom('spins')
      .select(['id', 'granted_at'])
      .where('tenant_id', '=', owner.tenantId)
      .where('player_id', '=', owner.playerId)
      .where('status', '=', 'AVAILABLE')
      .orderBy('granted_at')
      .execute();
  }

  /**
   * The only way a spin is consumed: a conditional update. Concurrent callers block on the row lock and
   * re-check `status`, so exactly one of them gets the row back. Returns the play time, or undefined.
   */
  async claim(
    tx: Tx,
    owner: SpinOwner,
    spinId: string,
    outcome: { rewardTableId: string; segment: RewardSegment },
  ): Promise<Date | undefined> {
    const row = await tx
      .updateTable('spins')
      .set({
        status: 'USED',
        used_at: sql`now()`,
        reward_table_id: outcome.rewardTableId,
        result_segment_key: outcome.segment.key,
        result_coins: outcome.segment.coins,
      })
      .where('id', '=', spinId)
      .where('tenant_id', '=', owner.tenantId)
      .where('player_id', '=', owner.playerId)
      .where('status', '=', 'AVAILABLE')
      .returning('used_at')
      .executeTakeFirst();
    return row?.used_at ?? undefined;
  }

  async findPlayed(owner: SpinOwner, spinId: string): Promise<PlayedSpin | undefined> {
    const row = await this.db
      .selectFrom('spins')
      .innerJoin('reward_tables', 'reward_tables.id', 'spins.reward_table_id')
      .select([
        'spins.result_segment_key',
        'spins.result_coins',
        'spins.used_at',
        'reward_tables.version',
        'reward_tables.segments',
      ])
      .where('spins.id', '=', spinId)
      .where('spins.tenant_id', '=', owner.tenantId)
      .where('spins.player_id', '=', owner.playerId)
      .where('spins.status', '=', 'USED')
      .executeTakeFirst();
    if (!row?.used_at || row.result_segment_key === null || row.result_coins === null) return undefined;
    const key = row.result_segment_key;
    const label = RewardSegmentsSchema.parse(row.segments).find((s) => s.key === key)?.label ?? key;
    // Coins come from the spin itself: that is the amount the ledger was credited with.
    return { segment: { key, label, coins: row.result_coins }, rewardTableVersion: row.version, playedAt: row.used_at };
  }
}
