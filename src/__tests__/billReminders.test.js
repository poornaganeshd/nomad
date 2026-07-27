import { describe, it, expect, beforeEach } from 'vitest';
import { checkBillReminders, buildReminders } from '../billReminders.js';

// localStorage is provided by jsdom in the test environment.
// We reset it before each test to prevent state bleed.
beforeEach(() => {
  localStorage.clear();
});

// Helper: build a minimal recurring record
const makeRec = (overrides = {}) => ({
  id: 'r1',
  name: 'Netflix',
  frequency: 'monthly',
  startDate: '2024-01-15',
  active: true,
  ...overrides,
});

// Stub getRecurringDueDate and isRecurringDueToday so we control the scheduling
const noDue = () => null;
const notDueToday = () => false;
const isDueToday = () => true;

// ---------------------------------------------------------------------------
// checkBillReminders — recurring bills
// ---------------------------------------------------------------------------
describe('checkBillReminders — recurring bills', () => {
  it('returns no reminders when there are no records', () => {
    const result = checkBillReminders([], [], '2024-04-15', noDue, notDueToday);
    expect(result).toEqual([]);
  });

  it('returns a "due" warning when a bill is due today', () => {
    const r = makeRec();
    const result = checkBillReminders([r], [], '2024-04-15', noDue, isDueToday);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'rec-r1', type: 'warn', msg: 'Netflix is due' });
  });

  it('skips inactive recurring records', () => {
    const r = makeRec({ active: false });
    const result = checkBillReminders([r], [], '2024-04-15', noDue, isDueToday);
    expect(result).toHaveLength(0);
  });

  it('returns an "upcoming" info reminder when bill is due within 3 days', () => {
    const r = makeRec({ id: 'r2' });
    const today = '2024-04-15';
    // Due date falls within today+1 to today+3
    const getDue = () => '2024-04-17';
    const result = checkBillReminders([r], [], today, getDue, notDueToday);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'info' });
    expect(result[0].msg).toMatch(/due in 2 days/);
  });

  it('uses singular "day" when due in exactly 1 day', () => {
    const r = makeRec({ id: 'r3' });
    const getDue = () => '2024-04-16';
    const result = checkBillReminders([r], [], '2024-04-15', getDue, notDueToday);
    expect(result[0].msg).toMatch(/due in 1 day$/);
  });

  it('returns no reminder when bill is due more than 3 days away', () => {
    const r = makeRec({ id: 'r4' });
    const getDue = () => '2024-04-20';
    const result = checkBillReminders([r], [], '2024-04-15', getDue, notDueToday);
    expect(result).toHaveLength(0);
  });

  it('skips already-shown reminders (stored in localStorage)', () => {
    const r = makeRec();
    // First call — should show
    const first = checkBillReminders([r], [], '2024-04-15', noDue, isDueToday);
    expect(first).toHaveLength(1);
    // Second call same day — already shown, should be empty
    const second = checkBillReminders([r], [], '2024-04-15', noDue, isDueToday);
    expect(second).toHaveLength(0);
  });

  it('shows reminders again on a new day', () => {
    const r = makeRec();
    checkBillReminders([r], [], '2024-04-15', noDue, isDueToday);
    // Different day — shown-set is different key
    const result = checkBillReminders([r], [], '2024-04-16', noDue, isDueToday);
    expect(result).toHaveLength(1);
  });

  it('does not include upcoming reminder when bill is already handled this month', () => {
    // isNotHandled check: monthly bill skipped in the same month as upcoming due
    const r = makeRec({ id: 'r5', lastSkippedDate: '2024-04-01' });
    const getDue = () => '2024-04-17'; // within 3 days of Apr 15
    const result = checkBillReminders([r], [], '2024-04-15', getDue, notDueToday);
    // Same year-month as due → handled → no reminder
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// checkBillReminders — settlement splits
// ---------------------------------------------------------------------------
describe('checkBillReminders — settlements', () => {
  it('reminds about unsettled "owe" splits, keyed per person', () => {
    const s = { id: 's1', direction: 'owe', settled: false, amount: 500, name: 'Lunch with Raj' };
    const result = checkBillReminders([], [s], '2024-04-15', noDue, notDueToday);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'owe-lunch with raj', type: 'warn' });
    expect(result[0].msg).toContain('₹500');
    expect(result[0].msg).toContain('Lunch with Raj');
  });

  it('skips settled splits', () => {
    const s = { id: 's2', direction: 'owe', settled: true, amount: 200, name: 'Movie' };
    const result = checkBillReminders([], [s], '2024-04-15', noDue, notDueToday);
    expect(result).toHaveLength(0);
  });

  it('skips splits where direction is not "owe"', () => {
    const s = { id: 's3', direction: 'owed', settled: false, amount: 300, name: 'Dinner' };
    const result = checkBillReminders([], [s], '2024-04-15', noDue, notDueToday);
    expect(result).toHaveLength(0);
  });

  it('skips written-off (skipped) and soft-deleted splits', () => {
    const splits = [
      { id: 'k1', direction: 'owe', settled: true, skipped: true, amount: 90, name: 'Written off' },
      { id: 'k2', direction: 'owe', settled: false, amount: 40, name: 'Deleted', deleted_at: '2024-04-14T00:00:00Z' },
    ];
    expect(checkBillReminders([], splits, '2024-04-15', noDue, notDueToday)).toHaveLength(0);
  });

  it('combines recurring and settlement reminders', () => {
    const r = makeRec({ id: 'r10' });
    const s = { id: 's10', direction: 'owe', settled: false, amount: 100, name: 'Test' };
    const result = checkBillReminders([r], [s], '2024-04-15', noDue, isDueToday);
    expect(result).toHaveLength(2);
  });

  // The bug behind the stacked "You owe ₹15 / ₹10 / ₹92.5 — Rakesh" chips: one
  // toast per split, each quoting the ORIGINAL amount.
  it('aggregates several IOUs with the same person into one reminder', () => {
    const splits = [
      { id: 'a', direction: 'owe', settled: false, amount: 15, name: 'Rakesh' },
      { id: 'b', direction: 'owe', settled: false, amount: 10, name: 'rakesh' },
      { id: 'c', direction: 'owe', settled: false, amount: 92.5, name: 'Rakesh' },
    ];
    const result = checkBillReminders([], splits, '2024-04-15', noDue, notDueToday);
    expect(result).toHaveLength(1);
    expect(result[0].msg).toBe('You owe ₹117.5 — Rakesh (3 IOUs)');
  });

  it('reminds on the REMAINING balance after partial settlements', () => {
    const splits = [{ id: 'a', direction: 'owe', settled: false, amount: 300, name: 'Rakesh' }];
    const settlements = [{ splitId: 'a', amount: 240 }];
    const result = checkBillReminders([], splits, '2024-04-15', noDue, notDueToday, settlements);
    expect(result[0].msg).toBe('You owe ₹60 — Rakesh');
  });

  it('ignores overpay excess when computing the remainder', () => {
    const splits = [{ id: 'a', direction: 'owe', settled: false, amount: 100, name: 'Raj' }];
    const settlements = [{ splitId: 'a', amount: 40, excess: 10 }];
    const result = checkBillReminders([], splits, '2024-04-15', noDue, notDueToday, settlements);
    expect(result[0].msg).toBe('You owe ₹70 — Raj');
  });

  it('drops a person whose IOUs are fully covered by settlements', () => {
    const splits = [{ id: 'a', direction: 'owe', settled: false, amount: 300, name: 'Rakesh' }];
    const settlements = [{ splitId: 'a', amount: 300 }];
    expect(checkBillReminders([], splits, '2024-04-15', noDue, notDueToday, settlements)).toHaveLength(0);
  });

  it('sorts people by outstanding balance, biggest first', () => {
    const splits = [
      { id: 'a', direction: 'owe', settled: false, amount: 20, name: 'Small' },
      { id: 'b', direction: 'owe', settled: false, amount: 900, name: 'Big' },
    ];
    const result = checkBillReminders([], splits, '2024-04-15', noDue, notDueToday);
    expect(result.map(r => r.msg)).toEqual(['You owe ₹900 — Big', 'You owe ₹20 — Small']);
  });

  it('ignores an unnamed IOU rather than emitting a blank reminder', () => {
    const splits = [{ id: 'a', direction: 'owe', settled: false, amount: 50, name: '  ' }];
    expect(checkBillReminders([], splits, '2024-04-15', noDue, notDueToday)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildReminders — the UNGATED source both consumers share
// ---------------------------------------------------------------------------
describe('buildReminders vs checkBillReminders', () => {
  const oweSplit = { id: 's1', direction: 'owe', settled: false, amount: 500, name: 'Raj' };

  it('buildReminders ignores the once-a-day gate and never marks', () => {
    expect(buildReminders([], [oweSplit], '2024-04-15', noDue, notDueToday)).toHaveLength(1);
    // Repeated calls keep returning it — nothing was recorded as "shown".
    expect(buildReminders([], [oweSplit], '2024-04-15', noDue, notDueToday)).toHaveLength(1);
    expect(buildReminders([], [oweSplit], '2024-04-15', noDue, notDueToday)).toHaveLength(1);
  });

  it('checkBillReminders fires once, then stays quiet for the rest of the day', () => {
    expect(checkBillReminders([], [oweSplit], '2024-04-15', noDue, notDueToday)).toHaveLength(1);
    expect(checkBillReminders([], [oweSplit], '2024-04-15', noDue, notDueToday)).toHaveLength(0);
    // …while the ungated view still reports it as outstanding.
    expect(buildReminders([], [oweSplit], '2024-04-15', noDue, notDueToday)).toHaveLength(1);
  });

  it('both agree on ids, so a stored notification can be matched against live state', () => {
    const built = buildReminders([], [oweSplit], '2024-04-15', noDue, notDueToday);
    const checked = checkBillReminders([], [oweSplit], '2024-04-15', noDue, notDueToday);
    expect(checked.map(r => r.id)).toEqual(built.map(r => r.id));
    expect(checked.map(r => r.msg)).toEqual(built.map(r => r.msg));
  });

  it('a settled IOU disappears from buildReminders immediately', () => {
    const settlements = [{ splitId: 's1', amount: 500 }];
    expect(buildReminders([], [oweSplit], '2024-04-15', noDue, notDueToday, settlements)).toHaveLength(0);
  });

  it('tolerates a null recurring list', () => {
    expect(() => buildReminders(null, [oweSplit], '2024-04-15', noDue, notDueToday)).not.toThrow();
  });
});
