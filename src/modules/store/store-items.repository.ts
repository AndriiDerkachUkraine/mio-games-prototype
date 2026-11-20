import { Inject, Injectable } from '@nestjs/common';
import { DB, type Db } from '../../db/db.provider';
import { RewardDescriptorSchema, type RewardDescriptor } from './reward-descriptor';

export interface StoreItem {
  itemId: string;
  sku: string;
  name: string;
  priceCoins: number;
  reward: RewardDescriptor;
}

@Injectable()
export class StoreItemsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async listActive(tenantId: string): Promise<StoreItem[]> {
    const rows = await this.baseQuery(tenantId).orderBy('price_coins').execute();
    return rows.map(toItem);
  }

  async findActive(tenantId: string, itemId: string): Promise<StoreItem | undefined> {
    const row = await this.baseQuery(tenantId).where('id', '=', itemId).executeTakeFirst();
    return row && toItem(row);
  }

  private baseQuery(tenantId: string) {
    return this.db
      .selectFrom('store_items')
      .select(['id', 'sku', 'name', 'price_coins', 'reward'])
      .where('tenant_id', '=', tenantId)
      .where('active', '=', true);
  }
}

const toItem = (row: { id: string; sku: string; name: string; price_coins: number; reward: unknown }): StoreItem => ({
  itemId: row.id,
  sku: row.sku,
  name: row.name,
  priceCoins: row.price_coins,
  reward: RewardDescriptorSchema.parse(row.reward),
});
