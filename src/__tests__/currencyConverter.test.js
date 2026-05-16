import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { getExchangeRate, saveCurrencyMeta, getCurrencyMeta } from '../currencyConverter.js';

const RATE_CACHE_KEY = 'nomad-fx-rates';
const META_KEY = 'nomad-currency-meta';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// getExchangeRate
// ---------------------------------------------------------------------------
describe('getExchangeRate', () => {
  it('returns 1 for INR', async () => {
    expect(await getExchangeRate('INR')).toBe(1);
    expect(await getExchangeRate('inr')).toBe(1);
  });

  it('returns 1 for empty string', async () => {
    expect(await getExchangeRate('')).toBe(1);
    expect(await getExchangeRate('  ')).toBe(1);
  });

  it('returns cached rate when available and fresh', async () => {
    const cache = { USD: { rate: 83.5, fetchedAt: Date.now() } };
    localStorage.setItem(RATE_CACHE_KEY, JSON.stringify(cache));
    const rate = await getExchangeRate('USD');
    expect(rate).toBe(83.5);
  });

  it('ignores cached rate older than 24h', async () => {
    const cache = { USD: { rate: 83.5, fetchedAt: Date.now() - 25 * 60 * 60 * 1000 } };
    localStorage.setItem(RATE_CACHE_KEY, JSON.stringify(cache));
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ usd: { inr: 90 } }) });
    const rate = await getExchangeRate('USD');
    expect(rate).toBe(90);
  });

  it('fetches from API and caches when no cached rate', async () => {
    const mockRate = 83.12;
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ usd: { inr: mockRate } }),
    });

    const rate = await getExchangeRate('USD');
    expect(rate).toBe(mockRate);
    expect(global.fetch).toHaveBeenCalledOnce();

    const cached = JSON.parse(localStorage.getItem(RATE_CACHE_KEY));
    expect(cached.USD.rate).toBe(mockRate);
    expect(typeof cached.USD.fetchedAt).toBe('number');
  });

  it('returns null when fetch response is not ok', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: false });
    const rate = await getExchangeRate('XYZ');
    expect(rate).toBeNull();
  });

  it('returns null when API response missing the inr field', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ eur: {} }),
    });
    const rate = await getExchangeRate('EUR');
    expect(rate).toBeNull();
  });

  it('returns null when both primary and fallback throw', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
    const rate = await getExchangeRate('GBP');
    expect(rate).toBeNull();
  });

  it('falls back to secondary CDN when primary fails', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ gbp: { inr: 105 } }) });
    const rate = await getExchangeRate('GBP');
    expect(rate).toBe(105);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('normalises currency to uppercase before lookup', async () => {
    const cache = { USD: { rate: 83.5, fetchedAt: Date.now() } };
    localStorage.setItem(RATE_CACHE_KEY, JSON.stringify(cache));
    expect(await getExchangeRate('usd')).toBe(83.5);
    expect(await getExchangeRate(' USD ')).toBe(83.5);
  });

  it('does not hit the API on a second call for the same currency', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ usd: { inr: 83 } }),
    });
    await getExchangeRate('USD');
    await getExchangeRate('USD');
    expect(global.fetch).toHaveBeenCalledOnce();
  });

  it('concurrent calls for the same currency share one fetch (in-flight dedup)', async () => {
    let resolveFetch;
    global.fetch = vi.fn().mockReturnValueOnce(
      new Promise(res => {
        resolveFetch = () => res({ ok: true, json: async () => ({ eur: { inr: 90 } }) });
      })
    );

    // Fire two calls before the first fetch resolves
    const p1 = getExchangeRate('EUR');
    const p2 = getExchangeRate('EUR');

    // Only one network request should have been initiated
    expect(global.fetch).toHaveBeenCalledOnce();

    resolveFetch();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe(90);
    expect(r2).toBe(90);
    expect(global.fetch).toHaveBeenCalledOnce(); // still one total
  });

  it('a call after in-flight resolves uses cache, not another fetch', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jpy: { inr: 0.55 } }),
    });

    await getExchangeRate('JPY');         // fetches + caches
    const r2 = await getExchangeRate('JPY'); // should hit cache

    expect(r2).toBe(0.55);
    expect(global.fetch).toHaveBeenCalledOnce();
  });

  it('in-flight dedup cleans up on failure so retry is possible', async () => {
    global.fetch = vi.fn()
      .mockRejectedValueOnce(new Error('network down')) // first call fails
      .mockRejectedValueOnce(new Error('network down')) // fallback also fails
      .mockResolvedValueOnce({ ok: true, json: async () => ({ chf: { inr: 95 } }) }) // primary succeeds on retry
      .mockResolvedValueOnce({ ok: true, json: async () => ({ chf: { inr: 95 } }) }); // fallback (unused)

    const r1 = await getExchangeRate('CHF');  // fails → null, map entry removed
    expect(r1).toBeNull();

    const r2 = await getExchangeRate('CHF');  // retries fresh
    expect(r2).toBe(95);
  });
});

// ---------------------------------------------------------------------------
// saveCurrencyMeta / getCurrencyMeta
// ---------------------------------------------------------------------------
describe('saveCurrencyMeta & getCurrencyMeta', () => {
  it('stores and retrieves meta for a transaction', () => {
    saveCurrencyMeta('tx-001', 'USD', 100, 83.5);
    expect(getCurrencyMeta('tx-001')).toMatchObject({
      currency: 'USD',
      originalAmount: 100,
      rateUsed: 83.5,
    });
  });

  it('records fetchedAt timestamp', () => {
    saveCurrencyMeta('tx-time', 'USD', 100, 83);
    const meta = getCurrencyMeta('tx-time');
    expect(typeof meta.fetchedAt).toBe('number');
    expect(meta.fetchedAt).toBeGreaterThan(0);
  });

  it('normalises currency to uppercase', () => {
    saveCurrencyMeta('tx-002', 'eur', 50, 90.2);
    expect(getCurrencyMeta('tx-002').currency).toBe('EUR');
  });

  it('returns null for unknown transaction id', () => {
    expect(getCurrencyMeta('unknown-tx')).toBeNull();
  });

  it('overwrites existing meta for the same transaction', () => {
    saveCurrencyMeta('tx-003', 'USD', 100, 83);
    saveCurrencyMeta('tx-003', 'GBP', 200, 105);
    expect(getCurrencyMeta('tx-003')).toMatchObject({
      currency: 'GBP',
      originalAmount: 200,
      rateUsed: 105,
    });
  });

  it('stores multiple transactions independently', () => {
    saveCurrencyMeta('tx-a', 'USD', 10, 83);
    saveCurrencyMeta('tx-b', 'EUR', 20, 90);
    expect(getCurrencyMeta('tx-a').currency).toBe('USD');
    expect(getCurrencyMeta('tx-b').currency).toBe('EUR');
  });

  it('returns null when localStorage has invalid JSON', () => {
    localStorage.setItem(META_KEY, '{{invalid}');
    expect(getCurrencyMeta('any')).toBeNull();
  });
});
