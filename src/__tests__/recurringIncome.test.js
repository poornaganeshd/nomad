import { describe, it, expect } from 'vitest';
import { recKind, isRecIncome, getRecurringDueDate, isRecurringDueToday } from '../financeUtils.js';
import { buildReminders } from '../billReminders.js';
import { COLS } from '../dbCols.js';

// A recurring row can now be money ARRIVING (salary, rent received, a payout),
// not only a bill. The scheduling engine is shared — only the write target
// (addI vs addE), the wallet rules and the copy differ.

describe('recKind', () => {
  it('treats a row with no type as a bill — every row written before this existed', () => {
    expect(recKind({ id: 'r' })).toBe('expense');
    expect(recKind({ id: 'r', type: null })).toBe('expense');
    expect(isRecIncome({ id: 'r' })).toBe(false);
  });

  it('only the explicit "income" marker makes it income', () => {
    expect(recKind({ type: 'income' })).toBe('income');
    expect(isRecIncome({ type: 'income' })).toBe(true);
    expect(isRecIncome({ type: 'Income' })).toBe(false); // exact, not fuzzy
  });

  it('survives a missing row', () => {
    expect(recKind(null)).toBe('expense');
    expect(isRecIncome(undefined)).toBe(false);
  });
});

describe('the type column round-trips', () => {
  it('is in COLS.recurring, or every full-row write would drop it', () => {
    // toSB() filters by COLS, so a field missing here is silently lost on the
    // first-connect migration, heal() and undo-restore — the exact way the
    // `skipped` write-off flag used to disappear.
    expect(COLS.recurring).toContain('type');
  });
});

describe('scheduling is shared with bills', () => {
  const salary = { id: 's1', type: 'income', name: 'Salary', amount: 50000, active: true, frequency: 'monthly', dayOfMonth: 1, startDate: '2026-01-01', lastPaidDate: null, lastSkippedDate: null };

  it('an income row is due on its schedule exactly like a bill', () => {
    expect(getRecurringDueDate(salary, '2026-09-15')).toBe('2026-09-01');
    expect(isRecurringDueToday(salary, '2026-09-15')).toBe(true);
  });

  it('recording it clears the cycle', () => {
    const paid = { ...salary, lastPaidDate: '2026-09-01' };
    expect(isRecurringDueToday(paid, '2026-09-15')).toBe(false);
  });
});

describe('reminder copy', () => {
  const noDue = () => null;
  const isDue = () => true;
  const bill = { id: 'r1', name: 'Rent', active: true, frequency: 'monthly' };
  const salary = { id: 'r2', name: 'Salary', active: true, frequency: 'monthly', type: 'income' };

  it('income is EXPECTED, never "due" — and never a warning', () => {
    const [r] = buildReminders([salary], [], '2026-09-15', noDue, isDue, []);
    expect(r.msg).toBe('Salary expected today');
    expect(r.type).toBe('info'); // nothing is at risk if it lands late
  });

  it('a bill still reads as due, and still warns', () => {
    const [r] = buildReminders([bill], [], '2026-09-15', noDue, isDue, []);
    expect(r.msg).toBe('Rent is due');
    expect(r.type).toBe('warn');
  });

  it('upcoming income is "expected in N days"', () => {
    const upcoming = () => '2026-09-17';
    const [r] = buildReminders([{ ...salary, lastPaidDate: null, lastSkippedDate: null }], [], '2026-09-15', upcoming, () => false, []);
    expect(r.msg).toBe('Salary expected in 2 days');
  });

  it('a snoozed income is silenced like any other recurring row', () => {
    expect(buildReminders([salary], [], '2026-09-15', noDue, isDue, [], { r2: '2026-09-16' })).toEqual([]);
  });
});
