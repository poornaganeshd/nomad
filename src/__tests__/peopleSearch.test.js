import { describe, it, expect } from 'vitest';
import {
  matchScore,
  rankPeople,
  hasExactPerson,
  highlightParts,
  peopleFromSplits,
  sameName,
  MATCH_EXACT,
  MATCH_PREFIX,
  MATCH_WORD,
  MATCH_SUBSTR,
  MATCH_FUZZY,
  MATCH_NONE,
} from '../peopleSearch.js';

// The people list from the real screenshots this was built against — the split
// picker showed all of these unfiltered, which is the wall of chips the search
// replaces.
const PEOPLE = [
  'Arun', 'Dharun', 'Thicknakaran', 'Sujatha pedhamma', 'Nithish',
  'Jayakumar', 'Jayasoorya', 'Rakesh', 'Venkatesh', 'Ayyapan', 'Harshiv',
  'Sundhari food aunty',
];

describe('matchScore — tiers', () => {
  it('scores an exact (case-insensitive) name best', () => {
    expect(matchScore('Rakesh', 'rakesh')).toBe(MATCH_EXACT);
    expect(matchScore('Rakesh', '  RAKESH  ')).toBe(MATCH_EXACT);
  });

  it('ranks a prefix above a mid-word substring', () => {
    expect(matchScore('Arun', 'a')).toBe(MATCH_PREFIX);
    expect(matchScore('Dharun', 'a')).toBe(MATCH_SUBSTR);
    expect(matchScore('Arun', 'a')).toBeLessThan(matchScore('Dharun', 'a'));
  });

  it('treats the start of a later word as its own tier', () => {
    expect(matchScore('Sujatha pedhamma', 'ped')).toBe(MATCH_WORD);
    expect(matchScore('Sundhari food aunty', 'aunty')).toBe(MATCH_WORD);
    // ...and above a plain substring hit.
    expect(matchScore('Sujatha pedhamma', 'ped')).toBeLessThan(matchScore('Dharun', 'a'));
  });

  it('handles dot / dash / slash word breaks', () => {
    expect(matchScore('jaya.kumar', 'kumar')).toBe(MATCH_WORD);
    expect(matchScore('food-aunty', 'aunty')).toBe(MATCH_WORD);
  });

  it('falls back to an in-order subsequence so a misspelling still finds the person', () => {
    expect(matchScore('Thicknakaran', 'thknkrn')).toBe(MATCH_FUZZY);
    expect(matchScore('Jayasoorya', 'jysry')).toBe(MATCH_FUZZY);
  });

  it('does NOT fuzzy-match below 3 characters (every name subsequences "ae")', () => {
    expect(matchScore('Rakesh', 'ke')).toBe(MATCH_SUBSTR); // real substring, fine
    expect(matchScore('Venkatesh', 'vk')).toBe(MATCH_NONE); // subsequence, too short
  });

  it('returns NONE for a genuine miss and for a blank name', () => {
    expect(matchScore('Arun', 'zzz')).toBe(MATCH_NONE);
    expect(matchScore('', 'a')).toBe(MATCH_NONE);
    expect(matchScore(null, 'a')).toBe(MATCH_NONE);
  });

  it('matches everything on an empty query, so the same helper lists "recent people"', () => {
    expect(matchScore('Arun', '')).toBe(MATCH_SUBSTR);
    expect(matchScore('Arun', '   ')).toBe(MATCH_SUBSTR);
  });
});

describe('rankPeople — the typeahead the user asked for', () => {
  it('typing "a" surfaces prefix matches first', () => {
    const names = rankPeople('a', PEOPLE, { limit: 20 }).map((r) => r.name);
    expect(names[0]).toBe('Arun');
    expect(names[1]).toBe('Ayyapan');
    // every remaining hit contains an "a" somewhere
    names.slice(2).forEach((n) => expect(n.toLowerCase()).toContain('a'));
  });

  it('drops names that do not match at all', () => {
    const names = rankPeople('jay', PEOPLE, { limit: 20 }).map((r) => r.name);
    expect(names).toEqual(['Jayakumar', 'Jayasoorya']);
    expect(names).not.toContain('Rakesh');
  });

  it('keeps the caller\'s (recency) order within a tier', () => {
    const recent = ['Zulu', 'Alpha', 'Amber'];
    expect(rankPeople('a', recent).map((r) => r.name)).toEqual(['Alpha', 'Amber']);
    const flipped = ['Zulu', 'Amber', 'Alpha'];
    expect(rankPeople('a', flipped).map((r) => r.name)).toEqual(['Amber', 'Alpha']);
  });

  it('lists everyone, recency-first, when the query is empty', () => {
    expect(rankPeople('', PEOPLE, { limit: 3 }).map((r) => r.name))
      .toEqual(['Arun', 'Dharun', 'Thicknakaran']);
  });

  it('excludes already-chosen people, case-insensitively', () => {
    const names = rankPeople('a', PEOPLE, { limit: 20, exclude: ['ARUN', 'ayyapan'] }).map((r) => r.name);
    expect(names).not.toContain('Arun');
    expect(names).not.toContain('Ayyapan');
    expect(names).toContain('Dharun');
  });

  it('de-duplicates differently-cased copies of one person', () => {
    expect(rankPeople('r', ['Rakesh', 'rakesh', 'RAKESH']).map((r) => r.name)).toEqual(['Rakesh']);
  });

  it('honours limit, and limit <= 0 means unlimited', () => {
    expect(rankPeople('a', PEOPLE, { limit: 2 })).toHaveLength(2);
    expect(rankPeople('a', PEOPLE, { limit: 0 }).length).toBeGreaterThan(2);
  });

  it('survives junk input', () => {
    expect(rankPeople('a', null)).toEqual([]);
    expect(rankPeople('a', [null, '', '   ', undefined])).toEqual([]);
    expect(rankPeople(undefined, ['Arun']).map((r) => r.name)).toEqual(['Arun']);
  });

  it('reports the tier so a weak fuzzy hit can be styled as such', () => {
    expect(rankPeople('rakesh', PEOPLE)[0]).toEqual({ name: 'Rakesh', score: MATCH_EXACT });
    expect(rankPeople('thknkrn', PEOPLE)[0]).toEqual({ name: 'Thicknakaran', score: MATCH_FUZZY });
  });
});

