import { createHash } from 'node:crypto';
import type { RewardDescriptor } from '../modules/store/reward-descriptor';
import type { RewardSegment } from '../modules/wheel/reward-segments';
import type { Db } from './db.provider';

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Dev-only credentials of the two simulated operators, public on purpose. */
export const DEV_TENANTS = {
  'casino-a': {
    name: 'Casino A (Platform A integration)',
    platform: 'platform-a',
    currency: 'EUR',
    webhookSecret: 'dev-casino-a-webhook-secret',
    playerTokenSecret: 'dev-casino-a-player-token-secret',
    adminApiKey: 'dev-casino-a-admin-key',
    rewardApiKey: 'dev-casino-a-reward-api-key',
  },
  'casino-b': {
    name: 'Casino B (Platform B integration)',
    platform: 'platform-b',
    currency: 'USD',
    webhookSecret: 'dev-casino-b-webhook-secret',
    playerTokenSecret: 'dev-casino-b-player-token-secret',
    adminApiKey: 'dev-casino-b-admin-key',
    rewardApiKey: 'dev-casino-b-reward-api-key',
  },
} as const;

export type DevTenantId = keyof typeof DEV_TENANTS;

export const DEFAULT_SEGMENTS: RewardSegment[] = [
  { key: 'coins-10', label: '10 coins', coins: 10, weight: 50 },
  { key: 'coins-25', label: '25 coins', coins: 25, weight: 30 },
  { key: 'coins-50', label: '50 coins', coins: 50, weight: 15 },
  { key: 'coins-200', label: '200 coins (jackpot)', coins: 200, weight: 5 },
];

interface SeedStoreItem {
  sku: string;
  name: string;
  priceCoins: number;
  reward: RewardDescriptor;
}

const STORE_ITEMS: Record<DevTenantId, SeedStoreItem[]> = {
  'casino-a': [
    {
      sku: 'free-spins-10',
      name: '10 free spins on Book of MIO',
      priceCoins: 20,
      reward: { type: 'FREE_SPINS', quantity: 10, game: 'book-of-mio' },
    },
    {
      sku: 'bonus-5-eur',
      name: 'EUR 5 bonus money',
      priceCoins: 100,
      reward: { type: 'BONUS_MONEY', amountMinor: 500, currency: 'EUR' },
    },
  ],
  'casino-b': [
    {
      sku: 'cash-bonus-5-usd',
      name: 'USD 5 cash bonus',
      priceCoins: 20,
      reward: { type: 'BONUS_MONEY', amountMinor: 500, currency: 'USD' },
    },
    {
      sku: 'free-spins-20',
      name: '20 free spins on Mega Wheel',
      priceCoins: 100,
      reward: { type: 'FREE_SPINS', quantity: 20, game: 'mega-wheel' },
    },
  ],
};

/** Idempotent: safe to run on every container start. */
export async function seed(db: Db, opts: { mockCasinoUrl: string; rewardApiTimeoutMs?: number }): Promise<void> {
  const timeoutMs = opts.rewardApiTimeoutMs ?? 2000;
  await db.transaction().execute(async (tx) => {
    for (const tenantId of Object.keys(DEV_TENANTS) as DevTenantId[]) {
      const t = DEV_TENANTS[tenantId];
      // The endpoint differs between compose and host runs, so it is refreshed on every seed.
      const endpoint = { reward_api_base_url: `${opts.mockCasinoUrl}/${t.platform}`, reward_api_timeout_ms: timeoutMs };
      await tx
        .insertInto('tenants')
        .values({
          id: tenantId,
          name: t.name,
          platform: t.platform,
          webhook_secret: t.webhookSecret,
          player_token_secret: t.playerTokenSecret,
          admin_api_key_hash: sha256Hex(t.adminApiKey),
          reward_api_key: t.rewardApiKey,
          ...endpoint,
        })
        .onConflict((oc) => oc.column('id').doUpdateSet(endpoint))
        .execute();

      const hasRule = await tx
        .selectFrom('gamification_rules')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst();
      if (!hasRule) {
        // 1 spin per successful deposit of at least 10.00 in the operator's currency.
        await tx
          .insertInto('gamification_rules')
          .values({
            tenant_id: tenantId,
            trigger: 'DEPOSIT_SUCCEEDED',
            currency: t.currency,
            min_amount_minor: 1000,
            spins_granted: 1,
          })
          .execute();
      }

      const hasTable = await tx
        .selectFrom('reward_tables')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst();
      if (!hasTable) {
        await tx
          .insertInto('reward_tables')
          .values({
            tenant_id: tenantId,
            version: 1,
            segments: JSON.stringify(DEFAULT_SEGMENTS),
            active: true,
            created_by: 'seed',
          })
          .execute();
      }

      for (const item of STORE_ITEMS[tenantId]) {
        await tx
          .insertInto('store_items')
          .values({
            tenant_id: tenantId,
            sku: item.sku,
            name: item.name,
            price_coins: item.priceCoins,
            reward: JSON.stringify(item.reward),
          })
          .onConflict((oc) => oc.columns(['tenant_id', 'sku']).doNothing())
          .execute();
      }
    }
  });
}
