import { useState, useEffect, useMemo, useRef, useCallback, memo } from "react";
import { FilmSlate, ForkKnife, Airplane, GameController, ShoppingCart, MusicNote, Trophy, Confetti, BookOpen, Briefcase, Warning, Wallet, Target, Lightning, Envelope, Fire, Sparkle, Lightbulb, ChartBar, ClipboardText, Timer, HandWaving, BellSlash, Robot, Receipt, FilePdf, Trash, Moon, Sun, Scales, Gear, PushPin, Hash, Microphone } from "@phosphor-icons/react";
import { IconCheck, IconTrash, IconHistory, IconChevronRight, IconChevronLeft, IconSend, IconAlertTriangle, IconX, IconClock, IconArrowDown, IconArrowUp, IconPlus, IconPlayerSkipForward } from "@tabler/icons-react";
import { ComposedChart, Bar, Line, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, CartesianGrid } from "recharts";
import RoutineApp from "./Routine";
import { flushSyncQueue, getPendingSyncCount, getDeadLetterCount, clearDeadLetter, sendSupabaseRequest, subscribePendingSync, subscribeSyncDrops, isPendingDelete, isPendingUpsert } from "./offlineSync";
import { checkBillReminders } from "./billReminders";
import { getExchangeRate, saveCurrencyMeta, getCurrencyMeta } from "./currencyConverter";
import ReceiptPicker from "./ReceiptPicker";
import CredentialSetup from "./CredentialSetup";
import { getCredentials } from "./credentials";
import { uploadReceipt, isLocalReceipt } from "./receiptUpload";
import { COLS } from "./dbCols";
import { mergeRemote, isRecentRow } from "./syncMerge";
import { computeFinanceScore, scoreLabel } from "./financeScore";
import { redactTransactions } from "./redactor";
import {
  roundMoney, localDateKey, fullMonthsBetween, fullYearsBetween,
  getRecurringAnchorDate, getRecurringDueDate, isRecurringDueToday,
  recurringDaysOverdue, distributeAmount, historySortCompare, itemTimestamp,
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
const localMode = !_creds.sbUrl;
const needsSetup = false;
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

const SOFT_DELETE_TABLES = new Set(["expenses", "incomes", "transfers", "recurring", "events", "splits"]);
const sbGet = async (table) => {
  if (!SB_ENABLED) return null;
  try {
    const filter = SOFT_DELETE_TABLES.has(table) ? "&deleted_at=is.null" : "";
    const r = await fetchWithTimeout(`${SB_URL}/rest/v1/${table}?select=*${filter}`, { headers: sbH });
    if (r.ok) { const rows = await r.json(); saveVersions(table, rows); return rows; }
    if (r.status === 400 && filter) {
      // deleted_at column not yet migrated — fall back to unfiltered
      const r2 = await fetchWithTimeout(`${SB_URL}/rest/v1/${table}?select=*`, { headers: sbH });
      if (!r2.ok) { console.error("sbGet fail", table, r2.status); return null; }
      return r2.json();
    }
    if (r.status === 503) { window.dispatchEvent(new CustomEvent("nomad-db-paused")); return null; }
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
const sbDelete = async (table, id) => { clearVersion(table, id); const r = await sbWrite(`${SB_URL}/rest/v1/${table}?id=eq.${id}`, { method: "PATCH", body: { deleted_at: new Date().toISOString() }, dedupeKey: `${table}:delete:${id}` }); if (!r.ok && !r.queued && r.response?.status === 400) return sbDeleteWhere(table, `id=eq.${id}`); return r; };
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

// Locale-aware amount parser. Accepts "3.24", "3,24" (EU decimal), "1,234.56" (US thousands), "1,23,456.78" (Indian).
// Returns NaN for empty / unparseable input — callers should guard with Number.isFinite.
const parseAmount = (s) => {
  if (typeof s === "number") return s;
  if (s == null) return NaN;
  const str = String(s).trim();
  if (!str) return NaN;
  const hasComma = str.includes(",");
  const hasPeriod = str.includes(".");
  if (hasComma && !hasPeriod && str.split(",").length === 2 && /,\d{1,2}$/.test(str)) return Number(str.replace(",", "."));
  return Number(str.replace(/,/g, ""));
};

// True if a wallet (object) or wallet id imposes UPI Lite-style restrictions:
// spend-only, ₹5000 daily / ₹1L monthly cap, max ₹5000 balance.
const isUpiLite = (walletOrId, walletList) => {
  if (!walletOrId) return false;
  if (typeof walletOrId === "string") {
    if (walletOrId === "upi_lite") return true;
    const w = (walletList || []).find(x => x?.id === walletOrId);
    return !!w?.upiLite;
  }
  return walletOrId.id === "upi_lite" || walletOrId.upiLite === true;
};

const clearVersion = (table, id) => {
  try {
    const store = JSON.parse(localStorage.getItem(VERSIONS_KEY) || "{}");
    const key = `${table}:${id}`;
    if (key in store) { delete store[key]; localStorage.setItem(VERSIONS_KEY, JSON.stringify(store)); }
  } catch { /* ignore storage errors */ }
};

const WALLETS =[{ id: "upi_lite", name: "UPI Lite", desc: "online · ₹5000 cap", color: "#00D4FF", neon: "#00E5FF" }, { id: "bank", name: "Bank", desc: "main account", color: "#34D399", neon: "#6EE7B7" }, { id: "cash", name: "Cash", desc: "physical money", color: "#FBBF24", neon: "#FDE68A" }];
const DC = [{ id: "food", name: "Food & Drinks", color: "#FF6B35", neon: "#FF9F1C" }, { id: "transport", name: "Transport", color: "#00D4FF", neon: "#00E5FF" }, { id: "rent", name: "Rent & Bills", color: "#A78BFA", neon: "#C4B5FD" }, { id: "entertainment", name: "Entertainment", color: "#F472B6", neon: "#FF8ED4" }, { id: "health", name: "Health", color: "#34D399", neon: "#6EE7B7" }, { id: "coffee", name: "Coffee / Snacks", color: "#FBBF24", neon: "#FDE68A" }, { id: "personal", name: "Personal Care", color: "#E879F9", neon: "#F0ABFC" }, { id: "other", name: "Other", color: "#6366F1", neon: "#818CF8" }];
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
    case "other": return <svg {...p}><circle cx="5" cy="12" r="1.5" fill={N} stroke="none"/><circle cx="12" cy="12" r="1.5" fill={N} stroke="none"/><circle cx="19" cy="12" r="1.5" fill={N} stroke="none"/><circle cx="12" cy="12" r="9"{...l} /></svg>;
    case "transfer": return <svg {...p}><polyline points="17 8 21 12 17 16"{...l}/><polyline points="7 8 3 12 7 16"{...l}/><line x1="21" y1="12" x2="3" y2="12"{...d}/></svg>;
    case "received": return <svg {...p}><path d="M12 5v14"{...l}/><polyline points="5 12 12 19 19 12"{...l}/><path d="M4 20h16"{...d}/></svg>;
    case "paid": return <svg {...p}><path d="M12 19V5"{...l}/><polyline points="5 12 12 5 19 12"{...l}/><path d="M4 4h16"{...d}/></svg>;
    default: return <svg {...p}><rect x="3" y="3" width="7" height="7" rx="1"{...l}/><rect x="14" y="3" width="7" height="7" rx="1"{...d}/><rect x="3" y="14" width="7" height="7" rx="1"{...d}/><rect x="14" y="14" width="7" height="7" rx="1"{...d}/></svg>
  }
}

const TIPS = ["Track every chai! Small spends add up.", "Saving ₹50/day = ₹1500/month!", "Review your week every Sunday!", "Needs vs wants — ask first!", "You're doing great!", "Set a weekly food budget!", "Unsubscribe unused stuff!", "Cook at home more!"];
const LH = ["Roarrr! Saving well!", "Budget king!", "Income > spending!", "Proud of you!", "Wallet smiling!"];
const LS = ["Spending > income…", "Tighten the belt.", "Slow down a bit.", "Cut one expense!", "Ramen week? Got this."];

function Lion({ mood, dancing, size = 56 }) {
  const [b, sB] = useState(false); useEffect(() => { if (!dancing) { sB(false); return } sB(true); const t = setTimeout(() => sB(false), 1600); return () => clearTimeout(t) }, [dancing]); const m = mood === "happy" ? "#E07A5F" : "#999", f = "#fae6c8";
  return <svg viewBox="0 0 80 80" width={size} height={size} style={{ transition: "transform 0.2s", transform: b ? "translateY(-6px) rotate(-5deg)" : "none", animation: b ? "ld 0.3s ease infinite alternate" : "none" }}><circle cx="40" cy="40" r="32" fill={m} opacity="0.9" /><circle cx="20" cy="25" r="10" fill={m} opacity="0.7" /><circle cx="60" cy="25" r="10" fill={m} opacity="0.7" /><circle cx="15" cy="42" r="9" fill={m} opacity="0.6" /><circle cx="65" cy="42" r="9" fill={m} opacity="0.6" /><circle cx="24" cy="60" r="8" fill={m} opacity="0.5" /><circle cx="56" cy="60" r="8" fill={m} opacity="0.5" /><circle cx="40" cy="42" r="22" fill={f} />{mood === "happy" ? <><path d="M30 38Q33 34 36 38" stroke="#141413" strokeWidth="2.5" fill="none" strokeLinecap="round" /><path d="M44 38Q47 34 50 38" stroke="#141413" strokeWidth="2.5" fill="none" strokeLinecap="round" /></> : <><circle cx="33" cy="37" r="3" fill="#141413" /><circle cx="47" cy="37" r="3" fill="#141413" /></>}<ellipse cx="40" cy="45" rx="4" ry="3" fill={mood === "happy" ? "#c4736e" : "#999"} />{mood === "happy" ? <path d="M34 49Q40 55 46 49" stroke="#141413" strokeWidth="1.8" fill="none" strokeLinecap="round" /> : <path d="M34 52Q40 48 46 52" stroke="#141413" strokeWidth="1.8" fill="none" strokeLinecap="round" />}<circle cx="22" cy="22" r="6" fill={f} /><circle cx="58" cy="22" r="6" fill={f} /><circle cx="22" cy="22" r="3" fill="#f0c4b0" /><circle cx="58" cy="22" r="3" fill="#f0c4b0" /></svg>
}

function LionM({ balance: bal, dancing, aiMsg, aiLoading, onTap }) {
  const [fallback, sM] = useState(""), mood = bal >= 0 ? "happy" : "sad"; useEffect(() => { const p = Math.random() < 0.5 ? TIPS : (mood === "happy" ? LH : LS); sM(p[Math.floor(Math.random() * p.length)]) }, [bal, mood]);
  const displayMsg = aiMsg || fallback;
  return <div style={{ display: "flex", alignItems: "flex-end", gap: 12, padding: "12px 0", cursor: onTap ? "pointer" : "default" }} onClick={onTap}><Lion mood={mood} dancing={dancing} /><div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "14px 14px 14px 4px", padding: "10px 14px", fontSize: 13, color: "var(--ts)", maxWidth: 220, fontFamily: "var(--font-b)", lineHeight: 1.5 }}>{aiLoading ? <span style={{ color: "var(--muted)", fontStyle: "italic" }}>Thinking…</span> : displayMsg}</div></div>
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