describe('hasExactPerson — guards the "create new" action', () => {
  it('is true only for an exact, case-insensitive name', () => {
    expect(hasExactPerson('rakesh', PEOPLE)).toBe(true);
    expect(hasExactPerson('  Rakesh ', PEOPLE)).toBe(true);
    expect(hasExactPerson('Rake', PEOPLE)).toBe(false);
  });

  it('is false for a blank query, so an empty field never looks like a duplicate', () => {
    expect(hasExactPerson('', PEOPLE)).toBe(false);
    expect(hasExactPerson('   ', PEOPLE)).toBe(false);
  });
});

describe('sameName', () => {
  it('ignores case and surrounding space', () => {
    expect(sameName('Rakesh', ' rakesh ')).toBe(true);
    expect(sameName('Rakesh', 'Rakesh K')).toBe(false);
  });

  it('never matches on empty', () => {
    expect(sameName('', '')).toBe(false);
    expect(sameName(null, undefined)).toBe(false);
  });
});

describe('highlightParts', () => {
  it('splits the name around the matched run', () => {
    expect(highlightParts('Dharun', 'a')).toEqual(['Dh', 'a', 'run']);
    expect(highlightParts('Arun', 'ar')).toEqual(['', 'Ar', 'un']);
  });

  it('preserves the original casing of the matched run', () => {
    expect(highlightParts('Rakesh', 'RAK')).toEqual(['', 'Rak', 'esh']);
  });

  it('returns the whole name unsplit for an empty query or a fuzzy-only hit', () => {
    expect(highlightParts('Arun', '')).toEqual(['Arun', '', '']);
    expect(highlightParts('Thicknakaran', 'thknkrn')).toEqual(['Thicknakaran', '', '']);
  });
});

describe('peopleFromSplits', () => {
  it('returns unique names, most recent first', () => {
    const splits = [
      { name: 'Arun', createdAt: '2026-07-01T10:00:00.000Z' },
      { name: 'Rakesh', createdAt: '2026-07-29T10:00:00.000Z' },
      { name: 'Nithish', createdAt: '2026-07-15T10:00:00.000Z' },
      { name: 'Arun', createdAt: '2026-07-20T10:00:00.000Z' },
    ];
    expect(peopleFromSplits(splits)).toEqual(['Rakesh', 'Arun', 'Nithish']);
  });

  it('excludes soft-deleted rows — a deleted IOU used to suggest its person forever', () => {
    const splits = [
      { name: 'Ghost', createdAt: '2026-07-29T10:00:00.000Z', deleted_at: '2026-07-30T00:00:00.000Z' },
      { name: 'Rakesh', createdAt: '2026-07-28T10:00:00.000Z' },
    ];
    expect(peopleFromSplits(splits)).toEqual(['Rakesh']);
  });

  it('keeps a person whose OTHER rows are still live', () => {
    const splits = [
      { name: 'Rakesh', createdAt: '2026-07-01T10:00:00.000Z', deleted_at: '2026-07-02T00:00:00.000Z' },
      { name: 'Rakesh', createdAt: '2026-07-28T10:00:00.000Z' },
    ];
    expect(peopleFromSplits(splits)).toEqual(['Rakesh']);
  });

  it('folds case variants to one entry, using the most recent spelling', () => {
    const splits = [
      { name: 'rakesh', createdAt: '2026-07-01T10:00:00.000Z' },
      { name: 'Rakesh', createdAt: '2026-07-28T10:00:00.000Z' },
    ];
    expect(peopleFromSplits(splits)).toEqual(['Rakesh']);
  });

  it('orders correctly when rows mix ISO createdAt with a bare date', () => {
    const splits = [
      { name: 'Older', date: '2026-07-10' },
      { name: 'Newer', createdAt: '2026-07-29T10:00:00.000Z' },
    ];
    expect(peopleFromSplits(splits)).toEqual(['Newer', 'Older']);
  });

  it('sorts rows with no timestamp last instead of dropping them', () => {
    const splits = [
      { name: 'Undated' },
      { name: 'Dated', createdAt: '2026-07-29T10:00:00.000Z' },
    ];
    expect(peopleFromSplits(splits)).toEqual(['Dated', 'Undated']);
  });

  it('ignores blank names and junk input', () => {
    expect(peopleFromSplits([{ name: '   ' }, { name: null }, null])).toEqual([]);
    expect(peopleFromSplits(null)).toEqual([]);
  });

  it('reads created_at (snake case, straight off Supabase) too', () => {
    const splits = [
      { name: 'Snake', created_at: '2026-07-29T10:00:00.000Z' },
      { name: 'Older', created_at: '2026-07-01T10:00:00.000Z' },
    ];
    expect(peopleFromSplits(splits)).toEqual(['Snake', 'Older']);
  });
});
