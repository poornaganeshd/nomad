import React, { useState, useEffect, useMemo, useRef } from 'react';
import { sendSupabaseRequest } from './offlineSync';
import { getCredentials as _getCreds } from './credentials';
import { analyzeFood, foodResultToText, foodResultToMacroString } from './foodVision';
import { IconFlameFilled, IconDropletFilled, IconCalendarMonth, IconCircleCheckFilled, IconMoodHappyFilled, IconMoodNeutralFilled, IconMoodSadFilled, IconMoodAngryFilled, IconBedFilled, IconMoonFilled, IconCameraFilled, IconCalendarWeek, IconPhotoPlus } from '@tabler/icons-react';
import { Camera, Leaf, Robot } from "@phosphor-icons/react";

/* ============================================================
   FORM — Daily food & skincare ritual tracker  v6
   Single-file React JSX. localStorage persistence. Mobile-first.
   v1 → original
   v2 → 13-fix rewrite (tab tinting, lion→panda, water+morning, toast,
         egg cap, food log categories, snack simplify, notes confirm,
         skin routine editor, log detail, xlsx export, settings reorg)
   v3 → panda emoji restored, flat food log w/ tags, download DOM fix
   v4 → export = xlsx only, backup = json only, nuke = single confirm
   v5 → inline nuke confirmation UI (no confirm() dialog)
   v6 → progress dots, streak badge, end-of-day card, AM/PM auto-expand,
         haptic feedback, confirm btn filled, avg water stat, empty state
   v7 → progress dots UI fix: column layout (dot + label + value), no wrap
   ============================================================ */

const PhosphorIcon = ({ name, size = 24, color = 'currentColor', opacity = 0.7 }) => {
    const icons = {
        drop: (
            <svg width={size} height={size} viewBox="0 0 256 256" fill="none">
                <path d="M208,144a80,80,0,0,1-160,0C48,80,128,16,128,16S208,80,208,144Z" fill={color} opacity={opacity} />
                <path d="M208,144a80,80,0,0,1-160,0C48,80,128,16,128,16S208,80,208,144Z" stroke={color} strokeWidth="14" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                <line x1="128" y1="200" x2="128" y2="224" stroke={color} strokeWidth="14" strokeLinecap="round" />
            </svg>
        ),
        egg: (
            <svg width={size} height={size} viewBox="0 0 256 256" fill="none">
                <ellipse cx="128" cy="135" rx="80" ry="97" fill={color} opacity={opacity} />
                <ellipse cx="128" cy="135" rx="80" ry="97" stroke={color} strokeWidth="14" fill="none" />
                <path d="M80,112C95,90,161,90,176,112" stroke={color} strokeWidth="14" strokeLinecap="round" fill="none" />
            </svg>
        ),
        bowl: (
            <svg width={size} height={size} viewBox="0 0 256 256" fill="none">
                <path d="M32,104H224a96,96,0,0,1-192,0Z" fill={color} opacity={opacity} />
                <path d="M32,104H224a96,96,0,0,1-192,0Z" stroke={color} strokeWidth="14" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                <line x1="72" y1="224" x2="184" y2="224" stroke={color} strokeWidth="14" strokeLinecap="round" />
                <line x1="32" y1="72" x2="224" y2="72" stroke={color} strokeWidth="14" strokeLinecap="round" />
            </svg>
        ),
        leaf: (
            <svg width={size} height={size} viewBox="0 0 256 256" fill="none">
                <path d="M152,32C80,32,40,88,40,152c0,0,48-24,88-16s72,48,72,48C228,120,224,32,152,32Z" fill={color} opacity={opacity} />
                <path d="M152,32C80,32,40,88,40,152c0,0,48-24,88-16s72,48,72,48C228,120,224,32,152,32Z" stroke={color} strokeWidth="14" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                <line x1="40" y1="216" x2="120" y2="136" stroke={color} strokeWidth="14" strokeLinecap="round" />
            </svg>
        ),
        bottle: (
            <svg width={size} height={size} viewBox="0 0 256 256" fill="none">
                <rect x="88" y="56" width="80" height="160" rx="24" fill={color} opacity={opacity} />
                <rect x="88" y="56" width="80" height="160" rx="24" stroke={color} strokeWidth="14" fill="none" />
                <line x1="88" y1="120" x2="168" y2="120" stroke={color} strokeWidth="12" strokeLinecap="round" />
                <path d="M88,152c20,16,64,16,80,0" stroke={color} strokeWidth="12" strokeLinecap="round" fill="none" />
                <path d="M108,56V32M148,56V32" stroke={color} strokeWidth="14" strokeLinecap="round" />
            </svg>
        ),
        notepad: (
            <svg width={size} height={size} viewBox="0 0 256 256" fill="none">
                <rect x="48" y="40" width="160" height="176" rx="16" fill={color} opacity={opacity} />
                <rect x="48" y="40" width="160" height="176" rx="16" stroke={color} strokeWidth="14" fill="none" />
                <line x1="88" y1="100" x2="168" y2="100" stroke={color} strokeWidth="14" strokeLinecap="round" />
                <line x1="88" y1="132" x2="168" y2="132" stroke={color} strokeWidth="14" strokeLinecap="round" />
                <line x1="88" y1="164" x2="136" y2="164" stroke={color} strokeWidth="14" strokeLinecap="round" />
            </svg>
        ),
        sparkle: (
            <svg width={size} height={size} viewBox="0 0 256 256" fill="none">
                <path d="M128,24l24,80H232l-68,48,24,80L128,184,68,232l24-80L24,104h80Z" fill={color} opacity={opacity} />
                <path d="M128,24l24,80H232l-68,48,24,80L128,184,68,232l24-80L24,104h80Z" stroke={color} strokeWidth="14" strokeLinejoin="round" fill="none" />
            </svg>
        ),
        sun: (
            <svg width={size} height={size} viewBox="0 0 256 256" fill="none">
                <circle cx="128" cy="128" r="60" fill={color} opacity={opacity} />
                <circle cx="128" cy="128" r="60" stroke={color} strokeWidth="14" fill="none" />
                {[[128, 24], [128, 232], [24, 128], [232, 128], [60, 60], [196, 196], [60, 196], [196, 60]].map(([x1, y1], i) => {
                    const cx = 128, cy = 128, dx = x1 - cx, dy = y1 - cy, len = Math.sqrt(dx * dx + dy * dy), nx = dx / len, ny = dy / len;
                    return <line key={i} x1={cx + nx * 72} y1={cy + ny * 72} x2={cx + nx * 88} y2={cy + ny * 88} stroke={color} strokeWidth="14" strokeLinecap="round" />;
                })}
            </svg>
        ),
        moon: (
            <svg width={size} height={size} viewBox="0 0 256 256" fill="none">
                <path d="M216,112A88,88,0,0,1,112,216c-40,0-74-22-90-56,0,0,42,10,74-8s52-54,38-96C172,58,216,82,216,112Z" fill={color} opacity={opacity} />
                <path d="M216,112A88,88,0,0,1,112,216c-40,0-74-22-90-56,0,0,42,10,74-8s52-54,38-96C172,58,216,82,216,112Z" stroke={color} strokeWidth="14" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
        ),
        heart: (
            <svg width={size} height={size} viewBox="0 0 256 256" fill="none">
                <path d="M128,224S24,160,24,96a52,52,0,0,1,104,0,52,52,0,0,1,104,0C232,160,128,224,128,224Z" fill={color} opacity={opacity} />
                <path d="M128,224S24,160,24,96a52,52,0,0,1,104,0,52,52,0,0,1,104,0C232,160,128,224,128,224Z" stroke={color} strokeWidth="14" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
        ),
        flame: (
            <svg width={size} height={size} viewBox="0 0 256 256" fill="none">
                <path d="M96,224c0-80,80-88,80-160,0,0,32,32,32,80a96,96,0,0,1-192,0C16,112,96,136,96,224Z" fill={color} opacity={opacity} />
                <path d="M96,224c0-80,80-88,80-160,0,0,32,32,32,80a96,96,0,0,1-192,0C16,112,96,136,96,224Z" stroke={color} strokeWidth="14" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
        ),
        cup: (
            <svg width={size} height={size} viewBox="0 0 256 256" fill="none">
                <path d="M56,56H200l-24,128H80Z" fill={color} opacity={opacity} />
                <path d="M56,56H200l-24,128H80Z" stroke={color} strokeWidth="14" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                <line x1="64" y1="208" x2="192" y2="208" stroke={color} strokeWidth="14" strokeLinecap="round" />
                <path d="M200,88h24a24,24,0,0,1,0,48H200" stroke={color} strokeWidth="14" strokeLinecap="round" fill="none" />
            </svg>
        ),
        pill: (
            <svg width={size} height={size} viewBox="0 0 256 256" fill="none">
                <rect x="36" y="100" width="184" height="56" rx="28" fill={color} opacity={opacity} />
                <rect x="36" y="100" width="184" height="56" rx="28" stroke={color} strokeWidth="14" fill="none" />
                <line x1="128" y1="100" x2="128" y2="156" stroke={color} strokeWidth="12" />
            </svg>
        ),
        book: (
            <svg width={size} height={size} viewBox="0 0 256 256" fill="none">
                <path d="M40,196V56a16,16,0,0,1,16-16H216V196Z" fill={color} opacity={opacity} />
                <path d="M40,196V56a16,16,0,0,1,16-16H216V196H56A16,16,0,0,0,40,212V196" stroke={color} strokeWidth="14" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                <path d="M56,212H216" stroke={color} strokeWidth="14" strokeLinecap="round" />
            </svg>
        ),
        star: (
            <svg width={size} height={size} viewBox="0 0 256 256" fill="none">
                <path d="M128,24l26,54,60,8-44,42,10,60L128,160l-52,28,10-60L42,86l60-8Z" fill={color} opacity={opacity} />
                <path d="M128,24l26,54,60,8-44,42,10,60L128,160l-52,28,10-60L42,86l60-8Z" stroke={color} strokeWidth="14" strokeLinejoin="round" fill="none" />
            </svg>
        ),
        run: (
            <svg width={size} height={size} viewBox="0 0 256 256" fill="none">
                <circle cx="164" cy="44" r="20" fill={color} opacity={opacity} />
                <circle cx="164" cy="44" r="20" stroke={color} strokeWidth="14" fill="none" />
                <path d="M80,160l40-56,40,24,32,56" stroke={color} strokeWidth="14" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                <path d="M120,104l-40,80" stroke={color} strokeWidth="14" strokeLinecap="round" fill="none" />
            </svg>
        ),
    };
    return icons[name] || null;
};

const PHOSPHOR_NAMES = new Set(['drop', 'egg', 'bowl', 'leaf', 'bottle', 'notepad', 'sparkle', 'sun', 'moon', 'heart', 'flame', 'cup', 'pill', 'book', 'star', 'run']);
const ItemIcon = ({ name, size = 22, color = 'rgba(0,0,0,0.45)', opacity = 0.35 }) =>
    PHOSPHOR_NAMES.has(name)
        ? <PhosphorIcon name={name} size={size} color={color} opacity={opacity} />
        : <span style={{ fontSize: size - 2, lineHeight: 1 }}>{name}</span>;

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700;800&family=DM+Mono:wght@400;500&display=swap');

#nomad-routine {
  --bg: #f0ece4;
  --bg2: #e8e4dc;
  --sf: #ffffff;
  --bd: rgba(0,0,0,0.07);
  --bde: rgba(0,0,0,0.13);
  --tx: rgba(46,43,38,0.92);
  --txm: rgba(46,43,38,0.50);
  --txd: rgba(46,43,38,0.28);
  --green: #639922;
  --green-sf: #b8d98a;
  --green-deep: #3B6D11;
  --amber: #EF9F27;
  --amber-sf: #f9e09a;
  --amber-deep: #854F0B;
  --teal: #1D9E75;
  --teal-sf: #8adace;
  --teal-deep: #0F6E56;
  --r: 20px;
  --rsm: 14px;
  --rpill: 100px;
  --font: 'DM Sans', sans-serif;
  --mono: 'DM Mono', monospace;
  --card-shadow: 0 3px 0 #ddd8ce;
  --sky: #d4e8f5;
  --sky-horizon: #e8f0e4;
  --sky-grass: #c8dba0;
  /* ── tile color tokens (light) ── */
  --ti-amber-bg:#FFD04D;  --ti-amber-sh:0 3px 0 #C8960C;
  --ti-amber-i-bg:#FFF4CC; --ti-amber-i-sh:0 3px 0 #E8D880;
  --ti-green-bg:#8ED952;  --ti-green-sh:0 3px 0 #5CA828;
  --ti-green-i-bg:#E0F8C0; --ti-green-i-sh:0 3px 0 #B0DC80;
  --ti-teal-bg:#3DC9B4;   --ti-teal-sh:0 3px 0 #1A9888;
  --ti-teal-i-bg:#C4F0EC;  --ti-teal-i-sh:0 3px 0 #88D4CC;
  --ti-sage-bg:#A0CC6A;   --ti-sage-sh:0 3px 0 #72A038;
  --ti-sage-i-bg:#D8F4B8;  --ti-sage-i-sh:0 3px 0 #ACCC80;
  --ti-purple-bg:#C070F0; --ti-purple-sh:0 3px 0 #8C30C0;
  --ti-purple-i-bg:#EED8FC; --ti-purple-i-sh:0 3px 0 #C8A0E8;
  --ti-pink-bg:#F070B8;   --ti-pink-sh:0 3px 0 #C03888;
  --ti-pink-i-bg:#FCD8EC;  --ti-pink-i-sh:0 3px 0 #E8A8CC;
  --ti-name:rgba(0,0,0,0.62);
  --ti-meta:rgba(0,0,0,0.32);
  --ti-amber-meta:rgba(0,0,0,0.32);
  --ti-green-meta:rgba(0,0,0,0.32);
  --ti-teal-meta:rgba(0,0,0,0.32);
  --ti-sage-meta:rgba(0,0,0,0.32);
  --ti-purple-meta:rgba(0,0,0,0.32);
  --ti-pink-meta:rgba(0,0,0,0.32);
  --ti-icon-idle:#f5f2ee;
  --ti-icon-done:rgba(255,255,255,0.45);
  --ti-check-done:rgba(255,255,255,0.6);
  --ti-stepper-bg:rgba(255,255,255,0.55);
  --ti-stepper-col:rgba(0,0,0,0.5);
}

/* ── WARM CHARCOAL DARK THEME ── */
#nomad-routine.dark {
  --bg: #14110D;
  --bg2: #1E1A14;
  --sf: #221E18;
  --bd: rgba(255,255,255,0.07);
  --bde: rgba(255,255,255,0.14);
  --tx: #F5EFE5;
  --txm: #B5AFA2;
  --txd: #756F62;
  --green: #B7E778;
  --green-sf: rgba(183,231,120,0.12);
  --green-deep: #B7E778;
  --amber: #F4A261;
  --amber-sf: rgba(244,162,97,0.12);
  --amber-deep: #F4A261;
  --teal: #A8E6F0;
  --teal-sf: rgba(168,230,240,0.12);
  --teal-deep: #A8E6F0;
  --card-shadow: none;
  --sky: #1E1A14;
  --sky-horizon: #14110D;
  --sky-grass: #14110D;
  /* ── tile color tokens ── */
  --ti-amber-bg: #F59E0B;
  --ti-amber-sh: none;
  --ti-amber-i-bg: rgba(245,158,11,0.15);
  --ti-amber-i-sh: none;
  --ti-green-bg: #22C55E;
  --ti-green-sh: none;
  --ti-green-i-bg: rgba(34,197,94,0.15);
  --ti-green-i-sh: none;
  --ti-teal-bg: #22D3EE;
  --ti-teal-sh: none;
  --ti-teal-i-bg: rgba(34,211,238,0.15);
  --ti-teal-i-sh: none;
  --ti-sage-bg: #22C55E;
  --ti-sage-sh: none;
  --ti-sage-i-bg: rgba(34,197,94,0.15);
  --ti-sage-i-sh: none;
  --ti-purple-bg: #A78BFA;
  --ti-purple-sh: none;
  --ti-purple-i-bg: rgba(167,139,250,0.15);
  --ti-purple-i-sh: none;
  --ti-pink-bg: #F472B6;
  --ti-pink-sh: none;
  --ti-pink-i-bg: rgba(244,114,182,0.15);
  --ti-pink-i-sh: none;
  --ti-name: #F5EFE5;
  --ti-meta: #B5AFA2;
  --ti-amber-meta: #B5AFA2;
  --ti-green-meta: #B5AFA2;
  --ti-teal-meta: #B5AFA2;
  --ti-sage-meta: #B5AFA2;
  --ti-purple-meta: #B5AFA2;
  --ti-pink-meta: #B5AFA2;
  --ti-icon-idle: #756F62;
  --ti-icon-done: #22C55E;
  --ti-check-done: #22C55E;
  --ti-stepper-bg: rgba(255,255,255,0.08);
  --ti-stepper-col: #B5AFA2;
}

#nomad-routine * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }

/* Dark mode main app background */
#nomad-routine.dark .app {
  background: #14110D !important;
}

#nomad-routine .app {
  max-width: 430px;
  margin: 0 auto;
  min-height: 100vh;
  background: var(--bg);
  position: relative;
  display: flex;
  flex-direction: column;
  padding-bottom: 76px;
}

#nomad-routine .screen {
  flex: 1;
  overflow-y: auto;
  scrollbar-width: none;
}
#nomad-routine .screen::-webkit-scrollbar { display: none; }

/* ---- Sky header per-screen color themes (DARK MODE) ---- */
#nomad-routine.dark .sky-skin     { --sky: #1E1A14 !important; --sky-horizon:#14110D !important; --sky-grass:#14110D !important; }
#nomad-routine.dark .sky-log      { --sky: #1E1A14 !important; --sky-horizon:#14110D !important; --sky-grass:#14110D !important; }
#nomad-routine.dark .sky-settings { --sky: #1E1A14 !important; --sky-horizon:#14110D !important; --sky-grass:#14110D !important; }


/* ---- Sky header ---- */
#nomad-routine .sky-header {
  background: var(--sky);
  padding: 20px 18px 18px;
  position: relative;
  overflow: hidden;
  border-bottom: 1px solid var(--bd);
}
/* Hide cloud decorations in dark mode */
#nomad-routine.dark .sky-cloud { display: none !important; }
#nomad-routine .sky-cloud {
  position: absolute;
  border-radius: 100px;
  background: rgba(255,255,255,0.5);
}
#nomad-routine .sky-horizon {
  position: absolute;
  bottom: 0; left: 0; right: 0;
  height: 0;
  background: var(--sky-horizon);
}
#nomad-routine.dark .sky-horizon { display: none; }
#nomad-routine .sky-grass {
  position: absolute;
  bottom: 0; left: 0; right: 0;
  height: 0;
  background: var(--sky-grass);
}
#nomad-routine.dark .sky-grass { display: none; }
#nomad-routine .sky-content { position: relative; z-index: 2; }
#nomad-routine .sky-top-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 16px;
}
#nomad-routine .sky-date-big {
  font-size: 24px;
  font-weight: 700;
  color: #2a3a28;
  letter-spacing: -0.02em;
  line-height: 1;
  margin-bottom: 3px;
}
#nomad-routine.dark .sky-date-big { color: #F5EFE5; }
#nomad-routine .sky-date-sub {
  font-size: 12px;
  font-weight: 600;
  color: #5a7050;
  letter-spacing: 0.01em;
}
#nomad-routine.dark .sky-date-sub { color: #B5AFA2; }
#nomad-routine .sky-progress-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
#nomad-routine .sky-prog-track {
  flex: 1;
  height: 5px;
  background: rgba(255,255,255,0.45);
  border-radius: 100px;
  overflow: hidden;
}
#nomad-routine.dark .sky-prog-track { background: rgba(255,255,255,0.08); }
#nomad-routine .sky-prog-fill {
  height: 100%;
  background: #639922;
  border-radius: 100px;
  transition: width 0.4s ease;
}
#nomad-routine.dark .sky-prog-fill { background: var(--green); }
#nomad-routine .sky-prog-txt {
  font-size: 11px;
  font-weight: 700;
  color: #3a5a30;
  white-space: nowrap;
  font-family: var(--mono);
}
#nomad-routine.dark .sky-prog-txt { color: var(--green); }
#nomad-routine .streak-card {
  background: rgba(255,255,255,0.7);
  border-radius: 10px;
  padding: 8px 12px;
  text-align: center;
  border: 1.5px solid rgba(255,255,255,0.9);
  flex-shrink: 0;
}
#nomad-routine.dark .streak-card {
  background: #221E18;
  border: 1px solid rgba(255,255,255,0.07);
}
#nomad-routine .streak-card .s-num {
  font-size: 22px;
  font-weight: 800;
  color: #c8820a;
  letter-spacing: -0.02em;
  line-height: 1;
  font-family: var(--mono);
}
#nomad-routine .streak-card .s-lbl {
  font-size: 9px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: #a09060;
  margin-top: 2px;
}
#nomad-routine .streak-on-fire { box-shadow: 0 0 0 2px rgba(239,159,39,0.35), 0 4px 16px rgba(239,159,39,0.18) !important; animation: streakPulse 3s ease-in-out infinite; }
@keyframes streakPulse { 0%,100% { box-shadow: 0 0 0 2px rgba(239,159,39,0.35),0 4px 16px rgba(239,159,39,0.18); } 50% { box-shadow: 0 0 0 4px rgba(239,159,39,0.5),0 6px 22px rgba(239,159,39,0.3); } }

/* ---- Panda bubble in sky ---- */
#nomad-routine .sky-panda-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
#nomad-routine .sky-panda-av {
  width: 44px; height: 44px;
  border-radius: 50%;
  background: rgba(255,255,255,0.6);
  border: 2px solid rgba(255,255,255,0.9);
  display: flex; align-items: center; justify-content: center;
  font-size: 24px;
  flex-shrink: 0;
  overflow: hidden;
}
#nomad-routine .sky-panda-av img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; }
#nomad-routine .sky-panda-bubble {
  background: rgba(255,255,255,0.82);
  border: 1.5px solid rgba(255,255,255,0.95);
  border-radius: 16px 16px 16px 4px;
  padding: 10px 13px;
  font-size: 13px;
  color: #3a3830;
  line-height: 1.5;
  flex: 1;
}
#nomad-routine .sky-settings .sky-date-big { color: #2e2b26; }
#nomad-routine .sky-settings .sky-date-sub { color: #7a7268; }

