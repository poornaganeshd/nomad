const RATE_CACHE_KEY = "nomad-fx-rates";
const META_KEY = "nomad-currency-meta";
const RATE_TTL_MS = 24 * 60 * 60 * 1000;

const PRIMARY_CDN  = "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies";
const FALLBACK_CDN = "https://latest.currency-api.pages.dev/v1/currencies";

function getCachedRate(currency) {
  try {
    const cache = JSON.parse(localStorage.getItem(RATE_CACHE_KEY) || "{}");
    const entry = cache[currency];
    if (!entry || typeof entry !== "object") return null;
    if (typeof entry.rate !== "number") return null;
    if (typeof entry.fetchedAt !== "number") return null;
    if (Date.now() - entry.fetchedAt > RATE_TTL_MS) return null;
    return entry.rate;
  } catch { return null; }
}

function saveRateCache(currency, rate) {
  try {
    const raw = localStorage.getItem(RATE_CACHE_KEY);
    const cache = raw ? JSON.parse(raw) : {};
    cache[currency] = { rate, fetchedAt: Date.now() };
    localStorage.setItem(RATE_CACHE_KEY, JSON.stringify(cache));
  } catch { /* quota or serialization failure — non-fatal */ }
}

async function fetchRateFrom(baseUrl, lower) {
  const res = await fetch(`${baseUrl}/${lower}.json`);
  if (!res.ok) return null;
  const data = await res.json();
  const rate = data?.[lower]?.inr;
  return typeof rate === "number" ? rate : null;
}

export async function getExchangeRate(fromCurrency) {
  const c = fromCurrency.trim().toUpperCase();
  if (!c || c === "INR") return 1;
  const cached = getCachedRate(c);
  if (cached !== null) return cached;
  const lower = c.toLowerCase();
  let rate = null;
  try { rate = await fetchRateFrom(PRIMARY_CDN, lower); } catch { rate = null; }
  if (rate === null) {
    try { rate = await fetchRateFrom(FALLBACK_CDN, lower); } catch { rate = null; }
  }
  if (rate === null) return null;
  saveRateCache(c, rate);
  return rate;
}

export function saveCurrencyMeta(txId, currency, originalAmount, rateUsed) {
  try {
    const meta = JSON.parse(localStorage.getItem(META_KEY) || "{}");
    meta[txId] = { currency: currency.toUpperCase(), originalAmount, rateUsed, fetchedAt: Date.now() };
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch { /* quota — non-fatal */ }
}

export function getCurrencyMeta(txId) {
  try {
    const meta = JSON.parse(localStorage.getItem(META_KEY) || "{}");
    return meta[txId] || null;
  } catch { return null; }
}
