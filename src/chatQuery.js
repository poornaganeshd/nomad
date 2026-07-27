// Deterministic query engine for "Ask NOMAD".
//
// The chat used to hand the model a few hundred raw rows and ask it to filter
// and sum them itself. It does not do that reliably: asked "how much did I
// spend on eggs", it answered with the whole Food & Drinks category (rice,
// carrots, parota…) and a total that matched none of the rows it listed.
//
// So the model no longer does arithmetic. It only translates the question into
// a QUERY SPEC — which rows, over what window — and this module runs that spec
// over the COMPLETE local ledger. Every number the user sees (total, count,
// average, the row list) is computed here, from real data, and handed to the
// model as fixed facts to phrase. The model can be wrong about intent; it can
// no longer be wrong about money.
//
// Pure functions only — no I/O, no React, no side effects.

import { roundMoney } from "./financeUtils";

/** Row shape this module works on. Built by `buildQueryRows`. */
// { id, kind: "expense"|"income", date, amount, category, wallet, source, note }

export function buildQueryRows({ expenses = [], incomes = [], categoryName = () => "", walletName = () => "", sourceName = () => "" }) {
  const rows = [];
  expenses.forEach(e => {
    if (!e || !e.date) return;
    rows.push({
      id: e.id, kind: "expense", date: e.date,
      amount: Number(e.amount) || 0,
      category: categoryName(e.categoryId) || "",
      wallet: walletName(e.walletId) || "",
      source: "",
      note: String(e.note || ""),
    });
  });
  incomes.forEach(i => {
    if (!i || !i.date) return;
    rows.push({
      id: i.id, kind: "income", date: i.date,
      amount: Number(i.amount) || 0,
      category: "",
      wallet: walletName(i.walletId) || "",
      source: sourceName(i.sourceId) || "",
      note: String(i.note || ""),
    });
  });
  return rows;
}

// ── date helpers (local YYYY-MM-DD string math, no Date-parsing surprises) ──

const pad = n => String(n).padStart(2, "0");
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const lastDayOf = (y, m) => new Date(y, m, 0).getDate();

function shiftDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return ymd(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}

/**
 * Turn a range spec into concrete inclusive `{ from, to }` bounds.
 * `today` anchors every relative preset, and is the CLIENT's local date — so
 * "last month" means last month where the user is, not on the server.
 */
export function resolveRange(range, today) {
  const [ty, tm] = today.split("-").map(Number);
  const r = range || {};
  const preset = String(r.preset || "all");

  switch (preset) {
    case "today":       return { from: today, to: today, label: "today" };
    case "yesterday": { const y = shiftDays(today, -1); return { from: y, to: y, label: "yesterday" }; }
    case "this_week":   return { from: shiftDays(today, -6), to: today, label: "the last 7 days" };
    case "this_month":  return { from: ymd(ty, tm, 1), to: today, label: "this month" };
    case "last_month": {
      const y = tm === 1 ? ty - 1 : ty, m = tm === 1 ? 12 : tm - 1;
      return { from: ymd(y, m, 1), to: ymd(y, m, lastDayOf(y, m)), label: "last month" };
    }
    case "this_year":   return { from: ymd(ty, 1, 1), to: today, label: "this year" };
    case "last_year":   return { from: ymd(ty - 1, 1, 1), to: ymd(ty - 1, 12, 31), label: "last year" };
    case "last_n_days": {
      const n = Math.max(1, Math.min(3650, Math.round(Number(r.days) || 30)));
      return { from: shiftDays(today, -(n - 1)), to: today, label: `the last ${n} days` };
    }
    case "month": {
      // An explicit YYYY-MM ("in June").
      const key = /^\d{4}-\d{2}$/.test(String(r.month)) ? String(r.month) : today.slice(0, 7);
      const [y, m] = key.split("-").map(Number);
      return { from: ymd(y, m, 1), to: ymd(y, m, lastDayOf(y, m)), label: key };
    }
    case "custom": {
      const from = /^\d{4}-\d{2}-\d{2}$/.test(String(r.from)) ? String(r.from) : null;
      const to   = /^\d{4}-\d{2}-\d{2}$/.test(String(r.to))   ? String(r.to)   : null;
      if (!from && !to) return { from: null, to: null, label: "all time" };
      return { from, to, label: from && to ? `${from} to ${to}` : from ? `since ${from}` : `up to ${to}` };
    }
    default:            return { from: null, to: null, label: "all time" };
  }
}

