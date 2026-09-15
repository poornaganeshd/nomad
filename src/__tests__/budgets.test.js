import { describe, it, expect } from 'vitest';
import { computeBudgets, normalizeBudgetCfg, spendByCategory, budgetPeriodLabel, DEFAULT_BUDGET_CFG } from '../financeUtils.js';

// Budgets were one number per category, hard-wired to the calendar month — no
// weekly grocery allowance, no annual pot, and no answer to the question most
// people actually ask ("what am I allowed to spend in TOTAL this month?").

const TODAY = '2026-09-15'; // Tue
const cats = [{ id: 'food', name: 'Food', color: '#f00' }, { id: 'travel', name: 'Travel', color: '#00f' }];
const exp = (amount, date, categoryId = 'food', over = {}) => ({ id: `e${amount}${date}`, amount, date, categoryId, ...over });

describe('normalizeBudgetCfg', () => {
  it('defaults an absent or junk config to a monthly budget with no cap', () => {
    expect(normalizeBudgetCfg(undefined)).toEqual(DEFAULT_BUDGET_CFG);
    expect(normalizeBudgetCfg({ period: 'fortnightly', total: -5 })).toEqual(DEFAULT_BUDGET_CFG);
  });

  it('keeps a valid one', () => {
    expect(normalizeBudgetCfg({ period: 'weekly', total: 3000, rollover: true }))
      .toEqual({ period: 'weekly', total: 3000, rollover: true });
  });

  it('labels each period', () => {
    expect(budgetPeriodLabel('weekly')).toBe('This week');
    expect(budgetPeriodLabel('yearly')).toBe('This year');
  });
});

describe('spendByCategory', () => {
  it('counts expenses inside the window only', () => {
    const rows = [exp(100, '2026-09-01'), exp(50, '2026-09-30'), exp(999, '2026-08-31')];
    expect(spendByCategory(rows, [], [], '2026-09-01', '2026-10-01')).toEqual({ food: 150 });
  });

  it('counts settlements you PAID OUT — that money left a wallet', () => {
    const stl = [{ id: 's1', direction: 'owe', date: '2026-09-05', amount: 200, categoryId: 'food' }];
    expect(spendByCategory([], stl, [], '2026-09-01', '2026-10-01')).toEqual({ food: 200 });
  });

  it('nets an overpay off a settlement — the extra is a write-off, not spending', () => {
    const stl = [{ id: 's1', direction: 'owe', date: '2026-09-05', amount: 200, excess: 50, categoryId: 'food' }];
    expect(spendByCategory([], stl, [], '2026-09-01', '2026-10-01')).toEqual({ food: 150 });
  });

  it('falls back to the split category for older settlement rows', () => {
    const stl = [{ id: 's1', direction: 'owe', date: '2026-09-05', amount: 90, splitId: 'sp1' }];
    expect(spendByCategory([], stl, [{ id: 'sp1', categoryId: 'travel' }], '2026-09-01', '2026-10-01')).toEqual({ travel: 90 });
  });

  it('ignores money someone ELSE paid, and money coming back', () => {
    const rows = [exp(500, '2026-09-05', 'food', { walletId: '__tracked__' })];
    const stl = [{ id: 's', direction: 'owed', date: '2026-09-05', amount: 300, categoryId: 'food' }];
    expect(spendByCategory(rows, stl, [], '2026-09-01', '2026-10-01')).toEqual({});
  });
});

describe('periods', () => {
  const budgets = { food: 5000 };
  const rows = [exp(1000, '2026-09-15'), exp(2000, '2026-09-01'), exp(4000, '2026-01-10')];

  it('monthly counts the calendar month to date', () => {
    const { lines } = computeBudgets({ budgets, cfg: { period: 'monthly' }, expenses: rows, categories: cats, today: TODAY });
    expect(lines[0].spent).toBe(3000);
  });

  it('weekly counts only this Sun–today', () => {
    const { lines } = computeBudgets({ budgets, cfg: { period: 'weekly' }, expenses: rows, categories: cats, today: TODAY });
    expect(lines[0].spent).toBe(1000); // 09-15 is in this week; 09-01 is not
  });

  it('yearly counts the whole calendar year to date', () => {
    const { lines } = computeBudgets({ budgets, cfg: { period: 'yearly' }, expenses: rows, categories: cats, today: TODAY });
    expect(lines[0].spent).toBe(7000);
  });
});

