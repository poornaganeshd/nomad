import { useState, useEffect, useMemo, useRef } from "react";
import { FilmSlate, ForkKnife, Airplane, GameController, ShoppingCart, MusicNote, Trophy, Confetti, BookOpen, Briefcase, Warning } from "@phosphor-icons/react";
import { ComposedChart, Bar, Line, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, CartesianGrid } from "recharts";
import RoutineApp from "./Routine";
import { flushSyncQueue, getPendingSyncCount, sendSupabaseRequest, subscribePendingSync, subscribeSyncDrops } from "./offlineSync";
import { checkBillReminders } from "./billReminders";
import { getExchangeRate, saveCurrencyMeta, getCurrencyMeta } from "./currencyConverter";
import ReceiptPicker from "./ReceiptPicker";
import CredentialSetup from "./CredentialSetup";
import { getCredentials } from "./credentials";
import {
  roundMoney, localDateKey, fullMonthsBetween, fullYearsBetween,
  getRecurringAnchorDate, getRecurringDueDate, isRecurringDueToday,
  recurringDaysOverdue, distributeAmount,
} from "./financeUtils";
const APP = "NOMAD", CUR = "₹";
// Use crypto.randomUUID() when available (all modern browsers + Node 14.17+).
// Falls back to a longer random suffix than the previous 4 chars to keep
// collision odds astronomically low even under offline-replay bursts.
const uid = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
};

// Supabase config — localStorage credentials take priority over build-time env vars
const _creds = getCredentials();
const SB_URL = _creds.sbUrl || import.meta.env.VITE_SUPABASE_URL || "";
const SB_KEY = _creds.sbKey || import.meta.env.VITE_SUPABASE_ANON_KEY || "";
const SB_ENABLED = Boolean(_creds.sbUrl && _creds.sbKey);
const sbH = SB_ENABLED ? { "Content-Type": "application/json", "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` } : {};
const needsSetup = !_creds.sbUrl;
const FETCH_TIMEOUT_MS = 8000;
const isoDate = (date) => localDateKey(date);
const dateOnly = (value) => new Date(`${value}T00:00:00`);
const lastDayOfMonth = (year, monthIndex) => new Date(year, monthIndex + 1, 0).getDate();
const withClampedDay = (year, monthIndex, desiredDay) => new Date(year, monthIndex, Math.min(Math.max(1, desiredDay || 1), lastDayOfMonth(year, monthIndex)));
const fetchWithTimeout = async (url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
};
const loadLocalBackup = ({ sEx, sInc, sTr, sStl, sCats, sIsrc, sSp, sRec, sEvs, sDm, sWsb, sRecCats }) => {
  try {
    const r = localStorage.getItem("nomad-v5"); if (!r) return;
    const d = JSON.parse(r);
    if (d.expenses) sEx(d.expenses); if (d.incomes) sInc(d.incomes); if (d.transfers) sTr(d.transfers);
    if (d.settlements) sStl(d.settlements); if (d.categories?.length) sCats(d.categories);
    if (d.incomeSources?.length) sIsrc(d.incomeSources); if (d.splits) sSp(d.splits);
    if (d.recurring) sRec(d.recurring); if (d.events) sEvs(d.events); if (d.darkMode !== undefined) sDm(d.darkMode);
    if (d.walletStartBal) sWsb(d.walletStartBal);
    if (d.recCats?.length) sRecCats(d.recCats);
  } catch { }
};
// ── Optimistic-concurrency version cache ─────────────────────────────────────
// Stores the server-stamped updated_at for each row so edits can send
// If-Unmodified-Since and get a 412 if another device wrote first.
const VERSIONS_KEY = "nomad-record-versions-v1";
const saveVersions = (table, rows) => {
  try {
    const store = JSON.parse(localStorage.getItem(VERSIONS_KEY) || "{}");
    rows.forEach(r => { if (r.id && r.updated_at) store[`${table}:${r.id}`] = r.updated_at; });
    localStorage.setItem(VERSIONS_KEY, JSON.stringify(store));
  } catch { /* storage unavailable or quota exceeded — safe to skip */ }
};
const getVersion = (table, id) => {
  try {
    const store = JSON.parse(localStorage.getItem(VERSIONS_KEY) || "{}");
    return store[`${table}:${id}`] ?? null;
  } catch { return null; }
};
// ─────────────────────────────────────────────────────────────────────────────

const sbGet = async (table) => {
  if (!SB_ENABLED) return null;
  try {
    const r = await fetchWithTimeout(`${SB_URL}/rest/v1/${table}?select=*&deleted_at=is.null`, { headers: sbH });
    if (r.ok) { const rows = await r.json(); saveVersions(table, rows); return rows; }
    if (r.status === 400) {
      // deleted_at column not yet migrated — fall back to unfiltered
      const r2 = await fetchWithTimeout(`${SB_URL}/rest/v1/${table}?select=*`, { headers: sbH });
      if (!r2.ok) { console.error("sbGet fail", table, r2.status); return null; }
      return r2.json();
    }
    console.error("sbGet fail", table, r.status);
    return null;
  } catch {
    return null;
  }
};
const sbWrite = async (path, { method = "POST", body, dedupeKey, extraHeaders = {} } = {}) => {
  if (!SB_ENABLED) return { ok: false, queued: false, offline: false, response: null };
  const result = await sendSupabaseRequest({
    path,
    method,
    headers: method === "POST" ? { ...sbH, "Prefer": "resolution=merge-duplicates,return=minimal", ...extraHeaders } : { ...sbH, ...extraHeaders },
    body: body ? JSON.stringify(body) : null,
    dedupeKey,
  });
  if (!result.ok && !result.queued && result.response) result.response.text().then(t => console.error("sbWrite fail", path, result.response.status, t));
  return result;
};
const sbUpsert = async (table, rows, dedupeKey = null, extraHeaders = {}) => sbWrite(`${SB_URL}/rest/v1/${table}`, { method: "POST", body: rows, dedupeKey, extraHeaders });
const sbDelete = async (table, id) => sbWrite(`${SB_URL}/rest/v1/${table}?id=eq.${id}`, { method: "PATCH", body: { deleted_at: new Date().toISOString() }, dedupeKey: `${table}:delete:${id}` });
const sbGetDeleted = async (table) => {
  if (!SB_ENABLED) return null;
  try {
    const since = new Date(Date.now() - 30 * 864e5).toISOString();
    const r = await fetchWithTimeout(`${SB_URL}/rest/v1/${table}?deleted_at=not.is.null&deleted_at=gte.${since}&select=*&order=deleted_at.desc`, { headers: sbH });
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
};
const sbDeleteWhere = async (table, filter) => sbWrite(`${SB_URL}/rest/v1/${table}?${filter}`, { method: "DELETE", dedupeKey: `${table}:delete:${filter}` });
const fmt = n => CUR + (Number(n) || 0).toLocaleString("en-IN"), mk = d => d.slice(0, 7);
const ml = k => { const [y, m] = k.split("-"); return new Date(y, m - 1).toLocaleDateString("en-US", { month: "short", year: "numeric" }) };
const dl = d => { const t = localDateKey(), y = localDateKey(new Date(Date.now() - 864e5)); return d === t ? "Today" : d === y ? "Yesterday" : new Date(d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) };
const ls = { fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "1.2px", marginBottom: 6, display: "block", fontFamily: "var(--font-h)", fontWeight: 600 };
const is = { background: "var(--card)", border: "1.5px solid var(--border)", borderRadius: 10, padding: "11px 14px", color: "var(--text)", fontSize: 14, fontFamily: "var(--font-b)", outline: "none", width: "100%", boxSizing: "border-box" };
const isFix = e => !!(e.recurring === true || (e.note && e.note.endsWith(" (recurring)")));

const WALLETS = [{ id: "upi_lite", name: "UPI Lite", desc: "online · ₹5000 cap", color: "#00D4FF", neon: "#00E5FF" }, { id: "bank", name: "Bank", desc: "main account", color: "#34D399", neon: "#6EE7B7" }, { id: "cash", name: "Cash", desc: "physical money", color: "#FBBF24", neon: "#FDE68A" }];
const IW = WALLETS.filter(w => w.id !== "upi_lite");
const DC = [{ id: "food", name: "Food & Drinks", color: "#FF6B35", neon: "#FF9F1C" }, { id: "transport", name: "Transport", color: "#00D4FF", neon: "#00E5FF" }, { id: "rent", name: "Rent & Bills", color: "#A78BFA", neon: "#C4B5FD" }, { id: "entertainment", name: "Entertainment", color: "#F472B6", neon: "#FF8ED4" }, { id: "health", name: "Health", color: "#34D399", neon: "#6EE7B7" }, { id: "coffee", name: "Coffee / Snacks", color: "#FBBF24", neon: "#FDE68A" }, { id: "personal", name: "Personal Care", color: "#E879F9", neon: "#F0ABFC" }];
const DI = [{ id: "allowance", name: "Allowance", color: "#34D399", neon: "#6EE7B7" }, { id: "gifts", name: "Gifts", color: "#FF6B35", neon: "#FF9F1C" }, { id: "investments", name: "Investments", color: "#00D4FF", neon: "#00E5FF" }];
const RC = [{ id: "rent", name: "Rent / PG", color: "#A78BFA", neon: "#C4B5FD" }, { id: "emi", name: "EMI", color: "#F472B6", neon: "#FF8ED4" }, { id: "sip", name: "SIP / MF", color: "#34D399", neon: "#6EE7B7" }, { id: "insurance", name: "Insurance", color: "#00D4FF", neon: "#00E5FF" }, { id: "recharge", name: "Phone Recharge", color: "#FBBF24", neon: "#FDE68A" }, { id: "ott", name: "OTT / Subscriptions", color: "#E879F9", neon: "#F0ABFC" }, { id: "utilities", name: "Electricity / Bills", color: "#FF6B35", neon: "#FF9F1C" }, { id: "other_rec", name: "Other", color: "#8A8A9A", neon: "#A0A0B0" }];

function DI2({ id, accent: A, size: sz = 18 }) {
  const N = A || "#22D3EE", p = { viewBox: "0 0 24 24", width: sz, height: sz, fill: "none" }, l = { stroke: N, strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" }, d = { ...l, opacity: 0.65 };
  switch (id) {
    case "food": return <svg {...p}><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"{...l} /><path d="M7 2v20"{...l} /><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3zm0 0v7"{...l} /></svg>;
    case "transport": return <svg {...p}><rect x="3" y="7" width="18" height="10" rx="2"{...l} /><circle cx="7.5" cy="17" r="2"{...l} /><circle cx="16.5" cy="17" r="2"{...l} /><path d="M5.5 7L7 3h10l1.5 4"{...d} /></svg>;
    case "rent": return <svg {...p}><path d="M3 10l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"{...l} /><polyline points="9 22 9 13 15 13 15 22"{...d} /></svg>;
    case "entertainment": return <svg {...p}><rect x="2" y="6" width="20" height="12" rx="2"{...l} /><line x1="6" y1="12" x2="10" y2="12"{...d} /><line x1="8" y1="10" x2="8" y2="14"{...d} /><circle cx="16" cy="10.5" r="1.5" fill={N} stroke="none" opacity="0.7" /><circle cx="18.5" cy="13" r="1.5" fill={N} stroke="none" opacity="0.4" /></svg>;
    case "health": return <svg {...p}><rect x="4" y="8" width="16" height="13" rx="2"{...l} /><path d="M8 2h8v6H8z"{...d} /><line x1="10" y1="14.5" x2="14" y2="14.5"{...l} /><line x1="12" y1="12.5" x2="12" y2="16.5"{...l} /></svg>;
    case "coffee": return <svg {...p}><path d="M17 8h1a4 4 0 0 1 0 8h-1"{...d} /><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"{...l} /><line x1="6" y1="2" x2="6" y2="5"{...l} opacity="0.6" /><line x1="10" y1="2" x2="10" y2="5"{...l} opacity="0.6" /><line x1="14" y1="2" x2="14" y2="5"{...l} opacity="0.6" /></svg>;
    case "personal": return <svg {...p}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"{...l} /><circle cx="12" cy="7" r="4"{...l} /></svg>;
    case "upi_lite": return <svg {...p}><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"{...l} /></svg>;
    case "bank": return <svg {...p}><path d="M3 21h18"{...l} /><path d="M3 10h18"{...l} /><path d="M12 2L2 10h20L12 2z"{...l} /><rect x="5" y="10" width="3" height="8"{...d} /><rect x="10.5" y="10" width="3" height="8"{...d} /><rect x="16" y="10" width="3" height="8"{...d} /></svg>;
    case "cash": return <svg {...p}><rect x="2" y="4" width="20" height="16" rx="2"{...l} /><circle cx="12" cy="12" r="4"{...d} /><circle cx="12" cy="12" r="1.5" fill={N} stroke="none" opacity="0.7" /></svg>;
    case "allowance": return <svg {...p}><path d="M12 2v20"{...l} /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"{...l} /></svg>;
    case "gifts": return <svg {...p}><rect x="3" y="8" width="18" height="14" rx="2"{...l} /><path d="M12 8v14"{...d} /><path d="M3 14h18"{...d} /><path d="M7.5 8C6 6.5 6 4 8 3s3.5 2.5 4 5"{...l} /><path d="M16.5 8c1.5-1.5 1.5-4-.5-5s-3.5 2.5-4 5"{...l} /></svg>;
    case "investments": return <svg {...p}><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"{...l} /><polyline points="16 7 22 7 22 13"{...l} /></svg>;
    case "emi": return <svg {...p}><rect x="2" y="5" width="20" height="14" rx="2"{...l} /><line x1="2" y1="10" x2="22" y2="10"{...d} /><line x1="6" y1="15" x2="10" y2="15"{...d} /></svg>;
    case "sip": return <svg {...p}><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"{...l} /><polyline points="16 7 22 7 22 13"{...l} /></svg>;
    case "recharge": return <svg {...p}><rect x="5" y="2" width="14" height="20" rx="2"{...l} /><line x1="9" y1="7" x2="15" y2="7"{...d} /><path d="M11 14l-2 4h4l-2 4"{...l} /></svg>;
    case "ott": return <svg {...p}><rect x="2" y="6" width="20" height="12" rx="2"{...l} /><path d="M8 10l4 4 4-4"{...d} /></svg>;
    case "utilities": return <svg {...p}><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"{...l} /></svg>;
    case "other_rec": return <svg {...p}><circle cx="12" cy="12" r="9"{...l} /><line x1="12" y1="8" x2="12" y2="12"{...l} /><circle cx="12" cy="16" r="1" fill={N} stroke="none" /></svg>;
    default: return <span style={{ fontSize: sz * 0.9 }}>📁</span>
  }
}

const TIPS = ["Track every chai! Small spends add up.", "Saving ₹50/day = ₹1500/month!", "Review your week every Sunday!", "Needs vs wants — ask first!", "You're doing great!", "Set a weekly food budget!", "Unsubscribe unused stuff!", "Cook at home more!"];
const LH = ["Roarrr! Saving well!", "Budget king!", "Income > spending!", "Proud of you!", "Wallet smiling!"];
const LS = ["Spending > income…", "Tighten the belt.", "Slow down a bit.", "Cut one expense!", "Ramen week? Got this."];

function Lion({ mood, dancing }) {
  const [b, sB] = useState(false); useEffect(() => { if (!dancing) { sB(false); return } sB(true); const t = setTimeout(() => sB(false), 1600); return () => clearTimeout(t) }, [dancing]); const m = mood === "happy" ? "#E07A5F" : "#999", f = "#fae6c8";
  return <svg viewBox="0 0 80 80" width="56" height="56" style={{ transition: "transform 0.2s", transform: b ? "translateY(-6px) rotate(-5deg)" : "none", animation: b ? "ld 0.3s ease infinite alternate" : "none" }}><circle cx="40" cy="40" r="32" fill={m} opacity="0.9" /><circle cx="20" cy="25" r="10" fill={m} opacity="0.7" /><circle cx="60" cy="25" r="10" fill={m} opacity="0.7" /><circle cx="15" cy="42" r="9" fill={m} opacity="0.6" /><circle cx="65" cy="42" r="9" fill={m} opacity="0.6" /><circle cx="24" cy="60" r="8" fill={m} opacity="0.5" /><circle cx="56" cy="60" r="8" fill={m} opacity="0.5" /><circle cx="40" cy="42" r="22" fill={f} />{mood === "happy" ? <><path d="M30 38Q33 34 36 38" stroke="#141413" strokeWidth="2.5" fill="none" strokeLinecap="round" /><path d="M44 38Q47 34 50 38" stroke="#141413" strokeWidth="2.5" fill="none" strokeLinecap="round" /></> : <><circle cx="33" cy="37" r="3" fill="#141413" /><circle cx="47" cy="37" r="3" fill="#141413" /></>}<ellipse cx="40" cy="45" rx="4" ry="3" fill={mood === "happy" ? "#c4736e" : "#999"} />{mood === "happy" ? <path d="M34 49Q40 55 46 49" stroke="#141413" strokeWidth="1.8" fill="none" strokeLinecap="round" /> : <path d="M34 52Q40 48 46 52" stroke="#141413" strokeWidth="1.8" fill="none" strokeLinecap="round" />}<circle cx="22" cy="22" r="6" fill={f} /><circle cx="58" cy="22" r="6" fill={f} /><circle cx="22" cy="22" r="3" fill="#f0c4b0" /><circle cx="58" cy="22" r="3" fill="#f0c4b0" /></svg>
}

function LionM({ balance: bal, dancing }) {
  const [msg, sM] = useState(""), mood = bal >= 0 ? "happy" : "sad"; useEffect(() => { const p = Math.random() < 0.5 ? TIPS : (mood === "happy" ? LH : LS); sM(p[Math.floor(Math.random() * p.length)]) }, [bal, mood]);
  return <div style={{ display: "flex", alignItems: "flex-end", gap: 12, padding: "12px 0" }}><Lion mood={mood} dancing={dancing} /><div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "14px 14px 14px 4px", padding: "10px 14px", fontSize: 13, color: "var(--ts)", maxWidth: 220, fontFamily: "var(--font-b)", lineHeight: 1.5 }}>{msg}</div></div>
}

function Chart({ expenses: ex, incomes: inc, settlements: stl, months: ms, period = "month" }) {
  const sumAmt = arr => arr.reduce((s, x) => s + Number(x.amount || 0), 0);
  const addDays = (date, days) => { const d = new Date(date); d.setDate(d.getDate() + days); return d; };
  const startOfWeek = (date) => { const d = new Date(date); d.setDate(d.getDate() - d.getDay()); return d; };
  const monthKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const allDates = [...ex, ...inc, ...stl].map(x => x.date).filter(Boolean).sort();
  let buckets = [];

  if (period === "day") {
    const today = new Date();
    buckets = Array.from({ length: 14 }, (_, i) => {
      const date = addDays(today, -(13 - i));
      const key = localDateKey(date);
      return { key, label: new Date(`${key}T00:00:00`).getDate().toString() };
    });
  } else if (period === "week") {
    const currentWeek = startOfWeek(new Date());
    buckets = Array.from({ length: 8 }, (_, i) => {
      const start = addDays(currentWeek, -(7 * (7 - i)));
      const key = localDateKey(start);
      return { key, label: new Date(`${key}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" }) };
    });
  } else if (period === "month") {
    const monthKeys = allDates.length
      ? [...new Set(allDates.map(d => d.slice(0, 7)))].sort().slice(-12)
      : ms.slice(-12);
    buckets = monthKeys.map(key => ({ key, label: ml(key) }));
  } else if (period === "year") {
    const years = [...new Set(allDates.map(d => d.slice(0, 4)))].sort();
    buckets = years.map(key => ({ key, label: key }));
  }

  if (buckets.length < 1) return <p style={{ color: "var(--muted)", fontSize: 13, textAlign: "center", padding: 24, fontFamily: "var(--font-b)" }}>Add transactions to see trends</p>;

  const data = buckets.map(({ key, label }) => {
    let income = 0, spent = 0;
    if (period === "day") {
      income = sumAmt(inc.filter(x => x.date === key));
      spent = sumAmt(ex.filter(x => x.date === key))
        + sumAmt(stl.filter(x => x.date === key && x.direction === "owe"))
        - sumAmt(stl.filter(x => x.date === key && x.direction === "owed"));
    } else if (period === "week") {
      const end = localDateKey(addDays(new Date(`${key}T00:00:00`), 6));
      income = sumAmt(inc.filter(x => x.date >= key && x.date <= end));
      spent = sumAmt(ex.filter(x => x.date >= key && x.date <= end))
        + sumAmt(stl.filter(x => x.date >= key && x.date <= end && x.direction === "owe"))
        - sumAmt(stl.filter(x => x.date >= key && x.date <= end && x.direction === "owed"));
    } else if (period === "month") {
      income = sumAmt(inc.filter(x => mk(x.date) === key));
      spent = sumAmt(ex.filter(x => mk(x.date) === key))
        + sumAmt(stl.filter(x => mk(x.date) === key && x.direction === "owe"))
        - sumAmt(stl.filter(x => mk(x.date) === key && x.direction === "owed"));
    } else {
      income = sumAmt(inc.filter(x => x.date?.startsWith(key)));
      spent = sumAmt(ex.filter(x => x.date?.startsWith(key)))
        + sumAmt(stl.filter(x => x.date?.startsWith(key) && x.direction === "owe"))
        - sumAmt(stl.filter(x => x.date?.startsWith(key) && x.direction === "owed"));
    }
    const safeSpent = Math.max(0, spent);
    const net = income - safeSpent;
    return { label, income, spent: safeSpent, net, netArea: Math.max(0, net), hasData: income > 0 || safeSpent > 0 };
  });

  if (data.every(p => p.income === 0 && p.spent === 0)) return <p style={{ color: "var(--muted)", fontSize: 13, textAlign: "center", padding: 24, fontFamily: "var(--font-b)" }}>No data for this period</p>;

  if (period === "day") {
    data.forEach((d, i) => { d.rollingAvg = i >= 6 ? data.slice(i - 6, i + 1).reduce((s, x) => s + x.spent, 0) / 7 : undefined; });
  }

  const allVals = data.flatMap(d => [d.income, d.spent, d.netArea]).filter(v => v > 0);
  const sorted = [...allVals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 1;
  const maxVal = Math.max(...allVals, 1);
  const useLog = maxVal > 5 * median && allVals.length > 3;

  const fmtY = v => { if (!v || v < 1) return ""; if (v >= 100000) return `₹${(v / 100000).toFixed(1)}L`; if (v >= 1000) return `₹${(v / 1000).toFixed(0)}k`; return `₹${Math.round(v)}`; };

  const IncomeDot = ({ cx, cy, payload }) => payload.hasData
    ? <circle cx={cx} cy={cy} r={4} fill="var(--card)" stroke="#6BAA75" strokeWidth={2} />
    : <circle cx={cx} cy={cy} r={3} fill="var(--muted)" opacity={0.28} />;

  const xInterval = period === "day" ? 2 : period === "week" ? 1 : 0;

  return (
    <ResponsiveContainer width="100%" height={210}>
      <ComposedChart data={data} margin={{ top: 10, right: 4, bottom: 20, left: 0 }}>
        <defs>
          <linearGradient id="netGreen" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#6BAA75" stopOpacity={0.22} />
            <stop offset="95%" stopColor="#6BAA75" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="label" tick={{ fontSize: 9, fontFamily: "var(--font-h)", fill: "var(--muted)" }} tickLine={false} axisLine={false} interval={xInterval} />
        <YAxis scale={useLog ? "log" : "auto"} domain={useLog ? [1, "auto"] : [0, "auto"]} tickFormatter={fmtY} tick={{ fontSize: 9, fontFamily: "var(--font-h)", fill: "var(--muted)" }} tickLine={false} axisLine={false} width={44} allowDataOverflow={useLog} />
        <Tooltip content={({ active, payload, label }) => {
          if (!active || !payload?.length) return null;
          const ip = payload.find(p => p.dataKey === "income"), sp = payload.find(p => p.dataKey === "spent"), np = payload.find(p => p.dataKey === "netArea")?.payload?.net;
          return <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", fontFamily: "var(--font-h)", fontSize: 12, boxShadow: "0 2px 12px rgba(0,0,0,0.1)" }}><div style={{ fontWeight: 700, marginBottom: 4, color: "var(--ts)", fontSize: 11 }}>{label}</div>{ip && <div style={{ color: "#6BAA75", fontWeight: 600 }}>Income: {fmt(ip.value || 0)}</div>}{sp && <div style={{ color: "#E07A5F", fontWeight: 600 }}>Spent: {fmt(sp.value || 0)}</div>}<div style={{ color: np >= 0 ? "#7B8CDE" : "#D4726A", fontWeight: 600 }}>Net: {fmt(np || 0)}</div></div>;
        }} />
        <Area dataKey="netArea" fill="url(#netGreen)" stroke="none" />
        <Bar dataKey="spent" fill="#E07A5F" fillOpacity={0.82} radius={[4, 4, 0, 0]} maxBarSize={18} />
        <Line dataKey="income" stroke="#6BAA75" strokeWidth={2.5} dot={<IncomeDot />} activeDot={{ r: 5, fill: "#6BAA75" }} />
        {period === "day" && data.some(d => d.rollingAvg !== undefined) && <Line dataKey="rollingAvg" stroke="#7B8CDE" strokeWidth={1.5} strokeDasharray="4 3" dot={false} activeDot={false} />}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function Heatmap({ expenses: ex }) {
  const today = new Date(), [vY, sY] = useState(today.getFullYear()), [vM, sM] = useState(today.getMonth()); const goB = () => { if (vM === 0) { sM(11); sY(y => y - 1) } else sM(m => m - 1) }; const goF = () => { if (vY === today.getFullYear() && vM === today.getMonth()) return; if (vM === 11) { sM(0); sY(y => y + 1) } else sM(m => m + 1) }; const iC = vY === today.getFullYear() && vM === today.getMonth();
  const fd = new Date(vY, vM, 1).getDay(), dim = new Date(vY, vM + 1, 0).getDate(), mn = new Date(vY, vM).toLocaleDateString("en-US", { month: "long", year: "numeric" }), pfx = `${vY}-${String(vM + 1).padStart(2, "0")}`;
  const dt = {}; ex.forEach(e => { if (e.date.startsWith(pfx)) dt[e.date] = (dt[e.date] || 0) + e.amount }); const mx = Math.max(...Object.values(dt), 1), mt = Object.values(dt).reduce((s, v) => s + v, 0), ad = Object.keys(dt).length;
  const gc = a => { if (!a) return "var(--border)"; const r = a / mx; return r < 0.25 ? "#6BAA75" : r < 0.5 ? "#FBBF24" : r < 0.75 ? "#E07A5F" : "#D4726A" };
  const cells = []; for (let i = 0; i < fd; i++)cells.push(<div key={`e${i}`} style={{ width: 36, height: 36 }} />); for (let d = 1; d <= dim; d++) { const ds = `${pfx}-${String(d).padStart(2, "0")}`, a = dt[ds] || 0, isT = iC && d === today.getDate(); cells.push(<div key={d} style={{ width: 36, height: 36, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", background: gc(a), color: a ? "#fff" : "var(--muted)", fontSize: 11, fontFamily: "var(--font-h)", fontWeight: isT ? 700 : 500, border: isT ? "2px solid var(--text)" : "2px solid transparent" }}>{d}</div>) }
  const nb = { background: "none", border: "1px solid var(--border)", borderRadius: 8, width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "var(--muted)", fontSize: 14 };
  return <div style={{ ...cc, padding: 16, marginBottom: 14, position: "relative", overflow: "hidden" }}><div style={{ position: "absolute", bottom: 0, right: 0, width: 60, height: 3, borderRadius: "3px 0 0 0", background: "#FBBF24" }} /><div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}><button onClick={goB} style={nb}>←</button><div style={{ textAlign: "center" }}><div style={{ fontFamily: "var(--font-h)", fontSize: 13, color: "var(--text)", fontWeight: 600 }}>{mn}</div>{!iC && <button onClick={() => { sY(today.getFullYear()); sM(today.getMonth()) }} style={{ background: "none", border: "none", fontSize: 10, color: "#E07A5F", cursor: "pointer", fontFamily: "var(--font-h)", fontWeight: 600, marginTop: 2 }}>Jump to today</button>}</div><button onClick={goF} style={{ ...nb, opacity: iC ? 0.3 : 1 }}>→</button></div><div style={{ display: "flex", gap: 8, marginBottom: 12 }}>{[{ l: "TOTAL", v: fmt(mt), c: "#E07A5F" }, { l: "AVG/DAY", v: fmt(ad > 0 ? Math.round(mt / ad) : 0), c: "var(--ts)" }, { l: "DAYS", v: `${ad}/${dim}`, c: "var(--ts)" }].map(x => <div key={x.l} style={{ flex: 1, background: "var(--bg)", borderRadius: 8, padding: "8px 10px", textAlign: "center" }}><div style={{ fontSize: 9, color: "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 600 }}>{x.l}</div><div style={{ fontSize: 14, fontWeight: 600, fontFamily: "var(--font-h)", color: x.c, marginTop: 2 }}>{x.v}</div></div>)}</div><div style={{ display: "flex", gap: 2, marginBottom: 8 }}>{"SMTWTFS".split("").map((d, i) => <div key={i} style={{ width: 36, textAlign: "center", fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 600 }}>{d}</div>)}</div><div style={{ display: "flex", flexWrap: "wrap", gap: 2 }}>{cells}</div><div style={{ display: "flex", gap: 8, marginTop: 10, justifyContent: "center" }}>{[{ c: "var(--border)", l: "None" }, { c: "#6BAA75", l: "Low" }, { c: "#FBBF24", l: "Med" }, { c: "#E07A5F", l: "High" }, { c: "#D4726A", l: "Heavy" }].map(x => <div key={x.l} style={{ display: "flex", alignItems: "center", gap: 3 }}><div style={{ width: 10, height: 10, borderRadius: 3, background: x.c }} /><span style={{ fontSize: 9, color: "var(--muted)" }}>{x.l}</span></div>)}</div></div>
}

function SpendingBreakdown({ expenses, categories, period, onPeriodChange, formatCurrency, darkMode }) {
  const categoryMap = useMemo(
    () => Object.fromEntries((categories || []).map(c => [c.id, c])),
    [categories]
  );
  const addDays = (date, days) => { const d = new Date(date); d.setDate(d.getDate() + days); return d; };
  const startOfWeek = date => { const d = new Date(date); d.setDate(d.getDate() - d.getDay()); return d; };

  const { data, activeCats, peakKey, yMax } = useMemo(() => {
    const allDates = (expenses || []).map(e => e.date).filter(Boolean).sort();
    if (!allDates.length) return { data: [], activeCats: [], peakKey: null, yMax: 1000 };
    let buckets;
    if (period === "day") {
      const today = new Date();
      buckets = Array.from({ length: 14 }, (_, i) => {
        const date = addDays(today, -(13 - i));
        const key = localDateKey(date);
        return { key, label: new Date(`${key}T00:00:00`).toLocaleDateString("en-US", { day: "numeric", month: "short" }) };
      });
    } else if (period === "week") {
      const cur = startOfWeek(new Date());
      buckets = Array.from({ length: 8 }, (_, i) => {
        const start = addDays(cur, -(7 * (7 - i)));
        const key = localDateKey(start);
        return { key, label: new Date(`${key}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" }) };
      });
    } else if (period === "month") {
      buckets = [...new Set(allDates.map(d => d.slice(0, 7)))].sort().slice(-12).map(key => {
        const [y, m] = key.split("-");
        return { key, label: new Date(Number(y), Number(m) - 1, 1).toLocaleDateString("en-US", { month: "short", year: "2-digit" }) };
      });
    } else {
      buckets = [...new Set(allDates.map(d => d.slice(0, 4)))].sort().slice(-8).map(key => ({ key, label: key }));
    }
    const catIds = [...new Set((expenses || []).map(e => e.categoryId).filter(Boolean))];
    const rows = new Map(buckets.map(b => [b.key, { ...b, total: 0, ...Object.fromEntries(catIds.map(id => [id, 0])) }]));
    (expenses || []).forEach(expense => {
      if (!expense?.date) return;
      let key = expense.date;
      if (period === "week") { const d = new Date(`${expense.date}T00:00:00`); d.setDate(d.getDate() - d.getDay()); key = localDateKey(d); }
      else if (period === "month") key = expense.date.slice(0, 7);
      else if (period === "year") key = expense.date.slice(0, 4);
      const row = rows.get(key);
      if (!row) return;
      row[expense.categoryId] = roundMoney((row[expense.categoryId] || 0) + Number(expense.amount || 0));
      row.total = roundMoney(row.total + Number(expense.amount || 0));
    });
    const raw = [...rows.values()];
    const activeCatIds = catIds.filter(id => raw.some(r => Number(r[id] || 0) > 0));
    const activeCatsData = activeCatIds.map(id => categoryMap[id] || { id, name: id, color: "#999" });
    const chartData = raw.map(row => ({ ...row, topCat: [...activeCatIds].reverse().find(id => Number(row[id] || 0) > 0) || null }));
    const peak = chartData.reduce((best, row) => row.total > (best?.total || 0) ? row : best, null);
    const maxTotal = Math.max(0, ...chartData.map(r => r.total || 0));
    return { data: chartData, activeCats: activeCatsData, peakKey: peak?.key || null, yMax: Math.max(1000, Math.ceil(maxTotal * 1.18 / 100) * 100) };
  }, [expenses, period, categoryMap]);

  const fmtY = v => { const n = Number(v || 0); if (n >= 100000) return `\u20b9${(n / 100000).toFixed(1)}L`; if (n >= 1000) return `\u20b9${(n / 1000).toFixed(1)}k`; return `\u20b9${Math.round(n)}`; };
  const lineStroke = darkMode ? "rgba(255,255,255,0.6)" : "rgba(44,42,36,0.4)";
  const ttBg = darkMode ? "#1A1917" : "#FAFAF7", ttBorder = darkMode ? "#2A2926" : "#DDD9D0", ttText = darkMode ? "#E8E4DC" : "#2C2A24", ttMuted = darkMode ? "#7A7870" : "#9A9488";

  const tabs = (
    <div style={{ display: "flex", gap: 2, background: darkMode ? "rgba(56,189,248,0.08)" : "rgba(56,189,248,0.12)", borderRadius: 20, padding: 3 }}>
      {["Day", "Week", "Month", "Year"].map(tab => {
        const v = tab.toLowerCase(), active = period === v;
        return <button key={v} onClick={() => onPeriodChange(v)} style={{ padding: "5px 11px", borderRadius: 16, border: "none", background: active ? "#38bdf8" : "transparent", fontSize: 11, fontFamily: "var(--font-h)", fontWeight: active ? 700 : 400, color: active ? (darkMode ? "#0a1628" : "#fff") : darkMode ? "rgba(56,189,248,0.6)" : "rgba(0,90,130,0.7)", cursor: "pointer", transition: "all 0.15s" }}>{tab}</button>;
      })}
    </div>
  );

  return (
    <div style={{ ...cc, padding: "18px 14px", marginBottom: 16, position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", bottom: 0, right: 0, width: 60, height: 3, borderRadius: "3px 0 0 0", background: "#38bdf8" }} />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, gap: 12 }}>
        <div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "#38bdf8", letterSpacing: "0.04em", fontWeight: 600 }}>Spending Breakdown</div>
        {tabs}
      </div>
      {!data.length || !activeCats.length ? (
        <p style={{ color: "var(--muted)", fontSize: 13, textAlign: "center", padding: "28px 0 8px", fontFamily: "var(--font-b)" }}>Add transactions to see trends</p>
      ) : (
        <>
          <div style={{ width: "100%", height: 260, minWidth: 0 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data} margin={{ top: 8, right: 8, left: -4, bottom: 0 }} barCategoryGap="30%">
                <CartesianGrid stroke={darkMode ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.06)"} vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "var(--muted)", fontSize: 10, fontFamily: "var(--font-h)" }} />
                <YAxis tickLine={false} axisLine={false} width={48} domain={[0, yMax]} tickFormatter={fmtY} tick={{ fill: "var(--muted)", fontSize: 10, fontFamily: "var(--font-h)" }} tickCount={5} />
                <Tooltip content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const row = payload[0]?.payload;
                  const entries = payload.filter(p => activeCats.some(c => c.id === p.dataKey) && Number(p.value || 0) > 0);
                  return (
                    <div style={{ background: ttBg, borderRadius: 10, border: `0.5px solid ${ttBorder}`, padding: "10px 12px", minWidth: 155, boxShadow: "0 8px 24px rgba(0,0,0,0.12)" }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: ttText, fontFamily: "var(--font-h)", marginBottom: 7 }}>{row.label}</div>
                      <div style={{ display: "grid", gap: 5 }}>
                        {entries.map(p => { const cat = activeCats.find(c => c.id === p.dataKey); return <div key={p.dataKey} style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}><div style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 7, height: 7, borderRadius: 2, background: cat?.color || "#999", flexShrink: 0 }} /><span style={{ color: ttMuted, fontSize: 11, fontFamily: "var(--font-b)" }}>{cat?.name || p.dataKey}</span></div><span style={{ color: ttText, fontSize: 11, fontFamily: "var(--font-b)", fontWeight: 700 }}>{formatCurrency(p.value)}</span></div>; })}
                        {entries.length > 1 && <><div style={{ height: 1, background: ttBorder, margin: "2px 0" }} /><div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}><span style={{ color: ttMuted, fontSize: 11, fontFamily: "var(--font-b)" }}>Total</span><span style={{ color: "#C17A5A", fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 700 }}>{formatCurrency(row.total)}</span></div></>}
                      </div>
                    </div>
                  );
                }} cursor={{ fill: "rgba(201,123,99,0.06)" }} />
                {activeCats.map(cat => (
                  <Bar key={cat.id} dataKey={cat.id} name={cat.name} stackId="e" fill={cat.color} maxBarSize={32} animationDuration={650}>
                    {data.map((row, idx) => <Cell key={`${cat.id}-${idx}`} radius={row.topCat === cat.id ? [4, 4, 0, 0] : [0, 0, 0, 0]} />)}
                  </Bar>
                ))}
                <Line type="monotone" dataKey="total" stroke={lineStroke} strokeDasharray="5 4" strokeWidth={1.5}
                  dot={({ cx, cy, payload }) => {
                    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
                    return <circle key={payload?.key} cx={cx} cy={cy} r={payload?.key === peakKey && payload?.total > 0 ? 6 : 2.5} fill="#C17A5A" />;
                  }}
                  activeDot={{ r: 5, fill: "#C17A5A" }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 10 }}>
            {activeCats.map(cat => (
              <div key={cat.id} style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "var(--bg)", border: "0.5px solid var(--border)", borderRadius: 20, padding: "3px 9px" }}>
                <span style={{ width: 7, height: 7, borderRadius: 2, background: cat.color, flexShrink: 0 }} />
                <span style={{ color: "var(--muted)", fontSize: 10, fontFamily: "var(--font-b)" }}>{cat.name}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Report({ expenses: ex }) {
  const today = new Date(), dow = today.getDay(), ws = new Date(today); ws.setDate(today.getDate() - dow); ws.setHours(0, 0, 0, 0); const lws = new Date(ws); lws.setDate(ws.getDate() - 7);
  const inR = (e, s, days) => { const d = dateOnly(e.date), end = new Date(s); end.setDate(s.getDate() + days); return d >= s && d < end };
  const tw = ex.filter(e => inR(e, ws, 7) && !isFix(e)), lw = ex.filter(e => inR(e, lws, 7) && !isFix(e)), tt = tw.reduce((s, e) => s + e.amount, 0), lt = lw.reduce((s, e) => s + e.amount, 0);
  if (tt === 0) {
    return <div style={{ ...cc, padding: 20, marginBottom: 14, position: "relative", overflow: "hidden" }}><div style={{ position: "absolute", bottom: 0, right: 0, width: 60, height: 3, borderRadius: "3px 0 0 0", background: "#8A8A9A" }} /><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "#6BAA75", marginBottom: 16, letterSpacing: "0.5px", fontWeight: 700 }}>Weekly Report Card</div><div style={{ display: "flex", alignItems: "center", gap: 16 }}><div style={{ width: 72, height: 72, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--border)", border: "3px solid var(--border)", flexShrink: 0 }}><span style={{ fontSize: 28, color: "var(--muted)" }}>—</span></div><div><div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-h)", marginBottom: 4 }}>No flexible spending yet this week</div><div style={{ fontSize: 12, color: "var(--ts)", fontFamily: "var(--font-b)", lineHeight: 1.5 }}>Add some expenses to see your weekly grade.</div><div style={{ fontSize: 10, color: "var(--muted)", marginTop: 6, fontStyle: "italic" }}>Graded on flexible spending only. Fixed costs excluded.</div></div></div></div>;
  }
  const pwt = []; for (let w = 1; w <= 12; w++) { const s = new Date(ws); s.setDate(ws.getDate() - w * 7); const t = ex.filter(e => inR(e, s, 7) && !isFix(e)).reduce((sum, e) => sum + e.amount, 0); if (t > 0) pwt.push(t) }
  const avg = pwt.length > 0 ? pwt.reduce((s, v) => s + v, 0) / pwt.length : 0, at = avg > 0 ? avg : tt * 1.2;
  const tscore = Math.max(0, 40 - (tt / at) * 40), trs = lt > 0 ? (tt <= lt ? 30 : Math.max(0, 30 - ((tt - lt) / lt) * 30)) : 15;
  const ct = {}; tw.forEach(e => { ct[e.categoryId] = (ct[e.categoryId] || 0) + e.amount }); const cv = Object.values(ct), mcp = cv.length > 0 ? Math.max(...cv) / tt : 0;
  const cs = mcp > 0.5 ? Math.max(0, 30 - (mcp - 0.5) * 60) : 30, total = Math.round(tscore + trs + cs);
  const grade = total >= 85 ? "A" : total >= 70 ? "B" : total >= 50 ? "C" : total >= 30 ? "D" : "F", gc = { A: "#6BAA75", B: "#7B8CDE", C: "#FBBF24", D: "#E07A5F", F: "#D4726A" }[grade];
  const gm = { A: "Outstanding week!", B: "Good — room to improve.", C: "Decent, watch spending.", D: "Spending heavy…", F: "Fresh start ahead!" }[grade], pc = lt > 0 ? ((tt - lt) / lt * 100).toFixed(0) : null;
  return <div style={{ ...cc, padding: 20, marginBottom: 14, position: "relative", overflow: "hidden" }}><div style={{ position: "absolute", bottom: 0, right: 0, width: 60, height: 3, borderRadius: "3px 0 0 0", background: "#6BAA75" }} /><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "#6BAA75", marginBottom: 16, letterSpacing: "0.5px", fontWeight: 700 }}>Weekly Report Card</div><div style={{ display: "flex", alignItems: "center", gap: 16 }}><div style={{ width: 72, height: 72, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", background: gc + "18", border: `3px solid ${gc}`, flexShrink: 0 }}><span style={{ fontSize: 32, fontWeight: 700, fontFamily: "var(--font-h)", color: gc }}>{grade}</span></div><div><div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-h)", marginBottom: 4 }}>{gm}</div><div style={{ fontSize: 12, color: "var(--ts)", fontFamily: "var(--font-b)", lineHeight: 1.5 }}>Flexible spend: <strong style={{ color: "#E07A5F" }}>{fmt(tt)}</strong> this week{pc !== null && <span style={{ color: Number(pc) <= 0 ? "#6BAA75" : "#E07A5F" }}> ({Number(pc) > 0 ? "+" : ""}{pc}%)</span>}</div><div style={{ fontSize: 10, color: "var(--muted)", marginTop: 6, fontStyle: "italic" }}>Graded on flexible spending only. Fixed costs excluded.</div></div></div><div style={{ display: "flex", gap: 8, marginTop: 16 }}>{[{ label: "Target", score: Math.round(tscore), max: 40 }, { label: "Trend", score: Math.round(trs), max: 30 }, { label: "Balance", score: Math.round(cs), max: 30 }].map(s => <div key={s.label} style={{ flex: 1, textAlign: "center" }}><div style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 600, marginBottom: 4 }}>{s.label}</div><div style={{ height: 5, borderRadius: 3, background: "var(--border)", overflow: "hidden" }}><div style={{ height: "100%", width: `${(s.score / s.max) * 100}%`, background: gc, borderRadius: 3 }} /></div><div style={{ fontSize: 10, color: "var(--ts)", fontFamily: "var(--font-h)", marginTop: 3 }}>{s.score}/{s.max}</div></div>)}</div></div>
}

