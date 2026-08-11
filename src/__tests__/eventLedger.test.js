import { describe, it, expect } from 'vitest';
import {
  roundMoney, groupShareTotals, expenseShareMap, distributeAmount,
  pendingIouNet, untrackedGroupDebts,
} from '../financeUtils.js';

// Mirrors the event-detail group ledger in App.jsx (Events component): the
// BALANCES card and its SETTLE UP rows. Both are derived from the IOU LEDGER —
// the debts NOMAD actually records and can settle — so the card, the settle
// sheet and the IOU wallet can never quote different numbers for one person.
//
// They used to be derived from fair shares and run through a greedy debt
// simplifier. That is a valid settlement plan but not THIS app's plan: NOMAD
// records IOUs only between You and each participant (`makeExpIOUs` — when
// someone else pays, only YOUR share becomes a debt to them), so the simplifier
// proposed transfers no IOU row backs and no handler could record. If the inline
// logic in App.jsx changes, mirror the change here.

// Per person, YOUR side of the ledger: + means they owe you.
const iouNets = (parts, splits, settlements, expenseIds) => {
  const ids = new Set(expenseIds);
  const mine = splits.filter(s => s.groupId && ids.has(s.groupId) && !s.deleted_at);
  return Object.fromEntries(parts.filter(p => p !== 'You').map(p => {
    const pl = p.toLowerCase();
    return [p, pendingIouNet(mine.filter(s => (s.name || '').toLowerCase() === pl), settlements)];
  }));
};

// Card sign: + means "gets back", − means "owes".
const grpBalances = (parts, nets) => Object.fromEntries(parts.map(p => [p,
  p === 'You' ? roundMoney(Object.values(nets).reduce((t, v) => t + v, 0)) : roundMoney(-(nets[p] || 0)),
]));

const suggested = (parts, nets) => parts
  .filter(p => p !== 'You' && Math.abs(nets[p] || 0) > 0.01)
  .sort((a, b) => Math.abs(nets[b]) - Math.abs(nets[a]))
  .map(p => (nets[p] > 0 ? { from: p, to: 'You', amt: roundMoney(nets[p]) } : { from: 'You', to: p, amt: roundMoney(-nets[p]) }));

const iou = (id, name, amount, direction, groupId, extra = {}) =>
  ({ id, name, amount, direction, groupId, settled: false, ...extra });

