// Client-side Web Push subscription management.
//
// This is the "real app" notification channel: the browser's own push system
// (the same one FCM/OneSignal wrap), so reminders land in the phone's
// notification shade with NOMAD's name and icon — no extra app installed.
//
// Flow: the user taps "Enable on this device" (Settings), which asks for
// notification permission, subscribes via the service worker's PushManager
// using the server's VAPID public key (fetched once from GET /api/push and
// cached), and hands the subscription JSON back to App.jsx, which stores it in
// the user's own Supabase `push_subscriptions` table for the daily cron.
//
// iOS requires the app to be installed to the home screen (iOS 16.4+) before
// PushManager exists — `isPushSupported()` returns false in plain iOS Safari,
// and the UI explains the one-tap install.

const VAPID_CACHE_KEY = "nomad-vapid-key";

export const isPushSupported = () =>
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window;

// Standard VAPID key conversion: URL-safe base64 → Uint8Array for
// pushManager.subscribe's applicationServerKey.
export function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Fetch the server's VAPID public key (GET /api/push), cached in localStorage
// so subsequent subscribes skip the round trip. `force` bypasses the cache —
// used to recover when the server key was rotated and the cached one is stale.
export async function getVapidPublicKey(fetchImpl = fetch, force = false) {
  if (!force) {
    const cached = localStorage.getItem(VAPID_CACHE_KEY);
    if (cached) return cached;
  }
  const r = await fetchImpl("/api/push");
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body?.error || `Couldn't reach the push server (${r.status})`);
  }
  const d = await r.json();
  if (!d?.publicKey) throw new Error("Push isn't configured on the server (missing VAPID keys)");
  localStorage.setItem(VAPID_CACHE_KEY, d.publicKey);
  return d.publicKey;
}

export async function getCurrentSubscription() {
  if (!isPushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub ? sub.toJSON() : null;
}

// True when an existing PushSubscription was created with the given VAPID
// public key. A subscription bound to a DIFFERENT key makes every server send
// fail with 403 — the push service checks the signing key against the one the
// subscription was created with. Returns true when the browser doesn't expose
// options.applicationServerKey (can't tell — assume it's fine).
export function subscriptionMatchesKey(sub, b64Key) {
  try {
    const raw = sub?.options?.applicationServerKey;
    if (!raw) return true;
    const cur = new Uint8Array(raw);
    const want = urlBase64ToUint8Array(b64Key);
    if (cur.length !== want.length) return false;
    for (let i = 0; i < cur.length; i++) { if (cur[i] !== want[i]) return false; }
    return true;
  } catch { return true; }
}

// Ask permission + subscribe this browser. Returns the subscription as plain
// JSON ({ endpoint, keys: { p256dh, auth } }) ready for the DB. Throws with a
// user-showable message on every failure path.
//
// Self-healing: always fetches the server's CURRENT key (bypassing the cache),
// and if an existing subscription is bound to a different key it is dropped
// and re-created — otherwise a rotated/corrected VAPID key would leave the
// device permanently 403ing with no way out but clearing site data.
export async function subscribeDevice(fetchImpl = fetch) {
  if (!isPushSupported()) {
    throw new Error("This browser can't receive push. On iPhone: Share → Add to Home Screen first, then enable here.");
  }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    throw new Error("Notification permission was denied — allow notifications for this site in browser settings.");
  }
  const reg = await navigator.serviceWorker.ready;
  const key = await getVapidPublicKey(fetchImpl, true);
  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    if (subscriptionMatchesKey(existing, key)) return existing.toJSON();
    await existing.unsubscribe().catch(() => { });
  }
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key),
  });
  return sub.toJSON();
}

// Unsubscribe this browser. Returns the endpoint that was removed (so the
// caller can delete its DB row) or null if there was nothing to remove.
export async function unsubscribeDevice() {
  if (!isPushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return null;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  return endpoint;
}

// Ask the server to fire a real push at this subscription (POST /api/push).
// This exercises the FULL path — server → push service → SW → notification
// shade — which is the only honest way to verify the feature works.
export async function sendTestPush(subscription, fetchImpl = fetch) {
  const r = await fetchImpl("/api/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error || `Test push failed (${r.status})`);
  return d;
}
