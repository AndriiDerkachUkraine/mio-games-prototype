import { Injectable } from '@nestjs/common';
import type { Tx } from '../../db/db.provider';

export interface SpinGrant {
  ruleId: string;
  spins: number;
}

/** Rules are per-tenant data, not code, so operators differ by configuration only. */
@Injectable()
export class RulesEngine {
  async evaluateDeposit(
    tx: Tx,
    tenantId: string,
    deposit: { amountMinor: number; currency: string },
  ): Promise<SpinGrant[]> {
    const rules = await tx
      .selectFrom('gamification_rules')
      .select(['id', 'spins_granted'])
      .where('tenant_id', '=', tenantId)
      .where('trigger', '=', 'DEPOSIT_SUCCEEDED')
      .where('active', '=', true)
      .where('min_amount_minor', '<=', deposit.amountMinor)
      .where((eb) => eb.or([eb('currency', 'is', null), eb('currency', '=', deposit.currency)]))
      .orderBy('created_at')
      .execute();
    return rules.map((r) => ({ ruleId: r.id, spins: r.spins_granted }));
  }
}
