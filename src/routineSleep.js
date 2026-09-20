// routineSleep.js — sleep-duration maths for the Routine sub-app.
//
// Extracted from Routine.jsx so it can be unit-tested without mounting the
// component (same reason billReminders/bankReconcile live outside App.jsx), and
// because a component file that also exports helpers breaks Fast Refresh.

/**
 * Hours between a bedtime and a wake time, both "HH:MM" in local wall-clock.
 * Wrapping past midnight is the normal case, so a negative span adds a day.
 * Returns null when either end is missing or unparseable — the caller renders
 * that as "no data" rather than arithmetic on NaN.
 */
export const calcSleepDuration = (sleepTime, wakeTime) => {
    if (!sleepTime || !wakeTime) return null;
    const [sh, sm] = String(sleepTime).split(':').map(Number);
    const [wh, wm] = String(wakeTime).split(':').map(Number);
    if (![sh, sm, wh, wm].every(Number.isFinite)) return null;
    let mins = (wh * 60 + wm) - (sh * 60 + sm);
    if (mins < 0) mins += 1440;
    return mins / 60;
};

/**
 * "7h 58m" / "8h" / "—".
 *
 * Rounds to the nearest MINUTE first, then splits into h/m. Flooring the hours
 * while separately rounding the minutes let the two disagree: the minute part
 * could round up to a full 60 with the hour part unmoved, so the avg-sleep tile
 * rendered "6h 60m". A single night can't trigger it (its minutes are whole),
 * but the average over several nights lands anywhere — 6h20m and 7h39m average
 * to 6.9917h, which printed "6h 60m" instead of "7h".
 */
export const fmtSleep = (h) => {
    if (h == null || !Number.isFinite(h)) return '—';
    const total = Math.round(h * 60);
    const hours = Math.floor(total / 60);
    const mins = total % 60;
    return `${hours}h${mins > 0 ? ` ${mins}m` : ''}`;
};
