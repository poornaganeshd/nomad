import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock web-push before importing the handler.
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(),
  },
}));

import webpush from "web-push";
import handler from "../push.js";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const makeRes = () => {
  const res: Partial<VercelResponse> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as VercelResponse; }) as VercelResponse["status"];
  res.json = vi.fn((body: unknown) => { res.body = body; return res as VercelResponse; }) as VercelResponse["json"];
  return res as VercelResponse & { statusCode: number; body: { error?: string; publicKey?: string; ok?: boolean; expired?: boolean } };
};

const makeReq = (method: string, body?: unknown) => ({ method, body }) as VercelRequest;

const goodSub = { endpoint: "https://push.example.com/x", keys: { p256dh: "p", auth: "a" } };

describe("/api/push", () => {
  beforeEach(() => {
    process.env.VAPID_PUBLIC_KEY = "test-pub";
    process.env.VAPID_PRIVATE_KEY = "test-priv";
    process.env.VAPID_SUBJECT = "mailto:t@t.dev";
    vi.resetModules();
  });
  afterEach(() => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
    vi.clearAllMocks();
  });

  // The handler reads env at module load — re-import per test for env changes.
  const freshHandler = async () => (await import("../push.js")).default as typeof handler;

  it("GET returns the public key", async () => {
    const h = await freshHandler();
    const res = makeRes();
    await h(makeReq("GET"), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.publicKey).toBe("test-pub");
  });

  it("GET returns 503 with setup hint when keys are missing", async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    const h = await freshHandler();
    const res = makeRes();
    await h(makeReq("GET"), res);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/generate-vapid-keys/);
  });

  it("POST rejects malformed subscriptions with 400", async () => {
    const h = await freshHandler();
    for (const bad of [undefined, {}, { subscription: {} }, { subscription: { endpoint: "http://insecure", keys: { p256dh: "p", auth: "a" } } }, { subscription: { endpoint: "https://ok", keys: { p256dh: "p" } } }]) {
      const res = makeRes();
      await h(makeReq("POST", bad), res);
      expect(res.statusCode).toBe(400);
    }
  });

  it("POST sends a test notification and returns ok", async () => {
    const h = await freshHandler();
    (webpush.sendNotification as ReturnType<typeof vi.fn>).mockResolvedValue({ statusCode: 201 });
    const res = makeRes();
    await h(makeReq("POST", { subscription: goodSub }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    const [sub, payload] = (webpush.sendNotification as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((sub as typeof goodSub).endpoint).toBe(goodSub.endpoint);
    const parsed = JSON.parse(payload as string);
    expect(parsed.title).toContain("NOMAD");
    expect(parsed.tag).toBe("nomad-test");
  });

  it("POST maps 410 from the push service to expired", async () => {
    const h = await freshHandler();
    const err = new Error("Gone") as Error & { statusCode: number };
    err.statusCode = 410;
    (webpush.sendNotification as ReturnType<typeof vi.fn>).mockRejectedValue(err);
    const res = makeRes();
    await h(makeReq("POST", { subscription: goodSub }), res);
    expect(res.statusCode).toBe(410);
    expect(res.body.expired).toBe(true);
  });

  it("rejects other methods with 405", async () => {
    const h = await freshHandler();
    const res = makeRes();
    await h(makeReq("DELETE"), res);
    expect(res.statusCode).toBe(405);
  });
});
