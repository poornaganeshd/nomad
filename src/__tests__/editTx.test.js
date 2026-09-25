import { describe, it, expect } from 'vitest';
import { walletDeltas, projectedBalances, overdrawnBy, roundMoney, expenseIouPlan, sameIouPlan } from '../financeUtils.js';

// History was delete-only: fixing a wrong amount meant deleting and re-typing,
// which loses the row's created_at (it jumps to the top of history and out of
// its place in the balance trail) and throws away the category correction.
//
// An edit can overdraw a wallet exactly like an add can, so it has to clear the
// same gate — but it must check the balance with the row's OWN effect removed.
// Checking the new amount against the live balance double-counts the row's
// existing spend and refuses edits that are perfectly affordable.

const bal = { bank: 1000, cash: 500, upi_lite: 200 };
const wallets = [{ id: 'bank', name: 'Bank' }, { id: 'cash', name: 'Cash' }, { id: 'upi_lite', name: 'UPI Lite' }];
const exp = (o = {}) => ({ id: 'e1', type: 'expense', amount: 300, walletId: 'bank', ...o });

describe('walletDeltas — one rule for what a row does to a wallet', () => {
  it('mirrors wBal exactly, defaults included', () => {
    expect(walletDeltas({ type: 'expense', amount: 100 })).toEqual({ upi_lite: -100 });   // default spend wallet
    expect(walletDeltas({ type: 'income', amount: 100 })).toEqual({ bank: 100 });          // default receive wallet
    expect(walletDeltas({ type: 'expense', amount: 100, walletId: 'cash' })).toEqual({ cash: -100 });
  });

  it('a transfer moves both ends', () => {
    expect(walletDeltas({ type: 'transfer', amount: 250, fromWallet: 'bank', toWallet: 'cash' }))
      .toEqual({ bank: -250, cash: 250 });
  });

  it('a settlement uses the FULL amount — an overpay really does leave the wallet', () => {
    expect(walletDeltas({ type: 'settlement', amount: 100, excess: 10, direction: 'owe', walletId: 'bank' })).toEqual({ bank: -100 });
    expect(walletDeltas({ type: 'settlement', amount: 100, direction: 'owed', walletId: 'bank' })).toEqual({ bank: 100 });
  });

  it('a tracked group expense touches no real wallet', () => {
    expect(walletDeltas({ type: 'expense', amount: 500, walletId: '__tracked__' })).toEqual({ __tracked__: -500 });
  });
});

describe('projectedBalances', () => {
  it('removes the old effect before applying the new one', () => {
    // ₹300 → ₹400 on a bank with ₹1000 already NET of that ₹300.
    const p = projectedBalances(bal, exp(), exp({ amount: 400 }));
    expect(p.bank).toBe(900);
  });

  it('moves the money when the wallet changes', () => {
    const p = projectedBalances(bal, exp(), exp({ walletId: 'cash' }));
    expect(p.bank).toBe(1300); // refunded
    expect(p.cash).toBe(200);  // charged
  });

  it('is a no-op for an unchanged row', () => {
    expect(projectedBalances(bal, exp(), exp()).bank).toBe(1000);
  });
});

