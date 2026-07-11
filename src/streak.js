// streak.js — Duolingo-style logging-streak engine (pure, no side effects
// except the two localStorage helpers at the bottom).
//
// The habit being rewarded is "I accounted for every day", not "I spent every
// day": a day counts if it has at least one transaction dated that day OR a
// one-tap "no spend" confirmation. Today never breaks the streak while it is
// still in progress (Duolingo's rule — a pending day shows as pending, not 0).
//
// Freezes (forgiveness): every 7th consecutive logged day earns one freeze,
// held up to FREEZE_CAP. A fully missed past day silently burns one freeze and
// the streak survives (the day shows as "frozen"); no freeze → streak resets.
// Everything is DERIVED by replaying history on every call — the only stored
// state is the no-spend day list (+ last celebrated milestone), so a backfilled
// transaction retroactively un-burns its freeze on the next recompute.
//
// Anti-cheat stance: none. Single-user personal app — backdating and imports
// count. Friction only punishes honest users.

import { localDateKey } from "./financeUtils";

export const FREEZE_CAP = 2;
export const FREEZE_EARN_EVERY = 7; // every 7th consecutive day → +1 freeze
export const MILESTONES = [3, 7, 14, 30, 50, 100, 200, 365];
export const STREAK_STORE_KEY = "nomad-streak-v1";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Noon anchor dodges DST off-by-one (house convention — see Routine/bankReconcile).
const nextDay = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d, 12);
  dt.setDate(dt.getDate() + 1);
  return localDateKey(dt);
};

/**
 * Replay the full logging history and return the streak state.
 *
 * @param {object} args
 * @param {Iterable<string>} args.txDates      "YYYY-MM-DD" of every manual transaction (expenses, incomes, transfers, settlements)
 * @param {Iterable<string>} args.noSpendDays  days the user confirmed "no spend"
 * @param {string}           args.today        localDateKey() of today (injectable for tests)
 * @returns {{
 *   current: number,        // streak length; includes today only once logged
 *   longest: number,
 *   todayLogged: boolean,
 *   atRisk: boolean,        // today unlogged and there is a streak to lose
 *   freezesHeld: number,
 *   frozenDays: string[],   // past days a freeze silently covered
 *   nextMilestone: number|null,
 *   milestoneToday: number|null, // milestone crossed by today's log, for celebration
 *   calendar: { date: string, state: "active"|"frozen"|"missed"|"pending" }[], // last 28 days, oldest first
 * }}
 */
export function computeStreak({ txDates = [], noSpendDays = [], today = localDateKey() } = {}) {
  const active = new Set();
  for (const d of txDates) { const k = String(d || "").slice(0, 10); if (DATE_RE.test(k) && k <= today) active.add(k); }
  for (const d of noSpendDays) { const k = String(d || "").slice(0, 10); if (DATE_RE.test(k) && k <= today) active.add(k); }

  const dayState = new Map(); // date → active|frozen|missed
  let run = 0, longest = 0, freezesHeld = 0;
  const frozenDays = [];

  if (active.size > 0) {
    let day = [...active].sort()[0];
    while (day <= today) {
      if (active.has(day)) {
        run++;
        if (run % FREEZE_EARN_EVERY === 0) freezesHeld = Math.min(FREEZE_CAP, freezesHeld + 1);
        dayState.set(day, "active");
      } else if (day === today) {
        // Pending — the day isn't over. Neither breaks nor burns a freeze.
        break;
      } else if (run > 0 && freezesHeld > 0) {
        // Freeze preserves the run but doesn't grow it (Duolingo semantics).
        freezesHeld--;
        frozenDays.push(day);
        dayState.set(day, "frozen");
      } else {
        longest = Math.max(longest, run);
        run = 0;
        dayState.set(day, "missed");
      }
      day = nextDay(day);
    }
  }
  longest = Math.max(longest, run);

  const todayLogged = active.has(today);
  const current = run;
  const atRisk = !todayLogged && current > 0;
  const nextMilestone = MILESTONES.find(m => m > current) ?? null;
  const milestoneToday = todayLogged && MILESTONES.includes(current) ? current : null;

  const calendar = [];
  {
    // Walk back 27 days from today via the noon anchor, then emit oldest-first.
    const keys = [];
    let k = today;
    for (let i = 0; i < 28; i++) { keys.push(k); const [y, m, d] = k.split("-").map(Number); const dt = new Date(y, m - 1, d, 12); dt.setDate(dt.getDate() - 1); k = localDateKey(dt); }
    keys.reverse();
    for (const date of keys) {
      const state = dayState.get(date) || (date === today && !todayLogged ? "pending" : active.has(date) ? "active" : "missed");
      calendar.push({ date, state });
    }
  }

  return { current, longest, todayLogged, atRisk, freezesHeld, frozenDays, nextMilestone, milestoneToday, calendar };
}

// ---------------------------------------------------------------------------
// Stored state — deliberately tiny: only what CANNOT be derived from the
// transaction history. localStorage-only for now (device-local, like
// nomad-lite); shape is versioned for a future user_prefs sync.
// ---------------------------------------------------------------------------

export function loadStreakStore(storage = globalThis.localStorage) {
  try {
    const raw = JSON.parse(storage.getItem(STREAK_STORE_KEY) || "{}");
    return {
      noSpendDays: Array.isArray(raw.noSpendDays) ? raw.noSpendDays.filter(d => DATE_RE.test(String(d))) : [],
      lastCelebrated: Number(raw.lastCelebrated) || 0,
    };
  } catch { return { noSpendDays: [], lastCelebrated: 0 }; }
}

export function saveStreakStore(store, storage = globalThis.localStorage) {
  try {
    storage.setItem(STREAK_STORE_KEY, JSON.stringify({
      // Cap keeps the store bounded; old days age out harmlessly because the
      // engine only needs them until real txns surround them.
      noSpendDays: [...new Set(store.noSpendDays)].sort().slice(-400),
      lastCelebrated: store.lastCelebrated || 0,
    }));
  } catch { /* quota — streak state is reconstructible, not precious */ }
  return store;
}