// ── matching ───────────────────────────────────────────────────────────────

const norm = s => String(s || "").toLowerCase();

// Very small singular/plural fold so "eggs" matches a note that says "egg"
// (and vice versa). Deliberately not a stemmer — over-stemming would make
// "carrots" match "carrot cake" style false positives worse, not better.
function variants(term) {
  const t = norm(term).trim();
  if (!t) return [];
  const out = new Set([t]);
  if (t.endsWith("ies") && t.length > 4) out.add(t.slice(0, -3) + "y");
  if (t.endsWith("es")  && t.length > 3) out.add(t.slice(0, -2));
  if (t.endsWith("s")   && t.length > 2) out.add(t.slice(0, -1));
  else { out.add(t + "s"); out.add(t + "es"); }
  return [...out];
}

/**
 * Does `text` contain `term` as a WORD (not as a substring of a longer word)?
 * Substring matching made "tea" match "steam"/"instead"; word matching keeps
 * "eggs" off "Veggies" while still finding "Eggs+tray" and "rice+eggs".
 */
function hasWord(text, term) {
  const hay = norm(text);
  if (!hay || !term) return false;
  let from = 0;
  for (;;) {
    const i = hay.indexOf(term, from);
    if (i === -1) return false;
    const before = i === 0 ? "" : hay[i - 1];
    const after = hay[i + term.length] || "";
    // A boundary is anything that isn't a LETTER — digits count as boundaries
    // so real notes like "Rice5kgs" and "4yippee" still match their word.
    const isBoundary = c => c === "" || !/[a-z]/.test(c);
    if (isBoundary(before) && isBoundary(after)) return true;
    from = i + 1;
  }
}

function matchesKeyword(row, term, fields) {
  return variants(term).some(v => fields.some(f => hasWord(row[f], v)));
}

const DEFAULT_KEYWORD_FIELDS = ["note", "category", "source"];

/**
 * Run a query spec over rows. Returns the matched rows plus every number the
 * answer needs, so nothing downstream has to re-derive (or mis-derive) them.
 */