function SettleM({ split: sp, onConfirm: oc, onClose: cl }) {
  const [wid, sW] = useState("bank"); const isO = sp.direction === "owed";
  const walletOptions = isO ? WALLETS.filter(w => w.id !== "upi_lite") : WALLETS;
  return <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={cl}><div onClick={e => e.stopPropagation()} style={{ background: "var(--card)", borderRadius: "20px 20px 0 0", padding: 28, width: "100%", maxWidth: 430 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 16, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{isO ? `${sp.name} pays you back` : `Pay ${sp.name}`}</div><div style={{ fontSize: 24, fontWeight: 700, fontFamily: "var(--font-h)", color: isO ? "#6BAA75" : "#E07A5F", marginBottom: 16 }}>{isO ? "+" : "−"}{fmt(sp.amount)}</div><div style={ls}>{isO ? "Receive into" : "Pay from"}</div><div style={{ display: "flex", gap: 8, marginBottom: 20 }}>{walletOptions.map(w => <button key={w.id} onClick={() => sW(w.id)} style={{ flex: 1, padding: "10px 8px", borderRadius: 10, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, border: `2px solid ${wid === w.id ? w.color : "var(--border)"}`, background: wid === w.id ? w.color + "15" : "var(--card)", cursor: "pointer" }}><DI2 id={w.id} accent={w.neon || w.color} size={18} /><span style={{ fontSize: 10, fontFamily: "var(--font-h)", fontWeight: wid === w.id ? 700 : 500, color: wid === w.id ? w.color : "var(--muted)" }}>{w.name}</span></button>)}</div><div style={{ display: "flex", gap: 10 }}><button onClick={cl} style={{ flex: 1, padding: 14, border: "1.5px solid var(--border)", borderRadius: 12, background: "transparent", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 14, cursor: "pointer" }}>Cancel</button><button onClick={() => { oc(wid); cl() }} style={{ flex: 2, padding: 14, border: "none", borderRadius: 12, background: isO ? "#6BAA75" : "#E07A5F", color: "#fff", fontFamily: "var(--font-h)", fontSize: 14, cursor: "pointer", fontWeight: 700 }}>{isO ? "Received ✓" : "Paid ✓"}</button></div></div></div>
}

function Splits({ splits: sp, onAdd, onSettle: os, onDelete: od, expanded: exp, onToggle: ot }) {
  const [nm, sN] = useState(""), [am, sA] = useState(""), [dir, sD] = useState("owe"), [st, sT] = useState(null);
  const add = () => { if (!nm.trim() || !am || Number(am) <= 0) return; onAdd({ id: uid(), name: nm.trim(), amount: Number(am), direction: dir, settled: false }); sN(""); sA("") };
  const tO = sp.filter(s => s.direction === "owe" && !s.settled).reduce((t, s) => t + s.amount, 0), tI = sp.filter(s => s.direction === "owed" && !s.settled).reduce((t, s) => t + s.amount, 0);
  if (!exp) return <div onClick={ot} style={{ ...cc, borderRadius: 16, padding: "16px 18px", marginBottom: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", position: "relative", overflow: "hidden" }}><div style={{ position: "absolute", bottom: 0, right: 0, width: 60, height: 3, borderRadius: "3px 0 0 0", background: "#D4726A" }} /><div><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "#D4726A", letterSpacing: "0.5px", fontWeight: 700 }}>Split Expenses</div><div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-b)", marginBottom: 4 }}>Personal IOUs · group splits live in Events</div><div style={{ fontSize: 13, fontFamily: "var(--font-b)", color: "var(--ts)", marginTop: 2 }}>{sp.filter(s => !s.settled).length === 0 ? "No pending splits" : <><span style={{ color: "#E07A5F" }}>You owe {fmt(tO)}</span> · <span style={{ color: "#6BAA75" }}>Owed {fmt(tI)}</span></>}</div></div><span style={{ fontSize: 18, color: "var(--muted)" }}>→</span></div>;
  return <div style={{ ...cc, borderRadius: 16, padding: 18, marginBottom: 14, position: "relative", overflow: "hidden" }}><div style={{ position: "absolute", bottom: 0, right: 0, width: 60, height: 3, borderRadius: "3px 0 0 0", background: "#D4726A" }} /><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "#D4726A", letterSpacing: "0.5px", fontWeight: 700 }}>Split Expenses</div><button onClick={ot} style={{ background: "none", border: "none", fontSize: 12, color: "var(--muted)", cursor: "pointer", fontFamily: "var(--font-h)" }}>← Back</button></div><div style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-b)", marginBottom: 12 }}>Track who owes who for informal splits. For group trips or events use the Events tab.</div>
    <div style={{ display: "flex", gap: 12, marginBottom: 16 }}><div style={{ flex: 1, textAlign: "center", padding: 12, background: "#E07A5F12", borderRadius: 10 }}><div style={{ fontSize: 10, color: "#E07A5F", fontFamily: "var(--font-h)", fontWeight: 600 }}>YOU OWE</div><div style={{ fontSize: 18, fontWeight: 700, fontFamily: "var(--font-h)", color: "#E07A5F", marginTop: 4 }}>{fmt(tO)}</div></div><div style={{ flex: 1, textAlign: "center", padding: 12, background: "#6BAA7512", borderRadius: 10 }}><div style={{ fontSize: 10, color: "#6BAA75", fontFamily: "var(--font-h)", fontWeight: 600 }}>OWED TO YOU</div><div style={{ fontSize: 18, fontWeight: 700, fontFamily: "var(--font-h)", color: "#6BAA75", marginTop: 4 }}>{fmt(tI)}</div></div></div>
    {sp.filter(s => !s.settled).map(s => <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "var(--bg)", borderRadius: 10, marginBottom: 6, border: "1px solid var(--border)" }}><span style={{ fontSize: 16 }}>{s.direction === "owe" ? "🔴" : "🟢"}</span><div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 600, fontFamily: "var(--font-h)", color: "var(--text)" }}>{s.name}</div><div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-b)" }}>{s.direction === "owe" ? "You owe" : "Owes you"}</div></div><span style={{ fontFamily: "var(--font-h)", fontWeight: 600, fontSize: 14, color: s.direction === "owe" ? "#E07A5F" : "#6BAA75" }}>{fmt(s.amount)}</span><button onClick={() => sT(s)} style={{ border: "1px solid var(--border)", background: "none", borderRadius: 6, padding: "4px 8px", fontSize: 10, color: "var(--muted)", cursor: "pointer" }}>Settle</button><button onClick={() => od(s.id)} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 14, opacity: 0.4 }}>✕</button></div>)}
    {sp.filter(s => s.settled).length > 0 && <details style={{ marginTop: 10 }}><summary style={{ fontSize: 11, color: "var(--muted)", cursor: "pointer", fontFamily: "var(--font-h)", fontWeight: 500, marginBottom: 6 }}>Settled ({sp.filter(s => s.settled).length})</summary>{sp.filter(s => s.settled).map(s => <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "var(--bg)", borderRadius: 10, marginBottom: 4, opacity: 0.5 }}><span>✅</span><span style={{ flex: 1, fontSize: 12, fontFamily: "var(--font-h)", color: "var(--ts)" }}>{s.name}</span><span style={{ fontSize: 12, fontFamily: "var(--font-h)", color: "var(--muted)" }}>{fmt(s.amount)}</span><button onClick={() => od(s.id)} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 12, opacity: 0.4 }}>✕</button></div>)}</details>}
    <div style={{ borderTop: "1px solid var(--border)", marginTop: 14, paddingTop: 14 }}><div style={{ display: "flex", gap: 6, marginBottom: 10 }}>{["owe", "owed"].map(d => <button key={d} onClick={() => sD(d)} style={{ flex: 1, padding: "8px", borderRadius: 8, fontSize: 12, fontFamily: "var(--font-h)", border: `1.5px solid ${dir === d ? (d === "owe" ? "#E07A5F" : "#6BAA75") : "var(--border)"}`, background: dir === d ? (d === "owe" ? "#E07A5F18" : "#6BAA7518") : "var(--card)", color: dir === d ? (d === "owe" ? "#E07A5F" : "#6BAA75") : "var(--muted)", cursor: "pointer", fontWeight: 500 }}>{d === "owe" ? "I owe them" : "They owe me"}</button>)}</div><div style={{ display: "flex", gap: 6 }}><input value={nm} onChange={e => sN(e.target.value)} placeholder="Friend name" style={{ ...is, flex: 1 }} /><input type="number" value={am} onChange={e => sA(e.target.value)} placeholder="₹" style={{ ...is, width: 80 }} /><button onClick={add} style={{ padding: "10px 14px", border: "none", borderRadius: 10, background: "#E07A5F", color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>+</button></div></div>
    {st && <SettleM split={st} onConfirm={wid => { os(st.id, wid); sT(null) }} onClose={() => sT(null)} />}</div>
}

const CURRENCIES = ["INR", "USD", "EUR", "GBP", "AED", "SGD", "JPY", "AUD", "CAD", "CHF", "CNY", "HKD", "NZD", "MYR", "THB", "PHP", "IDR", "KRW", "TWD", "SAR", "KWD", "QAR", "BHD", "OMR", "EGP", "ZAR", "NGN", "SEK", "NOK", "DKK", "PLN", "TRY", "RUB", "PKR", "BDT", "LKR", "NPR", "MXN", "BRL", "ARS"];
const CURRENCY_COUNTRIES = { INR: "India", USD: "United States", EUR: "Eurozone", GBP: "United Kingdom", AED: "UAE", SGD: "Singapore", JPY: "Japan", AUD: "Australia", CAD: "Canada", CHF: "Switzerland", CNY: "China", HKD: "Hong Kong", NZD: "New Zealand", MYR: "Malaysia", THB: "Thailand", PHP: "Philippines", IDR: "Indonesia", KRW: "South Korea", TWD: "Taiwan", SAR: "Saudi Arabia", KWD: "Kuwait", QAR: "Qatar", BHD: "Bahrain", OMR: "Oman", EGP: "Egypt", ZAR: "South Africa", NGN: "Nigeria", SEK: "Sweden", NOK: "Norway", DKK: "Denmark", PLN: "Poland", TRY: "Turkey", RUB: "Russia", PKR: "Pakistan", BDT: "Bangladesh", LKR: "Sri Lanka", NPR: "Nepal", MXN: "Mexico", BRL: "Brazil", ARS: "Argentina" };
const getCurrencyFlag = c => { if (c === "EUR") return "🇪🇺"; try { return String.fromCodePoint(...[...c.slice(0, 2).toUpperCase()].map(x => 127397 + x.charCodeAt(0))); } catch { return "🏳"; } };

function AddPage({ categories: cats, incomeSources: isrc, recurringCats: rCats, onAddExpense: oE, onAddIncome: oI, onAddTransfer: oT, onAddRec: oR, onError: showT = () => {}, patterns = [] }) {
  const _AD = (() => { try { return JSON.parse(sessionStorage.getItem("nomad-add-draft") || "{}"); } catch { return {}; } })();
  const [type, sType] = useState(_AD.type || "expense"), [amt, sAmt] = useState(_AD.amt || "0"), [catId, sCat] = useState(_AD.catId || cats[0]?.id || ""), [srcId, sSrc] = useState(isrc[0]?.id || ""), [wid, sW] = useState(_AD.wid || "bank"), [iwid, sIW] = useState("bank"), [tFrom, sTF] = useState("bank"), [tTo, sTT] = useState("upi_lite"), [date, sDate] = useState(_AD.date || localDateKey()), [note, sNote] = useState(_AD.note || "");
  const [rName, sRN] = useState(""), [rAmt, sRA] = useState(""), [rCat, sRC] = useState("rent"), [rWal, sRW] = useState("bank"), [rFreq, sRF] = useState("monthly"), [rDay, sRD] = useState(1), [rInt, sRI] = useState(30), [rStart, sRS] = useState(localDateKey()), [rOther, sRO] = useState(""), [rYM, sRYM] = useState(1), [rYD, sRYD] = useState(1);
  const [fxCur, setFxCur] = useState("INR"), [fxRate, setFxRate] = useState(null), [fxFetching, setFxFetching] = useState(false);
  const [fxExpanded, setFxExpanded] = useState(false), [fxSearch, setFxSearch] = useState("");
  const receiptPickerRef = useRef(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitKey, setSubmitKey] = useState(0);
  const flagBlobsRef = useRef({});
  const [flagSrcs, setFlagSrcs] = useState({});
  useEffect(() => { CURRENCIES.forEach(async c => { if (flagBlobsRef.current[c]) return; try { const r = await fetch(`https://flagcdn.com/32x24/${c.slice(0, 2).toLowerCase()}.png`); const blob = await r.blob(); const url = URL.createObjectURL(blob); flagBlobsRef.current[c] = url; setFlagSrcs(p => ({ ...p, [c]: url })); } catch { /* ignore flag fetch errors */ } }); }, []);
  useEffect(() => { const c = fxCur.trim().toUpperCase(); if (c.length !== 3 || c === "INR") { setFxRate(null); return; } setFxFetching(true); getExchangeRate(c).then(r => { setFxRate(r); setFxFetching(false); }).catch(() => { setFxRate(null); setFxFetching(false); }); }, [fxCur]);
  useEffect(() => { try { sessionStorage.setItem("nomad-add-draft", JSON.stringify({ type, amt, catId, wid, date, note })); } catch { /* ignore storage errors */ } }, [type, amt, catId, wid, date, note]);
  const ts = useRef(null), tc = type === "expense" ? "#E07A5F" : type === "income" ? "#6BAA75" : type === "transfer" ? "#7B8CDE" : "#A78BFA";
  const submit = async () => {
    if (submitting) return;
    const a = parseFloat(amt);
    if (!a || a <= 0) return;
    if (type === "transfer" && tFrom === tTo) return;
    setSubmitting(true);
    try {
      // Upload receipts only at submit time — fixes premature Cloudinary uploads
      let rUrl = null;
      if (type !== "transfer" && receiptPickerRef.current?.count > 0) {
        const urls = await receiptPickerRef.current.upload();
        rUrl = urls.length === 1 ? urls[0] : urls.length > 1 ? JSON.stringify(urls) : null;
      }
      const isFX = fxCur.trim().toUpperCase() !== "INR" && fxRate > 0;
      const inrAmt = isFX ? roundMoney(a * fxRate) : a;
      let txOk = true;
      if (type === "expense") {
        const txId = uid();
        if (isFX) saveCurrencyMeta(txId, fxCur, a, fxRate);
        txOk = oE({ id: txId, amount: inrAmt, categoryId: catId, date, note, walletId: wid, ...(rUrl ? { receipt_url: rUrl } : {}) }) !== false;
      } else if (type === "income") {
        const txId = uid();
        if (isFX) saveCurrencyMeta(txId, fxCur, a, fxRate);
        txOk = oI({ id: txId, amount: inrAmt, sourceId: srcId, date, note, walletId: iwid, ...(rUrl ? { receipt_url: rUrl } : {}) }) !== false;
      } else if (type === "transfer") {
        oT({ amount: a, fromWallet: tFrom, toWallet: tTo, date, note });
      }
      if (!txOk) return; // validation failed — keep form state + picker so user can fix and retry
      receiptPickerRef.current?.clear();
      setSubmitKey(k => k + 1);
      sAmt("0");
      sNote("");
      try { sessionStorage.removeItem("nomad-add-draft"); } catch { /* ignore */ }
    } finally {
      setSubmitting(false);
    }
  };
  const submitRec = () => { const a = roundMoney(rAmt); if (!rName.trim() || !a || a <= 0) return; if (rCat === "other_rec" && !rOther.trim()) return; if (!rStart) { showT("Pick a start date", "error"); return; } if (rFreq === "custom" && (!rInt || Number(rInt) <= 0)) { showT("Custom interval must be at least 1 day", "error"); return; } if (rFreq === "monthly" && (!rDay || Number(rDay) < 1 || Number(rDay) > 31)) { showT("Day of month must be between 1 and 31", "error"); return; } if (rFreq === "yearly" && (!rYM || !rYD || Number(rYM) < 1 || Number(rYM) > 12 || Number(rYD) < 1 || Number(rYD) > 31)) { showT("Pick a valid month and day", "error"); return; } oR({ id: uid(), name: rName.trim(), amount: a, categoryId: rCat, categoryName: rCat === "other_rec" ? rOther.trim() : null, walletId: rWal, frequency: rFreq, dayOfMonth: rFreq === "monthly" ? Number(rDay) : null, intervalDays: rFreq === "custom" ? Number(rInt) : null, yearMonth: rFreq === "yearly" ? Number(rYM) : null, yearDay: rFreq === "yearly" ? Number(rYD) : null, startDate: rStart, active: true, lastPaidDate: null, lastSkippedDate: null }); sRN(""); sRA(""); sRO("") };
  const WB = ({ wallets, sel, onSel }) => <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>{wallets.map(w => <button key={w.id} onClick={() => onSel(w.id)} style={{ flex: 1, padding: "10px 6px", borderRadius: 10, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, border: `2px solid ${sel === w.id ? w.color : "var(--border)"}`, background: sel === w.id ? w.color + "15" : "var(--card)", cursor: "pointer" }}><div style={{ display: "flex", alignItems: "center", gap: 4 }}><DI2 id={w.id} accent={w.neon || w.color} size={12} /><span style={{ fontSize: 11, fontFamily: "var(--font-h)", fontWeight: sel === w.id ? 700 : 500, color: sel === w.id ? w.color : "var(--muted)" }}>{w.name}</span></div>{w.desc && <span style={{ fontSize: 8, color: sel === w.id ? w.color : "var(--muted)", fontFamily: "var(--font-b)", opacity: 0.7, lineHeight: 1 }}>{w.desc}</span>}</button>)}</div>;
  return <div style={{ padding: "0 0 20px" }}>
    {(() => { const SI = { expense: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><polyline points="19 12 12 19 5 12" /></svg>, income: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" /></svg>, transfer: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 1 21 5 17 9" /><line x1="3" y1="5" x2="21" y2="5" /><polyline points="7 23 3 19 7 15" /><line x1="21" y1="19" x2="3" y2="19" /></svg>, recurring: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></svg> }; return <div style={{ display: "flex", background: "var(--card)", borderRadius: 12, padding: 4, border: "1px solid var(--border)", marginBottom: 20, gap: 2 }}>{[{ id: "expense", label: "Expense" }, { id: "income", label: "Income" }, { id: "transfer", label: "Transfer" }, { id: "recurring", label: "Recurring" }].map(t => <button key={t.id} onClick={() => sType(t.id)} style={{ flex: 1, padding: "10px 4px", border: "none", borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center", gap: 4, lineHeight: 1, background: type === t.id ? (t.id === "expense" ? "#E07A5F" : t.id === "income" ? "#6BAA75" : t.id === "transfer" ? "#7B8CDE" : "#A78BFA") : "transparent", color: type === t.id ? "#fff" : "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all 0.15s" }}>{SI[t.id]}{t.label}</button>)}</div>; })()}
    {type === "expense" && patterns.length > 0 && <div style={{ marginBottom: 16 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 11, color: "var(--muted)", letterSpacing: "0.5px", fontWeight: 600, marginBottom: 8 }}>QUICK ADD</div><div style={{ display: "flex", gap: 6, overflowX: "auto", scrollbarWidth: "none", WebkitOverflowScrolling: "touch", paddingBottom: 4 }}>{patterns.map((p, i) => { const cat = cats.find(c => c.id === p.categoryId); const accent = cat?.color || "#E07A5F"; return <button key={i} onClick={() => { sAmt(String(p.amount)); sCat(p.categoryId); sW(p.walletId); if (p.note) sNote(p.note); }} style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 5, padding: "7px 13px", borderRadius: 20, border: `1.5px solid ${accent}`, background: accent + "18", cursor: "pointer", fontFamily: "var(--font-h)", transition: "background 0.12s" }}><DI2 id={p.categoryId} accent={cat?.neon || accent} size={13} /><span style={{ fontSize: 13, fontWeight: 700, color: accent }}>₹{p.amount}</span>{p.note && <span style={{ fontSize: 11, color: "var(--ts)", maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.note}</span>}<span style={{ fontSize: 10, color: "var(--muted)", fontWeight: 600, marginLeft: 1 }}>×{p.count}</span></button>; })}</div></div>}
    {type !== "recurring" && <><div style={{ marginBottom: 16 }}><label style={ls}>Amount</label>
      {/* Merged amount + currency box */}
      <div style={{ position: "relative", display: "flex", alignItems: "center", background: "var(--card)", border: `1.5px solid ${tc}`, borderRadius: 10, overflow: "hidden" }}>
        {/* ₹ prefix — always shows INR symbol regardless of selected currency */}
        {type !== "transfer" && <img src={flagSrcs[fxCur] || `https://flagcdn.com/32x24/${fxCur.slice(0, 2).toLowerCase()}.png`} alt={fxCur} style={{ marginLeft: 16, height: 22, flexShrink: 0, userSelect: "none", objectFit: "contain", borderRadius: 2 }} />}
        <input type="number" value={amt === "0" ? "" : amt} onChange={e => sAmt(e.target.value || "0")} placeholder="0" autoFocus style={{ flex: 1, background: "transparent", border: "none", outline: "none", fontSize: 32, fontWeight: 600, fontFamily: "var(--font-h)", textAlign: "center", padding: "18px 8px", color: tc, minWidth: 0 }} />
        {/* Currency badge — tappable, opens the picker */}
        {type !== "transfer" && !fxExpanded && <button onClick={() => setFxExpanded(true)} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "7px 12px", margin: "0 8px", borderRadius: 20, border: `1.5px solid ${fxCur !== "INR" ? tc : "var(--border)"}`, background: fxCur !== "INR" ? tc + "14" : "var(--bg)", cursor: "pointer", fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 12, color: fxCur !== "INR" ? tc : "var(--muted)", letterSpacing: 0.5, flexShrink: 0, whiteSpace: "nowrap" }}><span style={{ fontSize: 13, lineHeight: 1 }}>{getCurrencyFlag(fxCur)}</span>{fxCur}<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}><polyline points="9 18 15 12 9 6" /></svg></button>}
        {type !== "transfer" && fxExpanded && <button onClick={() => { setFxExpanded(false); setFxSearch(""); }} style={{ display: "inline-flex", alignItems: "center", padding: "7px 10px", margin: "0 8px", borderRadius: 20, border: "1.5px solid var(--border)", background: "var(--bg)", cursor: "pointer", fontFamily: "var(--font-h)", fontSize: 12, color: "var(--muted)", flexShrink: 0 }}>✕</button>}
      </div>
      {/* Currency picker — expands below the amount box when badge is tapped */}
      {type !== "transfer" && fxExpanded && <div style={{ marginTop: 10 }}><div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}><input value={fxSearch} onChange={e => setFxSearch(e.target.value)} placeholder="Search currency or country…" autoFocus style={{ ...is, flex: 1, marginBottom: 0, padding: "8px 12px", fontSize: 13 }} /></div><div style={{ display: "flex", gap: 6, overflowX: "auto", scrollbarWidth: "none", WebkitOverflowScrolling: "touch", paddingBottom: 6 }}>{(fxSearch.trim() ? CURRENCIES.filter(c => { const q = fxSearch.trim().toLowerCase(); return c.toLowerCase().includes(q) || (CURRENCY_COUNTRIES[c] || "").toLowerCase().includes(q); }) : CURRENCIES).map(c => <button key={c} onClick={() => { setFxCur(c); setFxExpanded(false); setFxSearch(""); }} style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "7px 12px", borderRadius: 12, border: `1.5px solid ${fxCur === c ? tc : "var(--border)"}`, background: fxCur === c ? tc + "18" : "var(--card)", color: fxCur === c ? tc : "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: fxCur === c ? 700 : 500, whiteSpace: "nowrap", cursor: "pointer", flexShrink: 0 }}><span style={{ fontSize: 13, lineHeight: 1 }}>{getCurrencyFlag(c)}</span>{c}{CURRENCY_COUNTRIES[c] && <span style={{ fontSize: 9, opacity: 0.65, fontWeight: 400, maxWidth: 60, overflow: "hidden", textOverflow: "ellipsis" }}>{CURRENCY_COUNTRIES[c]}</span>}</button>)}</div>{fxFetching && <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-h)", marginTop: 6 }}>Fetching rate…</div>}{!fxFetching && fxRate && fxCur !== "INR" && <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10 }}>{parseFloat(amt) > 0 && <span style={{ fontSize: 15, color: tc, fontFamily: "var(--font-h)", fontWeight: 700 }}>≈ {fmt(roundMoney(parseFloat(amt) * fxRate))}</span>}<span style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 500, letterSpacing: "0.3px" }}>1 {fxCur} = ₹{fxRate.toFixed(2)}</span></div>}</div>}
      {/* Collapsed rate hint — shown below box when a foreign currency is selected */}
      {type !== "transfer" && !fxExpanded && fxCur !== "INR" && <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 6, paddingLeft: 2 }}>{fxFetching && <span style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-h)" }}>Fetching rate…</span>}{!fxFetching && fxRate && <><span style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 500, letterSpacing: "0.3px" }}>1 {fxCur} = ₹{fxRate.toFixed(2)}</span>{parseFloat(amt) > 0 && <span style={{ fontSize: 14, fontFamily: "var(--font-h)", fontWeight: 700, color: tc }}>≈ {fmt(roundMoney(parseFloat(amt) * fxRate))}</span>}</>}</div>}
    </div>
      {type === "expense" && <><label style={ls}>Pay From</label><WB wallets={WALLETS} sel={wid} onSel={sW} /><label style={ls}>Category</label><div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>{cats.map(c => <button key={c.id} onClick={() => sCat(c.id)} style={{ padding: "8px 14px", borderRadius: 10, fontSize: 13, fontFamily: "var(--font-b)", border: `1.5px solid ${catId === c.id ? c.color : "var(--border)"}`, background: catId === c.id ? c.color + "18" : "var(--card)", color: catId === c.id ? c.color : "var(--ts)", cursor: "pointer", fontWeight: catId === c.id ? 600 : 400, display: "flex", alignItems: "center", gap: 5 }}><DI2 id={c.id} accent={c.neon || c.color} size={14} />{c.name}</button>)}</div></>}
      {type === "income" && <><label style={ls}>Receive Into</label><WB wallets={IW} sel={iwid} onSel={sIW} /><label style={ls}>Source</label><div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>{isrc.map(c => <button key={c.id} onClick={() => sSrc(c.id)} style={{ padding: "8px 14px", borderRadius: 10, fontSize: 13, fontFamily: "var(--font-b)", border: `1.5px solid ${srcId === c.id ? c.color : "var(--border)"}`, background: srcId === c.id ? c.color + "18" : "var(--card)", color: srcId === c.id ? c.color : "var(--ts)", cursor: "pointer", fontWeight: srcId === c.id ? 600 : 400, display: "flex", alignItems: "center", gap: 5 }}><DI2 id={c.id} accent={c.neon || c.color} size={14} />{c.name}</button>)}</div></>}
      {type === "transfer" && <><label style={ls}>From</label><WB wallets={WALLETS} sel={tFrom} onSel={sTF} /><div style={{ textAlign: "center", fontSize: 18, color: "var(--muted)", marginBottom: 12 }}>↓</div><label style={ls}>To</label><WB wallets={WALLETS} sel={tTo} onSel={sTT} />{tFrom === tTo && <p style={{ fontSize: 12, color: "#D4726A", textAlign: "center", marginBottom: 12 }}>Must be different.</p>}</>}
      <div style={{ display: "flex", gap: 10, marginBottom: 18 }}><div style={{ flex: 1 }}><label style={ls}>Date</label><input type="date" value={date} onChange={e => sDate(e.target.value)} style={is} /></div><div style={{ flex: 1 }}><label style={ls}>Note</label><input value={note} onChange={e => sNote(e.target.value)} placeholder="Optional…" style={is} /></div></div>
      {type !== "transfer" && <div style={{ marginBottom: 18 }}><ReceiptPicker ref={receiptPickerRef} /></div>}
      <button onClick={submit} disabled={submitting} style={{ width: "100%", padding: "14px", border: "none", borderRadius: 12, background: submitting ? tc + "99" : tc, color: "#fff", fontSize: 15, fontFamily: "var(--font-h)", fontWeight: 600, cursor: submitting ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
        {submitting && <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite" /></path></svg>}
        {submitting ? "Uploading…" : type === "expense" ? "Add Expense" : type === "income" ? "Add Income" : "Transfer"}
      </button></>}
    {type === "recurring" && <><label style={ls}>Name</label><input value={rName} onChange={e => sRN(e.target.value)} placeholder="e.g. Netflix, Rent…" style={{ ...is, marginBottom: 12 }} /><label style={ls}>Amount ({CUR})</label><input type="number" value={rAmt} onChange={e => sRA(e.target.value)} placeholder="0" style={{ ...is, fontSize: 24, fontWeight: 700, fontFamily: "var(--font-h)", textAlign: "center", padding: "14px", color: "#A78BFA", borderColor: "#A78BFA", marginBottom: 12 }} /><label style={ls}>Category</label><div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>{(rCats || RC).map(c => <button key={c.id} onClick={() => sRC(c.id)} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 12, fontFamily: "var(--font-b)", border: `1.5px solid ${rCat === c.id ? c.color : "var(--border)"}`, background: rCat === c.id ? c.color + "18" : "var(--card)", color: rCat === c.id ? c.color : "var(--ts)", cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}><DI2 id={c.id} accent={c.neon || c.color} size={13} />{c.name}</button>)}</div>
      {rCat === "other_rec" && <input value={rOther} onChange={e => sRO(e.target.value)} placeholder="Name this category…" style={{ ...is, marginBottom: 12 }} />}
      <label style={ls}>Wallet</label><WB wallets={IW} sel={rWal} onSel={sRW} /><label style={ls}>Frequency</label><div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>{[{ id: "monthly", label: "Monthly" }, { id: "yearly", label: "Yearly" }, { id: "custom", label: "Every X Days" }].map(f => <button key={f.id} onClick={() => sRF(f.id)} style={{ flex: 1, padding: "9px", borderRadius: 9, fontSize: 12, fontFamily: "var(--font-h)", border: `1.5px solid ${rFreq === f.id ? "#A78BFA" : "var(--border)"}`, background: rFreq === f.id ? "#A78BFA18" : "var(--card)", color: rFreq === f.id ? "#A78BFA" : "var(--muted)", cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap" }}>{f.label}</button>)}</div>
      {rFreq === "monthly" && <div style={{ marginBottom: 12 }}><label style={ls}>Day of Month</label><input type="number" min={1} max={31} value={rDay} onChange={e => sRD(e.target.value)} style={{ ...is, textAlign: "center", fontFamily: "var(--font-h)", fontWeight: 600 }} /></div>}
      {rFreq === "yearly" && <div style={{ display: "flex", gap: 8, marginBottom: 12 }}><div style={{ flex: 1 }}><label style={ls}>Month (1–12)</label><input type="number" min={1} max={12} value={rYM} onChange={e => sRYM(e.target.value)} style={{ ...is, textAlign: "center", fontFamily: "var(--font-h)", fontWeight: 600 }} /></div><div style={{ flex: 1 }}><label style={ls}>Day</label><input type="number" min={1} max={31} value={rYD} onChange={e => sRYD(e.target.value)} style={{ ...is, textAlign: "center", fontFamily: "var(--font-h)", fontWeight: 600 }} /></div></div>}
      {rFreq === "yearly" && (() => { const maxD = new Date(new Date().getFullYear(), Number(rYM), 0).getDate(); return Number(rYD) > maxD ? <div style={{ fontSize: 11, color: "#E07A5F", marginTop: -8, marginBottom: 8 }}>{"Day " + rYD + " → clamps to " + maxD + " in " + ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(rYM)] + ". Bill fires on last available day."}</div> : null; })()}
      {rFreq === "custom" && <div style={{ marginBottom: 12 }}><label style={ls}>Every how many days?</label><input type="number" min={1} value={rInt} onChange={e => sRI(e.target.value)} style={{ ...is, textAlign: "center", fontFamily: "var(--font-h)", fontWeight: 600 }} /></div>}
      <label style={ls}>Start Date</label><input type="date" value={rStart} onChange={e => sRS(e.target.value)} style={{ ...is, marginBottom: 18 }} /><button onClick={submitRec} style={{ width: "100%", padding: "14px", border: "none", borderRadius: 12, background: "#A78BFA", color: "#fff", fontSize: 15, fontFamily: "var(--font-h)", fontWeight: 600, cursor: "pointer" }}>Add Recurring</button></>}</div>
}

function TxCard({ item: it, categories: cats, incomeSources: isrc, events: evs, onDelete: od, recurringCats: rCats }) {
  const isE = it.type === "expense", isI = it.type === "income", isTr = it.type === "transfer", isS = it.type === "settlement";
  const isRec = isE && isFix(it);
  let cat = isE ? cats.find(c => c.id === it.categoryId) : isI ? isrc.find(s => s.id === it.sourceId) : null;
  // Fallback to recurring category list (RC) if not found in user categories
  if (isE && !cat && isRec) {
    const rcMatch = (rCats || RC).find(c => c.id === it.categoryId);
    if (rcMatch) cat = rcMatch;
    else if (it.categoryId === "other_rec") cat = { id: "other_rec", name: "Other", color: "#8A8A9A", neon: "#A0A0B0" };
  }
  const w = WALLETS.find(x => x.id === it.walletId), fW = WALLETS.find(x => x.id === it.fromWallet), tW = WALLETS.find(x => x.id === it.toWallet);
  const ev = it.eventId ? evs?.find(e => e.id === it.eventId) : null, evT = ev ? `● ${ev.name}` : null;
  const fxMeta = (isE || isI) ? getCurrencyMeta(it.id) : null;
  if (isTr) return <div style={{ ...cc, borderRadius: 14, padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}><div style={{ width: 44, height: 44, borderRadius: 12, background: "#7B8CDE14", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>🔄</div><div style={{ flex: 1 }}><div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-h)" }}>Transfer</div><div style={{ fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-b)", marginTop: 2 }}>{fW?.name} → {tW?.name} · {dl(it.date)}</div></div><div style={{ fontFamily: "var(--font-h)", fontWeight: 600, fontSize: 15, color: "#7B8CDE" }}>{fmt(it.amount)}</div><button onClick={() => od(it.id, it.type)} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 14, opacity: 0.35 }}>✕</button></div>;
  if (isS) { const sW = WALLETS.find(x => x.id === it.walletId); return <div style={{ ...cc, borderRadius: 14, padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}><div style={{ width: 44, height: 44, borderRadius: 12, background: it.direction === "owed" ? "#6BAA7514" : "#E07A5F14", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>{it.direction === "owed" ? "💰" : "💸"}</div><div style={{ flex: 1 }}><div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-h)" }}>{it.direction === "owed" ? `${it.splitName} paid back` : `Paid ${it.splitName}`}</div><div style={{ fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-b)", marginTop: 2 }}>{sW?.name} · {dl(it.date)}</div></div><div style={{ fontFamily: "var(--font-h)", fontWeight: 600, fontSize: 15, color: it.direction === "owed" ? "#6BAA75" : "#E07A5F" }}>{it.direction === "owed" ? "+" : "−"}{fmt(it.amount)}</div><button onClick={() => od(it.id, it.type)} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 14, opacity: 0.35 }}>✕</button></div> }
  return <div style={{ ...cc, borderRadius: 14, padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}><div style={{ width: 44, height: 44, borderRadius: 12, background: (cat?.color || "#999") + "14", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{cat ? <DI2 id={cat.id} accent={cat.neon || cat.color} size={22} /> : <span style={{ fontSize: 22 }}>❓</span>}</div><div style={{ flex: 1, minWidth: 0 }}><div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}><span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-h)" }}>{cat?.name || "Unknown"}</span>{isE && <span style={{ fontSize: 7, fontFamily: "var(--font-h)", fontWeight: 600, color: isFix(it) ? "#A78BFA" : "#FBBF24", background: isFix(it) ? "#A78BFA15" : "#FBBF2415", padding: "1px 5px", borderRadius: 3 }}>{isFix(it) ? "FIXED" : "FLEX"}</span>}{w && <span style={{ fontSize: 9, fontFamily: "var(--font-h)", fontWeight: 600, color: w.color, background: w.color + "18", padding: "2px 6px", borderRadius: 4, display: "inline-flex", alignItems: "center", gap: 2 }}><DI2 id={w.id} accent={w.neon || w.color} size={10} /></span>}</div><div style={{ fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-b)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{evT && <span style={{ fontWeight: 600, color: "var(--ts)" }}>{evT} · </span>}{it.note ? it.note + " · " : ""}{dl(it.date)}</div>{fxMeta && <div style={{ fontSize: 10, color: "#7B8CDE", fontFamily: "var(--font-h)", fontWeight: 600, marginTop: 3, letterSpacing: "0.3px" }}>{fxMeta.currency} {fxMeta.originalAmount} @ {Number(fxMeta.rateUsed).toFixed(2)}</div>}
    {(isE || isI) && it.receipt_url && (() => { let urls; try { urls = JSON.parse(it.receipt_url); if (!Array.isArray(urls)) urls = [it.receipt_url]; } catch { urls = [it.receipt_url]; } return <div style={{ marginTop: 3, display: "flex", gap: 8, flexWrap: "wrap" }}>{urls.map((u, i) => <a key={i} href={u} target="_blank" rel="noopener noreferrer" style={{ fontSize: 10, color: "#6BAA75", fontFamily: "var(--font-h)", fontWeight: 600, textDecoration: "none" }}>🧾 {urls.length > 1 ? `Receipt ${i + 1}` : "Receipt"}</a>)}</div>; })()}</div><div style={{ fontFamily: "var(--font-h)", fontWeight: 600, fontSize: 15, color: isE ? "#E07A5F" : "#6BAA75", flexShrink: 0 }}>{isE ? "−" : "+"}{fmt(it.amount)}</div><button onClick={() => od(it.id, it.type)} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 14, opacity: 0.35, flexShrink: 0 }}>✕</button></div>
}

