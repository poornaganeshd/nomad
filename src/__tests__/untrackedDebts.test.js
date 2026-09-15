import { describe, it, expect } from 'vitest';
import { edgeKey, isEdgeResolved, filterResolved, resolveEdge, unresolveEdge, coverEdgeSplits } from '../untrackedDebts.js';
import { untrackedGroupDebts, pendingIouNet } from '../financeUtils.js';

// The BALANCES card named these debts honestly and then left you stuck with
// them: "B owes A ₹20 — between them, not tracked here" never goes away, no
// matter what anyone pays, because nothing in the app can act on it.

const untracked = { Rafi: { Rakesh: 20 }, Rakesh: { Amit: 15, Rafi: 5 } };

describe('edgeKey', () => {
  it('is directional — who owes whom is the whole point', () => {
    expect(edgeKey('ev1', 'Rafi', 'Rakesh')).not.toBe(edgeKey('ev1', 'Rakesh', 'Rafi'));
  });

  it('is case-insensitive, like every other name match here', () => {
    expect(edgeKey('ev1', 'RAFI', 'rakesh')).toBe(edgeKey('ev1', 'rafi', 'Rakesh'));
  });

  it('is scoped to the event — the same pair can owe in two trips', () => {
    expect(edgeKey('ev1', 'a', 'b')).not.toBe(edgeKey('ev2', 'a', 'b'));
  });
});

describe('filterResolved', () => {
  it('passes everything through when nothing is resolved', () => {
    expect(filterResolved(untracked, {}, 'ev1')).toEqual(untracked);
  });

  it('drops a resolved edge', () => {
    const r = resolveEdge({}, 'ev1', 'Rafi', 'Rakesh', 'settled');
    expect(filterResolved(untracked, r, 'ev1')).toEqual({ Rakesh: { Amit: 15, Rafi: 5 } });
  });

  it('drops the debtor entirely once their last edge is resolved', () => {
    let r = resolveEdge({}, 'ev1', 'Rakesh', 'Amit', 'settled');
    r = resolveEdge(r, 'ev1', 'Rakesh', 'Rafi', 'covered');
    expect(filterResolved(untracked, r, 'ev1')).toEqual({ Rafi: { Rakesh: 20 } });
  });

  it('does not apply another event\'s resolutions', () => {
    const r = resolveEdge({}, 'ev2', 'Rafi', 'Rakesh', 'settled');
    expect(filterResolved(untracked, r, 'ev1')).toEqual(untracked);
  });

  it('drops dust edges so no ₹0 line is ever shown', () => {
    expect(filterResolved({ A: { B: 0.001 } }, {}, 'ev1')).toEqual({});
  });

  it('unresolve puts it back', () => {
    const r = resolveEdge({}, 'ev1', 'Rafi', 'Rakesh', 'settled');
    expect(filterResolved(untracked, unresolveEdge(r, 'ev1', 'Rafi', 'Rakesh'), 'ev1')).toEqual(untracked);
  });

  it('records WHICH way it was resolved, for the UI to say so', () => {
    const r = resolveEdge({}, 'ev1', 'Rafi', 'Rakesh', 'covered');
    expect(isEdgeResolved(r, 'ev1', 'Rafi', 'Rakesh')).toBe(true);
    expect(r[edgeKey('ev1', 'Rafi', 'Rakesh')].mode).toBe('covered');
  });
});

describe('coverEdgeSplits', () => {
  let n = 0;
  const uid = () => `id${++n}`;

  it('makes the edge real as a settleable IOU PAIR', () => {
    const rows = coverEdgeSplits('ev1', 'Rafi', 'Rakesh', 20, { uid, date: '2026-09-15' });
    expect(rows).toHaveLength(2);
    // You owe the creditor; the debtor owes you. Both from YOUR side — the only
    // side this app can record.
    expect(rows[0]).toMatchObject({ name: 'Rakesh', direction: 'owe', amount: 20, eventId: 'ev1' });
    expect(rows[1]).toMatchObject({ name: 'Rafi', direction: 'owed', amount: 20, eventId: 'ev1' });
  });

  it('nets to zero for you — covering costs you nothing once they pay', () => {
    const rows = coverEdgeSplits('ev1', 'Rafi', 'Rakesh', 20, { uid, date: '2026-09-15' });
    expect(pendingIouNet(rows, [])).toBe(0);
  });

  it('carries NO groupId, so settleEventNet leaves it to its own Settle button', () => {
    // It is not expense-derived; folding it into an event net would make that
    // net quote a number the handler cannot move.
    coverEdgeSplits('ev1', 'a', 'b', 5, { uid, date: '2026-09-15' }).forEach(r => expect(r.groupId).toBe(null));
  });

  it('refuses a zero or nonsense edge rather than writing empty IOUs', () => {
    expect(coverEdgeSplits('ev1', 'a', 'b', 0, { uid, date: 'd' })).toEqual([]);
    expect(coverEdgeSplits('ev1', '', 'b', 10, { uid, date: 'd' })).toEqual([]);
  });
});

describe('the reconciliation still holds', () => {
  // tracked IOU net + untracked edges === that person's fair share. Covering an
  // edge moves it from the second term into the first; resolving it at the same
  // time is what stops it being counted in BOTH.
  it('a covered edge leaves the derivation, so nothing double-counts', () => {
    const expenses = [{ id: 'e1', amount: 300, paidBy: 'Rafi', splitWith: { You: 100, Rafi: 100, Rakesh: 100 } }];
    const edges = untrackedGroupDebts(expenses, ['You', 'Rafi', 'Rakesh']);
    expect(edges).toEqual({ Rakesh: { Rafi: 100 } });
    const r = resolveEdge({}, 'ev1', 'Rakesh', 'Rafi', 'covered');
    expect(filterResolved(edges, r, 'ev1')).toEqual({});
  });
});
