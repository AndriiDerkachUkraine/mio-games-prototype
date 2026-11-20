import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Selectable } from 'kysely';
import { DomainError } from '../../common/domain-error';
import { DB, type Db } from '../../db/db.provider';
import type { StoreItemsTable } from '../../db/schema';
import { RewardDescriptorSchema, type RewardDescriptor } from './reward-descriptor';

export interface StoreItem {
  itemId: string;
  sku: string;
  name: string;
  priceCoins: number;
  reward: RewardDescriptor;
}

export type NewStoreItem = Omit<StoreItem, 'itemId'>;
export type ManagedStoreItem = StoreItem & { active: boolean };

const COLUMNS = ['id', 'sku', 'name', 'price_coins', 'reward', 'active'] as const;

@Injectable()
export class StoreItemsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async listActive(tenantId: string): Promise<StoreItem[]> {
    const rows = await this.query(tenantId).where('active', '=', true).orderBy('price_coins').execute();
    return rows.map(toItem);
  }

  async findActive(tenantId: string, itemId: string): Promise<StoreItem | undefined> {
    const row = await this.query(tenantId).where('active', '=', true).where('id', '=', itemId).executeTakeFirst();
    return row && toItem(row);
  }

  async listAll(tenantId: string): Promise<ManagedStoreItem[]> {
    const rows = await this.query(tenantId).orderBy('price_coins').execute();
    return rows.map(toManagedItem);
  }

  async create(tenantId: string, item: NewStoreItem): Promise<ManagedStoreItem> {
    const row = await insertStoreItem(this.db, tenantId, item);
    if (!row) throw new DomainError(HttpStatus.CONFLICT, 'SKU_TAKEN', `sku "${item.sku}" already exists`);
    return toManagedItem(row);
  }

  /** Deactivation hides an item from the store; redemptions already made keep their own snapshot. */
  async setActive(tenantId: string, itemId: string, active: boolean): Promise<ManagedStoreItem | undefined> {
    const row = await this.db
      .updateTable('store_items')
      .set({ active })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', itemId)
      .returning(COLUMNS)
      .executeTakeFirst();
    return row && toManagedItem(row);
  }

  private query(tenantId: string) {
    return this.db.selectFrom('store_items').select(COLUMNS).where('tenant_id', '=', tenantId);
  }
}

type Row = Pick<Selectable<StoreItemsTable>, (typeof COLUMNS)[number]>;

/** Inserts unless the tenant already has this sku (then undefined). Also used by the seed, inside its transaction. */
export function insertStoreItem(db: Db, tenantId: string, item: NewStoreItem): Promise<Row | undefined> {
  return db
    .insertInto('store_items')
    .values({
      tenant_id: tenantId,
      sku: item.sku,
      name: item.name,
      price_coins: item.priceCoins,
      reward: JSON.stringify(item.reward),
    })
    .onConflict((oc) => oc.columns(['tenant_id', 'sku']).doNothing())
    .returning(COLUMNS)
    .executeTakeFirst();
}

const toItem = (row: Row): StoreItem => ({
  itemId: row.id,
  sku: row.sku,
  name: row.name,
  priceCoins: row.price_coins,
  reward: RewardDescriptorSchema.parse(row.reward),
});

const toManagedItem = (row: Row): ManagedStoreItem => ({ ...toItem(row), active: row.active });
