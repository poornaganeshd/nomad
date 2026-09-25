import { describe, it, expect, vi } from "vitest";
import { fetchAllRows, totalFromContentRange } from "../sbPaging";

// A fake PostgREST that clamps every page to `cap` rows, like Supabase's
// "Max rows" setting — whatever `limit` the URL asks for.
const fakeServer = (n, { cap = 1000, sendRange = true, failAtOffset = null } = {}) => {
  const all = Array.from({ length: n }, (_, i) => ({ id: String(i).padStart(6, "0") }));
  return vi.fn(async (url) => {
    const u = new URL(url);
    const limit = Number(u.searchParams.get("limit"));
    const offset = Number(u.searchParams.get("offset"));
    if (failAtOffset != null && offset === failAtOffset) return { ok: false, status: 500, headers: new Map(), json: async () => ({}) };
    const page = all.slice(offset, offset + Math.min(limit, cap));
    const headers = new Map(sendRange ? [["content-range", `${offset}-${offset + page.length - 1}/${n}`]] : []);
    return { ok: true, status: 200, headers, json: async () => page };
  });
};

describe("totalFromContentRange", () => {
  it("reads the total after the slash", () => {
    expect(totalFromContentRange("0-999/2345")).toBe(2345);
    expect(totalFromContentRange("*/0")).toBe(0);
    expect(totalFromContentRange("0-999/*")).toBe(null);
    expect(totalFromContentRange(null)).toBe(null);
  });
});

describe("fetchAllRows", () => {
  it("returns every row past Supabase's 1000-row cap", async () => {
    const f = fakeServer(2345);
    const r = await fetchAllRows(f, "https://x.supabase.co/rest/v1/expenses?select=*", {});
    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(2345);
    expect(new Set(r.rows.map(x => x.id)).size).toBe(2345);
    expect(f).toHaveBeenCalledTimes(3);
    expect(f.mock.calls[0][0]).toContain("order=id.asc");
  });

  it("follows a server cap smaller than the page size", async () => {
    const r = await fetchAllRows(fakeServer(1200, { cap: 500 }), "https://x/rest/v1/t?select=*", {});
    expect(r.rows).toHaveLength(1200);
  });

  it("makes one request for a small table", async () => {
    const f = fakeServer(12);
    const r = await fetchAllRows(f, "https://x/rest/v1/t?select=*", {});
    expect(r.rows).toHaveLength(12);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("still pages without a Content-Range header", async () => {
    const r = await fetchAllRows(fakeServer(2500, { sendRange: false }), "https://x/rest/v1/t?select=*", {});
    expect(r.rows).toHaveLength(2500);
  });

  it("fails the whole read when a later page fails — never a partial table", async () => {
    const r = await fetchAllRows(fakeServer(2500, { failAtOffset: 1000 }), "https://x/rest/v1/t?select=*", {});
    expect(r).toEqual({ ok: false, status: 500 });
  });

  it("passes a first-page error status through", async () => {
    const f = vi.fn(async () => ({ ok: false, status: 400, headers: new Map(), json: async () => ({}) }));
    expect(await fetchAllRows(f, "https://x/rest/v1/t?select=*", {})).toEqual({ ok: false, status: 400 });
  });

  it("orders by the column it is told to", async () => {
    const f = fakeServer(3);
    await fetchAllRows(f, "https://x/rest/v1/wallet_balances?select=*", {}, { orderCol: "wallet_id" });
    expect(f.mock.calls[0][0]).toContain("order=wallet_id.asc");
  });
});
