// bankReconcile.js — deterministic bank-statement ↔ NOMAD reconciliation.
//
// Pure matching logic extracted from the UI so it can be unit-tested without
// the App.jsx monolith (see bankReconcile.test.js). The AI `reconcile` mode in
// api/ai-analyze.ts only ever sees the leftovers this module can't match.
//
// Flow: parseBankCsv rows + NOMAD state → buildLedger (one debit/credit view of
// everything that touched the statement's wallet) → reconcile (greedy nearest-
// date match on exact amount + direction within a ±day window). Statement rows
// with a ref/UTR already imported earlier are skipped up front so re-importing
// the same statement is idempotent.

import { roundMoney } from "./financeUtils";

export const DATE_WINDOW_DAYS = 2;
export const IMPORTED_REFS_KEY = "nomad-bank-refs-v1";

// Noon anchor dodges DST/timezone off-by-one (same trick as Routine date math).
const dayDiff = (a, b) => Math.abs((new Date(a + "T12:00:00") - new Date(b + "T12:00:00")) / 86400000);

// Flatten NOMAD txs into statement-comparable entries for one wallet.
// Every entry: { id, kind, date, amount, dir: "debit"|"credit", note }.
// Transfers/settlements matter — a UPI-Lite top-up is a statement debit but
// lives in NOMAD as a transfer, and must NOT be flagged "missing".
export function buildLedger({ expenses = [], incomes = [], transfers = [], settlements = [], walletId }) {
  const out = [];
  // Receipt line-items share a groupId — the bank saw ONE debit for their sum,
  // so merge them into one ledger entry. Expenses with a unique groupId (event
  // group-expenses) pass through unchanged: sum of one = itself.
  const byGroup = new Map();
  for (const e of expenses) {
    if (e.walletId !== walletId) continue;
    if (e.groupId) {
      const g = byGroup.get(e.groupId);
      if (g) { g.amount = roundMoney(g.amount + roundMoney(e.amount)); continue; }
      const entry = { id: e.id, kind: "expense", date: e.date, amount: roundMoney(e.amount), dir: "debit", note: e.note || "" };
      byGroup.set(e.groupId, entry);
      out.push(entry);
      continue;
    }
    out.push({ id: e.id, kind: "expense", date: e.date, amount: roundMoney(e.amount), dir: "debit", note: e.note || "" });
  }
  for (const i of incomes) if (i.walletId === walletId) out.push({ id: i.id, kind: "income", date: i.date, amount: roundMoney(i.amount), dir: "credit", note: i.note || "" });
  for (const t of transfers) {
    if (t.fromWallet === walletId) out.push({ id: t.id, kind: "transfer", date: t.date, amount: roundMoney(t.amount), dir: "debit", note: t.note || "" });
    if (t.toWallet === walletId) out.push({ id: t.id, kind: "transfer", date: t.date, amount: roundMoney(t.amount), dir: "credit", note: t.note || "" });
  }
  for (const s of settlements) if (s.walletId === walletId) out.push({ id: s.id, kind: "settlement", date: s.date, amount: roundMoney(s.amount), dir: s.direction === "owed" ? "credit" : "debit", note: s.note || s.splitName || "" });
  return out.filter(x => x.date && x.amount > 0);
}

// Match statement rows against ledger entries. Greedy: rows sorted by date,
// each takes its nearest-date unused candidate with identical amount and
// direction. One ledger entry can satisfy only one statement row, so two
// identical statement debits need two logged expenses.
// Returns { matched, missing, alreadyImported } — `missing` rows are the ones
// the user should review/import; `matched`/`alreadyImported` are informational.
export function reconcile(statementRows, ledger, { windowDays = DATE_WINDOW_DAYS, importedRefs } = {}) {
  const refs = importedRefs || new Set();
  const used = new Set();
  const matched = [], missing = [], alreadyImported = [];
  const rows = [...statementRows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const row of rows) {
    if (row.ref && refs.has(row.ref)) { alreadyImported.push(row); continue; }
    const dir = row.type === "income" ? "credit" : "debit";
    let best = -1, bestDist = Infinity;
    for (let i = 0; i < ledger.length; i++) {
      if (used.has(i)) continue;
      const l = ledger[i];
      if (l.dir !== dir || Math.abs(l.amount - row.amount) >= 0.005) continue;
      const dist = dayDiff(l.date, row.date);
      if (dist <= windowDays && dist < bestDist) { best = i; bestDist = dist; }
    }
    if (best >= 0) { used.add(best); matched.push({ row, entry: ledger[best] }); }
    else missing.push(row);
  }
  return { matched, missing, alreadyImported };
}

// Statement closing balance = the balance on the latest-dated row that has one.
// Null when the statement has no balance column.
export function statementClosingBalance(rows) {
  let best = null;
  for (const r of rows) if (r.balance != null && (!best || r.date >= best.date)) best = r;
  return best ? { date: best.date, balance: best.balance } : null;
}

// Imported-ref persistence (localStorage). Refs are scoped per wallet so two
// banks reusing the same cheque number can't shadow each other. Capped at the
// most recent 3000 refs — old statements age out harmlessly.
export function loadImportedRefs(walletId, storage = globalThis.localStorage) {
  try {
    const all = JSON.parse(storage.getItem(IMPORTED_REFS_KEY) || "[]");
    const prefix = walletId + ":";
    return new Set(all.filter(r => typeof r === "string" && r.startsWith(prefix)).map(r => r.slice(prefix.length)));
  } catch { return new Set(); }
}

export function saveImportedRefs(walletId, newRefs, storage = globalThis.localStorage) {
  let all = [];
  try { all = JSON.parse(storage.getItem(IMPORTED_REFS_KEY) || "[]").filter(r => typeof r === "string"); }
  catch { all = []; /* corrupt store — start fresh rather than lose new refs */ }
  try {
    const merged = [...new Set([...all, ...[...newRefs].map(r => walletId + ":" + r)])];
    storage.setItem(IMPORTED_REFS_KEY, JSON.stringify(merged.slice(-3000)));
  } catch { /* quota failure — dedup falls back to amount+date matching */ }
}
