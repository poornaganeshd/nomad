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

- **Tests:** 634 pass / 0 fail, 32 files (`npm test`).
- **Lint:** 0 errors / 12 warnings (`npm run lint`). Warnings are cosmetic react-compiler/`exhaustive-deps` noise on the monoliths — don't chase to zero. The react-compiler/react-refresh *error* rules are demoted to `warn` for `App.jsx`/`Routine.jsx` only (see `eslint.config.js`); they stay errors everywhere else, so CI gates lint strictly.
- **Typecheck:** clean (`npm run typecheck` → `tsc --noEmit` on `api/`).
- **Build:** succeeds. Main chunk ~800 kB (gzip ~210 kB) + lazy chunks (Routine, CatDonut/recharts, IOUWallet, NomadLite, CalendarView, CredentialSetup, pdfjs); the >500 kB warning on the main chunk is expected.

## Working agreements

- **Never push to `main`** — the user merges PRs. Local sessions: don't `git push` at all (the user pushes from VS Code). Remote/cloud Claude sessions: push only to the session's designated `claude/*` branch (user-granted).
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
| `src/txParsers.js` | `src/__tests__/txParsers.test.js` |
| `src/nomadLiteSplit.js` | `src/__tests__/nomadLiteSplit.test.js` |
| `src/bankReconcile.js`, `src/chatFormat.js`, `src/streak.js`, `src/ntfy.js`, `src/webpush.js`, batch import | same-named tests in `src/__tests__/` |
| `wBal` logic in `App.jsx` (mirrors `roundMoney`) | `src/__tests__/balances.test.js` |
| `parseAmount`/`isUpiLite` helpers in `App.jsx` | `src/__tests__/helpers.test.js` |
| `src/syncMerge.js` (reconcile regression) | `src/__tests__/reconcileFlow.test.js` |
| event group ledger + `grpSettled` reconciliation (mirrors App.jsx Events) | `src/__tests__/eventLedger.test.js` |
| single-source decision helpers (`exceedsUpiLiteBalance`, `defaultSettleWalletId`, `resolveRecCategory`) | `src/__tests__/guards.test.js` |
| `goalProgress` (financeUtils — savings-goal pct/pace/overdue) | `src/__tests__/goals.test.js` |
| `balanceTrail` / `runwayInfo` (financeUtils — terrain-hero series + burn rate) | `src/__tests__/terrain.test.js` |
| `api/_shared.ts` | `api/__tests__/_shared.test.ts` |
| `api/_ai-provider.ts` | `api/__tests__/ai-provider.test.ts` |
| `api/ai-analyze.ts` | `api/__tests__/ai-analyze.test.ts` |

Conventions: `localStorage.clear()` in `beforeEach`; mock `fetch` with `global.fetch = vi.fn()` + `vi.restoreAllMocks()`; set `navigator.onLine` via `Object.defineProperty`. `offlineSync.js` has module-level state — use `vi.resetModules()` + dynamic `import()` per test for a clean instance. With fake timers, register `expect(...).rejects` **before** `vi.runAllTimersAsync()`. E2E (`e2e/`) uses Playwright's `page` fixture; never run it under vitest.

## Architecture

### Credentials / data flow
First run shows `CredentialSetup.jsx`. Creds (Supabase URL + anon key, optional Cloudinary) save to localStorage `nomad-credentials` via `credentials.js`. `App.jsx` reads them at module load; localStorage beats `VITE_SUPABASE_*` env vars.

**Local-only mode is the real onboarding:** new users land straight in the app with data in localStorage (`localMode = !creds.sbUrl`, `needsSetup = false` at top of `App.jsx`). A dismissible amber banner nags them to add Supabase for cloud sync + AI. There is **no demo/sample-data mode** — don't build one.

