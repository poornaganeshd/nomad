import type { VercelRequest, VercelResponse } from "@vercel/node";
import webpush from "web-push";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { subscription, bills } = req.body as {
    subscription: webpush.PushSubscription;
    bills: Array<{ name: string; amount: number; dueLabel: string }>;
  };

  if (!subscription || !bills?.length) {
    return res.status(400).json({ error: "subscription and bills required" });
  }
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return res.status(503).json({ error: "VAPID keys not configured" });
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  const results: Array<{ name: string; ok: boolean }> = [];

  for (const bill of bills) {
    const payload = JSON.stringify({
      title: `Bill Due: ${bill.name}`,
      body: `₹${bill.amount} due ${bill.dueLabel}`,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { billName: bill.name, amount: bill.amount },
      actions: [
        { action: "paid", title: "Mark Paid" },
        { action: "snooze", title: "Snooze 1 day" },
      ],
    });
    try {
      await webpush.sendNotification(subscription, payload);
      results.push({ name: bill.name, ok: true });
    } catch {
      results.push({ name: bill.name, ok: false });
    }
  }

  return res.status(200).json({ ok: true, results });
}
