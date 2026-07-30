// Free-text search over history rows.
//
// Split out of the App.jsx history memo so it can be tested. The old inline
// filter matched note / category / source / split / event names ONLY, so a
// perfectly reasonable query like "105" returned "0 results" while a ₹105
// expense sat on the calendar right above the search box. Amounts are the most
// obvious thing to search a ledger for and were the one thing it couldn't do.
//
// Rules, in one place so the UI can explain them honestly:
//   • The query is split on whitespace and EVERY token must match (AND), so
//     "curd 105" finds the ₹105 curd row and nothing else. Order doesn't matter.
//   • A token matches when any text field contains it, OR — for a numeric
//     token — when the row's amount matches it.
//   • A whole-rupee token matches to the NEAREST RUPEE: "105" finds ₹105,
//     ₹105.40 and ₹104.60. It deliberately does NOT find ₹1,050 — substring
//     matching on digits turns every search into noise. Use the Min/Max
//     filters for a range.
//   • A token with decimals is matched exactly ("105.5" → ₹105.50 only).
//
// Pure — no React, no storage, no side effects. Tested in
// src/__tests__/txSearch.test.js.

// Deliberately STRICTER than txParsers' parseAmount: that one is lenient
// because it reads amounts a human typed into an amount field, and will happily
// pull digits out of surrounding text. Here a lenient parse would make the token
// "rice5kgs" register as the amount 5 and match every ₹5 row, so a query token
// only counts as an amount when the whole token IS one.
const AMOUNT_TOKEN = /^\d+(\.\d+)?$/;

// "₹1,050.50" → 1050.5; anything that isn't purely an amount → null.
export function parseAmountToken(token) {
  const cleaned = String(token ?? "").trim().replace(/^₹/, "").replace(/,/g, "");
  if (!AMOUNT_TOKEN.test(cleaned)) return null;
  const v = Number(cleaned);
  return Number.isFinite(v) ? v : null;
}

// Does `amount` answer this numeric token? Whole-rupee tokens round; tokens with
// decimals must match to the paisa.
export function amountMatchesToken(amount, token) {
  const v = parseAmountToken(token);
  if (v === null) return false;
  if (!Number.isFinite(amount)) return false;
  const cleaned = String(token).trim().replace(/^₹/, "").replace(/,/g, "");
  if (cleaned.includes(".")) return Math.abs(amount - v) < 0.005;
  return Math.round(amount) === Math.round(v);
}

// Whitespace-separated tokens, lowercased. Empty query → no tokens (= match all).
export function tokenizeQuery(query) {
  return String(query ?? "").toLowerCase().trim().split(/\s+/).filter(Boolean);
}

// True when a numeric token could not possibly match any text either — used by
// the UI to explain a zero-result numeric search without guessing.
export const isAmountQuery = (query) => {
  const tokens = tokenizeQuery(query);
  return tokens.length > 0 && tokens.every((t) => parseAmountToken(t) !== null);
};

// `row` is { amount, text } where `text` is the row's searchable strings
// (note, category/source name, split name, event name, wallet names, type).
// Every token must hit something; a token can hit either the text or the amount.
export function matchesQuery(row, query) {
  const tokens = tokenizeQuery(query);
  if (!tokens.length) return true;
  const hay = (Array.isArray(row?.text) ? row.text : [])
    .filter(Boolean)
    .map((s) => String(s).toLowerCase());
  const amount = Number(row?.amount);
  return tokens.every(
    (t) => hay.some((h) => h.includes(t)) || amountMatchesToken(amount, t)
  );
}
