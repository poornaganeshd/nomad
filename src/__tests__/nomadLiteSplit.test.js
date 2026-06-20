import { describe, it, expect, beforeEach } from "vitest";
import { computeSplit, loadState, DEFAULT_STATE, initials, fmt, LS_KEY } from "../nomadLiteSplit";

const P = [{ id: "P1", name: "Aarav" }, { id: "P2", name: "Diya" }, { id: "P3", name: "Kiran" }];
const round = (n) => Math.round(n * 100) / 100;

describe("computeSplit — even split", () => {
  it("divides total equally and ignores base/groups", () => {
    const r = computeSplit({ ...DEFAULT_STATE, people: P, totalBill: "600" }, { evenSplit: true });
    expect(r.evenSplit).toBe(true);
    expect(round(r.perPersonTotal.P1)).toBe(200);
    expect(round(r.perPersonTotal.P2)).toBe(200);
    expect(round(r.perPersonTotal.P3)).toBe(200);
  });
  it("handles zero people without dividing by zero", () => {
    const r = computeSplit({ ...DEFAULT_STATE, people: [], totalBill: "600" }, { evenSplit: true });
    expect(r.perPersonTotal).toEqual({});
  });
});

describe("computeSplit — detailed (base + groups)", () => {
  it("splits base across base members and routes extra by group membership", () => {
    const st = {
      ...DEFAULT_STATE,
      people: [P[0], P[1]],
      baseMembers: ["P1", "P2"],
      baseBill: "210",
      totalBill: "500",
      mode: "auto",
      groups: [{ id: "G1", name: "Induction", pct: 100, members: ["P1"] }],
    };
    const r = computeSplit(st);
    expect(round(r.base)).toBe(210);
    expect(round(r.extra)).toBe(290); // 500 - 210
    expect(round(r.basePerPerson)).toBe(105);
    expect(round(r.perPersonTotal.P1)).toBe(395); // 105 + 290
    expect(round(r.perPersonTotal.P2)).toBe(105);
    const grand = round(r.perPersonTotal.P1 + r.perPersonTotal.P2);
    expect(grand).toBe(500); // adds up to the total bill
  });

  it("auto-scales group weights that don't sum to 100%", () => {
    const st = {
      ...DEFAULT_STATE,
      people: [P[0], P[1]],
      baseMembers: [],
      baseBill: "0",
      totalBill: "300",
      mode: "auto",
      groups: [
        { id: "G1", name: "AC", pct: 60, members: ["P1"] },
        { id: "G2", name: "Geyser", pct: 60, members: ["P2"] },
      ],
    };
    const r = computeSplit(st);
    expect(r.normalized).toBe(true);
    expect(r.rawTotalPct).toBe(120);
    // 60/120 each -> 150 each of the 300 extra
    expect(round(r.perPersonTotal.P1)).toBe(150);
    expect(round(r.perPersonTotal.P2)).toBe(150);
    expect(round(r.allocatedExtra)).toBe(300);
    expect(round(r.unallocated)).toBe(0);
  });

  it("reports unallocated extra when there are no groups", () => {
    const st = { ...DEFAULT_STATE, people: [P[0]], baseMembers: ["P1"], baseBill: "100", totalBill: "400", mode: "auto", groups: [] };
    const r = computeSplit(st);
    expect(round(r.extra)).toBe(300);
    expect(round(r.unallocated)).toBe(300);
    expect(round(r.perPersonTotal.P1)).toBe(100); // only base, extra unassigned
  });

  it("uses manual extra instead of total-minus-base in manual mode", () => {
    const st = { ...DEFAULT_STATE, people: [P[0], P[1]], baseMembers: ["P1", "P2"], baseBill: "200", totalBill: "999", mode: "manual", manualExtra: "100", groups: [{ id: "G1", name: "Washer", pct: 100, members: ["P1", "P2"] }] };
    const r = computeSplit(st);
    expect(round(r.extra)).toBe(100); // manual, not 999-200
    expect(round(r.perPersonTotal.P1)).toBe(150); // 100 base + 50 washer
    expect(round(r.perPersonTotal.P2)).toBe(150);
  });

  it("never produces negative extra when base exceeds total", () => {
    const st = { ...DEFAULT_STATE, people: [P[0]], baseMembers: ["P1"], baseBill: "500", totalBill: "300", mode: "auto", groups: [] };
    const r = computeSplit(st);
    expect(r.extra).toBe(0);
  });
});

describe("loadState", () => {
  beforeEach(() => localStorage.clear());
  it("returns defaults when nothing stored", () => {
    expect(loadState()).toEqual(DEFAULT_STATE);
  });
  it("coerces malformed arrays back to safe shapes", () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ people: null, baseMembers: "x", groups: [{ id: "G", name: "n", pct: 5 }] }));
    const s = loadState();
    expect(Array.isArray(s.people)).toBe(true);
    expect(Array.isArray(s.baseMembers)).toBe(true);
    expect(Array.isArray(s.groups[0].members)).toBe(true); // backfilled
  });
  it("survives corrupt JSON", () => {
    localStorage.setItem(LS_KEY, "{not json");
    expect(loadState()).toEqual(DEFAULT_STATE);
  });
});

describe("helpers", () => {
  it("initials handles one/two/empty names", () => {
    expect(initials("Aarav")).toBe("A");
    expect(initials("Aarav Diya")).toBe("AD");
    expect(initials("")).toBe("?");
  });
  it("fmt renders INR with 2 decimals", () => {
    expect(fmt(1234.5)).toBe("₹1,234.50");
    expect(fmt(Infinity)).toBe("₹0.00");
  });
});
