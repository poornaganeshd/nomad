// Haptic feedback via the Web Vibration API. Supported on Android Chrome and
// installed PWAs; iOS Safari exposes no vibration API, so every call is a silent
// no-op there (safe to sprinkle anywhere without guards at the call site).
//
// Pattern vocabulary — follows common mobile UX conventions so the *kind* of
// feedback matches the *kind* of event:
//   selection 15ms  — light tick: tab/segment switch, picker, wallet select
//   light     22ms  — a normal tap / navigation
//   medium    38ms  — a committed action with no toast of its own
//   success   rising double — a write succeeded
//   warning   even double   — a soft block (cap hit, validation)
//   error     strong double — a failure
//
// A short throttle coalesces bursts (e.g. a cascade of identical toasts, or
// double-fired click handlers) into a single pulse instead of a machine-gun of
// motor restarts.

const KEY = "nomad-haptics";

let enabled = (() => { try { return localStorage.getItem(KEY) !== "off"; } catch { return true; } })();
let last = 0;

export const hapticsEnabled = () => enabled;

export const setHapticsEnabled = (on) => {
  enabled = !!on;
  try { localStorage.setItem(KEY, on ? "on" : "off"); } catch { /* quota — non-fatal */ }
};

const buzz = (pattern) => {
  if (!enabled) return;
  const now = Date.now();
  if (now - last < 40) return; // coalesce rapid bursts into one pulse
  last = now;
  // Optional chaining keeps this a no-op where navigator/vibrate is absent
  // (iOS Safari, jsdom, SSR) without throwing.
  try { navigator?.vibrate?.(pattern); } catch { /* unsupported */ }
};

export const hapticSelection = () => buzz(15);
export const hapticLight = () => buzz(22);
export const hapticMedium = () => buzz(38);
export const hapticSuccess = () => buzz([18, 45, 32]);
export const hapticWarning = () => buzz([26, 50, 26]);
export const hapticError = () => buzz([45, 70, 45]);

// Toast → feedback mapping, used centrally in showT. Only user-action OUTCOMES
// buzz: info/warn stay silent so on-load bill reminders don't vibrate the device
// every time the app opens.
export const hapticForToast = (type) => {
  if (type === "success") hapticSuccess();
  else if (type === "error") hapticError();
};
