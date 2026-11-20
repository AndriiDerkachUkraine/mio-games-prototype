import { Inject, Injectable } from '@nestjs/common';
import { sql, type Selectable } from 'kysely';
import { DB, type Db, type Tx } from '../../db/db.provider';
import type { RedemptionsTable, RedemptionStatus } from '../../db/schema';
import type { RewardDescriptor } from '../store/reward-descriptor';

export type RedemptionRow = Selectable<RedemptionsTable>;
export type DeliveryJob = RedemptionRow & { external_player_id: string };

interface Owner {
  tenantId: string;
  playerId: string;
}

@Injectable()
export class RedemptionsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** undefined = this idempotency key was already used by the player. */
  insertPending(
    tx: Tx,
    r: Owner & { storeItemId: string; idempotencyKey: string; priceCoins: number; reward: RewardDescriptor },
  ): Promise<RedemptionRow | undefined> {
    return tx
      .insertInto('redemptions')
      .values({
        tenant_id: r.tenantId,
        player_id: r.playerId,
        store_item_id: r.storeItemId,
        idempotency_key: r.idempotencyKey,
        price_coins: r.priceCoins,
        reward: JSON.stringify(r.reward),
      })
      .onConflict((oc) => oc.columns(['tenant_id', 'player_id', 'idempotency_key']).doNothing())
      .returningAll()
      .executeTakeFirst();
  }

  findByKey(tx: Tx, owner: Owner, idempotencyKey: string): Promise<RedemptionRow> {
    return this.ownedBy(tx, owner).where('idempotency_key', '=', idempotencyKey).executeTakeFirstOrThrow();
  }

  find(owner: Owner, id: string): Promise<RedemptionRow | undefined> {
    return this.ownedBy(this.db, owner).where('id', '=', id).executeTakeFirst();
  }

  list(owner: Owner): Promise<RedemptionRow[]> {
    return this.ownedBy(this.db, owner).orderBy('created_at', 'desc').limit(50).execute();
  }

  history(id: string) {
    return this.db
      .selectFrom('redemption_events')
      .select(['from_status', 'to_status', 'detail', 'created_at'])
      .where('redemption_id', '=', id)
      .orderBy('id')
      .execute();
  }

  /**
   * Leases up to `limit` due jobs. SKIP LOCKED lets several workers run side by side; an expired lease
   * makes a job claimable again, which is how work of a crashed worker is recovered.
   */
  async claimDue(limit: number, leaseSeconds: number): Promise<DeliveryJob[]> {
    const { rows } = await sql<DeliveryJob>`
      UPDATE redemptions r
         SET lease_token = gen_random_uuid(),
             lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
             attempts = r.attempts + 1,
             updated_at = now()
        FROM players p
       WHERE p.id = r.player_id
         AND r.id IN (
               SELECT id FROM redemptions
                WHERE status IN ('PENDING', 'AWAITING_CONFIRMATION')
                  AND next_attempt_at <= now()
                  AND (lease_expires_at IS NULL OR lease_expires_at < now())
                ORDER BY next_attempt_at
                LIMIT ${limit}
                  FOR UPDATE SKIP LOCKED)
      RETURNING r.*, p.external_player_id`.execute(this.db);
    return rows;
  }

  /**
   * Fenced write: succeeds only while the caller still holds the lease it claimed with. Returns false
   * when the lease expired and another worker took the job over.
   */
  async finishAttempt(
    tx: Tx,
    job: { id: string; leaseToken: string },
    next: { status: RedemptionStatus; externalReference?: string; failureReason?: string; retryInMs?: number },
  ): Promise<boolean> {
    const row = await tx
      .updateTable('redemptions')
      .set({
        status: next.status,
        ...(next.externalReference ? { external_reference: next.externalReference } : {}),
        failure_reason: next.failureReason ?? null,
        next_attempt_at: sql`now() + make_interval(secs => ${(next.retryInMs ?? 0) / 1000})`,
        lease_token: null,
        lease_expires_at: null,
        updated_at: sql`now()`,
      })
      .where('id', '=', job.id)
      .where('lease_token', '=', job.leaseToken)
      .returning('id')
      .executeTakeFirst();
    return row !== undefined;
  }

  async addEvent(
    tx: Tx,
    e: { redemptionId: string; tenantId: string; from: RedemptionStatus | null; to: RedemptionStatus; detail: string },
  ): Promise<void> {
    await tx
      .insertInto('redemption_events')
      .values({
        redemption_id: e.redemptionId,
        tenant_id: e.tenantId,
        from_status: e.from,
        to_status: e.to,
        detail: e.detail,
      })
      .execute();
  }

  private ownedBy(db: Db | Tx, owner: Owner) {
    return db
      .selectFrom('redemptions')
      .selectAll()
      .where('tenant_id', '=', owner.tenantId)
      .where('player_id', '=', owner.playerId);
  }
}