function CalM({ wallet: w, currentBal: cb, onSave: os, onClose: cl }) {
  const [v, sV] = useState(String(roundMoney(cb)));
  const numV = Number(v) || 0;
  const isUpiLite = w.id === "upi_lite";
  const overCap = isUpiLite && numV > 5000;
  const isNeg = numV < 0;
  return <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={cl}><div onClick={e => e.stopPropagation()} style={{ background: "var(--card)", borderRadius: "20px 20px 0 0", padding: 28, width: "100%", maxWidth: 430 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 16, fontWeight: 700, color: "var(--text)", marginBottom: 6, display: "flex", alignItems: "center", gap: 8 }}><DI2 id={w.id} accent={w.neon || w.color} size={20} /> Calibrate {w.name}</div><p style={{ fontSize: 13, color: "var(--muted)", fontFamily: "var(--font-b)", marginBottom: 20, lineHeight: 1.5 }}>Enter your actual current balance.{isUpiLite && " UPI Lite max ₹5000 (RBI)."}</p><label style={ls}>Current Balance ({CUR})</label><input type="number" value={v} onChange={e => sV(e.target.value)} autoFocus style={{ ...is, fontSize: 28, fontWeight: 700, fontFamily: "var(--font-h)", textAlign: "center", padding: "16px", color: (overCap || isNeg) ? "#D4726A" : w.color, borderColor: (overCap || isNeg) ? "#D4726A" : w.color, marginBottom: overCap || isNeg ? 6 : 16 }} />{overCap && <p style={{ fontSize: 11, color: "#D4726A", marginBottom: 14, fontFamily: "var(--font-h)", fontWeight: 600 }}>Exceeds ₹5000 UPI Lite cap</p>}{isNeg && <p style={{ fontSize: 11, color: "#D4726A", marginBottom: 14, fontFamily: "var(--font-h)", fontWeight: 600 }}>Cannot be negative</p>}<div style={{ display: "flex", gap: 10 }}><button onClick={cl} style={{ flex: 1, padding: 14, border: "1.5px solid var(--border)", borderRadius: 12, background: "transparent", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 14, cursor: "pointer" }}>Cancel</button><button disabled={overCap || isNeg} onClick={() => { os(numV); cl() }} style={{ flex: 2, padding: 14, border: "none", borderRadius: 12, background: (overCap || isNeg) ? "#ccc" : w.color, color: "#fff", fontFamily: "var(--font-h)", fontSize: 14, cursor: (overCap || isNeg) ? "not-allowed" : "pointer", fontWeight: 700 }}>Set Balance</button></div></div></div>
}

