-- Postgres schema — espelho para dual-write gradual.
-- Aplicar: HANORK_PG_URL set + npm run pg:schema
-- SQLite continua fonte de verdade ate HANORK_DB_DRIVER=pg (com fallback SQLite).

CREATE TABLE IF NOT EXISTS billing_order (
  id TEXT PRIMARY KEY,
  customer_id TEXT,
  plan_id TEXT,
  amount_cents INTEGER,
  method TEXT,
  status TEXT,
  mp_preference_id TEXT,
  mp_payment_id TEXT,
  session_owner TEXT,
  chat_jid TEXT,
  platform TEXT,
  poll_count INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS billing_payment (
  id TEXT PRIMARY KEY,
  order_id TEXT,
  mp_payment_id TEXT UNIQUE,
  status TEXT,
  amount_cents INTEGER,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS billing_entitlement (
  customer_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  plan_id TEXT,
  status TEXT,
  starts_at TEXT,
  ends_at TEXT,
  meta TEXT,
  updated_at TEXT,
  PRIMARY KEY (customer_id, kind)
);

CREATE TABLE IF NOT EXISTS kv_store (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE TABLE IF NOT EXISTS group_flags (
  telegram_user_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  flag TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (telegram_user_id, group_id, flag)
);

CREATE INDEX IF NOT EXISTS idx_billing_order_customer ON billing_order (customer_id);
CREATE INDEX IF NOT EXISTS idx_billing_payment_mp ON billing_payment (mp_payment_id);
CREATE INDEX IF NOT EXISTS idx_kv_store_scope ON kv_store (scope);
CREATE INDEX IF NOT EXISTS idx_group_flags_user ON group_flags (telegram_user_id);