/* ---- Body padding ---- */
#nomad-routine .body-pad {
  padding: 18px 18px 0;
}

/* ---- Section label ---- */
#nomad-routine .sec-lbl {
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #c5c0b8;
  margin: 18px 0 10px 2px;
}

/* ---- Habit grid ---- */
#nomad-routine .habit-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
  margin-bottom: 10px;
  align-items: stretch;
}

/* ---- Habit tile ---- */
#nomad-routine .hcard {
  border-radius: 24px;
  padding: 16px 15px;
  min-height: 120px;
  display: flex;
  flex-direction: column;
  cursor: pointer;
  transition: transform 0.15s;
  position: relative;
  border: 1.5px solid transparent;
}
#nomad-routine .hcard:active { transform: scale(0.97); }
#nomad-routine .hcard.hc-idle {
  background: var(--sf);
  border-color: var(--bd);
  box-shadow: var(--card-shadow);
}
#nomad-routine .hcard.hc-amber {
  background: #FFD04D;
  box-shadow: 0 3px 0 #C8960C;
}
#nomad-routine .hcard.hc-green {
  background: #8ED952;
  box-shadow: 0 3px 0 #5CA828;
}
#nomad-routine .hcard.hc-teal {
  background: #3DC9B4;
  box-shadow: 0 3px 0 #1A9888;
}
#nomad-routine .hcard.hc-sage {
  background: #A0CC6A;
  box-shadow: 0 3px 0 #72A038;
}

#nomad-routine .hc-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 8px;
}
#nomad-routine .hc-icon {
  width: 40px; height: 40px;
  border-radius: 13px;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
#nomad-routine .hc-icon.ic-idle { background: #f5f2ee; }
#nomad-routine .hc-icon.ic-done { background: rgba(255,255,255,0.45); }
#nomad-routine .hc-check-idle {
  width: 20px; height: 20px;
  border-radius: 50%;
  border: 2px solid var(--bde);
}
#nomad-routine .hc-check-done {
  width: 20px; height: 20px;
  border-radius: 50%;
  background: rgba(255,255,255,0.6);
  display: flex; align-items: center; justify-content: center;
}
#nomad-routine .hc-body { margin-top: auto; }
#nomad-routine .hc-name {
  font-size: 14px;
  font-weight: 800;
  color: var(--tx);
  letter-spacing: -0.01em;
  line-height: 1.2;
}
#nomad-routine .hcard.hc-amber .hc-name,
#nomad-routine .hcard.hc-green .hc-name,
#nomad-routine .hcard.hc-teal .hc-name,
#nomad-routine .hcard.hc-sage .hc-name { color: rgba(0,0,0,0.62); }
#nomad-routine .hc-meta {
  font-size: 11px;
  font-weight: 600;
  color: var(--txm);
  margin-top: 3px;
}
#nomad-routine .hcard.hc-amber .hc-meta,
#nomad-routine .hcard.hc-green .hc-meta,
#nomad-routine .hcard.hc-teal .hc-meta,
#nomad-routine .hcard.hc-sage .hc-meta { color: rgba(0,0,0,0.32); }

/* ---- Card (shared) ---- */
#nomad-routine .card {
  background: var(--sf);
  border: 1.5px solid var(--bd);
  border-radius: 24px;
  padding: 18px;
  margin-bottom: 10px;
  box-shadow: var(--card-shadow);
}
#nomad-routine .card.done { background: var(--green-sf); border-color: transparent; }
#nomad-routine .card.skin-done { background: var(--teal-sf); border-color: transparent; }
#nomad-routine .card.confirmed { background: var(--bg2); border-color: transparent; }

/* ---- Water card ---- */
#nomad-routine .water-card-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 14px;
}
#nomad-routine .water-card-icon {
  width: 42px; height: 42px;
  border-radius: 14px;
  background: #fff8ee;
  display: flex; align-items: center; justify-content: center;
  margin-bottom: 8px;
}
#nomad-routine .water-card-name {
  font-size: 16px;
  font-weight: 800;
  color: var(--tx);
  letter-spacing: -0.02em;
}
#nomad-routine .water-card-sub {
  font-size: 11px;
  font-weight: 600;
  color: var(--txm);
  margin-top: 2px;
}
#nomad-routine .water-big {
  font-family: var(--mono);
  font-size: 38px;
  font-weight: 800;
  color: var(--amber);
  letter-spacing: -0.03em;
  line-height: 1;
  margin-bottom: 2px;
}
#nomad-routine .water-big .u {
  font-size: 16px;
  color: var(--txm);
  font-weight: 700;
  margin-left: 1px;
}
#nomad-routine .water-target {
  font-size: 11px;
  color: var(--txm);
  font-family: var(--mono);
  letter-spacing: 0.04em;
}

/* ---- Stepper (pill buttons) ---- */
#nomad-routine .stepper { display: flex; align-items: center; gap: 8px; }
#nomad-routine .stepper button {
  width: 38px; height: 38px;
  border-radius: 14px;
  background: var(--bg2);
  border: none;
  color: var(--tx);
  font-size: 22px;
  font-weight: 300;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  font-family: var(--font);
  line-height: 1;
  transition: transform 0.12s;
}
#nomad-routine .stepper button:active { transform: scale(0.92); }
#nomad-routine .stepper button:disabled { opacity: 0.35; pointer-events: none; }
#nomad-routine .stepper .val {
  font-family: var(--mono);
  font-size: 22px;
  font-weight: 700;
  min-width: 28px;
  text-align: center;
  color: var(--tx);
}

/* ---- Water track ---- */
#nomad-routine .track {
  display: flex;
  justify-content: space-between;
  margin: 14px 0 8px;
  gap: 5px;
}
#nomad-routine .track-pt {
  flex: 1;
  text-align: center;
  padding: 7px 0;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--txd);
  cursor: pointer;
  border-radius: 100px;
  height: 8px;
  background: var(--bg2);
  transition: all 0.15s;
  display: flex; align-items: center; justify-content: center;
  font-size: 0;
}
#nomad-routine .track-pt.on { background: var(--amber); }
#nomad-routine .track-pt.soft { background: var(--amber-sf); }
#nomad-routine .prog {
  height: 7px;
  background: var(--bg2);
  border-radius: 100px;
  overflow: hidden;
  margin-top: 4px;
}
#nomad-routine .prog-fill {
  height: 100%;
  background: var(--amber);
  border-radius: 100px;
  transition: width 0.3s ease;
}
#nomad-routine .prog-fill.teal { background: var(--teal); }
#nomad-routine .prog-fill.green { background: var(--green); }

/* ---- Morning water row ---- */
#nomad-routine .mw-row {
  display: flex; align-items: center; gap: 12px;
  padding: 4px 2px;
}
#nomad-routine .mw-row .txt { flex: 1; font-size: 15px; font-weight: 600; }
#nomad-routine .mw-input {
  background: var(--bg2);
  border: 1px solid var(--bd);
  border-radius: var(--rsm);
  padding: 6px 10px;
  font-family: var(--mono);
  font-size: 13px;
  color: var(--tx);
  width: 70px;
  outline: none;
}

/* ---- Checkbox ---- */
#nomad-routine .check {
  width: 22px; height: 22px;
  border-radius: 8px;
  border: 2px solid var(--bde);
  background: var(--bg2);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.15s;
}
#nomad-routine .check.on {
  background: var(--green);
  border-color: var(--green);
  animation: checkPop 0.25s ease;
}
#nomad-routine .check.on.teal { background: var(--teal); border-color: var(--teal); }
#nomad-routine .check svg { stroke: #fff; stroke-width: 3; fill: none; }
@keyframes checkPop {
  0% { transform: scale(0.8); }
  60% { transform: scale(1.12); }
  100% { transform: scale(1); }
}

/* ---- Pills / chips ---- */
#nomad-routine .pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border-radius: var(--rpill);
  background: var(--bg2);
  border: 1.5px solid var(--bd);
  font-size: 13px;
  color: var(--tx);
  cursor: pointer;
  font-family: var(--font);
  font-weight: 600;
  transition: all 0.15s;
}
#nomad-routine .pill:active { transform: scale(0.96); }
#nomad-routine .pill.on { background: var(--amber-sf); border-color: var(--amber); color: var(--amber-deep); font-weight: 700; }
#nomad-routine .pill.on.teal { background: var(--teal-sf); border-color: var(--teal); color: var(--teal-deep); }
#nomad-routine .pill.on.green { background: var(--green-sf); border-color: var(--green); color: var(--green-deep); }
#nomad-routine .pills { display: flex; flex-wrap: wrap; gap: 6px; }

#nomad-routine .chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: var(--rpill);
  background: #f8f5f0;
  border: 1px solid var(--bd);
  font-size: 12px;
  color: var(--txm);
  font-weight: 600;
  animation: chipIn 0.25s ease;
}
#nomad-routine .chip button {
  background: none; border: none; padding: 0;
  color: var(--txm);
  cursor: pointer; font-size: 14px;
  line-height: 1;
}
@keyframes chipIn {
  from { opacity: 0; transform: translateY(4px) scale(0.9); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

/* ---- Log card (food log section) ---- */
#nomad-routine .log-card-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
#nomad-routine .log-card-icon {
  width: 42px; height: 42px;
  border-radius: 14px;
  background: #edf7e0;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
#nomad-routine .log-card-num {
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: #c5c0b8;
}
#nomad-routine .log-card-name {
  font-size: 16px;
  font-weight: 800;
  color: var(--tx);
  letter-spacing: -0.02em;
}
#nomad-routine .log-card-add {
  margin-left: auto;
  font-size: 12px;
  font-weight: 800;
  color: var(--green-deep);
  background: #edf7e0;
  border-radius: 100px;
  padding: 5px 13px;
  cursor: pointer;
  border: none;
  font-family: var(--font);
  letter-spacing: 0.02em;
}

/* ---- Food chip entry ---- */
#nomad-routine .food-chip {
  background: #f8f5f0;
  border-radius: 12px;
  padding: 7px 11px;
  display: inline-flex;
  flex-direction: column;
  gap: 2px;
  max-width: 100%;
  min-width: 0;
  word-break: break-word;
  overflow-wrap: anywhere;
}
#nomad-routine .food-chip-tag {
  font-size: 9px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: #c5c0b8;
}
#nomad-routine .food-chip-txt {
  font-size: 12px;
  font-weight: 600;
  color: #4a4640;
}
#nomad-routine .free-list { display: flex; flex-wrap: wrap; gap: 7px; }

/* ---- Inputs ---- */
#nomad-routine .inp {
  width: 100%;
  background: var(--bg2);
  border: 1.5px solid var(--bd);
  border-radius: var(--rsm);
  padding: 10px 12px;
  font-size: 14px;
  color: var(--tx);
  font-family: var(--font);
  outline: none;
  font-weight: 500;
}
#nomad-routine .inp:focus { border-color: var(--bde); }
textarea.inp { resize: none; min-height: 60px; line-height: 1.4; }

/* ---- Buttons ---- */
#nomad-routine .btn {
  width: 100%;
  background: var(--tx);
  color: var(--bg);
  border: none;
  border-radius: 100px;
  padding: 13px;
  font-family: var(--font);
  font-weight: 700;
  font-size: 14px;
  cursor: pointer;
  margin-top: 12px;
  transition: opacity 0.15s;
}
#nomad-routine .btn:active { opacity: 0.85; }
#nomad-routine .btn.teal { background: var(--teal); color: #fff; }
#nomad-routine .btn.green { background: var(--green); color: #fff; }
#nomad-routine .btn.amber { background: var(--amber); color: #fff; }
#nomad-routine .btn.ghost { background: var(--bg2); color: var(--tx); border: 1px solid var(--bd); }
#nomad-routine .btn.danger { background: #c23c3c; color: #fff; }

#nomad-routine .confirm-btn {
  width: 100%;
  background: var(--green);
  border: none;
  border-radius: 100px;
  padding: 12px;
  font-family: var(--font);
  font-size: 13px;
  font-weight: 700;
  color: #fff;
  cursor: pointer;
  margin-top: 12px;
  transition: opacity 0.15s;
}
#nomad-routine .confirm-btn:active { opacity: 0.85; }
#nomad-routine .confirm-btn.teal { background: var(--teal); }

/* ---- Tap card (curd) ---- */
#nomad-routine .tap-card {
  padding: 18px;
  border-radius: 20px;
  background: var(--bg2);
  border: 1.5px solid var(--bd);
  text-align: center;
  cursor: pointer;
  transition: all 0.2s;
  font-weight: 700;
}
#nomad-routine .tap-card.on { background: var(--green-sf); border-color: var(--green); color: var(--green-deep); }
#nomad-routine .tap-card.teal.on { background: var(--teal-sf); border-color: var(--teal); color: var(--teal-deep); }
#nomad-routine .tap-card:active { transform: scale(0.98); }

/* ---- Label ---- */
#nomad-routine .label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--txd);
  font-weight: 800;
  margin-bottom: 10px;
}
#nomad-routine .row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

/* ---- Skin header ---- */
#nomad-routine .skin-hd {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 14px;
  padding: 0 2px;
}
#nomad-routine .phase-badge {
  background: var(--teal-sf);
  color: var(--teal-deep);
  border-radius: var(--rpill);
  padding: 5px 12px;
  font-size: 11px;
  font-weight: 700;
  border: 1.5px solid var(--teal);
}

/* ---- Collapsible ---- */
#nomad-routine .coll-hd {
  display: flex; justify-content: space-between; align-items: center;
  cursor: pointer;
}
#nomad-routine .coll-hd .t { font-weight: 700; font-size: 15px; }
#nomad-routine .coll-hd .t .ct { color: var(--txm); font-size: 12px; font-weight: 500; margin-left: 6px; }
#nomad-routine .chev { transition: transform 0.2s; color: var(--txm); }
#nomad-routine .chev.open { transform: rotate(90deg); }
#nomad-routine .steps { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--bd); }
#nomad-routine .step { display: flex; align-items: flex-start; gap: 12px; padding: 10px 0; }
#nomad-routine .step .info { flex: 1; }
#nomad-routine .step .info .name { font-size: 14px; font-weight: 600; }
#nomad-routine .step .info .kind { font-size: 11px; color: var(--txm); margin-top: 2px; text-transform: uppercase; letter-spacing: 0.04em; }

/* ---- Saved link ---- */
#nomad-routine .saved-link {
  display: block;
  text-align: center;
  font-size: 12px;
  color: var(--txm);
  margin-top: 10px;
  cursor: pointer;
  font-weight: 600;
}

/* ---- Nav ---- */
#nomad-routine .nav {
  position: fixed;
  bottom: 0; left: 50%;
  transform: translateX(-50%);
  width: 100%; max-width: 430px;
  background: #f8f6f2;
  border-top: 1.5px solid var(--bd);
  display: flex;
  padding: 10px 0 20px;
  z-index: 100;
}
#nomad-routine .nav button {
  flex: 1;
  background: none; border: none;
  padding: 6px 0;
  cursor: pointer;
  display: flex; flex-direction: column; align-items: center;
  gap: 4px;
  color: var(--txd);
  font-family: var(--font);
  font-size: 10px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.07em;
}
#nomad-routine .nav button svg { width: 22px; height: 22px; stroke: currentColor; fill: none; stroke-width: 1.8; }
#nomad-routine .nav button.active.food { color: var(--green); }
#nomad-routine .nav button.active.skin { color: var(--teal); }
#nomad-routine .nav button.active.log { color: var(--green); }
#nomad-routine .nav button.active.settings { color: var(--tx); }
#nomad-routine .nav button:active { transform: scale(0.94); }

/* ---- Stats (Log screen) ---- */
#nomad-routine .stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-bottom: 14px;
}
#nomad-routine .stat {
  background: var(--sf);
  border-radius: 20px;
  padding: 16px;
  box-shadow: var(--card-shadow);
}
#nomad-routine .stat .v { font-size: 26px; font-weight: 800; color: var(--green); font-family: var(--mono); letter-spacing: -0.02em; }
#nomad-routine .stat .l { font-size: 11px; font-weight: 600; color: var(--txm); margin-top: 2px; text-transform: uppercase; letter-spacing: 0.06em; }
#nomad-routine .stat.teal .v { color: var(--teal); }
#nomad-routine .stat.amber .v { color: var(--amber); }

/* ---- Calendar ---- */
#nomad-routine .cal-hd {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 14px;
}
#nomad-routine .cal-hd .m { font-size: 15px; font-weight: 800; color: var(--tx); letter-spacing: -0.01em; }
#nomad-routine .cal-hd button {
  background: var(--bg2); border: none;
  width: 32px; height: 32px; border-radius: 10px;
  font-size: 18px; cursor: pointer; color: var(--tx);
  display: flex; align-items: center; justify-content: center;
}
#nomad-routine .cal { display: grid; grid-template-columns: repeat(7,1fr); gap: 4px; }
#nomad-routine .cal-day-lbl {
  text-align: center; font-size: 10px; font-weight: 800;
  color: var(--txd); padding: 4px 0; letter-spacing: 0.06em;
  text-transform: uppercase;
}
#nomad-routine .cal-cell {
  aspect-ratio: 1;
  border-radius: 10px;
  background: var(--bg2);
  border: 1.5px solid transparent;
  display: flex; align-items: center; justify-content: center;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--txd);
  cursor: pointer;
  font-weight: 600;
}
#nomad-routine .cal-cell.empty { visibility: hidden; }
#nomad-routine .cal-cell.lvl1 { background: var(--amber-sf); color: var(--amber-deep); }
#nomad-routine .cal-cell.lvl2 { background: #fad99a; color: var(--amber-deep); }
#nomad-routine .cal-cell.lvl3 { background: var(--green-sf); color: var(--green-deep); }
#nomad-routine .cal-cell.lvl4 { background: var(--green); color: #fff; }
#nomad-routine .cal-cell.today { border-color: var(--tx); }
#nomad-routine .cal-cell .note-dot { background: #3a4a30 !important; }

/* ---- Sheet ---- */
#nomad-routine .sheet {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.45);
  z-index: 150;
  display: flex; align-items: flex-end;
  animation: fadeIn 0.2s ease;
}
#nomad-routine .sheet-body {
  width: 100%; max-width: 430px;
  margin: 0 auto;
  background: var(--bg);
  border-radius: 28px 28px 0 0;
  padding: 22px 20px 26px;
  max-height: 85vh;
  overflow-y: auto;
  animation: slideUp 0.28s ease;
}
#nomad-routine .sheet-body::-webkit-scrollbar { display: none; }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
#nomad-routine .sheet-hd {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 16px;
}
#nomad-routine .sheet-hd h2 { margin: 0; font-size: 18px; font-weight: 800; color: var(--tx); }
#nomad-routine .sheet-hd button {
  background: var(--bg2); border: none; width: 30px; height: 30px;
  border-radius: 10px; cursor: pointer; font-size: 16px; color: var(--tx);
}
#nomad-routine .sum-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
#nomad-routine .sum-chip {
  padding: 5px 10px; border-radius: var(--rpill);
  background: var(--sf); border: 1px solid var(--bd);
  font-size: 11px; color: var(--tx);
}
#nomad-routine .detail-section { margin-bottom: 16px; }
#nomad-routine .detail-section-lbl {
  font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em;
  font-weight: 800; color: var(--txd); margin-bottom: 8px;
  padding-bottom: 5px; border-bottom: 1px solid var(--bd);
}
#nomad-routine .detail-row {
  display: flex; justify-content: space-between; align-items: flex-start;
  font-size: 12px; padding: 3px 0; color: var(--tx);
}
#nomad-routine .detail-row .dk { color: var(--txm); flex-shrink: 0; margin-right: 10px; }
#nomad-routine .detail-row .dv { text-align: right; color: var(--tx); word-break: break-word; max-width: 65%; }

/* ---- Settings ---- */
#nomad-routine .sec { margin-bottom: 22px; }
#nomad-routine .sec h3 {
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--txm); font-weight: 800; margin: 0 0 10px; padding: 0 4px;
}
#nomad-routine .set-row {
  background: var(--sf); border: 1.5px solid var(--bd);
  border-radius: 20px; padding: 14px 16px; margin-bottom: 8px;
  box-shadow: var(--card-shadow);
}
#nomad-routine .set-row .lbl { font-size: 13px; font-weight: 700; }
#nomad-routine .set-row .desc { font-size: 11px; color: var(--txm); margin-top: 2px; }
#nomad-routine .set-row .r { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
#nomad-routine .toggle {
  width: 42px; height: 24px; background: var(--bg2); border: 1.5px solid var(--bd);
  border-radius: 100px; position: relative; cursor: pointer; transition: all 0.2s; flex-shrink: 0;
}
#nomad-routine .toggle::after {
  content: ''; position: absolute; top: 2px; left: 2px;
  width: 18px; height: 18px; background: #fff; border-radius: 50%;
  transition: transform 0.2s; box-shadow: 0 1px 3px rgba(0,0,0,0.15);
}
#nomad-routine .toggle.on { background: var(--green); border-color: var(--green); }
#nomad-routine .toggle.on::after { transform: translateX(18px); }
#nomad-routine .seg {
  display: flex; background: var(--bg2); border-radius: var(--rsm); padding: 3px; gap: 2px;
}
#nomad-routine .seg button {
  flex: 1; padding: 7px 8px; border: none; background: none;
  border-radius: 10px; font-size: 12px; color: var(--txm);
  cursor: pointer; font-family: var(--font); font-weight: 600;
}
#nomad-routine .seg button.on { background: var(--sf); color: var(--tx); box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
#nomad-routine .routine-day-row { margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid var(--bd); }
#nomad-routine .routine-day-row:last-child { border-bottom: none; margin-bottom: 0; }
#nomad-routine .routine-day-lbl { font-size: 13px; font-weight: 700; color: var(--tx); margin-bottom: 8px; }
#nomad-routine .routine-sub { display: flex; gap: 10px; align-items: flex-start; margin-bottom: 6px; }
#nomad-routine .routine-sub-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--txm); font-weight: 700; min-width: 24px; padding-top: 6px; }
#nomad-routine .routine-chips { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; flex: 1; }
#nomad-routine .routine-chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 9px; border-radius: 100px;
  background: var(--teal-sf); border: 1px solid var(--bd);
  font-size: 11px; color: var(--teal-deep); font-weight: 600;
}
#nomad-routine .routine-chip button { background: none; border: none; padding: 0; color: var(--teal-deep); cursor: pointer; font-size: 13px; }
#nomad-routine .add-step-btn {
  display: inline-flex; align-items: center; padding: 4px 9px;
  border-radius: 100px; background: var(--bg2); border: 1.5px dashed var(--bde);
  font-size: 11px; color: var(--txm); cursor: pointer; font-family: var(--font); font-weight: 600;
}
#nomad-routine .product-picker {
  margin-top: 6px; background: var(--bg); border: 1px solid var(--bd);
  border-radius: 12px; padding: 8px; display: flex; flex-wrap: wrap; gap: 5px; width: 100%;
}
#nomad-routine .product-picker-item {
  padding: 4px 10px; border-radius: 100px; background: var(--bg2);
  border: 1px solid var(--bd); font-size: 11px; color: var(--tx); cursor: pointer; font-weight: 600;
}

