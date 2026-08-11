import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler from "../sync.js";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// /api/sync is a PUBLIC endpoint that forwards a caller-supplied URL together
// with the caller's headers (which carry the Supabase anon key). The host check
// is the only thing standing between that and an open relay, so it is the part
// worth pinning: an unanchored or substring match would let
// "<ref>.supabase.co.attacker.com" through and hand the key to whoever owns it.

const REF = "abcdefghijklmnopqrst"; // a real project ref is exactly 20 chars
const OK_URL = `https://${REF}.supabase.co/rest/v1/expenses`;

const makeRes = () => {
  const res: Partial<VercelResponse> & { statusCode?: number; body?: unknown; sent?: string; headers?: Record<string, string> } = { headers: {} };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as VercelResponse; }) as VercelResponse["status"];
  res.json = vi.fn((body: unknown) => { res.body = body; return res as VercelResponse; }) as VercelResponse["json"];
  res.setHeader = vi.fn((k: string, v: string) => { (res.headers as Record<string, string>)[k] = v; return res as VercelResponse; }) as unknown as VercelResponse["setHeader"];
  res.send = vi.fn((body: string) => { res.sent = body; return res as VercelResponse; }) as unknown as VercelResponse["send"];
  return res as VercelResponse & { statusCode: number; body: { error?: string }; sent?: string; headers: Record<string, string> };
};

const makeReq = (method: string, body?: unknown) => ({ method, body }) as VercelRequest;

const upstream = (status: number, text: string, contentType = "application/json") =>
  ({ ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text), headers: { get: () => contentType } });

describe("/api/sync — request guard", () => {
  beforeEach(() => { global.fetch = vi.fn() as unknown as typeof fetch; });
  afterEach(() => { vi.restoreAllMocks(); });

  it("rejects anything but POST", async () => {
    const res = makeRes();
    await handler(makeReq("GET"), res);
    expect(res.statusCode).toBe(405);
  });

  it("requires a method and a path", async () => {
    const res = makeRes();
    await handler(makeReq("POST", { method: "POST" }), res);
    expect(res.statusCode).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects a path that is not a URL at all", async () => {
    const res = makeRes();
    await handler(makeReq("POST", { method: "POST", path: "/rest/v1/expenses" }), res);
    expect(res.statusCode).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("/api/sync — SSRF host validation", () => {
  beforeEach(() => { global.fetch = vi.fn() as unknown as typeof fetch; });
  afterEach(() => { vi.restoreAllMocks(); });

  const refuse = async (path: string) => {
    const res = makeRes();
    await handler(makeReq("POST", { method: "GET", path }), res);
    return res;
  };

  it("forwards a genuine Supabase REST URL", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(upstream(200, "[]"));
    const res = makeRes();
    await handler(makeReq("POST", { method: "GET", path: OK_URL }), res);
    expect(res.statusCode).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(OK_URL, expect.objectContaining({ method: "GET" }));
  });

  it("refuses a look-alike host that merely STARTS with a valid ref", async () => {
    // The whole reason the regex is anchored. A prefix match would proxy the
    // caller's anon key straight to attacker.com.
    const res = await refuse(`https://${REF}.supabase.co.attacker.com/rest/v1/expenses`);
    expect(res.statusCode).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("refuses a host that merely CONTAINS supabase.co", async () => {
    const res = await refuse(`https://evil.com/?x=${REF}.supabase.co`);
    expect(res.statusCode).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("refuses a subdomain under a valid-looking ref", async () => {
    const res = await refuse(`https://x.${REF}.supabase.co/rest/v1/expenses`);
    expect(res.statusCode).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("refuses plain http, even on a real Supabase host", async () => {
    const res = await refuse(`http://${REF}.supabase.co/rest/v1/expenses`);
    expect(res.statusCode).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("refuses internal and metadata addresses", async () => {
    for (const url of [
      "https://169.254.169.254/latest/meta-data/",
      "https://localhost/rest/v1/expenses",
      "https://127.0.0.1/rest/v1/expenses",
      "http://[::1]/rest/v1/expenses",
    ]) {
      expect((await refuse(url)).statusCode).toBe(400);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("refuses non-http schemes", async () => {
    for (const url of ["file:///etc/passwd", "gopher://evil.com/", `ftp://${REF}.supabase.co/`]) {
      expect((await refuse(url)).statusCode).toBe(400);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("refuses a ref of the wrong length", async () => {
    expect((await refuse("https://short.supabase.co/rest/v1/x")).statusCode).toBe(400);
    expect((await refuse(`https://${REF}xx.supabase.co/rest/v1/x`)).statusCode).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("refuses userinfo smuggling of the real host", async () => {
    // https://<ref>.supabase.co@evil.com resolves to evil.com; URL parsing puts
    // the ref in `username`, so `hostname` must be what is checked, not `href`.
    const res = await refuse(`https://${REF}.supabase.co@evil.com/rest/v1/x`);
    expect(res.statusCode).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("/api/sync — proxying", () => {
  beforeEach(() => { global.fetch = vi.fn() as unknown as typeof fetch; });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns the upstream status, body and content type unchanged", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(upstream(409, '{"code":"23505"}', "application/json; charset=utf-8"));
    const res = makeRes();
    await handler(makeReq("POST", { method: "POST", path: OK_URL, body: "{}" }), res);
    expect(res.statusCode).toBe(409);
    expect(res.sent).toBe('{"code":"23505"}');
    expect(res.headers["Content-Type"]).toBe("application/json; charset=utf-8");
  });

  it("reports an upstream failure as 502 rather than pretending it worked", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ECONNREFUSED"));
    const res = makeRes();
    await handler(makeReq("POST", { method: "POST", path: OK_URL }), res);
    expect(res.statusCode).toBe(502);
  });

  it("reports an aborted upstream as 504", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(abort);
    const res = makeRes();
    await handler(makeReq("POST", { method: "POST", path: OK_URL }), res);
    expect(res.statusCode).toBe(504);
  });

  it("replays the cached result for a dedupeKey already applied", async () => {
    // Idempotency: the same queued write replayed after a reconnect must not
    // apply twice.
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(upstream(200, '[{"result":{"ok":true}}]'));
    const res = makeRes();
    await handler(makeReq("POST", { method: "POST", path: OK_URL, dedupeKey: "splits:abc", headers: { apikey: "anon" } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // Only the lookup ran — the write was never forwarded.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("forwards normally when the key has not been seen", async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(upstream(200, "[]"));           // lookup: no rows
    fetchMock.mockResolvedValueOnce(upstream(201, '{"id":"x"}'));   // the real write
    fetchMock.mockResolvedValue(upstream(200, ""));                 // fire-and-forget key store + prune
    const res = makeRes();
    await handler(makeReq("POST", { method: "POST", path: OK_URL, dedupeKey: "splits:abc", headers: { apikey: "anon" } }), res);
    expect(res.statusCode).toBe(201);
    expect(res.sent).toBe('{"id":"x"}');
  });

  it("still forwards when the idempotency lookup itself fails", async () => {
    // nomad_sync_keys may not exist yet on an un-migrated project — that must
    // degrade to a plain proxy, not a failed write.
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValueOnce(new Error("relation does not exist"));
    fetchMock.mockResolvedValueOnce(upstream(201, '{"id":"x"}'));
    fetchMock.mockResolvedValue(upstream(200, ""));
    const res = makeRes();
    await handler(makeReq("POST", { method: "POST", path: OK_URL, dedupeKey: "splits:abc", headers: { apikey: "anon" } }), res);
    expect(res.statusCode).toBe(201);
  });
});
