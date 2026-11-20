import { Injectable } from '@nestjs/common';
import type { Tx } from '../../db/db.provider';

@Injectable()
export class PlayersRepository {
  /** (tenant, casino player id) → internal id; player and wallet are created on first contact. */
  async resolve(tx: Tx, tenantId: string, externalPlayerId: string): Promise<string> {
    const { id } = await tx
      .insertInto('players')
      .values({ tenant_id: tenantId, external_player_id: externalPlayerId })
      // No-op update instead of DO NOTHING, so RETURNING also yields existing rows.
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'external_player_id']).doUpdateSet({ external_player_id: externalPlayerId }),
      )
      .returning('id')
      .executeTakeFirstOrThrow();
    await tx
      .insertInto('wallets')
      .values({ tenant_id: tenantId, player_id: id })
      .onConflict((oc) => oc.column('player_id').doNothing())
      .execute();
    return id;
  }
}
