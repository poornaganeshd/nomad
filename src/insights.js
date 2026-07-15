// Daily insight — the one proactive line the dashboard says to the user each
// day. Pure local math over data the app already has (no AI call, works in
// local-only mode). Returns { text, tone } or null when there isn't enough
// history to say anything worth reading.
//
// Rules run in priority order — money-at-risk first, then pace, then a quiet
// summary. tone: "warn" (needs attention) | "good" (positive) | "info".
import { roundMoney, localDateKey, getRecurringDueDate, isRecurringDueToday, recurringDaysOverdue } from "./financeUtils.js";
import { isNotHandled } from "./billReminders.js";

const fmtINR = (n) => "₹" + Math.round(Math.abs(Number(n) || 0)).toLocaleString("en-IN");
const dayKeyOffset = (baseNoon, days) => localDateKey(new Date(baseNoon.getFullYear(), baseNoon.getMonth(), baseNoon.getDate() + days, 12));

export function buildDailyInsight({ expenses = [], recurring = [], walletBalances = {}, wallets = [], now = new Date() } = {}) {
  const noon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  const today = localDateKey(noon);
  const live = expenses.filter((e) => e && !e.deleted_at && e.date && Number(e.amount) > 0);
  const sumRange = (fromKey, toKey) => roundMoney(live.filter((e) => e.date >= fromKey && e.date <= toKey).reduce((t, e) => t + Number(e.amount), 0));
  const walletName = (id) => wallets.find((w) => w.id === id)?.name || "your wallet";
  const activeRec = recurring.filter((r) => r && r.active !== false && !r.deleted_at && Number(r.amount) > 0);

  // isRecurringDueToday = "due date arrived AND not paid/skipped this cycle",
  // so it is the single gate for both overdue and due-today.
  const pending = activeRec.filter((r) => isRecurringDueToday(r, today));

  // 1. Overdue bills — money already late beats everything else.
  const overdue = pending.filter((r) => recurringDaysOverdue(r, today) > 0);
  if (overdue.length) {
    const tot = roundMoney(overdue.reduce((t, r) => t + Number(r.amount), 0));
    const worst = overdue.reduce((a, b) => (recurringDaysOverdue(a, today) >= recurringDaysOverdue(b, today) ? a : b));
    return { tone: "warn", text: overdue.length === 1 ? `${worst.name} is ${recurringDaysOverdue(worst, today)} day${recurringDaysOverdue(worst, today) === 1 ? "" : "s"} overdue — ${fmtINR(worst.amount)} pending.` : `${overdue.length} bills overdue — ${fmtINR(tot)} pending. Oldest: ${worst.name}.` };
  }

  // 2. Due today, with wallet coverage.
  const dueToday = pending.filter((r) => recurringDaysOverdue(r, today) === 0);
  if (dueToday.length) {
    const b = dueToday[0];
    const bal = Number(walletBalances[b.walletId] || 0);
    const covered = bal >= Number(b.amount);
    return { tone: covered ? "info" : "warn", text: `${b.name} (${fmtINR(b.amount)}) due today — ${covered ? `${walletName(b.walletId)} covers it.` : `${walletName(b.walletId)} is short by ${fmtINR(Number(b.amount) - bal)}.`}` };
  }

  // 3. Nearest bill inside a week, with coverage. Query the due date AT the
  // horizon (billReminders does the same) — relative to today, a bill paid
  // this cycle reports last cycle's date and would never look upcoming.
  const week = dayKeyOffset(noon, 7);
  const upcoming = activeRec
    .map((r) => ({ r, due: getRecurringDueDate(r, week) }))
    .filter((x) => x.due && x.due > today && x.due <= week && isNotHandled(x.r, x.due))
    .sort((a, b) => a.due.localeCompare(b.due));
  if (upcoming.length) {
    const { r, due } = upcoming[0];
    const days = Math.round((new Date(due + "T12:00:00") - noon) / 86400000);
    const bal = Number(walletBalances[r.walletId] || 0);
    const covered = bal >= Number(r.amount);
    return { tone: covered ? "info" : "warn", text: `${r.name} (${fmtINR(r.amount)}) due in ${days} day${days === 1 ? "" : "s"} — ${covered ? `${walletName(r.walletId)} covers it.` : `${walletName(r.walletId)} is short by ${fmtINR(Number(r.amount) - bal)}.`}` };
  }

  // 4. Week pace vs your own recent normal (last 7 days vs the mean of the
  // three 7-day windows before that). Needs a real baseline to be worth saying.
  const thisWeek = sumRange(dayKeyOffset(noon, -6), today);
  const priorWeeks = [1, 2, 3].map((i) => sumRange(dayKeyOffset(noon, -6 - 7 * i), dayKeyOffset(noon, -7 * i)));
  const baseline = roundMoney(priorWeeks.reduce((a, b) => a + b, 0) / 3);
  if (baseline >= 200) {
    const delta = (thisWeek - baseline) / baseline;
    if (delta >= 0.2) return { tone: "warn", text: `This week ${fmtINR(thisWeek)} — ${Math.round(delta * 100)}% over your usual pace (${fmtINR(baseline)}/wk).` };
    if (delta <= -0.2) return { tone: "good", text: `This week ${fmtINR(thisWeek)} — ${Math.round(-delta * 100)}% under your usual pace (${fmtINR(baseline)}/wk). Nice.` };
  }

  // 5. Quiet fallback: month so far. Skip entirely when there's no data yet —
  // a "₹0 spent" line on day one reads as broken, not calm.
  const monthStart = today.slice(0, 8) + "01";
  const monthSpend = sumRange(monthStart, today);
  if (monthSpend > 0) return { tone: "info", text: `${fmtINR(monthSpend)} spent this month · ${fmtINR(thisWeek)} in the last 7 days.` };
  return null;
}
