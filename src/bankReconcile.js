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

// Match statement rows against ledger entries on identical amount + direction
// within a +/- day window. One ledger entry can satisfy only one statement row,
// so two identical statement debits need two logged expenses.
//
// Assignment is a maximum bipartite matching (Kuhn's augmenting path), NOT a
// per-row greedy. A greedy that walked rows in date order and let each take its
// nearest free entry named the WRONG row as missing whenever an earlier row
// reached forward and took an entry a later row matched exactly: two 500 debits
// on the 10th and the 12th with only the 12th logged reported the 12th missing,
// and re-importing it duplicated an expense that was already there. Every
// falsely-missing row is money the user is invited to enter twice, so the
// matching has to be right rather than merely quick.
//
// Rows claim in order of their tightest date evidence, and the augmenting path
// then lets a row hand its entry over when it has an alternative — so an exact
// date match never loses to a two-day-old one, and preferring it never costs a
// match elsewhere.
//
// Returns { matched, missing, alreadyImported } — `missing` rows are the ones
// the user should review/import; `matched`/`alreadyImported` are informational.
// `matched` and `missing` stay in statement-date order.
export function reconcile(statementRows, ledger, { windowDays = DATE_WINDOW_DAYS, importedRefs } = {}) {
  const refs = importedRefs || new Set();
  const matched = [], missing = [], alreadyImported = [];
  const rows = [...statementRows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const pending = [];
  for (const row of rows) {
    if (row.ref && refs.has(row.ref)) { alreadyImported.push(row); continue; }
    const dir = row.type === "income" ? "credit" : "debit";
    const cands = [];
    for (let i = 0; i < ledger.length; i++) {
      const l = ledger[i];
      if (l.dir !== dir || Math.abs(l.amount - row.amount) >= 0.005) continue;
      const dist = dayDiff(l.date, row.date);
      if (dist <= windowDays) cands.push({ i, dist });
    }
    // Nearest first, ledger order as the tie-break, so the result is stable.
    cands.sort((a, b) => a.dist - b.dist || a.i - b.i);
    pending.push({ row, cands: cands.map(c => c.i), best: cands.length ? cands[0].dist : Infinity });
  }

  const entryToRow = new Map();
  const assign = (k, seen) => {
    for (const i of pending[k].cands) {
      if (seen.has(i)) continue;
      seen.add(i);
      const holder = entryToRow.get(i);
      if (holder === undefined || assign(holder, seen)) { entryToRow.set(i, k); return true; }
    }
    return false;
  };
  pending
    .map((p, k) => k)
    .sort((a, b) => pending[a].best - pending[b].best || a - b)
    .forEach(k => assign(k, new Set()));

  const rowToEntry = new Map();
  entryToRow.forEach((k, i) => rowToEntry.set(k, i));
  pending.forEach((p, k) => {
    if (rowToEntry.has(k)) matched.push({ row: p.row, entry: ledger[rowToEntry.get(k)] });
    else missing.push(p.row);
  });
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
