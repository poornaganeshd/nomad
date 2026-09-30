// Server-side bill-reminder push via ntfy.
//
// This is the "closed-app" leg of NOMAD's ntfy integration: the daily cron
// (send-reports) computes each registered user's due/overdue/upcoming bills
// from their own Supabase `recurring` table and POSTs a digest to their ntfy
// topic — so reminders arrive even when no NOMAD tab is open.
//
// Design notes:
// - Zero new env vars. Each user's ntfy server + topic live in a
//   `notification_prefs` row in THEIR OWN Supabase (BYODB), read per-user by
//   the cron the same way `report_schedules` is.
// - The recurring due-date logic below is a faithful port of
//   src/financeUtils.js. api/ is CommonJS and cannot import the ESM src/
//   helpers, so it is duplicated here and covered by api/__tests__/notify.test.ts.
//   If you change the due-date math in one place, change it in both.

export interface RecurringRow {
  id: string;
  name: string;
  amount: number;
  frequency: "monthly" | "yearly" | "custom";
  dayOfMonth?: number | null;
  intervalDays?: number | null;
  yearMonth?: number | null;
  yearDay?: number | null;
  startDate: string;
  active?: boolean;
  lastPaidDate?: string | null;
  lastSkippedDate?: string | null;
  /** "income" = money arriving; absent/anything else = a bill. */
  type?: string | null;
}
export interface SplitRow {
  id: string;
  name: string;
  amount: number;
  direction: string;
  settled?: boolean;
  skipped?: boolean;
}
export interface SettlementRow {
  splitId?: string | null;
  amount?: number | null;
  /** Overpay surplus — does not count against the IOU (see settlementNetAmount). */
  excess?: number | null;
}
export interface NotifyPrefs {
  enabled?: boolean;
  ntfy_server?: string | null;
  ntfy_topic?: string | null;
  last_run_date?: string | null;
}

// ── date helpers (local YYYY-MM-DD, no UTC drift) ──────────────────────────
const dateOnly = (value: string) => new Date(`${value}T00:00:00`);
const isoDate = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
const lastDayOfMonth = (year: number, monthIndex: number) => new Date(year, monthIndex + 1, 0).getDate();
const withClampedDay = (year: number, monthIndex: number, desiredDay: number) =>
  new Date(year, monthIndex, Math.min(Math.max(1, desiredDay || 1), lastDayOfMonth(year, monthIndex)));

const getRecurringAnchorDate = (r: RecurringRow) => r.lastPaidDate || r.lastSkippedDate || r.startDate;

// Port of src/financeUtils.js getRecurringDueDate.
export function getRecurringDueDate(record: RecurringRow, todayString: string): string | null {
  const today = dateOnly(todayString);
  const start = dateOnly(record.startDate);
  if (Number.isNaN(start.getTime())) {
    if (record.frequency === "monthly" && record.dayOfMonth) {
      const dom = Math.min(Number(record.dayOfMonth), lastDayOfMonth(today.getFullYear(), today.getMonth()));
      return isoDate(new Date(today.getFullYear(), today.getMonth(), dom));
    }
    return null;
  }
  if (start > today) return null;
  // Latest occurrence on or before today, never before the first one on or
  // after startDate (see financeUtils for the three bugs the old
  // start-day-anchored month count caused).
  if (record.frequency === "monthly" || record.frequency === "yearly") {
    const monthly = record.frequency === "monthly";
    const dom = Number(record.dayOfMonth) || start.getDate();
    const ym = Math.max(0, (Number(record.yearMonth) || (start.getMonth() + 1)) - 1);
    const yd = Number(record.yearDay) || start.getDate();
    // The occurrence in month m of year y (monthly) / in year y (yearly).
    const at = (y: number, m: number) => (monthly ? withClampedDay(y, m, dom) : withClampedDay(y, ym, yd));
    let due = at(today.getFullYear(), today.getMonth());
    if (due > today) due = monthly ? at(today.getFullYear(), today.getMonth() - 1) : at(today.getFullYear() - 1, 0);
    let first = at(start.getFullYear(), start.getMonth());
    if (first < start) first = monthly ? at(start.getFullYear(), start.getMonth() + 1) : at(start.getFullYear() + 1, 0);
    return isoDate(due < first ? first : due);
  }
  if (record.frequency === "custom") {
    const intervalDays = Number(record.intervalDays) || 0;
    if (intervalDays <= 0) return null;
    if (!record.lastPaidDate && !record.lastSkippedDate) return isoDate(start);
    const anchor = dateOnly(getRecurringAnchorDate(record));
    if (Number.isNaN(anchor.getTime())) return null;
    const due = new Date(anchor);
    due.setDate(due.getDate() + intervalDays);
    return isoDate(due);
  }
  return null;
}

