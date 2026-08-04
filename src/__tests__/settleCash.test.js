import { describe, it, expect } from 'vitest';
import { roundMoney, settlementsCash, cashMatchesExpectation, settlementNetAmount } from '../financeUtils.js';

// The bug behind this file: a net settle records ONE settlement per IOU and
// leans on the opposite-direction rows to cancel the gross, so the wallet only
// lands on the net while every row is written into the same wallet. The sheet
// and the handler each derive the IOU set independently, so any drift between
// them banks the difference silently — History credits a bank with the GROSS of
// every "owes you" IOU while only the net ever arrived, and the wallet then
// disagrees with the real account by exactly the cancelled side.
//
// settlementsCash is the single answer to "what did this batch do to the
// wallet"; cashMatchesExpectation is the check that refuses to write when that
// answer is not the number the confirm button promised.

const owed = (amount, extra = {}) => ({ direction: 'owed', amount, ...extra });
const owe = (amount, extra = {}) => ({ direction: 'owe', amount, ...extra });

describe('settlementsCash', () => {
  it('adds money received and subtracts money paid out', () => {
    expect(settlementsCash([owed(74.67), owe(32.5)])).toBe(42.17);
    expect(settlementsCash([owe(100), owed(60)])).toBe(-40);
  });

  it('is zero when the two sides cancel exactly — no cash changes hands', () => {
    expect(settlementsCash([owed(32.5), owe(32.5)])).toBe(0);
  });

  it('counts an overpay in FULL, unlike the split-ledger value', () => {
    // owed ₹11.66, they send ₹12: the wallet really gains ₹12 even though only
    // ₹11.66 of it pays down the IOU.
    const rec = owed(12, { excess: 0.34 });
    expect(settlementsCash([rec])).toBe(12);
    expect(settlementNetAmount(rec)).toBe(11.66);
  });

  it('treats anything that is not "owed" as money leaving the wallet', () => {
    expect(settlementsCash([{ direction: undefined, amount: 10 }])).toBe(-10);
  });

  it('survives junk input instead of poisoning a balance with NaN', () => {
    expect(settlementsCash(null)).toBe(0);
    expect(settlementsCash([null, owed('abc'), owed(5)])).toBe(5);
  });
});

describe('cashMatchesExpectation', () => {
  it('passes when the batch moves exactly what was promised', () => {
    expect(cashMatchesExpectation(42.17, settlementsCash([owed(74.67), owe(32.5)]))).toBe(true);
  });

  it('passes a paisa of float drift', () => {
    expect(cashMatchesExpectation(42.17, 42.18)).toBe(true);
    expect(cashMatchesExpectation(-40, -40.01)).toBe(true);
  });

  it('FAILS when only the gross of the "owes you" side would be written', () => {
    // The reported bug in miniature: the sheet nets ₹74.67 owed against ₹32.50
    // owed back and promises ₹42.17, but the records add up to the gross.
    expect(cashMatchesExpectation(42.17, settlementsCash([owed(74.67)]))).toBe(false);
  });

  it('FAILS when the cash moves the wrong WAY', () => {
    expect(cashMatchesExpectation(42.17, -42.17)).toBe(false);
  });

  it('passes anything when no expectation was supplied (older call sites)', () => {
    expect(cashMatchesExpectation(null, 999)).toBe(true);
    expect(cashMatchesExpectation(undefined, -999)).toBe(true);
  });
});

// ── The guard in context ────────────────────────────────────────────────────
// Mirrors what settleNet does around the check: build the records, work out the
// cash, and refuse to write if it is not the confirmed number.
function settleNetFull(items, { expectCash, payAmt = null } = {}) {
  const net = roundMoney(items.reduce((t, x) => t + (x.direction === 'owed' ? x.amount : -x.amount), 0));
  const absNet = Math.abs(net);
  const excess = payAmt != null && absNet > 0.005 ? roundMoney(Math.max(0, payAmt - absNet)) : 0;
  const recs = items.map(x => ({ direction: x.direction, amount: x.amount }));
  if (excess > 0.005) {
    const host = recs.find(r => r.direction === (net > 0 ? 'owed' : 'owe'));
    if (host) { host.amount = roundMoney(host.amount + excess); host.excess = excess; }
  }
  const cash = settlementsCash(recs);
  if (!cashMatchesExpectation(expectCash, cash)) return { written: false, cash };
  return { written: true, cash, recs };
}

