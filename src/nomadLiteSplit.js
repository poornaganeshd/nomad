/*
 * Pure logic + helpers for NOMAD Lite presets. Kept in a plain module (no JSX
 * exports) so it is unit-testable and so NomadLite.jsx can stay a
 * components-only file (react-refresh/only-export-components).
 *
 * No side effects beyond the explicit localStorage load helper.
 */

export const LS_KEY = "nomad-lite-v1";

export const AVATAR_COLORS = ["#E07A5F", "#C9A84C", "#5B7C99", "#2F6F62", "#8E5B4B", "#C2645F"];
export const GROUP_COLORS = ["#E07A5F", "#F2895F", "#C2451F", "#E0A75A", "#D9712E", "#B6431F"];

export const uid = (p) => p + (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10));

export function avatarColor(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 9973;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
export function groupColor(idx) { return GROUP_COLORS[idx % GROUP_COLORS.length]; }
export function initials(name) {
  const p = String(name || "").trim().split(/\s+/);
  return ((p[0]?.[0] || "") + (p[1]?.[0] || "")).toUpperCase() || "?";
}
export function fmt(n) {
  if (!isFinite(n)) n = 0;
  n = Math.round(n * 100) / 100;
  return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function pctFmt(n) { return (Math.round(n * 10) / 10) + "%"; }

export const DEFAULT_STATE = {
  scenarioName: "",
  totalBill: "",
  baseBill: "",
  baseTouched: false,
  mode: "auto", // auto | manual
  manualExtra: "",
  baseRate: "105",
  people: [],
  baseMembers: [],
  groups: [],
};

export function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const p = JSON.parse(raw);
    return {
      ...DEFAULT_STATE,
      ...p,
      people: Array.isArray(p.people) ? p.people : [],
      baseMembers: Array.isArray(p.baseMembers) ? p.baseMembers : [],
      groups: Array.isArray(p.groups) ? p.groups.map(g => ({ ...g, members: Array.isArray(g.members) ? g.members : [] })) : [],
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

// Pure split computation. `s` is the persisted state shape above.
export function computeSplit(s, { evenSplit = false } = {}) {
  const people = s.people || [];
  const baseMembers = new Set(s.baseMembers || []);
  const total = Number(s.totalBill) || 0;

  if (evenSplit) {
    const per = people.length ? total / people.length : 0;
    const perPersonTotal = {};
    people.forEach(p => { perPersonTotal[p.id] = per; });
    return { evenSplit: true, total, base: 0, extra: total, basePerPerson: 0, baseParticipants: [...people], groupBreak: [], perPersonExtra: {}, perPersonTotal, rawTotalPct: 0, normalized: false, allocatedExtra: 0, unallocated: 0 };
  }

  const base = Number(s.baseBill) || 0;
  const extra = s.mode === "auto" ? Math.max(0, total - base) : Math.max(0, Number(s.manualExtra) || 0);
  const baseParticipants = people.filter(p => baseMembers.has(p.id));
  const basePerPerson = baseParticipants.length ? base / baseParticipants.length : 0;
  const rawTotalPct = (s.groups || []).reduce((t, g) => t + (Number(g.pct) || 0), 0);
  const normalized = rawTotalPct > 0 && Math.round(rawTotalPct) !== 100;
  const scale = rawTotalPct > 0 ? 100 / rawTotalPct : 1;

  const perPersonExtra = {};
  people.forEach(p => { perPersonExtra[p.id] = 0; });
  const groupBreak = (s.groups || []).map((g, idx) => {
    const effPct = (Number(g.pct) || 0) * scale;
    const amt = extra * effPct / 100;
    const members = people.filter(p => (g.members || []).includes(p.id));
    const share = members.length ? amt / members.length : 0;
    members.forEach(p => { perPersonExtra[p.id] += share; });
    return { ...g, effPct, amt, share, memberCount: members.length, color: groupColor(idx) };
  });

  const perPersonTotal = {};
  people.forEach(p => { perPersonTotal[p.id] = (baseMembers.has(p.id) ? basePerPerson : 0) + perPersonExtra[p.id]; });
  const allocatedExtra = groupBreak.reduce((t, g) => t + g.amt, 0);
  const unallocated = (s.groups || []).length === 0 ? extra : Math.max(0, extra - allocatedExtra);
  return { evenSplit: false, total, base, extra, basePerPerson, baseParticipants, groupBreak, perPersonExtra, perPersonTotal, rawTotalPct, normalized, allocatedExtra, unallocated };
}