// Port of src/financeUtils.js isRecurringDueToday.
export function isRecurringDueToday(record: RecurringRow, todayString: string): boolean {
  if (!record.active || record.startDate > todayString) return false;
  const dueDate = getRecurringDueDate(record, todayString);
  if (!dueDate || dueDate > todayString) return false;
  if (record.frequency === "monthly" || record.frequency === "yearly") return !isCycleHandled(record, dueDate);
  if (!record.lastPaidDate && !record.lastSkippedDate) return true;
  return getRecurringAnchorDate(record) !== dueDate;
}

// Port of src/financeUtils.js isRecurringCycleHandled: a cycle is settled by a
// paid/skipped action ON or AFTER its due date. This port still compared the
// calendar PERIOD (YYYY-MM) long after the client stopped, so paying
// September's rent on 2 Oct left the daily push saying "Rent overdue" until
// the next due date — and then silently swallowed October's unpaid cycle.
function isCycleHandled(r: RecurringRow, dueDate: string): boolean {
  return (!!r.lastPaidDate && r.lastPaidDate >= dueDate) || (!!r.lastSkippedDate && r.lastSkippedDate >= dueDate);
}

const addDaysStr = (dateStr: string, n: number) => {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return isoDate(dt);
};

// Mirrors src/billReminders.js "not yet handled" test for upcoming bills.
function isNotHandled(r: RecurringRow, dueStr: string): boolean {
  if (r.frequency === "monthly" || r.frequency === "yearly") return !isCycleHandled(r, dueStr);
  if (!r.lastPaidDate && !r.lastSkippedDate) return true;
  return getRecurringAnchorDate(r) !== dueStr;
}

const inr = (n: number) => "₹" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });

export interface BillDigest {
  title: string;
  message: string;
  priority: "default" | "high";
  count: number;
}

