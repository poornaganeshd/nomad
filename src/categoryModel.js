// Learned category prediction — the single source for "what category is this?".
//
// WHY THIS EXISTS. The old autocategorize loop only ever learned from ONE event:
// tapping ✓ on the AI suggestion chip. If you typed "Zomato", ignored the AI and
// picked Food yourself, nothing was recorded — the highest-quality signal in the
// app was thrown away. Rules were also write-once (`if (prev.find(r => r.keyword
// === rule.keyword)) return prev`), so a single bad AI acceptance was stuck for
// good, and the stored `hitCount`/`confidence` fields were never read at all.
//
// This is NOT reinforcement learning, despite the shape of the ask. Every logged
// transaction hands over a labelled example immediately — (note, wallet, amount)
// → category — which is ordinary supervised learning. RL would bring exploration:
// deliberately proposing categories it believes are wrong in order to learn from
// the outcome. In a finance app that is a bug, not a feature.
//
// So: a small weighted-frequency model (naive-Bayes-ish) over note tokens, with
// wallet and amount-bucket as weak fallback features. It runs locally, instantly,
// offline and for free — the AI stays as the cold-start path for merchants this
// model has never seen, and whatever you accept from it is learned here too.
//
// Pure module. No side effects, no storage, no clock reads except the date key
// callers pass in. Every function returns a NEW model; nothing is mutated.

import { roundMoney, localDateKey } from "./financeUtils";

export const CAT_MODEL_VERSION = 1;

// Tokens shorter than this are noise ("of", "rs", "x2"). Matches the threshold
// the old extractKeyword used, so migrated rules tokenize the same way.
const TOKEN_MIN = 3;

// Weights decay per elapsed DAY, applied once when the date rolls over rather
// than per write. 0.995/day is a ~138-day half-life: long enough that a merchant
// you use monthly stays learned, short enough that last year's habits fade.
// (suggestAddDefaults uses 0.97 — far more aggressive — because it is answering
// "what did you buy lately", not "what does this word mean".)
const DAILY_DECAY = 0.995;
const MAX_DECAY_DAYS = 400;

// A correction is worth more than an ordinary save: it is you actively
// disagreeing. The wrong category is HALVED rather than decremented so the
// response is scale-invariant — a token sitting at weight 20 should not need
// eight corrections to move, which is exactly the sluggishness this replaces.
// On top of that the corrected category is lifted just past the demoted one, so
// an explicit correction ALWAYS takes effect on the very next prediction. Any
// weaker rule breaks the promise the feature is built on: you told it the
// answer and it carried on suggesting the other thing. It stays recoverable —
// ordinary saves of the demoted category climb back normally.
const CORRECTION_BOOST = 2;
const CORRECTION_PENALTY = 0.5;

// An explicit Settings rule is strong evidence, but not unassailable evidence.
const RULE_SEED_WEIGHT = 5;

// Keeps the model small enough to ride along in the user_prefs JSONB blob.
export const MAX_TOKENS = 400;

// Context features (wallet, amount bucket) only ever break ties or answer when
// the note is unknown — they must never outvote a real token match.
const CONTEXT_CONFIDENCE_SCALE = 0.6;

// Below this, we do not touch the user's category — we ask the AI (or stay put).
export const CONFIDENT_ENOUGH = 0.55;

const STOPWORDS = new Set([
  "paid", "for", "at", "the", "to", "from", "in", "on", "and", "or", "by", "with",
  "via", "of", "per", "my", "recharge", "payment", "pay", "bill", "rs", "inr",
  "amount", "today", "yesterday", "new", "old", "some", "this", "that", "was",
]);

export const emptyModel = () => ({ v: CAT_MODEL_VERSION, tokens: {}, wallets: {}, buckets: {}, updatedAt: null });

/**
 * Note → learnable tokens.
 *
 * Splits on anything that is not a letter, so digits act as boundaries the same
 * way chatQuery treats them ("Rice5kg" → rice, kg) and pure numbers drop out on
 * their own. Unicode-aware, because a note written in Devanagari or Tamil is
 * exactly as good a signal as a Latin one — splitting on [a-z] would have
 * silently thrown those users' notes away.
 *
 * \p{M} (combining marks) is load-bearing, not decoration: on \p{L} alone
 * "दूध" splits into "द" and "ध" — every vowel sign is a mark, not a letter, so
 * Indic words shatter into single consonants and the model learns nothing but
 * noise from them.
 *
 * De-duplicated: writing "coffee coffee" must not count double.
 */
