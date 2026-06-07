import { describe, it, expect } from 'vitest';
import {
  roundMoney,
  localDateKey,
  fullMonthsBetween,
  fullYearsBetween,
  getRecurringAnchorDate,
  getRecurringDueDate,
  isRecurringDueToday,
  recurringDaysOverdue,
  distributeAmount,
  historySortCompare,
  itemTimestamp,
} from '../financeUtils.js';

// ---------------------------------------------------------------------------
// roundMoney
// ---------------------------------------------------------------------------
describe('roundMoney', () => {
  it('rounds to 2 decimal places', () => {
    // Use values that are exactly representable in floating point
    expect(roundMoney(1.125)).toBe(1.13);
    expect(roundMoney(1.124)).toBe(1.12);
    expect(roundMoney(10.375)).toBe(10.38);
  });

  it('handles integer values', () => {
    expect(roundMoney(100)).toBe(100);
    expect(roundMoney(0)).toBe(0);
  });

  it('handles string numbers', () => {
    expect(roundMoney('9.99')).toBe(9.99);
    expect(roundMoney('10.005')).toBe(10.01);
  });

  it('handles falsy values as 0', () => {
    expect(roundMoney(null)).toBe(0);
    expect(roundMoney(undefined)).toBe(0);
    expect(roundMoney('')).toBe(0);
  });

  it('handles negative values', () => {
    expect(roundMoney(-1.005)).toBe(-1);
    expect(roundMoney(-10.50)).toBe(-10.50);
  });
});

// ---------------------------------------------------------------------------
// localDateKey
// ---------------------------------------------------------------------------
describe('localDateKey', () => {
  it('formats a Date object as YYYY-MM-DD', () => {
    expect(localDateKey(new Date(2024, 0, 5))).toBe('2024-01-05');
    expect(localDateKey(new Date(2024, 11, 31))).toBe('2024-12-31');
  });

  it('pads single-digit months and days', () => {
    expect(localDateKey(new Date(2024, 2, 9))).toBe('2024-03-09');
  });

  it('accepts a date string as input', () => {
    expect(localDateKey('2023-06-15T00:00:00')).toBe('2023-06-15');
  });
});

