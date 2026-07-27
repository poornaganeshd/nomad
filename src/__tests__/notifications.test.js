import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  STORAGE_KEY,
  NOTIFY_KINDS,
  getNotifications,
  pushNotification,
  pushNotifications,
  markRead,
  markAllRead,
  dismissNotification,
  clearNotifications,
  reconcileNotifications,
  unreadCount,
  relTime,
} from '../notifications.js';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('pushNotification', () => {
  it('stores a notification and persists it to localStorage', () => {
    pushNotification({ id: 'bill-rent-2026-07-27', kind: 'bill', title: 'Rent is due', body: '₹12,000' });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY))).toHaveLength(1);
    const list = getNotifications();
    expect(list[0]).toMatchObject({ id: 'bill-rent-2026-07-27', kind: 'bill', title: 'Rent is due', read: false });
  });

  it('dedupes by id and refreshes the text without resetting read state', () => {
    pushNotification({ id: 'iou-rakesh', kind: 'iou', title: 'You owe ₹117.5 — Rakesh' });
    markRead('iou-rakesh');
    pushNotification({ id: 'iou-rakesh', kind: 'iou', title: 'You owe ₹60 — Rakesh' });
    const list = getNotifications();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('You owe ₹60 — Rakesh');
    expect(list[0].read).toBe(true);
  });

  it('ignores entries with no id or no title', () => {
    pushNotification({ kind: 'bill', title: 'nope' });
    pushNotification({ id: 'x', kind: 'bill' });
    expect(getNotifications()).toHaveLength(0);
  });

  it('falls back to the info kind for an unknown kind', () => {
    pushNotification({ id: 'a', kind: 'wat', title: 'Hello' });
    expect(getNotifications()[0].kind).toBe('info');
  });

  it('every declared kind has a tone and a label', () => {
    Object.values(NOTIFY_KINDS).forEach(k => {
      expect(typeof k.tone).toBe('string');
      expect(typeof k.label).toBe('string');
    });
  });

  it('caps the stored list so the key cannot grow forever', () => {
    for (let i = 0; i < 80; i++) pushNotification({ id: 'n' + i, title: 'note ' + i });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)).length).toBeLessThanOrEqual(60);
  });
});

describe('ordering and read state', () => {
  it('returns newest first regardless of insertion order', () => {
    pushNotification({ id: 'old', title: 'Old', ts: '2026-07-20T10:00:00.000Z' });
    pushNotification({ id: 'new', title: 'New', ts: '2026-07-27T10:00:00.000Z' });
    pushNotification({ id: 'mid', title: 'Mid', ts: '2026-07-24T10:00:00.000Z' });
    expect(getNotifications().map(n => n.id)).toEqual(['new', 'mid', 'old']);
  });

  it('unreadCount tracks markRead and markAllRead', () => {
    pushNotifications([
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
      { id: 'c', title: 'C' },
    ]);
    expect(unreadCount()).toBe(3);
    markRead('b');
    expect(unreadCount()).toBe(2);
    markAllRead();
    expect(unreadCount()).toBe(0);
  });

  it('markRead on a missing id is a no-op', () => {
    pushNotification({ id: 'a', title: 'A' });
    expect(() => markRead('ghost')).not.toThrow();
    expect(unreadCount()).toBe(1);
  });
});

describe('removal', () => {
  it('dismissNotification removes only that entry', () => {
    pushNotifications([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]);
    dismissNotification('a');
    expect(getNotifications().map(n => n.id)).toEqual(['b']);
  });

  it('clearNotifications empties the store', () => {
    pushNotifications([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]);
    expect(clearNotifications()).toEqual([]);
    expect(getNotifications()).toHaveLength(0);
  });
});

describe('resilience', () => {
  it('reads corrupt JSON as an empty list', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    expect(getNotifications()).toEqual([]);
  });

  it('drops malformed rows from a hand-edited store', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([{ id: 'ok', title: 'Fine' }, null, { title: 'no id' }]));
    expect(getNotifications().map(n => n.id)).toEqual(['ok']);
  });

  it('survives a write failure (quota) without throwing', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    expect(() => pushNotification({ id: 'a', title: 'A' })).not.toThrow();
  });
});

describe('relTime', () => {
  const now = new Date('2026-07-27T12:00:00.000Z');

  it('renders sub-minute as "just now"', () => {
    expect(relTime('2026-07-27T11:59:40.000Z', now)).toBe('just now');
  });

  it('renders minutes, hours and days', () => {
    expect(relTime('2026-07-27T11:25:00.000Z', now)).toBe('35m ago');
    expect(relTime('2026-07-27T09:00:00.000Z', now)).toBe('3h ago');
    expect(relTime('2026-07-25T12:00:00.000Z', now)).toBe('2d ago');
  });

  it('falls back to a date beyond a week', () => {
    expect(relTime('2026-07-10T12:00:00.000Z', now)).toMatch(/Jul/);
  });

  it('returns an empty string for an unparseable timestamp', () => {
    expect(relTime('not-a-date', now)).toBe('');
  });

  it('never goes negative for a clock-skewed future stamp', () => {
    expect(relTime('2026-07-27T13:00:00.000Z', now)).toBe('just now');
  });
});