describe('event BALANCES — derived from the IOU ledger', () => {
  it('two people: the payer is owed exactly the other half', () => {
    const parts = ['You', 'Rakesh'];
    const nets = iouNets(parts, [iou('s1', 'Rakesh', 575.5, 'owed', 'exp1')], [], ['exp1']);
    expect(grpBalances(parts, nets)).toEqual({ You: 575.5, Rakesh: -575.5 });
    expect(suggested(parts, nets)).toEqual([{ from: 'Rakesh', to: 'You', amt: 575.5 }]);
  });

  it('a settled IOU clears the row and drops the suggestion', () => {
    const parts = ['You', 'Rakesh'];
    const nets = iouNets(parts, [iou('s1', 'Rakesh', 575.5, 'owed', 'exp1', { settled: true })], [], ['exp1']);
    expect(grpBalances(parts, nets)).toEqual({ You: 0, Rakesh: 0 });
    expect(suggested(parts, nets)).toEqual([]);
  });

  it('a part payment leaves exactly the remainder', () => {
    const parts = ['You', 'Rakesh'];
    const splits = [iou('s1', 'Rakesh', 575.5, 'owed', 'exp1')];
    const nets = iouNets(parts, splits, [{ splitId: 's1', amount: 300, direction: 'owed' }], ['exp1']);
    expect(grpBalances(parts, nets)).toEqual({ You: 275.5, Rakesh: -275.5 });
    expect(suggested(parts, nets)).toEqual([{ from: 'Rakesh', to: 'You', amt: 275.5 }]);
  });

  // Skipping an event IOU is a write-off: you have decided the money is not
  // coming. The old fair-share derivation counted settlements only, so the card
  // kept quoting the debt and SETTLE UP kept proposing a transfer that
  // settleEventNet then refused ("No pending IOUs with X in this event") — an
  // event that could never be closed. pendingIouNet drops skipped rows outright.
  it('a WRITTEN-OFF IOU clears the row instead of nagging forever', () => {
    const parts = ['You', 'Rakesh'];
    const nets = iouNets(parts, [iou('s1', 'Rakesh', 575.5, 'owed', 'exp1', { settled: true, skipped: true })], [], ['exp1']);
    expect(grpBalances(parts, nets)).toEqual({ You: 0, Rakesh: 0 });
    expect(suggested(parts, nets)).toEqual([]);
  });

  it('a part-paid then written-off IOU clears too — no phantom remainder', () => {
    const parts = ['You', 'Rakesh'];
    const splits = [iou('s1', 'Rakesh', 575.5, 'owed', 'exp1', { settled: true, skipped: true })];
    const nets = iouNets(parts, splits, [{ splitId: 's1', amount: 300, direction: 'owed' }], ['exp1']);
    expect(grpBalances(parts, nets)).toEqual({ You: 0, Rakesh: 0 });
  });

  it('a manually-added IOU (no groupId) never touches the expense balance', () => {
    // It has its own owe/owed tally in the SPLITS list, and settleEventNet
    // ignores it. Counting it here over-subtracted and left a phantom balance.
    const parts = ['You', 'Rakesh'];
    const splits = [iou('s1', 'Rakesh', 575.5, 'owed', 'exp1', { settled: true }), iou('s2', 'Rakesh', 175, 'owed', undefined)];
    const nets = iouNets(parts, splits, [], ['exp1']);
    expect(grpBalances(parts, nets)).toEqual({ You: 0, Rakesh: 0 });
  });

  it('the card always balances to zero across everyone', () => {
    const parts = ['You', 'A', 'B', 'C'];
    const splits = [
      iou('s1', 'A', 100, 'owed', 'e1'), iou('s2', 'B', 100, 'owed', 'e1'),
      iou('s3', 'C', 40, 'owe', 'e2'),
    ];
    const bals = grpBalances(parts, iouNets(parts, splits, [], ['e1', 'e2']));
    expect(roundMoney(Object.values(bals).reduce((t, v) => t + v, 0))).toBe(0);
    expect(bals.You).toBe(160);
  });

  it('paise residue splits without drift', () => {
    const shares = groupShareTotals([100], 3);
    expect(roundMoney(shares[0] + shares[1] + shares[2])).toBe(100);
    const parts = ['You', 'B', 'C'];
    const nets = iouNets(parts, [iou('s1', 'B', shares[1], 'owed', 'e1'), iou('s2', 'C', shares[2], 'owed', 'e1')], [], ['e1']);
    expect(grpBalances(parts, nets).You).toBe(roundMoney(100 - shares[0]));
  });
});

