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

#### E.1 Security (4 open)

> E.1 #2 (unsigned Cloudinary) closed in B.18 — SHA-1 signed uploads via Web Crypto; unsigned preset fallback for legacy users.

| Pri | Finding | Location | Notes |
|---|---|---|---|
| **C** | RLS disabled on every table — anon key is the entire authentication boundary. Leaked URL+key = full data access | `nomad_setup.sql:95-102, 160-161, 187-188` | BYODB model assumes per-user isolation; document the threat model. Architectural — needs auth-model decision |
| **H** | Anon key in localStorage — extension with `host_permissions` reads it | `credentials.js:7` | App has no XSS surface today (verified — no `innerHTML`/`dangerouslySetInnerHTML`/`eval`) but adding one is instant credential exfil. Architectural |
| **M** | Email leakage via `report_schedules` lookup with anon key | `App.jsx:798` | Implied by RLS=off but worth noting |
| **M** | Verify Management API token handling in `setup-user.ts` | `api/setup-user.ts` | Confirm token is server-only, never echoed to client; avoid logging. Audit-only task |

#### E.2 Sync / Offline (2 open)

> E.2 #1 (dedupe merge) and E.2 #2 (per-item retry dead-letter) closed in B.10.
> E.2 #3 (conflict detection) closed in B.17 — `If-Unmodified-Since` on recurring edits; 412→conflict drop; header stripped on offline replay.

| Pri | Finding | Location | Notes |
|---|---|---|---|
| **H** | User can clear localStorage with pending queue (incognito close, "Clear site data") | Browser-level | Mitigated: Sync Status card (B.7.b) surfaces pending count. Cannot block browser-level clears; warn before in-app destructive ones |
| **M** | Two tabs / two devices have no cross-tab sync | App-wide | ✅ `storage` event listener shows "Another tab updated data" banner with Reload option (B.19.j). Full automatic merge not attempted — reload is the safe path. |

#### E.3 Date / Timezone (3 open)