/* ---- Toast ---- */
@keyframes toastPill {
  0% { opacity: 0; transform: translateX(-50%) translateY(-10px); }
  15% { opacity: 1; transform: translateX(-50%) translateY(0); }
  80% { opacity: 1; }
  100% { opacity: 0; transform: translateX(-50%) translateY(-4px); }
}

/* ---- Progress dots (kept for skin mode) ---- */
#nomad-routine .prog-dots {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px; background: var(--sf); border: 1.5px solid var(--bd);
  border-radius: 18px; margin-bottom: 14px; box-shadow: var(--card-shadow);
}
#nomad-routine .prog-dot { display: flex; flex-direction: column; align-items: center; gap: 4px; flex: 1; }
#nomad-routine .prog-dot .dot {
  width: 10px; height: 10px; border-radius: 50%; background: var(--bg2); border: 1.5px solid var(--bd); flex-shrink: 0; transition: all 0.2s;
}
#nomad-routine .prog-dot .dot.on { background: var(--green); border-color: var(--green); box-shadow: 0 0 0 3px var(--green-sf); }
#nomad-routine .prog-dot .dot.on.amber { background: var(--amber); border-color: var(--amber); box-shadow: 0 0 0 3px var(--amber-sf); }
#nomad-routine .prog-dot .dot.on.teal { background: var(--teal); border-color: var(--teal); box-shadow: 0 0 0 3px var(--teal-sf); }
#nomad-routine .prog-dot .dot-lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--txd); font-family: var(--mono); white-space: nowrap; }
#nomad-routine .prog-dot .dot-val { font-size: 10px; font-family: var(--mono); color: var(--txm); font-weight: 600; }
#nomad-routine .prog-dot-sep { width: 1px; height: 24px; background: var(--bd); flex-shrink: 0; }

/* ---- Idle tile color families ---- */
#nomad-routine .hcard.hc-amber-idle { background: #FFF4CC; box-shadow: 0 3px 0 #E8D880; }
#nomad-routine .hcard.hc-green-idle { background: #E0F8C0; box-shadow: 0 3px 0 #B0DC80; }
#nomad-routine .hcard.hc-teal-idle  { background: #C4F0EC; box-shadow: 0 3px 0 #88D4CC; }
#nomad-routine .hcard.hc-sage-idle  { background: #D8F4B8; box-shadow: 0 3px 0 #ACCC80; }
#nomad-routine .hcard.hc-purple-idle { background: #EED8FC; box-shadow: 0 3px 0 #C8A0E8; }
#nomad-routine .hcard.hc-pink-idle  { background: #FCD8EC; box-shadow: 0 3px 0 #E8A8CC; }
#nomad-routine .hcard.hc-purple { background: #C070F0; box-shadow: 0 3px 0 #8C30C0; }
#nomad-routine .hcard.hc-pink { background: #F070B8; box-shadow: 0 3px 0 #C03888; }

/* ---- Eggs in-tile stepper ---- */
#nomad-routine .hc-stepper {
  display: flex; gap: 6px; margin-top: 8px;
}
#nomad-routine .hc-stepper button {
  width: 28px; height: 28px; border-radius: 8px; border: none;
  background: rgba(255,255,255,0.55); color: rgba(0,0,0,0.5);
  font-size: 18px; font-weight: 300; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  font-family: var(--font); line-height: 1; transition: opacity 0.12s;
}
#nomad-routine .hcard.hc-idle .hc-stepper button,
#nomad-routine .hcard.hc-green-idle .hc-stepper button { background: var(--bg2); }
#nomad-routine .hc-stepper button:disabled { opacity: 0.25; pointer-events: none; }
#nomad-routine .hc-egg-dots { display: flex; gap: 2px; margin-bottom: 4px; flex-wrap: wrap; }
#nomad-routine .hc-egg-dot { font-size: 18px; opacity: 0.18; transition: opacity 0.15s, transform 0.15s; }
#nomad-routine .hc-egg-dot.filled { opacity: 1; transform: scale(1.08); }
#nomad-routine .hc-stepper button:active { opacity: 0.7; }


/* ---- Detail sheet new design ---- */
#nomad-routine .dl-section { margin-bottom: 18px; }
#nomad-routine .dl-section-hd { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
#nomad-routine .dl-section-icon { font-size: 16px; width: 28px; height: 28px; border-radius: 9px; display: flex; align-items: center; justify-content: center; }
#nomad-routine .dl-food-icon { background: #E0F8C0; }
#nomad-routine .dl-skin-icon { background: #C4F0EC; }
#nomad-routine .dl-section-lbl { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; color: var(--txm); }
#nomad-routine .dl-card { background: var(--bg); border: 1.5px solid var(--bd); border-radius: 18px; overflow: hidden; margin-bottom: 10px; }
#nomad-routine .dl-row { display: flex; justify-content: space-between; align-items: center; padding: 11px 14px; border-bottom: 1px solid var(--bd); }
#nomad-routine .dl-row:last-child { border-bottom: none; }
#nomad-routine .dl-row-left { display: flex; align-items: center; gap: 8px; }
#nomad-routine .dl-emoji { font-size: 15px; }
#nomad-routine .dl-ph-icon { width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
#nomad-routine .dl-key { font-size: 13px; font-weight: 600; color: var(--tx); }
#nomad-routine .dl-val { font-size: 13px; font-weight: 700; color: var(--txm); }
#nomad-routine .dl-val.dl-ok { color: #3a9010; }
#nomad-routine .dl-val.dl-miss { color: var(--txd); }
#nomad-routine .dl-sub-row { padding: 0 14px 10px 38px; font-size: 11px; color: var(--txm); margin-top: -4px; border-bottom: 1px solid var(--bd); }
#nomad-routine .dl-log { background: var(--bg); border: 1.5px solid var(--bd); border-radius: 18px; overflow: hidden; margin-bottom: 10px; }
#nomad-routine .dl-log-group { padding: 10px 14px; border-bottom: 1px solid var(--bd); }
#nomad-routine .dl-log-group:last-child { border-bottom: none; }
#nomad-routine .dl-log-tag { font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; color: var(--txm); margin-bottom: 3px; }
#nomad-routine .dl-log-items { font-size: 13px; color: var(--tx); font-weight: 500; }
#nomad-routine .dl-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
#nomad-routine .dl-chip { padding: 5px 12px; border-radius: 100px; font-size: 11px; font-weight: 700; }
#nomad-routine .dl-chip.amber { background: #FFF4CC; color: #8a6010; border: 1.5px solid #E8D880; }
#nomad-routine .dl-chip.green { background: #E0F8C0; color: #3a7010; border: 1.5px solid #B0DC80; }
#nomad-routine .dl-chip.teal { background: #C4F0EC; color: #0a6058; border: 1.5px solid #88D4CC; }
#nomad-routine .dl-chip.pink { background: #FCD8EC; color: #8a2858; border: 1.5px solid #E8A8CC; }
#nomad-routine .dl-note { font-size: 12px; color: var(--txm); padding: 10px 14px; background: var(--sf); border: 1.5px solid var(--bd); border-radius: 14px; margin-bottom: 10px; line-height: 1.5; }
/* Icon picker */
#nomad-routine .icon-picker-grid { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 0 6px; }
#nomad-routine .icon-picker-btn { width: 36px; height: 36px; border-radius: 10px; border: 1.5px solid var(--bd); background: var(--bg); font-size: 18px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background 0.1s; }
#nomad-routine .icon-picker-btn.sel { background: var(--amber-sf); border-color: var(--amber); }

/* ---- EOD card ---- */
#nomad-routine .eod-card {
  background: var(--tx); color: var(--bg); border-radius: 20px; padding: 14px 16px; margin-bottom: 12px; display: flex; flex-direction: column; gap: 6px;
}
#nomad-routine .eod-card .eod-title { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.55; font-weight: 700; }
#nomad-routine .eod-card .eod-row { display: flex; gap: 14px; flex-wrap: wrap; }
#nomad-routine .eod-card .eod-item { font-size: 13px; font-family: var(--mono); display: flex; align-items: center; gap: 5px; }
#nomad-routine .eod-card .eod-item .eod-ok { opacity: 1; }
#nomad-routine .eod-card .eod-item .eod-miss { opacity: 0.38; }

/* ================================================================
   DARK MODE — all overrides live here at the end to win the cascade
   ================================================================ */

/* Hero / sky header — Soft Pastel Design */
#nomad-routine.dark .sky-header { background: var(--sky) !important; border-bottom: 1px solid rgba(255,255,255,0.08) !important; }
#nomad-routine.dark .sky-cloud  { background: rgba(255,255,255,0.08) !important; }
#nomad-routine.dark .sky-horizon { display: none !important; }
#nomad-routine.dark .sky-grass   { display: none !important; }
#nomad-routine.dark .sky-date-big { color: #F5EFE5 !important; }
#nomad-routine.dark .sky-date-sub { color: #B5AFA2 !important; }
#nomad-routine.dark .sky-content { color: #F5EFE5 !important; }
#nomad-routine.dark .sky-prog-track { background: rgba(255,255,255,0.08) !important; }
#nomad-routine.dark .sky-prog-fill  { background: var(--green) !important; box-shadow: 0 4px 12px rgba(183,231,120,0.20); border-radius: 4px; }
#nomad-routine.dark .sky-prog-txt   { color: var(--green) !important; }
#nomad-routine.dark .streak-card    { background: #221E18 !important; border: 1px solid rgba(255,255,255,0.06) !important; border-radius: 16px !important; box-shadow: 0px 6px 16px rgba(0,0,0,0.25) !important; }
#nomad-routine.dark .streak-card .s-num { color: #F4A261 !important; text-shadow: none; font-weight: 600; }
#nomad-routine.dark .streak-card .s-lbl { color: #B5AFA2 !important; }
#nomad-routine.dark .sky-panda-av   { background: rgba(255,255,255,0.08) !important; border-color: rgba(255,255,255,0.12) !important; border-radius: 12px !important; }
#nomad-routine.dark .sky-panda-av img { opacity: 0.9; }
#nomad-routine.dark .sky-panda-bubble { background: #221E18 !important; border-color: rgba(255,255,255,0.06) !important; color: #F5EFE5 !important; border-radius: 12px !important; box-shadow: 0px 6px 16px rgba(0,0,0,0.25) !important; }
#nomad-routine.dark .sky-settings .sky-date-big { color: #F5EFE5 !important; }
#nomad-routine.dark .sky-settings .sky-date-sub { color: #B5AFA2 !important; }

/* Habit tiles — Soft Pastel Cards */
/* amber/yellow */
#nomad-routine.dark .hcard.hc-amber,
#nomad-routine.dark .hcard.hc-amber-idle {
  background: var(--ti-amber-bg) !important;
  border: none !important;
  border-radius: 18px !important;
  box-shadow: var(--ti-amber-sh) !important;
}
/* lime green */
#nomad-routine.dark .hcard.hc-green,
#nomad-routine.dark .hcard.hc-green-idle {
  background: var(--ti-green-bg) !important;
  border: none !important;
  border-radius: 18px !important;
  box-shadow: var(--ti-green-sh) !important;
}
/* cyan/teal */
#nomad-routine.dark .hcard.hc-teal,
#nomad-routine.dark .hcard.hc-teal-idle {
  background: var(--ti-teal-bg) !important;
  border: none !important;
  border-radius: 18px !important;
  box-shadow: var(--ti-teal-sh) !important;
}
/* sage (lime) */
#nomad-routine.dark .hcard.hc-sage,
#nomad-routine.dark .hcard.hc-sage-idle {
  background: var(--ti-sage-bg) !important;
  border: none !important;
  border-radius: 18px !important;
  box-shadow: var(--ti-sage-sh) !important;
}
/* purple */
#nomad-routine.dark .hcard.hc-purple,
#nomad-routine.dark .hcard.hc-purple-idle {
  background: var(--ti-purple-bg) !important;
  border: none !important;
  border-radius: 18px !important;
  box-shadow: var(--ti-purple-sh) !important;
}
/* pink/coral */
#nomad-routine.dark .hcard.hc-pink,
#nomad-routine.dark .hcard.hc-pink-idle {
  background: var(--ti-pink-bg) !important;
  border: none !important;
  border-radius: 18px !important;
  box-shadow: var(--ti-pink-sh) !important;
}
/* tile name — all variants */
#nomad-routine.dark .hcard[class*="hc-"] .hc-name { color: var(--ti-name) !important; font-weight: 600; }
/* tile meta per color */
#nomad-routine.dark .hcard.hc-amber     .hc-meta,
#nomad-routine.dark .hcard.hc-amber-idle .hc-meta { color: var(--ti-meta) !important; font-size: 0.85em; }
#nomad-routine.dark .hcard.hc-green     .hc-meta,
#nomad-routine.dark .hcard.hc-green-idle .hc-meta { color: var(--ti-meta) !important; font-size: 0.85em; }
#nomad-routine.dark .hcard.hc-teal      .hc-meta,
#nomad-routine.dark .hcard.hc-teal-idle  .hc-meta { color: var(--ti-meta) !important; font-size: 0.85em; }
#nomad-routine.dark .hcard.hc-sage      .hc-meta,
#nomad-routine.dark .hcard.hc-sage-idle  .hc-meta { color: var(--ti-meta) !important; font-size: 0.85em; }
#nomad-routine.dark .hcard.hc-purple    .hc-meta,
#nomad-routine.dark .hcard.hc-purple-idle .hc-meta { color: var(--ti-meta) !important; font-size: 0.85em; }
#nomad-routine.dark .hcard.hc-pink      .hc-meta,
#nomad-routine.dark .hcard.hc-pink-idle  .hc-meta { color: var(--ti-meta) !important; font-size: 0.85em; }
/* tile icons / checks */
#nomad-routine.dark .hc-icon.ic-idle { background: var(--ti-icon-idle) !important; border-radius: 10px !important; }
#nomad-routine.dark .hc-icon.ic-done { background: var(--ti-icon-done) !important; border-radius: 10px !important; }
#nomad-routine.dark .hc-check-idle   { border-color: rgba(255,255,255,0.20) !important; }
#nomad-routine.dark .hcard .hc-stepper button { background: var(--ti-stepper-bg) !important; color: var(--ti-stepper-col) !important; box-shadow: none; border-radius: 8px; }

/* Idle hcard (eggs counter, etc) */
#nomad-routine.dark .hcard.hc-idle { background: #221E18 !important; box-shadow: 0px 6px 16px rgba(0,0,0,0.20) !important; border: none !important; border-radius: 18px !important; }

/* .card (shared card shell) */
#nomad-routine.dark .card         { background: #221E18 !important; border: 1px solid rgba(255,255,255,0.06) !important; box-shadow: 0px 6px 16px rgba(0,0,0,0.20) !important; border-radius: 14px !important; }
#nomad-routine.dark .card.done    { background: rgba(183,231,120,0.12) !important; border-color: rgba(183,231,120,0.20) !important; box-shadow: 0px 6px 16px rgba(0,0,0,0.20) !important; }
#nomad-routine.dark .card.skin-done { background: rgba(168,230,240,0.12) !important; border-color: rgba(168,230,240,0.20) !important; box-shadow: 0px 6px 16px rgba(0,0,0,0.20) !important; }
#nomad-routine.dark .card.confirmed { background: #2A2620 !important; border-color: rgba(255,255,255,0.06) !important; }

/* Water card */
#nomad-routine.dark .water-card-icon { background: rgba(244,162,97,0.15) !important; border-radius: 10px !important; }

/* Track / progress */
#nomad-routine.dark .track-pt.on   { background: var(--amber) !important; box-shadow: 0px 4px 8px rgba(244,162,97,0.25); border-radius: 3px; }
#nomad-routine.dark .track-pt.soft { background: rgba(244,162,97,0.20) !important; }
#nomad-routine.dark .prog-fill     { box-shadow: none; }

/* Pills */
#nomad-routine.dark .pill.on       { background: rgba(244,162,97,0.08) !important; border-color: rgba(244,162,97,0.15) !important; color: rgba(244,162,97,0.7) !important; border-radius: 10px; }
#nomad-routine.dark .pill.on.teal  { background: rgba(168,230,240,0.08) !important; border-color: rgba(168,230,240,0.15) !important; color: rgba(168,230,240,0.7) !important; border-radius: 10px; }
#nomad-routine.dark .pill.on.green { background: rgba(183,231,120,0.08) !important; border-color: rgba(183,231,120,0.15) !important; color: rgba(183,231,120,0.7) !important; border-radius: 10px; }

/* Phase badge */
#nomad-routine.dark .phase-badge { background: rgba(168,230,240,0.08) !important; color: rgba(168,230,240,0.7) !important; border-color: rgba(168,230,240,0.15) !important; border-radius: 8px; }

/* Tap card */
#nomad-routine.dark .tap-card.on           { background: rgba(183,231,120,0.08) !important; border-color: rgba(183,231,120,0.15) !important; color: rgba(183,231,120,0.7) !important; border-radius: 10px; }
#nomad-routine.dark .tap-card.teal.on      { background: rgba(168,230,240,0.08) !important; border-color: rgba(168,230,240,0.15) !important; color: rgba(168,230,240,0.7) !important; border-radius: 10px; }

/* Check glow */
#nomad-routine.dark .check.on { box-shadow: none; }

/* Confirm button glow */
#nomad-routine.dark .confirm-btn       { box-shadow: 0px 6px 16px rgba(0,0,0,0.20); background: #8ED952; color: #1C1814; border-radius: 10px; }
#nomad-routine.dark .confirm-btn.teal  { box-shadow: 0px 6px 16px rgba(0,0,0,0.20); background: #5DD4D4; color: #1C1814; border-radius: 10px; }

/* Main buttons in dark mode */
#nomad-routine.dark .btn.teal  { background: #5DD4D4 !important; color: #1C1814 !important; }
#nomad-routine.dark .btn.green { background: #8ED952 !important; color: #1C1814 !important; }
#nomad-routine.dark .btn.amber { background: #D4A574 !important; color: #1C1814 !important; }

/* Log card */
#nomad-routine.dark .log-card-icon { background: rgba(183,231,120,0.15) !important; border-radius: 10px; }
#nomad-routine.dark .log-card-num  { color: #756F62 !important; }
#nomad-routine.dark .log-card-name { color: #F5EFE5 !important; }
#nomad-routine.dark .log-card-add  { background: rgba(183,231,120,0.15) !important; color: #B7E778 !important; border-radius: 8px; }

/* Stats (Log screen) */
#nomad-routine.dark .stat { background: #2A2620 !important; border: 1px solid rgba(255,255,255,0.06) !important; box-shadow: 0px 6px 16px rgba(0,0,0,0.20) !important; }
#nomad-routine.dark .stat .v { color: #B7E778 !important; }
#nomad-routine.dark .stat .l { color: #B5AFA2 !important; }
#nomad-routine.dark .stat.teal .v { color: #A8E6F0 !important; }
#nomad-routine.dark .stat.amber .v { color: #F4A261 !important; }

/* Chips / food chips */
#nomad-routine.dark .food-chip      { background: #221E18 !important; border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; }
#nomad-routine.dark .food-chip-txt  { color: #F5EFE5 !important; }
#nomad-routine.dark .food-chip-tag  { color: #B5AFA2 !important; }
#nomad-routine.dark .chip           { background: #221E18 !important; border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; }

/* DL detail chips */
#nomad-routine.dark .dl-chip.amber { background: rgba(244,162,97,0.14) !important; color: #FFD7B3 !important; border-color: rgba(244,162,97,0.28) !important; border-radius: 8px; }
#nomad-routine.dark .dl-chip.green { background: rgba(183,231,120,0.14) !important; color: #D9F7B8 !important; border-color: rgba(183,231,120,0.28) !important; border-radius: 8px; }
#nomad-routine.dark .dl-chip.teal  { background: rgba(168,230,240,0.14) !important; color: #D4F8FF !important; border-color: rgba(168,230,240,0.28) !important; border-radius: 8px; }
#nomad-routine.dark .dl-chip.pink  { background: rgba(240,140,178,0.14) !important; color: #FFD2E6 !important; border-color: rgba(240,140,178,0.28) !important; border-radius: 8px; }
#nomad-routine.dark .dl-val.dl-ok  { color: var(--green) !important; }
#nomad-routine.dark .dl-food-icon  { background: rgba(183,231,120,0.15) !important; border-radius: 8px; }
#nomad-routine.dark .dl-skin-icon  { background: rgba(168,230,240,0.15) !important; border-radius: 8px; }

/* DL cards and log entries */
#nomad-routine.dark .dl-section-icon { background: rgba(126,232,166,0.15) !important; }
#nomad-routine.dark .dl-section-lbl { color: #B5AFA2 !important; }
#nomad-routine.dark .dl-card { background: #221E18 !important; border: 1px solid rgba(255,255,255,0.08) !important; }
#nomad-routine.dark .dl-row { border-bottom-color: rgba(255,255,255,0.06) !important; }
#nomad-routine.dark .dl-key { color: #F5EFE5 !important; }
#nomad-routine.dark .dl-val { color: #B5AFA2 !important; }
#nomad-routine.dark .dl-val.dl-ok { color: #7EE8A6 !important; }
#nomad-routine.dark .dl-val.dl-miss { color: #756F62 !important; }
#nomad-routine.dark .dl-sub-row { color: #756F62 !important; font-size: 11px; margin-top: 2px; }
#nomad-routine.dark .dl-food-icon { background: rgba(183,231,120,0.15) !important; }
#nomad-routine.dark .dl-skin-icon { background: rgba(93,223,219,0.15) !important; }
#nomad-routine.dark .dl-note { background: #2A2620 !important; border-color: rgba(255,255,255,0.08) !important; color: #E8DFCF !important; }
#nomad-routine.dark .dl-log-tag { color: #756F62 !important; }
#nomad-routine.dark .dl-log-items { color: #F5EFE5 !important; }

