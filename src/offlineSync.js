const QUEUE_KEY = "nomad-sync-queue-v1";
const DEAD_LETTER_KEY = "nomad-sync-failed-v1";
const REQUEST_TIMEOUT_MS = 15000;
const FLUSH_BACKOFF_BASE_MS = 1000;
const FLUSH_BACKOFF_MAX_MS = 60000;
const MAX_ITEM_RETRIES = 3;

const listeners = new Set();
const dropListeners = new Set();

let consecutiveFlushFailures = 0;
let nextFlushAllowedAt = 0;

const canUseStorage = () => typeof window !== "undefined" && typeof localStorage !== "undefined";

const safeJsonParse = (value, fallback) => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const notifyDrops = (info) => {
  dropListeners.forEach((listener) => {
    try { listener(info); } catch { /* listener errors don't propagate */ }
  });
};

const safeSetItem = (key, value) => {
  if (!canUseStorage()) return false;
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    notifyDrops({ kind: "storage", error: e?.message ?? "storage error" });
    return false;
  }
};

// Merge two JSON bodies for upsert deduplication. New fields win; fields
// present only in the earlier write are preserved so partial edits survive.
const mergeUpsertBodies = (prevBody, nextBody) => {
  if (!prevBody || !nextBody) return nextBody;
  try {
    const a = JSON.parse(prevBody);
    const b = JSON.parse(nextBody);
    if (Array.isArray(a) && Array.isArray(b)) {
      const merged = a.map(row => ({ ...row }));
      b.forEach(newRow => {
        const idx = newRow.id != null ? merged.findIndex(r => r.id === newRow.id) : -1;
        if (idx >= 0) merged[idx] = { ...merged[idx], ...newRow };
        else merged.push(newRow);
      });
      return JSON.stringify(merged);
    }
    if (a && b && typeof a === "object" && typeof b === "object") {
      return JSON.stringify({ ...a, ...b });
    }
    return nextBody;
  } catch {
    return nextBody;
  }
};

const readQueue = () => {
  if (!canUseStorage()) return [];
  return safeJsonParse(localStorage.getItem(QUEUE_KEY) || "[]", []);
};

const writeQueue = (queue) => {
  const ok = safeSetItem(QUEUE_KEY, JSON.stringify(queue));
  if (!ok) return;
  listeners.forEach((listener) => listener(queue.length));
};

export const getPendingSyncCount = () => readQueue().length;

const readDeadLetter = () => {
  if (!canUseStorage()) return [];
  return safeJsonParse(localStorage.getItem(DEAD_LETTER_KEY) || "[]", []);
};

export const getDeadLetterCount = () => readDeadLetter().length;

export const clearDeadLetter = () => {
  if (canUseStorage()) localStorage.removeItem(DEAD_LETTER_KEY);
};

export const subscribePendingSync = (listener) => {
  listeners.add(listener);
  listener(getPendingSyncCount());
  return () => listeners.delete(listener);
};

// Subscribers receive {kind: "rejected"|"storage", status?, item?, error?}
// when an item is dropped from the queue (4xx, status:0, or storage failure).
export const subscribeSyncDrops = (listener) => {
  dropListeners.add(listener);
  return () => dropListeners.delete(listener);
};

const buildQueueItem = ({ path, method = "GET", headers = {}, body = null, dedupeKey = null }) => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  path,
  method,
  headers,
  body,
  dedupeKey,
  createdAt: new Date().toISOString(),
  _retries: 0,
});

const enqueueRequest = (item) => {
  const queue = readQueue();
  if (item.dedupeKey) {
    const existing = queue.find((q) => q.dedupeKey === item.dedupeKey);
    const mergedBody = existing ? mergeUpsertBodies(existing.body, item.body) : item.body;
    const merged = mergedBody !== item.body ? { ...item, body: mergedBody } : item;
    writeQueue([...queue.filter((q) => q.dedupeKey !== item.dedupeKey), merged]);
    return merged;
  }
  writeQueue([...queue, item]);
  return item;
};

const dropQueuedByDedupeKey = (dedupeKey) => {
  if (!dedupeKey) return;
  const queue = readQueue();
  const next = queue.filter((queued) => queued.dedupeKey !== dedupeKey);
  if (next.length !== queue.length) writeQueue(next);
};