function Heatmap({ expenses: ex, onDayClick, selectedDay = null }) {
  const today = new Date(), [vY, sY] = useState(today.getFullYear()), [vM, sM] = useState(today.getMonth()); const goB = () => { if (vM === 0) { sM(11); sY(y => y - 1) } else sM(m => m - 1) }; const goF = () => { if (vY === today.getFullYear() && vM === today.getMonth()) return; if (vM === 11) { sM(0); sY(y => y + 1) } else sM(m => m + 1) }; const iC = vY === today.getFullYear() && vM === today.getMonth();
  const fd = new Date(vY, vM, 1).getDay(), dim = new Date(vY, vM + 1, 0).getDate(), mn = new Date(vY, vM).toLocaleDateString("en-US", { month: "long", year: "numeric" }), pfx = `${vY}-${String(vM + 1).padStart(2, "0")}`;
  const dt = useMemo(() => { const m = {}; ex.forEach(e => { if (typeof e.date === "string" && e.date.startsWith(pfx)) m[e.date] = (m[e.date] || 0) + e.amount; }); return m; }, [ex, pfx]); const mx = Math.max(...Object.values(dt), 1), mt = Object.values(dt).reduce((s, v) => s + v, 0), ad = Object.keys(dt).length;
  const gc = a => { if (!a) return "var(--border)"; const r = a / mx; return r < 0.25 ? "#6BAA75" : r < 0.5 ? "#FBBF24" : r < 0.75 ? "#E07A5F" : "#D4726A" };
  const cells = []; for (let i = 0; i < fd; i++)cells.push(<div key={`e${i}`} style={{ width: 36, height: 36 }} />); for (let d = 1; d <= dim; d++) { const ds = `${pfx}-${String(d).padStart(2, "0")}`, a = dt[ds] || 0, isT = iC && d === today.getDate(), isSel = selectedDay === ds; cells.push(<div key={d} onClick={onDayClick ? () => onDayClick(isSel ? null : ds) : undefined} style={{ width: 36, height: 36, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", background: gc(a), color: a ? "#fff" : "var(--muted)", fontSize: 11, fontFamily: "var(--font-h)", fontWeight: isT || isSel ? 700 : 500, border: isSel ? "2px solid #E07A5F" : isT ? "2px solid var(--text)" : "2px solid transparent", cursor: onDayClick ? "pointer" : "default", boxShadow: isSel ? "0 0 0 2px #E07A5F40" : "none" }}>{d}</div>) }
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


function SettleM({ split: sp, remaining: rm, onConfirm: oc, onClose: cl, wallets: wl = WALLETS }) {
  const [wid, sW] = useState("bank"); const maxAmt = rm ?? sp.amount; const [amt, sAmt] = useState(String(maxAmt)); const parsedAmt = parseAmount(amt); const validAmt = Math.min(Math.max(Number.isFinite(parsedAmt) ? parsedAmt : 0, 0.01), maxAmt); const isO = sp.direction === "owed"; const isPartial = validAmt < maxAmt - 0.005; const walletOptions = isO ? wl.filter(w => !isUpiLite(w)) : wl;
  return <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={cl}><div onClick={e => e.stopPropagation()} style={{ background: "var(--card)", borderRadius: "20px 20px 0 0", padding: 24, width: "100%", maxWidth: 430 }}><div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{isO ? `Receiving from ${sp.name}` : `Paying ${sp.name}`}</div><button onClick={cl} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", padding: 4 }}><IconX size={18} /></button></div><div style={{ marginBottom: 14 }}><div style={{ fontSize: 10, fontFamily: "var(--font-h)", color: "var(--muted)", fontWeight: 600, marginBottom: 5, letterSpacing: "0.5px" }}>AMOUNT{isPartial ? " (PARTIAL PAYMENT)" : ""}</div><div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--bg)", borderRadius: 10, padding: "10px 14px", border: `1.5px solid ${isO ? "#6BAA75" : "#E07A5F"}` }}><span style={{ fontFamily: "var(--font-h)", fontSize: 16, color: "var(--muted)" }}>₹</span><input type="number" value={amt} onChange={e => sAmt(e.target.value)} max={maxAmt} min={0.01} step={0.01} style={{ flex: 1, border: "none", background: "transparent", fontFamily: "var(--font-h)", fontSize: 20, fontWeight: 700, color: isO ? "#6BAA75" : "#E07A5F", outline: "none" }} /><button onClick={() => sAmt(String(maxAmt))} style={{ fontSize: 9, fontFamily: "var(--font-h)", color: "var(--muted)", background: "var(--border)", border: "none", borderRadius: 4, padding: "2px 6px", cursor: "pointer", fontWeight: 600 }}>MAX</button></div>{isPartial && <div style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-h)", marginTop: 5 }}>{fmt(roundMoney(maxAmt - validAmt))} will remain as pending IOU</div>}</div><div style={{ fontSize: 10, fontFamily: "var(--font-h)", color: "var(--muted)", fontWeight: 600, marginBottom: 8, letterSpacing: "0.5px" }}>{isO ? "RECEIVE INTO" : "PAY FROM"}</div><div style={{ display: "flex", gap: 8, marginBottom: 20 }}>{walletOptions.map(w => <button key={w.id} onClick={() => sW(w.id)} style={{ flex: 1, padding: "10px 6px", borderRadius: 10, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, border: `2px solid ${wid === w.id ? w.color : "var(--border)"}`, background: wid === w.id ? w.color + "15" : "var(--card)", cursor: "pointer" }}><DI2 id={w.id} accent={w.neon || w.color} size={18} /><span style={{ fontSize: 9, fontFamily: "var(--font-h)", fontWeight: wid === w.id ? 700 : 500, color: wid === w.id ? w.color : "var(--muted)" }}>{w.name}</span></button>)}</div><div style={{ display: "flex", gap: 10 }}><button onClick={cl} style={{ flex: 1, padding: 13, border: "1.5px solid var(--border)", borderRadius: 12, background: "transparent", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 13, cursor: "pointer" }}>Cancel</button><button onClick={(ev) => { if (ev.currentTarget.disabled) return; if (validAmt > 0) { ev.currentTarget.disabled = true; oc(wid, validAmt); cl(); } }} style={{ flex: 2, padding: 13, border: "none", borderRadius: 12, background: isO ? "#6BAA75" : "#E07A5F", color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, cursor: "pointer", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}><IconSend size={15} />{isO ? `Received ${fmt(validAmt)}` : `Paid ${fmt(validAmt)}`}</button></div></div></div>;
}

function Splits({ splits: sp, settlements: stl, categories: cats = [], onAdd, onSettle: os, onDelete: od, onSkip: ok, expanded: exp, onToggle: ot, wallets: wl = WALLETS, walletBalances: wBalances = {}, onError = () => {} }) {
  const [nm, sN] = useState(""), [am, sA] = useState(""), [dir, sD] = useState("owe"), [snote, sSnote] = useState(""), [scat, sScat] = useState(""), [st, sT] = useState(null), [drill, sDrill] = useState(null), [showFeed, sSF] = useState(false), [delConfirm, sDelConfirm] = useState(null), [settleAllWid, sSAW] = useState(null), [openCards, sOC] = useState(new Set());
  const effScat = scat || cats[0]?.id || "";
  const avatarColor = name => { const pal = ["#E07A5F","#6BAA75","#7B8CDE","#F4A261","#81B29A","#A78BFA","#F2CC8F","#E07A5F"]; let h=0; for(const c of name) h=(h*31+c.charCodeAt(0))&0xffff; return pal[h%pal.length]; };
  const initials = name => name.trim().split(/\s+/).slice(0,2).map(w=>w[0]?.toUpperCase()||"").join("");
  const remainForSplit = s => roundMoney(s.amount - (stl||[]).filter(x=>x.splitId===s.id).reduce((t,x)=>t+x.amount,0));
  const add = () => { if((!nm.trim()&&!drill)||!am) return; const a=parseAmount(am); if(!Number.isFinite(a)||a<=0) return; onAdd({id:uid(),name:drill||nm.trim(),amount:a,direction:dir,settled:false,note:snote.trim()||undefined,categoryId:effScat||undefined}); sN(""); sA(""); sSnote("") };
  const personMap = {}; sp.filter(s=>!s.eventId&&!s.deleted_at).forEach(s=>{ const n=s.name; if(!personMap[n]) personMap[n]={splits:[],net:0}; personMap[n].splits.push(s); if(!s.settled){const rem=remainForSplit(s); personMap[n].net+=s.direction==="owed"?rem:-rem;} });
  const stlByPerson = {}; (stl||[]).filter(s=>!s.eventId).forEach(s=>{if(!stlByPerson[s.splitName])stlByPerson[s.splitName]=[];stlByPerson[s.splitName].push(s);});
  const people = Object.keys(personMap); const activePeople = people.filter(n=>Math.abs(personMap[n].net)>=0.01).sort((a,b)=>Math.abs(personMap[b].net)-Math.abs(personMap[a].net)); const settledPeople = people.filter(n=>Math.abs(personMap[n].net)<0.01);
  const tO = activePeople.filter(n=>personMap[n].net<0).reduce((t,n)=>t+Math.abs(personMap[n].net),0);
  const tI = activePeople.filter(n=>personMap[n].net>0).reduce((t,n)=>t+personMap[n].net,0);
  const fmtDate = ts => { try{return new Date(ts).toLocaleDateString("en-IN",{month:"short",day:"numeric"});}catch{return "";} };
  if(!exp) return <div onClick={ot} style={{...cc,borderRadius:16,padding:"16px 18px",marginBottom:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between",position:"relative",overflow:"hidden"}}><div style={{position:"absolute",bottom:0,right:0,width:60,height:3,borderRadius:"3px 0 0 0",background:"#D4726A"}}/><div><div style={{fontFamily:"var(--font-h)",fontSize:12,color:"#D4726A",letterSpacing:"0.5px",fontWeight:700}}>Split Expenses</div><div style={{fontSize:11,color:"var(--muted)",fontFamily:"var(--font-b)",marginBottom:4}}>Personal IOUs · tap to manage</div><div style={{fontSize:13,fontFamily:"var(--font-b)",color:"var(--ts)",marginTop:2}}>{activePeople.length===0?"No pending splits":<><span style={{color:"#E07A5F"}}>You owe {fmt(tO)}</span> · <span style={{color:"#6BAA75"}}>Owed {fmt(tI)}</span></>}</div></div><IconChevronRight size={18} color="var(--muted)"/></div>;
  if(exp&&drill){
    const pm=personMap[drill]||{splits:[],net:0}; const net=pm.net; const pStls=stlByPerson[drill]||[]; const pendingSplits=pm.splits.filter(s=>!s.settled); const aColor=avatarColor(drill);
    const events=[...pm.splits.map(s=>({...s,_k:"split"})),...pStls.map(s=>({...s,_k:"stl"}))].sort((a,b)=>itemTimestamp(b)-itemTimestamp(a));
    return <div style={{...cc,borderRadius:16,padding:18,marginBottom:14,position:"relative",overflow:"hidden"}}><div style={{position:"absolute",bottom:0,right:0,width:60,height:3,borderRadius:"3px 0 0 0",background:"#D4726A"}}/><div style={{display:"flex",alignItems:"center",gap:12,marginBottom:14}}><button onClick={()=>{sDrill(null);sDelConfirm(null);}} style={{background:"none",border:"none",cursor:"pointer",color:"var(--muted)",padding:2,display:"flex",alignItems:"center"}}><IconChevronLeft size={18}/></button><div style={{width:36,height:36,borderRadius:"50%",background:aColor,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><span style={{fontFamily:"var(--font-h)",fontSize:13,fontWeight:700,color:"#fff"}}>{initials(drill)}</span></div><div style={{flex:1}}><div style={{fontFamily:"var(--font-h)",fontSize:15,fontWeight:700,color:"var(--text)"}}>{drill}</div><div style={{fontSize:11,fontFamily:"var(--font-h)",fontWeight:700,color:Math.abs(net)<0.01?"var(--muted)":net>0?"#6BAA75":"#E07A5F"}}>{Math.abs(net)<0.01?"Fully settled ✓":net>0?`Owes you ${fmt(net)}`:`You owe ${fmt(-net)}`}</div></div>{pendingSplits.length>1&&settleAllWid===null&&<button onClick={()=>sSAW("bank")} style={{padding:"6px 10px",border:"1.5px solid #6BAA75",borderRadius:8,background:"#6BAA7512",color:"#6BAA75",fontFamily:"var(--font-h)",fontSize:11,fontWeight:700,cursor:"pointer",flexShrink:0}}>Settle all</button>}</div>
    {settleAllWid!==null&&<div style={{background:"var(--bg)",borderRadius:12,padding:14,marginBottom:12,border:"1.5px solid #6BAA75"}}><div style={{fontFamily:"var(--font-h)",fontSize:12,fontWeight:700,color:"var(--text)",marginBottom:8}}>Settle all IOUs with {drill} · {fmt(pendingSplits.reduce((t,s)=>t+remainForSplit(s),0))}</div><div style={{display:"flex",gap:6,marginBottom:10}}>{(pendingSplits[0]?.direction==="owed"?wl.filter(w=>w.id!=="upi_lite"):wl).map(w=><button key={w.id} onClick={()=>sSAW(w.id)} style={{flex:1,padding:"8px 4px",borderRadius:8,display:"flex",flexDirection:"column",alignItems:"center",gap:3,border:`2px solid ${settleAllWid===w.id?w.color:"var(--border)"}`,background:settleAllWid===w.id?w.color+"15":"var(--card)",cursor:"pointer"}}><DI2 id={w.id} accent={w.neon||w.color} size={16}/><span style={{fontSize:8,fontFamily:"var(--font-h)",fontWeight:settleAllWid===w.id?700:500,color:settleAllWid===w.id?w.color:"var(--muted)"}}>{w.name}</span></button>)}</div><div style={{display:"flex",gap:8}}><button onClick={()=>sSAW(null)} style={{flex:1,padding:"9px",border:"1.5px solid var(--border)",borderRadius:9,background:"transparent",color:"var(--muted)",fontFamily:"var(--font-h)",fontSize:12,cursor:"pointer"}}>Cancel</button><button onClick={(ev)=>{if(ev.currentTarget.disabled)return;ev.currentTarget.disabled=true;const isOwe=pendingSplits[0]?.direction==="owe";const totalNeed=roundMoney(pendingSplits.reduce((t,s)=>t+remainForSplit(s),0));if(isOwe){const have=roundMoney(wBalances[settleAllWid]||0);if(have<totalNeed){onError(`Not enough in wallet — need ${fmt(totalNeed)}, have ${fmt(have)}. Settle individually or top up first.`);ev.currentTarget.disabled=false;return;}}for(const s of pendingSplits){const ok=os(s.id,settleAllWid,remainForSplit(s));if(ok===false)break;}sSAW(null);}} style={{flex:2,padding:"9px",border:"none",borderRadius:9,background:"#6BAA75",color:"#fff",fontFamily:"var(--font-h)",fontSize:12,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:5}}><IconCheck size={14}/>Confirm all settled</button></div></div>}
    {events.length===0&&<div style={{textAlign:"center",padding:"16px 0",color:"var(--muted)",fontSize:13,fontFamily:"var(--font-h)"}}>No history yet</div>}
    {events.map(ev=>ev._k==="split"?<div key={ev.id} style={{borderRadius:12,marginBottom:8,border:`1px solid ${ev.skipped?"#F4A26130":ev.settled?"var(--border)":ev.direction==="owe"?"#E07A5F30":"#6BAA7530"}`,overflow:"hidden",opacity:ev.settled?0.65:1}}><div style={{display:"flex",alignItems:"flex-start",gap:10,padding:"12px 14px",background:ev.skipped?"#F4A26108":"var(--bg)"}}><div style={{marginTop:2}}>{ev.skipped?<IconPlayerSkipForward size={15} color="#F4A261"/>:ev.settled?<IconCheck size={15} color="#6BAA75"/>:ev.direction==="owe"?<IconArrowDown size={15} color="#E07A5F"/>:<IconArrowUp size={15} color="#6BAA75"/>}</div><div style={{flex:1}}><div style={{fontSize:13,fontFamily:"var(--font-h)",fontWeight:600,color:"var(--text)",textDecoration:ev.skipped?"line-through":"none"}}>{ev.direction==="owe"?"You owe":"Owes you"}</div>{ev.note&&<div style={{fontSize:11,color:ev.skipped?"#F4A261":"var(--ts)",fontFamily:"var(--font-b)",marginTop:3,padding:"3px 8px",background:"var(--border)",borderRadius:5,display:"inline-block",maxWidth:"100%",opacity:0.85}}>{ev.note}</div>}<div style={{fontSize:10,color:"var(--muted)",fontFamily:"var(--font-b)",marginTop:3,display:"flex",alignItems:"center",gap:4}}>{ev.skipped?<><IconPlayerSkipForward size={9} color="#F4A261"/>Skipped</>:ev.settled?<><IconCheck size={9} color="#6BAA75"/>Settled</>:<><IconClock size={9} color="var(--muted)"/>Pending</>}{ev.createdAt&&` · ${fmtDate(ev.createdAt)}`}</div></div><div style={{textAlign:"right",flexShrink:0}}><div style={{fontFamily:"var(--font-h)",fontWeight:700,fontSize:15,color:ev.skipped?"#F4A261":ev.direction==="owe"?"#E07A5F":"#6BAA75",textDecoration:ev.skipped?"line-through":"none"}}>{fmt(ev.amount)}</div>{!ev.settled&&remainForSplit(ev)<ev.amount-0.005&&<div style={{fontSize:9,color:"var(--muted)",fontFamily:"var(--font-h)"}}>{fmt(remainForSplit(ev))} left</div>}</div></div>{!ev.settled&&delConfirm===ev.id&&<div style={{background:"#E07A5F12",padding:"10px 14px",display:"flex",alignItems:"center",gap:10,borderTop:"1px solid #E07A5F30"}}><IconAlertTriangle size={14} color="#E07A5F"/><span style={{flex:1,fontSize:11,fontFamily:"var(--font-h)",color:"#E07A5F"}}>Delete this IOU permanently?</span><button onClick={()=>sDelConfirm(null)} style={{padding:"4px 10px",border:"1px solid var(--border)",borderRadius:6,background:"transparent",color:"var(--muted)",fontFamily:"var(--font-h)",fontSize:10,cursor:"pointer"}}>Cancel</button><button onClick={()=>{od(ev.id);sDelConfirm(null);}} style={{padding:"4px 10px",border:"none",borderRadius:6,background:"#E07A5F",color:"#fff",fontFamily:"var(--font-h)",fontSize:10,fontWeight:700,cursor:"pointer"}}>Delete</button></div>}{!ev.settled&&<div style={{display:"flex",borderTop:"1px solid var(--border)"}}><button onClick={()=>sT(ev)} style={{flex:2,padding:"9px 6px",border:"none",background:"transparent",color:"#6BAA75",fontFamily:"var(--font-h)",fontSize:11,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:4}}><IconSend size={12}/>Record payment</button><div style={{width:1,background:"var(--border)"}}/><button onClick={()=>ok(ev.id)} style={{flex:1,padding:"9px 6px",border:"none",background:"transparent",color:"#F4A261",fontFamily:"var(--font-h)",fontSize:11,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:3}}><IconPlayerSkipForward size={12}/>Skip</button><div style={{width:1,background:"var(--border)"}}/><button onClick={()=>sDelConfirm(delConfirm===ev.id?null:ev.id)} style={{padding:"9px 12px",border:"none",background:"transparent",color:"#E07A5F",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconTrash size={14}/></button></div>}</div>:<div key={ev.id} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",background:"var(--bg)",borderRadius:12,marginBottom:8,border:"1px solid var(--border)",opacity:0.65}}><div style={{width:28,height:28,borderRadius:8,background:ev.direction==="owed"?"#6BAA7518":"#E07A5F18",display:"flex",alignItems:"center",justifyContent:"center"}}><IconSend size={13} color={ev.direction==="owed"?"#6BAA75":"#E07A5F"}/></div><div style={{flex:1}}><div style={{fontSize:12,fontFamily:"var(--font-h)",fontWeight:600,color:"var(--text)"}}>{ev.direction==="owed"?"Payment received":"Payment made"}</div><div style={{fontSize:10,color:"var(--muted)",fontFamily:"var(--font-b)"}}>{ev.createdAt?fmtDate(ev.createdAt):ev.date||""}</div></div><span style={{fontFamily:"var(--font-h)",fontWeight:700,fontSize:14,color:ev.direction==="owed"?"#6BAA75":"#E07A5F"}}>{ev.direction==="owed"?"+":"-"}{fmt(ev.amount)}</span></div>)}
    <div style={{borderTop:"1px solid var(--border)",marginTop:14,paddingTop:14}}><div style={{fontFamily:"var(--font-h)",fontSize:10,color:"var(--muted)",fontWeight:600,marginBottom:8,letterSpacing:"0.5px"}}>ADD NEW IOU WITH {drill.toUpperCase()}</div><div style={{display:"flex",gap:6,marginBottom:8}}>{["owe","owed"].map(d=><button key={d} onClick={()=>sD(d)} style={{flex:1,padding:"7px",borderRadius:8,fontSize:11,fontFamily:"var(--font-h)",border:`1.5px solid ${dir===d?(d==="owe"?"#E07A5F":"#6BAA75"):"var(--border)"}`,background:dir===d?(d==="owe"?"#E07A5F18":"#6BAA7518"):"var(--card)",color:dir===d?(d==="owe"?"#E07A5F":"#6BAA75"):"var(--muted)",cursor:"pointer",fontWeight:600}}>{d==="owe"?"I owe them":"They owe me"}</button>)}</div>{cats.length>0&&<div style={{display:"flex",gap:5,overflowX:"auto",scrollbarWidth:"none",WebkitOverflowScrolling:"touch",marginBottom:8,paddingBottom:2}}>{cats.map(c=><button key={c.id} onClick={()=>sScat(c.id)} style={{flexShrink:0,padding:"5px 10px",borderRadius:14,fontSize:11,fontFamily:"var(--font-h)",border:`1.5px solid ${effScat===c.id?c.color:"var(--border)"}`,background:effScat===c.id?c.color+"18":"var(--card)",color:effScat===c.id?c.color:"var(--muted)",cursor:"pointer",fontWeight:effScat===c.id?700:500,display:"inline-flex",alignItems:"center",gap:4,whiteSpace:"nowrap"}}><DI2 id={c.id} accent={c.neon||c.color} size={11}/>{c.name}</button>)}</div>}<div style={{display:"flex",gap:6}}><input type="number" value={am} onChange={e=>sA(e.target.value)} placeholder="₹ amount" style={{...is,flex:1,marginBottom:0}}/><input value={snote} onChange={e=>sSnote(e.target.value)} placeholder="Note" style={{...is,flex:1,marginBottom:0}}/><button onClick={add} style={{padding:"10px 14px",border:"none",borderRadius:10,background:"#E07A5F",color:"#fff",fontFamily:"var(--font-h)",fontSize:13,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",gap:4}}><IconPlus size={14}/>Add</button></div></div>
    {st&&<SettleM split={st} remaining={remainForSplit(st)} wallets={wl} onConfirm={(wid,amount)=>{os(st.id,wid,amount);sT(null);}} onClose={()=>sT(null)}/>}</div>;
  }
  if(exp&&showFeed){
    const feed=[...sp.filter(s=>!s.eventId&&!s.deleted_at).map(s=>({...s,_k:"split"})),...(stl||[]).filter(s=>!s.eventId).map(s=>({...s,_k:"stl"}))].sort((a,b)=>itemTimestamp(b)-itemTimestamp(a));
    return <div style={{...cc,borderRadius:16,padding:18,marginBottom:14,position:"relative",overflow:"hidden"}}><div style={{position:"absolute",bottom:0,right:0,width:60,height:3,borderRadius:"3px 0 0 0",background:"#D4726A"}}/><div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}><button onClick={()=>sSF(false)} style={{background:"none",border:"none",cursor:"pointer",color:"var(--muted)",padding:2,display:"flex",alignItems:"center"}}><IconChevronLeft size={18}/></button><div style={{fontFamily:"var(--font-h)",fontSize:13,fontWeight:700,color:"#D4726A",flex:1}}>Split History</div></div>
    {feed.length===0&&<div style={{textAlign:"center",padding:"20px 0",color:"var(--muted)",fontSize:13,fontFamily:"var(--font-h)"}}>No split history yet</div>}
    {feed.map(ev=>ev._k==="split"?<div key={ev.id} onClick={()=>{sDrill(ev.name);sSF(false);}} style={{display:"flex",alignItems:"center",gap:12,padding:"11px 14px",background:"var(--bg)",borderRadius:12,marginBottom:8,border:`1px solid ${ev.settled?"var(--border)":ev.direction==="owe"?"#E07A5F30":"#6BAA7530"}`,cursor:"pointer",opacity:ev.settled?0.6:1}}><div style={{width:32,height:32,borderRadius:"50%",background:avatarColor(ev.name),display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><span style={{fontFamily:"var(--font-h)",fontSize:11,fontWeight:700,color:"#fff"}}>{initials(ev.name)}</span></div><div style={{flex:1}}><div style={{fontSize:13,fontWeight:600,fontFamily:"var(--font-h)",color:"var(--text)"}}>{ev.name}</div><div style={{fontSize:10,color:"var(--muted)",fontFamily:"var(--font-b)",display:"flex",alignItems:"center",gap:4}}>{ev.skipped?<IconPlayerSkipForward size={9} color="#F4A261"/>:ev.settled?<IconCheck size={9} color="#6BAA75"/>:ev.direction==="owe"?<IconArrowDown size={9} color="#E07A5F"/>:<IconArrowUp size={9} color="#6BAA75"/>}{ev.skipped?"Skipped":ev.direction==="owe"?"You owe":"Owes you"}{ev.note&&` · ${ev.note}`}{ev.createdAt&&` · ${fmtDate(ev.createdAt)}`}</div></div><span style={{fontFamily:"var(--font-h)",fontWeight:700,fontSize:14,color:ev.direction==="owe"?"#E07A5F":"#6BAA75"}}>{fmt(ev.amount)}</span></div>:<div key={ev.id} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",background:"var(--bg)",borderRadius:12,marginBottom:8,border:"1px solid var(--border)",opacity:0.65}}><div style={{width:32,height:32,borderRadius:"50%",background:avatarColor(ev.splitName||""),display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><span style={{fontFamily:"var(--font-h)",fontSize:11,fontWeight:700,color:"#fff"}}>{initials(ev.splitName||"")}</span></div><div style={{flex:1}}><div style={{fontSize:13,fontWeight:600,fontFamily:"var(--font-h)",color:"var(--text)"}}>{ev.splitName}</div><div style={{fontSize:10,color:"var(--muted)",fontFamily:"var(--font-b)",display:"flex",alignItems:"center",gap:4}}><IconSend size={9} color="var(--muted)"/>{ev.direction==="owed"?"Received":"Paid"}{ev.createdAt?` · ${fmtDate(ev.createdAt)}`:ev.date?` · ${ev.date}`:""}</div></div><span style={{fontFamily:"var(--font-h)",fontWeight:700,fontSize:14,color:ev.direction==="owed"?"#6BAA75":"#E07A5F"}}>{ev.direction==="owed"?"+":"-"}{fmt(ev.amount)}</span></div>)}
    </div>;
  }
  return <div style={{...cc,borderRadius:16,padding:18,marginBottom:14,position:"relative",overflow:"hidden"}}><div style={{position:"absolute",bottom:0,right:0,width:60,height:3,borderRadius:"3px 0 0 0",background:"#D4726A"}}/><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}><div style={{fontFamily:"var(--font-h)",fontSize:12,color:"#D4726A",letterSpacing:"0.5px",fontWeight:700}}>Split Expenses</div><div style={{display:"flex",gap:6,alignItems:"center"}}><button onClick={()=>sSF(true)} style={{background:"none",border:"1px solid var(--border)",borderRadius:6,padding:"4px 8px",fontSize:10,color:"var(--muted)",cursor:"pointer",fontFamily:"var(--font-h)",display:"flex",alignItems:"center",gap:3}}><IconHistory size={11}/>History</button><button onClick={ot} style={{background:"none",border:"none",fontSize:12,color:"var(--muted)",cursor:"pointer",fontFamily:"var(--font-h)",display:"flex",alignItems:"center"}}><IconChevronLeft size={16}/>Back</button></div></div>
  <div style={{display:"flex",gap:12,marginBottom:16}}><div style={{flex:1,textAlign:"center",padding:"11px 8px",background:"#E07A5F10",borderRadius:12,border:"1px solid #E07A5F20"}}><div style={{fontSize:9,color:"#E07A5F",fontFamily:"var(--font-h)",fontWeight:600,letterSpacing:"0.5px",marginBottom:3}}>YOU OWE</div><div style={{fontSize:17,fontWeight:700,fontFamily:"var(--font-h)",color:"#E07A5F"}}>{fmt(tO)}</div></div><div style={{flex:1,textAlign:"center",padding:"11px 8px",background:"#6BAA7510",borderRadius:12,border:"1px solid #6BAA7520"}}><div style={{fontSize:9,color:"#6BAA75",fontFamily:"var(--font-h)",fontWeight:600,letterSpacing:"0.5px",marginBottom:3}}>OWED TO YOU</div><div style={{fontSize:17,fontWeight:700,fontFamily:"var(--font-h)",color:"#6BAA75"}}>{fmt(tI)}</div></div></div>
  {activePeople.length===0&&people.length===0&&<div style={{textAlign:"center",padding:"12px 0 4px",color:"var(--muted)",fontSize:13,fontFamily:"var(--font-h)"}}>No splits yet — add one below</div>}
  {activePeople.map(name=>{const pm=personMap[name];const net=pm.net;const pending=pm.splits.filter(s=>!s.settled);const aColor=avatarColor(name);const isOpen=openCards.has(name);return <div key={name} style={{marginBottom:8,borderRadius:14,border:`1px solid ${net>0?"#6BAA7530":"#E07A5F30"}`,overflow:"hidden"}}><div onClick={()=>sOC(prev=>{const n=new Set(prev);n.has(name)?n.delete(name):n.add(name);return n;})} style={{display:"flex",alignItems:"center",gap:12,padding:"13px 14px",background:"var(--bg)",cursor:"pointer"}}><div style={{width:40,height:40,borderRadius:"50%",background:aColor,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,boxShadow:`0 2px 8px ${aColor}40`}}><span style={{fontFamily:"var(--font-h)",fontSize:14,fontWeight:700,color:"#fff"}}>{initials(name)}</span></div><div style={{flex:1,minWidth:0}}><div style={{fontSize:14,fontWeight:700,fontFamily:"var(--font-h)",color:"var(--text)"}}>{name}</div><div style={{fontSize:11,color:"var(--muted)",fontFamily:"var(--font-b)",display:"flex",alignItems:"center",gap:4}}>{net>0?<IconArrowUp size={11} color="#6BAA75"/>:<IconArrowDown size={11} color="#E07A5F"/>}{net>0?"Owes you":"You owe"}{pending.length>1&&<span style={{fontSize:9,background:"var(--border)",padding:"1px 5px",borderRadius:4,fontWeight:600}}>×{pending.length}</span>}</div></div><div style={{textAlign:"right",flexShrink:0}}><div style={{fontFamily:"var(--font-h)",fontWeight:800,fontSize:16,color:net>0?"#6BAA75":"#E07A5F"}}>{fmt(Math.abs(net))}</div><div style={{fontSize:10,color:"var(--muted)",fontFamily:"var(--font-h)",marginTop:2}}>{isOpen?"▲ hide":"▼ show"}</div></div></div>{isOpen&&pending.map(s=><div key={s.id} style={{borderTop:"1px solid var(--border)",background:"var(--card)"}}><div style={{display:"flex",alignItems:"flex-start",gap:10,padding:"12px 14px 8px"}}><div style={{marginTop:2}}>{s.direction==="owe"?<IconArrowDown size={14} color="#E07A5F"/>:<IconArrowUp size={14} color="#6BAA75"/>}</div><div style={{flex:1}}><div style={{fontSize:13,fontFamily:"var(--font-h)",fontWeight:600,color:"var(--text)"}}>{s.direction==="owe"?"You owe them":"They owe you"}</div>{s.note&&<div style={{fontSize:11,color:"var(--ts)",fontFamily:"var(--font-b)",marginTop:3,padding:"2px 8px",background:"var(--border)",borderRadius:4,display:"inline-block",opacity:0.85}}>{s.note}</div>}<div style={{fontSize:10,color:"var(--muted)",fontFamily:"var(--font-b)",marginTop:3,display:"flex",alignItems:"center",gap:4}}><IconClock size={9} color="var(--muted)"/>Pending{s.createdAt&&` · ${fmtDate(s.createdAt)}`}</div></div><div style={{textAlign:"right",flexShrink:0}}><div style={{fontFamily:"var(--font-h)",fontWeight:700,fontSize:15,color:s.direction==="owe"?"#E07A5F":"#6BAA75"}}>{fmt(remainForSplit(s))}</div>{remainForSplit(s)<s.amount-0.005&&<div style={{fontSize:9,color:"var(--muted)",fontFamily:"var(--font-h)"}}>of {fmt(s.amount)}</div>}</div></div>{delConfirm===s.id&&<div style={{background:"#E07A5F12",padding:"8px 14px",display:"flex",alignItems:"center",gap:10}}><IconAlertTriangle size={13} color="#E07A5F"/><span style={{flex:1,fontSize:11,fontFamily:"var(--font-h)",color:"#E07A5F"}}>Delete this IOU permanently?</span><button onClick={()=>sDelConfirm(null)} style={{padding:"4px 10px",border:"1px solid var(--border)",borderRadius:6,background:"transparent",color:"var(--muted)",fontFamily:"var(--font-h)",fontSize:10,cursor:"pointer"}}>Cancel</button><button onClick={()=>{od(s.id);sDelConfirm(null);}} style={{padding:"4px 10px",border:"none",borderRadius:6,background:"#E07A5F",color:"#fff",fontFamily:"var(--font-h)",fontSize:10,fontWeight:700,cursor:"pointer"}}>Delete</button></div>}<div style={{display:"flex",borderTop:"1px solid var(--border)"}}><button onClick={()=>sT(s)} style={{flex:2,padding:"9px 6px",border:"none",background:"transparent",color:"#6BAA75",fontFamily:"var(--font-h)",fontSize:11,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:4}}><IconSend size={11}/>Record payment</button><div style={{width:1,background:"var(--border)"}}/><button onClick={()=>ok(s.id)} style={{flex:1,padding:"9px 6px",border:"none",background:"transparent",color:"#F4A261",fontFamily:"var(--font-h)",fontSize:11,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:3}}><IconPlayerSkipForward size={11}/>Skip</button><div style={{width:1,background:"var(--border)"}}/><button onClick={()=>sDelConfirm(delConfirm===s.id?null:s.id)} style={{padding:"9px 12px",border:"none",background:"transparent",color:"#E07A5F",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconTrash size={13}/></button></div></div>)}{isOpen&&<div onClick={()=>sDrill(name)} style={{padding:"9px 14px",borderTop:"1px solid var(--border)",display:"flex",alignItems:"center",justifyContent:"center",gap:5,cursor:"pointer",background:"var(--bg)"}}><IconHistory size={11} color="var(--muted)"/><span style={{fontSize:11,color:"var(--muted)",fontFamily:"var(--font-h)"}}>Full history & settled IOUs</span><IconChevronRight size={11} color="var(--muted)"/></div>}</div>;})}  {settledPeople.length>0&&<details style={{marginTop:4}}><summary style={{fontSize:11,color:"var(--muted)",cursor:"pointer",fontFamily:"var(--font-h)",fontWeight:500,marginBottom:6,display:"flex",alignItems:"center",gap:5}}><IconCheck size={11} color="#6BAA75"/>Settled up ({settledPeople.length})</summary>{settledPeople.map(name=><div key={name} onClick={()=>sDrill(name)} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 13px",background:"var(--bg)",borderRadius:12,marginBottom:6,opacity:0.5,cursor:"pointer",border:"1px solid var(--border)"}}><div style={{width:32,height:32,borderRadius:"50%",background:avatarColor(name),display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><span style={{fontFamily:"var(--font-h)",fontSize:11,fontWeight:700,color:"#fff"}}>{initials(name)}</span></div><span style={{flex:1,fontSize:13,fontFamily:"var(--font-h)",color:"var(--ts)",fontWeight:600}}>{name}</span><div style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:"var(--muted)",fontFamily:"var(--font-h)"}}><IconCheck size={11} color="#6BAA75"/>All settled</div></div>)}</details>}
  <div style={{borderTop:"1px solid var(--border)",marginTop:14,paddingTop:14}}><div style={{fontFamily:"var(--font-h)",fontSize:10,color:"var(--muted)",fontWeight:600,marginBottom:8,letterSpacing:"0.5px"}}>ADD SPLIT IOU</div><div style={{display:"flex",gap:6,marginBottom:8}}>{["owe","owed"].map(d=><button key={d} onClick={()=>sD(d)} style={{flex:1,padding:"8px",borderRadius:8,fontSize:11,fontFamily:"var(--font-h)",border:`1.5px solid ${dir===d?(d==="owe"?"#E07A5F":"#6BAA75"):"var(--border)"}`,background:dir===d?(d==="owe"?"#E07A5F18":"#6BAA7518"):"var(--card)",color:dir===d?(d==="owe"?"#E07A5F":"#6BAA75"):"var(--muted)",cursor:"pointer",fontWeight:600,display:"flex",alignItems:"center",justifyContent:"center",gap:4}}>{d==="owe"?<><IconArrowDown size={12}/>I owe them</>:<><IconArrowUp size={12}/>They owe me</>}</button>)}</div><div style={{display:"flex",gap:6,marginBottom:6}}><input value={nm} onChange={e=>sN(e.target.value)} placeholder="Friend name" style={{...is,flex:1,marginBottom:0}}/><input type="number" value={am} onChange={e=>sA(e.target.value)} placeholder="₹" style={{...is,width:80,marginBottom:0}}/><button onClick={add} style={{padding:"10px 14px",border:"none",borderRadius:10,background:"#E07A5F",color:"#fff",fontFamily:"var(--font-h)",fontSize:13,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",gap:4}}><IconPlus size={14}/>Add</button></div><input value={snote} onChange={e=>sSnote(e.target.value)} placeholder="Note (what's this for?)" style={{...is,marginBottom:cats.length>0?8:0}}/>{cats.length>0&&<div style={{display:"flex",gap:5,overflowX:"auto",scrollbarWidth:"none",WebkitOverflowScrolling:"touch",paddingBottom:2}}>{cats.map(c=><button key={c.id} onClick={()=>sScat(c.id)} style={{flexShrink:0,padding:"5px 10px",borderRadius:14,fontSize:11,fontFamily:"var(--font-h)",border:`1.5px solid ${effScat===c.id?c.color:"var(--border)"}`,background:effScat===c.id?c.color+"18":"var(--card)",color:effScat===c.id?c.color:"var(--muted)",cursor:"pointer",fontWeight:effScat===c.id?700:500,display:"inline-flex",alignItems:"center",gap:4,whiteSpace:"nowrap"}}><DI2 id={c.id} accent={c.neon||c.color} size={11}/>{c.name}</button>)}</div>}</div>
  {st&&<SettleM split={st} remaining={remainForSplit(st)} wallets={wl} onConfirm={(wid,amount)=>{os(st.id,wid,amount);sT(null);}} onClose={()=>sT(null)}/>}</div>
}

const CURRENCIES = ["INR", "USD", "EUR", "GBP", "AED", "SGD", "JPY", "AUD", "CAD", "CHF", "CNY", "HKD", "NZD", "MYR", "THB", "PHP", "IDR", "KRW", "TWD", "SAR", "KWD", "QAR", "BHD", "OMR", "EGP", "ZAR", "NGN", "SEK", "NOK", "DKK", "PLN", "TRY", "RUB", "PKR", "BDT", "LKR", "NPR", "MXN", "BRL", "ARS"];
const CURRENCY_COUNTRIES = { INR: "India", USD: "United States", EUR: "Eurozone", GBP: "United Kingdom", AED: "UAE", SGD: "Singapore", JPY: "Japan", AUD: "Australia", CAD: "Canada", CHF: "Switzerland", CNY: "China", HKD: "Hong Kong", NZD: "New Zealand", MYR: "Malaysia", THB: "Thailand", PHP: "Philippines", IDR: "Indonesia", KRW: "South Korea", TWD: "Taiwan", SAR: "Saudi Arabia", KWD: "Kuwait", QAR: "Qatar", BHD: "Bahrain", OMR: "Oman", EGP: "Egypt", ZAR: "South Africa", NGN: "Nigeria", SEK: "Sweden", NOK: "Norway", DKK: "Denmark", PLN: "Poland", TRY: "Turkey", RUB: "Russia", PKR: "Pakistan", BDT: "Bangladesh", LKR: "Sri Lanka", NPR: "Nepal", MXN: "Mexico", BRL: "Brazil", ARS: "Argentina" };
const getCurrencyFlag = c => { if (c === "EUR") return "🇪🇺"; try { return String.fromCodePoint(...[...c.slice(0, 2).toUpperCase()].map(x => 127397 + x.charCodeAt(0))); } catch { return "🏳"; } };

// Extract the most useful keyword from a note for autoRule storage.
// Skips generic words, prefers first meaningful token (usually merchant/brand).
function extractKeyword(note) {
  const skip = new Set(["paid","for","at","the","to","from","in","on","a","an","rs","inr","and","or","by","with","via","of","per","my","via","recharge","payment","pay","bill"]);
  const words = note.toLowerCase().replace(/[₹,]/g, " ").split(/\s+/).filter(w => w.length > 2 && !skip.has(w) && !/^\d+$/.test(w));
  return words[0] || note.toLowerCase().trim().slice(0, 20);
}

function parseVoiceTx(transcript, { wallets = [], categories = [] } = {}) {
  if (!transcript) return {};
  const txt = String(transcript).toLowerCase().replace(/[,.!?]/g, " ").replace(/\s+/g, " ").trim();
  const amtMatch = txt.match(/(?:rs\.?|rupees?|₹)?\s*(\d+(?:\.\d+)?)\s*(?:rs\.?|rupees?|₹|bucks?)?/);
  const amount = amtMatch ? parseFloat(amtMatch[1]) : null;
  let wid = null;
  const walletAliases = { upi_lite: ["upi lite", "upi", "lite"], bank: ["bank", "account", "debit"], cash: ["cash"] };
  for (const w of wallets) {
    const aliases = walletAliases[w.id] || [w.name.toLowerCase()];
    if (aliases.some(a => txt.includes(a))) { wid = w.id; break; }
  }
  let cid = null;
  for (const c of categories) {
    if (txt.includes(c.name.toLowerCase())) { cid = c.id; break; }
  }
  let note = txt;
  if (amtMatch) note = note.replace(amtMatch[0], " ");
  note = note.replace(/\b(rs|rupees?|bucks?|paid|spent|got|received|added)\b/g, " ");
  if (wid) (walletAliases[wid] || []).forEach(a => { note = note.replace(new RegExp("\\b" + a + "\\b", "g"), " "); });
  note = note.replace(/\s+/g, " ").trim();
  return { amount, walletId: wid, categoryId: cid, note: note || null };
}

function VoiceAdd({ onParsed, accent = "#E07A5F" }) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState(null);
  const recRef = useRef(null);
  const SR = typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition);
  if (!SR) return null;
  const start = () => {
    setError(null);
    try {
      const rec = new SR();
      rec.lang = "en-IN";
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.continuous = false;
      rec.onresult = (e) => { const t = e.results?.[0]?.[0]?.transcript || ""; onParsed(t); setListening(false); };
      rec.onerror = (e) => { setError(e.error || "voice error"); setListening(false); };
      rec.onend = () => setListening(false);
      recRef.current = rec;
      rec.start();
      setListening(true);
    } catch { setError("mic unavailable"); }
  };
  const stop = () => { try { recRef.current?.stop(); } catch { /* ignore */ } setListening(false); };
  return <div style={{ marginBottom: 14 }}><button onClick={listening ? stop : start} style={{ width: "100%", padding: "10px 14px", border: `1.5px dashed ${listening ? "#E07A5F" : accent}`, borderRadius: 10, background: listening ? "#E07A5F12" : "var(--card)", color: listening ? "#E07A5F" : accent, fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}><Microphone size={14} weight={listening ? "fill" : "regular"} />{listening ? "Listening… tap to stop" : "Voice add — say e.g. \"300 coffee bank\""}</button>{error && <div style={{ fontSize: 11, color: "#E07A5F", marginTop: 4, fontFamily: "var(--font-h)" }}>{error}</div>}</div>;
}

function AddPage({ categories: cats, incomeSources: isrc, recurringCats: rCats, onAddExpense: oE, onAddIncome: oI, onAddTransfer: oT, onAddRec: oR, onError: showT = () => {}, patterns = [], autoRules = [], onLearnRule = () => {}, wallets: aw = WALLETS, cloudinaryEnabled = false, onLocalReceipt }) {
  const _AD = (() => { try { return JSON.parse(sessionStorage.getItem("nomad-add-draft") || "{}"); } catch { return {}; } })();
  const [type, sType] = useState(_AD.type || "expense"), [amt, sAmt] = useState(_AD.amt || "0"), [catId, sCat] = useState(_AD.catId || cats[0]?.id || ""), [srcId, sSrc] = useState(isrc[0]?.id || ""), [wid, sW] = useState(_AD.wid || "bank"), [iwid, sIW] = useState("bank"), [tFrom, sTF] = useState("bank"), [tTo, sTT] = useState("upi_lite"), [date, sDate] = useState(_AD.date || localDateKey()), [note, sNote] = useState(_AD.note || "");
  const [rName, sRN] = useState(""), [rAmt, sRA] = useState(""), [rCat, sRC] = useState("rent"), [rWal, sRW] = useState("bank"), [rFreq, sRF] = useState("monthly"), [rDay, sRD] = useState(1), [rInt, sRI] = useState(30), [rStart, sRS] = useState(localDateKey()), [rOther, sRO] = useState(""), [rYM, sRYM] = useState(1), [rYD, sRYD] = useState(1);
  const [fxCur, setFxCur] = useState("INR"), [fxRate, setFxRate] = useState(null), [fxFetching, setFxFetching] = useState(false);
  const [fxExpanded, setFxExpanded] = useState(false), [fxSearch, setFxSearch] = useState("");
  const receiptPickerRef = useRef(null);
  const [submitting, setSubmitting] = useState(false);
  const [aiCatSug, sAiCatSug] = useState(null); // {categoryId, confidence, keyword} | null
  const [aiCatLoading, sAiCatLoading] = useState(false);
  const [ocrLoading, sOcrLoading] = useState(false);
  const aiDebounceRef = useRef(null);
  const scanReceipt = async () => {
    if (ocrLoading) return;
    if (!receiptPickerRef.current?.hasImage) { showT("Add a receipt photo first", "error"); return; }
    sOcrLoading(true);
    try {
      const data = await receiptPickerRef.current.getFirstImageData();
      if (!data) { showT("No image to scan", "error"); return; }
      const r = await fetch("/api/food-vision", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...data, type: "receipt" }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "OCR failed");
      if (d.amount > 0) sAmt(String(d.amount));
      if (d.merchant) sNote(d.merchant);
      if (d.date && /^\d{4}-\d{2}-\d{2}$/.test(d.date)) sDate(d.date);
      showT(`Scanned: ${d.merchant || "(no merchant)"} ${d.amount > 0 ? "₹" + d.amount : ""} · ${d.confidence}`, d.confidence === "low" ? "info" : "success");
    } catch (e) {
      showT(e.message || "OCR error", "error");
    } finally {
      sOcrLoading(false);
    }
  };
  useEffect(() => { const c = fxCur.trim().toUpperCase(); if (c.length !== 3 || c === "INR") { setFxRate(null); return; } setFxFetching(true); getExchangeRate(c).then(r => { setFxRate(r); setFxFetching(false); }).catch(() => { setFxRate(null); setFxFetching(false); }); }, [fxCur]);
  useEffect(() => { try { sessionStorage.setItem("nomad-add-draft", JSON.stringify({ type, amt, catId, wid, date, note })); } catch { /* ignore storage errors */ } }, [type, amt, catId, wid, date, note]);
  const ts = useRef(null), tc = type === "expense" ? "#E07A5F" : type === "income" ? "#6BAA75" : type === "transfer" ? "#7B8CDE" : "#A78BFA";
  const submit = async () => {
    if (submitting) return;
    const a = parseAmount(amt);
    if (!Number.isFinite(a) || a <= 0) return;
    if (type === "transfer" && tFrom === tTo) return;
    setSubmitting(true);
    try {
      // Upload receipts only at submit time — fixes premature Cloudinary uploads
      let rUrl = null;
      if (type !== "transfer" && receiptPickerRef.current?.count > 0) {
        try {
          const urls = await receiptPickerRef.current.upload();
          rUrl = urls.length === 1 ? urls[0] : urls.length > 1 ? JSON.stringify(urls) : null;
          if (urls.some(u => typeof u === "string" && u.startsWith("data:"))) {
            // cloudinaryEnabled = cloudName is set. If set AND we still got a data:
            // URL back, the upload was attempted but Cloudinary rejected/failed —
            // show error toast pointing at config. If not set, fallback is intentional.
            if (cloudinaryEnabled) {
              showT("Cloudinary upload failed — receipt saved locally. Check API credentials or upload preset in Settings (DevTools → Network → cloudinary for details).", "error");
            } else {
              showT("Receipt saved locally — add Cloudinary in Settings to sync receipts to the cloud", "info");
            }
          }
        } catch (err) {
          showT(err?.message || "Receipt upload failed — please try again", "error");
          return; // keep form + picker state intact for retry
        }
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
    {(type === "expense" || type === "income") && <VoiceAdd accent={tc} onParsed={t => { const r = parseVoiceTx(t, { wallets: aw, categories: type === "expense" ? cats : isrc }); if (r.amount) sAmt(String(r.amount)); if (r.note) sNote(r.note); if (r.walletId) { if (type === "expense") sW(r.walletId); else if (!isUpiLite(aw.find(w => w.id === r.walletId) || {})) sIW(r.walletId); } if (r.categoryId) { if (type === "expense") sCat(r.categoryId); else sSrc(r.categoryId); } showT(r.amount ? `Heard: ₹${r.amount} ${r.note || ""}` : "Couldn't parse — try \"300 coffee bank\"", r.amount ? "info" : "error"); }} />}
    {type === "expense" && patterns.length > 0 && <div style={{ marginBottom: 16 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 11, color: "var(--muted)", letterSpacing: "0.5px", fontWeight: 600, marginBottom: 8 }}>QUICK ADD</div><div style={{ display: "flex", gap: 6, overflowX: "auto", scrollbarWidth: "none", WebkitOverflowScrolling: "touch", paddingBottom: 4 }}>{patterns.map((p, i) => { const cat = cats.find(c => c.id === p.categoryId); const accent = cat?.color || "#E07A5F"; return <button key={i} onClick={() => { sAmt(String(p.amount)); sCat(p.categoryId); sW(p.walletId); if (p.note) sNote(p.note); }} style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 5, padding: "7px 13px", borderRadius: 20, border: `1.5px solid ${accent}`, background: accent + "18", cursor: "pointer", fontFamily: "var(--font-h)", transition: "background 0.12s" }}><DI2 id={p.categoryId} accent={cat?.neon || accent} size={13} /><span style={{ fontSize: 13, fontWeight: 700, color: accent }}>₹{p.amount}</span>{p.note && <span style={{ fontSize: 11, color: "var(--ts)", maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.note}</span>}<span style={{ fontSize: 10, color: "var(--muted)", fontWeight: 600, marginLeft: 1 }}>×{p.count}</span></button>; })}</div></div>}
    {type !== "recurring" && <><div style={{ marginBottom: 16 }}><label style={ls}>Amount</label>
      {/* Merged amount + currency box */}
      <div style={{ position: "relative", display: "flex", alignItems: "center", background: "var(--card)", border: `1.5px solid ${tc}`, borderRadius: 10, overflow: "hidden" }}>
        {/* ₹ prefix — always shows INR symbol regardless of selected currency */}
        {type !== "transfer" && <span style={{ marginLeft: 16, fontSize: 22, lineHeight: 1, flexShrink: 0, userSelect: "none" }}>{getCurrencyFlag(fxCur)}</span>}
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
      {type === "expense" && <><label style={ls}>Pay From</label><WB wallets={aw} sel={wid} onSel={sW} /><label style={ls}>Category</label><div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>{[...cats, ...(cats.find(c => c.id === "other") ? [] : [DC.find(c => c.id === "other")])].map(c => <button key={c.id} onClick={() => sCat(c.id)} style={{ padding: "8px 14px", borderRadius: 10, fontSize: 13, fontFamily: "var(--font-b)", border: `1.5px solid ${catId === c.id ? c.color : "var(--border)"}`, background: catId === c.id ? c.color + "18" : "var(--card)", color: catId === c.id ? c.color : "var(--ts)", cursor: "pointer", fontWeight: catId === c.id ? 600 : 400, display: "flex", alignItems: "center", gap: 5 }}><DI2 id={c.id} accent={c.neon || c.color} size={14} />{c.name}</button>)}</div></>}
      {type === "income" && <><label style={ls}>Receive Into</label><WB wallets={aw.filter(w => !isUpiLite(w))} sel={iwid} onSel={sIW} /><label style={ls}>Source</label><div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>{isrc.map(c => <button key={c.id} onClick={() => sSrc(c.id)} style={{ padding: "8px 14px", borderRadius: 10, fontSize: 13, fontFamily: "var(--font-b)", border: `1.5px solid ${srcId === c.id ? c.color : "var(--border)"}`, background: srcId === c.id ? c.color + "18" : "var(--card)", color: srcId === c.id ? c.color : "var(--ts)", cursor: "pointer", fontWeight: srcId === c.id ? 600 : 400, display: "flex", alignItems: "center", gap: 5 }}><DI2 id={c.id} accent={c.neon || c.color} size={14} />{c.name}</button>)}</div></>}
      {type === "transfer" && <><label style={ls}>From</label><WB wallets={aw} sel={tFrom} onSel={sTF} /><div style={{ textAlign: "center", fontSize: 18, color: "var(--muted)", marginBottom: 12 }}>↓</div><label style={ls}>To</label><WB wallets={aw} sel={tTo} onSel={sTT} />{tFrom === tTo && <p style={{ fontSize: 12, color: "#D4726A", textAlign: "center", marginBottom: 12 }}>Must be different.</p>}</>}
      <div style={{ display: "flex", gap: 10, marginBottom: aiCatSug || aiCatLoading ? 6 : 18 }}><div style={{ flex: 1 }}><label style={ls}>Date</label><input type="date" value={date} onChange={e => sDate(e.target.value)} style={is} /></div><div style={{ flex: 1 }}><label style={ls}>Note</label><input value={note} onChange={e => { const v = e.target.value; sNote(v); sAiCatSug(null); if (aiDebounceRef.current) clearTimeout(aiDebounceRef.current); if (type === "expense") { const kw = v.toLowerCase().trim(); const m = autoRules.find(r => kw.includes(r.keyword.toLowerCase())); if (m) { sCat(m.categoryId); } else if (v.trim().length >= 3) { aiDebounceRef.current = setTimeout(async () => { sAiCatLoading(true); try { const r = await fetch("/api/ai-categorize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note: v.trim(), categories: cats.map(c => ({ id: c.id, name: c.name })) }) }); const d = await r.json(); if (r.ok && d.categoryId) sAiCatSug({ ...d, keyword: extractKeyword(v) }); } catch { /* silent */ } finally { sAiCatLoading(false); } }, 800); } } }} placeholder="Optional…" style={is} /></div></div>
      {aiCatLoading && <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 12, display: "flex", alignItems: "center", gap: 5 }}>AI suggesting category…</div>}
      {aiCatSug && (() => { const c = cats.find(x => x.id === aiCatSug.categoryId); if (!c) return null; return <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, padding: "7px 10px", borderRadius: 8, background: (c.color || "#6BAA75") + "12", border: `1px solid ${c.color || "#6BAA75"}` }}><DI2 id={c.id} accent={c.neon || c.color} size={14} /><span style={{ flex: 1, fontSize: 12, fontFamily: "var(--font-h)", fontWeight: 600, color: "var(--text)", display: "flex", alignItems: "center", gap: 4 }}><Robot size={12} />{c.name}?</span><span style={{ fontSize: 9, color: c.color, background: (c.color || "#6BAA75") + "20", padding: "1px 5px", borderRadius: 4, fontWeight: 700 }}>{aiCatSug.confidence}</span><button onClick={() => { sCat(aiCatSug.categoryId); onLearnRule({ keyword: aiCatSug.keyword, categoryId: aiCatSug.categoryId, source: "ai", confidence: 0.9, hitCount: 0, createdAt: localDateKey() }); sAiCatSug(null); }} style={{ padding: "4px 10px", borderRadius: 6, border: "none", background: c.color || "#6BAA75", color: "#fff", fontFamily: "var(--font-h)", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>✓</button><button onClick={() => sAiCatSug(null)} style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 11, cursor: "pointer" }}>✗</button></div>; })()}
      {type !== "transfer" && <div style={{ marginBottom: 18 }}><ReceiptPicker ref={receiptPickerRef} cloudinaryEnabled={cloudinaryEnabled} />{type === "expense" && <button onClick={scanReceipt} disabled={ocrLoading} style={{ marginTop: 8, width: "100%", padding: "9px 12px", border: `1.5px dashed ${tc}`, borderRadius: 10, background: ocrLoading ? "var(--border)" : "var(--card)", color: tc, fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: ocrLoading ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}><Receipt size={14} weight="fill" />{ocrLoading ? "Scanning…" : "Scan receipt — auto-fill amount, merchant, date"}</button>}</div>}
      <button onClick={submit} disabled={submitting} style={{ width: "100%", padding: "14px", border: "none", borderRadius: 12, background: submitting ? tc + "99" : tc, color: "#fff", fontSize: 15, fontFamily: "var(--font-h)", fontWeight: 600, cursor: submitting ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
        {submitting && <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite" /></path></svg>}
        {submitting ? "Uploading…" : type === "expense" ? "Add Expense" : type === "income" ? "Add Income" : "Transfer"}
      </button></>}
    {type === "recurring" && <><label style={ls}>Name</label><input value={rName} onChange={e => sRN(e.target.value)} placeholder="e.g. Netflix, Rent…" style={{ ...is, marginBottom: 12 }} /><label style={ls}>Amount ({CUR})</label><input type="number" value={rAmt} onChange={e => sRA(e.target.value)} placeholder="0" style={{ ...is, fontSize: 24, fontWeight: 700, fontFamily: "var(--font-h)", textAlign: "center", padding: "14px", color: "#A78BFA", borderColor: "#A78BFA", marginBottom: 12 }} /><label style={ls}>Category</label><div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>{(rCats || RC).map(c => <button key={c.id} onClick={() => sRC(c.id)} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 12, fontFamily: "var(--font-b)", border: `1.5px solid ${rCat === c.id ? c.color : "var(--border)"}`, background: rCat === c.id ? c.color + "18" : "var(--card)", color: rCat === c.id ? c.color : "var(--ts)", cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}><DI2 id={c.id} accent={c.neon || c.color} size={13} />{c.name}</button>)}</div>
      {rCat === "other_rec" && <input value={rOther} onChange={e => sRO(e.target.value)} placeholder="Name this category…" style={{ ...is, marginBottom: 12 }} />}
      <label style={ls}>Wallet</label><WB wallets={aw.filter(w => !isUpiLite(w))} sel={rWal} onSel={sRW} /><label style={ls}>Frequency</label><div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>{[{ id: "monthly", label: "Monthly" }, { id: "yearly", label: "Yearly" }, { id: "custom", label: "Every X Days" }].map(f => <button key={f.id} onClick={() => sRF(f.id)} style={{ flex: 1, padding: "9px", borderRadius: 9, fontSize: 12, fontFamily: "var(--font-h)", border: `1.5px solid ${rFreq === f.id ? "#A78BFA" : "var(--border)"}`, background: rFreq === f.id ? "#A78BFA18" : "var(--card)", color: rFreq === f.id ? "#A78BFA" : "var(--muted)", cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap" }}>{f.label}</button>)}</div>
      {rFreq === "monthly" && <div style={{ marginBottom: 12 }}><label style={ls}>Day of Month</label><input type="number" min={1} max={31} value={rDay} onChange={e => sRD(e.target.value)} style={{ ...is, textAlign: "center", fontFamily: "var(--font-h)", fontWeight: 600 }} /></div>}
      {rFreq === "yearly" && <div style={{ display: "flex", gap: 8, marginBottom: 12 }}><div style={{ flex: 1 }}><label style={ls}>Month (1–12)</label><input type="number" min={1} max={12} value={rYM} onChange={e => sRYM(e.target.value)} style={{ ...is, textAlign: "center", fontFamily: "var(--font-h)", fontWeight: 600 }} /></div><div style={{ flex: 1 }}><label style={ls}>Day</label><input type="number" min={1} max={31} value={rYD} onChange={e => sRYD(e.target.value)} style={{ ...is, textAlign: "center", fontFamily: "var(--font-h)", fontWeight: 600 }} /></div></div>}
      {rFreq === "yearly" && (() => { const maxD = new Date(new Date().getFullYear(), Number(rYM), 0).getDate(); return Number(rYD) > maxD ? <div style={{ fontSize: 11, color: "#E07A5F", marginTop: -8, marginBottom: 8 }}>{"Day " + rYD + " → clamps to " + maxD + " in " + ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(rYM)] + ". Bill fires on last available day."}</div> : null; })()}
      {rFreq === "custom" && <div style={{ marginBottom: 12 }}><label style={ls}>Every how many days?</label><input type="number" min={1} value={rInt} onChange={e => sRI(e.target.value)} style={{ ...is, textAlign: "center", fontFamily: "var(--font-h)", fontWeight: 600 }} /></div>}
      <label style={ls}>Start Date</label><input type="date" value={rStart} onChange={e => sRS(e.target.value)} style={{ ...is, marginBottom: 18 }} /><button onClick={submitRec} style={{ width: "100%", padding: "14px", border: "none", borderRadius: 12, background: "#A78BFA", color: "#fff", fontSize: 15, fontFamily: "var(--font-h)", fontWeight: 600, cursor: "pointer" }}>Add Recurring</button></>}</div>
}

const TxCard = memo(function TxCard({ item: it, categories: cats, incomeSources: isrc, events: evs, onDelete: od, recurringCats: rCats, wallets: wl = WALLETS, onRefund: oRef }) {
  const isE = it.type === "expense", isI = it.type === "income", isTr = it.type === "transfer", isS = it.type === "settlement", isSpl = it.type === "split";
  const isRec = isE && isFix(it);
  let cat = isE ? cats.find(c => c.id === it.categoryId) : isI ? isrc.find(s => s.id === it.sourceId) : null;
  // Fallback to recurring category list (RC) if not found in user categories
  if (isE && !cat && isRec) {
    const rcMatch = (rCats || RC).find(c => c.id === it.categoryId);
    if (rcMatch) cat = rcMatch;
    else if (it.categoryId === "other_rec") cat = { id: "other_rec", name: "Other", color: "#8A8A9A", neon: "#A0A0B0" };
  }
  if (isE && !cat && it.categoryId) cat = { id: it.categoryId, name: it.categoryId.split("_")[0].replace(/^\w/, l => l.toUpperCase()), color: "#6366F1", neon: "#818CF8" };
  const w = wl.find(x => x.id === it.walletId), fW = wl.find(x => x.id === it.fromWallet), tW = wl.find(x => x.id === it.toWallet);
  const ev = it.eventId ? evs?.find(e => e.id === it.eventId) : null, evT = ev ? `● ${ev.name}` : null;
  const fxMeta = (isE || isI) ? getCurrencyMeta(it.id) : null;
  if (isTr) return <div style={{ ...cc, borderRadius: 14, padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}><div style={{ width: 44, height: 44, borderRadius: 12, background: "#7B8CDE14", display: "flex", alignItems: "center", justifyContent: "center" }}><DI2 id="transfer" accent="#7B8CDE" size={22} /></div><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-h)" }}>Transfer</div><div style={{ fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-b)", marginTop: 2, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{fW?.name} → {tW?.name} · {dl(it.date)}</div></div><div style={{ fontFamily: "var(--font-h)", fontWeight: 600, fontSize: 15, color: "#7B8CDE" }}>{fmt(it.amount)}</div><button onClick={() => od(it.id, it.type)} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 14, opacity: 0.35 }}>✕</button></div>;
  if (isS) { const sW = wl.find(x => x.id === it.walletId); const sCat = it.categoryId ? cats.find(c => c.id === it.categoryId) : null; const accent = it.direction === "owed" ? "#6BAA75" : "#E07A5F"; return <div style={{ ...cc, borderRadius: 14, padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}><div style={{ width: 44, height: 44, borderRadius: 12, background: (sCat?.color || accent) + "14", display: "flex", alignItems: "center", justifyContent: "center" }}>{sCat ? <DI2 id={sCat.id} accent={sCat.neon || sCat.color} size={22} /> : <DI2 id={it.direction === "owed" ? "received" : "paid"} accent={accent} size={22} />}</div><div style={{ flex: 1, minWidth: 0 }}><div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}><span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-h)" }}>{it.direction === "owed" ? `${it.splitName} paid back` : `Paid ${it.splitName}`}</span>{sCat && <span style={{ fontSize: 8, fontFamily: "var(--font-h)", fontWeight: 600, color: sCat.color, background: sCat.color + "15", padding: "1px 5px", borderRadius: 3 }}>{sCat.name.toUpperCase()}</span>}</div><div style={{ fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-b)", marginTop: 2, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{sW?.name} · {dl(it.date)}{it.note ? " · " + it.note : ""}</div></div><div style={{ fontFamily: "var(--font-h)", fontWeight: 600, fontSize: 15, color: accent }}>{it.direction === "owed" ? "+" : "−"}{fmt(it.amount)}</div><button onClick={() => od(it.id, it.type)} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 14, opacity: 0.35 }}>✕</button></div> }
  if (isSpl) { const pal=["#E07A5F","#6BAA75","#7B8CDE","#F4A261","#81B29A","#A78BFA"]; let h=0; for(const c of(it.name||""))h=(h*31+c.charCodeAt(0))&0xffff; const aC=pal[h%pal.length],ini=(it.name||"?").split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase(),owes=it.direction==="owe"; return <div style={{...cc,borderRadius:14,padding:"14px 16px",display:"flex",alignItems:"center",gap:12,marginBottom:10,opacity:it.settled?0.6:1}}><div style={{width:44,height:44,borderRadius:"50%",background:aC,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><span style={{fontFamily:"var(--font-h)",fontSize:14,fontWeight:700,color:"#fff"}}>{ini}</span></div><div style={{flex:1,minWidth:0}}><div style={{fontSize:14,fontWeight:600,color:"var(--text)",fontFamily:"var(--font-h)",display:"flex",alignItems:"center",gap:6}}>{it.name}{it.settled&&<span style={{fontSize:9,fontFamily:"var(--font-h)",fontWeight:600,color:"#6BAA75",background:"#6BAA7515",padding:"1px 5px",borderRadius:3}}>SETTLED</span>}</div><div style={{fontSize:12,color:"var(--muted)",fontFamily:"var(--font-b)",marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{owes?"You owe":"Owes you"}{it.note?" · "+it.note:""} · {dl(it.date)}</div></div><div style={{fontFamily:"var(--font-h)",fontWeight:600,fontSize:15,color:owes?"#E07A5F":"#6BAA75",flexShrink:0}}>{owes?"−":"+"}{fmt(it.amount)}</div><button onClick={()=>od(it.id,it.type)} style={{background:"none",border:"none",color:"var(--muted)",cursor:"pointer",fontSize:14,opacity:0.35,flexShrink:0}}>✕</button></div>; }
  return <div style={{ ...cc, borderRadius: 14, padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}><div style={{ width: 44, height: 44, borderRadius: 12, background: (cat?.color || "#999") + "14", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{cat ? <DI2 id={cat.id} accent={cat.neon || cat.color} size={22} /> : <span style={{ fontSize: 22 }}>❓</span>}</div><div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}><div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}><span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-h)" }}>{cat?.name || "Unknown"}</span>{isE && <span style={{ fontSize: 7, fontFamily: "var(--font-h)", fontWeight: 600, color: isFix(it) ? "#A78BFA" : "#FBBF24", background: isFix(it) ? "#A78BFA15" : "#FBBF2415", padding: "1px 5px", borderRadius: 3 }}>{isFix(it) ? "FIXED" : "FLEX"}</span>}{w && <span style={{ fontSize: 9, fontFamily: "var(--font-h)", fontWeight: 600, color: w.color, background: w.color + "18", padding: "2px 6px", borderRadius: 4, display: "inline-flex", alignItems: "center", gap: 2 }}><DI2 id={w.id} accent={w.neon || w.color} size={10} /></span>}</div><div style={{ fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-b)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{evT && <span style={{ fontWeight: 600, color: "var(--ts)" }}>{evT} · </span>}{dl(it.date)}{it.note ? " · " + it.note : ""}</div>{fxMeta && <div style={{ fontSize: 10, color: "#7B8CDE", fontFamily: "var(--font-h)", fontWeight: 600, marginTop: 3, letterSpacing: "0.3px" }}>{fxMeta.currency} {fxMeta.originalAmount} @ {Number(fxMeta.rateUsed).toFixed(2)}</div>}
    {(isE || isI) && it.receipt_url && (() => { let urls; try { urls = JSON.parse(it.receipt_url); if (!Array.isArray(urls)) urls = [it.receipt_url]; } catch { urls = [it.receipt_url]; } return <div style={{ marginTop: 3, display: "flex", gap: 8, flexWrap: "wrap" }}>{urls.map((u, i) => { const isPdf = typeof u === "string" && (u.startsWith("data:application/pdf") || u.toLowerCase().endsWith(".pdf")); return <a key={i} href={u} target="_blank" rel="noopener noreferrer" style={{ fontSize: 10, color: "#6BAA75", fontFamily: "var(--font-h)", fontWeight: 600, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 3 }}>{isPdf ? <FilePdf size={12} /> : <Receipt size={12} />}{urls.length > 1 ? `${isPdf ? "PDF" : "Receipt"} ${i + 1}` : (isPdf ? "PDF" : "Receipt")}</a>; })}</div>; })()}</div><div style={{ fontFamily: "var(--font-h)", fontWeight: 600, fontSize: 15, color: isE ? "#E07A5F" : "#6BAA75", flexShrink: 0 }}>{isE ? "−" : "+"}{fmt(it.amount)}</div>{isE && oRef && <button onClick={() => oRef(it)} title="Refund this expense as income" style={{ background: "none", border: "none", color: "#6BAA75", cursor: "pointer", fontSize: 14, opacity: 0.5, flexShrink: 0, padding: "0 2px" }}>↩</button>}<button onClick={() => od(it.id, it.type)} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 14, opacity: 0.35, flexShrink: 0 }}>✕</button></div>
});

function CalM({ wallet: w, currentBal: cb, onSave: os, onClose: cl }) {
  const [v, sV] = useState(String(roundMoney(cb)));
  const [note, sNote] = useState("");
  const numV = Number(v) || 0;
  const isUL = isUpiLite(w);
  const overCap = isUL && numV > 5000;
  const isNeg = numV < 0;
  const gap = roundMoney(numV - roundMoney(cb));
  const gapPos = gap > 0;
  return <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={cl}><div onClick={e => e.stopPropagation()} style={{ background: "var(--card)", borderRadius: "20px 20px 0 0", padding: 28, width: "100%", maxWidth: 430 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 16, fontWeight: 700, color: "var(--text)", marginBottom: 6, display: "flex", alignItems: "center", gap: 8 }}><DI2 id={w.id} accent={w.neon || w.color} size={20} /> Reconcile {w.name}</div><p style={{ fontSize: 13, color: "var(--muted)", fontFamily: "var(--font-b)", marginBottom: 16, lineHeight: 1.5 }}>NOMAD balance: <strong>{fmt(roundMoney(cb))}</strong>. Enter your actual balance from your bank or UPI app.{isUL && " UPI Lite max ₹5000 (RBI)."}</p><label style={ls}>Actual Balance ({CUR})</label><input type="number" value={v} onChange={e => sV(e.target.value)} autoFocus style={{ ...is, fontSize: 28, fontWeight: 700, fontFamily: "var(--font-h)", textAlign: "center", padding: "16px", color: (overCap || isNeg) ? "#D4726A" : w.color, borderColor: (overCap || isNeg) ? "#D4726A" : w.color, marginBottom: 8 }} />{overCap && <p style={{ fontSize: 11, color: "#D4726A", marginBottom: 6, fontFamily: "var(--font-h)", fontWeight: 600 }}>Exceeds ₹5000 UPI Lite cap</p>}{isNeg && <p style={{ fontSize: 11, color: "#D4726A", marginBottom: 6, fontFamily: "var(--font-h)", fontWeight: 600 }}>Cannot be negative</p>}{gap !== 0 && !overCap && !isNeg && <div style={{ fontSize: 12, fontFamily: "var(--font-h)", fontWeight: 700, color: gapPos ? "#6BAA75" : "#D4726A", background: gapPos ? "#6BAA7515" : "#D4726A15", borderRadius: 8, padding: "7px 14px", marginBottom: 10, textAlign: "center" }}>Adjustment: {gapPos ? "+" : ""}{fmt(gap)} will be logged</div>}<input value={note} onChange={e => sNote(e.target.value)} placeholder="Reason (optional): bank charge, missed UPI, cash ATM…" style={{ ...is, fontSize: 12, marginBottom: 16, color: "var(--text)" }} /><div style={{ display: "flex", gap: 10 }}><button onClick={cl} style={{ flex: 1, padding: 14, border: "1.5px solid var(--border)", borderRadius: 12, background: "transparent", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 14, cursor: "pointer" }}>Cancel</button><button disabled={overCap || isNeg} onClick={() => { os(numV, note); cl(); }} style={{ flex: 2, padding: 14, border: "none", borderRadius: 12, background: (overCap || isNeg) ? "#ccc" : w.color, color: "#fff", fontFamily: "var(--font-h)", fontSize: 14, cursor: (overCap || isNeg) ? "not-allowed" : "pointer", fontWeight: 700 }}>Set Balance</button></div></div></div>
}
function RecountM({ wallet: w, currentBal: cb, onClose: cl }) {
  const DENOMS = [500, 200, 100, 50, 20, 10, 5, 2, 1];
  const STORE = "nomad-cash-counts";
  const [counts, sCounts] = useState(() => { try { const s = JSON.parse(localStorage.getItem(STORE) || "{}"); return Object.fromEntries(DENOMS.map(d => [d, s[d] || 0])); } catch { return Object.fromEntries(DENOMS.map(d => [d, 0])); } });
  const [savedAt, setSavedAt] = useState(() => { try { return JSON.parse(localStorage.getItem(STORE + "-ts") || "null"); } catch { return null; } });
  const counted = DENOMS.reduce((s, d) => s + d * counts[d], 0);
  const gap = roundMoney(counted - roundMoney(cb));
  const isShort = gap < 0;
  const adj = (d, n) => sCounts(p => { const next = { ...p, [d]: Math.max(0, (p[d] || 0) + n) }; try { localStorage.setItem(STORE, JSON.stringify(next)); } catch {} return next; });
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(counts)); const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); localStorage.setItem(STORE + "-ts", JSON.stringify(ts)); setSavedAt(ts); } catch {} };
  const reset = () => { sCounts(Object.fromEntries(DENOMS.map(d => [d, 0]))); try { localStorage.removeItem(STORE); localStorage.removeItem(STORE + "-ts"); setSavedAt(null); } catch {} };
  return <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={cl}><div onClick={e => e.stopPropagation()} style={{ background: "var(--card)", borderRadius: "20px 20px 0 0", padding: "20px 20px 24px", width: "100%", maxWidth: 430, maxHeight: "88vh", overflowY: "auto" }}><div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 16, fontWeight: 700, color: "var(--text)", display: "flex", alignItems: "center", gap: 6 }}><Hash size={16} weight="bold" />Count Cash</div><button onClick={reset} style={{ background: "none", border: "none", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 11, cursor: "pointer", padding: "2px 6px", opacity: 0.7 }}>Reset</button></div><p style={{ fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-b)", marginBottom: 14, lineHeight: 1.4 }}>App shows <strong>{fmt(roundMoney(cb))}</strong>.{savedAt ? <span> Last saved {savedAt}.</span> : " Tap + for each note."}</p>{DENOMS.map(d => { const cnt = counts[d]; return <div key={d} style={{ display: "flex", alignItems: "center", paddingBottom: 8, marginBottom: 8, borderBottom: "1px solid var(--border)", opacity: cnt === 0 ? 0.4 : 1 }}><span style={{ fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 14, color: "var(--text)", width: 48 }}>₹{d}</span><div style={{ display: "flex", alignItems: "center", marginLeft: "auto" }}><button onClick={() => adj(d, -1)} style={{ width: 34, height: 34, border: "1.5px solid var(--border)", borderRadius: "8px 0 0 8px", background: "var(--bg)", color: "var(--muted)", fontSize: 18, cursor: "pointer", fontWeight: 700, lineHeight: 1 }}>−</button><div style={{ width: 42, height: 34, border: "1.5px solid var(--border)", borderLeft: "none", borderRight: "none", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 15, color: "var(--text)", background: "var(--bg)" }}>{cnt}</div><button onClick={() => adj(d, 1)} style={{ width: 34, height: 34, border: `1.5px solid ${cnt > 0 ? w.color : "var(--border)"}`, borderRadius: "0 8px 8px 0", background: cnt > 0 ? w.color + "18" : "var(--bg)", color: cnt > 0 ? w.color : "var(--muted)", fontSize: 18, cursor: "pointer", fontWeight: 700, lineHeight: 1 }}>+</button></div><span style={{ fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, color: "var(--text)", width: 60, textAlign: "right", visibility: cnt > 0 ? "visible" : "hidden" }}>{fmt(d * cnt)}</span></div>; })}<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0 6px", borderTop: "2px solid var(--border)", marginTop: 4 }}><span style={{ fontFamily: "var(--font-h)", fontWeight: 600, fontSize: 13, color: "var(--muted)" }}>Counted</span><span style={{ fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 20, color: "var(--text)" }}>{fmt(counted)}</span></div>{gap !== 0 && counted > 0 && <div style={{ fontSize: 12, fontFamily: "var(--font-h)", fontWeight: 700, color: isShort ? "#E07A5F" : "#6BAA75", background: isShort ? "#E07A5F15" : "#6BAA7515", borderRadius: 8, padding: "7px 14px", margin: "8px 0 4px", textAlign: "center" }}>{isShort ? `₹${fmt(Math.abs(gap))} short` : `₹${fmt(gap)} extra`}</div>}<div style={{ display: "flex", gap: 10, marginTop: 14 }}><button onClick={cl} style={{ flex: 1, padding: 14, border: "1.5px solid var(--border)", borderRadius: 12, background: "transparent", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 14, cursor: "pointer" }}>Close</button><button onClick={() => { save(); cl(); }} style={{ flex: 2, padding: 14, border: "none", borderRadius: 12, background: w.color, color: "#fff", fontFamily: "var(--font-h)", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Save Count</button></div></div></div>;
}

function RecEditPanel({ r, recCats, onSave, onClose, wallets: wl = WALLETS }) {
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
              {wl.filter(w => !isUpiLite(w)).map(w => (
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
function EvIcon({ id, size = 18 }) { const Icon = PHICONS[id]; if (!Icon) return <PushPin size={size} />; return <Icon size={size} /> }

function Events({ events: evs, expenses: ex, splits: sp, settlements: stl, categories: cats, wallets: wl = WALLETS, staleByEvent = {}, onCreate: oC, onAddExp: oE, onAddSplit: oS, onSettleSplit: oSS, onDeleteSplit: oDS, onMarkDone: oMD, onDelete: oD, dm = false }) {
  const [view, sV] = useState("list"), [selId, sSel] = useState(null), [nn, sNN] = useState(""), [ne, sNE] = useState("film"), [evType, sEvType] = useState("solo"), [evParts, sEvParts] = useState([""]), [evTab, sEvTab] = useState("active");
  const [ea, sEA] = useState(""), [ec, sEC] = useState(cats[0]?.id || ""), [ew, sEW] = useState("bank"), [en, sEN] = useState(""), [ePaidBy, sEPaidBy] = useState("me");
  const [sn, sSN] = useState(""), [sa, sSA] = useState(""), [sd, sSD] = useState("owed"), [stgt, sSTgt] = useState(null), [spNote, sSPNote] = useState("");
  const [bsOpen, sBsO] = useState(false), [bsMode, sBsM] = useState("equal"), [bsTotal, sBsT] = useState(""), [bsPpl, sBsP] = useState([{ name: "", amount: "" }]), [bsCat, sBsC] = useState(cats[0]?.id || ""), [bsW, sBsW] = useState("bank"), [bsNote, sBsN] = useState(""), [bsStep, sBsS] = useState(1);
  const [evDelConfirm, sEvDelConfirm] = useState(null);
  const fmtDate = d => { if (!d) return ""; const dt = new Date(d + "T00:00:00"), M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]; return `${String(dt.getDate()).padStart(2, "0")} ${M[dt.getMonth()]} ${dt.getFullYear()}`; };
  const sel = evs.find(e => e.id === selId);
  const create = () => { if (!nn.trim()) return; const parts = evType === "group" ? evParts.filter(p => p.trim()) : []; oC({ id: uid(), name: nn.trim(), emoji: ne, date: localDateKey(), status: "active", type: evType, participants: parts }); sNN(""); sNE("film"); sEvType("solo"); sEvParts([""]); sV("list") };
  const addExp = () => { const a = parseAmount(ea); if (!Number.isFinite(a) || a <= 0 || !sel) return; const isGrp = sel.type === "group"; const pb = isGrp ? (ePaidBy === "me" || (sel.participants || []).includes(ePaidBy) ? ePaidBy : "me") : undefined; const ok = oE({ amount: a, categoryId: ec, walletId: ew, note: en, date: localDateKey(), eventId: sel.id, ...(pb ? { paidBy: pb } : {}) }); if (ok !== false) { sEA(""); sEN("") } };
  const addSplit = () => { if (!sn.trim() || !sa || Number(sa) <= 0 || !sel) return; oS({ id: uid(), name: sn.trim(), amount: Number(sa), direction: sd, settled: false, eventId: sel.id, note: spNote }); sSN(""); sSA(""); sSPNote("") };
  const netSpent = (evId) => {
    const e = ex.filter(x => x.eventId === evId).reduce((s, x) => s + x.amount, 0);
    const settleOut = stl.filter(x => x.eventId === evId && x.direction === "owe").reduce((s, x) => s + x.amount, 0);
    const settleIn = stl.filter(x => x.eventId === evId && x.direction === "owed").reduce((s, x) => s + x.amount, 0);
    return Math.max(0, e + settleOut - settleIn);
  };
  const remainForSplit = s => roundMoney(s.amount - (stl || []).filter(x => x.splitId === s.id).reduce((t, x) => t + x.amount, 0));

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
    const _gShares = isGroup && allParts.length > 0 ? distributeAmount(grpTotal, allParts.length) : [];
    const grpShareMap = Object.fromEntries(allParts.map((p, i) => [p, _gShares[i] || 0]));
    const tO = eSp.filter(s => s.direction === "owe" && !s.settled).reduce((t, s) => t + s.amount, 0), tI = eSp.filter(s => s.direction === "owed" && !s.settled).reduce((t, s) => t + s.amount, 0);
    return <div style={{ paddingTop: 8 }}><div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}><button onClick={() => sV("list")} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 13, fontFamily: "var(--font-h)" }}>← Events</button><div style={{ display: "flex", gap: 8, alignItems: "center" }}>{sel.status === "active" && <button onClick={() => oMD(sel.id)} style={{ padding: "6px 14px", border: "1.5px solid #6BAA75", borderRadius: 8, background: "#6BAA7518", color: "#6BAA75", fontFamily: "var(--font-h)", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Mark Done ✓</button>}<button onClick={() => sEvDelConfirm(sel.id)} style={{ padding: "6px 12px", border: "1.5px solid #D4726A", borderRadius: 8, background: "#D4726A12", color: "#D4726A", fontFamily: "var(--font-h)", fontSize: 11, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}><Trash size={11} />Delete</button></div></div>
      <div style={{ ...cc, padding: 20, marginBottom: 14, display: "flex", alignItems: "center", gap: 14 }}><div style={{ width: 48, height: 48, borderRadius: 12, background: "#E07A5F12", display: "flex", alignItems: "center", justifyContent: "center", color: "#E07A5F", flexShrink: 0 }}><EvIcon id={sel.emoji} size={24} /></div><div style={{ flex: 1 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 17, fontWeight: 700, color: "var(--text)" }}>{sel.name}</div><div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-b)", marginTop: 2 }}>{sel.date} · {sel.status === "active" ? "🟡 Active" : "✅ Done"}{isGroup && <span style={{ marginLeft: 6, fontSize: 10, fontFamily: "var(--font-h)", fontWeight: 600, color: "#7B8CDE", background: "#7B8CDE18", padding: "1px 6px", borderRadius: 4 }}>GROUP</span>}</div></div><div style={{ textAlign: "right" }}><div style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 600 }}>{isGroup ? "GROUP TOTAL" : "NET SPENT"}</div><div style={{ fontSize: 18, fontWeight: 700, fontFamily: "var(--font-h)", color: "#E07A5F" }}>{fmt(isGroup ? grpTotal : ns)}</div><div style={{ fontSize: 9, color: "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 500, marginTop: 3 }}>{isGroup ? `${allParts.length} people` : `Total Paid: ${fmt(tp)}`}</div></div></div>
      {isGroup && allParts.length > 1 && <div style={{ ...cc, padding: 14, marginBottom: 14 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 11, color: "var(--muted)", fontWeight: 600, marginBottom: 10, letterSpacing: "0.5px" }}>GROUP SUMMARY</div><div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-b)", marginBottom: 10 }}>Equal share: {fmt(grpShare)} / person ({allParts.length} people)</div>{allParts.map(p => { const paid = grpPaid[p] || 0, bal = roundMoney(paid - (grpShareMap[p] ?? grpShare)); const settled = Math.abs(bal) < 0.01, label = settled ? "settled" : bal > 0 ? `get back ${fmt(bal)}` : `owes ${fmt(Math.abs(bal))}`; const color = settled ? "var(--muted)" : bal > 0 ? "#6BAA75" : "#E07A5F"; return <div key={p} style={{ display: "flex", alignItems: "center", padding: "7px 0", borderBottom: "1px solid var(--border)" }}><span style={{ fontSize: 13, fontFamily: "var(--font-h)", color: "var(--text)", flex: 1 }}>{p}</span><span style={{ fontSize: 12, fontFamily: "var(--font-h)", color: "var(--ts)", marginRight: 12 }}>{fmt(paid)}</span><span style={{ fontSize: 11, fontFamily: "var(--font-h)", color, fontWeight: 600 }}>→ {label}</span></div>; })}{(() => { const bals = allParts.map(p => ({ name: p, bal: roundMoney((grpPaid[p] || 0) - (grpShareMap[p] ?? grpShare)) })); const cr = bals.filter(b => b.bal > 0.01).map(b => ({ ...b })).sort((a, b) => b.bal - a.bal); const db = bals.filter(b => b.bal < -0.01).map(b => ({ ...b })).sort((a, b) => a.bal - b.bal); const settlements = []; let ci = 0, di = 0; while (ci < cr.length && di < db.length) { const amt = roundMoney(Math.min(cr[ci].bal, -db[di].bal)); settlements.push({ from: db[di].name, to: cr[ci].name, amt }); cr[ci].bal = roundMoney(cr[ci].bal - amt); db[di].bal = roundMoney(db[di].bal + amt); if (cr[ci].bal < 0.01) ci++; if (db[di].bal > -0.01) di++; } return settlements.length > 0 && <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)" }}><div style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 600, marginBottom: 6, letterSpacing: "0.5px" }}>SUGGESTED SETTLEMENTS</div>{settlements.map((s, i) => <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontFamily: "var(--font-h)", fontWeight: 600, marginBottom: 4, color: s.from === "You" ? "#E07A5F" : s.to === "You" ? "#6BAA75" : "var(--ts)" }}><span>{s.from}</span><span style={{ opacity: 0.5 }}>→</span><span>{s.to}</span><span style={{ marginLeft: "auto" }}>{fmt(s.amt)}</span></div>)}</div>; })()}</div>}
      {eSp.length > 0 && <div style={{ display: "flex", gap: 8, marginBottom: 14 }}><div style={{ flex: 1, background: "#E07A5F12", borderRadius: 10, padding: "10px 12px", textAlign: "center" }}><div style={{ fontSize: 9, color: "#E07A5F", fontFamily: "var(--font-h)", fontWeight: 600 }}>YOU OWE</div><div style={{ fontSize: 16, fontWeight: 700, fontFamily: "var(--font-h)", color: "#E07A5F" }}>{fmt(tO)}</div></div><div style={{ flex: 1, background: "#6BAA7512", borderRadius: 10, padding: "10px 12px", textAlign: "center" }}><div style={{ fontSize: 9, color: "#6BAA75", fontFamily: "var(--font-h)", fontWeight: 600 }}>OWED TO YOU</div><div style={{ fontSize: 16, fontWeight: 700, fontFamily: "var(--font-h)", color: "#6BAA75" }}>{fmt(tI)}</div></div></div>}
      {eExps.length > 0 && <div style={{ ...cc, padding: 14, marginBottom: 14 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 11, color: "var(--muted)", fontWeight: 600, marginBottom: 10, letterSpacing: "0.5px" }}>EXPENSES</div>{[...eExps].reverse().map(e => { const cat = cats.find(c => c.id === e.categoryId) || { id: "other", name: "Other", color: "#999", neon: "#999" }; return <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--border)" }}><DI2 id={cat.id} accent={cat.neon || cat.color} size={18} /><div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 600, fontFamily: "var(--font-h)", color: "var(--text)" }}>{cat.name}</div>{e.note && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 1 }}>{e.note}</div>}{isGroup && e.paidBy && e.paidBy !== "me" && <div style={{ fontSize: 10, color: "#7B8CDE", marginTop: 1, fontFamily: "var(--font-h)", fontWeight: 600 }}>paid by {e.paidBy}</div>}</div><span style={{ fontFamily: "var(--font-h)", fontWeight: 600, color: "#E07A5F", fontSize: 14 }}>−{fmt(e.amount)}</span></div> })}</div>}
      {eSp.length > 0 && <div style={{ ...cc, padding: 14, marginBottom: 14 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 11, color: "var(--muted)", fontWeight: 600, marginBottom: 10, letterSpacing: "0.5px" }}>SPLITS</div>{eSp.map(s => <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--border)", opacity: s.settled ? 0.4 : 1 }}><span style={{ fontSize: 14 }}>{s.settled ? "✅" : s.direction === "owe" ? "🔴" : "🟢"}</span><div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 600, fontFamily: "var(--font-h)", color: "var(--text)" }}>{s.name}</div><div style={{ fontSize: 11, color: "var(--muted)" }}>{s.settled ? "Settled" : s.direction === "owe" ? "You owe" : "Owes you"}</div>{s.note && <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 1, fontStyle: "italic" }}>{s.note}</div>}</div><span style={{ fontFamily: "var(--font-h)", fontWeight: 600, fontSize: 14, color: s.direction === "owe" ? "#E07A5F" : "#6BAA75" }}>{fmt(s.amount)}</span>{!s.settled && <button onClick={() => sSTgt(s)} style={{ border: "1px solid var(--border)", background: "none", borderRadius: 6, padding: "3px 8px", fontSize: 10, color: "var(--muted)", cursor: "pointer" }}>Settle</button>}<button onClick={() => oDS(s.id)} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 13, opacity: 0.4 }}>✕</button></div>)}</div>}
      {sel.status === "active" && <div style={{ ...cc, padding: 16, marginBottom: 14 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 11, color: "var(--muted)", fontWeight: 600, marginBottom: 12, letterSpacing: "0.5px" }}>ADD EXPENSE</div><div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>{cats.map(c => <button key={c.id} onClick={() => sEC(c.id)} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 12, fontFamily: "var(--font-b)", border: `1.5px solid ${ec === c.id ? c.color : "var(--border)"}`, background: ec === c.id ? c.color + "18" : "var(--card)", color: ec === c.id ? c.color : "var(--ts)", cursor: "pointer", fontWeight: ec === c.id ? 600 : 400, display: "flex", alignItems: "center", gap: 4 }}><DI2 id={c.id} accent={c.neon || c.color} size={14} />{c.name}</button>)}</div>{isGroup && <div style={{ marginBottom: 12 }}><label style={ls}>Paid by</label><div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{["me", ...(sel.participants || [])].map(p => { const label = p === "me" ? "You" : p; return <button key={p} onClick={() => sEPaidBy(p)} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontFamily: "var(--font-h)", border: `1.5px solid ${ePaidBy === p ? "#7B8CDE" : "var(--border)"}`, background: ePaidBy === p ? "#7B8CDE18" : "var(--card)", color: ePaidBy === p ? "#7B8CDE" : "var(--ts)", cursor: "pointer", fontWeight: ePaidBy === p ? 600 : 400 }}>{label}</button>; })}</div></div>}{(!isGroup || ePaidBy === "me") && <><label style={ls}>Paid From</label><div style={{ display: "flex", gap: 6, marginBottom: 12 }}>{wl.map(w => <button key={w.id} onClick={() => sEW(w.id)} style={{ flex: 1, padding: "8px", borderRadius: 8, border: `1.5px solid ${ew === w.id ? w.color : "var(--border)"}`, background: ew === w.id ? w.color + "15" : "var(--card)", fontSize: 12, fontWeight: ew === w.id ? 600 : 500, fontFamily: "var(--font-h)", color: ew === w.id ? w.color : "var(--muted)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}><DI2 id={w.id} accent={w.neon || w.color} size={12} />{w.name}</button>)}</div></>}<div style={{ display: "flex", gap: 8 }}><input type="number" value={ea} onChange={e => sEA(e.target.value)} placeholder="₹" style={{ ...is, width: 80 }} /><input value={en} onChange={e => sEN(e.target.value)} placeholder="Note" style={{ ...is, flex: 1 }} /><button onClick={addExp} style={{ padding: "10px 14px", border: "none", borderRadius: 10, background: "#E07A5F", color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>+</button></div></div>}
      {sel.status === "active" && (() => {
        const totalNum = (() => { const n = parseAmount(bsTotal); return Number.isFinite(n) && n > 0 ? n : 0; })(), validPpl = bsPpl.filter(p => p.name.trim()), hc = validPpl.length + 1;
        const equalShares = distributeAmount(totalNum, hc), eqMy = equalShares[0] || 0, eqOthers = validPpl.map((_, i) => equalShares[i + 1] || 0);
        const custOT = bsPpl.reduce((s, p) => s + ((Number.isFinite(parseAmount(p.amount)) ? parseAmount(p.amount) : 0)), 0), custMy = Math.max(0, totalNum - custOT);
        const myShare = bsMode === "equal" ? eqMy : custMy;
        const canSub = totalNum > 0 && validPpl.length > 0 && (bsMode === "equal" || (custOT > 0 && custOT <= totalNum));
        const bsReset = () => { sBsT(""); sBsP([{ name: "", amount: "" }]); sBsN(""); sBsS(1); sBsO(false) };
        const bsSubmit = () => { if (!canSub || !sel) return; const gid = uid(); if (totalNum > 0) { const ok = oE({ amount: totalNum, categoryId: bsCat, walletId: bsW, note: bsNote || `Bill split — paid by you (your share ${fmt(myShare)})`, date: localDateKey(), eventId: sel.id, groupId: gid }); if (ok === false) return } validPpl.forEach((p, idx) => { const amt = bsMode === "equal" ? eqOthers[idx] : roundMoney((Number.isFinite(parseAmount(p.amount)) ? parseAmount(p.amount) : 0)); if (amt > 0) oS({ id: uid(), name: p.name.trim(), amount: amt, direction: "owed", settled: false, eventId: sel.id, groupId: gid }) }); sBsS(3); setTimeout(bsReset, 2000) };
        if (!bsOpen) return <button onClick={() => sBsO(true)} style={{ width: "100%", padding: 14, border: "1.5px solid #7B8CDE", borderRadius: 14, background: "#7B8CDE12", color: "#7B8CDE", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 600, cursor: "pointer", marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}><Receipt size={14} />Bill Splitter</button>;
        if (bsStep === 3) return <div style={{ ...cc, padding: 24, marginBottom: 14, textAlign: "center" }}><div style={{ fontSize: 32, marginBottom: 8 }}>✅</div><div style={{ fontFamily: "var(--font-h)", fontSize: 14, color: "#6BAA75", fontWeight: 600 }}>Split recorded!</div><div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>Full bill paid. Your final share is {fmt(myShare)}.</div></div>;
        if (bsStep === 2) { const cat = cats.find(c => c.id === bsCat) || cats[0]; return <div style={{ ...cc, padding: 16, marginBottom: 14 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 11, color: "var(--muted)", fontWeight: 600, marginBottom: 14, letterSpacing: "0.5px", display: "flex", alignItems: "center", gap: 4 }}><Receipt size={11} />CONFIRM SPLIT</div><div style={{ background: "#E07A5F12", borderRadius: 10, padding: "12px 14px", marginBottom: 10, border: "1px solid #E07A5F30" }}><div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 600, marginBottom: 6 }}>PAID NOW</div><div style={{ display: "flex", alignItems: "center", gap: 10 }}><DI2 id={cat?.id} accent={cat?.neon || cat?.color} size={20} /><div style={{ flex: 1 }}><div style={{ fontSize: 13, fontFamily: "var(--font-h)", fontWeight: 600, color: "var(--text)" }}>Full bill from {wl.find(w => w.id === bsW)?.name || "wallet"}</div></div><div style={{ fontSize: 18, fontWeight: 700, fontFamily: "var(--font-h)", color: "#E07A5F" }}>−{fmt(totalNum)}</div></div></div><div style={{ background: "#6BAA7512", borderRadius: 10, padding: "10px 14px", marginBottom: 14, border: "1px solid #6BAA7530" }}><div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontFamily: "var(--font-h)", color: "var(--ts)" }}><span>Your final share</span><span style={{ fontWeight: 700, color: "#E07A5F" }}>{fmt(myShare)}</span></div></div><div style={{ marginBottom: 14 }}><div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 600, marginBottom: 8 }}>THEY OWE YOU</div>{validPpl.map((p, i) => { const amt = bsMode === "equal" ? eqOthers[i] : roundMoney((Number.isFinite(parseAmount(p.amount)) ? parseAmount(p.amount) : 0)); return <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid var(--border)" }}><span style={{ fontSize: 13, fontFamily: "var(--font-h)", color: "var(--text)" }}>{p.name}</span><span style={{ fontSize: 13, fontFamily: "var(--font-h)", fontWeight: 600, color: "#6BAA75" }}>{fmt(amt)}</span></div> })}</div><div style={{ display: "flex", gap: 8 }}><button onClick={() => sBsS(1)} style={{ flex: 1, padding: 12, border: "1.5px solid var(--border)", borderRadius: 10, background: "transparent", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 13, cursor: "pointer" }}>← Edit</button><button onClick={bsSubmit} style={{ flex: 2, padding: 12, border: "none", borderRadius: 10, background: "#6BAA75", color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Confirm ✓</button></div></div> }
        return <div style={{ ...cc, padding: 16, marginBottom: 14 }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 11, color: "var(--muted)", fontWeight: 600, letterSpacing: "0.5px", display: "flex", alignItems: "center", gap: 4 }}><Receipt size={11} />BILL SPLITTER</div><button onClick={bsReset} style={{ background: "none", border: "none", fontSize: 12, color: "var(--muted)", cursor: "pointer" }}>✕</button></div>
          <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>{[{ id: "equal", label: "Equal Split" }, { id: "custom", label: "Custom Split" }].map(m => <button key={m.id} onClick={() => sBsM(m.id)} style={{ flex: 1, padding: "9px", borderRadius: 8, fontSize: 12, fontFamily: "var(--font-h)", border: `1.5px solid ${bsMode === m.id ? "#7B8CDE" : "var(--border)"}`, background: bsMode === m.id ? "#7B8CDE18" : "var(--card)", color: bsMode === m.id ? "#7B8CDE" : "var(--muted)", cursor: "pointer", fontWeight: 600 }}>{m.label}</button>)}</div>
          <label style={ls}>Note (optional)</label><input value={bsNote} onChange={e => sBsN(e.target.value)} placeholder="What was this bill for?" style={{ ...is, marginBottom: 14 }} /><label style={ls}>Total Bill (₹)</label><input type="number" value={bsTotal} onChange={e => sBsT(e.target.value)} placeholder="0" style={{ ...is, marginBottom: 14, fontSize: 20, fontWeight: 700, fontFamily: "var(--font-h)", textAlign: "center" }} />
          <label style={ls}>People (excluding you)</label>{bsPpl.map((p, i) => <div key={i} style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center" }}><input value={p.name} onChange={e => sBsP(pp => pp.map((x, idx) => idx === i ? { ...x, name: e.target.value } : x))} placeholder="Name" style={{ ...is, flex: 1 }} />{bsMode === "custom" && <input type="number" value={p.amount} onChange={e => sBsP(pp => pp.map((x, idx) => idx === i ? { ...x, amount: e.target.value } : x))} placeholder="₹" style={{ ...is, width: 78 }} />}{bsMode === "custom" && p.name.trim() && !(Number.isFinite(parseAmount(p.amount)) && parseAmount(p.amount) > 0) && <span style={{ fontSize: 10, color: "#E07A5F", flexShrink: 0, fontFamily: "var(--font-h)", fontWeight: 600 }}>₹0!</span>}{bsPpl.length > 1 && <button onClick={() => sBsP(pp => pp.filter((_, idx) => idx !== i))} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 16, opacity: 0.4 }}>✕</button>}</div>)}
          <button onClick={() => sBsP(p => [...p, { name: "", amount: "" }])} style={{ background: "none", border: "1px dashed var(--border)", borderRadius: 8, padding: "7px 14px", fontSize: 12, color: "var(--muted)", cursor: "pointer", fontFamily: "var(--font-h)", marginBottom: 14, width: "100%" }}>+ Add person</button>
          {totalNum > 0 && validPpl.length > 0 && <div style={{ background: "var(--bg)", borderRadius: 10, padding: "10px 14px", marginBottom: 14, border: "1px solid var(--border)" }}>{bsMode === "equal" ? <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontFamily: "var(--font-h)", color: "var(--ts)" }}><span>Per person ({hc})</span><span style={{ fontWeight: 600 }}>{fmt(equalShares[0] || 0)}</span></div> : <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontFamily: "var(--font-h)", color: custOT > totalNum ? "#D4726A" : "var(--ts)" }}><span>Others total</span><span style={{ fontWeight: 600 }}>{fmt(custOT)} / {fmt(totalNum)}{custOT > totalNum ? " (over!)" : ""}</span></div>}<div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontFamily: "var(--font-h)", color: "#E07A5F", fontWeight: 700, marginTop: 6 }}><span>Your share</span><span>{fmt(myShare)}</span></div></div>}
          <label style={ls}>Category</label><div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>{cats.map(c => <button key={c.id} onClick={() => sBsC(c.id)} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 12, fontFamily: "var(--font-b)", border: `1.5px solid ${bsCat === c.id ? c.color : "var(--border)"}`, background: bsCat === c.id ? c.color + "18" : "var(--card)", color: bsCat === c.id ? c.color : "var(--ts)", cursor: "pointer", fontWeight: bsCat === c.id ? 600 : 400 }}><DI2 id={c.id} accent={c.neon || c.color} size={14} /> {c.name}</button>)}</div>
          <label style={ls}>Paid From</label><div style={{ display: "flex", gap: 6, marginBottom: 14 }}>{wl.map(w => <button key={w.id} onClick={() => sBsW(w.id)} style={{ flex: 1, padding: "8px", borderRadius: 8, border: `1.5px solid ${bsW === w.id ? w.color : "var(--border)"}`, background: bsW === w.id ? w.color + "15" : "var(--card)", fontSize: 12, fontWeight: bsW === w.id ? 600 : 500, fontFamily: "var(--font-h)", color: bsW === w.id ? w.color : "var(--muted)", cursor: "pointer" }}><DI2 id={w.id} accent={w.neon || w.color} size={12} /> {w.name}</button>)}</div>
          <button onClick={() => { if (canSub) sBsS(2) }} disabled={!canSub} style={{ width: "100%", padding: 13, border: "none", borderRadius: 10, background: canSub ? "#6BAA75" : "var(--border)", color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 700, cursor: canSub ? "pointer" : "default", opacity: canSub ? 1 : 0.5 }}>Review Split →</button></div>
      })()}
      {sel.status === "active" && <div style={{ ...cc, padding: 16, marginBottom: 14 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 11, color: "var(--muted)", fontWeight: 600, marginBottom: 12, letterSpacing: "0.5px" }}>ADD SPLIT</div><div style={{ display: "flex", gap: 6, marginBottom: 10 }}>{["owed", "owe"].map(d => <button key={d} onClick={() => sSD(d)} style={{ flex: 1, padding: "8px", borderRadius: 8, fontSize: 12, fontFamily: "var(--font-h)", border: `1.5px solid ${sd === d ? (d === "owe" ? "#E07A5F" : "#6BAA75") : "var(--border)"}`, background: sd === d ? (d === "owe" ? "#E07A5F18" : "#6BAA7518") : "var(--card)", color: sd === d ? (d === "owe" ? "#E07A5F" : "#6BAA75") : "var(--muted)", cursor: "pointer", fontWeight: 500 }}>{d === "owe" ? "I owe them" : "They owe me"}</button>)}</div><div style={{ display: "flex", gap: 8 }}><input value={sn} onChange={e => sSN(e.target.value)} placeholder="Friend name" style={{ ...is, flex: 1 }} /><input type="number" value={sa} onChange={e => sSA(e.target.value)} placeholder="₹" style={{ ...is, width: 80 }} /><input value={spNote} onChange={e => sSPNote(e.target.value)} placeholder="Note" style={{ ...is, flex: 1 }} /><button onClick={addSplit} style={{ padding: "10px 14px", border: "none", borderRadius: 10, background: "#6BAA75", color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>+</button></div></div>}
      {stgt && <SettleM split={stgt} remaining={remainForSplit(stgt)} wallets={wl} onConfirm={(wid, amount) => { oSS(stgt.id, wid, amount); sSTgt(null) }} onClose={() => sSTgt(null)} />}{confirmOverlay}</div>
  }

  const active = [...evs.filter(e => e.status === "active")].sort((a, b) => (b.date || "").localeCompare(a.date || "")), done = [...evs.filter(e => e.status === "completed")].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const totalNs = evs.reduce((s, ev) => s + netSpent(ev.id), 0), unsettledCnt = evs.filter(ev => sp.some(s => s.eventId === ev.id && !s.settled)).length;
  const tabEvs = evTab === "active" ? active : evTab === "past" ? done : [...active, ...done];
  const MONTH_N = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const grouped = Object.entries(tabEvs.reduce((acc, ev) => { const d = ev.date ? new Date(ev.date + "T12:00:00") : null; const k = d ? `${MONTH_N[d.getMonth()]} ${d.getFullYear()}` : "Unknown"; if (!acc[k]) acc[k] = []; acc[k].push(ev); return acc; }, {}));
  const pC = dm ? "#1a1208" : "#F7F3EC", inkC = dm ? "#f0e6d3" : "#2C2416", mutC = dm ? "#8a7560" : "#9C8F7A", cardC = dm ? "#251a0e" : "#ffffff", stoneC = dm ? "#362510" : "#EDE8DF", stripC = dm ? "#0f0a05" : "#2C2416", terraC = "#C4603A";
  return <div style={{ position: "relative", background: pC, height: "calc(100vh - 90px)", display: "flex", flexDirection: "column", overflow: "hidden" }}><div style={{ position: "absolute", inset: 0, zIndex: 0, overflow: "hidden", pointerEvents: "none" }}><svg viewBox="0 0 375 812" preserveAspectRatio="xMidYMid slice" style={{ width: "100%", height: "100%", opacity: 0.13 }} xmlns="http://www.w3.org/2000/svg"><ellipse cx="180" cy="300" rx="280" ry="180" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="180" cy="300" rx="240" ry="145" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="180" cy="300" rx="200" ry="112" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="180" cy="300" rx="160" ry="82" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="180" cy="300" rx="120" ry="55" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="180" cy="300" rx="80" ry="32" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="180" cy="300" rx="42" ry="14" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="300" cy="560" rx="220" ry="160" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="300" cy="560" rx="185" ry="128" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="300" cy="560" rx="148" ry="98" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="300" cy="560" rx="112" ry="70" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="300" cy="560" rx="76" ry="46" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="300" cy="560" rx="42" ry="24" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="340" cy="140" rx="130" ry="90" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="340" cy="140" rx="100" ry="66" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="340" cy="140" rx="70" ry="44" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="340" cy="140" rx="42" ry="26" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="340" cy="140" rx="20" ry="12" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="40" cy="700" rx="180" ry="130" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="40" cy="700" rx="140" ry="98" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="40" cy="700" rx="100" ry="68" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="40" cy="700" rx="62" ry="40" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="40" cy="700" rx="30" ry="18" fill="none" stroke="#7A6A50" strokeWidth="1"/><path d="M 60 300 Q 120 260 180 300 Q 240 340 310 310" fill="none" stroke="#7A6A50" strokeWidth="1"/><path d="M 40 380 Q 130 340 200 370 Q 280 405 350 370" fill="none" stroke="#7A6A50" strokeWidth="1"/><path d="M 20 460 Q 110 420 190 445 Q 270 470 360 440" fill="none" stroke="#7A6A50" strokeWidth="1"/><path d="M 100 180 Q 160 155 220 175 Q 290 200 350 185" fill="none" stroke="#7A6A50" strokeWidth="1"/></svg></div><div style={{ position: "relative", zIndex: 10, padding: "max(20px, calc(env(safe-area-inset-top, 0px) + 14px)) 24px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}><div><div style={{ fontFamily: "'Playfair Display', Georgia, serif", fontSize: 26, color: inkC, letterSpacing: "-0.3px", fontWeight: 400 }}>Events</div><div style={{ fontSize: 11, color: mutC, letterSpacing: "1.2px", textTransform: "uppercase", marginTop: 2 }}>Track shared spending</div></div><div style={{ width: 38, height: 38, borderRadius: 12, background: stoneC, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid rgba(184,150,62,0.2)" }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" stroke={mutC} strokeWidth="1.5"/><path d="M12 8V12L14 14" stroke={mutC} strokeWidth="1.5" strokeLinecap="round"/><path d="M2 12H4M20 12H22M12 2V4M12 20V22" stroke={mutC} strokeWidth="1.5" strokeLinecap="round"/></svg></div></div><div style={{ position: "relative", zIndex: 10, margin: "0 20px 20px", background: stripC, borderRadius: 14, padding: "14px 18px", display: "flex", justifyContent: "space-between", alignItems: "center" }}><div style={{ textAlign: "center" }}><div style={{ fontSize: 15, fontWeight: 500, color: "#C9A84C", fontFamily: "'Playfair Display', Georgia, serif" }}>{evs.length}</div><div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", letterSpacing: "0.8px", textTransform: "uppercase", marginTop: 2 }}>Events</div></div><div style={{ width: 1, height: 28, background: "rgba(255,255,255,0.1)" }} /><div style={{ textAlign: "center" }}><div style={{ fontSize: 15, fontWeight: 500, color: "#C9A84C", fontFamily: "'Playfair Display', Georgia, serif" }}>{fmt(totalNs)}</div><div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", letterSpacing: "0.8px", textTransform: "uppercase", marginTop: 2 }}>Total</div></div><div style={{ width: 1, height: 28, background: "rgba(255,255,255,0.1)" }} /><div style={{ textAlign: "center" }}><div style={{ fontSize: 15, fontWeight: 500, color: "#C9A84C", fontFamily: "'Playfair Display', Georgia, serif" }}>{unsettledCnt}</div><div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", letterSpacing: "0.8px", textTransform: "uppercase", marginTop: 2 }}>Unsettled</div></div></div><div style={{ position: "relative", zIndex: 10, display: "flex", margin: "0 20px 20px", background: stoneC, borderRadius: 10, padding: 3 }}>{[["active","Active"],["past","Past"],["all","All"]].map(([t,l]) => <div key={t} onClick={() => sEvTab(t)} style={{ flex: 1, textAlign: "center", padding: 8, fontSize: 12, fontWeight: 500, color: evTab === t ? inkC : mutC, borderRadius: 8, cursor: "pointer", background: evTab === t ? pC : "transparent", boxShadow: evTab === t ? "0 1px 4px rgba(0,0,0,0.1)" : "none", letterSpacing: "0.5px", transition: "all 0.2s" }}>{l}</div>)}</div><div style={{ position: "relative", zIndex: 10, flex: 1, overflowY: "auto" }}>{tabEvs.length === 0 ? <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 40px 20px", gap: 12, opacity: 0, animation: "evFadeIn 0.6s 0.3s ease both" }}><svg style={{ opacity: 0.15, marginBottom: 8 }} width="80" height="80" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="40" cy="40" r="36" stroke="#2C2416" strokeWidth="1.5"/><circle cx="40" cy="40" r="28" stroke="#2C2416" strokeWidth="1"/><circle cx="40" cy="40" r="3" fill="#2C2416"/><path d="M40 20L44 38L40 36L36 38Z" fill="#C4603A"/><path d="M40 60L36 42L40 44L44 42Z" fill="#2C2416" opacity="0.4"/><path d="M20 40L38 36L36 40L38 44Z" fill="#2C2416" opacity="0.4"/><path d="M60 40L42 44L44 40L42 36Z" fill="#2C2416" opacity="0.4"/><text x="40" y="14" textAnchor="middle" fontFamily="sans-serif" fontSize="7" fill="#2C2416" opacity="0.6">N</text><text x="40" y="70" textAnchor="middle" fontFamily="sans-serif" fontSize="7" fill="#2C2416" opacity="0.6">S</text><text x="14" y="43" textAnchor="middle" fontFamily="sans-serif" fontSize="7" fill="#2C2416" opacity="0.6">W</text><text x="67" y="43" textAnchor="middle" fontFamily="sans-serif" fontSize="7" fill="#2C2416" opacity="0.6">E</text></svg><div style={{ fontFamily: "'Playfair Display', Georgia, serif", fontSize: 16, color: inkC, opacity: 0.6, textAlign: "center" }}>No {evTab === "all" ? "" : evTab + " "}events</div><div style={{ fontSize: 12, color: mutC, textAlign: "center", lineHeight: 1.6 }}>Add an event to start tracking shared costs with friends or family</div></div> : grouped.map(([month, mEvs]) => <div key={month}><div style={{ padding: "0 24px 12px", fontSize: 10, letterSpacing: "1.8px", textTransform: "uppercase", color: mutC, display: "flex", alignItems: "center", gap: 10 }}>{month}<div style={{ flex: 1, height: 1, background: "linear-gradient(to right, rgba(156,143,122,0.3), transparent)" }} /></div>{mEvs.map((ev, ei) => { const ns = netSpent(ev.id), isDone = ev.status === "completed", ps = sp.filter(s => s.eventId === ev.id && !s.settled).length, stalePs = (staleByEvent[ev.id] || []).length; return <div key={ev.id} onClick={() => { sSel(ev.id); sEPaidBy("me"); sV("detail") }} style={{ margin: "0 20px 12px", background: cardC, borderRadius: 16, padding: "16px 18px", display: "flex", alignItems: "center", gap: 14, boxShadow: "0 2px 12px rgba(44,36,22,0.07), 0 1px 3px rgba(44,36,22,0.05)", border: stalePs > 0 ? "1.5px solid #D4726A" : "1px solid rgba(224,217,206,0.8)", cursor: "pointer", animation: "evSlideUp 0.4s ease both", animationDelay: `${ei * 0.06}s` }}><div style={{ width: 42, height: 42, borderRadius: 12, background: "linear-gradient(135deg, #F5EFE4, #EDE5D4)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "1px solid rgba(184,150,62,0.15)" }}><EvIcon id={ev.emoji} size={20} /></div><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 15, fontWeight: 500, color: inkC, letterSpacing: "-0.1px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ev.name}</div><div style={{ fontSize: 12, color: mutC, marginTop: 2 }}>{fmtDate(ev.date)}{!isDone && ps > 0 ? ` · ⚠ ${ps} pending` : ""}{stalePs > 0 && <span style={{ color: "#D4726A", fontWeight: 600 }}> · {stalePs} stale 2+ days</span>}</div></div><div style={{ textAlign: "right", flexShrink: 0 }}><div style={{ fontFamily: "'Playfair Display', Georgia, serif", fontSize: 17, color: inkC, fontWeight: 500 }}>{fmt(ns)}</div><div style={{ display: "inline-flex", alignItems: "center", gap: 4, marginTop: 4, background: isDone ? "rgba(90,122,90,0.1)" : "rgba(184,150,62,0.1)", color: isDone ? "#5A7A5A" : "#B8963E", fontSize: 10, fontWeight: 500, letterSpacing: "0.5px", padding: "3px 8px", borderRadius: 20, border: `1px solid ${isDone ? "rgba(90,122,90,0.2)" : "rgba(184,150,62,0.2)"}` }}>{isDone ? "✓ done" : "active"}</div></div><button onClick={e => { e.stopPropagation(); sEvDelConfirm(ev.id); }} style={{ background: "none", border: "none", color: mutC, cursor: "pointer", fontSize: 14, padding: "2px 4px", opacity: 0.4, flexShrink: 0 }}>✕</button></div>; })}</div>)}</div><button onClick={() => sV("create")} style={{ position: "relative", zIndex: 10, margin: "16px 20px 20px", background: terraC, borderRadius: 14, padding: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, color: "white", fontSize: 14, fontWeight: 500, cursor: "pointer", border: "none", boxShadow: "0 4px 16px rgba(196,96,58,0.3)", letterSpacing: "0.3px", width: "calc(100% - 40px)" }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 5V19M5 12H19" stroke="white" strokeWidth="2" strokeLinecap="round"/></svg>New Event</button>{confirmOverlay}</div>;
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
  const [tab, sTab] = useState("dashboard"), [ex, sEx] = useState([]), [inc, sInc] = useState([]), [tr, sTr] = useState([]), [stl, sStl] = useState([]), [cats, sCats] = useState(DC), [isrc, sIsrc] = useState(DI), [sp, sSp] = useState([]), [evs, sEvs] = useState([]), [rec, sRec] = useState([]), [fm, sFm] = useState("all"), [loaded, sL] = useState(false), [ld, sLd] = useState(false), [dm, sDm] = useState(false), [toasts, sToasts] = useState([]), [nn, sNN] = useState(""), [ne2, sNE2] = useState("📁"), [nc, sNC] = useState("#E07A5F"), [mt, sMt] = useState("expense"), [clr, sClr] = useState(false), [nukeTxt, sNukeTxt] = useState(""), [spX, sSpX] = useState(false), [calW, sCalW] = useState(null), [recountW, sRecountW] = useState(null), [wsb, sWsb] = useState({});
  const [pendingSync, sPendingSync] = useState(getPendingSyncCount());
  const [deadLetterCount, sDeadLetterCount] = useState(getDeadLetterCount());
  const [calLog, sCalLog] = useState(() => { try { return JSON.parse(localStorage.getItem("nomad-cal-log") || "[]"); } catch { return []; } });
  const [dlBanner, sDlBanner] = useState(() => getDeadLetterCount() > 0);
  const [localBanner, sLocalBanner] = useState(localMode);
  const [online, sOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  const [staleData, sStaleData] = useState(false);
  const [swUpdate, sSwUpdate] = useState(false);
  const [manageXp, sManageXp] = useState(false);
  const [recDelConfirm, sRecDelConfirm] = useState(null);
  const [recEditId, sRecEditId] = useState(null);
  const [recDelItems, sRecDelItems] = useState(null);
  const [recDelLoading, sRecDelLoading] = useState(false);
  const [csvPreview, sCsvPreview] = useState(null);
  const [budgets, sBudgets] = useState({});
  const [budgetSettingsOpen, sBudgetSettingsOpen] = useState(false);
  const [hSearch, sHSearch] = useState(""), [hMinAmt, sHMinAmt] = useState(""), [hMaxAmt, sHMaxAmt] = useState(""), [hDateFrom, sHDateFrom] = useState(""), [hDateTo, sHDateTo] = useState(""), [hType, sHType] = useState("all"), [hShowFilters, sHShowFilters] = useState(false), [hTimeline, sHTimeline] = useState(false);
  const [drillCat, sDrillCat] = useState(null);
  const [bulkMode, sBulkMode] = useState(false);
  const [bulkSel, sBulkSel] = useState(new Set());
  const [autoRules, sAutoRules] = useState(() => { try { return JSON.parse(localStorage.getItem("nomad-auto-rules") || "[]"); } catch { return []; } });
  const [autoRulesOpen, sAutoRulesOpen] = useState(false);
  const [subSugOpen, sSubSugOpen] = useState(false);
  const [newRuleKw, sNewRuleKw] = useState(""), [newRuleCat, sNewRuleCat] = useState("");
  const [editingCat, sEditingCat] = useState(null); // {id, name} for inline rename
  const [wallets, sWallets] = useState(() => { try { const s = localStorage.getItem("nomad-wallets-v1"); return s ? JSON.parse(s) : WALLETS; } catch { return WALLETS; } });
  const [aiInsights, sAiInsights] = useState(() => { try { const s = localStorage.getItem("nomad-ai-insights"); if (!s) return null; const p = JSON.parse(s); if (Date.now() - p.ts > 86400000) return null; return p; } catch { return null; } });
  const [aiInsightsLoading, sAiInsightsLoading] = useState(false);
  const [aiExpandedInsight, sAiExpandedInsight] = useState(null);
  const [aiOpen, sAiOpen] = useState(false);
  const [recDelOpen, sRecDelOpen] = useState(false);
  const [lrMigrating, sLrMigrating] = useState(false);
  const [chatOpen, sChatOpen] = useState(false);
  const [chatMsgs, sChatMsgs] = useState([]);
  const [chatInput, sChatInput] = useState("");
  const [chatLoading, sChatLoading] = useState(false);
  const [lionMsg, sLionMsg] = useState(""); const [lionMsgLoading, sLionMsgLoading] = useState(false);
  const [walletsMgrOpen, sWalletsMgrOpen] = useState(false);
  const [newWalletName, sNewWalletName] = useState(""), [newWalletColor, sNewWalletColor] = useState("#A78BFA"), [newWalletUL, sNewWalletUL] = useState(false);
  const toastTimersRef = useRef({});
  const showT = (msg, type = "info") => {
    // Dedupe identical toasts so a cascade (e.g. 11 sync-rejected from the
    // same load) collapses into a single chip with a "×N" counter. Each
    // bump resets the dismissal timer so the user has time to read.
    sToasts(prev => {
      const existing = prev.find(t => t.msg === msg && t.type === type);
      if (existing) {
        if (toastTimersRef.current[existing.id]) clearTimeout(toastTimersRef.current[existing.id]);
        toastTimersRef.current[existing.id] = setTimeout(() => {
          sToasts(p => p.filter(t => t.id !== existing.id));
          delete toastTimersRef.current[existing.id];
        }, 2500);
        return prev.map(t => t.id === existing.id ? { ...t, count: (t.count || 1) + 1 } : t);
      }
      const id = Date.now() + Math.random();
      toastTimersRef.current[id] = setTimeout(() => {
        sToasts(p => p.filter(t => t.id !== id));
        delete toastTimersRef.current[id];
      }, 2000);
      return [...prev, { id, msg, type }];
    });
  };
  const dismissToast = (id) => {
    if (toastTimersRef.current[id]) { clearTimeout(toastTimersRef.current[id]); delete toastTimersRef.current[id]; }
    sToasts(prev => prev.filter(t => t.id !== id));
  };

  // Persist custom wallets
  useEffect(() => { localStorage.setItem("nomad-wallets-v1", JSON.stringify(wallets)); }, [wallets]);

  // No-log-in-3-days reminder (runs once after data loads)
  useEffect(() => {
    if (!loaded) return;
    const lastKey = "nomad-last-log-nudge";
    const today = localDateKey();
    if (localStorage.getItem(lastKey) === today) return; // already nudged today
    const allDates = [...ex, ...inc].map(t => t.date).filter(Boolean).sort();
    if (allDates.length === 0) return;
    const last = allDates[allDates.length - 1];
    const diff = Math.floor((new Date(today) - new Date(last)) / 86400000);
    if (diff >= 3) { showT(`No transactions in ${diff} days — stay on track!`, "info"); localStorage.setItem(lastKey, today); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // Pending splits reminder — throttled to once per day per device
  useEffect(() => {
    if (!loaded) return;
    const lastKey = "nomad-last-splits-nudge";
    const today = localDateKey();
    if (localStorage.getItem(lastKey) === today) return;
    const pending = sp.filter(s => !s.settled);
    if (!pending.length) return;
    const owe = pending.filter(s => s.direction === "owe");
    const owed = pending.filter(s => s.direction === "owed");
    const oweTotal = owe.reduce((t, s) => {
      const paid = stl.filter(x => x.splitId === s.id).reduce((u, x) => u + x.amount, 0);
      return t + Math.max(0, s.amount - paid);
    }, 0);
    const owedTotal = owed.reduce((t, s) => {
      const paid = stl.filter(x => x.splitId === s.id).reduce((u, x) => u + x.amount, 0);
      return t + Math.max(0, s.amount - paid);
    }, 0);
    let shown = false;
    if (owedTotal > 0.005) { showT(`${owed.length} pending — others owe you ${fmt(owedTotal)}`, "info"); shown = true; }
    if (oweTotal > 0.005) { showT(`${owe.length} pending — you owe ${fmt(oweTotal)}`, "info"); shown = true; }
    if (shown) localStorage.setItem(lastKey, today);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // Surface server-pushed messages as toasts when app is active (SW forwards via postMessage)
  useEffect(() => {
    if (!navigator.serviceWorker) return;
    const onMsg = (ev) => {
      if (ev.data?.type !== "nomad-push" || !ev.data.payload?.title) return;
      const tag = ev.data.payload.tag || "";
      // Skip toasts for events the client already toasted locally (split/settle/budget/nolog).
      // Only forward server-driven pushes (bill-* from cron).
      const isLocalEcho = /^(split|splits|settle|budget|nolog)-/.test(tag);
      if (isLocalEcho) return;
      showT(`${ev.data.payload.title}${ev.data.payload.body ? " — " + ev.data.payload.body : ""}`, "info");
    };
    navigator.serviceWorker.addEventListener("message", onMsg);
    return () => navigator.serviceWorker.removeEventListener("message", onMsg);
  }, []);

  useEffect(() => subscribePendingSync(sPendingSync), []);

  useEffect(() => subscribeSyncDrops((info) => {
    if (info.kind === "storage") { showT("Storage full — clear some data or export and reset", "error"); return; }
    if (info.kind === "conflict") { showT("Sync conflict — a newer version exists; local change discarded", "error"); return; }
    if (info.kind === "dead-letter") { sDeadLetterCount(getDeadLetterCount()); sDlBanner(true); showT("Change failed after 3 retries — moved to failed queue (see Sync Status)", "error"); return; }
    if (info.kind === "rejected") {
      if (info.status === 404) { showT("Supabase table missing — run nomad_setup.sql in your SQL editor", "error"); return; }
      // PostgREST schema-cache errors mean the DB is missing a column the
      // client is sending. PGRST204 = column not in schema cache;
      // 42703 = undefined_column. Tell the user exactly which column and
      // point them at the migration so they can act on it.
      if (info.status === 400 && (info.code === "PGRST204" || info.code === "42703")) {
        const colMatch = typeof info.message === "string" ? info.message.match(/'([^']+)'\s+column/i) : null;
        const col = colMatch ? colMatch[1] : null;
        showT(col ? `Schema missing '${col}' — re-run nomad_setup.sql in your SQL editor` : "Database schema out of date — re-run nomad_setup.sql in your SQL editor", "error");
        return;
      }
      const code = info.status === 0 ? "blocked" : info.status;
      showT(`Sync rejected (${code}) — change couldn't be saved`, "error");
    }
  }), []);

  useEffect(() => {
    const handler = () => showT("Supabase project is paused — visit supabase.com/dashboard to unpause it", "error");
    window.addEventListener("nomad-db-paused", handler);
    return () => window.removeEventListener("nomad-db-paused", handler);
  }, []);

  useEffect(() => { window.scrollTo(0, 0); }, [tab]);

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
  }, [loaded, rec, sp]);

  useEffect(() => {
    const handleOnline = () => { sOnline(true); flushSyncQueue().catch(() => { }); };
    const handleOffline = () => sOnline(false);
    const handleStorage = (e) => { if (e.key === "nomad-v5" && e.newValue !== e.oldValue) sStaleData(true); };
    if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("controllerchange", () => sSwUpdate(true));
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  useEffect(() => {
    const load = async () => {
      // Show local data instantly — zero startup delay
      loadLocalBackup({ sEx, sInc, sTr, sStl, sCats, sIsrc, sSp, sRec, sEvs, sDm, sWsb, sRecCats });
      sL(true);
      if (!SB_ENABLED || (typeof navigator !== "undefined" && !navigator.onLine)) return;
      // Flush any pending offline writes before reading remote state, so newly
      // added rows (especially ones still in the queue from the previous tab
      // session) commit before we mirror Supabase back into local state.
      try { await flushSyncQueue(); } catch { /* keep going on flush failure */ }
      // Background refresh — replace with authoritative Supabase data
      try {
        const [dbEx, dbInc, dbTr, dbStl, dbSp, dbRec, dbWsb, dbEvs] = await Promise.all([
          sbGet("expenses"), sbGet("incomes"), sbGet("transfers"), sbGet("settlements"),
          sbGet("splits"), sbGet("recurring"), sbGet("wallet_balances"), sbGet("events")
        ]);
        const hadRemoteFailure = [dbEx, dbInc, dbTr, dbStl, dbSp, dbRec, dbWsb, dbEvs].some(x => x === null);
        if (hadRemoteFailure) return;
        // First-time connect: migrate local data up to Supabase
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
                if (exL.length) sbUpsert("expenses", exL.map(e => toSB(e, COLS.expenses)));
                if (incL.length) sbUpsert("incomes", incL.map(i => toSB(i, COLS.incomes)));
                if (trL.length) sbUpsert("transfers", trL.map(t => toSB(t, COLS.transfers)));
                if (stlL.length) sbUpsert("settlements", stlL.map(s => toSB(s, COLS.settlements)));
                if (spL.length) sbUpsert("splits", spL.map(s => toSB(s, COLS.splits)));
                if (recL.length) sbUpsert("recurring", recL.map(r => toSB(r, COLS.recurring)));
                if (evsL.length) sbUpsert("events", evsL.map(e => toSB(e, COLS.events)));
                if (ld.walletStartBal) Object.entries(ld.walletStartBal).forEach(([wid, bal]) => sbUpsert("wallet_balances", [{ wallet_id: wid, balance: bal }], `wallet_balances:${wid}`));
              }
            }
          } catch { }
          return; // local data already rendered, nothing to replace
        }
        // Merge remote with local via the dedicated reconcile helper.
        // mergeRemote(): never drops a locally-known row unless it's been
        // explicitly deleted or has a fresher remote copy. See syncMerge.js
        // for the full rules. Orphans (locally-known rows missing from remote
        // with no queue entry) are returned separately so we can self-heal
        // them via a fresh upsert below.
        const localBackup = (() => { try { return JSON.parse(localStorage.getItem("nomad-v5") || "{}"); } catch { return {}; } })();
        const normalizedEvs = (dbEvs || []).map(e => ({ ...e, participants: Array.isArray(e?.participants) ? e.participants.filter(p => typeof p === "string") : [] }));
        const deps = { isPendingDelete, isPendingUpsert };
        const exM  = mergeRemote({ table: "expenses",  remote: dbEx,           local: localBackup.expenses,   ...deps });
        const incM = mergeRemote({ table: "incomes",   remote: dbInc,          local: localBackup.incomes,    ...deps });
        const trM  = mergeRemote({ table: "transfers", remote: dbTr,           local: localBackup.transfers,  ...deps });
        const spM  = mergeRemote({ table: "splits",    remote: dbSp,           local: localBackup.splits,     ...deps });
        const recM = mergeRemote({ table: "recurring", remote: dbRec,          local: localBackup.recurring,  ...deps });
        const evsM = mergeRemote({ table: "events",    remote: normalizedEvs,  local: localBackup.events,     ...deps });
        sEx(exM.next);
        sInc(incM.next);
        sTr(trM.next);
        sStl(dbStl || []);
        sSp(spM.next);
        sRec(recM.next);
        sEvs(evsM.next);
        // Self-heal: rows in local but missing from BOTH remote and the
        // offline queue were almost certainly lost to a silently-rejected
        // upsert (4xx, dead-letter exhaustion, etc.). Re-queue them so they
        // make it back to Supabase. Restricted to recently-created rows so
        // we never resurrect intentionally-deleted ancient items.
        const heal = (table, cols, orphans) => orphans.filter(r => isRecentRow(r)).forEach(r => sbUpsert(table, [toSB(r, cols)], `${table}:heal:${r.id}`));
        heal("expenses",  COLS.expenses,  exM.orphans);
        heal("incomes",   COLS.incomes,   incM.orphans);
        heal("transfers", COLS.transfers, trM.orphans);
        heal("splits",    COLS.splits,    spM.orphans);
        heal("recurring", COLS.recurring, recM.orphans);
        heal("events",    COLS.events,    evsM.orphans);
        if (dbWsb?.length) { const wb = {}; wallets.forEach(w => { wb[w.id] = 0; }); dbWsb.forEach(r => { wb[r.wallet_id] = r.balance; }); sWsb(wb); }
        try {
          const lp = JSON.parse(localStorage.getItem("nomad-v5") || "{}");
          if (lp.darkMode !== undefined) sDm(lp.darkMode);
          if (lp.categories?.length) sCats(lp.categories);
          if (lp.incomeSources?.length) sIsrc(lp.incomeSources);
        } catch { }
      } catch { /* network error — local data stays */ }
    };
    load();
  }, []);
  // Keep localStorage in sync as offline backup (debounced 800ms)
  const backupDebounceRef = useRef(null);
  useEffect(() => {
    if (!loaded) return;
    if (backupDebounceRef.current) clearTimeout(backupDebounceRef.current);
    backupDebounceRef.current = setTimeout(() => {
      try { localStorage.setItem("nomad-v5", JSON.stringify({ expenses: ex, incomes: inc, transfers: tr, settlements: stl, categories: cats, incomeSources: isrc, splits: sp, events: evs, recurring: rec, darkMode: dm, walletStartBal: wsb, recCats, _modified: Date.now() })) } catch { showT("Storage full — export a backup to preserve your data", "error"); }
    }, 800);
  }, [ex, inc, tr, stl, cats, isrc, sp, evs, rec, dm, wsb, recCats, loaded]);

  useEffect(() => { try { const b = JSON.parse(localStorage.getItem("nomad-budgets") || "{}"); sBudgets(b); } catch { /* ignore */ } }, []);
  useEffect(() => { try { localStorage.setItem("nomad-budgets", JSON.stringify(budgets)); } catch { /* quota */ } }, [budgets]);
  useEffect(() => { try { localStorage.setItem("nomad-auto-rules", JSON.stringify(autoRules)); } catch { /* quota */ } }, [autoRules]);

  const allM = useMemo(() => { const s = new Set(); ex.forEach(e => s.add(mk(e.date))); inc.forEach(i => s.add(mk(i.date))); return [...s].sort() }, [ex, inc]);
  const quickPatterns = useMemo(() => { const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 60); const cutStr = localDateKey(cutoff); const counts = {}; ex.filter(e => !e.deleted_at && (e.date || "") >= cutStr).forEach(e => { const k = `${e.amount}|${e.categoryId || ""}|${e.walletId || "upi_lite"}|${(e.note || "").slice(0, 30)}`; if (!counts[k]) counts[k] = { count: 0, amount: e.amount, categoryId: e.categoryId || "", walletId: e.walletId || "upi_lite", note: e.note || "" }; counts[k].count++; }); return Object.values(counts).filter(p => p.count >= 2).sort((a, b) => b.count - a.count).slice(0, 5); }, [ex]);
  const finStreak = useMemo(() => { const allDays = new Set([...ex, ...inc].map(t => String(t.date || "").slice(0, 10))); let s = 0; const d = new Date(); while (true) { const k = localDateKey(d); if (!allDays.has(k)) break; s++; d.setDate(d.getDate() - 1); } return s; }, [ex, inc]);
  const finScore = useMemo(() => computeFinanceScore({ expenses: ex, incomes: inc, recurring: rec }), [ex, inc, rec]);
  const subSuggestions = useMemo(() => { const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 90); const cutStr = localDateKey(cutoff); const recNames = new Set(rec.map(r => r.name.toLowerCase().trim())); const groups = {}; ex.filter(e => !e.deleted_at && (e.date || "") >= cutStr).forEach(e => { const k = (e.note || "").toLowerCase().trim(); if (!k || k.length < 3) return; if (!groups[k]) groups[k] = []; groups[k].push(e); }); return Object.values(groups).filter(g => g.length >= 2).map(g => { const amounts = g.map(e => e.amount); const avgAmt = roundMoney(amounts.reduce((s, a) => s + a, 0) / amounts.length); const name = g[0].note || ""; if (recNames.has(name.toLowerCase().trim())) return null; return { name, categoryId: g[0].categoryId, walletId: g[0].walletId || "bank", count: g.length, avgAmt }; }).filter(Boolean).sort((a, b) => b.count - a.count).slice(0, 5); }, [ex, rec]);
  const flt = useMemo(() => fm === "all" ? { expenses: ex, incomes: inc, settlements: stl } : { expenses: ex.filter(e => mk(e.date) === fm), incomes: inc.filter(i => mk(i.date) === fm), settlements: stl.filter(s => mk(s.date) === fm) }, [ex, inc, stl, fm]);
  const tI = flt.incomes.reduce((s, i) => s + i.amount, 0), tE = Math.max(0, flt.expenses.reduce((s, e) => s + e.amount, 0) + flt.settlements.filter(s => s.direction === "owe").reduce((s, x) => s + x.amount, 0) - flt.settlements.filter(s => s.direction === "owed").reduce((s, x) => s + x.amount, 0));
  const historyItems = useMemo(() => {
    const searching = hSearch.trim() !== "";
    let items = searching
      ? [...ex.map(e => ({ ...e, type: "expense" })), ...inc.map(i => ({ ...i, type: "income" })), ...tr.map(t => ({ ...t, type: "transfer" })), ...stl.map(s => ({ ...s, type: "settlement" }))]
      : [...flt.expenses.map(e => ({ ...e, type: "expense" })), ...flt.incomes.map(i => ({ ...i, type: "income" })), ...(fm === "all" ? tr : tr.filter(t => mk(t.date) === fm)).map(t => ({ ...t, type: "transfer" })), ...(fm === "all" ? stl : stl.filter(s => mk(s.date) === fm)).map(s => ({ ...s, type: "settlement" }))];
    if (searching) { const q = hSearch.toLowerCase().trim(); items = items.filter(it => (it.note || "").toLowerCase().includes(q) || (cats.find(c => c.id === it.categoryId)?.name || "").toLowerCase().includes(q) || (isrc.find(s => s.id === it.sourceId)?.name || "").toLowerCase().includes(q) || (it.splitName || "").toLowerCase().includes(q) || (evs.find(e => e.id === it.eventId)?.name || "").toLowerCase().includes(q)); }
    if (hMinAmt !== "") { const m = parseAmount(hMinAmt); if (Number.isFinite(m)) items = items.filter(it => it.amount >= m); }
    if (hMaxAmt !== "") { const m = parseAmount(hMaxAmt); if (Number.isFinite(m)) items = items.filter(it => it.amount <= m); }
    if (hDateFrom) items = items.filter(it => it.date >= hDateFrom);
    if (hDateTo) items = items.filter(it => it.date <= hDateTo);
    if (hType === "recurring") items = items.filter(it => it.type === "expense" && isFix(it));
    else if (hType !== "all") items = items.filter(it => it.type === hType);
    return items.sort(historySortCompare);
  }, [flt, ex, inc, tr, stl, fm, hSearch, hMinAmt, hMaxAmt, hDateFrom, hDateTo, hType, cats, isrc, evs]);
  const timelineData = useMemo(() => {
    const all = [...ex.map(e => ({ ...e, type: "expense" })), ...inc.map(i => ({ ...i, type: "income" })), ...tr.map(t => ({ ...t, type: "transfer" })), ...stl.map(s => ({ ...s, type: "settlement" }))].sort((a, b) => { const dd = new Date(a.date) - new Date(b.date); if (dd !== 0) return dd; return new Date(a.created_at || a.createdAt || a.updated_at || 0) - new Date(b.created_at || b.createdAt || b.updated_at || 0); });
    const wDelta = (tx, wId) => { if (tx.type === "expense") return (tx.walletId || "upi_lite") === wId ? -tx.amount : 0; if (tx.type === "income") return (tx.walletId || "bank") === wId ? tx.amount : 0; if (tx.type === "transfer") { if (tx.fromWallet === wId) return -tx.amount; if (tx.toWallet === wId) return tx.amount; return 0; } if (tx.type === "settlement") return tx.walletId === wId ? (tx.direction === "owed" ? tx.amount : -tx.amount) : 0; return 0; };
    // Calibrations shift wsb by `gap` at a specific point in time. For each
    // transaction, transactions PRIOR to a calibration's ts must use the
    // pre-calibration wsb (current wsb minus all gaps from calibrations
    // recorded after the transaction). Otherwise a fresh calibration would
    // retroactively rewrite the entire past timeline.
    const calsByWallet = {};
    calLog.forEach(c => { if (!calsByWallet[c.wId]) calsByWallet[c.wId] = []; calsByWallet[c.wId].push(c); });
    const txTs = (tx) => { const t = tx.created_at || tx.createdAt || tx.updated_at; return t ? new Date(t).getTime() : new Date(tx.date + "T23:59:59").getTime(); };
    const map = {};
    all.forEach((tx, i) => {
      const after = {}, before = {};
      const tts = txTs(tx);
      const slice = all.slice(0, i + 1);
      wallets.forEach(w => {
        const cals = calsByWallet[w.id] || [];
        const futureGapSum = cals.filter(c => c.ts > tts).reduce((s, c) => s + (c.gap || 0), 0);
        const histStartBal = (wsb[w.id] || 0) - futureGapSum;
        const aft = histStartBal + slice.reduce((s, t) => s + wDelta(t, w.id), 0);
        after[w.id] = aft;
        before[w.id] = aft - wDelta(tx, w.id);
      });
      map[tx.id] = { before, after };
    });
    return map;
  }, [ex, inc, tr, stl, wsb, wallets, calLog]);

  const budgetStatus = useMemo(() => { const cm = localDateKey().slice(0, 7); const splitCat = (id) => sp.find(x => x.id === id)?.categoryId; const mEx = ex.filter(e => mk(e.date) === cm); const mStl = (stl || []).filter(s => s.direction === "owe" && mk(s.date) === cm); return Object.entries(budgets).filter(entry => entry[1] > 0).map(([cid, lim]) => { const exSum = mEx.filter(e => e.categoryId === cid).reduce((s, e) => s + e.amount, 0); const stlSum = mStl.filter(s => (s.categoryId || splitCat(s.splitId)) === cid).reduce((s, x) => s + x.amount, 0); const spent = roundMoney(exSum + stlSum); const cat = cats.find(c => c.id === cid) || { id: cid, name: cid, color: "#999", neon: "#999" }; const pct = Math.min(100, Math.round(spent / lim * 100)); return { cid, cat, spent, lim, pct }; }); }, [budgets, ex, stl, sp, cats]);

  // Settlements that the user PAID OUT count as real spending, categorized by
  // the linked split's categoryId (snapshot on the settlement, or fetched from
  // the split as a fallback for older rows). Mapped to expense-shape so the
  // spending-breakdown, per-day/per-week chart, and spending-by-category
  // aggregations can include them without forking their logic.
  const settlementsAsExpenses = useMemo(() => {
    const splitCat = (id) => sp.find(x => x.id === id)?.categoryId;
    return (stl || []).filter(s => s.direction === "owe").map(s => ({
      id: s.id,
      date: s.date,
      amount: s.amount,
      categoryId: s.categoryId || splitCat(s.splitId) || "other",
      note: s.note || ("Paid " + s.splitName),
      walletId: s.walletId,
      __settlement: true,
    }));
  }, [stl, sp]);
  const exAll = useMemo(() => [...ex, ...settlementsAsExpenses], [ex, settlementsAsExpenses]);
  const fltExAll = useMemo(() => fm === "all" ? exAll : exAll.filter(e => mk(e.date) === fm), [exAll, fm]);

  // Stale split detection — IOUs older than 2 days that aren't settled/skipped/deleted.
  // Uses createdAt when present; falls back to linked event.date for event splits.
  // Without either, the split is treated as stale (forgotten old IOUs from before this feature).
  const staleSplits = useMemo(() => {
    const cutoffMs = Date.now() - 2 * 24 * 60 * 60 * 1000;
    return (sp || []).filter(s => {
      if (s.settled || s.deleted_at || s.skipped) return false;
      if (s.createdAt) { const t = new Date(s.createdAt).getTime(); return Number.isFinite(t) && t < cutoffMs; }
      if (s.eventId) { const ev = evs.find(e => e.id === s.eventId); if (ev?.date) { const t = new Date(ev.date + "T00:00:00").getTime(); return Number.isFinite(t) && t < cutoffMs; } }
      return true;
    });
  }, [sp, evs]);
  const stalePersonal = useMemo(() => staleSplits.filter(s => !s.eventId), [staleSplits]);
  const staleByEvent = useMemo(() => { const m = {}; staleSplits.forEach(s => { if (s.eventId) (m[s.eventId] = m[s.eventId] || []).push(s); }); return m; }, [staleSplits]);

  const wBal = useMemo(() => { const b = {}; wallets.forEach(w => { b[w.id] = roundMoney(wsb[w.id] || 0); }); inc.forEach(i => { const w = i.walletId || "bank"; if (b[w] !== undefined) b[w] = roundMoney(b[w] + i.amount) }); ex.forEach(e => { const w = e.walletId || "upi_lite"; if (b[w] !== undefined) b[w] = roundMoney(b[w] - e.amount) }); tr.forEach(t => { if (b[t.fromWallet] !== undefined) b[t.fromWallet] = roundMoney(b[t.fromWallet] - t.amount); if (b[t.toWallet] !== undefined) b[t.toWallet] = roundMoney(b[t.toWallet] + t.amount) }); stl.forEach(s => { if (b[s.walletId] !== undefined) { if (s.direction === "owed") b[s.walletId] = roundMoney(b[s.walletId] + s.amount); else b[s.walletId] = roundMoney(b[s.walletId] - s.amount) } }); return b }, [ex, inc, tr, stl, wsb, wallets]);
  const mBal = roundMoney(Object.values(wBal).reduce((s, v) => s + v, 0));
  useEffect(() => { if (!loaded) return; sLionMsgLoading(true); const cm = localDateKey().slice(0, 7); const totalInc = inc.reduce((s, i) => s + i.amount, 0); const totalExp = ex.reduce((s, e) => s + e.amount, 0); const catTotals = {}; ex.forEach(e => { catTotals[e.categoryId] = (catTotals[e.categoryId] || 0) + e.amount; }); const topCats = Object.entries(catTotals).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, amt]) => ({ name: cats.find(c => c.id === id)?.name || id, amount: amt, pct: totalExp > 0 ? Math.round(amt / totalExp * 100) : 0 })); const wBals = wallets.map(w => ({ name: w.name, balance: roundMoney(wBal[w.id] || 0) })); const LION_ANGLES = ["Channel a disappointed but loving parent", "Be a dramatic Bollywood narrator", "Sound like Gordon Ramsay reviewing my finances", "Be an overly enthusiastic life coach", "Be cryptic like a fortune cookie", "Sound like a cricket commentator calling my spending", "Be a strict school teacher grading my money habits", "Be a bewildered stock market analyst", "Sound like a proud desi dad comparing me to neighbours", "Be a suspenseful movie trailer narrator"]; const angle = LION_ANGLES[Math.floor(Math.random() * LION_ANGLES.length)]; fetch("/api/ai-chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: `Give me ONE witty line (max 15 words) as my cheeky lion finance mascot. Style: ${angle}. Use actual numbers from my data — no generic filler!`, context: { month: cm, totalIncome: totalInc, totalExpense: totalExp, topCategories: topCats, walletBalances: wBals, recurringCount: rec.filter(r => r.active !== false).length, streak: finStreak } }) }).then(r => r.json()).then(d => { if (d.answer) sLionMsg(d.answer.replace(/^["']|["']$/g, "").slice(0, 120)); sLionMsgLoading(false); }).catch(() => { sLionMsg(TIPS[Math.floor(Math.random() * TIPS.length)]); sLionMsgLoading(false); }); }, [loaded, ex.length]);

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
    return roundMoney(start + incSum - exSum + trIn - trOut + stlAdj);
  };

  // UPI Lite limits (RBI: ₹5000/day, ₹1L/month)
  const upiLiteUsage = (date, walletId = "upi_lite") => {
    const mk = String(date || "").slice(0, 7);
    const day = ex.filter(e => e.walletId === walletId && e.date === date).reduce((s, e) => s + e.amount, 0);
    const month = ex.filter(e => e.walletId === walletId && String(e.date || "").slice(0, 7) === mk).reduce((s, e) => s + e.amount, 0);
    return { day: roundMoney(day), month: roundMoney(month) };
  };

  const addE = data => {
    const amt = roundMoney(data.amount);
    if (amt <= 0) { showT("Enter a valid amount", "error"); return false }
    if (amt > 10000000) { showT("Amount too large (max ₹1 crore)", "error"); return false }
    if (typeof data.note === "string" && data.note.length > 500) data = { ...data, note: data.note.slice(0, 500) };
    if (data.paidBy && data.paidBy !== "me") {
      const rec = { id: uid(), type: "expense", ...data, amount: amt, walletId: "__tracked__", created_at: new Date().toISOString() };
      sEx(p => [rec, ...p]);
      sbUpsert("expenses", [toSB(rec, COLS.expenses)]);
      showT(online ? "Expense tracked" : "Expense saved offline", "success");
      return true;
    }
    const w = wallets.find(x => x.id === data.walletId);
    const today = localDateKey();
    const isBackdated = data.date && data.date < today;
    // Use historical balance for backdated, current for today/future
    const b = roundMoney(isBackdated ? balanceOnDate(data.walletId, data.date) : (wBal[data.walletId] || 0));
    if (b < amt) { showT(isBackdated ? `${w?.name} only had ${fmt(b)} on ${data.date} (need ${fmt(amt)})` : `Not enough in ${w?.name} (have ${fmt(b)}, need ${fmt(amt)})`, "error"); return false }
    // UPI Lite cap warnings
    if (isUpiLite(data.walletId, wallets)) {
      const u = upiLiteUsage(data.date || today, data.walletId);
      if (roundMoney(u.day + amt) > 5000) { showT(`UPI Lite daily cap ₹5000 exceeded (₹${u.day} used)`, "error"); return false }
      if (roundMoney(u.month + amt) > 100000) { showT(`UPI Lite monthly cap ₹1L exceeded`, "error"); return false }
      if (roundMoney(u.day + amt) > 4500) { showT(`Heads up: UPI Lite at ₹${roundMoney(u.day + amt)} today (cap ₹5000)`, "info") }
    }
    const rec = { id: uid(), type: "expense", ...data, amount: amt, balBefore: b, created_at: new Date().toISOString() };
    sEx(p => [rec, ...p]);
    sbUpsert("expenses", [toSB(rec, COLS.expenses)]);
    dance();
    if (budgets[data.categoryId] > 0) { const cm = localDateKey().slice(0, 7); const prev = ex.filter(e => e.categoryId === data.categoryId && mk(e.date) === cm).reduce((s, e) => s + e.amount, 0); const tot = prev + amt; const lim = budgets[data.categoryId]; const cn = cats.find(c => c.id === data.categoryId)?.name || data.categoryId; if (tot >= lim) showT(`${cn} budget exceeded! ${fmt(tot)} / ${fmt(lim)}`, "error"); else if (tot >= lim * 0.8) showT(`${cn} at ${Math.round(tot / lim * 100)}% of budget (${fmt(lim)})`, "info"); }
    showT(online ? "Expense added" : "Expense saved offline", "success");
    return true;
  };
  const addI = data => { const amt = roundMoney(data.amount); if (isUpiLite(data.walletId, wallets)) { showT("UPI Lite is for spending only", "error"); return false } if (amt <= 0) { showT("Enter a valid amount", "error"); return false } if (amt > 10000000) { showT("Amount too large (max ₹1 crore)", "error"); return false } if (typeof data.note === "string" && data.note.length > 500) data = { ...data, note: data.note.slice(0, 500) }; const isBackdated = data.date && data.date < localDateKey(); const balBefore = roundMoney(isBackdated ? balanceOnDate(data.walletId, data.date) : (wBal[data.walletId] || 0)); const rec = { id: uid(), type: "income", ...data, amount: amt, balBefore, created_at: new Date().toISOString() }; sInc(p => [rec, ...p]); sbUpsert("incomes", [toSB(rec, COLS.incomes)]); dance(); showT(online ? "Income added" : "Income saved offline", "success"); return true };
  const addT = data => { const amt = roundMoney(data.amount); if (amt <= 0) { showT("Enter an amount above zero", "error"); return false } if (amt > 10000000) { showT("Amount too large (max ₹1 crore)", "error"); return false } if (!data.fromWallet || !data.toWallet) { showT("Pick a source and a destination wallet", "error"); return false } if (data.fromWallet === data.toWallet) { showT("Source and destination must be different wallets", "error"); return false } const isBackdated = data.date && data.date < localDateKey(); const fromBalBefore = roundMoney(isBackdated ? balanceOnDate(data.fromWallet, data.date) : (wBal[data.fromWallet] || 0)); if (fromBalBefore < amt) { showT(`Insufficient balance`, "error"); return false } if (typeof data.note === "string" && data.note.length > 500) data = { ...data, note: data.note.slice(0, 500) }; const toBalBefore = roundMoney(isBackdated ? balanceOnDate(data.toWallet, data.date) : (wBal[data.toWallet] || 0)); const rec = { id: uid(), type: "transfer", ...data, amount: amt, fromBalBefore, toBalBefore, created_at: new Date().toISOString() }; sTr(p => [rec, ...p]); sbUpsert("transfers", [toSB(rec, COLS.transfers)]); dance(); showT(online ? "Transfer done" : "Transfer queued offline", "success"); return true };
  const refundItem = exp => { if (!exp || exp.amount <= 0) return; const src = isrc[0]; if (!src) { showT("No income source configured", "error"); return; } const note = ("Refund: " + (exp.note || cats.find(c => c.id === exp.categoryId)?.name || "")).slice(0, 500); addI({ id: uid(), amount: exp.amount, sourceId: src.id, walletId: exp.walletId, note, date: localDateKey() }); };
  const settle = (sid, wid, payAmt) => {
    const s = sp.find(x => x.id === sid);
    if (!s) return false;
    const today = localDateKey();
    const prevPaid = stl.filter(x => x.splitId === sid).reduce((t, x) => t + x.amount, 0);
    const remaining = roundMoney(s.amount - prevPaid);
    if (remaining < -0.005) { showT(`Over-settled — ${fmt(prevPaid)} paid against ${fmt(s.amount)} IOU. Check sync issues in Settings.`, "error"); return false; }
    const hasPayAmt = payAmt != null && payAmt !== "";
    const payNum = hasPayAmt ? Number(payAmt) : null;
    if (hasPayAmt && (!Number.isFinite(payNum) || payNum <= 0)) { showT("Enter a valid amount", "error"); return false; }
    const amount = hasPayAmt ? roundMoney(Math.min(payNum, remaining)) : remaining;
    if (amount <= 0) { showT("Already fully settled", "info"); return false; }
    if (s.direction === "owe") {
      const b = roundMoney(wBal[wid] || 0);
      if (b < amount) { showT(`Not enough — need ${fmt(amount)}, have ${fmt(b)}`, "error"); return false }
      if (isUpiLite(wid, wallets)) {
        const u = upiLiteUsage(today, wid);
        if (roundMoney(u.day + amount) > 5000) { showT(`UPI Lite daily cap ₹5000 exceeded (₹${u.day} used)`, "error"); return false }
        if (roundMoney(u.month + amount) > 100000) { showT(`UPI Lite monthly cap ₹1L exceeded`, "error"); return false }
        if (roundMoney(u.day + amount) > 4500) { showT(`Heads up: UPI Lite at ₹${roundMoney(u.day + amount)} today`, "info") }
      }
    }
    if (s.direction === "owed" && isUpiLite(wid, wallets)) { showT("UPI Lite cannot receive money", "error"); return false }
    const rec = { id: uid(), type: "settlement", splitName: s.name, splitId: s.id, amount, direction: s.direction, walletId: wid, date: today, createdAt: new Date().toISOString(), ...(s.categoryId && { categoryId: s.categoryId }), ...(s.note && { note: s.note }), ...(s.groupId && { groupId: s.groupId }), ...(s.eventId && { eventId: s.eventId }) };
    sStl(p => [...p, rec]);
    sbUpsert("settlements", [toSB(rec, COLS.settlements)]);
    const newTotal = roundMoney(prevPaid + amount);
    const fullySettled = newTotal >= s.amount - 0.005;
    if (fullySettled) { sSp(p => p.map(x => x.id === sid ? { ...x, settled: true } : x)); sbUpsert("splits", [{ id: sid, settled: true }], `splits:${sid}`); showT(online ? "Fully settled ✓" : "Settlement queued offline", "success"); }
    else { showT(`Paid ${fmt(amount)} · ${fmt(roundMoney(s.amount - newTotal))} still remaining`, "success"); }
    return true;
  };
  const undoBuffersRef = useRef(new Map()); // toastId -> buffer

  const undoDelete = (toastId) => {
    const buf = undoBuffersRef.current.get(toastId);
    if (!buf) return;
    if (buf.type === "expense") {
      sEx(p => [buf.exp, ...p]);
      sbUpsert("expenses", [{ ...toSB(buf.exp, COLS.expenses), deleted_at: null }]);
      if (buf.splits?.length) { sSp(p => [...p, ...buf.splits]); sbUpsert("splits", buf.splits.map(s => toSB(s, COLS.splits))); }
      if (buf.settlements?.length) { sStl(p => [...p, ...buf.settlements]); sbUpsert("settlements", buf.settlements.map(s => toSB(s, COLS.settlements))); }
    } else if (buf.type === "income") { sInc(p => [buf.exp, ...p]); sbUpsert("incomes", [{ ...toSB(buf.exp, COLS.incomes), deleted_at: null }]); }
    else if (buf.type === "transfer") { sTr(p => [buf.exp, ...p]); sbUpsert("transfers", [{ ...toSB(buf.exp, COLS.transfers), deleted_at: null }]); }
    else if (buf.type === "settlement") { sStl(p => [...p, buf.exp]); sbUpsert("settlements", [toSB(buf.exp, COLS.settlements)]); if (buf.exp.splitId) { sSp(p => p.map(x => x.id === buf.exp.splitId ? { ...x, settled: true } : x)); sbUpsert("splits", [{ id: buf.exp.splitId, settled: true }], `splits:${buf.exp.splitId}`); } }
    else if (buf.type === "recurring") { sRec(p => [buf.exp, ...p]); sbUpsert("recurring", [{ ...toSB(buf.exp, COLS.recurring), deleted_at: null }]); }
    else if (buf.type === "event") { sEvs(p => [buf.exp, ...p]); sbUpsert("events", [{ ...toSB(buf.exp, COLS.events), deleted_at: null }]); }
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

  const delItem = useCallback((id, type) => {
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
      sStl(p => p.filter(s => s.id !== id)); sbDeleteWhere("settlements", `id=eq.${id}`);
      if (stlRec.splitId) { sSp(p => p.map(x => x.id === stlRec.splitId ? { ...x, settled: false } : x)); sbUpsert("splits", [{ id: stlRec.splitId, settled: false }], `splits:${stlRec.splitId}`); }
      showUndoToast("Settlement deleted", { type: "settlement", exp: stlRec });
    } else if (type === "split") {
      sSp(p => p.filter(s => s.id !== id)); sbDelete("splits", id);
      showT("IOU deleted", "success");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ex, sp, stl, inc, tr]);
  const addRec = r => { sRec(p => [...p, r]); sbUpsert("recurring", [toSB(r, COLS.recurring)]); showT(r.name + " added as recurring", "success"); };
  const addCust = () => { if (!nn.trim()) return; const id = nn.trim().toLowerCase().replace(/\s+/g, "_") + "_" + uid(), item = { id, name: nn.trim(), emoji: ne2, color: nc }; if (mt === "expense") sCats(p => [...p, item]); else sIsrc(p => [...p, item]); sNN(""); sNE2("📁"); sNC("#E07A5F") };
  const handleCal = (wId, desired, note = "") => {
    if (isUpiLite(wId, wallets) && desired > 5000) {
      showT("UPI Lite max balance is ₹5000 (RBI rule)", "error");
      return;
    }
    if (desired < 0) {
      showT("Balance cannot be negative", "error");
      return;
    }
    const cur = roundMoney(wBal[wId] || 0), start = wsb[wId] || 0, newStart = start + (desired - cur);
    const gap = roundMoney(desired - cur);
    sWsb(p => ({ ...p, [wId]: newStart }));
    sbUpsert("wallet_balances", [{ wallet_id: wId, balance: newStart }], `wallet_balances:${wId}`);
    try {
      const prev = JSON.parse(localStorage.getItem("nomad-cal-log") || "[]");
      const entry = { wId, wName: wallets.find(w => w.id === wId)?.name || wId, date: localDateKey(), before: cur, after: roundMoney(desired), gap, note: note.trim(), ts: Date.now() };
      const updated = [entry, ...prev].slice(0, 50);
      localStorage.setItem("nomad-cal-log", JSON.stringify(updated));
      sCalLog(updated);
    } catch { }
    try {
      const snaps = JSON.parse(localStorage.getItem("nomad-cal-snaps-v1") || "[]");
      snaps.push({ walletId: wId, balance: roundMoney(desired), date: localDateKey(), ts: Date.now() });
      localStorage.setItem("nomad-cal-snaps-v1", JSON.stringify(snaps));
    } catch { }
    showT(gap === 0 ? "Balance unchanged" : `${gap > 0 ? "Added" : "Removed"} ${fmt(Math.abs(gap))} — reconciliation logged`, "success");
  };
  const expCSV = () => { let csv = "Type,Date,Amount,Category/Source,Wallet,Note\n"; inc.forEach(i => { csv += `Income,${i.date},${i.amount},"${isrc.find(s => s.id === i.sourceId)?.name || ""}","${wallets.find(x => x.id === i.walletId)?.name || "Bank"}","${i.note || ""}"\n` }); ex.forEach(e => { csv += `Expense,${e.date},${e.amount},"${cats.find(c => c.id === e.categoryId)?.name || ""}","${wallets.find(x => x.id === e.walletId)?.name || ""}","${e.note || ""}"\n` }); tr.forEach(t => { csv += `Transfer,${t.date},${t.amount},"${t.fromWallet}→${t.toWallet}","","${t.note || ""}"\n` }); stl.forEach(s => { csv += `Settlement,${s.date},${s.amount},"${s.splitName}","${wallets.find(w => w.id === s.walletId)?.name || ""}","${s.direction}"\n` }); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = `nomad_${localDateKey()}.csv`; a.click() };
  const expBackup = () => { const data = JSON.stringify({ expenses: ex, incomes: inc, transfers: tr, settlements: stl, categories: cats, incomeSources: isrc, splits: sp, events: evs, recurring: rec, darkMode: dm, walletStartBal: wsb, wallets, autoRules, budgets, _v: "nomad-v9", _date: new Date().toISOString() }, null, 2); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([data], { type: "application/json" })); a.download = `nomad_backup_${localDateKey()}.json`; a.click(); showT("Backup downloaded", "success") };
  // Convert a `data:` URL back to a File so it can be re-uploaded via uploadReceipt.
  const dataUrlToFile = (dataUrl) => {
    const [meta, b64] = String(dataUrl).split(",");
    const mime = (meta.match(/data:([^;]+)/)?.[1]) || "application/octet-stream";
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const name = mime === "application/pdf" ? "receipt.pdf" : "receipt.jpg";
    return new File([arr], name, { type: mime });
  };
  // Re-upload locally-stored receipts (data: URLs) to Cloudinary. Receipts attached
  // while offline or during a Cloudinary outage stay as data: URLs forever because
  // the sync queue replays the expense row as-is — it doesn't retry the upload.
  // Manual trigger from Settings → Local Receipts card.
  const migrateLocalReceipts = async () => {
    if (!_creds.cloudName) { showT("Configure Cloudinary first", "error"); return; }
    if (lrMigrating) return;
    sLrMigrating(true);
    let migrated = 0, failed = 0;
    let firstError = ""; // Cloudinary error message to surface in toast
    const processRow = async (row, table, setState) => {
      let urls;
      try { urls = JSON.parse(row.receipt_url); if (!Array.isArray(urls)) urls = [row.receipt_url]; }
      catch { urls = [row.receipt_url]; }
      const newUrls = await Promise.all(urls.map(async (u) => {
        if (typeof u !== "string" || !u.startsWith("data:")) return u;
        try {
          const file = dataUrlToFile(u);
          const r = await uploadReceipt(file, { throwOnFail: true });
          return r;
        } catch (e) {
          if (!firstError) firstError = e?.message || "Upload failed";
          console.warn("Migration upload failed:", e?.message || e);
          return u;
        }
      }));
      const anyUpdated = newUrls.some((u, i) => u !== urls[i] && !u.startsWith("data:"));
      const allStillLocal = newUrls.every(u => typeof u === "string" && u.startsWith("data:"));
      if (anyUpdated) {
        const final = newUrls.length === 1 ? newUrls[0] : JSON.stringify(newUrls);
        setState(prev => prev.map(x => x.id === row.id ? { ...x, receipt_url: final } : x));
        try { await sbUpsert(table, [{ id: row.id, receipt_url: final }]); } catch { /* sync queue will retry */ }
        if (allStillLocal) failed++; else migrated++;
      } else {
        failed++;
      }
    };
    const isLocal = (u) => typeof u === "string" && (u.startsWith("data:") || (() => { try { const arr = JSON.parse(u); return Array.isArray(arr) && arr.some(x => typeof x === "string" && x.startsWith("data:")); } catch { return false; } })());
    const localEx = ex.filter(e => isLocal(e.receipt_url));
    const localInc = inc.filter(i => isLocal(i.receipt_url));
    if (localEx.length + localInc.length === 0) { sLrMigrating(false); showT("No local receipts to migrate", "info"); return; }
    for (const r of localEx) await processRow(r, "expenses", sEx);
    for (const r of localInc) await processRow(r, "incomes", sInc);
    sLrMigrating(false);
    const total = migrated + failed;
    if (migrated > 0 && failed === 0) showT(`Migrated ${migrated} receipt${migrated === 1 ? "" : "s"} to Cloudinary`, "success");
    else if (migrated > 0) showT(`Migrated ${migrated} of ${total} · ${failed} failed: ${firstError || "unknown error"}`, "info");
    else showT(`All ${failed} migration attempt${failed === 1 ? "" : "s"} failed: ${firstError || "unknown error"}`, "error");
  };
  // Parse CSV text into array of {date, amount, note, type} rows.
  // Handles HDFC/ICICI/SBI/generic bank statement formats.
  // Debit columns → expense, Credit columns → income.
  const parseBankCsv = (text) => {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return [];
    const parseRow = line => { const cells = []; let cur = "", inQ = false; for (const ch of line) { if (ch === '"') { inQ = !inQ; } else if (ch === ',' && !inQ) { cells.push(cur.trim()); cur = ""; } else { cur += ch; } } cells.push(cur.trim()); return cells.map(c => c.replace(/^"|"$/g, "").trim()); };
    const headers = parseRow(lines[0]).map(h => h.toLowerCase());
    const colIdx = (keywords) => headers.findIndex(h => keywords.some(k => h.includes(k)));
    const dateCol = colIdx(["date", "txn date", "trans date", "transaction date", "value date"]);
    const debitCol = colIdx(["debit", "withdrawal", "dr", "debit amount", "withdrawal amt"]);
    const creditCol = colIdx(["credit", "deposit", "cr", "credit amount", "deposit amt"]);
    const amtCol = colIdx(["amount", "amt"]);
    const descCol = colIdx(["narration", "description", "particulars", "details", "remarks", "payee", "note", "transaction description"]);
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = parseRow(lines[i]);
      if (cells.length < 2) continue;
      const rawDate = dateCol >= 0 ? cells[dateCol] : null;
      if (!rawDate) continue;
      const parsedDate = (() => { const d = new Date(rawDate); if (!Number.isNaN(d.getTime())) return localDateKey(d); const m = rawDate.match(/^(\d{2})[/-](\d{2})[/-](\d{2,4})$/); if (m) { const y = m[3].length === 2 ? "20" + m[3] : m[3]; return `${y}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`; } return null; })();
      if (!parsedDate) continue;
      const cleanAmt = v => parseFloat((v || "").replace(/[^0-9.]/g, "")) || 0;
      const debit = debitCol >= 0 ? cleanAmt(cells[debitCol]) : 0;
      const credit = creditCol >= 0 ? cleanAmt(cells[creditCol]) : 0;
      const generic = amtCol >= 0 ? cleanAmt(cells[amtCol]) : 0;
      const note = descCol >= 0 ? cells[descCol] : "";
      if (debit > 0) rows.push({ date: parsedDate, amount: debit, note, type: "expense" });
      else if (credit > 0) rows.push({ date: parsedDate, amount: credit, note, type: "income" });
      else if (generic > 0) rows.push({ date: parsedDate, amount: generic, note, type: "expense" });
    }
    return rows;
  };
  const impCsv = (file) => { const r = new FileReader(); r.onerror = () => showT("Failed to read CSV file", "error"); r.onload = e => { const rows = parseBankCsv(e.target.result); if (rows.length === 0) { showT("No valid rows found — check CSV format", "error"); return; } sCsvPreview(rows); showT(`Parsed ${rows.length} rows — review and confirm import`, "info"); }; r.readAsText(file); };
  const confirmCsvImport = () => { if (!csvPreview?.length) return; let imported = 0; csvPreview.forEach(row => { const ok = row.type === "income" ? addI({ id: uid(), amount: row.amount, sourceId: "allowance", walletId: "bank", date: row.date, note: (row.note || "").slice(0, 500) }) : addE({ id: uid(), amount: row.amount, categoryId: "food", walletId: "bank", date: row.date, note: (row.note || "").slice(0, 500) }); if (ok !== false) imported++; }); sCsvPreview(null); showT(`Imported ${imported} transactions — recategorize as needed`, "success"); };
  const loadRecentlyDeleted = async () => { sRecDelLoading(true); const [dEx, dInc, dTr, dRec, dEvs, dSp] = await Promise.all([sbGetDeleted("expenses"), sbGetDeleted("incomes"), sbGetDeleted("transfers"), sbGetDeleted("recurring"), sbGetDeleted("events"), sbGetDeleted("splits")]); const all = [...(dEx || []).map(i => ({ ...i, _tbl: "expenses" })), ...(dInc || []).map(i => ({ ...i, _tbl: "incomes" })), ...(dTr || []).map(i => ({ ...i, _tbl: "transfers" })), ...(dRec || []).map(i => ({ ...i, _tbl: "recurring" })), ...(dEvs || []).map(i => ({ ...i, _tbl: "events" })), ...(dSp || []).map(i => ({ ...i, _tbl: "splits" }))].sort((a, b) => (b.deleted_at || "").localeCompare(a.deleted_at || "")); sRecDelItems(all); sRecDelLoading(false); };
  const restoreDeleted = (item) => { const { _tbl, ...row } = item; clearVersion(_tbl, row.id); sbWrite(`${SB_URL}/rest/v1/${_tbl}?id=eq.${row.id}`, { method: "PATCH", body: { deleted_at: null } }); const clean = { ...row, deleted_at: null }; if (_tbl === "expenses") sEx(p => [...p, clean]); else if (_tbl === "incomes") sInc(p => [...p, clean]); else if (_tbl === "transfers") sTr(p => [...p, clean]); else if (_tbl === "recurring") sRec(p => [...p, clean]); else if (_tbl === "events") sEvs(p => [...p, clean]); else if (_tbl === "splits") sSp(p => [...p, clean]); sRecDelItems(p => p ? p.filter(i => i.id !== row.id) : p); showT("Restored", "success"); };
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
  const impBackup = (file) => { const r = new FileReader(); r.onerror = () => showT("Failed to read backup file", "error"); r.onload = (e) => { try { const d = JSON.parse(e.target.result); if (!d._v || !d._v.startsWith("nomad")) { showT("Invalid backup file", "error"); return } const arrFields = ["expenses", "incomes", "transfers", "settlements", "splits", "recurring", "events", "categories", "incomeSources"]; for (const f of arrFields) { if (d[f] !== undefined && !Array.isArray(d[f])) { showT(`Backup corrupt: ${f}`, "error"); return; } } sEx(d.expenses || []); sInc(d.incomes || []); sTr(d.transfers || []); sStl(d.settlements || []); sSp(d.splits || []); sRec(d.recurring || []); sEvs(d.events || []); if (d.categories?.length) sCats(d.categories); if (d.incomeSources?.length) sIsrc(d.incomeSources); if (d.darkMode !== undefined) sDm(d.darkMode); if (d.walletStartBal && typeof d.walletStartBal === "object") sWsb(d.walletStartBal); if (d.wallets?.length) sWallets(d.wallets); if (Array.isArray(d.autoRules)) sAutoRules(d.autoRules); if (d.budgets && typeof d.budgets === "object") sBudgets(d.budgets); showT("Backup restored on this device", "success") } catch { showT("Failed to read file", "error") } }; r.readAsText(file) };

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
    {localMode && localBanner && <div style={{ position: "sticky", top: 0, zIndex: 120, margin: "0 12px 10px", padding: "8px 12px", borderRadius: 14, background: "#FFF3D6", border: "1px solid #F1C96B", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}><span style={{ fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 600, color: "#7A5600" }}>📦 Local-only mode. Add credentials for cloud sync + AI.</span><div style={{ display: "flex", gap: 6, flexShrink: 0 }}><button onClick={() => setShowSetup(true)} style={{ fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 700, background: "#7C4A2A", border: "none", color: "#fff", borderRadius: 6, padding: "3px 8px", cursor: "pointer" }}>Setup</button><button onClick={() => sLocalBanner(false)} style={{ fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 600, background: "none", border: "none", color: "#7A5600", cursor: "pointer", opacity: 0.6 }}>✕</button></div></div>}
    {staleData && <div style={{ position: "sticky", top: 0, zIndex: 120, margin: "0 12px 10px", padding: "8px 12px", borderRadius: 14, background: "#EDE9FE", border: "1px solid #A78BFA50", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}><span style={{ fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 600, color: "#4C1D95" }}>Another tab updated data.</span><div style={{ display: "flex", gap: 6, flexShrink: 0 }}><button onClick={() => window.location.reload()} style={{ fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 700, background: "#7C3AED", border: "none", color: "#fff", borderRadius: 6, padding: "3px 8px", cursor: "pointer" }}>Reload</button><button onClick={() => sStaleData(false)} style={{ fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 600, background: "none", border: "none", color: "#4C1D95", cursor: "pointer", opacity: 0.6 }}>✕</button></div></div>}
    {swUpdate && <div style={{ position: "sticky", top: 0, zIndex: 121, margin: "0 12px 10px", padding: "8px 12px", borderRadius: 14, background: "#ECFDF5", border: "1px solid #6BAA7550", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}><span style={{ fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 600, color: "#065F46", display: "flex", alignItems: "center", gap: 6 }}><Confetti size={16} weight="fill" />App updated — reload to see changes.</span><div style={{ display: "flex", gap: 6, flexShrink: 0 }}><button onClick={() => window.location.reload()} style={{ fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 700, background: "#6BAA75", border: "none", color: "#fff", borderRadius: 6, padding: "3px 8px", cursor: "pointer" }}>Reload</button><button onClick={() => sSwUpdate(false)} style={{ fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 600, background: "none", border: "none", color: "#065F46", cursor: "pointer", opacity: 0.6 }}>✕</button></div></div>}


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
          const tod = new Date(), todS = localDateKey(tod), snoozed = (() => { try { return JSON.parse(localStorage.getItem("nomad-rec-snooze") || "{}"); } catch { return {}; } })(), due = rec.filter(r => isRecurringDueToday(r, todS) && !(snoozed[r.id] && snoozed[r.id] > todS));
          return due.length > 0 && <div style={{ marginBottom: 14 }}>{due.map(r => { const cat = cats.find(c => c.id === r.categoryId) || { name: r.categoryId }; const wal = wallets.find(w => w.id === r.walletId) || { name: r.walletId }; return <div key={r.id} style={{ ...cc, borderLeft: "3px solid #E07A5F", borderRadius: 14, padding: "14px 16px", marginBottom: 8 }}><div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}><Warning size={16} color="#E07A5F" weight="fill" /><div style={{ flex: 1 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{r.name} due today — {fmt(r.amount)}{(() => { const od = recurringDaysOverdue(r, todS); return od > 0 ? <span style={{ marginLeft: 6, padding: "2px 6px", borderRadius: 4, background: "#D4726A", color: "#fff", fontSize: 10, fontWeight: 600 }}>{od}d overdue</span> : null; })()}</div><div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{wal.name} → {cat.name}</div></div></div><div style={{ display: "flex", gap: 6 }}><button onClick={(ev) => { if (ev.currentTarget.disabled) return; ev.currentTarget.disabled = true; const ok = addE({ amount: r.amount, categoryId: r.categoryId, walletId: r.walletId, date: todS, note: r.name + " (recurring)", recurring: true }); if (ok === false) { ev.currentTarget.disabled = false; return; } const updated = { ...r, lastPaidDate: todS, lastSkippedDate: null }; sRec(p => p.map(x => x.id === r.id ? updated : x)); sbUpsert("recurring", [toSB(updated, COLS.recurring)], null, getVersion("recurring", r.id) ? { "If-Unmodified-Since": getVersion("recurring", r.id) } : {}); showT(r.name + " marked paid — " + fmt(r.amount), "success") }} style={{ flex: 1, padding: "8px", border: "none", borderRadius: 8, background: "#6BAA75", color: "#fff", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>✓ Paid</button><button onClick={(ev) => { if (ev.currentTarget.disabled) return; ev.currentTarget.disabled = true; const updated = { ...r, lastSkippedDate: todS }; sRec(p => p.map(x => x.id === r.id ? updated : x)); sbUpsert("recurring", [toSB(updated, COLS.recurring)], null, getVersion("recurring", r.id) ? { "If-Unmodified-Since": getVersion("recurring", r.id) } : {}); showT("Skipped for this cycle", "info") }} style={{ flex: 1, padding: "8px", border: "1.5px solid var(--border)", borderRadius: 8, background: "var(--card)", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Skip</button><button onClick={() => { const snoozeUntil = localDateKey(new Date(Date.now() + 864e5)); const snoozed = JSON.parse(localStorage.getItem("nomad-rec-snooze") || "{}"); snoozed[r.id] = snoozeUntil; localStorage.setItem("nomad-rec-snooze", JSON.stringify(snoozed)); sRec(p => [...p]); showT("Snoozed until tomorrow", "info") }} style={{ flex: 1, padding: "8px", border: "1.5px solid var(--border)", borderRadius: 8, background: "var(--card)", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Snooze</button></div></div> })}</div>
        })()}
        {loaded && ex.length === 0 && inc.length === 0 && <div style={{ ...cc, padding: "18px 20px", marginBottom: 14, borderLeft: "3px solid #7B8CDE" }}><div style={{ fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}><HandWaving size={16} weight="fill" />Welcome to NOMAD</div><div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.6, marginBottom: 12 }}>Track expenses, income, and recurring bills.<br />Tap <strong>Add</strong> below to log your first transaction.</div><div style={{ display: "flex", gap: 8 }}><button onClick={() => sTab("add")} style={{ flex: 1, padding: "9px", border: "none", borderRadius: 9, background: "#E07A5F", color: "#fff", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>+ Add Expense</button><button onClick={() => sTab("settings")} style={{ padding: "9px 14px", border: "1.5px solid var(--border)", borderRadius: 9, background: "var(--card)", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Settings</button></div></div>}
        {(() => { const saved = roundMoney(tI - tE); const savedPct = tI > 0 ? Math.round((saved / tI) * 100) : null; const periodLbl = fm === "all" ? "All time" : ml(fm); return <div style={{ ...cc, padding: "26px 22px 20px", marginBottom: 16, textAlign: "center" }}><div style={{ fontFamily: "var(--font-h)", fontSize: 11, color: "var(--muted)", letterSpacing: "1.5px", textTransform: "uppercase", fontWeight: 500 }}>Total Balance</div><div style={{ fontSize: 36, fontWeight: 700, fontFamily: "var(--font-h)", color: mBal >= 0 ? "#6BAA75" : "#E07A5F", marginTop: 6, lineHeight: 1.2 }}>{fmt(mBal)}</div><div style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-h)", marginTop: 4, letterSpacing: "0.5px" }}>Across all wallets</div><div style={{ borderTop: "1px dashed var(--border)", marginTop: 18, paddingTop: 14 }}><div style={{ fontSize: 9, color: "var(--muted)", fontFamily: "var(--font-h)", letterSpacing: "1px", fontWeight: 600, marginBottom: 8 }}>{periodLbl.toUpperCase()} CASH FLOW</div><div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 }}><div><div style={{ fontFamily: "var(--font-h)", fontSize: 9, color: "var(--muted)", letterSpacing: "0.5px", fontWeight: 600 }}>IN</div><div style={{ fontFamily: "var(--font-h)", fontSize: 14, color: "#6BAA75", marginTop: 3, fontWeight: 700 }}>+{fmt(tI)}</div></div><div style={{ borderLeft: "1px solid var(--border)", borderRight: "1px solid var(--border)", padding: "0 4px" }}><div style={{ fontFamily: "var(--font-h)", fontSize: 9, color: "var(--muted)", letterSpacing: "0.5px", fontWeight: 600 }}>OUT</div><div style={{ fontFamily: "var(--font-h)", fontSize: 14, color: "#E07A5F", marginTop: 3, fontWeight: 700 }}>−{fmt(tE)}</div></div><div><div style={{ fontFamily: "var(--font-h)", fontSize: 9, color: "var(--muted)", letterSpacing: "0.5px", fontWeight: 600 }}>{saved >= 0 ? "SAVED" : "OVERSPEND"}</div><div style={{ fontFamily: "var(--font-h)", fontSize: 14, color: saved >= 0 ? "#7B8CDE" : "#D4726A", marginTop: 3, fontWeight: 700 }}>{saved >= 0 ? "" : "−"}{fmt(Math.abs(saved))}</div>{savedPct !== null && <div style={{ fontSize: 9, color: "var(--muted)", fontFamily: "var(--font-h)", marginTop: 1, fontWeight: 600 }}>{savedPct}% of in</div>}</div></div></div></div>; })()}

        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>{wallets.map(w => { const b = roundMoney(wBal[w.id] || 0); return <div key={w.id} onClick={() => sCalW(w)} className="card-hover" style={{ ...cc, flex: 1, minWidth: 0, padding: "12px 10px", cursor: "pointer", borderLeft: `3px solid ${w.color}`, borderRadius: 14 }}><div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 8 }}><DI2 id={w.id} accent={w.neon || w.color} size={14} /><span style={{ fontSize: 8, fontFamily: "var(--font-h)", fontWeight: 600, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flex: 1 }}>{w.name}</span>{w.id === "cash" && <button onClick={e => { e.stopPropagation(); sRecountW(w); }} title="Count cash" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", fontSize: 12, padding: "1px 3px", lineHeight: 1, opacity: 0.5, flexShrink: 0 }}>⟳</button>}</div><div style={{ fontSize: 16, fontWeight: 700, fontFamily: "var(--font-h)", color: b >= 0 ? w.color : "#E07A5F" }}>{fmt(b)}</div>{(() => { const lc = calLog.find(l => l.wId === w.id); return lc ? <div style={{ fontSize: 8, color: "var(--muted)", fontFamily: "var(--font-h)", marginTop: 3, lineHeight: 1 }}>⚖ {lc.date}</div> : null; })()}</div> })}</div>

        <LionM balance={mBal} dancing={ld} aiMsg={lionMsg} aiLoading={lionMsgLoading} onTap={() => sChatOpen(true)} />
        {(() => { const sl = scoreLabel(finScore.score); return <div style={{ ...cc, padding: "10px 16px", marginBottom: 12, display: "flex", alignItems: "center", gap: 10 }}><div style={{ width: 44, height: 44, borderRadius: "50%", border: `2.5px solid ${sl.color}`, background: sl.color + "18", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><span style={{ fontFamily: "var(--font-h)", fontSize: 15, fontWeight: 800, color: sl.color }}>{finScore.score}</span></div><div style={{ flex: 1 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 700, color: "var(--text)" }}>Health Score — {sl.label}</div><div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>Savings · Bills · Spread · Logging</div></div>{finStreak > 1 && <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", borderRadius: 8, background: "#FBBF2415", border: "1px solid #FBBF24" }}><Fire size={14} weight="fill" color="#FBBF24" /><span style={{ fontFamily: "var(--font-h)", fontSize: 11, fontWeight: 700, color: "#FBBF24" }}>{finStreak}d</span></div>}</div>; })()}
        {stalePersonal.length > 0 && (() => { const owed = stalePersonal.filter(s => s.direction === "owed"); const owe = stalePersonal.filter(s => s.direction === "owe"); const owedTot = owed.reduce((t, s) => t + (s.amount - (stl||[]).filter(x => x.splitId === s.id).reduce((u, x) => u + x.amount, 0)), 0); const oweTot = owe.reduce((t, s) => t + (s.amount - (stl||[]).filter(x => x.splitId === s.id).reduce((u, x) => u + x.amount, 0)), 0); return <div onClick={() => sSpX(true)} style={{ ...cc, padding: "12px 14px", marginBottom: 12, border: "1.5px solid #F4A261", background: "#F4A26115", cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}><IconClock size={20} color="#D4726A" style={{ flexShrink: 0 }} /><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 700, color: "#D4726A" }}>{stalePersonal.length} IOU{stalePersonal.length === 1 ? "" : "s"} pending 2+ days</div><div style={{ fontSize: 11, color: "var(--ts)", fontFamily: "var(--font-b)", marginTop: 2 }}>{owed.length > 0 && <span style={{ color: "#6BAA75" }}>Owed {fmt(owedTot)}</span>}{owed.length > 0 && owe.length > 0 && " · "}{owe.length > 0 && <span style={{ color: "#E07A5F" }}>You owe {fmt(oweTot)}</span>}</div></div><IconChevronRight size={18} color="var(--muted)" /></div>; })()}
        <Splits splits={sp} settlements={stl} categories={cats} expanded={spX} onToggle={() => sSpX(!spX)} onAdd={s => { const sr = { ...s, createdAt: new Date().toISOString() }; sSp(p => [...p, sr]); sbUpsert("splits", [toSB(sr, COLS.splits)]) }} onSettle={settle} onDelete={id => { sSp(p => p.filter(s => s.id !== id)); sbDelete("splits", id); }} onSkip={id => { sSp(p => p.map(s => s.id === id ? {...s, settled: true, skipped: true} : s)); sbUpsert("splits", [{id, settled: true, skipped: true}]); showT("IOU skipped ✓"); }} wallets={wallets} walletBalances={wBal} onError={msg => showT(msg, "error")} staleSet={new Set(stalePersonal.map(s => s.id))} />
        <div onClick={() => sChatOpen(true)} style={{ ...cc, padding: "12px 14px", marginBottom: 12, cursor: "pointer", display: "flex", alignItems: "center", gap: 10, borderLeft: "3px solid #D4704A", background: dm ? "#D4704A0a" : "#D4704A08" }}><div style={{ width: 36, height: 36, borderRadius: 10, background: "#D4704A20", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Lion mood="happy" size={26} /></div><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 700, color: "#D4704A", display: "flex", alignItems: "center", gap: 6 }}>Hey, there's a chatbot! <Sparkle size={12} weight="fill" /></div><div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-b)", marginTop: 2 }}>Ask NOMAD anything — all-time data, honest answers.</div></div><IconChevronRight size={18} color="#D4704A" /></div>
        {(() => { const ninety = new Date(); ninety.setDate(ninety.getDate() - 90); const d90 = ninety.toISOString().slice(0, 10); const recentEx = ex.filter(e => String(e.date || "") >= d90); const recentInc = inc.filter(i => String(i.date || "") >= d90); const cm = localDateKey().slice(0, 7); const sl = scoreLabel(finScore.score); const generateInsights = async () => { sAiInsightsLoading(true); sAiExpandedInsight(null); try { const body = { expenses: redactTransactions(recentEx), incomes: redactTransactions(recentInc), categories: cats.map(c => ({ id: c.id, name: c.name })), wallets: wallets.map(w => ({ id: w.id, name: w.name })), month: cm }; const r = await fetch("/api/ai-insights", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const data = await r.json(); if (!r.ok) throw new Error(data.error || "AI insights failed"); const result = { ...data, ts: Date.now() }; sAiInsights(result); try { localStorage.setItem("nomad-ai-insights", JSON.stringify(result)); } catch { /* quota */ } } catch (e) { showT(e.message || "AI insights unavailable", "error"); } finally { sAiInsightsLoading(false); } }; const typeColor = { warning: "#E07A5F", tip: "#6BAA75", pattern: "#7B8CDE", achievement: "#FBBF24" }; const typeIcon = { warning: <Warning size={11} weight="fill" />, tip: <Lightbulb size={11} weight="fill" />, pattern: <ChartBar size={11} weight="fill" />, achievement: <Trophy size={11} weight="fill" /> }; return <div style={{ ...cc, padding: "12px 14px", marginBottom: 14, borderLeft: `3px solid ${sl.color}` }}><div onClick={() => sAiOpen(o => !o)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: aiOpen && aiInsights ? 10 : 0, cursor: "pointer" }}><div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}><Sparkle size={14} weight="fill" /><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: sl.color, fontWeight: 700, letterSpacing: "0.5px" }}>AI Insights</div>{aiInsights && <span style={{ fontSize: 9, color: "var(--muted)", fontFamily: "var(--font-h)", whiteSpace: "nowrap" }}>{aiInsights.insights?.length || 0} · {Math.round((Date.now() - aiInsights.ts) / 60000)}m</span>}</div><div style={{ display: "flex", alignItems: "center", gap: 6 }}><button onClick={e => { e.stopPropagation(); generateInsights(); }} disabled={aiInsightsLoading} style={{ padding: "4px 10px", borderRadius: 8, border: `1.5px solid ${sl.color}`, background: aiInsightsLoading ? "var(--border)" : sl.color + "18", color: sl.color, fontFamily: "var(--font-h)", fontSize: 10, fontWeight: 700, cursor: aiInsightsLoading ? "default" : "pointer" }}>{aiInsightsLoading ? "…" : aiInsights ? "↻" : "Generate"}</button><span style={{ fontSize: 10, color: "var(--muted)", transition: "transform 0.2s", display: "inline-block", transform: aiOpen ? "rotate(0deg)" : "rotate(-90deg)" }}>▾</span></div></div>{aiOpen && aiInsights && <>{aiInsights.summary && <div style={{ fontSize: 11, color: "var(--ts)", lineHeight: 1.5, margin: "0 0 8px", padding: "6px 8px", background: "var(--bg)", borderRadius: 6, borderLeft: `2px solid ${sl.color}` }}>{aiInsights.summary}</div>}{aiInsights.insights.map((ins, i) => { const isExpInsight = aiExpandedInsight === i; return <div key={i} onClick={() => sAiExpandedInsight(isExpInsight ? null : i)} style={{ padding: "7px 10px", borderRadius: 6, marginBottom: 5, background: (typeColor[ins.type] || "#999") + "10", borderLeft: `3px solid ${typeColor[ins.type] || "#999"}`, cursor: "pointer" }}><div style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ fontSize: 11, color: typeColor[ins.type] || "#999" }}>{typeIcon[ins.type] || "•"}</span><span style={{ fontFamily: "var(--font-h)", fontSize: 11, fontWeight: 700, color: "var(--text)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ins.title}</span><span style={{ fontSize: 8, fontFamily: "var(--font-h)", fontWeight: 600, color: typeColor[ins.type] || "#999", background: (typeColor[ins.type] || "#999") + "20", padding: "1px 4px", borderRadius: 3, flexShrink: 0 }}>{ins.severity}</span></div>{isExpInsight && <p style={{ fontSize: 11, color: "var(--ts)", margin: "5px 0 0", lineHeight: 1.45, paddingLeft: 16 }}>{ins.detail}</p>}</div>; })}<div style={{ fontSize: 9, color: "var(--muted)", textAlign: "center", marginTop: 4, fontFamily: "var(--font-h)" }}>Tap an insight to expand</div></> }</div>; })()}
        {(() => { const cm = localDateKey().slice(0, 7), mE = exAll.filter(e => mk(e.date) === cm), fixT = mE.filter(isFix).reduce((s, e) => s + e.amount, 0), flxT = mE.filter(e => !isFix(e)).reduce((s, e) => s + e.amount, 0), tot = fixT + flxT, fixP = tot > 0 ? Math.round(fixT / tot * 100) : 0, flxP = 100 - fixP; return <div style={{ ...cc, padding: "16px 18px", marginBottom: 14, position: "relative", overflow: "hidden" }}><div style={{ position: "absolute", bottom: 0, right: 0, width: 60, height: 3, borderRadius: "3px 0 0 0", background: "#A78BFA" }} /><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "#A78BFA", fontWeight: 700, letterSpacing: "0.5px" }}>Fixed vs Flexible</div><div style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-h)" }}>This Month</div></div>{tot === 0 ? <p style={{ color: "var(--muted)", fontSize: 13, textAlign: "center", padding: "8px 0" }}>No expenses this month</p> : <><div style={{ height: 8, borderRadius: 4, background: "#FBBF24", overflow: "hidden", marginBottom: 10 }}><div style={{ height: "100%", width: `${fixP}%`, background: "#A78BFA", borderRadius: 4 }} /></div><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}><div style={{ display: "flex", alignItems: "center", gap: 6 }}><div style={{ width: 8, height: 8, borderRadius: 2, background: "#A78BFA", flexShrink: 0 }} /><span style={{ fontSize: 12, fontFamily: "var(--font-h)", color: "var(--ts)" }}>Fixed</span></div><span style={{ fontSize: 12, fontFamily: "var(--font-h)", fontWeight: 600, color: "var(--text)" }}>{fmt(fixT)} <span style={{ color: "var(--muted)", fontWeight: 400 }}>({fixP}%)</span></span></div><div style={{ display: "flex", justifyContent: "space-between" }}><div style={{ display: "flex", alignItems: "center", gap: 6 }}><div style={{ width: 8, height: 8, borderRadius: 2, background: "#FBBF24", flexShrink: 0 }} /><span style={{ fontSize: 12, fontFamily: "var(--font-h)", color: "var(--ts)" }}>Flexible</span></div><span style={{ fontSize: 12, fontFamily: "var(--font-h)", fontWeight: 600, color: "var(--text)" }}>{fmt(flxT)} <span style={{ color: "var(--muted)", fontWeight: 400 }}>({flxP}%)</span></span></div></>}</div> })()}
        {budgetStatus.length > 0 && <div style={{ ...cc, padding: "16px 18px", marginBottom: 14, position: "relative", overflow: "hidden" }}><div style={{ position: "absolute", bottom: 0, right: 0, width: 60, height: 3, borderRadius: "3px 0 0 0", background: "#7B8CDE" }} /><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "#7B8CDE", fontWeight: 700, letterSpacing: "0.5px" }}>Monthly Budgets</div><button onClick={() => { sTab("settings"); sBudgetSettingsOpen(true); }} style={{ fontSize: 10, color: "#7B8CDE", fontFamily: "var(--font-h)", fontWeight: 600, background: "none", border: "none", cursor: "pointer", padding: 0 }}>Edit ›</button></div>{budgetStatus.map(({ cid, cat, spent, lim, pct }) => { const bc = pct >= 100 ? "#D4726A" : pct >= 80 ? "#FBBF24" : "#6BAA75"; return <div key={cid} style={{ marginBottom: 10 }}><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, alignItems: "center" }}><div style={{ display: "flex", alignItems: "center", gap: 6 }}><DI2 id={cid} accent={cat.neon || cat.color} size={14} /><span style={{ fontSize: 12, fontFamily: "var(--font-h)", color: "var(--text)", fontWeight: 600 }}>{cat.name}</span>{pct >= 100 && <span style={{ fontSize: 9, fontFamily: "var(--font-h)", fontWeight: 700, color: "#D4726A", background: "#D4726A15", padding: "1px 5px", borderRadius: 3 }}>OVER</span>}</div><span style={{ fontSize: 11, fontFamily: "var(--font-h)", color: bc, fontWeight: 700 }}>{fmt(spent)} / {fmt(lim)}</span></div><div style={{ height: 5, borderRadius: 3, background: "var(--border)", overflow: "hidden" }}><div style={{ height: "100%", width: `${pct}%`, background: bc, borderRadius: 3 }} /></div></div>; })}</div>}
        <SpendingBreakdown expenses={exAll} categories={cats} period={trendPeriod} onPeriodChange={sTrendPeriod} formatCurrency={fmt} darkMode={dm} />
        <div style={{ ...cc, padding: 18, marginBottom: 16, position: "relative", overflow: "hidden" }}><div style={{ position: "absolute", bottom: 0, right: 0, width: 60, height: 3, borderRadius: "3px 0 0 0", background: "#E07A5F" }} /><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "#E07A5F", marginBottom: 16, letterSpacing: "0.5px", fontWeight: 700 }}>Spending by Category</div>{fltExAll.length === 0 ? <p style={{ color: "var(--muted)", fontSize: 13, textAlign: "center", padding: 20 }}>No expenses yet</p> : (() => { const t = {}; fltExAll.forEach(e => { t[e.categoryId] = (t[e.categoryId] || 0) + e.amount }); const s = Object.entries(t).sort((a, b) => b[1] - a[1]), mx = s[0]?.[1] || 1; const curM = fm !== "all" ? fm : localDateKey().slice(0, 7); const prevDate = new Date(curM + "-01"); prevDate.setMonth(prevDate.getMonth() - 1); const prevM = prevDate.toISOString().slice(0, 7); const prevT = {}; exAll.filter(e => mk(e.date) === prevM).forEach(e => { prevT[e.categoryId] = (prevT[e.categoryId] || 0) + e.amount }); return s.map(([cid, total]) => { const c = cats.find(x => x.id === cid) || { id: cid, name: cid.split("_")[0].replace(/^\w/, l => l.toUpperCase()), color: "#6366F1", neon: "#818CF8" }; const cExps = fltExAll.filter(e => e.categoryId === cid); const realEx = cExps.filter(e => !e.__settlement); const ctag = realEx.length > 0 && realEx.every(isFix) ? "fixed" : "flexible"; const prevTotal = prevT[cid] || 0; const momPct = prevTotal > 0 ? Math.round((total - prevTotal) / prevTotal * 100) : null; const isDrilled = drillCat === cid; const allTx = isDrilled ? [...cExps].sort((a, b) => (b.date || "").localeCompare(a.date || "")) : []; return <div key={cid} style={{ marginBottom: 12 }}><div onClick={() => sDrillCat(isDrilled ? null : cid)} style={{ display: "flex", alignItems: "center", gap: 12, cursor: "pointer" }}><span style={{ width: 30, display: "flex", justifyContent: "center" }}><DI2 id={c.id} accent={c.neon || c.color} size={20} /></span><div style={{ flex: 1 }}><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}><div style={{ display: "flex", alignItems: "center" }}><span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-h)" }}>{c.name}</span><span style={{ fontSize: 8, fontFamily: "var(--font-h)", fontWeight: 600, color: ctag === "fixed" ? "#A78BFA" : "#FBBF24", background: ctag === "fixed" ? "#A78BFA15" : "#FBBF2415", padding: "2px 6px", borderRadius: 4, marginLeft: 6 }}>{ctag === "fixed" ? "FIXED" : "FLEX"}</span><span style={{ fontSize: 9, color: "var(--muted)", marginLeft: 6, fontFamily: "var(--font-h)" }}>{cExps.length} tx</span></div><div style={{ display: "flex", alignItems: "center", gap: 6 }}>{momPct !== null && <span style={{ fontSize: 9, fontFamily: "var(--font-h)", fontWeight: 700, color: momPct > 0 ? "#E07A5F" : "#6BAA75", background: momPct > 0 ? "#E07A5F15" : "#6BAA7515", padding: "1px 5px", borderRadius: 3 }}>{momPct > 0 ? "+" : ""}{momPct}% MoM</span>}<span style={{ fontSize: 13, fontFamily: "var(--font-h)", color: "var(--ts)", fontWeight: 500 }}>{fmt(total)}</span></div></div><div style={{ height: 5, borderRadius: 3, background: "var(--border)", overflow: "hidden" }}><div style={{ height: "100%", width: `${(total / mx) * 100}%`, background: c.color, borderRadius: 3 }} /></div></div><span style={{ fontSize: 10, color: "var(--muted)" }}>{isDrilled ? "▲" : "▼"}</span></div>{isDrilled && <div style={{ marginLeft: 42, marginTop: 6, padding: "8px 10px", background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)", maxHeight: 260, overflowY: "auto" }}>{allTx.length === 0 && <div style={{ fontSize: 11, color: "var(--muted)", textAlign: "center", padding: 8 }}>No entries</div>}{allTx.map(tx => <div key={tx.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, paddingBottom: 6, borderBottom: "1px dashed var(--border)" }}><div style={{ flex: 1, minWidth: 0, marginRight: 8 }}><div style={{ fontSize: 11, color: "var(--ts)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-h)", fontWeight: 600 }}>{tx.note || "(no note)"}{tx.__settlement && <span style={{ marginLeft: 5, fontSize: 8, color: "#D4726A", background: "#D4726A15", padding: "1px 4px", borderRadius: 3, fontWeight: 700 }}>SPLIT</span>}</div><div style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-b)", marginTop: 1 }}>{dl(tx.date)}</div></div><span style={{ fontSize: 12, fontFamily: "var(--font-h)", color: "var(--text)", fontWeight: 600, flexShrink: 0 }}>{fmt(tx.amount)}</span></div>)}</div>}</div> }) })()}</div>
        </div>}

      {tab === "add" && <div className="pse" style={{ paddingTop: 20 }}><AddPage categories={cats} incomeSources={isrc} recurringCats={recCats} onAddExpense={addE} onAddIncome={addI} onAddTransfer={addT} onAddRec={addRec} onError={showT} patterns={quickPatterns} autoRules={autoRules} onLearnRule={rule => { sAutoRules(prev => { if (prev.find(r => r.keyword === rule.keyword)) return prev; return [...prev, rule]; }); }} wallets={wallets} cloudinaryEnabled={!!_creds.cloudName} /></div>}
      {tab === "events" && <div className="pse" style={{ background: "transparent", padding: 0 }}><Events events={evs} expenses={ex} splits={sp} settlements={stl} categories={cats} wallets={wallets} staleByEvent={staleByEvent} onCreate={ev => { sEvs(p => [...p, ev]); sbUpsert("events", [toSB(ev, COLS.events)]) }} onAddExp={addE} onAddSplit={s => { const sr = { ...s, createdAt: new Date().toISOString() }; sSp(p => [...p, sr]); sbUpsert("splits", [toSB(sr, COLS.splits)]); showT(sr.direction === "owe" ? `You owe ${sr.name} ${fmt(sr.amount)}` : `${sr.name} owes you ${fmt(sr.amount)}`, "info") }} onSettleSplit={settle} onDeleteSplit={id => { sSp(p => p.filter(s => s.id !== id)); sbDelete("splits", id); }} onMarkDone={id => { sEvs(p => p.map(e => e.id === id ? { ...e, status: "completed" } : e)); sbUpsert("events", [{ id, status: "completed" }]) }} onDelete={id => { const ev = evs.find(e => e.id === id); if (!ev) return; sEvs(p => p.filter(e => e.id !== id)); sbDelete("events", id); showUndoToast(ev.name + " deleted", { type: "event", exp: ev }); }} dm={dm} /></div>}
      {tab === "history" && <div className="pe"><Heatmap expenses={exAll} selectedDay={hDateFrom && hDateFrom === hDateTo ? hDateFrom : null} onDayClick={d => { if (d) { sHDateFrom(d); sHDateTo(d); sHShowFilters(true); } else { sHDateFrom(""); sHDateTo(""); } }} />{(() => { const activeCount = [hSearch.trim(), hMinAmt, hMaxAmt, hDateFrom, hDateTo, hType !== "all" ? "x" : ""].filter(Boolean).length; const clearAll = () => { sHSearch(""); sHMinAmt(""); sHMaxAmt(""); sHDateFrom(""); sHDateTo(""); sHType("all"); sHShowFilters(false); }; return <div style={{ marginBottom: 14 }}><div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}><input value={hSearch} onChange={e => sHSearch(e.target.value)} placeholder="Search note, category…" style={{ ...is, flex: 1, marginBottom: 0, padding: "10px 14px" }} /><button onClick={() => { sBulkMode(v => !v); sBulkSel(new Set()); }} style={{ padding: "10px 12px", borderRadius: 10, border: `1.5px solid ${bulkMode ? "#E07A5F" : "var(--border)"}`, background: bulkMode ? "#E07A5F18" : "var(--card)", color: bulkMode ? "#E07A5F" : "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}>Select</button><button onClick={() => sHShowFilters(!hShowFilters)} style={{ padding: "10px 14px", borderRadius: 10, border: `1.5px solid ${activeCount > 0 ? "#E07A5F" : "var(--border)"}`, background: activeCount > 0 ? "#E07A5F18" : "var(--card)", color: activeCount > 0 ? "#E07A5F" : "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", gap: 5 }}>Filter{activeCount > 0 && <span style={{ background: "#E07A5F", color: "#fff", borderRadius: "50%", width: 16, height: 16, fontSize: 9, display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>{activeCount}</span>}</button>{activeCount > 0 && <button onClick={clearAll} style={{ padding: "10px 12px", borderRadius: 10, border: "1.5px solid var(--border)", background: "var(--card)", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 11, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}>Clear</button>}<button onClick={() => sHTimeline(v => !v)} style={{ padding: "10px 12px", borderRadius: 10, border: `1.5px solid ${hTimeline ? "#A78BFA" : "var(--border)"}`, background: hTimeline ? "#A78BFA18" : "var(--card)", color: hTimeline ? "#A78BFA" : "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}><Timer size={14} /></button></div>{hShowFilters && <div style={{ ...cc, padding: 14, marginBottom: 8 }}><div style={{ display: "flex", gap: 5, marginBottom: 12, flexWrap: "wrap" }}>{["all", "expense", "income", "transfer", "settlement", "recurring"].map(t => <button key={t} onClick={() => sHType(t)} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 600, border: `1.5px solid ${hType === t ? "#7B8CDE" : "var(--border)"}`, background: hType === t ? "#7B8CDE18" : "var(--card)", color: hType === t ? "#7B8CDE" : "var(--muted)", cursor: "pointer" }}>{t.charAt(0).toUpperCase() + t.slice(1)}</button>)}</div><div style={{ display: "flex", gap: 8, marginBottom: 10 }}><div style={{ flex: 1 }}><label style={{ ...ls, fontSize: 10 }}>Min ₹</label><input type="number" value={hMinAmt} onChange={e => sHMinAmt(e.target.value)} placeholder="0" style={{ ...is, padding: "8px 10px", marginBottom: 0 }} /></div><div style={{ flex: 1 }}><label style={{ ...ls, fontSize: 10 }}>Max ₹</label><input type="number" value={hMaxAmt} onChange={e => sHMaxAmt(e.target.value)} placeholder="∞" style={{ ...is, padding: "8px 10px", marginBottom: 0 }} /></div></div><div style={{ display: "flex", gap: 8 }}><div style={{ flex: 1 }}><label style={{ ...ls, fontSize: 10 }}>From Date</label><input type="date" value={hDateFrom} onChange={e => sHDateFrom(e.target.value)} style={{ ...is, padding: "8px 10px", marginBottom: 0 }} /></div><div style={{ flex: 1 }}><label style={{ ...ls, fontSize: 10 }}>To Date</label><input type="date" value={hDateTo} onChange={e => sHDateTo(e.target.value)} style={{ ...is, padding: "8px 10px", marginBottom: 0 }} /></div></div></div>}{activeCount > 0 && <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-h)", textAlign: "center", marginTop: 4 }}>{historyItems.length} result{historyItems.length !== 1 ? "s" : ""}</div>}</div>; })()}{bulkMode && bulkSel.size > 0 && <div style={{ position: "sticky", top: 0, zIndex: 10, background: "#E07A5F", color: "#fff", padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", borderRadius: 10, marginBottom: 8 }}><span style={{ fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 600 }}>{bulkSel.size} selected</span><div style={{ display: "flex", gap: 8 }}><button onClick={() => { [...bulkSel].forEach(id => { const it = historyItems.find(x => x.id === id); if (it) delItem(id, it.type); }); sBulkSel(new Set()); sBulkMode(false); showT(`Deleted ${bulkSel.size} items`, "success"); }} style={{ padding: "6px 14px", border: "none", borderRadius: 8, background: "#fff", color: "#E07A5F", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Delete {bulkSel.size}</button><button onClick={() => { sBulkMode(false); sBulkSel(new Set()); }} style={{ padding: "6px 12px", border: "1.5px solid rgba(255,255,255,0.5)", borderRadius: 8, background: "transparent", color: "#fff", fontFamily: "var(--font-h)", fontSize: 12, cursor: "pointer" }}>Cancel</button></div></div>}
{historyItems.map(it => { const tlBal = hTimeline ? timelineData[it.id] : null; const hasSB = hTimeline && (it.balBefore !== undefined || it.fromBalBefore !== undefined); const showTL = tlBal || hasSB; const tlWallets = showTL ? (it.type === "transfer" ? [{ id: it.fromWallet }, { id: it.toWallet }] : [{ id: it.type === "expense" ? (it.walletId || "upi_lite") : it.type === "income" ? (it.walletId || "bank") : it.walletId }]) : []; return <div key={it.id} style={{ position: "relative", ...(hTimeline ? { paddingLeft: 28, marginBottom: 4 } : {}) }}>{hTimeline && <div style={{ position: "absolute", left: 10, top: 0, bottom: 0, width: 2, background: "var(--border)" }} />}{hTimeline && <div style={{ position: "absolute", left: 5, top: 22, width: 12, height: 12, borderRadius: "50%", background: it.type === "expense" ? "#E07A5F" : it.type === "income" ? "#6BAA75" : "#7B8CDE", border: "2px solid var(--bg)", zIndex: 1 }} />}<div style={{ display: "flex", alignItems: "stretch", gap: 6 }}>{bulkMode && <div onClick={() => sBulkSel(p => { const n = new Set(p); n.has(it.id) ? n.delete(it.id) : n.add(it.id); return n; })} style={{ display: "flex", alignItems: "center", padding: "0 4px", cursor: "pointer", flexShrink: 0 }}><div style={{ width: 20, height: 20, borderRadius: 5, border: `2px solid ${bulkSel.has(it.id) ? "#E07A5F" : "var(--border)"}`, background: bulkSel.has(it.id) ? "#E07A5F" : "var(--card)", display: "flex", alignItems: "center", justifyContent: "center" }}>{bulkSel.has(it.id) && <span style={{ color: "#fff", fontSize: 11, fontWeight: 700 }}>✓</span>}</div></div>}<div style={{ flex: 1, minWidth: 0 }}><TxCard item={it} categories={cats} incomeSources={isrc} events={evs} onDelete={delItem} recurringCats={recCats} wallets={wallets} onRefund={refundItem} />{showTL && <div style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "0 4px 10px 4px", marginTop: -4 }}>{tlWallets.map(tw => { const wName = wallets.find(w => w.id === tw.id)?.name || tw.id; let bef, aft; if (it.type === "transfer" && it.fromBalBefore !== undefined) { bef = tw.id === it.fromWallet ? it.fromBalBefore : (it.toBalBefore ?? 0); aft = tw.id === it.fromWallet ? roundMoney(it.fromBalBefore - it.amount) : roundMoney((it.toBalBefore ?? 0) + it.amount); } else if (it.balBefore !== undefined) { bef = it.balBefore; aft = roundMoney(it.balBefore + (it.type === "expense" ? -it.amount : it.amount)); } else { bef = tlBal?.before[tw.id] ?? 0; aft = tlBal?.after[tw.id] ?? 0; } return <div key={tw.id} style={{ fontSize: 10, fontFamily: "var(--font-h)", color: "var(--muted)", background: "var(--bg)", borderRadius: 6, padding: "3px 8px", display: "inline-flex", alignItems: "center", gap: 5, border: "1px solid var(--border)" }}><span style={{ fontWeight: 600, color: "var(--ts)", fontSize: 9 }}>{wName}</span><span>{fmt(bef)}</span><span style={{ opacity: 0.4, fontSize: 9 }}>→</span><span style={{ fontWeight: 700, color: bef > aft ? "#E07A5F" : bef < aft ? "#6BAA75" : "var(--muted)" }}>{fmt(aft)}</span></div>; })}</div>}</div></div></div>; })}{historyItems.length === 0 && <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--muted)", fontSize: 14, lineHeight: 1.8 }}>{flt.expenses.length === 0 && flt.incomes.length === 0 ? <><div style={{ marginBottom: 12 }}><ClipboardText size={32} color="var(--muted)" /></div><div style={{ fontFamily: "var(--font-h)", fontSize: 15, fontWeight: 600, color: "var(--ts)", marginBottom: 6 }}>No transactions yet</div><div style={{ fontSize: 12, marginBottom: 20 }}>Log expenses, income, and transfers<br />to see your spending history here.</div><button onClick={() => sTab("add")} style={{ padding: "12px 28px", border: "none", borderRadius: 12, background: "#E07A5F", color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>+ Add First Transaction</button></> : "No results match your filters."}</div>}</div>}

      {tab === "settings" && <div className="pe" style={{ paddingTop: 8 }}>
        <div style={{ ...cc, padding: "16px 18px", marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between" }}><div><div style={{ fontFamily: "var(--font-h)", fontSize: 13, color: "var(--text)", fontWeight: 600 }}>{dm ? <Moon size={16} weight="bold" /> : <Sun size={16} weight="bold" />} Dark Mode</div><div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{dm ? "Dark" : "Light"}</div></div><div onClick={() => sDm(!dm)} style={{ width: 48, height: 26, borderRadius: 13, background: dm ? "#E07A5F" : "var(--border)", cursor: "pointer", position: "relative" }}><div style={{ width: 20, height: 20, borderRadius: "50%", background: "#fff", position: "absolute", top: 3, left: dm ? 25 : 3, transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.15)" }} /></div></div>
        <div style={{ ...cc, padding: "14px 20px", marginBottom: 14, borderLeft: "3px solid #FBBF24" }}><div onClick={() => sWalletsMgrOpen(v => !v)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}><div style={{ display: "flex", alignItems: "center", gap: 8 }}><Wallet size={16} weight="fill" /><div style={{ fontFamily: "var(--font-h)", fontSize: 13, color: "#FBBF24", letterSpacing: "0.5px", fontWeight: 700 }}>Wallets</div></div><span style={{ fontSize: 11, color: "#FBBF24", fontWeight: 700 }}>{walletsMgrOpen ? "▲" : "▼"}</span></div>{walletsMgrOpen && <div style={{ marginTop: 16 }}><p style={{ fontSize: 11, color: "var(--muted)", marginBottom: 12, lineHeight: 1.6 }}>Add custom wallets (GPay, Credit Card, FD…). Existing transactions are preserved.</p>{wallets.map(w => <div key={w.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: "var(--bg)", borderRadius: 10, marginBottom: 6, border: `1px solid ${w.color}30` }}><div style={{ width: 10, height: 10, borderRadius: "50%", background: w.color, flexShrink: 0 }} />{editingCat?.id === ("wallet_" + w.id) ? <input value={editingCat.name} onChange={e => sEditingCat(p => ({ ...p, name: e.target.value }))} onBlur={() => { if (editingCat.name.trim()) { sWallets(p => p.map(x => x.id === w.id ? { ...x, name: editingCat.name.trim() } : x)); } sEditingCat(null); }} onKeyDown={e => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") sEditingCat(null); }} autoFocus style={{ flex: 1, padding: "4px 8px", borderRadius: 6, border: "1.5px solid #FBBF24", background: "var(--bg)", color: "var(--text)", fontSize: 12, fontFamily: "var(--font-h)", outline: "none" }} /> : <span style={{ flex: 1, fontSize: 12, fontFamily: "var(--font-h)", color: "var(--text)", fontWeight: 500 }}>{w.name}{w.desc ? <span style={{ color: "var(--muted)", fontWeight: 400, marginLeft: 4 }}>· {w.desc}</span> : null}</span>}<button onClick={() => sEditingCat({ id: "wallet_" + w.id, name: w.name })} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 12, padding: "2px 4px", opacity: 0.6 }}>✏</button>{!WALLETS.find(d => d.id === w.id) && <button onClick={() => { const refCount = ex.filter(e => e.walletId === w.id).length + inc.filter(i => i.walletId === w.id).length + tr.filter(t => t.fromWallet === w.id || t.toWallet === w.id).length + stl.filter(s => s.walletId === w.id).length; const bal = roundMoney(wBal[w.id] || 0); if (refCount > 0 || bal !== 0) { showT(`"${w.name}" has ${refCount} transaction${refCount === 1 ? "" : "s"}${bal !== 0 ? ` and ${fmt(bal)} balance` : ""}. Transfer the balance out and reassign or delete the transactions first.`, "error"); return; } if (window.confirm(`Delete wallet "${w.name}"? No transactions reference it.`)) sWallets(p => p.filter(x => x.id !== w.id)); }} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 14, padding: "2px 6px", opacity: 0.5 }}>✕</button>}</div>)}<div style={{ borderTop: "1px solid var(--border)", marginTop: 12, paddingTop: 12 }}><label style={{ ...ls, fontSize: 10 }}>Add Wallet</label><div style={{ display: "flex", gap: 6, marginBottom: 8 }}><input value={newWalletName} onChange={e => sNewWalletName(e.target.value)} placeholder="Name (e.g. GPay)…" style={{ ...is, flex: 1, padding: "8px 10px", marginBottom: 0 }} /><input type="color" value={newWalletColor} onChange={e => sNewWalletColor(e.target.value)} style={{ width: 42, height: 42, border: "none", cursor: "pointer", borderRadius: 8, flexShrink: 0 }} /></div><label style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-h)", cursor: "pointer" }}><input type="checkbox" checked={newWalletUL} onChange={e => sNewWalletUL(e.target.checked)} style={{ cursor: "pointer" }} />UPI Lite-style (spend-only, ₹5K cap)</label><button onClick={() => { if (!newWalletName.trim()) return; const id = "w_" + newWalletName.trim().toLowerCase().replace(/\s+/g, "_") + "_" + Date.now().toString(36); sWallets(p => [...p, { id, name: newWalletName.trim(), color: newWalletColor, neon: newWalletColor, desc: newWalletUL ? "spend-only · ₹5000 cap" : "", upiLite: newWalletUL || undefined }]); sNewWalletName(""); sNewWalletColor("#A78BFA"); sNewWalletUL(false); showT(newWalletName.trim() + " wallet added", "success"); }} style={{ width: "100%", padding: "10px", border: "none", borderRadius: 10, background: "#FBBF24", color: "#000", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>+ Add Wallet</button></div></div>}</div>
        <div style={{ ...cc, padding: "14px 20px", marginBottom: 14, borderLeft: "3px solid #7B8CDE", background: budgetSettingsOpen ? (dm ? "#7B8CDE0a" : "#7B8CDE08") : "var(--card)" }}><div onClick={() => sBudgetSettingsOpen(v => !v)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}><div style={{ display: "flex", alignItems: "center", gap: 8 }}><Target size={16} weight="fill" /><div style={{ fontFamily: "var(--font-h)", fontSize: 13, color: "#7B8CDE", letterSpacing: "0.5px", fontWeight: 700 }}>Budgets</div></div><span style={{ fontSize: 11, color: "#7B8CDE", fontWeight: 700 }}>{budgetSettingsOpen ? "▲" : "▼"}</span></div>{budgetSettingsOpen && <div style={{ marginTop: 16 }}><p style={{ fontSize: 11, color: "var(--muted)", marginBottom: 14, lineHeight: 1.6 }}>Monthly spending limits per category. Leave 0 or empty for no limit.</p>{cats.map(c => { const lim = budgets[c.id] || ""; return <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}><DI2 id={c.id} accent={c.neon || c.color} size={16} /><span style={{ flex: 1, fontSize: 12, fontFamily: "var(--font-h)", color: "var(--text)", fontWeight: 500 }}>{c.name}</span><input type="number" min="0" value={lim} onChange={e => { const v = parseFloat(e.target.value) || 0; const nb = { ...budgets }; if (v <= 0) delete nb[c.id]; else nb[c.id] = v; sBudgets(nb); }} placeholder="₹ limit" style={{ width: 90, padding: "7px 10px", borderRadius: 8, border: `1.5px solid ${budgets[c.id] ? "#7B8CDE" : "var(--border)"}`, background: "var(--bg)", color: "var(--text)", fontSize: 12, fontFamily: "var(--font-b)", textAlign: "right", outline: "none", boxSizing: "border-box" }} /></div>; })}{Object.keys(budgets).length > 0 && <button onClick={() => sBudgets({})} style={{ width: "100%", marginTop: 8, padding: "9px", border: "1.5px solid #D4726A", borderRadius: 10, background: "#D4726A12", color: "#D4726A", fontFamily: "var(--font-h)", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>Clear All Budgets</button>}</div>}</div>
        <div style={{ ...cc, padding: "14px 20px", marginBottom: 14, borderLeft: "3px solid #6BAA75" }}><div onClick={() => sAutoRulesOpen(v => !v)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}><div style={{ display: "flex", alignItems: "center", gap: 8 }}><Lightning size={16} weight="fill" /><div style={{ fontFamily: "var(--font-h)", fontSize: 13, color: "#6BAA75", letterSpacing: "0.5px", fontWeight: 700 }}>Autocategorize Rules</div></div><span style={{ fontSize: 11, color: "#6BAA75", fontWeight: 700 }}>{autoRulesOpen ? "▲" : "▼"}</span></div>{autoRulesOpen && <div style={{ marginTop: 16 }}><p style={{ fontSize: 11, color: "var(--muted)", marginBottom: 12, lineHeight: 1.6 }}>When note matches a keyword, category is set automatically.</p>{autoRules.map((r, i) => <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}><span style={{ fontSize: 12, fontFamily: "var(--font-h)", flex: 1, color: "var(--text)", fontWeight: 500 }}>"{r.keyword}" → {cats.find(c => c.id === r.categoryId)?.name || r.categoryId}</span><button onClick={() => sAutoRules(p => p.filter((_, j) => j !== i))} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 14, opacity: 0.5, padding: "2px 4px" }}>✕</button></div>)}<div style={{ display: "flex", gap: 6, marginTop: 10 }}><input value={newRuleKw} onChange={e => sNewRuleKw(e.target.value)} placeholder="keyword…" style={{ ...is, flex: 1, padding: "8px 10px", marginBottom: 0 }} /><select value={newRuleCat} onChange={e => sNewRuleCat(e.target.value)} style={{ flex: 1, padding: "8px 10px", borderRadius: 10, border: "1.5px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 12, fontFamily: "var(--font-h)", outline: "none" }}><option value="">Pick category</option>{cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><button onClick={() => { if (!newRuleKw.trim() || !newRuleCat) return; sAutoRules(p => [...p, { keyword: newRuleKw.trim().toLowerCase(), categoryId: newRuleCat }]); sNewRuleKw(""); sNewRuleCat(""); }} style={{ padding: "8px 14px", border: "none", borderRadius: 10, background: "#6BAA75", color: "#fff", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Add</button></div></div>}</div>
        <div style={{ ...cc, padding: "14px 20px", marginBottom: 14, borderLeft: "3px solid #c9a96e", background: reportOpen ? (dm ? "#c9a96e0a" : "#c9a96e08") : "var(--card)" }}>
          <div onClick={() => { if (!reportOpen) loadReportSchedule(); sReportOpen(v => !v); }} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Envelope size={16} weight="fill" />
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
            }} disabled={reportSaving} style={{ width: "100%", padding: "10px", border: "1.5px solid #7B8CDE", borderRadius: 10, background: "#7B8CDE12", color: "#7B8CDE", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: reportSaving ? "not-allowed" : "pointer" }}><Envelope size={13} weight="fill" style={{ marginRight: 5 }} />Send Now</button>}
          </div>}
        </div>
        <div style={{ ...cc, padding: 20, marginBottom: 14 }}>
          <div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "var(--muted)", marginBottom: 14, letterSpacing: "0.5px", fontWeight: 600 }}>Recurring ({rec.length})</div>
          {subSuggestions.length > 0 && <div style={{ marginBottom: 14, padding: "12px 14px", background: "var(--bg)", borderRadius: 10, border: "1px dashed #A78BFA" }}><div onClick={() => sSubSugOpen(o => !o)} style={{ fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 700, color: "#A78BFA", marginBottom: subSugOpen ? 8 : 0, cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}><span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Lightbulb size={12} weight="fill" />Possible recurring patterns ({subSuggestions.length})</span><span style={{ fontSize: 10, opacity: 0.7 }}>{subSugOpen ? "▲" : "▼"}</span></div>{subSugOpen && subSuggestions.map(s => { const c = cats.find(x => x.id === s.categoryId) || { name: s.categoryId, color: "#999" }; return <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 12, fontFamily: "var(--font-h)", fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</div><div style={{ fontSize: 10, color: "var(--muted)" }}>{s.count}× in 90d · avg {fmt(s.avgAmt)} · {c.name}</div></div><button onClick={() => { addRec({ id: uid(), name: s.name, amount: s.avgAmt, categoryId: s.categoryId, walletId: s.walletId, frequency: "monthly", dayOfMonth: new Date().getDate(), startDate: localDateKey(), active: true }); showT(s.name + " added to recurring", "success"); }} style={{ padding: "5px 10px", border: "1.5px solid #A78BFA", borderRadius: 8, background: "#A78BFA12", color: "#A78BFA", fontFamily: "var(--font-h)", fontSize: 11, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}>Promote ›</button></div>; })}</div>}
          {rec.length === 0 && <p style={{ fontSize: 12, color: "var(--muted)", textAlign: "center", padding: "12px 0", fontStyle: "italic" }}>No recurring expenses set up yet.</p>}
          {rec.map(r => {
            const rc = RC.find(c => c.id === r.categoryId) || recCats.find(c => c.id === r.categoryId) || { name: r.categoryName || r.categoryId, color: "#8A8A9A", neon: "#A0A0B0", id: r.categoryId };
            const ordSuf = n => { const v = n % 100; if (v >= 11 && v <= 13) return "th"; const u = n % 10; return u === 1 ? "st" : u === 2 ? "nd" : u === 3 ? "rd" : "th"; };
            const fl = r.frequency === "monthly" ? `Every month on the ${r.dayOfMonth}${ordSuf(r.dayOfMonth)}` : r.frequency === "yearly" ? `Yearly on ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][(r.yearMonth || 1) - 1]} ${r.yearDay}` : `Every ${r.intervalDays} days`;
            const accent = rc.neon || rc.color;
            return (
              <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "var(--bg)", borderRadius: 10, marginBottom: 6, border: "1px solid var(--border)", opacity: r.active ? 1 : 0.5 }}>
                <DI2 id={rc.id} accent={accent} size={18} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, fontFamily: "var(--font-h)", color: "var(--text)" }}>{r.name} — {fmt(r.amount)}</div>
                  <div style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-b)", marginTop: 1 }}>{fl}{(() => { const ts = localDateKey(), pd = r.lastPaidDate, sk = r.lastSkippedDate, m = ts.slice(0,7), y = ts.slice(0,4), due = getRecurringDueDate(r, ts); const paidNow = r.frequency === "monthly" ? pd?.slice(0,7) === m : r.frequency === "yearly" ? pd?.slice(0,4) === y : pd && due && pd === due; const skipNow = r.frequency === "monthly" ? sk?.slice(0,7) === m : r.frequency === "yearly" ? sk?.slice(0,4) === y : sk && due && sk === due; if (!paidNow && !skipNow) return null; const resetCycle = () => { const updated = { ...r, lastPaidDate: null, lastSkippedDate: null }; sRec(p => p.map(x => x.id === r.id ? updated : x)); sbUpsert("recurring", [toSB(updated, COLS.recurring)]); showT(r.name + " cycle reset — will show as due again", "info"); }; return <span style={{ display: "inline-flex", alignItems: "center", gap: 3, marginLeft: 6 }}><span style={{ padding: "1px 5px", borderRadius: 3, background: paidNow ? "#6BAA7522" : "#FBBF2422", color: paidNow ? "#6BAA75" : "#FBBF24", fontFamily: "var(--font-h)", fontWeight: 600, fontSize: 9 }}>{paidNow ? "✓ Paid" : "Skipped"}</span><button onClick={resetCycle} style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 10, cursor: "pointer", padding: "1px 3px", lineHeight: 1, opacity: 0.7 }} title="Reset this cycle">↺</button></span>; })()}</div>
                </div>
                {/* edit pencil */}
                <button onClick={() => { sRecDelConfirm(null); sRecEditId(r.id); }} style={{ background: "none", border: "none", padding: "4px 6px", cursor: "pointer", flexShrink: 0, opacity: 0.55, display: "flex", alignItems: "center" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#A78BFA" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                </button>
                {/* active toggle */}
                <div onClick={() => { let updatedRow = null; sRec(prev => { const next = prev.map(x => x.id === r.id ? { ...x, active: !x.active } : x); updatedRow = next.find(x => x.id === r.id); return next; }); if (updatedRow) sbUpsert("recurring", [toSB(updatedRow, COLS.recurring)]); }} style={{ width: 36, height: 20, borderRadius: 10, background: r.active ? "#A78BFA" : "var(--border)", cursor: "pointer", position: "relative", flexShrink: 0 }}>
                  <div style={{ width: 14, height: 14, borderRadius: "50%", background: "#fff", position: "absolute", top: 3, left: r.active ? 19 : 3, transition: "left 0.2s" }} />
                </div>
                {recDelConfirm === r.id
                  ? <div style={{ display: "flex", gap: 4, flexShrink: 0, alignItems: "center" }}>
                    <span style={{ fontSize: 10, color: "#D4726A", fontFamily: "var(--font-h)", fontWeight: 600, whiteSpace: "nowrap" }}>Delete?</span>
                    <button onClick={() => sRecDelConfirm(null)} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, padding: "3px 8px", fontSize: 10, color: "var(--muted)", cursor: "pointer", fontFamily: "var(--font-h)", fontWeight: 600 }}>No</button>
                    <button onClick={() => { sRec(p => p.filter(x => x.id !== r.id)); sbDelete("recurring", r.id); sRecDelConfirm(null); showUndoToast(r.name + " deleted", { type: "recurring", exp: r }); }} style={{ background: "#D4726A", border: "none", borderRadius: 6, padding: "3px 8px", fontSize: 10, color: "#fff", cursor: "pointer", fontFamily: "var(--font-h)", fontWeight: 600 }}>Yes</button>
                  </div>
                  : <button onClick={() => sRecDelConfirm(r.id)} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 14, opacity: 0.5, flexShrink: 0 }}>✕</button>
                }
              </div>
            );
          })}
        </div>
        {(() => { const list = mt === "expense" ? cats : isrc; const shown = manageXp ? list : list.slice(0, 2); return <div style={{ ...cc, padding: 20, marginBottom: 14 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "var(--muted)", marginBottom: 14, letterSpacing: "0.5px", fontWeight: 600 }}>Manage</div><div style={{ display: "flex", gap: 6, marginBottom: 16 }}>{["expense", "income", "recurring"].map(t => <button key={t} onClick={() => { sMt(t); sManageXp(false) }} style={{ flex: 1, padding: "9px", borderRadius: 10, fontSize: 11, fontFamily: "var(--font-h)", border: `1.5px solid ${mt === t ? (t === "expense" ? "#E07A5F" : t === "income" ? "#6BAA75" : "#A78BFA") : "var(--border)"}`, background: mt === t ? (t === "expense" ? "#E07A5F" : t === "income" ? "#6BAA75" : "#A78BFA") : "var(--card)", color: mt === t ? "#fff" : "var(--muted)", cursor: "pointer", fontWeight: 500 }}>{t === "expense" ? "Categories" : t === "income" ? "Income" : "Recurring"}</button>)}</div>{mt === "recurring" ? <>{(manageXp ? recCats : recCats.slice(0, 2)).map(c => <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "var(--bg)", borderRadius: 10, marginBottom: 6, border: "1px solid var(--border)" }}><DI2 id={c.id} accent={c.neon || c.color} size={18} /><span style={{ flex: 1, fontSize: 13, color: "var(--text)", fontWeight: 500, fontFamily: "var(--font-h)" }}>{c.name}</span><span style={{ width: 14, height: 14, borderRadius: "50%", background: c.color, flexShrink: 0 }} /><button onClick={() => { if (RC.find(d => d.id === c.id)) return; sRecCats(p => p.filter(x => x.id !== c.id)); }} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 14, padding: "2px 6px", opacity: RC.find(d => d.id === c.id) ? 0.15 : 0.5 }}>✕</button></div>)}{recCats.length > 2 && <button onClick={() => sManageXp(!manageXp)} style={{ width: "100%", padding: "8px", border: "1px dashed var(--border)", borderRadius: 8, background: "none", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, cursor: "pointer", marginBottom: 6 }}>{manageXp ? `Show less ▲` : `Show all ${recCats.length} ▼`}</button>}<div style={{ borderTop: "1px solid var(--border)", marginTop: 14, paddingTop: 14 }}><label style={ls}>Add New</label><div style={{ display: "flex", gap: 6, marginBottom: 10 }}><input value={ne2} onChange={e => sNE2(e.target.value)} maxLength={2} style={{ ...is, width: 48, textAlign: "center", flexShrink: 0 }} /><input value={nn} onChange={e => sNN(e.target.value)} placeholder="Name…" style={is} /><input type="color" value={nc} onChange={e => sNC(e.target.value)} style={{ width: 42, height: 42, border: "none", cursor: "pointer", borderRadius: 8, flexShrink: 0 }} /></div><button onClick={() => { if (!nn.trim()) return; const id = nn.trim().toLowerCase().replace(/\s+/g, "_") + "_" + uid(); sRecCats(p => [...p, { id, name: nn.trim(), emoji: ne2, color: nc, neon: nc }]); sNN(""); sNE2("📁"); sNC("#E07A5F"); }} style={{ width: "100%", padding: "11px", border: "none", borderRadius: 10, background: "#A78BFA", color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, cursor: "pointer", fontWeight: 600 }}>+ Add Category</button></div></> : <>{shown.map(c => <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "var(--bg)", borderRadius: 10, marginBottom: 6, border: "1px solid var(--border)" }}><DI2 id={c.id} accent={c.neon || c.color} size={18} />{editingCat?.id === c.id ? <input value={editingCat.name} onChange={e => sEditingCat(p => ({ ...p, name: e.target.value }))} onBlur={() => { if (editingCat.name.trim()) { if (mt === "expense") sCats(p => p.map(x => x.id === c.id ? { ...x, name: editingCat.name.trim() } : x)); else sIsrc(p => p.map(x => x.id === c.id ? { ...x, name: editingCat.name.trim() } : x)); } sEditingCat(null); }} onKeyDown={e => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") sEditingCat(null); }} autoFocus style={{ flex: 1, padding: "4px 8px", borderRadius: 6, border: "1.5px solid #7B8CDE", background: "var(--bg)", color: "var(--text)", fontSize: 13, fontFamily: "var(--font-h)", outline: "none" }} /> : <span onClick={() => sEditingCat({ id: c.id, name: c.name })} style={{ flex: 1, fontSize: 13, color: "var(--text)", fontWeight: 500, fontFamily: "var(--font-h)", cursor: "text" }}>{c.name}</span>}{(() => { const n = mt === "expense" ? ex.filter(e => e.categoryId === c.id).length : inc.filter(i => i.sourceId === c.id).length; return n > 0 ? <span style={{ fontSize: 9, color: "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 600, flexShrink: 0 }}>{n} txn{n !== 1 ? "s" : ""}</span> : null; })()}<span style={{ width: 14, height: 14, borderRadius: "50%", background: c.color }} /><button onClick={() => { const orphans = mt === "expense" ? ex.filter(e => e.categoryId === c.id).length : inc.filter(i => i.sourceId === c.id).length; if (mt === "expense") sCats(p => p.filter(x => x.id !== c.id)); else sIsrc(p => p.filter(x => x.id !== c.id)); if (orphans > 0) showT(`⚠ ${orphans} transaction${orphans !== 1 ? "s" : ""} now show as Unknown`, "info"); }} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 14, padding: "2px 6px", opacity: 0.5 }}>✕</button></div>)}{list.length > 2 && <button onClick={() => sManageXp(!manageXp)} style={{ width: "100%", padding: "8px", border: "1px dashed var(--border)", borderRadius: 8, background: "none", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, cursor: "pointer", marginBottom: 6 }}>{manageXp ? `Show less ▲` : `Show all ${list.length} ▼`}</button>}<div style={{ borderTop: "1px solid var(--border)", marginTop: 14, paddingTop: 14 }}><label style={ls}>Add New</label><div style={{ display: "flex", gap: 6, marginBottom: 10 }}><input value={ne2} onChange={e => sNE2(e.target.value)} maxLength={2} style={{ ...is, width: 48, textAlign: "center", flexShrink: 0 }} /><input value={nn} onChange={e => sNN(e.target.value)} placeholder="Name…" style={is} /><input type="color" value={nc} onChange={e => sNC(e.target.value)} style={{ width: 42, height: 42, border: "none", cursor: "pointer", borderRadius: 8, flexShrink: 0 }} /></div><button onClick={addCust} style={{ width: "100%", padding: "11px", border: "none", borderRadius: 10, background: "#7B8CDE", color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, cursor: "pointer", fontWeight: 600 }}>+ Add {mt === "expense" ? "Category" : "Source"}</button></div></>}</div> })()}
        <div style={{ ...cc, padding: 20, marginBottom: 14 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "var(--muted)", marginBottom: 14, letterSpacing: "0.5px", fontWeight: 600 }}>Export</div><button onClick={expCSV} style={{ width: "100%", padding: "13px", border: "none", borderRadius: 10, background: "#E07A5F", color: "#fff", fontFamily: "var(--font-h)", fontSize: 14, cursor: "pointer", fontWeight: 600 }}>Download CSV</button><p style={{ fontSize: 12, color: "var(--muted)", marginTop: 10, lineHeight: 1.6, fontStyle: "italic" }}>Upload to ChatGPT or Claude for analysis.</p></div>
        <div style={{ ...cc, padding: 20, marginBottom: 14 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "var(--muted)", marginBottom: 14, letterSpacing: "0.5px", fontWeight: 600 }}>Backup & Restore</div><div style={{ display: "flex", gap: 8, marginBottom: 8 }}><button onClick={expBackup} style={{ flex: 1, padding: "13px", border: "none", borderRadius: 10, background: "#6BAA75", color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, cursor: "pointer", fontWeight: 600 }}>Backup</button><label style={{ flex: 1, padding: "13px", border: "1.5px solid #7B8CDE", borderRadius: 10, background: "#7B8CDE12", color: "#7B8CDE", fontFamily: "var(--font-h)", fontSize: 13, cursor: "pointer", fontWeight: 600, textAlign: "center" }}>Restore<input type="file" accept=".json" onChange={e => { if (e.target.files[0]) impBackup(e.target.files[0]); e.target.value = "" }} style={{ display: "none" }} /></label></div><label style={{ display: "block", width: "100%", padding: "11px", border: "1.5px solid #c9a96e", borderRadius: 10, background: "#c9a96e12", color: "#c9a96e", fontFamily: "var(--font-h)", fontSize: 13, cursor: "pointer", fontWeight: 600, textAlign: "center", marginBottom: 8, boxSizing: "border-box" }}>Import Bank CSV<input type="file" accept=".csv" onChange={e => { if (e.target.files[0]) impCsv(e.target.files[0]); e.target.value = ""; }} style={{ display: "none" }} /></label>{csvPreview && <div style={{ background: "var(--bg)", borderRadius: 10, padding: "12px 14px", marginBottom: 8, border: "1px solid #c9a96e40" }}><div style={{ fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 700, color: "#c9a96e", marginBottom: 8 }}>PREVIEW — {csvPreview.length} ROWS</div>{csvPreview.slice(0, 4).map((r, i) => <div key={i} style={{ fontSize: 11, color: "var(--ts)", marginBottom: 4, display: "flex", gap: 8, justifyContent: "space-between" }}><span style={{ color: r.type === "income" ? "#6BAA75" : "#E07A5F", fontWeight: 700, flexShrink: 0 }}>{r.type === "income" ? "+" : "−"}₹{r.amount}</span><span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.note || "—"}</span><span style={{ flexShrink: 0 }}>{r.date}</span></div>)}{csvPreview.length > 4 && <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 4 }}>…and {csvPreview.length - 4} more</div>}<div style={{ fontSize: 10, color: "var(--muted)", marginTop: 6, marginBottom: 8 }}>Expenses → Food category, Bank wallet. Income → Allowance source. Recategorize after import.</div><div style={{ display: "flex", gap: 8 }}><button onClick={confirmCsvImport} style={{ flex: 2, padding: "10px", border: "none", borderRadius: 8, background: "#6BAA75", color: "#fff", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Import {csvPreview.length} transactions</button><button onClick={() => sCsvPreview(null)} style={{ flex: 1, padding: "10px", border: "1.5px solid var(--border)", borderRadius: 8, background: "transparent", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, cursor: "pointer" }}>Cancel</button></div></div>}<p style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.6, fontStyle: "italic" }}>Backup saves all data as JSON. Restore replaces current data. Import CSV adds bank statement transactions.</p></div>
        <div style={{ ...cc, padding: "14px 20px", marginBottom: 14 }}><div onClick={() => sBackendOpen(v => !v)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "var(--muted)", letterSpacing: "0.5px", fontWeight: 600 }}>Backend</div><span style={{ fontSize: 11, color: "var(--muted)" }}>{backendOpen ? "▲" : "▼"}</span></div>{backendOpen && <div style={{ marginTop: 14 }}><div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}><div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "var(--bg)", borderRadius: 10, border: "1px solid var(--border)" }}><div style={{ width: 8, height: 8, borderRadius: "50%", background: _creds.sbUrl ? "#6BAA75" : "#FBBF24", flexShrink: 0 }} /><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 11, fontWeight: 700, fontFamily: "var(--font-h)", color: "var(--text)" }}>Supabase</div><div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-b)", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{_creds.sbUrl ? _creds.sbUrl.replace("https://", "").replace(".supabase.co", "") + ".supabase.co" : "Not configured"}</div></div></div><div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "var(--bg)", borderRadius: 10, border: "1px solid var(--border)" }}><div style={{ width: 8, height: 8, borderRadius: "50%", background: _creds.cloudName ? "#6BAA75" : "#FBBF24", flexShrink: 0 }} /><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 11, fontWeight: 700, fontFamily: "var(--font-h)", color: "var(--text)" }}>Cloudinary</div><div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-b)", marginTop: 1 }}>{_creds.cloudName ? (_creds.apiKey ? _creds.cloudName + " (signed)" : _creds.cloudName + " (unsigned preset)") : "Not configured"}</div></div></div></div><div style={{ display: "flex", gap: 8, marginBottom: 8 }}><button onClick={() => { const data = JSON.stringify(_creds, null, 2); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([data], { type: "application/json" })); a.download = "nomad_credentials.json"; a.click(); showT("Credentials exported", "success"); }} style={{ flex: 1, padding: "11px", border: "1.5px solid #6BAA75", borderRadius: 10, background: "#6BAA7512", color: "#6BAA75", fontFamily: "var(--font-h)", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>Export</button><label style={{ flex: 1, padding: "11px", border: "1.5px solid #7B8CDE", borderRadius: 10, background: "#7B8CDE12", color: "#7B8CDE", fontFamily: "var(--font-h)", fontSize: 12, cursor: "pointer", fontWeight: 600, textAlign: "center" }}>Import<input type="file" accept=".json" style={{ display: "none" }} onChange={e => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onerror = () => showT("Failed to read file", "error"); r.onload = ev => { try { const d = JSON.parse(ev.target.result); if (!d.sbUrl || !d.sbKey) { showT("Invalid credentials file", "error"); return; } localStorage.setItem("nomad-credentials", JSON.stringify(d)); showT("Credentials imported — reloading…", "success"); setTimeout(() => window.location.reload(), 1000); } catch { showT("Failed to read file", "error"); } }; r.readAsText(f); e.target.value = ""; }} /></label></div><button onClick={() => setShowSetup(true)} style={{ width: "100%", padding: "11px", border: "1.5px solid var(--border)", borderRadius: 10, background: "var(--card)", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>Edit Credentials</button></div>}</div>
        <div style={{ ...cc, padding: "14px 20px", marginBottom: 14 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "var(--muted)", marginBottom: 12, letterSpacing: "0.5px", fontWeight: 600 }}>Sync Status</div><div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", background: "var(--bg)", borderRadius: 10, border: "1px solid var(--border)", marginBottom: 10 }}><div><div style={{ fontSize: 12, fontFamily: "var(--font-h)", fontWeight: 600, color: "var(--text)" }}>{online ? (pendingSync > 0 ? `${pendingSync} change${pendingSync === 1 ? "" : "s"} pending` : "All changes synced") : "Offline — changes will sync when online"}</div><div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2, fontFamily: "var(--font-h)" }}>{online ? "Connected to Supabase" : "Working from local copy"}</div></div><div style={{ width: 8, height: 8, borderRadius: "50%", background: !online ? "#D4726A" : pendingSync > 0 ? "#FBBF24" : "#6BAA75", flexShrink: 0 }} /></div><button disabled={!online || pendingSync === 0} onClick={() => { flushSyncQueue().then(r => { if (r.synced > 0) showT(`Synced ${r.synced} change${r.synced === 1 ? "" : "s"}`, "success"); else if (r.pending > 0) showT(`${r.pending} change${r.pending === 1 ? "" : "s"} still pending — server may be unreachable`, "info"); else showT("Nothing to sync", "info"); }).catch(() => showT("Sync failed", "error")); }} style={{ width: "100%", padding: "10px", border: "1.5px solid var(--border)", borderRadius: 10, background: "var(--card)", color: (!online || pendingSync === 0) ? "var(--muted)" : "var(--text)", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: (!online || pendingSync === 0) ? "not-allowed" : "pointer", opacity: (!online || pendingSync === 0) ? 0.5 : 1 }}>Sync now</button>{deadLetterCount > 0 && <div style={{ marginTop: 10, padding: "10px 12px", background: "#D4726A12", border: "1px solid #D4726A30", borderRadius: 10 }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><div style={{ fontSize: 12, fontFamily: "var(--font-h)", fontWeight: 600, color: "#D4726A" }}>{deadLetterCount} failed change{deadLetterCount === 1 ? "" : "s"}</div><button onClick={() => { clearDeadLetter(); sDeadLetterCount(0); showT("Failed queue cleared", "info"); }} style={{ fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 600, background: "none", border: "none", color: "#D4726A", cursor: "pointer", padding: "2px 6px" }}>Dismiss</button></div><div style={{ fontSize: 10, color: "var(--muted)", marginTop: 3, fontFamily: "var(--font-b)" }}>These changes couldn't be saved after 3 retries. They've been discarded from the queue.</div></div>}</div>
        {(() => { const hasLocal = (row) => { const u = row?.receipt_url; if (typeof u !== "string") return false; if (u.startsWith("data:")) return true; try { const arr = JSON.parse(u); return Array.isArray(arr) && arr.some(x => typeof x === "string" && x.startsWith("data:")); } catch { return false; } }; const count = ex.filter(hasLocal).length + inc.filter(hasLocal).length; if (count === 0) return null; return <div style={{ ...cc, padding: "14px 20px", marginBottom: 14, borderLeft: "3px solid #FBBF24" }}><div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}><div><div style={{ fontFamily: "var(--font-h)", fontSize: 13, color: "#c8820a", fontWeight: 700, letterSpacing: "0.5px" }}>Local Receipts</div><div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{count} receipt{count === 1 ? "" : "s"} saved on this device only</div></div><div style={{ fontSize: 11, color: "#c8820a", fontWeight: 700, fontFamily: "var(--font-h)", background: "#FBBF2415", borderRadius: 8, padding: "4px 10px" }}>{count}</div></div><p style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.5, marginBottom: 10 }}>These were attached while offline or when Cloudinary upload failed. They're stored as base64 in the database (large rows). Tap below to re-upload to Cloudinary.</p><button disabled={lrMigrating || !_creds.cloudName || !online} onClick={migrateLocalReceipts} style={{ width: "100%", padding: "10px", border: "1.5px solid #c8820a", borderRadius: 10, background: lrMigrating ? "var(--border)" : "#FBBF2412", color: "#c8820a", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 700, cursor: (lrMigrating || !_creds.cloudName || !online) ? "not-allowed" : "pointer", opacity: (lrMigrating || !_creds.cloudName || !online) ? 0.5 : 1 }}>{lrMigrating ? "Uploading…" : !_creds.cloudName ? "Add Cloudinary credentials first" : !online ? "Offline — connect to retry" : `Re-upload ${count} receipt${count === 1 ? "" : "s"} to Cloudinary`}</button></div>; })()}
        <div style={{ ...cc, padding: 20, marginBottom: 14 }}><div onClick={() => { sRecDelOpen(o => !o); if (!recDelOpen && recDelItems === null) loadRecentlyDeleted(); }} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", marginBottom: recDelOpen ? 12 : 0 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "var(--muted)", letterSpacing: "0.5px", fontWeight: 600 }}>Recently Deleted</div><span style={{ fontSize: 10, color: "var(--muted)", transition: "transform 0.2s", display: "inline-block", transform: recDelOpen ? "rotate(0deg)" : "rotate(-90deg)" }}>▾</span></div>{recDelOpen && (recDelItems === null ? <button onClick={loadRecentlyDeleted} disabled={recDelLoading} style={{ width: "100%", padding: "10px", border: "1.5px solid var(--border)", borderRadius: 10, background: "var(--card)", color: recDelLoading ? "var(--muted)" : "var(--text)", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: recDelLoading ? "not-allowed" : "pointer", opacity: recDelLoading ? 0.6 : 1 }}>{recDelLoading ? "Loading…" : "Load deleted items (last 30 days)"}</button> : recDelItems.length === 0 ? <div style={{ fontSize: 12, color: "var(--muted)", textAlign: "center", padding: "8px 0" }}>No items deleted in the last 30 days</div> : <><button onClick={() => { const cutoff = new Date(Date.now() - 30 * 864e5).toISOString(); if (!window.confirm("Permanently delete all items soft-deleted more than 30 days ago? This cannot be undone.")) return; ["expenses","incomes","transfers","recurring","events","splits"].forEach(t => sbDeleteWhere(t, "deleted_at=lt." + cutoff)); showT("Expired items (>30 days) purged from database", "success"); }} style={{ width: "100%", padding: "8px", border: "1.5px solid #D4726A", borderRadius: 8, background: "#D4726A10", color: "#D4726A", fontFamily: "var(--font-h)", fontSize: 11, fontWeight: 600, cursor: "pointer", marginBottom: 10, display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}><Trash size={12} />Purge expired (&gt;30 days old)</button>{recDelItems.map(item => <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid var(--border)" }}><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 12, fontFamily: "var(--font-h)", fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item._tbl === "recurring" ? item.name : item._tbl === "splits" ? (item.name + " · " + fmt(item.amount) + (item.note ? " · " + item.note : "")) : (fmt(item.amount) + (item.note ? " · " + item.note : "") + " · " + (item.date || ""))}</div><div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>{item._tbl} · deleted {new Date(item.deleted_at).toLocaleDateString()}</div></div><button onClick={() => restoreDeleted(item)} style={{ padding: "5px 10px", border: "1.5px solid #6BAA75", borderRadius: 7, background: "#6BAA7512", color: "#6BAA75", fontFamily: "var(--font-h)", fontSize: 11, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}>Restore</button><button onClick={() => { sbDeleteWhere(item._tbl, "id=eq." + item.id); sRecDelItems(p => p.filter(i => i.id !== item.id)); showT("Permanently deleted", "success"); }} style={{ padding: "5px 8px", border: "1.5px solid #D4726A", borderRadius: 7, background: "#D4726A10", color: "#D4726A", fontFamily: "var(--font-h)", fontSize: 11, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}>✕</button></div>)}</>)}</div>
        <div style={{ ...cc, padding: 20, marginBottom: 14 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "var(--muted)", marginBottom: 14, letterSpacing: "0.5px", fontWeight: 600 }}>Danger Zone</div>{!clr ? <button onClick={() => { sClr(true); sNukeTxt(""); }} style={{ width: "100%", padding: "13px", border: "1.5px solid #D4726A", borderRadius: 10, background: "#D4726A12", color: "#D4726A", fontFamily: "var(--font-h)", fontSize: 13, cursor: "pointer", fontWeight: 600 }}>Clear All Data</button> : <div><p style={{ fontSize: 13, color: "#D4726A", marginBottom: 8, lineHeight: 1.5 }}>Delete everything permanently?</p>{getPendingSyncCount() > 0 && <p style={{ fontSize: 12, color: "#E07A5F", marginBottom: 8, lineHeight: 1.5, display: "flex", alignItems: "flex-start", gap: 4 }}><Warning size={14} weight="fill" style={{ flexShrink: 0, marginTop: 1 }} /><span>{getPendingSyncCount()} unsaved change{getPendingSyncCount() === 1 ? "" : "s"} pending sync — will be permanently lost.</span></p>}<button onClick={expBackup} style={{ width: "100%", padding: "9px", border: "1.5px solid #6BAA75", borderRadius: 8, background: "#6BAA7512", color: "#6BAA75", fontFamily: "var(--font-h)", fontSize: 12, cursor: "pointer", fontWeight: 600, marginBottom: 10 }}>↓ Download backup first</button><p style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>Type <strong>DELETE</strong> to confirm:</p><input value={nukeTxt} onChange={e => sNukeTxt(e.target.value)} placeholder="DELETE" autoCapitalize="characters" style={{ width: "100%", padding: "9px 11px", border: "1px solid #D4726A", borderRadius: 8, marginBottom: 10, fontSize: 13, fontFamily: "monospace", background: "var(--card)", color: "var(--text)" }} /><div style={{ display: "flex", gap: 8 }}><button onClick={() => { sClr(false); sNukeTxt(""); }} style={{ flex: 1, padding: "11px", border: "1.5px solid var(--border)", borderRadius: 10, background: "var(--card)", color: "var(--ts)", fontFamily: "var(--font-h)", fontSize: 13, cursor: "pointer" }}>Cancel</button><button disabled={nukeTxt !== "DELETE"} onClick={() => { if (nukeTxt !== "DELETE") return; sEx([]); sInc([]); sTr([]); sStl([]); sCats(DC); sIsrc(DI); sSp([]); sEvs([]); sRec([]); sWsb({}); sClr(false); sNukeTxt(""); Object.keys(localStorage).filter(k => k.startsWith("nomad-") && k !== "nomad-credentials").forEach(k => localStorage.removeItem(k));["expenses", "incomes", "transfers", "settlements", "splits", "recurring", "events"].forEach(t => sbDeleteWhere(t, "id=neq.null")); sbDeleteWhere("wallet_balances", "wallet_id=neq.null"); showT(online ? "Data cleared" : "Clear queued for sync", "success") }} style={{ flex: 1, padding: "11px", border: "none", borderRadius: 10, background: nukeTxt === "DELETE" ? "#D4726A" : "#D4726A66", color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, cursor: nukeTxt === "DELETE" ? "pointer" : "not-allowed", fontWeight: 600 }}>Yes, Delete</button></div></div>}</div>
        <div style={{ textAlign: "center", padding: "24px 20px", color: "var(--muted)", fontSize: 12, lineHeight: 1.8, fontStyle: "italic" }}>NOMAD v10.5 — Track smart. Spend wise. 🦁</div></div>}

    </div>}

    {module === "finance" && (() => { const cm = localDateKey().slice(0, 7); const totalInc = inc.reduce((s, i) => s + i.amount, 0); const totalExp = ex.reduce((s, e) => s + e.amount, 0); const catTotals = {}; ex.forEach(e => { catTotals[e.categoryId] = (catTotals[e.categoryId] || 0) + e.amount; }); const topCats = Object.entries(catTotals).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, amt]) => ({ name: cats.find(c => c.id === id)?.name || id, amount: amt, pct: totalExp > 0 ? Math.round(amt / totalExp * 100) : 0 })); const wBals = wallets.map(w => ({ name: w.name, balance: roundMoney(wBal[w.id] || 0) })); const allTxRedacted = redactTransactions(ex).map(e => ({ date: e.date, amount: e.amount, category: cats.find(c => c.id === e.categoryId)?.name || e.categoryId || "Unknown", note: e.note || "" })).sort((a, b) => (b.date || "").localeCompare(a.date || "")); const sendChat = async (q) => { if (!q.trim() || chatLoading) return; const userMsg = { role: "user", content: q.trim() }; sChatMsgs(p => [...p, userMsg]); sChatInput(""); sChatLoading(true); try { const r = await fetch("/api/ai-chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q.trim(), context: { month: cm, totalIncome: totalInc, totalExpense: totalExp, topCategories: topCats, recentExpenses: allTxRedacted.slice(0, 300), totalTransactions: ex.length + inc.length, walletBalances: wBals, recurringCount: rec.filter(r => r.active !== false).length, streak: finStreak } }) }); const d = await r.json(); sChatMsgs(p => [...p, { role: "assistant", content: r.ok ? d.answer : (d.error || "Something went wrong.") }]); } catch { sChatMsgs(p => [...p, { role: "assistant", content: "Network error — check your connection." }]); } finally { sChatLoading(false); } }; const QUICK_QS = ["Where am I overspending?", "How's my savings rate?", "Any unusual spending?", "Can I afford a big purchase?"]; const chatView = chatMsgs.length > 0 ? "chat" : "home"; return <><style>{`@keyframes chatBounce { 0%, 60%, 100% { transform: translateY(0); opacity: 0.4; } 30% { transform: translateY(-6px); opacity: 1; } } @keyframes chatSlideUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } } @keyframes chatFadeIn { from { opacity: 0; } to { opacity: 1; } } @keyframes chatExpand { from { opacity: 0; transform: scale(0.92) translateY(20px); transform-origin: bottom center; } to { opacity: 1; transform: scale(1) translateY(0); transform-origin: bottom center; } }`}</style>{chatOpen && <div style={{ position: "fixed", inset: 0, background: "rgba(44,40,32,0.45)", zIndex: 54, display: "flex", flexDirection: "column", justifyContent: "flex-end", animation: "chatFadeIn 0.2s ease" }} onClick={(e) => { if (e.target === e.currentTarget) sChatOpen(false); }}><div style={{ background: "#F5F0EB", borderRadius: "24px 24px 0 0", height: "82%", display: "flex", flexDirection: "column", overflow: "hidden", animation: "chatExpand 0.28s cubic-bezier(0.34,1.56,0.64,1) forwards" }}><div style={{ padding: "16px 20px 12px", borderBottom: "1px solid #D9D0C4", display: "flex", alignItems: "center", justifyContent: "space-between", background: "#FFFFFF" }}><div style={{ display: "flex", alignItems: "center", gap: 10 }}><Lion mood="happy" size={36} /><div><div style={{ fontSize: 15, fontWeight: 700, color: "#D4704A", letterSpacing: 0.5 }}>Ask NOMAD</div><div style={{ fontSize: 11, color: "#8C8278" }}>All-time data · always honest</div></div></div><div style={{ display: "flex", gap: 8, alignItems: "center" }}>{chatMsgs.length > 0 && <button onClick={() => { sChatMsgs([]); sChatInput(""); }} style={{ fontSize: 12, color: "#8C8278", background: "none", border: "none", cursor: "pointer", padding: "4px 8px", borderRadius: 8, fontFamily: "inherit" }}>Clear</button>}<button onClick={() => sChatOpen(false)} style={{ width: 28, height: 28, borderRadius: "50%", background: "#EAE4DC", border: "none", cursor: "pointer", fontSize: 14, color: "#8C8278", display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button></div></div><div style={{ flex: 1, overflowY: "auto", padding: "16px 16px 8px", display: "flex", flexDirection: "column" }}>{chatView === "home" ? <><div style={{ display: "flex", gap: 10, marginBottom: 20, animation: "chatSlideUp 0.3s ease forwards" }}><div style={{ flexShrink: 0, marginTop: 2 }}><Lion mood="happy" size={28} /></div><div style={{ background: "#FFFFFF", borderRadius: "4px 16px 16px 16px", padding: "12px 14px", fontSize: 13.5, color: "#2C2820", lineHeight: 1.6, boxShadow: "0 1px 4px rgba(0,0,0,0.07)", maxWidth: "80%" }}>Ask anything about your finances. I'm grounded in your <strong>full transaction history</strong>.</div></div><div style={{ fontSize: 11, letterSpacing: 1.5, color: "#8C8278", marginBottom: 10, paddingLeft: 2 }}>QUICK QUESTIONS</div>{QUICK_QS.map((q, i) => <button key={q} onClick={() => sendChat(q)} style={{ background: "#FFFFFF", border: "1px solid #D9D0C4", borderRadius: 14, padding: "12px 16px", textAlign: "left", fontSize: 13.5, color: "#2C2820", cursor: "pointer", marginBottom: 8, fontFamily: "'Georgia', serif", lineHeight: 1.4, animation: `chatSlideUp 0.3s ease ${i * 0.07}s forwards`, opacity: 0 }}>{q}</button>)}</> : <>{chatMsgs.map((m, i) => <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start", marginBottom: 10, animation: "chatSlideUp 0.3s ease forwards", opacity: 0 }}>{m.role === "assistant" && <div style={{ flexShrink: 0, marginRight: 8, marginTop: 2 }}><Lion mood="happy" size={28} /></div>}<div style={{ maxWidth: "76%", padding: "10px 13px", borderRadius: m.role === "user" ? "16px 16px 4px 16px" : "4px 16px 16px 16px", background: m.role === "user" ? "#D4704A" : "#FFFFFF", color: m.role === "user" ? "#FFFFFF" : "#2C2820", fontSize: 13.5, lineHeight: 1.55, boxShadow: m.role === "user" ? "0 2px 8px rgba(212,112,74,0.25)" : "0 1px 4px rgba(0,0,0,0.08)", fontFamily: "'Georgia', serif" }} dangerouslySetInnerHTML={{ __html: String(m.content || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>") }} /></div>)}{chatLoading && <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 10 }}><div style={{ flexShrink: 0, marginRight: 8, marginTop: 2 }}><Lion mood="happy" size={28} /></div><div style={{ background: "#FFFFFF", borderRadius: "4px 16px 16px 16px", padding: "10px 13px", boxShadow: "0 1px 4px rgba(0,0,0,0.08)" }}><div style={{ display: "flex", gap: 4, alignItems: "center", padding: "4px 0" }}>{[0,1,2].map(j => <div key={j} style={{ width: 7, height: 7, borderRadius: "50%", background: "#D4704A", animation: `chatBounce 1.2s ease-in-out ${j * 0.2}s infinite` }} />)}</div></div></div>}</>}</div><div style={{ padding: "10px 12px", borderTop: "1px solid #D9D0C4", display: "flex", gap: 8, background: "#FFFFFF" }}><input value={chatInput} onChange={e => sChatInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(chatInput); } }} placeholder="Ask about your finances…" style={{ flex: 1, padding: "9px 12px", borderRadius: 10, border: "1.5px solid #D9D0C4", background: "#F5F0EB", color: "#2C2820", fontSize: 13, fontFamily: "'Georgia', serif", outline: "none" }} /><button onClick={() => sendChat(chatInput)} disabled={chatLoading || !chatInput.trim()} style={{ padding: "9px 14px", borderRadius: 10, border: "none", background: chatLoading || !chatInput.trim() ? "#D9D0C4" : "#D4704A", color: "#fff", fontSize: 16, fontWeight: 700, cursor: chatLoading || !chatInput.trim() ? "not-allowed" : "pointer" }}>→</button></div></div></div>}</>; })()}
    {module === "finance" && dlBanner && deadLetterCount > 0 && <div style={{ position: "fixed", bottom: 60, left: 0, right: 0, maxWidth: 430, margin: "0 auto", background: "#D4726A", color: "#fff", padding: "10px 14px", display: "flex", alignItems: "center", gap: 8, zIndex: 49, fontSize: 12, fontFamily: "var(--font-h)", fontWeight: 600, boxShadow: "0 -2px 10px rgba(212,114,106,0.4)" }}><span style={{ flex: 1 }}>⚠ {deadLetterCount} change{deadLetterCount === 1 ? "" : "s"} failed to sync</span><button onClick={() => { sTab("settings"); sDlBanner(false); }} style={{ background: "rgba(255,255,255,0.25)", border: "none", borderRadius: 8, color: "#fff", fontFamily: "var(--font-h)", fontSize: 11, fontWeight: 700, padding: "4px 10px", cursor: "pointer" }}>Fix ›</button><button onClick={() => sDlBanner(false)} style={{ background: "none", border: "none", color: "#fff", fontSize: 18, cursor: "pointer", padding: "0 2px", lineHeight: 1, opacity: 0.8 }}>✕</button></div>}
{module === "finance" && <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: "var(--nav-bg)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "center", maxWidth: 430, margin: "0 auto", zIndex: 50, paddingBottom: "env(safe-area-inset-bottom)" }}>{[{ id: "dashboard", label: "Home" }, { id: "add", label: "Add" }, { id: "events", label: "Events" }, { id: "history", label: "History" }, { id: "settings", label: "Settings" }].map(n => <button key={n.id} onClick={() => sTab(n.id)} style={{ flex: 1, padding: "10px 0 8px", border: "none", background: "none", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, cursor: "pointer", opacity: tab === n.id ? 1 : 0.45 }}><div style={{ position: "relative" }}><NI type={n.id} active={tab === n.id} />{n.id === "settings" && deadLetterCount > 0 && <div style={{ position: "absolute", top: -2, right: -2, width: 8, height: 8, borderRadius: "50%", background: "#D4726A", border: "2px solid var(--nav-bg)" }} />}</div><span style={{ fontFamily: "var(--font-h)", fontSize: 9, color: tab === n.id ? "#E07A5F" : "var(--muted)", fontWeight: tab === n.id ? 600 : 400 }}>{n.label}</span></button>)}</div>}

    {calW && <CalM wallet={calW} currentBal={wBal[calW.id] || 0} onSave={(v, note) => handleCal(calW.id, v, note)} onClose={() => sCalW(null)} />}{recountW && <RecountM wallet={recountW} currentBal={wBal[recountW.id] || 0} onClose={() => sRecountW(null)} />}
    {recEditId && (() => {
      const r = rec.find(x => x.id === recEditId);
      if (!r) return null;
      return <RecEditPanel r={r} recCats={recCats} wallets={wallets} onSave={patch => { const updated = rec.map(x => x.id === r.id ? { ...x, ...patch } : x); sRec(updated); sbUpsert("recurring", [toSB(updated.find(x => x.id === r.id), COLS.recurring)], null, getVersion("recurring", r.id) ? { "If-Unmodified-Since": getVersion("recurring", r.id) } : {}); sRecEditId(null); showT((patch.name || r.name) + " updated", "success"); }} onClose={() => sRecEditId(null)} />;
    })()}

    {dbSetupModal && (
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 400, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <div style={{ background: "var(--card)", borderRadius: 16, padding: 24, maxWidth: 380, width: "100%", boxShadow: "0 8px 32px rgba(0,0,0,0.3)" }}>
          <div style={{ marginBottom: 8 }}><Gear size={24} weight="fill" /></div>
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
      <div style={{ position: "fixed", top: 24, left: "50%", transform: "translateX(-50%)", zIndex: 300, display: "flex", flexDirection: "column", alignItems: "center", gap: 8, pointerEvents: "none", maxWidth: "min(440px, 92vw)", width: "auto" }}>
        {toasts.slice(-3).map(t => (
          <div key={t.id} onClick={() => dismissToast(t.id)} style={{ pointerEvents: "auto", cursor: "pointer", background: t.type === "error" ? "#D4726A" : t.type === "success" ? "#6BAA75" : t.type === "warn" ? "#E07A5F" : "#7B8CDE", color: "#fff", borderRadius: 18, padding: "10px 18px", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", textAlign: "center", lineHeight: 1.4, wordBreak: "break-word", maxWidth: "min(440px, 92vw)", animation: "ti 0.25s ease-out", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
            <span>{t.msg}</span>
            {t.count > 1 && <span style={{ background: "rgba(255,255,255,0.28)", borderRadius: 10, padding: "1px 7px", fontSize: 10, fontWeight: 700 }}>×{t.count}</span>}
            {t.undo && <button onClick={(e) => { e.stopPropagation(); undoDelete(t.id); }} style={{ background: "rgba(255,255,255,0.25)", color: "#fff", border: "none", borderRadius: 12, padding: "3px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>UNDO</button>}
          </div>
        ))}
      </div>
    )}
  </div>
}