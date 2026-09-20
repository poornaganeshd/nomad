import { describe, it, expect } from "vitest";
import { calcSleepDuration, fmtSleep } from "../routineSleep";

describe("calcSleepDuration", () => {
  it("measures a night that crosses midnight", () => {
    expect(calcSleepDuration("23:00", "07:00")).toBe(8);
    expect(calcSleepDuration("22:30", "06:15")).toBeCloseTo(7.75, 6);
  });

  it("measures a nap that does not cross midnight", () => {
    expect(calcSleepDuration("01:00", "09:30")).toBeCloseTo(8.5, 6);
  });

  it("returns null when either end is missing or unparseable", () => {
    expect(calcSleepDuration("", "07:00")).toBeNull();
    expect(calcSleepDuration("23:00", "")).toBeNull();
    expect(calcSleepDuration("not-a-time", "07:00")).toBeNull();
  });
});

describe("fmtSleep", () => {
  it("formats whole hours without a minute part", () => {
    expect(fmtSleep(8)).toBe("8h");
    expect(fmtSleep(calcSleepDuration("23:00", "07:00"))).toBe("8h");
  });

  it("formats hours and minutes", () => {
    expect(fmtSleep(calcSleepDuration("23:02", "07:00"))).toBe("7h 58m");
  });

  // The avg-sleep tile feeds this an arithmetic mean, which lands anywhere.
  // Flooring hours while separately rounding minutes let the minute part reach
  // a full 60 with the hour part unmoved, printing "6h 60m" for 7h.
  it("never renders a 60-minute remainder", () => {
    const avg = (calcSleepDuration("23:00", "05:20") + calcSleepDuration("23:00", "06:39")) / 2;
    expect(avg).toBeCloseTo(6.9917, 3);
    expect(fmtSleep(avg)).toBe("7h");

    for (let a = 300; a <= 600; a++) {
      for (let b = 300; b <= 600; b += 7) {
        expect(fmtSleep((a + b) / 2 / 60)).not.toMatch(/ 60m/);
      }
    }
  });

  it("renders a dash for no data rather than NaN", () => {
    expect(fmtSleep(null)).toBe("—");
    expect(fmtSleep(undefined)).toBe("—");
    expect(fmtSleep(NaN)).toBe("—");
  });
});