### Frontend (`src/`)
- **`App.jsx`** — one large component (~3k+ lines) owning all finance state and every view, plus inline helpers (`sbGet`/`sbWrite`/`sbUpsert`/`sbDelete`, date utils, SVG icons). Intentional monolith — don't split without a clear need.
- **`Routine.jsx`** — self-contained daily food/skin/habit/sleep/mood/water sub-app (own tab).
- **AI features live INLINE in `App.jsx`** (there is no `AIHub.jsx` — an earlier version of this doc invented one). Voice add, the statement chat (reconcile against bank/UPI exports), the AI narrative card, and category suggestions all call `POST /api/ai-analyze` with a `mode` param; PII is redacted via `redactTransactions()`/`redact()` before sending.
- **`IOUWallet.jsx`** — 1:1 IOU card wallet (Add tab → "IOU · Splits" segment). Neumorphic design with its own local atoms (MINT/CORAL/etc). Quick-add "morph" popup animates `transform` only (GPU) — don't reintroduce top/left/width/height animation. Person rename/merge: pencil in person view → `onRenamePerson(from, to)` (implemented in App.jsx: renames all matching splits + `sbUpsert`); renaming onto an existing person's name merges them. New-IOU form shows existing-people suggestions.
- **`CatDonut.jsx`** — the category-spend donut, extracted so recharts lives in a lazy chunk.
- **`CalendarView.jsx`** — month-grid calendar rendered inside the history tab. Shows per-day expense/income totals with a heat-map background (green → yellow → red). Supports controlled selection (`selectedDay` + `onDayClick` props) or internal state; `compact` prop hides the day-detail panel. Props: `expenses`, `incomes`, `refunds` (received IOU repayments — netted off the SPENT header so it matches the hero's Out), `transfers`, `categories`, `wallets`, `onTxClick`, `compact`, `selectedDay`, `onDayClick`, `viewMonth` + `onMonthChange` (two-way sync with the history month chips).
- **`NomadLite.jsx`** + **`nomadLiteSplit.js`** — "NOMAD Lite": a presets shell of standalone quick-calculators launched from the **clock icon in the Events list header** (Events `view === "lite"`). First preset "Current Split" = electricity/utility bill splitter (base load + appliance %-groups + auto/manual extra, donut, cards/table, copy/WhatsApp/print). **localStorage-only** (`nomad-lite-v1`), never synced to Supabase. Theme is global (inherits app CSS vars — no local toggle). Pure split math + helpers live in `nomadLiteSplit.js` so `NomadLite.jsx` stays components-only (`react-refresh/only-export-components` is an error outside App/Routine). Add future presets to the `PRESETS` array.
- **`CredentialSetup.jsx`**, **`ReceiptPicker.jsx`** (image + PDF).
- **Code-splitting:** `Routine`, `NomadLite`, `IOUWallet`, `CalendarView`, `CredentialSetup`, `CatDonut` are `lazy()`-loaded via the `lazyView` helper at the top of `App.jsx` (pre-wrapped in Suspense so call sites stay unchanged; failed chunk fetch renders a reconnect hint). All chunks are idle-prefetched after first paint — **required for offline**, since the SW can only serve what has been fetched once.
- **Boot splash:** `index.html` carries a pure-CSS animated splash inside `#root` (wiped when React mounts) + a pre-paint theme sniff of `nomad-v5`'s `"darkMode"`. Keep it dependency-free.
- **PWA shortcut:** manifest `shortcuts` → `/?add=1`; `App.jsx` reads the flag for the initial tab, then strips it from the URL.
- **Smart Add defaults:** `suggestAddDefaults` (financeUtils) pre-picks category/wallet from recent history; AddPage adopts a late suggestion only while the field still holds its auto value (draft/chip/voice/user changes hand off permanently).

### Support modules (`src/`)
| File | Purpose |
|---|---|
| `credentials.js` | read/write Supabase + Cloudinary creds |
| `dbCols.js` | **single source of truth for Supabase column lists** (`COLS.<table>`) |
| `offlineSync.js` | write-ahead queue; replay on reconnect; dedup/backoff/dead-letter/conflict |
| `syncMerge.js` | merge remote vs local rows on load |
| `billReminders.js` | due/upcoming recurring-bill toasts; exports `isNotHandled` (paid/skipped-this-cycle check) |
| `receiptUpload.js` | compress + upload receipts (3 modes, below) |
| `currencyConverter.js` | INR FX rates, 24h-cached in localStorage |
| `financeUtils.js` | pure money/date helpers (`roundMoney`, `localDateKey`, recurring due-date, `distributeAmount`, `historySortCompare`, `suggestAddDefaults`). **No side effects.** |
| `financeScore.js`, `redactor.js`, `foodVision.js` | finance score; PII redaction before AI; client food-photo compress + call |
| `txParsers.js` | pure parsing utilities: `parseAmount` (locale-aware — EU comma, US thousands, Indian lakhs), `parseVoiceTx` (spoken text → `{amount, walletId, categoryId, note}`), `parseBankCsv` (HDFC/ICICI/SBI/generic CSV), `parseUpiStatement` (GPay-style text), `htmlStatementToText` (BHIM/bank HTML export → text lines for the statement pipeline) |

### Offline-first write path
All Supabase writes go through `sendSupabaseRequest` in `offlineSync.js`. Offline or 5xx → serialised into localStorage queue `nomad-sync-queue-v1`, replayed on reconnect/visibility. Dedup by `dedupeKey`; bodies merged on dedup. Per-item retry; after 3 fails → dead-letter `nomad-sync-failed-v1`. Drops surface via `subscribeSyncDrops` (wired to toasts) — route any new drop condition through it. In production, writes route through **`/api/sync`** proxy for server-side idempotency (`nomad_sync_keys` table); dev/test go direct.

### Cross-device live pull
An open tab fetches Supabase only once on mount, so a row added on another device used to stay invisible until a full reload ("new entries missing on other device"). `App.jsx` runs a **background re-pull** — `load({ skipLocal: true })` on tab refocus (`visibilitychange`) **and** a 60s interval — via a `loadRef` so the interval always uses the latest closure. `load()` flushes the offline write queue first (push), then re-fetches + `mergeRemote` (pull); `mergeRemote` keeps any pending-upsert local row so a background pull can't clobber an in-flight edit. **`skipLocal` is load-bearing:** under `if (!skipLocal)`, the mount load restores local-only prefs (theme, categories, income sources) from the `nomad-v5` backup — background pulls MUST skip that, or a pull firing inside the 800ms backup debounce reverts a just-added category / theme toggle.

### Soft delete & conflicts
`sbDelete` is a soft delete (PATCH `deleted_at=now()`); `sbDeleteWhere` is a hard DELETE (bulk/nuke). `sbGet` appends `&deleted_at=is.null` only for `SOFT_DELETE_TABLES` = {expenses, incomes, transfers, recurring, events, splits}. Optimistic concurrency: recurring edits send `If-Unmodified-Since` from version cache `nomad-record-versions-v1`; 412 → conflict toast + discard; flush strips the header so offline replays always win. Recurring is the only table with conflict detection (the others are append-only).

### Local backup & PWA
Full state mirrored to localStorage `nomad-v5` (loaded as fallback). Categories/incomeSources/autoRules/budgets/savings-goals optionally sync cross-device via the **`user_prefs`** JSONB table (single row keyed `"nomad"`, dedupeKey `user_prefs:nomad`) — `load()` probes it once: present → `prefsSync="on"` (a debounced effect pushes `{categories, incomeSources, autoRules, budgets, goals}`, and remote is adopted when present & not pending a local upsert); absent (un-migrated) → `prefsSync="off"`, stay localStorage-only with **zero error toasts**. Adoption asymmetry is deliberate: categories/incomeSources only adopt a **non-empty** remote list, but budgets (`{}` ok) and goals (`[]` ok) adopt empty values too, so "clear all budgets" / "delete last goal" propagates — only a prefs row that predates those keys leaves local state alone (and the baseline mismatch then re-uploads local, migrating the row). Budgets/goals also keep their own localStorage keys (`nomad-budgets`, `nomad-goals-v1`) so they work offline/local-only; goal contributions are manual markers and **never touch wallet balances** (`goalProgress` in financeUtils is the single render source — dashboard card + settings editor + e2e `13-savings-goals.spec.js`). So these still work offline/un-migrated, and follow you across devices once `nomad_setup.sql` is re-run. `nomad-v5` remains the local fallback + backup-export source. `public/sw.js`: navigations serve the cached shell INSTANTLY and refresh it in the background (this is what makes cold opens fast — don't revert to network-first); hashed assets are cache-first; skips Supabase + non-OK/opaque responses (and ignores all non-GET, so the ntfy POST passes through); bump `CACHE_NAME` when changing it (Vite plugin auto-injects a build-version suffix). Deploys reach users via the "App updated — reload" banner (new SW waits for SKIP_WAITING; see `main.jsx`).

### Push notifications (Web Push + ntfy)
Bill/IOU reminders as real phone push, two channels behind one Settings → "Push Notifications" card:

**Web Push (primary, "real app" channel):** browser-native push via VAPID — notifications land in the device shade under NOMAD's name/icon, no extra app. `src/webpush.js` (tests `src/__tests__/webpush.test.js`) handles permission + `PushManager` subscribe using the VAPID public key from `GET /api/push` (cached in localStorage `nomad-vapid-key`, auto-refetch on stale-key subscribe failure). Subscriptions are stored in the user's own Supabase `push_subscriptions` table (endpoint PK, JSONB body); "Enable on this device" also upserts `notification_prefs` (dedupe stamp lives there) and registers in `user_registry`. `public/sw.js` has the `push`/`notificationclick` handlers (payload `{title, body, tag, url}`). Server side: `api/push.ts` (GET public key / POST canned test push — content fixed server-side so it can't be a spam relay; 404/410 → 410 expired) and `api/_webpush.ts` (`sendToSubscriptions` fans the daily digest out, returns expired endpoints which the cron prunes). **Owner env (only setup): `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`** — generate via `npx web-push generate-vapid-keys`. iOS needs Add-to-Home-Screen (16.4+); the UI explains when `PushManager` is absent. Tests: `api/__tests__/webpush.test.ts`, `api/__tests__/push.test.ts`.

**ntfy (optional alternative):** via the ntfy app (`src/ntfy.js`, tests `src/__tests__/ntfy.test.js`). Browser POSTs straight to the ntfy server (ntfy.sh is CORS-whitelisted in `vercel.json` CSP `connect-src`; custom servers must be added there). Config in localStorage `nomad-ntfy-v1` + `notification_prefs` row.

**Shared plumbing:** the `send-reports` cron builds ONE due-bill digest per user (`api/_notify.ts` `buildBillDigest`) and fans it out to whichever channels are on, deduped once per IST day via `notification_prefs.last_run_date` (upserted, so it works even when only web push is on). Client-side legs fire while a tab is open: the `App.jsx` bill-reminders effect mirrors `checkBillReminders()` output to `publishNtfy` AND to `registration.showNotification` (works in local-only mode, no server). `api/_notify.ts` is a hand-port of `financeUtils.js` recurring-due math (api/ is CommonJS, can't import ESM `src/`) — change both together; guarded by `api/__tests__/notify.test.ts`.

### Backend (`api/`)
| File | Route | Purpose |
|---|---|---|
| `sync.ts` | `POST /api/sync` | Supabase write proxy w/ idempotency. Validates host is exactly `<ref>.supabase.co` (anti-SSRF). |
| `send-reports.ts` | `POST /api/send-reports` (cron `0 2 * * *`) | iterate `user_registry`: email scheduled reports (concurrency 5, 30s/user) **and** push due-bill ntfy digests (`_notify.ts`). Email leg skipped (not 500) if Gmail creds unset, so ntfy runs standalone. |
| `send-now.ts` | `POST /api/send-now` | manual report; caller's URL must be in `user_registry` |
| `setup-user.ts` | `POST /api/setup-user` | create report tables via Supabase Management API |
| `push.ts` | `GET/POST /api/push` | Web Push: GET → VAPID public key; POST `{subscription}` → canned test notification (fixed content; 410 on expired) |
| `food-vision.ts` | `POST /api/food-vision` | **food nutrition AND receipt OCR** via `type: "food"\|"receipt"` body param (no separate receipt endpoint) |
| `ai-analyze.ts` | `POST /api/ai-analyze` | **omnibus AI endpoint** — 16 modes: `voice-parse`, `subscriptions`, `anomaly`, `duplicates`, `merchants`, `narrative`, `whatif`, `budget-suggest`, `mood-correlation`, `tax`, `split-cats`, `note-items`, `smart-reminders`, `goal-coach`, `reconcile`, `statement-parse`. Each mode has its own system prompt, user-prompt builder, JSON validator, and sanitizer. Returns 503 if no AI providers configured, 400 for unknown mode, 502 on bad JSON. |
| `ai-insights.ts` / `ai-categorize.ts` / `ai-chat.ts` | `POST /api/ai-*` | finance AI; client redacts PII first |
| `_shared.ts` | — | Supabase/period/schedule helpers, HTML/CSV email builders |
| `_ai-provider.ts` | — | Gemini→Groq→NVIDIA waterfall; `callText`/`callVision`/`callVisionWithProvider`, `extractJSON` |

Cron in `vercel.json` (only `send-reports`). Env: `VITE_SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`, `GMAIL_USER`/`GMAIL_APP_PASSWORD`, `CRON_SECRET`, `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` (Web Push), and `GEMINI_API_KEY`/`GROQ_API_KEY`/`NVIDIA_API_KEY` (any one enables AI).

### Database
`nomad_setup.sql` is idempotent (safe re-run; `IF NOT EXISTS` / `DROP ... IF EXISTS`). Core tables: `expenses`, `incomes`, `transfers`, `settlements`, `splits`, `recurring`, `events`, `wallet_balances`, `user_prefs` (cross-device JSONB prefs — categories / income sources / auto-rules / budgets / savings goals). Email: `report_schedules`, `report_delivery_log`. Push: `notification_prefs` (ntfy topic + shared `last_run_date` dedupe), `push_subscriptions` (Web Push, one row per device). Sync: `nomad_sync_keys`. Owner-only: `user_registry`. Routine: `daily_logs`, `user_config`. RLS disabled everywhere.

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
- **`txParsers.js` is the only source for amount/voice/CSV parsing.** `parseAmount` handles EU comma-decimal, US thousands, and Indian lakh formats. `parseBankCsv` handles HDFC/ICICI/SBI and generic CSV layouts with auto-detected column headers (no row-count cap). Don't re-implement these inline in `App.jsx`.
- **The omnibus `ai-analyze.ts` is the preferred pattern for new AI features** — add a mode there rather than a new file, to stay under the Vercel Hobby function limit.
- **Semantic color tokens** (`--pos`, `--neg`, `--danger`, `--acc`, `--acc2`, `--warn`, `--gold`) live in the theme maps in `App.jsx`; use them for any new UI color instead of raw hex. Raw hex remains ONLY where var() can't go: 8-digit hex+alpha literals, values fed to `alpha()` or `${x}NN` string concat (`tc`, `acc/grn/ind/gld`), `<input type="color">` state, category/wallet seed data, and the theme maps themselves.
- **`api/ai-analyze.ts` has a sanitize step** — after AI returns JSON, each mode's `sanitize()` function normalises enum values and resets out-of-list IDs to `null`. Always add sanitization when accepting AI output for a new mode; don't let raw AI strings reach the client.
- **`balances.test.js` and `helpers.test.js` mirror inline logic in `App.jsx`** — they duplicate and test pure functions that live inside the monolith. If you extract or change `wBal` accumulation or `parseAmount`/`isUpiLite`, update these tests to match.
- **The dashboard hero is the "terrain" layout** (`TerrainHero` in App.jsx): 30-day total-balance trail as layered SVG contour bands + readout ("Where you stand"), burn-rate runway, In/Out/Kept triad, and stitched-leather wallet squares (3 per row, wrapping — tap = reconcile, cash keeps its ⟳ recount). Series/burn math lives in `financeUtils.js` (`balanceTrail`, `runwayInfo`); the `terrainData` memo in App.jsx builds the signed deltas and MUST mirror `wBal`'s accumulation rules — change them together. Hero numerals use `--font-m` (Martian Mono, loaded in the same @import as the other fonts); all hero colors are theme vars so dark mode works. Don't reintroduce a "Total Balance" card — e2e `01-local-mode` asserts the hero's "Where you stand" readout.
- **Single-source decision helpers live in `financeUtils.js` — don't re-inline them.** A recurring bug class here was the same decision copied into several call sites then drifting apart (e.g. recurring category looked up in expense `cats` in one place but `RC`/`recCats` in another; the UPI-Lite ₹5000 ceiling enforced on calibration/income but not transfers; the settle modal defaulting a *receive* to UPI-Lite which the save then rejects). These now have one tested home: `resolveRecCategory` (every recurring-category render), `exceedsUpiLiteBalance`/`UPI_LITE_MAX_BALANCE` (every path that credits UPI Lite), `defaultSettleWalletId` (settle/record-payment default wallet). Call them; don't paste a fresh copy. Guarded by `guards.test.js`.
- **Don't trust this file's claims about a symbol existing** — grep first. Prior versions of this doc described features (demo mode, meditation/workout cards, habit streaks, push notifications) that were never shipped or were later removed. The code is authoritative.