/* Eggs card in dark mode */
#nomad-routine.dark .card[style*="F6E7C8"],
#nomad-routine.dark .card[style*="FFFFFF"] { 
  background: #221E18 !important; 
  box-shadow: 0px 6px 16px rgba(0,0,0,0.20) !important;
}

/* Calendar cells in dark mode */
#nomad-routine.dark .cal-cell { background: #2A2620 !important; color: #B5AFA2 !important; }
#nomad-routine.dark .cal-cell.lvl1 { background: rgba(246,211,101,0.25) !important; color: #F6D365 !important; }
#nomad-routine.dark .cal-cell.lvl2 { background: rgba(246,211,101,0.40) !important; color: #F6D365 !important; }
#nomad-routine.dark .cal-cell.lvl3 { background: rgba(183,231,120,0.25) !important; color: #B7E778 !important; }
#nomad-routine.dark .cal-cell.lvl4 { background: #B7E778 !important; color: #1C1814 !important; }
#nomad-routine.dark .cal-cell.today { border-color: #F5EFE5 !important; }
#nomad-routine.dark .cal-cell .note-dot { background: #F5EFE5 !important; opacity: 0.9 !important; }

/* Icon picker */
#nomad-routine.dark .icon-picker-btn { background: #221E18 !important; border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; }
#nomad-routine.dark .icon-picker-btn.sel { background: rgba(244,162,97,0.15) !important; border-color: #F4A261 !important; box-shadow: none; }

/* Section label */
#nomad-routine.dark .sec-lbl { color: #756F62 !important; }

/* Settings screen */
#nomad-routine.dark .lbl { color: #F5EFE5 !important; }
#nomad-routine.dark .desc { color: #B5AFA2 !important; }
#nomad-routine.dark .stepper { background: #2A2620 !important; border: 1px solid rgba(255,255,255,0.08) !important; border-radius: 10px; }
#nomad-routine.dark .stepper .val { color: #F5EFE5 !important; }
#nomad-routine.dark .stepper button { background: rgba(255,255,255,0.05) !important; color: #F5EFE5 !important; border-color: rgba(255,255,255,0.08) !important; }
#nomad-routine.dark .routine-day-lbl { color: #F5EFE5 !important; }
#nomad-routine.dark .routine-sub-label { color: #B5AFA2 !important; }
#nomad-routine.dark .routine-chip { background: #2A2620 !important; border-color: rgba(255,255,255,0.08) !important; color: #F5EFE5 !important; }
#nomad-routine.dark .add-step-btn { background: #2A2620 !important; border-color: rgba(255,255,255,0.08) !important; color: #B5AFA2 !important; }
#nomad-routine.dark .product-picker { background: #2A2620 !important; border: 1px solid rgba(255,255,255,0.08) !important; }
#nomad-routine.dark .product-picker-item { background: #221E18 !important; color: #F5EFE5 !important; border-bottom-color: rgba(255,255,255,0.06) !important; }
#nomad-routine.dark .product-picker-item:hover { background: #2A2620 !important; }

/* Nav bar */
#nomad-routine.dark .nav { background: #14110D !important; border-top: 1px solid rgba(255,255,255,0.08) !important; border-radius: 0; }
#nomad-routine.dark .nav button.active.food { color: var(--green) !important; }
#nomad-routine.dark .nav button.active.skin { color: var(--teal) !important; }
#nomad-routine.dark .nav button.active.log  { color: var(--green) !important; }

/* Input */
#nomad-routine.dark .inp { background: #2A2620 !important; border-color: rgba(255,255,255,0.08) !important; color: #F5EFE5 !important; }
#nomad-routine.dark .inp:focus { border-color: rgba(168,230,240,0.35) !important; box-shadow: 0 0 0 2px rgba(168,230,240,0.10); border-radius: 10px; }
#nomad-routine.dark .inp::placeholder { color: #756F62 !important; }

