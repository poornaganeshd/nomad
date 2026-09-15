import { describe, it, expect } from 'vitest';
import { mergeRemote, hasSyncedOnce } from '../syncMerge.js';

// Settlements are the one table sbDeleteRow HARD-deletes, so the server keeps
// no tombstone. That made "missing from the remote read" ambiguous, and
// mergeRemote resolved it the dangerous way: it called every such row an
// orphan, and load()'s heal() pass re-uploaded it.
//
// The real-world failure: delete a settlement on your phone; your laptop still
// has it locally, sees it missing remotely, and pushes it back. The cash
// returns to the wallet — and because the delete also reopened the linked IOU
// (settled:false, skipped:false) and that reopen DID sync, the same money is
// now counted twice: once as a settlement, once as a pending IOU.
//
// created_at is the discriminator. It is DB-owned (deliberately absent from
// COLS), so it only ever appears on a row that has come back from Supabase.

const deps = { isPendingDelete: () => false, isPendingUpsert: () => false };
const synced = (id) => ({ id, amount: 100, created_at: '2026-09-10T10:00:00Z', createdAt: '2026-09-10T10:00:00Z' });
const neverSynced = (id) => ({ id, amount: 100, createdAt: '2026-09-10T10:00:00Z' });

describe('hasSyncedOnce', () => {
  it('trusts only the DB-owned created_at, never the client createdAt', () => {
    expect(hasSyncedOnce(synced('a'))).toBe(true);
    expect(hasSyncedOnce(neverSynced('a'))).toBe(false);
    expect(hasSyncedOnce(null)).toBe(false);
  });
});

describe('mergeRemote on a hard-deleted table', () => {
  it('drops a settlement another device deleted instead of healing it back', () => {
    const r = mergeRemote({ table: 'settlements', remote: [], local: [synced('s1')], ...deps, hardDeleted: true });
    expect(r.next).toEqual([]);          // gone locally too
    expect(r.orphans).toEqual([]);       // and never re-uploaded
    expect(r.vanished.map(x => x.id)).toEqual(['s1']);
  });

  it('still heals a settlement whose upload was genuinely lost', () => {
    const r = mergeRemote({ table: 'settlements', remote: [], local: [neverSynced('s2')], ...deps, hardDeleted: true });
    expect(r.next.map(x => x.id)).toEqual(['s2']);
    expect(r.orphans.map(x => x.id)).toEqual(['s2']);
    expect(r.vanished).toEqual([]);
  });

  it('keeps a synced row whose local edit is still queued', () => {
    const r = mergeRemote({
      table: 'settlements', remote: [], local: [synced('s3')],
      isPendingDelete: () => false, isPendingUpsert: () => true, hardDeleted: true,
    });
    expect(r.next.map(x => x.id)).toEqual(['s3']);
    expect(r.vanished).toEqual([]);
  });

  it('does not resurrect a row this device just deleted', () => {
    const r = mergeRemote({
      table: 'settlements', remote: [], local: [synced('s4')],
      isPendingDelete: () => true, isPendingUpsert: () => false, hardDeleted: true,
    });
    expect(r.next).toEqual([]);
    expect(r.orphans).toEqual([]);
  });
});

describe('soft-delete tables are unchanged', () => {
  // Expenses/splits/… keep tombstones, so a missing row really can be a lost
  // write and rule 2c still applies — a synced expense absent from remote must
  // still heal, exactly as before.
  it('heals a synced expense missing from remote (tombstones cover the delete case)', () => {
    const r = mergeRemote({ table: 'expenses', remote: [], local: [synced('e1')], ...deps });
    expect(r.orphans.map(x => x.id)).toEqual(['e1']);
    expect(r.next.map(x => x.id)).toEqual(['e1']);
    expect(r.vanished).toEqual([]);
  });

  it('drops one the server tombstoned', () => {
    const r = mergeRemote({ table: 'expenses', remote: [], local: [synced('e2')], ...deps, remoteDeletedIds: ['e2'] });
    expect(r.next).toEqual([]);
    expect(r.orphans).toEqual([]);
  });
});
