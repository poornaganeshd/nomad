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
//
// Rule 2c holds only where the server keeps TOMBSTONES. On a hard-deleted
// table (settlements — sbDeleteRow) a deleted row just disappears, so "missing
// remotely" is ambiguous and `hardDeleted: true` resolves it with the DB-owned
// created_at stamp instead of guessing (see `vanished` below).

// Union two row arrays by id, primary rows winning on conflict. Used by
// load() to merge LIVE React state with the (800ms-debounced) nomad-v5
// backup before reconciling against remote: a row added while the remote
// fetch was in flight exists only in live state — merging against the backup
// alone would wipe it when the (stale) remote response replaces state.
export function unionById(primary, secondary) {
  const safePrimary = Array.isArray(primary) ? primary.filter(r => r && r.id != null) : [];
  const seen = new Set(safePrimary.map(r => r.id));
  const extras = (Array.isArray(secondary) ? secondary : []).filter(r => r && r.id != null && !seen.has(r.id));
  return [...safePrimary, ...extras];
}

// Has this row ever been to the server? `created_at` is DB-OWNED — it is
// deliberately absent from COLS (src/dbCols.js), so the client never sends it
// and it appears on a local row ONLY after that row has come back from
// Supabase. `createdAt` (camelCase) is the client's own stamp and proves
// nothing. This is the whole basis for telling "never uploaded" apart from
// "deleted somewhere else" on a table with no tombstones.
export const hasSyncedOnce = (row) => !!(row && row.created_at);

export function mergeRemote({ table, remote, local, isPendingDelete, isPendingUpsert, remoteDeletedIds, hardDeleted = false }) {
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
  const unqueued = localOnlyNotPendingDelete.filter(r => !isPendingUpsert(table, r.id));

  // HARD-DELETED TABLES (settlements) have no tombstone to read: the row is
  // simply gone from the server, and "gone" looks identical to "my upsert was
  // dropped". Guessing "dropped" and healing it is how a settlement deleted on
  // one device came back: device B still had it locally, found it missing
  // remotely, re-uploaded it, and the cash reappeared in a wallet with the IOU
  // already reopened — the money counted twice, on every device.
  //
  // `created_at` settles it. A row carrying the DB-owned stamp HAS been on the
  // server, so its absence now is a delete: drop it locally and never re-upload
  // it. A row without one never made it there, so it is a genuinely lost write
  // and still heals. Rows with a queued upsert are untouched either way.
  const vanished = hardDeleted ? unqueued.filter(hasSyncedOnce) : [];
  const orphans = hardDeleted ? unqueued.filter(r => !hasSyncedOnce(r)) : unqueued;

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
    vanished,
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