/* Pills */
#nomad-routine.dark .pill { background: #2A2620 !important; border-color: rgba(255,255,255,0.08) !important; color: #B5AFA2 !important; }
#nomad-routine.dark .pill.on { background: rgba(183,231,120,0.15) !important; border-color: rgba(183,231,120,0.30) !important; color: #B7E778 !important; }
#nomad-routine.dark .pill.on.teal { background: rgba(168,230,240,0.15) !important; border-color: rgba(168,230,240,0.30) !important; color: #A8E6F0 !important; }
#nomad-routine.dark .pill.on.amber { background: rgba(244,162,97,0.15) !important; border-color: rgba(244,162,97,0.30) !important; color: #F4A261 !important; }
`;

// Inject CSS immediately at module load so styles exist before first paint.
// Prevents the "header empty space" flash where elements render unstyled
// for one frame before useEffect runs.
if (typeof document !== 'undefined') {
    let _s = document.getElementById('form-style');
    if (!_s) { _s = document.createElement('style'); _s.id = 'form-style'; document.head.appendChild(_s); }
    _s.textContent = CSS;
}

/* ---------- helpers ---------- */
const todayKey = (d = new Date()) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
};
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayOfWeek = (d = new Date()) => DOW[d.getDay()];

/* Parse morning water amount string → litres */
const parseMorningWater = (s) => {
    if (!s) return 0;
    const str = String(s).trim().toLowerCase();
    const mlMatch = str.match(/^([\d.]+)\s*ml$/);
    if (mlMatch) return parseFloat(mlMatch[1]) / 1000;
    const lMatch = str.match(/^([\d.]+)\s*l$/);
    if (lMatch) return parseFloat(lMatch[1]);
    const numOnly = parseFloat(str);
    if (!isNaN(numOnly)) {
        if (numOnly <= 5) return numOnly;        // ≤5: assume litres (realistic glass/bottle in L)
        return numOnly / 1000;                    // anything else: treat as ml
    }
    return 0;
};

/* Effective morning water — only counts if checkbox is ON */
const effectiveMorningWater = (day) =>
    day && day.morningWater ? parseMorningWater(day.morningWaterAmount) : 0;

const calcSleepDuration = (sleepTime, wakeTime) => {
    if (!sleepTime || !wakeTime) return null;
    const [sh, sm] = sleepTime.split(':').map(Number);
    const [wh, wm] = wakeTime.split(':').map(Number);
    let mins = (wh * 60 + wm) - (sh * 60 + sm);
    if (mins < 0) mins += 1440;
    return mins / 60;
};
const fmtSleep = (h) => h == null ? '—' : `${Math.floor(h)}h${Math.round((h % 1) * 60) > 0 ? ` ${Math.round((h % 1) * 60)}m` : ''}`;
const compressPhoto = (file, maxPx = 480) => new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
        URL.revokeObjectURL(url);
        if (!img.width || !img.height) { reject(new Error('Zero-dimension image')); return; }
        const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.75));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load image')); };
    img.src = url;
});

/* Migrate freeFoodLog to flat [{text, tag}] format */
const migrateFreeFoodLog = (log) => {
    if (!log) return [];
    // Already new format: array of objects
    if (Array.isArray(log) && (log.length === 0 || typeof log[0] === 'object')) return log;
    // Old format: array of strings
    if (Array.isArray(log)) return log.map(t => ({ text: t, tag: 'other' }));
    // v2 categorized object format
    if (typeof log === 'object') {
        const result = [];
        (log.breakfast || []).forEach(t => result.push({ text: t, tag: 'breakfast' }));
        (log.lunch || []).forEach(t => result.push({ text: t, tag: 'lunch' }));
        (log.dinner || []).forEach(t => result.push({ text: t, tag: 'dinner' }));
        (log.other || []).forEach(t => result.push({ text: t, tag: 'other' }));
        return result;
    }
    return [];
};

const PRODUCT_LABELS = { cleanser: 'Cleanser', niacinamide: 'Niacinamide', sunscreen: 'Sunscreen', bhaSerum: 'BHA Serum', retinol: 'Retinol' };

const DEFAULT_CUSTOM_PRODUCTS = [
    { id: 'cleanser', kind: 'Cleanser', name: 'Barclay Italy SA Face Wash', slot: 'both' },
    { id: 'niacinamide', kind: 'Niacinamide', name: 'Minimalist Niacinamide 10%', slot: 'both' },
    { id: 'sunscreen', kind: 'Sunscreen', name: 'Barclay Italy Mineral SPF 50+', slot: 'am' },
    { id: 'bhaSerum', kind: 'BHA Serum', name: 'Barclay Italy SA Serum', slot: 'pm' },
    { id: 'retinol', kind: 'Retinol', name: 'Minimalist Retinol 0.3%', slot: 'pm' },
];

// Resolve product info by ID — includes archived products so history still shows names
const resolveProduct = (id, customProducts) => {
    const p = (customProducts || []).find(p => p.id === id);
    if (p) return p;
    return { id, kind: PRODUCT_LABELS[id] || id, name: PRODUCT_LABELS[id] || id, slot: 'both' };
};

const DEFAULT_ROUTINES = {
    Mon: { am: ['cleanser', 'niacinamide', 'sunscreen'], pm: ['cleanser', 'retinol'] },
    Tue: { am: ['cleanser', 'niacinamide', 'sunscreen'], pm: ['cleanser', 'niacinamide', 'bhaSerum'] },
    Wed: { am: ['cleanser', 'niacinamide', 'sunscreen'], pm: ['cleanser', 'retinol'] },
    Thu: { am: ['cleanser', 'niacinamide', 'sunscreen'], pm: ['cleanser', 'niacinamide', 'bhaSerum'] },
    Fri: { am: ['cleanser', 'niacinamide', 'sunscreen'], pm: ['cleanser'] },
    Sat: { am: ['cleanser', 'niacinamide', 'sunscreen'], pm: ['cleanser', 'niacinamide', 'bhaSerum'] },
    Sun: { am: ['cleanser', 'niacinamide', 'sunscreen'], pm: ['cleanser', 'retinol'] },
};

const DEFAULT_DAY = {
    morningWater: false,
    morningWaterAmount: '500ml',
    water: 0,
    curd: false,
    dailyChecks: {},
    amSkinDone: false,
    pmSkinDone: false,
    freeFoodLog: [],
    moodChip: '',
    skinFeelChip: '',
    energyChip: '',
    skinTodayChip: '',
    retinolReactionChip: '',
    reactionChip: '',
    notes: '',
    skinNotes: '',
    notesConfirmed: false,
    skinNotesConfirmed: false,
    sleepTime: '',
    wakeTime: '',
    sleepQuality: '',
    skinPhoto: '',
    hairPhoto: '',
};

const DEFAULT_CONFIG = {
    waterTarget: 3.5,
    calGoal: 2000,
    proteinGoal: 80,
    carbsGoal: 250,
    fatGoal: 65,
    darkMode: false,
    showProductNames: true,
    customProducts: DEFAULT_CUSTOM_PRODUCTS,
    routines: DEFAULT_ROUTINES,
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const pickRoutineList = (saved, fallback) => Array.isArray(saved) ? saved : fallback;
const sanitizeConfig = (value) => {
    const c = value || {};

    // Migrate old products object → customProducts array
    let customProducts = c.customProducts;
    if (!Array.isArray(customProducts)) {
        const oldProducts = c.products || {};
        customProducts = DEFAULT_CUSTOM_PRODUCTS.map(def => ({
            ...def,
            name: oldProducts[def.id] || def.name,
        }));
    }

    return {
        ...DEFAULT_CONFIG,
        ...c,
        waterTarget: clamp(Number(c.waterTarget ?? DEFAULT_CONFIG.waterTarget) || DEFAULT_CONFIG.waterTarget, 0.5, 5),
        calGoal: clamp(Number(c.calGoal ?? DEFAULT_CONFIG.calGoal) || DEFAULT_CONFIG.calGoal, 800, 5000),
        proteinGoal: clamp(Number(c.proteinGoal ?? DEFAULT_CONFIG.proteinGoal) || DEFAULT_CONFIG.proteinGoal, 20, 300),
        carbsGoal: clamp(Number(c.carbsGoal ?? DEFAULT_CONFIG.carbsGoal) || DEFAULT_CONFIG.carbsGoal, 50, 600),
        fatGoal: clamp(Number(c.fatGoal ?? DEFAULT_CONFIG.fatGoal) || DEFAULT_CONFIG.fatGoal, 20, 200),
        customProducts,
        routines: Object.fromEntries(
            Object.entries(DEFAULT_ROUTINES).map(([day, def]) => [
                day,
                {
                    am: pickRoutineList(c.routines?.[day]?.am, def.am),
                    pm: pickRoutineList(c.routines?.[day]?.pm, def.pm),
                },
            ])
        ),
    };
};
const sanitizeConfigWithData = (config) => config;

const sanitizeDayRecord = (record) => {
    const merged = { ...DEFAULT_DAY, ...(record || {}), freeFoodLog: migrateFreeFoodLog(record?.freeFoodLog) };
    // NOTE: Do NOT wipe notes/chips when notesConfirmed/skinNotesConfirmed is false.
    // This function runs on EVERY render via day = sanitizeDayRecord(rawDay), so wiping
    // would clobber in-progress edits. Drafts persist in state until the user toggles
    // back to confirmed or until app reload (which is fine — drafts survive within a session).
    // Migrate curd → dailyChecks.curd
    if (merged.curd && !merged.dailyChecks?.curd) {
        merged.dailyChecks = { ...merged.dailyChecks, curd: merged.curd };
    }
    // Migrate retinolReactionChip → reactionChip
    if (!merged.reactionChip && merged.retinolReactionChip) {
        merged.reactionChip = merged.retinolReactionChip;
    }
    return merged;
};
const sanitizeAllData = (data) => Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, sanitizeDayRecord(v)]));

const loadData = () => {
    try { return sanitizeAllData(JSON.parse(localStorage.getItem('form_data') || '{}')); } catch { return {}; }
};

const loadConfig = () => {
    try {
        const c = JSON.parse(localStorage.getItem('form_config') || 'null');
        if (!c) return DEFAULT_CONFIG;
        return sanitizeConfig(c);
    } catch { return DEFAULT_CONFIG; }
};

// Supabase — localStorage credentials take priority over build-time env vars
const _rc = _getCreds();
const SB_URL = _rc.sbUrl || import.meta.env.VITE_SUPABASE_URL || "";
const SB_KEY = _rc.sbKey || import.meta.env.VITE_SUPABASE_ANON_KEY || "";
const SB_ENABLED = Boolean(SB_URL && SB_KEY);
const sbH = SB_ENABLED ? { "Content-Type": "application/json", "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` } : {};
const FETCH_TIMEOUT_MS = 8000;
const sbGetR = async (table, id) => {
    if (!SB_ENABLED) return null;
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        const r = await fetch(`${SB_URL}/rest/v1/${table}?id=eq.${id}&select=*`, { headers: sbH, signal: ctrl.signal });
        clearTimeout(timer);
        if (!r.ok) return null;
        const d = await r.json();
        return d[0] || null;
    } catch { return null }
};
const sbUpsertR = async (table, row, dedupeKey = null) => SB_ENABLED ? sendSupabaseRequest({ path: `${SB_URL}/rest/v1/${table}`, method: "POST", headers: { ...sbH, "Prefer": "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(row), dedupeKey }) : { ok: false, queued: false, offline: false, response: null };
const sbDeleteR = async (table, id) => SB_ENABLED ? sendSupabaseRequest({ path: `${SB_URL}/rest/v1/${table}?id=eq.${id}`, method: "DELETE", headers: sbH, dedupeKey: `${table}:delete:${id}` }) : { ok: false, queued: false, offline: false, response: null };
const sbGetAllDailyLogsR = async () => {
    if (!SB_ENABLED) return [];
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        const r = await fetch(`${SB_URL}/rest/v1/routine_daily_logs?select=*`, { headers: sbH, signal: ctrl.signal });
        clearTimeout(timer);
        if (!r.ok) return [];
        return await r.json();
    } catch { return []; }
};
const sbDeleteAllDailyLogsR = () => SB_ENABLED ? sendSupabaseRequest({ path: `${SB_URL}/rest/v1/routine_daily_logs?log_date=neq.null`, method: "DELETE", headers: sbH, dedupeKey: "routine_daily_logs:delete:all" }) : { ok: false };

const BANNERS_KEY = 'form_banners';
const getBanners = () => { try { return JSON.parse(localStorage.getItem(BANNERS_KEY) || '{}'); } catch { return {}; } };

/* ---------- icons ---------- */
const Icon = ({ name }) => {
    const icons = {
        food: <svg viewBox="0 0 24 24"><path d="M12 3c-4 0-7 3-7 7v1h14v-1c0-4-3-7-7-7zM4 13h16l-1 6a2 2 0 01-2 2H7a2 2 0 01-2-2l-1-6z" /></svg>,
        skin: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /><path d="M9 11c0 1 .5 2 1 2M15 11c0 1-.5 2-1 2M9 16c1 1 5 1 6 0" /></svg>,
        log: <svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="16" rx="2" /><path d="M8 3v4M16 3v4M4 11h16" /></svg>,
        settings: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></svg>,
        check: <svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7" /></svg>,
        chev: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 6l6 6-6 6" /></svg>,
    };
    return icons[name];
};

/* ---------- Panda messages ---------- */
const getPandaFoodMessage = (day, config) => {
    if (!day.morningWater) return "Start with morning water. Before anything else.";
    const mwL = effectiveMorningWater(day);
    const total = mwL + day.water;
    if (total >= config.waterTarget) return "Clean day. That's the standard.";
    if (total >= config.waterTarget * 0.7) return "Water on track. Keep the pattern.";
    return "Ritual in progress.";
};

const getPandaSkinMessage = (day, config) => {
    const dow = dayOfWeek();
    const routine = (config.routines && config.routines[dow]) || { am: [], pm: [] };
    const hasRetinol = routine.pm.includes('retinol');
    const isPmShort = routine.pm.length <= 1;
    if (!day.amSkinDone) return "AM routine first. Face wash → Niacinamide → SPF.";
    if (hasRetinol && !day.pmSkinDone) return "Last step, nothing on top. Let it work.";
    if (isPmShort && !day.pmSkinDone) return "Rest night. Face wash only.";
    if (day.amSkinDone && day.pmSkinDone) return "Skin ritual done. Consistent beats perfect.";
    return "PM routine when ready.";
};

const PANDA_SRC = "data:image/png;base64,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";

const Panda = ({ msg, mode }) => (
    <div className={`mascot ${mode === 'skin' ? 'skin' : ''}`}>
        <div className="av">
            <img src={PANDA_SRC} alt="mascot" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
        </div>
        <div className="msg">{msg}</div>
    </div>
);

const PandaM = ({ message }) => (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, padding: '12px 0' }}>
        <img src={PANDA_SRC} alt="panda" style={{ width: 56, height: 56, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
        <div style={{ background: 'var(--sf)', border: '1px solid var(--bd)', borderRadius: '14px 14px 14px 4px', padding: '10px 14px', fontSize: 13, color: 'var(--tx)', maxWidth: 220, fontFamily: 'var(--font)', lineHeight: 1.5 }}>{message}</div>
    </div>
);

const Check = ({ on, onClick, teal }) => (
    <div className={`check ${on ? 'on' : ''} ${teal ? 'teal' : ''}`} onClick={onClick}>
        {on && <Icon name="check" />}
    </div>
);

/* ---------- Activity ring ---------- */
const ActivityRing = ({ pct, size = 76, strokeWidth = 7, color, trackColor }) => { const r = (size - strokeWidth) / 2; const circ = 2 * Math.PI * r; const offset = circ * (1 - Math.min(pct, 100) / 100); const c = color || (pct >= 100 ? 'var(--green)' : 'var(--amber)'); return (<svg width={size} height={size} style={{ transform: 'rotate(-90deg)', display: 'block' }}><circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={trackColor || 'rgba(255,255,255,0.22)'} strokeWidth={strokeWidth} /><circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={c} strokeWidth={strokeWidth} strokeDasharray={`${circ}`} strokeDashoffset={offset} strokeLinecap="round" style={{ transition: 'stroke-dashoffset 0.7s cubic-bezier(0.4,0,0.2,1)' }} /></svg>); };

/* ---------- Haptic ---------- */
const prefersReducedMotion = () => {
    try { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch { return false; }
};
const haptic = (ms = 8) => {
    try {
        if (prefersReducedMotion()) return;
        const off = localStorage.getItem('form_haptic_off');
        if (off === '1') return;
        navigator.vibrate && navigator.vibrate(ms);
    } catch (_) { }
};

/* ---------- Progress dots ---------- */
const ProgressDots = ({ day, config, mode }) => {
    const mwL = effectiveMorningWater(day);
    const waterTotal = mwL + day.water;
    const waterOk = waterTotal >= config.waterTarget;
    const waterPct = Math.min(100, Math.round((waterTotal / config.waterTarget) * 100));

    if (mode === 'food') return (
        <div className="prog-dots">
            <div className="prog-dot">
                <div className={`dot ${day.morningWater ? 'on amber' : ''}`} />
                <div className="dot-lbl">Morning</div>
                <div className="dot-val">{day.morningWater ? '✓' : '—'}</div>
            </div>
            <div className="prog-dot-sep" />
            <div className="prog-dot">
                <div className={`dot ${waterOk ? 'on amber' : ''}`} />
                <div className="dot-lbl">Water</div>
                <div className="dot-val">{waterPct}%</div>
            </div>
        </div>
    );

    return (
        <div className="prog-dots">
            <div className="prog-dot">
                <div className={`dot ${day.amSkinDone ? 'on teal' : ''}`} />
                <div className="dot-lbl">AM</div>
                <div className="dot-val">{day.amSkinDone ? '✓' : '—'}</div>
            </div>
            <div className="prog-dot-sep" />
            <div className="prog-dot">
                <div className={`dot ${day.pmSkinDone ? 'on teal' : ''}`} />
                <div className="dot-lbl">PM</div>
                <div className="dot-val">{day.pmSkinDone ? '✓' : '—'}</div>
            </div>
            <div className="prog-dot-sep" />
            <div className="prog-dot">
                <div className={`dot ${day.skinTodayChip ? 'on teal' : ''}`} />
                <div className="dot-lbl">Skin</div>
                <div className="dot-val">{day.skinTodayChip || '—'}</div>
            </div>
            <div className="prog-dot-sep" />
            <div className="prog-dot">
                <div className={`dot ${day.skinNotesConfirmed ? 'on teal' : ''}`} />
                <div className="dot-lbl">Notes</div>
                <div className="dot-val">{day.skinNotesConfirmed ? '✓' : '—'}</div>
            </div>
        </div>
    );
};

/* ---------- End of day summary ---------- */
const EodCard = ({ day, config }) => {
    const mwL = effectiveMorningWater(day);
    const waterTotal = (mwL + day.water).toFixed(1);
    const waterOk = (mwL + day.water) >= config.waterTarget;

    return (
        <div className="eod-card">
            <div className="eod-title">Today at a glance</div>
            <div className="eod-row">
                <div className="eod-item">
                    <span className={day.morningWater ? 'eod-ok' : 'eod-miss'}>🌅</span>
                    <span>{day.morningWater ? 'Morning ✓' : 'No morning water'}</span>
                </div>
                <div className="eod-item">
                    <span className={waterOk ? 'eod-ok' : 'eod-miss'}>💧</span>
                    <span>{waterTotal}L</span>
                </div>
            </div>
        </div>
    );
};

/* ============================================================
   FOOD SCREEN
   ============================================================ */
const FoodScreen = ({ day, update, config, onComplete, streak, showToast = () => {} }) => {
    const waterPts = Array.from({ length: Math.round(config.waterTarget / 0.5) }, (_, i) => (i + 1) * 0.5);
    const mwL = effectiveMorningWater(day);
    const foodLog = migrateFreeFoodLog(day.freeFoodLog);

    const prevComplete = useRef(false);
    useEffect(() => {
        const complete = !!day.morningWater;
        if (complete && !prevComplete.current) onComplete('food');
        prevComplete.current = complete;
    }, [day.morningWater]);

    const [logInput, setLogInput] = useState('');
    const [logTag, setLogTag] = useState('breakfast');
    const LOG_TAGS = ['breakfast', 'lunch', 'dinner', 'snack', 'other'];

    // AI photo analysis state
    const [analyzing, setAnalyzing] = useState(false);
    const [aiMacros, setAiMacros] = useState(null); // { calories, protein_g, carbs_g, fat_g, confidence }
    const [pickerOpen, setPickerOpen] = useState(false);
    const cameraInputRef = useRef(null);
    const galleryInputRef = useRef(null);

    const analyzePhoto = async (file) => {
        setAnalyzing(true);
        setAiMacros(null);
        try {
            const result = await analyzeFood(file);
            setLogInput(foodResultToText(result));
            setAiMacros({ calories: result.calories, protein_g: result.protein_g, carbs_g: result.carbs_g, fat_g: result.fat_g, confidence: result.confidence, aiAnalyzed: true });
        } catch (e) {
            showToast(e.message || 'Photo analysis failed — enter manually', 'error');
        } finally {
            setAnalyzing(false);
        }
    };

    const addEntry = () => {
        const t = logInput.trim();
        if (!t) return;
        haptic();
        const entry = aiMacros ? { text: t, tag: logTag, ...aiMacros } : { text: t, tag: logTag };
        update(d => ({ freeFoodLog: [...migrateFreeFoodLog(d.freeFoodLog), entry] }));
        setLogInput('');
        setAiMacros(null);
    };

    const removeEntry = (i) => {
        haptic(4);
        update(d => ({ freeFoodLog: migrateFreeFoodLog(d.freeFoodLog).filter((_, idx) => idx !== i) }));
    };

    const dailyCals = useMemo(() => foodLog.reduce((s, e) => s + (e.calories || 0), 0), [foodLog]);

    const totalWater = mwL + day.water;

    const doneCount = day.morningWater ? 1 : 0;
    const totalCount = 1;
    const pct = doneCount * 100;

    const dow = dayOfWeek();
    const dateLabel = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

    return (
        <div className="screen">
            {/* Sky Header */}
            <div className="sky-header">
                <div className="sky-cloud" style={{ width: 110, height: 34, top: 12, left: -16 }} />
                <div className="sky-cloud" style={{ width: 80, height: 26, top: 6, left: 54 }} />
                <div className="sky-cloud" style={{ width: 130, height: 40, top: 18, right: -24 }} />
                <div className="sky-cloud" style={{ width: 70, height: 22, top: 46, right: 36 }} />
                <div className="sky-cloud" style={{ width: 55, height: 18, top: 50, left: 70 }} />
                <div className="sky-horizon" />
                <div className="sky-grass" />
                <div className="sky-content">
                    <div className="sky-top-row">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <div style={{ position: 'relative', width: 76, height: 76, flexShrink: 0 }}>
                                <ActivityRing pct={pct} size={76} color={pct >= 100 ? 'var(--green)' : '#EF9F27'} trackColor="rgba(255,255,255,0.45)" />
                                <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                                    <span style={{ fontSize: 17, fontWeight: 800, color: 'var(--tx)', lineHeight: 1 }}>{pct}%</span>
                                    <span style={{ fontSize: 9, color: 'var(--txm)', fontWeight: 700, marginTop: 1 }}>{doneCount}/{totalCount}</span>
                                </div>
                            </div>
                            <div>
                                <div className="sky-date-big">{dow}</div>
                                <div className="sky-date-sub">{dateLabel}</div>
                            </div>
                        </div>
                        {streak > 0 && (
                            <div className={`streak-card${streak >= 7 ? ' streak-on-fire' : ''}`}>
                                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 2 }}><IconFlameFilled size={18} color="#EF9F27" /></div>
                                <div className="s-num">{streak}</div>
                                <div className="s-lbl">day{streak !== 1 ? 's' : ''}</div>
                            </div>
                        )}
                    </div>
                    <div className="sky-panda-row" style={{ marginTop: '-8px' }}>
                        <div className="sky-panda-av">
                            <img src={PANDA_SRC} alt="panda" />
                        </div>
                        <div className="sky-panda-bubble">{getPandaFoodMessage(day, config)}</div>
                    </div>
                </div>
            </div>

            {/* Body */}
            <div className="body-pad">

                {/* Morning Water tile — single */}
                <div
                    className={`hcard ${day.morningWater ? 'hc-amber' : 'hc-amber-idle'}`}
                    style={{ marginBottom: 10 }}
                    onClick={() => { haptic(); update(d => ({ morningWater: !d.morningWater })); }}
                >
                    <div className="hc-top">
                        <div className="hc-icon ic-done">
                            <PhosphorIcon name="drop" size={24} color={day.morningWater ? 'rgba(0,0,0,0.5)' : '#c8820a'} opacity={0.35} />
                        </div>
                        {day.morningWater
                            ? <div className="hc-check-done"><svg width="9" height="8" viewBox="0 0 12 10" fill="none"><path d="M1 5l3.5 3.5L11 1" stroke="rgba(0,0,0,0.45)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg></div>
                            : <div className="hc-check-idle" />
                        }
                    </div>
                    <div className="hc-body">
                        <div className="hc-name" style={{ color: day.morningWater ? 'rgba(0,0,0,0.62)' : 'var(--tx)' }}>Morning Water</div>
                        <div className="hc-meta" style={{ color: day.morningWater ? 'rgba(0,0,0,0.32)' : 'var(--txm)' }}>{day.morningWater ? `${day.morningWaterAmount || '500ml'} · done` : 'tap to log'}</div>
                    </div>
                </div>

                {/* Sleep card */}
                <div className="card" style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                        <IconBedFilled size={18} color="#7B8CDE" />
                        <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--txm)' }}>Sleep</span>
                        {calcSleepDuration(day.sleepTime, day.wakeTime) != null && <span style={{ marginLeft: 'auto', fontSize: 13, color: '#7B8CDE', fontWeight: 800, fontFamily: 'var(--mono)' }}>{fmtSleep(calcSleepDuration(day.sleepTime, day.wakeTime))}</span>}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
                        <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 5 }}>
                                <IconMoonFilled size={13} color="#7B8CDE" />
                                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--txm)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Bedtime</span>
                            </div>
                            <input type="time" className="inp" style={{ padding: '7px 10px', fontSize: 15, fontWeight: 700, fontFamily: 'var(--mono)', color: 'var(--tx)' }} value={day.sleepTime || ''} onChange={(e) => update({ sleepTime: e.target.value })} />
                        </div>
                        <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 5 }}>
                                <PhosphorIcon name="sun" size={13} color="#EF9F27" opacity={0.9} />
                                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--txm)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Wake up</span>
                            </div>
                            <input type="time" className="inp" style={{ padding: '7px 10px', fontSize: 15, fontWeight: 700, fontFamily: 'var(--mono)', color: 'var(--tx)' }} value={day.wakeTime || ''} onChange={(e) => update({ wakeTime: e.target.value })} />
                        </div>
                    </div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--txm)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Quality</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
                        {[{ key: 'deep', label: 'Deep', color: '#6BAA75' }, { key: 'okay', label: 'Okay', color: '#7B8CDE' }, { key: 'light', label: 'Light', color: 'var(--amber)' }, { key: 'poor', label: 'Poor', color: '#E07A5F' }].map(({ key, label, color }) => (
                            <div key={key} onClick={() => { haptic(); update(d => ({ sleepQuality: d.sleepQuality === key ? '' : key })); }} style={{ textAlign: 'center', padding: '7px 4px', borderRadius: 10, background: day.sleepQuality === key ? `${color}22` : 'var(--sf)', border: `1.5px solid ${day.sleepQuality === key ? color : 'var(--bd)'}`, cursor: 'pointer', transition: 'all 0.15s' }}>
                                <div style={{ fontSize: 11, fontWeight: 700, color: day.sleepQuality === key ? color : 'var(--txm)' }}>{label}</div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Water total card */}
                <div className="card" style={{ marginBottom: 10 }}>
                    <div className="water-card-row">
                        <div>
                            <div className="water-card-icon">
                                <PhosphorIcon name="bottle" size={24} color="#c8820a" opacity={0.3} />
                            </div>
                            <div className="water-card-name">Water Total</div>
                            <div className="water-card-sub">{mwL > 0 && day.morningWater ? `${mwL.toFixed(1)}L from morning` : `target ${config.waterTarget}L`}</div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                            <div className="water-big">{(totalWater).toFixed(1)}<span className="u">L</span></div>
                            <div className="water-target">of {config.waterTarget}L</div>
                            <div className="stepper" style={{ marginTop: 8, justifyContent: 'flex-end' }}>
                                <button onClick={() => { haptic(); update(d => ({ water: Math.max(0, (d.water || 0) - 0.5) })); }} disabled={day.water <= 0}>−</button>
                                <button onClick={() => { haptic(); update(d => ({ water: (d.water || 0) + 0.5 })); }} disabled={totalWater >= config.waterTarget}>+</button>
                            </div>
                        </div>
                    </div>
                    <div className="track">
                        {waterPts.filter(p => p <= config.waterTarget + 0.01).map((p) => {
                            const currentTotal = Math.round((mwL + day.water) * 10) / 10;
                            const isOn = currentTotal >= p;
                            const isSoft = !isOn && currentTotal >= p - 0.5 && currentTotal > 0;
                            return (
                                <div
                                    key={p}
                                    className={`track-pt ${isOn ? 'on' : isSoft ? 'soft' : ''}`}
                                    onClick={() => { haptic(); update(d => ({ water: Math.max(0, p - effectiveMorningWater(d)) })); }}
                                />
                            );
                        })}
                    </div>
                </div>

                {/* Food Log card */}
                <div className="card" style={{ marginBottom: 10 }}>
                    <div className="log-card-header">
                        <div className="log-card-icon">
                            <PhosphorIcon name="notepad" size={24} color="#4a8a22" opacity={0.3} />
                        </div>
                        <div className="log-card-title-col">
                            <div className="log-card-num">Food Log</div>
                            <div className="log-card-name">Today's meals</div>
                        </div>
                    </div>
                    <div className="sec-lbl" style={{ margin: '0 0 8px', fontSize: 9 }}>Category</div>
                    <div className="pills" style={{ marginBottom: 10 }}>
                        {LOG_TAGS.map(t => (
                            <div key={t} className={`pill ${logTag === t ? 'on' : ''}`} onClick={() => setLogTag(t)}>
                                {t[0].toUpperCase() + t.slice(1)}
                            </div>
                        ))}
                    </div>
                    {/* Hidden camera + gallery file inputs */}
                    <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) analyzePhoto(f); e.target.value = ''; }} />
                    <input ref={galleryInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) analyzePhoto(f); e.target.value = ''; }} />
                    <div style={{ display: 'flex', gap: 8 }}>
                        <input
                            className="inp"
                            placeholder="What did you eat?"
                            value={logInput}
                            onChange={(e) => { setLogInput(e.target.value); if (!e.target.value) setAiMacros(null); }}
                            onKeyDown={(e) => { if (e.key === 'Enter') addEntry(); }}
                            style={{ flex: 1 }}
                        />
                        <div style={{ position: 'relative', flexShrink: 0 }}>
                            <button
                                style={{ width: 38, height: 38, marginTop: 0, borderRadius: 10, border: '1.5px solid var(--bd)', background: analyzing ? 'var(--sf)' : 'var(--bg)', cursor: analyzing ? 'default' : 'pointer', fontSize: 18, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                                onClick={() => { if (!analyzing) setPickerOpen(o => !o); }}
                                title="Analyse food photo"
                            >{analyzing ? '⏳' : <Camera size={18} />}</button>
                            {pickerOpen && !analyzing && (
                                <>
                                    <div onClick={() => setPickerOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 9 }} />
                                    <div style={{ position: 'absolute', bottom: 'calc(100% + 6px)', right: 0, background: 'var(--bg)', border: '1.5px solid var(--bd)', borderRadius: 12, boxShadow: '0 6px 16px rgba(0,0,0,0.18)', padding: 6, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 170, zIndex: 10 }}>
                                        <button style={{ padding: '9px 12px', borderRadius: 8, border: 'none', background: 'transparent', textAlign: 'left', fontSize: 12, fontWeight: 600, cursor: 'pointer', color: 'var(--tx)', display: 'flex', alignItems: 'center', gap: 8 }} onClick={() => { setPickerOpen(false); cameraInputRef.current?.click(); }}><IconCameraFilled size={14} color="var(--tx)" />Take Photo</button>
                                        <button style={{ padding: '9px 12px', borderRadius: 8, border: 'none', background: 'transparent', textAlign: 'left', fontSize: 12, fontWeight: 600, cursor: 'pointer', color: 'var(--tx)', display: 'flex', alignItems: 'center', gap: 8 }} onClick={() => { setPickerOpen(false); galleryInputRef.current?.click(); }}><IconPhotoPlus size={14} color="var(--tx)" />Choose from Gallery</button>
                                    </div>
                                </>
                            )}
                        </div>
                        <button className="btn green" style={{ width: 'auto', marginTop: 0, padding: '0 16px', fontSize: 13 }} onClick={addEntry}>Add</button>
                    </div>
                    {/* AI macro preview — shown after photo analysis, before user taps Add */}
                    {aiMacros && (
                        <div style={{ marginTop: 8, padding: '7px 10px', borderRadius: 8, background: 'var(--green-sf)', border: '1px solid var(--green)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                            <span style={{ fontSize: 11, color: 'var(--green-deep)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}><Robot size={12} />{foodResultToMacroString(aiMacros)}</span>
                            <span style={{ fontSize: 10, color: aiMacros.confidence === 'low' ? '#e07800' : 'var(--green-deep)', background: aiMacros.confidence === 'low' ? '#fff3e0' : 'rgba(255,255,255,0.55)', borderRadius: 6, padding: '2px 6px', fontWeight: 700 }}>{aiMacros.confidence}</span>
                        </div>
                    )}
                    {foodLog.length > 0 && (
                        <div className="free-list" style={{ marginTop: 12 }}>
                            {foodLog.map((entry, i) => (
                                <div key={i} className="food-chip">
                                    <span className="food-chip-tag">{entry.tag}</span>
                                    <span className="food-chip-txt">
                                        {entry.text}
                                        {entry.calories > 0 && <span style={{ marginLeft: 5, fontSize: 10, color: 'var(--txm)', fontWeight: 600, background: 'var(--sf)', borderRadius: 5, padding: '1px 5px' }}>{entry.calories} cal</span>}
                                        <button style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: '#c5c0b8', padding: 0, marginLeft: 4 }} onClick={() => removeEntry(i)}>×</button>
                                    </span>
                                </div>
                            ))}
                            {dailyCals > 0 && (() => { const totalProt = foodLog.reduce((s, e) => s + (e.protein_g || 0), 0); const totalCarbs = foodLog.reduce((s, e) => s + (e.carbs_g || 0), 0); const totalFat = foodLog.reduce((s, e) => s + (e.fat_g || 0), 0); const calGoal = config.calGoal || 2000; const pGoal = config.proteinGoal || 80; const cGoal = config.carbsGoal || 250; const fGoal = config.fatGoal || 65; const calPct = Math.min(100, Math.round(dailyCals / calGoal * 100)); const pPct = Math.min(100, Math.round(totalProt / pGoal * 100)); const cPct = Math.min(100, Math.round(totalCarbs / cGoal * 100)); const fPct = Math.min(100, Math.round(totalFat / fGoal * 100)); const macroKcal = totalProt * 4 + totalCarbs * 4 + totalFat * 9; const hasMacros = macroKcal > 0; const MacroBar = ({ label, val, goal, pct, color }) => (<div style={{ marginTop: 6 }}><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}><span style={{ fontSize: 10, fontWeight: 700, color }}>{label} {Math.round(val)}g</span><span style={{ fontSize: 9, color: 'var(--txm)', fontWeight: 600 }}>/{goal}g · {pct}%</span></div><div style={{ height: 4, borderRadius: 2, background: 'var(--bg2)', overflow: 'hidden' }}><div style={{ width: `${pct}%`, background: color, transition: 'width 0.5s ease', borderRadius: 2 }} /></div></div>); return (<div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, background: 'var(--sf)', border: '1px solid var(--bd)' }}><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}><span style={{ fontSize: 13, fontWeight: 700, color: 'var(--tx)' }}>~{dailyCals} kcal</span><span style={{ fontSize: 11, color: 'var(--txm)' }}>of {calGoal} · {calPct}%</span></div><div style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', background: 'var(--bg2)' }}><div style={{ width: `${calPct}%`, background: calPct >= 100 ? 'var(--amber)' : 'var(--green)', transition: 'width 0.5s ease', borderRadius: 3 }} /></div>{hasMacros && (<><MacroBar label="P" val={totalProt} goal={pGoal} pct={pPct} color="#7B8CDE" /><MacroBar label="C" val={totalCarbs} goal={cGoal} pct={cPct} color="var(--amber-deep)" /><MacroBar label="F" val={totalFat} goal={fGoal} pct={fPct} color="#E07A5F" /></>)}</div>); })()}
                        </div>
                    )}
                </div>

                {/* Mood card */}
                <div className="card" style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                        <IconMoodHappyFilled size={18} color="var(--amber)" />
                        <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--txm)' }}>Mood</span>
                        {day.moodChip && <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--tx)', fontWeight: 600, background: 'var(--sf)', borderRadius: 8, padding: '2px 8px' }}>{day.moodChip}</span>}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                        {[{ key: 'great', IC: IconMoodHappyFilled, color: '#6BAA75', label: 'Great', bg: 'rgba(107,170,117,0.13)' }, { key: 'okay', IC: IconMoodNeutralFilled, color: '#7B8CDE', label: 'Okay', bg: 'rgba(123,140,222,0.13)' }, { key: 'low', IC: IconMoodSadFilled, color: '#E07A5F', label: 'Low', bg: 'rgba(224,122,95,0.13)' }, { key: 'stressed', IC: IconMoodAngryFilled, color: '#c25b4c', label: 'Stressed', bg: 'rgba(194,91,76,0.13)' }].map(({ key, IC, color, label, bg }) => (
                            <div key={key} onClick={() => { haptic(); update(d => ({ moodChip: d.moodChip === key ? '' : key })); }} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, padding: '10px 4px', borderRadius: 12, background: day.moodChip === key ? bg : 'var(--sf)', border: `1.5px solid ${day.moodChip === key ? color : 'var(--bd)'}`, cursor: 'pointer', transition: 'all 0.15s' }}>
                                <IC size={22} color={day.moodChip === key ? color : 'var(--txm)'} />
                                <span style={{ fontSize: 10, fontWeight: 700, color: day.moodChip === key ? color : 'var(--txm)', letterSpacing: '0.02em' }}>{label}</span>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Notes card */}
                <div className={`card ${day.notesConfirmed ? 'confirmed' : ''}`} style={{ marginBottom: 24 }}>
                    <div className="label">Notes</div>
                    <div style={{ fontSize: 11, color: 'var(--txm)', marginBottom: 6 }}>Digestion</div>
                    <div className="pills" style={{ marginBottom: 10, opacity: day.notesConfirmed ? 0.6 : 1 }}>
                        {['light', 'normal', 'heavy'].map((k) => (
                            <div key={k} className={`pill ${day.skinFeelChip === k ? 'on' : ''}`}
                                onClick={() => !day.notesConfirmed && update(d => ({ skinFeelChip: d.skinFeelChip === k ? '' : k }))}>
                                {k[0].toUpperCase() + k.slice(1)}
                            </div>
                        ))}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--txm)', marginBottom: 6 }}>Energy</div>
                    <div className="pills" style={{ marginBottom: 12, opacity: day.notesConfirmed ? 0.6 : 1 }}>
                        {['high', 'medium', 'low'].map((k) => (
                            <div key={k} className={`pill ${day.energyChip === k ? 'on' : ''}`}
                                onClick={() => !day.notesConfirmed && update(d => ({ energyChip: d.energyChip === k ? '' : k }))}>
                                {k[0].toUpperCase() + k.slice(1)}
                            </div>
                        ))}
                    </div>
                    <textarea className="inp" placeholder="Anything else..." value={day.notes} readOnly={day.notesConfirmed} onChange={(e) => !day.notesConfirmed && update({ notes: e.target.value })} />
                    {!day.notesConfirmed
                        ? <button className="confirm-btn" onClick={() => { haptic(); update({ notesConfirmed: true }); }}>Confirm notes</button>
                        : <span className="saved-link" onClick={() => update({ notesConfirmed: false })}>✓ Saved · Edit</span>
                    }
                </div>

            </div>
        </div>
    );
};

/* ============================================================
   SKIN SCREEN
   ============================================================ */
