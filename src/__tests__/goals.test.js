import { describe, it, expect } from 'vitest';
import { goalProgress, roundMoney } from '../financeUtils';

const TODAY = '2026-07-16';

describe('goalProgress', () => {
  it('computes pct and remaining for a partial goal', () => {
    const p = goalProgress({ target: 10000, saved: 2500 }, TODAY);
    expect(p.pct).toBe(25);
    expect(p.remaining).toBe(7500);
    expect(p.done).toBe(false);
    expect(p.overdue).toBe(false);
  });

  it('marks done at exactly the target and caps pct at 100', () => {
    expect(goalProgress({ target: 5000, saved: 5000 }, TODAY)).toMatchObject({ done: true, pct: 100, remaining: 0 });
    expect(goalProgress({ target: 5000, saved: 7200 }, TODAY)).toMatchObject({ done: true, pct: 100, remaining: 0 });
  });

  it('never shows 100% for an unfinished goal (floor, not round)', () => {
    const p = goalProgress({ target: 10000, saved: 9999.9 }, TODAY);
    expect(p.done).toBe(false);
    expect(p.pct).toBe(99);
  });

  it('computes per-month pace from calendar months to the target date', () => {
    // Jul 2026 → Dec 2026 = 5 calendar months
    const p = goalProgress({ target: 12000, saved: 2000, targetDate: '2026-12-01' }, TODAY);
    expect(p.monthsLeft).toBe(5);
    expect(p.perMonth).toBe(2000);
  });

  it('floors monthsLeft at 1 when the target date is later this month', () => {
    const p = goalProgress({ target: 3000, saved: 0, targetDate: '2026-07-31' }, TODAY);
    expect(p.monthsLeft).toBe(1);
    expect(p.perMonth).toBe(3000);
  });

  it('flags a past target date as overdue with no pace', () => {
    const p = goalProgress({ target: 3000, saved: 100, targetDate: '2026-07-01' }, TODAY);
    expect(p.overdue).toBe(true);
    expect(p.monthsLeft).toBeNull();
    expect(p.perMonth).toBeNull();
  });

  it('a finished goal is never overdue and has no pace', () => {
    const p = goalProgress({ target: 3000, saved: 3000, targetDate: '2020-01-01' }, TODAY);
    expect(p.overdue).toBe(false);
    expect(p.perMonth).toBeNull();
  });

  it('ignores a malformed targetDate', () => {
    const p = goalProgress({ target: 1000, saved: 0, targetDate: 'next year' }, TODAY);
    expect(p.targetDate).toBeNull();
    expect(p.monthsLeft).toBeNull();
    expect(p.overdue).toBe(false);
  });

  it('clamps garbage input to zeros instead of NaN', () => {
    const p = goalProgress({ target: -50, saved: 'abc' }, TODAY);
    expect(p).toMatchObject({ target: 0, saved: 0, remaining: 0, pct: 0, done: false });
    expect(goalProgress(null, TODAY).pct).toBe(0);
  });

  it('rounds money like roundMoney (paise precision, no float residue)', () => {
    const p = goalProgress({ target: 100, saved: 33.333 }, TODAY);
    expect(p.saved).toBe(roundMoney(33.333));
    expect(p.remaining).toBe(roundMoney(100 - roundMoney(33.333)));
  });
});
