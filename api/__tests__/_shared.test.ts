import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeHeaders, getPeriod, getNextSendAt, withRetry } from '../_shared.js';
import type { Schedule } from '../_shared.js';

// ---------------------------------------------------------------------------
// Minimal schedule factory
// ---------------------------------------------------------------------------
const makeSchedule = (overrides: Partial<Schedule> = {}): Schedule => ({
  id: 'sched-1',
  user_id: 'user-1',
  email: 'test@example.com',
  frequency: 'weekly',
  custom_days: null,
  send_hour: 8,
  send_day_of_week: null,
  send_day_of_month: null,
  include_expenses: true,
  include_incomes: true,
  include_transfers: false,
  selected_categories: null,
  next_send_at: '2024-04-15T08:00:00Z',
  is_active: true,
  ...overrides,
});

// ---------------------------------------------------------------------------
// makeHeaders
// ---------------------------------------------------------------------------
describe('makeHeaders', () => {
  it('returns the correct header shape', () => {
    const headers = makeHeaders('my-anon-key');
    expect(headers).toEqual({
      'Content-Type': 'application/json',
      apikey: 'my-anon-key',
      Authorization: 'Bearer my-anon-key',
      Prefer: 'return=representation',
    });
  });

  it('uses the provided key in both apikey and Authorization', () => {
    const key = 'secret-key-xyz';
    const headers = makeHeaders(key);
    expect(headers.apikey).toBe(key);
    expect(headers.Authorization).toBe(`Bearer ${key}`);
  });
});

// ---------------------------------------------------------------------------
// getPeriod
// ---------------------------------------------------------------------------
describe('getPeriod', () => {
  const now = new Date('2024-04-15T12:00:00Z');

  it('weekly: returns last 7 days (yesterday as end)', () => {
    const s = makeSchedule({ frequency: 'weekly' });
    const { start, end } = getPeriod(s, now);
    // end = yesterday
    expect(end.toISOString().slice(0, 10)).toBe('2024-04-14');
    // start = 7 days ago
    expect(start.toISOString().slice(0, 10)).toBe('2024-04-08');
  });

  it('monthly: returns the full previous calendar month', () => {
    const s = makeSchedule({ frequency: 'monthly' });
    const { start, end } = getPeriod(s, now);
    expect(start.toISOString().slice(0, 10)).toBe('2024-03-01');
    expect(end.toISOString().slice(0, 10)).toBe('2024-03-31');
  });

  it('quarterly: returns last 3 calendar months', () => {
    const s = makeSchedule({ frequency: 'quarterly' });
    const { start, end } = getPeriod(s, now);
    expect(start.toISOString().slice(0, 10)).toBe('2024-01-01');
    expect(end.toISOString().slice(0, 10)).toBe('2024-03-31');
  });

  it('custom: returns the last N days (custom_days)', () => {
    const s = makeSchedule({ frequency: 'custom', custom_days: 14 });
    const { start, end } = getPeriod(s, now);
    expect(end.toISOString().slice(0, 10)).toBe('2024-04-14');
    expect(start.toISOString().slice(0, 10)).toBe('2024-04-01');
  });

  it('custom falls back to 7 days when custom_days is null', () => {
    const s = makeSchedule({ frequency: 'custom', custom_days: null });
    const { start, end } = getPeriod(s, now);
    expect(end.toISOString().slice(0, 10)).toBe('2024-04-14');
    expect(start.toISOString().slice(0, 10)).toBe('2024-04-08');
  });
});

