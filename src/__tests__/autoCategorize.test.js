import { describe, it, expect } from 'vitest';
import { draftAutoPick } from '../financeUtils.js';
import { emptyModel, learn, predict, buildFromHistory, CONFIDENT_ENOUGH } from '../categoryModel.js';

// Autocategorization "sometimes didn't work, don't know why". Two causes, both
// invisible from the UI, both pinned here.

describe('draftAutoPick — the Add form handing off to the user', () => {
  // The bug: AddPage restores a sessionStorage draft on every mount, and the
  // draft effect writes on EVERY render — so a categoryId is in the draft the
  // instant the Add tab first paints, with nobody having touched it. Inferring
  // "the user picked this" from "the draft has a value" therefore switched
  // autocategorize off for the rest of the session the first time you left the
  // Add tab and came back (AddPage is conditionally rendered — that remounts).
  it('keeps auto-fill armed for a draft the user never touched', () => {
    // aCat === the auto value the form itself chose: still auto.
    expect(draftAutoPick('food', 'food', 'other')).toBe('food');
  });

  it('hands off for good once the user picked a category', () => {
    // The form filled "food"; the user then chose "travel". aCat stays at the
    // auto value, catId moved — the two differ, so fillCat refuses.
    expect(draftAutoPick('food', 'travel', 'other')).toBe('food');
    // And an explicit hand-off (null) survives the round trip.
    expect(draftAutoPick(null, 'travel', 'other')).toBe(null);
  });

  it('falls back to the old conservative reading for a pre-flag draft', () => {
    expect(draftAutoPick(undefined, 'travel', 'other')).toBe(null); // had a value → assume manual
    expect(draftAutoPick(undefined, undefined, 'other')).toBe('other'); // no draft → auto
  });

  it('treats an empty draft value as no draft at all', () => {
    expect(draftAutoPick(undefined, '', 'other')).toBe('other');
  });
});

describe('learning from every expense path, not just the Add form', () => {
  // The model used to learn only from AddPage's submit, so quick-add taps,
  // event/bill-split expenses, receipt line items, CSV imports and "bill paid"
  // taught it nothing — every one of them a real (note → category) pair.
  // Learning now happens in addE, which all of those go through. This pins the
  // consequence: repeated sightings of a merchant reach a confident, usable
  // prediction, which is what a single learning path could never accumulate.
  const day = { todayKey: '2026-09-15' };

  it('one sighting is known but not confident enough to fill a field', () => {
    const m = learn(emptyModel(), { note: 'Zomato dinner', categoryId: 'food', walletId: 'bank', amount: 400 }, day);
    const p = predict(m, { note: 'zomato', walletId: 'bank', amount: 400 });
    expect(p.categoryId).toBe('food');
    expect(p.confidence).toBeLessThan(CONFIDENT_ENOUGH);
  });

  it('a handful of sightings from any path becomes confident', () => {
    let m = emptyModel();
    for (let i = 0; i < 4; i++) m = learn(m, { note: 'Zomato dinner', categoryId: 'food', walletId: 'bank', amount: 400 }, day);
    const p = predict(m, { note: 'zomato', walletId: 'bank', amount: 400 });
    expect(p.categoryId).toBe('food');
    expect(p.confidence).toBeGreaterThanOrEqual(CONFIDENT_ENOUGH);
  });

  it('a correction takes effect on the very next prediction', () => {
    let m = emptyModel();
    for (let i = 0; i < 5; i++) m = learn(m, { note: 'Rentomojo', categoryId: 'shopping', walletId: 'bank', amount: 600 }, day);
    m = learn(m, { note: 'Rentomojo', categoryId: 'rent', walletId: 'bank', amount: 600, wrongCategoryId: 'shopping' }, day);
    const p = predict(m, { note: 'Rentomojo', walletId: 'bank', amount: 600 });
    expect(p.categoryId).toBe('rent');
    expect(p.confidence).toBeGreaterThanOrEqual(CONFIDENT_ENOUGH);
  });
});

describe('history backfill', () => {
  // The seed effect used to latch itself off after seeding from Settings rules
  // alone. `loaded` flips on the localStorage paint and the remote pull lands
  // after it, so on a fresh device the model was built from a couple of rules,
  // marked done, and never saw the ledger that arrived a moment later. It now
  // waits for expenses — this is what it gets when it does.
  it('builds a usable model straight out of existing history', () => {
    const ex = [];
    for (let i = 0; i < 6; i++) ex.push({ id: `e${i}`, note: 'Rentomojo', categoryId: 'rent', walletId: 'bank', amount: 635, date: '2026-09-10' });
    const m = buildFromHistory(ex, { todayKey: '2026-09-15' });
    const p = predict(m, { note: 'rentomojo rent', walletId: 'bank', amount: 635 });
    expect(p.categoryId).toBe('rent');
    expect(p.confidence).toBeGreaterThanOrEqual(CONFIDENT_ENOUGH);
  });

  it('an empty ledger produces nothing to act on — so waiting for it matters', () => {
    const m = buildFromHistory([], { todayKey: '2026-09-15' });
    expect(predict(m, { note: 'rentomojo', walletId: 'bank', amount: 635 }).categoryId).toBe(null);
  });
});
