import type { VercelRequest, VercelResponse } from "@vercel/node";
import nodemailer from "nodemailer";
import {
  userGet, userPatch, userPost,
  getPeriod, getNextSendAt, processSchedule,
} from "./_shared.js";
import type { Schedule } from "./_shared.js";
import { format } from "date-fns";

const GMAIL_USER     = process.env.GMAIL_USER!;
const GMAIL_PASS     = process.env.GMAIL_APP_PASSWORD!;
const REGISTRY_URL   = process.env.VITE_SUPABASE_URL;
const REGISTRY_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!GMAIL_USER || !GMAIL_PASS) return res.status(500).json({ error: "Gmail not configured" });

  const { supabase_url, anon_key } = (req.body ?? {}) as { supabase_url?: string; anon_key?: string };
  if (!supabase_url || !anon_key) return res.status(400).json({ error: "supabase_url and anon_key required" });

  // Reject the trivial open-relay abuse: caller's supabase_url must exist in the
  // owner's user_registry (or be the owner's own URL). This stops attackers who
  // spin up their own Supabase project just to relay spam through our Gmail.
  if (!REGISTRY_URL || !REGISTRY_KEY) return res.status(500).json({ error: "Registry env vars not configured (VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)" });
  if (supabase_url !== REGISTRY_URL) {
    const lookupUrl = `${REGISTRY_URL}/rest/v1/user_registry?supabase_url=eq.${encodeURIComponent(supabase_url)}&select=supabase_url`;
    let lookupRes: Response;
    try {
      lookupRes = await fetch(lookupUrl, { headers: { apikey: REGISTRY_KEY, Authorization: `Bearer ${REGISTRY_KEY}` } });
    } catch (e) {
      return res.status(503).json({ error: "Could not verify caller", detail: (e as Error).message });
    }
    if (!lookupRes.ok) return res.status(503).json({ error: "Could not verify caller", status: lookupRes.status });
    const rows = await lookupRes.json().catch(() => []) as Array<{ supabase_url: string }>;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(403).json({ error: "Caller is not a registered NOMAD user. Open the app once to register." });
    }
  }

  const userId = supabase_url.replace("https://", "").split(".")[0];
  let schedules: Schedule[];
  try {
    schedules = await userGet(supabase_url, anon_key, `/report_schedules?user_id=eq.${userId}&select=*&limit=1`) as Schedule[];
  } catch (e) {
    return res.status(502).json({ error: "Could not reach Supabase", detail: (e as Error).message });
  }

  if (!schedules.length) return res.status(404).json({ error: "No schedule found — save one first" });

  const s = schedules[0];
  const now = new Date();
  const transporter = nodemailer.createTransport({ service: "gmail", auth: { user: GMAIL_USER, pass: GMAIL_PASS } });

  try {
    await processSchedule(s, supabase_url, anon_key, transporter, GMAIL_USER, now);
  } catch (e) {
    return res.status(500).json({ error: "Email send failed", detail: (e as Error).message });
  }

  const nowIso = now.toISOString();
  const { start, end } = getPeriod(s, now);
  await userPatch(supabase_url, anon_key, `/report_schedules?id=eq.${s.id}`, {
    last_sent_at: nowIso,
    next_send_at: getNextSendAt(s, now).toISOString(),
  });
  await userPost(supabase_url, anon_key, "report_delivery_log", {
    schedule_id: s.id, user_id: s.user_id, status: "success",
    period_start: format(start, "yyyy-MM-dd"),
    period_end: format(end, "yyyy-MM-dd"),
    error_message: null,
  }).catch(() => {});

  return res.status(200).json({ success: true, sentTo: s.email });
}
