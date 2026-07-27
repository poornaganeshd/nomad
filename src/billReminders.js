const SHOWN_KEY_PREFIX = "nomad-bill-reminders-";

function getTodayShown(todayStr) {
  try { return new Set(JSON.parse(localStorage.getItem(SHOWN_KEY_PREFIX + todayStr) || "[]")); }
  catch { return new Set(); }
}

function markShown(todayStr, ids) {
  try {
    const s = getTodayShown(todayStr);
    ids.forEach(id => s.add(id));
    localStorage.setItem(SHOWN_KEY_PREFIX + todayStr, JSON.stringify([...s]));
    // Keep today and the previous local day; purge anything older.
    // Keeping yesterday avoids re-firing reminders if the tab crosses midnight
    // and the new local day key is computed before the old one is cleared.
    const yesterdayStr = addDays(todayStr, -1);
    Object.keys(localStorage)
      .filter(k => k.startsWith(SHOWN_KEY_PREFIX)
        && k !== SHOWN_KEY_PREFIX + todayStr
        && k !== SHOWN_KEY_PREFIX + yesterdayStr)
      .forEach(k => localStorage.removeItem(k));
  } catch { /* quota — non-fatal */ }
}

// Local-date arithmetic. Both input and output are YYYY-MM-DD in local time.
// Previous implementation used toISOString() which silently shifted to UTC and
// produced off-by-one results for timezones east of UTC (e.g., IST).
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// Exported so any future consumer shares this exact "paid/skipped this
// cycle?" decision instead of re-deriving it (guarded by billReminders tests).
export function isNotHandled(r, dueStr) {
  if (r.frequency === "monthly") return !(r.lastPaidDate?.slice(0, 7) === dueStr.slice(0, 7) || r.lastSkippedDate?.slice(0, 7) === dueStr.slice(0, 7));
  if (r.frequency === "yearly") return !(r.lastPaidDate?.slice(0, 4) === dueStr.slice(0, 4) || r.lastSkippedDate?.slice(0, 4) === dueStr.slice(0, 4));
  // custom: first occurrence (no payment/skip yet) is not yet handled.
  if (!r.lastPaidDate && !r.lastSkippedDate) return true;
  const anchor = r.lastPaidDate || r.lastSkippedDate || r.startDate;
  return anchor !== dueStr;
}

// Settlement rows carry an `excess` (overpay surplus) that must NOT count
// against the IOU — mirrors settlementNetAmount in financeUtils. Kept local so
// billReminders stays dependency-free.
function paidAgainst(settlements, splitId) {
  return (settlements || []).reduce((t, x) => {
    if (x?.splitId !== splitId) return t;
    const amt = Number(x.amount) || 0;
    const exc = Number(x.excess) || 0;
    return t + (amt - exc);
  }, 0);
}

/**
 * Reminders for the current local day: recurring bills due/upcoming, plus what
 * you still owe people.
 *
 * The IOU leg is aggregated PER PERSON and uses the REMAINING balance, not the
 * original IOU amount. Reminding per split re-nagged the full ₹100 of a ₹100
 * IOU you'd already paid ₹90 of, and stacked one toast per row (three separate
 * "You owe … — Rakesh" chips for one person). Skipped (written-off), settled
 * and soft-deleted IOUs are excluded outright.
 *
 * @param settlements settlement rows — needed to subtract partial payments.
 */
export function checkBillReminders(recurring, splits, todayStr, getRecurringDueDateFn, isRecurringDueTodayFn, settlements = []) {
  const shown = getTodayShown(todayStr);
  const reminders = [];
  const in3Str = addDays(todayStr, 3);

  recurring.filter(r => r.active).forEach(r => {
    const key = "rec-" + r.id;
    if (shown.has(key)) return;
    if (isRecurringDueTodayFn(r, todayStr)) {
      reminders.push({ id: key, msg: `${r.name} is due`, type: "warn" });
      return;
    }
    const upcoming = getRecurringDueDateFn(r, in3Str);
    if (upcoming && upcoming > todayStr && upcoming <= in3Str && isNotHandled(r, upcoming)) {
      const days = Math.round((new Date(upcoming + "T00:00:00") - new Date(todayStr + "T00:00:00")) / 86400000);
      reminders.push({ id: key, msg: `${r.name} due in ${days} day${days !== 1 ? "s" : ""}`, type: "info" });
    }
  });

  // One line per person, carrying their total OUTSTANDING balance.
  const byPerson = new Map();
  (splits || []).forEach(s => {
    if (!s || s.direction !== "owe" || s.settled || s.skipped || s.deleted_at) return;
    const rem = Math.round(((Number(s.amount) || 0) - paidAgainst(settlements, s.id)) * 100) / 100;
    if (rem <= 0.005) return;
    const name = String(s.name || "").trim();
    if (!name) return;
    const k = name.toLowerCase();
    const cur = byPerson.get(k) || { name, total: 0, count: 0 };
    cur.total = Math.round((cur.total + rem) * 100) / 100;
    cur.count += 1;
    byPerson.set(k, cur);
  });
  [...byPerson.values()].sort((a, b) => b.total - a.total).forEach(p => {
    const key = "owe-" + p.name.toLowerCase();
    if (shown.has(key)) return;
    reminders.push({ id: key, msg: `You owe ₹${p.total} — ${p.name}${p.count > 1 ? ` (${p.count} IOUs)` : ""}`, type: "warn" });
  });

  if (reminders.length > 0) markShown(todayStr, reminders.map(r => r.id));
  return reminders;
}
