// Colour tinting — the single place that turns "a colour + an opacity" into CSS.
//
// Category, wallet and income-source colours are USER-EDITABLE, and several of
// the built-in seeds are CSS custom properties rather than hex:
//   DC.coffee     = var(--warn)      DC.rent = var(--acc2)
//   WALLETS.cash  = var(--warn)      Routine's "Light" sleep quality = var(--amber)
// Every hand-rolled tinting trick in the app broke on those, in two different
// and equally invisible ways:
//
//   1. Hex-PARSING helpers (`parseInt(hex.slice(0,2), 16) || 0`) don't throw on
//      "var(--warn)" — they yield NaN, the `|| 0` blackens every channel, and you
//      get rgba(0,0,0,a). A translucent BLACK chip that reads as a deliberate
//      design choice, which is why it survived so long.
//   2. The hex-alpha SUFFIX idiom (`color + "24"`, `${color}24`) produced
//      "var(--warn)24" — not a colour at all — so the browser dropped the whole
//      declaration and the surface rendered with NO tint. The Cash wallet tile's
//      icon chip had neither a fill nor its dashed ring while the other two
//      wallets had both.
//
// Both paths now funnel through here. Pure; no DOM, no React. Tested in
// src/__tests__/tint.test.js.

// Only a full 6-digit hex can be manipulated arithmetically or suffixed. 3-digit
// hex, 8-digit hex+alpha, rgb()/hsl() strings and var() all take the color-mix
// path, which handles every one of them correctly.
const HEX6 = /^#[0-9a-fA-F]{6}$/;

const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * Tint `c` to the decimal opacity `a` (0–1).
 * Hex → rgba(). Anything else → color-mix(), so CSS vars keep their colour.
 */
export const withAlpha = (c, a) => {
  const s = String(c ?? "").trim();
  const al = clamp01(Number(a));
  if (HEX6.test(s)) {
    return `rgba(${parseInt(s.slice(1, 3), 16)},${parseInt(s.slice(3, 5), 16)},${parseInt(s.slice(5, 7), 16)},${al})`;
  }
  // An empty colour has nothing to mix; keep the old transparent-black result
  // rather than emitting `color-mix(in srgb,  0%, transparent)`.
  if (!s) return `rgba(0,0,0,${al})`;
  return `color-mix(in srgb, ${s} ${Math.round(al * 100)}%, transparent)`;
};

/**
 * The 2-digit hex-alpha suffix idiom: `tint(c, "24")` replaces `c + "24"`.
 * A real 6-digit hex returns the byte-identical old string, so no existing
 * visual shifts; everything else routes through withAlpha.
 */
export const tint = (c, hh) => {
  const s = String(c ?? "").trim();
  const suffix = String(hh ?? "");
  if (HEX6.test(s) && /^[0-9a-fA-F]{2}$/.test(suffix)) return s + suffix;
  return withAlpha(s, (parseInt(suffix, 16) || 0) / 255);
};
