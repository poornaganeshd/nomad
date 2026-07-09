import type { VercelRequest, VercelResponse } from "@vercel/node";

const DDL = `
CREATE TABLE IF NOT EXISTS report_schedules (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              TEXT        NOT NULL,
  email                TEXT        NOT NULL,
  frequency            TEXT        NOT NULL CHECK (frequency IN ('weekly','monthly','quarterly','custom')),
  custom_days          INTEGER,
  send_hour            INTEGER     NOT NULL DEFAULT 6 CHECK (send_hour BETWEEN 0 AND 23),
  include_expenses     BOOLEAN     NOT NULL DEFAULT true,
  include_incomes      BOOLEAN     NOT NULL DEFAULT true,
  include_transfers    BOOLEAN     NOT NULL DEFAULT false,
  selected_categories  JSONB,
  next_send_at         TIMESTAMPTZ NOT NULL,
  last_sent_at         TIMESTAMPTZ,
  is_active            BOOLEAN     NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id)
);

CREATE TABLE IF NOT EXISTS report_delivery_log (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id   UUID        REFERENCES report_schedules(id) ON DELETE CASCADE,
  user_id       TEXT        NOT NULL,
  status        TEXT        NOT NULL CHECK (status IN ('success','failed','retrying')),
  attempted_at  TIMESTAMPTZ DEFAULT NOW(),
  period_start  DATE        NOT NULL,
  period_end    DATE        NOT NULL,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_report_schedules_due
  ON report_schedules (next_send_at)
  WHERE is_active = true;

CREATE TABLE IF NOT EXISTS notification_prefs (
  id             TEXT        PRIMARY KEY DEFAULT 'self',
  enabled        BOOLEAN     NOT NULL DEFAULT false,
  ntfy_server    TEXT        NOT NULL DEFAULT 'https://ntfy.sh',
  ntfy_topic     TEXT        NOT NULL DEFAULT '',
  last_run_date  DATE,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint      TEXT        PRIMARY KEY,
  subscription  JSONB       NOT NULL,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE report_schedules    DISABLE ROW LEVEL SECURITY;
ALTER TABLE report_delivery_log DISABLE ROW LEVEL SECURITY;
ALTER TABLE notification_prefs  DISABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions  DISABLE ROW LEVEL SECURITY;

ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS custom_days         INTEGER;
ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS send_hour           INTEGER NOT NULL DEFAULT 6;
ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS send_day_of_week    INTEGER CHECK (send_day_of_week BETWEEN 0 AND 6);
ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS send_day_of_month   INTEGER CHECK (send_day_of_month BETWEEN 1 AND 31);
ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS include_expenses    BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS include_incomes     BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS include_transfers   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS selected_categories JSONB;

DO $$ BEGIN ALTER TABLE expenses  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE incomes   ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE transfers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE splits    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE recurring ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE events    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE expenses  ADD COLUMN IF NOT EXISTS "balBefore"     NUMERIC DEFAULT NULL; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE incomes   ADD COLUMN IF NOT EXISTS "balBefore"     NUMERIC DEFAULT NULL; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE transfers ADD COLUMN IF NOT EXISTS "fromBalBefore" NUMERIC DEFAULT NULL; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE transfers ADD COLUMN IF NOT EXISTS "toBalBefore"   NUMERIC DEFAULT NULL; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE splits      ADD COLUMN IF NOT EXISTS "categoryId" TEXT; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE settlements ADD COLUMN IF NOT EXISTS "categoryId" TEXT; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE settlements ADD COLUMN IF NOT EXISTS note         TEXT; EXCEPTION WHEN undefined_table THEN NULL; END $$;

`;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // No CRON_SECRET needed here — the Supabase personal access token IS the auth.
  // An attacker would need both a valid Supabase URL and the project owner's PAT.

  const { supabase_url, access_token } = (req.body ?? {}) as { supabase_url?: string; access_token?: string };
  if (!supabase_url || !access_token) {
    return res.status(400).json({ error: "supabase_url and access_token are required" });
  }

  // Extract project ref from https://{ref}.supabase.co
  // Real Supabase project refs are 20 lowercase alphanumeric chars
  const match = supabase_url.match(/^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/);
  if (!match) return res.status(400).json({ error: "Invalid Supabase URL — expected https://{20-char-ref}.supabase.co" });
  const ref = match[1];

  const mgmtRes = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${access_token}`,
    },
    body: JSON.stringify({ query: DDL }),
  });

  if (!mgmtRes.ok) {
    const errorBody = await mgmtRes.text().catch(() => "(unreadable)");
    console.error(`[setup-user] Management API error: ${mgmtRes.status} — ${errorBody}`);
    return res.status(502).json({ error: "Supabase Management API rejected the request", detail: errorBody, status: mgmtRes.status });
  }

  console.log(`[setup-user] Tables created for project: ${ref}`);
  return res.status(200).json({ success: true, project: ref });
}
