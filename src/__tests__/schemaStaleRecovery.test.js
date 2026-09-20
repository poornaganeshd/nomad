import { describe, it, expect, beforeEach, vi } from "vitest";

// Reproduces the reported failure: skipping a recurring bill against a Supabase
// whose `recurring` table predates the `type` column. PostgREST rejects the
// whole row, the write was dropped, and the next load restored the un-skipped
// row from remote — the bill came back after a refresh.

const PGRST204 = (col, table) => ({
  ok: false,
  status: 400,
  clone() { return this; },
  text: async () => JSON.stringify({
    code: "PGRST204",
    message: `Could not find the '${col}' column of '${table}' in the schema cache`,
  }),
});
const UNDEFINED_COLUMN = (col, table) => ({
  ok: false,
  status: 400,
  clone() { return this; },
  text: async () => JSON.stringify({
    code: "42703",
    message: `column "${col}" of relation "${table}" does not exist`,
  }),
});
const OK = { ok: true, status: 200, clone() { return this; }, text: async () => "" };

const skipWrite = (extra = {}) => ({
  path: "https://x.supabase.co/rest/v1/recurring",
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify([{ id: "r1", name: "Rent", amount: 1750, lastSkippedDate: "2026-09-20", type: "expense", ...extra }]),
  dedupeKey: null,
});

const bodyOf = (call) => JSON.parse(call[1].body);

describe("stale-schema write recovery", () => {
  beforeEach(() => { localStorage.clear(); vi.resetModules(); });

  it("retries without the missing column so the skip actually persists", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(PGRST204("type", "recurring"))
      .mockResolvedValueOnce(OK);
    const { sendSupabaseRequest, subscribeSyncDrops } = await import("../offlineSync.js");
    const drops = [];
    subscribeSyncDrops(i => drops.push(i));

    const res = await sendSupabaseRequest(skipWrite());

    expect(res.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);

    // The retry dropped only `type` — the skip itself still went to the server.
    const retried = bodyOf(global.fetch.mock.calls[1]);
    expect(retried[0]).not.toHaveProperty("type");
    expect(retried[0].lastSkippedDate).toBe("2026-09-20");
    expect(retried[0].id).toBe("r1");

    // Reported as a stale schema, not as a failed write.
    expect(drops.map(d => d.kind)).toEqual(["schema-stale"]);
    expect(drops[0].columns).toEqual(["type"]);
  });

  it("peels off several unknown columns in turn", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(PGRST204("type", "recurring"))
      .mockResolvedValueOnce(UNDEFINED_COLUMN("categoryName", "recurring"))
      .mockResolvedValueOnce(OK);
    const { sendSupabaseRequest, subscribeSyncDrops } = await import("../offlineSync.js");
    const drops = [];
    subscribeSyncDrops(i => drops.push(i));

    const res = await sendSupabaseRequest(skipWrite({ categoryName: "Rent / PG" }));

    expect(res.ok).toBe(true);
    expect(drops[0].columns).toEqual(["type", "categoryName"]);
    const final = bodyOf(global.fetch.mock.calls[2]);
    expect(final[0]).not.toHaveProperty("type");
    expect(final[0]).not.toHaveProperty("categoryName");
    expect(final[0].lastSkippedDate).toBe("2026-09-20");
  });

  it("still reports a genuine rejection when stripping does not help", async () => {
    // Removing the column exposes a NOT NULL violation — a real failure.
    global.fetch = vi.fn()
      .mockResolvedValueOnce(PGRST204("type", "recurring"))
      .mockResolvedValueOnce({
        ok: false, status: 400, clone() { return this; },
        text: async () => JSON.stringify({ code: "23502", message: 'null value in column "type" violates not-null constraint' }),
      });
    const { sendSupabaseRequest, subscribeSyncDrops } = await import("../offlineSync.js");
    const drops = [];
    subscribeSyncDrops(i => drops.push(i));

    const res = await sendSupabaseRequest(skipWrite());

    expect(res.ok).toBe(false);
    expect(drops.map(d => d.kind)).toEqual(["rejected"]);
  });

  it("never strips id, and does not retry when the row lacks the column", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(PGRST204("id", "recurring"));
    const { sendSupabaseRequest, subscribeSyncDrops } = await import("../offlineSync.js");
    const drops = [];
    subscribeSyncDrops(i => drops.push(i));

    const res = await sendSupabaseRequest(skipWrite());

    expect(res.ok).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(drops.map(d => d.kind)).toEqual(["rejected"]);
  });

  it("parses the column name out of both error dialects", async () => {
    const { missingColumnFrom } = await import("../offlineSync.js");
    expect(missingColumnFrom("Could not find the 'type' column of 'recurring' in the schema cache")).toBe("type");
    expect(missingColumnFrom('column "lastSkippedDate" of relation "recurring" does not exist')).toBe("lastSkippedDate");
    expect(missingColumnFrom("something else entirely")).toBeNull();
    expect(missingColumnFrom(null)).toBeNull();
  });
});
