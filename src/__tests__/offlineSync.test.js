import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module isolation
// We re-import the module fresh for each test group that cares about
// module-level state (the `listeners` Set and `syncInitialized` flag).
// ---------------------------------------------------------------------------

const QUEUE_KEY = 'nomad-sync-queue-v1';

const makeItem = (overrides = {}) => ({
  path: 'https://example.supabase.co/rest/v1/expenses',
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ amount: 100 }),
  dedupeKey: null,
  ...overrides,
});

// ---------------------------------------------------------------------------
// getPendingSyncCount
// ---------------------------------------------------------------------------
describe('getPendingSyncCount', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('returns 0 when queue is empty', async () => {
    const { getPendingSyncCount } = await import('../offlineSync.js');
    expect(getPendingSyncCount()).toBe(0);
  });

  it('returns the number of items in the queue', async () => {
    const items = [makeItem(), makeItem({ path: '/other' })];
    localStorage.setItem(QUEUE_KEY, JSON.stringify(items));
    const { getPendingSyncCount } = await import('../offlineSync.js');
    expect(getPendingSyncCount()).toBe(2);
  });

  it('returns 0 when localStorage has invalid JSON', async () => {
    localStorage.setItem(QUEUE_KEY, 'bad json');
    const { getPendingSyncCount } = await import('../offlineSync.js');
    expect(getPendingSyncCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// subscribePendingSync
// ---------------------------------------------------------------------------
describe('subscribePendingSync', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('calls listener immediately with current count', async () => {
    const { subscribePendingSync } = await import('../offlineSync.js');
    const listener = vi.fn();
    subscribePendingSync(listener);
    expect(listener).toHaveBeenCalledWith(0);
  });

  it('calls listener when queue changes via queueSupabaseRequest', async () => {
    const { subscribePendingSync, queueSupabaseRequest } = await import('../offlineSync.js');
    const counts = [];
    subscribePendingSync((c) => counts.push(c));
    queueSupabaseRequest(makeItem());
    expect(counts).toEqual([0, 1]);
  });

  it('returned unsubscribe function stops further notifications', async () => {
    const { subscribePendingSync, queueSupabaseRequest } = await import('../offlineSync.js');
    const listener = vi.fn();
    const unsub = subscribePendingSync(listener);
    unsub();
    queueSupabaseRequest(makeItem());
    // listener called once on subscribe, never again after unsub
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// queueSupabaseRequest
// ---------------------------------------------------------------------------
describe('queueSupabaseRequest', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('adds an item to the queue', async () => {
    const { queueSupabaseRequest, getPendingSyncCount } = await import('../offlineSync.js');
    queueSupabaseRequest(makeItem());
    expect(getPendingSyncCount()).toBe(1);
  });

  it('deduplicates items sharing the same dedupeKey', async () => {
    const { queueSupabaseRequest, getPendingSyncCount } = await import('../offlineSync.js');
    queueSupabaseRequest(makeItem({ dedupeKey: 'expenses:upsert:1' }));
    queueSupabaseRequest(makeItem({ dedupeKey: 'expenses:upsert:1', body: JSON.stringify({ amount: 200 }) }));
    expect(getPendingSyncCount()).toBe(1);
    // The second item (latest) should be the one kept
    const raw = JSON.parse(localStorage.getItem(QUEUE_KEY));
    expect(JSON.parse(raw[0].body).amount).toBe(200);
  });

  it('keeps distinct items when dedupeKey is null', async () => {
    const { queueSupabaseRequest, getPendingSyncCount } = await import('../offlineSync.js');
    queueSupabaseRequest(makeItem({ dedupeKey: null }));
    queueSupabaseRequest(makeItem({ dedupeKey: null }));
    expect(getPendingSyncCount()).toBe(2);
  });

  it('keeps distinct items with different dedupeKeys', async () => {
    const { queueSupabaseRequest, getPendingSyncCount } = await import('../offlineSync.js');
    queueSupabaseRequest(makeItem({ dedupeKey: 'key-a' }));
    queueSupabaseRequest(makeItem({ dedupeKey: 'key-b' }));
    expect(getPendingSyncCount()).toBe(2);
  });

  it('merges bodies on dedup: fields from first write that second omits are preserved', async () => {
    const { queueSupabaseRequest } = await import('../offlineSync.js');
    // First write has amount + note; second edit only changes amount
    queueSupabaseRequest(makeItem({
      dedupeKey: 'expenses:upsert:1',
      body: JSON.stringify([{ id: '1', amount: 100, note: 'coffee' }]),
    }));
    queueSupabaseRequest(makeItem({
      dedupeKey: 'expenses:upsert:1',
      body: JSON.stringify([{ id: '1', amount: 200 }]),
    }));
    const raw = JSON.parse(localStorage.getItem(QUEUE_KEY));
    const row = JSON.parse(raw[0].body)[0];
    expect(row.amount).toBe(200);  // new field wins
    expect(row.note).toBe('coffee'); // old field preserved
  });
});

// ---------------------------------------------------------------------------
// sendSupabaseRequest
// ---------------------------------------------------------------------------
describe('sendSupabaseRequest', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
    // Default: online
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ok:true and drops dedupe-keyed item from queue on success', async () => {
    const { sendSupabaseRequest, queueSupabaseRequest, getPendingSyncCount } = await import('../offlineSync.js');
    // Pre-queue an item with the same dedupeKey
    queueSupabaseRequest(makeItem({ dedupeKey: 'expenses:upsert:5' }));
    expect(getPendingSyncCount()).toBe(1);

    global.fetch = vi.fn().mockResolvedValueOnce({ ok: true });
    const result = await sendSupabaseRequest(makeItem({ dedupeKey: 'expenses:upsert:5' }));

    expect(result.ok).toBe(true);
    expect(result.queued).toBe(false);
    expect(result.offline).toBe(false);
    expect(getPendingSyncCount()).toBe(0);
  });

  it('queues the request when offline', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    const { sendSupabaseRequest, getPendingSyncCount } = await import('../offlineSync.js');

    const result = await sendSupabaseRequest(makeItem());
    expect(result.ok).toBe(false);
    expect(result.queued).toBe(true);
    expect(result.offline).toBe(true);
    expect(getPendingSyncCount()).toBe(1);
  });

  it('does not queue when offline and queueIfOffline:false', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    const { sendSupabaseRequest, getPendingSyncCount } = await import('../offlineSync.js');

    const result = await sendSupabaseRequest(makeItem(), { queueIfOffline: false });
    expect(result.queued).toBe(false);
    expect(getPendingSyncCount()).toBe(0);
  });

  it('queues on 5xx server error', async () => {
    const { sendSupabaseRequest, getPendingSyncCount } = await import('../offlineSync.js');
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 });

    const result = await sendSupabaseRequest(makeItem());
    expect(result.ok).toBe(false);
    expect(result.queued).toBe(true);
    expect(getPendingSyncCount()).toBe(1);
  });

  it('does not queue on 4xx client error', async () => {
    const { sendSupabaseRequest, getPendingSyncCount } = await import('../offlineSync.js');
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 400 });

    const result = await sendSupabaseRequest(makeItem());
    expect(result.ok).toBe(false);
    expect(result.queued).toBe(false);
    expect(getPendingSyncCount()).toBe(0);
  });

  it('queues when fetch throws (network failure)', async () => {
    const { sendSupabaseRequest, getPendingSyncCount } = await import('../offlineSync.js');
    global.fetch = vi.fn().mockRejectedValueOnce(new Error('Failed to fetch'));

    const result = await sendSupabaseRequest(makeItem());
    expect(result.ok).toBe(false);
    expect(result.queued).toBe(true);
    expect(result.offline).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// flushSyncQueue
// ---------------------------------------------------------------------------
describe('flushSyncQueue', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns synced:0 pending:0 when queue is empty', async () => {
    const { flushSyncQueue } = await import('../offlineSync.js');
    const result = await flushSyncQueue();
    expect(result).toEqual({ synced: 0, pending: 0 });
  });

  it('returns synced:0 pending:N when offline', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    const { flushSyncQueue, queueSupabaseRequest } = await import('../offlineSync.js');
    queueSupabaseRequest(makeItem());
    const result = await flushSyncQueue();
    expect(result.synced).toBe(0);
    expect(result.pending).toBe(1);
  });

  it('processes all items when all succeed', async () => {
    const { flushSyncQueue, queueSupabaseRequest, getPendingSyncCount } = await import('../offlineSync.js');
    queueSupabaseRequest(makeItem());
    queueSupabaseRequest(makeItem({ path: '/other' }));
    global.fetch = vi.fn().mockResolvedValue({ ok: true });

    const result = await flushSyncQueue();
    expect(result.synced).toBe(2);
    expect(result.pending).toBe(0);
    expect(getPendingSyncCount()).toBe(0);
  });

  it('retains 5xx item in queue but continues processing subsequent items', async () => {
    const { flushSyncQueue, queueSupabaseRequest } = await import('../offlineSync.js');
    queueSupabaseRequest(makeItem({ path: '/first' }));
    queueSupabaseRequest(makeItem({ path: '/second' }));
    queueSupabaseRequest(makeItem({ path: '/third' }));

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true })               // first succeeds
      .mockResolvedValueOnce({ ok: false, status: 503 }) // second: 5xx → stays (retry 1)
      .mockResolvedValueOnce({ ok: true }));             // third succeeds (still attempted)

    const result = await flushSyncQueue();
    expect(result.synced).toBe(2);   // first + third
    expect(result.pending).toBe(1);  // second still in queue
  });

  it('moves 5xx item to dead-letter after MAX_ITEM_RETRIES failures', async () => {
    const { flushSyncQueue, getDeadLetterCount } = await import('../offlineSync.js');
    // Queue item already at MAX_ITEM_RETRIES - 1 retries
    const item = makeItem({ path: '/poison' });
    localStorage.setItem(QUEUE_KEY, JSON.stringify([{ ...item, id: 'x1', _retries: 2 }]));

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    const result = await flushSyncQueue();
    expect(result.synced).toBe(0);
    expect(result.pending).toBe(0);          // removed from main queue
    expect(getDeadLetterCount()).toBe(1);    // moved to dead-letter
  });

  it('discards 4xx items and continues with rest', async () => {
    const { flushSyncQueue, queueSupabaseRequest } = await import('../offlineSync.js');
    queueSupabaseRequest(makeItem({ path: '/first' }));
    queueSupabaseRequest(makeItem({ path: '/second' }));

    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 400 }) // first: 4xx discarded
      .mockResolvedValueOnce({ ok: true });               // second: success

    const result = await flushSyncQueue();
    expect(result.synced).toBe(1);
    expect(result.pending).toBe(0);
  });

  it('stops processing and retains all on network error', async () => {
    const { flushSyncQueue, queueSupabaseRequest } = await import('../offlineSync.js');
    queueSupabaseRequest(makeItem({ path: '/a' }));
    queueSupabaseRequest(makeItem({ path: '/b' }));

    global.fetch = vi.fn().mockRejectedValue(new Error('Network down'));

    const result = await flushSyncQueue();
    expect(result.synced).toBe(0);
    expect(result.pending).toBe(2);
  });

  it('drops 412 conflict as kind:conflict and continues', async () => {
    const { flushSyncQueue, queueSupabaseRequest, subscribeSyncDrops } = await import('../offlineSync.js');
    queueSupabaseRequest(makeItem({ path: '/conflict' }));
    queueSupabaseRequest(makeItem({ path: '/ok' }));

    const drops = [];
    subscribeSyncDrops(info => drops.push(info));

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 412 }) // conflict → drop
      .mockResolvedValueOnce({ ok: true }));              // second succeeds

    const result = await flushSyncQueue();
    expect(result.synced).toBe(1);
    expect(result.pending).toBe(0);
    expect(drops).toHaveLength(1);
    expect(drops[0].kind).toBe('conflict');
    expect(drops[0].status).toBe(412);
  });

  it('strips If-Unmodified-Since from headers during flush replay', async () => {
    const { flushSyncQueue, queueSupabaseRequest } = await import('../offlineSync.js');
    queueSupabaseRequest(makeItem({
      headers: { 'Content-Type': 'application/json', 'If-Unmodified-Since': '2026-05-01T00:00:00Z' },
    }));

    const captured = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      captured.push(opts.headers);
      return Promise.resolve({ ok: true });
    }));

    await flushSyncQueue();
    expect(captured[0]).not.toHaveProperty('If-Unmodified-Since');
    expect(captured[0]).toHaveProperty('Content-Type');
  });
});