describe('overdrawnBy', () => {
  it('allows raising an expense the wallet can still cover', () => {
    expect(overdrawnBy(bal, exp(), exp({ amount: 1300 }), wallets)).toBe(null);
  });

  it('refuses one it cannot, and names the wallet and the shortfall', () => {
    const short = overdrawnBy(bal, exp(), exp({ amount: 1400 }), wallets);
    expect(short).toMatchObject({ walletId: 'bank', name: 'Bank', shortBy: 100 });
  });

  it('does NOT double-count the row being edited (the whole point)', () => {
    // Naively checking 1000 >= 1300 would refuse this. The row's own ₹300 is
    // already out of `bal`, so ₹1300 is exactly affordable.
    expect(overdrawnBy(bal, exp(), exp({ amount: 1300 }), wallets)).toBe(null);
  });

  it('catches a wallet switch that overdraws the destination', () => {
    const short = overdrawnBy(bal, exp(), exp({ walletId: 'cash', amount: 600 }), wallets);
    expect(short).toMatchObject({ walletId: 'cash', shortBy: 100 });
  });

  it('checks BOTH ends of an edited transfer', () => {
    const before = { id: 't', type: 'transfer', amount: 100, fromWallet: 'bank', toWallet: 'cash' };
    expect(overdrawnBy(bal, before, { ...before, amount: 1100 }, wallets)).toBe(null);
    expect(overdrawnBy(bal, before, { ...before, amount: 1200 }, wallets)).toMatchObject({ walletId: 'bank' });
  });

  it('ignores __tracked__, which is a placeholder, not a wallet', () => {
    const tracked = { id: 'e', type: 'expense', amount: 5000, walletId: '__tracked__' };
    expect(overdrawnBy(bal, tracked, { ...tracked, amount: 9000 }, wallets)).toBe(null);
  });

  it('tolerates a paisa of float noise rather than refusing on it', () => {
    const b = { bank: roundMoney(0.001) };
    expect(overdrawnBy(b, exp({ amount: 0 }), exp({ amount: 0.004 }), wallets)).toBe(null);
  });
});

describe('overdrawnBy — a wallet that is already negative', () => {
  const neg = { bank: -50, cash: 500 };
  it('lets you fix a note (or anything that does not make it worse)', () => {
    expect(overdrawnBy(neg, exp(), exp({ note: 'typo fixed' }), wallets)).toBe(null);
    expect(overdrawnBy(neg, exp(), exp({ amount: 200 }), wallets)).toBe(null);
  });
  it('still refuses an edit that digs it deeper', () => {
    expect(overdrawnBy(neg, exp(), exp({ amount: 310 }), wallets)).toMatchObject({ walletId: 'bank', shortBy: 60 });
  });
});

describe('expenseIouPlan / sameIouPlan — event expense edits keep their IOUs', () => {
  it('you paid: everyone else owes you their share', () => {
    expect(expenseIouPlan({ You: 100, A: 100, B: 100 }, 'You')).toEqual([
      { name: 'A', amount: 100, direction: 'owed' }, { name: 'B', amount: 100, direction: 'owed' },
    ]);
  });
  it('someone else paid: only your share, owed to them', () => {
    expect(expenseIouPlan({ You: 40, A: 60 }, 'A')).toEqual([{ name: 'A', amount: 40, direction: 'owe' }]);
    expect(expenseIouPlan({ A: 60 }, 'A')).toEqual([]);
    expect(expenseIouPlan(null, 'You')).toEqual([]);
  });
  it('an unchanged split matches the live IOUs (order and case do not matter)', () => {
    const live = [{ name: 'b', amount: 100, direction: 'owed' }, { name: 'A', amount: 100.001, direction: 'owed' }];
    expect(sameIouPlan(live, expenseIouPlan({ You: 100, A: 100, B: 100 }, 'You'))).toBe(true);
  });
  it('a changed amount, person or direction does not', () => {
    const live = [{ name: 'A', amount: 100, direction: 'owed' }];
    expect(sameIouPlan(live, [{ name: 'A', amount: 120, direction: 'owed' }])).toBe(false);
    expect(sameIouPlan(live, [{ name: 'B', amount: 100, direction: 'owed' }])).toBe(false);
    expect(sameIouPlan(live, [{ name: 'A', amount: 100, direction: 'owe' }])).toBe(false);
    expect(sameIouPlan(live, [])).toBe(false);
  });
  it('soft-deleted IOUs are not live', () => {
    expect(sameIouPlan([{ name: 'A', amount: 1, direction: 'owed', deleted_at: 'x' }], [])).toBe(true);
  });
});
