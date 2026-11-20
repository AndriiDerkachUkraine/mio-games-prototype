import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DomainError } from '../../common/domain-error';
import { DB, type Db, type Tx } from '../../db/db.provider';
import type { LedgerEntryKind } from '../../db/schema';

export interface Posting {
  tenantId: string;
  playerId: string;
  /** Positive = credit, negative = debit. */
  amount: number;
  kind: LedgerEntryKind;
  referenceId: string;
  /** One financial effect per business operation, enforced by a unique key. */
  idempotencyKey: string;
}

export interface LedgerEntryView {
  kind: LedgerEntryKind;
  amount: number;
  balanceAfter: number;
  referenceId: string;
  createdAt: Date;
}

@Injectable()
export class LedgerService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Runs inside the caller's transaction. The conditional update locks the wallet row, so concurrent
   * postings for one player serialize and a debit can never take the balance below zero.
   */
  async post(tx: Tx, posting: Posting): Promise<number> {
    if (!Number.isSafeInteger(posting.amount) || posting.amount === 0) {
      throw new Error(`Invalid ledger amount: ${posting.amount}`);
    }
    const wallet = await tx
      .updateTable('wallets')
      .set((eb) => ({ balance: eb('balance', '+', posting.amount), updated_at: sql`now()` }))
      .where('tenant_id', '=', posting.tenantId)
      .where('player_id', '=', posting.playerId)
      .$if(posting.amount < 0, (qb) => qb.where('balance', '>=', -posting.amount))
      .returning('balance')
      .executeTakeFirst();
    if (!wallet) {
      if (posting.amount > 0) throw new Error(`Wallet not found for player ${posting.playerId}`);
      throw new DomainError(HttpStatus.CONFLICT, 'INSUFFICIENT_BALANCE', 'not enough coins');
    }

    await tx
      .insertInto('ledger_entries')
      .values({
        tenant_id: posting.tenantId,
        player_id: posting.playerId,
        amount: posting.amount,
        balance_after: wallet.balance,
        kind: posting.kind,
        reference_id: posting.referenceId,
        idempotency_key: posting.idempotencyKey,
      })
      .execute();
    return wallet.balance;
  }

  async wallet(tenantId: string, playerId: string): Promise<{ balance: number; entries: LedgerEntryView[] }> {
    const { balance } = await this.db
      .selectFrom('wallets')
      .select('balance')
      .where('tenant_id', '=', tenantId)
      .where('player_id', '=', playerId)
      .executeTakeFirstOrThrow();
    const entries = await this.db
      .selectFrom('ledger_entries')
      .select(['kind', 'amount', 'balance_after', 'reference_id', 'created_at'])
      .where('tenant_id', '=', tenantId)
      .where('player_id', '=', playerId)
      .orderBy('created_at', 'desc')
      .limit(50)
      .execute();
    return {
      balance,
      entries: entries.map((e) => ({
        kind: e.kind,
        amount: e.amount,
        balanceAfter: e.balance_after,
        referenceId: e.reference_id,
        createdAt: e.created_at,
      })),
    };
  }
}
