import { describe, it, expect } from 'vitest';
import { computeFinanceScore, scoreLabel } from '../financeScore.js';

const M = '2026-05';

// ---------------------------------------------------------------------------
// savings sub-score
// ---------------------------------------------------------------------------
describe('computeFinanceScore — savings', () => {
  it('gives neutral 15 when no income data', () => {
    const { breakdown } = computeFinanceScore({ month: M });
    expect(breakdown.savings).toBe(15);
  });

  it('gives full 35 when savings rate >= 30%', () => {
    const { breakdown } = computeFinanceScore({
      month: M,
      incomes:  [{ date: '2026-05-01', amount: 10000 }],
      expenses: [{ date: '2026-05-01', amount: 7000, categoryId: 'food' }],
    });
    expect(breakdown.savings).toBe(35);
  });

  it('gives 35 when income equals expenses (0% savings = still positive)', () => {
    // rate = 0 → ((0 + 0.2) / 0.5) * 35 = 14
    const { breakdown } = computeFinanceScore({
      month: M,
      incomes:  [{ date: '2026-05-01', amount: 5000 }],
      expenses: [{ date: '2026-05-01', amount: 5000, categoryId: 'food' }],
    });
    expect(breakdown.savings).toBeGreaterThanOrEqual(0);
    expect(breakdown.savings).toBeLessThanOrEqual(35);
  });

  it('gives 0 when overspending > 20% of income', () => {
    const { breakdown } = computeFinanceScore({
      month: M,
      incomes:  [{ date: '2026-05-01', amount: 1000 }],
      expenses: [{ date: '2026-05-01', amount: 1300, categoryId: 'food' }],
    });
    expect(breakdown.savings).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// bills sub-score
// ---------------------------------------------------------------------------
describe('computeFinanceScore — bills', () => {
  it('gives mild bonus 20 when no recurring bills', () => {
    const { breakdown } = computeFinanceScore({ month: M });
    expect(breakdown.bills).toBe(20);
  });

  it('gives 25 when all active bills paid this month', () => {
    const { breakdown } = computeFinanceScore({
      month: M,
      recurring: [
        { active: true, lastPaidDate: '2026-05-10' },
        { active: true, lastPaidDate: '2026-05-15' },
      ],
    });
    expect(breakdown.bills).toBe(25);
  });

  it('gives 0 when no active bills paid this month', () => {
    const { breakdown } = computeFinanceScore({
      month: M,
      recurring: [{ active: true, lastPaidDate: '2026-04-10' }],
    });
    expect(breakdown.bills).toBe(0);
  });

  it('ignores inactive recurring items', () => {
    const { breakdown } = computeFinanceScore({
      month: M,
      recurring: [{ active: false, lastPaidDate: '2026-04-01' }],
    });
    expect(breakdown.bills).toBe(20);
  });

  it('scores partial payment proportionally', () => {
    const { breakdown } = computeFinanceScore({
      month: M,
      recurring: [
        { active: true, lastPaidDate: '2026-05-01' },
        { active: true, lastPaidDate: '2026-04-01' },
      ],
    });
    expect(breakdown.bills).toBe(13); // 1/2 * 25 = 12.5 → rounded 13
  });

  // Scheduled bills are judged on whether anything is OUTSTANDING, not on where
  // the lastPaidDate stamp happens to fall.
  const bills = (recurring, today) =>
    computeFinanceScore({ recurring, month: today.slice(0, 7), today }).breakdown.bills;

  const RENT = { active: true, frequency: 'monthly', dayOfMonth: 28, startDate: '2025-01-28' };
  const ELEC = { active: true, frequency: 'monthly', dayOfMonth: 5,  startDate: '2025-01-05' };

  it('does not penalise a bill that is not due yet', () => {
    // 6 Oct: electricity (5th) is paid; rent is not due until the 28th. Scoring
    // on the month stamp read rent's September stamp as "unpaid this month" and
    // docked 12 points for a bill the user could not have paid yet.
    const r = [{ ...RENT, lastPaidDate: '2026-09-28' }, { ...ELEC, lastPaidDate: '2026-10-05' }];
    expect(bills(r, '2026-10-06')).toBe(25);
    expect(bills(r, '2026-10-10')).toBe(25);
  });

  it('penalises a bill that is genuinely overdue', () => {
    expect(bills([{ ...RENT, lastPaidDate: '2026-09-28' }], '2026-11-02')).toBe(0);
  });

  it('credits a cycle paid late, after the month rolled over', () => {
    expect(bills([{ ...RENT, lastPaidDate: '2026-11-02' }], '2026-11-02')).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// spread sub-score
// ---------------------------------------------------------------------------
describe('computeFinanceScore — spread', () => {
  it('gives neutral 10 when no expenses', () => {
    const { breakdown } = computeFinanceScore({ month: M });
    expect(breakdown.spread).toBe(10);
  });

  it('gives 20 when expenses spread evenly across categories', () => {
    const { breakdown } = computeFinanceScore({
      month: M,
      expenses: [
        { date: '2026-05-01', amount: 300, categoryId: 'food' },
        { date: '2026-05-02', amount: 300, categoryId: 'transport' },
        { date: '2026-05-03', amount: 300, categoryId: 'health' },
      ],
    });
    expect(breakdown.spread).toBe(20);
  });

  it('gives 0 when all expenses in one category (mcp=1.0)', () => {
    const { breakdown } = computeFinanceScore({
      month: M,
      expenses: [{ date: '2026-05-01', amount: 1000, categoryId: 'food' }],
    });
    expect(breakdown.spread).toBe(0);
  });

  it('penalises heavy concentration above 60%', () => {
    const { breakdown } = computeFinanceScore({
      month: M,
      expenses: [
        { date: '2026-05-01', amount: 800, categoryId: 'food' },
        { date: '2026-05-02', amount: 200, categoryId: 'transport' },
      ],
    });
    expect(breakdown.spread).toBeLessThan(20);
    expect(breakdown.spread).toBeGreaterThanOrEqual(0);
  });

  it('returns a finite score when an expense has undefined amount', () => {
    const { breakdown, score } = computeFinanceScore({
      month: M,
      expenses: [
        { date: '2026-05-01', amount: undefined, categoryId: 'food' },
        { date: '2026-05-02', amount: 500,       categoryId: 'transport' },
      ],
    });
    expect(Number.isFinite(breakdown.spread)).toBe(true);
    expect(Number.isFinite(score)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// logging sub-score
// ---------------------------------------------------------------------------
describe('computeFinanceScore — logging', () => {
  it('gives 0 when nothing logged', () => {
    const { breakdown } = computeFinanceScore({ month: M });
    expect(breakdown.logging).toBe(0);
  });

  it('gives 20 at >= 20 distinct days', () => {
    const expenses = Array.from({ length: 20 }, (_, i) => ({
      date: `2026-05-${String(i + 1).padStart(2, '0')}`,
      amount: 100,
      categoryId: 'food',
    }));
    const { breakdown } = computeFinanceScore({ month: M, expenses });
    expect(breakdown.logging).toBe(20);
  });

  it('caps at 20 even with more than 20 days', () => {
    const expenses = Array.from({ length: 25 }, (_, i) => ({
      date: `2026-05-${String(i + 1).padStart(2, '0')}`,
      amount: 100,
      categoryId: 'food',
    }));
    const { breakdown } = computeFinanceScore({ month: M, expenses });
    expect(breakdown.logging).toBe(20);
  });

  it('scales proportionally for 10 days', () => {
    const expenses = Array.from({ length: 10 }, (_, i) => ({
      date: `2026-05-${String(i + 1).padStart(2, '0')}`,
      amount: 100,
      categoryId: 'food',
    }));
    const { breakdown } = computeFinanceScore({ month: M, expenses });
    expect(breakdown.logging).toBe(10);
  });

  it('counts incomes and expenses as distinct days', () => {
    const { breakdown } = computeFinanceScore({
      month: M,
      expenses: [{ date: '2026-05-01', amount: 100, categoryId: 'food' }],
      incomes:  [{ date: '2026-05-02', amount: 500 }],
    });
    expect(breakdown.logging).toBe(2);
  });

  it('deduplicates same-day entries', () => {
    const { breakdown } = computeFinanceScore({
      month: M,
      expenses: [
        { date: '2026-05-01', amount: 100, categoryId: 'food' },
        { date: '2026-05-01', amount: 200, categoryId: 'transport' },
      ],
    });
    expect(breakdown.logging).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// total score
// ---------------------------------------------------------------------------
describe('computeFinanceScore — total', () => {
  it('score is clamped between 0 and 100', () => {
    const { score } = computeFinanceScore({ month: M });
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it('returns a number when month is not specified', () => {
    const { score } = computeFinanceScore({});
    expect(typeof score).toBe('number');
  });

  it('ignores transactions from other months', () => {
    const { breakdown } = computeFinanceScore({
      month: M,
      expenses: [{ date: '2026-04-15', amount: 9000, categoryId: 'food' }],
      incomes:  [{ date: '2026-04-15', amount: 1000 }],
    });
    // No income/expense in M → savings neutral = 15
    expect(breakdown.savings).toBe(15);
    expect(breakdown.logging).toBe(0);
  });

  it('breakdown components sum to score', () => {
    const r = computeFinanceScore({
      month: M,
      incomes:  [{ date: '2026-05-01', amount: 5000 }],
      expenses: [
        { date: '2026-05-01', amount: 1000, categoryId: 'food' },
        { date: '2026-05-02', amount: 500,  categoryId: 'transport' },
      ],
      recurring: [{ active: true, lastPaidDate: '2026-05-05' }],
    });
    const { savings, bills, spread, logging } = r.breakdown;
    expect(r.score).toBe(Math.max(0, Math.min(100, savings + bills + spread + logging)));
  });
});

// ---------------------------------------------------------------------------
// scoreLabel
// ---------------------------------------------------------------------------
describe('scoreLabel', () => {
  it('returns Excellent for score >= 80', () => {
    expect(scoreLabel(80).label).toBe('Excellent');
    expect(scoreLabel(100).label).toBe('Excellent');
  });

  it('returns Good for score 60–79', () => {
    expect(scoreLabel(60).label).toBe('Good');
    expect(scoreLabel(79).label).toBe('Good');
  });

  it('returns Fair for score 40–59', () => {
    expect(scoreLabel(40).label).toBe('Fair');
    expect(scoreLabel(59).label).toBe('Fair');
  });

  it('returns Needs work for score 20–39', () => {
    expect(scoreLabel(20).label).toBe('Needs work');
    expect(scoreLabel(39).label).toBe('Needs work');
  });

  it('returns Critical for score < 20', () => {
    expect(scoreLabel(0).label).toBe('Critical');
    expect(scoreLabel(19).label).toBe('Critical');
  });

  it('includes color and emoji for every tier', () => {
    [0, 20, 40, 60, 80].forEach(s => {
      const r = scoreLabel(s);
      expect(r.color).toBeTruthy();
      expect(r.emoji).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// Regression: spread sub-score must never poison the total to NaN when an
// expense is missing its `amount` (corrupt/imported row). Previously byCat used
// `e.amount` (no `|| 0` guard) so one undefined amount → maxAmt NaN → score NaN.
// ---------------------------------------------------------------------------
describe('computeFinanceScore — robustness against missing amounts', () => {
  it('never returns NaN when an expense has no amount', () => {
    const { score, breakdown } = computeFinanceScore({
      month: M,
      incomes:  [{ date: '2026-05-01', amount: 5000 }],
      expenses: [
        { date: '2026-05-02', amount: 1000, categoryId: 'food' },
        { date: '2026-05-03', categoryId: 'transport' }, // no amount
      ],
    });
    expect(Number.isFinite(score)).toBe(true);
    expect(Number.isFinite(breakdown.spread)).toBe(true);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});