export function runQuery(rows, spec = {}, today) {
  const s = spec || {};
  const range = resolveRange(s.range, today);
  const kind = ["expense", "income", "both"].includes(s.type) ? s.type : "expense";
  const keywords = (Array.isArray(s.keywords) ? s.keywords : []).map(k => String(k || "").trim()).filter(Boolean).slice(0, 8);
  const keywordMode = s.keywordMode === "all" ? "all" : "any";
  const fields = Array.isArray(s.keywordFields) && s.keywordFields.length
    ? s.keywordFields.filter(f => DEFAULT_KEYWORD_FIELDS.includes(f))
    : DEFAULT_KEYWORD_FIELDS;
  const cats = (Array.isArray(s.categories) ? s.categories : []).map(norm).filter(Boolean);
  const wals = (Array.isArray(s.wallets) ? s.wallets : []).map(norm).filter(Boolean);
  const srcs = (Array.isArray(s.sources) ? s.sources : []).map(norm).filter(Boolean);
  const minA = Number.isFinite(Number(s.minAmount)) && s.minAmount !== null && s.minAmount !== "" ? Number(s.minAmount) : null;
  const maxA = Number.isFinite(Number(s.maxAmount)) && s.maxAmount !== null && s.maxAmount !== "" ? Number(s.maxAmount) : null;

  const matched = rows.filter(r => {
    if (kind !== "both" && r.kind !== kind) return false;
    if (range.from && r.date < range.from) return false;
    if (range.to && r.date > range.to) return false;
    if (minA !== null && r.amount < minA) return false;
    if (maxA !== null && r.amount > maxA) return false;
    if (cats.length && !cats.includes(norm(r.category))) return false;
    if (wals.length && !wals.includes(norm(r.wallet))) return false;
    if (srcs.length && !srcs.includes(norm(r.source))) return false;
    if (keywords.length) {
      const hit = keywordMode === "all"
        ? keywords.every(k => matchesKeyword(r, k, fields))
        : keywords.some(k => matchesKeyword(r, k, fields));
      if (!hit) return false;
    }
    return true;
  });

  const sortKey = s.sort === "amount_desc" ? "amount_desc" : s.sort === "amount_asc" ? "amount_asc" : s.sort === "date_asc" ? "date_asc" : "date_desc";
  const sorted = matched.slice().sort((a, b) => {
    if (sortKey === "amount_desc") return b.amount - a.amount || String(b.date).localeCompare(String(a.date));
    if (sortKey === "amount_asc")  return a.amount - b.amount || String(a.date).localeCompare(String(b.date));
    if (sortKey === "date_asc")    return String(a.date).localeCompare(String(b.date)) || b.amount - a.amount;
    return String(b.date).localeCompare(String(a.date)) || b.amount - a.amount;
  });

  const total = roundMoney(sorted.reduce((t, r) => t + r.amount, 0));
  const expenseTotal = roundMoney(sorted.filter(r => r.kind === "expense").reduce((t, r) => t + r.amount, 0));
  const incomeTotal = roundMoney(sorted.filter(r => r.kind === "income").reduce((t, r) => t + r.amount, 0));

  return {
    range,
    type: kind,
    keywords,
    rows: sorted,
    count: sorted.length,
    total,
    expenseTotal,
    incomeTotal,
    average: sorted.length ? roundMoney(total / sorted.length) : 0,
    min: sorted.length ? roundMoney(Math.min(...sorted.map(r => r.amount))) : 0,
    max: sorted.length ? roundMoney(Math.max(...sorted.map(r => r.amount))) : 0,
    first: sorted.length ? sorted.reduce((a, r) => (r.date < a ? r.date : a), sorted[0].date) : null,
    last: sorted.length ? sorted.reduce((a, r) => (r.date > a ? r.date : a), sorted[0].date) : null,
    groups: groupRows(sorted, s.groupBy),
  };
}

/** Sum by category / wallet / source / month / day. `none` → null. */
export function groupRows(rows, groupBy) {
  const by = ["category", "wallet", "source", "month", "day"].includes(groupBy) ? groupBy : null;
  if (!by) return null;
  const keyOf = r =>
    by === "month" ? String(r.date).slice(0, 7) :
    by === "day"   ? String(r.date) :
    (r[by] || "—");
  const map = new Map();
  rows.forEach(r => {
    const k = keyOf(r);
    const cur = map.get(k) || { key: k, total: 0, count: 0 };
    cur.total = roundMoney(cur.total + r.amount);
    cur.count += 1;
    map.set(k, cur);
  });
  return [...map.values()].sort((a, b) => b.total - a.total);
}

/**
 * Render the result as compact facts for the model to phrase. This — not the
 * raw ledger — is what the answer is grounded in, so every figure in the reply
 * traces back to a real row.
 */
