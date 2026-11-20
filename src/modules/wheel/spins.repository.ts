import { Injectable } from '@nestjs/common';
import type { Tx } from '../../db/db.provider';
import type { SpinGrant } from '../rules/rules.engine';

@Injectable()
export class SpinsRepository {
  /** A spin always traces back to a verified event (`source_event_id` is mandatory). */
  async grant(
    tx: Tx,
    owner: { tenantId: string; playerId: string; sourceEventId: string },
    grants: SpinGrant[],
  ): Promise<number> {
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
}
