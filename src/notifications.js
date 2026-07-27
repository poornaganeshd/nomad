// Notification centre store — the durable half of the toast system.
//
// Toasts are ephemeral by design: they confirm an action you just took
// ("Expense added") and vanish. Reminders are the opposite — they arrive
// unprompted on the first open of a new day, stack three-deep over the
// dashboard, and are gone in two seconds whether or not you read them. Those
// belong in a list you can come back to.
//
// So: anything that TELLS YOU SOMETHING NEEDS DOING is recorded here (bills
// due, IOUs outstanding, budget overspend, sync failures); anything that
// CONFIRMS SOMETHING YOU JUST DID is not. `NOTIFY_KINDS` is the whole
// vocabulary — call `pushNotification` with one of them.
//
// Storage is localStorage only (`nomad-notifications-v1`), never synced to
// Supabase: these are per-device nudges derived from data that already syncs,
// so mirroring them would just duplicate rows and fight across devices.

export const STORAGE_KEY = "nomad-notifications-v1";
const MAX_ITEMS = 60;

// kind → presentation. `tone` maps onto the app's semantic colour tokens.
export const NOTIFY_KINDS = {
  bill:    { tone: "warn",   label: "Bill" },
  iou:     { tone: "warn",   label: "IOU" },
  budget:  { tone: "danger", label: "Budget" },
  sync:    { tone: "danger", label: "Sync" },
  goal:    { tone: "pos",    label: "Goal" },
  streak:  { tone: "acc",    label: "Streak" },
  info:    { tone: "acc",    label: "NOMAD" },
};

const read = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter(n => n && typeof n.id === "string") : [];
  } catch { return []; }
};

const write = list => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_ITEMS))); }
  catch { /* quota — non-fatal, the list is a convenience */ }
  return list.slice(0, MAX_ITEMS);
};

/** Newest first. Never throws — a corrupt/blocked store reads as empty. */
export function getNotifications() {
  return read().sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
}

export function unreadCount(list) {
  return (list || getNotifications()).filter(n => !n.read).length;
}

/**
 * Record a reminder.
 *
 * `id` is a stable dedupe key — pass one that encodes the day for daily
 * reminders (`bill-<id>-2026-07-27`) so the same nudge can't pile up on every
 * remount, but can legitimately reappear tomorrow. Re-pushing an existing id
 * refreshes its text and leaves its read state alone.
 *
 * @returns the stored list (newest first).
 */
export function pushNotification({ id, kind = "info", title, body = "", ts, meta }) {
  if (!id || !title) return getNotifications();
  const list = read();
  const at = ts || new Date().toISOString();
  const existing = list.find(n => n.id === id);
  if (existing) {
    existing.title = title;
    existing.body = body;
    if (meta !== undefined) existing.meta = meta;
    write(list);
    return getNotifications();
  }
  list.unshift({ id, kind: NOTIFY_KINDS[kind] ? kind : "info", title, body, ts: at, read: false, ...(meta !== undefined && { meta }) });
  write(list);
  return getNotifications();
}

/** Push many at once — one write instead of N. */
export function pushNotifications(items) {
  (items || []).forEach(it => pushNotification(it));
  return getNotifications();
}

export function markRead(id) {
  const list = read();
  const n = list.find(x => x.id === id);
  if (n) { n.read = true; write(list); }
  return getNotifications();
}

export function markAllRead() {
  const list = read();
  list.forEach(n => { n.read = true; });
  write(list);
  return getNotifications();
}

export function dismissNotification(id) {
  write(read().filter(n => n.id !== id));
  return getNotifications();
}

export function clearNotifications() {
  write([]);
  return [];
}

/** "just now" / "3h ago" / "12 Jul" — compact enough for a list row. */
export function relTime(ts, now = new Date()) {
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Math.max(0, now.getTime() - t);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(t).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}
