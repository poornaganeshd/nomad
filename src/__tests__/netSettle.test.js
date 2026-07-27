import { describe, it, expect } from 'vitest';
import { roundMoney, settlementNetAmount } from '../financeUtils.js';

// Mirrors the PARTIAL branch of `settleNet` in App.jsx (the way
// balances.test.js mirrors wBal). If you change the allocation order, the
// write-off marking, or the "left / written off" arithmetic there, update this
// copy to match.
//
// The bug this guards: a partial net settle ("₹240 of the ₹300 I owe Rakesh")
// left the unpaid ₹60 stranded — the only way to close it was to skip each
// leftover IOU one at a time. `forgiveRemainder` makes the sheet's write-off
// toggle clear the person in the same action.
function settleNetPartial(splits, settlements, { name, payAmt, forgiveRemainder = false }) {
  const remOf = s => roundMoney(s.amount - settlements.filter(x => x.splitId === s.id).reduce((t, x) => t + settlementNetAmount(x), 0));
  const nameLc = String(name || '').trim().toLowerCase();
  const items = splits
    .filter(s => (s.name || '').trim().toLowerCase() === nameLc && !s.deleted_at && !s.settled && !s.skipped)
    .map(s => ({ s, rem: remOf(s) }))
    .filter(x => x.rem > 0.005);
  if (!items.length) return null;

  const net = roundMoney(items.reduce((t, x) => t + (x.s.direction === 'owed' ? x.rem : -x.rem), 0));
  const payNum = Number(payAmt);
  const isPartial = roundMoney(payNum) < Math.abs(net) - 0.005;
  if (!isPartial) return { partial: false };

  const dir = net > 0 ? 'owed' : 'owe';
  let cap = roundMoney(Math.min(payNum, Math.abs(net)));
  const recs = []; const doneIds = []; const paidById = {};
  const ordered = items.filter(i => i.s.direction === dir).sort((a, b) => (a.s.eventId ? 1 : 0) - (b.s.eventId ? 1 : 0));
  for (const x of ordered) {
    if (cap <= 0.005) break;
    const pay = roundMoney(Math.min(x.rem, cap));
    recs.push({ splitId: x.s.id, amount: pay, direction: x.s.direction });
    paidById[x.s.id] = pay;
    if (pay >= x.rem - 0.005) doneIds.push(x.s.id);
    cap = roundMoney(cap - pay);
  }
  const paid = roundMoney(recs.reduce((t, r) => t + r.amount, 0));
  const writtenOffIds = forgiveRemainder
    ? items.filter(x => roundMoney(x.rem - (paidById[x.s.id] || 0)) > 0.005).map(x => x.s.id)
    : [];
  const after = splits.map(s => {
    if (doneIds.includes(s.id)) return { ...s, settled: true };
    if (writtenOffIds.includes(s.id)) return { ...s, settled: true, skipped: true };
    return s;
  });
  return {
    partial: true, net, paid, recs, doneIds, writtenOffIds, splits: after,
    remaining: roundMoney(Math.abs(net) - paid),
  };
}

const owe = (id, amount, name = 'Rakesh', extra = {}) => ({ id, name, amount, direction: 'owe', settled: false, ...extra });
const owed = (id, amount, name = 'Rakesh', extra = {}) => ({ id, name, amount, direction: 'owed', settled: false, ...extra });
const allPending = res => res.splits.filter(s => !s.settled && !s.skipped);

