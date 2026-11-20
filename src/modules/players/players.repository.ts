import { Injectable } from '@nestjs/common';
import type { Tx } from '../../db/db.provider';

@Injectable()
export class PlayersRepository {
  /** (tenant, casino player id) → internal id; player and wallet are created together on first contact. */
  async resolve(tx: Tx, tenantId: string, externalPlayerId: string): Promise<string> {
    // Plain read first: resolving an existing player must not lock its row. An upsert (ON CONFLICT DO UPDATE)
    // would, and that lock deadlocks against the FK check of a concurrent ledger insert.
    const existing = await this.find(tx, tenantId, externalPlayerId);
    if (existing) return existing;

    const created = await tx
      .insertInto('players')
      .values({ tenant_id: tenantId, external_player_id: externalPlayerId })
      .onConflict((oc) => oc.columns(['tenant_id', 'external_player_id']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!created) {
      // A concurrent first contact won the insert (and created the wallet); its row is committed by now.
      const winner = await this.find(tx, tenantId, externalPlayerId);
      if (!winner) throw new Error(`Player ${tenantId}/${externalPlayerId} vanished after a conflicting insert`);
      return winner;
    }
    await tx.insertInto('wallets').values({ tenant_id: tenantId, player_id: created.id }).execute();
    return created.id;
  }

  private async find(tx: Tx, tenantId: string, externalPlayerId: string): Promise<string | undefined> {
    const row = await tx
      .selectFrom('players')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('external_player_id', '=', externalPlayerId)
      .executeTakeFirst();
    return row?.id;
  }
}
