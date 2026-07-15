import { describe, it, expect } from 'vitest';
import { roundMoney, settlementNetAmount } from '../financeUtils.js';

// Mirrors the `writeOffs` useMemo in App.jsx (like balances.test.js mirrors
// wBal). If you change the memo — skipped-remainder maths, excess recovery,
// or the floor-at-zero netting — update this copy to match.
const computeWriteOffs = (sp, stl) => {
  let lost = 0, forgiven = 0, recovered = 0, overpaid = 0;
  (sp || []).forEach(s => {
    if (!s || !s.skipped || s.deleted_at) return;
    const paid = (stl || []).filter(x => x.splitId === s.id).reduce((t, x) => t + settlementNetAmount(x), 0);
    const rem = roundMoney((s.amount || 0) - paid);
    if (rem <= 0.005) return;
    if (s.direction === 'owed') lost = roundMoney(lost + rem); else forgiven = roundMoney(forgiven + rem);
  });
  (stl || []).forEach(x => {
    const e = roundMoney(Number(x.excess) || 0);
    if (e <= 0.005) return;
    if (x.direction === 'owed') recovered = roundMoney(recovered + e); else overpaid = roundMoney(overpaid + e);
  });
  const lostNet = Math.max(0, roundMoney(lost - recovered));
  const forgivenNet = Math.max(0, roundMoney(forgiven - overpaid));
  return { lost: lostNet, forgiven: forgivenNet, recovered, overpaid, net: roundMoney(forgivenNet - lostNet) };
};

const skipped = (id, amount, direction = 'owed') => ({ id, amount, direction, settled: true, skipped: true });
const stlOf = (splitId, amount, direction = 'owed', excess) => ({ splitId, amount, direction, ...(excess ? { excess } : {}) });

describe('writeOffs ledger — skipped remainders net of overpay recovery', () => {
  it('a skipped owed IOU is a loss; a skipped owe IOU is forgiven', () => {
    const r = computeWriteOffs([skipped('a', 5, 'owed'), skipped('b', 3, 'owe')], []);
    expect(r).toEqual({ lost: 5, forgiven: 3, recovered: 0, overpaid: 0, net: -2 });
  });

  it('payments against a skipped IOU shrink its write-off remainder', () => {
    const r = computeWriteOffs([skipped('a', 5)], [stlOf('a', 2)]);
    expect(r.lost).toBe(3);
  });

  it('settle overpay received offsets the lost bucket (the ₹12-for-₹11.66 case)', () => {
    // ₹5 written off earlier; friend later overpays a live IOU by ₹0.34.
    const sp = [skipped('old', 5), { id: 'jai', amount: 11.66, direction: 'owed', settled: true }];
    const stl = [stlOf('jai', 12, 'owed', 0.34)];
    const r = computeWriteOffs(sp, stl);
    expect(r.lost).toBe(4.66);
    expect(r.recovered).toBe(0.34);
    expect(r.net).toBe(-4.66);
  });

  it('excess you paid out offsets the forgiven bucket (symmetric)', () => {
    const sp = [skipped('w', 2, 'owe'), { id: 'x', amount: 10, direction: 'owe', settled: true }];
    const stl = [stlOf('x', 10.5, 'owe', 0.5)];
    const r = computeWriteOffs(sp, stl);
    expect(r.forgiven).toBe(1.5);
    expect(r.overpaid).toBe(0.5);
  });

  it('recovery floors at zero — surplus beyond the write-offs does not go negative', () => {
    const r = computeWriteOffs([], [stlOf('x', 12, 'owed', 2)]);
    expect(r.lost).toBe(0);
    expect(r.recovered).toBe(2);
    expect(r.net).toBe(0);
  });

  it('settle-and-forgive remainder lands as a write-off (underpay accepted as full)', () => {
    // Owed ₹11.66, accepted ₹11.50 as full & final: settlement 11.50 + split
    // flipped to settled+skipped. The 16p remainder is the loss.
    const sp = [{ id: 'jai', amount: 11.66, direction: 'owed', settled: true, skipped: true }];
    const stl = [stlOf('jai', 11.5, 'owed')];
    const r = computeWriteOffs(sp, stl);
    expect(r.lost).toBe(0.16);
  });

  it('excess on a settlement of a skipped IOU is not double-counted in the remainder', () => {
    // Pays 3 against skipped ₹5 with 1 marked excess: only the net 2 reduces
    // the remainder, and the 1 comes back separately as recovery.
    const r = computeWriteOffs([skipped('a', 5)], [stlOf('a', 3, 'owed', 1)]);
    expect(r.lost).toBe(2); // 5 - 2 = 3 remainder, minus 1 recovered = 2
    expect(r.recovered).toBe(1);
  });
});