describe('reconcileNotifications — an entry is a claim, not a log line', () => {
  it('drops a derived entry once its cause is gone', () => {
    pushNotifications([
      { id: 'owe-rakesh-2026-07-27', kind: 'iou', title: 'You owe ₹117.5 — Rakesh' },
      { id: 'rec-rent-2026-07-27', kind: 'bill', title: 'Rent is due' },
    ]);
    // Rakesh settled; rent still outstanding.
    const list = reconcileNotifications(new Set(['rec-rent-2026-07-27']));
    expect(list.map(n => n.id)).toEqual(['rec-rent-2026-07-27']);
  });

  it('keeps derived entries that are still live', () => {
    pushNotification({ id: 'owe-raj-2026-07-27', kind: 'iou', title: 'You owe ₹60 — Raj' });
    expect(reconcileNotifications(['owe-raj-2026-07-27'])).toHaveLength(1);
  });

  it('accepts an array as well as a Set', () => {
    pushNotification({ id: 'a', kind: 'bill', title: 'A' });
    expect(reconcileNotifications([])).toHaveLength(0);
  });

  it('never auto-removes non-derived kinds', () => {
    pushNotifications([
      { id: 'g1', kind: 'goal', title: 'Goal reached' },
      { id: 's1', kind: 'streak', title: '30-day trail' },
      { id: 'i1', kind: 'info', title: 'Heads up' },
      { id: 'b1', kind: 'bill', title: 'Rent is due' },
    ]);
    const list = reconcileNotifications(new Set());
    expect(list.map(n => n.id).sort()).toEqual(['g1', 'i1', 's1']);
  });

  it('clears every derived entry when nothing is outstanding', () => {
    pushNotifications([
      { id: 'a', kind: 'iou', title: 'A' },
      { id: 'b', kind: 'bill', title: 'B' },
      { id: 'c', kind: 'budget', title: 'C' },
      { id: 'd', kind: 'sync', title: 'D' },
    ]);
    expect(reconcileNotifications(new Set())).toHaveLength(0);
  });

  it('sweeps yesterday\'s day-scoped copy so the list cannot grow per-day', () => {
    pushNotifications([
      { id: 'owe-rakesh-2026-07-26', kind: 'iou', title: 'You owe ₹117.5 — Rakesh' },
      { id: 'owe-rakesh-2026-07-27', kind: 'iou', title: 'You owe ₹117.5 — Rakesh' },
    ]);
    const list = reconcileNotifications(new Set(['owe-rakesh-2026-07-27']));
    expect(list.map(n => n.id)).toEqual(['owe-rakesh-2026-07-27']);
  });

  it('preserves read state and metadata of surviving entries', () => {
    pushNotification({ id: 'keep', kind: 'iou', title: 'Keep', meta: { go: 'iou', person: 'raj' } });
    markRead('keep');
    const [n] = reconcileNotifications(['keep']);
    expect(n.read).toBe(true);
    expect(n.meta).toEqual({ go: 'iou', person: 'raj' });
  });

  it('does not write when nothing changed', () => {
    pushNotification({ id: 'a', kind: 'bill', title: 'A' });
    const spy = vi.spyOn(Storage.prototype, 'setItem');
    reconcileNotifications(['a']);
    expect(spy).not.toHaveBeenCalled();
  });

  it('is a no-op on an empty store', () => {
    expect(reconcileNotifications(new Set(['anything']))).toEqual([]);
  });
});

describe('reconcileNotifications — refreshing a claim that changed', () => {
  it('rewrites the title when the amount moved but the debt remains', () => {
    pushNotification({ id: 'owe-rakesh-2026-07-27', kind: 'iou', title: 'You owe ₹300 — Rakesh' });
    const list = reconcileNotifications([
      { id: 'owe-rakesh-2026-07-27', title: 'You owe ₹60 — Rakesh', body: 'Tap to open and settle up' },
    ]);
    expect(list[0].title).toBe('You owe ₹60 — Rakesh');
    expect(list[0].body).toBe('Tap to open and settle up');
  });

  it('keeps read state across a refresh — you just made that payment', () => {
    pushNotification({ id: 'x', kind: 'iou', title: 'You owe ₹300 — Rakesh' });
    markRead('x');
    const [n] = reconcileNotifications([{ id: 'x', title: 'You owe ₹60 — Rakesh' }]);
    expect(n.title).toBe('You owe ₹60 — Rakesh');
    expect(n.read).toBe(true);
  });

  it('leaves the text alone for a live marker with no title (budget/sync)', () => {
    pushNotification({ id: 'budget-food-2026-07', kind: 'budget', title: 'Food budget exceeded' });
    const [n] = reconcileNotifications([{ id: 'budget-food-2026-07' }]);
    expect(n.title).toBe('Food budget exceeded');
  });

  it('still accepts a plain Set of ids', () => {
    pushNotifications([{ id: 'a', kind: 'iou', title: 'A' }, { id: 'b', kind: 'iou', title: 'B' }]);
    expect(reconcileNotifications(new Set(['a'])).map(n => n.id)).toEqual(['a']);
  });

  it('does not write when the title is unchanged', () => {
    pushNotification({ id: 'a', kind: 'bill', title: 'Rent is due' });
    const spy = vi.spyOn(Storage.prototype, 'setItem');
    reconcileNotifications([{ id: 'a', title: 'Rent is due' }]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('prunes and refreshes in the same pass', () => {
    pushNotifications([
      { id: 'gone', kind: 'iou', title: 'You owe ₹50 — Settled' },
      { id: 'moved', kind: 'iou', title: 'You owe ₹300 — Rakesh' },
    ]);
    const list = reconcileNotifications([{ id: 'moved', title: 'You owe ₹60 — Rakesh' }]);
    expect(list.map(n => n.id)).toEqual(['moved']);
    expect(list[0].title).toBe('You owe ₹60 — Rakesh');
  });
});
