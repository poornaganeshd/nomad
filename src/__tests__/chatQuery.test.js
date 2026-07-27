import { describe, it, expect } from 'vitest';
import {
  buildQueryRows,
  resolveRange,
  runQuery,
  groupRows,
  formatQueryFacts,
  sanitizeQuerySpec,
  isEmptySpec,
} from '../chatQuery.js';

const TODAY = '2026-07-21';

// A slice of the real ledger from the bug report: the question was "how much
// did I spend on eggs" and the chat answered with the whole food category.
const EXPENSES = [
  { id: '1', date: '2026-07-19', amount: 310, categoryId: 'food', walletId: 'bank', note: 'Rice5kgs' },
  { id: '2', date: '2026-07-18', amount: 8, categoryId: 'food', walletId: 'bank', note: 'Tomotoes' },
  { id: '3', date: '2026-07-17', amount: 70, categoryId: 'food', walletId: 'bank', note: 'Sambar rice' },
  { id: '4', date: '2026-07-12', amount: 193, categoryId: 'food', walletId: 'bank', note: 'Eggs+tray' },
  { id: '5', date: '2026-07-07', amount: 70, categoryId: 'food', walletId: 'upi_lite', note: 'Eggs' },
  { id: '6', date: '2026-05-18', amount: 84, categoryId: 'food', walletId: 'bank', note: 'Rice+eggs' },
  { id: '7', date: '2026-05-20', amount: 50, categoryId: 'food', walletId: 'bank', note: 'Carrots' },
  { id: '8', date: '2026-06-02', amount: 640, categoryId: 'transport', walletId: 'cash', note: 'Petrol' },
];
const INCOMES = [
  { id: 'i1', date: '2026-07-01', amount: 40000, sourceId: 'salary', walletId: 'bank', note: 'July salary' },
  { id: 'i2', date: '2026-06-01', amount: 40000, sourceId: 'salary', walletId: 'bank', note: 'June salary' },
];

const NAMES = {
  categoryName: id => ({ food: 'Food & Drinks', transport: 'Transport' }[id] || ''),
  walletName: id => ({ bank: 'Bank', cash: 'Cash', upi_lite: 'UPI Lite' }[id] || ''),
  sourceName: id => ({ salary: 'Salary' }[id] || ''),
};

const rows = buildQueryRows({ expenses: EXPENSES, incomes: INCOMES, ...NAMES });
const spec = o => sanitizeQuerySpec(o, { categories: ['Food & Drinks', 'Transport'], wallets: ['Bank', 'Cash', 'UPI Lite'], sources: ['Salary'] });

describe('buildQueryRows', () => {
  it('normalises expenses and incomes into one row shape', () => {
    expect(rows).toHaveLength(10);
    const egg = rows.find(r => r.id === '5');
    expect(egg).toMatchObject({ kind: 'expense', date: '2026-07-07', amount: 70, category: 'Food & Drinks', wallet: 'UPI Lite', note: 'Eggs' });
    const sal = rows.find(r => r.id === 'i1');
    expect(sal).toMatchObject({ kind: 'income', source: 'Salary', category: '' });
  });

  it('drops rows with no date rather than sorting them unpredictably', () => {
    const r = buildQueryRows({ expenses: [{ id: 'x', amount: 5 }], incomes: [{ id: 'y', amount: 5 }], ...NAMES });
    expect(r).toEqual([]);
  });
});

describe('resolveRange', () => {
  it('resolves this_month from the first of the month to today', () => {
    expect(resolveRange({ preset: 'this_month' }, TODAY)).toMatchObject({ from: '2026-07-01', to: TODAY });
  });

  it('resolves last_month to the full previous calendar month', () => {
    expect(resolveRange({ preset: 'last_month' }, TODAY)).toMatchObject({ from: '2026-06-01', to: '2026-06-30' });
  });

  it('rolls last_month back across a year boundary', () => {
    expect(resolveRange({ preset: 'last_month' }, '2026-01-09')).toMatchObject({ from: '2025-12-01', to: '2025-12-31' });
  });

  it('handles February in a leap year', () => {
    expect(resolveRange({ preset: 'month', month: '2028-02' }, TODAY)).toMatchObject({ from: '2028-02-01', to: '2028-02-29' });
  });

  it('resolves last_n_days inclusive of today', () => {
    expect(resolveRange({ preset: 'last_n_days', days: 7 }, TODAY)).toMatchObject({ from: '2026-07-15', to: TODAY });
  });

  it('resolves yesterday across a month boundary', () => {
    expect(resolveRange({ preset: 'yesterday' }, '2026-07-01')).toMatchObject({ from: '2026-06-30', to: '2026-06-30' });
  });

  it('treats an unknown preset and "all" as unbounded', () => {
    expect(resolveRange({ preset: 'nonsense' }, TODAY)).toMatchObject({ from: null, to: null });
    expect(resolveRange({ preset: 'all' }, TODAY)).toMatchObject({ from: null, to: null });
  });

  it('accepts explicit custom bounds and ignores malformed ones', () => {
    expect(resolveRange({ preset: 'custom', from: '2026-01-01', to: '2026-03-31' }, TODAY)).toMatchObject({ from: '2026-01-01', to: '2026-03-31' });
    expect(resolveRange({ preset: 'custom', from: 'junk', to: 'junk' }, TODAY)).toMatchObject({ from: null, to: null });
  });
});

