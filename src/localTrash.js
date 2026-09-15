// localTrash.js — a 30-day recycle bin that does not need a server.
//
// "Recently Deleted" was built on `sbGetDeleted`, which reads rows whose
// `deleted_at` the server has stamped. That makes it invisible in LOCAL-ONLY
// mode — which is the app's actual onboarding path (`localMode = !creds.sbUrl`,
// new users land straight in with everything in localStorage). So for the users
// most likely to be experimenting, and most likely to delete the wrong thing, a
// delete was permanent the moment the undo toast timed out. There is no way to
// tell them that, either: the section renders, it is just always empty.
//
// This mirrors every soft delete into localStorage so the bin works with no
// credentials at all. In cloud mode it ALSO covers the window where a delete is
// still sitting in the offline queue — the server has no tombstone yet, so
// sbGetDeleted cannot see it, but the row is already gone from the screen.
//
// Deliberately NOT synced: it is a per-device convenience over rows that
// already sync, and a second copy of deleted data in Supabase is the opposite
// of what someone deleting things wants.
//
// Pure except for the storage handle, which every function takes, so tests get
// a clean instance without module-level state.

export const TRASH_KEY = "nomad-trash-v1";
export const TRASH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
// Bounds the blob so a bulk delete can never push localStorage over quota and
// take the REAL data down with it — the backup lives in the same store.
export const TRASH_CAP = 200;

const read = (storage) => {
  try {
    const raw = JSON.parse(storage.getItem(TRASH_KEY) || "null");
    const items = Array.isArray(raw?.items) ? raw.items : [];
    return items.filter(i => i && i.id != null && typeof i._tbl === "string");
  } catch { return []; }
};

const write = (storage, items) => {
  try { storage.setItem(TRASH_KEY, JSON.stringify({ v: 1, items })); }
  catch { /* quota — the bin is a convenience, never worth failing a delete for */ }
  return items;
};

/** Newest first, with anything past the 30-day window already dropped. */
export const listTrash = (storage = globalThis.localStorage, now = Date.now()) => {
  const cutoff = now - TRASH_WINDOW_MS;
  return read(storage)
    .filter(i => {
      const t = new Date(i.deleted_at).getTime();
      return Number.isFinite(t) && t >= cutoff;
    })
    .sort((a, b) => String(b.deleted_at).localeCompare(String(a.deleted_at)));
};

/**
 * Record rows as deleted. `rows` may be one row or many; each is stamped with
 * the table it came from so restore knows where to put it back.
 *
 * Re-deleting an id replaces its entry rather than stacking a second copy —
 * delete → undo → delete again must leave ONE row in the bin, not two, or the
 * bin starts showing the same expense three times.
 */
export const putTrash = (storage = globalThis.localStorage, table, rows, now = Date.now()) => {
  const list = Array.isArray(rows) ? rows : [rows];
  const stamped = list
    .filter(r => r && r.id != null)
    .map(r => ({ ...r, _tbl: table, deleted_at: r.deleted_at || new Date(now).toISOString() }));
  if (!stamped.length) return listTrash(storage, now);
  const ids = new Set(stamped.map(r => `${table}:${r.id}`));
  const kept = listTrash(storage, now).filter(i => !ids.has(`${i._tbl}:${i.id}`));
  return write(storage, [...stamped, ...kept].slice(0, TRASH_CAP));
};

/** Take one row back out — used when it is restored, or hard-deleted for good. */
export const removeTrash = (storage = globalThis.localStorage, table, id, now = Date.now()) =>
  write(storage, listTrash(storage, now).filter(i => !(i._tbl === table && i.id === id)));

export const clearTrash = (storage = globalThis.localStorage) => write(storage, []);

/**
 * Merge the server's tombstones with the local bin, newest first.
 *
 * The server wins on conflict: it is the cross-device record, and its row has
 * been through `toSB` so its shape is canonical. The local copy still matters
 * for rows whose delete has not flushed yet — those exist in no tombstone table
 * anywhere, and without this they are simply unrecoverable.
 */
export const mergeTrash = (serverItems, localItems) => {
  const out = [];
  const seen = new Set();
  const add = (i) => {
    if (!i || i.id == null) return;
    const k = `${i._tbl}:${i.id}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(i);
  };
  (serverItems || []).forEach(add);
  (localItems || []).forEach(add);
  return out.sort((a, b) => String(b.deleted_at || "").localeCompare(String(a.deleted_at || "")));
};
