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

// THE money formatter. Whole rupees render without decimals, anything with a
// fractional part renders with exactly two.
//
// `toLocaleString("en-IN")` with no options was showing whatever each number
// happened to have: ₹670.56 sat next to ₹572.2 in the same card, and a value
// carrying float noise rendered a THIRD of a paisa (₹1,234.567) or an amount
// nobody has (₹99.999). Pinning only maximumFractionDigits fixes the second
// problem and not the first — 572.2 still prints one decimal — so the minimum
// has to move with the value.
//
// The whole-number test uses a half-paisa tolerance, so distributeAmount
// residue (₹1,500.001) reads as ₹1,500 rather than ₹1,500.00.
//
// Sign handling is deliberately unchanged: callers pass Math.abs() and add
// their own +/− (IOUWallet's fmtSigned slices the currency symbol off the
// front, which only works while the symbol stays first).
export const formatMoney = (value, currency = "\u20B9") => {
  const v = Number(value) || 0;
  const whole = Math.abs(v - Math.round(v)) < 0.005;
  return currency + v.toLocaleString("en-IN", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
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

// The signed CASH a batch of settlement records moves in its wallet: money
// received ("owed") counts up, money handed over ("owe") counts down. It reads
// `amount` in full, not settlementNetAmount — an overpay genuinely leaves the
// wallet, so the wallet must see all of it.
export const settlementsCash = (recs) =>
  roundMoney((Array.isArray(recs) ? recs : []).reduce(
    (t, r) => t + (r?.direction === "owed" ? (Number(r?.amount) || 0) : -(Number(r?.amount) || 0)), 0));

// A net settle must move EXACTLY the cash its confirm button promised, and this
// is the check that proves it before anything is written.
//
// Why it exists: a net settle nets "you owe" against "owes you" and records one
// settlement per IOU, relying on the opposite-direction rows to cancel the
// gross. That only balances while the sheet and the handler are netting the
// SAME set of IOUs — and they each derive it independently. Whenever those sets
// drift (a sheet left open while the data moved, an event IOU inside the
// sheet's net but outside the handler's scope) the wallet quietly banks the
// difference: History reports the GROSS of every "owes you" IOU as money that
// reached the bank while only the net ever did, and the wallet then disagrees
// with the real account by exactly the cancelled side. Comparing the two to the
// paisa turns that silent drift into a refusal the user can act on.
// `expected` null/undefined means "no expectation supplied" → always passes.
export const cashMatchesExpectation = (expected, actual) =>
  expected == null ||
  Math.abs(roundMoney(Number(expected) || 0) - roundMoney(Number(actual) || 0)) <= 0.011;

// How much has been paid against each split id, net of overpay excess. The one
// answer to "how much of this IOU has landed", so every caller that needs a
// REMAINING balance starts from the same number.
export const settlementsBySplit = (settlements) => {
  const m = {};
  (settlements || []).forEach((x) => {
    if (!x || x.splitId == null) return;
    m[x.splitId] = roundMoney((m[x.splitId] || 0) + settlementNetAmount(x));
  });
  return m;
};

// The pending net across a set of IOU rows — "owes you" counts up, "you owe"
// counts down, each on its REMAINING balance, with settled / written-off /
// soft-deleted rows excluded.
//
// This is exactly what a net settle will move, which is why a settle sheet must
// quote THIS and not some other derivation of the same debt. The Events tab's
// "Settle up" row was priced from the greedy fair-share simplifier instead — a
// different (also valid) plan that can route a debt through a participant the
// IOU ledger has no row for — so the button promised one figure and the handler
// moved another, silently.
export const pendingIouNet = (splits, settlements) => {
  const paid = settlementsBySplit(settlements);
  return roundMoney((splits || []).reduce((t, s) => {
    if (!s || s.deleted_at || s.settled || s.skipped) return t;
    const rem = roundMoney((Number(s.amount) || 0) - (paid[s.id] || 0));
    if (!(rem > 0.005)) return t;
    return t + (s.direction === "owed" ? rem : -rem);
  }, 0));
};

// Debts a group expense creates between two OTHER participants — the ones NOMAD
// does not record. It tracks IOUs only between You and each participant
// (`makeExpIOUs`: when someone else pays, only YOUR share becomes a debt to
// them), so when A pays for B, "B owes A" is real but has no IOU row and no way
// to settle in the app.
//
// Returned as { debtor: { creditor: amount } }. The event BALANCES card states
// these out loud instead of folding them into a headline number that nothing on
// screen can act on: a person's tracked IOU net PLUS their untracked edges is
// exactly their fair share, so the row still reconciles.
export const untrackedGroupDebts = (expenses, allParts) => {
  const parts = (allParts || []).filter(Boolean);
  const out = {};
  (expenses || []).forEach((e) => {
    if (!e) return;
    const raw = e.paidBy;
    const payer = !raw || raw === "me"
      ? "You"
      : (parts.find((p) => p.toLowerCase() === String(raw).toLowerCase()) || "You");
    // You paid → every other share is a tracked "owes you". Nothing hidden.
    if (payer === "You") return;
    const sw = e.splitWith && typeof e.splitWith === "object" ? e.splitWith : null;
    // Mirrors expenseShareMap's equal-split fallback exactly (same order, same
    // residue distribution) so the two can never disagree by a paisa.
    const equal = sw ? null : distributeAmount(e.amount, parts.length);
    parts.forEach((q, i) => {
      if (q === "You" || q === payer) return;
      const share = sw ? Number(sw[q]) : equal[i];
      if (!Number.isFinite(share) || share <= 0.005) return;
      if (!out[q]) out[q] = {};
      out[q][payer] = roundMoney((out[q][payer] || 0) + share);
    });
  });
  return out;
};

// Will this settle write any INCOMING settlement record? UPI Lite is spend-only,
// so the answer decides both which wallets a settle sheet may OFFER and which a
// settle handler will ACCEPT.
//
// The net's own sign is NOT the rule. A FULL net settle records one settlement
// per IOU and leans on the opposite-direction rows to cancel, so a net you PAY
// can still carry "owes you" legs that credit the wallet — one such leg is
// enough to disqualify UPI Lite. A PARTIAL pay-down writes records for the
// paying direction alone, so there only the net's direction matters.
//
// Single source because the sheet and the handler derive this independently:
// while the sheet asked only "is the net incoming?", it listed UPI Lite for
// every mixed net you pay, and the handler then refused it every time — a
// dead end with no way out from inside the sheet.
export const settleWritesIncoming = ({ net = 0, hasOwedItems = false, partial = false } = {}) =>
  roundMoney(Number(net) || 0) > 0.005 || (!partial && !!hasOwedItems);

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

// Savings-goal progress: the single source for every place that renders a goal
// (dashboard card + settings editor). A goal is { target, saved, targetDate? }
// with amounts in INR; contributions are manual markers and never move wallet
// balances. Pace (monthsLeft/perMonth) only exists for a dated, unfinished,
// non-overdue goal; months are counted calendar-month to calendar-month with a
// floor of 1 so "due this month" still yields a finite per-month figure.
export const goalProgress = (goal, todayKey = localDateKey()) => {
  const target = roundMoney(Math.max(0, Number(goal?.target) || 0));
  const saved = roundMoney(Math.max(0, Number(goal?.saved) || 0));
  const remaining = roundMoney(Math.max(0, target - saved));
  const done = target > 0 && saved >= target;
  const pct = target > 0 ? (done ? 100 : Math.min(99, Math.floor((saved / target) * 100))) : 0;
  const targetDate = (typeof goal?.targetDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(goal.targetDate)) ? goal.targetDate : null;
  let monthsLeft = null, perMonth = null, overdue = false;
  if (targetDate && !done) {
    overdue = targetDate < todayKey;
    if (!overdue) {
      const [ty, tm] = targetDate.split("-").map(Number);
      const [cy, cm] = todayKey.split("-").map(Number);
      monthsLeft = Math.max(1, (ty - cy) * 12 + (tm - cm));
      perMonth = roundMoney(remaining / monthsLeft);
    }
  }
  return { target, saved, remaining, pct, done, monthsLeft, perMonth, overdue, targetDate };
};

// ── Terrain hero math (dashboard) ────────────────────────────────────────────
// monotonePathD: SVG cubic path through `pts` using monotone cubic interpolation
// (Fritsch–Carlson). This replaced a Catmull-Rom spline, and the difference is
// the whole reason the hero used to look "sharp": Catmull-Rom takes the tangent
// at each point from its NEIGHBOURS ((next − prev)/6), which at a one-day spike
// is non-zero and asymmetric — so every reversal drew a hard corner, and the
// curve overshot past the data on top of it. Monotone forces the tangent to ZERO
// wherever the slope changes sign, so a peak lands as a rounded crest and a dip
// as a rounded basin, and it provably never overshoots the input values.
//
// Pure geometry, no smoothing: every point is still hit exactly, so the trail
// keeps telling the truth about the balance. Only the curve BETWEEN points
// changes.
export const monotonePathD = (pts) => {
  const p = (Array.isArray(pts) ? pts : []).filter(
    (q) => q && Number.isFinite(q.x) && Number.isFinite(q.y)
  );
  const n = p.length;
  if (!n) return "";
  const at = (i) => `${p[i].x.toFixed(1)},${p[i].y.toFixed(1)}`;
  if (n === 1) return `M${at(0)}`;
  if (n === 2) return `M${at(0)} L${at(1)}`;

  // Secant slopes between consecutive points.
  const h = [], m = [];
  for (let i = 0; i < n - 1; i += 1) {
    h[i] = p[i + 1].x - p[i].x;
    m[i] = h[i] === 0 ? 0 : (p[i + 1].y - p[i].y) / h[i];
  }
  // Tangents: zero at every local extremum, weighted harmonic mean elsewhere
  // (the harmonic mean is what keeps the segment monotone, so no overshoot).
  const t = new Array(n);
  t[0] = m[0];
  t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i += 1) {
    if (m[i - 1] * m[i] <= 0) { t[i] = 0; continue; }
    const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
    t[i] = (w1 + w2) / (w1 / m[i - 1] + w2 / m[i]);
  }

  let d = `M${at(0)}`;
  for (let i = 0; i < n - 1; i += 1) {
    const k = h[i] / 3;
    d += ` C${(p[i].x + k).toFixed(1)},${(p[i].y + t[i] * k).toFixed(1)}`
      + ` ${(p[i + 1].x - k).toFixed(1)},${(p[i + 1].y - t[i + 1] * k).toFixed(1)}`
      + ` ${at(i + 1)}`;
  }
  return d;
};

// smoothSeries: light shape-preserving easing for the hero ridgeline. Each pass
// is a [1,2,1]/4 kernel over the interior — a point moves a quarter of the way
// toward each neighbour — with the ENDPOINTS PINNED, so the trail still begins
// exactly at the 30-day-ago balance and ends exactly at today's. Two passes
// leave a lone one-day spike at ~37% of its raw height and spread it over five
// days, while a multi-day trend is essentially untouched.
//
// Why smooth at all: the hero is a decorative contour ridgeline with no y-axis,
// no gridlines and no tooltips — nothing is read off it except the SHAPE. Drawn
// raw, a ledger with a few big spend days becomes flat shelves joined by
// near-vertical cliffs, which is what "sharp, no smoothness" meant. Every figure
// the card actually STATES (today's balance, the 30-day delta, In/Out/Kept, the
// burn rate) is computed from the raw values and never from this.
export const smoothSeries = (values, passes = 1) => {
  let v = (Array.isArray(values) ? values : []).map((x) => {
    const num = Number(x);
    return Number.isFinite(num) ? num : 0;
  });
  for (let p = 0; p < Math.max(0, passes); p += 1) {
    if (v.length < 3) break;
    const out = v.slice();
    for (let i = 1; i < v.length - 1; i += 1) out[i] = (v[i - 1] + 2 * v[i] + v[i + 1]) / 4;
    v = out;
  }
  return v;
};

// balanceTrail: end-of-day TOTAL balance for the last `days` days, ending at
// `currentBalance` today. Walks BACKWARD from today subtracting each day's net
// so the series always reconciles exactly with the live balance. `events` are
// signed deltas to the total ({date: 'YYYY-MM-DD', amount}) — the caller builds
// them mirroring the wBal accumulation rules (unknown-wallet rows excluded,
// transfers between two known wallets cancel out). Events before the window
// need no handling (they're already inside the oldest balance); future-dated
// events are ignored (their day is never visited).
export const balanceTrail = (currentBalance, events, { days = 30, todayKey = localDateKey() } = {}) => {
  const net = {};
  for (const e of events || []) {
    if (!e || !e.date) continue;
    const key = String(e.date).slice(0, 10);
    net[key] = roundMoney((net[key] || 0) + (Number(e.amount) || 0));
  }
  const [y, m, d] = String(todayKey).split("-").map(Number);
  const out = [];
  let bal = roundMoney(Number(currentBalance) || 0);
  for (let i = 0; i <= days; i++) {
    const key = localDateKey(new Date(y, m - 1, d - i, 12));
    out.unshift({ date: key, bal });
    bal = roundMoney(bal - (net[key] || 0));
  }
  return out;
};

// runwayInfo: "days of ground ahead" from the current burn rate. `spendEvents`
// are positive outflows ({date, amount}); rate = mean over the last `win` days
// (today inclusive), usual = mean over the `baseline` days before that window.
// daysLeft/daysAtUsual floor to whole days; null means "no burn measured".
export const runwayInfo = (balance, spendEvents, { todayKey = localDateKey(), win = 7, baseline = 21 } = {}) => {
  const bal = Math.max(0, Number(balance) || 0);
  const [y, m, d] = String(todayKey).split("-").map(Number);
  const keyAt = (off) => localDateKey(new Date(y, m - 1, d + off, 12));
  const winStart = keyAt(-(win - 1));
  const baseStart = keyAt(-(win - 1) - baseline);
  let winSum = 0, baseSum = 0;
  for (const e of spendEvents || []) {
    if (!e || !e.date) continue;
    const a = Number(e.amount) || 0;
    if (a <= 0) continue;
    const key = String(e.date).slice(0, 10);
    if (key > todayKey) continue;
    if (key >= winStart) winSum += a;
    else if (key >= baseStart) baseSum += a;
  }
  const rate = roundMoney(winSum / win);
  const usual = roundMoney(baseSum / baseline);
  const daysLeft = rate > 0 ? Math.floor(bal / rate) : null;
  const daysAtUsual = usual > 0 ? Math.floor(bal / usual) : null;
  const dryBy = daysLeft !== null ? keyAt(daysLeft) : null;
  return { rate, usual, daysLeft, daysAtUsual, dryBy };
};