function RecEditPanel({ r, recCats, onSave, onClose }) {
  const [d, sD] = useState({
    name: r.name, amount: String(r.amount),
    categoryId: r.categoryId, categoryName: r.categoryName || "",
    walletId: r.walletId || "bank", frequency: r.frequency,
    dayOfMonth: r.dayOfMonth || 1, intervalDays: r.intervalDays || 30,
    yearMonth: r.yearMonth || 1, yearDay: r.yearDay || 1,
    startDate: r.startDate,
  });
  const up = patch => sD(p => ({ ...p, ...patch }));
  const allCats = recCats.length ? recCats : RC;
  const rc = allCats.find(c => c.id === d.categoryId) || allCats[0];
  const accent = rc?.neon || rc?.color || "#A78BFA";
  const save = () => {
    const a = roundMoney(d.amount);
    if (!d.name.trim() || !a || a <= 0) return;
    onSave({ name: d.name.trim(), amount: a, categoryId: d.categoryId, categoryName: d.categoryId === "other_rec" ? d.categoryName : null, walletId: d.walletId, frequency: d.frequency, dayOfMonth: d.frequency === "monthly" ? Number(d.dayOfMonth) : null, intervalDays: d.frequency === "custom" ? Number(d.intervalDays) : null, yearMonth: d.frequency === "yearly" ? Number(d.yearMonth) : null, yearDay: d.frequency === "yearly" ? Number(d.yearDay) : null, startDate: d.startDate });
  };
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: "var(--card)", borderRadius: "22px 22px 0 0", width: "100%", maxWidth: 430, maxHeight: "88vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* drag handle */}
        <div style={{ display: "flex", justifyContent: "center", paddingTop: 12, paddingBottom: 4, flexShrink: 0 }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: "var(--border)" }} />
        </div>
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 22px 14px", flexShrink: 0, borderBottom: "1px solid var(--border)" }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: accent + "20", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <DI2 id={rc?.id} accent={accent} size={18} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: "var(--font-h)", fontSize: 15, fontWeight: 700, color: "var(--text)" }}>Edit Recurring</div>
            <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-b)", marginTop: 1 }}>{r.name}</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 18, cursor: "pointer", lineHeight: 1, padding: "4px 6px" }}>✕</button>
        </div>
        {/* scrollable body */}
        <div style={{ overflowY: "auto", padding: "18px 22px", flex: 1, display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Name + Amount */}
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 2 }}>
              <label style={ls}>Name</label>
              <input value={d.name} onChange={e => up({ name: e.target.value })} style={{ ...is }} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={ls}>Amount</label>
              <input type="number" value={d.amount} onChange={e => up({ amount: e.target.value })} style={{ ...is, fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 16, textAlign: "center", color: "#A78BFA", borderColor: "#A78BFA66" }} />
            </div>
          </div>
          {/* Category */}
          <div>
            <label style={ls}>Category</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {allCats.map(c => (
                <button key={c.id} onClick={() => up({ categoryId: c.id })} style={{ padding: "6px 12px", borderRadius: 9, fontSize: 12, fontFamily: "var(--font-b)", border: `1.5px solid ${d.categoryId === c.id ? c.color : "var(--border)"}`, background: d.categoryId === c.id ? c.color + "20" : "var(--card)", color: d.categoryId === c.id ? c.color : "var(--ts)", cursor: "pointer", display: "flex", alignItems: "center", gap: 5, fontWeight: d.categoryId === c.id ? 600 : 400 }}>
                  <DI2 id={c.id} accent={c.neon || c.color} size={13} />{c.name}
                </button>
              ))}
            </div>
          </div>
          {/* Wallet */}
          <div>
            <label style={ls}>Wallet</label>
            <div style={{ display: "flex", gap: 8 }}>
              {IW.map(w => (
                <button key={w.id} onClick={() => up({ walletId: w.id })} style={{ flex: 1, padding: "10px 8px", borderRadius: 10, border: `1.5px solid ${d.walletId === w.id ? w.color : "var(--border)"}`, background: d.walletId === w.id ? w.color + "18" : "var(--card)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                  <DI2 id={w.id} accent={w.neon || w.color} size={14} />
                  <span style={{ fontSize: 12, fontFamily: "var(--font-h)", fontWeight: d.walletId === w.id ? 700 : 400, color: d.walletId === w.id ? w.color : "var(--muted)" }}>{w.name}</span>
                </button>
              ))}
            </div>
          </div>
          {/* Frequency */}
          <div>
            <label style={ls}>Frequency</label>
            <div style={{ display: "flex", gap: 6 }}>
              {[{ id: "monthly", label: "Monthly" }, { id: "yearly", label: "Yearly" }, { id: "custom", label: "Every X Days" }].map(f => (
                <button key={f.id} onClick={() => up({ frequency: f.id })} style={{ flex: 1, padding: "9px 4px", borderRadius: 9, fontSize: 11, fontFamily: "var(--font-h)", border: `1.5px solid ${d.frequency === f.id ? "#A78BFA" : "var(--border)"}`, background: d.frequency === f.id ? "#A78BFA18" : "var(--card)", color: d.frequency === f.id ? "#A78BFA" : "var(--muted)", cursor: "pointer", fontWeight: 600 }}>{f.label}</button>
              ))}
            </div>
          </div>
          {d.frequency === "monthly" && (
            <div>
              <label style={ls}>Day of Month</label>
              <input type="number" min={1} max={31} value={d.dayOfMonth} onChange={e => up({ dayOfMonth: e.target.value })} style={{ ...is, textAlign: "center", fontFamily: "var(--font-h)", fontWeight: 600, fontSize: 16 }} />
            </div>
          )}
          {d.frequency === "yearly" && (
            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ flex: 1 }}><label style={ls}>Month (1–12)</label><input type="number" min={1} max={12} value={d.yearMonth} onChange={e => up({ yearMonth: e.target.value })} style={{ ...is, textAlign: "center", fontFamily: "var(--font-h)", fontWeight: 600 }} /></div>
              <div style={{ flex: 1 }}><label style={ls}>Day</label><input type="number" min={1} max={31} value={d.yearDay} onChange={e => up({ yearDay: e.target.value })} style={{ ...is, textAlign: "center", fontFamily: "var(--font-h)", fontWeight: 600 }} /></div>
            </div>
          )}
          {d.frequency === "yearly" && (() => { const maxD = new Date(new Date().getFullYear(), Number(d.yearMonth), 0).getDate(); return Number(d.yearDay) > maxD ? <div style={{ fontSize: 11, color: "#E07A5F", marginTop: 4, marginBottom: 4 }}>{"Day " + d.yearDay + " → clamps to " + maxD + " in " + ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(d.yearMonth)] + ". Bill fires on last available day."}</div> : null; })()}
          {d.frequency === "custom" && (
            <div>
              <label style={ls}>Every how many days?</label>
              <input type="number" min={1} value={d.intervalDays} onChange={e => up({ intervalDays: e.target.value })} style={{ ...is, textAlign: "center", fontFamily: "var(--font-h)", fontWeight: 600, fontSize: 16 }} />
            </div>
          )}
          <div>
            <label style={ls}>Start Date</label>
            <input type="date" value={d.startDate} onChange={e => up({ startDate: e.target.value })} style={{ ...is }} />
          </div>
        </div>
        {/* footer actions */}
        <div style={{ display: "flex", gap: 10, padding: "14px 22px", borderTop: "1px solid var(--border)", flexShrink: 0, paddingBottom: "max(14px, env(safe-area-inset-bottom))" }}>
          <button onClick={onClose} style={{ flex: 1, padding: 14, border: "1.5px solid var(--border)", borderRadius: 12, background: "transparent", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 14, cursor: "pointer" }}>Cancel</button>
          <button onClick={save} style={{ flex: 2, padding: 14, border: "none", borderRadius: 12, background: "#A78BFA", color: "#fff", fontFamily: "var(--font-h)", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Save Changes</button>
        </div>
      </div>
    </div>
  );
}

const EI = ["film", "food", "travel", "game", "shop", "music", "sport", "party", "study", "work"];
const PHICONS = { film: FilmSlate, food: ForkKnife, travel: Airplane, game: GameController, shop: ShoppingCart, music: MusicNote, sport: Trophy, party: Confetti, study: BookOpen, work: Briefcase };
function EvIcon({ id, size = 18 }) { const Icon = PHICONS[id]; if (!Icon) return <span style={{ fontSize: size }}>📌</span>; return <Icon size={size} /> }

function Events({ events: evs, expenses: ex, splits: sp, settlements: stl, categories: cats, onCreate: oC, onAddExp: oE, onAddSplit: oS, onSettleSplit: oSS, onDeleteSplit: oDS, onMarkDone: oMD, onDelete: oD, dm = false }) {
  const [view, sV] = useState("list"), [selId, sSel] = useState(null), [nn, sNN] = useState(""), [ne, sNE] = useState("film"), [evType, sEvType] = useState("solo"), [evParts, sEvParts] = useState([""]);
  const [ea, sEA] = useState(""), [ec, sEC] = useState(cats[0]?.id || ""), [ew, sEW] = useState("bank"), [en, sEN] = useState(""), [ePaidBy, sEPaidBy] = useState("me");
  const [sn, sSN] = useState(""), [sa, sSA] = useState(""), [sd, sSD] = useState("owed"), [stgt, sSTgt] = useState(null), [spNote, sSPNote] = useState("");
  const [bsOpen, sBsO] = useState(false), [bsMode, sBsM] = useState("equal"), [bsTotal, sBsT] = useState(""), [bsPpl, sBsP] = useState([{ name: "", amount: "" }]), [bsCat, sBsC] = useState(cats[0]?.id || ""), [bsW, sBsW] = useState("bank"), [bsNote, sBsN] = useState(""), [bsStep, sBsS] = useState(1);
  const [evDelConfirm, sEvDelConfirm] = useState(null);
  const fmtDate = d => { if (!d) return ""; const dt = new Date(d + "T00:00:00"), M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]; return `${String(dt.getDate()).padStart(2, "0")} ${M[dt.getMonth()]} ${dt.getFullYear()}`; };
  const sel = evs.find(e => e.id === selId);
  const create = () => { if (!nn.trim()) return; const parts = evType === "group" ? evParts.filter(p => p.trim()) : []; oC({ id: uid(), name: nn.trim(), emoji: ne, date: localDateKey(), status: "active", type: evType, participants: parts }); sNN(""); sNE("film"); sEvType("solo"); sEvParts([""]); sV("list") };
  const addExp = () => { const a = parseFloat(ea); if (!a || a <= 0 || !sel) return; const isGrp = sel.type === "group"; const pb = isGrp ? (ePaidBy === "me" || (sel.participants || []).includes(ePaidBy) ? ePaidBy : "me") : undefined; const ok = oE({ amount: a, categoryId: ec, walletId: ew, note: en, date: localDateKey(), eventId: sel.id, ...(pb ? { paidBy: pb } : {}) }); if (ok !== false) { sEA(""); sEN("") } };
  const addSplit = () => { if (!sn.trim() || !sa || Number(sa) <= 0 || !sel) return; oS({ id: uid(), name: sn.trim(), amount: Number(sa), direction: sd, settled: false, eventId: sel.id, note: spNote }); sSN(""); sSA(""); sSPNote("") };
  const netSpent = (evId) => {
    const e = ex.filter(x => x.eventId === evId).reduce((s, x) => s + x.amount, 0);
    const settleOut = stl.filter(x => x.eventId === evId && x.direction === "owe").reduce((s, x) => s + x.amount, 0);
    const settleIn = stl.filter(x => x.eventId === evId && x.direction === "owed").reduce((s, x) => s + x.amount, 0);
    return Math.max(0, e + settleOut - settleIn);
  };

  const confirmOverlay = evDelConfirm ? (
    <div style={{ position: "fixed", inset: 0, background: dm ? "rgba(0,0,0,0.65)" : "rgba(20,10,0,0.45)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div style={{ background: dm ? "#1a1108" : "#f5f0e6", backgroundImage: `radial-gradient(circle, ${dm ? "rgba(180,140,90,0.12)" : "rgba(140,100,50,0.1)"} 1.2px, transparent 1.2px)`, backgroundSize: "18px 18px", backgroundPosition: "9px 9px", borderRadius: "20px 20px 0 0", padding: "28px 24px 40px", width: "100%", maxWidth: 430, maxHeight: "80vh", overflowY: "auto", borderTop: `1px solid ${dm ? "rgba(180,140,90,0.25)" : "rgba(160,120,70,0.2)"}` }}>
        <div style={{ fontFamily: "var(--font-h)", fontSize: 16, fontWeight: 700, color: dm ? "#f0e6d3" : "#2a1f10", marginBottom: 8 }}>Delete Event?</div>
        <div style={{ fontSize: 13, color: dm ? "#8a7560" : "#9a8060", fontFamily: "var(--font-b)", marginBottom: 24, lineHeight: 1.6 }}>This will permanently delete the event. Linked expenses and splits will remain but lose the event tag.</div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={() => sEvDelConfirm(null)} style={{ flex: 1, padding: 13, border: `1px solid ${dm ? "rgba(200,169,110,0.35)" : "rgba(138,96,48,0.3)"}`, borderRadius: 10, background: dm ? "rgba(30,22,14,0.7)" : "rgba(240,234,220,0.8)", color: dm ? "#c8a96e" : "#8a6030", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
          <button onClick={() => { oD(evDelConfirm); sEvDelConfirm(null); if (view === "detail") sV("list"); }} style={{ flex: 1, padding: 13, border: "none", borderRadius: 10, background: "#c0524a", color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Delete</button>
        </div>
      </div>
    </div>
  ) : null;

  if (view === "create") return <div style={{ paddingTop: 8 }}><button onClick={() => sV("list")} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 13, fontFamily: "var(--font-h)", marginBottom: 16 }}>← Back</button><div style={{ fontFamily: "var(--font-h)", fontSize: 16, fontWeight: 700, color: "var(--text)", marginBottom: 16 }}>New Event</div><div style={{ display: "flex", gap: 8, marginBottom: 16 }}>{[{ id: "solo", label: "Solo Event", sub: "only my spending tracked" }, { id: "group", label: "Group Event", sub: "group total + splits" }].map(t => <button key={t.id} onClick={() => sEvType(t.id)} style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: `2px solid ${evType === t.id ? "#E07A5F" : "var(--border)"}`, background: evType === t.id ? "#E07A5F18" : "var(--card)", cursor: "pointer", textAlign: "left" }}><div style={{ fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 700, color: evType === t.id ? "#E07A5F" : "var(--text)" }}>{evType === t.id ? "● " : "○ "}{t.label}</div><div style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-b)", marginTop: 2 }}>{t.sub}</div></button>)}</div><label style={ls}>Icon</label><div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>{EI.map(id => <button key={id} onClick={() => sNE(id)} style={{ width: 38, height: 38, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", border: `2px solid ${ne === id ? "#E07A5F" : "var(--border)"}`, background: ne === id ? "#E07A5F18" : "var(--card)", cursor: "pointer", color: ne === id ? "#E07A5F" : "var(--muted)" }}><EvIcon id={id} size={18} /></button>)}</div><label style={ls}>Event Name</label><input value={nn} onChange={e => sNN(e.target.value)} placeholder="e.g. Movie Night, Goa Trip…" style={{ ...is, marginBottom: evType === "group" ? 12 : 20 }} />{evType === "group" && <div style={{ marginBottom: 20 }}><label style={ls}>Participants (others, "You" is always included)</label>{evParts.map((p, i) => <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}><input value={p} onChange={e => sEvParts(pp => pp.map((x, idx) => idx === i ? e.target.value : x))} placeholder={`Person ${i + 1} name`} style={{ ...is, flex: 1 }} />{evParts.length > 1 && <button onClick={() => sEvParts(pp => pp.filter((_, idx) => idx !== i))} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 16, opacity: 0.4 }}>✕</button>}</div>)}<button onClick={() => sEvParts(p => [...p, ""])} style={{ background: "none", border: "1px dashed var(--border)", borderRadius: 8, padding: "7px 14px", fontSize: 12, color: "var(--muted)", cursor: "pointer", fontFamily: "var(--font-h)", marginBottom: 0, width: "100%" }}>+ Add person</button></div>}<button onClick={create} style={{ width: "100%", padding: 14, border: "none", borderRadius: 12, background: "#E07A5F", color: "#fff", fontFamily: "var(--font-h)", fontSize: 15, fontWeight: 700, cursor: "pointer" }}>Create Event</button></div>;

  if (view === "detail" && sel) {
    const eExps = ex.filter(e => e.eventId === sel.id), eSp = sp.filter(s => s.eventId === sel.id), ns = netSpent(sel.id), tp = eExps.reduce((s, e) => s + e.amount, 0);
    const isGroup = sel.type === "group", allParts = isGroup ? ["You", ...(sel.participants || [])] : [];
    const grpPaid = isGroup ? allParts.reduce((acc, p) => { acc[p] = eExps.filter(e => p === "You" ? (!e.paidBy || e.paidBy === "me") : e.paidBy === p).reduce((s, e) => s + e.amount, 0); return acc; }, {}) : {};
    const grpTotal = isGroup ? Object.values(grpPaid).reduce((s, v) => s + v, 0) : 0;
    const grpShare = isGroup && allParts.length > 0 ? roundMoney(grpTotal / allParts.length) : 0;
    const tO = eSp.filter(s => s.direction === "owe" && !s.settled).reduce((t, s) => t + s.amount, 0), tI = eSp.filter(s => s.direction === "owed" && !s.settled).reduce((t, s) => t + s.amount, 0);
    return <div style={{ paddingTop: 8 }}><div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}><button onClick={() => sV("list")} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 13, fontFamily: "var(--font-h)" }}>← Events</button><div style={{ display: "flex", gap: 8, alignItems: "center" }}>{sel.status === "active" && <button onClick={() => oMD(sel.id)} style={{ padding: "6px 14px", border: "1.5px solid #6BAA75", borderRadius: 8, background: "#6BAA7518", color: "#6BAA75", fontFamily: "var(--font-h)", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Mark Done ✓</button>}<button onClick={() => sEvDelConfirm(sel.id)} style={{ padding: "6px 12px", border: "1.5px solid #D4726A", borderRadius: 8, background: "#D4726A12", color: "#D4726A", fontFamily: "var(--font-h)", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>🗑 Delete</button></div></div>
      <div style={{ ...cc, padding: 20, marginBottom: 14, display: "flex", alignItems: "center", gap: 14 }}><div style={{ width: 48, height: 48, borderRadius: 12, background: "#E07A5F12", display: "flex", alignItems: "center", justifyContent: "center", color: "#E07A5F", flexShrink: 0 }}><EvIcon id={sel.emoji} size={24} /></div><div style={{ flex: 1 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 17, fontWeight: 700, color: "var(--text)" }}>{sel.name}</div><div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-b)", marginTop: 2 }}>{sel.date} · {sel.status === "active" ? "🟡 Active" : "✅ Done"}{isGroup && <span style={{ marginLeft: 6, fontSize: 10, fontFamily: "var(--font-h)", fontWeight: 600, color: "#7B8CDE", background: "#7B8CDE18", padding: "1px 6px", borderRadius: 4 }}>GROUP</span>}</div></div><div style={{ textAlign: "right" }}><div style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 600 }}>{isGroup ? "GROUP TOTAL" : "NET SPENT"}</div><div style={{ fontSize: 18, fontWeight: 700, fontFamily: "var(--font-h)", color: "#E07A5F" }}>{fmt(isGroup ? grpTotal : ns)}</div><div style={{ fontSize: 9, color: "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 500, marginTop: 3 }}>{isGroup ? `${allParts.length} people` : `Total Paid: ${fmt(tp)}`}</div></div></div>
      {isGroup && allParts.length > 1 && <div style={{ ...cc, padding: 14, marginBottom: 14 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 11, color: "var(--muted)", fontWeight: 600, marginBottom: 10, letterSpacing: "0.5px" }}>GROUP SUMMARY</div><div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-b)", marginBottom: 10 }}>Equal share: {fmt(grpShare)} / person ({allParts.length} people)</div>{allParts.map(p => { const paid = grpPaid[p] || 0, bal = roundMoney(paid - grpShare); const settled = Math.abs(bal) < 0.01, label = settled ? "settled" : bal > 0 ? `get back ${fmt(bal)}` : `owes ${fmt(Math.abs(bal))}`; const color = settled ? "var(--muted)" : bal > 0 ? "#6BAA75" : "#E07A5F"; return <div key={p} style={{ display: "flex", alignItems: "center", padding: "7px 0", borderBottom: "1px solid var(--border)" }}><span style={{ fontSize: 13, fontFamily: "var(--font-h)", color: "var(--text)", flex: 1 }}>{p}</span><span style={{ fontSize: 12, fontFamily: "var(--font-h)", color: "var(--ts)", marginRight: 12 }}>{fmt(paid)}</span><span style={{ fontSize: 11, fontFamily: "var(--font-h)", color, fontWeight: 600 }}>→ {label}</span></div>; })}{(() => { const debtors = allParts.filter(p => p !== "You" && roundMoney((grpPaid[p] || 0) - grpShare) < -0.01); return debtors.length > 0 && <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)" }}>{debtors.map(p => <div key={p} style={{ fontSize: 11, color: "#E07A5F", fontFamily: "var(--font-h)", fontWeight: 600, marginBottom: 4 }}>{p} owes you {fmt(Math.abs(roundMoney((grpPaid[p] || 0) - grpShare)))}</div>)}</div>; })()}</div>}
      {eSp.length > 0 && <div style={{ display: "flex", gap: 8, marginBottom: 14 }}><div style={{ flex: 1, background: "#E07A5F12", borderRadius: 10, padding: "10px 12px", textAlign: "center" }}><div style={{ fontSize: 9, color: "#E07A5F", fontFamily: "var(--font-h)", fontWeight: 600 }}>YOU OWE</div><div style={{ fontSize: 16, fontWeight: 700, fontFamily: "var(--font-h)", color: "#E07A5F" }}>{fmt(tO)}</div></div><div style={{ flex: 1, background: "#6BAA7512", borderRadius: 10, padding: "10px 12px", textAlign: "center" }}><div style={{ fontSize: 9, color: "#6BAA75", fontFamily: "var(--font-h)", fontWeight: 600 }}>OWED TO YOU</div><div style={{ fontSize: 16, fontWeight: 700, fontFamily: "var(--font-h)", color: "#6BAA75" }}>{fmt(tI)}</div></div></div>}
      {eExps.length > 0 && <div style={{ ...cc, padding: 14, marginBottom: 14 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 11, color: "var(--muted)", fontWeight: 600, marginBottom: 10, letterSpacing: "0.5px" }}>EXPENSES</div>{[...eExps].reverse().map(e => { const cat = cats.find(c => c.id === e.categoryId) || { id: "other", name: "Other", color: "#999", neon: "#999" }; return <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--border)" }}><DI2 id={cat.id} accent={cat.neon || cat.color} size={18} /><div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 600, fontFamily: "var(--font-h)", color: "var(--text)" }}>{cat.name}</div>{e.note && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 1 }}>{e.note}</div>}</div><span style={{ fontFamily: "var(--font-h)", fontWeight: 600, color: "#E07A5F", fontSize: 14 }}>−{fmt(e.amount)}</span></div> })}</div>}
      {eSp.length > 0 && <div style={{ ...cc, padding: 14, marginBottom: 14 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 11, color: "var(--muted)", fontWeight: 600, marginBottom: 10, letterSpacing: "0.5px" }}>SPLITS</div>{eSp.map(s => <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--border)", opacity: s.settled ? 0.4 : 1 }}><span style={{ fontSize: 14 }}>{s.settled ? "✅" : s.direction === "owe" ? "🔴" : "🟢"}</span><div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 600, fontFamily: "var(--font-h)", color: "var(--text)" }}>{s.name}</div><div style={{ fontSize: 11, color: "var(--muted)" }}>{s.settled ? "Settled" : s.direction === "owe" ? "You owe" : "Owes you"}</div>{s.note && <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 1, fontStyle: "italic" }}>{s.note}</div>}</div><span style={{ fontFamily: "var(--font-h)", fontWeight: 600, fontSize: 14, color: s.direction === "owe" ? "#E07A5F" : "#6BAA75" }}>{fmt(s.amount)}</span>{!s.settled && <button onClick={() => sSTgt(s)} style={{ border: "1px solid var(--border)", background: "none", borderRadius: 6, padding: "3px 8px", fontSize: 10, color: "var(--muted)", cursor: "pointer" }}>Settle</button>}<button onClick={() => oDS(s.id)} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 13, opacity: 0.4 }}>✕</button></div>)}</div>}
      {sel.status === "active" && <div style={{ ...cc, padding: 16, marginBottom: 14 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 11, color: "var(--muted)", fontWeight: 600, marginBottom: 12, letterSpacing: "0.5px" }}>ADD EXPENSE</div><div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>{cats.map(c => <button key={c.id} onClick={() => sEC(c.id)} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 12, fontFamily: "var(--font-b)", border: `1.5px solid ${ec === c.id ? c.color : "var(--border)"}`, background: ec === c.id ? c.color + "18" : "var(--card)", color: ec === c.id ? c.color : "var(--ts)", cursor: "pointer", fontWeight: ec === c.id ? 600 : 400, display: "flex", alignItems: "center", gap: 4 }}><DI2 id={c.id} accent={c.neon || c.color} size={14} />{c.name}</button>)}</div>{isGroup && <div style={{ marginBottom: 12 }}><label style={ls}>Paid by</label><div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{["me", ...(sel.participants || [])].map(p => { const label = p === "me" ? "You" : p; return <button key={p} onClick={() => sEPaidBy(p)} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontFamily: "var(--font-h)", border: `1.5px solid ${ePaidBy === p ? "#7B8CDE" : "var(--border)"}`, background: ePaidBy === p ? "#7B8CDE18" : "var(--card)", color: ePaidBy === p ? "#7B8CDE" : "var(--ts)", cursor: "pointer", fontWeight: ePaidBy === p ? 600 : 400 }}>{label}</button>; })}</div></div>}{(!isGroup || ePaidBy === "me") && <><label style={ls}>Paid From</label><div style={{ display: "flex", gap: 6, marginBottom: 12 }}>{WALLETS.map(w => <button key={w.id} onClick={() => sEW(w.id)} style={{ flex: 1, padding: "8px", borderRadius: 8, border: `1.5px solid ${ew === w.id ? w.color : "var(--border)"}`, background: ew === w.id ? w.color + "15" : "var(--card)", fontSize: 12, fontWeight: ew === w.id ? 600 : 500, fontFamily: "var(--font-h)", color: ew === w.id ? w.color : "var(--muted)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}><DI2 id={w.id} accent={w.neon || w.color} size={12} />{w.name}</button>)}</div></>}<div style={{ display: "flex", gap: 8 }}><input type="number" value={ea} onChange={e => sEA(e.target.value)} placeholder="₹" style={{ ...is, width: 80 }} /><input value={en} onChange={e => sEN(e.target.value)} placeholder="Note" style={{ ...is, flex: 1 }} /><button onClick={addExp} style={{ padding: "10px 14px", border: "none", borderRadius: 10, background: "#E07A5F", color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>+</button></div></div>}
      {sel.status === "active" && (() => {
        const totalNum = parseFloat(bsTotal) || 0, validPpl = bsPpl.filter(p => p.name.trim()), hc = validPpl.length + 1;
        const equalShares = distributeAmount(totalNum, hc), eqMy = equalShares[0] || 0, eqOthers = validPpl.map((_, i) => equalShares[i + 1] || 0);
        const custOT = bsPpl.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0), custMy = Math.max(0, totalNum - custOT);
        const myShare = bsMode === "equal" ? eqMy : custMy;
        const canSub = totalNum > 0 && validPpl.length > 0 && (bsMode === "equal" || (custOT > 0 && custOT <= totalNum));
        const bsReset = () => { sBsT(""); sBsP([{ name: "", amount: "" }]); sBsN(""); sBsS(1); sBsO(false) };
        const bsSubmit = () => { if (!canSub || !sel) return; const gid = uid(); if (totalNum > 0) { const ok = oE({ amount: totalNum, categoryId: bsCat, walletId: bsW, note: bsNote || `Bill split — paid by you (your share ${fmt(myShare)})`, date: localDateKey(), eventId: sel.id, groupId: gid }); if (ok === false) return } validPpl.forEach((p, idx) => { const amt = bsMode === "equal" ? eqOthers[idx] : roundMoney(parseFloat(p.amount) || 0); if (amt > 0) oS({ id: uid(), name: p.name.trim(), amount: amt, direction: "owed", settled: false, eventId: sel.id, groupId: gid }) }); sBsS(3); setTimeout(bsReset, 2000) };
        if (!bsOpen) return <button onClick={() => sBsO(true)} style={{ width: "100%", padding: 14, border: "1.5px solid #7B8CDE", borderRadius: 14, background: "#7B8CDE12", color: "#7B8CDE", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 600, cursor: "pointer", marginBottom: 14 }}>🧾 Bill Splitter</button>;
        if (bsStep === 3) return <div style={{ ...cc, padding: 24, marginBottom: 14, textAlign: "center" }}><div style={{ fontSize: 32, marginBottom: 8 }}>✅</div><div style={{ fontFamily: "var(--font-h)", fontSize: 14, color: "#6BAA75", fontWeight: 600 }}>Split recorded!</div><div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>Full bill paid. Your final share is {fmt(myShare)}.</div></div>;
        if (bsStep === 2) { const cat = cats.find(c => c.id === bsCat) || cats[0]; return <div style={{ ...cc, padding: 16, marginBottom: 14 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 11, color: "var(--muted)", fontWeight: 600, marginBottom: 14, letterSpacing: "0.5px" }}>🧾 CONFIRM SPLIT</div><div style={{ background: "#E07A5F12", borderRadius: 10, padding: "12px 14px", marginBottom: 10, border: "1px solid #E07A5F30" }}><div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 600, marginBottom: 6 }}>PAID NOW</div><div style={{ display: "flex", alignItems: "center", gap: 10 }}><DI2 id={cat?.id} accent={cat?.neon || cat?.color} size={20} /><div style={{ flex: 1 }}><div style={{ fontSize: 13, fontFamily: "var(--font-h)", fontWeight: 600, color: "var(--text)" }}>Full bill from {WALLETS.find(w => w.id === bsW)?.name || "wallet"}</div></div><div style={{ fontSize: 18, fontWeight: 700, fontFamily: "var(--font-h)", color: "#E07A5F" }}>−{fmt(totalNum)}</div></div></div><div style={{ background: "#6BAA7512", borderRadius: 10, padding: "10px 14px", marginBottom: 14, border: "1px solid #6BAA7530" }}><div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontFamily: "var(--font-h)", color: "var(--ts)" }}><span>Your final share</span><span style={{ fontWeight: 700, color: "#E07A5F" }}>{fmt(myShare)}</span></div></div><div style={{ marginBottom: 14 }}><div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 600, marginBottom: 8 }}>THEY OWE YOU</div>{validPpl.map((p, i) => { const amt = bsMode === "equal" ? eqOthers[i] : roundMoney(parseFloat(p.amount) || 0); return <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid var(--border)" }}><span style={{ fontSize: 13, fontFamily: "var(--font-h)", color: "var(--text)" }}>{p.name}</span><span style={{ fontSize: 13, fontFamily: "var(--font-h)", fontWeight: 600, color: "#6BAA75" }}>{fmt(amt)}</span></div> })}</div><div style={{ display: "flex", gap: 8 }}><button onClick={() => sBsS(1)} style={{ flex: 1, padding: 12, border: "1.5px solid var(--border)", borderRadius: 10, background: "transparent", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 13, cursor: "pointer" }}>← Edit</button><button onClick={bsSubmit} style={{ flex: 2, padding: 12, border: "none", borderRadius: 10, background: "#6BAA75", color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Confirm ✓</button></div></div> }
        return <div style={{ ...cc, padding: 16, marginBottom: 14 }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 11, color: "var(--muted)", fontWeight: 600, letterSpacing: "0.5px" }}>🧾 BILL SPLITTER</div><button onClick={bsReset} style={{ background: "none", border: "none", fontSize: 12, color: "var(--muted)", cursor: "pointer" }}>✕</button></div>
          <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>{[{ id: "equal", label: "Equal Split" }, { id: "custom", label: "Custom Split" }].map(m => <button key={m.id} onClick={() => sBsM(m.id)} style={{ flex: 1, padding: "9px", borderRadius: 8, fontSize: 12, fontFamily: "var(--font-h)", border: `1.5px solid ${bsMode === m.id ? "#7B8CDE" : "var(--border)"}`, background: bsMode === m.id ? "#7B8CDE18" : "var(--card)", color: bsMode === m.id ? "#7B8CDE" : "var(--muted)", cursor: "pointer", fontWeight: 600 }}>{m.label}</button>)}</div>
          <label style={ls}>Note (optional)</label><input value={bsNote} onChange={e => sBsN(e.target.value)} placeholder="What was this bill for?" style={{ ...is, marginBottom: 14 }} /><label style={ls}>Total Bill (₹)</label><input type="number" value={bsTotal} onChange={e => sBsT(e.target.value)} placeholder="0" style={{ ...is, marginBottom: 14, fontSize: 20, fontWeight: 700, fontFamily: "var(--font-h)", textAlign: "center" }} />
          <label style={ls}>People (excluding you)</label>{bsPpl.map((p, i) => <div key={i} style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center" }}><input value={p.name} onChange={e => sBsP(pp => pp.map((x, idx) => idx === i ? { ...x, name: e.target.value } : x))} placeholder="Name" style={{ ...is, flex: 1 }} />{bsMode === "custom" && <input type="number" value={p.amount} onChange={e => sBsP(pp => pp.map((x, idx) => idx === i ? { ...x, amount: e.target.value } : x))} placeholder="₹" style={{ ...is, width: 78 }} />}{bsMode === "custom" && p.name.trim() && !(parseFloat(p.amount) > 0) && <span style={{ fontSize: 10, color: "#E07A5F", flexShrink: 0, fontFamily: "var(--font-h)", fontWeight: 600 }}>₹0!</span>}{bsPpl.length > 1 && <button onClick={() => sBsP(pp => pp.filter((_, idx) => idx !== i))} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 16, opacity: 0.4 }}>✕</button>}</div>)}
          <button onClick={() => sBsP(p => [...p, { name: "", amount: "" }])} style={{ background: "none", border: "1px dashed var(--border)", borderRadius: 8, padding: "7px 14px", fontSize: 12, color: "var(--muted)", cursor: "pointer", fontFamily: "var(--font-h)", marginBottom: 14, width: "100%" }}>+ Add person</button>
          {totalNum > 0 && validPpl.length > 0 && <div style={{ background: "var(--bg)", borderRadius: 10, padding: "10px 14px", marginBottom: 14, border: "1px solid var(--border)" }}>{bsMode === "equal" ? <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontFamily: "var(--font-h)", color: "var(--ts)" }}><span>Per person ({hc})</span><span style={{ fontWeight: 600 }}>{fmt(equalShares[0] || 0)}</span></div> : <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontFamily: "var(--font-h)", color: custOT > totalNum ? "#D4726A" : "var(--ts)" }}><span>Others total</span><span style={{ fontWeight: 600 }}>{fmt(custOT)} / {fmt(totalNum)}{custOT > totalNum ? " (over!)" : ""}</span></div>}<div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontFamily: "var(--font-h)", color: "#E07A5F", fontWeight: 700, marginTop: 6 }}><span>Your share</span><span>{fmt(myShare)}</span></div></div>}
          <label style={ls}>Category</label><div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>{cats.map(c => <button key={c.id} onClick={() => sBsC(c.id)} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 12, fontFamily: "var(--font-b)", border: `1.5px solid ${bsCat === c.id ? c.color : "var(--border)"}`, background: bsCat === c.id ? c.color + "18" : "var(--card)", color: bsCat === c.id ? c.color : "var(--ts)", cursor: "pointer", fontWeight: bsCat === c.id ? 600 : 400 }}><DI2 id={c.id} accent={c.neon || c.color} size={14} /> {c.name}</button>)}</div>
          <label style={ls}>Paid From</label><div style={{ display: "flex", gap: 6, marginBottom: 14 }}>{WALLETS.map(w => <button key={w.id} onClick={() => sBsW(w.id)} style={{ flex: 1, padding: "8px", borderRadius: 8, border: `1.5px solid ${bsW === w.id ? w.color : "var(--border)"}`, background: bsW === w.id ? w.color + "15" : "var(--card)", fontSize: 12, fontWeight: bsW === w.id ? 600 : 500, fontFamily: "var(--font-h)", color: bsW === w.id ? w.color : "var(--muted)", cursor: "pointer" }}><DI2 id={w.id} accent={w.neon || w.color} size={12} /> {w.name}</button>)}</div>
          <button onClick={() => { if (canSub) sBsS(2) }} disabled={!canSub} style={{ width: "100%", padding: 13, border: "none", borderRadius: 10, background: canSub ? "#6BAA75" : "var(--border)", color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 700, cursor: canSub ? "pointer" : "default", opacity: canSub ? 1 : 0.5 }}>Review Split →</button></div>
      })()}
      {sel.status === "active" && <div style={{ ...cc, padding: 16, marginBottom: 14 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 11, color: "var(--muted)", fontWeight: 600, marginBottom: 12, letterSpacing: "0.5px" }}>ADD SPLIT</div><div style={{ display: "flex", gap: 6, marginBottom: 10 }}>{["owed", "owe"].map(d => <button key={d} onClick={() => sSD(d)} style={{ flex: 1, padding: "8px", borderRadius: 8, fontSize: 12, fontFamily: "var(--font-h)", border: `1.5px solid ${sd === d ? (d === "owe" ? "#E07A5F" : "#6BAA75") : "var(--border)"}`, background: sd === d ? (d === "owe" ? "#E07A5F18" : "#6BAA7518") : "var(--card)", color: sd === d ? (d === "owe" ? "#E07A5F" : "#6BAA75") : "var(--muted)", cursor: "pointer", fontWeight: 500 }}>{d === "owe" ? "I owe them" : "They owe me"}</button>)}</div><div style={{ display: "flex", gap: 8 }}><input value={sn} onChange={e => sSN(e.target.value)} placeholder="Friend name" style={{ ...is, flex: 1 }} /><input type="number" value={sa} onChange={e => sSA(e.target.value)} placeholder="₹" style={{ ...is, width: 80 }} /><input value={spNote} onChange={e => sSPNote(e.target.value)} placeholder="Note" style={{ ...is, flex: 1 }} /><button onClick={addSplit} style={{ padding: "10px 14px", border: "none", borderRadius: 10, background: "#6BAA75", color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>+</button></div></div>}
      {stgt && <SettleM split={stgt} onConfirm={wid => { oSS(stgt.id, wid); sSTgt(null) }} onClose={() => sSTgt(null)} />}{confirmOverlay}</div>
  }

  const active = [...evs.filter(e => e.status === "active")].sort((a, b) => (b.date || "").localeCompare(a.date || "")), done = [...evs.filter(e => e.status === "completed")].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const dC = dm ? "#c8a96e" : "#8a6030", dD = dm ? "#8a6a3a" : "#c4a060", tC = dm ? "#f0e6d3" : "#2a1f10", mC = dm ? "#8a7560" : "#9a8060", aC = dm ? "#e8d5b0" : "#3a2810", sC = dm ? "#6a8a5a" : "#4a7040", slC = dm ? "#6a5a45" : "#b0906a", lnC = dm ? "rgba(180,140,90,0.25)" : "rgba(160,120,70,0.22)", bg = dm ? "#140f0a" : "#f5f0e6", cbg = dm ? "rgba(30,22,14,0.82)" : "rgba(255,252,245,0.88)", cbr = dm ? "rgba(180,140,90,0.18)" : "rgba(160,120,70,0.18)";
  const row = (ev, isFirst, isLast, isDone) => { const ns = netSpent(ev.id), ps = sp.filter(s => s.eventId === ev.id && !s.settled).length; return <div key={ev.id} style={{ display: "flex", gap: 10 }}><div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 20, flexShrink: 0 }}><div style={{ width: 9, height: 9, borderRadius: "50%", background: isFirst ? dC : dD, flexShrink: 0, marginTop: 15 }} />{!isLast && <div style={{ flex: 1, width: 1.5, background: lnC, marginTop: 3, minHeight: 20 }} />}</div><div onClick={() => { sSel(ev.id); sEPaidBy("me"); sV("detail") }} style={{ flex: 1, background: cbg, border: `0.5px solid ${cbr}`, borderRadius: 12, padding: "11px 13px", marginBottom: 10, cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}><div style={{ color: dC, flexShrink: 0, display: "flex", alignItems: "center" }}><EvIcon id={ev.emoji} size={18} /></div><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 14, fontWeight: 500, color: tC, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ev.name}</div><div style={{ fontSize: 11, color: mC, marginTop: 3 }}>{fmtDate(ev.date)}{!isDone && ps > 0 ? ` · ⚠️ ${ps}` : ""}</div></div><div style={{ textAlign: "right", flexShrink: 0 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 15, fontWeight: 500, color: aC }}>{fmt(ns)}</div>{isDone && <div style={{ fontSize: 10, color: sC, marginTop: 2 }}>✓ done</div>}</div><button onClick={e => { e.stopPropagation(); sEvDelConfirm(ev.id); }} style={{ background: "none", border: "none", color: mC, cursor: "pointer", fontSize: 14, padding: "2px 4px", opacity: 0.5, flexShrink: 0 }}>✕</button></div></div>; };
  const dotClr = dm ? "rgba(180,140,90,0.18)" : "rgba(140,100,50,0.15)", vigClr = dm ? "rgba(5,3,1,0.72)" : "rgba(210,195,165,0.55)";
  const evBg = `radial-gradient(ellipse at 50% 35%, transparent 20%, ${vigClr} 100%), radial-gradient(circle, ${dotClr} 1.2px, transparent 1.2px) 9px 9px / 18px 18px ${bg}`;
  return <div style={{ position: "relative", background: evBg, paddingBottom: 32, paddingTop: 8, paddingLeft: 16, paddingRight: 16, minHeight: "calc(100vh - 90px)" }}><button onClick={() => sV("create")} style={{ display: "block", width: "100%", padding: 14, border: `1px dashed ${dC}`, borderRadius: 14, background: "transparent", color: dC, fontFamily: "var(--font-h)", fontSize: 14, fontWeight: 600, cursor: "pointer", marginBottom: 16 }}>+ New Event</button>{active.length === 0 && done.length === 0 && <div style={{ textAlign: "center", padding: "60px 20px", color: mC, fontFamily: "var(--font-b)", fontSize: 14, lineHeight: 2 }}>No events yet.<br />Create one!</div>}{active.map((ev, i) => row(ev, i === 0, i === active.length - 1 && done.length === 0, false))}{done.length > 0 && <><div style={{ fontFamily: "var(--font-h)", fontSize: 10, color: slC, fontWeight: 600, letterSpacing: "1.2px", textTransform: "uppercase", marginBottom: 8, paddingLeft: 30 }}>PAST EVENTS</div>{done.map((ev, i) => row(ev, false, i === done.length - 1, true))}</>}{confirmOverlay}</div>;
}