// ---------------------------------------------------------------------------
// fullMonthsBetween
// ---------------------------------------------------------------------------
describe('fullMonthsBetween', () => {
  it('returns 0 for the same date', () => {
    const d = new Date(2024, 3, 15);
    expect(fullMonthsBetween(d, d)).toBe(0);
  });

  it('counts exact full months', () => {
    expect(fullMonthsBetween(new Date(2024, 0, 1), new Date(2024, 3, 1))).toBe(3);
    expect(fullMonthsBetween(new Date(2023, 0, 1), new Date(2024, 0, 1))).toBe(12);
  });

  it('does not count a partial month', () => {
    // Jan 15 → Apr 14 is only 2 full months, not 3
    expect(fullMonthsBetween(new Date(2024, 0, 15), new Date(2024, 3, 14))).toBe(2);
  });

  it('counts a full month when end day >= start day', () => {
    expect(fullMonthsBetween(new Date(2024, 0, 15), new Date(2024, 3, 15))).toBe(3);
    expect(fullMonthsBetween(new Date(2024, 0, 15), new Date(2024, 3, 20))).toBe(3);
  });

  it('handles cross-year boundaries', () => {
    expect(fullMonthsBetween(new Date(2023, 10, 1), new Date(2024, 1, 1))).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// fullYearsBetween
// ---------------------------------------------------------------------------
describe('fullYearsBetween', () => {
  it('returns 0 for less than a full year', () => {
    expect(fullYearsBetween(new Date(2024, 0, 1), new Date(2024, 11, 31))).toBe(0);
    expect(fullYearsBetween(new Date(2024, 5, 15), new Date(2025, 5, 14))).toBe(0);
  });

  it('counts exact full years', () => {
    expect(fullYearsBetween(new Date(2020, 0, 1), new Date(2024, 0, 1))).toBe(4);
    expect(fullYearsBetween(new Date(2020, 5, 15), new Date(2025, 5, 15))).toBe(5);
  });

  it('does not count year if month has not passed', () => {
    expect(fullYearsBetween(new Date(2024, 6, 1), new Date(2025, 5, 30))).toBe(0);
  });

  it('does not count year if same month but day has not passed', () => {
    expect(fullYearsBetween(new Date(2024, 5, 20), new Date(2025, 5, 19))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getRecurringAnchorDate
// ---------------------------------------------------------------------------
describe('getRecurringAnchorDate', () => {
  it('prefers lastPaidDate', () => {
    expect(getRecurringAnchorDate({ lastPaidDate: '2024-03-01', lastSkippedDate: '2024-02-01', startDate: '2024-01-01' })).toBe('2024-03-01');
  });

  it('falls back to lastSkippedDate when no lastPaidDate', () => {
    expect(getRecurringAnchorDate({ lastSkippedDate: '2024-02-01', startDate: '2024-01-01' })).toBe('2024-02-01');
  });

  it('falls back to startDate when no paid or skipped date', () => {
    expect(getRecurringAnchorDate({ startDate: '2024-01-01' })).toBe('2024-01-01');
  });
});

// ---------------------------------------------------------------------------
// getRecurringDueDate — monthly
// ---------------------------------------------------------------------------
describe('getRecurringDueDate — monthly', () => {
  const base = { frequency: 'monthly', startDate: '2024-01-15', active: true };

  it('returns the most recent due date', () => {
    expect(getRecurringDueDate(base, '2024-04-20')).toBe('2024-04-15');
  });

  it('returns start date when today is the start date', () => {
    expect(getRecurringDueDate(base, '2024-01-15')).toBe('2024-01-15');
  });

  it('returns null when startDate is in the future', () => {
    expect(getRecurringDueDate(base, '2023-12-31')).toBeNull();
  });

  it('clamps to last day of month when dayOfMonth exceeds month length', () => {
    const r = { frequency: 'monthly', startDate: '2024-01-31', active: true, dayOfMonth: 31 };
    // Feb 29 is the clamped anniversary for a 31-day bill — due today
    expect(getRecurringDueDate(r, '2024-02-29')).toBe('2024-02-29');
    // Mar 30: Feb anniversary passed, Mar 31 not yet reached — show Mar 31 (upcoming)
    expect(getRecurringDueDate(r, '2024-03-30')).toBe('2024-03-31');
    // On Mar 31: due today
    expect(getRecurringDueDate(r, '2024-03-31')).toBe('2024-03-31');
  });

  it('uses dayOfMonth override when provided', () => {
    const r = { frequency: 'monthly', startDate: '2024-01-01', dayOfMonth: 20, active: true };
    expect(getRecurringDueDate(r, '2024-04-25')).toBe('2024-04-20');
  });
});

// ---------------------------------------------------------------------------
// getRecurringDueDate — yearly
// ---------------------------------------------------------------------------
describe('getRecurringDueDate — yearly', () => {
  it('returns the most recent annual due date', () => {
    const r = { frequency: 'yearly', startDate: '2022-06-15', active: true };
    expect(getRecurringDueDate(r, '2024-08-01')).toBe('2024-06-15');
  });

  it('respects yearMonth and yearDay overrides', () => {
    const r = { frequency: 'yearly', startDate: '2022-01-01', yearMonth: 3, yearDay: 10, active: true };
    expect(getRecurringDueDate(r, '2024-04-01')).toBe('2024-03-10');
  });

  it('returns null when startDate is in the future', () => {
    const r = { frequency: 'yearly', startDate: '2025-06-15', active: true };
    expect(getRecurringDueDate(r, '2024-08-01')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getRecurringDueDate — custom interval
// ---------------------------------------------------------------------------
describe('getRecurringDueDate — custom interval', () => {
  it('first occurrence (never paid/skipped) IS the start date', () => {
    const r = { frequency: 'custom', startDate: '2024-01-01', intervalDays: 30, active: true };
    expect(getRecurringDueDate(r, '2024-02-15')).toBe('2024-01-01');
  });

  it('after a payment, due is anchor + intervalDays', () => {
    const r = { frequency: 'custom', startDate: '2024-01-01', lastPaidDate: '2024-02-01', intervalDays: 14, active: true };
    expect(getRecurringDueDate(r, '2024-03-01')).toBe('2024-02-15');
  });

  it('after a skip, due is anchor + intervalDays', () => {
    const r = { frequency: 'custom', startDate: '2024-01-01', lastSkippedDate: '2024-02-01', intervalDays: 14, active: true };
    expect(getRecurringDueDate(r, '2024-03-01')).toBe('2024-02-15');
  });

  it('returns null for zero intervalDays', () => {
    const r = { frequency: 'custom', startDate: '2024-01-01', intervalDays: 0, active: true };
    expect(getRecurringDueDate(r, '2024-02-01')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isRecurringDueToday
// ---------------------------------------------------------------------------
describe('isRecurringDueToday', () => {
  it('returns true when monthly bill is due and not paid/skipped this month', () => {
    const r = { frequency: 'monthly', startDate: '2024-01-15', active: true };
    expect(isRecurringDueToday(r, '2024-04-15')).toBe(true);
  });

  it('returns false when monthly bill already paid this month', () => {
    const r = { frequency: 'monthly', startDate: '2024-01-15', active: true, lastPaidDate: '2024-04-01' };
    expect(isRecurringDueToday(r, '2024-04-15')).toBe(false);
  });

  it('returns false when monthly bill skipped this month', () => {
    const r = { frequency: 'monthly', startDate: '2024-01-15', active: true, lastSkippedDate: '2024-04-01' };
    expect(isRecurringDueToday(r, '2024-04-15')).toBe(false);
  });

  it('returns false when inactive', () => {
    const r = { frequency: 'monthly', startDate: '2024-01-15', active: false };
    expect(isRecurringDueToday(r, '2024-04-15')).toBe(false);
  });

  it('returns false when startDate is in the future', () => {
    const r = { frequency: 'monthly', startDate: '2024-05-01', active: true };
    expect(isRecurringDueToday(r, '2024-04-15')).toBe(false);
  });

  it('returns true when overdue (due date has passed and not settled)', () => {
    const r = { frequency: 'monthly', startDate: '2024-01-15', active: true };
    expect(isRecurringDueToday(r, '2024-04-20')).toBe(true);
  });

  it('custom "every N days" bill is due on its start day (so it can be confirmed when added)', () => {
    const r = { frequency: 'custom', startDate: '2024-04-15', intervalDays: 80, active: true };
    expect(isRecurringDueToday(r, '2024-04-15')).toBe(true);
  });

  it('custom bill is not due again until interval days after it was paid', () => {
    const r = { frequency: 'custom', startDate: '2024-04-15', lastPaidDate: '2024-04-15', intervalDays: 80, active: true };
    expect(isRecurringDueToday(r, '2024-04-15')).toBe(false);     // just paid
    expect(isRecurringDueToday(r, '2024-07-04')).toBe(true);      // 80 days later
  });
});

// ---------------------------------------------------------------------------
// recurringDaysOverdue
// ---------------------------------------------------------------------------
describe('recurringDaysOverdue', () => {
  it('returns 0 when due date is today', () => {
    const r = { frequency: 'monthly', startDate: '2024-01-15', active: true };
    expect(recurringDaysOverdue(r, '2024-04-15')).toBe(0);
  });

  it('returns 0 for a custom-interval bill whose next due is still in the future', () => {
    // Paid Jan 1, interval 30 → next due Jan 31; today Jan 20 (before due) → not overdue
    const r = { frequency: 'custom', startDate: '2024-01-01', lastPaidDate: '2024-01-01', intervalDays: 30, active: true };
    expect(recurringDaysOverdue(r, '2024-01-20')).toBe(0);
  });

  it('returns correct overdue days', () => {
    const r = { frequency: 'monthly', startDate: '2024-01-15', active: true };
    expect(recurringDaysOverdue(r, '2024-04-20')).toBe(5);
    expect(recurringDaysOverdue(r, '2024-04-25')).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// distributeAmount
// ---------------------------------------------------------------------------
describe('distributeAmount', () => {
  it('distributes evenly divisible amount', () => {
    expect(distributeAmount(30, 3)).toEqual([10, 10, 10]);
    expect(distributeAmount(100, 4)).toEqual([25, 25, 25, 25]);
  });

  it('distributes remainder by adding 1 cent to early shares', () => {
    // 10 split 3 ways: 3.34 + 3.33 + 3.33
    const result = distributeAmount(10, 3);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(3.34);
    expect(result[1]).toBe(3.33);
    expect(result[2]).toBe(3.33);
  });

  it('sums to original amount', () => {
    const total = 99.99;
    const shares = distributeAmount(total, 7);
    const sum = shares.reduce((a, b) => roundMoney(a + b), 0);
    expect(sum).toBeCloseTo(total, 2);
  });

  it('returns zeros for headCount 0', () => {
    expect(distributeAmount(100, 0)).toEqual([]);
  });

  it('handles zero amount', () => {
    expect(distributeAmount(0, 3)).toEqual([0, 0, 0]);
  });

  it('handles string amount input', () => {
    expect(distributeAmount('30', 3)).toEqual([10, 10, 10]);
  });

  it('handles single person', () => {
    expect(distributeAmount(49.99, 1)).toEqual([49.99]);
  });

  it('handles large split', () => {
    const shares = distributeAmount(1, 3);
    expect(shares[0]).toBe(0.34);
    expect(shares[1]).toBe(0.33);
    expect(shares[2]).toBe(0.33);
  });
});

// ---------------------------------------------------------------------------
// historySortCompare
// ---------------------------------------------------------------------------
describe('historySortCompare', () => {
  it('sorts by date descending', () => {
    const items = [
      { id: 'a', date: '2026-05-10', created_at: '2026-05-10T10:00:00Z' },
      { id: 'b', date: '2026-05-19', created_at: '2026-05-19T08:00:00Z' },
      { id: 'c', date: '2026-05-15', created_at: '2026-05-15T09:00:00Z' },
    ];
    const sorted = [...items].sort(historySortCompare).map(i => i.id);
    expect(sorted).toEqual(['b', 'c', 'a']);
  });

  it('uses created_at as tiebreaker on same date (newest first)', () => {
    const items = [
      { id: 'a', date: '2026-05-19', created_at: '2026-05-19T08:00:00Z' },
      { id: 'b', date: '2026-05-19', created_at: '2026-05-19T12:00:00Z' },
      { id: 'c', date: '2026-05-19', created_at: '2026-05-19T10:00:00Z' },
    ];
    const sorted = [...items].sort(historySortCompare).map(i => i.id);
    expect(sorted).toEqual(['b', 'c', 'a']);
  });

  it('uses id as final tiebreaker when date and created_at match', () => {
    const items = [
      { id: 'aaa', date: '2026-05-19', created_at: '2026-05-19T08:00:00Z' },
      { id: 'ccc', date: '2026-05-19', created_at: '2026-05-19T08:00:00Z' },
      { id: 'bbb', date: '2026-05-19', created_at: '2026-05-19T08:00:00Z' },
    ];
    const sorted = [...items].sort(historySortCompare).map(i => i.id);
    expect(sorted).toEqual(['ccc', 'bbb', 'aaa']);
  });

  it('does NOT use updated_at to sort (would reshuffle on every edit)', () => {
    // Item `a` was created first and has a much later updated_at (was edited).
    // It must NOT jump to the top — the sort must remain stable across edits.
    const items = [
      { id: 'a', date: '2026-05-19', created_at: '2026-05-19T08:00:00Z', updated_at: '2026-05-19T23:00:00Z' },
      { id: 'b', date: '2026-05-19', created_at: '2026-05-19T09:00:00Z', updated_at: '2026-05-19T09:00:00Z' },
    ];
    const sorted = [...items].sort(historySortCompare).map(i => i.id);
    expect(sorted).toEqual(['b', 'a']);
  });

  it('falls back to createdAt when created_at is missing', () => {
    const items = [
      { id: 'a', date: '2026-05-19', createdAt: '2026-05-19T08:00:00Z' },
      { id: 'b', date: '2026-05-19', createdAt: '2026-05-19T12:00:00Z' },
    ];
    const sorted = [...items].sort(historySortCompare).map(i => i.id);
    expect(sorted).toEqual(['b', 'a']);
  });

  it('handles missing date/created_at without throwing', () => {
    const items = [
      { id: 'a' },
      { id: 'b', date: '2026-05-19' },
      { id: 'c', date: '2026-05-19', created_at: '2026-05-19T10:00:00Z' },
    ];
    const sorted = [...items].sort(historySortCompare).map(i => i.id);
    expect(sorted).toEqual(['c', 'b', 'a']);
  });

  it('is stable across repeated sorts (idempotent)', () => {
    const items = [
      { id: 'a', date: '2026-05-19', created_at: '2026-05-19T08:00:00Z' },
      { id: 'b', date: '2026-05-19', created_at: '2026-05-19T08:00:00Z' },
      { id: 'c', date: '2026-05-18', created_at: '2026-05-18T08:00:00Z' },
    ];
    const first = [...items].sort(historySortCompare).map(i => i.id);
    const second = [...items].sort(historySortCompare).map(i => i.id);
    const third = [...first.map(id => items.find(i => i.id === id))].sort(historySortCompare).map(i => i.id);
    expect(first).toEqual(second);
    expect(first).toEqual(third);
  });
});

// ---------------------------------------------------------------------------
// itemTimestamp
// ---------------------------------------------------------------------------
describe('itemTimestamp', () => {
  it('does not derive a bogus timestamp from a UUID id (dashes present)', () => {
    // parseInt('ffffffff', 36) ≈ 1.2e12 — without the dash guard this slipped
    // through the sanity window and mis-dated the row to ~2008.
    expect(itemTimestamp({ id: 'ffffffff-1111-2222-3333-444444444444' })).toBe(0);
  });

  it('prefers created_at over any id heuristic', () => {
    const t = Date.parse('2026-05-19T10:00:00Z');
    expect(itemTimestamp({ id: 'ffffffff-aaaa', created_at: '2026-05-19T10:00:00Z' })).toBe(t);
  });
});
