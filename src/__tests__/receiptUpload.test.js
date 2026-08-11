import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";

vi.mock("../credentials", () => ({ getCredentials: vi.fn() }));

import { getCredentials } from "../credentials";
import { uploadReceipt, isLocalReceipt } from "../receiptUpload.js";

// receiptUpload picks between three modes and silently falls back between them,
// which is exactly the shape of thing that breaks without anyone noticing: a
// receipt still "saves", it just quietly stops reaching Cloudinary.
//
// Every test drives a PDF, because that path skips compressImage() — canvas is
// not implemented in jsdom, so the image branch cannot be exercised here. The
// mode selection and fallback logic (the part with the decisions in it) is
// identical for both.

const pdf = () => new File([new Uint8Array([1, 2, 3])], "bill.pdf", { type: "application/pdf" });
const creds = (o) => { getCredentials.mockReturnValue(o); };
const okRes = (url = "https://res.cloudinary.com/x/image/upload/v1/r.jpg") =>
  ({ ok: true, status: 200, json: async () => ({ secure_url: url }) });

describe("isLocalReceipt", () => {
  it("recognises a data URL and nothing else", () => {
    expect(isLocalReceipt("data:image/jpeg;base64,abc")).toBe(true);
    expect(isLocalReceipt("https://res.cloudinary.com/x.jpg")).toBe(false);
    expect(isLocalReceipt(null)).toBe(false);
    expect(isLocalReceipt(undefined)).toBe(false);
    expect(isLocalReceipt(123)).toBe(false);
  });
});

describe("uploadReceipt — mode selection", () => {
  beforeEach(() => { global.fetch = vi.fn(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("stores locally when Cloudinary is not configured at all", async () => {
    creds({});
    const url = await uploadReceipt(pdf());
    expect(isLocalReceipt(url)).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("stores locally when there is a cloudName but no usable auth", async () => {
    creds({ cloudName: "demo" });
    const url = await uploadReceipt(pdf());
    expect(isLocalReceipt(url)).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("uses the UNSIGNED preset when there is no api secret", async () => {
    creds({ cloudName: "demo", uploadPreset: "nomad_unsigned" });
    global.fetch.mockResolvedValue(okRes());
    await uploadReceipt(pdf());
    const form = global.fetch.mock.calls[0][1].body;
    expect(form.get("upload_preset")).toBe("nomad_unsigned");
    expect(form.get("signature")).toBeNull();
  });

  it("prefers a SIGNED upload when key and secret are both present", async () => {
    creds({ cloudName: "demo", apiKey: "111", apiSecret: "shh", uploadPreset: "nomad_unsigned" });
    global.fetch.mockResolvedValue(okRes());
    await uploadReceipt(pdf());
    const form = global.fetch.mock.calls[0][1].body;
    expect(form.get("api_key")).toBe("111");
    expect(form.get("signature")).toBeTruthy();
    // Signed mode must not also send the preset — Cloudinary rejects the mix.
    expect(form.get("upload_preset")).toBeNull();
  });

  it("signs exactly what Cloudinary expects: sha1(timestamp=<ts><secret>)", async () => {
    // Cross-checked against node:crypto, i.e. a different SHA-1 implementation
    // than the Web Crypto one under test. A wrong signature is a 401 at upload
    // time and a silent fall back to local storage.
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    creds({ cloudName: "demo", apiKey: "111", apiSecret: "shh" });
    global.fetch.mockResolvedValue(okRes());
    await uploadReceipt(pdf());
    const form = global.fetch.mock.calls[0][1].body;
    const expected = createHash("sha1").update("timestamp=1700000000shh").digest("hex");
    expect(form.get("timestamp")).toBe("1700000000");
    expect(form.get("signature")).toBe(expected);
  });

  it("posts PDFs to /image/upload, not /raw/upload", async () => {
    // Most unsigned presets are scoped to resource_type=image and 400 on /raw.
    creds({ cloudName: "demo", uploadPreset: "p" });
    global.fetch.mockResolvedValue(okRes());
    await uploadReceipt(pdf());
    expect(global.fetch.mock.calls[0][0]).toBe("https://api.cloudinary.com/v1_1/demo/image/upload");
    expect(global.fetch.mock.calls[0][1].body.get("file")).toBeTruthy();
  });

  it("returns the secure_url on success", async () => {
    creds({ cloudName: "demo", uploadPreset: "p" });
    global.fetch.mockResolvedValue(okRes("https://res.cloudinary.com/demo/r.pdf"));
    expect(await uploadReceipt(pdf())).toBe("https://res.cloudinary.com/demo/r.pdf");
  });
});

describe("uploadReceipt — fallback", () => {
  beforeEach(() => { global.fetch = vi.fn(); vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("falls back to local storage when Cloudinary rejects the upload", async () => {
    creds({ cloudName: "demo", uploadPreset: "p" });
    global.fetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { message: "Upload preset not found" } }) });
    expect(isLocalReceipt(await uploadReceipt(pdf()))).toBe(true);
  });

  it("falls back to local storage on a network error", async () => {
    creds({ cloudName: "demo", uploadPreset: "p" });
    global.fetch.mockRejectedValue(new Error("Failed to fetch"));
    expect(isLocalReceipt(await uploadReceipt(pdf()))).toBe(true);
  });

  it("survives a rejection whose body is not JSON", async () => {
    creds({ cloudName: "demo", uploadPreset: "p" });
    global.fetch.mockResolvedValue({ ok: false, status: 502, json: async () => { throw new Error("not json"); } });
    expect(isLocalReceipt(await uploadReceipt(pdf()))).toBe(true);
  });
});

describe("uploadReceipt — throwOnFail surfaces the real reason", () => {
  beforeEach(() => { global.fetch = vi.fn(); vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  // The migrate-local-receipts flow needs the actual server message, not a
  // silent fallback — otherwise "nothing happened" is the only feedback.
  it("reports Cloudinary's own message", async () => {
    creds({ cloudName: "demo", uploadPreset: "p" });
    global.fetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { message: "Upload preset must be whitelisted" } }) });
    await expect(uploadReceipt(pdf(), { throwOnFail: true })).rejects.toThrow("Upload preset must be whitelisted");
  });

  it("falls back to the status code when there is no message", async () => {
    creds({ cloudName: "demo", uploadPreset: "p" });
    global.fetch.mockResolvedValue({ ok: false, status: 413, json: async () => ({}) });
    await expect(uploadReceipt(pdf(), { throwOnFail: true })).rejects.toThrow("413");
  });

  it("reports a missing cloudName instead of storing locally", async () => {
    creds({});
    await expect(uploadReceipt(pdf(), { throwOnFail: true })).rejects.toThrow(/cloudName/);
  });

  it("reports missing auth instead of storing locally", async () => {
    creds({ cloudName: "demo" });
    await expect(uploadReceipt(pdf(), { throwOnFail: true })).rejects.toThrow(/apiKey|uploadPreset/);
  });

  it("propagates a network error", async () => {
    creds({ cloudName: "demo", uploadPreset: "p" });
    global.fetch.mockRejectedValue(new Error("Failed to fetch"));
    await expect(uploadReceipt(pdf(), { throwOnFail: true })).rejects.toThrow("Failed to fetch");
  });
});
