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

// Per-person share map for a list of group expenses, honouring each expense's
// optional `splitWith` breakdown — a { name -> share } object ("You" for the
// logger, absent/0 = excluded from that expense). Expenses WITHOUT `splitWith`
// fall back to an equal split across `allParts`, identical to groupShareTotals,
// so legacy events reconcile unchanged. `allParts` is the canonical participant
// list INCLUDING "You" (index 0), and its order decides who absorbs the
// remainder paisa on equal splits — keep "You" first to match netSpent. Returns
// { name -> roundMoney total }.
export const expenseShareMap = (expenses, allParts) => {
  const parts = (allParts || []).filter(Boolean);
  const totals = Object.fromEntries(parts.map((p) => [p, 0]));
  (expenses || []).forEach((e) => {
    if (!e) return;
    const sw = e.splitWith;
    if (sw && typeof sw === "object") {
      parts.forEach((p) => {
        const v = Number(sw[p]);
        if (Number.isFinite(v) && v > 0) totals[p] = roundMoney(totals[p] + v);
      });
    } else {
      distributeAmount(e.amount, parts.length).forEach((share, i) => {
        const p = parts[i];
        if (p != null) totals[p] = roundMoney(totals[p] + share);
      });
    }
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

// ---------------------------------------------------------------------------
// Shared decision helpers — the "single source of truth" wall.
//
// Each function below replaces logic that used to be inlined (and silently
// drifted) in more than one place in App.jsx. They are pure and unit-tested, so
// every call site stays in agreement and a regression shows up as a test
// failure rather than a user-visible bug. Don't re-inline these.
// ---------------------------------------------------------------------------

// RBI cap: a UPI Lite wallet may never hold more than ₹5000.
export const UPI_LITE_MAX_BALANCE = 5000;

// True when topping a UPI Lite wallet (current balance) up by `incoming` would
// breach the ₹5000 ceiling. Used by every path that can credit UPI Lite
// (calibration AND transfers — transfers used to skip the check entirely).
export const exceedsUpiLiteBalance = (currentBalance, incoming = 0) =>
  roundMoney((Number(currentBalance) || 0) + (Number(incoming) || 0)) > UPI_LITE_MAX_BALANCE;

// Default wallet for a settle / record-payment action. direction "owed" means
// YOU receive the money, and UPI Lite cannot receive — so it must never be the
// default for a receive. (The modal used to default to UPI Lite and the save
// then rejected it, so a no-tap confirm always errored.) `isUpiLiteFn` is the
// app's isUpiLite predicate, passed in to keep this module React/wallet-free.
export const defaultSettleWalletId = (direction, wallets, isUpiLiteFn) => {
  const list = wallets || [];
  const usable = direction === "owed" ? list.filter(w => !isUpiLiteFn(w)) : list;
  return (usable[0] || list[0])?.id;
};

// A settlement's contribution to the SPLIT ledger. `amount` is the cash that
// actually moved (wallet math must always use it in full); `excess` is the part
// paid over and above the IOU's remainder (an overpay — e.g. owed ₹11.66, friend
// sends ₹12). Every place that reconciles settlements against splits/shares
// (paid-so-far, remaining, group ledgers, spending stats) must use this net
// value or the extra paise leak in as phantom credit. The excess itself is
// surfaced only in the write-off ledger, as recovery.
export const settlementNetAmount = (s) =>
  roundMoney((Number(s?.amount) || 0) - (Number(s?.excess) || 0));

// Fat-finger guard for overpaid settles. A small tip-sized surplus (₹12 against
// ₹11.66) sails through; a surplus that's large in absolute terms (> ₹50) or
// relative to the amount due (> 20%) is more likely a typo (120 for 12), so the
// settle button demands a second, explicit tap before moving real money.
// Single source for every settle surface (per-IOU modal, net-settle sheet).
export const isSuspiciousExcess = (excess, due) => {
  const e = Number(excess) || 0;
  const d = Number(due) || 0;
  if (e <= 0.005) return false;
  return e > 50 || (d > 0 && e > roundMoney(d * 0.2));
};

// Resolve a recurring bill's category to a display object. Recurring bills use
// the recurring category lists (built-in defaults + the user's custom ones), NOT
// the expense categories — looking them up against expense categories showed a
// raw id like "ott"/"other_rec". Pass the lists in priority order. Single source
// of truth for every place that renders a recurring category.
export const resolveRecCategory = (categoryId, lists = [], categoryName) => {
  for (const list of lists) {
    const hit = (list || []).find(c => c && c.id === categoryId);
    if (hit) return hit;
  }
  return { id: categoryId, name: categoryName || categoryId, color: "#8A8A9A", neon: "#A0A0B0" };
};

// Smart Add-form defaults: the category/wallet you most plausibly log next,
// from recency-weighted frequency over the last 120 days with a same-weekday
// boost (expenses only store a day-precision `date`, so time-of-day is not
// available). Candidates are restricted to ids in validCategoryIds /
// validWalletIds when provided, so a deleted category can never be suggested.
// Returns { categoryId, walletId } with nulls when there's no usable history.
export const suggestAddDefaults = (expenses, { now = new Date(), validCategoryIds, validWalletIds } = {}) => {
  const nowNoon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  const todayDow = nowNoon.getDay();
  const catScore = {}, walScore = {};
  for (const e of expenses || []) {
    if (!e || e.deleted_at || !e.date) continue;
    const [y, m, d] = String(e.date).split("-").map(Number);
    if (!y || !m || !d) continue;
    const when = new Date(y, m - 1, d, 12);
    const age = Math.round((nowNoon - when) / 86400000);
    if (age < 0 || age > 120) continue;
    const w = Math.pow(0.97, age) * (when.getDay() === todayDow ? 1.25 : 1);
    if (e.categoryId && (!validCategoryIds || validCategoryIds.has(e.categoryId))) catScore[e.categoryId] = (catScore[e.categoryId] || 0) + w;
    if (e.walletId && (!validWalletIds || validWalletIds.has(e.walletId))) walScore[e.walletId] = (walScore[e.walletId] || 0) + w;
  }
  const top = scores => { let best = null, bestW = 0; for (const [id, sc] of Object.entries(scores)) if (sc > bestW) { best = id; bestW = sc; } return best; };
  return { categoryId: top(catScore), walletId: top(walScore) };
};