const SkinScreen = ({ day, update, config, onComplete, streak }) => {
    const dow = dayOfWeek();
    const routine = (config.routines && config.routines[dow]) || { am: ['cleanser', 'niacinamide', 'sunscreen'], pm: ['cleanser'] };

    const [amOpen, setAmOpen] = useState(!day.amSkinDone);
    const [pmOpen, setPmOpen] = useState(day.amSkinDone && !day.pmSkinDone);
    const amSteps = day.amSteps || [];
    const pmSteps = day.pmSteps || [];

    const amStepList = routine.am.map(id => { const p = resolveProduct(id, config.customProducts); return { key: id, name: p.name, kind: p.kind }; });
    const pmStepList = routine.pm.map(id => { const p = resolveProduct(id, config.customProducts); return { key: id, name: p.name, kind: p.kind }; });

    const amLabel = `Morning routine · ${routine.am.length} step${routine.am.length !== 1 ? 's' : ''}`;
    const pmLabel = `Evening routine · ${routine.pm.length} step${routine.pm.length !== 1 ? 's' : ''}`;

    const prevComplete = useRef(false);
    useEffect(() => {
        const complete = day.amSkinDone && day.pmSkinDone;
        if (complete && !prevComplete.current) onComplete('skin');
        prevComplete.current = complete;
    }, [day.amSkinDone, day.pmSkinDone]);

    useEffect(() => {
        setAmOpen(!day.amSkinDone);
    }, [day.amSkinDone]);

    useEffect(() => {
        setPmOpen(!day.pmSkinDone);
    }, [day.pmSkinDone]);

    const toggleAmStep = (i) => {
        update(d => {
            const next = [...(d.amSteps || [])];
            next[i] = !next[i];
            const allDone = amStepList.every((_, idx) => !!next[idx]);
            return { amSteps: next, amSkinDone: allDone };
        });
    };
    const togglePmStep = (i) => {
        update(d => {
            const next = [...(d.pmSteps || [])];
            next[i] = !next[i];
            const allDone = pmStepList.every((_, idx) => !!next[idx]);
            return { pmSteps: next, pmSkinDone: allDone };
        });
    };

    return (
        <div className="screen">
            <div className="sky-header sky-skin">
                <div className="sky-cloud" style={{ width: 100, height: 30, top: 10, left: -10 }} />
                <div className="sky-cloud" style={{ width: 75, height: 24, top: 5, left: 60 }} />
                <div className="sky-cloud" style={{ width: 120, height: 36, top: 16, right: -20 }} />
                <div className="sky-horizon" />
                <div className="sky-grass" />
                <div className="sky-content">
                    <div className="sky-top-row">
                        <div>
                            <div className="sky-date-big">{dow} · {new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</div>
                            <div className="sky-date-sub">Skin ritual</div>
                        </div>
                    </div>
                    <div className="sky-panda-row" style={{ marginTop: '-8px' }}>
                        <div className="sky-panda-av">
                            <img src={PANDA_SRC} alt="panda" />
                        </div>
                        <div className="sky-panda-bubble">{getPandaSkinMessage(day, config)}</div>
                    </div>
                </div>
            </div>
            <div className="body-pad">

                <ProgressDots day={day} config={config} mode="skin" />

                {/* AM Card */}
                <div className={`card ${day.amSkinDone ? 'skin-done' : ''}`}>
                    <div className="coll-hd" onClick={() => setAmOpen(!amOpen)}>
                        <div className="t">
                            {day.amSkinDone && '✓ '}{amLabel.split(' · ')[0]}<span className="ct">{amLabel.split(' · ')[1]}</span>
                        </div>
                        <div className={`chev ${amOpen ? 'open' : ''}`}><Icon name="chev" /></div>
                    </div>
                    {amOpen && (
                        <div className="steps">
                            {amStepList.map((s, i) => (
                                <div key={i} className="step">
                                    <Check on={!!amSteps[i]} teal onClick={() => toggleAmStep(i)} />
                                    <div className="info">
                                        <div className="name">{config.showProductNames ? s.name : s.kind}</div>
                                        <div className="kind">{s.kind}</div>
                                    </div>
                                </div>
                            ))}
                            {!day.amSkinDone && (
                                <button className="btn teal" onClick={() => { haptic(10); update({ amSkinDone: true, amSteps: amStepList.map(() => true) }); }}>
                                    Mark AM done
                                </button>
                            )}
                        </div>
                    )}
                </div>

                {/* PM Card */}
                <div className={`card ${day.pmSkinDone ? 'skin-done' : ''}`}>
                    <div className="coll-hd" onClick={() => setPmOpen(!pmOpen)}>
                        <div className="t">
                            {day.pmSkinDone && '✓ '}{pmLabel.split(' · ')[0]}<span className="ct">{pmLabel.split(' · ')[1]}</span>
                        </div>
                        <div className={`chev ${pmOpen ? 'open' : ''}`}><Icon name="chev" /></div>
                    </div>
                    {pmOpen && (
                        <div className="steps">
                            {pmStepList.map((s, i) => (
                                <div key={i} className="step">
                                    <Check on={!!pmSteps[i]} teal onClick={() => togglePmStep(i)} />
                                    <div className="info">
                                        <div className="name">{config.showProductNames ? s.name : s.kind}</div>
                                        <div className="kind">{s.kind}</div>
                                    </div>
                                </div>
                            ))}
                            {!day.pmSkinDone && (
                                <button className="btn teal" onClick={() => { haptic(10); update({ pmSkinDone: true, pmSteps: pmStepList.map(() => true) }); }}>
                                    Mark PM done
                                </button>
                            )}
                        </div>
                    )}
                </div>

                {/* Skin notes — with confirm */}
                <div className={`card ${day.skinNotesConfirmed ? 'confirmed' : ''}`}>
                    <div className="label">Skin notes</div>
                    <div style={{ fontSize: 11, color: 'var(--txm)', marginBottom: 6 }}>Skin today</div>
                    <div className="pills" style={{ marginBottom: 10, opacity: day.skinNotesConfirmed ? 0.6 : 1 }}>
                        {['clear', 'breakouts', 'purging', 'oily', 'dry'].map((k) => (
                            <div key={k} className={`pill ${day.skinTodayChip === k ? 'on teal' : ''}`}
                                onClick={() => !day.skinNotesConfirmed && update(d => ({ skinTodayChip: d.skinTodayChip === k ? '' : k }))}>
                                {k[0].toUpperCase() + k.slice(1)}
                            </div>
                        ))}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--txm)', marginBottom: 6 }}>Skin reaction</div>
                    <div className="pills" style={{ marginBottom: 12, opacity: day.skinNotesConfirmed ? 0.6 : 1 }}>
                        {[['none', 'None'], ['mild', 'Mild dryness'], ['irritation', 'Irritation']].map(([k, l]) => (
                            <div key={k} className={`pill ${day.reactionChip === k ? 'on teal' : ''}`}
                                onClick={() => !day.skinNotesConfirmed && update(d => ({ reactionChip: d.reactionChip === k ? '' : k }))}>{l}</div>
                        ))}
                    </div>
                    <textarea
                        className="inp"
                        placeholder="Anything else about skin..."
                        value={day.skinNotes}
                        readOnly={day.skinNotesConfirmed}
                        onChange={(e) => !day.skinNotesConfirmed && update({ skinNotes: e.target.value })}
                    />
                    {!day.skinNotesConfirmed
                        ? <button className="confirm-btn teal" onClick={() => { haptic(); update({ skinNotesConfirmed: true }); }}>Confirm notes</button>
                        : <span className="saved-link" onClick={() => update({ skinNotesConfirmed: false })}>✓ Saved · Edit</span>
                    }
                </div>
                {/* Photo Journal card */}
                <div className="card" style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                        <IconCameraFilled size={18} color="var(--teal)" />
                        <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--txm)' }}>Photo Journal</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                        {[{ field: 'skinPhoto', label: 'Face', icon: '🙂' }, { field: 'hairPhoto', label: 'Hair', icon: '💇' }].map(({ field, label, icon }) => {
                            const camId = `photo-cam-${field}`;
                            const upId = `photo-up-${field}`;
                            const handleFile = async (f) => { if (!f) return; try { const b64 = await compressPhoto(f); haptic(); update({ [field]: b64 }); } catch { } };
                            return (
                                <div key={field} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                                    <div style={{ width: '100%', aspectRatio: '1', borderRadius: 14, overflow: 'hidden', background: 'var(--sf)', border: '2px dashed var(--bd)', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
                                        {day[field] ? <img src={day[field]} alt={label} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}><span style={{ fontSize: 26 }}>{icon}</span><span style={{ fontSize: 10, color: 'var(--txm)', fontWeight: 600 }}>Use buttons below</span></div>}
                                        {day[field] && <div style={{ position: 'absolute', top: 6, right: 6, width: 22, height: 22, borderRadius: '50%', background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }} onClick={() => { haptic(4); update({ [field]: '' }); }}>✕</div>}
                                    </div>
                                    <input id={camId} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={async (e) => { await handleFile(e.target.files?.[0]); e.target.value = ''; }} />
                                    <input id={upId} type="file" accept="image/*" style={{ display: 'none' }} onChange={async (e) => { await handleFile(e.target.files?.[0]); e.target.value = ''; }} />
                                    <div style={{ display: 'flex', gap: 6, width: '100%' }}>
                                        <button onClick={() => document.getElementById(camId)?.click()} style={{ flex: 1, padding: '7px 4px', borderRadius: 9, border: '1.5px solid var(--bd)', background: 'var(--sf)', fontSize: 11, fontWeight: 700, color: 'var(--txm)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                                            <IconCameraFilled size={13} color="var(--txm)" />
                                            Camera
                                        </button>
                                        <button onClick={() => document.getElementById(upId)?.click()} style={{ flex: 1, padding: '7px 4px', borderRadius: 9, border: '1.5px solid var(--bd)', background: 'var(--sf)', fontSize: 11, fontWeight: 700, color: 'var(--txm)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                                            <IconPhotoPlus size={13} color="var(--txm)" />
                                            Upload
                                        </button>
                                    </div>
                                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--txm)' }}>{label}</span>
                                </div>
                            );
                        })}
                    </div>
                </div>

            </div>
        </div>
    );
};

/* ============================================================
   LOG SCREEN
   ============================================================ */
