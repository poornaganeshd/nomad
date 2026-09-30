import { describe, it, expect } from 'vitest';
import { catCompareWindow, catCompareLabel, catWindowLabel, spendChange, categorySpend, localDateKey } from '../financeUtils.js';

// Spending by Category (App.jsx) was hard-pinned to the current month and its
// "MoM" compared month-to-date against ALL of last month, so early in a month
// every row read as a steep drop. These are the helpers behind its ‹ month ›
// stepper and the like-for-like comparison it now shares with the donut.

const k = d => localDateKey(d);
const TODAY = new Date(2026, 8, 15, 12); // Tue 15 Sep 2026

describe('catCompareWindow — like-for-like comparison', () => {
  it('month-to-date compares the SAME days of last month', () => {
    const w = catCompareWindow('month', 0, TODAY);
    expect(k(w.start)).toBe('2026-09-01');
    expect(k(w.end)).toBe('2026-09-16');
    expect(k(w.prevStart)).toBe('2026-08-01');
    expect(k(w.prevEnd)).toBe('2026-08-16'); // 1–15 Aug, exclusive end
    expect(w.partial).toBe(true);
  });

  it('on the last day of a month, compares the whole month with the whole previous one', () => {
    const w = catCompareWindow('month', 0, new Date(2026, 8, 30, 12));
    expect(k(w.prevStart)).toBe('2026-08-01');
    expect(k(w.prevEnd)).toBe('2026-09-01'); // all of August, including the 31st
    expect(w.partial).toBe(false);
  });

  it('a day the shorter month lacks clamps to the whole of it (30 Mar → all Feb)', () => {
    const w = catCompareWindow('month', 0, new Date(2026, 2, 30, 12));
    expect(k(w.prevStart)).toBe('2026-02-01');
    expect(k(w.prevEnd)).toBe('2026-03-01');
    expect(w.partial).toBe(false);
    const w27 = catCompareWindow('month', 0, new Date(2026, 2, 27, 12));
    expect(k(w27.prevEnd)).toBe('2026-02-28'); // 1–27 Feb
  });

  it('a past month is compared with the whole month before it', () => {
    const w = catCompareWindow('month', 1, TODAY);
    expect(k(w.start)).toBe('2026-08-01');
    expect(k(w.end)).toBe('2026-09-01');
    expect(k(w.prevStart)).toBe('2026-07-01');
    expect(k(w.prevEnd)).toBe('2026-08-01');
    expect(w.partial).toBe(false);
  });

  it('January compares with December across the year boundary', () => {
    const w = catCompareWindow('month', 0, new Date(2027, 0, 10, 12));
    expect(k(w.prevStart)).toBe('2026-12-01');
    expect(k(w.prevEnd)).toBe('2026-12-11');
  });

  it('week, 3m and year are cut to the same point too', () => {
    const wk = catCompareWindow('week', 0, TODAY); // Sun 13 → Tue 15
    expect(k(wk.prevStart)).toBe('2026-09-06');
    expect(k(wk.prevEnd)).toBe('2026-09-09');
    const q = catCompareWindow('3m', 0, TODAY); // Jul 1 → Sep 15
    expect(k(q.prevStart)).toBe('2026-04-01');
    expect(k(q.prevEnd)).toBe('2026-06-16');
    const y = catCompareWindow('year', 0, TODAY);
    expect(k(y.prevStart)).toBe('2025-01-01');
    expect(k(y.prevEnd)).toBe('2025-09-16');
  });

  it('never reaches into the period it is compared with', () => {
    for (const range of ['week', 'month', '3m', 'year']) {
      for (let d = 1; d <= 31; d++) {
        const today = new Date(2026, 2, d, 12); // March, incl. the Feb-clamp days
        const w = catCompareWindow(range, 0, today);
        expect(w.prevEnd <= w.start).toBe(true);
        expect(w.prevStart < w.prevEnd).toBe(true);
      }
    }
  });
});

describe('catCompareLabel', () => {
  it('names the comparison month', () => {
    expect(catCompareLabel('month', 0, catCompareWindow('month', 0, TODAY))).toBe('vs 1–15 Aug');
    expect(catCompareLabel('month', 1, catCompareWindow('month', 1, TODAY))).toBe('vs Jul');
    expect(catCompareLabel('month', 0, catCompareWindow('month', 0, new Date(2026, 8, 1, 12)))).toBe('vs 1 Aug');
    expect(catCompareLabel('month', 0, catCompareWindow('month', 0, new Date(2026, 8, 30, 12)))).toBe('vs Aug');
  });

  it('keeps the short forms for the other ranges', () => {
    expect(catCompareLabel('week', 0, catCompareWindow('week', 0, TODAY))).toBe('vs last week');
    expect(catCompareLabel('year', 0, catCompareWindow('year', 0, TODAY))).toBe('vs 2025 to date');
    expect(catCompareLabel('year', 1, catCompareWindow('year', 1, TODAY))).toBe('vs 2024');
  });

  it('pairs with the stepper label', () => {
    const w = catCompareWindow('month', 2, TODAY);
    expect(catWindowLabel('month', 2, w, TODAY)).toBe('Jul 2026');
    expect(catWindowLabel('month', 0, catCompareWindow('month', 0, TODAY), TODAY)).toBe('This month');
  });
});