const performRequest = (item) => {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS) : null;
  const p = fetch(item.path, {
    method: item.method,
    headers: item.headers,
    body: item.body,
    signal: ctrl?.signal,
  });
  if (timer) {
    p.finally(() => clearTimeout(timer)).catch(() => {});
  }
  return p;
};

export const queueSupabaseRequest = (request) => enqueueRequest(buildQueueItem(request));

export const sendSupabaseRequest = async (request, options = {}) => {
  const item = buildQueueItem(request);
  const shouldQueue = options.queueIfOffline !== false;

  if (typeof navigator !== "undefined" && !navigator.onLine) {
    if (shouldQueue) enqueueRequest(item);
    return { ok: false, queued: shouldQueue, offline: true, response: null };
  }

  try {
    const response = await performRequest(item);
    if (response.ok) {
      dropQueuedByDedupeKey(item.dedupeKey);
      return { ok: true, queued: false, offline: false, response };
    }

    if (response.status >= 500 && shouldQueue) {
      enqueueRequest(item);
      return { ok: false, queued: true, offline: false, response };
    }

    return { ok: false, queued: false, offline: false, response };
  } catch {
    if (shouldQueue) {
      enqueueRequest(item);
      return { ok: false, queued: true, offline: true, response: null };
    }
    return { ok: false, queued: false, offline: true, response: null };
  }
};

export const flushSyncQueue = async () => {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return { synced: 0, pending: getPendingSyncCount() };
  }
  if (Date.now() < nextFlushAllowedAt) {
    return { synced: 0, pending: getPendingSyncCount() };
  }

  const queue = readQueue();
  if (!queue.length) {
    consecutiveFlushFailures = 0;
    nextFlushAllowedAt = 0;
    return { synced: 0, pending: 0 };
  }

  const remaining = [];
  let synced = 0;
  let progressedDuringFlush = false;

  for (let index = 0; index < queue.length; index += 1) {
    const item = queue[index];
    try {
      const response = await performRequest(item);
      if (response.ok) {
        synced += 1;
        progressedDuringFlush = true;
        continue;
      }

      // Server-side problem: track per-item retries; continue to subsequent items.
      if (response.status >= 500) {
        const retries = (item._retries || 0) + 1;
        if (retries >= MAX_ITEM_RETRIES) {
          const dead = readDeadLetter();
          safeSetItem(DEAD_LETTER_KEY, JSON.stringify([...dead, { ...item, _retries: retries }]));
          notifyDrops({ kind: "dead-letter", status: response.status, item });
          progressedDuringFlush = true;
        } else {
          remaining.push({ ...item, _retries: retries });
        }
        continue;
      }

      // Definitive client-side reject (4xx) OR opaque/CORS (status: 0).
      // Drop and notify the UI so the user knows a write was lost.
      progressedDuringFlush = true;
      notifyDrops({ kind: "rejected", status: response.status, item });
      continue;
    } catch {
      // AbortError, network failure, DNS — keep this and the rest, stop.
      remaining.push(item, ...queue.slice(index + 1));
      break;
    }
  }

  writeQueue(remaining);

  if (remaining.length === 0) {
    consecutiveFlushFailures = 0;
    nextFlushAllowedAt = 0;
  } else if (!progressedDuringFlush) {
    consecutiveFlushFailures += 1;
    const delay = Math.min(
      FLUSH_BACKOFF_MAX_MS,
      FLUSH_BACKOFF_BASE_MS * (2 ** (consecutiveFlushFailures - 1))
    );
    nextFlushAllowedAt = Date.now() + delay;
  } else {
    // Made some progress — reset backoff.
    consecutiveFlushFailures = 0;
    nextFlushAllowedAt = 0;
  }

  return { synced, pending: remaining.length };
};

let syncInitialized = false;

export const initOfflineSync = () => {
  if (syncInitialized || typeof window === "undefined") return () => {};
  syncInitialized = true;

  const handleOnline = () => {
    flushSyncQueue().catch(() => {});
  };

  window.addEventListener("online", handleOnline);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") flushSyncQueue().catch(() => {});
  });

  handleOnline();

  return () => {
    window.removeEventListener("online", handleOnline);
  };
};
