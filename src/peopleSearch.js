// Ranked typeahead over the people you've already logged IOUs / splits with.
//
// Two surfaces needed the same behaviour and had neither: the Add-form "Split
// with friends" picker (an unfiltered wall of every known name, whose input only
// ever *added* a new person — typing "a" filtered nothing) and the New-IOU name
// field (a plain `includes()` with no ranking, rendered inside a clipped
// horizontal strip so only ~3 of the matches were reachable). Typing "a" has to
// put "Arun" ahead of "Dharun": a prefix hit is what the user meant.
//
// Pure — no React, no storage, no side effects. Tested in
// src/__tests__/peopleSearch.test.js.

// Match qualities, ordered best → worst. Exported so call sites can style a
// weak (fuzzy) hit differently from a confident one.
export const MATCH_EXACT = 0;
export const MATCH_PREFIX = 1;
export const MATCH_WORD = 2;    // starts a later word: "kumar" → "Jaya Kumar"
export const MATCH_SUBSTR = 3;
export const MATCH_FUZZY = 4;   // in-order subsequence: "thknkrn" → "Thicknakaran"
export const MATCH_NONE = -1;

const fold = (s) => String(s ?? "").trim().toLowerCase();

// Case- and whitespace-insensitive name equality. Empty never equals anything,
// so a blank query can't "already exist".
export const sameName = (a, b) => {
  const x = fold(a);
  return !!x && x === fold(b);
};

// Characters that start a new word inside a name ("Sujatha pedhamma",
// "food-aunty", "jaya.kumar").
const WORD_BREAK = /[\s._\-/]/;

// In-order subsequence test — the last-resort tier, so a clipped or misspelt
// query ("thknkrn") still finds "Thicknakaran" instead of silently offering to
// create a duplicate person.
const isSubsequence = (q, s) => {
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j += 1) if (s[j] === q[i]) i += 1;
  return i === q.length;
};

// How well `name` answers `query`. An empty query matches everything at the
// lowest confident tier, so callers can reuse this to render "recent people".
export function matchScore(name, query) {
  const s = fold(name);
  const q = fold(query);
  if (!s) return MATCH_NONE;
  if (!q) return MATCH_SUBSTR;
  if (s === q) return MATCH_EXACT;
  if (s.startsWith(q)) return MATCH_PREFIX;
  const idx = s.indexOf(q);
  if (idx > 0) return WORD_BREAK.test(s[idx - 1]) ? MATCH_WORD : MATCH_SUBSTR;
  // Fuzzy only from 3 characters — below that almost every name subsequences a
  // 1–2 letter query and the list becomes noise.
  if (q.length >= 3 && isSubsequence(q, s)) return MATCH_FUZZY;
  return MATCH_NONE;
}

// Rank `people` for `query`, best first. STABLE within a tier: equal scores keep
// the caller's order, and both call sites pass most-recent-first, so an empty
// query lists the people you actually transact with rather than whoever happened
// to load first. `exclude` drops names already chosen.
export function rankPeople(query, people = [], { limit = 8, exclude = [] } = {}) {
  const ex = new Set((Array.isArray(exclude) ? exclude : []).map(fold));
  const hits = [];
  const seen = new Set();
  (Array.isArray(people) ? people : []).forEach((raw, i) => {
    const name = String(raw ?? "").trim();
    const key = fold(name);
    if (!name || ex.has(key) || seen.has(key)) return;
    const score = matchScore(name, query);
    if (score === MATCH_NONE) return;
    seen.add(key);
    hits.push({ name, score, i });
  });
  hits.sort((a, b) => a.score - b.score || a.i - b.i);
  const capped = limit > 0 ? hits.slice(0, limit) : hits;
  return capped.map(({ name, score }) => ({ name, score }));
}

// True when the query already names a known person (case-insensitively) — the
// signal for hiding a "create new" action, so a stray tap can't fork "rakesh"
// off the existing "Rakesh".
export const hasExactPerson = (query, people = []) =>
  (Array.isArray(people) ? people : []).some((p) => sameName(p, query));

// [before, match, after] so a suggestion can bold the part that matched.
// Returns [name, "", ""] when the hit isn't a contiguous substring (fuzzy tier)
// or the query is empty, letting callers render without a special case.
export function highlightParts(name, query) {
  const s = String(name ?? "");
  const q = fold(query);
  if (!q) return [s, "", ""];
  const i = fold(s).indexOf(q);
  if (i < 0) return [s, "", ""];
  // fold() trims, so shift the index back onto the untrimmed raw string.
  const lead = s.length - s.trimStart().length;
  const at = i + lead;
  return [s.slice(0, at), s.slice(at, at + q.length), s.slice(at + q.length)];
}

// Unique display names from split rows, MOST RECENT FIRST, soft-deleted rows
// excluded. Both were bugs in the old inline derivations: a deleted IOU kept
// suggesting its person forever, and plain insertion order meant the strip led
// with whoever loaded first rather than whoever you last split with.
// ISO `createdAt` and bare `date` keys both sort lexicographically, and mixing
// the two still orders correctly by day.
export function peopleFromSplits(splits = []) {
  const best = new Map();
  (Array.isArray(splits) ? splits : []).forEach((s) => {
    if (!s || s.deleted_at) return;
    const name = String(s.name ?? "").trim();
    if (!name) return;
    const key = name.toLowerCase();
    const ts = String(s.createdAt || s.created_at || s.date || "");
    const prev = best.get(key);
    // Keep the most recent row's spelling, so a rename is reflected immediately.
    if (!prev || ts > prev.ts) best.set(key, { name, ts });
  });
  return [...best.values()]
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
    .map((v) => v.name);
}
