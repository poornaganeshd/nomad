import { describe, it, expect } from 'vitest';
import { roundMoney, groupShareTotals, expenseShareMap, pendingIouNet } from '../financeUtils.js';

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

// Mirrors the grpSettled reconciliation in App.jsx (Events detail). The group
// BALANCES card is derived from group EXPENSES only, so it must reconcile against
// settlements of the auto-IOUs created when an expense is logged (those carry a
// groupId matching an event expense) — NOT settlements of manually-added split
// IOUs, which live in their own owe/owed tally. Mixing them in over-subtracts and
// leaves a phantom balance after everything looks settled. Keep in sync with the
// `eStl`/`grpSettled`/`bal` math in App.jsx.
const grpSettled = (parts, settlements, expenseIds, splits = []) => {
  const ids = new Set(expenseIds);
  const eStl = settlements.filter(s => s.groupId && ids.has(s.groupId));
  // A WRITTEN-OFF expense IOU resolves the balance just as a paid one does — the
  // money is not coming and you have said so. Its unpaid remainder folds in with
  // the sign a settlement of it would have carried. Without this the BALANCES
  // card kept quoting a debt already written off and SETTLE UP kept proposing a
  // transfer for it that settleEventNet then refused (the IOU is not pending).
  const paidBy = {};
  settlements.forEach(s => { if (s.splitId != null) paidBy[s.splitId] = roundMoney((paidBy[s.splitId] || 0) + s.amount); });
  const eSkipped = splits.filter(s => s.groupId && ids.has(s.groupId) && s.skipped && !s.deleted_at);
  const rows = [
    ...eStl.map(s => ({ name: s.splitName, direction: s.direction, amount: s.amount })),
    ...eSkipped.map(s => ({ name: s.name, direction: s.direction, amount: roundMoney(s.amount - (paidBy[s.id] || 0)) })),
  ].filter(x => x.amount > 0.005);
  return Object.fromEntries(parts.map(p => {
    const pl = p.toLowerCase();
    const mine = p === 'You' ? rows : rows.filter(x => (x.name || '').toLowerCase() === pl);
    const out = mine.filter(x => x.direction === 'owe').reduce((t, x) => t + x.amount, 0);
    const inn = mine.filter(x => x.direction === 'owed').reduce((t, x) => t + x.amount, 0);
    return [p, roundMoney(p === 'You' ? inn - out : out - inn)];
  }));
};

const grpBalances = ({ parts, paid, shares, settlements, expenseIds, splits = [] }) => {
  const settled = grpSettled(parts, settlements, expenseIds, splits);
  return parts.map(p => ({ name: p, bal: roundMoney((paid[p] || 0) - (shares[p] || 0) - (settled[p] || 0)) }));
};

describe('event group BALANCES vs settlements', () => {
  // Scenario from the bug report: ₹1,151 group expense paid by You (2 people),
  // PLUS a manual ₹175 IOU Rakesh owes you. Settling everything used to leave a
  // phantom "You owe ₹175 / Rakesh gets back ₹175" because the manual settlement
  // wrongly counted against the expense balance.
  it('settling the expense IOU clears the balance to zero', () => {
    const bals = grpBalances({
      parts: ['You', 'Rakesh'],
      paid: { You: 1151, Rakesh: 0 },
      shares: { You: 575.5, Rakesh: 575.5 },
      // Only the auto-IOU settlement (groupId === the expense id) counts.
      settlements: [{ direction: 'owed', splitName: 'Rakesh', amount: 575.5, groupId: 'exp1' }],
      expenseIds: ['exp1'],
    });
    expect(bals).toEqual([{ name: 'You', bal: 0 }, { name: 'Rakesh', bal: 0 }]);
    expect(suggestSettlements(bals)).toEqual([]);
  });

  it('a manually-added IOU settlement does not corrupt the expense balance', () => {
    const bals = grpBalances({
      parts: ['You', 'Rakesh'],
      paid: { You: 1151, Rakesh: 0 },
      shares: { You: 575.5, Rakesh: 575.5 },
      settlements: [
        { direction: 'owed', splitName: 'Rakesh', amount: 575.5, groupId: 'exp1' }, // auto IOU
        { direction: 'owed', splitName: 'Rakesh', amount: 175, /* no groupId */ }, // manual IOU
      ],
      expenseIds: ['exp1'],
    });
    // The manual ₹175 is ignored here — expense balance is fully settled, no
    // phantom "You owe ₹175".
    expect(bals).toEqual([{ name: 'You', bal: 0 }, { name: 'Rakesh', bal: 0 }]);
    expect(suggestSettlements(bals)).toEqual([]);
  });

  it('a partial settlement of the expense IOU leaves the remaining balance', () => {
    const bals = grpBalances({
      parts: ['You', 'Rakesh'],
      paid: { You: 1151, Rakesh: 0 },
      shares: { You: 575.5, Rakesh: 575.5 },
      settlements: [{ direction: 'owed', splitName: 'Rakesh', amount: 300, groupId: 'exp1' }],
      expenseIds: ['exp1'],
    });
    expect(bals).toEqual([{ name: 'You', bal: 275.5 }, { name: 'Rakesh', bal: -275.5 }]);
    expect(suggestSettlements(bals)).toEqual([{ from: 'Rakesh', to: 'You', amt: 275.5 }]);
  });
});

