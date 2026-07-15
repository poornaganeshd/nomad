# NOMAD — Public Launch Plan

Roadmap for taking NOMAD from a personal app to a public product, based on a
code audit (July 2026) and the competitive positioning work: NOMAD competes as
**"the discipline of kakeibo, the habit loop of Duolingo, a real finance engine
underneath — with your data in your own database."** Not against SMS
auto-trackers (Moneyview/Axio); against Fortune City on habit mechanics, YNAB on
philosophy, Actual Budget on data ownership.

**What the audit found already shipped** (plan builds on these, doesn't rebuild):

- Full Duolingo-style streak engine (`src/streak.js`): freezes, milestones,
  28-day calendar, no-spend days, derived-by-replay. UI: streak sheet with
  flame/longest/freezes/milestone bar, no-spend button, milestone toasts,
  daily nudge dismissal (`nomad-streak-nudge`).
- Daily proactive insight line (`src/insights.js` `buildDailyInsight`) — the
  reflective half of the loop.
- CSV export, full JSON Backup/Restore, Recently-Deleted with purge, and
  `sbDeleteWhere` hard-delete plumbing (Settings).
- `api/setup-user.ts` already creates report/notification tables via the
  Supabase Management API with a user PAT — the seed of one-click provisioning.
- Offline-first queue, idempotent `/api/sync`, web push with per-user
  subscriptions, 607-test suite + CI. The infra is launch-grade.

**What blocks a public launch**, in order of severity:

1. AI/email endpoints run on the owner's API keys with no auth or rate limit —
   public users would burn the owner's quota (economics blocker).
2. Cloud onboarding requires manually creating a Supabase project and running
   `nomad_setup.sql` (adoption blocker).
3. The discipline story is implied, not the front door (positioning blocker).
4. No privacy policy / data-flow disclosure (trust blocker).

---

## Phase 1 — Multi-user economics & abuse resistance (server)

*The hard blocker. Nothing else matters if 100 strangers can drain the
owner's Gemini quota on day one.*

### 1.1 BYO AI keys — `M`

Public users bring their own free-tier Gemini/Groq key, exactly like they bring
their own Supabase.

- `src/credentials.js`: add optional `aiGeminiKey` / `aiGroqKey` /
  `aiNvidiaKey` to the creds blob (localStorage, never synced).
- Every AI call site in `App.jsx`, `foodVision.js`: pass the user keys in a
  request header (`x-ai-keys`, JSON) — headers, not body, so redaction and
  body-shape validators stay untouched.
- `api/_ai-provider.ts`: accept per-request key overrides; a request with user
  keys uses ONLY user keys (waterfall order preserved). Env keys become the
  fallback for requests without user keys — see 1.2 for who may do that.
  Never log key material; scrub from error messages.
- `CredentialSetup.jsx` + Settings: "AI (optional)" fields with a one-line
  "get a free key" link per provider; the existing "AI features disabled"
  states already handle key-absent gracefully (503 path).
- Tests: `api/__tests__/ai-provider.test.ts` — override precedence, no
  env-key leakage into user-key requests, key never appears in thrown errors.

### 1.2 Owner-key gating + rate limiting — `M`

Keep owner env keys usable for the owner without exposing them publicly.

- New `api/_guard.ts`: shared per-endpoint guard.
  - **Owner check:** request may use env AI keys only when its Supabase URL
    (already sent by most callers, add where missing) matches
    `VITE_SUPABASE_URL` — i.e., the deployer. Everyone else must send BYO keys
    or gets 402-style `{ error: "bring-your-own-key" }` that the client
    renders as a setup hint.
  - **Rate limit:** token bucket keyed by IP + Supabase ref, stored in the
    owner DB (`api_rate_limits` table added to `nomad_setup.sql`) with a
    best-effort in-memory fast path. Applies to `ai-analyze`, `ai-chat`,
    `ai-insights`, `ai-categorize`, `food-vision`, `push`, `sync`,
    `send-now`, `setup-user`. Sensible defaults (e.g. 60 req/hr AI, 600/hr
    sync); 429 with `Retry-After`.
- `send-now.ts` already gates on `user_registry`; keep, add the rate limit.
- Cron stays behind `CRON_SECRET` (already done).
- Tests: new `api/__tests__/guard.test.ts` (bucket math, owner match,
  header-vs-env precedence) + a case in each endpoint's existing test file.

### 1.3 Email reports become explicitly owner-only (for now) — `S`

Gmail creds are the owner's; a public user's reports coming "from" the owner's
Gmail is wrong on every axis.

- `send-reports.ts`: skip the email leg for non-owner registry entries
  (compare `supabase_url` to `REGISTRY_URL`); web-push/ntfy digest legs keep
  working for everyone — that's the real notification story anyway.
- Settings UI: hide/annotate the email-reports card in non-owner deployments
  ("email reports require your own deployment — see OWNER_SETUP.md").
- Later (post-launch, optional): per-user SMTP creds in their own
  `notification_prefs`.

### 1.4 `user_registry` becomes informed opt-in — `S`

The registry stores each user's Supabase URL + anon key in the OWNER's
database so the cron can push digests. That's fine — but for the public it
must be disclosed and reversible.

- Registration moment (web-push enable / report setup): one-time consent copy
  — "NOMAD's daily reminder service stores your Supabase URL + anon key on
  the app server to check your due bills once a day. Remove anytime."
- New `DELETE /api/setup-user` (or `mode: "unregister"`): removes the caller's
  registry row + push subscriptions; wired to a "Disconnect reminder service"
  button in Settings.
- Cap registry size via env (`MAX_REGISTRY_USERS`, cron logs + skips beyond
  it) so the owner's daily cron can't silently blow past Vercel/Gmail limits.

**Phase 1 exit criteria:** a stranger with the app URL and no keys can log
expenses forever (local mode) but cannot consume any owner-paid resource
beyond rate-limited sync; a stranger with their own free keys gets full AI.

---

## Phase 2 — Onboarding: collapse the Supabase wall

*Local-only mode is already the real free tier and needs no work. This phase
is about making "upgrade to cloud" a 3-minute wizard instead of a 30-minute
SQL session.*

### 2.1 Guided cloud setup wizard — `L`

Extend the existing Management-API pattern from `setup-user.ts` to the whole
schema.

- `api/setup-user.ts`: new `mode: "full-setup"` that runs the complete
  `nomad_setup.sql` (import the file at build time — single source of truth,
  no DDL fork; it's already idempotent). Auth = the user's PAT, as today.
  PAT is used in-flight only, never stored — say so in the UI.
- `CredentialSetup.jsx` becomes a 3-step wizard:
  1. **Choose path:** "Stay local (default) / Connect my own cloud".
  2. **Cloud path:** links to create a free Supabase project + PAT, then two
     fields (project URL, PAT) → calls full-setup → on success asks only for
     the anon key (with a screenshot hint of where it lives).
  3. **Verify:** ping `rest/v1/expenses?limit=1`, green check, done.
- Keep the current manual path ("I already ran the SQL") as an "advanced"
  collapse for existing users.
- Tests: extend `api/__tests__` for full-setup mode (mock Management API);
  e2e happy-path for the wizard UI with mocked fetch.

### 2.2 Local → cloud backfill — `M`

Today, data logged before adding creds only reaches Supabase via merge
accidents, not by design. Make it explicit.

- After the wizard succeeds and creds save: detect local rows with no cloud
  counterpart (the `nomad-v5` backup vs a fresh `sbGet`) and enqueue upserts
  for all of them through the existing `offlineSync` queue (it already
  handles batching/retry/dedupe — reuse, don't write a new uploader).
- Progress toast ("Backing up 214 entries to your cloud…") driven by queue
  drain; `subscribeSyncDrops` already surfaces failures.
- Test: `src/__tests__/` new backfill test — local rows present, remote
  empty → every table enqueued once, dedupe keys correct, prefs blob pushed.

### 2.3 Progressive disclosure of the feature surface — `M`

First-run should feel like a habit app, not a dashboard of eight products.

- New `src/onboarding.js` (pure + localStorage, testable): tracks
  `firstUseDate`, days-with-logs, and a `surfaceLevel` derived from them.
- Level 0 (day 0): Add + Dashboard (with streak + insight) + History.
  Level 1 (first log): Recurring + wallets management surface.
  Level 2 (3+ logged days or explicit "show everything" in Settings):
  Events, IOU, NOMAD Lite, Routine, reconcile.
- Implementation is *hiding entry points only* (tab bar items, dashboard
  cards) — zero data-model changes, and a single "Show all features" switch
  in Settings bypasses it forever (existing users: default to
  everything-on when local data already exists at first run with the flag).
- Tests: `onboarding.test.js` (level derivation), e2e: fresh profile sees
  the reduced tab bar.

**Phase 2 exit criteria:** a new user reaches their first logged expense in
under 60 seconds without reading anything; a motivated user reaches cloud
sync in under 5 minutes without leaving the app except to create the
Supabase project.

---

## Phase 3 — Make the discipline story the front door (product)

### 3.1 "Daily Minute" ritual card — `M`

One glanceable dashboard-top card that IS the product thesis:

- Compose what already exists: streak flame + `current` (tap → existing
  streak sheet), today-logged state, the `buildDailyInsight` line, and the
  no-spend quick action when today is empty.
- Add a rotating **reflection prompt** (kakeibo's four questions adapted):
  new `src/reflection.js` — pure function `(dayKey, recentTxns) → prompt`,
  e.g. "Yesterday's ₹340 on Food — need, want, or habit?" Deterministic per
  day, no AI, no storage beyond an optional one-tap answer appended to the
  day's note metadata (skip persistence in v1 if it drags — the prompt alone
  carries the ritual).
- Tests: `reflection.test.js` (determinism, data-driven prompt selection).

### 3.2 Streak-at-risk push (closed-app leg) — `M`

The client-side nudge exists but only fires with a tab open. Habit apps live
on the evening reminder.

- `api/_notify.ts`: alongside `buildBillDigest`, add `buildStreakNudge` —
  during the cron run (or a second daily cron at ~14:30 UTC / 20:00 IST if
  Vercel plan allows), query the user's Supabase for any row dated today
  across expenses/incomes/transfers/settlements; none → push "🔥 Your
  N-day streak is waiting — 30 seconds to log today." Needs streak length:
  store `current` in `notification_prefs` (client updates it opportunistically
  on each log; approximate is fine for copy).
- Dedupe via the existing `last_run_date` pattern (second column,
  `last_streak_nudge_date`).
- Respect a per-user toggle in the push card ("Evening streak reminder").
- Tests: extend `api/__tests__/notify.test.ts`.

### 3.3 Positioning pass on copy & README — `S`

- README / landing copy rewritten around the wedge: manual-by-design ("if
  you don't log it yourself, what did you learn?"), streaks, your-own-DB.
  Explicitly name what NOMAD does NOT do (SMS reading, bank linking) as a
  feature, not an apology.
- App: rename ambient labels where cheap (e.g. the dashboard section headers)
  to reinforce ritual framing. No structural changes.

**Phase 3 exit criteria:** a screenshot of the dashboard alone communicates
"daily money habit," and a closed app still pulls the user back at 8pm.

---

## Phase 4 — Trust plumbing

### 4.1 Privacy & data-flow page — `S`

Static, honest, specific. In-app (Settings → "Privacy & your data") plus a
`PRIVACY.md` rendered on the landing/README:

- What never leaves the device (everything, in local mode; creds; AI keys).
- What goes where in cloud mode: your Supabase (your rows), Cloudinary
  (receipts, if configured), AI providers (redacted transaction text — link
  to `redactor.js` behavior), owner server (registry row IF you enable
  reminders — see 1.4).
- Retention: soft-delete 30-day window (already built), how to purge, how to
  leave.

### 4.2 "Leave cleanly" — delete everything — `S`

Compose existing plumbing into one flow: Settings → "Delete all my data" →
confirm phrase → `sbDeleteWhere` across all tables + `user_prefs` +
`push_subscriptions` + registry unregister (1.4) + `localStorage` wipe →
reload into fresh local mode. Test the orchestration function in isolation.

### 4.3 Export completeness audit — `S`

`expBackup` covers finance state; verify and close gaps: streak store,
Routine tables (`daily_logs`, `user_config`), NOMAD Lite (`nomad-lite-v1`),
currency meta, auto-rules. One JSON = the user's entire life in the app,
restorable. Add a restore round-trip test.

**Phase 4 exit criteria:** every question a privacy-conscious reviewer would
ask has a one-link answer, and "get out with everything" is one button.

---

## Phase 5 — Distribution & retention ceiling

### 5.1 PWA polish — `S`

- Second manifest shortcut: "No-spend today ✓" (`/?nospend=1`, same pattern
  as the existing `/?add=1` flag).
- App Badging API: badge the icon when `atRisk` (cheap, in the bill-reminders
  effect; feature-detect).
- Install prompt: after the 3rd logged day (onboarding.js knows), show a
  one-time "put NOMAD on your home screen" card with the iOS A2HS explainer
  reused from the push card.

### 5.2 Play Store presence via TWA — `M` *(post-launch, optional)*

Bubblewrap/TWA wrapper around the deployed PWA for Play Store
discoverability — habit-app credibility and better notification defaults on
Android. No code changes to the app itself; new sibling repo/folder. iOS
native wrapper explicitly deferred.

---

## Phase 6 — Launch readiness checklist

- [ ] Baselines green: 607+ tests, lint 0 errors, typecheck clean, build OK
      (run per CLAUDE.md before/after every phase).
- [ ] Abuse drill: hit every `api/*` endpoint keyless/creditless — verify
      429/402 paths, nothing owner-paid reachable (Phase 1 regression sweep).
- [ ] Fresh-user drill on a clean profile: first log < 60s (Phase 2 metric),
      wizard end-to-end against a real throwaway Supabase project.
- [ ] Docs: README (positioning), OWNER_SETUP.md (deployers), PRIVACY.md,
      a short "your own cloud in 5 minutes" guide with screenshots.
- [ ] Beta cohort of 10–20 users for 2+ weeks watching: day-7 streak
      retention, wizard completion rate, sync dead-letter rate.
- [ ] Versioning story for `nomad_setup.sql` re-runs on upgrades (it's
      idempotent — document "re-run on every update" as the official path).

---

## Sequencing & effort

| Order | Phase | Size | Depends on | Why this order |
|---|---|---|---|---|
| 1 | P1 economics/abuse | ~2 wk | — | Hard blocker; everything public-facing waits on it |
| 2 | P2 onboarding | ~2–3 wk | P1 (wizard touches setup-user) | Biggest adoption lever |
| 3 | P3 discipline front door | ~1–2 wk | — (parallelizable with P2) | The differentiator reviewers will screenshot |
| 4 | P4 trust | ~1 wk | P1.4 (unregister) | Cheap, mandatory, mostly composition of existing plumbing |
| 5 | P5 distribution | ~1 wk + TWA later | P3 (streak badge) | Retention ceiling, not launch gate |
| 6 | P6 checklist + beta | 2+ wk elapsed | all | Gate to public |

Realistic calendar: **6–8 weeks of focused work to public beta**, TWA and
per-user SMTP explicitly after.

## Risks & mitigations

- **BYO-keys friction kills AI adoption** → AI is already optional
  everywhere (503 paths exist); position AI as the power-up, not the core.
  The core loop (log + streak + insight) is 100% local math.
- **Management-API wizard breaks when Supabase changes PAT/API shape** →
  keep the manual SQL path forever as the documented fallback.
- **Progressive disclosure annoys existing users** → auto-detect existing
  data → default to everything-on; the switch is one tap.
- **Rate-limit table adds writes to the owner DB** → in-memory fast path
  first, DB only on suspicion; bucket rows are tiny and TTL-pruned by cron.
- **Monolith risk:** most UI work lands in `App.jsx` — respect the
  one-JSX-block-per-line convention and the `COLS`/single-source-helper
  rules (CLAUDE.md) or CI breaks.
