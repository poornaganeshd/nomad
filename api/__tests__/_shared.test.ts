import { describe, it, expect, vi, beforeEach } from 'vitest';
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

  it('monthly with send_day_of_month clamps to 28', () => {
    const s = makeSchedule({ frequency: 'monthly', send_day_of_month: 31 });
    const next = getNextSendAt(s, now);
    expect(next.getUTCDate()).toBe(28);
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
