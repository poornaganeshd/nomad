import { describe, it, expect } from 'vitest';
import {
  emptyModel, tokenize, amountBucket, learn, predict, decayModel, pruneModel,
  buildFromHistory, seedFromRules, modelSize, MAX_TOKENS, CONFIDENT_ENOUGH,
  rankCategories, SAVE_FILL_MIN, WEIGHT_PICK, WEIGHT_ACCEPTED,
} from '../categoryModel.js';

const T = '2026-08-11';
const day = (n) => {
  const d = new Date(2026, 7, 11, 12);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Teach the same example n times, as logging it n times would.
const teachW = (model, entry, n = 1, todayKey = T) => {
  let m = model;
  for (let i = 0; i < n; i++) m = learn(m, entry, { todayKey });
  return m;
};
const teach = (model, entry, n = 1, todayKey = T) => {
  let m = model;
  for (let i = 0; i < n; i++) m = learn(m, entry, { todayKey });
  return m;
};

describe('tokenize', () => {
  it('drops stopwords, short tokens and bare numbers', () => {
    expect(tokenize('Paid 450 for coffee at the cafe')).toEqual(['coffee', 'cafe']);
  });

  it('treats digits as boundaries, so a glued quantity still yields the word', () => {
    expect(tokenize('Rice5kg')).toEqual(['rice']);
    expect(tokenize('2x Zomato order')).toEqual(['zomato', 'order']);
  });

  it('de-duplicates — writing a word twice is not twice the evidence', () => {
    expect(tokenize('coffee coffee coffee')).toEqual(['coffee']);
  });

  it('keeps non-Latin scripts intact', () => {
    // Splitting on [a-z] would throw these away entirely; splitting on \p{L}
    // without \p{M} shatters them ("दूध" → "द","ध"), because every Devanagari
    // vowel sign is a combining mark rather than a letter. "और" ("and") drops
    // out on length, which is right — it is a stopword.
    expect(tokenize('दूध और चाय')).toEqual(['दूध', 'चाय']);
  });

  it('is empty for junk input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(null)).toEqual([]);
    expect(tokenize('₹1,200')).toEqual([]);
  });
});

describe('amountBucket', () => {
  it('separates a chai from a rent payment', () => {
    expect(amountBucket(40)).not.toBe(amountBucket(15000));
  });
  it('puts near-identical amounts together', () => {
    expect(amountBucket(410)).toBe(amountBucket(430));
  });
  it('is null for nothing', () => {
    expect(amountBucket(0)).toBeNull();
    expect(amountBucket(undefined)).toBeNull();
  });
});