// Build a single push digest from a user's recurring bills + owed splits.
// Returns null when there is nothing to remind about. `todayStr` is the user's
// local date (YYYY-MM-DD). Mirrors src/billReminders.js so the server push and
// the in-app toast agree on what's "due".
export function buildBillDigest(
  recurring: RecurringRow[],
  splits: SplitRow[],
  todayStr: string,
  settlements: SettlementRow[] = [],
): BillDigest | null {
  const in3Str = addDaysStr(todayStr, 3);
  const dueToday: string[] = [];
  const upcoming: string[] = [];

  (recurring || []).filter(r => r.active).forEach(r => {
    if (isRecurringDueToday(r, todayStr)) {
      const due = getRecurringDueDate(r, todayStr);
      const overdue = due && due < todayStr
        ? Math.floor((dateOnly(todayStr).getTime() - dateOnly(due).getTime()) / 86400000)
        : 0;
      // A recurring INCOME is money arriving — it is never "overdue", and a
      // digest that says so reads as a chore the user has failed at.
      const inc = r.type === "income";
      dueToday.push(`• ${r.name} — ${inr(r.amount)}${overdue > 0 ? (inc ? ` (${overdue} day${overdue !== 1 ? "s" : ""} late)` : ` (${overdue} day${overdue !== 1 ? "s" : ""} overdue)`) : (inc ? " expected today" : " due today")}`);
      return;
    }
    const up = getRecurringDueDate(r, in3Str);
    if (up && up > todayStr && up <= in3Str && isNotHandled(r, up)) {
      const days = Math.round((dateOnly(up).getTime() - dateOnly(todayStr).getTime()) / 86400000);
      upcoming.push(`• ${r.name} — ${inr(r.amount)} in ${days} day${days !== 1 ? "s" : ""}`);
    }
  });

  // Aggregate per person on the REMAINING balance — mirrors
  // src/billReminders.js. Reminding per split repeated the full original amount
  // of a partially-paid IOU and stacked one line per row for the same person.
  const paidAgainst = (splitId: string) => (settlements || []).reduce((t, x) => {
    if (!x || x.splitId !== splitId) return t;
    return t + ((Number(x.amount) || 0) - (Number(x.excess) || 0));
  }, 0);
  const byPerson = new Map<string, { name: string; total: number; count: number }>();
  (splits || []).forEach(s => {
    if (!s || s.direction !== "owe" || s.settled || s.skipped) return;
    const rem = Math.round(((Number(s.amount) || 0) - paidAgainst(s.id)) * 100) / 100;
    if (rem <= 0.005) return;
    const name = String(s.name || "").trim();
    if (!name) return;
    const k = name.toLowerCase();
    const cur = byPerson.get(k) || { name, total: 0, count: 0 };
    cur.total = Math.round((cur.total + rem) * 100) / 100;
    cur.count += 1;
    byPerson.set(k, cur);
  });
  const owed = [...byPerson.values()]
    .sort((a, b) => b.total - a.total)
    .map(p => `• You owe ${inr(p.total)} — ${p.name}${p.count > 1 ? ` (${p.count} IOUs)` : ""}`);

  const count = dueToday.length + upcoming.length + owed.length;
  if (count === 0) return null;

  const sections: string[] = [];
  if (dueToday.length) sections.push("Due now:\n" + dueToday.join("\n"));
  if (upcoming.length) sections.push("Coming up:\n" + upcoming.join("\n"));
  if (owed.length) sections.push("You owe:\n" + owed.join("\n"));

  return {
    title: dueToday.length ? `${dueToday.length} bill${dueToday.length !== 1 ? "s" : ""} due` : "Upcoming bills",
    message: sections.join("\n\n"),
    priority: dueToday.length || owed.length ? "high" : "default",
    count,
  };
}

// POST a notification to an ntfy topic from the server. Title header must be
// ASCII (non-ASCII lives in the UTF-8 body only). Never throws — returns a
// small result object the caller can log.
export async function publishNtfyServer(
  server: string,
  topic: string,
  opts: { title?: string; message?: string; priority?: string; tags?: string[] },
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const base = (server || "https://ntfy.sh").trim().replace(/\/+$/, "");
  const t = (topic || "").trim();
  if (!t) return { ok: false, error: "no topic" };
  const safeTitle = String(opts.title || "NOMAD").replace(/[\r\n]+/g, " ").replace(/[^\x20-\x7E]/g, "").trim() || "NOMAD";
  try {
    const res = await fetchImpl(`${base}/${encodeURIComponent(t)}`, {
      method: "POST",
      headers: {
        Title: safeTitle,
        Priority: opts.priority || "default",
        Tags: (opts.tags || ["moneybag"]).join(","),
      },
      body: String(opts.message || ""),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || "network error" };
  }
}

// The user's local (IST) date as YYYY-MM-DD. NOMAD is India-first and stores
// recurring due dates in local time, so the cron evaluates "today" in IST.
export function istTodayStr(now: Date): string {
  const ist = new Date(now.getTime() + (5 * 60 + 30) * 60_000);
  return isoDate(new Date(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}
