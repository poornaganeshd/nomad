import { describe, it, expect } from 'vitest';
import { balanceTrail, runwayInfo, monotonePathD, smoothSeries } from '../financeUtils';

const TODAY = '2026-07-16';

describe('balanceTrail', () => {
  it('returns days+1 points ending at the current balance today', () => {
    const t = balanceTrail(5000, [], { days: 30, todayKey: TODAY });
    expect(t).toHaveLength(31);
    expect(t[30]).toEqual({ date: '2026-07-16', bal: 5000 });
    expect(t[0].date).toBe('2026-06-16');
  });

  it('walks backward subtracting each day\'s net delta', () => {
    const events = [
      { date: '2026-07-16', amount: -200 }, // spent today
      { date: '2026-07-15', amount: 1000 }, // income yesterday
    ];
    const t = balanceTrail(5000, events, { days: 3, todayKey: TODAY });
    // today 5000; end of 15th = 5000 - (-200) = 5200; end of 14th = 5200 - 1000 = 4200
    expect(t.map(p => p.bal)).toEqual([4200, 4200, 5200, 5000]);
  });

  it('sums multiple same-day events and ignores events outside the window', () => {
    const events = [
      { date: '2026-07-16', amount: -100 },
      { date: '2026-07-16', amount: -50 },
      { date: '2026-05-01', amount: -99999 }, // long before the window — already inside the oldest balance
      { date: '2026-08-01', amount: 500 },    // future — never visited
    ];
    const t = balanceTrail(1000, events, { days: 2, todayKey: TODAY });
    expect(t.map(p => p.bal)).toEqual([1150, 1150, 1000]);
  });

  it('crosses month boundaries with real calendar dates', () => {
    const t = balanceTrail(0, [], { days: 3, todayKey: '2026-03-02' });
    expect(t.map(p => p.date)).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
  });

  it('rounds to paise and tolerates garbage input', () => {
    const t = balanceTrail('abc', [{ date: '2026-07-16', amount: '0.335' }, null, { amount: 5 }], { days: 1, todayKey: TODAY });
    expect(t[1].bal).toBe(0);
    expect(t[0].bal).toBe(-0.34);
  });
});

describe('runwayInfo', () => {
  // ₹100/day for the last 7 days, ₹50/day for the 21 days before that.
  const spends = [];
  for (let i = 0; i < 7; i++) spends.push({ date: `2026-07-${String(16 - i).padStart(2, '0')}`, amount: 100 });
  for (let i = 7; i < 28; i++) {
    const d = new Date(2026, 6, 16 - i, 12);
    spends.push({ date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, amount: 50 });
  }

  it('computes this-week rate, usual baseline pace, and days of ground', () => {
    const r = runwayInfo(1100, spends, { todayKey: TODAY });
    expect(r.rate).toBe(100);
    expect(r.usual).toBe(50);
    expect(r.daysLeft).toBe(11);
    expect(r.daysAtUsual).toBe(22);
    expect(r.dryBy).toBe('2026-07-27');
  });

  it('returns nulls when there is no burn', () => {
    const r = runwayInfo(5000, [], { todayKey: TODAY });
    expect(r.rate).toBe(0);
    expect(r.daysLeft).toBeNull();
    expect(r.dryBy).toBeNull();
  });

  it('clamps a negative balance to zero ground', () => {
    const r = runwayInfo(-250, spends, { todayKey: TODAY });
    expect(r.daysLeft).toBe(0);
    expect(r.dryBy).toBe(TODAY);
  });

  it('ignores future-dated and non-positive spend rows', () => {
    const r = runwayInfo(1000, [
      { date: '2026-07-20', amount: 999 },
      { date: '2026-07-16', amount: -40 },
      { date: '2026-07-16', amount: 70 },
    ], { todayKey: TODAY });
    expect(r.rate).toBe(10); // 70 / 7
  });
});

// Curve shape for the terrain hero. The old Catmull-Rom spline is what made the
// graph read as "sharp": its tangent at a point came from that point's
// NEIGHBOURS, so a one-day spike drew a hard asymmetric corner and the curve
// overshot past the real value.