function NI({ type: t, active: a }) {
  const c = a ? "#E07A5F" : "var(--muted)";
  if (t === "dashboard") return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="11" width="7" height="10" rx="1.5" /><rect x="3" y="13" width="7" height="8" rx="1.5" /></svg>;
  if (t === "add") return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>;
  if (t === "events") return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /><circle cx="12" cy="16" r="2" /></svg>;
  if (t === "history") return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><path d="M12 8v4l3 3" /><circle cx="12" cy="12" r="9" /></svg>;
  if (t === "settings") return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>;
  return null
}

// Clean card style
const cc = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: 20, boxShadow: "0 2px 16px rgba(0,0,0,0.04)" };

export default function Nomad() {
  const [module, setModule] = useState("finance");
  const [showSetup, setShowSetup] = useState(needsSetup);
  const [routineTab, setRoutineTab] = useState("food");
  const [backendOpen, sBackendOpen] = useState(false);
  const [reportOpen, sReportOpen] = useState(false);
  const [reportEmail, sReportEmail] = useState("");
  const [reportFreq, sReportFreq] = useState("monthly");
  const [reportCustomDays, sReportCustomDays] = useState(14);
  const [reportSendHour, sReportSendHour] = useState(6);
  const [reportIncExp, sReportIncExp] = useState(true);
  const [reportIncInc, sReportIncInc] = useState(true);
  const [reportIncTr, sReportIncTr] = useState(false);
  const [reportSelCats, sReportSelCats] = useState([]);
  const [reportActive, sReportActive] = useState(true);
  const [reportSendDow, sReportSendDow] = useState(1);
  const [reportSendDom, sReportSendDom] = useState(1);
  const [reportSaving, sReportSaving] = useState(false);
  const [reportScheduleId, sReportScheduleId] = useState(null);
  const [dbSetupModal, sDbSetupModal] = useState(false);
  const [dbSetupToken, sDbSetupToken] = useState("");
  const [dbSetupRunning, sDbSetupRunning] = useState(false);
  const [trendPeriod, sTrendPeriod] = useState("month");
  const [recCats, sRecCats] = useState(RC);
  const [tab, sTab] = useState("dashboard"), [ex, sEx] = useState([]), [inc, sInc] = useState([]), [tr, sTr] = useState([]), [stl, sStl] = useState([]), [cats, sCats] = useState(DC), [isrc, sIsrc] = useState(DI), [sp, sSp] = useState([]), [evs, sEvs] = useState([]), [rec, sRec] = useState([]), [fm, sFm] = useState("all"), [loaded, sL] = useState(false), [ld, sLd] = useState(false), [dm, sDm] = useState(false), [toasts, sToasts] = useState([]), [nn, sNN] = useState(""), [ne2, sNE2] = useState("📁"), [nc, sNC] = useState("#E07A5F"), [mt, sMt] = useState("expense"), [clr, sClr] = useState(false), [nukeTxt, sNukeTxt] = useState(""), [spX, sSpX] = useState(false), [calW, sCalW] = useState(null), [wsb, sWsb] = useState({ upi_lite: 0, bank: 0, cash: 0 });
  const [pendingSync, sPendingSync] = useState(getPendingSyncCount());
  const [online, sOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  const [manageXp, sManageXp] = useState(false);
  const [recDelConfirm, sRecDelConfirm] = useState(null);
  const [recEditId, sRecEditId] = useState(null);
  const [recDelItems, sRecDelItems] = useState(null);
  const [recDelLoading, sRecDelLoading] = useState(false);
  const [hSearch, sHSearch] = useState(""), [hMinAmt, sHMinAmt] = useState(""), [hMaxAmt, sHMaxAmt] = useState(""), [hDateFrom, sHDateFrom] = useState(""), [hDateTo, sHDateTo] = useState(""), [hType, sHType] = useState("all"), [hShowFilters, sHShowFilters] = useState(false);
  const showT = (msg, type = "info") => {
    const id = Date.now() + Math.random();
    sToasts(prev => [...prev, { id, msg, type }]);
    setTimeout(() => sToasts(prev => prev.filter(t => t.id !== id)), 2000);
  };
  const dismissToast = (id) => sToasts(prev => prev.filter(t => t.id !== id));

  useEffect(() => subscribePendingSync(sPendingSync), []);

  useEffect(() => subscribeSyncDrops((info) => {
    if (info.kind === "storage") { showT("Storage full — clear some data or export and reset", "error"); return; }
    if (info.kind === "conflict") { showT("Sync conflict — a newer version exists; local change discarded", "error"); return; }
    if (info.kind === "rejected") { const code = info.status === 0 ? "blocked" : info.status; showT(`Sync rejected (${code}) — change couldn't be saved`, "error"); }
  }), []);

  useEffect(() => {
    if (!loaded || !SB_ENABLED) return;
    const userKey = SB_URL.replace("https://", "").split(".")[0];
    const seenKey = `nomad-last-seen-sent-${userKey}`;
    fetch(`${SB_URL}/rest/v1/report_schedules?user_id=eq.${userKey}&select=last_sent_at,email&limit=1`, { headers: sbH })
      .then(r => r.ok ? r.json() : [])
      .then(d => {
        const row = d[0];
        if (!row?.last_sent_at) return;
        const seen = localStorage.getItem(seenKey);
        if (!seen) {
          localStorage.setItem(seenKey, row.last_sent_at);
          return;
        }
        if (seen === row.last_sent_at) return;
        const age = Date.now() - new Date(row.last_sent_at).getTime();
        if (age < 86400000) showT(`Report emailed to ${row.email}`, "success");
        localStorage.setItem(seenKey, row.last_sent_at);
      }).catch(() => { });
  }, [loaded]);

  useEffect(() => {
    if (!loaded) return;
    const todayStr = localDateKey();
    const reminders = checkBillReminders(rec, sp, todayStr, getRecurringDueDate, isRecurringDueToday);
    if (reminders.length === 0) return;
    if (navigator.vibrate) navigator.vibrate([80, 40, 80]);
    reminders.forEach((r, i) => {
      setTimeout(() => {
        const id = Date.now() + Math.random();
        sToasts(prev => [...prev, { id, msg: r.msg, type: r.type }]);
        setTimeout(() => sToasts(prev => prev.filter(t => t.id !== id)), 4000);
      }, i * 700);
    });
  }, [loaded]);

  useEffect(() => {
    const handleOnline = () => { sOnline(true); flushSyncQueue().catch(() => { }); };
    const handleOffline = () => sOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    const load = async () => {
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        loadLocalBackup({ sEx, sInc, sTr, sStl, sCats, sIsrc, sSp, sRec, sEvs, sDm, sWsb, sRecCats });
        sL(true);
        return;
      }
      try {
        const [dbEx, dbInc, dbTr, dbStl, dbSp, dbRec, dbWsb, dbEvs] = await Promise.all([
          sbGet("expenses"), sbGet("incomes"), sbGet("transfers"), sbGet("settlements"),
          sbGet("splits"), sbGet("recurring"), sbGet("wallet_balances"), sbGet("events")
        ]);
        const hadRemoteFailure = [dbEx, dbInc, dbTr, dbStl, dbSp, dbRec, dbWsb, dbEvs].some(x => x === null);
        if (hadRemoteFailure) {
          loadLocalBackup({ sEx, sInc, sTr, sStl, sCats, sIsrc, sSp, sRec, sEvs, sDm, sWsb, sRecCats });
        } else {
          // If Supabase is empty but localStorage has data, migrate it up (first-time connection)
          const sbHasData = [dbEx, dbInc, dbTr, dbStl, dbSp, dbRec, dbEvs].some(x => x && x.length > 0);
          if (!sbHasData) {
            try {
              const localRaw = localStorage.getItem("nomad-v5");
              if (localRaw) {
                const ld = JSON.parse(localRaw);
                const hasLocal = ["expenses", "incomes", "transfers", "settlements", "splits", "recurring", "events"].some(k => ld[k]?.length > 0);
                if (hasLocal) {
                  const exL = ld.expenses || [], incL = ld.incomes || [], trL = ld.transfers || [];
                  const stlL = ld.settlements || [], spL = ld.splits || [], recL = ld.recurring || [], evsL = ld.events || [];
                  if (exL.length) sbUpsert("expenses", exL.map(e => toSB(e, ["id", "amount", "categoryId", "walletId", "note", "date", "eventId", "groupId"])));
                  if (incL.length) sbUpsert("incomes", incL.map(i => toSB(i, ["id", "amount", "sourceId", "walletId", "note", "date"])));
                  if (trL.length) sbUpsert("transfers", trL.map(t => toSB(t, ["id", "amount", "fromWallet", "toWallet", "note", "date"])));
                  if (stlL.length) sbUpsert("settlements", stlL.map(s => toSB(s, ["id", "amount", "splitName", "splitId", "direction", "walletId", "date", "groupId", "eventId"])));
                  if (spL.length) sbUpsert("splits", spL.map(s => toSB(s, ["id", "name", "amount", "direction", "settled", "eventId", "groupId"])));
                  if (recL.length) sbUpsert("recurring", recL.map(r => toSB(r, ["id", "name", "amount", "categoryId", "categoryName", "walletId", "frequency", "dayOfMonth", "intervalDays", "yearMonth", "yearDay", "startDate", "active", "lastPaidDate", "lastSkippedDate"])));
                  if (evsL.length) sbUpsert("events", evsL.map(e => toSB(e, ["id", "name", "emoji", "date", "status"])));
                  if (ld.walletStartBal) Object.entries(ld.walletStartBal).forEach(([wid, bal]) => sbUpsert("wallet_balances", [{ wallet_id: wid, balance: bal }], `wallet_balances:${wid}`));
                  sEx(exL); sInc(incL); sTr(trL); sStl(stlL); sSp(spL); sRec(recL); sEvs(evsL);
                  if (ld.categories?.length) sCats(ld.categories);
                  if (ld.incomeSources?.length) sIsrc(ld.incomeSources);
                  if (ld.darkMode !== undefined) sDm(ld.darkMode);
                  if (ld.walletStartBal) sWsb(ld.walletStartBal);
                  sL(true);
                  return;
                }
              }
            } catch { }
          }
          sEx(dbEx || []);
          sInc(dbInc || []);
          sTr(dbTr || []);
          sStl(dbStl || []);
          sSp(dbSp || []);
          sRec(dbRec || []);
          // Normalize events: participants is JSONB and could be malformed (null,
          // object, array of non-strings) from a 3rd-party write or a bad import.
          // Coerce to a clean string[] so the rest of the app can trust it.
          sEvs((dbEvs || []).map(e => ({ ...e, participants: Array.isArray(e?.participants) ? e.participants.filter(p => typeof p === "string") : [] })));
          if (dbWsb?.length) { const wb = { upi_lite: 0, bank: 0, cash: 0 }; dbWsb.forEach(r => { wb[r.wallet_id] = r.balance }); sWsb(wb) }
          // Restore local-only preferences (not stored in Supabase)
          try {
            const lp = JSON.parse(localStorage.getItem("nomad-v5") || "{}");
            if (lp.darkMode !== undefined) sDm(lp.darkMode);
            if (lp.categories?.length) sCats(lp.categories);
            if (lp.incomeSources?.length) sIsrc(lp.incomeSources);
          } catch { }
        }
      } catch {
        loadLocalBackup({ sEx, sInc, sTr, sStl, sCats, sIsrc, sSp, sRec, sEvs, sDm, sWsb, sRecCats });
      }
      sL(true);
    };
    load();
  }, []);
  // Keep localStorage in sync as offline backup (debounced 800ms)
  const backupDebounceRef = useRef(null);
  useEffect(() => {
    if (!loaded) return;
    if (backupDebounceRef.current) clearTimeout(backupDebounceRef.current);
    backupDebounceRef.current = setTimeout(() => {
      try { localStorage.setItem("nomad-v5", JSON.stringify({ expenses: ex, incomes: inc, transfers: tr, settlements: stl, categories: cats, incomeSources: isrc, splits: sp, events: evs, recurring: rec, darkMode: dm, walletStartBal: wsb, recCats, _modified: Date.now() })) } catch { }
    }, 800);
  }, [ex, inc, tr, stl, cats, isrc, sp, evs, rec, dm, wsb, loaded]);

  const allM = useMemo(() => { const s = new Set(); ex.forEach(e => s.add(mk(e.date))); inc.forEach(i => s.add(mk(i.date))); return [...s].sort() }, [ex, inc]);
  const quickPatterns = useMemo(() => { const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 60); const cutStr = localDateKey(cutoff); const counts = {}; ex.filter(e => !e.deleted_at && (e.date || "") >= cutStr).forEach(e => { const k = `${e.amount}|${e.categoryId || ""}|${e.walletId || "upi_lite"}|${(e.note || "").slice(0, 30)}`; if (!counts[k]) counts[k] = { count: 0, amount: e.amount, categoryId: e.categoryId || "", walletId: e.walletId || "upi_lite", note: e.note || "" }; counts[k].count++; }); return Object.values(counts).filter(p => p.count >= 2).sort((a, b) => b.count - a.count).slice(0, 5); }, [ex]);
  const flt = useMemo(() => fm === "all" ? { expenses: ex, incomes: inc, settlements: stl } : { expenses: ex.filter(e => mk(e.date) === fm), incomes: inc.filter(i => mk(i.date) === fm), settlements: stl.filter(s => mk(s.date) === fm) }, [ex, inc, stl, fm]);
  const tI = flt.incomes.reduce((s, i) => s + i.amount, 0), tE = Math.max(0, flt.expenses.reduce((s, e) => s + e.amount, 0) + flt.settlements.filter(s => s.direction === "owe").reduce((s, x) => s + x.amount, 0) - flt.settlements.filter(s => s.direction === "owed").reduce((s, x) => s + x.amount, 0));
  const historyItems = useMemo(() => {
    const searching = hSearch.trim() !== "";
    let items = searching
      ? [...ex.map(e => ({ ...e, type: "expense" })), ...inc.map(i => ({ ...i, type: "income" })), ...tr.map(t => ({ ...t, type: "transfer" })), ...stl.map(s => ({ ...s, type: "settlement" }))]
      : [...flt.expenses.map(e => ({ ...e, type: "expense" })), ...flt.incomes.map(i => ({ ...i, type: "income" })), ...(fm === "all" ? tr : tr.filter(t => mk(t.date) === fm)).map(t => ({ ...t, type: "transfer" })), ...(fm === "all" ? stl : stl.filter(s => mk(s.date) === fm)).map(s => ({ ...s, type: "settlement" }))];
    if (searching) { const q = hSearch.toLowerCase().trim(); items = items.filter(it => (it.note || "").toLowerCase().includes(q) || (cats.find(c => c.id === it.categoryId)?.name || "").toLowerCase().includes(q) || (isrc.find(s => s.id === it.sourceId)?.name || "").toLowerCase().includes(q) || (it.splitName || "").toLowerCase().includes(q)); }
    if (hMinAmt !== "") items = items.filter(it => it.amount >= parseFloat(hMinAmt));
    if (hMaxAmt !== "") items = items.filter(it => it.amount <= parseFloat(hMaxAmt));
    if (hDateFrom) items = items.filter(it => it.date >= hDateFrom);
    if (hDateTo) items = items.filter(it => it.date <= hDateTo);
    if (hType !== "all") items = items.filter(it => it.type === hType);
    return items.sort((a, b) => { const dd = new Date(b.date) - new Date(a.date); if (dd !== 0) return dd; return parseInt(b.id, 36) - parseInt(a.id, 36); });
  }, [flt, ex, inc, tr, stl, fm, hSearch, hMinAmt, hMaxAmt, hDateFrom, hDateTo, hType, cats, isrc]);

  const wBal = useMemo(() => { const b = { upi_lite: wsb.upi_lite || 0, bank: wsb.bank || 0, cash: wsb.cash || 0 }; inc.forEach(i => { const w = i.walletId || "bank"; if (b[w] !== undefined) b[w] += i.amount }); ex.forEach(e => { const w = e.walletId || "upi_lite"; if (b[w] !== undefined) b[w] -= e.amount }); tr.forEach(t => { if (b[t.fromWallet] !== undefined) b[t.fromWallet] -= t.amount; if (b[t.toWallet] !== undefined) b[t.toWallet] += t.amount }); stl.forEach(s => { if (b[s.walletId] !== undefined) { if (s.direction === "owed") b[s.walletId] += s.amount; else b[s.walletId] -= s.amount } }); return b }, [ex, inc, tr, stl, wsb]);
  const mBal = Object.values(wBal).reduce((s, v) => s + v, 0);

  const dance = () => { sLd(true); setTimeout(() => sLd(false), 1800) };
  const toSB = (obj, keys) => Object.fromEntries(keys.map(k => [k, obj[k] ?? null]));
  // Compute historical balance up to and including a given date for a wallet
  const balanceOnDate = (walletId, date) => {
    const start = wsb[walletId] || 0;
    const incSum = inc.filter(i => (i.walletId || "bank") === walletId && i.date <= date).reduce((s, i) => s + i.amount, 0);
    const exSum = ex.filter(e => (e.walletId || "upi_lite") === walletId && e.date <= date).reduce((s, e) => s + e.amount, 0);
    const trIn = tr.filter(t => t.toWallet === walletId && t.date <= date).reduce((s, t) => s + t.amount, 0);
    const trOut = tr.filter(t => t.fromWallet === walletId && t.date <= date).reduce((s, t) => s + t.amount, 0);
    const stlAdj = stl.filter(s => s.walletId === walletId && s.date <= date).reduce((s, x) => s + (x.direction === "owed" ? x.amount : -x.amount), 0);
    return start + incSum - exSum + trIn - trOut + stlAdj;
  };

  // UPI Lite limits (RBI: ₹5000/day, ₹1L/month)
  const upiLiteUsage = (date) => {
    const mk = String(date || "").slice(0, 7);
    const day = ex.filter(e => e.walletId === "upi_lite" && e.date === date).reduce((s, e) => s + e.amount, 0);
    const month = ex.filter(e => e.walletId === "upi_lite" && String(e.date || "").slice(0, 7) === mk).reduce((s, e) => s + e.amount, 0);
    return { day, month };
  };

  const addE = data => {
    const amt = roundMoney(data.amount);
    if (amt <= 0) { showT("Enter a valid amount", "error"); return false }
    if (typeof data.note === "string" && data.note.length > 500) data = { ...data, note: data.note.slice(0, 500) };
    if (data.paidBy && data.paidBy !== "me") {
      const rec = { id: uid(), type: "expense", ...data, amount: amt, walletId: "__tracked__" };
      sEx(p => [rec, ...p]);
      sbUpsert("expenses", [toSB(rec, ["id", "amount", "categoryId", "walletId", "note", "date", "eventId", "groupId"])]);
      showT(online ? "Expense tracked" : "Expense saved offline", "success");
      return true;
    }
    const w = WALLETS.find(x => x.id === data.walletId);
    const today = localDateKey();
    const isBackdated = data.date && data.date < today;
    // Use historical balance for backdated, current for today/future
    const b = roundMoney(isBackdated ? balanceOnDate(data.walletId, data.date) : (wBal[data.walletId] || 0));
    if (b < amt) { showT(isBackdated ? `${w?.name} only had ${fmt(b)} on ${data.date} (need ${fmt(amt)})` : `Not enough in ${w?.name} (have ${fmt(b)}, need ${fmt(amt)})`, "error"); return false }
    // UPI Lite cap warnings
    if (data.walletId === "upi_lite") {
      const u = upiLiteUsage(data.date || today);
      if (u.day + amt > 5000) { showT(`UPI Lite daily cap ₹5000 exceeded (₹${u.day} used)`, "error"); return false }
      if (u.month + amt > 100000) { showT(`UPI Lite monthly cap ₹1L exceeded`, "error"); return false }
      if (u.day + amt > 4500) { showT(`Heads up: UPI Lite at ₹${roundMoney(u.day + amt)} today (cap ₹5000)`, "info") }
    }
    const rec = { id: uid(), type: "expense", ...data, amount: amt };
    sEx(p => [rec, ...p]);
    sbUpsert("expenses", [toSB(rec, ["id", "amount", "categoryId", "walletId", "note", "date", "eventId", "groupId", "receipt_url", "paidBy"])]);
    dance();
    showT(online ? "Expense added" : "Expense saved offline", "success");
    return true;
  };
  const addI = data => { const amt = roundMoney(data.amount); if (data.walletId === "upi_lite") { showT("UPI Lite is for spending only", "error"); return } if (amt <= 0) { showT("Enter a valid amount", "error"); return } if (typeof data.note === "string" && data.note.length > 500) data = { ...data, note: data.note.slice(0, 500) }; const rec = { id: uid(), type: "income", ...data, amount: amt }; sInc(p => [rec, ...p]); sbUpsert("incomes", [toSB(rec, ["id", "amount", "sourceId", "walletId", "note", "date", "receipt_url"])]); dance(); showT(online ? "Income added" : "Income saved offline", "success") };
  const addT = data => { const b = roundMoney(wBal[data.fromWallet] || 0), amt = roundMoney(data.amount); if (amt <= 0) { showT("Enter an amount above zero", "error"); return } if (b < amt) { showT(`Insufficient balance`, "error"); return } if (typeof data.note === "string" && data.note.length > 500) data = { ...data, note: data.note.slice(0, 500) }; const rec = { id: uid(), type: "transfer", ...data, amount: amt }; sTr(p => [rec, ...p]); sbUpsert("transfers", [toSB(rec, ["id", "amount", "fromWallet", "toWallet", "note", "date"])]); dance(); showT(online ? "Transfer done" : "Transfer queued offline", "success") };
  const settle = (sid, wid) => {
    const s = sp.find(x => x.id === sid);
    if (!s) return;
    const today = localDateKey();
    if (s.direction === "owe") {
      // Paying someone back — UPI Lite allowed, but apply caps
      const b = wBal[wid] || 0;
      if (b < s.amount) { showT("Not enough to settle", "error"); return }
      if (wid === "upi_lite") {
        const u = upiLiteUsage(today);
        if (u.day + s.amount > 5000) { showT(`UPI Lite daily cap ₹5000 exceeded (₹${u.day} used)`, "error"); return }
        if (u.month + s.amount > 100000) { showT(`UPI Lite monthly cap ₹1L exceeded`, "error"); return }
        if (u.day + s.amount > 4500) { showT(`Heads up: UPI Lite at ₹${roundMoney(u.day + s.amount)} today`, "info") }
      }
    }
    if (s.direction === "owed" && wid === "upi_lite") { showT("UPI Lite cannot receive money", "error"); return }
    const rec = { id: uid(), type: "settlement", splitName: s.name, splitId: s.id, amount: s.amount, direction: s.direction, walletId: wid, date: today, ...(s.groupId && { groupId: s.groupId }), ...(s.eventId && { eventId: s.eventId }) };
    sStl(p => [...p, rec]);
    sbUpsert("settlements", [toSB(rec, ["id", "amount", "splitName", "splitId", "direction", "walletId", "date", "groupId", "eventId"])]);
    sSp(p => p.map(x => x.id === sid ? { ...x, settled: true } : x));
    sbUpsert("splits", [{ id: sid, settled: true }], `splits:${sid}`);
    showT(online ? "Settled" : "Settlement queued offline", "success");
  };
  const undoBuffersRef = useRef(new Map()); // toastId -> buffer

  const undoDelete = (toastId) => {
    const buf = undoBuffersRef.current.get(toastId);
    if (!buf) return;
    if (buf.type === "expense") {
      sEx(p => [buf.exp, ...p]);
      sbUpsert("expenses", [toSB(buf.exp, ["id", "amount", "categoryId", "walletId", "note", "date", "eventId", "groupId"])]);
      if (buf.splits?.length) { sSp(p => [...p, ...buf.splits]); sbUpsert("splits", buf.splits.map(s => toSB(s, ["id", "name", "amount", "direction", "settled", "eventId", "groupId"]))); }
      if (buf.settlements?.length) { sStl(p => [...p, ...buf.settlements]); sbUpsert("settlements", buf.settlements.map(s => toSB(s, ["id", "amount", "splitName", "splitId", "direction", "walletId", "date", "groupId", "eventId"]))); }
    } else if (buf.type === "income") { sInc(p => [buf.exp, ...p]); sbUpsert("incomes", [toSB(buf.exp, ["id", "amount", "sourceId", "walletId", "note", "date"])]); }
    else if (buf.type === "transfer") { sTr(p => [buf.exp, ...p]); sbUpsert("transfers", [toSB(buf.exp, ["id", "amount", "fromWallet", "toWallet", "note", "date"])]); }
    else if (buf.type === "settlement") { sStl(p => [...p, buf.exp]); sbUpsert("settlements", [toSB(buf.exp, ["id", "amount", "splitName", "splitId", "direction", "walletId", "date", "groupId", "eventId"])]); if (buf.exp.splitId) { sSp(p => p.map(x => x.id === buf.exp.splitId ? { ...x, settled: true } : x)); sbUpsert("splits", [{ id: buf.exp.splitId, settled: true }], `splits:${buf.exp.splitId}`); } }
    undoBuffersRef.current.delete(toastId);
    dismissToast(toastId);
    showT("Restored", "success");
  };

  const showUndoToast = (msg, buffer) => {
    const id = Date.now() + Math.random();
    undoBuffersRef.current.set(id, buffer);
    sToasts(prev => [...prev, { id, msg, type: "info", undo: true }]);
    setTimeout(() => {
      sToasts(prev => prev.filter(t => t.id !== id));
      undoBuffersRef.current.delete(id);
    }, 5000);
  };

  const delItem = (id, type) => {
    if (type === "expense") {
      const exp = ex.find(e => e.id === id);
      if (!exp) return;
      const splits = exp.groupId ? sp.filter(s => s.groupId === exp.groupId) : [];
      const settlements = exp.groupId ? stl.filter(s => s.groupId === exp.groupId) : [];
      sEx(p => p.filter(e => e.id !== id));
      sbDelete("expenses", id);
      if (exp.groupId) {
        sSp(p => p.filter(s => s.groupId !== exp.groupId));
        sStl(p => p.filter(s => s.groupId !== exp.groupId));
        sbDeleteWhere("splits", `group_id=eq.${exp.groupId}`);
        sbDeleteWhere("settlements", `group_id=eq.${exp.groupId}`);
      }
      showUndoToast("Expense deleted", { type: "expense", exp, splits, settlements });
    } else if (type === "income") {
      const exp = inc.find(i => i.id === id); if (!exp) return;
      sInc(p => p.filter(i => i.id !== id)); sbDelete("incomes", id);
      showUndoToast("Income deleted", { type: "income", exp });
    } else if (type === "transfer") {
      const exp = tr.find(t => t.id === id); if (!exp) return;
      sTr(p => p.filter(t => t.id !== id)); sbDelete("transfers", id);
      showUndoToast("Transfer deleted", { type: "transfer", exp });
    } else if (type === "settlement") {
      const stlRec = stl.find(s => s.id === id); if (!stlRec) return;
      sStl(p => p.filter(s => s.id !== id)); sbDelete("settlements", id);
      if (stlRec.splitId) { sSp(p => p.map(x => x.id === stlRec.splitId ? { ...x, settled: false } : x)); sbUpsert("splits", [{ id: stlRec.splitId, settled: false }], `splits:${stlRec.splitId}`); }
      showUndoToast("Settlement deleted", { type: "settlement", exp: stlRec });
    }
  };
  const addRec = r => { sRec(p => [...p, r]); sbUpsert("recurring", [toSB(r, ["id", "name", "amount", "categoryId", "categoryName", "walletId", "frequency", "dayOfMonth", "intervalDays", "yearMonth", "yearDay", "startDate", "active", "lastPaidDate", "lastSkippedDate"])]); showT(r.name + " added as recurring", "success"); };
  const addCust = () => { if (!nn.trim()) return; const id = nn.trim().toLowerCase().replace(/\s+/g, "_") + "_" + uid(), item = { id, name: nn.trim(), emoji: ne2, color: nc }; if (mt === "expense") sCats(p => [...p, item]); else sIsrc(p => [...p, item]); sNN(""); sNE2("📁"); sNC("#E07A5F") };
  const handleCal = (wId, desired) => {
    if (wId === "upi_lite" && desired > 5000) {
      showT("UPI Lite max balance is ₹5000 (RBI rule)", "error");
      return;
    }
    if (desired < 0) {
      showT("Balance cannot be negative", "error");
      return;
    }
    const cur = wBal[wId], start = wsb[wId] || 0, newStart = start + (desired - cur);
    sWsb(p => ({ ...p, [wId]: newStart }));
    sbUpsert("wallet_balances", [{ wallet_id: wId, balance: newStart }], `wallet_balances:${wId}`);
    showT("Balance updated", "success");
  };
  const expCSV = () => { let csv = "Type,Date,Amount,Category/Source,Wallet,Note\n"; inc.forEach(i => { csv += `Income,${i.date},${i.amount},"${isrc.find(s => s.id === i.sourceId)?.name || ""}","${WALLETS.find(x => x.id === i.walletId)?.name || "Bank"}","${i.note || ""}"\n` }); ex.forEach(e => { csv += `Expense,${e.date},${e.amount},"${cats.find(c => c.id === e.categoryId)?.name || ""}","${WALLETS.find(x => x.id === e.walletId)?.name || ""}","${e.note || ""}"\n` }); tr.forEach(t => { csv += `Transfer,${t.date},${t.amount},"${t.fromWallet}→${t.toWallet}","","${t.note || ""}"\n` }); stl.forEach(s => { csv += `Settlement,${s.date},${s.amount},"${s.splitName}","${WALLETS.find(w => w.id === s.walletId)?.name || ""}","${s.direction}"\n` }); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = `nomad_${localDateKey()}.csv`; a.click() };
  const expBackup = () => { const data = JSON.stringify({ expenses: ex, incomes: inc, transfers: tr, settlements: stl, categories: cats, incomeSources: isrc, splits: sp, events: evs, recurring: rec, darkMode: dm, walletStartBal: wsb, _v: "nomad-v9", _date: new Date().toISOString() }, null, 2); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([data], { type: "application/json" })); a.download = `nomad_backup_${localDateKey()}.json`; a.click(); showT("Backup downloaded", "success") };
  const loadRecentlyDeleted = async () => { sRecDelLoading(true); const [dEx, dInc, dTr, dRec] = await Promise.all([sbGetDeleted("expenses"), sbGetDeleted("incomes"), sbGetDeleted("transfers"), sbGetDeleted("recurring")]); const all = [...(dEx || []).map(i => ({ ...i, _tbl: "expenses" })), ...(dInc || []).map(i => ({ ...i, _tbl: "incomes" })), ...(dTr || []).map(i => ({ ...i, _tbl: "transfers" })), ...(dRec || []).map(i => ({ ...i, _tbl: "recurring" }))].sort((a, b) => (b.deleted_at || "").localeCompare(a.deleted_at || "")); sRecDelItems(all); sRecDelLoading(false); };
  const restoreDeleted = (item) => { const { _tbl, ...row } = item; sbWrite(`${SB_URL}/rest/v1/${_tbl}?id=eq.${row.id}`, { method: "PATCH", body: { deleted_at: null } }); const clean = { ...row, deleted_at: null }; if (_tbl === "expenses") sEx(p => [...p, clean]); else if (_tbl === "incomes") sInc(p => [...p, clean]); else if (_tbl === "transfers") sTr(p => [...p, clean]); else if (_tbl === "recurring") sRec(p => [...p, clean]); sRecDelItems(p => p ? p.filter(i => i.id !== row.id) : p); showT("Restored", "success"); };
  const loadReportSchedule = () => {
    if (!SB_ENABLED) return;
    const userKey = SB_URL.replace("https://", "").split(".")[0];
    fetch(`${SB_URL}/rest/v1/report_schedules?user_id=eq.${userKey}&select=*&limit=1`, { headers: sbH })
      .then(r => r.ok ? r.json() : [])
      .then(d => {
        if (!d[0]) return;
        const s = d[0];
        sReportScheduleId(s.id ?? null);
        sReportEmail(s.email ?? "");
        sReportFreq(s.frequency ?? "monthly");
        sReportCustomDays(s.custom_days ?? 14);
        sReportSendHour(s.send_hour ?? 6);
        sReportIncExp(s.include_expenses ?? true);
        sReportIncInc(s.include_incomes ?? true);
        sReportIncTr(s.include_transfers ?? false);
        sReportSelCats(s.selected_categories ?? []);
        sReportActive(s.is_active ?? false);
        sReportSendDow(s.send_day_of_week ?? 1);
        sReportSendDom(s.send_day_of_month ?? 1);
      })
      .catch(() => { });
  };
  const _doSaveSchedule = async () => {
    const userId = SB_URL.replace("https://", "").split(".")[0];
    const now = new Date();
    const next = new Date(now);
    // Compare against IST current hour (UTC+5:30)
    const nowISTH = Math.floor(((now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % 1440) / 60);
    if (reportFreq === "weekly") {
      const dow = reportSendDow;
      let diff = dow - now.getUTCDay();
      if (diff < 0 || (diff === 0 && nowISTH >= reportSendHour)) diff += 7;
      next.setUTCDate(next.getUTCDate() + diff);
    } else if (reportFreq === "monthly") {
      const dom = Math.min(reportSendDom, new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate());
      next.setUTCDate(dom);
      if (now.getUTCDate() > dom || (now.getUTCDate() === dom && nowISTH >= reportSendHour)) next.setUTCMonth(next.getUTCMonth() + 1);
    } else if (reportFreq === "quarterly") {
      const dom = Math.min(reportSendDom, new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate());
      next.setUTCDate(dom);
      if (now.getUTCDate() > dom || (now.getUTCDate() === dom && nowISTH >= reportSendHour)) next.setUTCMonth(next.getUTCMonth() + 3);
    } else {
      next.setUTCDate(next.getUTCDate() + (reportCustomDays || 7));
    }
    // Convert IST send_hour to UTC (IST = UTC+5:30)
    const istMin = reportSendHour * 60 - 330;
    const utcMin = ((istMin % 1440) + 1440) % 1440;
    if (istMin < 0) next.setUTCDate(next.getUTCDate() - 1);
    next.setUTCHours(Math.floor(utcMin / 60), utcMin % 60, 0, 0);
    const payload = {
      user_id: userId,
      email: reportEmail.trim(),
      frequency: reportFreq,
      custom_days: reportFreq === "custom" ? (reportCustomDays || 7) : null,
      send_hour: reportSendHour,
      send_day_of_week: reportFreq === "weekly" ? reportSendDow : null,
      send_day_of_month: (reportFreq === "monthly" || reportFreq === "quarterly") ? reportSendDom : null,
      include_expenses: reportIncExp,
      include_incomes: reportIncInc,
      include_transfers: reportIncTr,
      selected_categories: reportSelCats.length ? reportSelCats : null,
      next_send_at: next.toISOString(),
      is_active: reportActive,
    };
    if (reportScheduleId) {
      return fetch(`${SB_URL}/rest/v1/report_schedules?id=eq.${reportScheduleId}`, {
        method: "PATCH",
        headers: { ...sbH, "Prefer": "return=minimal" },
        body: JSON.stringify(payload),
      });
    } else {
      const r = await fetch(`${SB_URL}/rest/v1/report_schedules`, {
        method: "POST",
        headers: { ...sbH, "Prefer": "return=representation" },
        body: JSON.stringify([payload]),
      });
      if (r.ok) {
        const created = await r.json().catch(() => []);
        if (created[0]?.id) sReportScheduleId(created[0].id);
      }
      return r;
    }
  };

  const saveReportSchedule = async () => {
    if (!reportEmail.trim()) { showT("Enter an email address", "error"); return; }
    if (!SB_ENABLED) { showT("Supabase not configured", "error"); return; }
    sReportSaving(true);
    try {
      const r = await _doSaveSchedule();
      if (r.ok) {
        showT("Report schedule saved", "success");
        const registryUrl = import.meta.env.VITE_SUPABASE_URL;
        const registryKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
        if (registryUrl && registryKey) {
          fetch(`${registryUrl}/rest/v1/user_registry`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "apikey": registryKey, "Authorization": `Bearer ${registryKey}`, "Prefer": "resolution=merge-duplicates" },
            body: JSON.stringify([{ supabase_url: SB_URL, anon_key: _creds.sbKey }])
          }).catch(() => { });
        }
      } else {
        // Check if this is a missing-table error (42P01 = relation does not exist)
        const errBody = await r.json().catch(() => ({}));
        const isMissingTable = errBody?.code === "42P01" || (errBody?.message ?? "").includes("does not exist");
        if (isMissingTable) {
          sDbSetupModal(true);
        } else {
          showT(`Failed to save (${r.status})`, "error");
        }
      }
    } catch { showT("Failed to save schedule", "error"); }
    sReportSaving(false);
  };

  const runDbSetup = async () => {
    if (!dbSetupToken.trim()) { showT("Enter your Supabase access token", "error"); return; }
    sDbSetupRunning(true);
    try {
      const r = await fetch(`/api/setup-user`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supabase_url: SB_URL, access_token: dbSetupToken.trim() }),
      });
      if (r.ok) {
        showT("Database tables created!", "success");
        sDbSetupModal(false);
        sDbSetupToken("");
        sReportSaving(true);
        try {
          const r2 = await _doSaveSchedule();
          if (r2.ok) showT("Report schedule saved", "success");
          else showT("Tables created but save failed — try again", "error");
        } catch { showT("Tables created but save failed — try again", "error"); }
        sReportSaving(false);
      } else {
        const errBody = await r.json().catch(() => ({}));
        const detail = errBody?.detail || errBody?.error || `Status ${r.status}`;
        showT(`Setup failed: ${detail}`, "error");
      }
    } catch { showT("Setup request failed — check connection", "error"); }
    sDbSetupRunning(false);
  };
  const impBackup = (file) => { const r = new FileReader(); r.onload = (e) => { try { const d = JSON.parse(e.target.result); if (!d._v || !d._v.startsWith("nomad")) { showT("Invalid backup file", "error"); return } const arrFields = ["expenses", "incomes", "transfers", "settlements", "splits", "recurring", "events", "categories", "incomeSources"]; for (const f of arrFields) { if (d[f] !== undefined && !Array.isArray(d[f])) { showT(`Backup corrupt: ${f}`, "error"); return; } } sEx(d.expenses || []); sInc(d.incomes || []); sTr(d.transfers || []); sStl(d.settlements || []); sSp(d.splits || []); sRec(d.recurring || []); sEvs(d.events || []); if (d.categories?.length) sCats(d.categories); if (d.incomeSources?.length) sIsrc(d.incomeSources); if (d.darkMode !== undefined) sDm(d.darkMode); if (d.walletStartBal && typeof d.walletStartBal === "object") sWsb(d.walletStartBal); showT("Backup restored on this device", "success") } catch { showT("Failed to read file", "error") } }; r.readAsText(file) };

  if (showSetup) return <CredentialSetup onDone={() => window.location.reload()} onCancel={needsSetup ? undefined : () => setShowSetup(false)} />;
  if (!loaded) return null;
  const theme = dm ? { "--bg": "#000000", "--card": "#0F0F0F", "--border": "#1F1F1F", "--text": "#E5E7EB", "--ts": "#9CA3AF", "--muted": "#6B7280", "--nav-bg": "rgba(0,0,0,0.95)" } : { "--bg": "#F2F0EB", "--card": "#FFF", "--border": "rgba(0,0,0,0.06)", "--text": "#1A1A2E", "--ts": "#4A4A5A", "--muted": "#8A8A9A", "--nav-bg": "rgba(242,240,235,0.92)" };

  return <div style={{ ...theme, fontFamily: "var(--font-b)", background: "var(--bg)", color: "var(--text)", minHeight: "100vh", width: "100%", maxWidth: 430, margin: "0 auto", padding: "0 0 90px", overflowX: "hidden", boxSizing: "border-box" }}><style>{`
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Nunito:wght@400;500;600;700;800&family=Playfair+Display:wght@400;500&display=swap');
:root{--font-h:'Plus Jakarta Sans',sans-serif;--font-b:'Nunito',sans-serif}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{overflow-x:hidden;max-width:100%}
body{background:${dm ? "#000000" : "#F2F0EB"};overflow-x:hidden}
input[type=date]{color-scheme:${dm ? "dark" : "light"}}input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none}input[type=number]{-moz-appearance:textfield}
::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
button{transition:transform 0.1s ease,opacity 0.15s ease}button:active{transform:scale(0.96)}
@keyframes fi{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
@keyframes fis{from{opacity:0;transform:scale(0.95)}to{opacity:1;transform:scale(1)}}
@keyframes ld{from{transform:translateY(-6px) rotate(-5deg)}to{transform:translateY(-4px) rotate(5deg)}}
@keyframes ti{from{opacity:0;transform:translateY(-16px)}to{opacity:1;transform:translateY(0)}}
@keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.6}}
.pe{animation:fi 0.3s ease-out}.pse{animation:fis 0.25s ease-out}
.card-hover{transition:box-shadow 0.2s ease,transform 0.2s ease}
.card-hover:hover{box-shadow:0 4px 24px rgba(0,0,0,0.08);transform:translateY(-1px)}
`}</style>

    {(!online || pendingSync > 0) && <div style={{ position: "sticky", top: 0, zIndex: 120, margin: "0 12px 10px", padding: "8px 12px", borderRadius: 14, background: online ? "#FFF3D6" : "#FDE7E4", border: `1px solid ${online ? "#F1C96B" : "#E7A39B"}`, color: online ? "#7A5600" : "#9F3E33", fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 600, letterSpacing: "0.01em", textAlign: "center" }}>{!online ? "Offline. Changes sync later." : `Syncing ${pendingSync} change${pendingSync === 1 ? "" : "s"}.`}</div>}


    {(() => {
      const isRoutine = module === "routine";
      const routineLabel = routineTab.charAt(0).toUpperCase() + routineTab.slice(1);
      if (module === "finance" && tab !== "dashboard") return null;
      return <div style={{ position: "sticky", top: 0, zIndex: 100, backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", background: dm ? "rgba(0,0,0,0.92)" : "rgba(242,240,235,0.92)", borderBottom: `1px solid ${dm ? "#1F1F1F" : "rgba(0,0,0,0.06)"}`, padding: "12px 20px 10px", transition: "padding 0.2s" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{ fontFamily: "'Plus Jakarta Sans',sans-serif", fontSize: 20, fontWeight: 700, color: dm ? "#E5E7EB" : "#1A1A2E", letterSpacing: "0.04em", lineHeight: 1 }}>NOMAD</div>
          <span style={{ fontFamily: "var(--font-h)", fontSize: 11, color: dm ? "#6B7280" : "var(--muted)", fontWeight: 600, letterSpacing: "1.5px" }}>{new Date().toLocaleDateString("en-US", { weekday: "short" }).toUpperCase()} · {new Date().getDate()} {new Date().toLocaleDateString("en-US", { month: "short" }).toUpperCase()}</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => { setModule("finance") }} style={{ flex: 1, padding: "7px 0", borderRadius: 100, fontSize: 12, fontFamily: "var(--font-h)", fontWeight: 600, border: `1.5px solid ${module === "finance" ? "#E07A5F" : dm ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.1)"}`, cursor: "pointer", background: module === "finance" ? "#E07A5F" : "transparent", color: module === "finance" ? "#fff" : dm ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.35)", letterSpacing: "0.5px", transition: "all 0.2s" }}>Finance</button>
          <button onClick={() => { setModule("routine"); setRoutineTab("food") }} style={{ flex: 1, padding: "7px 0", borderRadius: 100, fontSize: 12, fontFamily: "var(--font-h)", fontWeight: 600, border: `1.5px solid ${module === "routine" ? "#EF9F27" : dm ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.1)"}`, cursor: "pointer", background: module === "routine" ? "#EF9F27" : "transparent", color: module === "routine" ? "#fff" : dm ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.35)", letterSpacing: "0.5px", transition: "all 0.2s" }}>Routine</button>
        </div>
      </div>
    })()}

    {module === "routine" && <RoutineApp darkMode={dm} onTabChange={setRoutineTab} />}
    {module === "finance" && <div style={{ padding: "0 16px" }}>

      {(tab === "dashboard" || tab === "history") && <div style={{ display: "flex", gap: 6, overflowX: "auto", padding: "12px 0 16px", scrollbarWidth: "none" }}><button onClick={() => sFm("all")} style={{ padding: "7px 16px", borderRadius: 20, fontSize: 12, fontFamily: "var(--font-h)", border: `1.5px solid ${fm === "all" ? "#E07A5F" : "var(--border)"}`, background: fm === "all" ? "#E07A5F" : "var(--card)", color: fm === "all" ? "#fff" : "var(--muted)", cursor: "pointer", whiteSpace: "nowrap", fontWeight: 500 }}>All</button>{allM.map(m => <button key={m} onClick={() => sFm(m)} style={{ padding: "7px 16px", borderRadius: 20, fontSize: 12, fontFamily: "var(--font-h)", border: `1.5px solid ${fm === m ? "#6BAA75" : "var(--border)"}`, background: fm === m ? "#6BAA75" : "var(--card)", color: fm === m ? "#fff" : "var(--muted)", cursor: "pointer", whiteSpace: "nowrap", fontWeight: 500 }}>{ml(m)}</button>)}</div>}

      {tab === "dashboard" && <div className="pe">
        {(() => {
          const tod = new Date(), todS = localDateKey(tod), snoozed = (() => { try { return JSON.parse(localStorage.getItem("nomad-rec-snooze") || "{}"); } catch { return {}; } })(), due = rec.filter(r => isRecurringDueToday(r, todS) && !(snoozed[r.id] && snoozed[r.id] >= todS));
          return due.length > 0 && <div style={{ marginBottom: 14 }}>{due.map(r => { const cat = cats.find(c => c.id === r.categoryId) || { name: r.categoryId }; const wal = WALLETS.find(w => w.id === r.walletId) || { name: r.walletId }; return <div key={r.id} style={{ ...cc, borderLeft: "3px solid #E07A5F", borderRadius: 14, padding: "14px 16px", marginBottom: 8 }}><div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}><Warning size={16} color="#E07A5F" weight="fill" /><div style={{ flex: 1 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{r.name} due today — {fmt(r.amount)}{(() => { const od = recurringDaysOverdue(r, todS); return od > 0 ? <span style={{ marginLeft: 6, padding: "2px 6px", borderRadius: 4, background: "#D4726A", color: "#fff", fontSize: 10, fontWeight: 600 }}>{od}d overdue</span> : null; })()}</div><div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{wal.name} → {cat.name}</div></div></div><div style={{ display: "flex", gap: 6 }}><button onClick={(ev) => { if (ev.currentTarget.disabled) return; ev.currentTarget.disabled = true; const ok = addE({ amount: r.amount, categoryId: r.categoryId, walletId: r.walletId, date: todS, note: r.name + " (recurring)", recurring: true }); if (ok === false) { ev.currentTarget.disabled = false; return; } const updated = { ...r, lastPaidDate: todS, lastSkippedDate: null }; sRec(p => p.map(x => x.id === r.id ? updated : x)); sbUpsert("recurring", [toSB(updated, ["id", "name", "amount", "categoryId", "categoryName", "walletId", "frequency", "dayOfMonth", "intervalDays", "yearMonth", "yearDay", "startDate", "active", "lastPaidDate", "lastSkippedDate"])], null, getVersion("recurring", r.id) ? { "If-Unmodified-Since": getVersion("recurring", r.id) } : {}); showT(r.name + " marked paid — " + fmt(r.amount), "success") }} style={{ flex: 1, padding: "8px", border: "none", borderRadius: 8, background: "#6BAA75", color: "#fff", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>✓ Paid</button><button onClick={(ev) => { if (ev.currentTarget.disabled) return; ev.currentTarget.disabled = true; const updated = { ...r, lastSkippedDate: todS }; sRec(p => p.map(x => x.id === r.id ? updated : x)); sbUpsert("recurring", [toSB(updated, ["id", "name", "amount", "categoryId", "categoryName", "walletId", "frequency", "dayOfMonth", "intervalDays", "yearMonth", "yearDay", "startDate", "active", "lastPaidDate", "lastSkippedDate"])], null, getVersion("recurring", r.id) ? { "If-Unmodified-Since": getVersion("recurring", r.id) } : {}); showT("Skipped for this cycle", "info") }} style={{ flex: 1, padding: "8px", border: "1.5px solid var(--border)", borderRadius: 8, background: "var(--card)", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Skip</button><button onClick={() => { const snoozeUntil = localDateKey(new Date(Date.now() + 864e5)); const snoozed = JSON.parse(localStorage.getItem("nomad-rec-snooze") || "{}"); snoozed[r.id] = snoozeUntil; localStorage.setItem("nomad-rec-snooze", JSON.stringify(snoozed)); sRec(p => [...p]); showT("Snoozed until tomorrow", "info") }} style={{ flex: 1, padding: "8px", border: "1.5px solid var(--border)", borderRadius: 8, background: "var(--card)", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Snooze</button></div></div> })}</div>
        })()}
        {loaded && ex.length === 0 && inc.length === 0 && <div style={{ ...cc, padding: "18px 20px", marginBottom: 14, borderLeft: "3px solid #7B8CDE" }}><div style={{ fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>👋 Welcome to NOMAD</div><div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.6, marginBottom: 12 }}>Track expenses, income, and recurring bills.<br />Tap <strong>Add</strong> below to log your first transaction.</div><div style={{ display: "flex", gap: 8 }}><button onClick={() => sTab("add")} style={{ flex: 1, padding: "9px", border: "none", borderRadius: 9, background: "#E07A5F", color: "#fff", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>+ Add Expense</button><button onClick={() => sTab("settings")} style={{ padding: "9px 14px", border: "1.5px solid var(--border)", borderRadius: 9, background: "var(--card)", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Settings</button></div></div>}
        <div style={{ ...cc, padding: "28px 24px", marginBottom: 16, textAlign: "center" }}><div style={{ fontFamily: "var(--font-h)", fontSize: 11, color: "var(--muted)", letterSpacing: "1.5px", textTransform: "uppercase", fontWeight: 500 }}>Total Money</div><div style={{ fontSize: 36, fontWeight: 700, fontFamily: "var(--font-h)", color: mBal >= 0 ? "#6BAA75" : "#E07A5F", marginTop: 8, lineHeight: 1.2 }}>{fmt(mBal)}</div><div style={{ display: "flex", justifyContent: "space-around", marginTop: 22 }}><div><div style={{ fontFamily: "var(--font-h)", fontSize: 10, color: "var(--muted)", letterSpacing: "1px", fontWeight: 500 }}>INCOME</div><div style={{ fontFamily: "var(--font-h)", fontSize: 16, color: "#6BAA75", marginTop: 4, fontWeight: 600 }}>{fmt(tI)}</div></div><div style={{ width: 1, background: "var(--border)" }} /><div><div style={{ fontFamily: "var(--font-h)", fontSize: 10, color: "var(--muted)", letterSpacing: "1px", fontWeight: 500 }}>NET SPENT</div><div style={{ fontFamily: "var(--font-h)", fontSize: 16, color: "#E07A5F", marginTop: 4, fontWeight: 600 }}>{fmt(tE)}</div></div></div></div>

        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>{WALLETS.map(w => { const b = roundMoney(wBal[w.id] || 0); return <div key={w.id} onClick={() => sCalW(w)} className="card-hover" style={{ ...cc, flex: 1, minWidth: 0, padding: "12px 10px", cursor: "pointer", borderLeft: `3px solid ${w.color}`, borderRadius: 14 }}><div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 8 }}><DI2 id={w.id} accent={w.neon || w.color} size={14} /><span style={{ fontSize: 8, fontFamily: "var(--font-h)", fontWeight: 600, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{w.name}</span></div><div style={{ fontSize: 16, fontWeight: 700, fontFamily: "var(--font-h)", color: b >= 0 ? w.color : "#E07A5F" }}>{fmt(b)}</div></div> })}</div>

        <LionM balance={mBal} dancing={ld} />
        <Splits splits={sp} expanded={spX} onToggle={() => sSpX(!spX)} onAdd={s => { sSp(p => [...p, s]); sbUpsert("splits", [toSB(s, ["id", "name", "amount", "direction", "settled", "eventId", "groupId"])]) }} onSettle={settle} onDelete={id => { sSp(p => p.filter(s => s.id !== id)); sbDelete("splits", id) }} />
        {(() => { const cm = localDateKey().slice(0, 7), mE = ex.filter(e => mk(e.date) === cm), fixT = mE.filter(isFix).reduce((s, e) => s + e.amount, 0), flxT = mE.filter(e => !isFix(e)).reduce((s, e) => s + e.amount, 0), tot = fixT + flxT, fixP = tot > 0 ? Math.round(fixT / tot * 100) : 0, flxP = 100 - fixP; return <div style={{ ...cc, padding: "16px 18px", marginBottom: 14, position: "relative", overflow: "hidden" }}><div style={{ position: "absolute", bottom: 0, right: 0, width: 60, height: 3, borderRadius: "3px 0 0 0", background: "#A78BFA" }} /><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "#A78BFA", fontWeight: 700, letterSpacing: "0.5px" }}>Fixed vs Flexible</div><div style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-h)" }}>This Month</div></div>{tot === 0 ? <p style={{ color: "var(--muted)", fontSize: 13, textAlign: "center", padding: "8px 0" }}>No expenses this month</p> : <><div style={{ height: 8, borderRadius: 4, background: "#FBBF24", overflow: "hidden", marginBottom: 10 }}><div style={{ height: "100%", width: `${fixP}%`, background: "#A78BFA", borderRadius: 4 }} /></div><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}><div style={{ display: "flex", alignItems: "center", gap: 6 }}><div style={{ width: 8, height: 8, borderRadius: 2, background: "#A78BFA", flexShrink: 0 }} /><span style={{ fontSize: 12, fontFamily: "var(--font-h)", color: "var(--ts)" }}>Fixed</span></div><span style={{ fontSize: 12, fontFamily: "var(--font-h)", fontWeight: 600, color: "var(--text)" }}>{fmt(fixT)} <span style={{ color: "var(--muted)", fontWeight: 400 }}>({fixP}%)</span></span></div><div style={{ display: "flex", justifyContent: "space-between" }}><div style={{ display: "flex", alignItems: "center", gap: 6 }}><div style={{ width: 8, height: 8, borderRadius: 2, background: "#FBBF24", flexShrink: 0 }} /><span style={{ fontSize: 12, fontFamily: "var(--font-h)", color: "var(--ts)" }}>Flexible</span></div><span style={{ fontSize: 12, fontFamily: "var(--font-h)", fontWeight: 600, color: "var(--text)" }}>{fmt(flxT)} <span style={{ color: "var(--muted)", fontWeight: 400 }}>({flxP}%)</span></span></div></>}</div> })()}
        <SpendingBreakdown expenses={ex} categories={cats} period={trendPeriod} onPeriodChange={sTrendPeriod} formatCurrency={fmt} darkMode={dm} />
        <div style={{ ...cc, padding: 18, marginBottom: 16, position: "relative", overflow: "hidden" }}><div style={{ position: "absolute", bottom: 0, right: 0, width: 60, height: 3, borderRadius: "3px 0 0 0", background: "#E07A5F" }} /><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "#E07A5F", marginBottom: 16, letterSpacing: "0.5px", fontWeight: 700 }}>Spending by Category</div>{flt.expenses.length === 0 ? <p style={{ color: "var(--muted)", fontSize: 13, textAlign: "center", padding: 20 }}>No expenses yet</p> : (() => { const t = {}; flt.expenses.forEach(e => { t[e.categoryId] = (t[e.categoryId] || 0) + e.amount }); const s = Object.entries(t).sort((a, b) => b[1] - a[1]), mx = s[0]?.[1] || 1; return s.map(([cid, total]) => { const c = cats.find(x => x.id === cid) || { id: cid, name: cid, color: "#999", neon: "#999" }; const cExps = flt.expenses.filter(e => e.categoryId === cid); const ctag = cExps.length > 0 && cExps.every(isFix) ? "fixed" : "flexible"; return <div key={cid} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}><span style={{ width: 30, display: "flex", justifyContent: "center" }}><DI2 id={c.id} accent={c.neon || c.color} size={20} /></span><div style={{ flex: 1 }}><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}><div style={{ display: "flex", alignItems: "center" }}><span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-h)" }}>{c.name}</span><span style={{ fontSize: 8, fontFamily: "var(--font-h)", fontWeight: 600, color: ctag === "fixed" ? "#A78BFA" : "#FBBF24", background: ctag === "fixed" ? "#A78BFA15" : "#FBBF2415", padding: "2px 6px", borderRadius: 4, marginLeft: 6 }}>{ctag === "fixed" ? "FIXED" : "FLEX"}</span></div><span style={{ fontSize: 13, fontFamily: "var(--font-h)", color: "var(--ts)", fontWeight: 500 }}>{fmt(total)}</span></div><div style={{ height: 5, borderRadius: 3, background: "var(--border)", overflow: "hidden" }}><div style={{ height: "100%", width: `${(total / mx) * 100}%`, background: c.color, borderRadius: 3 }} /></div></div></div> }) })()}</div>
        <Report expenses={ex} /></div>}

      {tab === "add" && <div className="pse" style={{ paddingTop: 20 }}><AddPage categories={cats} incomeSources={isrc} recurringCats={recCats} onAddExpense={addE} onAddIncome={addI} onAddTransfer={addT} onAddRec={addRec} onError={showT} patterns={quickPatterns} /></div>}
      {tab === "events" && <div className="pse" style={{ background: "transparent", padding: 0 }}><Events events={evs} expenses={ex} splits={sp} settlements={stl} categories={cats} onCreate={ev => { sEvs(p => [...p, ev]); sbUpsert("events", [toSB(ev, ["id", "name", "emoji", "date", "status", "type", "participants"])]) }} onAddExp={addE} onAddSplit={s => { sSp(p => [...p, s]); sbUpsert("splits", [toSB(s, ["id", "name", "amount", "direction", "settled", "eventId", "groupId", "note"])]) }} onSettleSplit={settle} onDeleteSplit={id => { sSp(p => p.filter(s => s.id !== id)); sbDelete("splits", id) }} onMarkDone={id => { sEvs(p => p.map(e => e.id === id ? { ...e, status: "completed" } : e)); sbUpsert("events", [{ id, status: "completed" }]) }} onDelete={id => { sEvs(p => p.filter(e => e.id !== id)); sbDelete("events", id) }} dm={dm} /></div>}
      {tab === "history" && <div className="pe"><Heatmap expenses={ex} />{(() => { const activeCount = [hSearch.trim(), hMinAmt, hMaxAmt, hDateFrom, hDateTo, hType !== "all" ? "x" : ""].filter(Boolean).length; const clearAll = () => { sHSearch(""); sHMinAmt(""); sHMaxAmt(""); sHDateFrom(""); sHDateTo(""); sHType("all"); sHShowFilters(false); }; return <div style={{ marginBottom: 14 }}><div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}><input value={hSearch} onChange={e => sHSearch(e.target.value)} placeholder="Search note, category…" style={{ ...is, flex: 1, marginBottom: 0, padding: "10px 14px" }} /><button onClick={() => sHShowFilters(!hShowFilters)} style={{ padding: "10px 14px", borderRadius: 10, border: `1.5px solid ${activeCount > 0 ? "#E07A5F" : "var(--border)"}`, background: activeCount > 0 ? "#E07A5F18" : "var(--card)", color: activeCount > 0 ? "#E07A5F" : "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", gap: 5 }}>Filter{activeCount > 0 && <span style={{ background: "#E07A5F", color: "#fff", borderRadius: "50%", width: 16, height: 16, fontSize: 9, display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>{activeCount}</span>}</button>{activeCount > 0 && <button onClick={clearAll} style={{ padding: "10px 12px", borderRadius: 10, border: "1.5px solid var(--border)", background: "var(--card)", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 11, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}>Clear</button>}</div>{hShowFilters && <div style={{ ...cc, padding: 14, marginBottom: 8 }}><div style={{ display: "flex", gap: 5, marginBottom: 12, flexWrap: "wrap" }}>{["all", "expense", "income", "transfer", "settlement"].map(t => <button key={t} onClick={() => sHType(t)} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 600, border: `1.5px solid ${hType === t ? "#7B8CDE" : "var(--border)"}`, background: hType === t ? "#7B8CDE18" : "var(--card)", color: hType === t ? "#7B8CDE" : "var(--muted)", cursor: "pointer" }}>{t.charAt(0).toUpperCase() + t.slice(1)}</button>)}</div><div style={{ display: "flex", gap: 8, marginBottom: 10 }}><div style={{ flex: 1 }}><label style={{ ...ls, fontSize: 10 }}>Min ₹</label><input type="number" value={hMinAmt} onChange={e => sHMinAmt(e.target.value)} placeholder="0" style={{ ...is, padding: "8px 10px", marginBottom: 0 }} /></div><div style={{ flex: 1 }}><label style={{ ...ls, fontSize: 10 }}>Max ₹</label><input type="number" value={hMaxAmt} onChange={e => sHMaxAmt(e.target.value)} placeholder="∞" style={{ ...is, padding: "8px 10px", marginBottom: 0 }} /></div></div><div style={{ display: "flex", gap: 8 }}><div style={{ flex: 1 }}><label style={{ ...ls, fontSize: 10 }}>From Date</label><input type="date" value={hDateFrom} onChange={e => sHDateFrom(e.target.value)} style={{ ...is, padding: "8px 10px", marginBottom: 0 }} /></div><div style={{ flex: 1 }}><label style={{ ...ls, fontSize: 10 }}>To Date</label><input type="date" value={hDateTo} onChange={e => sHDateTo(e.target.value)} style={{ ...is, padding: "8px 10px", marginBottom: 0 }} /></div></div></div>}{activeCount > 0 && <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-h)", textAlign: "center", marginTop: 4 }}>{historyItems.length} result{historyItems.length !== 1 ? "s" : ""}</div>}</div>; })()}{historyItems.map(it => <TxCard key={it.id} item={it} categories={cats} incomeSources={isrc} events={evs} onDelete={delItem} recurringCats={recCats} />)}{historyItems.length === 0 && <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--muted)", fontSize: 14, lineHeight: 1.8 }}>{flt.expenses.length === 0 && flt.incomes.length === 0 ? <><div style={{ fontSize: 32, marginBottom: 12 }}>📋</div><div style={{ fontFamily: "var(--font-h)", fontSize: 15, fontWeight: 600, color: "var(--ts)", marginBottom: 6 }}>No transactions yet</div><div style={{ fontSize: 12, marginBottom: 20 }}>Log expenses, income, and transfers<br />to see your spending history here.</div><button onClick={() => sTab("add")} style={{ padding: "12px 28px", border: "none", borderRadius: 12, background: "#E07A5F", color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>+ Add First Transaction</button></> : "No results match your filters."}</div>}</div>}

      {tab === "settings" && <div className="pe" style={{ paddingTop: 8 }}>
        <div style={{ ...cc, padding: "16px 18px", marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between" }}><div><div style={{ fontFamily: "var(--font-h)", fontSize: 13, color: "var(--text)", fontWeight: 600 }}>{dm ? "🌙" : "☀️"} Dark Mode</div><div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{dm ? "Dark" : "Light"}</div></div><div onClick={() => sDm(!dm)} style={{ width: 48, height: 26, borderRadius: 13, background: dm ? "#E07A5F" : "var(--border)", cursor: "pointer", position: "relative" }}><div style={{ width: 20, height: 20, borderRadius: "50%", background: "#fff", position: "absolute", top: 3, left: dm ? 25 : 3, transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.15)" }} /></div></div>
        <div style={{ ...cc, padding: 20, marginBottom: 14 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "var(--muted)", marginBottom: 14, letterSpacing: "0.5px", fontWeight: 600 }}>Export</div><button onClick={expCSV} style={{ width: "100%", padding: "13px", border: "none", borderRadius: 10, background: "#E07A5F", color: "#fff", fontFamily: "var(--font-h)", fontSize: 14, cursor: "pointer", fontWeight: 600 }}>Download CSV</button><p style={{ fontSize: 12, color: "var(--muted)", marginTop: 10, lineHeight: 1.6, fontStyle: "italic" }}>Upload to ChatGPT or Claude for analysis.</p></div>
        <div style={{ ...cc, padding: 20, marginBottom: 14 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "var(--muted)", marginBottom: 14, letterSpacing: "0.5px", fontWeight: 600 }}>Backup & Restore</div><div style={{ display: "flex", gap: 8, marginBottom: 12 }}><button onClick={expBackup} style={{ flex: 1, padding: "13px", border: "none", borderRadius: 10, background: "#6BAA75", color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, cursor: "pointer", fontWeight: 600 }}>📥 Backup</button><label style={{ flex: 1, padding: "13px", border: "1.5px solid #7B8CDE", borderRadius: 10, background: "#7B8CDE12", color: "#7B8CDE", fontFamily: "var(--font-h)", fontSize: 13, cursor: "pointer", fontWeight: 600, textAlign: "center" }}>📤 Restore<input type="file" accept=".json" onChange={e => { if (e.target.files[0]) impBackup(e.target.files[0]); e.target.value = "" }} style={{ display: "none" }} /></label></div><p style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.6, fontStyle: "italic" }}>Backup saves all data as JSON. Restore replaces current data with the backup file.</p></div>
        <div style={{ ...cc, padding: "14px 20px", marginBottom: 14, borderLeft: "3px solid #c9a96e", background: reportOpen ? (dm ? "#c9a96e0a" : "#c9a96e08") : "var(--card)" }}>
          <div onClick={() => { if (!reportOpen) loadReportSchedule(); sReportOpen(v => !v); }} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 16 }}>📧</span>
              <div style={{ fontFamily: "var(--font-h)", fontSize: 13, color: "#c9a96e", letterSpacing: "0.5px", fontWeight: 700 }}>Email Reports</div>
            </div>
            <span style={{ fontSize: 11, color: "#c9a96e", fontWeight: 700 }}>{reportOpen ? "▲" : "▼"}</span>
          </div>
          {reportOpen && <div style={{ marginTop: 16 }}>
            {!SB_ENABLED && <div style={{ fontSize: 12, color: "#FBBF24", marginBottom: 12, fontFamily: "var(--font-h)", fontWeight: 600, background: "#FBBF2412", borderRadius: 8, padding: "8px 12px" }}>⚠️ Configure Supabase first</div>}

            {/* Email */}
            <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--muted)", letterSpacing: "1px", marginBottom: 6, textTransform: "uppercase" }}>Email</label>
            <input type="email" value={reportEmail} onChange={e => sReportEmail(e.target.value)} placeholder="you@email.com" style={{ width: "100%", padding: "11px 14px", borderRadius: 10, border: "1.5px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 13, fontFamily: "var(--font-b)", outline: "none", boxSizing: "border-box", marginBottom: 14 }} />

            {/* Frequency */}
            <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--muted)", letterSpacing: "1px", marginBottom: 6, textTransform: "uppercase" }}>Frequency</label>
            <div style={{ display: "flex", gap: 6, marginBottom: reportFreq === "custom" ? 8 : 14, flexWrap: "wrap" }}>
              {["weekly", "monthly", "quarterly", "custom"].map(f => <button key={f} onClick={() => sReportFreq(f)} style={{ flex: 1, padding: "9px 4px", borderRadius: 10, fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 600, border: `1.5px solid ${reportFreq === f ? "#c9a96e" : "var(--border)"}`, background: reportFreq === f ? "#c9a96e18" : "var(--card)", color: reportFreq === f ? "#c9a96e" : "var(--muted)", cursor: "pointer", minWidth: 60 }}>{f.charAt(0).toUpperCase() + f.slice(1)}</button>)}
            </div>
            {reportFreq === "custom" && <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, padding: "10px 14px", background: "var(--bg)", borderRadius: 10, border: "1px solid var(--border)" }}>
              <span style={{ fontSize: 13, color: "var(--muted)", fontFamily: "var(--font-h)" }}>Every</span>
              <input type="number" min="1" max="365" value={reportCustomDays} onChange={e => sReportCustomDays(Number(e.target.value))} style={{ width: 60, padding: "6px 10px", borderRadius: 8, border: "1.5px solid #c9a96e", background: "var(--bg)", color: "#c9a96e", fontSize: 14, fontWeight: 700, fontFamily: "var(--font-h)", textAlign: "center", outline: "none" }} />
              <span style={{ fontSize: 13, color: "var(--muted)", fontFamily: "var(--font-h)" }}>days</span>
            </div>}

            {reportFreq === "weekly" && <>
              <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--muted)", letterSpacing: "1px", marginBottom: 6, textTransform: "uppercase" }}>Send Day</label>
              <div style={{ display: "flex", gap: 5, marginBottom: 14 }}>
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => <button key={i} onClick={() => sReportSendDow(i)} style={{ flex: 1, padding: "8px 2px", borderRadius: 8, fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 600, border: `1.5px solid ${reportSendDow === i ? "#c9a96e" : "var(--border)"}`, background: reportSendDow === i ? "#c9a96e18" : "var(--card)", color: reportSendDow === i ? "#c9a96e" : "var(--muted)", cursor: "pointer" }}>{d}</button>)}
              </div>
            </>}

            {(reportFreq === "monthly" || reportFreq === "quarterly") && <>
              <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--muted)", letterSpacing: "1px", marginBottom: 6, textTransform: "uppercase" }}>Send on Day of Month</label>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, padding: "10px 14px", background: "var(--bg)", borderRadius: 10, border: "1px solid var(--border)" }}>
                <span style={{ fontSize: 13, color: "var(--muted)", fontFamily: "var(--font-h)" }}>Day</span>
                <input type="number" min="1" max="31" value={reportSendDom} onChange={e => sReportSendDom(Math.min(31, Math.max(1, Number(e.target.value))))} style={{ width: 60, padding: "6px 10px", borderRadius: 8, border: "1.5px solid #c9a96e", background: "var(--bg)", color: "#c9a96e", fontSize: 14, fontWeight: 700, fontFamily: "var(--font-h)", textAlign: "center", outline: "none" }} />
                <span style={{ fontSize: 13, color: "var(--muted)", fontFamily: "var(--font-h)" }}>of each month</span>
              </div>
            </>}

            {/* Send Time */}
            <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--muted)", letterSpacing: "1px", marginBottom: 6, textTransform: "uppercase" }}>Send Time (IST)</label>
            <select value={reportSendHour} onChange={e => sReportSendHour(Number(e.target.value))} style={{ width: "100%", padding: "11px 14px", borderRadius: 10, border: "1.5px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 13, fontFamily: "var(--font-h)", outline: "none", marginBottom: 14, cursor: "pointer" }}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{h === 0 ? "12:00 AM" : h < 12 ? `${h}:00 AM` : h === 12 ? "12:00 PM" : `${h - 12}:00 PM`} IST</option>)}
            </select>

            {/* Content */}
            <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--muted)", letterSpacing: "1px", marginBottom: 8, textTransform: "uppercase" }}>Include in Report</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
              {[["Expenses", reportIncExp, sReportIncExp], ["Incomes", reportIncInc, sReportIncInc], ["Transfers", reportIncTr, sReportIncTr]].map(([label, val, setter]) => (
                <div key={label} onClick={() => setter(v => !v)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 12px", background: "var(--bg)", borderRadius: 10, border: `1px solid ${val ? "#c9a96e44" : "var(--border)"}`, cursor: "pointer" }}>
                  <span style={{ fontSize: 13, fontFamily: "var(--font-h)", fontWeight: 600, color: "var(--text)" }}>{label}</span>
                  <div style={{ width: 38, height: 20, borderRadius: 10, background: val ? "#c9a96e" : "var(--border)", position: "relative", flexShrink: 0 }}><div style={{ width: 14, height: 14, borderRadius: "50%", background: "#fff", position: "absolute", top: 3, left: val ? 21 : 3, transition: "left 0.2s" }} /></div>
                </div>
              ))}
            </div>

            {/* Category filter */}
            <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--muted)", letterSpacing: "1px", marginBottom: 8, textTransform: "uppercase" }}>Categories <span style={{ fontWeight: 400, textTransform: "none", fontSize: 10 }}>(empty = all)</span></label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
              {cats.map(c => { const on = reportSelCats.includes(c.id); return <button key={c.id} onClick={() => sReportSelCats(p => on ? p.filter(x => x !== c.id) : [...p, c.id])} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 600, border: `1.5px solid ${on ? c.color : "var(--border)"}`, background: on ? c.color + "22" : "var(--card)", color: on ? c.color : "var(--muted)", cursor: "pointer" }}>{c.name}</button>; })}
            </div>

            {/* Active + Save */}
            <div onClick={() => sReportActive(v => !v)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, padding: "10px 12px", background: "var(--bg)", borderRadius: 10, border: "1px solid var(--border)", cursor: "pointer" }}>
              <span style={{ fontSize: 13, fontFamily: "var(--font-h)", fontWeight: 600, color: "var(--text)" }}>Active</span>
              <div style={{ width: 44, height: 24, borderRadius: 12, background: reportActive ? "#c9a96e" : "var(--border)", position: "relative", flexShrink: 0 }}><div style={{ width: 18, height: 18, borderRadius: "50%", background: "#fff", position: "absolute", top: 3, left: reportActive ? 23 : 3, transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }} /></div>
            </div>
            <button onClick={saveReportSchedule} disabled={reportSaving} style={{ width: "100%", padding: "12px", border: "none", borderRadius: 10, background: reportSaving ? "#c9a96e88" : "#c9a96e", color: "#1a1a1a", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 700, cursor: reportSaving ? "not-allowed" : "pointer", marginBottom: 8 }}>{reportSaving ? "Saving…" : "Save Report Schedule"}</button>
            {reportScheduleId && <button onClick={async () => {
              if (!SB_ENABLED) return;
              sReportSaving(true);
              try {
                const r = await fetch("/api/send-now", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ supabase_url: SB_URL, anon_key: SB_KEY }),
                });
                const d = await r.json().catch(() => ({}));
                if (r.ok) showT(`Email sent to ${d.sentTo}`, "success");
                else showT(d.error || `Send failed (${r.status})`, "error");
              } catch { showT("Send failed — check connection", "error"); }
              sReportSaving(false);
            }} disabled={reportSaving} style={{ width: "100%", padding: "10px", border: "1.5px solid #7B8CDE", borderRadius: 10, background: "#7B8CDE12", color: "#7B8CDE", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: reportSaving ? "not-allowed" : "pointer" }}>📧 Send Now</button>}
          </div>}
        </div>
        <div style={{ ...cc, padding: 20, marginBottom: 14 }}>
          <div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "var(--muted)", marginBottom: 14, letterSpacing: "0.5px", fontWeight: 600 }}>Recurring ({rec.length})</div>
          {rec.length === 0 && <p style={{ fontSize: 12, color: "var(--muted)", textAlign: "center", padding: "12px 0", fontStyle: "italic" }}>No recurring expenses set up yet.</p>}
          {rec.map(r => {
            const rc = RC.find(c => c.id === r.categoryId) || recCats.find(c => c.id === r.categoryId) || { name: r.categoryName || r.categoryId, color: "#8A8A9A", neon: "#A0A0B0", id: r.categoryId };
            const fl = r.frequency === "monthly" ? `Every month on the ${r.dayOfMonth}${[, "st", "nd", "rd"][r.dayOfMonth] || "th"}` : r.frequency === "yearly" ? `Yearly on ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][(r.yearMonth || 1) - 1]} ${r.yearDay}` : `Every ${r.intervalDays} days`;
            const accent = rc.neon || rc.color;
            return (
              <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "var(--bg)", borderRadius: 10, marginBottom: 6, border: "1px solid var(--border)", opacity: r.active ? 1 : 0.5 }}>
                <DI2 id={rc.id} accent={accent} size={18} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, fontFamily: "var(--font-h)", color: "var(--text)" }}>{r.name} — {fmt(r.amount)}</div>
                  <div style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-b)", marginTop: 1 }}>{fl}{(() => { const ts = localDateKey(), pd = r.lastPaidDate, sk = r.lastSkippedDate, m = ts.slice(0,7), y = ts.slice(0,4), due = getRecurringDueDate(r, ts); const paidNow = r.frequency === "monthly" ? pd?.slice(0,7) === m : r.frequency === "yearly" ? pd?.slice(0,4) === y : pd && due && pd === due; const skipNow = r.frequency === "monthly" ? sk?.slice(0,7) === m : r.frequency === "yearly" ? sk?.slice(0,4) === y : sk && due && sk === due; if (paidNow) return <span style={{ marginLeft: 6, padding: "1px 5px", borderRadius: 3, background: "#6BAA7522", color: "#6BAA75", fontFamily: "var(--font-h)", fontWeight: 600, fontSize: 9 }}>✓ Paid</span>; if (skipNow) return <span style={{ marginLeft: 6, padding: "1px 5px", borderRadius: 3, background: "#FBBF2422", color: "#FBBF24", fontFamily: "var(--font-h)", fontWeight: 600, fontSize: 9 }}>Skipped</span>; return null; })()}</div>
                </div>
                {/* edit pencil */}
                <button onClick={() => { sRecDelConfirm(null); sRecEditId(r.id); }} style={{ background: "none", border: "none", padding: "4px 6px", cursor: "pointer", flexShrink: 0, opacity: 0.55, display: "flex", alignItems: "center" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#A78BFA" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                </button>
                {/* active toggle */}
                <div onClick={() => { const updated = rec.map(x => x.id === r.id ? { ...x, active: !x.active } : x); sRec(updated); sbUpsert("recurring", [toSB(updated.find(x => x.id === r.id), ["id", "name", "amount", "categoryId", "categoryName", "walletId", "frequency", "dayOfMonth", "intervalDays", "yearMonth", "yearDay", "startDate", "active", "lastPaidDate", "lastSkippedDate"])]); }} style={{ width: 36, height: 20, borderRadius: 10, background: r.active ? "#A78BFA" : "var(--border)", cursor: "pointer", position: "relative", flexShrink: 0 }}>
                  <div style={{ width: 14, height: 14, borderRadius: "50%", background: "#fff", position: "absolute", top: 3, left: r.active ? 19 : 3, transition: "left 0.2s" }} />
                </div>
                {recDelConfirm === r.id
                  ? <div style={{ display: "flex", gap: 4, flexShrink: 0, alignItems: "center" }}>
                    <span style={{ fontSize: 10, color: "#D4726A", fontFamily: "var(--font-h)", fontWeight: 600, whiteSpace: "nowrap" }}>Delete?</span>
                    <button onClick={() => sRecDelConfirm(null)} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, padding: "3px 8px", fontSize: 10, color: "var(--muted)", cursor: "pointer", fontFamily: "var(--font-h)", fontWeight: 600 }}>No</button>
                    <button onClick={() => { sRec(p => p.filter(x => x.id !== r.id)); sbDelete("recurring", r.id); sRecDelConfirm(null); showT(r.name + " deleted", "info"); }} style={{ background: "#D4726A", border: "none", borderRadius: 6, padding: "3px 8px", fontSize: 10, color: "#fff", cursor: "pointer", fontFamily: "var(--font-h)", fontWeight: 600 }}>Yes</button>
                  </div>
                  : <button onClick={() => sRecDelConfirm(r.id)} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 14, opacity: 0.5, flexShrink: 0 }}>✕</button>
                }
              </div>
            );
          })}
        </div>
        {(() => { const list = mt === "expense" ? cats : isrc; const shown = manageXp ? list : list.slice(0, 2); return <div style={{ ...cc, padding: 20, marginBottom: 14 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "var(--muted)", marginBottom: 14, letterSpacing: "0.5px", fontWeight: 600 }}>Manage</div><div style={{ display: "flex", gap: 6, marginBottom: 16 }}>{["expense", "income", "recurring"].map(t => <button key={t} onClick={() => { sMt(t); sManageXp(false) }} style={{ flex: 1, padding: "9px", borderRadius: 10, fontSize: 11, fontFamily: "var(--font-h)", border: `1.5px solid ${mt === t ? (t === "expense" ? "#E07A5F" : t === "income" ? "#6BAA75" : "#A78BFA") : "var(--border)"}`, background: mt === t ? (t === "expense" ? "#E07A5F" : t === "income" ? "#6BAA75" : "#A78BFA") : "var(--card)", color: mt === t ? "#fff" : "var(--muted)", cursor: "pointer", fontWeight: 500 }}>{t === "expense" ? "Categories" : t === "income" ? "Income" : "Recurring"}</button>)}</div>{mt === "recurring" ? <>{(manageXp ? recCats : recCats.slice(0, 2)).map(c => <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "var(--bg)", borderRadius: 10, marginBottom: 6, border: "1px solid var(--border)" }}><DI2 id={c.id} accent={c.neon || c.color} size={18} /><span style={{ flex: 1, fontSize: 13, color: "var(--text)", fontWeight: 500, fontFamily: "var(--font-h)" }}>{c.name}</span><span style={{ width: 14, height: 14, borderRadius: "50%", background: c.color, flexShrink: 0 }} /><button onClick={() => { if (RC.find(d => d.id === c.id)) return; sRecCats(p => p.filter(x => x.id !== c.id)); }} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 14, padding: "2px 6px", opacity: RC.find(d => d.id === c.id) ? 0.15 : 0.5 }}>✕</button></div>)}{recCats.length > 2 && <button onClick={() => sManageXp(!manageXp)} style={{ width: "100%", padding: "8px", border: "1px dashed var(--border)", borderRadius: 8, background: "none", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, cursor: "pointer", marginBottom: 6 }}>{manageXp ? `Show less ▲` : `Show all ${recCats.length} ▼`}</button>}<div style={{ borderTop: "1px solid var(--border)", marginTop: 14, paddingTop: 14 }}><label style={ls}>Add New</label><div style={{ display: "flex", gap: 6, marginBottom: 10 }}><input value={ne2} onChange={e => sNE2(e.target.value)} maxLength={2} style={{ ...is, width: 48, textAlign: "center", flexShrink: 0 }} /><input value={nn} onChange={e => sNN(e.target.value)} placeholder="Name…" style={is} /><input type="color" value={nc} onChange={e => sNC(e.target.value)} style={{ width: 42, height: 42, border: "none", cursor: "pointer", borderRadius: 8, flexShrink: 0 }} /></div><button onClick={() => { if (!nn.trim()) return; const id = nn.trim().toLowerCase().replace(/\s+/g, "_") + "_" + uid(); sRecCats(p => [...p, { id, name: nn.trim(), emoji: ne2, color: nc, neon: nc }]); sNN(""); sNE2("📁"); sNC("#E07A5F"); }} style={{ width: "100%", padding: "11px", border: "none", borderRadius: 10, background: "#A78BFA", color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, cursor: "pointer", fontWeight: 600 }}>+ Add Category</button></div></> : <>{shown.map(c => <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "var(--bg)", borderRadius: 10, marginBottom: 6, border: "1px solid var(--border)" }}><DI2 id={c.id} accent={c.neon || c.color} size={18} /><span style={{ flex: 1, fontSize: 13, color: "var(--text)", fontWeight: 500, fontFamily: "var(--font-h)" }}>{c.name}</span>{(() => { const n = mt === "expense" ? ex.filter(e => e.categoryId === c.id).length : inc.filter(i => i.sourceId === c.id).length; return n > 0 ? <span style={{ fontSize: 9, color: "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 600, flexShrink: 0 }}>{n} txn{n !== 1 ? "s" : ""}</span> : null; })()}<span style={{ width: 14, height: 14, borderRadius: "50%", background: c.color }} /><button onClick={() => { const defs = mt === "expense" ? DC : DI; if (defs.find(d => d.id === c.id)) return; const orphans = mt === "expense" ? ex.filter(e => e.categoryId === c.id).length : inc.filter(i => i.sourceId === c.id).length; if (mt === "expense") sCats(p => p.filter(x => x.id !== c.id)); else sIsrc(p => p.filter(x => x.id !== c.id)); if (orphans > 0) showT(`⚠ ${orphans} transaction${orphans !== 1 ? "s" : ""} now show as Unknown`, "info"); }} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 14, padding: "2px 6px", opacity: (mt === "expense" ? DC : DI).find(d => d.id === c.id) ? 0.15 : 0.5 }}>✕</button></div>)}{list.length > 2 && <button onClick={() => sManageXp(!manageXp)} style={{ width: "100%", padding: "8px", border: "1px dashed var(--border)", borderRadius: 8, background: "none", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, cursor: "pointer", marginBottom: 6 }}>{manageXp ? `Show less ▲` : `Show all ${list.length} ▼`}</button>}<div style={{ borderTop: "1px solid var(--border)", marginTop: 14, paddingTop: 14 }}><label style={ls}>Add New</label><div style={{ display: "flex", gap: 6, marginBottom: 10 }}><input value={ne2} onChange={e => sNE2(e.target.value)} maxLength={2} style={{ ...is, width: 48, textAlign: "center", flexShrink: 0 }} /><input value={nn} onChange={e => sNN(e.target.value)} placeholder="Name…" style={is} /><input type="color" value={nc} onChange={e => sNC(e.target.value)} style={{ width: 42, height: 42, border: "none", cursor: "pointer", borderRadius: 8, flexShrink: 0 }} /></div><button onClick={addCust} style={{ width: "100%", padding: "11px", border: "none", borderRadius: 10, background: "#7B8CDE", color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, cursor: "pointer", fontWeight: 600 }}>+ Add {mt === "expense" ? "Category" : "Source"}</button></div></>}</div> })()}
        <div style={{ ...cc, padding: "14px 20px", marginBottom: 14 }}><div onClick={() => sBackendOpen(v => !v)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "var(--muted)", letterSpacing: "0.5px", fontWeight: 600 }}>Backend</div><span style={{ fontSize: 11, color: "var(--muted)" }}>{backendOpen ? "▲" : "▼"}</span></div>{backendOpen && <div style={{ marginTop: 14 }}><div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}><div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "var(--bg)", borderRadius: 10, border: "1px solid var(--border)" }}><div style={{ width: 8, height: 8, borderRadius: "50%", background: _creds.sbUrl ? "#6BAA75" : "#FBBF24", flexShrink: 0 }} /><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 11, fontWeight: 700, fontFamily: "var(--font-h)", color: "var(--text)" }}>Supabase</div><div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-b)", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{_creds.sbUrl ? _creds.sbUrl.replace("https://", "").replace(".supabase.co", "") + ".supabase.co" : "Not configured"}</div></div></div><div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "var(--bg)", borderRadius: 10, border: "1px solid var(--border)" }}><div style={{ width: 8, height: 8, borderRadius: "50%", background: _creds.cloudName ? "#6BAA75" : "#FBBF24", flexShrink: 0 }} /><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 11, fontWeight: 700, fontFamily: "var(--font-h)", color: "var(--text)" }}>Cloudinary</div><div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-b)", marginTop: 1 }}>{_creds.cloudName ? (_creds.apiKey ? _creds.cloudName + " (signed)" : _creds.cloudName + " (unsigned preset)") : "Not configured"}</div></div></div></div><div style={{ display: "flex", gap: 8, marginBottom: 8 }}><button onClick={() => { const data = JSON.stringify(_creds, null, 2); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([data], { type: "application/json" })); a.download = "nomad_credentials.json"; a.click(); showT("Credentials exported", "success"); }} style={{ flex: 1, padding: "11px", border: "1.5px solid #6BAA75", borderRadius: 10, background: "#6BAA7512", color: "#6BAA75", fontFamily: "var(--font-h)", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>Export</button><label style={{ flex: 1, padding: "11px", border: "1.5px solid #7B8CDE", borderRadius: 10, background: "#7B8CDE12", color: "#7B8CDE", fontFamily: "var(--font-h)", fontSize: 12, cursor: "pointer", fontWeight: 600, textAlign: "center" }}>Import<input type="file" accept=".json" style={{ display: "none" }} onChange={e => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = ev => { try { const d = JSON.parse(ev.target.result); if (!d.sbUrl || !d.sbKey) { showT("Invalid credentials file", "error"); return; } localStorage.setItem("nomad-credentials", JSON.stringify(d)); showT("Credentials imported — reloading…", "success"); setTimeout(() => window.location.reload(), 1000); } catch { showT("Failed to read file", "error"); } }; r.readAsText(f); e.target.value = ""; }} /></label></div><button onClick={() => setShowSetup(true)} style={{ width: "100%", padding: "11px", border: "1.5px solid var(--border)", borderRadius: 10, background: "var(--card)", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>Edit Credentials</button></div>}</div>
        <div style={{ ...cc, padding: "14px 20px", marginBottom: 14 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "var(--muted)", marginBottom: 12, letterSpacing: "0.5px", fontWeight: 600 }}>Sync Status</div><div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", background: "var(--bg)", borderRadius: 10, border: "1px solid var(--border)", marginBottom: 10 }}><div><div style={{ fontSize: 12, fontFamily: "var(--font-h)", fontWeight: 600, color: "var(--text)" }}>{online ? (pendingSync > 0 ? `${pendingSync} change${pendingSync === 1 ? "" : "s"} pending` : "All changes synced") : "Offline — changes will sync when online"}</div><div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2, fontFamily: "var(--font-h)" }}>{online ? "Connected to Supabase" : "Working from local copy"}</div></div><div style={{ width: 8, height: 8, borderRadius: "50%", background: !online ? "#D4726A" : pendingSync > 0 ? "#FBBF24" : "#6BAA75", flexShrink: 0 }} /></div><button disabled={!online || pendingSync === 0} onClick={() => { flushSyncQueue().then(r => { if (r.synced > 0) showT(`Synced ${r.synced} change${r.synced === 1 ? "" : "s"}`, "success"); else if (r.pending > 0) showT(`${r.pending} change${r.pending === 1 ? "" : "s"} still pending — server may be unreachable`, "info"); else showT("Nothing to sync", "info"); }).catch(() => showT("Sync failed", "error")); }} style={{ width: "100%", padding: "10px", border: "1.5px solid var(--border)", borderRadius: 10, background: "var(--card)", color: (!online || pendingSync === 0) ? "var(--muted)" : "var(--text)", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: (!online || pendingSync === 0) ? "not-allowed" : "pointer", opacity: (!online || pendingSync === 0) ? 0.5 : 1 }}>Sync now</button></div>
        <div style={{ ...cc, padding: 20, marginBottom: 14 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "var(--muted)", marginBottom: 12, letterSpacing: "0.5px", fontWeight: 600 }}>Recently Deleted</div>{recDelItems === null ? <button onClick={loadRecentlyDeleted} disabled={recDelLoading} style={{ width: "100%", padding: "10px", border: "1.5px solid var(--border)", borderRadius: 10, background: "var(--card)", color: recDelLoading ? "var(--muted)" : "var(--text)", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: recDelLoading ? "not-allowed" : "pointer", opacity: recDelLoading ? 0.6 : 1 }}>{recDelLoading ? "Loading…" : "Load deleted items (last 30 days)"}</button> : recDelItems.length === 0 ? <div style={{ fontSize: 12, color: "var(--muted)", textAlign: "center", padding: "8px 0" }}>No items deleted in the last 30 days</div> : recDelItems.map(item => <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid var(--border)" }}><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 12, fontFamily: "var(--font-h)", fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item._tbl === "recurring" ? item.name : (fmt(item.amount) + (item.note ? " · " + item.note : "") + " · " + (item.date || ""))}</div><div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>{item._tbl} · deleted {new Date(item.deleted_at).toLocaleDateString()}</div></div><button onClick={() => restoreDeleted(item)} style={{ padding: "5px 10px", border: "1.5px solid #6BAA75", borderRadius: 7, background: "#6BAA7512", color: "#6BAA75", fontFamily: "var(--font-h)", fontSize: 11, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}>Restore</button></div>)}</div>
        <div style={{ ...cc, padding: 20, marginBottom: 14 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "var(--muted)", marginBottom: 14, letterSpacing: "0.5px", fontWeight: 600 }}>Danger Zone</div>{!clr ? <button onClick={() => { sClr(true); sNukeTxt(""); }} style={{ width: "100%", padding: "13px", border: "1.5px solid #D4726A", borderRadius: 10, background: "#D4726A12", color: "#D4726A", fontFamily: "var(--font-h)", fontSize: 13, cursor: "pointer", fontWeight: 600 }}>Clear All Data</button> : <div><p style={{ fontSize: 13, color: "#D4726A", marginBottom: 8, lineHeight: 1.5 }}>Delete everything permanently?</p>{getPendingSyncCount() > 0 && <p style={{ fontSize: 12, color: "#E07A5F", marginBottom: 8, lineHeight: 1.5 }}>⚠ {getPendingSyncCount()} unsaved change{getPendingSyncCount() === 1 ? "" : "s"} pending sync — will be permanently lost.</p>}<button onClick={expBackup} style={{ width: "100%", padding: "9px", border: "1.5px solid #6BAA75", borderRadius: 8, background: "#6BAA7512", color: "#6BAA75", fontFamily: "var(--font-h)", fontSize: 12, cursor: "pointer", fontWeight: 600, marginBottom: 10 }}>↓ Download backup first</button><p style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>Type <strong>DELETE</strong> to confirm:</p><input value={nukeTxt} onChange={e => sNukeTxt(e.target.value)} placeholder="DELETE" autoCapitalize="characters" style={{ width: "100%", padding: "9px 11px", border: "1px solid #D4726A", borderRadius: 8, marginBottom: 10, fontSize: 13, fontFamily: "monospace", background: "var(--card)", color: "var(--text)" }} /><div style={{ display: "flex", gap: 8 }}><button onClick={() => { sClr(false); sNukeTxt(""); }} style={{ flex: 1, padding: "11px", border: "1.5px solid var(--border)", borderRadius: 10, background: "var(--card)", color: "var(--ts)", fontFamily: "var(--font-h)", fontSize: 13, cursor: "pointer" }}>Cancel</button><button disabled={nukeTxt !== "DELETE"} onClick={() => { if (nukeTxt !== "DELETE") return; sEx([]); sInc([]); sTr([]); sStl([]); sCats(DC); sIsrc(DI); sSp([]); sEvs([]); sRec([]); sWsb({ upi_lite: 0, bank: 0, cash: 0 }); sClr(false); sNukeTxt(""); Object.keys(localStorage).filter(k => k.startsWith("nomad-") && k !== "nomad-credentials").forEach(k => localStorage.removeItem(k));["expenses", "incomes", "transfers", "settlements", "splits", "recurring", "events"].forEach(t => sbDeleteWhere(t, "id=neq.null")); sbDeleteWhere("wallet_balances", "wallet_id=neq.null"); showT(online ? "Data cleared" : "Clear queued for sync", "success") }} style={{ flex: 1, padding: "11px", border: "none", borderRadius: 10, background: nukeTxt === "DELETE" ? "#D4726A" : "#D4726A66", color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, cursor: nukeTxt === "DELETE" ? "pointer" : "not-allowed", fontWeight: 600 }}>Yes, Delete</button></div></div>}</div>
        <div style={{ textAlign: "center", padding: "24px 20px", color: "var(--muted)", fontSize: 12, lineHeight: 1.8, fontStyle: "italic" }}>NOMAD v10.4 — Track smart. Spend wise. 🦁</div></div>}

    </div>}

    {module === "finance" && <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: "var(--nav-bg)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "center", maxWidth: 430, margin: "0 auto", zIndex: 50, paddingBottom: "env(safe-area-inset-bottom)" }}>{[{ id: "dashboard", label: "Home" }, { id: "add", label: "Add" }, { id: "events", label: "Events" }, { id: "history", label: "History" }, { id: "settings", label: "Settings" }].map(n => <button key={n.id} onClick={() => sTab(n.id)} style={{ flex: 1, padding: "10px 0 8px", border: "none", background: "none", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, cursor: "pointer", opacity: tab === n.id ? 1 : 0.45 }}><NI type={n.id} active={tab === n.id} /><span style={{ fontFamily: "var(--font-h)", fontSize: 9, color: tab === n.id ? "#E07A5F" : "var(--muted)", fontWeight: tab === n.id ? 600 : 400 }}>{n.label}</span></button>)}</div>}

    {calW && <CalM wallet={calW} currentBal={wBal[calW.id] || 0} onSave={v => handleCal(calW.id, v)} onClose={() => sCalW(null)} />}
    {recEditId && (() => {
      const r = rec.find(x => x.id === recEditId);
      if (!r) return null;
      return <RecEditPanel r={r} recCats={recCats} onSave={patch => { const updated = rec.map(x => x.id === r.id ? { ...x, ...patch } : x); sRec(updated); sbUpsert("recurring", [toSB(updated.find(x => x.id === r.id), ["id", "name", "amount", "categoryId", "categoryName", "walletId", "frequency", "dayOfMonth", "intervalDays", "yearMonth", "yearDay", "startDate", "active", "lastPaidDate", "lastSkippedDate"])], null, getVersion("recurring", r.id) ? { "If-Unmodified-Since": getVersion("recurring", r.id) } : {}); sRecEditId(null); showT((patch.name || r.name) + " updated", "success"); }} onClose={() => sRecEditId(null)} />;
    })()}

    {dbSetupModal && (
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 400, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <div style={{ background: "var(--card)", borderRadius: 16, padding: 24, maxWidth: 380, width: "100%", boxShadow: "0 8px 32px rgba(0,0,0,0.3)" }}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>🔧</div>
          <div style={{ fontFamily: "var(--font-h)", fontSize: 15, fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>One-time Database Setup</div>
          <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.7, marginBottom: 16 }}>
            The required tables don't exist in your Supabase yet. Provide your <strong style={{ color: "var(--text)" }}>Supabase personal access token</strong> to create them automatically.
            <br /><br />
            Get it at: <span style={{ color: "#c9a96e", fontFamily: "monospace", fontSize: 11 }}>supabase.com → Account → Access Tokens</span>
          </div>
          <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--muted)", letterSpacing: "1px", marginBottom: 6, textTransform: "uppercase" }}>Personal Access Token</label>
          <input
            type="password"
            value={dbSetupToken}
            onChange={e => sDbSetupToken(e.target.value)}
            placeholder="sbp_..."
            style={{ width: "100%", padding: "11px 14px", borderRadius: 10, border: "1.5px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 13, fontFamily: "var(--font-b)", outline: "none", boxSizing: "border-box", marginBottom: 16 }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => { sDbSetupModal(false); sDbSetupToken(""); }} style={{ flex: 1, padding: "11px", border: "1.5px solid var(--border)", borderRadius: 10, background: "var(--card)", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 13, cursor: "pointer", fontWeight: 600 }}>Cancel</button>
            <button onClick={runDbSetup} disabled={dbSetupRunning || !dbSetupToken.trim()} style={{ flex: 2, padding: "11px", border: "none", borderRadius: 10, background: dbSetupRunning ? "#c9a96e88" : "#c9a96e", color: "#1a1a1a", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 700, cursor: dbSetupRunning ? "not-allowed" : "pointer" }}>
              {dbSetupRunning ? "Setting up…" : "Create Tables & Save"}
            </button>
          </div>
        </div>
      </div>
    )}

    {toasts.length > 0 && (
      <div style={{ position: "fixed", top: 24, left: "50%", transform: "translateX(-50%)", zIndex: 300, display: "flex", flexDirection: "column", alignItems: "center", gap: 8, pointerEvents: "none" }}>
        {toasts.map(t => (
          <div key={t.id} style={{ pointerEvents: "auto", background: t.type === "error" ? "#D4726A" : t.type === "success" ? "#6BAA75" : t.type === "warn" ? "#E07A5F" : "#7B8CDE", color: "#fff", borderRadius: 50, padding: "9px 22px", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", textAlign: "center", whiteSpace: "nowrap", animation: "ti 0.25s ease-out", display: "flex", alignItems: "center", gap: 12 }}>
            {t.msg}
            {t.undo && <button onClick={() => undoDelete(t.id)} style={{ background: "rgba(255,255,255,0.25)", color: "#fff", border: "none", borderRadius: 12, padding: "3px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>UNDO</button>}
          </div>
        ))}
      </div>
    )}
  </div>
}