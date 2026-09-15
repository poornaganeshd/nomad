import { describe, it, expect } from 'vitest';
import { distributeByWeights, splitWeights, splitIssue, distributeAmount, roundMoney } from '../financeUtils.js';

// The bill splitter could only split equally or by exact rupee amounts. Three
// flatmates where one has the big room, a dinner where two shared a dish, a
// trip someone joined halfway — all weighted, and all of them meant doing the
// arithmetic yourself before typing it in.

const sum = (a) => roundMoney(a.reduce((t, v) => t + v, 0));

describe('distributeByWeights', () => {
  it('splits by ratio', () => {
    expect(distributeByWeights(300, [1, 2])).toEqual([100, 200]);
    expect(distributeByWeights(1000, [50, 30, 20])).toEqual([500, 300, 200]);
  });

  it('ALWAYS sums to exactly the amount — the residue would be an unsettleable IOU', () => {
    // 100 / 3 has no exact answer in paisa; the leftover must still land somewhere.
    const out = distributeByWeights(100, [1, 1, 1]);
    expect(sum(out)).toBe(100);
    expect(out).toEqual([33.34, 33.33, 33.33]);
  });

  it('holds for awkward ratios and odd totals', () => {
    for (const amt of [0.03, 9.99, 1234.57, 100000.01]) {
      for (const w of [[1, 1, 1], [2, 3, 5, 7], [1, 99], [7, 7, 7, 7, 7, 7]]) {
        expect(sum(distributeByWeights(amt, w))).toBe(roundMoney(amt));
      }
    }
  });

  it('gives the spare paisa to the largest remainders, deterministically', () => {
    expect(distributeByWeights(10, [1, 1, 1])).toEqual([3.34, 3.33, 3.33]);
  });

  it('matches distributeAmount when every weight is equal', () => {
    expect(distributeByWeights(100, [1, 1, 1])).toEqual(distributeAmount(100, 3));
    expect(distributeByWeights(77.77, [1, 1, 1, 1])).toEqual(distributeAmount(77.77, 4));
  });

  it('treats a zero or negative weight as taking nothing', () => {
    expect(distributeByWeights(100, [1, 0, 1])).toEqual([50, 0, 50]);
    expect(distributeByWeights(100, [1, -5, 1])).toEqual([50, 0, 50]);
  });

  it('degrades safely on junk input', () => {
    expect(distributeByWeights(100, [])).toEqual([]);
    expect(distributeByWeights(100, [0, 0])).toEqual([0, 0]);
    expect(distributeByWeights(0, [1, 2])).toEqual([0, 0]);
    expect(distributeByWeights(-50, [1, 1])).toEqual([0, 0]);
  });
});

describe('splitWeights', () => {
  it('percent gives YOU whatever is left of 100 — the number you never type', () => {
    expect(splitWeights('percent', { others: [30, 20] })).toEqual([50, 30, 20]);
  });

  it('percent floors your share at zero rather than going negative', () => {
    expect(splitWeights('percent', { others: [80, 60] })[0]).toBe(0);
  });

  it('shares takes your own count', () => {
    expect(splitWeights('shares', { mine: 2, others: [1, 1] })).toEqual([2, 1, 1]);
  });

  it('equal is one head each, You first', () => {
    expect(splitWeights('equal', { others: [5, 5] })).toEqual([1, 1, 1]);
  });

  it('puts You at index 0, like every other share derivation here', () => {
    const w = splitWeights('percent', { others: [25] });
    expect(w[0]).toBe(75);
  });
});

describe('splitIssue', () => {
  it('names what is missing rather than just disabling the button', () => {
    expect(splitIssue('percent', { total: 0, others: [50] })).toBe('Enter the bill total');
    expect(splitIssue('percent', { total: 100, others: [] })).toBe('Add at least one person');
    expect(splitIssue('percent', { total: 100, others: [0] })).toBe("Enter each person's %");
  });

  it('refuses over 100% and says by how much', () => {
    expect(splitIssue('percent', { total: 100, others: [70, 50] })).toBe('That is 120% - over 100%'.replace('-', '—'));
  });

  it('allows under 100% — the rest is simply your share', () => {
    expect(splitIssue('percent', { total: 100, others: [30] })).toBe(null);
  });

  it('allows exactly 100%, leaving you nothing', () => {
    expect(splitIssue('percent', { total: 100, others: [60, 40] })).toBe(null);
    expect(splitWeights('percent', { others: [60, 40] })).toEqual([0, 60, 40]);
  });

  it('shares needs at least one share somewhere', () => {
    expect(splitIssue('shares', { total: 100, mine: 0, others: [0] })).toBe('Give someone at least one share');
    expect(splitIssue('shares', { total: 100, mine: 0, others: [1] })).toBe(null);
  });
});
