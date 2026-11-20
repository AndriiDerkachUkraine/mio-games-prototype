import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DomainError } from '../../common/domain-error';
import { DB, type Db } from '../../db/db.provider';
import { LedgerService } from '../ledger/ledger.service';
import type { AuthenticatedPlayer } from '../players/player-auth.guard';
import { RewardDescriptorSchema, type RewardDescriptor } from '../store/reward-descriptor';
import { StoreItemsRepository } from '../store/store-items.repository';
import { RedemptionsRepository, type RedemptionRow } from './redemptions.repository';

export interface RedemptionView {
  redemptionId: string;
  itemId: string;
  priceCoins: number;
  reward: RewardDescriptor;
  status: RedemptionRow['status'];
  externalReference: string | null;
  failureReason: string | null;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
}

const IdempotencyKey = z.string().regex(/^[\x21-\x7e]{1,128}$/, 'must be 1-128 printable ASCII characters');
const Uuid = z.uuid();

const itemNotFound = () => new DomainError(HttpStatus.NOT_FOUND, 'ITEM_NOT_FOUND', 'store item not found');
const redemptionNotFound = () => new DomainError(HttpStatus.NOT_FOUND, 'REDEMPTION_NOT_FOUND', 'redemption not found');

@Injectable()
export class RedemptionService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly items: StoreItemsRepository,
    private readonly redemptions: RedemptionsRepository,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * Debits the coins and records the delivery job atomically. A repeated Idempotency-Key returns the original
   * redemption instead of buying again; insufficient coins leave no redemption behind.
   */
  async redeem(
    player: AuthenticatedPlayer,
    itemId: string,
    idempotencyKey: string | undefined,
  ): Promise<{ redemption: RedemptionView; created: boolean }> {
    const key = IdempotencyKey.safeParse(idempotencyKey);
    if (!key.success) {
      throw new DomainError(HttpStatus.BAD_REQUEST, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key header is required');
    }
    if (!Uuid.safeParse(itemId).success) throw itemNotFound();
    const item = await this.items.findActive(player.tenantId, itemId);
    if (!item) throw itemNotFound();

    return this.db.transaction().execute(async (tx) => {
      const created = await this.redemptions.insertPending(tx, {
        ...player,
        storeItemId: item.itemId,
        idempotencyKey: key.data,
        priceCoins: item.priceCoins,
        reward: item.reward,
      });
      if (!created) {
        const existing = await this.redemptions.findByKey(tx, player, key.data);
        if (existing.store_item_id !== item.itemId) {
          throw new DomainError(
            HttpStatus.UNPROCESSABLE_ENTITY,
            'IDEMPOTENCY_KEY_REUSED',
            'this Idempotency-Key was already used for a different item',
          );
        }
        return { redemption: toView(existing), created: false };
      }

      await this.ledger.post(tx, {
        tenantId: player.tenantId,
        playerId: player.playerId,
        amount: -item.priceCoins,
        kind: 'REDEMPTION_DEBIT',
        referenceId: created.id,
        idempotencyKey: `redemption:${created.id}:debit`,
      });
      await this.redemptions.addEvent(tx, {
        redemptionId: created.id,
        tenantId: player.tenantId,
        from: null,
        to: 'PENDING',
        detail: `${item.priceCoins} coins debited`,
      });
      return { redemption: toView(created), created: true };
    });
  }

  async get(player: AuthenticatedPlayer, redemptionId: string) {
    if (!Uuid.safeParse(redemptionId).success) throw redemptionNotFound();
    const row = await this.redemptions.find(player, redemptionId);
    if (!row) throw redemptionNotFound();
    const history = await this.redemptions.history(row.id);
    return {
      ...toView(row),
      history: history.map((h) => ({ from: h.from_status, to: h.to_status, detail: h.detail, at: h.created_at })),
    };
  }

  async list(player: AuthenticatedPlayer): Promise<RedemptionView[]> {
    return (await this.redemptions.list(player)).map(toView);
  }
}

const toView = (r: RedemptionRow): RedemptionView => ({
  redemptionId: r.id,
  itemId: r.store_item_id,
  priceCoins: r.price_coins,
  reward: RewardDescriptorSchema.parse(r.reward),
  status: r.status,
  externalReference: r.external_reference,
  failureReason: r.failure_reason,
  attempts: r.attempts,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
