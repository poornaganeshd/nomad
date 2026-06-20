export const roundMoney = (value) => Math.round(Number(value || 0) * 100) / 100;

export const localDateKey = (d = new Date()) => {
  const dt = (d instanceof Date) ? d : new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const isoDate = (date) => localDateKey(date);
const dateOnly = (value) => new Date(`${value}T00:00:00`);
const lastDayOfMonth = (year, monthIndex) => new Date(year, monthIndex + 1, 0).getDate();
const withClampedDay = (year, monthIndex, desiredDay) =>
  new Date(year, monthIndex, Math.min(Math.max(1, desiredDay || 1), lastDayOfMonth(year, monthIndex)));

export const fullMonthsBetween = (start, end) => {
  let months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
  const daysInEndMonth = new Date(end.getFullYear(), end.getMonth() + 1, 0).getDate();
  if (end.getDate() < Math.min(start.getDate(), daysInEndMonth)) months -= 1;
  return months;
};

export const fullYearsBetween = (start, end) => {
  let years = end.getFullYear() - start.getFullYear();
  if (end.getMonth() < start.getMonth() || (end.getMonth() === start.getMonth() && end.getDate() < start.getDate())) years -= 1;
  return years;
};

export const getRecurringAnchorDate = (record) =>
  record.lastPaidDate || record.lastSkippedDate || record.startDate;

export const getRecurringDueDate = (record, todayString) => {
  const today = dateOnly(todayString);
  let start = dateOnly(record.startDate);
  if (Number.isNaN(start.getTime())) {
    // null/invalid startDate — for monthly bills with dayOfMonth, compute directly
    if (record.frequency === 'monthly' && record.dayOfMonth) {
      const dom = Math.min(Number(record.dayOfMonth), lastDayOfMonth(today.getFullYear(), today.getMonth()));
      return isoDate(new Date(today.getFullYear(), today.getMonth(), dom));
    }
    return null;
  }
  if (start > today) return null;
  if (record.frequency === 'monthly') {
    const dom = record.dayOfMonth || start.getDate();
    let months = Math.max(0, fullMonthsBetween(start, today));
    let due = withClampedDay(start.getFullYear(), start.getMonth() + months, dom);
    const daysInDueMonth = new Date(due.getFullYear(), due.getMonth() + 1, 0).getDate();
    if (dom > daysInDueMonth && due < today) { months += 1; due = withClampedDay(start.getFullYear(), start.getMonth() + months, dom); }
    if (due < start) { months += 1; due = withClampedDay(start.getFullYear(), start.getMonth() + months, dom); }
    return isoDate(due);
  }
  if (record.frequency === 'yearly') {
    const monthIndex = Math.max(0, (record.yearMonth || (start.getMonth() + 1)) - 1);
    const desiredDay = record.yearDay || start.getDate();
    const startAnchor = withClampedDay(start.getFullYear(), monthIndex, desiredDay);
    const years = Math.max(0, fullYearsBetween(startAnchor, today));
    return isoDate(withClampedDay(start.getFullYear() + years, monthIndex, desiredDay));
  }
  if (record.frequency === 'custom') {
    const intervalDays = Number(record.intervalDays) || 0;
    if (intervalDays <= 0) return null;
    // First occurrence (never paid or skipped) IS the start date, so an
    // "every N days" bill is due on its start day and can be confirmed right
    // after it's added. Once paid/skipped, the next due anchors on that action
    // + interval.
    if (!record.lastPaidDate && !record.lastSkippedDate) return isoDate(start);
    const anchor = dateOnly(getRecurringAnchorDate(record));
    if (Number.isNaN(anchor.getTime())) return null;
    const due = new Date(anchor);
    due.setDate(due.getDate() + intervalDays);
    return isoDate(due);
  }
  return null;
};

export const isRecurringDueToday = (record, todayString) => {
  if (!record.active || record.startDate > todayString) return false;
  const dueDate = getRecurringDueDate(record, todayString);
  if (!dueDate || dueDate > todayString) return false;
  if (record.frequency === 'monthly') return !(record.lastPaidDate?.slice(0, 7) === dueDate.slice(0, 7) || record.lastSkippedDate?.slice(0, 7) === dueDate.slice(0, 7));
  if (record.frequency === 'yearly') return !(record.lastPaidDate?.slice(0, 4) === dueDate.slice(0, 4) || record.lastSkippedDate?.slice(0, 4) === dueDate.slice(0, 4));
  // custom: the first occurrence (no payment/skip yet) is due/awaiting action.
  if (!record.lastPaidDate && !record.lastSkippedDate) return true;
  return getRecurringAnchorDate(record) !== dueDate;
};

export const recurringDaysOverdue = (record, todayString) => {
  const dueDate = getRecurringDueDate(record, todayString);
  if (!dueDate || dueDate >= todayString) return 0;
  const due = new Date(dueDate + 'T12:00:00');
  const today = new Date(todayString + 'T12:00:00');
  return Math.floor((today - due) / 86400000);
};

export const distributeAmount = (amount, headCount) => {
  const cents = Math.round(Number(amount || 0) * 100);
  if (!headCount || cents <= 0) return Array.from({ length: Math.max(0, headCount) }, () => 0);
  const base = Math.floor(cents / headCount);
  let remainder = cents - (base * headCount);
  return Array.from({ length: headCount }, () => {
    const share = base + (remainder > 0 ? 1 : 0);
    remainder = Math.max(0, remainder - 1);
    return share / 100;
  });
};

// Per-person share totals for a SERIES of group expenses. Each expense is
// distributed independently with distributeAmount (the same way the split
// records are created when the expense is logged), then summed per person.
// This is NOT the same as distributeAmount(totalOfAllExpenses, headCount):
// the remainder paisa lands on a per-expense basis, so redistributing the
// grand total can disagree with the recorded splits by a paisa per expense —
// leaving members "owing ₹0.01" forever after fully settling. Any view that
// reconciles against split/settlement records must use this.
export const groupShareTotals = (amounts, headCount) => {
  const totals = Array.from({ length: Math.max(0, headCount || 0) }, () => 0);
  (amounts || []).forEach((amount) => {
    distributeAmount(amount, headCount).forEach((share, i) => {
      totals[i] = roundMoney(totals[i] + share);
    });
  });
  return totals;
};

// Stable, descending comparator for history rows.
// Order: date desc → creation timestamp desc → id desc.
//
// Bug-fix history: earlier impl compared `created_at` strings directly. Items
// missing `created_at` (locally-added before first Supabase sync) had value ""
// and any item WITH created_at sorted above them, regardless of actual age —
// so freshly-added expenses appeared at the bottom of today's entries. Now we
// derive a unified numeric timestamp from `created_at` / `createdAt` /
// `updated_at` / id base36 prefix in that priority, so all items have a
// comparable value.
//
// `updated_at` is deliberately last in the fallback chain — it shifts on every
// edit, but is still a better signal than nothing when older items lack the
// other fields. ID base36 prefix is the safest fallback (uid() encodes
// Date.now() into the id, so base36 prefix sorts in time order).
export const itemTimestamp = (it) => {
  if (it?.created_at) { const n = Date.parse(it.created_at); if (Number.isFinite(n)) return n; }
  if (it?.createdAt)  { const n = Date.parse(it.createdAt);  if (Number.isFinite(n)) return n; }
  const id = String(it?.id || "");
  // Only the base36 uid() fallback encodes Date.now() in its prefix; a
  // crypto.randomUUID() id contains dashes and its hex prefix can parse to a
  // spurious ~1e12 value that slips through the sanity window and mis-dates the
  // row. Skip dashed (UUID) ids — they fall through to updated_at / 0.
  const m = !id.includes("-") && id.match(/^([0-9a-z]{8,11})/i);
  if (m) {
    const n = parseInt(m[1], 36);
    // Sanity check: timestamp in ms must be after year 2001 (1e12) and before year 5000 (~1e14)
    if (Number.isFinite(n) && n > 1_000_000_000_000 && n < 100_000_000_000_000) return n;
  }
  if (it?.updated_at) { const n = Date.parse(it.updated_at); if (Number.isFinite(n)) return n; }
  return 0;
};

export const historySortCompare = (a, b) => {
  const dd = (b?.date || "").localeCompare(a?.date || "");
  if (dd !== 0) return dd;
  const tb = itemTimestamp(b);
  const ta = itemTimestamp(a);
  if (tb !== ta) return tb - ta;
  return String(b?.id || "").localeCompare(String(a?.id || ""));
};

// "Net across everything" — aggregates every still-open IOU per counterparty
// across BOTH personal splits (no eventId) and event splits, nets owe vs owed,
// and counts the distinct "places" (contexts) a person appears in.
//
// Correctness guards — these ARE the feature:
//   1. skipped splits never count (explicitly waived).
//   2. settled splits never count, and amount is the REMAINING balance
//      (original − settlements applied) so a fully-paid split contributes 0 and
//      drops out — settlements actually cancel the debt here.
//   3. a split inside a COMPLETED event never counts. Once an event is wrapped
//      up its balances are closed; it must not keep nagging the global net.
//      (This was the reported bug: settled/finished events still showed here.)
export const netAcrossPeople = (splits = [], settlements = [], events = []) => {
  const paidBySplit = {};
  (settlements || []).forEach((s) => {
    if (s && s.splitId != null) paidBySplit[s.splitId] = (paidBySplit[s.splitId] || 0) + (Number(s.amount) || 0);
  });
  const doneEvents = new Set((events || []).filter((e) => e && e.status === "completed").map((e) => e.id));

  const byName = new Map();
  (splits || []).forEach((sp) => {
    if (!sp || sp.deleted_at || sp.skipped || sp.settled) return;          // guard 1 + 2
    if (sp.eventId && doneEvents.has(sp.eventId)) return;                   // guard 3
    const remaining = roundMoney((Number(sp.amount) || 0) - (paidBySplit[sp.id] || 0)); // guard 2
    if (remaining <= 0.005) return;
    const name = String(sp.name || "").trim();
    if (!name) return;
    let entry = byName.get(name);
    if (!entry) { entry = { name, owe: 0, owed: 0, places: new Set() }; byName.set(name, entry); }
    if (sp.direction === "owed") entry.owed = roundMoney(entry.owed + remaining);
    else entry.owe = roundMoney(entry.owe + remaining);
    entry.places.add(sp.eventId || "personal");
  });

  const people = [...byName.values()]
    .map((e) => ({ name: e.name, owe: e.owe, owed: e.owed, net: roundMoney(e.owed - e.owe), placeCount: e.places.size }))
    .filter((e) => e.owe > 0.005 || e.owed > 0.005)
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || (b.owed + b.owe) - (a.owed + a.owe));

  const totalOwed = roundMoney(people.reduce((t, p) => t + Math.max(0, p.net), 0));
  const totalOwe = roundMoney(people.reduce((t, p) => t + Math.max(0, -p.net), 0));
  return { people, totalOwed, totalOwe };
};

