import { describe, it, expect, beforeEach } from 'vitest';
import { putTrash, listTrash, removeTrash, clearTrash, mergeTrash, TRASH_KEY, TRASH_CAP } from '../localTrash.js';

// "Recently Deleted" read server tombstones only, so it was permanently EMPTY
// in local-only mode — the app's actual onboarding path, and the users most
// likely to delete the wrong thing. There was no signal either: the section
// renders, it is just always blank.

beforeEach(() => localStorage.clear());

const row = (id, over = {}) => ({ id, amount: 100, note: 'x', ...over });

describe('the bin works with no server at all', () => {
  it('records a delete and lists it back', () => {
    putTrash(localStorage, 'expenses', row('e1'));
    const out = listTrash(localStorage);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'e1', _tbl: 'expenses' });
    expect(out[0].deleted_at).toBeTruthy();
  });

  it('takes several rows at once, as a group delete produces', () => {
    putTrash(localStorage, 'splits', [row('s1'), row('s2')]);
    expect(listTrash(localStorage).map(i => i.id).sort()).toEqual(['s1', 's2']);
  });

  it('lists newest first', () => {
    putTrash(localStorage, 'expenses', row('old'), Date.parse('2026-09-01T00:00:00Z'));
    putTrash(localStorage, 'expenses', row('new'), Date.parse('2026-09-10T00:00:00Z'));
    expect(listTrash(localStorage).map(i => i.id)).toEqual(['new', 'old']);
  });
});

describe('re-deleting the same row', () => {
  it('replaces its entry instead of stacking a second copy', () => {
    // delete → undo → delete again must leave ONE row in the bin.
    putTrash(localStorage, 'expenses', row('e1'));
    putTrash(localStorage, 'expenses', row('e1', { amount: 999 }));
    const out = listTrash(localStorage);
    expect(out).toHaveLength(1);
    expect(out[0].amount).toBe(999);
  });

  it('keys on table AND id — two tables can share an id', () => {
    putTrash(localStorage, 'expenses', row('x'));
    putTrash(localStorage, 'incomes', row('x'));
    expect(listTrash(localStorage)).toHaveLength(2);
  });
});

describe('bounds', () => {
  it('drops entries past the 30-day window', () => {
    const now = Date.parse('2026-10-01T00:00:00Z');
    putTrash(localStorage, 'expenses', row('stale'), now - 31 * 864e5);
    putTrash(localStorage, 'expenses', row('fresh'), now - 2 * 864e5);
    expect(listTrash(localStorage, now).map(i => i.id)).toEqual(['fresh']);
  });

  it('caps the blob so a bulk delete cannot blow the localStorage quota', () => {
    // The real ledger backup lives in the same store — the bin must never be
    // what takes it down.
    putTrash(localStorage, 'expenses', Array.from({ length: TRASH_CAP + 50 }, (_, i) => row(`e${i}`)));
    expect(listTrash(localStorage)).toHaveLength(TRASH_CAP);
  });

  it('survives a corrupted blob rather than throwing', () => {
    localStorage.setItem(TRASH_KEY, '{not json');
    expect(listTrash(localStorage)).toEqual([]);
    putTrash(localStorage, 'expenses', row('e1'));
    expect(listTrash(localStorage)).toHaveLength(1);
  });

  it('ignores rows with no id', () => {
    putTrash(localStorage, 'expenses', [{ amount: 5 }, row('ok')]);
    expect(listTrash(localStorage).map(i => i.id)).toEqual(['ok']);
  });
});

describe('removeTrash / clearTrash', () => {
  it('removes exactly one row, by table and id', () => {
    putTrash(localStorage, 'expenses', [row('a'), row('b')]);
    removeTrash(localStorage, 'expenses', 'a');
    expect(listTrash(localStorage).map(i => i.id)).toEqual(['b']);
  });

  it('empties the bin', () => {
    putTrash(localStorage, 'expenses', row('a'));
    clearTrash(localStorage);
    expect(listTrash(localStorage)).toEqual([]);
  });
});

describe('mergeTrash', () => {
  const server = [{ id: 'e1', _tbl: 'expenses', amount: 100, deleted_at: '2026-09-10T00:00:00Z' }];
  const local = [
    { id: 'e1', _tbl: 'expenses', amount: 999, deleted_at: '2026-09-10T00:00:00Z' }, // same row, stale local copy
    { id: 'e2', _tbl: 'expenses', amount: 50, deleted_at: '2026-09-11T00:00:00Z' },  // delete still in the offline queue
  ];

  it('keeps the SERVER copy on conflict — it is the cross-device record', () => {
    const out = mergeTrash(server, local);
    expect(out.find(i => i.id === 'e1').amount).toBe(100);
  });

  it('keeps local-only rows the server has no tombstone for yet', () => {
    expect(mergeTrash(server, local).map(i => i.id).sort()).toEqual(['e1', 'e2']);
  });

  it('works with no server at all — the local-only case', () => {
    expect(mergeTrash(null, local).map(i => i.id).sort()).toEqual(['e1', 'e2']);
  });

  it('returns newest first', () => {
    expect(mergeTrash(server, local)[0].id).toBe('e2');
  });
});
