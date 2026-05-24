/**
 * push-scheduler.ts  GET/POST /api/push-scheduler
 *
 * Hourly cron that iterates user_registry and fires push notifications for:
 *   1. Per-slot routine reminders (routine_reminders table)
 *   2. Recurring bills due today (recurring table, monthly frequency)
 *   3. Streak break risk (no daily_logs entry for ≥ 2 days)
 *
 * Auth: requires CRON_SECRET (Bearer header or ?secret= query) unless invoked
 * via the Vercel cron internal header (x-vercel-cron). Same pattern as send-reports.ts.
 *
 * Each user is processed independently with a 30s wall-clock timeout so one
 * slow Supabase project can't block the whole tick. Concurrency=5 (matches
 * send-reports.ts).
 *
 * Schedule: vercel.json should hit this hourly. Example cron: "0 * * * *".
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import webPush from "web-push";
import { makeHeaders, userGet, userPatch, withRetry } from "./_shared.js";
import type { UserEntry } from "./_shared.js";

const REGISTRY_URL  = process.env.VITE_SUPABASE_URL!;
const REGISTRY_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CRON_SECRET   = process.env.CRON_SECRET!;
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  ?? "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY ?? "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT     ?? "mailto:admin@nomad.app";

const CONCURRENCY = 5;
const PER_USER_TIMEOUT_MS = 30_000;

type Reminder = {
  id: string;
  slot_id: string;
  label: string;
  time_hhmm: string;
  days_mask: number;
  offset_minutes: number;
  enabled: boolean;
  last_sent_at: string | null;
};

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms)),
  ]);
}

async function sendPush(subs: any[], title: string, body: string, tag: string): Promise<number> {
  if (!subs.length || !VAPID_PUBLIC || !VAPID_PRIVATE) return 0;
  webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  const payload = JSON.stringify({ title, body, tag, requireInteraction: false });
  let sent = 0;
  await Promise.all(subs.map(async (s: any) => {
    try {
      await webPush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      sent++;
    } catch { /* swallow — stale subs handled by send-reports cleanup */ }
  }));
  return sent;
}

// True if a monthly recurring is due today (UTC date) and not paid/skipped this month
function isMonthlyDueToday(r: any, todayStr: string): boolean {
  if (!r.active) return false;
  const dom = Number(r.dayOfMonth ?? 0);
  if (!dom) return false;
  const y = Number(todayStr.slice(0, 4));
  const m = Number(todayStr.slice(5, 7));
  const todayDay = Number(todayStr.slice(8, 10));
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (Math.min(dom, lastDay) !== todayDay) return false;
  const thisMonth = todayStr.slice(0, 7);
  if ((r.lastPaidDate ?? "").slice(0, 7) === thisMonth) return false;
  if ((r.lastSkippedDate ?? "").slice(0, 7) === thisMonth) return false;
  return true;
}

// Returns true if reminder should fire in the current hour for the user's local time
// + day-of-week mask + not-yet-sent-today
function shouldFireReminder(r: Reminder, nowUtc: Date): boolean {
  if (!r.enabled) return false;
  const userMs = nowUtc.getTime() + (r.offset_minutes || 0) * 60_000;
  const userLocal = new Date(userMs);
  const localHour = userLocal.getUTCHours();
  const localMin  = userLocal.getUTCMinutes();
  const localDow  = userLocal.getUTCDay(); // 0=Sun..6=Sat

  // Day-of-week bitmask: bit 0 = Sunday
  if ((r.days_mask & (1 << localDow)) === 0) return false;

  const [rh, rm] = (r.time_hhmm || "08:00").split(":").map(Number);
  if (localHour !== rh) return false;
  // Match within current hour, regardless of minute (cron runs hourly anyway)
  if (rm > localMin && Math.abs(rm - localMin) > 30) return false;

  // Already sent today (compare on user-local date)
  if (r.last_sent_at) {
    const lastMs = new Date(r.last_sent_at).getTime() + (r.offset_minutes || 0) * 60_000;
    const lastDate = new Date(lastMs).toISOString().slice(0, 10);
    const userDate = userLocal.toISOString().slice(0, 10);
    if (lastDate === userDate) return false;
  }
  return true;
}

