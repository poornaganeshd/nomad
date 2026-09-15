import { describe, it, expect } from 'vitest';
import { catWindow, catWindowLabel, localDateKey } from '../financeUtils.js';

// Category Share (the donut in App.jsx) anchored every range to today, so the
// only month it could ever show was the current one: "Month" meant
// month-to-date and there was no way to reach August from September. These are
// the window bounds behind its period stepper.
//
// The offset-0 window is deliberately clamped to tomorrow — "this month" stays
// month-TO-DATE, exactly as before — while every past window is the full
// period, so browsing back gives whole months rather than a partial one.

const TODAY = new Date(2026, 8, 15); // Tue 15 Sep 2026
const k = d => localDateKey(d);

describe('catWindow — month', () => {
  it('offset 0 is month-to-date (end clamped to tomorrow)', () => {
    const w = catWindow('month', 0, TODAY);
    expect(k(w.start)).toBe('2026-09-01');
    expect(k(w.end)).toBe('2026-09-16');
    expect(k(w.prevStart)).toBe('2026-08-01');
    expect(k(w.prevEnd)).toBe('2026-09-01');
  });

  it('offset 1 is the WHOLE previous month, compared against the one before it', () => {
    const w = catWindow('month', 1, TODAY);
    expect(k(w.start)).toBe('2026-08-01');
    expect(k(w.end)).toBe('2026-09-01');
    expect(k(w.prevStart)).toBe('2026-07-01');
    expect(k(w.prevEnd)).toBe('2026-08-01');
  });

  it('walks back across a year boundary', () => {
    const w = catWindow('month', 10, TODAY); // Nov 2025
    expect(k(w.start)).toBe('2025-11-01');
    expect(k(w.end)).toBe('2025-12-01');
  });
});

describe('catWindow — week, 3m, year', () => {
  it('week offset 0 starts on Sunday and ends tomorrow', () => {
    const w = catWindow('week', 0, TODAY);
    expect(k(w.start)).toBe('2026-09-13'); // Sun
    expect(k(w.end)).toBe('2026-09-16');   // clamped
  });

  it('week offset 1 is the full previous Sun–Sat', () => {
    const w = catWindow('week', 1, TODAY);
    expect(k(w.start)).toBe('2026-09-06');
    expect(k(w.end)).toBe('2026-09-13');
  });

  it('3m steps a whole quarter at a time, never one month', () => {
    const cur = catWindow('3m', 0, TODAY);
    const back = catWindow('3m', 1, TODAY);
    expect(k(cur.start)).toBe('2026-07-01');
    expect(k(back.start)).toBe('2026-04-01');
    expect(k(back.end)).toBe('2026-07-01');
  });

  it('year offset 1 is the whole previous calendar year', () => {
    const w = catWindow('year', 1, TODAY);
    expect(k(w.start)).toBe('2025-01-01');
    expect(k(w.end)).toBe('2026-01-01');
  });

  it('back-to-back windows never overlap and never leave a gap', () => {
    for (const range of ['week', 'month', '3m', 'year']) {
      for (let o = 1; o < 4; o++) {
        const newer = catWindow(range, o - 1, TODAY);
        const older = catWindow(range, o, TODAY);
        expect(k(older.end)).toBe(k(newer.start));
      }
    }
  });
});

describe('catWindowLabel', () => {
  it('names the window instead of counting periods back', () => {
    const lbl = (r, o) => catWindowLabel(r, o, catWindow(r, o, TODAY), TODAY);
    expect(lbl('month', 0)).toBe('This month');
    expect(lbl('month', 1)).toBe('Aug 2026');
    expect(lbl('month', 10)).toBe('Nov 2025');
    expect(lbl('week', 0)).toBe('This week');
    expect(lbl('week', 1)).toBe('Last week');
    expect(lbl('week', 3)).toBe('Week of 23 Aug');
    expect(lbl('year', 0)).toBe('This year');
    expect(lbl('year', 2)).toBe('2024');
    expect(lbl('3m', 0)).toBe('Last 3 months');
    expect(lbl('3m', 1)).toBe('Apr–Jun 2026');
  });

  it('spells out the year on an older week, so two Augusts never read alike', () => {
    expect(catWindowLabel('week', 60, catWindow('week', 60, TODAY), TODAY)).toContain('2025');
  });
});
