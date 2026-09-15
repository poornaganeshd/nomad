// Haptic feedback via the Web Vibration API. Supported on Android Chrome and
// installed PWAs; iOS Safari exposes no vibration API, so every call is a silent
// no-op there (safe to sprinkle anywhere without guards at the call site).
//
// DELEGATED, NOT PER-BUTTON. Haptics used to be wired by hand inside individual
// onClick handlers, which left whole surfaces silent (IOUWallet, CalendarView,
// history rows, month chips…) and read as "haptics randomly don't work".
// `attachGlobalHaptics()` (called once from main.jsx) now installs a single
// capture-phase `click` listener that ticks for EVERY interactive tap — real
// buttons/links/roles, and any element styled `cursor: pointer` (this codebase's
// clickable <div> cards). New UI gets haptics automatically; never wire
// hapticSelection/hapticLight into a click handler again.
//
// Same-gesture dedupe: the global tick flags the current event dispatch, and
// tap-tier calls that run later in the SAME dispatch (all the legacy inline
// hapticSelection calls) are swallowed, so one tap = exactly one tick.
//
// THE FLAG IS CLEARED BY THE NEXT CLICK, NOT BY A TIMER. It used to reset on a
// setTimeout(…, 0), which is a task queued behind whatever the click handler
// kicked off — and in this app that is a re-render of a 3k-line monolith. On a
// phone that render can hold the main thread for hundreds of milliseconds, so
// the reset had not run yet when the next tap arrived, the flag was still set,
// and that tap silently produced NO buzz. That is the whole of "haptics work
// sometimes": every tap that lands during a slow render after another tap is
// eaten. Clearing at the top of each real click dispatch is timing-independent
// — the tick fires first in the capture phase, so one tap is still exactly one
// tick — and the timer stays only as a backstop for tap-tier calls that arrive
// without a click of their own. Don't put a fixed Date.now() window on the tap
// tier either; that eats fast keypad taps, which is how this started.
//
// Pattern vocabulary — follows common mobile UX conventions so the *kind* of
// feedback matches the *kind* of event:
//   selection 30ms  — light tick: any tap (this is what the global listener fires)
//   light     45ms  — a slightly weightier tap / navigation
//   medium    65ms  — a committed action with no toast of its own (e.g. delete)
//   success   rising double — a write succeeded
//   warning   even double   — a soft block (cap hit, validation)
//   error     strong double — a failure
// Durations are deliberately >=30ms: sub-20ms pulses are below the reliable
// perception threshold on most Android ERM/LRA motors, so shorter ticks read as
// "no buzz at all".
//
// Two independent tiers: taps (selection/light) dedupe per gesture as above;
// outcomes (medium/success/warning/error) always fire even right after a tap —
// they're the feedback that matters — with only a 40ms window to coalesce
// cascades of identical toasts into one pulse.

const KEY = "nomad-haptics";

let enabled = (() => { try { return localStorage.getItem(KEY) !== "off"; } catch { return true; } })();
let gestureTicked = false; // current event dispatch already produced a tap tick
let resetTimer = null;     // backstop clear for tap ticks that arrive without a click
let lastOutcome = 0;

export const hapticsEnabled = () => enabled;

export const setHapticsEnabled = (on) => {
  enabled = !!on;
  try { localStorage.setItem(KEY, on ? "on" : "off"); } catch { /* quota — non-fatal */ }
};

// Optional chaining keeps this a no-op where navigator/vibrate is absent
// (iOS Safari, jsdom, SSR) without throwing.
const vibrate = (pattern) => { try { navigator?.vibrate?.(pattern); } catch { /* unsupported */ } };

const tapBuzz = (pattern) => {
  if (!enabled || gestureTicked) return;
  gestureTicked = true;
  // Backstop only — the authoritative reset is at the top of the next click
  // dispatch (see attachGlobalHaptics). This clears the flag for tap-tier calls
  // that never get one, e.g. a programmatic hapticLight() outside any gesture.
  if (resetTimer) clearTimeout(resetTimer);
  resetTimer = setTimeout(() => { gestureTicked = false; resetTimer = null; }, 0);
  vibrate(pattern);
};

const outcomeBuzz = (pattern) => {
  if (!enabled) return;
  const now = Date.now();
  if (now - lastOutcome < 40) return; // coalesce toast cascades into one pulse
  lastOutcome = now;
  vibrate(pattern);
};

export const hapticSelection = () => tapBuzz(30);
export const hapticLight = () => tapBuzz(45);
export const hapticMedium = () => outcomeBuzz(65);
export const hapticSuccess = () => outcomeBuzz([35, 45, 55]);
export const hapticWarning = () => outcomeBuzz([45, 55, 45]);
export const hapticError = () => outcomeBuzz([65, 70, 65]);

// Toast → feedback mapping, used centrally in showT. Only user-action OUTCOMES
// buzz: info/warn stay silent so on-load bill reminders don't vibrate the device
// every time the app opens.
export const hapticForToast = (type) => {
  if (type === "success") hapticSuccess();
  else if (type === "error") hapticError();
};

// ---- global delegation -----------------------------------------------------

const INTERACTIVE = 'button, a[href], [role="button"], summary, label, select, input[type="checkbox"], input[type="radio"], input[type="range"], input[type="file"]';
const TEXT_ENTRY = "input, textarea"; // focusing a field shouldn't tick (the OS keyboard has its own)

// Walk up from the tap target looking for something interactive. Real controls
// match INTERACTIVE; the app's many clickable <div> cards are caught by their
// computed `cursor: pointer`. Text-entry fields end the walk with "not a tap".
//
// The depth cap is generous on purpose. At 12 it was a silent miss: App.jsx
// nests inline-styled wrappers deeply, so a tap landing on a leaf span inside a
// card inside a section inside a sheet could run out of walk before reaching
// the `cursor: pointer` ancestor that makes it a button — and that whole
// surface then felt like haptics were broken. The loop is cheap (it stops at
// the first match, which for a real <button> is the first or second step).
const MAX_WALK = 30;
const findInteractive = (start) => {
  let el = start instanceof Element ? start : null;
  for (let i = 0; el && el !== document.documentElement && i < MAX_WALK; i++, el = el.parentElement) {
    if (el.matches(TEXT_ENTRY) && !el.matches(INTERACTIVE)) return null;
    if (el.matches(INTERACTIVE)) return el;
    try { if (getComputedStyle(el).cursor === "pointer") return el; } catch { /* detached node */ }
  }
  return null;
};

let attachedTo = null;

// Install the app-wide tap tick. `click` (not pointerdown) so a finger landing
// to scroll never buzzes, and the event carries user activation, which Chrome
// requires for vibrate(). Capture phase runs before React's handlers, so the
// gesture flag is already set when legacy inline haptic calls fire.
// Idempotent per document; returns a detach function (used by tests).
export const attachGlobalHaptics = (doc = typeof document !== "undefined" ? document : null) => {
  if (!doc || attachedTo === doc) return () => {};
  const onClick = (e) => {
    // Every real click dispatch opens a NEW gesture. Clearing here — rather
    // than waiting for the previous tick's setTimeout(0), which a long React
    // render can starve well past the next tap — is what makes a fast sequence
    // of taps buzz every time instead of intermittently.
    gestureTicked = false;
    const el = findInteractive(e.target);
    if (!el || el.disabled) return;
    hapticSelection();
  };
  doc.addEventListener("click", onClick, { capture: true, passive: true });
  attachedTo = doc;
  return () => { doc.removeEventListener("click", onClick, { capture: true }); if (attachedTo === doc) attachedTo = null; };
};
