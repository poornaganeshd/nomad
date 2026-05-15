-- NOMAD — Full Database Setup
-- Supabase → SQL Editor → New query → paste all → Run
-- Safe to re-run (all statements are idempotent)

-- ── 1. CORE TABLES ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS expenses (
  id          TEXT    PRIMARY KEY,
  amount      NUMERIC,
  "categoryId" TEXT,
  "walletId"  TEXT,
  note        TEXT,
  date        TEXT,
  "eventId"   TEXT,
  "groupId"   TEXT,
  receipt_url TEXT,
  "paidBy"    TEXT
);

CREATE TABLE IF NOT EXISTS incomes (
  id          TEXT    PRIMARY KEY,
  amount      NUMERIC,
  "sourceId"  TEXT,
  "walletId"  TEXT,
  note        TEXT,
  date        TEXT,
  receipt_url TEXT
);

CREATE TABLE IF NOT EXISTS transfers (
  id           TEXT    PRIMARY KEY,
  amount       NUMERIC,
  "fromWallet" TEXT,
  "toWallet"   TEXT,
  note         TEXT,
  date         TEXT
);

CREATE TABLE IF NOT EXISTS settlements (
  id          TEXT    PRIMARY KEY,
  amount      NUMERIC,
  "splitName" TEXT,
  "splitId"   TEXT,
  direction   TEXT,
  "walletId"  TEXT,
  date        TEXT,
  "groupId"   TEXT,
  "eventId"   TEXT
);

CREATE TABLE IF NOT EXISTS splits (
  id        TEXT    PRIMARY KEY,
  name      TEXT,
  amount    NUMERIC,
  direction TEXT,
  settled   BOOLEAN,
  "eventId" TEXT,
  "groupId" TEXT,
  note      TEXT
);

CREATE TABLE IF NOT EXISTS recurring (
  id                TEXT    PRIMARY KEY,
  name              TEXT,
  amount            NUMERIC,
  "categoryId"      TEXT,
  "categoryName"    TEXT,
  "walletId"        TEXT,
  frequency         TEXT,
  "dayOfMonth"      INTEGER,
  "intervalDays"    INTEGER,
  "yearMonth"       INTEGER,
  "yearDay"         INTEGER,
  "startDate"       TEXT,
  active            BOOLEAN,
  "lastPaidDate"    TEXT,
  "lastSkippedDate" TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id           TEXT    PRIMARY KEY,
  name         TEXT,
  emoji        TEXT,
  date         TEXT,
  status       TEXT,
  type         TEXT    DEFAULT 'solo',
  participants JSONB   DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS wallet_balances (
  wallet_id TEXT    PRIMARY KEY,
  balance   NUMERIC
);

ALTER TABLE expenses        DISABLE ROW LEVEL SECURITY;
ALTER TABLE incomes         DISABLE ROW LEVEL SECURITY;
ALTER TABLE transfers       DISABLE ROW LEVEL SECURITY;
ALTER TABLE settlements     DISABLE ROW LEVEL SECURITY;
ALTER TABLE splits          DISABLE ROW LEVEL SECURITY;
ALTER TABLE recurring       DISABLE ROW LEVEL SECURITY;
ALTER TABLE events          DISABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_balances DISABLE ROW LEVEL SECURITY;

ALTER TABLE expenses        REPLICA IDENTITY DEFAULT;
ALTER TABLE incomes         REPLICA IDENTITY DEFAULT;
ALTER TABLE transfers       REPLICA IDENTITY DEFAULT;
ALTER TABLE settlements     REPLICA IDENTITY DEFAULT;
ALTER TABLE splits          REPLICA IDENTITY DEFAULT;
ALTER TABLE recurring       REPLICA IDENTITY DEFAULT;
ALTER TABLE events          REPLICA IDENTITY DEFAULT;
ALTER TABLE wallet_balances REPLICA IDENTITY DEFAULT;

-- ── 1b. UPDATED_AT COLUMNS + TRIGGER ─────────────────────────
-- Adds updated_at to every core table so future conflict detection
-- (last-write-wins guards, incremental sync) has a server-stamped value
-- to compare against. Idempotent — safe on re-run.

CREATE OR REPLACE FUNCTION nomad_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'expenses','incomes','transfers','settlements','splits',
    'recurring','events','wallet_balances'
  ]) LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I_touch_updated_at ON %I', t, t);
    EXECUTE format($q$
      CREATE TRIGGER %I_touch_updated_at
        BEFORE INSERT OR UPDATE ON %I
        FOR EACH ROW EXECUTE FUNCTION nomad_touch_updated_at()
    $q$, t, t);
  END LOOP;
END $$;

-- ── 1c. SOFT-DELETE COLUMN ──────────────────────────────────
-- Adds deleted_at to core tables so single-item deletes become reversible.
-- Items with deleted_at IS NOT NULL are hidden from normal reads but
-- recoverable within 30 days. Idempotent — safe on re-run.

DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'expenses','incomes','transfers','recurring','events'
  ]) LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL', t);
  END LOOP;
END $$;

-- ── 2. EMAIL REPORT TABLES ───────────────────────────────────

CREATE TABLE IF NOT EXISTS report_schedules (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             TEXT        NOT NULL UNIQUE,
  email               TEXT        NOT NULL,
  frequency           TEXT        NOT NULL CHECK (frequency IN ('weekly','monthly','quarterly','custom')),
  custom_days         INTEGER,
  send_hour           INTEGER     NOT NULL DEFAULT 6 CHECK (send_hour BETWEEN 0 AND 23),
  send_day_of_week    INTEGER     CHECK (send_day_of_week BETWEEN 0 AND 6),
  send_day_of_month   INTEGER     CHECK (send_day_of_month BETWEEN 1 AND 31),
  include_expenses    BOOLEAN     NOT NULL DEFAULT true,
  include_incomes     BOOLEAN     NOT NULL DEFAULT true,
  include_transfers   BOOLEAN     NOT NULL DEFAULT false,
  selected_categories JSONB,
  next_send_at        TIMESTAMPTZ NOT NULL,
  last_sent_at        TIMESTAMPTZ,
  is_active           BOOLEAN     NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS report_delivery_log (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id   UUID        REFERENCES report_schedules(id) ON DELETE CASCADE,
  user_id       TEXT        NOT NULL,
  status        TEXT        NOT NULL CHECK (status IN ('success','failed','retrying')),
  attempted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  period_start  DATE        NOT NULL,
  period_end    DATE        NOT NULL,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_report_schedules_due
  ON report_schedules (next_send_at)
  WHERE is_active = true;

ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS send_day_of_week  INTEGER CHECK (send_day_of_week BETWEEN 0 AND 6);
ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS send_day_of_month INTEGER CHECK (send_day_of_month BETWEEN 1 AND 31);

-- Widen send_day_of_month from 1-28 to 1-31 for existing tables
DO $$ BEGIN
  ALTER TABLE report_schedules DROP CONSTRAINT IF EXISTS report_schedules_send_day_of_month_check;
  ALTER TABLE report_schedules ADD CONSTRAINT report_schedules_send_day_of_month_check CHECK (send_day_of_month BETWEEN 1 AND 31);
END $$;

-- ── MIGRATIONS: add columns to existing tables ────────────────
-- Events feature overhaul (group events, split notes, paidBy)
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS "paidBy"      TEXT;
ALTER TABLE splits   ADD COLUMN IF NOT EXISTS note          TEXT;
ALTER TABLE splits   ADD COLUMN IF NOT EXISTS deleted_at    TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE events   ADD COLUMN IF NOT EXISTS type          TEXT DEFAULT 'solo';
ALTER TABLE events   ADD COLUMN IF NOT EXISTS participants  JSONB DEFAULT '[]';

-- Tags (array of strings) on expenses and incomes
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';
ALTER TABLE incomes  ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';

ALTER TABLE report_schedules    DISABLE ROW LEVEL SECURITY;
ALTER TABLE report_delivery_log DISABLE ROW LEVEL SECURITY;

-- ── 3. USER REGISTRY (owner's Supabase only) ─────────────────

CREATE TABLE IF NOT EXISTS user_registry (
  supabase_url  TEXT        PRIMARY KEY,
  anon_key      TEXT        NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE user_registry DISABLE ROW LEVEL SECURITY;

-- ── 4. ROUTINE TRACKER TABLES ─────────────────────────────────

CREATE TABLE IF NOT EXISTS daily_logs (
  id               TEXT PRIMARY KEY,
  data             JSONB,
  last_modified_at TEXT
);

CREATE TABLE IF NOT EXISTS user_config (
  id               TEXT PRIMARY KEY,
  data             JSONB,
  last_modified_at TEXT
);

ALTER TABLE daily_logs  DISABLE ROW LEVEL SECURITY;
ALTER TABLE user_config DISABLE ROW LEVEL SECURITY;

ALTER TABLE daily_logs  REPLICA IDENTITY DEFAULT;
ALTER TABLE user_config REPLICA IDENTITY DEFAULT;

-- Per-day routine logs (replaces single allData blob in daily_logs)
CREATE TABLE IF NOT EXISTS routine_daily_logs (
  log_date    TEXT    PRIMARY KEY,
  data        JSONB   NOT NULL DEFAULT '{}',
  modified_at BIGINT  NOT NULL DEFAULT 0
);

ALTER TABLE routine_daily_logs DISABLE ROW LEVEL SECURITY;
ALTER TABLE routine_daily_logs REPLICA IDENTITY DEFAULT;

-- ── 5. PUSH NOTIFICATIONS ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT        PRIMARY KEY,
  p256dh     TEXT        NOT NULL DEFAULT '',
  auth       TEXT        NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE push_subscriptions DISABLE ROW LEVEL SECURITY;
