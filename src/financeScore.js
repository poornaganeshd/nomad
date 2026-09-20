/**
 * financeScore.js — Monthly financial health score (0–100).
 *
 * Adapted from Ray Finance src/scoring/ for NOMAD's data model.
 * PURE FUNCTIONS — no localStorage, no fetch, no side effects.
 * Safe to use in useMemo with no dependency surprises.
 *
 * Score breakdown (100 pts total):
 *   Savings rate      0–35 pts  (income vs spending ratio)
 *   Bill consistency  0–25 pts  (recurring bills paid on time)
 *   Category spread   0–20 pts  (not over-concentrated in one category)
 *   Logging habit     0–20 pts  (days with at least one transaction)
 */

import { getRecurringDueDate, isRecurringDueToday, localDateKey } from "./financeUtils";

/**
 * Filter transactions to a given YYYY-MM month string.
 * @param {Array} txns
 * @param {string} month  e.g. "2026-05"
 * @returns {Array}
 */
function forMonth(txns, month) {
  return txns.filter(t => String(t.date || "").slice(0, 7) === month);
}

/**
 * Current month key in YYYY-MM format using local time.
 * @returns {string}
 */
function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Compute savings-rate sub-score (0–35).
 * Full 35 pts at ≥30% savings rate. Scales linearly below.
 *
 * @param {number} totalIncome
 * @param {number} totalExpense
 * @returns {number}
 */
function savingsScore(totalIncome, totalExpense) {
  if (totalIncome <= 0) return 15; // no income data — give neutral
  const saved = totalIncome - totalExpense;
  const rate  = saved / totalIncome;            // can be negative
  if (rate >= 0.30) return 35;
  if (rate <= -0.20) return 0;
  // Linear interpolation: rate -0.2 → 0 pts, rate 0.3 → 35 pts
  return Math.max(0, Math.round(((rate + 0.20) / 0.50) * 35));
}

/**
 * Compute bill-consistency sub-score (0–25).
 * Based on how many active recurring items were paid this month.
 *
 * @param {Array}  recurring  — full recurring list
 * @param {string} month      — YYYY-MM
 * @returns {number}
 */
function billScore(recurring, month, asOf) {
  // Only monthly bills are scored — yearly/quarterly/custom bills paid in
  // their due month would otherwise drag the score for every other month.
  const active = recurring.filter(r => r.active !== false && (r.frequency === "monthly" || r.frequency == null));
  if (active.length === 0) return 20; // no monthly bills → mild bonus

  // What counts is whether the bill has anything OUTSTANDING as of `asOf` —
  // not whether its lastPaidDate stamp happens to land in `month`.
  //
  // The stamp test got this wrong in both directions. A bill due on the 28th
  // was scored as unpaid for the first 27 days of every month, so the score
  // opened each month 25 points down and blamed the user for bills that were
  // not due yet. And paying an overdue bill late — September's rent on 2 Oct —
  // stamped it into October, so September never got the credit and October got
  // credit it had not earned.
  //
  // `isRecurringDueToday` answers the real question, and answers it the same
  // way the reminder card does, so the score and the card can no longer
  // disagree about whether a bill is outstanding.
  const onTrack = active.filter(r => {
    const sched = { ...r, active: true, frequency: "monthly" };
    // Legacy rows carry no startDate/dayOfMonth, so no due date can be derived.
    // Fall back to the old month-stamp test rather than scoring them blindly.
    if (!getRecurringDueDate(sched, asOf)) return String(r.lastPaidDate || "").slice(0, 7) === month;
    return !isRecurringDueToday(sched, asOf);
  }).length;
  return Math.round((onTrack / active.length) * 25);
}

// Last day of a YYYY-MM month, as YYYY-MM-DD.
function endOfMonth(month) {
  const [y, m] = String(month).split("-").map(Number);
  if (!y || !m) return `${month}-28`;
  return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
}

/**
 * Compute category-spread sub-score (0–20).
 * Penalises heavy concentration in a single category.
 * mcp (max-category-proportion) above 60% starts losing points.
 *
 * @param {Array} expenses
 * @returns {number}
 */
function spreadScore(expenses) {
  if (expenses.length === 0) return 10; // neutral
  const total = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  if (total === 0) return 10;
  const byCat  = {};
  expenses.forEach(e => { byCat[e.categoryId] = (byCat[e.categoryId] || 0) + (e.amount || 0); });
  const maxAmt = Math.max(...Object.values(byCat));
  const mcp    = maxAmt / total;
  if (mcp <= 0.40) return 20;
  if (mcp >= 1.00) return 0;
  // Linear: 0.40 → 20 pts, 1.00 → 0 pts
  return Math.max(0, Math.round((1 - mcp) / 0.60 * 20));
}

/**
 * Compute logging-habit sub-score (0–20).
 * Full 20 pts at ≥20 distinct days logged in the month.
 *
 * @param {Array}  expenses
 * @param {Array}  incomes
 * @param {string} month    — YYYY-MM
 * @returns {number}
 */
function loggingScore(expenses, incomes, month) {
  const days = new Set([
    ...expenses.map(e => String(e.date || "").slice(0, 10)),
    ...incomes.map(i => String(i.date  || "").slice(0, 10)),
  ].filter(d => d.slice(0, 7) === month));
  const TARGET = 20;
  return Math.min(20, Math.round((days.size / TARGET) * 20));
}

/**
 * Main entry point. Compute overall monthly financial health score.
 *
 * @param {{
 *   expenses:  Array,
 *   incomes:   Array,
 *   recurring: Array,
 *   month?:    string   YYYY-MM — defaults to current month
 *   today?:    string   YYYY-MM-DD — injectable clock, for bill-due evaluation
 * }} params
 * @returns {{
 *   score:     number   0–100
 *   breakdown: { savings: number, bills: number, spread: number, logging: number }
 * }}
 */
export function computeFinanceScore({ expenses = [], incomes = [], recurring = [], month, today = localDateKey() }) {
  const m  = month || currentMonth();
  // Bills are judged as of a point in time, not a whole month: today for the
  // live month, month-end for a month already over.
  const asOf = m < String(today).slice(0, 7) ? endOfMonth(m) : today;
  const mE = forMonth(expenses, m);
  const mI = forMonth(incomes,  m);

  const totalIncome  = mI.reduce((s, i) => s + (i.amount || 0), 0);
  const totalExpense = mE.reduce((s, e) => s + (e.amount || 0), 0);

  const savings = savingsScore(totalIncome, totalExpense);
  const bills   = billScore(recurring, m, asOf);
  const spread  = spreadScore(mE);
  const logging = loggingScore(expenses, incomes, m);

  const score = Math.max(0, Math.min(100, savings + bills + spread + logging));

  return { score, breakdown: { savings, bills, spread, logging } };
}

/**
 * Human-readable label + accent colour for a given score.
 *
 * @param {number} score
 * @returns {{ label: string, color: string, emoji: string }}
 */
export function scoreLabel(score) {
  if (score >= 80) return { label: "Excellent", color: "#6BAA75", emoji: "🟢" };
  if (score >= 60) return { label: "Good",      color: "#7B8CDE", emoji: "🔵" };
  if (score >= 40) return { label: "Fair",      color: "#FBBF24", emoji: "🟡" };
  if (score >= 20) return { label: "Needs work",color: "#E07A5F", emoji: "🟠" };
  return              { label: "Critical",      color: "#D4726A", emoji: "🔴" };
}
