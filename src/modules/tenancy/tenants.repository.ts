import { Inject, Injectable } from '@nestjs/common';
import { DB, type Db } from '../../db/db.provider';
import type { Tenant } from '../../db/schema';

@Injectable()
export class TenantsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Suspended tenants are treated exactly like unknown ones. */
  findActive(id: string): Promise<Tenant | undefined> {
    return this.db
      .selectFrom('tenants')
      .selectAll()
      .where('id', '=', id)
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
  }

  findActiveByAdminKeyHash(hash: string): Promise<Tenant | undefined> {
    return this.db
      .selectFrom('tenants')
      .selectAll()
      .where('admin_api_key_hash', '=', hash)
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
  }

  /** Any status: rewards already paid for in coins are still delivered after a suspension. */
  get(id: string): Promise<Tenant> {
    return this.db.selectFrom('tenants').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  }
}