describe('settleNet partial — allocation', () => {
  it('pays down IOUs of the net direction up to the entered amount', () => {
    const splits = [owe('a', 300)];
    const r = settleNetPartial(splits, [], { name: 'Rakesh', payAmt: 240 });
    expect(r.paid).toBe(240);
    expect(r.remaining).toBe(60);
    expect(r.doneIds).toEqual([]);
    expect(allPending(r)).toHaveLength(1);
  });

  it('marks fully-covered IOUs settled and stops at the cap', () => {
    const splits = [owe('a', 15), owe('b', 10), owe('c', 92.5)];
    const r = settleNetPartial(splits, [], { name: 'Rakesh', payAmt: 30 });
    expect(r.paid).toBe(30);
    expect(r.doneIds).toEqual(['a', 'b']);
    expect(r.recs).toHaveLength(3);
    expect(r.recs[2]).toMatchObject({ splitId: 'c', amount: 5 });
    expect(allPending(r).map(s => s.id)).toEqual(['c']);
  });

  it('pays general IOUs before event IOUs', () => {
    const splits = [owe('ev', 100, 'Rakesh', { eventId: 'e1' }), owe('gen', 100)];
    const r = settleNetPartial(splits, [], { name: 'Rakesh', payAmt: 100 });
    expect(r.recs.map(x => x.splitId)).toEqual(['gen']);
  });

  it('measures the remainder against prior settlements, not the original amount', () => {
    const splits = [owe('a', 300)];
    const settlements = [{ splitId: 'a', amount: 100 }];
    const r = settleNetPartial(splits, settlements, { name: 'Rakesh', payAmt: 50 });
    expect(r.net).toBe(-200);
    expect(r.remaining).toBe(150);
  });

  it('is not partial when the entered amount covers the whole net', () => {
    expect(settleNetPartial([owe('a', 300)], [], { name: 'Rakesh', payAmt: 300 }).partial).toBe(false);
  });

  it('nets opposite directions before deciding what is partial', () => {
    // Owe 300, owed 100 → net 200 owed out. Paying 200 clears the net.
    const splits = [owe('a', 300), owed('b', 100)];
    expect(settleNetPartial(splits, [], { name: 'Rakesh', payAmt: 200 }).partial).toBe(false);
    expect(settleNetPartial(splits, [], { name: 'Rakesh', payAmt: 150 }).net).toBe(-200);
  });
});

describe('settleNet partial — forgiveRemainder (write off the rest)', () => {
  it('clears the person and writes off the unpaid tail', () => {
    const splits = [owe('a', 300)];
    const r = settleNetPartial(splits, [], { name: 'Rakesh', payAmt: 240, forgiveRemainder: true });
    expect(r.paid).toBe(240);
    expect(r.remaining).toBe(60);
    expect(r.writtenOffIds).toEqual(['a']);
    expect(allPending(r)).toHaveLength(0);
    expect(r.splits[0]).toMatchObject({ settled: true, skipped: true });
  });

  it('leaves fully-paid IOUs settled but NOT marked as write-offs', () => {
    const splits = [owe('a', 15), owe('b', 10), owe('c', 92.5)];
    const r = settleNetPartial(splits, [], { name: 'Rakesh', payAmt: 30, forgiveRemainder: true });
    expect(r.doneIds).toEqual(['a', 'b']);
    expect(r.writtenOffIds).toEqual(['c']);
    expect(r.splits.find(s => s.id === 'a').skipped).toBeUndefined();
    expect(r.splits.find(s => s.id === 'c')).toMatchObject({ settled: true, skipped: true });
    expect(allPending(r)).toHaveLength(0);
  });

  it('also closes opposite-direction IOUs the net cancelled on paper', () => {
    const splits = [owe('a', 300), owed('b', 100)];
    const r = settleNetPartial(splits, [], { name: 'Rakesh', payAmt: 150, forgiveRemainder: true });
    expect(r.writtenOffIds.sort()).toEqual(['a', 'b']);
    expect(allPending(r)).toHaveLength(0);
  });

  it('the write-off ledger picks up exactly the unpaid remainder', () => {
    const splits = [owe('a', 300)];
    const r = settleNetPartial(splits, [], { name: 'Rakesh', payAmt: 240, forgiveRemainder: true });
    // computeWriteOffs semantics (see writeOffs.test.js): skipped rows count
    // their amount MINUS payments recorded against them.
    const paidAgainst = r.recs.filter(x => x.splitId === 'a').reduce((t, x) => t + x.amount, 0);
    const forgiven = roundMoney(r.splits[0].amount - paidAgainst);
    expect(forgiven).toBe(60);
  });

  it('without the flag the tail stays pending — the original behaviour', () => {
    const splits = [owe('a', 300)];
    const r = settleNetPartial(splits, [], { name: 'Rakesh', payAmt: 240 });
    expect(r.writtenOffIds).toEqual([]);
    expect(allPending(r)).toHaveLength(1);
  });

  it('ignores already-skipped and soft-deleted IOUs entirely', () => {
    const splits = [
      owe('a', 300),
      owe('b', 50, 'Rakesh', { settled: true, skipped: true }),
      owe('c', 50, 'Rakesh', { deleted_at: '2026-07-01T00:00:00Z' }),
    ];
    const r = settleNetPartial(splits, [], { name: 'Rakesh', payAmt: 240, forgiveRemainder: true });
    expect(r.net).toBe(-300);
    expect(r.writtenOffIds).toEqual(['a']);
  });
});