async function processUser(user: UserEntry, nowUtc: Date) {
  const subs: any[] = await userGet(user.supabase_url, user.anon_key, "/push_subscriptions?select=*").catch(() => []);
  if (!subs.length) return { user: user.supabase_url, skipped: "no subs" };

  // UTC date used by recurring bill check (matches send-reports convention)
  const todayUtc = nowUtc.toISOString().slice(0, 10);

  const [reminders, recurring, dailyLogs] = await Promise.all([
    userGet(user.supabase_url, user.anon_key, "/routine_reminders?select=*").catch(() => [] as Reminder[]),
    userGet(user.supabase_url, user.anon_key, "/recurring?select=*&deleted_at=is.null").catch(() => [] as any[]),
    userGet(user.supabase_url, user.anon_key, "/routine_daily_logs?select=log_date&order=log_date.desc&limit=2").catch(() => [] as any[]),
  ]);

  let totalSent = 0;
  const fired: string[] = [];

  // 1. Per-slot reminders
  for (const r of (reminders as Reminder[])) {
    if (!shouldFireReminder(r, nowUtc)) continue;
    const sent = await sendPush(subs, r.label || "Reminder", `Time for ${r.label || r.slot_id}`, `reminder-${r.id}`);
    if (sent > 0) {
      totalSent += sent;
      fired.push(`reminder:${r.slot_id}`);
      await userPatch(user.supabase_url, user.anon_key, `/routine_reminders?id=eq.${encodeURIComponent(r.id)}`, { last_sent_at: nowUtc.toISOString() }).catch(() => {});
    }
  }

  // 2. Bills due today (only fire once per day; check via simple heuristic — first hour after midnight UTC)
  // To avoid duplicate fires from hourly cron, only fire when UTC hour < 4 (typical IST/EU run window).
  if (nowUtc.getUTCHours() < 4) {
    const dueBills = (recurring as any[]).filter(r => isMonthlyDueToday(r, todayUtc));
    if (dueBills.length > 0) {
      const body = dueBills.length === 1
        ? `${dueBills[0].name} is due today`
        : `${dueBills.length} bills due today: ${dueBills.slice(0, 3).map(b => b.name).join(", ")}${dueBills.length > 3 ? "…" : ""}`;
      const sent = await sendPush(subs, "Bills due", body, "bills-due-" + todayUtc);
      if (sent > 0) { totalSent += sent; fired.push("bills"); }
    }
  }

  // 3. Streak break risk — if last log is ≥ 2 days old and user has any history, nudge
  // Only fire in late evening window (UTC 12-16, roughly IST 6-10 PM)
  if (nowUtc.getUTCHours() >= 12 && nowUtc.getUTCHours() <= 16 && Array.isArray(dailyLogs) && dailyLogs.length > 0) {
    const lastLogDate = (dailyLogs[0] as any)?.log_date;
    if (lastLogDate) {
      const daysSince = Math.floor((Date.parse(todayUtc) - Date.parse(lastLogDate)) / 86_400_000);
      if (daysSince >= 2 && daysSince <= 7) {
        const sent = await sendPush(subs, "Streak at risk", `${daysSince} days since last log — log today to keep your streak`, "streak-" + todayUtc);
        if (sent > 0) { totalSent += sent; fired.push("streak"); }
      }
    }
  }

  return { user: user.supabase_url, sent: totalSent, fired };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const authHeader  = req.headers.authorization;
  const querySecret = (req.query.secret as string) ?? "";
  const isVercelCron = !!req.headers["x-vercel-cron"];

  if (!isVercelCron && authHeader !== `Bearer ${CRON_SECRET}` && querySecret !== CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return res.status(503).json({ error: "VAPID keys not configured" });
  }
  if (!REGISTRY_URL || !REGISTRY_KEY) {
    return res.status(503).json({ error: "Owner Supabase env vars not configured" });
  }

  let users: UserEntry[] = [];
  try {
    const r = await fetch(`${REGISTRY_URL}/rest/v1/user_registry?select=supabase_url,anon_key`, {
      headers: makeHeaders(REGISTRY_KEY),
    });
    if (!r.ok) throw new Error(`registry ${r.status}`);
    users = await r.json();
  } catch (e) {
    return res.status(502).json({ error: (e as Error).message });
  }

  const nowUtc = new Date();
  const results: any[] = [];

  for (let i = 0; i < users.length; i += CONCURRENCY) {
    const chunk = users.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.allSettled(
      chunk.map(u => withRetry(() => withTimeout(processUser(u, nowUtc), PER_USER_TIMEOUT_MS, u.supabase_url), 1))
    );
    for (const r of chunkResults) {
      if (r.status === "fulfilled") results.push(r.value);
      else results.push({ error: r.reason?.message ?? "unknown" });
    }
  }

  return res.status(200).json({ ok: true, processed: users.length, results, at: nowUtc.toISOString() });
}