describe('runQuery — keyword matching (the eggs bug)', () => {
  it('matches only rows whose note actually mentions the keyword', () => {
    const r = runQuery(rows, spec({ keywords: ['egg'] }), TODAY);
    expect(r.rows.map(x => x.note)).toEqual(['Eggs+tray', 'Eggs', 'Rice+eggs']);
    expect(r.total).toBe(347);
    expect(r.count).toBe(3);
  });

  it('folds singular/plural so "eggs" finds "Eggs" and "egg"', () => {
    expect(runQuery(rows, spec({ keywords: ['eggs'] }), TODAY).count).toBe(3);
    expect(runQuery(rows, spec({ keywords: ['egg'] }), TODAY).count).toBe(3);
  });

  it('does NOT fall back to the whole category when nothing matches', () => {
    const r = runQuery(rows, spec({ keywords: ['caviar'] }), TODAY);
    expect(r.count).toBe(0);
    expect(r.total).toBe(0);
  });

  it('matches on word boundaries, not substrings', () => {
    const local = buildQueryRows({ expenses: [
      { id: 'a', date: '2026-07-01', amount: 20, categoryId: 'food', walletId: 'cash', note: 'Tea' },
      { id: 'b', date: '2026-07-02', amount: 30, categoryId: 'food', walletId: 'cash', note: 'Steam iron' },
    ], incomes: [], ...NAMES });
    const r = runQuery(local, spec({ keywords: ['tea'] }), TODAY);
    expect(r.rows.map(x => x.note)).toEqual(['Tea']);
  });

  it('matches a keyword that appears joined by punctuation', () => {
    const r = runQuery(rows, spec({ keywords: ['rice'] }), TODAY);
    expect(r.rows.map(x => x.note).sort()).toEqual(['Rice+eggs', 'Rice5kgs', 'Sambar rice'].sort());
  });

  it('keywordMode "all" requires every term', () => {
    const anyR = runQuery(rows, spec({ keywords: ['rice', 'egg'], keywordMode: 'any' }), TODAY);
    const allR = runQuery(rows, spec({ keywords: ['rice', 'egg'], keywordMode: 'all' }), TODAY);
    expect(anyR.count).toBeGreaterThan(allR.count);
    expect(allR.rows.map(x => x.note)).toEqual(['Rice+eggs']);
  });

  it('also matches the category name, so "food" finds the category', () => {
    const r = runQuery(rows, spec({ keywords: ['food'] }), TODAY);
    expect(r.count).toBe(7);
  });
});

describe('runQuery — filters', () => {
  it('filters by date window', () => {
    const r = runQuery(rows, spec({ keywords: ['egg'], range: { preset: 'this_month' } }), TODAY);
    expect(r.count).toBe(2);
    expect(r.total).toBe(263);
  });

  it('filters by wallet name', () => {
    const r = runQuery(rows, spec({ wallets: ['UPI Lite'] }), TODAY);
    expect(r.rows.map(x => x.id)).toEqual(['5']);
  });

  it('filters by category name', () => {
    const r = runQuery(rows, spec({ categories: ['Transport'] }), TODAY);
    expect(r.total).toBe(640);
  });

  it('filters by amount thresholds', () => {
    const r = runQuery(rows, spec({ minAmount: 100 }), TODAY);
    expect(r.rows.map(x => x.amount).sort((a, b) => a - b)).toEqual([193, 310, 640]);
  });

  it('queries income separately from expenses', () => {
    const r = runQuery(rows, spec({ type: 'income', range: { preset: 'this_month' } }), TODAY);
    expect(r.count).toBe(1);
    expect(r.total).toBe(40000);
  });

  it('reports both sides separately for type "both"', () => {
    const r = runQuery(rows, spec({ type: 'both', range: { preset: 'this_month' } }), TODAY);
    expect(r.expenseTotal).toBe(651);
    expect(r.incomeTotal).toBe(40000);
    expect(r.total).toBe(40651);
  });
});

