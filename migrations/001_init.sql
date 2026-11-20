-- MIO Games prototype schema.
-- Financial invariants are enforced by the database itself (UNIQUE / CHECK / FK / triggers),
-- so that a bug in application code cannot produce duplicate rewards or negative balances.
--
-- Tenant isolation at the schema level: every tenant-owned table exposes UNIQUE (tenant_id, id),
-- and every reference between tenant-owned rows is a composite FK (tenant_id, <ref>_id).
-- A row can therefore never point to a row of another tenant, whatever the application does.

-- ─── Tenancy ────────────────────────────────────────────────────────────────
CREATE TABLE tenants (
  id                    text PRIMARY KEY,               -- slug, e.g. 'casino-a'
  name                  text        NOT NULL,
  platform              text        NOT NULL,           -- integration adapter key, e.g. 'platform-a'
  webhook_secret        text        NOT NULL,           -- HMAC key for inbound events (prod: envelope-encrypted via KMS)
  player_token_secret   text        NOT NULL,           -- HS256 key the casino uses to sign player session tokens
  admin_api_key_hash    text        NOT NULL UNIQUE,    -- sha256(hex) of the tenant admin API key; plaintext is never stored
  reward_api_base_url   text        NOT NULL,
  reward_api_key        text        NOT NULL,
  reward_api_timeout_ms integer     NOT NULL DEFAULT 2000 CHECK (reward_api_timeout_ms > 0),
  status                text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- ─── Player identity mapping ────────────────────────────────────────────────
CREATE TABLE players (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          text        NOT NULL REFERENCES tenants (id),
  external_player_id text        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_player_id),
  UNIQUE (tenant_id, id)
);

-- ─── Event ingestion (inbox + dedup) ────────────────────────────────────────
CREATE TABLE inbound_events (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         text        NOT NULL REFERENCES tenants (id),
  external_event_id text        NOT NULL,
  event_type        text        NOT NULL,               -- normalized type, e.g. 'DEPOSIT'
  status            text        NOT NULL CHECK (status IN ('PROCESSED', 'IGNORED')),
  ignore_reason     text,
  player_id         uuid,
  payload           jsonb       NOT NULL,               -- raw casino payload, kept for audit / replay
  received_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_event_id),                -- the deduplication guarantee
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, player_id) REFERENCES players (tenant_id, id)
);

-- ─── Gamification rules ─────────────────────────────────────────────────────
CREATE TABLE gamification_rules (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        text        NOT NULL REFERENCES tenants (id),
  trigger          text        NOT NULL CHECK (trigger IN ('DEPOSIT_SUCCEEDED')),
  currency         text,                                -- NULL = any currency
  min_amount_minor bigint      NOT NULL DEFAULT 0 CHECK (min_amount_minor >= 0),
  spins_granted    integer     NOT NULL CHECK (spins_granted > 0),
  active           boolean     NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX gamification_rules_lookup ON gamification_rules (tenant_id, trigger) WHERE active;

-- ─── Wheel of Fortune ───────────────────────────────────────────────────────
CREATE TABLE reward_tables (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  text        NOT NULL REFERENCES tenants (id),
  version    integer     NOT NULL CHECK (version > 0),
  segments   jsonb       NOT NULL,                      -- [{ key, label, coins, weight }]; immutable once written
  active     boolean     NOT NULL DEFAULT false,
  created_by text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, version),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX reward_tables_one_active ON reward_tables (tenant_id) WHERE active;

CREATE TABLE spins (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          text        NOT NULL,
  player_id          uuid        NOT NULL,
  status             text        NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE', 'USED')),
  source_event_id    uuid        NOT NULL,
  rule_id            uuid        NOT NULL,
  reward_table_id    uuid,
  result_segment_key text,
  result_coins       bigint      CHECK (result_coins > 0),
  granted_at         timestamptz NOT NULL DEFAULT now(),
  used_at            timestamptz,
  FOREIGN KEY (tenant_id, player_id) REFERENCES players (tenant_id, id),
  FOREIGN KEY (tenant_id, source_event_id) REFERENCES inbound_events (tenant_id, id),
  FOREIGN KEY (tenant_id, rule_id) REFERENCES gamification_rules (tenant_id, id),
  FOREIGN KEY (tenant_id, reward_table_id) REFERENCES reward_tables (tenant_id, id),
  -- A spin is either untouched or carries its complete, immutable outcome.
  CHECK (
    (status = 'AVAILABLE' AND used_at IS NULL AND reward_table_id IS NULL
      AND result_segment_key IS NULL AND result_coins IS NULL)
    OR
    (status = 'USED' AND used_at IS NOT NULL AND reward_table_id IS NOT NULL
      AND result_segment_key IS NOT NULL AND result_coins IS NOT NULL)
  )
);
CREATE INDEX spins_by_player ON spins (tenant_id, player_id, status);

-- ─── Virtual currency ledger ────────────────────────────────────────────────
CREATE TABLE wallets (
  player_id  uuid        PRIMARY KEY,
  tenant_id  text        NOT NULL,
  balance    bigint      NOT NULL DEFAULT 0 CHECK (balance >= 0),   -- last line of defence against overspending
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, player_id) REFERENCES players (tenant_id, id)
);

