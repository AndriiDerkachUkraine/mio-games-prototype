import type { ColumnType, Generated, Selectable } from 'kysely';

// Hand-written to mirror migrations/*.sql. bigint columns are parsed to JS numbers
// (see db.provider.ts): coin amounts are far below Number.MAX_SAFE_INTEGER.

/** timestamptz with a DB default: optional on insert, always a Date when read. */
type DefaultedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
/** jsonb: written as a JSON string, read as `unknown` until validated by the owning module's schema. */
type Json = ColumnType<unknown, string, string>;

export type RedemptionStatus = 'PENDING' | 'AWAITING_CONFIRMATION' | 'ISSUED' | 'FAILED' | 'MANUAL_REVIEW';
export type LedgerEntryKind = 'SPIN_REWARD' | 'REDEMPTION_DEBIT' | 'REDEMPTION_REFUND';

export interface TenantsTable {
  id: string;
  name: string;
  platform: string;
  webhook_secret: string;
  player_token_secret: string;
  admin_api_key_hash: string;
  reward_api_base_url: string;
  reward_api_key: string;
  reward_api_timeout_ms: Generated<number>;
  status: Generated<'ACTIVE' | 'SUSPENDED'>;
  created_at: DefaultedTimestamp;
}

export interface PlayersTable {
  id: Generated<string>;
  tenant_id: string;
  external_player_id: string;
  created_at: DefaultedTimestamp;
}

export interface InboundEventsTable {
  id: Generated<string>;
  tenant_id: string;
  external_event_id: string;
  event_type: string;
  status: 'PROCESSED' | 'IGNORED';
  ignore_reason: string | null;
  player_id: string | null;
  payload: Json;
  received_at: DefaultedTimestamp;
}

export interface GamificationRulesTable {
  id: Generated<string>;
  tenant_id: string;
  trigger: 'DEPOSIT_SUCCEEDED';
  currency: string | null;
  min_amount_minor: Generated<number>;
  spins_granted: number;
  active: Generated<boolean>;
  created_at: DefaultedTimestamp;
}

export interface RewardTablesTable {
  id: Generated<string>;
  tenant_id: string;
  version: number;
  segments: Json;
  active: Generated<boolean>;
  created_by: string;
  created_at: DefaultedTimestamp;
}

export interface SpinsTable {
  id: Generated<string>;
  tenant_id: string;
  player_id: string;
  status: Generated<'AVAILABLE' | 'USED'>;
  source_event_id: string;
  rule_id: string;
  reward_table_id: string | null;
  result_segment_key: string | null;
  result_coins: number | null;
  granted_at: DefaultedTimestamp;
  used_at: NullableTimestamp;
}

export interface WalletsTable {
  player_id: string;
  tenant_id: string;
  balance: Generated<number>;
  updated_at: DefaultedTimestamp;
}

export interface LedgerEntriesTable {
  id: Generated<string>;
  tenant_id: string;
  player_id: string;
  amount: number;
  balance_after: number;
  kind: LedgerEntryKind;
  reference_id: string;
  idempotency_key: string;
  created_at: DefaultedTimestamp;
}

export interface StoreItemsTable {
  id: Generated<string>;
  tenant_id: string;
  sku: string;
  name: string;
  price_coins: number;
  reward: Json;
  active: Generated<boolean>;
  created_at: DefaultedTimestamp;
}

export interface RedemptionsTable {
  id: Generated<string>;
  tenant_id: string;
  player_id: string;
  store_item_id: string;
  idempotency_key: string;
  price_coins: number;
  reward: Json;
  status: Generated<RedemptionStatus>;
  external_reference: string | null;
  failure_reason: string | null;
  attempts: Generated<number>;
  next_attempt_at: DefaultedTimestamp;
  lease_token: string | null;
  lease_expires_at: NullableTimestamp;
  created_at: DefaultedTimestamp;
  updated_at: DefaultedTimestamp;
}

export interface RedemptionEventsTable {
  id: Generated<number>;
  redemption_id: string;
  tenant_id: string;
  from_status: string | null;
  to_status: string;
  detail: string | null;
  created_at: DefaultedTimestamp;
}

export interface Database {
  tenants: TenantsTable;
  players: PlayersTable;
  inbound_events: InboundEventsTable;
  gamification_rules: GamificationRulesTable;
  reward_tables: RewardTablesTable;
  spins: SpinsTable;
  wallets: WalletsTable;
  ledger_entries: LedgerEntriesTable;
  store_items: StoreItemsTable;
  redemptions: RedemptionsTable;
  redemption_events: RedemptionEventsTable;
}

export type Tenant = Selectable<TenantsTable>;
