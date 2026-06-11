import { describe, it, expect } from 'vitest';
import { roundMoney, groupShareTotals } from '../financeUtils.js';

// Mirrors the event-detail group ledger in App.jsx (Events component):
// per-person balance and the greedy who-pays-whom matcher behind the
// "Settle Up" suggestions and one-tap settle. If the inline logic changes
// in App.jsx, mirror the change here.
const ledgerBalances = ({ parts, paid, shares, settled = {} }) =>
  parts.map(p => ({ name: p, bal: roundMoney((paid[p] || 0) - (shares[p] || 0) - (settled[p] || 0)) }));

const suggestSettlements = bals => {
  const cr = bals.filter(b => b.bal > 0.01).map(b => ({ ...b })).sort((a, b) => b.bal - a.bal);
  const db = bals.filter(b => b.bal < -0.01).map(b => ({ ...b })).sort((a, b) => a.bal - b.bal);
  const out = []; let ci = 0, di = 0;
  while (ci < cr.length && di < db.length) {
    const amt = roundMoney(Math.min(cr[ci].bal, -db[di].bal));
    out.push({ from: db[di].name, to: cr[ci].name, amt });
    cr[ci].bal = roundMoney(cr[ci].bal - amt);
    db[di].bal = roundMoney(db[di].bal + amt);
    if (cr[ci].bal < 0.01) ci++;
    if (db[di].bal > -0.01) di++;
  }
  return out;
};

describe('event group ledger', () => {
  it('two people: payer gets back exactly the other half', () => {
    const shares = groupShareTotals([1151], 2);
    const bals = ledgerBalances({
      parts: ['You', 'Rakesh'],
      paid: { You: 1151, Rakesh: 0 },
      shares: { You: shares[0], Rakesh: shares[1] },
    });
    const sug = suggestSettlements(bals);
    expect(sug).toEqual([{ from: 'Rakesh', to: 'You', amt: 575.5 }]);
  });

  it('settled amounts drop the suggestion entirely', () => {
    const bals = ledgerBalances({
      parts: ['You', 'Rakesh'],
      paid: { You: 1151, Rakesh: 0 },
      shares: { You: 575.5, Rakesh: 575.5 },
      // You received 575.5 (inn - out), Rakesh paid 575.5 (out - inn)
      settled: { You: 575.5, Rakesh: -575.5 },
    });
    expect(suggestSettlements(bals)).toEqual([]);
  });

  it('three people: transfers conserve money and clear every balance', () => {
    const amounts = [300, 150, 90];
    const shares = groupShareTotals(amounts, 3);
    const total = roundMoney(amounts.reduce((s, x) => s + x, 0));
    const bals = ledgerBalances({
      parts: ['You', 'B', 'C'],
      paid: { You: total, B: 0, C: 0 },
      shares: { You: shares[0], B: shares[1], C: shares[2] },
    });
    const sug = suggestSettlements(bals);
    // every debtor pays You; transfers sum to the total owed
    expect(sug.every(s => s.to === 'You')).toBe(true);
    const owed = roundMoney(sug.reduce((s, x) => s + x.amt, 0));
    expect(owed).toBe(roundMoney(shares[1] + shares[2]));
    expect(sug.every(s => s.amt > 0)).toBe(true);
  });

  it('paise residue never produces negative or duplicate transfers', () => {
    // 100 split 3 ways -> 33.34 + 33.33 + 33.33 via groupShareTotals
    const shares = groupShareTotals([100], 3);
    expect(roundMoney(shares[0] + shares[1] + shares[2])).toBe(100);
    const bals = ledgerBalances({
      parts: ['You', 'B', 'C'],
      paid: { You: 100, B: 0, C: 0 },
      shares: { You: shares[0], B: shares[1], C: shares[2] },
    });
    const sug = suggestSettlements(bals);
    expect(sug.length).toBe(2);
    expect(roundMoney(sug[0].amt + sug[1].amt)).toBe(roundMoney(100 - shares[0]));
  });

  it('mixed creditors and debtors route through the greedy matcher', () => {
    const bals = [
      { name: 'You', bal: 50 },
      { name: 'B', bal: 30 },
      { name: 'C', bal: -45 },
      { name: 'D', bal: -35 },
    ];
    const sug = suggestSettlements(bals);
    const credit = {}; const debit = {};
    sug.forEach(s => { credit[s.to] = roundMoney((credit[s.to] || 0) + s.amt); debit[s.from] = roundMoney((debit[s.from] || 0) + s.amt); });
    expect(credit).toEqual({ You: 50, B: 30 });
    expect(debit).toEqual({ C: 45, D: 35 });
  });
});
