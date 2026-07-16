# NOMAD

Personal finance tracker — expenses, income, transfers, recurring bills, and group splits — with an optional daily-routine sub-app. React 19 + Vite SPA, deployed on Vercel.

**Bring your own database (BYODB):** there is no central data store. Each user points the app at **their own Supabase project**; credentials live in the browser's localStorage. It's a single-user personal app, not multi-tenant.

## Features

- **Finance** — log expenses, income, transfers, and recurring bills; per-wallet running balances with drift detection & reconciliation; multi-currency input (stored in INR).
- **Budgets & savings goals** — per-category monthly limits with overspend warnings, and savings goals with target dates and per-month pace; both follow you across devices via `user_prefs`.
- **Events & splits** — group expenses with fair-share distribution (no ₹0.01 residue), two-way settle sync, and IOU wallet.
- **NOMAD Lite** — standalone quick-calculators (utility-bill splitter, tip & tax split) that stay local-only.
- **AI Hub** — 11 tools (subscription detector, anomaly/duplicate scanners, merchant cleanup, narrative, what-if, budget recommender, mood↔spend correlation, India tax helper, smart reminders, goal coach). All PII is redacted client-side before any AI call.
- **Routine** — self-contained daily food / skin / habit / sleep / mood / water sub-app.
- **Receipts** — Cloudinary upload or local data-URL fallback, with OCR.
- **Email reports** — scheduled + on-demand, via nodemailer + Gmail.
- **Offline-first** — write-ahead queue replays on reconnect; cross-device live pull; PWA app-shell caching.

## Tech stack

- **Frontend:** React 19, Vite, Recharts, `@phosphor-icons/react` + `@tabler/icons-react`
- **Backend:** TypeScript Vercel serverless functions (`api/`)
- **Database:** Supabase (Postgres), user-hosted. RLS is disabled by design — the anon key is the per-user auth boundary.
- **AI:** Gemini → Groq → NVIDIA provider waterfall
- **Receipts:** Cloudinary · **Email:** nodemailer + Gmail

## Getting started

```bash
npm install
npm run dev            # Vite dev server (HMR) → localhost:5173
```

On first run the app starts in **local-only mode** (data in localStorage); add your Supabase URL + anon key in Setup to enable cloud sync and AI. See `nomad_setup.sql` for the schema (idempotent — safe to re-run).

## Commands

```bash
npm run dev            # dev server (HMR)
npm run build          # production build → dist/
npm run lint           # ESLint (JS/JSX)
npm run typecheck      # tsc --noEmit on api/
npm test               # vitest run (unit)
npm run test:e2e       # Playwright (needs dev server)
```

## Deployment

Vercel: the frontend builds to `dist/`; the `api/` functions deploy as serverless routes. Configure the environment variables listed in `CLAUDE.md` (Supabase, Gmail, and at least one AI provider key). A daily cron (`vercel.json`) drives scheduled email reports.