describe('rollover', () => {
  const budgets = { food: 1000 };
  // Spent 600 of 1000 last month → 400 unspent.
  const rows = [exp(600, '2026-08-10'), exp(200, '2026-09-05')];

  it('carries last period\'s unspent budget forward', () => {
    const { lines } = computeBudgets({ budgets, cfg: { period: 'monthly', rollover: true }, expenses: rows, categories: cats, today: TODAY });
    expect(lines[0]).toMatchObject({ base: 1000, carry: 400, lim: 1400, spent: 200 });
  });

  it('carries nothing when last period was overspent', () => {
    const over = [exp(1500, '2026-08-10'), exp(200, '2026-09-05')];
    const { lines } = computeBudgets({ budgets, cfg: { period: 'monthly', rollover: true }, expenses: over, categories: cats, today: TODAY });
    expect(lines[0].carry).toBe(0);
  });

  it('caps the carry at ONE period — a dormant category is not a windfall', () => {
    // Nothing spent last month at all: carry is the full 1000, not more.
    const { lines } = computeBudgets({ budgets, cfg: { period: 'monthly', rollover: true }, expenses: [], categories: cats, today: TODAY });
    expect(lines[0]).toMatchObject({ carry: 1000, lim: 2000 });
  });

  it('is off unless asked for', () => {
    const { lines } = computeBudgets({ budgets, cfg: { period: 'monthly' }, expenses: rows, categories: cats, today: TODAY });
    expect(lines[0]).toMatchObject({ carry: 0, lim: 1000 });
  });
});

describe('the overall cap', () => {
  const rows = [exp(3000, '2026-09-05', 'food'), exp(2000, '2026-09-06', 'travel')];

  it('counts ALL spending, not just the categories that have a budget', () => {
    const { total } = computeBudgets({ budgets: { food: 4000 }, cfg: { period: 'monthly', total: 10000 }, expenses: rows, categories: cats, today: TODAY });
    expect(total).toMatchObject({ base: 10000, lim: 10000, spent: 5000, left: 5000, over: false });
  });

  it('is null when no cap is set', () => {
    expect(computeBudgets({ budgets: { food: 4000 }, cfg: {}, expenses: rows, categories: cats, today: TODAY }).total).toBe(null);
  });

  it('flags a breach', () => {
    const { total } = computeBudgets({ budgets: {}, cfg: { period: 'monthly', total: 4000 }, expenses: rows, categories: cats, today: TODAY });
    expect(total.over).toBe(true);
    expect(total.left).toBe(-1000);
  });

  it('rolls over too', () => {
    const withPrev = [...rows, exp(1000, '2026-08-02', 'food')];
    const { total } = computeBudgets({ budgets: {}, cfg: { period: 'monthly', total: 10000, rollover: true }, expenses: withPrev, categories: cats, today: TODAY });
    expect(total).toMatchObject({ carry: 9000, lim: 19000 });
  });
});

describe('lines', () => {
  it('skips categories with no budget set, and resolves the category object', () => {
    const { lines } = computeBudgets({ budgets: { food: 1000, travel: 0 }, cfg: {}, expenses: [], categories: cats, today: TODAY });
    expect(lines).toHaveLength(1);
    expect(lines[0].cat.name).toBe('Food');
  });

  it('survives a budget on a category that was deleted', () => {
    const { lines } = computeBudgets({ budgets: { gone: 500 }, cfg: {}, expenses: [], categories: cats, today: TODAY });
    expect(lines[0].cat.name).toBe('gone');
  });

  it('sorts most-consumed first, so the one at risk is on top', () => {
    const rows = [exp(900, '2026-09-05', 'food'), exp(100, '2026-09-05', 'travel')];
    const { lines } = computeBudgets({ budgets: { food: 1000, travel: 1000 }, cfg: {}, expenses: rows, categories: cats, today: TODAY });
    expect(lines.map(l => l.cid)).toEqual(['food', 'travel']);
  });
});
