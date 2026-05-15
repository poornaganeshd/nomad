import type { VercelRequest, VercelResponse } from "@vercel/node";
import nodemailer from "nodemailer";
import { format } from "date-fns";
import webPush from "web-push";
import {
  makeHeaders, userGet, userPatch, userPost,
  withRetry, getPeriod, getNextSendAt, processSchedule,
} from "./_shared.js";
import type { UserEntry, Schedule } from "./_shared.js";

const REGISTRY_URL  = process.env.VITE_SUPABASE_URL!;
const REGISTRY_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CRON_SECRET   = process.env.CRON_SECRET!;
const GMAIL_USER    = process.env.GMAIL_USER!;
const GMAIL_PASS    = process.env.GMAIL_APP_PASSWORD!;
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  ?? "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY ?? "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT     ?? "mailto:admin@nomad.app";

// Returns true if a monthly recurring bill is due on todayStr and not yet paid/skipped.
function isMonthlyDueToday(r: Record<string, any>, todayStr: string): boolean {
  if (!r.active) return false;
  const dom = Number(r.dayOfMonth ?? 0);
  if (!dom) return false;
  const todayDay = Number(todayStr.slice(8, 10));
  if (dom !== todayDay) return false;
  const thisMonth = todayStr.slice(0, 7);
  if ((r.lastPaidDate ?? "").slice(0, 7) === thisMonth) return false;
  if ((r.lastSkippedDate ?? "").slice(0, 7) === thisMonth) return false;
  return true;
}

async function sendPushForDueBills(user: UserEntry, todayStr: string): Promise<void> {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;

  const [subs, recurring] = await Promise.all([
    userGet(user.supabase_url, user.anon_key, "/push_subscriptions?select=*").catch(() => [] as any[]),
    userGet(user.supabase_url, user.anon_key, "/recurring?active=eq.true&select=*").catch(() => [] as any[]),
  ]);

  if (!subs.length) return;
  const due = (recurring as any[]).filter(r => isMonthlyDueToday(r, todayStr));
  if (!due.length) return;

  webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

  for (const sub of subs as any[]) {
    const pushSub = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
    for (const rec of due) {
      const payload = JSON.stringify({
        title: "NOMAD — Bill Due Today",
        body: `${rec.name} — ₹${rec.amount}`,
        tag: `bill-${rec.id}-${todayStr}`,
        requireInteraction: true,
      });
      await webPush.sendNotification(pushSub, payload).catch(() => {});
    }
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const authHeader   = req.headers.authorization ?? "";
  const querySecret  = (req.query?.secret as string) ?? "";
  const isVercelCron = req.headers["x-vercel-cron"] === "1";

  if (!isVercelCron && authHeader !== `Bearer ${CRON_SECRET}` && querySecret !== CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!GMAIL_USER || !GMAIL_PASS) {
    return res.status(500).json({ error: "GMAIL_USER or GMAIL_APP_PASSWORD is not set" });
  }

  const now         = new Date();
  const nowIso      = now.toISOString();
  const todayStr    = format(now, "yyyy-MM-dd");
  const transporter = nodemailer.createTransport({ service: "gmail", auth: { user: GMAIL_USER, pass: GMAIL_PASS } });
  const results: { user: string; scheduleId: string; status: string; error?: string }[] = [];

  const registryRaw = await fetch(`${REGISTRY_URL}/rest/v1/user_registry?select=*`, { headers: makeHeaders(REGISTRY_KEY) });
  let registry: UserEntry[] = [];
  if (registryRaw.ok) {
    registry = await registryRaw.json() as UserEntry[];
  } else {
    const body = await registryRaw.text().catch(() => "(unreadable)");
    console.error(`[send-reports] Registry fetch failed: ${registryRaw.status} — ${body}`);
  }

  const allUsers: UserEntry[] = [
    { supabase_url: REGISTRY_URL, anon_key: REGISTRY_KEY },
    ...registry.filter(u => u.supabase_url !== REGISTRY_URL),
  ];

  const PER_USER_TIMEOUT_MS = 30_000;
  const CONCURRENCY = 5;

  const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
    Promise.race([
      promise,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
    ]);

  const processUser = async (user: UserEntry) => {
    // Send push notifications for bills due today (independent of email schedule).
    sendPushForDueBills(user, todayStr).catch(() => {});

    let schedules: Schedule[] = [];
    try {
      schedules = await withTimeout(
        userGet(user.supabase_url, user.anon_key, `/report_schedules?is_active=eq.true&next_send_at=lte.${nowIso}&select=*`),
        PER_USER_TIMEOUT_MS,
        `schedules ${user.supabase_url}`,
      ) as Schedule[];
    } catch (e) {
      results.push({ user: user.supabase_url, scheduleId: "—", status: "failed", error: (e as Error).message });
      return;
    }

    for (const s of schedules) {
      const { start, end } = getPeriod(s, now);
      const pStart = format(start, "yyyy-MM-dd");
      const pEnd   = format(end,   "yyyy-MM-dd");
      let status = "success";
      let errMsg: string | undefined;

      try {
        await withTimeout(
          withRetry(() => processSchedule(s, user.supabase_url, user.anon_key, transporter, GMAIL_USER, now)),
          PER_USER_TIMEOUT_MS,
          `send ${user.supabase_url}`,
        );
        await userPatch(user.supabase_url, user.anon_key, `/report_schedules?id=eq.${s.id}`, {
          next_send_at: getNextSendAt(s, now).toISOString(),
          last_sent_at: nowIso,
        });
      } catch (e) {
        status = "failed";
        errMsg = (e as Error).message;
      }

      await userPost(user.supabase_url, user.anon_key, "report_delivery_log", {
        schedule_id: s.id, user_id: s.user_id, status,
        period_start: pStart, period_end: pEnd,
        error_message: errMsg ?? null,
      }).catch(() => {});

      results.push({ user: user.supabase_url, scheduleId: s.id, status, error: errMsg });
    }
  };

  for (let i = 0; i < allUsers.length; i += CONCURRENCY) {
    const chunk = allUsers.slice(i, i + CONCURRENCY);
    await Promise.allSettled(chunk.map(processUser));
  }

  return res.status(200).json({ processed: results.length, results });
}
