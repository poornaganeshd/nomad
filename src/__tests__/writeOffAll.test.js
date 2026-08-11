import { describe, it, expect } from 'vitest';
import { roundMoney, pendingIouNet, settlementsBySplit, settlementNetAmount } from '../financeUtils.js';

// Two things guarded here:
//  1. `pendingIouNet` — the single answer to "what will a net settle move",
//     which a settle sheet has to quote so its button can't promise a figure the
//     handler then contradicts.
//  2. The FULL WRITE-OFF branch of settleNet / settleEventNet in App.jsx
//     (mirrored below, like netSettle.test.js mirrors the partial branch).

const owe = (id, amount, name = 'Rakesh', extra = {}) => ({ id, name, amount, direction: 'owe', settled: false, ...extra });
const owed = (id, amount, name = 'Rakesh', extra = {}) => ({ id, name, amount, direction: 'owed', settled: false, ...extra });

describe('pendingIouNet — what a net settle will actually move', () => {
  it('nets owe against owed on the REMAINING balance', () => {
    const splits = [owed('a', 500), owe('b', 200)];
    expect(pendingIouNet(splits, [])).toBe(300);
    // ₹100 already collected against the 500 → net drops to 200.
    expect(pendingIouNet(splits, [{ splitId: 'a', amount: 100, direction: 'owed' }])).toBe(200);
  });

  it('ignores settled, written-off and soft-deleted rows', () => {
    const splits = [
      owed('a', 100),
      owed('b', 50, 'Rakesh', { settled: true }),
      owed('c', 40, 'Rakesh', { settled: true, skipped: true }),
      owed('d', 30, 'Rakesh', { deleted_at: '2026-01-01' }),
    ];
    expect(pendingIouNet(splits, [])).toBe(100);
  });

  it('reads settlements net of overpay excess, so change does not inflate the net', () => {
    // Owed ₹11.66, they sent ₹12 → only 11.66 pays down the IOU.
    const splits = [owed('a', 11.66)];
    expect(pendingIouNet(splits, [{ splitId: 'a', amount: 12, excess: 0.34, direction: 'owed' }])).toBe(0);
  });

  it('a fully cancelled pair nets to zero, not to its gross', () => {
    expect(pendingIouNet([owed('a', 250), owe('b', 250)], [])).toBe(0);
  });

  it('settlementsBySplit sums per split and skips rows with no split', () => {
    const m = settlementsBySplit([
      { splitId: 'a', amount: 10, direction: 'owed' },
      { splitId: 'a', amount: 5, direction: 'owed' },
      { amount: 99, direction: 'owed' },
    ]);
    expect(m).toEqual({ a: 15 });
  });
});

// ── mirror of the FULL WRITE-OFF branch in settleNet / settleEventNet ────────
// Amount exactly 0 + forgiveRemainder. NO settlement row is written (no cash
// moved), every in-scope IOU is closed into the write-off ledger, and the cash
// invariant is checked against zero.
const isFullWriteOff = (opts, hasPayAmt, payNum) =>
  !!opts.forgiveRemainder && hasPayAmt && Number.isFinite(payNum) && roundMoney(payNum) === 0;

function settleNetWriteOff(splits, settlements, { name, payAmt, ...opts }) {
  const paid = settlementsBySplit(settlements);
  const nameLc = String(name || '').trim().toLowerCase();
  const items = splits
    .filter(s => (s.name || '').trim().toLowerCase() === nameLc && !s.deleted_at && !s.settled && !s.skipped)
    .map(s => ({ s, rem: roundMoney(s.amount - (paid[s.id] || 0)) }))
    .filter(x => x.rem > 0.005);
  if (!items.length) return { refused: 'nothing-pending' };
  const net = roundMoney(items.reduce((t, x) => t + (x.s.direction === 'owed' ? x.rem : -x.rem), 0));
  const hasPayAmt = payAmt != null && payAmt !== '';
  const payNum = hasPayAmt ? Number(payAmt) : null;
  if (!isFullWriteOff(opts, hasPayAmt, payNum)) return { wroteOff: false, net };
  const expected = opts.expectCash;
  if (expected != null && Math.abs(roundMoney(expected) - 0) > 0.011) return { refused: 'stale' };
  const offIds = items.map(x => x.s.id);
  return {
    wroteOff: true, net, offIds, settlementsWritten: [],
    splits: splits.map(s => (offIds.includes(s.id) ? { ...s, settled: true, skipped: true } : s)),
  };
}

describe('full write-off — a net settle where nothing changes hands', () => {
  it('closes every in-scope IOU and writes NO settlement row', () => {
    const splits = [owed('a', 200), owed('b', 100)];
    const r = settleNetWriteOff(splits, [], { name: 'Rakesh', payAmt: '0', forgiveRemainder: true, expectCash: 0 });
    expect(r.wroteOff).toBe(true);
    expect(r.net).toBe(300);
    // The point: no cash record. A settlement is the record of money moving
    // through a wallet, and none did — inventing one credits a bank that never
    // saw the money.
    expect(r.settlementsWritten).toEqual([]);
    expect(r.splits.every(s => s.settled && s.skipped)).toBe(true);
  });

  it('writes off BOTH directions, so the ledger nets to what you really gave up', () => {
    // They owe you 500, you owe them 200 → walking away costs you 300 net.
    const splits = [owed('a', 500), owe('b', 200)];
    const r = settleNetWriteOff(splits, [], { name: 'Rakesh', payAmt: '0', forgiveRemainder: true, expectCash: 0 });
    const off = r.splits.filter(s => s.skipped);
    const lost = off.filter(s => s.direction === 'owed').reduce((t, s) => t + s.amount, 0);
    const forgiven = off.filter(s => s.direction === 'owe').reduce((t, s) => t + s.amount, 0);
    expect(roundMoney(forgiven - lost)).toBe(-300);
    expect(roundMoney(forgiven - lost)).toBe(-r.net);
  });

  it('only the unpaid remainder is written off after a part payment', () => {
    const splits = [owed('a', 300)];
    const settlements = [{ splitId: 'a', amount: 120, direction: 'owed' }];
    const r = settleNetWriteOff(splits, settlements, { name: 'Rakesh', payAmt: '0', forgiveRemainder: true, expectCash: 0 });
    expect(r.net).toBe(180);
    const s = r.splits[0];
    expect(roundMoney(s.amount - settlementNetAmount(settlements[0]))).toBe(180);
    expect(s.skipped).toBe(true);
  });

  it('zero WITHOUT the write-off flag is not a write-off — and never a full settle', () => {
    // The old behaviour: `0` fell through the "is this partial?" test and settled
    // the whole net as if it had been paid in full.
    const r = settleNetWriteOff([owed('a', 300)], [], { name: 'Rakesh', payAmt: '0' });
    expect(r.wroteOff).toBe(false);
  });

  it('still honours the cash invariant — a stale sheet is refused', () => {
    // Sheet thought money was moving; the write-off path moves none.
    const r = settleNetWriteOff([owed('a', 300)], [], { name: 'Rakesh', payAmt: '0', forgiveRemainder: true, expectCash: 300 });
    expect(r.refused).toBe('stale');
  });

  it('a person with nothing pending cannot be written off', () => {
    const r = settleNetWriteOff([owed('a', 300, 'Rakesh', { settled: true })], [], { name: 'Rakesh', payAmt: '0', forgiveRemainder: true, expectCash: 0 });
    expect(r.refused).toBe('nothing-pending');
  });
});
