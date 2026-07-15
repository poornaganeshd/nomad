import { describe, it, expect } from "vitest";
import { buildDailyInsight } from "../insights.js";

// Tue 2026-07-14, noon-anchored like the app's date math.
const NOW = new Date(2026, 6, 14, 9);
const e = (date, amount, extra = {}) => ({ id: date + ":" + amount, date, amount, categoryId: "food", walletId: "bank", ...extra });
// Realistic recurring row: startDate day matches dayOfMonth, previous cycle paid.
const rec = (dom, over = {}) => ({ id: "r1", name: "Rent", amount: 5000, walletId: "bank", frequency: "monthly", dayOfMonth: dom, startDate: `2026-01-${String(dom).padStart(2, "0")}`, lastPaidDate: `2026-06-${String(dom).padStart(2, "0")}`, active: true, ...over });

describe("buildDailyInsight", () => {
  it("returns null with no data at all", () => {
    expect(buildDailyInsight({ now: NOW })).toBeNull();
    expect(buildDailyInsight({ expenses: [], recurring: [], now: NOW })).toBeNull();
  });

  it("overdue bill outranks everything and names the oldest", () => {
    const r = rec(10); // due 2026-07-10 → 4 days overdue
    const out = buildDailyInsight({ recurring: [r], expenses: [e("2026-07-13", 900)], now: NOW });
    expect(out.tone).toBe("warn");
    expect(out.text).toContain("Rent");
    expect(out.text).toContain("4 days overdue");
  });

  it("bill due today reports wallet coverage", () => {
    const r = rec(14);
    const ok = buildDailyInsight({ recurring: [r], walletBalances: { bank: 9000 }, wallets: [{ id: "bank", name: "Bank" }], now: NOW });
    expect(ok.tone).toBe("info");
    expect(ok.text).toContain("due today");
    expect(ok.text).toContain("Bank covers it");
    const short = buildDailyInsight({ recurring: [rec(14)], walletBalances: { bank: 3000 }, wallets: [{ id: "bank", name: "Bank" }], now: NOW });
    expect(short.tone).toBe("warn");
    expect(short.text).toContain("short by ₹2,000");
  });

  it("upcoming bill within a week shows days-until and coverage", () => {
    const r = rec(17); // due in 3 days
    const out = buildDailyInsight({ recurring: [r], walletBalances: { bank: 9000 }, wallets: [{ id: "bank", name: "Bank" }], now: NOW });
    expect(out.text).toContain("due in 3 days");
    expect(out.text).toContain("covers it");
  });

  it("flags a week 20%+ over the prior three-week pace", () => {
    const exps = [];
    // prior 3 weeks: steady ₹700/wk
    for (let i = 7; i < 28; i += 7) { exps.push(e(`2026-07-${String(14 - i).padStart(2, "0")}`, 350)); exps.push(e(`2026-07-${String(15 - i).padStart(2, "0")}`, 350)); }
    // this week: ₹1400
    exps.push(e("2026-07-12", 700), e("2026-07-13", 700));
    const out = buildDailyInsight({ expenses: exps.filter(x => x.date >= "2026-07-01" || true), now: NOW });
    expect(out.tone).toBe("warn");
    expect(out.text).toMatch(/over your usual pace/);
  });

  it("praises a week 20%+ under pace", () => {
    const exps = [];
    for (let i = 7; i < 28; i += 7) exps.push(e(`2026-06-${String(30 - i).padStart(2, "0")}`, 1000));
    // Put the prior-week spends inside July windows instead (dates must land in each window)
    const exps2 = [e("2026-07-03", 1000), e("2026-06-28", 1000), e("2026-06-21", 1000), e("2026-07-12", 100)];
    const out = buildDailyInsight({ expenses: exps2, now: NOW });
    expect(out.tone).toBe("good");
    expect(out.text).toMatch(/under your usual pace/);
  });

  it("falls back to a quiet month summary and ignores deleted rows", () => {
    const out = buildDailyInsight({ expenses: [e("2026-07-02", 500), e("2026-07-13", 250), e("2026-07-10", 999, { deleted_at: "2026-07-10T10:00:00Z" })], now: NOW });
    expect(out.tone).toBe("info");
    expect(out.text).toContain("₹750 spent this month");
    expect(out.text).toContain("₹250 in the last 7 days");
  });

  it("inactive recurring bills are ignored", () => {
    const out = buildDailyInsight({ recurring: [rec(10, { active: false })], expenses: [e("2026-07-02", 100)], now: NOW });
    expect(out.text).not.toContain("overdue");
  });
});