// ---------------------------------------------------------------------------
// isPendingDelete
// ---------------------------------------------------------------------------
describe('isPendingDelete', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false when the queue is empty', async () => {
    const { isPendingDelete } = await import('../offlineSync.js');
    expect(isPendingDelete('expenses', 'abc123')).toBe(false);
  });

  it('returns true when a matching soft-delete is queued', async () => {
    const { isPendingDelete, queueSupabaseRequest } = await import('../offlineSync.js');
    queueSupabaseRequest(makeItem({ dedupeKey: 'expenses:delete:abc123' }));
    expect(isPendingDelete('expenses', 'abc123')).toBe(true);
  });

  it('returns false when queue has items but none match table+id', async () => {
    const { isPendingDelete, queueSupabaseRequest } = await import('../offlineSync.js');
    queueSupabaseRequest(makeItem({ dedupeKey: 'expenses:delete:other-id' }));
    queueSupabaseRequest(makeItem({ dedupeKey: 'splits:delete:abc123' }));
    expect(isPendingDelete('expenses', 'abc123')).toBe(false);
  });

  it('matches table and id independently', async () => {
    const { isPendingDelete, queueSupabaseRequest } = await import('../offlineSync.js');
    queueSupabaseRequest(makeItem({ dedupeKey: 'splits:delete:abc123' }));
    expect(isPendingDelete('splits', 'abc123')).toBe(true);
    expect(isPendingDelete('expenses', 'abc123')).toBe(false);
    expect(isPendingDelete('splits', 'other-id')).toBe(false);
  });

  it('returns false after flush successfully processes the delete', async () => {
    const { isPendingDelete, queueSupabaseRequest, flushSyncQueue } = await import('../offlineSync.js');
    queueSupabaseRequest(makeItem({ dedupeKey: 'expenses:delete:abc123' }));
    expect(isPendingDelete('expenses', 'abc123')).toBe(true);

    global.fetch = vi.fn().mockResolvedValueOnce({ ok: true });
    await flushSyncQueue();

    expect(isPendingDelete('expenses', 'abc123')).toBe(false);
  });

  it('works with invalid queue JSON (returns false, does not throw)', async () => {
    const { isPendingDelete } = await import('../offlineSync.js');
    localStorage.setItem(QUEUE_KEY, 'not-valid-json');
    expect(() => isPendingDelete('expenses', 'abc')).not.toThrow();
    expect(isPendingDelete('expenses', 'abc')).toBe(false);
  });
});
