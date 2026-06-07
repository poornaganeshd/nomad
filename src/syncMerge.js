// Bug-proofing layer for the Supabase ↔ local-state reconcile that runs on
// every page load. The original `load()` REPLACED state with whatever
// Supabase returned, which raced the fire-and-forget upserts in addE/addI
// and could silently drop a freshly-added expense (or its receipt_url) when
// sbGet beat the sync queue. Then the 800ms localStorage backup would
// overwrite nomad-v5 with the wiped state — permanent data loss.
//
// `mergeRemote` is a pure function so it can be unit-tested in isolation.
// The reconcile rules:
//
//   1. Rows in the remote response that have a queued soft-delete are
//      dropped (they're about to be PATCH'd out remotely).
//   2. Rows present in local but missing from remote are KEPT in state if
//      ANY of:
//        a. they have a queued upsert (race with flushSyncQueue), or
//        b. they have a queued delete (intentional removal — caller filters
//           them out via #1 above; this just guarantees no resurrection), or
//        c. they're orphans — no queue entry at all. We assume the write was
//           silently dropped (4xx, dead-letter, etc.) and we don't want to
//           lose the row. The caller is expected to re-queue these as a
//           self-heal pass so they eventually reach the server.
//
// The MERGE returns the orphan list separately so the caller can re-queue
// only those without colliding with rows that are already in flight.

export function mergeRemote({ table, remote, local, isPendingDelete, isPendingUpsert, remoteDeletedIds }) {
  const safeRemote = Array.isArray(remote) ? remote : [];
  const safeLocal  = Array.isArray(local)  ? local  : [];
  // IDs the SERVER has soft-deleted (tombstones). A delete made on another
  // device lands here; without dropping these, a stale local backup keeps the
  // row visible forever and re-heals it → permanent cross-device divergence.
  const deletedSet = remoteDeletedIds instanceof Set
    ? remoteDeletedIds
    : new Set(Array.isArray(remoteDeletedIds) ? remoteDeletedIds : []);

  // Step 1: drop remote rows that are pending a delete locally.
  const visibleRemote = safeRemote.filter(r => r && r.id != null && !isPendingDelete(table, r.id));
  const remoteIds = new Set(visibleRemote.map(r => r.id));

  // Step 2: classify local-only rows.
  const localOnly = safeLocal.filter(r => r && r.id != null && !remoteIds.has(r.id));

  // Drop local-only rows the server has tombstoned (deleted on another device),
  // UNLESS this device has a pending upsert for it — a genuine local re-add
  // that should win over the remote delete.
  const notRemotelyDeleted = localOnly.filter(r => !deletedSet.has(r.id) || isPendingUpsert(table, r.id));

  // Pending delete → drop (user explicitly removed it).
  const localOnlyNotPendingDelete = notRemotelyDeleted.filter(r => !isPendingDelete(table, r.id));

  const queued = localOnlyNotPendingDelete.filter(r => isPendingUpsert(table, r.id));
  const orphans = localOnlyNotPendingDelete.filter(r => !isPendingUpsert(table, r.id));

  // Rows present in BOTH local and remote: the remote copy is normally the
  // server-of-record and wins. EXCEPTION — if this device still has a pending
  // upsert queued for that id (an offline edit that hasn't flushed yet, e.g.
  // migrating a receipt to Cloudinary or discarding a local copy), keep the
  // LOCAL row. Otherwise a remote read that lands before the queue drains
  // reverts the edit, and the change appears to "come back" until sync runs.
  const localById = new Map(safeLocal.filter(r => r && r.id != null).map(r => [r.id, r]));
  const reconciledRemote = visibleRemote.map(r =>
    isPendingUpsert(table, r.id) && localById.has(r.id) ? localById.get(r.id) : r
  );

  // Local-only rows go first so the newest unsynced additions stay on top of
  // history lists; remote rows follow in their server-supplied order.
  return {
    next: [...queued, ...orphans, ...reconciledRemote],
    orphans,
  };
}

// Heuristic: only auto-re-queue rows whose `created_at` falls within the
// recent past. Anything older is more likely to be intentionally absent
// from the remote (legitimate cross-device delete, a Clear-All-Data on
// another device, etc.) than a freshly-lost write. Recent rows are almost
// certainly an unsynced add the user just made.
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function isRecentRow(row, now = Date.now()) {
  if (!row) return false;
  const ts = row.created_at || row.createdAt;
  if (!ts) return true; // no timestamp → assume recent (safer than dropping)
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return true;
  return (now - t) <= RECENT_WINDOW_MS;
}