// Pull every coordinate out of a path so we can reason about the control points.
const nums = (d) => d.match(/-?\d+(?:\.\d+)?/g).map(Number);
// Control points + endpoint of the i-th cubic segment: "C c1x,c1y c2x,c2y x,y".
const seg = (d, i) => {
  const [c1, c2, end] = d.match(/C[^C]*/g)[i]
    .replace('C', '').trim().split(/\s+/).map((pair) => pair.split(',').map(Number));
  return { c1, c2, end };
};

describe('monotonePathD', () => {
  it('starts at the first point and ends exactly on the last', () => {
    const pts = [{ x: 0, y: 10 }, { x: 10, y: 40 }, { x: 20, y: 25 }];
    const d = monotonePathD(pts);
    expect(d.startsWith('M0.0,10.0')).toBe(true);
    expect(d.trim().endsWith('20.0,25.0')).toBe(true);
  });

  it('passes through every input point (it interpolates, it does not smooth)', () => {
    const pts = [{ x: 0, y: 5 }, { x: 10, y: 90 }, { x: 20, y: 12 }, { x: 30, y: 60 }];
    const d = monotonePathD(pts);
    pts.slice(1).forEach((q) => expect(d).toContain(`${q.x.toFixed(1)},${q.y.toFixed(1)}`));
  });

  it('flattens the tangent at a local peak, so a spike is a rounded crest', () => {
    // Middle point is a peak (y smaller = higher on screen is irrelevant here;
    // what matters is the slope reverses).
    const d = monotonePathD([{ x: 0, y: 100 }, { x: 10, y: 20 }, { x: 20, y: 100 }]);
    // Leaving the peak, the first control point must sit at the peak's own y —
    // a zero tangent. Catmull-Rom would have pulled it off to one side.
    const s = seg(d, 1);
    expect(s.c1[1]).toBeCloseTo(20, 5);
  });

  it('flattens the tangent at a local valley too', () => {
    const d = monotonePathD([{ x: 0, y: 20 }, { x: 10, y: 100 }, { x: 20, y: 20 }]);
    expect(seg(d, 1).c1[1]).toBeCloseTo(100, 5);
  });

  it('never overshoots: control points stay inside each segment\'s y range', () => {
    const ys = [40, 12, 130, 55, 58, 20, 96];
    const pts = ys.map((y, i) => ({ x: i * 10, y }));
    const d = monotonePathD(pts);
    for (let i = 0; i < ys.length - 1; i += 1) {
      const { c1, c2 } = seg(d, i);
      const loY = Math.min(ys[i], ys[i + 1]) - 1e-6, hiY = Math.max(ys[i], ys[i + 1]) + 1e-6;
      expect(c1[1]).toBeGreaterThanOrEqual(loY);
      expect(c1[1]).toBeLessThanOrEqual(hiY);
      expect(c2[1]).toBeGreaterThanOrEqual(loY);
      expect(c2[1]).toBeLessThanOrEqual(hiY);
    }
  });

  it('keeps control points inside the segment horizontally', () => {
    const d = monotonePathD([{ x: 0, y: 0 }, { x: 12, y: 40 }, { x: 24, y: 10 }]);
    const { c1, c2 } = seg(d, 0);
    expect(c1[0]).toBeGreaterThan(0);
    expect(c2[0]).toBeLessThan(12);
  });

  it('handles a flat run without dividing by zero', () => {
    const d = monotonePathD([{ x: 0, y: 50 }, { x: 10, y: 50 }, { x: 20, y: 50 }]);
    expect(nums(d).every(Number.isFinite)).toBe(true);
    expect(d).toContain('20.0,50.0');
  });

  it('handles duplicate x values without producing NaN', () => {
    const d = monotonePathD([{ x: 0, y: 10 }, { x: 0, y: 40 }, { x: 10, y: 20 }]);
    expect(nums(d).every(Number.isFinite)).toBe(true);
  });

  it('degrades gracefully for 0, 1 and 2 points', () => {
    expect(monotonePathD([])).toBe('');
    expect(monotonePathD(null)).toBe('');
    expect(monotonePathD([{ x: 3, y: 4 }])).toBe('M3.0,4.0');
    expect(monotonePathD([{ x: 0, y: 0 }, { x: 5, y: 9 }])).toBe('M0.0,0.0 L5.0,9.0');
  });

  it('drops non-finite points instead of emitting NaN into the path', () => {
    const d = monotonePathD([{ x: 0, y: 10 }, { x: NaN, y: 20 }, { x: 20, y: 30 }, { x: 30, y: null }]);
    expect(d).not.toContain('NaN');
    expect(nums(d).every(Number.isFinite)).toBe(true);
  });
});

