import type { VercelRequest, VercelResponse } from "@vercel/node";
import webPush from "web-push";
import { makeHeaders } from "./_shared.js";

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  ?? "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY ?? "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT     ?? "mailto:admin@nomad.app";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return res.status(503).json({ error: "VAPID keys not configured" });

  const { supabase_url, anon_key, title, body, tag, requireInteraction } = req.body ?? {};
  if (!supabase_url || !anon_key || !title) {
    return res.status(400).json({ error: "Missing supabase_url, anon_key, or title" });
  }

  const headers = makeHeaders(anon_key);
  let subs: any[] = [];
  try {
    const r = await fetch(`${supabase_url}/rest/v1/push_subscriptions?select=*`, { headers });
    if (!r.ok) return res.status(502).json({ error: `Supabase ${r.status}: ${await r.text().catch(() => "")}` });
    subs = (await r.json()) as any[];
  } catch (e) {
    return res.status(502).json({ error: (e as Error).message });
  }

  if (!subs.length) return res.status(200).json({ ok: true, sent: 0 });

  webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  const payload = JSON.stringify({ title, body: body ?? "", tag: tag ?? `nomad-${Date.now()}`, requireInteraction: !!requireInteraction });

  const stale: string[] = [];
  let sent = 0;
  await Promise.all(subs.map(async (s: any) => {
    const pushSub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    try {
      await webPush.sendNotification(pushSub, payload);
      sent++;
    } catch (err: any) {
      // 404/410 → subscription expired or unsubscribed
      if (err?.statusCode === 404 || err?.statusCode === 410) stale.push(s.endpoint);
    }
  }));

  // Best-effort cleanup of dead subscriptions
  if (stale.length) {
    await Promise.all(stale.map(ep =>
      fetch(`${supabase_url}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(ep)}`, { method: "DELETE", headers }).catch(() => {})
    ));
  }

  return res.status(200).json({ ok: true, sent, removed: stale.length });
}
