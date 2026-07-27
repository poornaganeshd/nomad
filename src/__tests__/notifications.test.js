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
