import { describe, it, expect, beforeEach } from 'vitest';
import { checkBillReminders } from '../billReminders.js';

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
  it('reminds about unsettled "owe" splits', () => {
    const s = { id: 's1', direction: 'owe', settled: false, amount: 500, name: 'Lunch with Raj' };
    const result = checkBillReminders([], [s], '2024-04-15', noDue, notDueToday);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'stl-s1', type: 'warn' });
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

  it('combines recurring and settlement reminders', () => {
    const r = makeRec({ id: 'r10' });
    const s = { id: 's10', direction: 'owe', settled: false, amount: 100, name: 'Test' };
    const result = checkBillReminders([r], [s], '2024-04-15', noDue, isDueToday);
    expect(result).toHaveLength(2);
  });
});
