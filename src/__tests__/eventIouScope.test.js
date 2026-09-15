import { describe, it, expect } from 'vitest';
import { eventExpenseKeys, eventExpenseIous, pendingIouNet } from '../financeUtils.js';

// The bug this pins: the event settle scope used to be a Set of expense IDs,
// but NOMAD links an IOU to its expense through `groupId`, and the two event
// creation paths spell that link differently —
//
//   • the event Add-expense form  → groupId === the expense's OWN id
//   • the Bill-split sheet        → groupId === a fresh uid stamped on BOTH
//                                   the expense and its IOUs
//
// so every bill-split IOU fell outside an id-only scope. The IOU wallet's
// canNet gate only checked that a groupId existed, so it still offered
// "Settle up" for that group, and settleEventNet then refused with
// "No pending IOUs with X in this event" — on a row visible right above the
// button, with the balance the sheet had just quoted.

const EV = 'ev1';

// Created through the event Add-expense form: groupId === expense id.
const formExp = { id: 'e1', eventId: EV, groupId: 'e1', amount: 300 };
// Created through the Bill-split sheet: a standalone group id, not the row id.
const billExp = { id: 'e2', eventId: EV, groupId: 'g-bill', amount: 181.44 };

const iou = (id, name, amount, groupId, extra = {}) =>
  ({ id, name, amount, direction: 'owed', groupId, eventId: EV, settled: false, skipped: false, ...extra });

describe('eventExpenseKeys', () => {
  it('carries BOTH the id and the groupId of every live event expense', () => {
    const keys = eventExpenseKeys([formExp, billExp], EV);
    expect([...keys].sort()).toEqual(['e1', 'e2', 'g-bill']);
  });

  it('ignores expenses from other events and soft-deleted rows', () => {
    const keys = eventExpenseKeys([
      formExp,
      { id: 'other', eventId: 'ev2', groupId: 'other' },
      { id: 'gone', eventId: EV, groupId: 'g-gone', deleted_at: '2026-09-01T00:00:00Z' },
    ], EV);
    expect([...keys].sort()).toEqual(['e1']);
  });
});

describe('eventExpenseIous', () => {
  const keys = eventExpenseKeys([formExp, billExp], EV);

  it('includes bill-split IOUs, which an expense-id-only scope dropped', () => {
    const rows = [iou('s1', 'Rafi', 90.72, 'g-bill'), iou('s2', 'Rakesh', 90.72, 'g-bill')];
    // The old scope: a Set of expense IDs only.
    const oldScope = new Set([formExp.id, billExp.id]);
    expect(rows.filter(s => oldScope.has(s.groupId))).toHaveLength(0);
    // The fixed scope finds both, and prices them exactly as the sheet quoted.
    expect(eventExpenseIous(rows, keys, EV)).toHaveLength(2);
    expect(pendingIouNet(eventExpenseIous(rows, keys, EV, 'Rafi'), [])).toBe(90.72);
  });

  it('still includes IOUs whose groupId is the expense id', () => {
    const rows = [iou('s3', 'Rafi', 100, 'e1')];
    expect(eventExpenseIous(rows, keys, EV, 'Rafi')).toHaveLength(1);
  });

  it('excludes manually-added event IOUs and rows of a deleted expense', () => {
    const rows = [
      iou('s4', 'Rafi', 50, null),          // manual — its own Settle button
      iou('s5', 'Rafi', 50, 'g-vanished'),  // expense deleted out from under it
      iou('s6', 'Rafi', 50, 'g-bill', { deleted_at: '2026-09-02T00:00:00Z' }),
    ];
    expect(eventExpenseIous(rows, keys, EV, 'Rafi')).toHaveLength(0);
  });

  it('matches the person case-insensitively, like the handler does', () => {
    const rows = [iou('s7', 'RAFI', 90.72, 'g-bill')];
    expect(eventExpenseIous(rows, keys, EV, 'rafi')).toHaveLength(1);
  });

  it('gates canNet and the handler on the SAME set — the button cannot lie', () => {
    const rows = [iou('s8', 'Rafi', 90.72, 'g-bill')];
    const pend = rows.filter(s => !s.settled && !s.skipped);
    const canNet = pend.length > 0 && pend.every(s => s.groupId != null && keys.has(s.groupId));
    const handlerItems = eventExpenseIous(rows, keys, EV, 'Rafi').filter(s => !s.settled && !s.skipped);
    expect(canNet).toBe(true);
    expect(handlerItems.length).toBeGreaterThan(0);
  });
});
