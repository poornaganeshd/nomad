// Server-side Web Push delivery for the send-reports cron.
//
// Companion to _notify.ts: _notify builds the due-bill digest; this module
// fans it out to every browser subscription the user stored in their own
// Supabase `push_subscriptions` table (BYODB — one table per user's DB, rows
// written by src/webpush.js when they tap "Enable on this device").
//
// VAPID keys are the ONE piece of owner setup: generate once with
// `npx web-push generate-vapid-keys`, set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
// / VAPID_SUBJECT in Vercel env. Without them this leg silently no-ops.

import webpush from "web-push";

export interface PushSubRow {
  endpoint: string;
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
}

export interface VapidConfig { publicKey: string; privateKey: string; subject: string; }

export interface PushPayload { title: string; body: string; tag?: string; url?: string; }

export const vapidFromEnv = (env: NodeJS.ProcessEnv = process.env): VapidConfig | null => {
  const publicKey  = env.VAPID_PUBLIC_KEY  ?? "";
  const privateKey = env.VAPID_PRIVATE_KEY ?? "";
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject: env.VAPID_SUBJECT ?? "mailto:nomad-app@example.com" };
};

export interface FanoutResult { sent: number; failed: number; expired: string[]; }

// Send one payload to every subscription. Never throws: per-subscription
// failures are counted, and 404/410 (subscription gone — user cleared site
// data or revoked permission) endpoints are returned in `expired` so the
// caller can prune their DB rows. `sender` is injectable for tests.
export async function sendToSubscriptions(
  subs: PushSubRow[],
  payload: PushPayload,
  vapid: VapidConfig,
  sender: Pick<typeof webpush, "setVapidDetails" | "sendNotification"> = webpush,
): Promise<FanoutResult> {
  sender.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  const body = JSON.stringify(payload);
  const expired: string[] = [];
  let sent = 0, failed = 0;
  await Promise.all((subs || []).map(async (row) => {
    if (!row?.subscription?.endpoint) { failed++; return; }
    try {
      await sender.sendNotification(row.subscription as webpush.PushSubscription, body);
      sent++;
    } catch (e) {
      const sc = (e as { statusCode?: number })?.statusCode;
      if (sc === 404 || sc === 410) expired.push(row.endpoint || row.subscription.endpoint);
      else failed++;
    }
  }));
  return { sent, failed, expired };
}