describe('smoothSeries', () => {
  it('pins the endpoints, so the trail still starts and ends on real balances', () => {
    const v = [100, 500, 200, 900, 300];
    const out = smoothSeries(v, 2);
    expect(out[0]).toBe(100);
    expect(out[out.length - 1]).toBe(300);
  });

  it('leaves a straight ramp alone (a real trend must not be flattened)', () => {
    expect(smoothSeries([0, 10, 20, 30, 40], 3)).toEqual([0, 10, 20, 30, 40]);
  });

  it('leaves a flat series flat', () => {
    expect(smoothSeries([7, 7, 7, 7], 2)).toEqual([7, 7, 7, 7]);
  });

  it('halves a lone one-day spike in one pass and eases it further in two', () => {
    const one = smoothSeries([0, 0, 100, 0, 0], 1);
    expect(one[2]).toBe(50);
    expect(one[1]).toBe(25);
    const two = smoothSeries([0, 0, 100, 0, 0], 2);
    expect(two[2]).toBeCloseTo(37.5, 6);
  });

  it('never moves a point outside the range of its neighbourhood (no overshoot)', () => {
    const v = [40, 12, 130, 55, 58, 20, 96];
    const out = smoothSeries(v, 2);
    const lo = Math.min(...v), hi = Math.max(...v);
    out.forEach((x) => { expect(x).toBeGreaterThanOrEqual(lo); expect(x).toBeLessThanOrEqual(hi); });
  });

  it('keeps a peak a peak and a dip a dip when they are not adjacent', () => {
    //                  ↑peak            ↓dip
    const out = smoothSeries([50, 50, 90, 50, 50, 10, 50, 50], 2);
    expect(out[2]).toBeGreaterThan(out[1]);
    expect(out[2]).toBeGreaterThan(out[3]);
    expect(out[5]).toBeLessThan(out[4]);
    expect(out[5]).toBeLessThan(out[6]);
  });

  it('deliberately crushes day-to-day zig-zag — that noise IS the "sharpness"', () => {
    // Alternating extremes carry no trend, only visual spikiness. Two passes
    // collapse them toward the local mean, which is the whole point.
    const out = smoothSeries([0, 100, 0, 100, 0, 100, 0], 2);
    out.slice(1, -1).forEach((x) => { expect(x).toBeGreaterThan(20); expect(x).toBeLessThan(80); });
  });

  it('is a no-op for 0 passes and for series too short to smooth', () => {
    expect(smoothSeries([1, 9, 3], 0)).toEqual([1, 9, 3]);
    expect(smoothSeries([5, 9], 3)).toEqual([5, 9]);
    expect(smoothSeries([5], 3)).toEqual([5]);
    expect(smoothSeries([], 3)).toEqual([]);
  });

  it('coerces junk to 0 rather than propagating NaN through the curve', () => {
    const out = smoothSeries([10, null, undefined, 'x', 20], 1);
    expect(out.every(Number.isFinite)).toBe(true);
  });

  it('survives a non-array and a negative pass count', () => {
    expect(smoothSeries(null, 2)).toEqual([]);
    expect(smoothSeries([1, 9, 3], -5)).toEqual([1, 9, 3]);
  });
});
