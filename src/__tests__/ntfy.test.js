import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  getNtfyConfig,
  saveNtfyConfig,
  isNtfyConfigured,
  ntfyUrl,
  ntfyMeta,
  publishNtfy,
} from "../ntfy";

describe("ntfy config", () => {
  beforeEach(() => localStorage.clear());

  it("returns disabled defaults when nothing stored", () => {
    const c = getNtfyConfig();
    expect(c).toEqual({ enabled: false, server: "https://ntfy.sh", topic: "" });
  });

  it("round-trips saved config", () => {
    saveNtfyConfig({ enabled: true, server: "https://ntfy.sh", topic: "nomad-alerts" });
    expect(getNtfyConfig()).toEqual({ enabled: true, server: "https://ntfy.sh", topic: "nomad-alerts" });
  });

  it("trims topic, strips trailing slashes on server, defaults empty server", () => {
    const saved = saveNtfyConfig({ enabled: true, server: "https://push.example.com///", topic: "  my-topic  " });
    expect(saved).toEqual({ enabled: true, server: "https://push.example.com", topic: "my-topic" });
    const savedDefault = saveNtfyConfig({ enabled: true, server: "", topic: "x" });
    expect(savedDefault.server).toBe("https://ntfy.sh");
  });

  it("survives corrupt localStorage", () => {
    localStorage.setItem("nomad-ntfy-v1", "{not json");
    expect(getNtfyConfig()).toEqual({ enabled: false, server: "https://ntfy.sh", topic: "" });
  });

  it("isNtfyConfigured requires enabled + topic + server", () => {
    expect(isNtfyConfigured({ enabled: true, server: "https://ntfy.sh", topic: "t" })).toBe(true);
    expect(isNtfyConfigured({ enabled: false, server: "https://ntfy.sh", topic: "t" })).toBe(false);
    expect(isNtfyConfigured({ enabled: true, server: "https://ntfy.sh", topic: "" })).toBe(false);
    expect(isNtfyConfigured(null)).toBe(false);
  });
});

describe("ntfyUrl", () => {
  it("joins server + encoded topic and strips trailing slash", () => {
    expect(ntfyUrl("https://ntfy.sh/", "nomad")).toBe("https://ntfy.sh/nomad");
    expect(ntfyUrl("https://ntfy.sh", "a b")).toBe("https://ntfy.sh/a%20b");
  });

  it("throws when topic is empty", () => {
    expect(() => ntfyUrl("https://ntfy.sh", "")).toThrow(/topic/);
  });
});

describe("ntfyMeta", () => {
  it("maps types to priority + tags", () => {
    expect(ntfyMeta("warn").priority).toBe("high");
    expect(ntfyMeta("error").priority).toBe("urgent");
    expect(ntfyMeta("info").tags).toContain("bell");
    expect(ntfyMeta("whatever").priority).toBe("default");
  });
});

describe("publishNtfy", () => {
  afterEach(() => vi.restoreAllMocks());

  const cfg = { enabled: true, server: "https://ntfy.sh", topic: "nomad-alerts" };

  it("skips silently when not configured", async () => {
    const fetchMock = vi.fn();
    const r = await publishNtfy({ enabled: false, server: "https://ntfy.sh", topic: "t" }, {}, fetchMock);
    expect(r).toEqual({ ok: false, skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs to the topic URL with title/priority/tags headers and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const r = await publishNtfy(cfg, { title: "Bill due", message: "Rent is due", type: "warn" }, fetchMock);
    expect(r).toEqual({ ok: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://ntfy.sh/nomad-alerts");
    expect(opts.method).toBe("POST");
    expect(opts.body).toBe("Rent is due");
    expect(opts.headers.Title).toBe("Bill due");
    expect(opts.headers.Priority).toBe("high");
    expect(opts.headers.Tags).toBe("warning,money_with_wings");
  });

  it("keeps non-ASCII (₹) in the body but strips it from the Title header", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await publishNtfy(cfg, { title: "Owe ₹500", message: "You owe ₹500 — Alex" }, fetchMock);
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.body).toBe("You owe ₹500 — Alex");
    expect(opts.headers.Title).toBe("Owe 500");
    expect(/[^\x20-\x7E]/.test(opts.headers.Title)).toBe(false);
  });

  it("returns ok:false with error on network failure", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    const r = await publishNtfy(cfg, { message: "hi" }, fetchMock);
    expect(r).toEqual({ ok: false, error: "offline" });
  });

  it("reports non-ok HTTP status", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    const r = await publishNtfy(cfg, { message: "hi" }, fetchMock);
    expect(r).toEqual({ ok: false, status: 429 });
  });
});
