import { describe, it, expect } from 'vitest';
import { withAlpha, tint } from '../tint.js';

// The real values that exposed the bug: two seed categories, one seed wallet and
// one Routine sleep-quality option carry CSS vars instead of hex.
const VAR_COLORS = ['var(--warn)', 'var(--acc2)', 'var(--amber)'];

describe('withAlpha — hex path', () => {
  it('converts 6-digit hex to rgba', () => {
    expect(withAlpha('#FF6B35', 0.13)).toBe('rgba(255,107,53,0.13)');
    expect(withAlpha('#000000', 0.5)).toBe('rgba(0,0,0,0.5)');
    expect(withAlpha('#ffffff', 1)).toBe('rgba(255,255,255,1)');
  });

  it('is case-insensitive and tolerates surrounding space', () => {
    expect(withAlpha('  #ff6b35  ', 0.2)).toBe('rgba(255,107,53,0.2)');
  });
});

describe('withAlpha — the bug: CSS vars must not go black', () => {
  it.each(VAR_COLORS)('keeps %s as a colour instead of rgba(0,0,0,a)', (c) => {
    const out = withAlpha(c, 0.13);
    expect(out).toBe(`color-mix(in srgb, ${c} 13%, transparent)`);
    expect(out).not.toContain('rgba(0,0,0');
  });

  it('rounds the percentage to a whole number', () => {
    expect(withAlpha('var(--warn)', 0.135)).toBe('color-mix(in srgb, var(--warn) 14%, transparent)');
    expect(withAlpha('var(--warn)', 0)).toBe('color-mix(in srgb, var(--warn) 0%, transparent)');
  });

  it('routes 3-digit hex, 8-digit hex+alpha and rgb() strings through color-mix too', () => {
    // None of these can be safely sliced or suffixed, but color-mix handles them.
    expect(withAlpha('#abc', 0.5)).toBe('color-mix(in srgb, #abc 50%, transparent)');
    expect(withAlpha('#FF6B3580', 0.5)).toBe('color-mix(in srgb, #FF6B3580 50%, transparent)');
    expect(withAlpha('rgb(1, 2, 3)', 0.25)).toBe('color-mix(in srgb, rgb(1, 2, 3) 25%, transparent)');
  });
});

describe('withAlpha — junk input', () => {
  it('falls back to transparent black only when there is no colour at all', () => {
    expect(withAlpha('', 0.3)).toBe('rgba(0,0,0,0.3)');
    expect(withAlpha(null, 0.3)).toBe('rgba(0,0,0,0.3)');
    expect(withAlpha(undefined, 0.3)).toBe('rgba(0,0,0,0.3)');
  });

  it('clamps the alpha and coerces a non-numeric one to 0', () => {
    expect(withAlpha('#FF6B35', 5)).toBe('rgba(255,107,53,1)');
    expect(withAlpha('#FF6B35', -2)).toBe('rgba(255,107,53,0)');
    expect(withAlpha('#FF6B35', NaN)).toBe('rgba(255,107,53,0)');
    expect(withAlpha('#FF6B35', 'x')).toBe('rgba(255,107,53,0)');
  });
});

describe('tint — the hex-alpha suffix idiom', () => {
  it('returns the byte-identical old string for hex, so nothing shifts visually', () => {
    // These are exactly the suffixes used across the app.
    ['15', '18', '20', '22', '24', '30', '33', '59', '1c'].forEach((hh) => {
      expect(tint('#FF6B35', hh)).toBe('#FF6B35' + hh);
    });
  });

  it.each(VAR_COLORS)('converts %s to a real tint instead of an invalid value', (c) => {
    // "var(--warn)24" is not a colour — the browser drops the declaration and the
    // surface renders with NO tint at all. 0x24/255 = 14%.
    expect(tint(c, '24')).toBe(`color-mix(in srgb, ${c} 14%, transparent)`);
    expect(tint(c, '24')).not.toContain(`${c}24`);
  });

  it('maps the suffix to the right percentage', () => {
    expect(tint('var(--warn)', '15')).toBe('color-mix(in srgb, var(--warn) 8%, transparent)');  // 0x15/255 = 8.2%
    expect(tint('var(--warn)', '33')).toBe('color-mix(in srgb, var(--warn) 20%, transparent)'); // 0x33/255 = 20%
    expect(tint('var(--warn)', '59')).toBe('color-mix(in srgb, var(--warn) 35%, transparent)'); // 0x59/255 = 35%
    expect(tint('var(--warn)', 'ff')).toBe('color-mix(in srgb, var(--warn) 100%, transparent)');
  });

  it('accepts an uppercase suffix', () => {
    expect(tint('#FF6B35', '1C')).toBe('#FF6B351C');
    expect(tint('var(--warn)', '1C')).toBe('color-mix(in srgb, var(--warn) 11%, transparent)');
  });

  it('does not suffix a colour it cannot safely suffix', () => {
    expect(tint('#abc', '22')).not.toBe('#abc22');
    expect(tint('#FF6B3580', '22')).not.toBe('#FF6B358022');
  });

  it('survives junk', () => {
    expect(tint(null, '22')).toBe(`rgba(0,0,0,${0x22 / 255})`);
    expect(tint('#FF6B35', null)).toBe('rgba(255,107,53,0)');
    expect(tint('#FF6B35', 'zz')).toBe('rgba(255,107,53,0)');
  });
});