export const tokenize = (note) => {
  const s = String(note ?? "").toLowerCase().trim();
  if (!s) return [];
  const out = [];
  const seen = new Set();
  for (const raw of s.split(/[^\p{L}\p{M}]+/u)) {
    if (raw.length < TOKEN_MIN || STOPWORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
};

/**
 * Coarse log-scale amount bucket. ₹15,000 and ₹40 mean very different things
 * even with an empty note; ₹410 vs ₹430 mean the same thing. Buckets rather than
 * raw amounts is what keeps this a useful feature instead of overfitting noise.
 */
export const amountBucket = (amount) => {
  const a = Math.abs(Number(amount) || 0);
  if (!(a > 0)) return null;
  if (a < 50) return "a";
  if (a < 200) return "b";
  if (a < 500) return "c";
  if (a < 1500) return "d";
  if (a < 5000) return "e";
  if (a < 20000) return "f";
  return "g";
};

const daysBetween = (fromKey, toKey) => {
  if (!fromKey || !toKey) return 0;
  const [fy, fm, fd] = String(fromKey).split("-").map(Number);
  const [ty, tm, td] = String(toKey).split("-").map(Number);
  if (!fy || !fm || !fd || !ty || !tm || !td) return 0;
  // Noon anchor, like the rest of the app's date maths, to dodge DST off-by-one.
  const diff = (new Date(ty, tm - 1, td, 12) - new Date(fy, fm - 1, fd, 12)) / 86400000;
  return Number.isFinite(diff) ? Math.round(diff) : 0;
};

const scaleTable = (table, factor) => {
  const out = {};
  for (const [key, row] of Object.entries(table || {})) {
    const next = {};
    for (const [cat, w] of Object.entries(row || {})) {
      const v = roundMoney(w * factor);
      // Drop dust rather than carry thousands of ~0 entries forever.
      if (v > 0.01) next[cat] = v;
    }
    if (Object.keys(next).length) out[key] = next;
  }
  return out;
};

/**
 * Age the whole model to `todayKey`. A no-op within the same day, so logging ten
 * transactions in a row costs one pass, not ten.
 */
export const decayModel = (model, todayKey = localDateKey()) => {
  const m = model && model.v === CAT_MODEL_VERSION ? model : emptyModel();
  if (!m.updatedAt || m.updatedAt === todayKey) return { ...m, updatedAt: todayKey };
  const days = Math.min(MAX_DECAY_DAYS, Math.max(0, daysBetween(m.updatedAt, todayKey)));
  if (days <= 0) return { ...m, updatedAt: todayKey };
  const f = Math.pow(DAILY_DECAY, days);
  return {
    v: CAT_MODEL_VERSION,
    tokens: scaleTable(m.tokens, f),
    wallets: scaleTable(m.wallets, f),
    buckets: scaleTable(m.buckets, f),
    updatedAt: todayKey,
  };
};

const totalWeight = (row) => Object.values(row || {}).reduce((t, w) => t + w, 0);

/**
 * Cap the token table so the synced prefs blob cannot grow without bound. Drops
 * the lowest-total-weight tokens, i.e. the ones seen least and longest ago.
 */
export const pruneModel = (model, cap = MAX_TOKENS) => {
  const m = model || emptyModel();
  const keys = Object.keys(m.tokens || {});
  if (keys.length <= cap) return m;
  const keep = keys
    .map((k) => [k, totalWeight(m.tokens[k])])
    .sort((a, b) => b[1] - a[1])
    .slice(0, cap)
    .map(([k]) => k);
  const tokens = {};
  for (const k of keep) tokens[k] = m.tokens[k];
  return { ...m, tokens };
};

const bump = (table, key, categoryId, weight) => {
  if (!key || !categoryId || !(weight > 0)) return;
  if (!table[key]) table[key] = {};
  table[key][categoryId] = roundMoney((table[key][categoryId] || 0) + weight);
};

/**
 * Record one labelled example.
 *
 * `wrongCategoryId` is the correction path: pass the category that was on screen
 * when the user picked a different one, and its weight for these tokens is
 * halved as the right one is boosted. That single signal is the whole difference
 * between a model that adapts and the old rule table that could not be corrected
 * at all.
 */
export const learn = (model, { note, categoryId, walletId, amount, weight = 1, wrongCategoryId = null } = {}, { todayKey = localDateKey() } = {}) => {
  if (!categoryId) return model || emptyModel();
  const base = decayModel(model, todayKey);
  const correcting = !!wrongCategoryId && wrongCategoryId !== categoryId;
  const w = weight * (correcting ? CORRECTION_BOOST : 1);
  const tokens = { ...base.tokens };
  const wallets = { ...base.wallets };
  const buckets = { ...base.buckets };
  const toks = tokenize(note);
  for (const t of toks) {
    tokens[t] = { ...(tokens[t] || {}) };
    bump(tokens, t, categoryId, w);
    if (correcting && tokens[t][wrongCategoryId]) {
      const cut = roundMoney(tokens[t][wrongCategoryId] * CORRECTION_PENALTY);
      if (cut > 0.01) tokens[t][wrongCategoryId] = cut; else delete tokens[t][wrongCategoryId];
      // Decisively dominant, not merely ahead. Nudging it one point past the
      // demoted category flips the argmax but leaves the two nearly tied — and a
      // near-tie scores below CONFIDENT_ENOUGH, so predict() knows the answer and
      // still refuses to act on it. That is the exact failure this feature is
      // meant to end: you corrected it, and it kept not filling anything in.
      const demoted = tokens[t][wrongCategoryId] || 0;
      const decisive = roundMoney(demoted * 2 + CORRECTION_BOOST);
      if (tokens[t][categoryId] < decisive) tokens[t][categoryId] = decisive;
    }
  }
  // "__tracked__" is a group expense someone else paid — the wallet is a
  // placeholder, not a choice, so it is not evidence about anything.
  if (walletId && walletId !== "__tracked__") {
    wallets[walletId] = { ...(wallets[walletId] || {}) };
    bump(wallets, walletId, categoryId, w);
  }
  const b = amountBucket(amount);
  if (b) {
    buckets[b] = { ...(buckets[b] || {}) };
    bump(buckets, b, categoryId, w);
  }
  return pruneModel({ v: CAT_MODEL_VERSION, tokens, wallets, buckets, updatedAt: todayKey });
};

// Evidence mass → confidence damping. One sighting of a token is not the same as
// twenty, even though both give a 100% share. 1 → 0.5, 3 → 0.75, 7 → 0.875.
const massFactor = (top) => 1 - 1 / (1 + Math.max(0, top));

const argmax = (scores, allowed) => {
  let best = null, bestW = 0, total = 0;
  for (const [cat, w] of Object.entries(scores)) {
    if (allowed && !allowed.has(cat)) continue;
    total += w;
    if (w > bestW) { best = cat; bestW = w; }
  }
  return { best, bestW, total };
};

/**
 * Predict a category. Returns `{ categoryId, confidence, source, why }`, or a
 * null categoryId when the model has nothing useful to say — callers then fall
 * back to the AI (cold start) or to suggestAddDefaults' recency prior.
 *
 * Note tokens decide it whenever ANY of them are known. Wallet and amount only
 * answer when the note is unknown or empty: a strong "zomato → Food" must never
 * be outvoted by "you usually pay Bank" — that inversion is how a context-aware
 * model starts feeling arbitrary.
 */
export const predict = (model, { note, walletId, amount } = {}, { validCategoryIds } = {}) => {
  const m = model && model.v === CAT_MODEL_VERSION ? model : emptyModel();
  const allowed = validCategoryIds instanceof Set ? validCategoryIds : (Array.isArray(validCategoryIds) ? new Set(validCategoryIds) : null);
  const empty = { categoryId: null, confidence: 0, source: null, why: [] };

  const scores = {};
  const hits = [];
  for (const t of tokenize(note)) {
    const row = m.tokens[t];
    if (!row) continue;
    let tokenBest = null, tokenBestW = 0;
    for (const [cat, w] of Object.entries(row)) {
      if (allowed && !allowed.has(cat)) continue;
      scores[cat] = roundMoney((scores[cat] || 0) + w);
      if (w > tokenBestW) { tokenBest = cat; tokenBestW = w; }
    }
    if (tokenBest) hits.push({ token: t, categoryId: tokenBest, weight: tokenBestW });
  }
  const noteHit = argmax(scores, allowed);
  if (noteHit.best && noteHit.total > 0) {
    const share = noteHit.bestW / noteHit.total;
    return {
      categoryId: noteHit.best,
      confidence: Math.min(1, roundMoney(share * massFactor(noteHit.bestW))),
      source: "note",
      why: hits.filter(h => h.categoryId === noteHit.best).sort((a, b) => b.weight - a.weight).slice(0, 3),
    };
  }

  // Nothing in the note is known — fall back to context.
  const ctx = {};
  const add = (row) => { for (const [cat, w] of Object.entries(row || {})) { if (allowed && !allowed.has(cat)) continue; ctx[cat] = roundMoney((ctx[cat] || 0) + w); } };
  if (walletId) add(m.wallets[walletId]);
  const b = amountBucket(amount);
  if (b) add(m.buckets[b]);
  const ctxHit = argmax(ctx, allowed);
  if (!ctxHit.best || ctxHit.total <= 0) return empty;
  const share = ctxHit.bestW / ctxHit.total;
  return {
    categoryId: ctxHit.best,
    confidence: Math.min(1, roundMoney(share * massFactor(ctxHit.bestW) * CONTEXT_CONFIDENCE_SCALE)),
    source: "context",
    why: [],
  };
};

/**
 * Build a model from expense history so the very first prediction is already
 * good. Without this the feature is useless for the first few weeks, which is
 * exactly long enough for someone to conclude it does not work — and the data
 * has been sitting there the whole time.
 */
export const buildFromHistory = (expenses, { todayKey = localDateKey(), validCategoryIds } = {}) => {
  const allowed = validCategoryIds instanceof Set ? validCategoryIds : (Array.isArray(validCategoryIds) ? new Set(validCategoryIds) : null);
  const model = emptyModel();
  const tokens = {}, wallets = {}, buckets = {};
  for (const e of expenses || []) {
    if (!e || e.deleted_at || !e.categoryId) continue;
    if (allowed && !allowed.has(e.categoryId)) continue;
    const age = e.date ? Math.max(0, daysBetween(e.date, todayKey)) : 0;
    if (age > MAX_DECAY_DAYS) continue;
    const w = Math.pow(DAILY_DECAY, age);
    if (!(w > 0.01)) continue;
    for (const t of tokenize(e.note)) bump(tokens, t, e.categoryId, w);
    if (e.walletId && e.walletId !== "__tracked__") bump(wallets, e.walletId, e.categoryId, w);
    const b = amountBucket(e.amount);
    if (b) bump(buckets, b, e.categoryId, w);
  }
  return pruneModel({ ...model, tokens, wallets, buckets, updatedAt: todayKey });
};

/**
 * Fold the user's explicit Settings rules in as strong priors, so migrating to
 * this model never loses a rule someone deliberately wrote. The rules ALSO keep
 * working as a hard override in the UI — this is belt and braces, and it means a
 * rule still shapes predictions for notes that only partly match it.
 */
export const seedFromRules = (model, rules, { todayKey = localDateKey() } = {}) => {
  let m = model && model.v === CAT_MODEL_VERSION ? model : emptyModel();
  const tokens = { ...m.tokens };
  for (const r of rules || []) {
    if (!r || !r.keyword || !r.categoryId) continue;
    for (const t of tokenize(r.keyword)) {
      tokens[t] = { ...(tokens[t] || {}) };
      bump(tokens, t, r.categoryId, RULE_SEED_WEIGHT);
    }
  }
  return pruneModel({ ...m, tokens, updatedAt: m.updatedAt || todayKey });
};

/** Token count — used to decide whether a backfill has produced anything usable. */
export const modelSize = (model) => Object.keys(model?.tokens || {}).length;
