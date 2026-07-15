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
  note      TEXT,
  date      TEXT
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

-- Categorized splits + settlements (B.31). Splits gain a categoryId so per-person IOUs
-- can roll up into category totals; settlements snapshot categoryId + note so the
-- spending-by-category aggregation works without joining back to the parent split.
ALTER TABLE splits      ADD COLUMN IF NOT EXISTS "categoryId" TEXT;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS "categoryId" TEXT;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS note         TEXT;

-- Overpay recovery: when someone settles an IOU with MORE than the remainder
-- (owed ₹11.66, they send ₹12), `amount` stays the real cash moved and `excess`
-- records the extra. Split ledgers reconcile on (amount - excess); the excess
-- offsets the write-off ledger as recovered/repaid-extra.
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS excess NUMERIC;

ALTER TABLE expenses        REPLICA IDENTITY DEFAULT;
ALTER TABLE incomes         REPLICA IDENTITY DEFAULT;
ALTER TABLE transfers       REPLICA IDENTITY DEFAULT;
ALTER TABLE settlements     REPLICA IDENTITY DEFAULT;
ALTER TABLE splits          REPLICA IDENTITY DEFAULT;
ALTER TABLE recurring       REPLICA IDENTITY DEFAULT;
ALTER TABLE events          REPLICA IDENTITY DEFAULT;
ALTER TABLE wallet_balances REPLICA IDENTITY DEFAULT;

-- Cross-device app preferences: a single-row-per-key JSONB store for data that
-- is NOT transactional — user-curated categories, income sources, and the IOU
-- write-off tag map (key = 'nomad'). Kept here (not on transaction rows) so a
-- fresh device can pull the user's setup. The app degrades to localStorage-only
-- if this table is absent, so running this migration is optional but enables
-- categories / income sources / write-off labels to follow you across devices.
CREATE TABLE IF NOT EXISTS user_prefs (
  key        TEXT PRIMARY KEY,
  value      JSONB,
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE user_prefs DISABLE ROW LEVEL SECURITY;
ALTER TABLE user_prefs REPLICA IDENTITY DEFAULT;

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

-- ── 1d. CREATED_AT COLUMNS ──────────────────────────────────
-- Adds an immutable created_at to the transaction tables so per-row creation
-- time survives the Supabase round-trip. walletVerify (staleness badge),
-- isRecentRow (self-heal age guard in syncMerge.js), and future time-based
-- features need a STABLE creation stamp — updated_at is bumped on every edit by
-- nomad_touch_updated_at, so it cannot serve as creation time.
--
-- created_at is DB-OWNED: the client never sends it (it's intentionally absent
-- from COLS in src/dbCols.js), so DEFAULT NOW() stamps it on INSERT and, on a
-- PostgREST upsert (resolution=merge-duplicates), the ON CONFLICT UPDATE only
-- sets the columns present in the payload — so created_at is preserved across
-- edits/offline-replays. Idempotent — safe on re-run.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'expenses','incomes','transfers','settlements'
  ]) LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()', t);
    -- Backfill rows that pre-date this migration: their created_at was just
    -- defaulted to the migration timestamp, but updated_at (added earlier,
    -- stamped at insert) better approximates true creation. Only rows whose
    -- freshly-defaulted created_at post-dates updated_at are pre-existing, so
    -- re-runs and future inserts (where created_at == updated_at) are untouched.
    EXECUTE format('UPDATE %I SET created_at = updated_at WHERE updated_at IS NOT NULL AND created_at > updated_at', t);
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
ALTER TABLE splits   ADD COLUMN IF NOT EXISTS skipped       BOOLEAN DEFAULT FALSE;
ALTER TABLE splits   ADD COLUMN IF NOT EXISTS date          TEXT;
ALTER TABLE events   ADD COLUMN IF NOT EXISTS type          TEXT DEFAULT 'solo';
ALTER TABLE events   ADD COLUMN IF NOT EXISTS participants  JSONB DEFAULT '[]';

ALTER TABLE report_schedules    DISABLE ROW LEVEL SECURITY;
ALTER TABLE report_delivery_log DISABLE ROW LEVEL SECURITY;

