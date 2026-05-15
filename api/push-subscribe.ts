import type { VercelRequest, VercelResponse } from "@vercel/node";
import { makeHeaders } from "./_shared.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { subscription, supabase_url, anon_key } = req.body ?? {};
  if (!subscription?.endpoint || !supabase_url || !anon_key) {
    return res.status(400).json({ error: "Missing subscription, supabase_url, or anon_key" });
  }

  const row = {
    endpoint: subscription.endpoint,
    p256dh:   subscription.keys?.p256dh ?? "",
    auth:     subscription.keys?.auth   ?? "",
  };

  const headers = { ...makeHeaders(anon_key), Prefer: "resolution=merge-duplicates" };
  let r: Response;
  try {
    r = await fetch(`${supabase_url}/rest/v1/push_subscriptions`, {
      method: "POST", headers, body: JSON.stringify(row),
    });
  } catch (e) {
    return res.status(502).json({ error: (e as Error).message });
  }

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    return res.status(502).json({ error: `Supabase ${r.status}: ${text}` });
  }
  return res.status(200).json({ ok: true });
}