// ---------------------------------------------------------------------------
// getNextSendAt
// ---------------------------------------------------------------------------
describe('getNextSendAt', () => {
  const now = new Date('2024-04-15T08:00:00Z');

  it('weekly: adds 7 days', () => {
    const s = makeSchedule({ frequency: 'weekly', send_hour: 8 });
    const next = getNextSendAt(s, now);
    expect(next.toISOString().slice(0, 10)).toBe('2024-04-22');
    // 8 AM IST = 2:30 AM UTC
    expect(next.getUTCHours()).toBe(2);
    expect(next.getUTCMinutes()).toBe(30);
  });

  it('weekly with send_day_of_week adjusts to correct weekday', () => {
    // now = April 15, 2024 (Monday = 1). Ask for Wednesday = 3.
    const s = makeSchedule({ frequency: 'weekly', send_day_of_week: 3, send_hour: 9 });
    const next = getNextSendAt(s, now);
    expect(next.getUTCDay()).toBe(3); // Wednesday
    // 9 AM IST = 3:30 AM UTC
    expect(next.getUTCHours()).toBe(3);
    expect(next.getUTCMinutes()).toBe(30);
  });

  it('monthly: adds 1 month', () => {
    const s = makeSchedule({ frequency: 'monthly', send_hour: 7 });
    const next = getNextSendAt(s, now);
    expect(next.getUTCMonth()).toBe(4); // May (0-indexed)
    // 7 AM IST = 1:30 AM UTC
    expect(next.getUTCHours()).toBe(1);
    expect(next.getUTCMinutes()).toBe(30);
  });

  it('monthly with send_day_of_month clamps to last day of target month', () => {
    // now = April 15 → +1 month = May (31 days). dom=31 fits, no clamp.
    const s = makeSchedule({ frequency: 'monthly', send_day_of_month: 31 });
    const next = getNextSendAt(s, now);
    expect(next.getUTCDate()).toBe(31); // May has 31 days
    // Use January → February to verify clamp: Jan 15 + 1 month = Feb (29 in 2024 leap year)
    const nowJan = new Date('2024-01-15T08:00:00Z');
    const nextFeb = getNextSendAt(s, nowJan);
    expect(nextFeb.getUTCDate()).toBe(29); // Feb 2024 has 29 days (leap year)
  });

  it('monthly does not skip a month when source day exceeds next month length', () => {
    // Regression: previously, setUTCMonth(m+1) on Jan 31 overflowed to Mar 2,
    // skipping Feb entirely and returning the wrong month after clamping.
    const s = makeSchedule({ frequency: 'monthly', send_day_of_month: 15, send_hour: 6 });
    const nowJan31 = new Date('2024-01-31T08:00:00Z');
    const next = getNextSendAt(s, nowJan31);
    expect(next.getUTCMonth()).toBe(1); // February, not March
    expect(next.getUTCDate()).toBe(15);
  });

  it('monthly with no send_day_of_month clamps source day to target month length', () => {
    // Regression: Mar 31 + 1 month should be Apr 30 (not May 1 via overflow).
    const s = makeSchedule({ frequency: 'monthly', send_day_of_month: null, send_hour: 6 });
    const nowMar31 = new Date('2024-03-31T08:00:00Z');
    const next = getNextSendAt(s, nowMar31);
    expect(next.getUTCMonth()).toBe(3); // April
    expect(next.getUTCDate()).toBe(30); // April has 30 days
  });

  it('quarterly does not skip a month when source day exceeds target month length', () => {
    // Regression: Nov 30 + 3 months should land in Feb (29 in leap year, not Mar 2).
    const s = makeSchedule({ frequency: 'quarterly', send_day_of_month: 31, send_hour: 6 });
    const nowNov30 = new Date('2023-11-30T08:00:00Z');
    const next = getNextSendAt(s, nowNov30);
    expect(next.getUTCFullYear()).toBe(2024);
    expect(next.getUTCMonth()).toBe(1); // February
    expect(next.getUTCDate()).toBe(29); // Feb 2024 has 29 days (leap year)
  });

  it('quarterly: adds 3 months', () => {
    const s = makeSchedule({ frequency: 'quarterly', send_hour: 6 });
    const next = getNextSendAt(s, now);
    expect(next.getUTCMonth()).toBe(6); // July
    // 6 AM IST = 0:30 AM UTC
    expect(next.getUTCHours()).toBe(0);
    expect(next.getUTCMinutes()).toBe(30);
  });

  it('custom: adds custom_days', () => {
    const s = makeSchedule({ frequency: 'custom', custom_days: 30, send_hour: 10 });
    const next = getNextSendAt(s, now);
    const expectedDate = new Date(now);
    expectedDate.setUTCDate(expectedDate.getUTCDate() + 30);
    expect(next.toISOString().slice(0, 10)).toBe(expectedDate.toISOString().slice(0, 10));
    // 10 AM IST = 4:30 AM UTC
    expect(next.getUTCHours()).toBe(4);
    expect(next.getUTCMinutes()).toBe(30);
  });

  it('custom falls back to 7 days when custom_days is null', () => {
    // Use send_hour: 6 (6 AM IST = 0:30 UTC — no date rollback) so test focuses on 7-day interval
    const s = makeSchedule({ frequency: 'custom', custom_days: null, send_hour: 6 });
    const next = getNextSendAt(s, now);
    const expectedDate = new Date(now);
    expectedDate.setUTCDate(expectedDate.getUTCDate() + 7);
    expect(next.toISOString().slice(0, 10)).toBe(expectedDate.toISOString().slice(0, 10));
  });

  it('sets seconds and ms to 0 (minutes = 30 due to IST offset)', () => {
    // send_hour is IST; IST = UTC+5:30, so UTC minutes always = 30
    const s = makeSchedule({ frequency: 'weekly', send_hour: 14 });
    const next = getNextSendAt(s, now);
    expect(next.getUTCMinutes()).toBe(30);
    expect(next.getUTCSeconds()).toBe(0);
    expect(next.getUTCMilliseconds()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------
describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns result immediately on first-try success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, 3);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries and succeeds on second attempt', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('recovered');

    const promise = withRetry(fn, 3);
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting all attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));
    const promise = withRetry(fn, 3);
    // Register the rejection handler BEFORE running timers to avoid unhandled-rejection warnings
    const assertion = expect(promise).rejects.toThrow('always fails');
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('defaults to 3 attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));
    const promise = withRetry(fn);
    const assertion = expect(promise).rejects.toThrow('fail');
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// userGetAll — paged reads past Supabase's 1000-row cap
// ---------------------------------------------------------------------------
import { userGetAll, reportTotals, isTrackedExpense } from '../_shared.js';

describe('userGetAll', () => {
  const page = (rows: unknown[], total: number | null, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => rows,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-range' && total != null ? `0-${rows.length - 1}/${total}` : null) },
  });
  const rows = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: from + i }));

  it('walks offset until it holds the reported total', async () => {
    const calls: string[] = [];
    const f = vi.fn(async (url: string) => {
      calls.push(url);
      const off = Number(/offset=(\d+)/.exec(url)![1]);
      return page(rows(off, Math.min(1000, 2345 - off)), 2345);
    });
    const out = await userGetAll('https://x.supabase.co', 'k', '/expenses?select=*', 'date.desc,id.desc', f as unknown as typeof fetch);
    expect(out).toHaveLength(2345);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain('order=date.desc,id.desc');
    expect(calls[1]).toContain('offset=1000');
    expect(calls[2]).toContain('offset=2000');
  });

  it('honours a server page size smaller than 1000', async () => {
    const f = vi.fn(async (url: string) => {
      const off = Number(/offset=(\d+)/.exec(url)![1]);
      return page(rows(off, Math.min(500, 1200 - off)), 1200);
    });
    expect(await userGetAll('https://x.supabase.co', 'k', '/splits', 'id.asc', f as unknown as typeof fetch)).toHaveLength(1200);
  });

  it('stops on a short page when the count header is missing', async () => {
    const f = vi.fn(async (url: string) => {
      const off = Number(/offset=(\d+)/.exec(url)![1]);
      return page(rows(off, off === 0 ? 1000 : 10), null);
    });
    expect(await userGetAll('https://x.supabase.co', 'k', '/splits', 'id.asc', f as unknown as typeof fetch)).toHaveLength(1010);
  });

  it('fails the whole read when any page fails — a partial table is worse than none', async () => {
    const f = vi.fn(async (url: string) => (url.includes('offset=0') ? page(rows(0, 1000), 1500) : page([], null, 500)));
    await expect(userGetAll('https://x.supabase.co', 'k', '/splits', 'id.asc', f as unknown as typeof fetch)).rejects.toThrow(/500/);
  });

  it('returns an empty table without a second request', async () => {
    const f = vi.fn(async () => page([], 0));
    expect(await userGetAll('https://x.supabase.co', 'k', '/splits', 'id.asc', f as unknown as typeof fetch)).toEqual([]);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('reportTotals', () => {
  const e = (amount: number, categoryId: string, walletId = 'bank') => ({ amount, categoryId, walletId, date: '2026-09-01' });

  it('leaves out group expenses someone else paid', () => {
    const t = reportTotals([e(100, 'food'), e(900, 'food', '__tracked__'), e(50, 'travel')], [], []);
    expect(t.totalSpent).toBe(150);
    expect(t.byCategory).toEqual([{ name: 'Food', amount: 100 }, { name: 'Travel', amount: 50 }]);
    expect(isTrackedExpense({ walletId: '__tracked__' })).toBe(true);
  });

  it('sums in paisa, not float dust', () => {
    const t = reportTotals(Array.from({ length: 10 }, () => e(0.1, 'food')), [{ amount: 0.1, sourceId: 's', walletId: 'bank', date: '2026-09-01' }, { amount: 0.2, sourceId: 's', walletId: 'bank', date: '2026-09-01' }], []);
    expect(t.totalSpent).toBe(1);
    expect(t.totalIncome).toBe(0.3);
  });
});
