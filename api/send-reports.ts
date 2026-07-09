import type { VercelRequest, VercelResponse } from "@vercel/node";
import nodemailer from "nodemailer";
import { format } from "date-fns";
import {
  makeHeaders, userGet, userPatch, userPost,
  withRetry, getPeriod, getNextSendAt, processSchedule,
} from "./_shared.js";
import type { UserEntry, Schedule } from "./_shared.js";
import { buildBillDigest, publishNtfyServer, istTodayStr } from "./_notify.js";
import type { NotifyPrefs, RecurringRow, SplitRow } from "./_notify.js";

const REGISTRY_URL  = process.env.VITE_SUPABASE_URL!;
const REGISTRY_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CRON_SECRET   = process.env.CRON_SECRET!;
const GMAIL_USER    = process.env.GMAIL_USER!;
const GMAIL_PASS    = process.env.GMAIL_APP_PASSWORD!;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const authHeader   = req.headers.authorization ?? "";
  const querySecret  = (req.query?.secret as string) ?? "";
  const isVercelCron = req.headers["x-vercel-cron"] === "1";

  if (!isVercelCron && authHeader !== `Bearer ${CRON_SECRET}` && querySecret !== CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  // Email needs Gmail creds; ntfy push does not. Missing Gmail no longer fails
  // the whole cron — we just skip the email leg and still run notifications.
  const emailEnabled = !!(GMAIL_USER && GMAIL_PASS);

  const now         = new Date();
  const nowIso      = now.toISOString();
  const todayStr    = format(now, "yyyy-MM-dd");
  const transporter = emailEnabled ? nodemailer.createTransport({ service: "gmail", auth: { user: GMAIL_USER, pass: GMAIL_PASS } }) : null;
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
    if (!emailEnabled || !transporter) return;

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

  // ── ntfy bill-reminder push (closed-app delivery) ────────────────────────
  // Reads the user's own notification_prefs + recurring/splits, builds a due-
  // bill digest, and pushes it to their ntfy topic. Deduped to once per IST
  // day via last_run_date. Independent of email — runs even if Gmail is unset.
  const processUserNotifications = async (user: UserEntry) => {
    let prefs: NotifyPrefs | undefined;
    try {
      const rows = await withTimeout(
        userGet(user.supabase_url, user.anon_key, `/notification_prefs?id=eq.self&select=*`),
        PER_USER_TIMEOUT_MS,
        `notify-prefs ${user.supabase_url}`,
      ) as NotifyPrefs[];
      prefs = rows?.[0];
    } catch {
      // Table missing (un-migrated) or unreachable → user just isn't opted in.
      return;
    }
    if (!prefs || !prefs.enabled || !prefs.ntfy_topic) return;

    const todayStr = istTodayStr(now);
    if (prefs.last_run_date === todayStr) return; // already pushed today

    try {
      const [recurring, splits] = await Promise.all([
        userGet(user.supabase_url, user.anon_key, `/recurring?deleted_at=is.null&select=*`),
        userGet(user.supabase_url, user.anon_key, `/splits?direction=eq.owe&deleted_at=is.null&select=*`),
      ]) as [RecurringRow[], SplitRow[]];

      const digest = buildBillDigest(recurring, splits, todayStr);
      // Stamp the run date regardless, so a same-day re-trigger won't re-push.
      await userPatch(user.supabase_url, user.anon_key, `/notification_prefs?id=eq.self`, { last_run_date: todayStr });
      if (!digest) return;

      const r = await publishNtfyServer(prefs.ntfy_server || "https://ntfy.sh", prefs.ntfy_topic, {
        title: digest.title,
        message: digest.message,
        priority: digest.priority,
        tags: ["moneybag", "bell"],
      });
      results.push({ user: user.supabase_url, scheduleId: "ntfy", status: r.ok ? "success" : "failed", error: r.ok ? undefined : (r.error || `HTTP ${r.status}`) });
    } catch (e) {
      results.push({ user: user.supabase_url, scheduleId: "ntfy", status: "failed", error: (e as Error).message });
    }
  };

  for (let i = 0; i < allUsers.length; i += CONCURRENCY) {
    const chunk = allUsers.slice(i, i + CONCURRENCY);
    await Promise.allSettled(chunk.flatMap(u => [processUser(u), processUserNotifications(u)]));
  }

  return res.status(200).json({ processed: results.length, results });
}
