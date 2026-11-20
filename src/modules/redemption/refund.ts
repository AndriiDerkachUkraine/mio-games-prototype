import type { Tx } from '../../db/db.provider';
import type { LedgerService } from '../ledger/ledger.service';

/**
 * Gives the coins of a redemption back. The idempotency key is per redemption, so whoever refunds (worker or
 * operator), the ledger accepts at most one refund for it.
 */
export function refundRedemption(
  ledger: LedgerService,
  tx: Tx,
  r: { id: string; tenantId: string; playerId: string; priceCoins: number },
): Promise<number> {
  return ledger.post(tx, {
    tenantId: r.tenantId,
    playerId: r.playerId,
    amount: r.priceCoins,
    kind: 'REDEMPTION_REFUND',
    referenceId: r.id,
    idempotencyKey: `redemption:${r.id}:refund`,
  });
}