CREATE TABLE ledger_entries (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text        NOT NULL,
  player_id       uuid        NOT NULL,
  amount          bigint      NOT NULL CHECK (amount <> 0),
  balance_after   bigint      NOT NULL CHECK (balance_after >= 0),
  kind            text        NOT NULL CHECK (kind IN ('SPIN_REWARD', 'REDEMPTION_DEBIT', 'REDEMPTION_REFUND')),
  reference_id    uuid        NOT NULL,
  idempotency_key text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),                  -- one financial effect per business operation
  FOREIGN KEY (tenant_id, player_id) REFERENCES players (tenant_id, id)
);
CREATE INDEX ledger_entries_by_player ON ledger_entries (tenant_id, player_id, created_at DESC);

CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only: corrections must be new compensating entries';
END;
$$;
CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

-- ─── Bonus Store & redemption ───────────────────────────────────────────────
CREATE TABLE store_items (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text        NOT NULL REFERENCES tenants (id),
  sku         text        NOT NULL,
  name        text        NOT NULL,
  price_coins bigint      NOT NULL CHECK (price_coins > 0),
  reward      jsonb       NOT NULL,                     -- internal reward descriptor, translated by the casino adapter
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sku),
  UNIQUE (tenant_id, id)
);

CREATE TABLE redemptions (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          text        NOT NULL,
  player_id          uuid        NOT NULL,
  store_item_id      uuid        NOT NULL,
  idempotency_key    text        NOT NULL,
  price_coins        bigint      NOT NULL CHECK (price_coins > 0),
  reward             jsonb       NOT NULL,              -- snapshot at purchase time
  status             text        NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING', 'AWAITING_CONFIRMATION', 'ISSUED', 'FAILED', 'MANUAL_REVIEW')),
  external_reference text,                              -- casino-side id of the issued bonus / order
  failure_reason     text,
  attempts           integer     NOT NULL DEFAULT 0,
  next_attempt_at    timestamptz NOT NULL DEFAULT now(),
  lease_token        uuid,                              -- fencing token of the worker currently holding the job
  lease_expires_at   timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, player_id, idempotency_key),       -- duplicate redemption requests collapse into one
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, player_id) REFERENCES players (tenant_id, id),
  FOREIGN KEY (tenant_id, store_item_id) REFERENCES store_items (tenant_id, id)
);
CREATE INDEX redemptions_due ON redemptions (next_attempt_at) WHERE status IN ('PENDING', 'AWAITING_CONFIRMATION');
CREATE INDEX redemptions_by_player ON redemptions (tenant_id, player_id, created_at DESC);

-- Status history doubles as the audit trail of the delivery process.
CREATE TABLE redemption_events (
  id            bigserial   PRIMARY KEY,
  redemption_id uuid        NOT NULL,
  tenant_id     text        NOT NULL,
  from_status   text,
  to_status     text        NOT NULL,
  detail        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, redemption_id) REFERENCES redemptions (tenant_id, id)
);
CREATE INDEX redemption_events_by_redemption ON redemption_events (redemption_id, id);