export function formatQueryFacts(result, { maxRows = 40 } = {}) {
  const lines = [];
  const what = result.type === "income" ? "income entries" : result.type === "both" ? "transactions" : "expenses";
  const kw = result.keywords.length ? ` matching ${result.keywords.map(k => `"${k}"`).join(result.keywords.length > 1 ? " or " : "")}` : "";
  lines.push(`QUERY RESULT — ${result.count} ${what}${kw} over ${result.range.label}.`);
  if (result.count === 0) {
    lines.push("No rows matched. Say so plainly; do not invent transactions.");
    return lines.join("\n");
  }
  lines.push(`TOTAL: ₹${result.total}`);
  if (result.type === "both") lines.push(`  expenses ₹${result.expenseTotal}, income ₹${result.incomeTotal}`);
  lines.push(`AVERAGE: ₹${result.average}   SMALLEST: ₹${result.min}   LARGEST: ₹${result.max}`);
  lines.push(`SPAN: ${result.first} → ${result.last}`);
  if (result.groups?.length) {
    lines.push(`BREAKDOWN:\n${result.groups.slice(0, 15).map(g => `  ${g.key}: ₹${g.total} (${g.count})`).join("\n")}`);
  }
  const shown = result.rows.slice(0, maxRows);
  // A "|" or newline inside a note would inject phantom columns/rows into the
  // pipe table the model reads back — strip them and collapse the gap.
  const cell = v => String(v ?? "").replace(/[|\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  lines.push(`MATCHED ROWS (date|amount|category|wallet|note)${shown.length < result.count ? ` — first ${shown.length} of ${result.count}` : ""}:
${shown.map(r => `${r.date}|${r.amount}|${cell(r.category || r.source) || "?"}|${cell(r.wallet) || "?"}|${cell(r.note)}`).join("\n")}`);
  if (shown.length < result.count) {
    const rest = roundMoney(result.total - roundMoney(shown.reduce((t, r) => t + r.amount, 0)));
    lines.push(`(${result.count - shown.length} more rows totalling ₹${rest} — mention them as a single "…and N more totalling ₹X" line.)`);
  }
  return lines.join("\n");
}

/**
 * Clamp an AI-produced spec to something safe to execute. Unknown category /
 * wallet / source names are DROPPED rather than kept: a hallucinated
 * "Groceries" filter against a ledger that has no such category would silently
 * return zero rows and read as "you never spent on that".
 */
export function sanitizeQuerySpec(spec, { categories = [], wallets = [], sources = [] } = {}) {
  const s = (spec && typeof spec === "object") ? spec : {};
  const known = (list, allowed) => {
    const set = new Set(allowed.map(norm));
    return (Array.isArray(list) ? list : []).map(x => String(x || "").trim()).filter(x => set.has(norm(x))).slice(0, 10);
  };
  const num = v => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const presets = ["all", "today", "yesterday", "this_week", "this_month", "last_month", "this_year", "last_year", "last_n_days", "month", "custom"];
  const rawRange = (s.range && typeof s.range === "object") ? s.range : {};
  return {
    type: ["expense", "income", "both"].includes(s.type) ? s.type : "expense",
    keywords: (Array.isArray(s.keywords) ? s.keywords : []).map(k => String(k || "").trim()).filter(k => k.length > 1).slice(0, 8),
    keywordMode: s.keywordMode === "all" ? "all" : "any",
    categories: known(s.categories, categories),
    wallets: known(s.wallets, wallets),
    sources: known(s.sources, sources),
    minAmount: num(s.minAmount),
    maxAmount: num(s.maxAmount),
    range: {
      preset: presets.includes(String(rawRange.preset)) ? String(rawRange.preset) : "all",
      days: num(rawRange.days),
      month: /^\d{4}-\d{2}$/.test(String(rawRange.month)) ? String(rawRange.month) : null,
      from: /^\d{4}-\d{2}-\d{2}$/.test(String(rawRange.from)) ? String(rawRange.from) : null,
      to: /^\d{4}-\d{2}-\d{2}$/.test(String(rawRange.to)) ? String(rawRange.to) : null,
    },
    groupBy: ["category", "wallet", "source", "month", "day"].includes(s.groupBy) ? s.groupBy : "none",
    sort: ["date_desc", "date_asc", "amount_desc", "amount_asc"].includes(s.sort) ? s.sort : "date_desc",
  };
}

/**
 * Is this question a data lookup at all? "How much did I spend on eggs" is;
 * "should I get a credit card" is not, and forcing a spec onto it would answer
 * a question nobody asked. The model reports `needsData`; this is the guard for
 * a spec that would match the entire ledger with no filter of any kind.
 */
export function isEmptySpec(spec) {
  const s = spec || {};
  return !(s.keywords?.length || s.categories?.length || s.wallets?.length || s.sources?.length
    || s.minAmount !== null || s.maxAmount !== null
    || (s.range?.preset && s.range.preset !== "all")
    || (s.groupBy && s.groupBy !== "none"));
}