describe('runQuery — aggregates and ordering', () => {
  it('computes average, min, max and span from the matched rows only', () => {
    const r = runQuery(rows, spec({ keywords: ['egg'] }), TODAY);
    expect(r.average).toBe(115.67);
    expect(r.min).toBe(70);
    expect(r.max).toBe(193);
    expect(r.first).toBe('2026-05-18');
    expect(r.last).toBe('2026-07-12');
  });

  it('sorts newest first by default and by amount on request', () => {
    expect(runQuery(rows, spec({ keywords: ['egg'] }), TODAY).rows.map(r => r.date))
      .toEqual(['2026-07-12', '2026-07-07', '2026-05-18']);
    expect(runQuery(rows, spec({ keywords: ['egg'], sort: 'amount_desc' }), TODAY).rows.map(r => r.amount))
      .toEqual([193, 84, 70]);
  });

  it('zeroes every aggregate on an empty result instead of producing NaN', () => {
    const r = runQuery(rows, spec({ keywords: ['caviar'] }), TODAY);
    expect(r).toMatchObject({ count: 0, total: 0, average: 0, min: 0, max: 0, first: null, last: null });
  });

  it('groups by category / wallet / month', () => {
    expect(groupRows(rows.filter(r => r.kind === 'expense'), 'wallet').map(g => g.key)).toContain('Bank');
    const byMonth = runQuery(rows, spec({ groupBy: 'month' }), TODAY).groups;
    expect(byMonth.map(g => g.key).sort()).toEqual(['2026-05', '2026-06', '2026-07']);
  });

  it('returns null groups when groupBy is none', () => {
    expect(runQuery(rows, spec({ keywords: ['egg'] }), TODAY).groups).toBeNull();
  });
});

describe('sanitizeQuerySpec', () => {
  it('drops category / wallet names the ledger does not have', () => {
    const s = spec({ categories: ['Groceries', 'Food & Drinks'], wallets: ['PayPal'] });
    expect(s.categories).toEqual(['Food & Drinks']);
    expect(s.wallets).toEqual([]);
  });

  it('matches known names case-insensitively', () => {
    expect(spec({ wallets: ['bank'] }).wallets).toEqual(['bank']);
    expect(runQuery(rows, spec({ wallets: ['bank'] }), TODAY).count).toBeGreaterThan(0);
  });

  it('normalises bad enums and rejects non-positive amounts', () => {
    const s = spec({ type: 'guess', sort: 'random', groupBy: 'colour', minAmount: -5, maxAmount: 'abc' });
    expect(s).toMatchObject({ type: 'expense', sort: 'date_desc', groupBy: 'none', minAmount: null, maxAmount: null });
  });

  it('drops one-character keywords that would match everything', () => {
    expect(spec({ keywords: ['a', 'egg', '', null] }).keywords).toEqual(['egg']);
  });

  it('survives a null/garbage spec', () => {
    expect(() => spec(null)).not.toThrow();
    expect(spec(null).range.preset).toBe('all');
  });
});

describe('isEmptySpec', () => {
  it('flags a spec with no filter at all', () => {
    expect(isEmptySpec(spec({}))).toBe(true);
  });

  it('accepts a spec with any real filter', () => {
    expect(isEmptySpec(spec({ keywords: ['egg'] }))).toBe(false);
    expect(isEmptySpec(spec({ range: { preset: 'last_month' } }))).toBe(false);
    expect(isEmptySpec(spec({ groupBy: 'category' }))).toBe(false);
    expect(isEmptySpec(spec({ minAmount: 500 }))).toBe(false);
  });
});

describe('formatQueryFacts', () => {
  it('states the total and lists the matched rows in pipe format', () => {
    const facts = formatQueryFacts(runQuery(rows, spec({ keywords: ['egg'] }), TODAY));
    expect(facts).toContain('TOTAL: ₹347');
    expect(facts).toContain('2026-07-12|193|Food & Drinks|Bank|Eggs+tray');
    expect(facts).toContain('3 expenses matching "egg"');
  });

  it('tells the model to say nothing matched rather than improvise', () => {
    const facts = formatQueryFacts(runQuery(rows, spec({ keywords: ['caviar'] }), TODAY));
    expect(facts).toContain('No rows matched');
    expect(facts).toContain('do not invent');
  });

  it('summarises the overflow when there are more rows than it shows', () => {
    const many = buildQueryRows({
      expenses: Array.from({ length: 12 }, (_, i) => ({ id: 'e' + i, date: '2026-07-0' + ((i % 9) + 1), amount: 10, categoryId: 'food', walletId: 'cash', note: 'egg' })),
      incomes: [], ...NAMES,
    });
    const facts = formatQueryFacts(runQuery(many, spec({ keywords: ['egg'] }), TODAY), { maxRows: 5 });
    expect(facts).toContain('first 5 of 12');
    expect(facts).toContain('7 more rows totalling ₹70');
  });

  it('escapes pipes in a note so the table cannot gain phantom columns', () => {
    const local = buildQueryRows({ expenses: [{ id: 'a', date: '2026-07-01', amount: 20, categoryId: 'food', walletId: 'cash', note: 'egg | extra' }], incomes: [], ...NAMES });
    const facts = formatQueryFacts(runQuery(local, spec({ keywords: ['egg'] }), TODAY));
    expect(facts).toContain('2026-07-01|20|Food & Drinks|Cash|egg extra');
  });
});
