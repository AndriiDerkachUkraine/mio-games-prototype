import { RewardDescriptorSchema, type RewardDescriptor } from '../store/reward-descriptor';
import type { RedemptionRow } from './redemptions.repository';

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

export const toRedemptionView = (r: RedemptionRow): RedemptionView => ({
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
