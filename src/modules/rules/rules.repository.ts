import { Inject, Injectable } from '@nestjs/common';
import type { Selectable } from 'kysely';
import { DB, type Db } from '../../db/db.provider';
import type { GamificationRulesTable } from '../../db/schema';

export interface Rule {
  ruleId: string;
  trigger: 'DEPOSIT_SUCCEEDED';
  currency: string | null;
  minAmountMinor: number;
  spinsGranted: number;
  active: boolean;
}

export type RuleChanges = Partial<Pick<Rule, 'currency' | 'minAmountMinor' | 'spinsGranted' | 'active'>>;

const COLUMNS = ['id', 'trigger', 'currency', 'min_amount_minor', 'spins_granted', 'active'] as const;

/** Rule configuration; evaluation lives in RulesEngine. */
@Injectable()
export class RulesRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(tenantId: string): Promise<Rule[]> {
    const rows = await this.db
      .selectFrom('gamification_rules')
      .select(COLUMNS)
      .where('tenant_id', '=', tenantId)
      .orderBy('created_at')
      .execute();
    return rows.map(toRule);
  }

  async update(tenantId: string, ruleId: string, changes: RuleChanges): Promise<Rule | undefined> {
    const row = await this.db
      .updateTable('gamification_rules')
      .set({
        ...(changes.currency !== undefined ? { currency: changes.currency } : {}),
        ...(changes.minAmountMinor !== undefined ? { min_amount_minor: changes.minAmountMinor } : {}),
        ...(changes.spinsGranted !== undefined ? { spins_granted: changes.spinsGranted } : {}),
        ...(changes.active !== undefined ? { active: changes.active } : {}),
      })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', ruleId)
      .returning(COLUMNS)
      .executeTakeFirst();
    return row && toRule(row);
  }
}

type Row = Pick<Selectable<GamificationRulesTable>, (typeof COLUMNS)[number]>;

const toRule = (r: Row): Rule => ({
  ruleId: r.id,
  trigger: r.trigger,
  currency: r.currency,
  minAmountMinor: r.min_amount_minor,
  spinsGranted: r.spins_granted,
  active: r.active,
});
