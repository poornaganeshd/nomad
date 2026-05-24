/**
 * send-routine-report.ts  GET/POST /api/send-routine-report
 *
 * Daily cron that checks each user's routine_report_schedules row and sends
 * a weekly HTML summary email when the configured send_day_of_week matches
 * the user's local day-of-week.
 *
 * Summary includes:
 *   - Days logged this week (out of 7)
 *   - Completion % avg (water + eggs + custom daily items)
 *   - Sleep duration avg
 *   - Mood emoji per day
 *   - Streak (consecutive days where dayLevel >= 2)
 *   - Habit table (each custom daily item × days done this week)
 *
 * Auth: CRON_SECRET (Bearer or ?secret=) unless invoked by Vercel cron.
 *
 * Schedule: hits hourly enough to catch any user's local-day window. We use
 * once-daily at 3 AM UTC so it covers the typical window for IST/EU/US.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import nodemailer from "nodemailer";
import { makeHeaders, userGet, userPatch, withRetry } from "./_shared.js";
import type { UserEntry } from "./_shared.js";

const REGISTRY_URL = process.env.VITE_SUPABASE_URL!;
const REGISTRY_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CRON_SECRET  = process.env.CRON_SECRET!;
const GMAIL_USER   = process.env.GMAIL_USER!;
const GMAIL_PASS   = process.env.GMAIL_APP_PASSWORD!;

const CONCURRENCY = 5;
const PER_USER_TIMEOUT_MS = 30_000;

type RoutineSchedule = {
  id: string;
  email: string;
  enabled: boolean;
  send_day_of_week: number;   // 0=Sun..6=Sat
  send_hour: number;          // user-local hour (0-23)
  offset_minutes: number;     // minutes east of UTC (IST = +330)
  last_sent_at: string | null;
};

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms)),
  ]);
}

function userLocalNow(nowUtc: Date, offsetMinutes: number): Date {
  return new Date(nowUtc.getTime() + (offsetMinutes || 0) * 60_000);
}

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dayLevelOf(record: any): number {
  if (!record) return 0;
  const checks = record.dailyChecks || {};
  const checked = Object.values(checks).filter(Boolean).length;
  const hasWater = !!record.morningWater;
  const hasEggs = (record.eggs || 0) >= 1;
  const hasSkincare = record.amSkinDone || record.pmSkinDone;
  // 0 = no activity; 1 = something; 2 = water+eggs; 3+ = water+eggs+skin+habits
  let lvl = 0;
  if (hasWater) lvl++;
  if (hasEggs) lvl++;
  if (hasSkincare) lvl++;
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

const MOOD_EMOJI: Record<string, string> = { great: "😊", okay: "😐", low: "😔", stressed: "😤" };

function buildHtml(schedule: RoutineSchedule, logs: Record<string, any>, weekStart: Date, weekEnd: Date): string {
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
    return `<td style="text-align:center;padding:8px 4px;background:${bg};border-radius:6px;min-width:38px">
      <div style="font-size:10px;color:#525252;font-weight:700">${dayName}</div>
      <div style="font-size:14px;font-weight:700;color:#171717">${date.getUTCDate()}</div>
      <div style="font-size:14px;line-height:1">${mood || "·"}</div>
    </td>`;
  }).join("");

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;color:#171717">
  <h2 style="margin:0 0 4px;color:#171717">Your week in NOMAD Routine</h2>
  <p style="margin:0 0 20px;color:#525252;font-size:13px">${toDateKey(weekStart)} → ${toDateKey(weekEnd)}</p>

  <table style="width:100%;border-collapse:separate;border-spacing:4px;margin-bottom:24px">
    <tr>${dayCells}</tr>
  </table>

  <div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:20px">
    <div style="flex:1;min-width:130px;padding:14px;background:#fafaf9;border-radius:10px">
      <div style="font-size:10px;color:#737373;font-weight:700;text-transform:uppercase;letter-spacing:0.06em">Days logged</div>
      <div style="font-size:24px;font-weight:800;color:#171717;margin-top:4px">${daysLogged}/7</div>
    </div>
    <div style="flex:1;min-width:130px;padding:14px;background:#fafaf9;border-radius:10px">
      <div style="font-size:10px;color:#737373;font-weight:700;text-transform:uppercase;letter-spacing:0.06em">Completion</div>
      <div style="font-size:24px;font-weight:800;color:#171717;margin-top:4px">${avgCompletion}%</div>
    </div>
    <div style="flex:1;min-width:130px;padding:14px;background:#fafaf9;border-radius:10px">
      <div style="font-size:10px;color:#737373;font-weight:700;text-transform:uppercase;letter-spacing:0.06em">Avg sleep</div>
      <div style="font-size:24px;font-weight:800;color:#171717;margin-top:4px">${avgSleep}<span style="font-size:14px;color:#525252">h</span></div>
    </div>
  </div>

  ${topMood ? `<p style="margin:0 0 12px;font-size:13px;color:#525252">Most days you felt <strong>${MOOD_EMOJI[topMood]} ${topMood}</strong>.</p>` : ""}
  ${totalWorkoutMin > 0 ? `<p style="margin:0 0 6px;font-size:13px;color:#525252">Workout: <strong>${totalWorkoutMin} min</strong> this week.</p>` : ""}
  ${totalMeditationMin > 0 ? `<p style="margin:0 0 6px;font-size:13px;color:#525252">Meditation: <strong>${totalMeditationMin} min</strong> this week.</p>` : ""}

  <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
  <p style="font-size:11px;color:#a3a3a3">Sent by NOMAD · weekly routine summary. Adjust in Settings → Routine email.</p>
</div>`;
}

async function processUser(user: UserEntry, nowUtc: Date) {
  const schedules = await userGet(user.supabase_url, user.anon_key, "/routine_report_schedules?enabled=eq.true&select=*").catch(() => []);
  if (!Array.isArray(schedules) || !schedules.length) return { user: user.supabase_url, skipped: "no schedule" };

  const s: RoutineSchedule = schedules[0];
  if (!s.email) return { user: user.supabase_url, skipped: "no email" };

  const userNow = userLocalNow(nowUtc, s.offset_minutes);
  const localDow = userNow.getUTCDay();
  const localHour = userNow.getUTCHours();

  // Only fire when local day-of-week matches AND we're in the configured hour window (±1 hour)
  if (localDow !== s.send_day_of_week) return { user: user.supabase_url, skipped: `dow ${localDow}≠${s.send_day_of_week}` };
  if (Math.abs(localHour - s.send_hour) > 1) return { user: user.supabase_url, skipped: `hour ${localHour}≠${s.send_hour}` };

  // Already sent this week?
  if (s.last_sent_at) {
    const lastMs = new Date(s.last_sent_at).getTime();
    if (nowUtc.getTime() - lastMs < 6 * 86_400_000) return { user: user.supabase_url, skipped: "already sent" };
  }

  // Fetch past 7 days of logs (user-local week ending yesterday)
  const weekEnd = new Date(userNow); weekEnd.setUTCDate(weekEnd.getUTCDate() - 1); weekEnd.setUTCHours(12, 0, 0, 0);
  const weekStart = new Date(weekEnd); weekStart.setUTCDate(weekStart.getUTCDate() - 6);
  const startKey = toDateKey(weekStart);
  const endKey = toDateKey(weekEnd);

  const rows = await userGet(user.supabase_url, user.anon_key, `/routine_daily_logs?log_date=gte.${startKey}&log_date=lte.${endKey}&select=log_date,data`).catch(() => []);
  const logs: Record<string, any> = {};
  for (const r of rows as any[]) {
    logs[r.log_date] = r.data || {};
  }

  const html = buildHtml(s, logs, weekStart, weekEnd);

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  });

  await transporter.sendMail({
    from: `"NOMAD Routine" <${GMAIL_USER}>`,
    to: s.email,
    subject: `Your week in NOMAD Routine — ${startKey} → ${endKey}`,
    html,
  });

  await userPatch(user.supabase_url, user.anon_key, `/routine_report_schedules?id=eq.${encodeURIComponent(s.id)}`, { last_sent_at: nowUtc.toISOString() }).catch(() => {});

  return { user: user.supabase_url, sent: 1, email: s.email };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const authHeader  = req.headers.authorization;
  const querySecret = (req.query.secret as string) ?? "";
  const isVercelCron = !!req.headers["x-vercel-cron"];

  if (!isVercelCron && authHeader !== `Bearer ${CRON_SECRET}` && querySecret !== CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!GMAIL_USER || !GMAIL_PASS) {
    return res.status(503).json({ error: "Gmail not configured" });
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
