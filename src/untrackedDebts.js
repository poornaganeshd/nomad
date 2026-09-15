// untrackedDebts.js — the debts NOMAD does not record, and what you can do
// about them.
//
// NOMAD tracks IOUs only between You and each participant (`makeExpIOUs`: when
// someone else pays, only YOUR share becomes a debt to them). So when A pays
// for B, "B owes A" is real, falls out of the fair-share maths, and has no IOU
// row behind it. The event BALANCES card names each such edge — "Also owes ₹20
// to A — between them, not tracked here" — which is honest but terminal: the
// line sits there forever, because nothing in the app can act on it. Settling
// with everyone else does not clear it, and there is no way to say it is done.
//
// Two things a person actually wants to do with such an edge:
//
//   "they sorted it out"  → it stops being listed. Nothing moves; this is a
//                           record that the debt is closed, not that cash moved
//                           through YOUR wallets — inventing a settlement for
//                           money that never touched you is exactly the bug
//                           class the write-off branch exists to avoid.
//   "put it on my tab"    → it becomes REAL: you owe the creditor, the debtor
//                           owes you. Two ordinary IOU rows, settleable by
//                           every existing surface, and the totals still
//                           reconcile because the edge is resolved at the same
//                           time and so stops being counted twice.
//
// Resolutions are tiny intent data, not ledger data: one key per edge, stored
// beside budgets/goals in the prefs blob. The IOUs that "cover" creates are the
// real record; this map only stops the derivation from double-counting them.

/** Stable id for one directed edge inside one event. */
export const edgeKey = (eventId, debtor, creditor) =>
  `${eventId || ""}|${String(debtor || "").toLowerCase()}|${String(creditor || "").toLowerCase()}`;

export const isEdgeResolved = (resolved, eventId, debtor, creditor) =>
  !!(resolved || {})[edgeKey(eventId, debtor, creditor)];

/**
 * Drop every resolved edge from an `untrackedGroupDebts` map, and any debtor
 * left with nothing — so the card shows no empty "Also owes" line.
 */
export const filterResolved = (untracked, resolved, eventId) => {
  const out = {};
  Object.entries(untracked || {}).forEach(([debtor, edges]) => {
    const kept = {};
    Object.entries(edges || {}).forEach(([creditor, amt]) => {
      if (!(amt > 0.005)) return;
      if (isEdgeResolved(resolved, eventId, debtor, creditor)) return;
      kept[creditor] = amt;
    });
    if (Object.keys(kept).length) out[debtor] = kept;
  });
  return out;
};

/** Mark an edge resolved. `mode` is "settled" (they sorted it) or "covered". */
export const resolveEdge = (resolved, eventId, debtor, creditor, mode, at = new Date().toISOString()) =>
  ({ ...(resolved || {}), [edgeKey(eventId, debtor, creditor)]: { mode, at } });

export const unresolveEdge = (resolved, eventId, debtor, creditor) => {
  const next = { ...(resolved || {}) };
  delete next[edgeKey(eventId, debtor, creditor)];
  return next;
};

/**
 * The two IOU rows that make an untracked edge real when you cover it.
 *
 * Direction is from YOUR side, the only side this app records: you OWE the
 * creditor (you are paying what the debtor owed them) and the debtor OWES you.
 * They carry the eventId so they group under the event, but NO groupId — they
 * are not expense-derived, so `settleEventNet` correctly leaves them to their
 * own per-row Settle button rather than folding them into an event net that
 * quotes a different number.
 */
export const coverEdgeSplits = (eventId, debtor, creditor, amount, { uid, date, now = new Date().toISOString() } = {}) => {
  const amt = Math.round((Number(amount) || 0) * 100) / 100;
  if (!(amt > 0.005) || !debtor || !creditor) return [];
  const base = { amount: amt, settled: false, skipped: false, eventId: eventId || null, groupId: null, date, createdAt: now };
  return [
    { ...base, id: uid(), name: creditor, direction: "owe", note: `Covered ${debtor}'s share` },
    { ...base, id: uid(), name: debtor, direction: "owed", note: `Covered your share to ${creditor}` },
  ];
};
