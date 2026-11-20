import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { DomainError } from '../../common/domain-error';
import { Uuid } from '../../common/schemas';
import { DB, type Db } from '../../db/db.provider';
import type { RedemptionStatus } from '../../db/schema';
import { LedgerService } from '../ledger/ledger.service';
import { RewardDescriptorSchema } from '../store/reward-descriptor';
import { RedemptionsRepository } from './redemptions.repository';
import { refundRedemption } from './refund';

export type ReviewDecision =
  /** The operator confirmed with the casino that the reward was delivered. */
  | { outcome: 'ISSUED'; externalReference: string; note: string }
  /** The operator confirmed it was not delivered: the coins go back. */
  | { outcome: 'REFUNDED'; note: string };

const notFound = () => new DomainError(HttpStatus.NOT_FOUND, 'REDEMPTION_NOT_FOUND', 'redemption not found');

/** The exit from MANUAL_REVIEW: a person decides, and the decision is recorded in the redemption's history. */
@Injectable()
export class ManualReviewService {
  constructor(
    @InjectPinoLogger(ManualReviewService.name) private readonly logger: PinoLogger,
    @Inject(DB) private readonly db: Db,
    private readonly redemptions: RedemptionsRepository,
    private readonly ledger: LedgerService,
  ) {}

  async list(tenantId: string, status: RedemptionStatus) {
    const rows = await this.redemptions.listForTenant(tenantId, status);
    return rows.map((r) => ({
      redemptionId: r.id,
      externalPlayerId: r.external_player_id,
      status: r.status,
      priceCoins: r.price_coins,
      reward: RewardDescriptorSchema.parse(r.reward),
      failureReason: r.failure_reason,
      attempts: r.attempts,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async resolve(
    tenantId: string,
    redemptionId: string,
    decision: ReviewDecision,
  ): Promise<{ status: RedemptionStatus }> {
    if (!Uuid.safeParse(redemptionId).success) throw notFound();
    const status = await this.db.transaction().execute(async (tx) => {
      const closed = await this.redemptions.closeReview(
        tx,
        tenantId,
        redemptionId,
        decision.outcome === 'ISSUED'
          ? { status: 'ISSUED', externalReference: decision.externalReference }
          : { status: 'FAILED', failureReason: `refunded after manual review: ${decision.note}` },
      );
      if (!closed) return undefined;
      if (closed.status === 'FAILED') {
        await refundRedemption(this.ledger, tx, {
          id: closed.id,
          tenantId,
          playerId: closed.player_id,
          priceCoins: closed.price_coins,
        });
      }
      await this.redemptions.addEvent(tx, {
        redemptionId,
        tenantId,
        from: 'MANUAL_REVIEW',
        to: closed.status,
        detail: `manual review: ${decision.note}`,
      });
      return closed.status;
    });

    if (!status) {
      const exists = await this.redemptions.existsForTenant(tenantId, redemptionId);
      if (!exists) throw notFound();
      throw new DomainError(HttpStatus.CONFLICT, 'NOT_IN_REVIEW', 'redemption is not awaiting manual review');
    }
    this.logger.info({ tenantId, redemptionId, status, note: decision.note }, 'manual review resolved');
    return { status };
  }
}