> E.3 #1 (streak today), E.3 #3 (yearly clamp warning), E.3 #5 (send_day_of_month 28→31) closed in B.11, B.12, B.16.
> Note: `_shared.ts:58, 61` still has the old 28-cap in the **backend** cron math — the SQL and UI are fixed but the server-side `getNextSendAt` clamp was not changed (it's in TypeScript; the 7 pre-existing test failures in `_shared.test.ts` relate to this file — investigate before editing).

| Pri | Finding | Location | Notes |
|---|---|---|---|
| **H** | Timezone-tied date keys, no anchor stored | `Routine.jsx:2436`, `financeUtils.js:3-9` | Travel Mumbai → Tokyo flips a day forward; back trip overwrites. No `tzOffset` stored per record. Architectural — needs decision on per-record vs per-account anchor |
| **M** | `fullMonthsBetween` off-by-one with month-end starts | `financeUtils.js:17-21` | Start = Jan 31, today = Mar 30 → returns 1, not 2. Affects 31st-rent edge cases |
| **L** | DST edges in offset-naive math | `Routine.jsx:2447` | `new Date(year, month, i)` lacks the noon anchor used elsewhere in `financeUtils.js` |

#### E.4 Backend / Cron Scale (5 open)

| Pri | Finding | Location | Notes |
|---|---|---|---|
| **C** | Cron is still serial within each chunk | `send-reports.ts` | Mitigated: chunked concurrency=5 + per-user 30s timeout (B.6.a). At 1M users, still no chance. Re-architect to fan-out via Inngest / QStash / Vercel Queue / pg_cron with retries + dead-letter |
| **H** | Gmail SMTP capped at 500/day | `send-reports.ts:30` | Past ~500 users on the same day, cron silently errors out. Move to Resend (`OWNER_SETUP.md` already mentions it). Needs ESP swap |
| **M** | Per-user Supabase cold start can time out | Free-tier projects pause after 7 days idle | Mitigated by per-user 30s wall clock (B.6.b). Cap concurrent cold-starts; surface "your project is paused" warning |
| **M** | Single-tenant DB → can't grep production at scale | Architectural | Plan opt-in anonymized telemetry channel |
| **L** | `report_schedules.send_day_of_month` clamp at 28 in cron math | `_shared.ts:58, 61` | ✅ Fixed in B.19.m — now clamps to actual last day of target month |

#### E.5 Architecture / Performance (8 open)

| Pri | Finding | Location | Notes |
|---|---|---|---|
| **H** | `App.jsx` is 1470 lines; near-minified one-line-per-block style | `App.jsx` whole file | Diff review is hard (see this branch's commits). Split along screen boundaries. Architectural — needs explicit decision to override the "intentional" note |
| **H** | `Routine.jsx` reads entire `allData` JSONB blob on every read/write | `nomad_setup.sql:175-179`, `Routine.jsx` | 3 years × ~1KB/day = 1MB+ per read. Migrate to one row per `(user_id, date)` |
| **H** | `wallet_balances` is a denormalized cache with no integrity invariant | `nomad_setup.sql:90-93` | Two tabs both read balance, both decrement, both write — last write wins, ledger drifts. "Verify & repair" tool postponed pending decision on whether balances are derived (already true in `wBal` memo) or stored authoritatively |
| **H** | Settlements/recurring/splits issue multiple writes without rollback | `App.jsx` recurring & settlement flows | Crash mid-sequence → wallet balance, expense row, split row mutually inconsistent. Server-side `RPC` would close this |
| **M** | `App.jsx` re-renders on every state change — no `useMemo`/`React.memo` on `TxCard`, no virtualization on history list | App-wide | Janky after 5+ years of data |
| **M** | Heatmap renders all expenses, no windowing | `App.jsx:240` (`Heatmap`) | ✅ Aggregation memoized with `useMemo([ex, pfx])` (B.19.n) — O(n) scan now only runs on data/month change, not every render |
| **L** | Receipt upload + transaction insert not coupled | Add-expense flow | ✅ Partially addressed (B.19.k): form no longer clears on validation failure, so user can retry without losing form state. Blobs already uploaded before a server 5xx are still orphaned — full fix requires a Cloudinary signing endpoint. |

> E.5 #7 (SW manual cache version) closed in B.15 — Vite plugin auto-injects build timestamp.

#### E.6 Other Edge Cases (10 open)

> E.6 #1 (soft delete) closed in B.13. E.6 #8 (UPI Lite slice) closed in B.14. E.6 M (skipped-vs-paid badges) and E.6 M (orphan-category warning) closed in B.19.

| Pri | Finding | Location | Notes |
|---|---|---|---|
| **H** | "Clear All Data" non-atomic across tables | `App.jsx:1418` | Mid-network nuke leaves 3/8 tables empty, others not. Mitigated by "Download backup first" nudge (B.9.c). A server-side function would close it fully |
| **H** | Refund flow doesn't exist | App-wide | Returned purchase becomes "negative expense" or "fake income"; either choice corrupts category analytics |
| **M** | Deleting a category orphans expenses | App-wide | ✅ Warning toast added (B.19.f) — shows orphan count. Ghost data still exists but user is warned |
| **M** | Deleting a participant from a group event after a split | App-wide | Settlement math no longer balances; orphan owes nobody |
| **M** | Custom split with ₹0 participants — input-side validation | `App.jsx:703` | Submit-side guard already drops 0-amount rows; the input could reject earlier with a per-row warning |
| **M** | `getExchangeRate` hardcodes INR target | `currencyConverter.js:29-31` | ✅ Renamed from `getINRRate` → `getExchangeRate` (B.19) to reduce misleading name; INR target still hardcoded |
| **L** | `JSON.stringify` loses precision past 2^53 | `App.jsx:904` | Not relevant for INR; flagged for completeness |
| **L** | `report_schedules` UNIQUE on `user_id` | `nomad_setup.sql:117` | Only one schedule per user; can't have daily + weekly. Drop the UNIQUE if needed |
| **L** | Streak gaming: edit `allData` JSON directly in Supabase | `Routine.jsx` data model | If you care about streak integrity, lock past days after midnight |
| **L** | Splits with imaginary friends (no identity check) | App-wide | Cosmetic risk only |

#### E.7 UX / Human Behavior (9 open)

| Pri | Finding | Location | Notes |
|---|---|---|---|
| **H** | First-run friction is the #1 growth blocker — Supabase signup → SQL paste → URL/key copy → Cloudinary signup → preset config | `CredentialSetup.jsx` | Drop-off probably >80%. Build "demo data" mode + 3-screen guided onboarding |
| **H** | Routine Day-1 streak confusion (see E.3) | `Routine.jsx:3303-3305` | First action of the day shows yesterday's streak — feels broken |
| **H** | No quick-entry / templates for repeat transactions | App-wide | Daily ₹120 metro fare = 5 taps every day forever. Suggest last-N |
| **H** | Long expense entry form (5+ fields) | `App.jsx` AddPage | Compare Splitwise's two-tap flow |
| **M** | Receipt upload gated on Cloudinary setup — skip Cloudinary → no receipts ever | `App.jsx`, `receiptUpload.js` | Fall back to local-blob persistence with quota warning |
| **M** | "Wallet" terminology — `upi_lite`, `bank`, `cash` — unexplained | `App.jsx:86` | ✅ Added `desc` subtitle to each wallet in selector (B.19.g) |
| **M** | Splits vs Settlements vs Events overlap conceptually | App-wide | ✅ Added explainer text to Splits section (B.19.h) |
| **M** | No empty-state guidance | App-wide | ✅ History tab: empty state + CTA; Dashboard: welcome card (B.19.e) |
| **M** | No tutorial / sample data toggle | App-wide | New users can't understand "Splits" without committing real data |
| **M** | Unsaved form state lost on tab switch | App-wide | ✅ sessionStorage draft save already implemented (add form autosaves on every keystroke) |
| **L** | No undo on destructive actions | App-wide | ✅ Already implemented: `undoDelete`/`showUndoToast`/`undoBuffersRef` — UNDO button appears on delete toast |

#### E.8 Product Gaps (~25 open) — features, not bugs

> Competing apps ship these; this app doesn't. None addressed in this branch.

##### Table-stakes (HIGH)

| Pri | Feature | Notes |
|---|---|---|
| **H** | Budgets / per-category caps with progress + alerts | The #1 feature of every expense tracker; blocking adoption |
| **H** | CSV / PDF in-app export | Currently only via emailed report |
| **H** | CSV import (bank statements) | #1 reason expense apps die: hand-keying. Map HDFC/ICICI/SBI export formats |
| **H** | Transaction full-text search across years | History tab filter only covers current visible window |
| **H** | UI to manage hardcoded wallets/categories/sources | `WALLETS`, `DC`, `DI`, `RC` are constants in `App.jsx`. Custom-add exists but defaults can't be deleted/renamed |
| **H** | "Demo data" mode for new users | Lets them explore without committing |
| **H** | Multi-account / family sharing | Splits exist as personal IOUs, not a shared ledger |

##### Power user (MEDIUM)

| Pri | Feature | Notes |
|---|---|---|
| **M** | Rules / autocategorize from merchant text | Splitwise, Walnut do this |
| **M** | Tags (orthogonal to categories) | "Groceries for trip" vs "groceries normal" |
| **M** | PDF/non-image attachments | Statements, bills |
| **M** | Multi-currency display (drop INR hardcode) | Show original + INR |
| **M** | Subscription detection (auto-find recurring from history) | One-tap promote-to-recurring |
| **M** | Month-over-month / merchant frequency / spending projections | Beyond `TrendChart` + heatmap |
| **M** | Undo affordance on toasts | Critical for delete actions |
| **M** | Bulk operations (multi-select delete/edit) | History tab |

##### Retention (MEDIUM)

| Pri | Feature | Notes |
|---|---|---|
| **M** | "You haven't logged in 3 days" reminder | Push or email |
| **M** | Streak for the finance side | Routine has one; expenses don't |
| **M** | In-app insights (push) summary | Cheaper and faster than email |
| **M** | Inline category drilldowns | "Tap a category to see top merchants" |

### F. Recommended Sequence (next sessions)

Re-prioritized after the work in this branch.

| # | Track | Effort | Items |
|---|---|---|---|
| ~~1~~ | ~~Wire client to `updated_at`~~ | ~~½ day~~ | ✅ **Done in B.17** — `If-Unmodified-Since` on recurring edits, 412 conflict drop |
| ~~2~~ | ~~Per-item retry + dead-letter~~ | ~~½ day~~ | ✅ **Done in B.10** |
| ~~3~~ | ~~Routine streak UX fixes~~ | ~~2 hours~~ | ✅ **Done in B.11, B.12** |
| ~~4~~ | ~~Soft delete + recovery~~ | ~~1 day~~ | ✅ **Done in B.13** |
| ~~5~~ | ~~Signed Cloudinary uploads~~ | ~~1 day~~ | ✅ **Done in B.18** — client-side SHA-1 via Web Crypto |
| 1 | **ESP swap Gmail → Resend** | ½ day | E.4 #2 — closes the 500/day cap. `OWNER_SETUP.md` already mentions it |
| 2 | **Onboarding overhaul + demo data** | 2 days | E.7 #1, E.8 "Demo data" |
| 3 | **Cron full fan-out** | 1 day | E.4 #1 — Inngest / QStash / pg_cron with retries + dead-letter. Replaces the chunked-concurrency stop-gap from B.6.a |
| 4 | **Budgets + in-app CSV export/import** | 2-3 days | E.8 top 3 — biggest product gap |
| 5 | **Split `App.jsx`** | 1-2 days | E.5 #1 — reformat into multi-line, split along screen boundaries; add `React.memo` on `TxCard` |
| 6 | **E2E tests with Playwright** | 1 day | Smoke tests on the 5 critical user flows |

### G. Quick Reference — Open Findings by File

> Items closed in this branch are not listed. See B.x for closed-item references.

| File | Still-open findings |
|---|---|
| `src/App.jsx` | settlement / recurring multi-write atomicity, JSON.stringify precision (`:904`, low), reportSchedule email leak (`:798`), heatmap windowing (`:240`), 1470-line monolith |
| `src/Routine.jsx` | TZ anchor (`:2436`), DST anchor (`:2447`), JSONB blob model |
| `src/financeUtils.js` | monthly off-by-one (`:17-21`) |
| `src/offlineSync.js` | cross-tab sync gap |
| `src/currencyConverter.js` | INR hardcoded (`:29-31`) — API name only |
| `src/credentials.js` | anon key in localStorage (`:7`) — architectural |
| `src/receiptUpload.js` | `apiSecret` stored in localStorage (same threat as anon key — architectural) |
| `api/_shared.ts` | ✅ `send_day_of_month` backend clamp fixed (B.19.m); all tests pass |
| `api/send-reports.ts` | within-chunk serial fan-out, Gmail 500/day, per-user cold start |
| `api/setup-user.ts` | Management API token handling (audit only) |
| `nomad_setup.sql` | RLS disabled everywhere (`:95-102, :160-161, :187-188`), `wallet_balances` no integrity invariant, schedule UNIQUE on user_id (`:117`), `daily_logs` JSONB blob model (`:175-179`) |
| `api/__tests__/_shared.test.ts` | ✅ All 9 failures fixed (D.1.2) — 0 failing |

### H. Notes for Future Claude Sessions

1. **Do not re-investigate the items in section C (false positives).** They are correct in the existing code.
2. **Always run `npm run lint` and `npm test` before and after edits.** Current baselines (verified May 2026, third session):
   - **Lint:** 64 problems (57 errors, 7 warnings). New edits must not increase this count.
   - **Tests:** **133 pass / 0 fail (133 total).** All 9 previously-failing tests in `api/__tests__/_shared.test.ts` are now fixed: 2 `getPeriod` failures (UTC-safe month arithmetic) and 7 `getNextSendAt` failures (stale tests updated to reflect IST→UTC conversion).
   - B.17 added 2 new offlineSync tests (412 conflict drop, header stripping) → total went 131 → 133 passing.
3. **`App.jsx` and `Routine.jsx` are written one-line-per-JSX-block.** When editing, use a unique substring as `old_string` — do **not** attempt to reformat. The build will break.
4. **`dist/` is gitignored but historically tracked.** Don't commit rebuilt `dist/` unless explicitly asked; Vercel rebuilds on push. After running `npm run build`, run `git checkout HEAD -- dist/` before staging.
5. **`AddPage` is a sub-component** (line 419) without direct access to the main `App` state. Pass callbacks (like `onError`) as props rather than reaching for global state.
6. **Sync queue is the riskiest data structure.** Anything that mutates `nomad-sync-queue-v1` or replays it must be idempotent and must surface failures to the user. The new `subscribeSyncDrops` channel (B.4.d) is the user-visible signal — wire any new drop conditions through it. Dead-letter queue is `nomad-sync-failed-v1` (B.10.b).
7. **All 133 tests now pass.** The previously-failing `_shared.test.ts` tests are fixed (see D.1.2). Test baseline is 133/133.
8. **`nomad_setup.sql` is idempotent and safe to re-run.** All migrations use `ADD COLUMN IF NOT EXISTS`, `DROP TRIGGER IF EXISTS`, and `DROP CONSTRAINT IF EXISTS` patterns. The `deleted_at` and `updated_at` migrations (B.7.a, B.13.a) will apply cleanly to existing databases.
9. **`receiptUpload.js` supports two Cloudinary modes** (B.18): signed (apiKey+apiSecret → SHA-1 via `crypto.subtle`) or unsigned (uploadPreset). Tests that exercise the upload path must mock `getCredentials()` to return at minimum `cloudName` plus either `apiKey`+`apiSecret` or `uploadPreset`.
10. **`uid()` (App.jsx:16) prefers `crypto.randomUUID()`.** Don't reintroduce shadowing — the renamed `userKey` constants (subdomain ref) live alongside it (B.8.b).
11. **`api/send-now.ts` requires the caller's supabase_url to be in `user_registry`.** Owner's URL is exempt. If you add new server endpoints that take user creds from the request body, mirror the same pattern.
12. **`sbDelete` is now a soft delete (PATCH `deleted_at=now()`).** `sbDeleteWhere` remains a hard DELETE (bulk cascade ops and the nuke). `sbGet` filters `deleted_at=is.null` with a 400-fallback for pre-migration databases.
13. **Conflict detection (B.17)** targets `recurring` table only. Versions are stored in `nomad-record-versions-v1` keyed `{table}:{id}`. Flush always strips `If-Unmodified-Since` so replays always win. 412 is a `kind:"conflict"` drop — toast shown, change discarded.
14. **Signed Cloudinary (B.18)** uses `apiKey` + `apiSecret` from credentials. The `apiSecret` is in localStorage — same threat model as the Supabase anon key. A proper signing endpoint would avoid client-side secret exposure but requires a Vercel env var and server roundtrip.