// Write-offs summary. `writeOffMap` is { splitId: "written" | "forgiven" } —
// kept in its OWN localStorage key (nomad-writeoffs-v1), NOT on the synced split
// row, so a background Supabase pull can never wipe the tag and it needs no DB
// column. "written" = a debt owed TO YOU you gave up collecting; "forgiven" = a
// debt YOU owed that the other side waived. Both are non-cash (no settlement, no
// wallet movement) — purely a record of what fell off the books. Sums the
// REMAINING balance (original − prior settlements). netLoss = written − forgiven.
export const writeOffTotals = (splits = [], settlements = [], writeOffMap = {}) => {
  const map = writeOffMap || {};
  const paid = {};
  (settlements || []).forEach((s) => {
    if (s && s.splitId != null) paid[s.splitId] = (paid[s.splitId] || 0) + (Number(s.amount) || 0);
  });
  let written = 0, forgiven = 0;
  (splits || []).forEach((s) => {
    if (!s || s.deleted_at) return;
    const kind = map[s.id];
    if (!kind) return;
    const rem = roundMoney((Number(s.amount) || 0) - (paid[s.id] || 0));
    if (rem <= 0.005) return;
    if (kind === "written") written = roundMoney(written + rem);
    else if (kind === "forgiven") forgiven = roundMoney(forgiven + rem);
  });
  return { written, forgiven, netLoss: roundMoney(written - forgiven) };
};