describe('learn + predict — the core loop', () => {
  it('learns a merchant from a single save and predicts it back', () => {
    const m = learn(emptyModel(), { note: 'Zomato dinner', categoryId: 'food', walletId: 'bank', amount: 450 }, { todayKey: T });
    const p = predict(m, { note: 'zomato lunch' });
    expect(p.categoryId).toBe('food');
    expect(p.source).toBe('note');
  });

  it('one sighting is not confident enough to act on; repetition is', () => {
    // The whole point of damping by evidence mass: a single observation gives a
    // 100% share but must not be enough to start overwriting the form.
    const once = learn(emptyModel(), { note: 'Blinkit', categoryId: 'grocery' }, { todayKey: T });
    expect(predict(once, { note: 'Blinkit' }).confidence).toBeLessThan(CONFIDENT_ENOUGH);
    const often = teach(emptyModel(), { note: 'Blinkit', categoryId: 'grocery' }, 4);
    expect(predict(often, { note: 'Blinkit' }).confidence).toBeGreaterThanOrEqual(CONFIDENT_ENOUGH);
  });

  it('says nothing about a note it has never seen', () => {
    const m = teach(emptyModel(), { note: 'Zomato', categoryId: 'food' }, 5);
    expect(predict(m, { note: 'Kalyan Jewellers' }).categoryId).toBeNull();
  });

  it('an unknown note falls through to wallet/amount context, but quietly', () => {
    const m = teach(emptyModel(), { note: 'Zomato', categoryId: 'food', walletId: 'upi_lite', amount: 300 }, 6);
    const p = predict(m, { note: 'xyzzy', walletId: 'upi_lite', amount: 320 });
    expect(p.categoryId).toBe('food');
    expect(p.source).toBe('context');
    // Deliberately weaker than a note match — context answers, it does not assert.
    expect(p.confidence).toBeLessThan(predict(m, { note: 'Zomato' }).confidence);
  });

  it('a known token BEATS context pointing elsewhere', () => {
    // "you usually pay from Bank" must never outvote "zomato means Food".
    let m = teach(emptyModel(), { note: 'Zomato', categoryId: 'food', walletId: 'cash', amount: 400 }, 3);
    m = teach(m, { note: 'Metro card', categoryId: 'travel', walletId: 'bank', amount: 400 }, 20);
    expect(predict(m, { note: 'zomato', walletId: 'bank', amount: 400 }).categoryId).toBe('food');
  });

  it('ignores categories that no longer exist', () => {
    const m = teach(emptyModel(), { note: 'Zomato', categoryId: 'deleted_cat' }, 5);
    expect(predict(m, { note: 'Zomato' }, { validCategoryIds: new Set(['food']) }).categoryId).toBeNull();
  });

  it('explains itself — the why carries the tokens that decided it', () => {
    const m = teach(emptyModel(), { note: 'Zomato dinner', categoryId: 'food' }, 3);
    const p = predict(m, { note: 'zomato' });
    expect(p.why[0]).toMatchObject({ token: 'zomato', categoryId: 'food' });
  });

  it('never mutates the model it was given', () => {
    const before = emptyModel();
    const snapshot = JSON.stringify(before);
    learn(before, { note: 'Zomato', categoryId: 'food' }, { todayKey: T });
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('corrections — the signal the old rule table threw away', () => {
  it('picking a different category flips a settled prediction', () => {
    // Six saves say Shopping. One correction should not need six more to undo.
    let m = teach(emptyModel(), { note: 'Swiggy', categoryId: 'shopping' }, 6);
    expect(predict(m, { note: 'Swiggy' }).categoryId).toBe('shopping');
    m = learn(m, { note: 'Swiggy', categoryId: 'food', wrongCategoryId: 'shopping' }, { todayKey: T });
    expect(predict(m, { note: 'Swiggy' }).categoryId).toBe('food');
  });

  it('halving is scale-invariant — a heavy wrong weight moves just as fast', () => {
    let m = teach(emptyModel(), { note: 'Swiggy', categoryId: 'shopping' }, 30);
    m = learn(m, { note: 'Swiggy', categoryId: 'food', wrongCategoryId: 'shopping' }, { todayKey: T });
    m = learn(m, { note: 'Swiggy', categoryId: 'food', wrongCategoryId: 'shopping' }, { todayKey: T });
    m = learn(m, { note: 'Swiggy', categoryId: 'food', wrongCategoryId: 'shopping' }, { todayKey: T });
    m = learn(m, { note: 'Swiggy', categoryId: 'food', wrongCategoryId: 'shopping' }, { todayKey: T });
    expect(predict(m, { note: 'Swiggy' }).categoryId).toBe('food');
  });

  it('a correction only demotes the category that was actually wrong', () => {
    let m = teach(emptyModel(), { note: 'Cafe', categoryId: 'food' }, 4);
    m = teach(m, { note: 'Cafe', categoryId: 'coffee' }, 2);
    m = learn(m, { note: 'Cafe', categoryId: 'coffee', wrongCategoryId: 'food' }, { todayKey: T });
    // Food is demoted, not erased — you do sometimes file a cafe as Food.
    expect(predict(m, { note: 'Cafe' }).categoryId).toBe('coffee');
    expect(m.tokens.cafe.food).toBeGreaterThan(0);
  });

  it('a correction is CONFIDENT, not merely correct', () => {
    // Flipping the argmax is not enough: a near-tie scores below the bar, so the
    // model would know the answer and still decline to fill it in — which is
    // indistinguishable from the correction having been ignored.
    let m = teach(emptyModel(), { note: 'Swiggy', categoryId: 'entertainment' }, 4);
    m = learn(m, { note: 'Swiggy', categoryId: 'food', wrongCategoryId: 'entertainment' }, { todayKey: T });
    const p = predict(m, { note: 'Swiggy' });
    expect(p.categoryId).toBe('food');
    expect(p.confidence).toBeGreaterThanOrEqual(CONFIDENT_ENOUGH);
  });

  it('a plain save (no correction) is ordinary evidence, not a demotion', () => {
    let m = teach(emptyModel(), { note: 'Cafe', categoryId: 'food' }, 4);
    const before = m.tokens.cafe.food;
    m = learn(m, { note: 'Cafe', categoryId: 'coffee' }, { todayKey: T });
    expect(m.tokens.cafe.food).toBe(before);
  });
});

describe('decay', () => {
  it('is a no-op within the same day', () => {
    const m = learn(emptyModel(), { note: 'Zomato', categoryId: 'food' }, { todayKey: T });
    expect(decayModel(m, T).tokens).toEqual(m.tokens);
  });

  it('fades old weight but keeps a months-old habit predictable', () => {
    const m = teach(emptyModel(), { note: 'Zomato', categoryId: 'food' }, 5);
    const aged = decayModel(m, day(120));
    expect(aged.tokens.zomato.food).toBeLessThan(m.tokens.zomato.food);
    expect(predict(aged, { note: 'Zomato' }).categoryId).toBe('food');
  });

  it('recent evidence overtakes stale evidence', () => {
    let m = teach(emptyModel(), { note: 'Corner shop', categoryId: 'grocery' }, 6);
    m = teach(m, { note: 'Corner shop', categoryId: 'coffee' }, 4, day(300));
    expect(predict(m, { note: 'corner shop' }).categoryId).toBe('coffee');
  });

  it('caps how far a single decay can go, so a wild date cannot wipe the model', () => {
    // A corrupted or absent updatedAt must not silently erase everything learned.
    const m = teach(emptyModel(), { note: 'Zomato', categoryId: 'food' }, 5);
    const aged = decayModel(m, day(3000));
    expect(aged.tokens.zomato.food).toBeLessThan(m.tokens.zomato.food * 0.2);
    expect(predict(aged, { note: 'Zomato' }).categoryId).toBe('food');
  });
});

describe('pruning keeps the synced blob bounded', () => {
  it('caps the token table, keeping the heaviest', () => {
    let m = emptyModel();
    for (let i = 0; i < MAX_TOKENS + 60; i++) m = learn(m, { note: `merchant${i}xx`, categoryId: 'food' }, { todayKey: T });
    m = teach(m, { note: 'zomato', categoryId: 'food' }, 20);
    expect(modelSize(m)).toBeLessThanOrEqual(MAX_TOKENS);
    expect(m.tokens.zomato).toBeTruthy();
  });

  it('leaves a small model alone', () => {
    const m = learn(emptyModel(), { note: 'Zomato', categoryId: 'food' }, { todayKey: T });
    expect(pruneModel(m)).toEqual(m);
  });
});

describe('buildFromHistory — accurate on day one, not after a fortnight', () => {
  const hist = [
    { date: day(-2), note: 'Zomato dinner', categoryId: 'food', walletId: 'bank', amount: 450 },
    { date: day(-9), note: 'Zomato lunch', categoryId: 'food', walletId: 'bank', amount: 300 },
    { date: day(-15), note: 'Uber to office', categoryId: 'travel', walletId: 'upi_lite', amount: 220 },
    { date: day(-20), note: 'Uber airport', categoryId: 'travel', walletId: 'upi_lite', amount: 700 },
  ];

  it('learns merchants straight out of existing expenses', () => {
    const m = buildFromHistory(hist, { todayKey: T });
    expect(predict(m, { note: 'zomato' }).categoryId).toBe('food');
    expect(predict(m, { note: 'uber ride' }).categoryId).toBe('travel');
  });

  it('weights recent history above ancient history', () => {
    const m = buildFromHistory([
      { date: day(-1), note: 'Corner shop', categoryId: 'grocery', amount: 100 },
      { date: day(-350), note: 'Corner shop', categoryId: 'coffee', amount: 100 },
    ], { todayKey: T });
    expect(predict(m, { note: 'corner shop' }).categoryId).toBe('grocery');
  });

  it('skips deleted rows, uncategorized rows and dead categories', () => {
    const m = buildFromHistory([
      { date: day(-1), note: 'Zomato', categoryId: 'food', deleted_at: '2026-01-01' },
      { date: day(-1), note: 'Mystery' },
      { date: day(-1), note: 'Gucci', categoryId: 'gone' },
    ], { todayKey: T, validCategoryIds: new Set(['food']) });
    expect(modelSize(m)).toBe(0);
  });

  it('does not treat a tracked group expense as wallet evidence', () => {
    const m = buildFromHistory([{ date: day(-1), note: 'Dinner', categoryId: 'food', walletId: '__tracked__', amount: 900 }], { todayKey: T });
    expect(m.wallets.__tracked__).toBeUndefined();
  });

  it('handles an empty ledger without exploding', () => {
    expect(modelSize(buildFromHistory([], { todayKey: T }))).toBe(0);
    expect(modelSize(buildFromHistory(null, { todayKey: T }))).toBe(0);
  });
});

describe('seedFromRules — migrating without losing anything', () => {
  it('an explicit rule predicts immediately and confidently', () => {
    const m = seedFromRules(emptyModel(), [{ keyword: 'swiggy', categoryId: 'food' }], { todayKey: T });
    const p = predict(m, { note: 'Swiggy order' });
    expect(p.categoryId).toBe('food');
    expect(p.confidence).toBeGreaterThanOrEqual(CONFIDENT_ENOUGH);
  });

  it('a rule shapes partial matches too, which a literal keyword rule cannot', () => {
    const m = seedFromRules(emptyModel(), [{ keyword: 'metro card', categoryId: 'travel' }], { todayKey: T });
    expect(predict(m, { note: 'topped up the metro' }).categoryId).toBe('travel');
  });

  it('but a rule is still only a prior — enough corrections override it', () => {
    let m = seedFromRules(emptyModel(), [{ keyword: 'swiggy', categoryId: 'food' }], { todayKey: T });
    for (let i = 0; i < 4; i++) m = learn(m, { note: 'Swiggy', categoryId: 'grocery', wrongCategoryId: 'food' }, { todayKey: T });
    expect(predict(m, { note: 'Swiggy' }).categoryId).toBe('grocery');
  });

  it('ignores malformed rules', () => {
    const m = seedFromRules(emptyModel(), [null, { keyword: '' }, { categoryId: 'food' }], { todayKey: T });
    expect(modelSize(m)).toBe(0);
  });
});

describe('robustness', () => {
  it('predicts nothing from an empty model instead of throwing', () => {
    expect(predict(emptyModel(), { note: 'anything' })).toMatchObject({ categoryId: null, confidence: 0 });
    expect(predict(null, { note: 'anything' }).categoryId).toBeNull();
  });

  it('a model from a future schema version is discarded, not trusted', () => {
    expect(predict({ v: 99, tokens: { zomato: { food: 50 } } }, { note: 'zomato' }).categoryId).toBeNull();
  });

  it('learning without a category is a no-op', () => {
    const m = emptyModel();
    expect(learn(m, { note: 'Zomato' }, { todayKey: T })).toEqual(m);
  });

  it('an empty note still learns context', () => {
    const m = learn(emptyModel(), { note: '', categoryId: 'food', walletId: 'cash', amount: 60 }, { todayKey: T });
    expect(modelSize(m)).toBe(0);
    expect(m.wallets.cash.food).toBeGreaterThan(0);
  });
});

describe('merchant variants — the same shop typed three different ways', () => {
  it('matches a known token as a prefix of a longer one', () => {
    // UPI notes are never spelled the same twice. Exact-token matching alone
    // treated "swiggyinstamart" as a merchant it had never seen.
    const m = teach(emptyModel(), { note: 'Swiggy', categoryId: 'food' }, 6);
    expect(predict(m, { note: 'swiggyinstamart' }).categoryId).toBe('food');
    expect(predict(m, { note: 'swiggy' }).confidence).toBeGreaterThan(predict(m, { note: 'swiggyinstamart' }).confidence);
  });

  it('and the other way round — a longer known token from a shorter note', () => {
    const m = teach(emptyModel(), { note: 'zomatogold', categoryId: 'food' }, 6);
    expect(predict(m, { note: 'zomato' }).categoryId).toBe('food');
  });

  it('does not fuzzy-match short tokens, which would match half the table', () => {
    const m = teach(emptyModel(), { note: 'cab ride', categoryId: 'travel' }, 6);
    // "cabinet" shares a 3-letter prefix with "cab" — not evidence of anything.
    expect(predict(m, { note: 'cabinet' }).categoryId).toBeNull();
  });

  it('an exact match still outranks a prefix match', () => {
    let m = teach(emptyModel(), { note: 'metro', categoryId: 'travel' }, 4);
    m = teach(m, { note: 'metropolis', categoryId: 'entertainment' }, 4);
    expect(predict(m, { note: 'metro' }).categoryId).toBe('travel');
  });
});

describe('context is a tie-breaker now, not a last resort', () => {
  it('the amount decides a token that means two different things', () => {
    // "monthly" is filed both ways; ₹15,000 vs ₹200 is the whole difference, and
    // the old all-or-nothing gate ignored it because the token WAS known.
    let m = teach(emptyModel(), { note: 'monthly', categoryId: 'rent', amount: 15000, walletId: 'bank' }, 5);
    m = teach(m, { note: 'monthly', categoryId: 'subs', amount: 200, walletId: 'bank' }, 5);
    expect(predict(m, { note: 'monthly', amount: 15000, walletId: 'bank' }).categoryId).toBe('rent');
    expect(predict(m, { note: 'monthly', amount: 200, walletId: 'bank' }).categoryId).toBe('subs');
  });

  it('but it still cannot overturn a merchant it disagrees with', () => {
    // The promise that must survive the blend: a wallet used 20x more often than
    // a merchant does not get to rename that merchant's category.
    let m = teach(emptyModel(), { note: 'Zomato', categoryId: 'food', walletId: 'cash', amount: 400 }, 3);
    m = teach(m, { note: 'Metro card', categoryId: 'travel', walletId: 'bank', amount: 400 }, 40);
    expect(predict(m, { note: 'zomato', walletId: 'bank', amount: 400 }).categoryId).toBe('food');
  });

  it('an ambiguous token lands between the two bars — asked at save, not filled while typing', () => {
    let m = teach(emptyModel(), { note: 'order', categoryId: 'food', amount: 300 }, 5);
    m = teach(m, { note: 'order', categoryId: 'shopping', amount: 300 }, 5);
    const c = predict(m, { note: 'order', amount: 300 }).confidence;
    expect(c).toBeLessThan(CONFIDENT_ENOUGH);
    expect(c).toBeGreaterThanOrEqual(SAVE_FILL_MIN);
  });
});

describe('the recency prior orders the picker and nothing else', () => {
  const prior = { food: 30, travel: 10, rent: 2 };

  it('ranks by habit when the model has never seen the note', () => {
    const ranked = rankCategories(emptyModel(), { note: 'entirely unknown' }, { prior });
    expect(ranked.map(r => r.categoryId)).toEqual(['food', 'travel', 'rent']);
    expect(ranked[0].source).toBe('prior');
  });

  it('is capped below the save-time bar, so it can never FILE anything', () => {
    // "You spend on Food a lot" is not evidence about THIS transaction. Even a
    // history containing exactly one category must not clear the bar.
    const only = rankCategories(emptyModel(), { note: 'unknown' }, { prior: { food: 5000 } });
    expect(only[0].categoryId).toBe('food');
    expect(only[0].confidence).toBeLessThan(SAVE_FILL_MIN);
  });

  it('yields to anything the model actually knows', () => {
    const m = teach(emptyModel(), { note: 'Uber', categoryId: 'travel' }, 4);
    expect(predict(m, { note: 'uber' }, { prior: { food: 500 } }).categoryId).toBe('travel');
  });

  it('respects the valid-category filter like every other tier', () => {
    const ranked = rankCategories(emptyModel(), { note: 'x' }, { prior, validCategoryIds: new Set(['travel']) });
    expect(ranked.map(r => r.categoryId)).toEqual(['travel']);
  });

  it('says nothing at all with no model, no context and no prior', () => {
    expect(rankCategories(emptyModel(), { note: 'x' })).toEqual([]);
  });
});

describe('rankCategories is the single scorer behind both the fill and the picker', () => {
  it('predict is exactly its head', () => {
    const m = teach(emptyModel(), { note: 'Zomato dinner', categoryId: 'food' }, 4);
    const ranked = rankCategories(m, { note: 'zomato' });
    expect(predict(m, { note: 'zomato' })).toEqual(ranked[0]);
  });

  it('orders every category it has an opinion about, best first', () => {
    let m = teach(emptyModel(), { note: 'cafe', categoryId: 'food' }, 6);
    m = teach(m, { note: 'cafe', categoryId: 'coffee' }, 3);
    const ranked = rankCategories(m, { note: 'cafe' });
    expect(ranked.map(r => r.categoryId)).toEqual(['food', 'coffee']);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });
});

describe('learning weights — the model must not train on its own output', () => {
  it('an accepted fill counts for less than a category you picked', () => {
    const picked = learn(emptyModel(), { note: 'Nykaa', categoryId: 'personal', weight: WEIGHT_PICK }, { todayKey: T });
    const accepted = learn(emptyModel(), { note: 'Nykaa', categoryId: 'personal', weight: WEIGHT_ACCEPTED }, { todayKey: T });
    expect(accepted.tokens.nykaa.personal).toBeLessThan(picked.tokens.nykaa.personal);
  });

  it('so a guess repeated back at it takes about twice as long to settle', () => {
    // Two deliberate picks are enough to start filling the form in. The same
    // note merely tolerated twice is not — otherwise an early wrong guess
    // confirms itself on the strength of nobody having objected yet.
    const conf = (m) => predict(m, { note: 'nykaa' }).confidence;
    const acc = (n) => conf(teachW(emptyModel(), { note: 'Nykaa', categoryId: 'personal', weight: WEIGHT_ACCEPTED }, n));
    const pick = (n) => conf(teachW(emptyModel(), { note: 'Nykaa', categoryId: 'personal', weight: WEIGHT_PICK }, n));
    expect(pick(2)).toBeGreaterThanOrEqual(CONFIDENT_ENOUGH);
    expect(acc(2)).toBeLessThan(CONFIDENT_ENOUGH);
    expect(acc(4)).toBeGreaterThanOrEqual(CONFIDENT_ENOUGH);
    expect(acc(4)).toBeLessThan(pick(4));
  });

  it('a correction still beats both, whatever the fill was worth', () => {
    let m = teachW(emptyModel(), { note: 'Swiggy', categoryId: 'shopping', weight: WEIGHT_ACCEPTED }, 6);
    m = learn(m, { note: 'Swiggy', categoryId: 'food', wrongCategoryId: 'shopping', weight: WEIGHT_PICK }, { todayKey: T });
    const p = predict(m, { note: 'Swiggy' });
    expect(p.categoryId).toBe('food');
    expect(p.confidence).toBeGreaterThanOrEqual(CONFIDENT_ENOUGH);
  });
});
