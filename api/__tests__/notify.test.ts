import { describe, it, expect, vi } from "vitest";
import {
  getRecurringDueDate,
  isRecurringDueToday,
  buildBillDigest,
  publishNtfyServer,
  istTodayStr,
  type RecurringRow,
  type SplitRow,
} from "../_notify.js";

const rec = (o: Partial<RecurringRow> = {}): RecurringRow => ({
  id: "r1", name: "Rent", amount: 15000, frequency: "monthly",
  dayOfMonth: 5, startDate: "2024-01-05", active: true,
  lastPaidDate: null, lastSkippedDate: null, ...o,
});

describe("getRecurringDueDate (server port)", () => {
  it("computes the monthly due date on dayOfMonth", () => {
    expect(getRecurringDueDate(rec(), "2024-06-10")).toBe("2024-06-05");
  });
  it("clamps dayOfMonth to the last day of a short month", () => {
    expect(getRecurringDueDate(rec({ dayOfMonth: 31, startDate: "2024-01-31" }), "2024-02-29")).toBe("2024-02-29");
  });
  it("handles custom interval anchored on last action", () => {
    const r = rec({ frequency: "custom", intervalDays: 7, startDate: "2024-06-01", lastPaidDate: "2024-06-08" });
    expect(getRecurringDueDate(r, "2024-06-20")).toBe("2024-06-15");
  });
  it("returns start date as first custom occurrence", () => {
    const r = rec({ frequency: "custom", intervalDays: 30, startDate: "2024-06-01" });
    expect(getRecurringDueDate(r, "2024-06-01")).toBe("2024-06-01");
  });
  it("returns null before the start date", () => {
    expect(getRecurringDueDate(rec({ startDate: "2025-01-01" }), "2024-06-10")).toBeNull();
  });
});

describe("isRecurringDueToday (server port)", () => {
  it("is due on the day of month when unpaid", () => {
    expect(isRecurringDueToday(rec(), "2024-06-05")).toBe(true);
  });
  it("is not due once paid this month", () => {
    expect(isRecurringDueToday(rec({ lastPaidDate: "2024-06-05" }), "2024-06-05")).toBe(false);
  });
  it("stays due (overdue) after the due day when unpaid", () => {
    expect(isRecurringDueToday(rec(), "2024-06-09")).toBe(true);
  });
  it("ignores inactive bills", () => {
    expect(isRecurringDueToday(rec({ active: false }), "2024-06-05")).toBe(false);
  });
});

describe("buildBillDigest", () => {
  it("returns null when nothing is due", () => {
    expect(buildBillDigest([rec({ lastPaidDate: "2024-06-05" })], [], "2024-06-05")).toBeNull();
  });

  it("summarises a due-today bill with high priority", () => {
    const d = buildBillDigest([rec()], [], "2024-06-05")!;
    expect(d).not.toBeNull();
    expect(d.count).toBe(1);
    expect(d.priority).toBe("high");
    expect(d.title).toBe("1 bill due");
    expect(d.message).toContain("Rent");
    expect(d.message).toContain("₹15,000");
    expect(d.message).toContain("due today");
  });

  it("flags overdue days", () => {
    const d = buildBillDigest([rec()], [], "2024-06-08")!;
    expect(d.message).toContain("3 days overdue");
  });

  it("lists upcoming bills within 3 days as default priority", () => {
    // Paid last month, so the 8th of THIS month is a future (not overdue) due.
    const d = buildBillDigest([rec({ dayOfMonth: 8, startDate: "2024-01-08", lastPaidDate: "2024-05-08" })], [], "2024-06-06")!;
    expect(d.title).toBe("Upcoming bills");
    expect(d.priority).toBe("default");
    expect(d.message).toContain("in 2 days");
  });

  it("includes unsettled owed splits and raises priority", () => {
    const splits: SplitRow[] = [
      { id: "s1", name: "Dinner", amount: 500, direction: "owe", settled: false },
      { id: "s2", name: "Paid", amount: 100, direction: "owe", settled: true },
      { id: "s3", name: "Owed to me", amount: 200, direction: "owed", settled: false },
    ];
    const d = buildBillDigest([], splits, "2024-06-06")!;
    expect(d.count).toBe(1);
    expect(d.priority).toBe("high");
    expect(d.message).toContain("You owe ₹500 — Dinner");
    expect(d.message).not.toContain("Owed to me");
    expect(d.message).not.toContain("Paid");
  });
});

describe("publishNtfyServer", () => {
  it("POSTs to the topic with ASCII-safe title and UTF-8 body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const r = await publishNtfyServer("https://ntfy.sh/", "nomad-x", { title: "₹ Bills due", message: "You owe ₹500", priority: "high" }, fetchMock as unknown as typeof fetch);
    expect(r).toEqual({ ok: true, status: 200 });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://ntfy.sh/nomad-x");
    expect(opts.headers.Title).toBe("Bills due");
    expect(opts.headers.Priority).toBe("high");
    expect(opts.body).toBe("You owe ₹500");
  });

  it("no-ops without a topic", async () => {
    const fetchMock = vi.fn();
    const r = await publishNtfyServer("https://ntfy.sh", "", {}, fetchMock as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports network errors instead of throwing", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("down"));
    const r = await publishNtfyServer("https://ntfy.sh", "t", { message: "x" }, fetchMock as unknown as typeof fetch);
    expect(r).toEqual({ ok: false, error: "down" });
  });
});

describe("istTodayStr", () => {
  it("rolls to the next IST day for late-UTC times", () => {
    // 2024-06-05T20:00Z + 5:30 = 2024-06-06T01:30 IST
    expect(istTodayStr(new Date("2024-06-05T20:00:00Z"))).toBe("2024-06-06");
  });
  it("stays on the same day for early-UTC times", () => {
    expect(istTodayStr(new Date("2024-06-05T10:00:00Z"))).toBe("2024-06-05");
  });
});
