import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

vi.mock("nodemailer", () => ({ default: { createTransport: vi.fn(() => ({ sendMail: vi.fn().mockResolvedValue({}) })) } }));
vi.mock("../_shared.js", () => ({
  userGet: vi.fn(async () => []),
  userPatch: vi.fn(async () => {}),
  userPost: vi.fn(async () => {}),
  getPeriod: vi.fn(() => ({ start: "2026-08-01", end: "2026-08-31" })),
  getNextSendAt: vi.fn(() => "2026-09-01T02:00:00Z"),
  processSchedule: vi.fn(async () => ({ html: "<p/>", subject: "s" })),
}));

// /api/send-now sends email through the OWNER's Gmail account. Without the
// registry check anyone could stand up their own Supabase project and relay
// spam through it, so the gate — and the fact that it fails CLOSED — is the
// part worth pinning.

const OWNER = "https://ownerreftwentychar.supabase.co";
const OTHER = "https://strangerrefabcdefgh.supabase.co";

const makeRes = () => {
  const res: Partial<VercelResponse> & { statusCode?: number; body?: { error?: string } } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as VercelResponse; }) as VercelResponse["status"];
  res.json = vi.fn((body: unknown) => { res.body = body as { error?: string }; return res as VercelResponse; }) as VercelResponse["json"];
  return res as VercelResponse & { statusCode: number; body: { error?: string } };
};
const makeReq = (method: string, body?: unknown) => ({ method, body }) as VercelRequest;

// Env is read at module load, so re-import per test.
const freshHandler = async () => (await import("../send-now.js")).default;

describe("/api/send-now — caller authorization", () => {
  beforeEach(() => {
    process.env.GMAIL_USER = "owner@example.com";
    process.env.GMAIL_APP_PASSWORD = "app-pass";
    process.env.VITE_SUPABASE_URL = OWNER;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
    vi.resetModules();
    global.fetch = vi.fn() as unknown as typeof fetch;
  });
  afterEach(() => {
    delete process.env.GMAIL_USER; delete process.env.GMAIL_APP_PASSWORD;
    delete process.env.VITE_SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    vi.restoreAllMocks();
  });

  const ok = (rows: unknown) => ({ ok: true, status: 200, json: async () => rows });

  it("rejects anything but POST", async () => {
    const h = await freshHandler();
    const res = makeRes();
    await h(makeReq("GET"), res);
    expect(res.statusCode).toBe(405);
  });

  it("requires both supabase_url and anon_key", async () => {
    const h = await freshHandler();
    const res = makeRes();
    await h(makeReq("POST", { supabase_url: OTHER }), res);
    expect(res.statusCode).toBe(400);
  });

  it("REFUSES a caller that is not in the registry", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(ok([]));
    const h = await freshHandler();
    const res = makeRes();
    await h(makeReq("POST", { supabase_url: OTHER, anon_key: "anon" }), res);
    expect(res.statusCode).toBe(403);
  });

  it("fails CLOSED when the registry cannot be reached", async () => {
    // A lookup that errors must not fall through to sending — that would make
    // the gate bypassable by anyone who can make the registry flaky.
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network"));
    const h = await freshHandler();
    const res = makeRes();
    await h(makeReq("POST", { supabase_url: OTHER, anon_key: "anon" }), res);
    expect(res.statusCode).toBe(503);
  });

  it("fails CLOSED when the registry answers with an error status", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const h = await freshHandler();
    const res = makeRes();
    await h(makeReq("POST", { supabase_url: OTHER, anon_key: "anon" }), res);
    expect(res.statusCode).toBe(503);
  });

  it("lets a REGISTERED caller through the gate", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(ok([{ supabase_url: OTHER }]));
    const h = await freshHandler();
    const res = makeRes();
    await h(makeReq("POST", { supabase_url: OTHER, anon_key: "anon" }), res);
    // Past the gate: it got as far as looking for a schedule (mocked empty).
    expect(res.statusCode).toBe(404);
  });

  it("lets the owner's own URL through without a lookup", async () => {
    const h = await freshHandler();
    const res = makeRes();
    await h(makeReq("POST", { supabase_url: OWNER, anon_key: "anon" }), res);
    expect(res.statusCode).toBe(404);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("refuses to run at all when Gmail is unconfigured", async () => {
    delete process.env.GMAIL_USER;
    vi.resetModules();
    const h = await freshHandler();
    const res = makeRes();
    await h(makeReq("POST", { supabase_url: OWNER, anon_key: "anon" }), res);
    expect(res.statusCode).toBe(500);
  });

  it("refuses to run when the registry env is unconfigured", async () => {
    // No registry means no way to check — it must not default to open.
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    vi.resetModules();
    const h = await freshHandler();
    const res = makeRes();
    await h(makeReq("POST", { supabase_url: OTHER, anon_key: "anon" }), res);
    expect(res.statusCode).toBe(500);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
