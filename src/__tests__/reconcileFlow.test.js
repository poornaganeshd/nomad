// Regression suite for the EXACT failure mode that the user reported:
//
//   "new expense with receipt are not getting logged. receipts are not
//    showing in history tab. entries after refresh doesn't adding in history."
//
// The reconcile flow is: addE() updates state + fires sbUpsert →
// (sometimes 5xx → queued, sometimes 4xx → silently dropped) → user refreshes
// → load() runs loadLocalBackup + flushSyncQueue + sbGet → mergeRemote
// produces the next state. Pre-fix, mergeRemote was a REPLACE which dropped
// any locally-known row missing from Supabase. This suite locks in the
// behavior so a future refactor can't regress.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mergeRemote } from '../syncMerge.js';

const QUEUE_KEY = 'nomad-sync-queue-v1';

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Helper to wire mergeRemote against the live offlineSync queue.
async function reconcile(table, remote, local) {
  const { isPendingDelete, isPendingUpsert } = await import('../offlineSync.js');
  return mergeRemote({ table, remote, local, isPendingDelete, isPendingUpsert });
}

// Helper to queue a real upsert (mirrors what sbUpsert does in App.jsx).
async function enqueueUpsert(table, row, dedupeKey = null) {
  const { queueSupabaseRequest } = await import('../offlineSync.js');
  queueSupabaseRequest({
    path: `https://x.supabase.co/rest/v1/${table}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([row]),
    dedupeKey,
  });
}

async function enqueueSoftDelete(table, id) {
  const { queueSupabaseRequest } = await import('../offlineSync.js');
  queueSupabaseRequest({
    path: `https://x.supabase.co/rest/v1/${table}?id=eq.${id}`,
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deleted_at: new Date().toISOString() }),
    dedupeKey: `${table}:delete:${id}`,
  });
}

// ---------------------------------------------------------------------------
// User-reported scenario: add expense → 5xx → queue → refresh → stale GET
// ---------------------------------------------------------------------------

describe('reconcile: race between sync queue and Supabase fetch', () => {
  it('preserves a queued expense that has not yet reached Supabase', async () => {
    // Simulates: user added an expense, sbUpsert returned 5xx and queued.
    // User refreshes before queue flushes. sbGet returns the pre-add snapshot.
    await enqueueUpsert('expenses', { id: 'new-1', amount: 500, receipt_url: 'https://res.cloudinary.com/x.jpg' });

    const localBackup = [
      { id: 'old-1', amount: 100 },
      { id: 'new-1', amount: 500, receipt_url: 'https://res.cloudinary.com/x.jpg' },
    ];
    const remoteAfterStaleGet = [{ id: 'old-1', amount: 100 }];

    const merged = await reconcile('expenses', remoteAfterStaleGet, localBackup);
    expect(merged.next.map(r => r.id).sort()).toEqual(['new-1', 'old-1']);
    // The receipt_url MUST survive the merge.
    const recovered = merged.next.find(r => r.id === 'new-1');
    expect(recovered.receipt_url).toBe('https://res.cloudinary.com/x.jpg');
    // It's queued, so it's NOT an orphan — the queue will sync it on its own.
    expect(merged.orphans).toEqual([]);
  });

  it('preserves a queued row even when local backup is missing it', async () => {
    // Edge case: queue has the row but the localStorage backup hasn't been
    // written yet (within the 800ms debounce). After loadLocalBackup the
    // state would be missing the row — but we still must surface it.
    // (In production, App.jsx reads localStorage AFTER queue flush, so this
    // case is the "queue flushed, remote now has it" path.)
    await enqueueUpsert('expenses', { id: 'new-1', amount: 500 });

    const merged = await reconcile('expenses', [{ id: 'new-1', amount: 500 }], []);
    // Remote already has it, so it's not local-only — the merge just returns
    // the remote row.
    expect(merged.next.map(r => r.id)).toEqual(['new-1']);
    expect(merged.orphans).toEqual([]);
  });

  it('keeps an orphaned row even when no queue entry exists (4xx silent fail)', async () => {
    // Simulates: addE fired sbUpsert which returned 4xx (e.g. schema gap).
    // No queue entry. Without merge protection the row would be silently
    // lost on next refresh. With protection, it's marked as an orphan so
    // the caller can self-heal.
    const localBackup = [{ id: 'silent-loss', amount: 200, created_at: '2026-05-18T10:00:00Z' }];
    const merged = await reconcile('expenses', [], localBackup);
    expect(merged.next.map(r => r.id)).toEqual(['silent-loss']);
    expect(merged.orphans.map(r => r.id)).toEqual(['silent-loss']);
  });
});

// ---------------------------------------------------------------------------
// Soft-delete propagation still works end-to-end.
// ---------------------------------------------------------------------------

describe('reconcile: pending soft-delete behavior', () => {
  it('drops a row whose soft-delete is still in the queue (no resurrection)', async () => {
    await enqueueSoftDelete('expenses', 'goodbye');
    const remote = [{ id: 'goodbye' }, { id: 'keeper' }];
    const merged = await reconcile('expenses', remote, []);
    expect(merged.next.map(r => r.id)).toEqual(['keeper']);
  });

  it('does not orphan a row that is being deleted', async () => {
    await enqueueSoftDelete('expenses', 'goodbye');
    const local = [{ id: 'goodbye' }];
    const merged = await reconcile('expenses', [], local);
    expect(merged.next).toEqual([]);
    expect(merged.orphans).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Multi-table isolation: a queued write to one table cannot affect another.
// ---------------------------------------------------------------------------

describe('reconcile: per-table queue scoping', () => {
  it('a queued expense upsert does not affect income reconcile', async () => {
    await enqueueUpsert('expenses', { id: 'shared-id', amount: 1 });
    const merged = await reconcile('incomes', [], [{ id: 'shared-id', amount: 1 }]);
    // The id matches an expense queue entry, but reconciling incomes treats
    // it as an orphan because there is no incomes-table queue entry.
    expect(merged.orphans.map(r => r.id)).toEqual(['shared-id']);
  });
});

// ---------------------------------------------------------------------------
// The localStorage backup we'd write AFTER merge contains the saved row
// (this is what protects against the "next refresh wipes nomad-v5" loop).
// ---------------------------------------------------------------------------

describe('reconcile: backup-after-merge invariant', () => {
  it('a saved state derived from the merge still contains the queued expense', async () => {
    await enqueueUpsert('expenses', { id: 'new-1', amount: 500 });

    const merged = await reconcile('expenses',
      [{ id: 'old-1', amount: 100 }],                          // stale GET
      [{ id: 'old-1', amount: 100 }, { id: 'new-1', amount: 500 }]  // local backup
    );

    // What App.jsx writes back to nomad-v5 via the 800ms backup useEffect:
    const nextBackup = { expenses: merged.next };
    const ids = nextBackup.expenses.map(r => r.id).sort();
    expect(ids).toEqual(['new-1', 'old-1']);
  });
});
