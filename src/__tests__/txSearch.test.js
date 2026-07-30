import { describe, it, expect } from 'vitest';
import {
  parseAmountToken,
  amountMatchesToken,
  tokenizeQuery,
  isAmountQuery,
  matchesQuery,
} from '../txSearch.js';

// The row shape App.jsx feeds in: the amount plus every searchable string.
const row = (amount, ...text) => ({ amount, text });

describe('parseAmountToken', () => {
  it('reads a plain number', () => {
    expect(parseAmountToken('105')).toBe(105);
    expect(parseAmountToken('105.5')).toBe(105.5);
  });

  it('tolerates a ₹ prefix, commas and surrounding space', () => {
    expect(parseAmountToken('₹105')).toBe(105);
    expect(parseAmountToken('1,050')).toBe(1050);
    expect(parseAmountToken(' ₹1,050.50 ')).toBe(1050.5);
  });

  it('rejects anything that is not purely an amount', () => {
    // A lenient parse here would make "rice5kgs" match every ₹5 row.
    expect(parseAmountToken('rice5kgs')).toBeNull();
    expect(parseAmountToken('105rs')).toBeNull();
    expect(parseAmountToken('curd')).toBeNull();
    expect(parseAmountToken('')).toBeNull();
    expect(parseAmountToken(null)).toBeNull();
    expect(parseAmountToken('2026-07-15')).toBeNull();
  });
});

describe('amountMatchesToken', () => {
  it('matches a whole-rupee token to the nearest rupee', () => {
    expect(amountMatchesToken(105, '105')).toBe(true);
    expect(amountMatchesToken(105.4, '105')).toBe(true);
    expect(amountMatchesToken(104.6, '105')).toBe(true);
    expect(amountMatchesToken(105.6, '105')).toBe(false);
  });

  it('does NOT treat the query as a digit substring', () => {
    // This is the line between "useful" and "every search returns everything".
    expect(amountMatchesToken(1050, '105')).toBe(false);
    expect(amountMatchesToken(10.5, '105')).toBe(false);
  });

  it('matches a decimal token to the paisa', () => {
    expect(amountMatchesToken(105.5, '105.5')).toBe(true);
    expect(amountMatchesToken(105.5, '105.50')).toBe(true);
    expect(amountMatchesToken(105.55, '105.5')).toBe(false);
  });

  it('is false for a non-amount token or a missing amount', () => {
    expect(amountMatchesToken(105, 'curd')).toBe(false);
    expect(amountMatchesToken(undefined, '105')).toBe(false);
    expect(amountMatchesToken(NaN, '105')).toBe(false);
  });
});

describe('tokenizeQuery', () => {
  it('lowercases and splits on any whitespace', () => {
    expect(tokenizeQuery('  Curd   105 ')).toEqual(['curd', '105']);
  });

  it('returns nothing for an empty query', () => {
    expect(tokenizeQuery('')).toEqual([]);
    expect(tokenizeQuery('   ')).toEqual([]);
    expect(tokenizeQuery(null)).toEqual([]);
  });
});

describe('isAmountQuery', () => {
  it('is true only when every token is an amount', () => {
    expect(isAmountQuery('105')).toBe(true);
    expect(isAmountQuery('₹1,050.50')).toBe(true);
    expect(isAmountQuery('105 curd')).toBe(false);
    expect(isAmountQuery('curd')).toBe(false);
    expect(isAmountQuery('')).toBe(false);
  });
});

describe('matchesQuery — the bug this module exists for', () => {
  it('finds a row by its amount (the old filter could not)', () => {
    expect(matchesQuery(row(105, 'Curd', 'Food & Drinks', 'Bank'), '105')).toBe(true);
    expect(matchesQuery(row(330, 'Curd', 'Food & Drinks', 'Bank'), '105')).toBe(false);
  });

  it('still finds a row by note, category, wallet or event name', () => {
    const r = row(105, 'Curdrice', 'Food & Drinks', 'UPI Lite', 'Goa trip');
    expect(matchesQuery(r, 'curd')).toBe(true);
    expect(matchesQuery(r, 'food')).toBe(true);
    expect(matchesQuery(r, 'upi')).toBe(true);
    expect(matchesQuery(r, 'goa')).toBe(true);
    expect(matchesQuery(r, 'petrol')).toBe(false);
  });

  it('is case-insensitive both ways', () => {
    expect(matchesQuery(row(105, 'CURDRICE'), 'curd')).toBe(true);
    expect(matchesQuery(row(105, 'curdrice'), 'CURD')).toBe(true);
  });

  it('ANDs every token, in any order', () => {
    const curd = row(105, 'Curdrice', 'Food & Drinks');
    const water = row(105, 'Water', 'Food & Drinks');
    expect(matchesQuery(curd, 'curd 105')).toBe(true);
    expect(matchesQuery(curd, '105 curd')).toBe(true);
    expect(matchesQuery(water, 'curd 105')).toBe(false);
    // Both tokens are text: order-independent, unlike a plain substring match.
    expect(matchesQuery(row(1, 'Filter coffee'), 'coffee filter')).toBe(true);
  });

  it('lets a token match the amount OR the text, not necessarily the same one', () => {
    // "105" hits the amount, "food" hits the category.
    expect(matchesQuery(row(105, 'Curdrice', 'Food & Drinks'), 'food 105')).toBe(true);
  });

  it('matches everything on an empty query', () => {
    expect(matchesQuery(row(105, 'Curd'), '')).toBe(true);
    expect(matchesQuery(row(105, 'Curd'), '   ')).toBe(true);
  });

  it('survives junk rows', () => {
    expect(matchesQuery(null, '105')).toBe(false);
    expect(matchesQuery({}, '105')).toBe(false);
    expect(matchesQuery(row(105, null, undefined, ''), '105')).toBe(true);
    expect(matchesQuery({ amount: 105 }, '105')).toBe(true);
  });
});
