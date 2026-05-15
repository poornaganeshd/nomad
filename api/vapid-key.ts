import type { VercelRequest, VercelResponse } from "@vercel/node";

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY ?? "";

export default function handler(_req: VercelRequest, res: VercelResponse) {
  if (!PUBLIC_KEY) return res.status(503).json({ error: "Push not configured — add VAPID_PUBLIC_KEY to Vercel env vars" });
  res.setHeader("Cache-Control", "public, max-age=3600");
  return res.status(200).json({ publicKey: PUBLIC_KEY });
}