describe('event group BALANCES vs write-offs', () => {
  // Skipping an event IOU is a write-off: you have decided the money is not
  // coming. The balance card kept showing the full debt anyway, and SETTLE UP
  // kept proposing a transfer that settleEventNet refuses outright ("No pending
  // IOUs with X in this event") — an event that could never be closed.
  it('a written-off expense IOU clears the balance instead of nagging forever', () => {
    const bals = grpBalances({
      parts: ['You', 'Rakesh'],
      paid: { You: 1151, Rakesh: 0 },
      shares: { You: 575.5, Rakesh: 575.5 },
      settlements: [],
      splits: [{ id: 's1', name: 'Rakesh', amount: 575.5, direction: 'owed', groupId: 'exp1', settled: true, skipped: true }],
      expenseIds: ['exp1'],
    });
    expect(bals).toEqual([{ name: 'You', bal: 0 }, { name: 'Rakesh', bal: 0 }]);
    expect(suggestSettlements(bals)).toEqual([]);
  });

  it('only the UNPAID remainder of a part-paid, then written-off IOU counts', () => {
    const bals = grpBalances({
      parts: ['You', 'Rakesh'],
      paid: { You: 1151, Rakesh: 0 },
      shares: { You: 575.5, Rakesh: 575.5 },
      settlements: [{ splitId: 's1', direction: 'owed', splitName: 'Rakesh', amount: 300, groupId: 'exp1' }],
      splits: [{ id: 's1', name: 'Rakesh', amount: 575.5, direction: 'owed', groupId: 'exp1', settled: true, skipped: true }],
      expenseIds: ['exp1'],
    });
    // 300 paid + 275.5 written off = the whole share, settled either way.
    expect(bals).toEqual([{ name: 'You', bal: 0 }, { name: 'Rakesh', bal: 0 }]);
  });

  it('a written-off IOU you OWE clears symmetrically', () => {
    const bals = grpBalances({
      parts: ['You', 'Rakesh'],
      paid: { You: 0, Rakesh: 400 },
      shares: { You: 200, Rakesh: 200 },
      settlements: [],
      splits: [{ id: 's1', name: 'Rakesh', amount: 200, direction: 'owe', groupId: 'exp1', settled: true, skipped: true }],
      expenseIds: ['exp1'],
    });
    expect(bals).toEqual([{ name: 'You', bal: 0 }, { name: 'Rakesh', bal: 0 }]);
  });
});

describe('event SETTLE UP must quote the tracked IOU net, not the simplifier', () => {
  // NOMAD only records IOUs between You and each participant: when someone else
  // pays, just YOUR share becomes a debt to them (makeExpIOUs in App.jsx). The
  // fair-share simplifier does not know that — it happily routes a debt through
  // a participant pair the IOU ledger has no row for. Both plans are valid and
  // both settle the same total, but only the IOU plan is one the app can record.
  //
  // You pay 300 (3-way), then A pays 60 (3-way).
  //   IOUs:      A owes You 100, B owes You 100, You owe A 20
  //   simplifier: B -> You 120, A -> You 60
  const expenses = [{ amount: 300 }, { amount: 60 }];
  const parts = ['You', 'A', 'B'];
  const shares = expenseShareMap(expenses, parts);
  const splits = [
    { id: 'i1', name: 'A', amount: 100, direction: 'owed', groupId: 'e1', settled: false },
    { id: 'i2', name: 'B', amount: 100, direction: 'owed', groupId: 'e1', settled: false },
    { id: 'i3', name: 'A', amount: 20, direction: 'owe', groupId: 'e2', settled: false },
  ];
  const bals = parts.map(p => ({ name: p, bal: roundMoney(({ You: 300, A: 60, B: 0 })[p] - shares[p]) }));

  it('the two plans disagree per person while agreeing on the total', () => {
    const sug = suggestSettlements(bals);
    expect(sug).toEqual([{ from: 'B', to: 'You', amt: 120 }, { from: 'A', to: 'You', amt: 60 }]);
    const iouB = pendingIouNet(splits.filter(s => s.name === 'B'), []);
    const iouA = pendingIouNet(splits.filter(s => s.name === 'A'), []);
    expect(iouB).toBe(100); // simplifier said 120
    expect(iouA).toBe(80);  // simplifier said 60
    // Same money either way — only the routing differs.
    expect(roundMoney(iouA + iouB)).toBe(roundMoney(120 + 60));
  });

  it('settling at the simplifier figure would move the wrong cash', () => {
    // B: the sheet promised 120, the handler can only move the 100 that exists.
    const iouB = pendingIouNet(splits.filter(s => s.name === 'B'), []);
    expect(Math.abs(120 - iouB)).toBeGreaterThan(0.011); // expectCash refuses this
    // A: 60 is UNDER the 80 net, so it books as a partial and strands 20 —
    // while the balance card reads "settled". The sheet now quotes 80.
    const iouA = pendingIouNet(splits.filter(s => s.name === 'A'), []);
    expect(iouA).toBe(80);
  });
});
