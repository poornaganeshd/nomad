# CLAUDE.md

Guidance for Claude Code working in this repo. Read once at session start.

## Project

**NOMAD** — personal finance tracker (expenses, income, transfers, recurring bills, splits) with an optional daily-routine sub-app. React 19 + Vite SPA on Vercel, backed by **the user's own Supabase project** (BYODB — no central data store). Single-user personal app; not multi-tenant.

## Tech stack

- **Frontend:** React 19, Vite, Recharts, `@phosphor-icons/react` + `@tabler/icons-react`
- **Backend:** TypeScript Vercel serverless functions (`api/`), CommonJS (`api/package.json` is `type: commonjs`; root is `type: module` — don't mix)
- **DB:** Supabase (Postgres), user-hosted, creds in localStorage. RLS is disabled on every table by design — the anon key is the per-user auth boundary.
- **Receipts:** Cloudinary (or local data-URL fallback). **Email reports:** nodemailer + Gmail. **AI:** Gemini → Groq → NVIDIA waterfall.
- **Dates:** date-fns + local helpers.

## Commands

```bash
npm run dev            # Vite dev server (HMR)
npm run build          # production build → dist/
npm run lint           # ESLint (JS/JSX only)
npm run typecheck      # tsc --noEmit on api/ (TS not linted by ESLint)
npm test               # vitest run (unit) — excludes e2e/**
npm run test:watch
npm run test:coverage
npm run test:e2e       # Playwright (needs dev server; localhost:5173)
```

## Baselines (verify before/after edits; don't regress)

- **Tests:** 453 pass / 0 fail, 21 files (`npm test`).
- **Lint:** 0 errors / 16 warnings (`npm run lint`). Warnings are cosmetic react-compiler/`exhaustive-deps` noise on the monoliths — don't chase to zero. The 5 react-compiler/react-refresh *error* rules are demoted to `warn` for `App.jsx`/`Routine.jsx`/`TrendChart.jsx` only (see `eslint.config.js`); they stay errors everywhere else, so CI gates lint strictly.
- **Typecheck:** clean (`npm run typecheck` → `tsc --noEmit` on `api/`).
- **Build:** succeeds (~1.16 MB bundle; the >500 kB chunk warning is expected).

## Working agreements

- **Never `git push`** — the user pushes from VS Code. (Also in auto-memory.)
- `App.jsx` and `Routine.jsx` are written **one JSX block per line**. When editing, match a unique substring — do **not** reformat or the build breaks.
- `dist/` is gitignored but historically tracked. After `npm run build`, run `git checkout HEAD -- dist/` before staging; Vercel rebuilds on push.
- On Windows, use the **PowerShell tool** for shell, not Bash-with-PS-cmdlets.

## Testing

Vitest + jsdom (configured in `vite.config.js` under `test`). Coverage via `@vitest/coverage-v8`. CI (`.github/workflows/ci.yml`) has two jobs on every push/PR — keep both green: **test** (`lint` → `typecheck` → `npm test` → `build`) and **e2e** (Playwright chromium; config self-starts the dev server when `CI` is set).

| Source | Test |
|---|---|
| `src/financeUtils.js` | `src/__tests__/financeUtils.test.js` |
| `src/billReminders.js` | `src/__tests__/billReminders.test.js` |
| `src/credentials.js` | `src/__tests__/credentials.test.js` |
| `src/currencyConverter.js` | `src/__tests__/currencyConverter.test.js` |
| `src/offlineSync.js` | `src/__tests__/offlineSync.test.js` |
| `src/syncMerge.js` | `src/__tests__/syncMerge.test.js` |
| `src/financeScore.js` | `src/__tests__/financeScore.test.js` |
| `src/redactor.js` | `src/__tests__/redactor.test.js` |
| `src/foodVision.js` | `src/__tests__/foodVision.test.js` |
| `src/dbCols.js` | `src/__tests__/dbCols.test.js` |
| `api/_shared.ts` | `api/__tests__/_shared.test.ts` |
| `api/_ai-provider.ts` | `api/__tests__/ai-provider.test.ts` |

Conventions: `localStorage.clear()` in `beforeEach`; mock `fetch` with `global.fetch = vi.fn()` + `vi.restoreAllMocks()`; set `navigator.onLine` via `Object.defineProperty`. `offlineSync.js` has module-level state — use `vi.resetModules()` + dynamic `import()` per test for a clean instance. With fake timers, register `expect(...).rejects` **before** `vi.runAllTimersAsync()`. E2E (`e2e/`) uses Playwright's `page` fixture; never run it under vitest.

## Architecture

### Credentials / data flow
First run shows `CredentialSetup.jsx`. Creds (Supabase URL + anon key, optional Cloudinary) save to localStorage `nomad-credentials` via `credentials.js`. `App.jsx` reads them at module load; localStorage beats `VITE_SUPABASE_*` env vars.

**Local-only mode is the real onboarding:** new users land straight in the app with data in localStorage (`localMode = !creds.sbUrl`, `needsSetup = false` at top of `App.jsx`). A dismissible amber banner nags them to add Supabase for cloud sync + AI. There is **no demo/sample-data mode** — don't build one.

### Frontend (`src/`)
- **`App.jsx`** — one large component (~2k lines) owning all finance state and every view, plus inline helpers (`sbGet`/`sbWrite`/`sbUpsert`/`sbDelete`, date utils, SVG icons). Intentional monolith — don't split without a clear need.
- **`Routine.jsx`** — self-contained daily food/skin/habit/sleep/mood/water sub-app (own tab).
- **`CredentialSetup.jsx`**, **`ReceiptPicker.jsx`** (image + PDF), **`components/TrendChart.jsx`**.

### Support modules (`src/`)
| File | Purpose |
|---|---|
| `credentials.js` | read/write Supabase + Cloudinary creds |
| `dbCols.js` | **single source of truth for Supabase column lists** (`COLS.<table>`) |
| `offlineSync.js` | write-ahead queue; replay on reconnect; dedup/backoff/dead-letter/conflict |
| `syncMerge.js` | merge remote vs local rows on load |
| `billReminders.js` | due/upcoming recurring-bill toasts |
| `receiptUpload.js` | compress + upload receipts (3 modes, below) |
| `currencyConverter.js` | INR FX rates, 24h-cached in localStorage |
| `financeUtils.js` | pure money/date helpers (`roundMoney`, `localDateKey`, recurring due-date, `distributeAmount`, `historySortCompare`). **No side effects.** |
| `financeScore.js`, `redactor.js`, `foodVision.js` | finance score; PII redaction before AI; client food-photo compress + call |

### Offline-first write path
All Supabase writes go through `sendSupabaseRequest` in `offlineSync.js`. Offline or 5xx → serialised into localStorage queue `nomad-sync-queue-v1`, replayed on reconnect/visibility. Dedup by `dedupeKey`; bodies merged on dedup. Per-item retry; after 3 fails → dead-letter `nomad-sync-failed-v1`. Drops surface via `subscribeSyncDrops` (wired to toasts) — route any new drop condition through it. In production, writes route through **`/api/sync`** proxy for server-side idempotency (`nomad_sync_keys` table); dev/test go direct.

### Soft delete & conflicts
`sbDelete` is a soft delete (PATCH `deleted_at=now()`); `sbDeleteWhere` is a hard DELETE (bulk/nuke). `sbGet` appends `&deleted_at=is.null` only for `SOFT_DELETE_TABLES` = {expenses, incomes, transfers, recurring, events, splits}. Optimistic concurrency: recurring edits send `If-Unmodified-Since` from version cache `nomad-record-versions-v1`; 412 → conflict toast + discard; flush strips the header so offline replays always win. Recurring is the only table with conflict detection (the others are append-only).

### Local backup & PWA
Full state mirrored to localStorage `nomad-v5` (loaded as fallback). Categories/incomeSources live **only** in `nomad-v5` + backup export (not synced to Supabase — multi-device users restore via backup). `public/sw.js` is cache-first (app shell); skips Supabase + non-OK/opaque responses; bump `CACHE_NAME` when changing it (Vite plugin auto-injects a build-version suffix). No push notifications (removed) — reminders are in-app only.

### Backend (`api/`)
| File | Route | Purpose |
|---|---|---|
| `sync.ts` | `POST /api/sync` | Supabase write proxy w/ idempotency. Validates host is exactly `<ref>.supabase.co` (anti-SSRF). |
| `send-reports.ts` | `POST /api/send-reports` (cron `0 2 * * *`) | iterate `user_registry`, email scheduled reports (concurrency 5, 30s/user) |
| `send-now.ts` | `POST /api/send-now` | manual report; caller's URL must be in `user_registry` |
| `setup-user.ts` | `POST /api/setup-user` | create report tables via Supabase Management API |
| `food-vision.ts` | `POST /api/food-vision` | **food nutrition AND receipt OCR** via `type: "food"\|"receipt"` body param (no separate receipt endpoint) |
| `ai-insights.ts` / `ai-categorize.ts` / `ai-chat.ts` | `POST /api/ai-*` | finance AI; client redacts PII first |
| `_shared.ts` | — | Supabase/period/schedule helpers, HTML/CSV email builders |
| `_ai-provider.ts` | — | Gemini→Groq→NVIDIA waterfall; `callText`/`callVision`/`callVisionWithProvider`, `extractJSON` |

Cron in `vercel.json` (only `send-reports`). Env: `VITE_SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`, `GMAIL_USER`/`GMAIL_APP_PASSWORD`, `CRON_SECRET`, and `GEMINI_API_KEY`/`GROQ_API_KEY`/`NVIDIA_API_KEY` (any one enables AI).

### Database
`nomad_setup.sql` is idempotent (safe re-run; `IF NOT EXISTS` / `DROP ... IF EXISTS`). Core tables: `expenses`, `incomes`, `transfers`, `settlements`, `splits`, `recurring`, `events`, `wallet_balances`. Email: `report_schedules`, `report_delivery_log`. Sync: `nomad_sync_keys`. Owner-only: `user_registry`. Routine: `daily_logs`, `user_config`. RLS disabled everywhere.

## Key conventions / gotchas

- **`COLS` (`dbCols.js`) is the only source of truth for column lists.** Never inline a column array in a `toSB()` call — add the field to `COLS.<table>` once and every write path picks it up. `dbCols.test.js` guards required fields.
- **IDs are client-side:** `uid()` (App.jsx) prefers `crypto.randomUUID()`, base36 fallback. No server IDs.
- **All amounts stored in INR (₹).** Foreign input converts at entry time; original currency + rate kept in `nomad-currency-meta` keyed by tx id.
- **`receiptUpload.js` 3 modes:** signed (`cloudName`+`apiKey`+`apiSecret`, SHA-1 via Web Crypto) → unsigned (`cloudName`+`uploadPreset`) → local (no `cloudName` → compressed data URL). `isLocalReceipt(url)` = `url.startsWith("data:")`.
- **Startup is stale-while-revalidate:** `load()` paints from `nomad-v5` then refreshes from Supabase async. Never `await sbGet(...)` before the first render.
- **Wallets/categories/sources are user-editable**, stored in localStorage state (`WALLETS`/`DC`/`DI`/`RC` are just default seeds). `wallets` state is the live source — never hardcode `{upi_lite,bank,cash}`.
- **Group splits use `distributeAmount` (`grpShareMap`)**, not `total/n`, to avoid ₹0.01 residue. `addE` must include `paidBy` in its `COLS.expenses` write or group summaries break on reload.
- **Tags were removed** — don't re-add (redundant with Events). SQL `tags` columns are dead but harmless.
- **Routine date math** uses a noon anchor (`new Date(y, m, d, 12)`) to dodge DST off-by-one. Keep it when touching streak/calendar code.
- **Don't trust this file's claims about a symbol existing** — grep first. Prior versions of this doc described features (demo mode, meditation/workout cards, habit streaks, push notifications) that were never shipped or were later removed. The code is authoritative.
