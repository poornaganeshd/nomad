import type { VercelRequest, VercelResponse } from "@vercel/node";
import webpush from "web-push";

// Web Push support endpoint.
//
//   GET  /api/push                     → { publicKey }  (VAPID public key for
//                                        the client's pushManager.subscribe)
//   POST /api/push { subscription }    → fires a fixed test notification at
//                                        that subscription, exercising the
//                                        full server→push-service→SW path.
//
// Env (owner setup, generate once with `npx web-push generate-vapid-keys`):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto: or https: URL)
//
// The POST body's content is fixed server-side — a caller can only trigger the
// canned test message, never arbitrary text, so the endpoint can't be abused
// as a push spam relay. Possessing a subscription object is itself the
// capability: push endpoints are unguessable capability URLs.

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  ?? "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY ?? "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT ?? "mailto:nomad-app@example.com";

interface SubscriptionBody {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    if (!VAPID_PUBLIC) {
      return res.status(503).json({ error: "Web Push isn't configured — set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT in Vercel env (npx web-push generate-vapid-keys)" });
    }
    return res.status(200).json({ publicKey: VAPID_PUBLIC });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return res.status(503).json({ error: "Web Push isn't configured — set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in Vercel env" });
  }

  const { subscription } = (req.body ?? {}) as { subscription?: SubscriptionBody };
  const endpoint = subscription?.endpoint ?? "";
  if (!endpoint.startsWith("https://") || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: "Invalid subscription — expected { endpoint, keys: { p256dh, auth } }" });
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  try {
    await webpush.sendNotification(
      subscription as webpush.PushSubscription,
      JSON.stringify({
        title: "NOMAD test 🦁",
        body: "Push is working — bill & IOU reminders will arrive here even when the app is closed.",
        tag: "nomad-test",
        url: "/",
      }),
    );
    return res.status(200).json({ ok: true });
  } catch (e) {
    const status = (e as { statusCode?: number })?.statusCode;
    if (status === 404 || status === 410) {
      return res.status(410).json({ error: "Subscription expired — disable and re-enable push on that device", expired: true });
    }
    if (status === 403 || status === 401) {
      // Push services reject with 401/403 when the VAPID signing key doesn't
      // match the key the device subscribed under — mismatched env values or
      // keys rotated after subscribing.
      return res.status(403).json({ error: "VAPID key mismatch (403) — verify VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are from the same generate run (no quotes/spaces), redeploy, then Disable and re-enable push on this device", mismatch: true });
    }
    console.error("[push] test send failed:", (e as Error).message);
    return res.status(502).json({ error: `Push service rejected the send (${status ?? "network"})` });
  }
}
