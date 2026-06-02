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
  const m = id.match(/^([0-9a-z]{8,11})/i);
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