describe('net settle — the wallet moves the confirmed amount, or nothing moves', () => {
  const mixed = [
    { direction: 'owed', amount: 40 },
    { direction: 'owed', amount: 34.67 },
    { direction: 'owe', amount: 32.5 },
  ];

  it('writes when the sheet and the handler net the same IOUs', () => {
    const r = settleNetFull(mixed, { expectCash: 42.17 });
    expect(r.written).toBe(true);
    expect(r.cash).toBe(42.17);
  });

  it('refuses when the handler is netting a different set than the sheet showed', () => {
    // The sheet counted an IOU the handler's scope leaves out, so it promised
    // ₹42.17 while these records would put ₹74.67 in the bank. Nothing is
    // written — previously the wallet just took the ₹74.67.
    const r = settleNetFull(mixed.filter(x => x.direction === 'owed'), { expectCash: 42.17 });
    expect(r.written).toBe(false);
    expect(r.cash).toBe(74.67);
  });

  it('still allows a deliberate overpay, because the sheet promises the overpay too', () => {
    const r = settleNetFull(mixed, { payAmt: 45, expectCash: 45 });
    expect(r.written).toBe(true);
    expect(r.cash).toBe(45);
  });

  it('refuses a payout that would drain more than the confirmed net', () => {
    const youOwe = [{ direction: 'owe', amount: 100 }, { direction: 'owed', amount: 60 }];
    expect(settleNetFull(youOwe, { expectCash: -40 }).written).toBe(true);
    expect(settleNetFull([youOwe[0]], { expectCash: -40 }).written).toBe(false);
  });
});

// ── History grouping ────────────────────────────────────────────────────────
// Mirrors the settlement half of `renderItems` in App.jsx. Keyed by direction,
// a net settle filed as two unrelated cards — "Rakesh paid back ₹74.50" beside
// "Paid Rakesh ₹32.50" — so anyone reconciling History against a bank statement
// read the gross as money that had landed. One card per person/day/wallet,
// carrying the net, is what the wallet actually did.
function groupSettlements(rows) {
  const groups = new Map(); const out = [];
  for (const it of rows) {
    const key = `${(it.splitName || '').trim().toLowerCase()}|${it.date}|${it.walletId || ''}`;
    const g = groups.get(key);
    if (g) g.items.push(it);
    else { const c = { __group: true, direction: it.direction, splitName: it.splitName, date: it.date, walletId: it.walletId, items: [it] }; groups.set(key, c); out.push(c); }
  }
  return out.map(o => {
    if (o.items.length === 1) return o.items[0];
    const cash = settlementsCash(o.items);
    const netted = o.items.some(s => s.direction === 'owed') && o.items.some(s => s.direction === 'owe');
    return { ...o, __netted: netted, direction: cash < 0 ? 'owe' : 'owed', amount: roundMoney(Math.abs(cash)) };
  });
}

const stl = (direction, amount, extra = {}) => ({ splitName: 'Rakesh', date: '2026-08-04', walletId: 'bank', direction, amount, ...extra });

describe('history — a net settle reads as one net movement', () => {
  it('collapses both directions into one card carrying the net', () => {
    const out = groupSettlements([stl('owed', 40), stl('owed', 34.67), stl('owe', 32.5)]);
    expect(out).toHaveLength(1);
    expect(out[0].__netted).toBe(true);
    expect(out[0].direction).toBe('owed');
    expect(out[0].amount).toBe(42.17);
    expect(out[0].items).toHaveLength(3);
  });

  it('flips the card to a payout when the net goes the other way', () => {
    const out = groupSettlements([stl('owe', 100), stl('owed', 60)]);
    expect(out[0].direction).toBe('owe');
    expect(out[0].amount).toBe(40);
  });

  it('leaves same-direction batches reading as a plain total, not a net', () => {
    const out = groupSettlements([stl('owed', 20), stl('owed', 22)]);
    expect(out[0].__netted).toBe(false);
    expect(out[0].amount).toBe(42);
  });

  it('keeps separate wallets separate — each wallet reconciles on its own', () => {
    const out = groupSettlements([stl('owed', 42, { walletId: 'bank' }), stl('owe', 42, { walletId: 'cash' })]);
    expect(out).toHaveLength(2);
  });

  it('leaves a lone settlement exactly as it was', () => {
    const one = stl('owed', 15);
    expect(groupSettlements([one])[0]).toBe(one);
  });
});