const LogScreen = ({ allData, config }) => {
    const [monthOffset, setMonthOffset] = useState(0);
    const [weekOffset, setWeekOffset] = useState(0);
    const [logView, setLogView] = useState('month');
    const [activeDay, setActiveDay] = useState(null);
    const [exported, setExported] = useState(false);

    const viewDate = useMemo(() => {
        const d = new Date();
        d.setDate(1);
        d.setMonth(d.getMonth() + monthOffset);
        return d;
    }, [monthOffset]);

    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const monthName = viewDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const firstDayOfWeek = new Date(year, month, 1).getDay();

    const dayLevel = (d) => {
        if (!d) return 0;
        let pts = 0;
        if (d.morningWater) pts++;
        const mwL = effectiveMorningWater(d);
        if ((mwL + (d.water || 0)) >= config.waterTarget) pts++;
        if (d.amSkinDone) pts++;
        if (d.pmSkinDone) pts++;
        if (pts >= 4) return 4;
        if (pts >= 3) return 3;
        if (pts >= 2) return 2;
        if (pts >= 1) return 1;
        const log = migrateFreeFoodLog(d.freeFoodLog);
        if (log.length || d.notes || d.skinNotes) return 1;
        return 0;
    };

    const streak = useMemo(() => {
        let s = 0;
        const d = new Date();
        const todayK = todayKey(d);
        // Count today immediately on first logged action; past days still require ≥2.
        if (allData[todayK] && dayLevel(allData[todayK]) >= 1) s = 1;
        d.setDate(d.getDate() - 1);
        // Walk back through history; cap is a sanity bound only (~13.7 years).
        let safety = 0;
        while (safety < 5000) {
            const rec = allData[todayKey(d)];
            if (rec && dayLevel(rec) >= 2) { s++; d.setDate(d.getDate() - 1); safety++; }
            else break;
        }
        return s;
    }, [allData, config]);

    const daysTrackedThisMonth = useMemo(() => {
        const now = new Date();
        let c = 0;
        for (const k in allData) {
            const d = new Date(k + 'T12:00:00');
            if (d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear() && dayLevel(allData[k]) > 0) c++;
        }
        return c;
    }, [allData, config]);

    const completionPct = useMemo(() => {
        const now = new Date();
        const daysSoFar = now.getDate();
        let full = 0;
        for (let i = 1; i <= daysSoFar; i++) {
            const d = new Date(now.getFullYear(), now.getMonth(), i, 12);
            const key = todayKey(d);
            if (allData[key] && dayLevel(allData[key]) >= 4) full++;
        }
        return Math.round((full / daysSoFar) * 100);
    }, [allData, config]);

    const avgWater = useMemo(() => {
        const now = new Date();
        let total = 0, count = 0;
        for (let i = 1; i <= now.getDate(); i++) {
            const k = todayKey(new Date(now.getFullYear(), now.getMonth(), i, 12));
            const rec = allData[k];
            if (rec) {
                const mwL = effectiveMorningWater(rec);
                total += mwL + (rec.water || 0);
                count++;
            }
        }
        return count > 0 ? (total / count).toFixed(1) : '—';
    }, [allData]);

    const avgSleep = useMemo(() => {
        const vals = Object.values(allData).map(r => calcSleepDuration(r.sleepTime, r.wakeTime)).filter(v => v != null);
        if (!vals.length) return null;
        return vals.reduce((a, b) => a + b, 0) / vals.length;
    }, [allData]);

    const cells = [];
    for (let i = 0; i < firstDayOfWeek; i++) cells.push({ empty: true, key: `e${i}` });
    for (let d = 1; d <= daysInMonth; d++) {
        const date = new Date(year, month, d, 12);
        const key = todayKey(date);
        const rec = allData[key];
        const lvl = dayLevel(rec);
        const isToday = key === todayKey();
        cells.push({ d, key, lvl, isToday, rec });
    }

    const loadXLSX = () => new Promise((resolve, reject) => {
        if (window.XLSX) return resolve(window.XLSX);
        const s = document.createElement('script');
        s.src = 'https://cdn.sheetjs.com/xlsx-0.20.1/package/dist/xlsx.full.min.js';
        s.onload = () => resolve(window.XLSX);
        s.onerror = reject;
        document.head.appendChild(s);
    });

    const exportData = async () => {
        // XLSX only
        try {
            const XLSX = await loadXLSX();
            const wb = XLSX.utils.book_new();

            // Daily sheet (cap at 10 years = ~3650 days for safety on low-RAM devices)
            const hdr = ['Date', 'Day', 'Water (L)', 'Water target', 'Morning water', 'Breakfast', 'Lunch', 'Dinner', 'Other food', 'Skin feel', 'Energy', 'AM skin', 'PM skin', 'AM products', 'PM products', 'Skin today', 'Skin reaction', 'Notes', 'Skin notes'];
            const rows = [hdr];
            const allKeys = Object.keys(allData).sort();
            const exportKeys = allKeys.length > 3650 ? allKeys.slice(-3650) : allKeys;
            exportKeys.forEach((k) => {
                const d = allData[k];
                const dow2 = dayOfWeek(new Date(k + 'T12:00:00'));
                const mwL = effectiveMorningWater(d);
                const log = migrateFreeFoodLog(d.freeFoodLog);
                const r2 = (config.routines && config.routines[dow2]) || { am: [], pm: [] };
                rows.push([
                    k, dow2,
                    parseFloat((mwL + (d.water || 0)).toFixed(2)),
                    config.waterTarget,
                    d.morningWaterAmount || '',
                    log.filter(e => e.tag === 'breakfast').map(e => e.text).join('; '),
                    log.filter(e => e.tag === 'lunch').map(e => e.text).join('; '),
                    log.filter(e => e.tag === 'dinner').map(e => e.text).join('; '),
                    log.filter(e => e.tag === 'snack' || e.tag === 'other').map(e => e.text).join('; '),
                    d.skinFeelChip || '', d.energyChip || '',
                    d.amSkinDone ? 'yes' : 'no', d.pmSkinDone ? 'yes' : 'no',
                    r2.am.map(pk => resolveProduct(pk, config.customProducts).name).join(', '),
                    r2.pm.map(pk => resolveProduct(pk, config.customProducts).name).join(', '),
                    d.skinTodayChip || '', d.reactionChip || d.retinolReactionChip || '',
                    d.notes || '', d.skinNotes || '',
                ]);
            });
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Daily');

            // Config sheet
            const cfgRows = [['Key', 'Value']];
            cfgRows.push(['waterTarget', config.waterTarget], ['showProductNames', config.showProductNames]);
            (config.customProducts || []).forEach(p => cfgRows.push([`product.${p.id}`, `${p.kind} | ${p.name} | ${p.slot}${p.archived ? ' | archived' : ''}`]));
            Object.entries(config.routines || {}).forEach(([day, r]) => {
                cfgRows.push([`routine.${day}.am`, r.am.join(', ')]);
                cfgRows.push([`routine.${day}.pm`, r.pm.join(', ')]);
            });
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cfgRows), 'Config');

            const wbOut = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
            const xlsxBlob = new Blob([wbOut], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
            const xlsxUrl = URL.createObjectURL(xlsxBlob);
            const ax = document.createElement('a');
            ax.href = xlsxUrl; ax.download = `form-export-${todayKey()}.xlsx`;
            document.body.appendChild(ax); ax.click(); document.body.removeChild(ax);
            URL.revokeObjectURL(xlsxUrl);
        } catch (err) {
            console.error('XLSX export failed:', err);
        }

        setExported(true);
        setTimeout(() => setExported(false), 2000);
    };

    const renderDetail = (key, rec) => {
        const mwL = effectiveMorningWater(rec);
        const totalW = (mwL + (rec.water || 0)).toFixed(1);
        const dow2 = dayOfWeek(new Date(key + 'T12:00:00'));
        const log = migrateFreeFoodLog(rec.freeFoodLog);
        const r2 = (config.routines && config.routines[dow2]) || { am: [], pm: [] };
        const amLoggedNames = r2.am.filter((_, idx) => !!rec.amSteps?.[idx]).map(pk => resolveProduct(pk, config.customProducts).name).join(', ');
        const pmLoggedNames = r2.pm.filter((_, idx) => !!rec.pmSteps?.[idx]).map(pk => resolveProduct(pk, config.customProducts).name).join(', ');
        const amLoggedCount = (rec.amSteps || []).filter(Boolean).length;
        const pmLoggedCount = (rec.pmSteps || []).filter(Boolean).length;
        const waterOk = (mwL + (rec.water || 0)) >= config.waterTarget;

        return (
            <>
                {/* Food section */}
                <div className="dl-section">
                    <div className="dl-section-hd">
                        <div className="dl-section-icon dl-food-icon"><PhosphorIcon name="bowl" size={16} color="#3a7010" opacity={0.7} /></div>
                        <span className="dl-section-lbl">Food</span>
                    </div>
                    <div className="dl-card">
                        <div className="dl-row">
                            <div className="dl-row-left"><div className="dl-ph-icon"><PhosphorIcon name="drop" size={16} color="var(--txm)" opacity={0.8} /></div><span className="dl-key">Morning water</span></div>
                            <span className={`dl-val ${rec.morningWater ? 'dl-ok' : 'dl-miss'}`}>{rec.morningWater ? '✓' : '—'}</span>
                        </div>
                        <div className="dl-row">
                            <div className="dl-row-left"><div className="dl-ph-icon"><PhosphorIcon name="bottle" size={16} color="var(--txm)" opacity={0.8} /></div><span className="dl-key">Water</span></div>
                            <span className={`dl-val ${waterOk ? 'dl-ok' : ''}`}>{totalW} / {config.waterTarget}L</span>
                        </div>
                    </div>
                    {log.length > 0 && (
                        <div className="dl-log">
                            {['breakfast', 'lunch', 'dinner', 'snack', 'other'].map(tag => {
                                const items = log.filter(e => e.tag === tag).map(e => e.text);
                                if (!items.length) return null;
                                return (
                                    <div key={tag} className="dl-log-group">
                                        <div className="dl-log-tag">{tag}</div>
                                        <div className="dl-log-items">{items.join(', ')}</div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                    {(rec.skinFeelChip || rec.energyChip) && (
                        <div className="dl-chips">
                            {rec.skinFeelChip && <div className="dl-chip amber">Skin feel · {rec.skinFeelChip}</div>}
                            {rec.energyChip && <div className="dl-chip green">Energy · {rec.energyChip}</div>}
                        </div>
                    )}
                    {rec.notes && <div className="dl-note">{rec.notes}</div>}
                </div>

                {/* Skin section */}
                <div className="dl-section">
                    <div className="dl-section-hd">
                        <div className="dl-section-icon dl-skin-icon"><PhosphorIcon name="sparkle" size={16} color="#0a6058" opacity={0.7} /></div>
                        <span className="dl-section-lbl">Skin</span>
                    </div>
                    <div className="dl-card">
                        <div className="dl-row">
                            <div className="dl-row-left"><div className="dl-ph-icon"><PhosphorIcon name="sun" size={16} color="var(--txm)" opacity={0.8} /></div><span className="dl-key">AM Routine</span></div>
                            <span className={`dl-val ${(rec.amSkinDone || amLoggedCount > 0) ? 'dl-ok' : 'dl-miss'}`}>{rec.amSkinDone ? 'Done' : amLoggedCount > 0 ? `${amLoggedCount}/${r2.am.length} logged` : '-'}</span>
                        </div>
                        {amLoggedNames && <div className="dl-sub-row">{amLoggedNames}</div>}
                        <div className="dl-row">
                            <div className="dl-row-left"><div className="dl-ph-icon"><PhosphorIcon name="moon" size={16} color="var(--txm)" opacity={0.8} /></div><span className="dl-key">PM Routine</span></div>
                            <span className={`dl-val ${(rec.pmSkinDone || pmLoggedCount > 0) ? 'dl-ok' : 'dl-miss'}`}>{rec.pmSkinDone ? 'Done' : pmLoggedCount > 0 ? `${pmLoggedCount}/${r2.pm.length} logged` : '-'}</span>
                        </div>
                        {pmLoggedNames && <div className="dl-sub-row">{pmLoggedNames}</div>}
                    </div>
                    {(rec.skinTodayChip || rec.reactionChip || rec.retinolReactionChip) && (
                        <div className="dl-chips">
                            {rec.skinTodayChip && <div className="dl-chip teal">Skin today · {rec.skinTodayChip}</div>}
                            {(rec.reactionChip || rec.retinolReactionChip) && <div className="dl-chip pink">Reaction · {rec.reactionChip || rec.retinolReactionChip}</div>}
                        </div>
                    )}
                    {rec.skinNotes && <div className="dl-note">{rec.skinNotes}</div>}
                </div>

                {/* Mood & Sleep section */}
                {(rec.moodChip || rec.sleepTime || rec.wakeTime || rec.sleepQuality) && (
                    <div className="dl-section">
                        <div className="dl-section-hd">
                            <div className="dl-section-icon" style={{ background: 'rgba(123,140,222,0.15)' }}><IconMoodHappyFilled size={16} color="#7B8CDE" /></div>
                            <span className="dl-section-lbl">Mood & Sleep</span>
                        </div>
                        <div className="dl-card">
                            {rec.moodChip && (
                                <div className="dl-row">
                                    <div className="dl-row-left"><span className="dl-key">Mood</span></div>
                                    <span className="dl-val" style={{ color: 'var(--tx)' }}>{rec.moodChip[0].toUpperCase() + rec.moodChip.slice(1)}</span>
                                </div>
                            )}
                            {(rec.sleepTime || rec.wakeTime) && (
                                <div className="dl-row">
                                    <div className="dl-row-left"><IconBedFilled size={15} color="var(--txm)" /><span className="dl-key" style={{ marginLeft: 6 }}>Sleep</span></div>
                                    <span className="dl-val" style={{ color: '#7B8CDE', fontFamily: 'var(--mono)', fontWeight: 700 }}>{rec.sleepTime || '?'} → {rec.wakeTime || '?'} · {fmtSleep(calcSleepDuration(rec.sleepTime, rec.wakeTime))}</span>
                                </div>
                            )}
                            {rec.sleepQuality && (
                                <div className="dl-row">
                                    <div className="dl-row-left"><span className="dl-key">Quality</span></div>
                                    <span className="dl-val" style={{ color: 'var(--tx)' }}>{rec.sleepQuality[0].toUpperCase() + rec.sleepQuality.slice(1)}</span>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* Photos section */}
                {(rec.skinPhoto || rec.hairPhoto) && (
                    <div className="dl-section">
                        <div className="dl-section-hd">
                            <div className="dl-section-icon" style={{ background: 'rgba(0,139,131,0.12)' }}><IconCameraFilled size={16} color="var(--teal)" /></div>
                            <span className="dl-section-lbl">Photos</span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: rec.skinPhoto && rec.hairPhoto ? '1fr 1fr' : '1fr', gap: 10, marginTop: 8 }}>
                            {rec.skinPhoto && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                                    <img src={rec.skinPhoto} alt="Face" style={{ width: '100%', borderRadius: 10, objectFit: 'cover', aspectRatio: '1' }} />
                                    <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--txm)', textAlign: 'center' }}>Face</span>
                                </div>
                            )}
                            {rec.hairPhoto && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                                    <img src={rec.hairPhoto} alt="Hair" style={{ width: '100%', borderRadius: 10, objectFit: 'cover', aspectRatio: '1' }} />
                                    <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--txm)', textAlign: 'center' }}>Hair</span>
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </>
        );
    };

    return (
        <div className="screen">
            <div className="sky-header sky-log">
                <div className="sky-cloud" style={{ width: 90, height: 28, top: 10, left: -10 }} />
                <div className="sky-cloud" style={{ width: 130, height: 38, top: 18, right: -20 }} />
                <div className="sky-horizon" />
                <div className="sky-grass" />
                <div className="sky-content">
                    <div className="sky-date-big">Log</div>
                    <div className="sky-date-sub">Your history</div>
                </div>
            </div>
            <div className="body-pad">

                <div style={{ display: 'flex', gap: 10, marginBottom: 14, overflowX: 'auto', paddingBottom: 4 }}>
                    {[{ IC: IconFlameFilled, ic: 'var(--amber)', val: streak, label: `day${streak !== 1 ? 's' : ''}`, color: 'var(--amber)' }, { IC: IconCalendarMonth, ic: 'var(--teal)', val: daysTrackedThisMonth, label: 'this month', color: 'var(--teal)' }, { IC: IconCircleCheckFilled, ic: 'var(--green)', val: `${completionPct}%`, label: 'completion', color: 'var(--green)' }, { IC: IconDropletFilled, ic: 'var(--teal)', val: `${avgWater}${avgWater !== '—' ? 'L' : ''}`, label: 'avg water', color: 'var(--teal)' }, { IC: IconBedFilled, ic: '#7B8CDE', val: fmtSleep(avgSleep), label: 'avg sleep', color: '#7B8CDE' }].map(({ IC, ic, val, label, color }) => (
                        <div key={label} style={{ background: 'var(--sf)', borderRadius: 18, padding: '12px 16px', minWidth: 86, flexShrink: 0, textAlign: 'center', boxShadow: 'var(--card-shadow)' }}>
                            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 4 }}><IC size={20} color={ic} /></div>
                            <div style={{ fontSize: 22, fontWeight: 800, color, fontFamily: 'var(--mono)', letterSpacing: '-0.02em', lineHeight: 1.1 }}>{val}</div>
                            <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--txm)', marginTop: 3, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</div>
                        </div>
                    ))}
                </div>
                {(() => { const days7 = Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - (6 - i)); d.setHours(12, 0, 0, 0); const k = todayKey(d); const rec = allData[k]; const lvl = dayLevel(rec); const names = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']; return { k, lvl, label: names[d.getDay()], isToday: k === todayKey() }; }); const maxH = 40; return (<div className="card" style={{ marginBottom: 14, padding: '14px 16px' }}><div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--txm)', marginBottom: 12 }}>Last 7 days</div><div style={{ display: 'flex', alignItems: 'flex-end', gap: 5, height: maxH + 22 }}>{days7.map(({ k, lvl, label, isToday }) => { const h = lvl === 0 ? 4 : Math.round((lvl / 4) * maxH); const bg = lvl === 0 ? 'var(--bd)' : lvl >= 4 ? 'var(--green)' : lvl >= 2 ? 'var(--amber)' : 'rgba(183,231,120,0.45)'; return (<div key={k} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}><div style={{ width: '100%', borderRadius: 4, background: bg, height: h, alignSelf: 'flex-end', transition: 'height 0.4s ease', minHeight: 4 }} /><div style={{ fontSize: 9, fontWeight: isToday ? 800 : 600, color: isToday ? 'var(--tx)' : 'var(--txm)', letterSpacing: isToday ? '0.02em' : 0 }}>{label}</div></div>); })}</div></div>); })()}

                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                    <button onClick={() => setLogView('month')} style={{ flex: 1, padding: '8px 0', borderRadius: 10, border: '1.5px solid var(--bd)', background: logView === 'month' ? 'var(--teal)' : 'var(--sf)', color: logView === 'month' ? '#fff' : 'var(--txm)', fontWeight: 700, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                        <IconCalendarMonth size={15} color={logView === 'month' ? '#fff' : 'var(--txm)'} />
                        Month
                    </button>
                    <button onClick={() => setLogView('week')} style={{ flex: 1, padding: '8px 0', borderRadius: 10, border: '1.5px solid var(--bd)', background: logView === 'week' ? 'var(--teal)' : 'var(--sf)', color: logView === 'week' ? '#fff' : 'var(--txm)', fontWeight: 700, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                        <IconCalendarWeek size={15} color={logView === 'week' ? '#fff' : 'var(--txm)'} />
                        Week
                    </button>
                    <button onClick={() => setLogView('photos')} style={{ flex: 1, padding: '8px 0', borderRadius: 10, border: '1.5px solid var(--bd)', background: logView === 'photos' ? 'var(--teal)' : 'var(--sf)', color: logView === 'photos' ? '#fff' : 'var(--txm)', fontWeight: 700, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                        <IconCameraFilled size={15} color={logView === 'photos' ? '#fff' : 'var(--txm)'} />
                        Photos
                    </button>
                </div>

                {logView === 'photos' && (() => {
                    const entries = Object.entries(allData)
                        .filter(([, rec]) => rec && (rec.skinPhoto || rec.hairPhoto))
                        .sort(([a], [b]) => b.localeCompare(a))
                        .slice(0, 60);
                    if (entries.length === 0) {
                        return (
                            <div className="card" style={{ marginBottom: 14, padding: '28px 16px', textAlign: 'center' }}>
                                <IconCameraFilled size={28} color="var(--txm)" />
                                <div style={{ fontSize: 13, color: 'var(--txm)', marginTop: 8, fontWeight: 600 }}>No progress photos yet</div>
                                <div style={{ fontSize: 11, color: 'var(--txd)', marginTop: 4 }}>Add Face/Hair photos in the daily Photo Journal section</div>
                            </div>
                        );
                    }
                    return (
                        <div className="card" style={{ marginBottom: 14, padding: '14px 14px' }}>
                            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--txm)', marginBottom: 12, display: 'flex', justifyContent: 'space-between' }}>
                                <span>Photo timeline</span>
                                <span style={{ color: 'var(--txd)', fontWeight: 600 }}>{entries.length} day{entries.length === 1 ? '' : 's'}</span>
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))', gap: 8 }}>
                                {entries.map(([k, rec]) => {
                                    const dateLabel = new Date(k + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
                                    return (
                                        <div key={k} onClick={() => setActiveDay(k)} style={{ cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 4 }}>
                                            <div style={{ position: 'relative', aspectRatio: '1', borderRadius: 8, overflow: 'hidden', background: 'var(--sf)', border: '1px solid var(--bd)' }}>
                                                {rec.skinPhoto ? <img src={rec.skinPhoto} alt={dateLabel} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : rec.hairPhoto ? <img src={rec.hairPhoto} alt={dateLabel} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : null}
                                                {rec.skinPhoto && rec.hairPhoto && <div style={{ position: 'absolute', bottom: 3, right: 3, background: 'rgba(0,0,0,0.55)', borderRadius: 4, padding: '1px 4px', fontSize: 8, color: '#fff', fontWeight: 700 }}>2</div>}
                                            </div>
                                            <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--txm)', textAlign: 'center' }}>{dateLabel}</div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })()}

                {logView === 'week' && (() => {
                    const mon = new Date(); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7) + weekOffset * 7); mon.setHours(12, 0, 0, 0);
                    const days7w = Array.from({ length: 7 }, (_, i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); const k = todayKey(d); const rec = allData[k]; const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']; return { k, rec, label: names[i], dateNum: d.getDate(), isToday: k === todayKey(), lvl: dayLevel(rec) }; });
                    const weekLabel = `${mon.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${days7w[6] ? new Date(days7w[6].k + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : ''}`;
                    const MOOD_EMOJI = { great: '😊', okay: '😐', low: '😔', stressed: '😤' };
                    return (
                        <div className="card" style={{ marginBottom: 14 }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                                <button onClick={() => setWeekOffset(w => w - 1)} style={{ background: 'none', border: 'none', fontSize: 20, color: 'var(--txm)', cursor: 'pointer', padding: '0 6px' }}>‹</button>
                                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--txm)' }}>{weekLabel}</span>
                                <button onClick={() => setWeekOffset(w => Math.min(0, w + 1))} style={{ background: 'none', border: 'none', fontSize: 20, color: 'var(--txm)', cursor: 'pointer', padding: '0 6px' }}>›</button>
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
                                {days7w.map(({ k, rec, label, dateNum, isToday, lvl }) => {
                                    const bg = lvl === 0 ? 'var(--bd)' : lvl >= 4 ? 'var(--green)' : lvl >= 2 ? 'var(--amber)' : 'rgba(183,231,120,0.45)';
                                    const slpH = rec ? calcSleepDuration(rec.sleepTime, rec.wakeTime) : null;
                                    const foodDone = rec && !!rec.morningWater;
                                    const skinDone = rec && (rec.amSkinDone || rec.pmSkinDone);
                                    return (
                                        <div key={k} onClick={() => rec && setActiveDay({ key: k, rec })} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '8px 2px', borderRadius: 10, background: isToday ? 'rgba(var(--teal-rgb, 0,139,131), 0.07)' : 'transparent', border: isToday ? '1.5px solid var(--teal)' : '1.5px solid transparent', cursor: rec ? 'pointer' : 'default' }}>
                                            <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--txm)', textTransform: 'uppercase' }}>{label}</span>
                                            <div style={{ width: 28, height: 28, borderRadius: 8, background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                                <span style={{ fontSize: 12, fontWeight: 800, color: lvl > 0 ? 'rgba(0,0,0,0.55)' : 'var(--txm)' }}>{dateNum}</span>
                                            </div>
                                            <div style={{ display: 'flex', gap: 2 }}>
                                                <div style={{ width: 6, height: 6, borderRadius: 2, background: foodDone ? 'var(--green)' : 'var(--bd)' }} title="Food" />
                                                <div style={{ width: 6, height: 6, borderRadius: 2, background: skinDone ? 'var(--teal)' : 'var(--bd)' }} title="Skin" />
                                            </div>
                                            {rec?.moodChip ? <span style={{ fontSize: 11, lineHeight: 1 }}>{MOOD_EMOJI[rec.moodChip] || ''}</span> : <span style={{ fontSize: 11, lineHeight: 1, color: 'transparent' }}>·</span>}
                                            <span style={{ fontSize: 9, fontWeight: 700, color: '#7B8CDE', fontFamily: 'var(--mono)' }}>{slpH != null ? fmtSleep(slpH) : ''}</span>
                                        </div>
                                    );
                                })}
                            </div>
                            <div style={{ display: 'flex', gap: 12, marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--bd)' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}><div style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--green)' }} /><span style={{ fontSize: 10, color: 'var(--txm)' }}>Food</span></div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}><div style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--teal)' }} /><span style={{ fontSize: 10, color: 'var(--txm)' }}>Skin</span></div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ fontSize: 11 }}>😊</span><span style={{ fontSize: 10, color: 'var(--txm)' }}>Mood</span></div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}><IconBedFilled size={12} color="#7B8CDE" /><span style={{ fontSize: 10, color: 'var(--txm)' }}>Sleep</span></div>
                            </div>
                        </div>
                    );
                })()}

                {logView === 'month' && <div className="card">
                    <div className="cal-hd">
                        <button onClick={() => setMonthOffset(monthOffset - 1)}>‹</button>
                        <div className="m">{monthName}</div>
                        <button onClick={() => setMonthOffset(Math.min(0, monthOffset + 1))}>›</button>
                    </div>
                    {Object.keys(allData).length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '32px 16px', color: 'var(--txm)' }}>
                            <div style={{ marginBottom: 10 }}><Leaf size={32} color="var(--txm)" /></div>
                            <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>No data yet</div>
                            <div style={{ fontSize: 12 }}>Start logging on the Food and Skin tabs — your history will appear here.</div>
                        </div>
                    ) : (
                        <div className="cal" key={monthOffset}>
                            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <div key={i} className="cal-day-lbl">{d}</div>)}
                            {cells.map((c) => c.empty
                                ? <div key={c.key} className="cal-cell empty" />
                                : <div
                                    key={c.key}
                                    className={`cal-cell lvl${c.lvl} ${c.isToday ? 'today' : ''}`}
                                    onClick={() => c.rec && setActiveDay({ key: c.key, rec: c.rec })}
                                    style={{ position: 'relative' }}
                                >
                                    {c.d}
                                    {c.rec && (c.rec.notes || c.rec.skinNotes) && (
                                        <div className="note-dot" style={{ position: 'absolute', bottom: 3, right: 4, width: 4, height: 4, borderRadius: '50%' }} />
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                </div>}

                <button className={`btn ${exported ? 'green' : ''}`} onClick={exportData}>
                    {exported ? 'Exported ✓' : 'Export data'}
                </button>

            </div>

            {activeDay && (
                <div className="sheet" onClick={() => setActiveDay(null)}>
                    <div className="sheet-body" onClick={(e) => e.stopPropagation()}>
                        <div className="sheet-hd">
                            <h2>{new Date(activeDay.key + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
                            <button onClick={() => setActiveDay(null)}>×</button>
                        </div>
                        {renderDetail(activeDay.key, activeDay.rec)}
                    </div>
                </div>
            )}
        </div>
    );
};

/* ============================================================
   ROUTINE EDITOR (Settings sub-component)
   ============================================================ */
const RoutineEditor = ({ config, setConfig }) => {
    const [picker, setPicker] = useState(null); // { day, slot } | null

    const updateRoutine = (day, slot, keys) => {
        setConfig(sanitizeConfig({
            ...config,
            routines: {
                ...config.routines,
                [day]: { ...config.routines[day], [slot]: keys },
            },
        }));
    };

    const activeProducts = (config.customProducts || []).filter(p => !p.archived);

    return (
        <div className="set-row">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => {
                const r = (config.routines && config.routines[day]) || { am: [], pm: [] };
                return (
                    <div key={day} className="routine-day-row">
                        <div className="routine-day-lbl">{day}</div>
                        {['am', 'pm'].map((slot) => {
                            const keys = r[slot] || [];
                            const pickerOpen = picker && picker.day === day && picker.slot === slot;
                            const eligible = activeProducts.filter(p =>
                                (slot === 'am' ? (p.slot === 'am' || p.slot === 'both') : (p.slot === 'pm' || p.slot === 'both'))
                                && !keys.includes(p.id)
                            );
                            return (
                                <div key={slot} className="routine-sub">
                                    <div className="routine-sub-label">{slot.toUpperCase()}</div>
                                    <div style={{ flex: 1 }}>
                                        <div className="routine-chips">
                                            {keys.map((id, i) => (
                                                <div key={i} className="routine-chip">
                                                    {resolveProduct(id, config.customProducts).kind}
                                                    <button onClick={() => updateRoutine(day, slot, keys.filter((_, idx) => idx !== i))}>×</button>
                                                </div>
                                            ))}
                                            <div className="add-step-btn" onClick={() => setPicker(pickerOpen ? null : { day, slot })}>
                                                + Add
                                            </div>
                                        </div>
                                        {pickerOpen && (
                                            <div className="product-picker">
                                                {eligible.length > 0 ? eligible.map(p => (
                                                    <div key={p.id} className="product-picker-item" onClick={() => {
                                                        updateRoutine(day, slot, [...keys, p.id]);
                                                        setPicker(null);
                                                    }}>{p.kind}</div>
                                                )) : <span style={{ fontSize: 11, color: 'var(--txm)' }}>All added</span>}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                );
            })}
        </div>
    );
};

/* ============================================================
   SETTINGS SCREEN
   ============================================================ */
const SettingsScreen = ({ config, setConfig, allData, setAllData, showToast = () => { }, localModRef, configModRef, prevAllDataRef }) => {
    const update = (patchOrFn) => setConfig(prev => {
        const cur = sanitizeConfig(prev);
        const patch = typeof patchOrFn === 'function' ? patchOrFn(cur) : patchOrFn;
        return sanitizeConfig({ ...cur, ...patch });
    });

    const [restoreMode, setRestoreMode] = useState('both'); // 'both' | 'data' | 'config'
    const [open, setOpen] = useState({ targets: true, skincare: false, routine: false, data: true });
    const [newProduct, setNewProduct] = useState({ kind: '', name: '', slot: 'both' });

    const toggle = (k) => setOpen(o => ({ ...o, [k]: !o[k] }));
    const SecHd = ({ label, k }) => (
        <div onClick={() => toggle(k)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', marginBottom: open[k] ? 14 : 0 }}>
            <h3 style={{ margin: 0 }}>{label}</h3>
            <span style={{ fontSize: 20, lineHeight: 1, color: 'var(--txm)', fontWeight: 300, userSelect: 'none' }}>{open[k] ? '−' : '+'}</span>
        </div>
    );
    const fileRef = useRef(null);

    const handleBackup = () => {
        const dayCount = Object.keys(allData || {}).length;
        const json = JSON.stringify({ data: allData, config, version: 2 }, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `form-backup-${todayKey()}.json`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast(`Backup downloaded (${dayCount} day${dayCount === 1 ? '' : 's'})`, 'success');
    };

    const isValidDateKey = (k) => /^\d{4}-\d{2}-\d{2}$/.test(k) && !isNaN(new Date(k + 'T12:00:00').getTime());

    const sanitizeRestoredData = (data) => {
        if (!data || typeof data !== 'object') return {};
        const clean = {};
        for (const k in data) {
            if (isValidDateKey(k)) clean[k] = data[k];
        }
        return sanitizeAllData(clean);
    };

    const handleRestore = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const parsed = JSON.parse(ev.target.result);
                if (!parsed.data || !parsed.config) { showToast('Invalid backup file', 'error'); return; }
                const ver = parsed.version || 1;
                if (ver > 2) { showToast('Backup is newer than app — update first', 'error'); return; }
                const now = Date.now();
                let summary = [];
                if (restoreMode === 'data' || restoreMode === 'both') {
                    const cleanData = sanitizeRestoredData(parsed.data);
                    if (prevAllDataRef) prevAllDataRef.current = {};
                    setAllData(cleanData);
                    localStorage.setItem('form_data_modified', String(now));
                    if (localModRef) localModRef.current = now;
                    Object.entries(cleanData).forEach(([day, dayData]) => {
                        sbUpsertR("routine_daily_logs", { log_date: day, data: dayData, modified_at: now }, `routine:day:${day}`);
                    });
                    summary.push(`${Object.keys(cleanData).length} days`);
                }
                if (restoreMode === 'config' || restoreMode === 'both') {
                    const mergedConfig = sanitizeConfig(parsed.config);
                    setConfig(mergedConfig);
                    localStorage.setItem('form_config_modified', String(now));
                    if (configModRef) configModRef.current = now;
                    sbUpsertR("user_config", { id: "singleton", data: mergedConfig, last_modified_at: String(now) }, "routine:user_config");
                    summary.push('config');
                }
                showToast(`Restored ${summary.join(' + ')}`, 'success');
            } catch { showToast('Could not read file', 'error'); }
        };
        reader.readAsText(file);
        e.target.value = '';
    };

    const [nukeStep, setNukeStep] = useState(0); // 0=idle, 1=confirming
    const [nukeText, setNukeText] = useState('');

    const handleNuke = () => {
        if (nukeStep === 0) { setNukeStep(1); setNukeText(''); return; }
        if (nukeText !== 'DELETE') return;
        localStorage.removeItem('form_data');
        localStorage.removeItem('form_config');
        localStorage.removeItem(BANNERS_KEY);
        localStorage.removeItem('form_data_modified');
        localStorage.removeItem('form_config_modified');
        sbDeleteAllDailyLogsR();
        sbDeleteR("daily_logs", "all_data");
        sbDeleteR("user_config", "singleton");
        if (prevAllDataRef) prevAllDataRef.current = {};
        setAllData({});
        setConfig(DEFAULT_CONFIG);
        setNukeStep(0);
        setNukeText('');
        showToast('All data cleared', 'warn');
    };

    return (
        <div className="screen">
            <div className="sky-header sky-settings">
                <div className="sky-cloud" style={{ width: 100, height: 30, top: 10, left: -10, background: 'rgba(255,255,255,0.4)' }} />
                <div className="sky-horizon" />
                <div className="sky-content">
                    <div className="sky-date-big">Settings</div>
                    <div className="sky-date-sub">Routine & data</div>
                </div>
            </div>
            <div className="body-pad">

                {/* Targets */}
                <div className="sec">
                    <SecHd label="Targets" k="targets" />
                    {open.targets && <>
                        <div className="set-row">
                            <div className="r">
                                <div>
                                    <div className="lbl">Water target</div>
                                    <div className="desc">Daily goal in litres</div>
                                </div>
                                <div className="stepper">
                                    <button onClick={() => update(c => ({ waterTarget: Math.max(1.5, c.waterTarget - 0.5) }))}>−</button>
                                    <div className="val">{config.waterTarget}L</div>
                                    <button onClick={() => update(c => ({ waterTarget: Math.min(5, c.waterTarget + 0.5) }))}>+</button>
                                </div>
                            </div>
                        </div>
                        <div className="set-row">
                            <div className="r">
                                <div>
                                    <div className="lbl">Calorie goal</div>
                                    <div className="desc">Daily kcal</div>
                                </div>
                                <div className="stepper">
                                    <button onClick={() => update(c => ({ calGoal: Math.max(800, (c.calGoal || 2000) - 100) }))}>−</button>
                                    <div className="val">{config.calGoal || 2000}</div>
                                    <button onClick={() => update(c => ({ calGoal: Math.min(5000, (c.calGoal || 2000) + 100) }))}>+</button>
                                </div>
                            </div>
                        </div>
                        <div className="set-row">
                            <div className="r">
                                <div>
                                    <div className="lbl">Protein goal</div>
                                    <div className="desc">Daily grams</div>
                                </div>
                                <div className="stepper">
                                    <button onClick={() => update(c => ({ proteinGoal: Math.max(20, (c.proteinGoal || 80) - 5) }))}>−</button>
                                    <div className="val">{config.proteinGoal || 80}g</div>
                                    <button onClick={() => update(c => ({ proteinGoal: Math.min(300, (c.proteinGoal || 80) + 5) }))}>+</button>
                                </div>
                            </div>
                        </div>
                        <div className="set-row">
                            <div className="r">
                                <div>
                                    <div className="lbl">Carbs goal</div>
                                    <div className="desc">Daily grams</div>
                                </div>
                                <div className="stepper">
                                    <button onClick={() => update(c => ({ carbsGoal: Math.max(50, (c.carbsGoal || 250) - 10) }))}>−</button>
                                    <div className="val">{config.carbsGoal || 250}g</div>
                                    <button onClick={() => update(c => ({ carbsGoal: Math.min(600, (c.carbsGoal || 250) + 10) }))}>+</button>
                                </div>
                            </div>
                        </div>
                        <div className="set-row">
                            <div className="r">
                                <div>
                                    <div className="lbl">Fat goal</div>
                                    <div className="desc">Daily grams</div>
                                </div>
                                <div className="stepper">
                                    <button onClick={() => update(c => ({ fatGoal: Math.max(20, (c.fatGoal || 65) - 5) }))}>−</button>
                                    <div className="val">{config.fatGoal || 65}g</div>
                                    <button onClick={() => update(c => ({ fatGoal: Math.min(200, (c.fatGoal || 65) + 5) }))}>+</button>
                                </div>
                            </div>
                        </div>
                    </>}
                </div>

                {/* Skincare */}
                <div className="sec">
                    <SecHd label="Skincare" k="skincare" />
                    {open.skincare && <>
                        {/* Product list */}
                        {(config.customProducts || []).filter(p => !p.archived).map((p) => (
                            <div key={p.id} className="set-row" style={{ marginBottom: 10, padding: '10px 12px', background: 'var(--bg2)', borderRadius: 10 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                                    <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: 0.4, padding: '2px 8px', borderRadius: 100, background: p.slot === 'am' ? 'var(--amber-sf)' : p.slot === 'pm' ? 'var(--teal-sf)' : 'var(--green-sf)', color: p.slot === 'am' ? 'var(--amber-deep)' : p.slot === 'pm' ? 'var(--teal-deep)' : 'var(--green-deep)', cursor: 'pointer', userSelect: 'none' }}
                                        onClick={() => {
                                            const next = p.slot === 'am' ? 'pm' : p.slot === 'pm' ? 'both' : 'am';
                                            update({ customProducts: config.customProducts.map(cp => cp.id === p.id ? { ...cp, slot: next } : cp) });
                                        }}>
                                        {p.slot === 'both' ? 'AM+PM' : p.slot.toUpperCase()}
                                    </span>
                                    <button style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--txd)', fontSize: 18, cursor: 'pointer', padding: '0 2px', lineHeight: 1 }}
                                        onClick={() => {
                                            update({ customProducts: config.customProducts.map(cp => cp.id === p.id ? { ...cp, archived: true } : cp) });
                                            showToast(`${p.name || p.kind} archived`, 'info');
                                        }}>×</button>
                                </div>
                                <input className="inp" style={{ marginBottom: 6 }} placeholder="Type (e.g. Retinol)" value={p.kind}
                                    onChange={(e) => update({ customProducts: config.customProducts.map(cp => cp.id === p.id ? { ...cp, kind: e.target.value } : cp) })} />
                                <input className="inp" placeholder="Brand name" value={p.name}
                                    onChange={(e) => update({ customProducts: config.customProducts.map(cp => cp.id === p.id ? { ...cp, name: e.target.value } : cp) })} />
                            </div>
                        ))}

                        {/* Add product */}
                        <div className="set-row" style={{ padding: '10px 12px', background: 'var(--bg2)', borderRadius: 10, marginBottom: 10 }}>
                            <div className="lbl" style={{ marginBottom: 8 }}>Add product</div>
                            <input className="inp" style={{ marginBottom: 6 }} placeholder="Type (e.g. Vitamin C)" value={newProduct.kind}
                                onChange={(e) => setNewProduct(np => ({ ...np, kind: e.target.value }))} />
                            <input className="inp" style={{ marginBottom: 8 }} placeholder="Brand name (optional)" value={newProduct.name}
                                onChange={(e) => setNewProduct(np => ({ ...np, name: e.target.value }))} />
                            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                                {['am', 'pm', 'both'].map(s => (
                                    <div key={s} onClick={() => setNewProduct(np => ({ ...np, slot: s }))}
                                        style={{ flex: 1, textAlign: 'center', padding: '5px 0', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer', background: newProduct.slot === s ? (s === 'am' ? 'var(--amber-sf)' : s === 'pm' ? 'var(--teal-sf)' : 'var(--green-sf)') : 'var(--sf)', border: '1px solid var(--bd)', color: newProduct.slot === s ? (s === 'am' ? 'var(--amber-deep)' : s === 'pm' ? 'var(--teal-deep)' : 'var(--green-deep)') : 'var(--txm)' }}>
                                        {s === 'both' ? 'AM+PM' : s.toUpperCase()}
                                    </div>
                                ))}
                            </div>
                            <button className="btn" style={{ marginTop: 0 }} onClick={() => {
                                const kind = newProduct.kind.trim();
                                if (!kind) { showToast('Enter a product type first', 'error'); return; }
                                const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
                                const finalName = newProduct.name.trim() || kind;
                                update({ customProducts: [...(config.customProducts || []), { id, kind, name: finalName, slot: newProduct.slot }] });
                                setNewProduct({ kind: '', name: '', slot: 'both' });
                                showToast(`${finalName} added`, 'success');
                            }}>Add product</button>
                        </div>

                        <div className="set-row">
                            <div className="r">
                                <div>
                                    <div className="lbl">Show product names</div>
                                    <div className="desc">Off = show step types only</div>
                                </div>
                                <div className={`toggle ${config.showProductNames ? 'on' : ''}`} onClick={() => update({ showProductNames: !config.showProductNames })} />
                            </div>
                        </div>

                        <div className="set-row">
                            <div className="r">
                                <div>
                                    <div className="lbl">Vibration on tap</div>
                                    <div className="desc">Off saves battery</div>
                                </div>
                                <div className={`toggle ${(localStorage.getItem('form_haptic_off') !== '1') ? 'on' : ''}`}
                                    onClick={() => {
                                        const cur = localStorage.getItem('form_haptic_off');
                                        const turningOff = cur !== '1';
                                        localStorage.setItem('form_haptic_off', turningOff ? '1' : '0');
                                        setConfig(c => ({ ...c })); // force re-render
                                        showToast(turningOff ? 'Vibration off' : 'Vibration on', 'info');
                                    }} />
                            </div>
                        </div>
                    </>}
                </div>

                {/* Skin routine */}
                <div className="sec">
                    <SecHd label="Skin routine" k="routine" />
                    {open.routine && <RoutineEditor config={config} setConfig={setConfig} />}
                </div>

                {/* Data */}
                <div className="sec">
                    <SecHd label="Data" k="data" />
                    {open.data && <>
                        <div style={{ fontSize: 11, color: 'var(--txm)', fontFamily: 'var(--mono, monospace)', marginBottom: 8 }}>
                            {(() => {
                                const m = parseInt(localStorage.getItem('form_data_modified') || '0', 10);
                                if (!m) return 'Not synced yet';
                                const ago = Math.floor((Date.now() - m) / 1000);
                                if (ago < 60) return `Saved ${ago}s ago`;
                                if (ago < 3600) return `Saved ${Math.floor(ago / 60)}m ago`;
                                return `Saved ${Math.floor(ago / 3600)}h ago`;
                            })()}
                        </div>
                        <button className="btn ghost" onClick={handleBackup}>Backup data</button>
                        <input ref={fileRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleRestore} />
                        <div style={{ display: 'flex', gap: 6, marginTop: 8, fontSize: 11 }}>
                            {['both', 'data', 'config'].map(m => (
                                <button key={m} onClick={() => setRestoreMode(m)}
                                    style={{
                                        flex: 1, padding: '6px 8px', borderRadius: 6,
                                        border: '1px solid var(--bd)', cursor: 'pointer',
                                        background: restoreMode === m ? 'var(--tx)' : 'var(--bg2)',
                                        color: restoreMode === m ? 'var(--bg)' : 'var(--tx)',
                                        fontFamily: 'var(--mono, monospace)', textTransform: 'uppercase'
                                    }}>{m}</button>
                            ))}
                        </div>
                        <button className="btn ghost" style={{ marginTop: 8 }} onClick={() => fileRef.current && fileRef.current.click()}>
                            Restore ({restoreMode})
                        </button>

                        {nukeStep === 0 ? (
                            <button className="btn danger" onClick={handleNuke} style={{ marginTop: 8 }}>
                                Clear all data
                            </button>
                        ) : (
                            <div style={{ marginTop: 8, background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 'var(--rsm)', padding: '14px' }}>
                                <div style={{ fontSize: 13, fontWeight: 600, color: '#991b1b', marginBottom: 4 }}>Clear all data?</div>
                                <div style={{ fontSize: 12, color: '#b91c1c', marginBottom: 8 }}>This will permanently delete all your tracked days and reset settings. Cannot be undone.</div>
                                <div style={{ fontSize: 11, color: '#7f1d1d', marginBottom: 6 }}>Type <strong>DELETE</strong> to confirm:</div>
                                <input
                                    value={nukeText}
                                    onChange={(e) => setNukeText(e.target.value)}
                                    placeholder="DELETE"
                                    autoCapitalize="characters"
                                    style={{ width: '100%', padding: '8px 10px', border: '1px solid #fca5a5', borderRadius: 6, marginBottom: 10, fontSize: 13, fontFamily: 'var(--mono, monospace)' }}
                                />
                                <div style={{ display: 'flex', gap: 8 }}>
                                    <button
                                        onClick={handleNuke}
                                        disabled={nukeText !== 'DELETE'}
                                        style={{ flex: 1, background: nukeText === 'DELETE' ? '#dc2626' : '#fca5a5', color: '#fff', border: 'none', borderRadius: 8, padding: '10px', fontSize: 13, fontWeight: 600, cursor: nukeText === 'DELETE' ? 'pointer' : 'not-allowed' }}
                                    >
                                        Yes, clear everything
                                    </button>
                                    <button
                                        onClick={() => { setNukeStep(0); setNukeText(''); }}
                                        style={{ flex: 1, background: 'var(--bg2)', color: 'var(--tx)', border: '1px solid var(--bd)', borderRadius: 8, padding: '10px', fontSize: 13, cursor: 'pointer' }}
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        )}
                    </>}
                </div>
            </div>
        </div>
    );
};

/* ============================================================
   APP
   ============================================================ */
export default function RoutineApp({ darkMode = false, onTabChange }) {
    const [allData, setAllData] = useState(loadData);
    const [config, setConfig] = useState(loadConfig);
    const [activeTab, setActiveTab] = useState('food');
    const [toast, setToast] = useState(null);

    const handleTabChange = (t) => { setActiveTab(t); if (onTabChange) onTabChange(t); };

    useEffect(() => {
        const el = document.getElementById('nomad-routine');
        if (el) el.classList.toggle('dark', !!darkMode);
    }, [darkMode]);

    const [sbLoaded, setSbLoaded] = useState(false);
    const [syncStatus, setSyncStatus] = useState(''); // '', 'syncing', 'synced', 'conflict'
    const localModRef = useRef(parseInt(localStorage.getItem('form_data_modified') || '0', 10));
    const configModRef = useRef(parseInt(localStorage.getItem('form_config_modified') || '0', 10));
    const dataDebounceRef = useRef(null);
    const configDebounceRef = useRef(null);
    const prevAllDataRef = useRef({});

    // Load from Supabase on mount, fall back to localStorage. Conflict-aware.
    useEffect(() => {
        const load = async () => {
            const [dailyRows, oldBlob, dbConfig] = await Promise.all([
                sbGetAllDailyLogsR(),
                sbGetR("daily_logs", "all_data"),
                sbGetR("user_config", "singleton"),
            ]);
            let resolvedData = null;
            if (dailyRows.length > 0) {
                // New per-day table has data — use it
                const remoteMod = dailyRows.reduce((mx, r) => Math.max(mx, parseInt(r.modified_at || '0', 10)), 0);
                const localMod = localModRef.current;
                if (remoteMod >= localMod || localMod === 0) {
                    const merged = {};
                    dailyRows.forEach(row => { merged[row.log_date] = row.data; });
                    const cleanData = sanitizeAllData(merged);
                    setAllData(cleanData);
                    prevAllDataRef.current = cleanData;
                    localStorage.setItem('form_data', JSON.stringify(cleanData));
                    localStorage.setItem('form_data_modified', String(remoteMod || Date.now()));
                    localModRef.current = remoteMod || Date.now();
                    resolvedData = merged;
                } else {
                    setSyncStatus('conflict');
                    setTimeout(() => setSyncStatus(''), 4000);
                }
            } else if (oldBlob?.data) {
                // Migrate: old single-blob table has data, new table is empty
                const remoteMod = parseInt(oldBlob.last_modified_at || '0', 10);
                const localMod = localModRef.current;
                if (remoteMod >= localMod || localMod === 0) {
                    const cleanData = sanitizeAllData(oldBlob.data);
                    setAllData(cleanData);
                    prevAllDataRef.current = cleanData;
                    localStorage.setItem('form_data', JSON.stringify(cleanData));
                    localStorage.setItem('form_data_modified', String(remoteMod || Date.now()));
                    localModRef.current = remoteMod || Date.now();
                    resolvedData = oldBlob.data;
                    // Migrate each day to new table
                    const migTs = remoteMod || Date.now();
                    Object.entries(cleanData).forEach(([day, dayData]) => {
                        sbUpsertR("routine_daily_logs", { log_date: day, data: dayData, modified_at: migTs }, `routine:day:${day}`);
                    });
                } else {
                    setSyncStatus('conflict');
                    setTimeout(() => setSyncStatus(''), 4000);
                }
            }
            if (dbConfig?.data) {
                try {
                    const remoteMod = parseInt(dbConfig.last_modified_at || '0', 10);
                    const localMod = configModRef.current;
                    if (remoteMod >= localMod || localMod === 0) {
                        let merged = sanitizeConfig(dbConfig.data);
                        if (resolvedData) merged = sanitizeConfigWithData(merged, resolvedData);
                        setConfig(merged);
                        localStorage.setItem('form_config', JSON.stringify(merged));
                        localStorage.setItem('form_config_modified', String(remoteMod || Date.now()));
                        configModRef.current = remoteMod || Date.now();
                    }
                } catch { }
            }
            setSbLoaded(true);
        };
        load();
    }, []);

    useEffect(() => {
        if (!sbLoaded) return;
        const cleanData = sanitizeAllData(allData);
        const now = Date.now();
        localStorage.setItem('form_data', JSON.stringify(cleanData));
        localStorage.setItem('form_data_modified', String(now));
        localModRef.current = now;
        const prevData = prevAllDataRef.current;
        const changedDays = Object.keys(cleanData).filter(k => JSON.stringify(cleanData[k]) !== JSON.stringify(prevData[k]));
        prevAllDataRef.current = cleanData;
        if (changedDays.length === 0) return;
        if (dataDebounceRef.current) clearTimeout(dataDebounceRef.current);
        dataDebounceRef.current = setTimeout(() => {
            changedDays.forEach(day => {
                sbUpsertR("routine_daily_logs", { log_date: day, data: cleanData[day], modified_at: now }, `routine:day:${day}`);
            });
        }, 1500);
    }, [allData, sbLoaded]);

    useEffect(() => {
        if (!sbLoaded) return;
        const cleanConfig = sanitizeConfig(config);
        const now = Date.now();
        localStorage.setItem('form_config', JSON.stringify(cleanConfig));
        localStorage.setItem('form_config_modified', String(now));
        configModRef.current = now;
        if (configDebounceRef.current) clearTimeout(configDebounceRef.current);
        configDebounceRef.current = setTimeout(() => {
            sbUpsertR("user_config", { id: "singleton", data: cleanConfig, last_modified_at: String(now) }, "routine:user_config");
        }, 1500);
    }, [config, sbLoaded]);

    const key = todayKey();
    const rawDay = allData[key] || {};
    const day = sanitizeDayRecord(rawDay);
    const updateDay = (patchOrFn) => setAllData(prev => {
        const cur = { ...DEFAULT_DAY, ...(prev[key] || {}) };
        const patch = typeof patchOrFn === 'function' ? patchOrFn(cur) : patchOrFn;
        return { ...prev, [key]: { ...cur, ...patch } };
    });

    const { foodStreak, skinStreak } = useMemo(() => {
        const foodDayLevel = (d) => { if (!d) return 0; let pts = 0; if (d.morningWater) pts++; const mwL = effectiveMorningWater(d); if ((mwL + (d.water || 0)) >= config.waterTarget) pts++; return pts; };
        const skinDayLevel = (d) => { if (!d) return 0; return (d.amSkinDone ? 1 : 0) + (d.pmSkinDone ? 1 : 0); };
        const countStreak = (levelFn, pastThreshold = 2) => { let s = 0; const d = new Date(); const todayK = todayKey(d); if (allData[todayK] && levelFn(allData[todayK]) >= 1) s = 1; d.setDate(d.getDate() - 1); let safety = 0; while (safety < 5000) { const rec = allData[todayKey(d)]; if (rec && levelFn(rec) >= pastThreshold) { s++; d.setDate(d.getDate() - 1); safety++; } else break; } return s; };
        return { foodStreak: countStreak(foodDayLevel, 1), skinStreak: countStreak(skinDayLevel, 2) };
    }, [allData, config]);

    const onComplete = (type) => {
        const banners = getBanners();
        const todayStr = todayKey();
        const bKey = type === 'food' ? 'foodBannerShown' : 'skinBannerShown';
        if (banners[bKey] === todayStr) return;
        banners[bKey] = todayStr;
        localStorage.setItem(BANNERS_KEY, JSON.stringify(banners));
        const id = Date.now();
        setToast({ type, id });
        setTimeout(() => setToast(prev => (prev && prev.id === id ? null : prev)), 2500);
    };

    // Generic toast for action confirmations (nuke, backup, add/delete custom items, etc.)
    const showToast = (msg, variant = 'info') => {
        const id = Date.now() + Math.random();
        setToast({ msg, variant, id });
        setTimeout(() => setToast(prev => (prev && prev.id === id ? null : prev)), 2500);
    };

    return (
        <div id="nomad-routine">
            <div className="app" data-tab={activeTab}>
                {activeTab === 'food' && <FoodScreen day={day} update={updateDay} config={config} onComplete={onComplete} streak={foodStreak} showToast={showToast} />}
                {activeTab === 'skin' && <SkinScreen day={day} update={updateDay} config={config} onComplete={onComplete} streak={skinStreak} />}
                {activeTab === 'log' && <LogScreen allData={allData} config={config} />}
                {activeTab === 'settings' && <SettingsScreen config={config} setConfig={setConfig} allData={allData} setAllData={setAllData} showToast={showToast} localModRef={localModRef} configModRef={configModRef} prevAllDataRef={prevAllDataRef} />}

                {toast && (
                    <div
                        key={toast.id}
                        style={{
                            position: 'fixed',
                            top: 14,
                            left: '50%',
                            transform: 'translateX(-50%)',
                            zIndex: 300,
                            animation: 'toastPill 2.5s ease forwards',
                            pointerEvents: 'none',
                            maxWidth: '90vw',
                        }}
                    >
                        <div style={{
                            padding: '10px 18px',
                            borderRadius: 18,
                            background: toast.msg
                                ? (toast.variant === 'error' ? '#D4726A'
                                    : toast.variant === 'success' ? 'var(--green, #6BAA75)'
                                        : toast.variant === 'warn' ? '#E07A5F'
                                            : '#7B8CDE')
                                : (toast.type === 'food' ? 'var(--green)' : 'var(--teal)'),
                            color: '#fff',
                            fontSize: 13,
                            fontWeight: 500,
                            lineHeight: 1.4,
                            wordBreak: 'break-word',
                            textAlign: 'center',
                            boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
                            fontFamily: 'var(--font)',
                        }}>
                            {toast.msg
                                ? toast.msg
                                : (toast.type === 'food' ? 'Food ritual complete ✓' : 'Skin ritual complete ✓')}
                        </div>
                    </div>
                )}

                <nav className="nav">
                    {[['food', 'Food'], ['skin', 'Skin'], ['log', 'Log'], ['settings', 'Settings']].map(([k, l]) => (
                        <button key={k} className={activeTab === k ? `active ${k}` : ''} onClick={() => handleTabChange(k)}>
                            <Icon name={k} />
                            {l}
                        </button>
                    ))}
                </nav>
            </div>
        </div>
    );
}