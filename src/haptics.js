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
// hapticSelection calls) are swallowed, so one tap = exactly one tick. The flag
// resets on a 0ms timeout — after the dispatch completes — so two genuinely
// separate taps always both buzz, no matter how fast (a fixed Date.now() window
// here would eat fast keypad taps; don't reintroduce one on the tap tier).
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
  setTimeout(() => { gestureTicked = false; }, 0);
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
const findInteractive = (start) => {
  let el = start instanceof Element ? start : null;
  for (let i = 0; el && el !== document.documentElement && i < 12; i++, el = el.parentElement) {
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
    const el = findInteractive(e.target);
    if (!el || el.disabled) return;
    hapticSelection();
  };
  doc.addEventListener("click", onClick, { capture: true, passive: true });
  attachedTo = doc;
  return () => { doc.removeEventListener("click", onClick, { capture: true }); if (attachedTo === doc) attachedTo = null; };
};
