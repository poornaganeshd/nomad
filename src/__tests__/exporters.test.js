import { describe, it, expect } from 'vitest';
import { buildWorkbook, buildStatementHtml, inPeriod } from '../exporters.js';

// Export was one flat CSV — every row type crammed into six shared columns, so
// "Category/Source" meant three different things depending on the row — plus a
// JSON backup only NOMAD can open. Neither is what you hand an accountant or
// open beside a bank statement.

const CTRL = String.fromCharCode(1); // illegal in XML 1.0; makes Excel reject the file

const wallets = [{ id: 'bank', name: 'Bank' }, { id: 'cash', name: 'Cash' }];
const categories = [{ id: 'food', name: 'Food & Drinks' }];
const sources = [{ id: 'salary', name: 'Salary' }];
const events = [{ id: 'ev1', name: 'Goa trip' }];
const base = {
  wallets, categories, sources, events,
  expenses: [{ id: 'e1', date: '2026-09-05', amount: 250.5, categoryId: 'food', walletId: 'bank', note: 'Lunch', eventId: 'ev1' }],
  incomes: [{ id: 'i1', date: '2026-09-01', amount: 50000, sourceId: 'salary', walletId: 'bank' }],
  transfers: [{ id: 't1', date: '2026-09-02', amount: 1000, fromWallet: 'bank', toWallet: 'cash' }],
  settlements: [{ id: 's1', date: '2026-09-06', amount: 120, splitName: 'Rafi', direction: 'owed', walletId: 'bank' }],
  splits: [{ id: 'sp1', date: '2026-09-05', name: 'Rafi', amount: 120, direction: 'owed', settled: true }],
  balances: { bank: 48000, cash: 1000 },
  today: '2026-09-15',
};

describe('inPeriod', () => {
  const rows = [{ date: '2026-08-31' }, { date: '2026-09-01' }, { date: '2026-09-30' }, { date: '2026-10-01' }];

  it('is inclusive at BOTH ends — a statement must contain its own last day', () => {
    expect(inPeriod(rows, '2026-09-01', '2026-09-30')).toHaveLength(2);
  });

  it('treats a null bound as unbounded', () => {
    expect(inPeriod(rows, null, null)).toHaveLength(4);
    expect(inPeriod(rows, '2026-09-01', null)).toHaveLength(3);
  });

  it('drops soft-deleted and undated rows rather than exporting them', () => {
    expect(inPeriod([{ date: '2026-09-05', deleted_at: 'x' }, { amount: 5 }, null], null, null)).toEqual([]);
  });
});

describe('buildWorkbook', () => {
  const xml = buildWorkbook(base);

  it('is a SpreadsheetML workbook Excel will open', () => {
    expect(xml.startsWith('<?xml version="1.0"?>')).toBe(true);
    expect(xml).toContain('progid="Excel.Sheet"');
    expect(xml).toContain('urn:schemas-microsoft-com:office:spreadsheet');
  });

  it('gives each row type its OWN sheet and columns', () => {
    ['Summary', 'Expenses', 'Income', 'Transfers', 'Settlements', 'IOUs']
      .forEach(n => expect(xml).toContain(`ss:Name="${n}"`));
    expect(xml).toContain('Category');   // expenses
    expect(xml).toContain('Source');     // income — a different concept
    expect(xml).toContain('Direction');  // settlements
  });

  it('writes amounts as NUMBERS, so a column sums without re-typing it', () => {
    expect(xml).toContain('<Data ss:Type="Number">250.5</Data>');
    expect(xml).toContain('<Data ss:Type="Number">50000</Data>');
  });

  it('resolves ids to the names the user actually sees', () => {
    expect(xml).toContain('Food &amp; Drinks');
    expect(xml).toContain('Goa trip');
    expect(xml).toContain('Salary');
  });

  it('escapes XML so one ampersand cannot corrupt the file', () => {
    const out = buildWorkbook({ ...base, expenses: [{ id: 'e', date: '2026-09-05', amount: 1, note: 'A & B <c> "d"', walletId: 'bank' }] });
    expect(out).toContain('A &amp; B &lt;c&gt; &quot;d&quot;');
  });

  it('strips control characters, which make Excel reject the whole workbook', () => {
    const out = buildWorkbook({ ...base, expenses: [{ id: 'e', date: '2026-09-05', amount: 1, note: `bad${CTRL}byte`, walletId: 'bank' }] });
    expect(out).toContain('badbyte');
    expect(out.includes(CTRL)).toBe(false);
  });

  it('honours the period', () => {
    const out = buildWorkbook({ ...base, from: '2026-09-06', to: '2026-09-30' });
    expect(out).not.toContain('Lunch');        // 09-05, outside
    expect(out).toContain('Rafi');             // 09-06 settlement, inside
  });

  it('carries the summary and wallet balances', () => {
    expect(xml).toContain('<Data ss:Type="Number">48000</Data>');
    expect(xml).toContain('Net');
  });

  it('sanitises a sheet name Excel would reject', () => {
    // Not user-supplied today, but the rule lives with the writer so a future
    // per-event sheet cannot silently produce an unopenable file.
    expect(xml).not.toMatch(/ss:Name="[^"]*[:\\/?*[\]]/);
  });

  it('produces a valid workbook from a completely empty ledger', () => {
    const out = buildWorkbook({ today: '2026-09-15' });
    expect(out).toContain('ss:Name="Expenses"');
    expect(out).toContain('</Workbook>');
  });
});

describe('buildStatementHtml', () => {
  const html = buildStatementHtml({ ...base, periodLabel: 'September 2026', from: '2026-09-01', to: '2026-09-30' });

  it('is a self-contained printable document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('@media print');
    expect(html).toContain('@page');
    expect(html).not.toContain('<script');   // nothing to run, nothing to block printing
  });

  it('leads with the totals someone reads first', () => {
    expect(html).toContain('Money in');
    expect(html).toContain('Money out');
    expect(html).toContain('September 2026');
  });

  it('breaks spending down by category with shares', () => {
    expect(html).toContain('Where it went');
    expect(html).toContain('Food &amp; Drinks');
  });

  it('lists every row type in one date-ordered ledger', () => {
    const order = ['Income', 'Transfer', 'Expense', 'Settlement'].map(k => html.indexOf(`<td>${k}</td>`));
    expect(order.every(i => i > -1)).toBe(true);
    // 09-01 income, 09-02 transfer, 09-05 expense, 09-06 settlement
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('escapes notes — a statement is a document you send to people', () => {
    const out = buildStatementHtml({ ...base, expenses: [{ id: 'e', date: '2026-09-05', amount: 1, note: '<img src=x onerror=alert(1)>', walletId: 'bank' }] });
    expect(out).not.toContain('<img src=x');
    expect(out).toContain('&lt;img src=x');
  });

  it('says so plainly when the period is empty', () => {
    const out = buildStatementHtml({ wallets: [], today: '2026-09-15', from: '2020-01-01', to: '2020-01-31' });
    expect(out).toContain('Nothing logged in this period');
  });
});
