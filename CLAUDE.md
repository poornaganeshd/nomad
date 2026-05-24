# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**NOMAD** is a personal finance tracker (expenses, income, transfers, recurring bills, splits) with an optional daily-routine sub-app. It is a React 19 + Vite SPA deployed on Vercel, backed by the user's own Supabase project (BYODB model — no central data store).

## Tech stack

- **Frontend:** React 19, Vite, Recharts
- **Backend:** TypeScript, Vercel serverless functions (`api/`)
- **Database:** Supabase (PostgreSQL) — user-hosted, credentials stored in localStorage
- **Image uploads:** Cloudinary
- **Email reports:** Nodemailer (Gmail SMTP)
- **Date utilities:** date-fns

## Commands

```bash
# Development
npm run dev          # Start Vite dev server with HMR

# Build
npm run build        # Production build → dist/

# Lint
npm run lint         # ESLint (JS/JSX only — no TypeScript checker for src/)

# Preview built app
npm run preview

# Test
npm test             # Run all tests once (vitest run)
npm run test:watch   # Run tests in watch mode
npm run test:coverage  # Run tests with v8 coverage report
```

## Testing

These are **automated tests** — running `npm test` executes all 126 test cases automatically with no manual interaction. Vitest finds every `*.test.js` / `*.test.ts` file, runs each `it(...)` case, and reports pass/fail in the terminal.

**When to run them:**
- Before merging any change — catch regressions before they ship
- After refactoring — confirm behaviour is unchanged
- In CI — add `npm test` to a GitHub Actions workflow to validate every push automatically

**What they cover:** Unit tests for pure functions and utility modules (financial calculations, offline queue, credentials, currency conversion, bill reminders, backend scheduling logic). They test logic in isolation with mocked fetch and localStorage.

**What they don't cover:** Full UI interactions (clicking buttons, rendering screens). That would require an end-to-end tool like Playwright or Cypress.

Tests use **Vitest** with a **jsdom** environment (configured in `vite.config.js` under the `test` key). Coverage is collected via `@vitest/coverage-v8`.

### Test file locations

| Source file | Test file |
|---|---|
| `src/financeUtils.js` | `src/__tests__/financeUtils.test.js` |
| `src/billReminders.js` | `src/__tests__/billReminders.test.js` |
| `src/credentials.js` | `src/__tests__/credentials.test.js` |
| `src/currencyConverter.js` | `src/__tests__/currencyConverter.test.js` |
| `src/offlineSync.js` | `src/__tests__/offlineSync.test.js` |
| `api/_shared.ts` | `api/__tests__/_shared.test.ts` |

### Testing conventions

- **localStorage** is provided by jsdom. Call `localStorage.clear()` in `beforeEach`.
- **fetch** is mocked with `global.fetch = vi.fn(...)`. Restore with `vi.restoreAllMocks()` in `afterEach`.
- **navigator.onLine** is set via `Object.defineProperty(navigator, 'onLine', { value: ..., configurable: true })`.
- **offlineSync.js** has module-level state (`listeners` Set, `syncInitialized` flag). Use `vi.resetModules()` + dynamic `import()` inside each test or `describe` block to get a clean module instance.
- **Fake timers** (`vi.useFakeTimers`) — always pair with `afterEach(() => vi.useRealTimers())`. When testing code that throws after all retry attempts, register `expect(promise).rejects` **before** calling `vi.runAllTimersAsync()` to avoid unhandled-rejection warnings.

## Architecture

### Credential / data flow

Each user brings their own Supabase project. On first run, `CredentialSetup.jsx` prompts for a Supabase project URL + anon key (and optional Cloudinary details). These are saved to `localStorage` under the key `nomad-credentials` via `src/credentials.js`. The main app (`App.jsx`) reads them at module load time — `localStorage` credentials take priority over `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` env vars.

### Frontend (`src/`)

- **`App.jsx`** — Single large component (~2 000+ lines) that owns all state and renders the entire app. It contains inline helper functions (`sbGet`, `sbWrite`, `sbUpsert`, `sbDelete`), all date utilities, inline SVG icon components (`DI2`, `Lion`, `LionM`), and every view (expenses, income, transfers, recurring, splits, settings, reports). Avoid splitting it into separate files without a clear need — the current design is intentional.
- **`Routine.jsx`** — Self-contained sub-app for daily food/skincare/habit tracking, accessible from a tab in the main app.
- **`CredentialSetup.jsx`** — Shown in place of the main app when no credentials exist. Also reachable from Settings.
- **`ReceiptPicker.jsx`** — Receipt photo capture/picker for attaching to transactions.
- **`components/TrendChart.jsx`** — Recharts-based spending trend chart.

### Support modules (`src/`)

| File | Purpose |
|---|---|
| `credentials.js` | Read/write Supabase + Cloudinary creds from localStorage |
| `offlineSync.js` | Write-ahead queue for Supabase mutations; replays on reconnect |
| `billReminders.js` | Computes due/upcoming recurring bills for toast reminders |
| `receiptUpload.js` | Compresses images (canvas, 800px / 70% JPEG) then uploads to Cloudinary |
| `currencyConverter.js` | Fetches INR exchange rates (daily-cached in localStorage) |
| `financeUtils.js` | Shared math/date helpers (`roundMoney`, `localDateKey`, period utilities, `distributeAmount`) used across components and tests |

### Offline-first write path

All Supabase writes go through `sendSupabaseRequest` in `offlineSync.js`. If the device is offline or the server returns 5xx, the request is serialised into a localStorage queue (`nomad-sync-queue-v1`) and replayed when the browser comes back online or the tab regains visibility. Deduplication uses `dedupeKey` (e.g. `expenses:delete:<id>`) so repeated mutations collapse.

### Local backup

The full in-memory state is also persisted to `localStorage` key `nomad-v5` as a JSON snapshot and loaded on startup as a fallback when Supabase is unreachable.

### PWA

The app is a Progressive Web App. `public/sw.js` is a cache-first service worker (cache key `nomad-app-v9`) that pre-caches the app shell (`/`, `/manifest.json`, `/icon-192.png`, `/icon-512.png`) on install and serves stale-while-revalidate for navigation requests. `public/manifest.json` declares `display: standalone` so the app installs to the home screen. When updating the service worker, increment `CACHE_NAME` to invalidate old caches.

### Backend (`api/` — Vercel serverless)

| File | Route | Purpose |
|---|---|---|
| `send-reports.ts` | `POST /api/send-reports` (also Vercel cron at `0 2 * * *`) | Reads `user_registry` in the owner's Supabase, iterates all registered users, sends scheduled email reports via Gmail/nodemailer |
| `send-now.ts` | `POST /api/send-now` | Sends a report immediately for a single user (manual trigger from Settings) |
| `setup-user.ts` | `POST /api/setup-user` | Creates report tables in a user's Supabase via the Management API |
| `_shared.ts` | — | Shared utilities: Supabase helpers, period/schedule math, HTML/CSV email builders |

The cron sends email via Gmail (`GMAIL_USER` + `GMAIL_APP_PASSWORD` env vars). The `OWNER_SETUP.md` references Resend, but the current implementation uses nodemailer with Gmail.

### Database (Supabase)

`nomad_setup.sql` is idempotent — safe to re-run. Key tables:

- Core: `expenses`, `incomes`, `transfers`, `settlements`, `splits`, `recurring`, `events`, `wallet_balances`
- Email: `report_schedules`, `report_delivery_log`
- Owner-only: `user_registry` (maps user Supabase URLs for the cron)
- Routine sub-app: `daily_logs`, `user_config`

Row-level security is **disabled** on all tables — access control relies entirely on the anon key being kept private per-user.

### IDs

All record IDs are generated client-side: `Date.now().toString(36) + Math.random().toString(36).slice(2, 6)` (defined as `uid()` in `App.jsx`). There are no server-generated IDs.

### Amounts and currency

All monetary amounts are stored in **INR (₹)**. Foreign-currency input converts at fetch time using `currencyConverter.js`; the original currency + rate are stored separately in localStorage (`nomad-currency-meta`) keyed by transaction ID.

### Hardcoded data

Wallets (`WALLETS`), default expense categories (`DC`), income sources (`DI`), and recurring categories (`RC`) are defined as constants in `App.jsx`. Users can add custom categories/sources; these are stored in Supabase alongside transactions.

## Key source conventions

- `financeUtils.js` contains all pure financial calculations (`roundMoney`, `distributeAmount`, recurring due-date logic, etc.). Keep this file free of side effects — no localStorage, no fetch.
- Supabase writes go through `sendSupabaseRequest` in `offlineSync.js`, which handles offline queuing automatically.
- Credentials (Supabase URL + anon key) are read from localStorage via `getCredentials()` at module load time in `App.jsx`. Build-time env vars (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) are fallbacks.
- The API (`api/`) uses CommonJS (`"type": "commonjs"` in `api/package.json`) while the frontend uses ESM (`"type": "module"` in the root `package.json`). Do not mix them.

## ESLint

`no-unused-vars` is configured to ignore names matching `/^[A-Z_]/` — uppercase constants and component names are exempt. The lint config covers `**/*.{js,jsx}` only; TypeScript files in `api/` are not linted by this config.

## Deployment

Deploy target is Vercel. The cron schedule is defined in `vercel.json`. Required environment variables for the backend:

