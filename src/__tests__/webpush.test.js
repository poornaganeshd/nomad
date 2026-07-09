import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isPushSupported,
  urlBase64ToUint8Array,
  getVapidPublicKey,
  subscribeDevice,
  unsubscribeDevice,
  getCurrentSubscription,
  sendTestPush,
} from "../webpush";

// jsdom has no PushManager/Notification — install controllable fakes.
const FAKE_KEY = "BPfKF0AsRy2tj7Op6H2q1QwZ8Yv7Fh3sBqmzC1TnGKlR5eXW9dJvNwq4iYxUuHkT2LhVgD8cA0M7pOI6E5nSmQE";

function makeSubscription(endpoint = "https://push.example.com/sub/abc") {
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
}

function installPushEnv({ permission = "granted", existingSub = null, subscribeError = null } = {}) {
  const pushManager = {
    getSubscription: vi.fn().mockResolvedValue(existingSub),
    subscribe: subscribeError
      ? vi.fn().mockRejectedValueOnce(subscribeError).mockResolvedValue(makeSubscription())
      : vi.fn().mockResolvedValue(makeSubscription()),
  };
  const registration = { pushManager };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { ready: Promise.resolve(registration) },
  });
  globalThis.PushManager = function PushManager() {};
  globalThis.Notification = { requestPermission: vi.fn().mockResolvedValue(permission), permission };
  return { pushManager };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.PushManager;
  delete globalThis.Notification;
});

describe("isPushSupported", () => {
  it("is false without PushManager (plain iOS Safari)", () => {
    delete globalThis.PushManager;
    expect(isPushSupported()).toBe(false);
  });
  it("is true with SW + PushManager + Notification", () => {
    installPushEnv();
    expect(isPushSupported()).toBe(true);
  });
});

describe("urlBase64ToUint8Array", () => {
  it("decodes URL-safe base64 with correct byte values", () => {
    // "-_" is URL-safe for "+/" → 0xFB 0xEF... spot-check known bytes
    const out = urlBase64ToUint8Array("AQAB");
    expect(out).toBeInstanceOf(Uint8Array);
    expect([...out]).toEqual([1, 0, 1]);
  });
  it("handles unpadded input (VAPID keys have no padding)", () => {
    expect(() => urlBase64ToUint8Array(FAKE_KEY)).not.toThrow();
    expect(urlBase64ToUint8Array(FAKE_KEY).length).toBe(65);
  });
});

describe("getVapidPublicKey", () => {
  it("fetches from /api/push and caches in localStorage", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ publicKey: FAKE_KEY }) });
    expect(await getVapidPublicKey(fetchMock)).toBe(FAKE_KEY);
    expect(await getVapidPublicKey(fetchMock)).toBe(FAKE_KEY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("nomad-vapid-key")).toBe(FAKE_KEY);
  });
  it("force bypasses the cache", async () => {
    localStorage.setItem("nomad-vapid-key", "stale");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ publicKey: FAKE_KEY }) });
    expect(await getVapidPublicKey(fetchMock, true)).toBe(FAKE_KEY);
  });
  it("throws a clear error when server has no keys", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: "VAPID keys not configured" }) });
    await expect(getVapidPublicKey(fetchMock)).rejects.toThrow(/VAPID keys not configured/);
  });
});

describe("subscribeDevice", () => {
  it("throws the iPhone hint when unsupported", async () => {
    delete globalThis.PushManager;
    await expect(subscribeDevice()).rejects.toThrow(/Add to Home Screen/);
  });

  it("throws when permission is denied", async () => {
    installPushEnv({ permission: "denied" });
    await expect(subscribeDevice()).rejects.toThrow(/denied/);
  });

  it("returns existing subscription without re-subscribing", async () => {
    const existing = makeSubscription("https://push.example.com/existing");
    const { pushManager } = installPushEnv({ existingSub: existing });
    const sub = await subscribeDevice(vi.fn());
    expect(sub.endpoint).toBe("https://push.example.com/existing");
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });

  it("subscribes with the fetched VAPID key", async () => {
    const { pushManager } = installPushEnv();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ publicKey: FAKE_KEY }) });
    const sub = await subscribeDevice(fetchMock);
    expect(sub.endpoint).toBe("https://push.example.com/sub/abc");
    const arg = pushManager.subscribe.mock.calls[0][0];
    expect(arg.userVisibleOnly).toBe(true);
    expect(arg.applicationServerKey).toBeInstanceOf(Uint8Array);
  });

  it("retries once with a fresh key after a stale-key failure", async () => {
    const { pushManager } = installPushEnv({ subscribeError: new Error("InvalidAccessError") });
    localStorage.setItem("nomad-vapid-key", "stale-key0");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ publicKey: FAKE_KEY }) });
    const sub = await subscribeDevice(fetchMock);
    expect(sub.endpoint).toBe("https://push.example.com/sub/abc");
    expect(pushManager.subscribe).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem("nomad-vapid-key")).toBe(FAKE_KEY);
  });
});

describe("unsubscribeDevice / getCurrentSubscription", () => {
  it("unsubscribes and returns the endpoint", async () => {
    const existing = makeSubscription("https://push.example.com/gone");
    installPushEnv({ existingSub: existing });
    expect(await unsubscribeDevice()).toBe("https://push.example.com/gone");
    expect(existing.unsubscribe).toHaveBeenCalled();
  });
  it("returns null when nothing subscribed", async () => {
    installPushEnv();
    expect(await unsubscribeDevice()).toBeNull();
    expect(await getCurrentSubscription()).toBeNull();
  });
  it("getCurrentSubscription returns JSON of active sub", async () => {
    installPushEnv({ existingSub: makeSubscription("https://push.example.com/cur") });
    expect((await getCurrentSubscription()).endpoint).toBe("https://push.example.com/cur");
  });
});

describe("sendTestPush", () => {
  it("POSTs the subscription and returns server result", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    const r = await sendTestPush({ endpoint: "e", keys: {} }, fetchMock);
    expect(r.ok).toBe(true);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/push");
    expect(JSON.parse(opts.body).subscription.endpoint).toBe("e");
  });
  it("surfaces server error messages", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: "VAPID keys not configured" }) });
    await expect(sendTestPush({}, fetchMock)).rejects.toThrow(/VAPID keys not configured/);
  });
});