describe('spendChange', () => {
  it('is NEW when nothing was spent last time, and null when neither period has spend', () => {
    expect(spendChange(500, 0)).toEqual({ kind: 'new', text: 'NEW' });
    expect(spendChange(0, 0)).toBeNull();
  });

  it('reads as a rounded percentage in both directions', () => {
    expect(spendChange(114, 100)).toMatchObject({ kind: 'up', pct: 14, text: '+14%' });
    expect(spendChange(27, 100)).toMatchObject({ kind: 'down', pct: -73, text: '−73%' });
    expect(spendChange(0, 100)).toMatchObject({ kind: 'down', pct: -100 });
  });

  it('unchanged spending is FLAT, not a saving', () => {
    expect(spendChange(500, 500)).toMatchObject({ kind: 'flat', text: '0%' });
    expect(spendChange(500.2, 500)).toMatchObject({ kind: 'flat' }); // rounds to 0%
  });

  it('turns an unreadable percentage off a tiny base into a multiple', () => {
    // The screenshot bug: ₹1 → ₹485.22 rendered as "+48422% MoM".
    expect(spendChange(485.22, 1)).toMatchObject({ kind: 'up', text: '485×' });
    expect(spendChange(1100, 100)).toMatchObject({ text: '11×' });
    expect(spendChange(1099, 100)).toMatchObject({ text: '+999%' });
  });

  it('works in rupees, not floating-point dust', () => {
    expect(spendChange(0.1 + 0.2, 0.3)).toMatchObject({ kind: 'flat' });
  });
});

describe('categorySpend', () => {
  const E = (id, date, amount, categoryId, extra = {}) => ({ id, date, amount, categoryId, ...extra });
  const expenses = [
    E('a', '2026-09-02', 300, 'food'),
    E('b', '2026-09-10', 120.5, 'food'),
    E('c', '2026-09-05', 2000, 'rent', { recurring: true }),
    E('d', '2026-08-03', 200, 'food'),
    E('e', '2026-08-20', 999, 'food'), // after 15 Aug — not in the like-for-like window
    E('f', '2026-08-01', 2000, 'rent', { recurring: true }),
    E('g', '2026-07-12', 50, 'travel'),
  ];
  const isFixed = e => e.recurring === true;

  it('totals, counts and sorts the viewed month', () => {
    const r = categorySpend(expenses, 'month', 0, TODAY, { isFixed });
    expect(r.rows.map(x => x.cid)).toEqual(['rent', 'food']);
    const food = r.rows.find(x => x.cid === 'food');
    expect(food.total).toBe(420.5);
    expect(food.count).toBe(2);
    expect(food.items.map(i => i.id)).toEqual(['b', 'a']); // newest first
    expect(r.total).toBe(2420.5);
    expect(r.count).toBe(3);
  });

  it('compares like-for-like: late-August spend does not count against mid-September', () => {
    const r = categorySpend(expenses, 'month', 0, TODAY, { isFixed });
    const food = r.rows.find(x => x.cid === 'food');
    expect(food.prevTotal).toBe(200); // only 3 Aug; 20 Aug is past the cut
    expect(food.change).toMatchObject({ kind: 'up', pct: 110 });
    expect(r.rows.find(x => x.cid === 'rent').change).toMatchObject({ kind: 'flat' });
    expect(r.prevTotal).toBe(2200);
  });

  it('browses a past month in full', () => {
    const r = categorySpend(expenses, 'month', 1, TODAY, { isFixed });
    expect(r.rows.map(x => [x.cid, x.total])).toEqual([['rent', 2000], ['food', 1199]]);
    expect(r.rows.find(x => x.cid === 'food').change).toEqual({ kind: 'new', text: 'NEW' });
    const jul = categorySpend(expenses, 'month', 2, TODAY, { isFixed });
    expect(jul.rows.map(x => x.cid)).toEqual(['travel']);
  });

  it('flags FIXED only when every real (non-settlement) row is recurring', () => {
    const rows = [
      E('r1', '2026-09-01', 500, 'sip', { recurring: true }),
      E('s1', '2026-09-02', 80, 'sip', { __settlement: true }),
      E('x1', '2026-09-03', 80, 'food'),
      E('x2', '2026-09-04', 40, 'food', { recurring: true }),
      E('s2', '2026-09-04', 60, 'gift', { __settlement: true }),
    ];
    const r = categorySpend(rows, 'month', 0, TODAY, { isFixed });
    const by = Object.fromEntries(r.rows.map(x => [x.cid, x.fixed]));
    expect(by).toEqual({ sip: true, food: false, gift: false });
  });

  it('files a missing category under "uncat" and ignores rows it cannot place', () => {
    const r = categorySpend([E('u', '2026-09-03', 40, undefined), { id: 'n', amount: 5 }, null, E('z', '2026-09-04', 0, 'food')], 'month', 0, TODAY);
    expect(r.rows.map(x => x.cid)).toEqual(['uncat']); // a ₹0 row says nothing
  });

  it('accepts timestamp-shaped dates by their day', () => {
    const r = categorySpend([E('t', '2026-09-03T18:30:00', 40, 'food')], 'month', 0, TODAY);
    expect(r.total).toBe(40);
  });

  it('sums to the paisa', () => {
    const many = Array.from({ length: 10 }, (_, i) => E(`p${i}`, '2026-09-02', 0.1, 'food'));
    expect(categorySpend(many, 'month', 0, TODAY).total).toBe(1);
  });
});
