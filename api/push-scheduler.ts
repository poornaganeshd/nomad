/**
 * push-scheduler.ts  GET/POST /api/push-scheduler
 *
 * Daily cron (Vercel Hobby plan limits to once/day) that iterates user_registry
 * and per user does FOUR things:
 *   1. Per-slot routine reminders (routine_reminders table) — fires once daily
 *      per enabled reminder (HH:MM precision needs Pro plan + hourly cron)
 *   2. Recurring bills due today (recurring table, monthly frequency)
 *   3. Streak break risk (no daily_logs entry for ≥ 2 days)
 *   4. Weekly routine email summary (routine_report_schedules, fired when
 *      user-local day-of-week matches send_day_of_week + last_sent_at ≥ 6 days)
 *
 * NOTE: Vercel Hobby plan caps total serverless functions at 12. To stay
 * under the limit, the weekly-email logic that was previously in
 * api/send-routine-report.ts is inlined here. Endpoint is removed.
 *
 * Auth: requires CRON_SECRET (Bearer header or ?secret= query) unless invoked
 * via the Vercel cron internal header (x-vercel-cron). Same pattern as send-reports.ts.
 *
 * Each user is processed independently with a 30s wall-clock timeout so one
 * slow Supabase project can't block the whole tick. Concurrency=5.
 *
 * Schedule: vercel.json hits this daily at `0 2 * * *` (UTC 2 AM).
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import nodemailer from "nodemailer";
import webPush from "web-push";
import { makeHeaders, userGet, userPatch, withRetry } from "./_shared.js";
import type { UserEntry } from "./_shared.js";

const REGISTRY_URL  = process.env.VITE_SUPABASE_URL!;
const REGISTRY_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CRON_SECRET   = process.env.CRON_SECRET!;
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  ?? "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY ?? "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT     ?? "mailto:admin@nomad.app";
const GMAIL_USER    = process.env.GMAIL_USER        ?? "";
const GMAIL_PASS    = process.env.GMAIL_APP_PASSWORD ?? "";

const CONCURRENCY = 5;
const PER_USER_TIMEOUT_MS = 30_000;

type RoutineSchedule = {
  id: string;
  email: string;
  enabled: boolean;
  send_day_of_week: number;
  send_hour: number;
  offset_minutes: number;
  last_sent_at: string | null;
};

const MOOD_EMOJI: Record<string, string> = { great: "😊", okay: "😐", low: "😔", stressed: "😤" };

function dayLevelOf(record: any): number {
  if (!record) return 0;
  const checks = record.dailyChecks || {};
  const checked = Object.values(checks).filter(Boolean).length;
  let lvl = 0;
  if (record.morningWater) lvl++;
  if ((record.eggs || 0) >= 1) lvl++;
  if (record.amSkinDone || record.pmSkinDone) lvl++;
  if (checked > 0) lvl++;
  return Math.min(4, lvl);
}

function calcSleepHours(record: any): number | null {
  if (!record?.sleepTime || !record?.wakeTime) return null;
  const [sh, sm] = record.sleepTime.split(":").map(Number);
  const [wh, wm] = record.wakeTime.split(":").map(Number);
  let h = (wh + wm / 60) - (sh + sm / 60);
  if (h < 0) h += 24;
  return Math.round(h * 10) / 10;
}

function toDateKey(d: Date): string { return d.toISOString().slice(0, 10); }

function buildRoutineHtml(logs: Record<string, any>, weekStart: Date, weekEnd: Date): string {
  const days: { key: string; date: Date }[] = [];
  for (let d = new Date(weekStart); d <= weekEnd; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push({ key: toDateKey(d), date: new Date(d) });
  }
  let daysLogged = 0;
  let totalSleep = 0, sleepN = 0;
  const moodCounts: Record<string, number> = {};
  let totalCompletionPct = 0, completionN = 0;
  let totalWorkoutMin = 0, totalMeditationMin = 0;
  for (const { key } of days) {
    const r = logs[key];
    if (!r) continue;
    daysLogged++;
    if (dayLevelOf(r) >= 2) totalCompletionPct += Math.round(dayLevelOf(r) / 4 * 100);
    completionN++;
    const slp = calcSleepHours(r);
    if (slp != null) { totalSleep += slp; sleepN++; }
    if (r.moodChip) moodCounts[r.moodChip] = (moodCounts[r.moodChip] || 0) + 1;
    if (r.workout?.durationMin) totalWorkoutMin += Number(r.workout.durationMin) || 0;
    if (r.meditationMin) totalMeditationMin += Number(r.meditationMin) || 0;
  }
  const avgSleep = sleepN > 0 ? (totalSleep / sleepN).toFixed(1) : "—";
  const avgCompletion = completionN > 0 ? Math.round(totalCompletionPct / completionN) : 0;
  const topMood = Object.entries(moodCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  const dayCells = days.map(({ key, date }) => {
    const r = logs[key];
    const lvl = dayLevelOf(r);
    const bg = lvl === 0 ? "#e5e7eb" : lvl >= 3 ? "#86efac" : lvl >= 2 ? "#fde68a" : "#fef3c7";
    const dayName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getUTCDay()];
    const mood = r?.moodChip ? MOOD_EMOJI[r.moodChip] || "" : "";
    return `<td style="text-align:center;padding:8px 4px;background:${bg};border-radius:6px;min-width:38px"><div style="font-size:10px;color:#525252;font-weight:700">${dayName}</div><div style="font-size:14px;font-weight:700;color:#171717">${date.getUTCDate()}</div><div style="font-size:14px;line-height:1">${mood || "·"}</div></td>`;
  }).join("");
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;color:#171717"><h2 style="margin:0 0 4px;color:#171717">Your week in NOMAD Routine</h2><p style="margin:0 0 20px;color:#525252;font-size:13px">${toDateKey(weekStart)} → ${toDateKey(weekEnd)}</p><table style="width:100%;border-collapse:separate;border-spacing:4px;margin-bottom:24px"><tr>${dayCells}</tr></table><div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:20px"><div style="flex:1;min-width:130px;padding:14px;background:#fafaf9;border-radius:10px"><div style="font-size:10px;color:#737373;font-weight:700;text-transform:uppercase;letter-spacing:0.06em">Days logged</div><div style="font-size:24px;font-weight:800;color:#171717;margin-top:4px">${daysLogged}/7</div></div><div style="flex:1;min-width:130px;padding:14px;background:#fafaf9;border-radius:10px"><div style="font-size:10px;color:#737373;font-weight:700;text-transform:uppercase;letter-spacing:0.06em">Completion</div><div style="font-size:24px;font-weight:800;color:#171717;margin-top:4px">${avgCompletion}%</div></div><div style="flex:1;min-width:130px;padding:14px;background:#fafaf9;border-radius:10px"><div style="font-size:10px;color:#737373;font-weight:700;text-transform:uppercase;letter-spacing:0.06em">Avg sleep</div><div style="font-size:24px;font-weight:800;color:#171717;margin-top:4px">${avgSleep}<span style="font-size:14px;color:#525252">h</span></div></div></div>${topMood ? `<p style="margin:0 0 12px;font-size:13px;color:#525252">Most days you felt <strong>${MOOD_EMOJI[topMood]} ${topMood}</strong>.</p>` : ""}${totalWorkoutMin > 0 ? `<p style="margin:0 0 6px;font-size:13px;color:#525252">Workout: <strong>${totalWorkoutMin} min</strong> this week.</p>` : ""}${totalMeditationMin > 0 ? `<p style="margin:0 0 6px;font-size:13px;color:#525252">Meditation: <strong>${totalMeditationMin} min</strong> this week.</p>` : ""}<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0"><p style="font-size:11px;color:#a3a3a3">Sent by NOMAD · weekly routine summary. Adjust in Settings → Routine email.</p></div>`;
}

async function maybeSendRoutineEmail(user: UserEntry, nowUtc: Date): Promise<{ sent: boolean; reason?: string }> {
  if (!GMAIL_USER || !GMAIL_PASS) return { sent: false, reason: "gmail not configured" };
  const schedules = (await userGet(user.supabase_url, user.anon_key, "/routine_report_schedules?enabled=eq.true&select=*").catch(() => [])) as any[];
  if (!schedules.length) return { sent: false, reason: "no schedule" };
  const s = schedules[0] as RoutineSchedule;
  if (!s.email) return { sent: false, reason: "no email" };

  const userNow = new Date(nowUtc.getTime() + (s.offset_minutes || 0) * 60_000);
  if (userNow.getUTCDay() !== s.send_day_of_week) return { sent: false, reason: `dow mismatch` };

  if (s.last_sent_at) {
    const lastMs = new Date(s.last_sent_at).getTime();
    if (nowUtc.getTime() - lastMs < 6 * 86_400_000) return { sent: false, reason: "already sent this week" };
  }

  const weekEnd = new Date(userNow); weekEnd.setUTCDate(weekEnd.getUTCDate() - 1); weekEnd.setUTCHours(12, 0, 0, 0);
  const weekStart = new Date(weekEnd); weekStart.setUTCDate(weekStart.getUTCDate() - 6);
  const startKey = toDateKey(weekStart);
  const endKey = toDateKey(weekEnd);

  const rows = (await userGet(user.supabase_url, user.anon_key, `/routine_daily_logs?log_date=gte.${startKey}&log_date=lte.${endKey}&select=log_date,data`).catch(() => [])) as any[];
  const logs: Record<string, any> = {};
  for (const r of rows) logs[r.log_date] = r.data || {};

  const html = buildRoutineHtml(logs, weekStart, weekEnd);
  const transporter = nodemailer.createTransport({ service: "gmail", auth: { user: GMAIL_USER, pass: GMAIL_PASS } });
  await transporter.sendMail({
    from: `"NOMAD Routine" <${GMAIL_USER}>`,
    to: s.email,
    subject: `Your week in NOMAD Routine — ${startKey} → ${endKey}`,
    html,
  });
  await userPatch(user.supabase_url, user.anon_key, `/routine_report_schedules?id=eq.${encodeURIComponent(s.id)}`, { last_sent_at: nowUtc.toISOString() }).catch(() => {});
  return { sent: true };
}

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

// Returns true if reminder is enabled, day-of-week matches, and not yet sent today.
// NOTE: Vercel Hobby plan limits crons to once/day, so push-scheduler runs ONCE daily
// (cron `0 2 * * *`). Per-slot HH:MM precision is not available on Hobby — all enabled
// reminders for the day fire when this cron ticks. Upgrade to Pro for hourly cron +
// proper HH:MM matching.
function shouldFireReminder(r: Reminder, nowUtc: Date): boolean {
  if (!r.enabled) return false;
  const userMs = nowUtc.getTime() + (r.offset_minutes || 0) * 60_000;
  const userLocal = new Date(userMs);
  const localDow  = userLocal.getUTCDay(); // 0=Sun..6=Sat

  // Day-of-week bitmask: bit 0 = Sunday
  if ((r.days_mask & (1 << localDow)) === 0) return false;

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
  const subs = (await userGet(user.supabase_url, user.anon_key, "/push_subscriptions?select=*").catch(() => [])) as any[];
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

  // 1. Per-slot reminders — Hobby plan = single daily tick, so fire each enabled
  // reminder once per user-local day (HH:MM precision requires Pro plan + hourly cron).
  // The reminder body still shows its target time_hhmm so user sees "AM skincare @ 07:30".
  for (const r of (reminders as Reminder[])) {
    if (!shouldFireReminder(r, nowUtc)) continue;
    const body = r.time_hhmm ? `${r.label || r.slot_id} @ ${r.time_hhmm}` : `${r.label || r.slot_id}`;
    const sent = await sendPush(subs, r.label || "Reminder", body, `reminder-${r.id}`);
    if (sent > 0) {
      totalSent += sent;
      fired.push(`reminder:${r.slot_id}`);
      await userPatch(user.supabase_url, user.anon_key, `/routine_reminders?id=eq.${encodeURIComponent(r.id)}`, { last_sent_at: nowUtc.toISOString() }).catch(() => {});
    }
  }

  // 2. Bills due today — cron runs once daily so no need to gate by UTC hour
  const dueBills = (recurring as any[]).filter(r => isMonthlyDueToday(r, todayUtc));
  if (dueBills.length > 0) {
    const body = dueBills.length === 1
      ? `${dueBills[0].name} is due today`
      : `${dueBills.length} bills due today: ${dueBills.slice(0, 3).map(b => b.name).join(", ")}${dueBills.length > 3 ? "…" : ""}`;
    const sent = await sendPush(subs, "Bills due", body, "bills-due-" + todayUtc);
    if (sent > 0) { totalSent += sent; fired.push("bills"); }
  }

  // 3. Streak break risk — if last log is ≥ 2 days old, nudge once per day
  if (Array.isArray(dailyLogs) && dailyLogs.length > 0) {
    const lastLogDate = (dailyLogs[0] as any)?.log_date;
    if (lastLogDate) {
      const daysSince = Math.floor((Date.parse(todayUtc) - Date.parse(lastLogDate)) / 86_400_000);
      if (daysSince >= 2 && daysSince <= 7) {
        const sent = await sendPush(subs, "Streak at risk", `${daysSince} days since last log — log today to keep your streak`, "streak-" + todayUtc);
        if (sent > 0) { totalSent += sent; fired.push("streak"); }
      }
    }
  }

  // Weekly routine email — gated by day-of-week + last_sent_at inside helper.
  let emailResult: any = null;
  try {
    emailResult = await maybeSendRoutineEmail(user, nowUtc);
    if (emailResult.sent) fired.push("weekly-email");
  } catch (e) {
    emailResult = { sent: false, error: (e as Error).message };
  }

  return { user: user.supabase_url, sent: totalSent, fired, email: emailResult };
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
    users = (await r.json()) as UserEntry[];
  } catch (e) {
    return res.status(502).json({ error: (e as Error).message });
  }

  const nowUtc = new Date();
  const results: any[] = [];

  // Weekly routine email — handled inline (was api/send-routine-report.ts).
  // Inlined to keep total serverless function count ≤ 12 (Vercel Hobby limit).
  // Per-user maybeSendRoutineEmail() runs inside the user loop below.

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