// ── the third-party-payer case ──────────────────────────────────────────────
// You pay ₹300 (3-way), then A pays ₹60 (3-way).
//   IOUs recorded: A owes You 100, B owes You 100, You owe A 20
//   NOT recorded:  B owes A 20  (neither side is You)
// Fair shares say A is down 60 and B down 120; the IOU ledger says A owes you 80
// and B owes you 100. Both are right — they route the same ₹180 to you
// differently — but only the IOU plan is one the app can record.
describe('event BALANCES vs fair shares when a third party pays', () => {
  const parts = ['You', 'A', 'B'];
  const expenses = [
    { id: 'e1', amount: 300, splitWith: { You: 100, A: 100, B: 100 } },
    { id: 'e2', amount: 60, paidBy: 'A', splitWith: { You: 20, A: 20, B: 20 } },
  ];
  const splits = [
    iou('i1', 'A', 100, 'owed', 'e1'),
    iou('i2', 'B', 100, 'owed', 'e1'),
    iou('i3', 'A', 20, 'owe', 'e2'),
  ];
  const nets = iouNets(parts, splits, [], ['e1', 'e2']);
  const shares = expenseShareMap(expenses, parts);
  const paid = { You: 300, A: 60, B: 0 };
  const untracked = untrackedGroupDebts(expenses, parts);

  it('every SETTLE UP row involves You, because every tracked debt does', () => {
    expect(suggested(parts, nets)).toEqual([
      { from: 'B', to: 'You', amt: 100 },
      { from: 'A', to: 'You', amt: 80 },
    ]);
  });

  it('your own row is identical either way — only the others get relabelled', () => {
    const fairYou = roundMoney(paid.You - shares.You);
    expect(grpBalances(parts, nets).You).toBe(fairYou);
    expect(fairYou).toBe(180);
  });

  it('names the debt it does not track, rather than folding it into a number', () => {
    expect(untracked).toEqual({ B: { A: 20 } });
  });

  // The reconciliation that makes the card honest: for every participant,
  // tracked IOU net + untracked edges === their fair share. Nothing is lost,
  // it is just attributed to whoever the debt is actually with.
  it('tracked + untracked reconciles to the fair share for everyone', () => {
    const owedToOthers = p => Object.values(untracked[p] || {}).reduce((t, v) => t + v, 0);
    const owedByOthers = p => Object.values(untracked).reduce((t, m) => t + (m[p] || 0), 0);
    parts.filter(p => p !== 'You').forEach(p => {
      const fair = roundMoney((paid[p] || 0) - shares[p]);
      const tracked = -(nets[p] || 0); // card sign
      expect(roundMoney(tracked - owedToOthers(p) + owedByOthers(p))).toBe(fair);
    });
  });

  it('a settle at the old simplifier figure would have moved the wrong cash', () => {
    // The simplifier said "B → You 120" and "A → You 60".
    expect(Math.abs(120 - nets.B)).toBeGreaterThan(0.011); // expectCash refuses
    // And 60 against A's real 80 net booked a partial that stranded ₹20 while
    // the card read "settled".
    expect(nets.A).toBe(80);
  });
});

describe('untrackedGroupDebts', () => {
  it('is empty when You paid for everything', () => {
    expect(untrackedGroupDebts([{ amount: 300, splitWith: { You: 100, A: 100, B: 100 } }], ['You', 'A', 'B'])).toEqual({});
  });

  it('is empty in a two-person event — every debt involves You', () => {
    expect(untrackedGroupDebts([{ amount: 300, paidBy: 'A', splitWith: { You: 150, A: 150 } }], ['You', 'A'])).toEqual({});
  });

  it('accumulates across expenses and payers', () => {
    const out = untrackedGroupDebts([
      { amount: 60, paidBy: 'A', splitWith: { You: 20, A: 20, B: 20 } },
      { amount: 90, paidBy: 'A', splitWith: { You: 30, A: 30, B: 30 } },
      { amount: 30, paidBy: 'B', splitWith: { You: 10, A: 10, B: 10 } },
    ], ['You', 'A', 'B']);
    expect(out).toEqual({ B: { A: 50 }, A: { B: 10 } });
  });

  it('falls back to an equal split that matches expenseShareMap exactly', () => {
    const parts = ['You', 'A', 'B'];
    const e = { amount: 100, paidBy: 'A' };
    const equal = distributeAmount(100, 3);
    expect(untrackedGroupDebts([e], parts)).toEqual({ B: { A: equal[2] } });
    expect(expenseShareMap([e], parts).B).toBe(equal[2]);
  });

  it('an unknown payer name is treated as You (no phantom untracked debt)', () => {
    expect(untrackedGroupDebts([{ amount: 60, paidBy: 'Ghost', splitWith: { You: 20, A: 20, B: 20 } }], ['You', 'A', 'B'])).toEqual({});
  });
});
