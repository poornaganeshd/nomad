import { describe, it, expect } from 'vitest';
import { balanceTrail, runwayInfo } from '../financeUtils';

const TODAY = '2026-07-16';

describe('balanceTrail', () => {
  it('returns days+1 points ending at the current balance today', () => {
    const t = balanceTrail(5000, [], { days: 30, todayKey: TODAY });
    expect(t).toHaveLength(31);
    expect(t[30]).toEqual({ date: '2026-07-16', bal: 5000 });
    expect(t[0].date).toBe('2026-06-16');
  });

  it('walks backward subtracting each day\'s net delta', () => {
    const events = [
      { date: '2026-07-16', amount: -200 }, // spent today
      { date: '2026-07-15', amount: 1000 }, // income yesterday
    ];
    const t = balanceTrail(5000, events, { days: 3, todayKey: TODAY });
    // today 5000; end of 15th = 5000 - (-200) = 5200; end of 14th = 5200 - 1000 = 4200
    expect(t.map(p => p.bal)).toEqual([4200, 4200, 5200, 5000]);
  });

  it('sums multiple same-day events and ignores events outside the window', () => {
    const events = [
      { date: '2026-07-16', amount: -100 },
      { date: '2026-07-16', amount: -50 },
      { date: '2026-05-01', amount: -99999 }, // long before the window — already inside the oldest balance
      { date: '2026-08-01', amount: 500 },    // future — never visited
    ];
    const t = balanceTrail(1000, events, { days: 2, todayKey: TODAY });
    expect(t.map(p => p.bal)).toEqual([1150, 1150, 1000]);
  });

  it('crosses month boundaries with real calendar dates', () => {
    const t = balanceTrail(0, [], { days: 3, todayKey: '2026-03-02' });
    expect(t.map(p => p.date)).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
  });

  it('rounds to paise and tolerates garbage input', () => {
    const t = balanceTrail('abc', [{ date: '2026-07-16', amount: '0.335' }, null, { amount: 5 }], { days: 1, todayKey: TODAY });
    expect(t[1].bal).toBe(0);
    expect(t[0].bal).toBe(-0.34);
  });
});

describe('runwayInfo', () => {
  // ₹100/day for the last 7 days, ₹50/day for the 21 days before that.
  const spends = [];
  for (let i = 0; i < 7; i++) spends.push({ date: `2026-07-${String(16 - i).padStart(2, '0')}`, amount: 100 });
  for (let i = 7; i < 28; i++) {
    const d = new Date(2026, 6, 16 - i, 12);
    spends.push({ date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, amount: 50 });
  }

  it('computes this-week rate, usual baseline pace, and days of ground', () => {
    const r = runwayInfo(1100, spends, { todayKey: TODAY });
    expect(r.rate).toBe(100);
    expect(r.usual).toBe(50);
    expect(r.daysLeft).toBe(11);
    expect(r.daysAtUsual).toBe(22);
    expect(r.dryBy).toBe('2026-07-27');
  });

  it('returns nulls when there is no burn', () => {
    const r = runwayInfo(5000, [], { todayKey: TODAY });
    expect(r.rate).toBe(0);
    expect(r.daysLeft).toBeNull();
    expect(r.dryBy).toBeNull();
  });

  it('clamps a negative balance to zero ground', () => {
    const r = runwayInfo(-250, spends, { todayKey: TODAY });
    expect(r.daysLeft).toBe(0);
    expect(r.dryBy).toBe(TODAY);
  });

  it('ignores future-dated and non-positive spend rows', () => {
    const r = runwayInfo(1000, [
      { date: '2026-07-20', amount: 999 },
      { date: '2026-07-16', amount: -40 },
      { date: '2026-07-16', amount: 70 },
    ], { todayKey: TODAY });
    expect(r.rate).toBe(10); // 70 / 7
  });
});
