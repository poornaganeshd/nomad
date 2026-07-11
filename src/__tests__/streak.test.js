import { describe, it, expect, beforeEach } from "vitest";
import { computeStreak, loadStreakStore, saveStreakStore, FREEZE_CAP, MILESTONES, STREAK_STORE_KEY } from "../streak";

// Consecutive date helper: n days ending at `end` (inclusive), "YYYY-MM-DD".
const daysEnding = (end, n) => {
  const [y, m, d] = end.split("-").map(Number);
  const out = [];
  for (let i = 0; i < n; i++) { const dt = new Date(y, m - 1, d - i, 12); out.push(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`); }
  return out.reverse();
};

const TODAY = "2026-07-08";

describe("computeStreak — core counting", () => {
  it("empty history → all zeros, not at risk", () => {
    const s = computeStreak({ txDates: [], noSpendDays: [], today: TODAY });
    expect(s.current).toBe(0);
    expect(s.longest).toBe(0);
    expect(s.atRisk).toBe(false);
    expect(s.todayLogged).toBe(false);
    expect(s.freezesHeld).toBe(0);
  });

  it("3 consecutive days ending today → current 3, logged, milestone 3", () => {
    const s = computeStreak({ txDates: daysEnding(TODAY, 3), today: TODAY });
    expect(s.current).toBe(3);
    expect(s.todayLogged).toBe(true);
    expect(s.atRisk).toBe(false);
    expect(s.milestoneToday).toBe(3);
    expect(s.nextMilestone).toBe(7);
  });

  it("today unlogged does NOT break the streak — shows yesterday's count, at risk", () => {
    const s = computeStreak({ txDates: daysEnding("2026-07-07", 5), today: TODAY });
    expect(s.current).toBe(5);
    expect(s.todayLogged).toBe(false);
    expect(s.atRisk).toBe(true);
    expect(s.milestoneToday).toBeNull();
  });

  it("duplicate dates and multiple txns per day count once", () => {
    const s = computeStreak({ txDates: [TODAY, TODAY, TODAY], today: TODAY });
    expect(s.current).toBe(1);
  });

  it("future-dated txns are ignored", () => {
    const s = computeStreak({ txDates: ["2026-07-09", "2026-08-01"], today: TODAY });
    expect(s.current).toBe(0);
  });

  it("garbage dates are ignored", () => {
    const s = computeStreak({ txDates: ["", null, "not-a-date", "2026-7-8"], today: TODAY });
    expect(s.current).toBe(0);
  });

  it("no-spend confirmations count as streak days", () => {
    const s = computeStreak({ txDates: daysEnding("2026-07-06", 2), noSpendDays: ["2026-07-07", TODAY], today: TODAY });
    expect(s.current).toBe(4);
    expect(s.todayLogged).toBe(true);
  });
});

describe("computeStreak — freezes", () => {
  it("7 consecutive days earn one freeze", () => {
    const s = computeStreak({ txDates: daysEnding(TODAY, 7), today: TODAY });
    expect(s.freezesHeld).toBe(1);
    expect(s.milestoneToday).toBe(7);
  });

  it("14 consecutive days earn two; 21 days cap at FREEZE_CAP", () => {
    expect(computeStreak({ txDates: daysEnding(TODAY, 14), today: TODAY }).freezesHeld).toBe(2);
    expect(computeStreak({ txDates: daysEnding(TODAY, 21), today: TODAY }).freezesHeld).toBe(FREEZE_CAP);
  });

  it("a missed day burns a freeze and the streak survives (without growing)", () => {
    // 7 days (earn freeze) … miss 2026-07-04 … 4 more days ending today.
    const dates = [...daysEnding("2026-07-03", 7), ...daysEnding(TODAY, 4)];
    const s = computeStreak({ txDates: dates, today: TODAY });
    expect(s.frozenDays).toEqual(["2026-07-04"]);
    expect(s.freezesHeld).toBe(0);
    expect(s.current).toBe(11); // 7 + 4 — frozen day preserved, didn't count
  });

  it("a 2-day gap with only 1 freeze breaks the streak on the second day", () => {
    const dates = [...daysEnding("2026-07-02", 7), ...daysEnding(TODAY, 4)]; // gap 03rd+04th
    const s = computeStreak({ txDates: dates, today: TODAY });
    expect(s.frozenDays).toEqual(["2026-07-03"]);
    expect(s.current).toBe(4);
    expect(s.longest).toBe(7);
  });

  it("a missed day with no freeze resets; longest remembers the old run", () => {
    const dates = [...daysEnding("2026-07-03", 4), ...daysEnding(TODAY, 3)]; // 4-run, gap, 3-run
    const s = computeStreak({ txDates: dates, today: TODAY });
    expect(s.current).toBe(3);
    expect(s.longest).toBe(4);
    expect(s.frozenDays).toEqual([]);
  });

  it("backfilling the missed day refunds the freeze on recompute", () => {
    const withGap = [...daysEnding("2026-07-03", 7), ...daysEnding(TODAY, 4)];
    expect(computeStreak({ txDates: withGap, today: TODAY }).freezesHeld).toBe(0);
    const backfilled = [...withGap, "2026-07-04"];
    const s = computeStreak({ txDates: backfilled, today: TODAY });
    expect(s.freezesHeld).toBe(1);   // never burned
    expect(s.frozenDays).toEqual([]);
    expect(s.current).toBe(12);      // 7 + 1 + 4, all active now
  });

  it("today missing burns nothing — freeze survives the pending day", () => {
    const s = computeStreak({ txDates: daysEnding("2026-07-07", 7), today: TODAY });
    expect(s.freezesHeld).toBe(1);
    expect(s.atRisk).toBe(true);
  });
});

describe("computeStreak — milestones & calendar", () => {
  it("MILESTONES are ascending and start at 3", () => {
    expect(MILESTONES[0]).toBe(3);
    expect([...MILESTONES].sort((a, b) => a - b)).toEqual(MILESTONES);
  });

  it("milestoneToday fires only on exact milestone crossed with today logged", () => {
    expect(computeStreak({ txDates: daysEnding(TODAY, 30), today: TODAY }).milestoneToday).toBe(30);
    expect(computeStreak({ txDates: daysEnding(TODAY, 31), today: TODAY }).milestoneToday).toBeNull();
  });

  it("calendar covers 28 days oldest-first with correct states", () => {
    const dates = [...daysEnding("2026-07-03", 7), ...daysEnding("2026-07-07", 3)]; // frozen 04th, missed today
    const s = computeStreak({ txDates: dates, today: TODAY });
    expect(s.calendar).toHaveLength(28);
    expect(s.calendar[0].date < s.calendar[27].date).toBe(true);
    expect(s.calendar[27]).toEqual({ date: TODAY, state: "pending" });
    const byDate = Object.fromEntries(s.calendar.map(c => [c.date, c.state]));
    expect(byDate["2026-07-04"]).toBe("frozen");
    expect(byDate["2026-07-03"]).toBe("active");
    expect(byDate["2026-06-25"]).toBe("missed"); // before history starts
  });
});

describe("streak store", () => {
  beforeEach(() => localStorage.clear());

  it("loads defaults from empty storage", () => {
    expect(loadStreakStore()).toEqual({ noSpendDays: [], lastCelebrated: 0 });
  });

  it("round-trips, dedupes and sorts no-spend days, drops garbage", () => {
    saveStreakStore({ noSpendDays: ["2026-07-08", "2026-07-06", "2026-07-08"], lastCelebrated: 7 });
    const s = loadStreakStore();
    expect(s.noSpendDays).toEqual(["2026-07-06", "2026-07-08"]);
    expect(s.lastCelebrated).toBe(7);
    localStorage.setItem(STREAK_STORE_KEY, JSON.stringify({ noSpendDays: ["bad", "2026-07-01"], lastCelebrated: "x" }));
    expect(loadStreakStore()).toEqual({ noSpendDays: ["2026-07-01"], lastCelebrated: 0 });
  });

  it("survives corrupt storage", () => {
    localStorage.setItem(STREAK_STORE_KEY, "{not json");
    expect(loadStreakStore()).toEqual({ noSpendDays: [], lastCelebrated: 0 });
  });
});
