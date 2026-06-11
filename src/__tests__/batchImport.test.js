import { describe, it, expect } from 'vitest';
import { roundMoney } from '../financeUtils.js';

// Mirrors makeBatchTracker + the addE/addI balanceDelta integration in App.jsx
// (batch CSV / photo-ledger imports). wBal and balanceOnDate come from React
// state that doesn't update mid-loop, so each entry's validation balance is
// adjusted by the net effect of batch entries already accepted. If the inline
// logic changes in App.jsx, mirror the change here.
const makeBatchTracker = () => {
  const applied = [];
  return {
    deltaFor: (walletId, date, isBackdated) => roundMoney(applied.filter(x => x.walletId === walletId && (!isBackdated || x.date <= date)).reduce((s, x) => s + x.amt, 0)),
    record: (walletId, date, amt) => applied.push({ walletId, date, amt }),
  };
};

// Mirrors the addE acceptance path: balance seen = stale balance + delta,
// reject when it can't cover the amount.
const simulateBatchImport = ({ rows, staleBalance, today }) => {
  const batch = makeBatchTracker();
  const results = [];
  rows.forEach(row => {
    const amount = roundMoney(Number(row.amount) || 0);
    const isBackdated = row.date < today;
    const delta = batch.deltaFor(row.walletId, row.date, isBackdated);
    const b = roundMoney(staleBalance(row.walletId, isBackdated ? row.date : null) + delta);
    if (row.type === 'expense' && b < amount) { results.push({ ok: false, balBefore: b }); return; }
    batch.record(row.walletId, row.date, row.type === 'income' ? amount : -amount);
    results.push({ ok: true, balBefore: b });
  });
  return results;
};

describe('makeBatchTracker', () => {
  it('returns 0 for a wallet with no recorded entries', () => {
    const t = makeBatchTracker();
    expect(t.deltaFor('bank', '2026-06-11', false)).toBe(0);
  });

  it('accumulates signed amounts per wallet (today semantics: all entries count)', () => {
    const t = makeBatchTracker();
    t.record('bank', '2026-06-11', -300);
    t.record('bank', '2026-06-11', 100);
    t.record('cash', '2026-06-11', -50);
    expect(t.deltaFor('bank', '2026-06-11', false)).toBe(-200);
    expect(t.deltaFor('cash', '2026-06-11', false)).toBe(-50);
  });

  it('backdated entries only count batch entries dated on/before their own date', () => {
    const t = makeBatchTracker();
    t.record('bank', '2026-06-01', -100);
    t.record('bank', '2026-06-05', -200);
    t.record('bank', '2026-06-10', -400);
    // balanceOnDate(2026-06-05) semantics: includes 06-01 and 06-05, not 06-10
    expect(t.deltaFor('bank', '2026-06-05', true)).toBe(-300);
    // non-backdated (today/future) counts everything
    expect(t.deltaFor('bank', '2026-06-05', false)).toBe(-700);
  });

  it('rounds paisa-fraction accumulation', () => {
    const t = makeBatchTracker();
    t.record('bank', '2026-06-11', -0.1);
    t.record('bank', '2026-06-11', -0.2);
    expect(t.deltaFor('bank', '2026-06-11', false)).toBe(-0.3);
  });
});

describe('batch import balance validation', () => {
  const today = '2026-06-11';

  it('rejects the entry that overdraws mid-batch instead of validating all against the pre-batch balance', () => {
    const rows = [
      { type: 'expense', amount: 60, walletId: 'bank', date: today },
      { type: 'expense', amount: 60, walletId: 'bank', date: today },
    ];
    const res = simulateBatchImport({ rows, staleBalance: () => 100, today });
    expect(res[0]).toEqual({ ok: true, balBefore: 100 });
    // second entry sees 100 - 60 = 40, not the stale 100
    expect(res[1]).toEqual({ ok: false, balBefore: 40 });
  });

  it('income earlier in the batch funds later expenses', () => {
    const rows = [
      { type: 'income', amount: 500, walletId: 'bank', date: today },
      { type: 'expense', amount: 550, walletId: 'bank', date: today },
    ];
    const res = simulateBatchImport({ rows, staleBalance: () => 100, today });
    expect(res[1]).toEqual({ ok: true, balBefore: 600 });
  });

  it('stores running balBefore snapshots, not the stale pre-batch balance', () => {
    const rows = [
      { type: 'expense', amount: 10, walletId: 'bank', date: today },
      { type: 'expense', amount: 20, walletId: 'bank', date: today },
      { type: 'expense', amount: 30, walletId: 'bank', date: today },
    ];
    const res = simulateBatchImport({ rows, staleBalance: () => 1000, today });
    expect(res.map(r => r.balBefore)).toEqual([1000, 990, 970]);
  });

  it('a backdated entry ignores later-dated batch entries when checking its historical balance', () => {
    const rows = [
      { type: 'expense', amount: 50, walletId: 'bank', date: '2026-06-10' },
      { type: 'expense', amount: 80, walletId: 'bank', date: '2026-06-01' },
    ];
    // historical balance was 100 on both dates; the 06-01 entry must not be
    // debited for the 06-10 spend that happened after it
    const res = simulateBatchImport({ rows, staleBalance: () => 100, today });
    expect(res[0].ok).toBe(true);
    expect(res[1]).toEqual({ ok: true, balBefore: 100 });
  });

  it('wallets are isolated', () => {
    const rows = [
      { type: 'expense', amount: 90, walletId: 'bank', date: today },
      { type: 'expense', amount: 90, walletId: 'cash', date: today },
    ];
    const res = simulateBatchImport({ rows, staleBalance: () => 100, today });
    expect(res.every(r => r.ok)).toBe(true);
  });
});
