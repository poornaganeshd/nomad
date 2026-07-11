import { describe, it, expect, vi } from "vitest";
import { vapidFromEnv, sendToSubscriptions, type PushSubRow, type VapidConfig } from "../_webpush.js";

const vapid: VapidConfig = { publicKey: "pub", privateKey: "priv", subject: "mailto:t@t.dev" };

const row = (endpoint: string): PushSubRow => ({
  endpoint,
  subscription: { endpoint, keys: { p256dh: "p", auth: "a" } },
});

type Sender = Parameters<typeof sendToSubscriptions>[3];

const makeSender = (impl?: (sub: unknown) => Promise<unknown>) => ({
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(impl ?? (async () => ({ statusCode: 201 }))),
}) as unknown as Sender & { setVapidDetails: ReturnType<typeof vi.fn>; sendNotification: ReturnType<typeof vi.fn> };

describe("vapidFromEnv", () => {
  it("returns null when keys are missing", () => {
    expect(vapidFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(vapidFromEnv({ VAPID_PUBLIC_KEY: "x" } as NodeJS.ProcessEnv)).toBeNull();
  });
  it("returns config with default subject", () => {
    const v = vapidFromEnv({ VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" } as NodeJS.ProcessEnv)!;
    expect(v.publicKey).toBe("pub");
    expect(v.subject).toMatch(/^mailto:/);
  });
  it("honours VAPID_SUBJECT", () => {
    const v = vapidFromEnv({ VAPID_PUBLIC_KEY: "p", VAPID_PRIVATE_KEY: "k", VAPID_SUBJECT: "https://nomad.app" } as NodeJS.ProcessEnv)!;
    expect(v.subject).toBe("https://nomad.app");
  });
});

describe("sendToSubscriptions", () => {
  it("sends the JSON payload to every subscription", async () => {
    const sender = makeSender();
    const r = await sendToSubscriptions([row("e1"), row("e2")], { title: "Bills", body: "Rent due" }, vapid, sender);
    expect(r).toEqual({ sent: 2, failed: 0, expired: [] });
    expect(sender.setVapidDetails).toHaveBeenCalledWith("mailto:t@t.dev", "pub", "priv");
    const [sub, body] = sender.sendNotification.mock.calls[0];
    expect((sub as { endpoint: string }).endpoint).toBe("e1");
    expect(JSON.parse(body as string)).toEqual({ title: "Bills", body: "Rent due" });
  });

  it("collects 410/404 endpoints as expired, counts other failures", async () => {
    const sender = makeSender(async (sub) => {
      const ep = (sub as { endpoint: string }).endpoint;
      if (ep === "gone") { const e = new Error("Gone") as Error & { statusCode: number }; e.statusCode = 410; throw e; }
      if (ep === "flaky") throw new Error("network");
      return { statusCode: 201 };
    });
    const r = await sendToSubscriptions([row("ok"), row("gone"), row("flaky")], { title: "t", body: "b" }, vapid, sender);
    expect(r.sent).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.expired).toEqual(["gone"]);
  });

  it("tolerates empty/malformed rows without throwing", async () => {
    const sender = makeSender();
    const r = await sendToSubscriptions([{ endpoint: "x", subscription: null } as unknown as PushSubRow], { title: "t", body: "b" }, vapid, sender);
    expect(r).toEqual({ sent: 0, failed: 1, expired: [] });
    const empty = await sendToSubscriptions([], { title: "t", body: "b" }, vapid, sender);
    expect(empty).toEqual({ sent: 0, failed: 0, expired: [] });
  });
});