-- ── 2b. PUSH NOTIFICATION PREFS (ntfy) ───────────────────────
-- One row per user (id='self'). Read by the send-reports cron to push a due-
-- bill digest to the user's ntfy topic even when no NOMAD tab is open.
CREATE TABLE IF NOT EXISTS notification_prefs (
  id             TEXT        PRIMARY KEY DEFAULT 'self',
  enabled        BOOLEAN     NOT NULL DEFAULT false,
  ntfy_server    TEXT        NOT NULL DEFAULT 'https://ntfy.sh',
  ntfy_topic     TEXT        NOT NULL DEFAULT '',
  last_run_date  DATE,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE notification_prefs DISABLE ROW LEVEL SECURITY;

-- Web Push browser subscriptions (one row per device/browser that tapped
-- "Enable on this device"). The send-reports cron sends the daily due-bill
-- digest to every row via the Web Push protocol; 404/410 rows are pruned.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint      TEXT        PRIMARY KEY,
  subscription  JSONB       NOT NULL,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE push_subscriptions DISABLE ROW LEVEL SECURITY;

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

-- Per-slot push reminders. Cron checks each row daily.
-- slot_id: free-form ("am_skincare", "water_2h", "pm_skincare", custom)
-- time_hhmm: HH:MM in user's local time (best-effort; client provides offset_minutes vs UTC)
-- days_mask: bitmask Sun=1, Mon=2, Tue=4, Wed=8, Thu=16, Fri=32, Sat=64 (127 = all days)
CREATE TABLE IF NOT EXISTS routine_reminders (
  id              TEXT        PRIMARY KEY,
  slot_id         TEXT        NOT NULL,
  label           TEXT        NOT NULL DEFAULT '',
  time_hhmm       TEXT        NOT NULL DEFAULT '08:00',
  days_mask       INTEGER     NOT NULL DEFAULT 127,
  offset_minutes  INTEGER     NOT NULL DEFAULT 0,
  enabled         BOOLEAN     NOT NULL DEFAULT TRUE,
  last_sent_at    TIMESTAMPTZ DEFAULT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE routine_reminders DISABLE ROW LEVEL SECURITY;

-- Weekly routine email report opt-in. One row per user (id='self').
CREATE TABLE IF NOT EXISTS routine_report_schedules (
  id               TEXT        PRIMARY KEY DEFAULT 'self',
  email            TEXT        NOT NULL DEFAULT '',
  enabled          BOOLEAN     NOT NULL DEFAULT FALSE,
  send_day_of_week INTEGER     NOT NULL DEFAULT 0,   -- 0=Sun..6=Sat
  send_hour        INTEGER     NOT NULL DEFAULT 8,    -- 0-23 local hour
  offset_minutes   INTEGER     NOT NULL DEFAULT 0,    -- IST offset for owner default = -330
  last_sent_at     TIMESTAMPTZ DEFAULT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE routine_report_schedules DISABLE ROW LEVEL SECURITY;

-- ── 6. PRE-TRANSACTION BALANCE SNAPSHOTS ─────────────────────
-- Stores the wallet balance captured at the moment each transaction was
-- created. Calibration-independent: never recomputed, never changes.
DO $$ BEGIN ALTER TABLE expenses  ADD COLUMN IF NOT EXISTS "balBefore" NUMERIC DEFAULT NULL; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE incomes   ADD COLUMN IF NOT EXISTS "balBefore" NUMERIC DEFAULT NULL; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE transfers ADD COLUMN IF NOT EXISTS "fromBalBefore" NUMERIC DEFAULT NULL; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE transfers ADD COLUMN IF NOT EXISTS "toBalBefore"   NUMERIC DEFAULT NULL; EXCEPTION WHEN undefined_table THEN NULL; END $$;
-- Per-expense group split breakdown: { "You": share, "<name>": share, ... } in
-- INR. Absent/null = legacy equal split among all participants. Lets a single
-- group expense be split unequally, by exact amounts, or among a subset.
DO $$ BEGIN ALTER TABLE expenses  ADD COLUMN IF NOT EXISTS "splitWith"  JSONB   DEFAULT NULL; EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- ── 7. SYNC IDEMPOTENCY KEYS ──────────────────────────────────
-- Used by /api/sync to detect already-applied mutations so a client retry
-- after a dropped response never double-writes. Keys older than 30 days are
-- pruned by the proxy on each successful write.
CREATE TABLE IF NOT EXISTS nomad_sync_keys (
  key        TEXT        PRIMARY KEY,
  result     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS nomad_sync_keys_created ON nomad_sync_keys(created_at);

ALTER TABLE nomad_sync_keys DISABLE ROW LEVEL SECURITY;
