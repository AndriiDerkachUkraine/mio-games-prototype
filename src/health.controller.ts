import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'kysely';
import { DB, type Db } from './db/db.provider';

@Controller('health')
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async check(): Promise<{ status: 'ok' }> {
    try {
      await sql`SELECT 1`.execute(this.db);
    } catch {
      throw new ServiceUnavailableException({ status: 'error', reason: 'database unreachable' });
    }
    return { status: 'ok' };
  }
}