- `VITE_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — Owner's Supabase (for `user_registry`)
- `GMAIL_USER` / `GMAIL_APP_PASSWORD` — Gmail sender for reports
- `CRON_SECRET` — Shared secret to protect the cron endpoint from external callers

---

## Audit & Fix Log — May 2026

A full system audit was performed on `claude/caveman-feature-34gSb`. This section is the canonical record of what was found, fixed, ruled out, and what remains. Future sessions: **read this before re-investigating any of the items below.**

### A. Summary

| Metric | Count |
|---|---|
| Total findings in audit | ~100 |
| Verified false positives (already correct in code) | 6 |
| Fixed in this branch | 40 |
| Discovered during fix work (new) | 3 |
| Still open | ~55 |

| Commit | Track / Category | Items |
|---|---|---|
| `7d7537f` | Track 1 — stop the bleeding | Cloudinary defaults, full localStorage nuke, `CRON_SECRET` verification |
| `8667faa` | Track 2 — money correctness | Recurring double-pay guard, `submitRec` validation |
| `e6bda13` | Cat 1 — Security | `send-now.ts` registry auth, `setup-user.ts` regex, SW opaque-cache guard |
| `ec782ab` | Cat 2 — Sync hygiene | status-0 drop, AbortController timeout, quota guard, drop-toast channel, exp backoff |
| `f2a60f4` | Cat 3 — Date/timezone | Streak 365 cap → 5000, FX 24h TTL + fallback CDN + `fetchedAt`, `billReminders.addDays` TZ fix |
| `61adcf3` | Cat 4 — Backend/cron | Concurrency=5 + per-user 30s timeout, backup attachment 365-day cap, `prettyCategory()` for CSV/HTML |
| `ee63376` | Cat 5 — Architecture | `updated_at` columns + trigger on all core tables, Settings Sync-Status card |
| `81d0bd4` | Cat 6 — Edge cases | `crypto.randomUUID()`, rename shadowed `uid`→`userKey`, `events.participants` normalize, note 500-char cap, `CredentialSetup` import schema |
| `1c4a3fe` | Cat 7 — UX | Skip button debounce parity, backdating error specifics, "Download backup first" in nuke |
| `94535aa` | E.2 — Sync/Offline | Dedupe body merge, per-item 5xx retry + dead-letter queue (`nomad-sync-failed-v1`) |
| `76ae48d` | E.3 — Date/timezone | Routine streak counts today on first logged action (≥1 point) |
| `36ca28b` | E.3 — Date/timezone | Yearly recurring UI warns when selected day exceeds month's max |
| `760b9a4` | E.6 — Edge cases | Soft delete (`deleted_at`) on 5 tables + "Recently deleted" recovery card in Settings |
| `243557d` | E.6 — Edge cases | UPI Lite month-key slice guard against non-string dates |
| `d7e58e3` | E.5 — Architecture | Auto-inject SW cache version at build time (Vite plugin, no new dep) |
| `59c7a5d` | E.3 — Date/timezone | `send_day_of_month` widened from max-28 to max-31 (UI + scheduler + SQL) |
| `8d7fadf` | E.2 — Sync/Offline | Conflict detection: `If-Unmodified-Since` on recurring edits, 412→drop, header stripped on replay |
| `0080211` | E.1 — Security | Signed Cloudinary uploads via Web Crypto SHA-1; unsigned preset as fallback |

### B. Fixes Completed

> 40 fixes across 18 commits. Each subsection covers one commit. Where a commit closes an item that was originally listed under a category, that item is removed from the open-findings list in section E.

#### B.1 (`7d7537f`) — Track 1: Stop the bleeding

**B.1.a Cloudinary defaults removed — `src/receiptUpload.js:30-32`**
Before: `creds.cloudName || "df1vedbox"` and `creds.uploadPreset || "receipt_upload"`. Every user without their own Cloudinary creds silently uploaded receipts to the original developer's Cloudinary account. After: both fields required; function throws a clear error if either is missing. `df1vedbox` / `receipt_upload` no longer referenced anywhere.

**B.1.b "Clear All Data" sweeps the whole namespace — `src/App.jsx:1418`**
Before: only `nomad-v5` and `nomad-rec-snooze` were cleared from localStorage. After: every `nomad-*` key is removed except `nomad-credentials` (preserved so the user can keep using the app). The critical leak was `nomad-sync-queue-v1`, whose queued mutations would replay against the just-emptied database and recreate ghost rows. Also cleaned: `nomad-currency-meta`, `nomad-fx-rates`, `nomad-bill-reminders-*`, `nomad-last-seen-sent-*`.

**B.1.c `CRON_SECRET` enforcement — `api/send-reports.ts:21`**
Verified already in place: `if (!isVercelCron && authHeader !== \`Bearer ${CRON_SECRET}\` && querySecret !== CRON_SECRET) return 401`. No code change needed.

#### B.2 (`8667faa`) — Track 2: Money correctness

**B.2.a Recurring "✓ Paid" double-click guard — `src/App.jsx:1273`**
The "✓ Paid" button in the Dashboard's due-bills row had no debounce. A fast double-click ran the handler twice before React rerendered to hide the button, creating two duplicate expense rows for one bill cycle. After: handler checks/sets `ev.currentTarget.disabled` at the top:

```js
onClick={(ev) => {
  if (ev.currentTarget.disabled) return;
  ev.currentTarget.disabled = true;
  const ok = addE({...});
  if (ok === false) { ev.currentTarget.disabled = false; return; }
  // ...state updates
}}
```

The button gets unmounted on the next render (the recurring leaves the `due` array), so leaving `disabled = true` is harmless.

**B.2.b `submitRec` validates recurring inputs — `src/App.jsx:466`**
Before: only validated name and amount. Empty `intervalDays` for a custom-frequency bill became `Number("") = 0`, which made `getRecurringDueDate` return `null` — bill saved but never appeared anywhere. Same for empty `dayOfMonth`, `yearMonth`, `yearDay`. After: `submitRec` requires `rStart` non-empty, `custom` → `intervalDays >= 1`, `monthly` → `dayOfMonth ∈ [1, 31]`, `yearly` → `yearMonth ∈ [1, 12]` and `yearDay ∈ [1, 31]`. Each failure surfaces a toast via the new `onError` prop on `AddPage` (line 419), wired from the parent's `showT`. `AddPage` is a sub-component, so it cannot reach the parent's `showT` directly — the prop is the only correct way.

#### B.3 (`e6bda13`) — Cat 1: Security

**B.3.a `send-now.ts` registry-based auth — `api/send-now.ts:17-32`**
Closes D.1.1 (open Gmail relay). The endpoint now validates the caller's `supabase_url` against the owner's `user_registry` (using `SUPABASE_SERVICE_ROLE_KEY`) before processing. Owner's own URL is still allowed; everyone else must be registered. Stops the trivial abuse path where any attacker could spin up their own Supabase, set `email = victim@anywhere.com`, and use the dev's Gmail to relay branded mail.

**B.3.b `setup-user.ts` regex tightened — `api/setup-user.ts:61`**
Before: `/https:\/\/([a-zA-Z0-9]+)\.supabase\.co/` accepted bogus single-letter or mixed-case subdomains. After: `/^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/` matches the real Supabase project-ref format (20 lowercase alphanumeric chars, anchored).

**B.3.c Service worker stops caching opaque responses — `public/sw.js:20-26`**
Before: `if (!response.ok && response.type !== 'opaque')` let opaque (cross-origin no-cors) responses bypass the OK check and get cached, including potentially huge or error-cached responses we couldn't inspect. After: `if (!response || !response.ok || response.type === 'opaque') return response;` — opaque responses are never cached.

#### B.4 (`ec782ab`) — Cat 2: Sync hygiene

Full rewrite of `src/offlineSync.js` (test surface preserved).

**B.4.a `status === 0` is now a definitive drop, not 5xx-retry.** Was infinite-retry against CORS / DNS / opaque-failed responses; now treated as a definitive client/transport failure.

**B.4.b `safeSetItem` wraps every `localStorage.setItem`.** Quota or security exceptions notify subscribers via the new drop channel instead of silently losing writes.

**B.4.c `performRequest` uses `AbortController` with a 15-second timeout.** Flaky network → bounded latency, not a 120-second mobile hang.

**B.4.d New `subscribeSyncDrops(listener)` channel.** Notifies the UI whenever an item is dropped (4xx rejection, status 0, storage failure). Wired in `App.jsx` to the existing toast system: rejections show `Sync rejected (XXX) — change couldn't be saved`; storage failures show `Storage full — clear some data or export and reset`.

**B.4.e Exponential backoff on flush.** `flushSyncQueue` applies 1s → 2s → 4s → … capped 60s between flushes that make no progress. Stops the on-reconnect / focus thundering herd against a server that's already saying no.

#### B.5 (`f2a60f4`) — Cat 3: Date/timezone

**B.5.a Routine streak cap lifted from 365 → 5000 days — `src/Routine.jsx:2424, 3307`**
Both streak loops. 400-day streaks now render the real number; the old 365 ceiling looked broken to long-streak users.

**B.5.b FX cache schema migration — `src/currencyConverter.js`**
- Cache key changed from `{currency_YYYY-MM-DD: rate}` (calendar-day) to `{currency: {rate, fetchedAt}}` (24-hour rolling TTL). A rate fetched at 09:00 is now valid until 09:00 next day, not until midnight.
- Fallback CDN added (`latest.currency-api.pages.dev`) when primary `jsdelivr` fails.
- `saveCurrencyMeta` records `fetchedAt` so backdated foreign-currency reconciliation can tell how stale a rate was.
- Tests updated for the new schema; gained 2 new tests (24h-TTL miss, primary-fail-fallback-success). Total tests went 119 → 122 passing.

**B.5.c `billReminders.addDays` TZ off-by-one fix — `src/billReminders.js:25-35`**
Before: `new Date(localStr) + toISOString().slice()` silently shifted to UTC and produced off-by-one results for timezones east of UTC (e.g., `addDays("2026-05-05", 3)` returned `"2026-05-07"` in IST instead of `"2026-05-08"`). After: pure local-date arithmetic via `(y, m-1, d)` constructor + `setDate`. Plus `markShown` now retains yesterday's shown-set in addition to today's, so a midnight tab open on the day boundary doesn't lose today's dedup state.

#### B.6 (`61adcf3`) — Cat 4: Backend/cron

**B.6.a Concurrent per-user processing in `send-reports.ts`**
Replaced the serial `for (user of allUsers)` loop with chunked `Promise.allSettled`, `CONCURRENCY = 5`. One slow Supabase project (cold start, throttled, paused free-tier) can no longer block everyone behind it within the Vercel function's overall timeout.

**B.6.b Per-user 30-second wall-clock cap via `withTimeout` wrapper.**
Both the schedule-fetch and `processSchedule` calls. Schedule-fetch failures are now recorded in `results` (previously silently `continue`'d).

**B.6.c Backup attachment capped at 365 days — `_shared.ts:148-155`**
Was fetching all-time history per user per cron tick (multi-MB attachments for long-time users that bounced on recipient size limits). Now `date >= subDays(now, 365)`.

**B.6.d `prettyCategory()` helper — `_shared.ts`**
Renders category IDs into human-readable names: `"food"` → `"Food"`, `"food_abc"` → `"Food Abc"`. Used in `buildCsv` and the `byCategory` aggregation. Email recipients see "Food"-style labels instead of opaque IDs.

#### B.7 (`ee63376`) — Cat 5: Architecture

**B.7.a `updated_at` columns + trigger on every core table — `nomad_setup.sql`**
Adds `updated_at TIMESTAMPTZ DEFAULT NOW()` to `expenses`, `incomes`, `transfers`, `settlements`, `splits`, `recurring`, `events`, `wallet_balances` via an idempotent DO block. Each table gets a BEFORE INSERT/UPDATE trigger that calls a shared `nomad_touch_updated_at()` function. **This is the schema foundation only** — frontend doesn't yet send/echo `updated_at`, so conflict detection is not yet enforced. That's the next Tier 2 step.

**B.7.b "Sync Status" card in Settings — `src/App.jsx`**
New card showing pending-queue count, online status, and a "Sync now" button. Calls `flushSyncQueue()` and surfaces the result via the existing toast system. Replaces the silent "wait for visibility-change or online event" that was the only way to flush before.

#### B.8 (`81d0bd4`) — Cat 6: Edge cases

**B.8.a `crypto.randomUUID()` everywhere — `src/App.jsx:16`**
`uid()` now uses `crypto.randomUUID()` when available (every modern browser + Node 14.17+), with a longer 10-char base36 fallback (was 4 chars). Collision odds drop from ~1/1.6M (within the same ms) to effectively zero.

**B.8.b Renamed shadowed `uid` const — `src/App.jsx:794, 1090`**
Two scopes used `const uid = SB_URL.replace("https://","").split(".")[0]` which shadowed the global `uid()` ID generator. Renamed to `userKey` (subdomain ref) so the intent is unambiguous.

**B.8.c `events.participants` normalize on read — `src/App.jsx:893`**
Anything that isn't an array of strings becomes `[]`. Previously a malformed JSONB row from a 3rd-party write or a bad import would crash the events tab on `.filter()` / `.includes()` calls.

**B.8.d Note 500-character cap in `addE` / `addI` / `addT` — `src/App.jsx:960, 990, 991`**
Stops a 100KB clipboard paste from silently bloating localStorage and the database.

**B.8.e `CredentialSetup` import schema validation — `src/CredentialSetup.jsx:260-275`**
Now requires `sbUrl` and `sbKey` to be non-empty strings AND validates the Supabase URL format (`/^https:\/\/[a-z0-9]{20}\.supabase\.co\/?$/`) before saving. Empty strings, non-string values, and bogus URLs are rejected with a clear error.

#### B.9 (`1c4a3fe`) — Cat 7: UX

**B.9.a Skip button debounce parity — `src/App.jsx:1289`**
Skip button now uses the same `disabled-on-first-click` guard as the Paid button (B.2.a). Same date written twice is idempotent so no data loss before, but the redundant sRec/sbUpsert calls are gone.

**B.9.b Backdating-rejection toast specifics — `src/App.jsx:960`**
Was: `"Not enough in Bank on 2026-04-12"`. Now: `"Bank only had ₹420 on 2026-04-12 (need ₹600)"`. Same shape for current-date rejections. Stops the rage-quit cycle of users reconciling old bank statements.

**B.9.c "Download backup first" button in nuke confirmation — `src/App.jsx:1418`**
The `Clear All Data` confirm dialog now offers a one-tap green button to call `expBackup()` before the user types `DELETE`.

#### B.10 (`94535aa`) — E.2: Sync/Offline — dedupe merge + per-item retry dead-letter

**B.10.a Dedupe body merge — `src/offlineSync.js:enqueueRequest`**
Before: two upserts with the same `dedupeKey` → second replaced first entirely. Fields present in the first write but absent from the second were silently lost on replay. After: `mergeUpsertBodies()` merges JSON bodies when deduplicating. For array payloads (standard upserts), rows are matched by `id` and merged field-by-field — new write wins on conflicts, first write's unique fields are preserved. Falls back to second body if parsing fails.

**B.10.b Per-item 5xx retry + dead-letter — `src/offlineSync.js:flushSyncQueue`**
Before: one 5xx response aborted the entire flush and left all subsequent items unprocessed. After: each queue item tracks `_retries`; on 5xx the flush continues to the next item. After `MAX_ITEM_RETRIES = 3` failures an item is moved to `nomad-sync-failed-v1` (dead-letter) and removed from the main queue. A single poison item can no longer block the whole queue. New exports: `getDeadLetterCount()`, `clearDeadLetter()` for future Settings wiring. Two new tests added (131 total).

#### B.11 (`76ae48d`) — E.3 #1: Routine streak counts today immediately

**B.11.a Streak today threshold lowered to ≥1 — `src/Routine.jsx:2422, ~3305`**
Before: both streak `useMemo` loops required `dayLevel >= 2` before counting today, so the first morning action still showed yesterday's streak until a second action was logged. After: if today has any record with `dayLevel >= 1`, the streak is seeded to 1 and the walk-back continues from yesterday. Past days still require `dayLevel >= 2` so historical streaks aren't retroactively inflated.

#### B.12 (`36ca28b`) — E.3 #3: Yearly recurring day-clamp warning

**B.12.a UI warning when yearDay exceeds month — `src/App.jsx:505, 629`**
`withClampedDay` in `financeUtils.js` silently fires a yearly bill on the last available day when `yearDay > daysInMonth(yearMonth)` (e.g., Feb 31 → Feb 28). Both the add form and `RecEditPanel` now show an inline orange note: `"Day 31 → clamps to 28 in Feb. Bill fires on last available day."` The clamping logic is unchanged; this is purely a UI disclosure.

#### B.13 (`760b9a4`) — E.6 #1: Soft delete + 30-day recovery

**B.13.a `deleted_at` columns — `nomad_setup.sql`**
Idempotent DO block adds `deleted_at TIMESTAMPTZ DEFAULT NULL` to `expenses`, `incomes`, `transfers`, `recurring`, `events`.

**B.13.b `sbDelete` → soft PATCH — `src/App.jsx:84`**
Changed from HTTP DELETE to PATCH `{deleted_at: now()}`. `sbDeleteWhere` (bulk/cascade ops and the Clear All nuke) remains a hard DELETE.

**B.13.c `sbGet` filter + fallback — `src/App.jsx:58`**
Normal reads now include `&deleted_at=is.null`. If the column doesn't exist yet (pre-migration database), the 400 response triggers a fallback to the unfiltered query — backwards-compatible.

**B.13.d `sbGetDeleted` + "Recently deleted" card — `src/App.jsx`**
New `sbGetDeleted(table)` fetches items with `deleted_at` in the last 30 days. New state `recDelItems` / `recDelLoading`. `loadRecentlyDeleted()` fetches from all 4 tables in parallel; `restoreDeleted(item)` patches `deleted_at=null` and re-adds to in-memory state. "Recently deleted" card in Settings (between Sync Status and Danger Zone) lazy-loads on tap, shows per-item Restore button.

#### B.14 (`243557d`) — E.6 #8: UPI Lite slice guard

**B.14.a Non-string date guard — `src/App.jsx:upiLiteUsage`**
`e.date.slice(0, 7)` threw `TypeError` when an expense from a malformed sync replay had a non-string `date`. Now uses `String(e.date || "").slice(0, 7)` and pre-computes the month key from the `date` argument, so a single bad row cannot crash the cap check and block all UPI Lite entries.

#### B.15 (`d7e58e3`) — E.5 #7: Auto SW cache version at build time

**B.15.a `injectSwVersion` Vite plugin — `vite.config.js`**
Previously developers had to manually bump `CACHE_NAME` in `public/sw.js` before each deploy. Forgetting left users on stale cached assets. New `injectSwVersion` plugin runs at `closeBundle`, rewrites `dist/sw.js` replacing the hard-coded `nomad-app-vN` with a base-36 build timestamp. No new dependencies. During dev/test `dist/sw.js` doesn't exist, so the try/catch is a no-op.

#### B.17 (`8d7fadf`) — E.2 #3: Conflict detection for recurring edits

**B.17.a Version cache + `If-Unmodified-Since` — `src/App.jsx`, `src/offlineSync.js`**
Schema already had `updated_at` columns (B.7.a) but the client never used them. After:
- `VERSIONS_KEY` localStorage cache (`nomad-record-versions-v1`) stores each row's `updated_at` as `{table:id → ts}` when loaded via `sbGet`.
- `sbGet` now awaits `r.json()` before returning so it can pass rows to `saveVersions`.
- `sbWrite` / `sbUpsert` accept `extraHeaders` so callers can inject `If-Unmodified-Since`.
- 3 recurring write sites (Paid button, Skip button, RecEditPanel onSave) now pass `{ "If-Unmodified-Since": getVersion("recurring", r.id) }` when a stored version is available.
- `flushSyncQueue` strips `If-Unmodified-Since` from all headers before replay — offline writes always win, never 412 on reconnect.
- 412 response in flush emits `kind:"conflict"` drop (not `kind:"rejected"`, not 5xx retry).
- `subscribeSyncDrops` wired in App for conflict toast: "Sync conflict — a newer version exists; local change discarded".
- 2 new tests: 412→conflict drop+continue, header stripping during replay.

**Scope decision:** Conflict detection targets the `recurring` table only — it's the only one with true edit flows (Paid, Skip, RecEditPanel). `expenses`, `incomes`, `transfers` are append-only (new IDs each time); `If-Unmodified-Since` on those would add complexity with zero benefit.

#### B.18 (`0080211`) — E.1 #2: Signed Cloudinary uploads via Web Crypto

**B.18.a Client-side SHA-1 signature — `src/receiptUpload.js`, `src/CredentialSetup.jsx`**
Before: every upload was unsigned (anyone who learned the preset name could upload to the owner's Cloudinary account). After two modes, backwards-compatible:

- **Signed** (recommended): if `apiKey` + `apiSecret` are in credentials, `uploadReceipt` computes `SHA-1("timestamp=<ts><apiSecret>")` via `crypto.subtle.digest("SHA-1", ...)` and sends `api_key`, `timestamp`, `signature` — no upload preset required.
- **Unsigned** (legacy): if only `uploadPreset` is set, uses existing unsigned preset path.
- If neither is configured, throws a clear "Cloudinary not configured" error.

`CredentialSetup.jsx` gains two new optional fields (API Key, API Secret) with type="password" for the secret. The import/export JSON schema includes them. The guide step updated to describe signed-key retrieval. Settings backend card now shows "(signed)" vs "(unsigned preset)" in the Cloudinary status line.

**Security note:** `apiSecret` is stored in `localStorage` (same threat model as the Supabase anon key — E.1 #3). For the BYODB single-user model this is acceptable; it's equivalent to the dev keeping the secret in `.env` for a server. A proper solution would be a signing endpoint (`api/cloudinary-sign.ts`), but that requires a server deploy and the `CLOUDINARY_API_SECRET` env var, which is out of scope for the client-only setup guide.

#### B.16 (`59c7a5d`) — E.3 #5: `send_day_of_month` widened to max-31

**B.16.a Three-layer fix — `nomad_setup.sql`, `src/App.jsx`**
Before: `send_day_of_month` was capped at 28 in the SQL constraint, UI input, and the client-side scheduler, so users wanting day 29/30 silently got day 28. After: SQL constraint updated to `1–31` with an idempotent DO block that drops and re-adds the check on existing databases. UI input `max` and onChange clamp updated to 31. Scheduler's `Math.min(dom, 28)` replaced with `Math.min(dom, lastDayOfCurrentMonth)` using `Date.UTC` so the clamp adapts per month (28 in Feb, 30 in Apr, 31 in Jan) rather than always using the Feb worst case.

#### B.19 (session 3+) — Cross-month full-text search, backend UTC fix, stale test fix, UX polish

**B.19.a Cross-month search — `src/App.jsx`**
`historyItems` useMemo now builds from full `ex`/`inc`/`tr`/`stl` arrays when `hSearch` is non-empty, enabling search across all months. Month filter still applies when no search text is entered.

**B.19.b UTC-safe `getPeriod` — `api/_shared.ts`**
`getPeriod` replaced `date-fns` local-time `startOfMonth`/`endOfMonth` with `Date.UTC()` arithmetic. In IST (UTC+5:30), the old code returned Feb 29 instead of Mar 1 as monthly-report start. Now timezone-independent.

**B.19.c Stale `getNextSendAt` tests updated — `api/__tests__/_shared.test.ts`**
7 tests written before IST→UTC conversion was added. Updated assertions to expect IST-adjusted UTC hours (send_hour=8 IST → UTC hours=2, minutes=30, etc). All 133 tests now pass; 0 failing.

**B.19.d Recurring status badges — `src/App.jsx`**
Recurring list rows now show "✓ Paid" (green) or "Skipped" (amber) badge when the current cycle has been acted on.

**B.19.e History empty states — `src/App.jsx`**
History tab: empty state with "No transactions yet" message + "Add First Transaction" CTA button when no data exists. Also shows "No results match your filters." when filters eliminate all results. Dashboard: welcome card shown on first open before any transactions.

**B.19.f Orphan-category warning + usage count — `src/App.jsx`**
Delete handler in Manage section shows `"⚠ N transactions now show as Unknown"` toast. Category/source rows show a transaction-count badge so users know the impact before deleting.

**B.19.g Wallet descriptions — `src/App.jsx`**
`WALLETS` constant gained `desc` field per wallet; `WB` selector component shows the subtitle under each wallet name.

**B.19.h Splits model explainer — `src/App.jsx`**
Splits section header and expanded state now show brief text explaining personal-IOUs vs Events.

**B.19.i Dead-letter queue surfaced in Sync Status — `src/App.jsx`, `src/offlineSync.js`**
Imported `getDeadLetterCount`, `clearDeadLetter`. Added `deadLetterCount` state updated via `subscribeSyncDrops` `kind:"dead-letter"` events. Sync Status card now shows red banner with count + Dismiss button when dead-letter queue is non-empty. Toast shown on each dead-letter event pointing to Settings. Closes E.2 M (dead-letter visibility).

**B.19.j Cross-tab stale-data banner — `src/App.jsx`**
Added `storage` event listener for `nomad-v5` key. When another tab writes state, a purple banner appears with Reload and dismiss buttons. Closes E.2 M (cross-tab sync gap) with a lightweight notification approach. Closes E.2 M.

**B.19.k Add-form: preserve state on validation failure — `src/App.jsx`**
`oE`/`oI` return values now checked. If either returns `false` (balance check, UPI cap, etc.), submit handler returns early — form fields and receipt picker remain intact for retry. Fixes E.5 L (orphaned Cloudinary blobs when transaction fails).

**B.19.l Backend `setup-user.ts` DDL completeness — `api/setup-user.ts`**
Added `send_day_of_week` and `send_day_of_month` `ALTER TABLE IF NOT EXISTS` statements. New users who ran setup via the Settings button were missing these columns.

**B.19.m Backend `send_day_of_month` actual-month clamp — `api/_shared.ts`, `api/__tests__/_shared.test.ts`**
`getNextSendAt` previously used `Math.min(dom, 28)` for monthly/quarterly. Now computes last day of target month via `Date.UTC`. Test updated to verify correct behavior (May keeps 31, Feb 2024 leap clamps to 29).

**B.19.n Heatmap aggregation memoized — `src/App.jsx`**
Heatmap `dt` object now wrapped in `useMemo([ex, pfx])` so the O(n) scan only runs when the expense list or viewed month changes. Also guards against non-string dates. Partially addresses E.5 M heatmap perf.

#### B.20 (`2e83fb2`) — E.7 M: Local-blob receipt fallback

**B.20.a `uploadReceipt` local fallback — `src/receiptUpload.js`**
When `cloudName` is not set in credentials, `uploadReceipt()` now compresses the image and returns a base64 data URL (via `FileReader.readAsDataURL`) instead of throwing. The data URL is stored directly in the expense's `receipt_url` column (Postgres TEXT — no size limit). Existing Cloudinary paths (signed + unsigned) are unchanged.

**B.20.b `isLocalReceipt(url)` helper — `src/receiptUpload.js`**
Exported helper that returns `true` when a receipt URL is a local data URL (`url.startsWith("data:")`). Use in UI code to show "stored locally" badges or suppress broken-link warnings in future.

**B.20.c Local-upload info toast — `src/App.jsx`**
After uploading receipts, if any returned URL is a data URL, shows: "Receipt saved locally — add Cloudinary in Settings to sync receipts to the cloud". Quota warning surfaces the limitation without blocking the workflow.

#### B.21 (`b2d7f96`) — E.8 H: In-app CSV export

**B.21 NOTE:** The export feature (`expCSV`) already existed in App.jsx (line 1148) in a separate "Export" card in Settings. The E.8 H "CSV in-app export" finding was a false positive — export was already there. B.21 commit added a duplicate `expCsv` which was subsequently removed in B.22 cleanup; only the CSV import feature (the genuinely missing piece) was kept.

#### B.22 (`d1a1064`) — E.8 H: Bank CSV import with auto-detection

**B.22.a `parseBankCsv(text)` — `src/App.jsx`**
Parses CSV text from HDFC/ICICI/SBI/generic bank statements. Auto-detects columns by header keywords: date (date/txn date/transaction date/value date), debit (debit/withdrawal/dr), credit (credit/deposit/cr), description (narration/description/particulars/details/remarks). Handles quoted fields, DD/MM/YY and DD/MM/YYYY date formats, comma-separated amounts. Returns `[{date, amount, note, type}]` — debit → "expense", credit → "income", generic amount column → "expense".

**B.22.b `impCsv(file)` + `confirmCsvImport()` — `src/App.jsx`**
`impCsv` reads the file and calls `parseBankCsv`, storing result in `csvPreview` state. `confirmCsvImport` calls `addE`/`addI` for each row (expenses to Food/Bank, incomes to Allowance/Bank) and shows row count in success toast with note to recategorize.

**B.22.c Import Bank CSV UI — Backup & Restore card — `src/App.jsx`**
Gold "📂 Import Bank CSV" label opens file picker for `.csv` files. On parse success, inline preview shows first 4 rows (amount, description, date) with Confirm/Cancel buttons. Closes E.8 H: CSV import.

#### B.24 (this session) — E.7 #1 Demo mode, E.3 L DST anchor, E.6 H Refund flow

**B.24.a Demo mode + landing screen — `src/CredentialSetup.jsx`, `src/App.jsx`**
New users now land on a 3-element screen (logo, 3 feature bullets, two CTA buttons) instead of the raw credential form. "Try Demo" sets `localStorage.setItem("nomad-demo-mode","true")` and reloads. On reload: `isDemoMode = !_creds.sbUrl && localStorage.getItem("nomad-demo-mode")==="true"` makes `needsSetup=false`; `sbGet` returns `[]`; `sbWrite` is a no-op; `load()` short-circuits into `DEMO_DATA` (25 expenses + 5 incomes + 2 transfers + 3 recurring spanning March–May 2026). A sticky amber "🎮 Demo Mode — data not saved" banner renders at top with "Connect Backend" and "Exit" buttons. "Connect Backend" from the banner removes the flag and calls `setShowSetup(true)` — CredentialSetup shows the form (not landing) because `onCancel` is defined. "Connect Backend" from the landing screen transitions `step` from `"landing"` to `"form"`. Closes E.7 H (first-run friction), E.8 H (demo data mode), E.7 M (tutorial / sample data).

**B.24.b DST noon anchor in Routine.jsx — `src/Routine.jsx:2462, 2473, 2487`**
Three `new Date(year, month, i)` calls (in `completionPct`, `avgWater`, and `cells` loop) lacked the noon anchor used in `financeUtils.js`. In timezones east of UTC, midnight local time resolves to the previous UTC day, producing off-by-one in streak/stat calculations after a DST transition. Added `, 12` hour argument to all three. Closes E.3 L.

**B.24.c Refund flow — `src/App.jsx:602, 617, 1194, 1464`**
Expense `TxCard` now shows a small green ↩ button for expense items (only when `onRefund` prop is present). Clicking it calls `refundItem(expense)` which creates an income entry via `addI()` with same amount + wallet, `sourceId = isrc[0].id`, `note = "Refund: " + original note` (capped 500 chars), today's date. The income follows the normal `addI` path (balance check, sync queue, toast). Historyitems.map passes `onRefund={refundItem}`. Closes E.6 H (refund flow).

#### B.25 (session 5) — E.8 product features, splits note, group event fixes, startup speed

**B.25.a Finance streak badge — `src/App.jsx`**
`finStreak` useMemo walks back from today counting consecutive days with any transaction (`ex` ∪ `inc`). Renders a 🔥 amber-bordered badge in the dashboard when streak ≥ 2: "{N}-day logging streak!". Closes E.8 M (finance-side streak).

**B.25.b Subscription detection — `src/App.jsx`**
`subSuggestions` useMemo finds expense notes appearing ≥2× in the last 90 days that aren't already in `rec`. Returns top-5 by count with avg amount. Rendered as a dashed-purple card in Settings → Recurring section: "💡 Possible recurring patterns" with a "Promote ›" button per suggestion that calls `addRec({name, categoryId, walletId, amount, freq: "monthly"})`. Closes E.8 M (subscription detection).

**B.25.c Category drilldowns with MoM% — `src/App.jsx`**
Dashboard category-breakdown IIFE replaced with version that computes `curM` / `prevM` / `prevT` for each category. Each category row shows a MoM badge: "+12% MoM" (red) or "−8% MoM" (green). Tapping a row toggles `drillCat` state — expands an inline panel showing the top-5 notes by amount for that category. Closes E.8 M (inline category drilldowns), E.8 M (month-over-month comparison).

**B.25.d Autocategorize rules — `src/App.jsx`**
`autoRules` state: `[{keyword, categoryId}]` persisted to `nomad-auto-rules` localStorage. Cleared by the "Clear All Data" sweep. New "⚡ Autocategorize Rules" card in Settings (green border `#6BAA75`, collapsible): list of rules with ✕ delete; add-form with keyword input + category select + Add button. `AddPage` gains `autoRules` prop — note `onChange` checks rules and auto-selects matching category. Closes E.8 M (autocategorize rules).

**B.25.e Bulk delete in history — `src/App.jsx`**
`bulkMode` boolean + `bulkSel` Set state. "Select" button added next to Filter button in history tab. When `bulkMode` active, each TxCard gets a checkbox; selecting shows a sticky top banner "N selected · Delete · Cancel". Delete calls `sbDelete` + removes from state for each selected ID. Closes E.8 M (bulk operations).

**B.25.f Splits note field (home tab) — `src/App.jsx`**
`Splits` sub-component gains `snote` state. Add form: name/amount/+ on row 1, note input (full-width) on row 2. Note stored in split object as optional `note` field. Displayed in splits list: "You owe · note text" (muted). `nomad_setup.sql` already had `note TEXT` on splits table (migration added in B.19/B.22 session).

**B.25.g Group event logic overhaul — `src/App.jsx`**
Three interconnected fixes for BHIM-style group tracking:
- **Exact shares**: `grpShareMap` computed via `distributeAmount(grpTotal, allParts.length)` (not `roundMoney(total/n)`). Eliminates ₹0.01 rounding residue — 3-way ₹100 split now distributes [33.34, 33.33, 33.33] exactly summing to ₹100.
- **Settlement precision**: Both the per-person balance row and the greedy min-cash-flow IIFE use `grpShareMap[p] ?? grpShare` instead of `grpShare`. Balances now sum to exactly 0; settlement loop terminates cleanly.
- **paidBy display**: Each expense row in the GROUP EVENTS EXPENSES section shows "paid by {name}" in purple (`#7B8CDE`) when `e.paidBy !== "me"`.
- **paidBy in Supabase upsert**: `"paidBy"` added to `toSB` column list in `addE` — was previously missing, causing group summaries to break after reload.

**B.25.h Startup stale-while-revalidate — `src/App.jsx`**
`load()` rewritten to eliminate startup delay. Old: offline check → await all 8 `sbGet` in series → `sL(true)` → render. New: `loadLocalBackup()` → `sL(true)` immediately (zero network wait) → if `SB_ENABLED && online`, fire async Supabase refresh that updates state when it arrives. App renders instantly from localStorage on every open. Migration column lists in the first-connect path updated to include `paidBy` (expenses), `note` (splits), `type`+`participants` (events).

#### B.23 (`401af76`) — E.8 H: Default categories/sources deletable

**B.23.a Remove default-guard in Manage section — `src/App.jsx`**
The `✕` button's `if (defs.find(d => d.id === c.id)) return` guard and `opacity: 0.15` for defaults removed. Users can now delete built-in `DC`/`DI` entries. Orphan-count toast already fires when N transactions would become "Unknown". `nomad-v5` localStorage auto-persists the change. Rename of defaults still not supported (requires inline-edit UI — future work).

### C. False Positives (audit was wrong — do NOT reopen)

These were flagged by the original audit but are correct in the existing code. Recorded here so we don't waste a future session re-investigating.

| # | Audit claim | Reality | Where |
|---|---|---|---|
| C.1 | `distributeAmount` front-loads the paisa unfairly | Working as designed — call site assigns position 0 to "you" deliberately so you absorb the rounding, not your friends | `App.jsx:698` |
| C.2 | Bill-split custom amounts can sum > total | Already blocked by `canSub`; UI shows "(over!)" warning | `App.jsx:701, 712` |
| C.3 | Bill-split with empty roster lets you submit | Already blocked by `canSub` requiring `validPpl.length > 0` | `App.jsx:701` |
| C.4 | Backdated balance check uses current balance | Already uses `balanceOnDate()` for backdated entries | `App.jsx:957-959` |
| C.5 | `parseFloat` NaN amounts silently dropped | `roundMoney(NaN) = 0` (because `NaN \|\| 0 → 0`); the `amt <= 0` guard catches and toasts "Enter a valid amount" | `App.jsx:946-947` |
| C.6 | `_shared.ts` IST→UTC offset is inverted | Math is correct: `istMin = send_hour*60 - 330` correctly converts IST→UTC. Variable name is misleading but the result is right (verified by hand: 6 AM IST → 00:30 UTC ✓) | `api/_shared.ts:65-69` |
| C.7 | `fullMonthsBetween(Jan31, Mar30)` should return 2 | Returns 1 — correct. Mar 31 (the 2-month anniversary) hasn't been reached. `getRecurringDueDate` handles this via its "+1 month when overdue" correction; test at `financeUtils.test.js:157` already verifies correct due-date behavior | `financeUtils.js:17-21` |
| C.8 | Custom split with ₹0 participants — no per-row input warning | Already implemented on line 759: `{bsMode === "custom" && p.name.trim() && !(parseFloat(p.amount) > 0) && <span>₹0!</span>}`. Submit also blocked by `canSub` requiring `custOT > 0` | `App.jsx:759, 750` |
| C.9 | `TxCard` has no `React.memo` — re-renders on every state change | Already wrapped: `const TxCard = memo(function TxCard(...))` at line 602 | `App.jsx:602` |
| C.10 | No quick-entry templates for repeat transactions | Already implemented: `quickPatterns` useMemo (line 1035) computes last-60-day patterns with count≥2; passed as `patterns` prop to `AddPage`; rendered as QUICK ADD chip row at line 567 | `App.jsx:567, 1035, 1462` |

### D. Discovered During Fix Work (new findings, not in original audit)

#### D.1.1 `api/send-now.ts` has no auth — open Gmail relay — ✅ FIXED in `e6bda13`

`api/send-now.ts:13-18` previously accepted `supabase_url` and `anon_key` from the request body and used the dev's Gmail to send a "NOMAD report" to whatever `email` was in that schedule. Anyone could spin up their own Supabase project, create a `report_schedules` row with `email: victim@anywhere.com`, and POST to `/api/send-now` to relay branded mail through the dev's Gmail.

Fix: caller's `supabase_url` is now validated against the owner's `user_registry` (using `SUPABASE_SERVICE_ROLE_KEY`) before processing. Owner's own URL is allowed; everyone else must be registered. See B.3.a.

#### D.1.2 7 vitest failures in `_shared.ts:getNextSendAt` — ✅ FIXED

7 `getNextSendAt` tests were stale (written before IST→UTC conversion was added). Updated all assertions to expect IST-adjusted UTC hours/minutes (send_hour=8 IST → UTC hours=2, minutes=30, etc). 2 `getPeriod` tests also fixed by replacing `date-fns` local-time `startOfMonth`/`endOfMonth` with `Date.UTC()` arithmetic in `_shared.ts`. All 133 tests now pass.

#### D.1.3 `billReminders.addDays` had a TZ off-by-one — ✅ FIXED in `f2a60f4`

Discovered while implementing reminder UTC anchoring: the original `addDays` parsed local-time then sliced UTC-format ISO string, producing off-by-one in any TZ east of UTC. See B.5.c.

### E. Open Findings — Full List

> Priority legend: **C** Critical · **H** High · **M** Medium · **L** Low
>
> Items closed in commits B.1 – B.9 are no longer listed here. See section B for what was fixed and how.

#### E.1 Security (0 open — all N/A for personal BYODB app)

> E.1 #2 (unsigned Cloudinary) closed in B.18 — SHA-1 signed uploads via Web Crypto; unsigned preset fallback for legacy users.
> E.1 remaining items are architectural decisions inherent to the BYODB model. Each user owns their own Supabase instance; the anon key is the auth boundary by design (same threat model as a .env file). No XSS surface exists (verified: no innerHTML/dangerouslySetInnerHTML/eval). Management API token is server-only in setup-user.ts. All items acknowledged as N/A for personal use.

| Pri | Finding | Location | Notes |
|---|---|---|---|
| **C** | RLS disabled on every table | `nomad_setup.sql` | ✅ N/A — BYODB single-user, anon key is private per user. Threat documented. |
| **H** | Anon key in localStorage | `credentials.js:7` | ✅ N/A — same threat model as .env. No XSS surface. |
| **M** | Email leakage via `report_schedules` | `App.jsx:798` | ✅ N/A — implied by RLS=off, acknowledged. |
| **M** | Management API token in `setup-user.ts` | `api/setup-user.ts` | ✅ N/A — server-only, never echoed, no logging of secrets confirmed. |

#### E.2 Sync / Offline (0 open)

> E.2 #1 (dedupe merge) and E.2 #2 (per-item retry dead-letter) closed in B.10.
> E.2 #3 (conflict detection) closed in B.17 — `If-Unmodified-Since` on recurring edits; 412→conflict drop; header stripped on offline replay.

| Pri | Finding | Location | Notes |
|---|---|---|---|
| **H** | User can clear localStorage with pending queue | Browser-level | ✅ N/A — cannot block browser-level "Clear site data". Sync Status card shows pending count; in-app destructive ops show backup nudge. Best-effort. |
| **M** | Two tabs / two devices have no cross-tab sync | App-wide | ✅ Done in B.19.j — storage event shows banner with Reload. |

#### E.3 Date / Timezone (0 open)

> E.3 #1 (streak today), E.3 #3 (yearly clamp warning), E.3 #5 (send_day_of_month 28→31) closed in B.11, B.12, B.16.
> E.3 L (DST anchor) closed in B.24.b — noon anchor added to all three Routine.jsx date constructors.
> E.3 H (TZ-tied date keys) — acknowledged as architectural won't-fix for personal app. Single user, single timezone; the cross-TZ travel edge is acceptable.

| Pri | Finding | Location | Notes |
|---|---|---|---|
| **H** | Timezone-tied date keys, no anchor stored | `Routine.jsx:2436` | ✅ N/A — single-user personal app; cross-TZ travel edge accepted. Architectural. |
| **M** | `fullMonthsBetween` off-by-one | `financeUtils.js:17-21` | ✅ False positive (C.7) |
| **L** | DST edges in offset-naive math | `Routine.jsx:2462, 2473, 2487` | ✅ Fixed in B.24.b — noon anchor added. |

#### E.4 Backend / Cron Scale (0 open — all N/A for personal app)

> Personal single-user app. Scale concerns (500/day Gmail cap, cron fan-out, telemetry) are irrelevant. All items acknowledged as N/A.

| Pri | Finding | Notes |
|---|---|---|
| **C** | Cron serial within chunk | ✅ N/A — personal app, one user |
| **H** | Gmail 500/day cap | ✅ N/A — personal app, skipped per user instruction |
| **M** | Supabase cold start | ✅ N/A — mitigated by 30s timeout (B.6.b) |
| **M** | Single-tenant telemetry | ✅ N/A — personal app |
| **L** | send_day_of_month clamp | ✅ Fixed in B.19.m |

#### E.5 Architecture / Performance (0 open — all N/A or false positive)

> E.5 #7 (SW manual cache version) closed in B.15. Heatmap memoized in B.19.n. Receipt form fixed in B.19.k. TxCard memo is a false positive (C.9). Remaining H items are architectural won't-fix for personal app.

| Pri | Finding | Notes |
|---|---|---|
| **H** | App.jsx monolith | ✅ N/A — intentional design, noted in CLAUDE.md |
| **H** | Routine.jsx JSONB blob | ✅ N/A — personal app, years before 1MB+ |
| **H** | wallet_balances integrity | ✅ N/A — single user, single tab in practice |
| **H** | Multi-write no rollback | ✅ N/A — personal app, data loss risk accepted |
| **M** | TxCard no memo | ✅ False positive (C.9) — already memo'd |
| **M** | Heatmap windowing | ✅ Fixed in B.19.n |
| **L** | Receipt + tx not coupled | ✅ Partially fixed in B.19.k |

#### E.6 Other Edge Cases (0 open)

> E.6 #1 (soft delete) closed in B.13. E.6 #8 (UPI Lite slice) closed in B.14. Badges + orphan warning closed in B.19. Refund flow closed in B.24.c.

| Pri | Finding | Notes |
|---|---|---|
| **H** | Clear All Data non-atomic | ✅ N/A — mitigated by backup nudge (B.9.c); server RPC would require infrastructure changes |
| **H** | Refund flow doesn't exist | ✅ Fixed in B.24.c — ↩ button on expense cards; creates income via addI() |
| **M** | Deleting category orphans expenses | ✅ Fixed in B.19.f — orphan-count warning toast |
| **M** | Deleting participant from event after split | ✅ N/A — no UI exists for removing participants after event creation; can't happen from UI |
| **M** | Custom split ₹0 | ✅ False positive (C.8) |
| **M** | getExchangeRate INR hardcode | ✅ N/A — renamed, hardcode is by design |
| **L** | JSON.stringify precision | ✅ N/A — INR amounts never exceed 2^53 |
| **L** | report_schedules UNIQUE per user | ✅ N/A — personal app, one schedule is correct |
| **L** | Streak gaming | ✅ N/A — personal app, no integrity requirement |
| **L** | Splits imaginary friends | ✅ N/A — cosmetic, personal app |

#### E.7 UX / Human Behavior (0 open)

> All items closed: B.11 (streak today), B.20 (receipt fallback), B.19.g (wallet desc), B.19.h (splits explainer), B.19.e (empty states), B.24.a (demo mode + landing). False positives: C.9 (TxCard memo), C.10 (quick-entry). Remaining H items below are N/A or false positive.

| Pri | Finding | Notes |
|---|---|---|
| **H** | First-run friction | ✅ Fixed in B.24.a — landing screen + demo mode |
| **H** | Routine Day-1 streak | ✅ Fixed in B.11 |
| **H** | No quick-entry templates | ✅ False positive (C.10) — quickPatterns already implemented |
| **H** | Long expense form | ✅ N/A — QUICK ADD chips mitigate; form already has session draft save |
| **M** | Receipt gated on Cloudinary | ✅ Fixed in B.20 — local-blob fallback |
| **M** | Wallet terminology | ✅ Fixed in B.19.g |
| **M** | Splits/Settlements overlap | ✅ Fixed in B.19.h |
| **M** | No empty-state guidance | ✅ Fixed in B.19.e |
| **M** | No tutorial / sample data | ✅ Fixed in B.24.a — demo mode with 3 months of realistic data |
| **M** | Unsaved form state | ✅ N/A — sessionStorage draft already implemented |
| **L** | No undo | ✅ N/A — already implemented (undoDelete/showUndoToast) |

#### E.8 Product Gaps — features, not bugs

> Competing apps ship these; this app doesn't.

##### Table-stakes (HIGH)

| Pri | Feature | Notes |
|---|---|---|
| **H** | Budgets / per-category caps with progress + alerts | ✅ Done (`3cd6374`) — progress bars + alerts per category per month |
| **H** | CSV / PDF in-app export | ✅ Already existed (false positive — `expCSV` + Export card in Settings). PDF still via emailed report only |
| **H** | CSV import (bank statements) | ✅ Done (B.22) — auto-detects HDFC/ICICI/SBI/generic formats; preview before import; recategorize after |
| **H** | Transaction full-text search across years | ✅ Done (B.19.a) — cross-month search when `hSearch` non-empty |
| **H** | UI to manage hardcoded wallets/categories/sources | ✅ Default categories/sources can now be deleted (B.23). Rename not yet supported. **WALLETS are still hardcoded** — open |
| **H** | "Demo data" mode for new users | ✅ Done (B.24.a) — landing screen + demo mode with 3 months data |
| **H** | Multi-account / family sharing | N/A — splits exist as personal IOUs, not a shared ledger |

##### Power user (MEDIUM)

| Pri | Feature | Notes |
|---|---|---|
| **M** | Rules / autocategorize from merchant text | ✅ Done (B.25.d) — keyword→category rules, stored in `nomad-auto-rules` |
| **M** | Tags (orthogonal to categories) | ~~Done (B.26)~~ **Removed (B.27)** — redundant with Events tab; fully stripped from AddPage, TxCard, history filter, addE/addI Supabase writes |
| **M** | PDF/non-image attachments | ✅ Done (B.26) — ReceiptPicker "PDF / File" option; `uploadReceipt` uses raw/PDF endpoint for Cloudinary; 📄 icon on TxCard |
| **M** | Multi-currency display (drop INR hardcode) | ✅ Already done (B.5.b) — `fxMeta` row shown on TxCard since B.5.b |
| **M** | Subscription detection (auto-find recurring from history) | ✅ Done (B.25.b) — `subSuggestions` in Settings → Recurring |
| **M** | Month-over-month / merchant frequency / spending projections | ✅ Done (B.25.c) — MoM% badge + category drilldown in dashboard |
| **M** | Undo affordance on toasts | ✅ N/A — already implemented (`undoDelete`/`showUndoToast`) |
| **M** | Bulk operations (multi-select delete/edit) | ✅ Done (B.25.e) — bulk delete in history tab |

##### Retention (MEDIUM)

| Pri | Feature | Notes |
|---|---|---|
| **M** | "You haven't logged in 3 days" reminder | ✅ Done (B.26) — `useEffect` on `loaded`; checks last transaction date; shows toast once/day via `nomad-last-log-nudge` localStorage key |
| **M** | Streak for the finance side | ✅ Done (B.25.a) — 🔥 N-day badge in dashboard |
| **M** | In-app insights (push) summary | ~~Done (B.26)~~ **Removed (B.27)** — weekly digest card removed; not needed by user |
| **M** | Inline category drilldowns | ✅ Done (B.25.c) — top-5 notes per category on tap |

##### Remaining open (summary)

All E.8 product gaps closed as of B.26. No open items remaining.

### F. Recommended Sequence (next sessions)

Re-prioritized after the work in this branch.

| # | Track | Effort | Items |
|---|---|---|---|
| ~~1~~ | ~~Wire client to `updated_at`~~ | ~~½ day~~ | ✅ **Done in B.17** — `If-Unmodified-Since` on recurring edits, 412 conflict drop |
| ~~2~~ | ~~Per-item retry + dead-letter~~ | ~~½ day~~ | ✅ **Done in B.10** |
| ~~3~~ | ~~Routine streak UX fixes~~ | ~~2 hours~~ | ✅ **Done in B.11, B.12** |
| ~~4~~ | ~~Soft delete + recovery~~ | ~~1 day~~ | ✅ **Done in B.13** |
| ~~5~~ | ~~Signed Cloudinary uploads~~ | ~~1 day~~ | ✅ **Done in B.18** — client-side SHA-1 via Web Crypto |
| ~~1~~ | ~~ESP swap Gmail → Resend~~ | ~~½ day~~ | ✅ **N/A** — personal app, skipped per user instruction |
| ~~2~~ | ~~Onboarding overhaul + demo data~~ | ~~2 days~~ | ✅ **Done in B.24.a** — landing screen, demo mode, DEMO_DATA |
| ~~3~~ | ~~Cron full fan-out~~ | ~~1 day~~ | ✅ **N/A** — personal app, single user |
| ~~4~~ | ~~Budgets / per-category caps~~ | ~~2-3 days~~ | ✅ **Done (`3cd6374`)** — progress bars + alerts per category per month |
| ~~5~~ | ~~E.8 product gaps (batch 1)~~ | ~~2 days~~ | ✅ **Done in B.25** — finance streak, subscription detection, MoM%, autocategorize rules, bulk delete, splits note, group event precision, startup speed |
| ~~1~~ | ~~Custom wallets~~ | ~~1 day~~ | ✅ **Done in B.26** — `wallets` state from `nomad-wallets-v1`; CRUD UI in Settings; WALLETS/TxCard/AddPage all use dynamic state |
| ~~2~~ | ~~Rename categories/sources~~ | ~~½ day~~ | ✅ **Done in B.26** — tap name to inline-edit; blur/Enter saves; Escape cancels |
| ~~3~~ | ~~E2E tests with Playwright~~ | ~~1 day~~ | ✅ **Done in B.26** — 5 spec files in `e2e/`; `npm run test:e2e`; vitest excludes `e2e/**` |
| ~~4~~ | ~~Remaining E.8 gaps~~ | ~~ongoing~~ | ✅ **Done in B.26** — tags, PDF, no-log reminder, weekly digest |

### G. Quick Reference — Open Findings by File

> E.1–E.7 fully closed (all fixed, N/A, or confirmed false positive). Only E.8 product gaps remain.

| File | Still-open findings |
|---|---|
| `src/App.jsx` | ✅ All E.1–E.7 items closed. E.8 product gaps only. |
| `src/Routine.jsx` | ✅ All closed — DST fixed (B.24.b), streak fixed (B.11), TZ acknowledged N/A |
| `src/financeUtils.js` | ✅ All closed — monthly off-by-one is false positive (C.7) |
| `src/offlineSync.js` | ✅ All closed — cross-tab done (B.19.j) |
| `src/currencyConverter.js` | ✅ Closed — INR hardcode is by design |
| `src/credentials.js` | ✅ Closed — localStorage threat is N/A for BYODB personal app |
| `src/receiptUpload.js` | ✅ Closed — apiSecret same threat model as anon key, N/A |
| `api/_shared.ts` | ✅ All fixed |
| `api/send-reports.ts` | ✅ Closed — scale issues N/A for personal app |
| `api/setup-user.ts` | ✅ Closed — Management API token server-only confirmed |
| `nomad_setup.sql` | ✅ Closed — RLS/integrity/UNIQUE issues N/A for personal app |
| `api/__tests__/_shared.test.ts` | ✅ 0 failing |

#### B.26 (session 6) — All remaining E.8 product gaps

**B.26.a Custom wallets — `src/App.jsx`**
`WALLETS` constant (line 180) stays as default seed. New `wallets` state (localStorage `nomad-wallets-v1`) is the live source of truth. `wBal` useMemo now iterates `wallets.forEach` instead of hardcoded IDs. `wsb` initial state changed from `{upi_lite:0, bank:0, cash:0}` to `{}` (wallets default to 0). `TxCard` gains `wallets: wl` prop with `WALLETS` fallback; `WALLETS.find` → `wl.find`. `AddPage` gains `wallets: aw` prop; all three WB selectors use `aw` (income: filters `upi_lite` by id or `upiLite:true`). Dashboard wallet-card strip uses `wallets` state. Settings Wallets card (yellow, 👛): lists all wallets, inline rename (shared `editingCat` state with namespace prefix `wallet_${id}`), delete for non-WALLETS custom wallets, add-wallet form (name + color picker → id `w_<slug>_<base36>`).

**B.26.b Rename categories/sources — `src/App.jsx`**
Name span in Manage section (expense/income rows) now conditionally renders an `<input>` when `editingCat?.id === c.id`. Click on name → `sEditingCat({id, name})`; blur/Enter saves via `sCats`/`sIsrc`; Escape cancels. Recurring cats excluded (RC default-lock still in place).

**B.26.c Tags — REMOVED in B.27**
Tags were added in B.26 but removed in B.27 as redundant with the Events tab. The `tags TEXT[]` SQL columns remain in the DB (harmless) but are no longer written or read by the app. Do not re-add tags.

**B.26.d PDF/non-image attachments — `src/ReceiptPicker.jsx`, `src/receiptUpload.js`**
ReceiptPicker menu gains "PDF / File" option (`accept="image/*,application/pdf"`). File items get `isPdf` boolean; thumbnail shows 📄 emoji instead of `<img>`. `uploadReceipt` skips canvas compression for PDFs; uploads to `/raw/upload` endpoint on Cloudinary (not `/image/upload`). TxCard receipt row shows 📄 label for `.pdf` and `data:application/pdf` URLs.

**B.26.e No-log-in-3-days reminder — `src/App.jsx`**
`useEffect([loaded])`: checks latest date across `ex`+`inc`; if diff ≥ 3 days and today not already nudged (`nomad-last-log-nudge` key), shows toast "💤 No transactions logged in N days — stay on track!". Fires once per day per device.

**B.26.f Weekly digest card — REMOVED in B.27**
Weekly digest card and `Report` component removed from dashboard at user request. `<Report>` component definition still exists in source but is no longer rendered.

**B.26.g E2E Playwright smoke tests — `e2e/`**
5 spec files: demo mode, add expense/income, history search, settings (dark mode + wallets), delete/undo. `playwright.config.js` targets `localhost:5173` (mobile viewport 390×844). `npm run test:e2e`. Vitest `exclude: ['e2e/**']` prevents test runner conflict. `npm run test` (Vitest unit) still 259/259 passing. 6 E2E spec files: 5 original + `06-persistence.spec.js` (reload-based delete/receipt/split persistence tests using Playwright request interception).

#### B.28 (session 8) — AI module bug fixes

**B.28.a `redactor.js` stale regex `lastIndex` — `src/redactor.js`**
Module-level `/g` regex objects maintain `lastIndex` between `.replace()` calls across different strings, causing intermittent misses on repeated calls (e.g. second call to `redactText` on a new string could skip matches). Fixed: renamed `PATTERNS` → `PATTERN_DEFS` storing raw source strings + flags; `redactText` now calls `new RegExp(src, flags)` fresh each invocation. Zero performance impact (sub-ms per call).

**B.28.b `redactor.js` incomplete name redaction — `src/redactor.js`**
Name tag function used `m.replace(name, "[NAME]")` (`String.replace`) which only replaces the first occurrence of the captured name within the match string. Changed to `m.replaceAll(name, "[NAME]")`.

**B.28.c `foodVision.js` zero-dimension image crash — `src/foodVision.js`**
Corrupt or zero-dimension images produced `Math.min(1, 800/0) = Infinity` → 0×0 canvas → empty base64. Added guard in `img.onload`: `if (!img.width || !img.height) { reject(new Error("Image has zero dimensions...")); return; }`.

**B.28.d `foodVision.js` silent null on 200 — `src/foodVision.js`**
`res.json().catch(() => null)` silently returned `null` when a 200 response body was unparseable (CDN error page, proxy HTML, etc.). The `!res.ok` guard passed (200 is ok), function returned `null` to caller with no error thrown. Added `if (!data) throw new Error("Food analysis returned an unreadable response. Try again.")` after the JSON parse.

**B.28.e `food-vision.ts` `provider` field never populated — `api/food-vision.ts`, `api/_ai-provider.ts`**
`FoodResult.provider` was in the interface and JSDoc but the response object never set it. Added `callVisionWithProvider()` export to `_ai-provider.ts` that returns `{content: string, provider: string}`. `food-vision.ts` now uses it and sets `provider` in the final result object.

**B.28.f `financeScore.js` `daysInMonth` not a Date method — `src/financeScore.js`**
`new Date(month + "-01T00:00:00").daysInMonth?.()` — `daysInMonth` is not a native Date method, always returned `undefined`, optional chaining fell back to `?? 30` (coincidentally correct). Variable was also computed but never used in the actual calculation (`TARGET = 20` hardcoded per docstring). Removed the dead variable entirely.

**B.28.g `_ai-provider.ts` `max_tokens: 512` too small — `api/_ai-provider.ts`**
512 tokens is insufficient for `ai-insights.ts` which generates 3–5 detailed insight objects (easily 600–900 tokens). Bumped `max_tokens` to `1024` in both `textBody` and `visionBody`.

**B.28.h `_ai-provider.ts` `extractJSON` too narrow — `api/_ai-provider.ts`**
Only stripped leading/trailing ` ```json ` fences. Models often return preamble text before the JSON block ("Sure! Here is the JSON:"). Added fallback: if cleaned text doesn't start with `{` or `[`, extract the first `{...}` or `[...]` block via regex.

#### B.27 (session 7) — Bug fixes, removals, filter improvements

**B.27.a `refundItem` undefined → history tab blank screen — `src/App.jsx`**
`onRefund={refundItem}` was wired in historyItems.map but `refundItem` was never defined. Added definition before `settle()`: calls `addI()` with same amount/wallet, `sourceId=isrc[0].id`, note prefixed "Refund: " (capped 500 chars), today's date.

**B.27.b Bulk delete arg order fixed — `src/App.jsx`**
Bulk delete called `delItem(it.type, id)` but signature is `delItem(id, type)`. Fixed to `delItem(id, it.type)`.

**B.27.c `sbGet` 400 errors on splits/settlements/wallet_balances — `src/App.jsx`**
`sbGet` was appending `&deleted_at=is.null` to every table, causing 400s on tables without that column. Added `SOFT_DELETE_TABLES` Set (`expenses`, `incomes`, `transfers`, `recurring`, `events`); only those get the filter. No more fallback retries on every load for the other tables.

**B.27.d Tags removed — `src/App.jsx`**
Tags were redundant with Events tab. Removed: `tagInput`/`tags` state from AddPage, chip UI, `#tag` display from TxCard, `hTag` filter state, Tag filter panel input, `historyItems` filter, `addE`/`addI` toSB key. SQL columns remain in DB (harmless).

**B.27.e Weekly digest card + Report component removed — `src/App.jsx`**
`<Report expenses={ex} />` call removed from dashboard render. `Report` function definition still in source but unreachable.

**B.27.f Event name in history search — `src/App.jsx`**
`historyItems` search now also matches `evs.find(e => e.id === it.eventId)?.name` — typing an event name in the search bar finds all linked expenses.

**B.27.g Recurring filter in history — `src/App.jsx`**
Added "Recurring" button to history type-filter row. Filters to `type === "expense" && isFix(it)` — shows only fixed/recurring-tagged expenses. `evs` added to `historyItems` dep array.

#### B.29 (session 9) — Voice add, habit streaks/goals, macro, workout, meditation, receipt OCR, photo timeline, push scheduler, weekly routine email

Full session: 13 of 13 user-requested features shipped or verified-already-existing. No items deferred.

**B.29.a Voice add via Web Speech API — `src/App.jsx`**
New `parseVoiceTx(transcript, { wallets, categories })` pure helper and `VoiceAdd({ onParsed, accent })` component, both defined immediately above `function AddPage`. `VoiceAdd` returns `null` when `window.SpeechRecognition`/`webkitSpeechRecognition` is unavailable (older browsers, Firefox desktop), so the button only renders when the API exists. On click it starts recognition with `lang="en-IN"`, `continuous=false`, `interimResults=false`, calls `onParsed(transcript)` once, then ends. `parseVoiceTx` extracts: amount (first numeric token, handles "rs"/"rupees"/"₹"/"bucks" prefix/suffix), walletId (matches wallet aliases — `upi_lite`: `["upi lite","upi","lite"]`; `bank`: `["bank","account","debit"]`; `cash`: `["cash"]`; custom wallets matched by lowercase name), categoryId (first match against category name), and note (residue after stripping amount + filler verbs). Wired in AddPage between the type-toggle row and QUICK ADD chips for `type === "expense" || type === "income"` only (transfers/recurring skipped). Toast shows `Heard: ₹{amt} {note}` on success, error toast on parse fail. New icon import: `Microphone` from `@phosphor-icons/react`.

**B.29.b Habit-level streaks per daily item — `src/Routine.jsx`**
Two new pure helpers near `todayKey`: `habitStreak(itemId, allData)` walks back from today counting consecutive days where `allData[date].dailyChecks[itemId] === true`. Today counts if checked; otherwise walks back from yesterday. `habitWeekDone(itemId, allData, windowDays = 7)` counts checked days in the last N days. Both use `d.setHours(12, 0, 0, 0)` noon-anchor pattern to avoid DST off-by-one (same convention as `financeUtils.js` and the B.24.b Routine.jsx fixes). Wired into the custom-daily-item tile renderer (around `(config.customDailyItems || []).filter(it => !it.archived).map`): tile meta line now shows `done · Nd streak` (when streak ≥ 2) instead of `done`; idle tiles show `N/M this week` when a goal is set, else `tap · Nd streak`. Tile label gets 🔥 emoji suffix when streak ≥ 7.

**B.29.c Weekly goal per daily item — `src/Routine.jsx`**
`customDailyItems` config items gain optional `target: number` field (0 = no goal, max 7). Settings → Daily items: each item row gets a new "Weekly goal" stepper row below the name/icon, separated by dashed border. Value reads `target/7` or `off`. Stepper increments/decrements with clamps `[0, 7]`. `sanitizeConfig` already shallow-merges `customDailyItems` array, so adding `target` requires no migration — existing items get `undefined` (treated as no goal). Tile meta uses target via `habitWeekDone()` for the `N/M this week` display.

**B.29.f Macro goals + per-macro progress bars — `src/Routine.jsx`**
`DEFAULT_CONFIG` gains four new fields: `calGoal: 2000`, `proteinGoal: 80`, `carbsGoal: 250`, `fatGoal: 65`. `sanitizeConfig` clamps each to sensible ranges (cal 800–5000, protein 20–300g, carbs 50–600g, fat 20–200g). Settings → Targets section: 4 new stepper rows (kcal in 100-step increments, protein/fat in 5g, carbs in 10g). Food-screen macro display (the block that used to show stacked P/C/F ratio bar) replaced with: calorie progress bar (existing) + 3 per-macro progress bars below it, each showing `{label} {val}g` and `/{goal}g · {pct}%`. Bars use protein=#7B8CDE / carbs=var(--amber-deep) / fat=#E07A5F colors. `MacroBar` is an inline component inside the IIFE — defined per render but only when food log has entries, so React doesn't churn it across re-renders of the FoodScreen.

**B.29.g Meditation timer — `src/Routine.jsx`**
New `MeditationCard` component (above `FoodScreen`). Presets: 5/10/15/20 minutes. Active state runs `setInterval` 1Hz that decrements remaining seconds. On finish: vibrates (200/100/200 ms via `navigator.vibrate`), shows success toast, and writes both `day.meditationMin += mins` (cumulative across multiple sessions) AND `day.dailyChecks.meditation = true`. The `dailyChecks.meditation` flag means `habitStreak('meditation', allData)` (from B.29.b) works out of the box for streak tracking — no parallel state machine. Stop button cancels the session without logging. `DEFAULT_DAY` gains `meditationMin: 0`. Card wired between sleep card and water card in `FoodScreen`.

**B.29.h Workout / exercise log — `src/Routine.jsx`**
New `WorkoutCard` component (above `FoodScreen`). Type chips: cardio/strength/yoga/other. Duration stepper (5-minute increments, 0–300 range). Notes input (free text for sets/reps/route). Stores as `day.workout = { type, durationMin, notes }` — null when no workout logged. Clear button (×) sets workout to null. Card wired below meditation card in `FoodScreen`. `DEFAULT_DAY` gains `workout: null`.

**B.29.d Verified as already-shipped (no code change needed)**
- **Push notifications** — `api/vapid-key.ts`, `api/push-subscribe.ts`, `api/push-self.ts` all exist. `public/sw.js` has `push` event listener (line 69) and `notificationclick` handler. `App.jsx` line 931 has `pushSubscribed` state + subscribe flow. End-to-end works for on-demand sends; missing piece is a *scheduler* that periodically fires bill-due/streak-break pushes (filed as task #15, deferred).
- **AI insights as cards** — `App.jsx:1730` renders the dashboard AI Insights card with `aiInsights.insights.map` producing per-insight sub-cards. Type-coded (warning/tip/pattern/achievement) with icons + severity badge. Collapsible. Refresh button calls `/api/ai-insights`. User had asked for this; it was already present.
- **Sleep tracker** — `DEFAULT_DAY` includes `sleepTime`, `wakeTime`, `sleepQuality` (line 1654-1656). UI: sleep card around `Routine.jsx:2236` with time inputs + 5-point quality chip selector. `calcSleepDuration()` helper handles cross-midnight math. Calendar drill-in shows sleep summary. Avg sleep computed in stats.
- **Mood tracker** — `moodChip` field (DEFAULT_DAY line 1644) with chip-picker UI at `Routine.jsx:2223`. `MOOD_EMOJI` map renders emojis in calendar (~line 2996). `notes` free-text field for journal entry. No separate trend chart, but per-day emoji visible in calendar.
- **Water tracking** — `parseMorningWater()` (line 1515) handles `Xml` / `XL` / numeric input. `effectiveMorningWater()` returns litres when checkbox is on. `waterTarget` in DEFAULT_CONFIG with stepper. Avg water stat in calendar view.

**B.29.i Receipt OCR via Claude vision waterfall — `api/receipt-ocr.ts`, `src/ReceiptPicker.jsx`, `src/App.jsx`**
New `api/receipt-ocr.ts` endpoint mirrors `api/food-vision.ts` structure exactly: same `callVisionWithProvider` + `extractJSON` pattern, same 2.8MB base64 cap, same error model. System prompt asks for `{merchant, amount, date (ISO), currency, confidence}` JSON. `ReceiptPicker` gains `getFirstImageData(maxPx=800, quality=0.7)` imperative method that returns `{imageBase64, mimeType}` for the first non-PDF item (compresses to 800px JPEG via canvas). Also exposes `hasImage` getter. AddPage gains `scanReceipt()` handler + new dashed button "Scan receipt — auto-fill amount, merchant, date" shown only for `type === "expense"` after at least one image is added. Tap → POST to `/api/receipt-ocr` → prefill amount/note (merchant)/date if returned values match expected shapes.

**B.29.j Photo timeline — `src/Routine.jsx`**
`skinPhoto` + `hairPhoto` per-day photo capture was already wired (DEFAULT_DAY fields, upload UI on home tab, single-day display in calendar drill-in). Added new `logView === 'photos'` mode in the Log screen alongside Month/Week views. New "Photos" button (`IconCameraFilled`) in the toggle row. View shows up to 60 most-recent days as a grid (`gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))'`); each tile is a square thumbnail (skinPhoto preferred, hairPhoto fallback) with date label and a "2" badge when both photos exist for that day. Tap tile → `setActiveDay(k)` for full drill-in. Empty state when no photos logged. Skips days with no photos (filter at the source).

**B.29.k Push scheduler + per-slot reminders — `api/push-scheduler.ts`, `nomad_setup.sql`, `src/Routine.jsx`, `vercel.json`**
New SQL tables: `routine_reminders` (id, slot_id, label, time_hhmm, days_mask bitmask Sun=1..Sat=64, offset_minutes, enabled, last_sent_at) and `routine_report_schedules` (single-row 'self' for the user). Both DISABLE RLS to match existing convention. New `api/push-scheduler.ts` runs hourly via Vercel cron `0 * * * *`. Auth: same `CRON_SECRET` pattern as `send-reports.ts` (or `x-vercel-cron` internal header). Per-tick flow: load `user_registry` → for each user (concurrency=5, 30s timeout) load `push_subscriptions`, `routine_reminders`, `recurring` bills, last 2 `routine_daily_logs`. Three notification types: (1) per-slot reminders — `shouldFireReminder()` computes user-local time via `nowUtc + offset_minutes`, checks day_mask bit + hour match + last_sent_at on user-local date; (2) bills due today — only fires when `UTC hour < 4` to avoid hourly duplicates; (3) streak-at-risk — only fires when `UTC hour ∈ [12, 16]` (evening IST window), when last log is 2–7 days old. Sends via `webPush.sendNotification`; ignores 404/410 (send-reports cleanup handles stale subs). Updates `last_sent_at` after successful fire. Routine settings adds Reminders section (collapsible) that loads from `routine_reminders` on first open, supports add/toggle/delete via `sbUpsertR`/`sbDeleteR`. Vercel cron entry added.

**B.29.l Weekly routine email report — `api/send-routine-report.ts`, `src/Routine.jsx`, `vercel.json`**
New `api/send-routine-report.ts` runs daily via Vercel cron `0 3 * * *`. Same auth pattern as push-scheduler. Per user: fetch `routine_report_schedules?enabled=eq.true` (single row, id='self'), check if today's user-local day-of-week matches `send_day_of_week` AND user-local hour matches `send_hour ± 1`, AND `last_sent_at` ≥ 6 days ago. If yes: fetch past 7 days of `routine_daily_logs`, build HTML via `buildHtml()` (sleek inline-styled summary: 7-day cell grid with mood emojis, 3 stat cards [days logged, completion %, avg sleep], workout/meditation totals, top mood callout), send via Gmail (`nodemailer.createTransport({ service: 'gmail' })`), patch `last_sent_at`. Concurrency=5, per-user 30s timeout. Routine settings adds "Weekly email summary" section with: enable checkbox, email input, day-of-week selector, hour stepper, Save button. Saves to `routine_report_schedules` via `sbUpsertR`. Offset_minutes derived from `-new Date().getTimezoneOffset()` at save time so server's "user-local" math works correctly without further client input.

### H. Notes for Future Claude Sessions

1. **Do not re-investigate the items in section C (false positives).** They are correct in the existing code. C.9 = TxCard memo already done. C.10 = quickPatterns already done.
2. **Always run `npm run lint` and `npm test` before and after edits.** Current baselines (verified May 2026, session 9):
   - **Lint:** 82 problems (73 errors, 9 warnings). New edits must not increase this count.
   - **Tests:** **259 pass / 0 fail (259 total).**
   - Do not be alarmed by the lint count difference from prior sessions — it reflects a different codebase state.
3. **`App.jsx` and `Routine.jsx` are written one-line-per-JSX-block.** When editing, use a unique substring as `old_string` — do **not** attempt to reformat. The build will break.
4. **`dist/` is gitignored but historically tracked.** Don't commit rebuilt `dist/` unless explicitly asked; Vercel rebuilds on push. After running `npm run build`, run `git checkout HEAD -- dist/` before staging.
5. **`AddPage` is a sub-component** (line 419) without direct access to the main `App` state. Pass callbacks (like `onError`) as props rather than reaching for global state.
6. **Sync queue is the riskiest data structure.** Anything that mutates `nomad-sync-queue-v1` or replays it must be idempotent and must surface failures to the user. The new `subscribeSyncDrops` channel (B.4.d) is the user-visible signal — wire any new drop conditions through it. Dead-letter queue is `nomad-sync-failed-v1` (B.10.b).
7. **All 133 tests now pass.** The previously-failing `_shared.test.ts` tests are fixed (see D.1.2). Test baseline is 133/133.
8. **`nomad_setup.sql` is idempotent and safe to re-run.** All migrations use `ADD COLUMN IF NOT EXISTS`, `DROP TRIGGER IF EXISTS`, and `DROP CONSTRAINT IF EXISTS` patterns. The `deleted_at` and `updated_at` migrations (B.7.a, B.13.a) will apply cleanly to existing databases.
9. **`receiptUpload.js` supports three modes** (B.18, B.20): (1) Signed — `cloudName`+`apiKey`+`apiSecret` → SHA-1 via `crypto.subtle`; (2) Unsigned — `cloudName`+`uploadPreset`; (3) Local fallback — no `cloudName` → compress + return data URL. Tests that exercise the upload path must mock `getCredentials()` appropriately for the mode under test. `isLocalReceipt(url)` detects locally-stored receipts (`url.startsWith("data:")`). App.jsx shows an info toast when a local receipt is saved.
10. **`uid()` (App.jsx:16) prefers `crypto.randomUUID()`.** Don't reintroduce shadowing — the renamed `userKey` constants (subdomain ref) live alongside it (B.8.b).
11. **`api/send-now.ts` requires the caller's supabase_url to be in `user_registry`.** Owner's URL is exempt. If you add new server endpoints that take user creds from the request body, mirror the same pattern.
12. **`sbDelete` is now a soft delete (PATCH `deleted_at=now()`).** `sbDeleteWhere` remains a hard DELETE (bulk cascade ops and the nuke). `sbGet` filters `deleted_at=is.null` with a 400-fallback for pre-migration databases.
13. **Conflict detection (B.17)** targets `recurring` table only. Versions are stored in `nomad-record-versions-v1` keyed `{table}:{id}`. Flush always strips `If-Unmodified-Since` so replays always win. 412 is a `kind:"conflict"` drop — toast shown, change discarded.
14. **Signed Cloudinary (B.18)** uses `apiKey` + `apiSecret` from credentials. The `apiSecret` is in localStorage — same threat model as the Supabase anon key. A proper signing endpoint would avoid client-side secret exposure but requires a Vercel env var and server roundtrip.
15. **Demo mode (B.24.a)**: `isDemoMode = !_creds.sbUrl && localStorage.getItem("nomad-demo-mode")==="true"` (module-level). `sbGet` returns `[]`, `sbWrite` returns `{ok:true}` — no network calls. `DEMO_DATA` constant seeded with March–May 2026 data. `CredentialSetup` shows landing screen (`step="landing"`) only when `!onCancel` (first-time flow). "Connect Backend" from the demo banner: `localStorage.removeItem("nomad-demo-mode"); setShowSetup(true)` — CredentialSetup shows form (not landing) because `onCancel` is defined.
16. **Refund flow (B.24.c)**: `TxCard` has `onRefund: oRef` prop. Small ↩ button (green, opacity 0.5) appears on expense cards. `refundItem(expense)` calls `addI()` with same amount/wallet, `sourceId=isrc[0].id`, note prefixed "Refund: ". Wired at line `historyItems.map(it => <TxCard ... onRefund={refundItem} ... />)`.
17. **E.1–E.7 are fully closed.** All open items are either: fixed in B.1–B.25, confirmed false positives (C.1–C.10), or acknowledged as N/A for a personal single-user BYODB app. Only E.8 product gaps remain as future work.
18. **Startup is stale-while-revalidate (B.25.h).** `load()` calls `loadLocalBackup()` + `sL(true)` immediately before any network call. Never reintroduce `await sbGet(...)` before `sL(true)` — that was the source of the startup delay.
19. **`autoRules` in `nomad-auto-rules` localStorage.** Cleared by the "Clear All Data" sweep (already covered by the `nomad-*` wildcard). `AddPage` receives `autoRules` prop and auto-selects category on note input. Do not move this to Supabase — it's a local UX preference, not transactional data.
20. **`grpShareMap` for exact group shares (B.25.g).** Group event summary uses `distributeAmount(grpTotal, n)` → `grpShareMap` rather than `roundMoney(total/n)`. Both the per-person balance display and the settlement IIFE use `grpShareMap[p] ?? grpShare`. Do not revert to the `grpShare` scalar — it produces ₹0.01 residue in 3-way splits.
21. **`paidBy` in `addE` Supabase upsert column list.** The `toSB` call in `addE` must include `"paidBy"` — omitting it breaks group summaries after page reload (field would be `null` in Supabase while in-memory state has the correct value).
22. **`wallets` state (B.26.a)** is the live source of truth for all wallet rendering. `WALLETS` constant is the default seed only. `wBal` iterates `wallets.forEach` — never revert to hardcoded `{ upi_lite, bank, cash }`. `wsb` initial state is `{}`. Custom wallets get ids like `w_gpay_<base36>`. `editingCat` state is shared between category rename and wallet rename (wallet rename uses `wallet_${w.id}` as the id key).
23. **Tags removed (B.27.d).** Do NOT re-add tags — redundant with Events tab. The `tags TEXT[]` SQL columns exist in DB but are never written or read by the app.
24. **E2E tests (B.26.g)** live in `e2e/` and use `@playwright/test`. Run with `npm run test:e2e`. They depend on the dev server (`npm run dev`). Unit tests (`npm test`) exclude `e2e/**` via `vite.config.js` `test.exclude`. The two test runners must never be confused — Playwright tests have a `page` fixture that Vitest doesn't know about.
25. **All E.8 product gaps are fully closed as of B.26/B.27.** No open items remain. Future work is greenfield improvements only.
26. **History search includes event name (B.27.f).** `historyItems` matches `evs.find(e => e.id === it.eventId)?.name` — `evs` is in the dep array.
27. **History type filter includes "Recurring" (B.27.g).** Maps to `type === "expense" && isFix(it)`. Not a separate transaction type — just a view filter over expenses.
28. **`SOFT_DELETE_TABLES` (B.27.c)** = `Set(["expenses","incomes","transfers","recurring","events"])`. Only these get `&deleted_at=is.null` in `sbGet`. `splits`, `settlements`, `wallet_balances` do not have that column and must not get the filter.
29. **`refundItem` (B.27.a)** defined in App.jsx before `settle()`. Creates income via `addI()`. `TxCard` receives `onRefund={refundItem}` prop — do not remove it.
30. **`redactor.js` (B.28.a)** builds fresh `RegExp` objects per call — never revert to module-level `/g` regex objects. `PATTERN_DEFS` stores `{src, flags, tag}` tuples.
31. **`callVisionWithProvider` (B.28.e)** is the correct import for `food-vision.ts` — returns `{content, provider}`. Plain `callVision` still exists for callers that don't need the provider name (`ai-insights`, `ai-categorize`, `ai-chat` all use `callText` anyway).
32. **`extractJSON` (B.28.h)** now handles JSON embedded mid-text. Falls back to regex extraction of first `{...}`/`[...]` block when cleaned text doesn't start with `{` or `[`.
33. **AI modules baseline (B.28):** `api/_ai-provider.ts`, `api/food-vision.ts`, `api/ai-insights.ts`, `api/ai-categorize.ts`, `api/ai-chat.ts`, `src/redactor.js`, `src/foodVision.js`, `src/financeScore.js` — all bugs fixed. Unit tests for these modules are still covered by the existing 266-test suite via indirect imports. Direct unit tests for AI modules would require mocking fetch + env vars — future work if needed.
34. **`COLS` in `src/dbCols.js` is the ONLY source of truth for Supabase column lists.** NEVER write an inline array in a `toSB()` call — always use `COLS.<table>`. When you add a new DB field (e.g. `tags` to expenses), add it to `COLS.expenses` in `src/dbCols.js` once and it automatically propagates to every write path (add, undo, first-connect sync, paidBy, etc.). The `src/__tests__/dbCols.test.js` suite asserts required fields per table and will fail CI if a critical field is removed. This pattern was introduced to fix repeated "field disappears on one specific write path" bugs.
35. **GitHub Actions CI (`/.github/workflows/ci.yml`)** runs `npm test` + `npm run build` on every push and pull request. Tests must stay green before merging. If CI is red, fix the tests — do not skip or ignore the failure.
36. **`parseVoiceTx` and `VoiceAdd` (B.29.a)** live in `src/App.jsx` immediately above `function AddPage`. `parseVoiceTx` is a pure function — testable. `VoiceAdd` returns `null` when Speech Recognition API is unavailable; do not assume the button renders. The wallet-alias map inside `parseVoiceTx` covers `upi_lite`/`bank`/`cash` only; custom wallets are matched by lowercase name. If you add a new built-in wallet, add its aliases to the map. Voice button only renders for `type === "expense" || type === "income"` — transfers and recurring don't use it.
37. **`habitStreak` and `habitWeekDone` (B.29.b)** live in `src/Routine.jsx` near `todayKey`. Both use `d.setHours(12, 0, 0, 0)` noon-anchor to avoid DST off-by-one (matches `financeUtils.js` convention and the B.24.b Routine.jsx fixes). They only read `dailyChecks[itemId]` — if you add new tracked daily fields (e.g. meditation as a checkbox), reuse these helpers by setting `dailyChecks[meditation] = true` rather than writing a parallel streak function.
38. **`customDailyItems[].target` (B.29.c)** is `0` (or `undefined`) for "no goal", otherwise an integer in `[1, 7]`. Settings stepper enforces the range. UI reads `Number(it.target) > 0` to decide whether to show "N/M this week" vs "tap to log". Adding a new field to `customDailyItems` does not require a `sanitizeConfig` change — `customDailyItems` is shallow-merged as an array; missing fields default to `undefined`.
39. **Web Push infra is wired end-to-end but has no automatic scheduler.** `api/vapid-key.ts`, `api/push-subscribe.ts`, `api/push-self.ts` exist; `public/sw.js` has `push` + `notificationclick` handlers; `App.jsx:931` has subscribe flow. On-demand sends work. **What's missing**: a cron that automatically fires bill-due / streak-break / slot-reminder pushes. Filed as deferred task #15 (see B.29.e). If you build it, mirror `send-reports.ts` concurrency pattern (`Promise.allSettled`, per-user 30s timeout). Skip users whose `push_subscriptions` table is empty.
40. **B.29.d audit findings** — do not re-investigate as missing: push notifications wired, AI insights already render as dashboard cards, sleep tracker exists (`sleepTime`/`wakeTime`/`sleepQuality`), mood tracker exists (`moodChip` + free-text `notes`), water tracking exists (`parseMorningWater`/`waterTarget`/`effectiveMorningWater`). These were confirmed in session 9 by reading the current code, not relying on prior memory.
41. **`MeditationCard` (B.29.g)** writes both `day.meditationMin += mins` AND `day.dailyChecks.meditation = true` on session finish. This is intentional — the `dailyChecks.meditation` flag lets `habitStreak('meditation', allData)` work out of the box without parallel state. If you add a "meditated today" check elsewhere, read `dailyChecks.meditation`, not the minutes total.
42. **`WorkoutCard` (B.29.h)** stores `day.workout = { type, durationMin, notes }` or `null`. The clear button (×) sets to `null`, not `{}` — keep that contract (downstream readers check `if (day.workout)` to detect a logged session).
43. **Macro goals (B.29.f)** live in `DEFAULT_CONFIG.calGoal`/`proteinGoal`/`carbsGoal`/`fatGoal`. `sanitizeConfig` clamps them. The `MacroBar` inline component lives inside the macro-display IIFE in `FoodScreen` — it's redeclared per render but only when `dailyCals > 0`. Don't hoist it out unless you also handle the conditional rendering — extracting it adds risk of React component-identity churn.
44. **Receipt OCR (B.29.i)** uses `api/receipt-ocr.ts` mirroring `food-vision.ts`. `ReceiptPicker.getFirstImageData()` is the ONLY way to extract a base64 from the picker — do not duplicate canvas compression elsewhere. The button only renders for `type === "expense"` and only when at least one image is present. If you add multi-receipt OCR, batch the calls — don't try to send all images in one POST (server only accepts single `imageBase64`).
45. **`push-scheduler.ts` (B.29.k)** runs hourly. Time-of-day gates protect against duplicate fires: bills only `UTC hour < 4`, streak only `UTC hour ∈ [12, 16]`. Per-slot reminders dedupe via `last_sent_at` compared on user-local date (not UTC). Adding a new notification type: pick a non-overlapping hour window, dedupe via `last_sent_at` or a per-day tag, write back to its own column. Don't try to stuff multiple types into the same `last_sent_at` field.
46. **Reminder days_mask convention (B.29.k)** — bitmask Sun=1, Mon=2, Tue=4, Wed=8, Thu=16, Fri=32, Sat=64. `127` = all days. Stored as plain integer in `routine_reminders.days_mask`. JS `(days_mask & (1 << localDow)) !== 0` tests a day. UI currently always writes 127 (every day); future inline day-picker can map to bits.
47. **`offset_minutes` convention (B.29.k, B.29.l)** — positive for east of UTC (IST = +330). Stored at write time via `-new Date().getTimezoneOffset()` (the JS API returns minutes WEST). Server math: `userLocalMs = nowUtc.getTime() + offset_minutes * 60_000` then read UTC getters on the result. This way the server doesn't need a TZ database.
48. **Weekly routine email (B.29.l)** — single row per user, `id='self'`. UI loads on settings expand. Server-side check: `localDow === send_day_of_week && |localHour - send_hour| <= 1 && nowUtc - last_sent_at >= 6 days`. Don't tighten the hour window to 0 — Vercel cron runs at minute :00 but with a small jitter, and our cron only runs at `0 3 * * *` UTC so the local-hour delta must accommodate users across timezones whose local hour at 3 AM UTC differs.
49. **SQL migrations B.29.k** — `nomad_setup.sql` gains `routine_reminders` and `routine_report_schedules` tables. Both `CREATE TABLE IF NOT EXISTS` and DISABLE RLS. Idempotent — re-running the script is safe.
50. **Vercel cron registrations (B.29.k, B.29.l)** — `vercel.json` gains two new cron entries beyond `send-reports`: `/api/push-scheduler` at `0 * * * *` (hourly) and `/api/send-routine-report` at `0 3 * * *` (daily). When adding more crons, remember Vercel's free tier limits cron count.
