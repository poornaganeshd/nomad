import { describe, it, expect } from 'vitest';
import { mergeRemote, isRecentRow } from '../syncMerge.js';

// Builders ------------------------------------------------------------------

const row = (id, extras = {}) => ({ id, ...extras });

// Default predicates that return false for everything; tests override per case.
const baseDeps = {
  isPendingDelete: () => false,
  isPendingUpsert: () => false,
};

// Returns deps that mark the given (table, id) pairs as pending.
const depsWith = ({ pendingDelete = [], pendingUpsert = [] } = {}) => ({
  isPendingDelete: (table, id) => pendingDelete.some(p => p.table === table && p.id === id),
  isPendingUpsert: (table, id) => pendingUpsert.some(p => p.table === table && p.id === id),
});

// ---------------------------------------------------------------------------
// mergeRemote — the function this app relies on to never lose new expenses.
// ---------------------------------------------------------------------------

describe('mergeRemote', () => {
  it('returns remote rows when there is no local state', () => {
    const result = mergeRemote({
      table: 'expenses',
      remote: [row('a'), row('b')],
      local: [],
      ...baseDeps,
    });
    expect(result.next.map(r => r.id)).toEqual(['a', 'b']);
    expect(result.orphans).toEqual([]);
  });

  it('returns local rows when remote is empty AND queue is empty (treats them as orphans)', () => {
    // Stale Supabase read scenario — the user added a row, the upsert was
    // silently dropped (4xx, dead-letter), refresh hits before queue retries.
    // Without this guarantee the user permanently loses data.
    const local = [row('x', { amount: 99 })];
    const result = mergeRemote({
      table: 'expenses',
      remote: [],
      local,
      ...baseDeps,
    });
    expect(result.next).toEqual(local);
    expect(result.orphans).toEqual(local);
  });

  it('keeps local rows with a queued upsert (race protection)', () => {
    const local = [row('queued'), row('orphan')];
    const result = mergeRemote({
      table: 'expenses',
      remote: [],
      local,
      ...depsWith({ pendingUpsert: [{ table: 'expenses', id: 'queued' }] }),
    });
    expect(result.next.map(r => r.id).sort()).toEqual(['orphan', 'queued']);
    // Only the truly orphaned row (no queue entry) is returned for self-heal.
    expect(result.orphans.map(r => r.id)).toEqual(['orphan']);
  });

  it('drops local rows that are pending a soft-delete', () => {
    const local = [row('keep'), row('deleted')];
    const result = mergeRemote({
      table: 'expenses',
      remote: [],
      local,
      ...depsWith({ pendingDelete: [{ table: 'expenses', id: 'deleted' }] }),
    });
    expect(result.next.map(r => r.id)).toEqual(['keep']);
    expect(result.orphans.map(r => r.id)).toEqual(['keep']);
  });

  it('drops remote rows that are pending a soft-delete (delete not yet propagated)', () => {
    // User soft-deleted X locally; the PATCH is queued. Remote still shows
    // X because the queue hasn't flushed yet. Without this filter the
    // deletion would reappear after every refresh until the queue drains.
    const result = mergeRemote({
      table: 'expenses',
      remote: [row('X'), row('Y')],
      local: [],
      ...depsWith({ pendingDelete: [{ table: 'expenses', id: 'X' }] }),
    });
    expect(result.next.map(r => r.id)).toEqual(['Y']);
  });

  it('prefers remote when a row exists in both (remote is server-of-record)', () => {
    const local  = [row('a', { amount: 100, note: 'stale' })];
    const remote = [row('a', { amount: 200, note: 'fresh' })];
    const result = mergeRemote({
      table: 'expenses',
      remote,
      local,
      ...baseDeps,
    });
    expect(result.next).toHaveLength(1);
    expect(result.next[0].amount).toBe(200);
    expect(result.next[0].note).toBe('fresh');
    expect(result.orphans).toEqual([]);
  });

  it('keeps the LOCAL row when it exists in both but a local upsert is still pending', () => {
    // Offline receipt migration/discard: the local row has the new value and a
    // queued upsert that hasn't flushed. A remote read before the queue drains
    // must NOT revert the edit back to the stale remote value.
    const local  = [row('a', { amount: 100, receipt_url: 'https://cloudinary/r.jpg' })];
    const remote = [row('a', { amount: 100, receipt_url: 'data:image/jpeg;base64,AAAA' })];
    const result = mergeRemote({
      table: 'expenses',
      remote,
      local,
      ...depsWith({ pendingUpsert: [{ table: 'expenses', id: 'a' }] }),
    });
    expect(result.next).toHaveLength(1);
    expect(result.next[0].receipt_url).toBe('https://cloudinary/r.jpg');
    expect(result.orphans).toEqual([]);
  });

  it('puts local-only rows BEFORE remote so unsynced additions stay on top', () => {
    const result = mergeRemote({
      table: 'expenses',
      remote: [row('remote-1'), row('remote-2')],
      local:  [row('local-only')],
      ...baseDeps,
    });
    expect(result.next.map(r => r.id)).toEqual(['local-only', 'remote-1', 'remote-2']);
  });

  it('scopes pending checks per table (queued in splits should not affect expenses)', () => {
    const result = mergeRemote({
      table: 'expenses',
      remote: [],
      local: [row('id1')],
      ...depsWith({
        pendingUpsert: [{ table: 'splits', id: 'id1' }],
        pendingDelete: [{ table: 'incomes', id: 'id1' }],
      }),
    });
    // No expense queue entry → orphan.
    expect(result.orphans.map(r => r.id)).toEqual(['id1']);
  });

  it('ignores rows with null/undefined id (safety)', () => {
    const result = mergeRemote({
      table: 'expenses',
      remote: [{ amount: 1 }, row('valid')],
      local:  [{ note: 'oops' }, row('local-valid')],
      ...baseDeps,
    });
    expect(result.next.map(r => r.id)).toEqual(['local-valid', 'valid']);
    expect(result.orphans.map(r => r.id)).toEqual(['local-valid']);
  });

  it('handles null/undefined remote and local without throwing', () => {
    expect(() => mergeRemote({ table: 'expenses', remote: null, local: null, ...baseDeps })).not.toThrow();
    const result = mergeRemote({ table: 'expenses', remote: null, local: null, ...baseDeps });
    expect(result.next).toEqual([]);
    expect(result.orphans).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isRecentRow — guardrail so the self-heal doesn't resurrect ancient data
// the user may have intentionally cleared.
// ---------------------------------------------------------------------------

describe('isRecentRow', () => {
  const now = new Date('2026-05-18T12:00:00Z').getTime();

  it('returns true for rows with no timestamp (safer default)', () => {
    expect(isRecentRow({ id: 'a' }, now)).toBe(true);
  });

  it('returns true for rows created within the last 7 days', () => {
    const created_at = new Date(now - 3 * 86400_000).toISOString();
    expect(isRecentRow({ id: 'a', created_at }, now)).toBe(true);
  });

  it('returns false for rows older than 7 days', () => {
    const created_at = new Date(now - 10 * 86400_000).toISOString();
    expect(isRecentRow({ id: 'a', created_at }, now)).toBe(false);
  });

  it('accepts createdAt (camelCase) as well as created_at', () => {
    const createdAt = new Date(now - 1 * 86400_000).toISOString();
    expect(isRecentRow({ id: 'a', createdAt }, now)).toBe(true);
  });

  it('treats malformed timestamps as recent (safer default)', () => {
    expect(isRecentRow({ id: 'a', created_at: 'garbage' }, now)).toBe(true);
  });

  it('returns false for nullish rows', () => {
    expect(isRecentRow(null)).toBe(false);
    expect(isRecentRow(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mergeRemote — server tombstones (cross-device delete propagation).
// Regression: a row deleted on device A must NOT be resurrected on device B
// from B's stale local backup. Without remoteDeletedIds the orphan logic kept
// (and re-healed) it → different totals on different devices.
// ---------------------------------------------------------------------------
describe('mergeRemote — server tombstones', () => {
  it('drops a local-only row the server has soft-deleted (delete propagates)', () => {
    const result = mergeRemote({
      table: 'expenses',
      remote: [row('a')],
      local: [row('a'), row('gone', { amount: 500 })], // 'gone' deleted on another device
      ...baseDeps,
      remoteDeletedIds: new Set(['gone']),
    });
    expect(result.next.map(r => r.id)).toEqual(['a']); // 'gone' dropped
    expect(result.orphans).toEqual([]);                // and NOT re-healed
  });

  it('keeps a tombstoned row when THIS device has a pending re-add (upsert wins)', () => {
    const result = mergeRemote({
      table: 'expenses',
      remote: [],
      local: [row('x')],
      ...depsWith({ pendingUpsert: [{ table: 'expenses', id: 'x' }] }),
      remoteDeletedIds: new Set(['x']),
    });
    expect(result.next.map(r => r.id)).toEqual(['x']);
  });

  it('accepts a plain array for remoteDeletedIds', () => {
    const result = mergeRemote({
      table: 'expenses', remote: [], local: [row('d')], ...baseDeps,
      remoteDeletedIds: ['d'],
    });
    expect(result.next).toEqual([]);
  });

  it('no tombstones (undefined) keeps the existing orphan-preserving behavior', () => {
    const result = mergeRemote({
      table: 'expenses', remote: [], local: [row('keep')], ...baseDeps,
    });
    expect(result.next.map(r => r.id)).toEqual(['keep']);
    expect(result.orphans.map(r => r.id)).toEqual(['keep']);
  });
});
