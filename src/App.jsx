import { useState, useEffect, useMemo, useRef, useCallback, memo } from "react";
import { FilmSlate, ForkKnife, Airplane, GameController, ShoppingCart, MusicNote, Trophy, Confetti, BookOpen, Briefcase, Warning, Wallet, Target, Lightning, Envelope, Fire, Sparkle, Lightbulb, ClipboardText, Timer, HandWaving, BellSlash, Robot, Receipt, FilePdf, Trash, Moon, Sun, Scales, Gear, PushPin, Hash, Microphone, CheckCircle, ArrowsLeftRight, CaretLeft, Users, ArrowRight, ArrowUpRight, ArrowDownLeft, PencilSimple, ShareNetwork, Compass } from "@phosphor-icons/react";
import { IconCheck, IconTrash, IconHistory, IconChevronRight, IconChevronLeft, IconSend, IconAlertTriangle, IconX, IconClock, IconArrowDown, IconArrowUp, IconPlus, IconPlayerSkipForward, IconPencil } from "@tabler/icons-react";
import { ComposedChart, Bar, Line, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, CartesianGrid } from "recharts";
import RoutineApp from "./Routine";
import { flushSyncQueue, getPendingSyncCount, getPendingSyncSummary, getDeadLetterCount, clearDeadLetter, sendSupabaseRequest, subscribePendingSync, subscribeSyncDrops, isPendingDelete, isPendingUpsert, hasPendingDedupeKey } from "./offlineSync";
import { checkBillReminders } from "./billReminders";
import { getExchangeRate, saveCurrencyMeta, getCurrencyMeta, getRateMeta } from "./currencyConverter";
import { hapticForToast, hapticLight, hapticMedium, hapticSelection, hapticsEnabled, setHapticsEnabled } from "./haptics";
import ReceiptPicker from "./ReceiptPicker";
import CredentialSetup from "./CredentialSetup";
import { getCredentials, isLocalMode } from "./credentials";
import { uploadReceipt } from "./receiptUpload";
import { COLS } from "./dbCols";
import { mergeRemote, isRecentRow, unionById } from "./syncMerge";
import { computeFinanceScore, scoreLabel } from "./financeScore";
import { redactTransactions } from "./redactor";
import {
  roundMoney, localDateKey, getRecurringDueDate, isRecurringDueToday,
  recurringDaysOverdue, distributeAmount, expenseShareMap, historySortCompare,
  UPI_LITE_MAX_BALANCE, exceedsUpiLiteBalance, defaultSettleWalletId, resolveRecCategory,
} from "./financeUtils";
import { parseAmount, parseVoiceTx, parseBankCsv } from "./txParsers";
import CalendarView from "./CalendarView";
import NomadLite from "./NomadLite";
import IOUWallet from "./IOUWallet";
import { useLockBodyScroll } from "./scrollLock";
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
const localMode = isLocalMode(_creds);
const FETCH_TIMEOUT_MS = 8000;
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
    // Explicit limit overrides any server-side max-rows cap (PostgREST default
    // is 1000 when a max-rows config is set). 50k is well above any realistic
    // personal-finance dataset and small enough to keep responses cacheable.
    const r = await fetchWithTimeout(`${SB_URL}/rest/v1/${table}?select=*${filter}&limit=50000`, { headers: sbH });
    if (r.ok) { const rows = await r.json(); saveVersions(table, rows); return rows; }
    if (r.status === 400 && filter) {
      // deleted_at column not yet migrated — fall back to unfiltered
      const r2 = await fetchWithTimeout(`${SB_URL}/rest/v1/${table}?select=*&limit=50000`, { headers: sbH });
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
// Group expenses someone ELSE paid (logged for the event ledger only). They
// carry walletId "__tracked__", never touch a wallet, and must be EXCLUDED
// from personal-spend aggregations — YOUR share enters spending via the "owe"
// settlement when you pay the payer back. Counting the tracked row (full
// amount) AND the settlement double-counts money you never spent.
const isTrackedExp = e => e?.walletId === "__tracked__";
const ml = k => { const [y, m] = k.split("-"); return new Date(y, m - 1).toLocaleDateString("en-US", { month: "short", year: "numeric" }) };
const dl = d => { const t = localDateKey(), y = localDateKey(new Date(Date.now() - 864e5)); return d === t ? "Today" : d === y ? "Yesterday" : new Date(d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) };
// Single source for person avatars so the same name renders the same colour in
// both the Splits tab and the event-detail Balances card (the two used to drift).
const avatarColor = name => { const pal = ["#E07A5F","#6BAA75","#7B8CDE","#F4A261","#81B29A","#A78BFA","#F2CC8F","#E07A5F"]; let h=0; for(const c of name) h=(h*31+c.charCodeAt(0))&0xffff; return pal[h%pal.length]; };
const initials = name => name.trim().split(/\s+/).slice(0,2).map(w=>w[0]?.toUpperCase()||"").join("");
const ls = { fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "1.2px", marginBottom: 6, display: "block", fontFamily: "var(--font-h)", fontWeight: 600 };
const is = { background: "var(--card)", border: "1.5px solid var(--border)", borderRadius: 10, padding: "11px 14px", color: "var(--text)", fontSize: 14, fontFamily: "var(--font-b)", outline: "none", width: "100%", boxSizing: "border-box" };
const FIX_SUFFIX = " (recurring)";
const isFix = e => !!(e.recurring === true || (e.note && e.note.endsWith(FIX_SUFFIX)));
// Persist a "fixed cost" flag through the same note-suffix channel isFix reads.
// (expenses have no dedicated `recurring` DB column, so the suffix is the
// cross-device, migration-free marker.) markFixedNote tags a note; dispNote
// strips the tag for display since the FIXED badge already conveys it.
const markFixedNote = n => { const t = String(n || "").trim(); if (!t) return "Fixed expense" + FIX_SUFFIX; return t.endsWith(FIX_SUFFIX) ? t : t + FIX_SUFFIX; };
const dispNote = n => String(n || "").replace(/ \(recurring\)$/, "");

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
const LL = ["ROARRR! Loaded!", "Treasure hoard!", "Lion's living large!", "Mane event: savings!", "Wallet's roaring rich!"];
const LH = ["Roarrr! Saving well!", "Budget king!", "Income > spending!", "Proud of you!", "Wallet smiling!"];
const LN = ["Steady as she goes.", "Holding the line.", "Balanced & calm.", "Keep it cruising.", "Watchful but okay."];
const LS = ["Spending > income…", "Tighten the belt.", "Slow down a bit.", "Cut one expense!", "Ramen week? Got this."];

function Lion({ mood, dancing, size = 56 }) {
  const [b, sB] = useState(false); useEffect(() => { if (!dancing) { sB(false); return } sB(true); const t = setTimeout(() => sB(false), 1600); return () => clearTimeout(t) }, [dancing]); const f = "#fae6c8", dk = "#141413"; const m = mood === "laugh" ? "#E8714F" : mood === "sad" ? "#D0876B" : "#E07A5F"; const cheerful = mood === "laugh" || mood === "happy";
  return <svg viewBox="0 0 80 80" width={size} height={size} style={{ transition: "transform 0.2s", transform: b ? "translateY(-6px) rotate(-5deg)" : "none", animation: b ? "ld 0.3s ease infinite alternate" : "none" }}><circle cx="40" cy="40" r="32" fill={m} opacity="0.9" /><circle cx="20" cy="25" r="10" fill={m} opacity="0.7" /><circle cx="60" cy="25" r="10" fill={m} opacity="0.7" /><circle cx="15" cy="42" r="9" fill={m} opacity="0.6" /><circle cx="65" cy="42" r="9" fill={m} opacity="0.6" /><circle cx="24" cy="60" r="8" fill={m} opacity="0.5" /><circle cx="56" cy="60" r="8" fill={m} opacity="0.5" /><circle cx="40" cy="42" r="22" fill={f} />{cheerful ? <><path d={mood === "laugh" ? "M29 38Q33 32 37 38" : "M30 38Q33 34 36 38"} stroke={dk} strokeWidth="2.5" fill="none" strokeLinecap="round" /><path d={mood === "laugh" ? "M43 38Q47 32 51 38" : "M44 38Q47 34 50 38"} stroke={dk} strokeWidth="2.5" fill="none" strokeLinecap="round" /></> : <><circle cx="33" cy="37" r="3" fill={dk} /><circle cx="47" cy="37" r="3" fill={dk} /></>}{mood === "sad" && <path d="M33 40q-2.2 4 0 6q2.2 -2 0 -6Z" fill="#7BB5E8" opacity="0.9" />}<ellipse cx="40" cy="45" rx="4" ry="3" fill="#c4736e" />{mood === "laugh" ? <path d="M31 47Q40 61 49 47Q40 51 31 47Z" fill="#9c3b34" stroke={dk} strokeWidth="1.3" strokeLinejoin="round" /> : mood === "happy" ? <path d="M34 49Q40 55 46 49" stroke={dk} strokeWidth="1.8" fill="none" strokeLinecap="round" /> : mood === "neutral" ? <path d="M35 51L45 51" stroke={dk} strokeWidth="1.8" fill="none" strokeLinecap="round" /> : <path d="M34 52Q40 48 46 52" stroke={dk} strokeWidth="1.8" fill="none" strokeLinecap="round" />}<circle cx="22" cy="22" r="6" fill={f} /><circle cx="58" cy="22" r="6" fill={f} /><circle cx="22" cy="22" r="3" fill="#f0c4b0" /><circle cx="58" cy="22" r="3" fill="#f0c4b0" /></svg>
}

function LionM({ balance: bal, dancing, aiMsg, aiLoading, onTap }) {
  const [fallback, sM] = useState(""), mood = bal < 0 ? "sad" : bal < 500 ? "neutral" : bal < 5000 ? "happy" : "laugh"; useEffect(() => { const bank = mood === "laugh" ? LL : mood === "happy" ? LH : mood === "neutral" ? LN : LS; const p = Math.random() < 0.5 ? TIPS : bank; sM(p[Math.floor(Math.random() * p.length)]) }, [bal, mood]);
  const displayMsg = aiMsg || fallback;
  return <div style={{ display: "flex", alignItems: "flex-end", gap: 12, padding: "12px 0", cursor: onTap ? "pointer" : "default" }} onClick={onTap}><Lion mood={mood} dancing={dancing} /><div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "14px 14px 14px 4px", padding: "10px 14px", fontSize: 13, color: "var(--ts)", maxWidth: 220, fontFamily: "var(--font-b)", lineHeight: 1.5 }}>{aiLoading ? <span style={{ color: "var(--muted)", fontStyle: "italic" }}>Thinking…</span> : displayMsg}</div></div>
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
        return <button key={v} onClick={() => { hapticSelection(); onPeriodChange(v); }} style={{ padding: "5px 11px", borderRadius: 16, border: "none", background: active ? "#38bdf8" : "transparent", fontSize: 11, fontFamily: "var(--font-h)", fontWeight: active ? 700 : 400, color: active ? (darkMode ? "#0a1628" : "#fff") : darkMode ? "rgba(56,189,248,0.6)" : "rgba(0,90,130,0.7)", cursor: "pointer", transition: "all 0.15s" }}>{tab}</button>;
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
  useLockBodyScroll();
  const isO = sp.direction === "owed"; const walletOptions = isO ? wl.filter(w => !isUpiLite(w)) : wl; const [wid, sW] = useState(() => defaultSettleWalletId(sp.direction, wl, isUpiLite) || "bank"); const maxAmt = rm ?? sp.amount; const [amt, sAmt] = useState(String(maxAmt)); const [sdate, sSdate] = useState(localDateKey()); const parsedAmt = parseAmount(amt); const validAmt = Math.min(Math.max(Number.isFinite(parsedAmt) ? parsedAmt : 0, 0.01), maxAmt); const isPartial = validAmt < maxAmt - 0.005;
  return <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={cl}><div onClick={e => e.stopPropagation()} style={{ background: "var(--card)", borderRadius: "20px 20px 0 0", padding: 24, width: "100%", maxWidth: 430 }}><div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{isO ? `Receiving from ${sp.name}` : `Paying ${sp.name}`}</div><button onClick={cl} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", padding: 4 }}><IconX size={18} /></button></div><div style={{ marginBottom: 14 }}><div style={{ fontSize: 10, fontFamily: "var(--font-h)", color: "var(--muted)", fontWeight: 600, marginBottom: 5, letterSpacing: "0.5px" }}>AMOUNT{isPartial ? " (PARTIAL PAYMENT)" : ""}</div><div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--bg)", borderRadius: 10, padding: "10px 14px", border: `1.5px solid ${isO ? "#6BAA75" : "#E07A5F"}` }}><span style={{ fontFamily: "var(--font-h)", fontSize: 16, color: "var(--muted)" }}>₹</span><input type="number" value={amt} onChange={e => sAmt(e.target.value)} max={maxAmt} min={0.01} step={0.01} style={{ flex: 1, border: "none", background: "transparent", fontFamily: "var(--font-h)", fontSize: 20, fontWeight: 700, color: isO ? "#6BAA75" : "#E07A5F", outline: "none" }} /><button onClick={() => sAmt(String(maxAmt))} style={{ fontSize: 9, fontFamily: "var(--font-h)", color: "var(--muted)", background: "var(--border)", border: "none", borderRadius: 4, padding: "2px 6px", cursor: "pointer", fontWeight: 600 }}>MAX</button></div>{isPartial && <div style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-h)", marginTop: 5 }}>{fmt(roundMoney(maxAmt - validAmt))} will remain as pending IOU</div>}</div><div style={{ fontSize: 10, fontFamily: "var(--font-h)", color: "var(--muted)", fontWeight: 600, marginBottom: 8, letterSpacing: "0.5px" }}>DATE</div><div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20 }}><input type="date" value={sdate} max={localDateKey()} onChange={e => sSdate(e.target.value)} style={{ ...is, marginBottom: 0, flex: 1 }} />{sdate !== localDateKey() && <button onClick={() => sSdate(localDateKey())} style={{ padding: "11px 13px", border: "1.5px solid var(--border)", borderRadius: 10, background: "transparent", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>Today</button>}</div><div style={{ fontSize: 10, fontFamily: "var(--font-h)", color: "var(--muted)", fontWeight: 600, marginBottom: 8, letterSpacing: "0.5px" }}>{isO ? "RECEIVE INTO" : "PAY FROM"}</div><div style={{ display: "flex", gap: 8, marginBottom: 20 }}>{walletOptions.map(w => <button key={w.id} onClick={() => sW(w.id)} style={{ flex: 1, padding: "10px 6px", borderRadius: 10, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, border: `2px solid ${wid === w.id ? w.color : "var(--border)"}`, background: wid === w.id ? w.color + "15" : "var(--card)", cursor: "pointer" }}><DI2 id={w.id} accent={w.neon || w.color} size={18} /><span style={{ fontSize: 9, fontFamily: "var(--font-h)", fontWeight: wid === w.id ? 700 : 500, color: wid === w.id ? w.color : "var(--muted)" }}>{w.name}</span></button>)}</div><div style={{ display: "flex", gap: 10 }}><button onClick={cl} style={{ flex: 1, padding: 13, border: "1.5px solid var(--border)", borderRadius: 12, background: "transparent", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 13, cursor: "pointer" }}>Cancel</button><button onClick={(ev) => { if (ev.currentTarget.disabled) return; if (validAmt > 0) { ev.currentTarget.disabled = true; oc(wid, validAmt, sdate); cl(); } }} style={{ flex: 2, padding: 13, border: "none", borderRadius: 12, background: isO ? "#6BAA75" : "#E07A5F", color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, cursor: "pointer", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}><IconSend size={15} />{isO ? `Received ${fmt(validAmt)}` : `Paid ${fmt(validAmt)}`}</button></div></div></div>;
}

const CURRENCIES = ["INR", "USD", "EUR", "GBP", "AED", "SGD", "JPY", "AUD", "CAD", "CHF", "CNY", "HKD", "NZD", "MYR", "THB", "PHP", "IDR", "KRW", "TWD", "SAR", "KWD", "QAR", "BHD", "OMR", "EGP", "ZAR", "NGN", "SEK", "NOK", "DKK", "PLN", "TRY", "RUB", "PKR", "BDT", "LKR", "NPR", "MXN", "BRL", "ARS"];
const CURRENCY_COUNTRIES = { INR: "India", USD: "United States", EUR: "Eurozone", GBP: "United Kingdom", AED: "UAE", SGD: "Singapore", JPY: "Japan", AUD: "Australia", CAD: "Canada", CHF: "Switzerland", CNY: "China", HKD: "Hong Kong", NZD: "New Zealand", MYR: "Malaysia", THB: "Thailand", PHP: "Philippines", IDR: "Indonesia", KRW: "South Korea", TWD: "Taiwan", SAR: "Saudi Arabia", KWD: "Kuwait", QAR: "Qatar", BHD: "Bahrain", OMR: "Oman", EGP: "Egypt", ZAR: "South Africa", NGN: "Nigeria", SEK: "Sweden", NOK: "Norway", DKK: "Denmark", PLN: "Poland", TRY: "Turkey", RUB: "Russia", PKR: "Pakistan", BDT: "Bangladesh", LKR: "Sri Lanka", NPR: "Nepal", MXN: "Mexico", BRL: "Brazil", ARS: "Argentina" };

// Extract the most useful keyword from a note for autoRule storage.
// Skips generic words, prefers first meaningful token (usually merchant/brand).
function extractKeyword(note) {
  const skip = new Set(["paid","for","at","the","to","from","in","on","a","an","rs","inr","and","or","by","with","via","of","per","my","via","recharge","payment","pay","bill"]);
  const words = note.toLowerCase().replace(/[₹,]/g, " ").split(/\s+/).filter(w => w.length > 2 && !skip.has(w) && !/^\d+$/.test(w));
  return words[0] || note.toLowerCase().trim().slice(0, 20);
}

function VoiceAdd({ onParsed, accent = "#E07A5F", compact = false }) {
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
  if (compact) return <button onClick={listening ? stop : start} title={listening ? "Stop listening" : "Voice add"} style={{ width: 40, height: 40, padding: 0, border: `1.5px solid ${listening ? "#E07A5F" : "var(--border)"}`, borderRadius: 12, background: listening ? "#E07A5F18" : "var(--bg)", color: listening ? "#E07A5F" : accent, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Microphone size={18} weight={listening ? "fill" : "regular"} /></button>;
  return <div style={{ marginBottom: 14 }}><button onClick={listening ? stop : start} style={{ width: "100%", padding: "10px 14px", border: `1.5px dashed ${listening ? "#E07A5F" : accent}`, borderRadius: 10, background: listening ? "#E07A5F12" : "var(--card)", color: listening ? "#E07A5F" : accent, fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}><Microphone size={14} weight={listening ? "fill" : "regular"} />{listening ? "Listening… tap to stop" : "Voice add — say e.g. \"300 coffee bank\""}</button>{error && <div style={{ fontSize: 11, color: "#E07A5F", marginTop: 4, fontFamily: "var(--font-h)" }}>{error}</div>}</div>;
}

function AddPage({ categories: cats, incomeSources: isrc, recurringCats: rCats, onAddExpense: oE, onAddIncome: oI, onAddTransfer: oT, onAddRec: oR, onError: showT = () => {}, patterns = [], autoRules = [], onLearnRule = () => {}, wallets: aw = WALLETS, cloudinaryEnabled = false }) {
  const _AD = (() => { try { return JSON.parse(sessionStorage.getItem("nomad-add-draft") || "{}"); } catch { return {}; } })();
  const [type, sType] = useState(_AD.type || "expense"), [amt, sAmt] = useState(_AD.amt || "0"), [catId, sCat] = useState(_AD.catId || cats[0]?.id || ""), [srcId, sSrc] = useState(isrc[0]?.id || ""), [wid, sW] = useState(_AD.wid || "bank"), [iwid, sIW] = useState("bank"), [tFrom, sTF] = useState("bank"), [tTo, sTT] = useState("upi_lite"), [date, sDate] = useState(_AD.date || localDateKey()), [note, sNote] = useState(_AD.note || ""), [fixed, sFixed] = useState(false);
  const [rName, sRN] = useState(""), [rAmt, sRA] = useState(""), [rCat, sRC] = useState("rent"), [rWal, sRW] = useState("bank"), [rFreq, sRF] = useState("monthly"), [rDay, sRD] = useState(new Date().getDate()), [rInt, sRI] = useState(30), [rStart, sRS] = useState(localDateKey()), [rOther, sRO] = useState(""), [rYM, sRYM] = useState(1), [rYD, sRYD] = useState(1);
  const [fxCur, setFxCur] = useState("INR"), [fxRate, setFxRate] = useState(null), [fxFetching, setFxFetching] = useState(false), [fxDate, setFxDate] = useState(null);
  const [fxExpanded, setFxExpanded] = useState(false), [fxSearch, setFxSearch] = useState("");
  const receiptPickerRef = useRef(null);
  const [submitting, setSubmitting] = useState(false);
  const [aiCatSug, sAiCatSug] = useState(null); // {categoryId, confidence, keyword} | null
  const [aiCatLoading, sAiCatLoading] = useState(false);
  const [ocrLoading, sOcrLoading] = useState(false);
  const [itemsPreview, sItemsPreview] = useState(null); // {merchant, total, items[]} | null
  const [itemsLoading, sItemsLoading] = useState(false);
  // splitPreview state removed — the AI category-split feature (single
  // expense → multi-category guess) was noisy. Receipt-items flow replaced it.
  // Fuzzy-match AI's free-text category hint (e.g. "Groceries", "Food") to a
  // local category id. Falls back to current expense category, then first.
  const matchCatHint = (hint) => {
    const h = String(hint || "").toLowerCase().trim();
    if (!h) return catId || cats[0]?.id;
    const direct = cats.find(c => c.name.toLowerCase() === h);
    if (direct) return direct.id;
    const fuzzy = cats.find(c => c.name.toLowerCase().includes(h) || h.includes(c.name.toLowerCase()));
    return fuzzy?.id || catId || cats[0]?.id;
  };
  // Map a free-text payment-method hint from a receipt/UPI screenshot (e.g.
  // "UPI Lite", "GPay", "Credit Card", "Cash") to one of the user's wallet ids.
  // Returns null when nothing matches so the form keeps the current selection.
  const matchWalletHint = (hint) => {
    const h = String(hint || "").toLowerCase().trim();
    if (!h) return null;
    const direct = aw.find(w => w.name.toLowerCase() === h);
    if (direct) return direct.id;
    const fuzzy = aw.find(w => w.name.toLowerCase().includes(h) || h.includes(w.name.toLowerCase()));
    if (fuzzy) return fuzzy.id;
    if (/\blite\b/.test(h)) { const ul = aw.find(isUpiLite); if (ul) return ul.id; }
    if (/cash/.test(h)) { const c = aw.find(w => /cash/i.test(w.name)); if (c) return c.id; }
    if (/upi|gpay|phonepe|paytm|bank|card|credit|debit|account|net ?bank/.test(h)) { const b = aw.find(w => /bank/i.test(w.name)) || aw.find(w => !isUpiLite(w)); if (b) return b.id; }
    return null;
  };
  const extractItems = async () => {
    if (itemsLoading) return;
    // No receipt attached → split the typed note into line items via text AI,
    // distributing the entered amount across them. (Receipt-free fallback.)
    if (!receiptPickerRef.current?.hasAny) {
      const noteText = note.trim();
      const total = (fxCur !== "INR" && fxRate > 0) ? roundMoney((parseFloat(amt) || 0) * fxRate) : (parseFloat(amt) || 0);
      if (!noteText) { showT("Add a receipt, or type a note to split", "error"); return; }
      if (!(total > 0)) { showT("Enter an amount to split", "error"); return; }
      sItemsLoading(true); sItemsPreview(null);
      try {
        const r = await fetch("/api/ai-analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "note-items", note: noteText, total, currency: "INR", categories: cats.map(c => ({ id: c.id, name: c.name })) }) });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Split failed");
        const items = (Array.isArray(d.items) ? d.items : []).filter(it => Number(it.amount) > 0);
        if (!items.length) { showT("Couldn't split that note into items", "info"); return; }
        sItemsPreview({ merchant: d.merchant || "", total, currency: "INR", items: items.map(it => ({ ...it, categoryId: matchCatHint(it.category) })), confidence: d.confidence || "medium" });
      } catch (e) {
        showT(e.message || "Split error", "error");
      } finally {
        sItemsLoading(false);
      }
      return;
    }
    sItemsLoading(true); sItemsPreview(null);
    try {
      // Multi-file/PDF: scan every attached item, merge results.
      const allData = await receiptPickerRef.current.getAllItemsData();
      if (!allData.length) { showT("No readable items", "error"); return; }
      const results = await Promise.all(allData.map(data =>
        fetch("/api/food-vision", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...data, type: "receipt-items" }) })
          .then(r => r.json().then(d => ({ ok: r.ok, d })))
          .catch(err => ({ ok: false, d: { error: err?.message || "OCR failed" } }))
      ));
      const merged = { merchant: "", total: 0, currency: "INR", items: [], confidence: "medium" };
      const failures = [];
      results.forEach((res, i) => {
        if (!res.ok || !Array.isArray(res.d.items)) { failures.push(res.d?.error || `file ${i + 1}`); return; }
        if (!merged.merchant && res.d.merchant) merged.merchant = res.d.merchant;
        merged.total += Number(res.d.total) || 0;
        if (res.d.currency) merged.currency = res.d.currency;
        merged.items.push(...res.d.items);
      });
      if (merged.items.length === 0) { showT(failures.length ? `OCR failed: ${failures[0]}` : "No line items found", failures.length ? "error" : "info"); return; }
      // Pre-resolve each item to a real categoryId so the preview can render an
      // editable select bound to a stable id (rather than the free-text AI hint).
      merged.items = merged.items.map(it => ({ ...it, categoryId: matchCatHint(it.category) }));
      sItemsPreview(merged);
      if (failures.length) showT(`Scanned ${results.length - failures.length}/${results.length} receipts — ${failures.length} failed`, "info");
    } catch (e) {
      showT(e.message || "OCR error", "error");
    } finally {
      sItemsLoading(false);
    }
  };
  const updateItemCat = (i, categoryId) => {
    sItemsPreview(prev => prev ? { ...prev, items: prev.items.map((it, j) => j === i ? { ...it, categoryId } : it) } : prev);
  };
  const updateItemName = (i, name) => {
    sItemsPreview(prev => prev ? { ...prev, items: prev.items.map((it, j) => j === i ? { ...it, name } : it) } : prev);
  };
  const updateItemAmount = (i, amount) => {
    sItemsPreview(prev => prev ? { ...prev, items: prev.items.map((it, j) => j === i ? { ...it, amount } : it) } : prev);
  };
  const confirmItemsImport = () => {
    if (!itemsPreview?.items?.length) return;
    let added = 0;
    // Split line items all post to the same wallet+date in one batch. wBal /
    // balanceOnDate don't reflect a prior item until React re-renders, so each
    // addE would otherwise capture the SAME pre-batch balBefore — history showed
    // e.g. ₹118.9→₹108.9 AND ₹118.9→₹98.9 instead of chaining 118.9→108.9→88.9.
    // Thread a running delta (same pattern as CSV/ledger batch imports) so every
    // item's balBefore reflects the ones added before it.
    let balanceDelta = 0;
    itemsPreview.items.forEach(it => {
      const amount = roundMoney(Number(it.amount) || 0);
      if (amount <= 0) return;
      const noteParts = [];
      if (itemsPreview.merchant) noteParts.push(itemsPreview.merchant);
      if (it.name) noteParts.push(it.name);
      const itemNote = noteParts.join(" · ").slice(0, 120);
      const cid = it.categoryId || matchCatHint(it.category) || catId;
      const ok = oE({ id: uid(), amount, categoryId: cid, walletId: wid, date, note: itemNote }, { balanceDelta }) !== false;
      if (ok) { added++; balanceDelta = roundMoney(balanceDelta - amount); }
    });
    showT(`Added ${added} of ${itemsPreview.items.length} line items`, "success");
    sItemsPreview(null);
    receiptPickerRef.current?.clear();
  };
  const aiDebounceRef = useRef(null);
  const scanReceipt = async () => {
    if (ocrLoading) return;
    if (!receiptPickerRef.current?.hasAny) { showT("Add a receipt first", "error"); return; }
    sOcrLoading(true);
    try {
      // Multi-file / PDF aware: scan every attached receipt, sum amounts.
      // PDFs are passed through as application/pdf — Gemini handles them; if
      // the provider waterfall has no PDF-capable provider it falls through
      // gracefully and that file is reported in the failures count.
      const allData = await receiptPickerRef.current.getAllItemsData();
      if (!allData.length) { showT("No readable receipts", "error"); return; }
      // Send the user's real category + wallet names so the AI can pick from
      // them (rather than inventing labels). Names aren't PII — the receipt
      // image itself is already going to the provider.
      const catNames = cats.map(c => c.name);
      const walNames = aw.map(w => w.name);
      const results = await Promise.all(allData.map(data =>
        fetch("/api/food-vision", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...data, type: "receipt", categories: catNames, wallets: walNames }) })
          .then(r => r.json().then(d => ({ ok: r.ok, d })))
          .catch(err => ({ ok: false, d: { error: err?.message || "OCR failed" } }))
      ));
      let totalAmt = 0;
      let merchant = "";
      let earliestDate = "";
      let lowestConf = "high";
      let catHint = "";
      let payHint = "";
      const failures = [];
      results.forEach((res, i) => {
        if (!res.ok) { failures.push(res.d?.error || `file ${i + 1}`); return; }
        const d = res.d;
        if (Number(d.amount) > 0) totalAmt += Number(d.amount);
        if (!merchant && d.merchant) merchant = d.merchant;
        if (!catHint && d.category) catHint = d.category;
        if (!payHint && d.paymentMethod) payHint = d.paymentMethod;
        if (d.date && /^\d{4}-\d{2}-\d{2}$/.test(d.date)) {
          if (!earliestDate || d.date < earliestDate) earliestDate = d.date;
        }
        if (d.confidence === "low") lowestConf = "low";
        else if (d.confidence === "medium" && lowestConf !== "low") lowestConf = "medium";
      });
      if (results.length - failures.length === 0) {
        throw new Error(failures[0] || "OCR failed for all files");
      }
      if (totalAmt > 0) sAmt(String(roundMoney(totalAmt)));
      if (merchant) sNote(merchant + (results.length > 1 ? ` (${results.length} receipts)` : ""));
      if (earliestDate) sDate(earliestDate);
      let setCat = null, setWal = null;
      if (catHint) { const cid = matchCatHint(catHint); if (cid) { sCat(cid); setCat = cats.find(c => c.id === cid)?.name || null; } }
      if (payHint) { const wid2 = matchWalletHint(payHint); if (wid2) { sW(wid2); setWal = aw.find(w => w.id === wid2)?.name || null; } }
      const okCount = results.length - failures.length;
      const extras = [setCat && `→ ${setCat}`, setWal && `· ${setWal}`].filter(Boolean).join(" ");
      const baseMsg = `Scanned ${okCount}/${results.length} · ${merchant || "(no merchant)"} ${totalAmt > 0 ? "₹" + roundMoney(totalAmt) : ""}${extras ? " " + extras : ""} · ${lowestConf}`;
      showT(failures.length ? `${baseMsg} — ${failures.length} failed` : baseMsg, lowestConf === "low" || failures.length ? "info" : "success");
    } catch (e) {
      showT(e.message || "OCR error", "error");
    } finally {
      sOcrLoading(false);
    }
  };
  // Clear AI-bulk previews when switching transaction type — they're built
  // for the current type's wallet/category context and become stale otherwise.
  useEffect(() => { sItemsPreview(null); sFixed(false); }, [type]);
  useEffect(() => { const c = fxCur.trim().toUpperCase(); if (c.length !== 3 || c === "INR") { setFxRate(null); setFxDate(null); return; } setFxFetching(true); getExchangeRate(c, date).then(r => { setFxRate(r); setFxDate(getRateMeta(c, date)?.date || null); setFxFetching(false); }).catch(() => { setFxRate(null); setFxDate(null); setFxFetching(false); }); }, [fxCur, date]);
  useEffect(() => { try { sessionStorage.setItem("nomad-add-draft", JSON.stringify({ type, amt, catId, wid, date, note })); } catch { /* ignore storage errors */ } }, [type, amt, catId, wid, date, note]);
  const tc = type === "expense" ? "#E07A5F" : type === "income" ? "#6BAA75" : type === "transfer" ? "#7B8CDE" : "#A78BFA";
  const submit = async () => {
    if (submitting) return;
    const a = parseAmount(amt);
    if (!Number.isFinite(a) || a <= 0) return;
    if (type === "transfer" && tFrom === tTo) return;
    // A foreign currency is selected but no valid rate is loaded (fetch failed
    // or still in flight). Without this guard isFX falls back to false and the
    // raw foreign amount is stored as INR — e.g. $100 saved as ₹100. Block it.
    if (type !== "transfer" && fxCur.trim().toUpperCase() !== "INR" && !(fxRate > 0)) {
      showT(fxFetching ? "Still fetching the exchange rate — try again in a second" : "Couldn't get the exchange rate — check your connection or switch to INR", "error");
      return;
    }
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
        txOk = oE({ id: txId, amount: inrAmt, categoryId: catId, date, note: fixed ? markFixedNote(note) : note, walletId: wid, recurring: fixed || undefined, ...(rUrl ? { receipt_url: rUrl } : {}) }) !== false;
      } else if (type === "income") {
        const txId = uid();
        if (isFX) saveCurrencyMeta(txId, fxCur, a, fxRate);
        txOk = oI({ id: txId, amount: inrAmt, sourceId: srcId, date, note, walletId: iwid, ...(rUrl ? { receipt_url: rUrl } : {}) }) !== false;
      } else if (type === "transfer") {
        txOk = oT({ amount: a, fromWallet: tFrom, toWallet: tTo, date, note }) !== false;
      }
      if (!txOk) return; // validation failed — keep form state + picker so user can fix and retry
      receiptPickerRef.current?.clear();
      sAmt("0");
      sNote("");
      sFixed(false);
      try { sessionStorage.removeItem("nomad-add-draft"); } catch { /* ignore */ }
    } finally {
      setSubmitting(false);
    }
  };
  const submitRec = () => { const a = roundMoney(rAmt); if (!rName.trim() || !a || a <= 0) return; if (rCat === "other_rec" && !rOther.trim()) return; if (!rStart) { showT("Pick a start date", "error"); return; } if (rFreq === "custom" && (!rInt || Number(rInt) <= 0)) { showT("Custom interval must be at least 1 day", "error"); return; } if (rFreq === "monthly" && (!rDay || Number(rDay) < 1 || Number(rDay) > 31)) { showT("Day of month must be between 1 and 31", "error"); return; } if (rFreq === "yearly" && (!rYM || !rYD || Number(rYM) < 1 || Number(rYM) > 12 || Number(rYD) < 1 || Number(rYD) > 31)) { showT("Pick a valid month and day", "error"); return; } const recRecord = { id: uid(), name: rName.trim(), amount: a, categoryId: rCat, categoryName: rCat === "other_rec" ? rOther.trim() : null, walletId: rWal, frequency: rFreq, dayOfMonth: rFreq === "monthly" ? Number(rDay) : null, intervalDays: rFreq === "custom" ? Number(rInt) : null, yearMonth: rFreq === "yearly" ? Number(rYM) : null, yearDay: rFreq === "yearly" ? Number(rYD) : null, startDate: rStart, active: true, lastPaidDate: null, lastSkippedDate: null }; oR(recRecord); const todayK = localDateKey(); const due = getRecurringDueDate(recRecord, todayK); let dueMsg = "saved"; if (due) { dueMsg = due <= todayK ? "due now — see Home" : "next due " + new Date(due + "T12:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" }); } showT(`${recRecord.name} added · ${dueMsg}`, "success"); sRN(""); sRA(""); sRO("") };
  const WB = ({ wallets, sel, onSel }) => <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>{wallets.map(w => <button key={w.id} onClick={() => { hapticSelection(); onSel(w.id); }} style={{ flex: 1, padding: "10px 6px", borderRadius: 10, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, border: `2px solid ${sel === w.id ? w.color : "var(--border)"}`, background: sel === w.id ? w.color + "15" : "var(--card)", cursor: "pointer" }}><div style={{ display: "flex", alignItems: "center", gap: 4 }}><DI2 id={w.id} accent={w.neon || w.color} size={12} /><span style={{ fontSize: 11, fontFamily: "var(--font-h)", fontWeight: sel === w.id ? 700 : 500, color: sel === w.id ? w.color : "var(--muted)" }}>{w.name}</span></div>{w.desc && <span style={{ fontSize: 8, color: sel === w.id ? w.color : "var(--muted)", fontFamily: "var(--font-b)", opacity: 0.7, lineHeight: 1 }}>{w.desc}</span>}</button>)}</div>;
  return <div style={{ padding: "0 0 20px" }}>
    {(() => { const SI = { expense: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><polyline points="19 12 12 19 5 12" /></svg>, income: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" /></svg>, transfer: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 1 21 5 17 9" /><line x1="3" y1="5" x2="21" y2="5" /><polyline points="7 23 3 19 7 15" /><line x1="21" y1="19" x2="3" y2="19" /></svg>, recurring: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></svg> }; return <div style={{ display: "flex", background: "var(--card)", borderRadius: 12, padding: 4, border: "1px solid var(--border)", marginBottom: 20, gap: 2 }}>{[{ id: "expense", label: "Expense" }, { id: "income", label: "Income" }, { id: "transfer", label: "Transfer" }, { id: "recurring", label: "Recurring" }].map(t => <button key={t.id} onClick={() => { hapticSelection(); sType(t.id); }} style={{ flex: 1, padding: "10px 4px", border: "none", borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center", gap: 4, lineHeight: 1, background: type === t.id ? (t.id === "expense" ? "#E07A5F" : t.id === "income" ? "#6BAA75" : t.id === "transfer" ? "#7B8CDE" : "#A78BFA") : "transparent", color: type === t.id ? "#fff" : "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all 0.15s" }}>{SI[t.id]}{t.label}</button>)}</div>; })()}
    {type !== "recurring" && (() => {
      const applyParsed = r => { if (r.amount) sAmt(String(r.amount)); if (r.note) sNote(r.note); if (r.walletId) { if (type === "expense") sW(r.walletId); else if (!isUpiLite(aw.find(w => w.id === r.walletId) || {})) sIW(r.walletId); } if (r.categoryId) { if (type === "expense") sCat(r.categoryId); else sSrc(r.categoryId); } };
      const handleVoice = async t => { const local = parseVoiceTx(t, { wallets: aw, categories: type === "expense" ? cats : isrc }); applyParsed(local); if (local.amount && local.categoryId && local.walletId) { showT(`Heard: ₹${local.amount} ${local.note || ""}`, "info"); return; } try { const r = await fetch("/api/ai-analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "voice-parse", transcript: t, wallets: aw.map(w => ({ id: w.id, name: w.name })), categories: (type === "expense" ? cats : isrc).map(c => ({ id: c.id, name: c.name })) }) }); const data = await r.json(); if (r.ok && data.amount) { applyParsed(data); showT(`AI: ₹${data.amount} ${data.note || ""}`, "info"); } else if (!local.amount) { showT(data?.error || "Couldn't parse — try \"300 coffee bank\"", "error"); } } catch { if (!local.amount) showT("Couldn't parse — try \"300 coffee bank\"", "error"); } };
      const alpha = (hex, a) => { const h = String(hex || "#000000").replace("#", ""); const r = parseInt(h.slice(0, 2), 16) || 0, g = parseInt(h.slice(2, 4), 16) || 0, b = parseInt(h.slice(4, 6), 16) || 0; return `rgba(${r},${g},${b},${a})`; };
      const microLabel = (c) => ({ fontFamily: "var(--font-h)", fontSize: 10.5, color: c, letterSpacing: "1.6px", fontWeight: 800, textTransform: "uppercase" });
      const isFXcur = fxCur !== "INR" && fxRate > 0;
      const inrAmt = isFXcur ? roundMoney((parseFloat(amt) || 0) * fxRate) : (parseFloat(amt) || 0);
      const curSym = !isFXcur ? "₹" : fxCur === "USD" ? "$" : fxCur === "EUR" ? "€" : fxCur === "GBP" ? "£" : "";

      if (type === "transfer") {
        return <>
          <div style={{ background: "var(--card)", border: `1.5px solid ${tc}`, borderRadius: 18, padding: "10px 12px", marginBottom: 14, boxShadow: `0 2px 10px ${tc}20` }}><div style={{ display: "flex", alignItems: "center", gap: 8 }}><div style={{ flex: 1, display: "flex", alignItems: "center", minWidth: 0 }}><input type="number" value={amt === "0" ? "" : amt} onChange={e => sAmt(e.target.value || "0")} placeholder="0" autoFocus style={{ flex: 1, background: "transparent", border: "none", outline: "none", fontSize: 30, fontWeight: 700, fontFamily: "var(--font-h)", padding: "8px 4px", color: tc, minWidth: 0, width: "100%" }} /></div></div></div>
          <div style={{ position: "relative", background: "var(--card)", borderRadius: 18, padding: "16px 16px 8px 22px", marginBottom: 14, boxShadow: "0 1px 4px rgba(0,0,0,0.04)", border: "1px solid var(--border)" }}><div style={{ position: "absolute", left: 0, top: 14, bottom: 14, width: 4, background: tc, borderRadius: "0 3px 3px 0" }} /><div style={{ fontFamily: "var(--font-h)", fontSize: 10, color: tc, letterSpacing: "1.8px", fontWeight: 800, marginBottom: 14 }}>TRANSFER</div><label style={ls}>From</label><WB wallets={aw} sel={tFrom} onSel={sTF} /><div style={{ textAlign: "center", fontSize: 18, color: tc, marginBottom: 10, fontWeight: 700 }}>↓</div><label style={ls}>To</label><WB wallets={aw} sel={tTo} onSel={sTT} />{tFrom === tTo && <p style={{ fontSize: 12, color: "#D4726A", textAlign: "center", marginBottom: 8 }}>Must be different.</p>}</div>
          <div style={{ position: "relative", background: "var(--card)", borderRadius: 18, padding: "16px 16px 8px 22px", marginBottom: 14, boxShadow: "0 1px 4px rgba(0,0,0,0.04)", border: "1px solid var(--border)" }}><div style={{ position: "absolute", left: 0, top: 14, bottom: 14, width: 4, background: "var(--muted)", borderRadius: "0 3px 3px 0", opacity: 0.4 }} /><div style={{ fontFamily: "var(--font-h)", fontSize: 10, color: "var(--muted)", letterSpacing: "1.8px", fontWeight: 800, marginBottom: 14 }}>DETAILS</div><div style={{ display: "flex", gap: 10, marginBottom: 14 }}><div style={{ flex: 1 }}><label style={ls}>Date</label><input type="date" value={date} onChange={e => sDate(e.target.value)} style={is} /></div><div style={{ flex: 1 }}><label style={ls}>Note</label><input value={note} onChange={e => sNote(e.target.value)} placeholder="Optional…" style={is} /></div></div></div>
          <button onClick={submit} disabled={submitting} style={{ width: "100%", padding: "16px", border: "none", borderRadius: 14, background: submitting ? tc + "99" : tc, color: "#fff", fontSize: 15, fontFamily: "var(--font-h)", fontWeight: 700, letterSpacing: 0.5, cursor: submitting ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, boxShadow: `0 6px 16px ${tc}40`, marginTop: 4 }}>{submitting ? "Saving…" : "Transfer"}</button>
        </>;
      }

      // ===== EXPENSE / INCOME — redesigned layout =====
      const isExp = type === "expense", isInc = type === "income";
      const walletsList = isExp ? aw : aw.filter(w => !isUpiLite(w));
      const selW = isExp ? wid : iwid;
      const setSelW = isExp ? sW : sIW;
      const selCatId = isExp ? catId : srcId;
      const setSelCat = isExp ? sCat : sSrc;
      const catList = isExp ? [...cats, ...(cats.find(c => c.id === "other") ? [] : [DC.find(c => c.id === "other")])].filter(Boolean) : isrc;

      return <>
        {isExp && patterns.length > 0 && <div style={{ marginBottom: 14 }}>
          <div style={{ ...microLabel("var(--muted)"), marginBottom: 9 }}>Quick add</div>
          <div className="nm-hscroll" style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 2 }}>{patterns.slice(0, 8).map((p, i) => { const cat = cats.find(c => c.id === p.categoryId) || DC.find(c => c.id === p.categoryId) || { color: "#E07A5F", neon: "#FF9F1C" }; return <button key={i} onClick={() => { hapticLight(); sAmt(String(p.amount)); sCat(p.categoryId); sW(p.walletId); if (p.note) sNote(p.note); }} style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 7, padding: "9px 13px 9px 10px", borderRadius: 14, border: `1.5px solid ${alpha(cat.color, 0.45)}`, background: alpha(cat.color, 0.08), cursor: "pointer", fontFamily: "var(--font-h)" }}><DI2 id={p.categoryId} accent={cat.neon || cat.color} size={16} /><span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", lineHeight: 1.15 }}><span style={{ fontSize: 13, fontWeight: 800, color: cat.color }}>₹{p.amount}</span>{p.note && <span style={{ fontSize: 10, color: "var(--muted)", fontWeight: 600 }}>{p.note}</span>}</span></button>; })}</div>
        </div>}

        {/* AMOUNT HERO */}
        <div style={{ borderRadius: 24, padding: "16px 18px 18px", marginBottom: 14, background: `linear-gradient(165deg, ${alpha(tc, 0.13)}, ${alpha(tc, 0.04)})`, border: `1.5px solid ${alpha(tc, 0.28)}` }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={microLabel(tc)}>{isExp ? "Expense amount" : "Income amount"}</span>
            <button onClick={() => setFxExpanded(o => !o)} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 11px", borderRadius: 100, border: `1.5px solid ${isFXcur ? tc : "var(--border)"}`, background: isFXcur ? alpha(tc, 0.14) : "var(--card)", color: isFXcur ? tc : "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 12, letterSpacing: ".5px", cursor: "pointer" }}>{fxCur}<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" style={{ transform: fxExpanded ? "rotate(180deg)" : "none" }}><polyline points="6 9 12 15 18 9" /></svg></button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ flex: 1, display: "flex", alignItems: "center", minWidth: 0 }}>
              <span style={{ fontSize: 34, lineHeight: 1, color: tc, fontFamily: "var(--font-h)", fontWeight: 800, marginRight: 4, opacity: 0.9 }}>{curSym}</span>
              <input type="number" value={amt === "0" ? "" : amt} onChange={e => sAmt(e.target.value || "0")} placeholder="0" inputMode="decimal" autoFocus style={{ flex: 1, background: "transparent", border: "none", outline: "none", fontSize: 46, fontWeight: 800, fontFamily: "var(--font-h)", color: tc, minWidth: 0, width: "100%", letterSpacing: "-1px", padding: 0 }} />
            </div>
            <VoiceAdd compact accent={tc} onParsed={handleVoice} />
          </div>
          {isFXcur && <div style={{ marginTop: 8, display: "flex", alignItems: "center", justifyContent: "space-between" }}><span style={{ fontFamily: "var(--font-h)", fontSize: 10.5, color: "var(--muted)", fontWeight: 600 }}>1 {fxCur} = ₹{fxRate.toFixed(2)}{fxDate ? ` · as of ${fxDate}` : ""}</span>{parseFloat(amt) > 0 && <span style={{ fontFamily: "var(--font-h)", fontSize: 14, fontWeight: 800, color: tc }}>≈ {fmt(inrAmt)}</span>}</div>}
          {fxFetching && fxCur !== "INR" && <div style={{ marginTop: 6, fontSize: 10.5, color: "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 600 }}>Fetching rate…</div>}
        </div>

        {/* FX picker */}
        {fxExpanded && <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 16, padding: 12, marginBottom: 14, boxShadow: "0 6px 20px rgba(0,0,0,0.06)" }}>
          <input value={fxSearch} onChange={e => setFxSearch(e.target.value)} placeholder="Search currency or country…" autoFocus style={{ ...is, marginBottom: 10, padding: "9px 12px", fontSize: 13 }} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 200, overflowY: "auto" }}>{(fxSearch.trim() ? CURRENCIES.filter(c => { const q = fxSearch.trim().toLowerCase(); return c.toLowerCase().includes(q) || (CURRENCY_COUNTRIES[c] || "").toLowerCase().includes(q); }) : CURRENCIES).map(c => { const on = fxCur === c; return <button key={c} onClick={() => { hapticSelection(); setFxCur(c); setFxExpanded(false); setFxSearch(""); }} style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 1, padding: "7px 11px", borderRadius: 12, border: `1.5px solid ${on ? tc : "var(--border)"}`, background: on ? alpha(tc, 0.14) : "var(--bg)", color: on ? tc : "var(--ts)", fontFamily: "var(--font-h)", fontSize: 12.5, fontWeight: on ? 800 : 600, cursor: "pointer" }}>{c}{CURRENCY_COUNTRIES[c] && <span style={{ fontSize: 8.5, opacity: 0.6, fontWeight: 500, maxWidth: 64, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{CURRENCY_COUNTRIES[c]}</span>}</button>; })}</div>
        </div>}

        {/* UNIFIED DETAIL CARD */}
        <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 22, padding: "18px 18px 8px", boxShadow: "0 2px 10px rgba(0,0,0,0.04)", marginBottom: 14 }}>
          <div style={{ ...microLabel("var(--muted)"), marginBottom: 11 }}>{isExp ? "Pay from" : "Receive into"}</div>
          <div style={{ display: "flex", gap: 8 }}>{walletsList.map(w => { const on = selW === w.id; return <button key={w.id} onClick={() => { hapticSelection(); setSelW(w.id); }} style={{ flex: 1, padding: "11px 6px 9px", borderRadius: 15, display: "flex", flexDirection: "column", alignItems: "center", gap: 5, border: `2px solid ${on ? w.color : "var(--border)"}`, background: on ? alpha(w.color, 0.1) : "var(--bg)", cursor: "pointer" }}><DI2 id={w.id} accent={w.neon || w.color} size={19} /><span style={{ fontSize: 11.5, fontFamily: "var(--font-h)", fontWeight: on ? 800 : 600, color: on ? w.color : "var(--muted)" }}>{w.name}</span>{w.desc && <span style={{ fontSize: 8.5, color: "var(--muted)", fontFamily: "var(--font-b)", opacity: 0.75, lineHeight: 1 }}>{w.desc}</span>}</button>; })}</div>

          <div style={{ height: 1, background: "var(--border)", margin: "16px -18px" }} />

          <div style={{ ...microLabel("var(--muted)"), marginBottom: 11 }}>{isExp ? "Category" : "Source"}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>{catList.map(c => { const on = selCatId === c.id; return <button key={c.id} onClick={() => { hapticSelection(); setSelCat(c.id); }} style={{ padding: "8px 13px 8px 10px", borderRadius: 100, fontSize: 12.5, fontFamily: "var(--font-h)", border: `1.5px solid ${on ? c.color : "var(--border)"}`, background: on ? alpha(c.color, 0.13) : "var(--bg)", color: on ? c.color : "var(--ts)", cursor: "pointer", fontWeight: on ? 800 : 600, display: "flex", alignItems: "center", gap: 6 }}><DI2 id={c.id} accent={c.neon || c.color} size={15} />{c.name}</button>; })}</div>

          {isExp && <button onClick={() => { hapticSelection(); sFixed(f => !f); }} aria-pressed={fixed} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 12, padding: "9px 12px", borderRadius: 12, border: `1.5px solid ${fixed ? alpha("#A78BFA", 0.5) : "var(--border)"}`, background: fixed ? alpha("#A78BFA", 0.07) : "var(--bg)", cursor: "pointer", textAlign: "left", transition: "background .15s, border-color .15s" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
              <Lightning size={16} weight={fixed ? "fill" : "regular"} color={fixed ? "#A78BFA" : "var(--muted)"} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: "var(--font-h)", fontSize: 12.5, fontWeight: 700, color: fixed ? "#A78BFA" : "var(--text)" }}>Fixed cost</div>
                <div style={{ fontFamily: "var(--font-b)", fontSize: 10, color: "var(--muted)", lineHeight: 1.3, marginTop: 1 }}>Rent, bills, recharge — counts under Fixed</div>
              </div>
            </div>
            <div style={{ width: 32, height: 18, borderRadius: 9, background: fixed ? "#A78BFA" : "var(--border)", position: "relative", flexShrink: 0, transition: "background .15s" }}><div style={{ position: "absolute", top: 2, left: fixed ? 16 : 2, width: 14, height: 14, borderRadius: "50%", background: "#fff", transition: "left .15s", boxShadow: "0 1px 3px rgba(0,0,0,0.25)" }} /></div>
          </button>}

          <div style={{ height: 1, background: "var(--border)", margin: "16px -18px" }} />

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 11 }}>
            <span style={microLabel("var(--muted)")}>Details</span>
            {aiCatLoading && <span style={{ display: "flex", alignItems: "center", gap: 5, fontFamily: "var(--font-h)", fontSize: 10.5, color: "var(--muted)", fontWeight: 700 }}><Robot size={11} />Suggesting…</span>}
          </div>
          <div style={{ display: "flex", gap: 7, marginBottom: 7 }}>
            <input type="date" value={date} onChange={e => sDate(e.target.value)} style={{ ...is, flex: 1, minWidth: 0, padding: "0 12px", height: 44, fontFamily: "var(--font-h)", fontWeight: 600, fontSize: 12.5 }} />
            {isExp && <button onClick={scanReceipt} disabled={ocrLoading} title="Scan receipt — auto-fill amount, merchant, date" style={{ flexShrink: 0, width: 44, height: 44, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", cursor: ocrLoading ? "default" : "pointer", border: `1.5px solid ${alpha(tc, 0.5)}`, background: alpha(tc, 0.1), color: tc, opacity: ocrLoading ? 0.6 : 1 }}>{ocrLoading ? <span style={{ width: 15, height: 15, border: `2px solid ${alpha(tc, 0.35)}`, borderTopColor: tc, borderRadius: "50%", animation: "nmSpin .7s linear infinite", display: "inline-block" }} /> : <Receipt size={17} weight="regular" />}</button>}
            {isExp && <button onClick={extractItems} disabled={itemsLoading} title="Split into line items — from a receipt, or from your note + amount if none is attached" style={{ flexShrink: 0, width: 44, height: 44, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", cursor: itemsLoading ? "default" : "pointer", border: `1.5px solid ${alpha(tc, 0.5)}`, background: alpha(tc, 0.1), color: tc, opacity: itemsLoading ? 0.6 : 1 }}>{itemsLoading ? <span style={{ width: 15, height: 15, border: `2px solid ${alpha(tc, 0.35)}`, borderTopColor: tc, borderRadius: "50%", animation: "nmSpin .7s linear infinite", display: "inline-block" }} /> : <Robot size={17} weight="regular" />}</button>}
          </div>
          <div style={{ marginBottom: 8 }}>
            <input value={note} onChange={e => { const v = e.target.value; sNote(v); sAiCatSug(null); if (aiDebounceRef.current) clearTimeout(aiDebounceRef.current); if (type === "expense") { const kw = v.toLowerCase().trim(); const m = autoRules.find(r => kw.includes(r.keyword.toLowerCase())); if (m) { sCat(m.categoryId); } else if (v.trim().length >= 3) { aiDebounceRef.current = setTimeout(async () => { sAiCatLoading(true); try { const r = await fetch("/api/ai-categorize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note: v.trim(), categories: cats.map(c => ({ id: c.id, name: c.name })) }) }); const d = await r.json(); if (r.ok && d.categoryId) sAiCatSug({ ...d, keyword: extractKeyword(v) }); } catch { /* silent */ } finally { sAiCatLoading(false); } }, 800); } } }} placeholder="Add a note…" style={{ ...is, height: 44, padding: "0 12px" }} />
          </div>
          {aiCatSug && (() => { const c = cats.find(x => x.id === aiCatSug.categoryId); if (!c) return null; return <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, padding: "7px 9px", borderRadius: 12, background: alpha(c.color, 0.1), border: `1px solid ${alpha(c.color, 0.5)}` }}><Robot size={12} color={c.color} /><span style={{ flex: 1, fontSize: 12, fontFamily: "var(--font-h)", fontWeight: 700, color: "var(--text)" }}>Set category to <strong style={{ color: c.color }}>{c.name}</strong>?</span><span style={{ fontSize: 8.5, color: c.color, background: alpha(c.color, 0.16), padding: "2px 6px", borderRadius: 5, fontWeight: 800, textTransform: "uppercase" }}>{aiCatSug.confidence}</span><button onClick={() => { sCat(aiCatSug.categoryId); onLearnRule({ keyword: aiCatSug.keyword, categoryId: aiCatSug.categoryId, source: "ai", confidence: 0.9, hitCount: 0, createdAt: localDateKey() }); sAiCatSug(null); }} style={{ width: 26, height: 26, borderRadius: 7, border: "none", background: c.color, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontWeight: 800 }}>✓</button><button onClick={() => sAiCatSug(null)} style={{ width: 26, height: 26, borderRadius: 7, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 12, cursor: "pointer" }}>✕</button></div>; })()}
          {/* Removed: "Split across categories with AI" — AI's blind guess at how
              to split one expense across categories was noisy. Use the receipt-items
              flow (Robot icon next to Scan) instead — it splits a *real* receipt
              into line items with editable per-line category. */}
          <div style={{ marginBottom: 10 }}><ReceiptPicker ref={receiptPickerRef} cloudinaryEnabled={cloudinaryEnabled} /></div>
          {itemsPreview && (() => { const sum = roundMoney(itemsPreview.items.reduce((s, it) => s + (Number(it.amount) || 0), 0)); const total = roundMoney(itemsPreview.total || 0); const drift = roundMoney(sum - total); const driftBig = total > 0 && Math.abs(drift) > 5; return <div style={{ background: alpha(tc, 0.06), border: `1.5px solid ${alpha(tc, 0.4)}`, borderRadius: 14, padding: "10px 12px", marginBottom: 10 }}><div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 11, fontWeight: 800, color: tc, letterSpacing: ".5px" }}>RECEIPT ITEMS · {itemsPreview.merchant || "(no merchant)"}</div><span style={{ fontSize: 9.5, color: "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 700 }}>{itemsPreview.items.length} item{itemsPreview.items.length === 1 ? "" : "s"}</span></div><div style={{ maxHeight: 280, overflowY: "auto", paddingRight: 2 }}>{itemsPreview.items.map((it, i) => <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 0", borderBottom: i < itemsPreview.items.length - 1 ? "1px dashed var(--border)" : "none" }}><input value={it.name || ""} onChange={e => updateItemName(i, e.target.value)} placeholder="Item" style={{ flex: 2, minWidth: 0, padding: "6px 8px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--card)", color: "var(--text)", fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 11.5, outline: "none" }} /><div style={{ position: "relative", flex: "0 1 118px", minWidth: 86 }}><select value={it.categoryId || ""} onChange={e => updateItemCat(i, e.target.value)} title="Set category — AI's guess is a starting point" style={{ width: "100%", appearance: "none", WebkitAppearance: "none", MozAppearance: "none", padding: "6px 22px 6px 9px", borderRadius: 7, border: `1px solid ${alpha(tc, 0.4)}`, background: alpha(tc, 0.06), color: tc, fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 10.5, outline: "none", cursor: "pointer" }}>{cats.map(c => <option key={c.id} value={c.id} style={{ color: "var(--text)" }}>{c.name}</option>)}</select><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke={tc} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}><polyline points="6 9 12 15 18 9" /></svg></div><div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0, width: 80, border: "1px solid var(--border)", borderRadius: 7, padding: "5px 7px", background: "var(--card)" }}><span style={{ fontFamily: "var(--font-h)", fontWeight: 800, color: tc, fontSize: 11 }}>₹</span><input type="number" inputMode="decimal" value={it.amount ?? ""} onChange={e => updateItemAmount(i, e.target.value)} style={{ width: "100%", minWidth: 0, border: "none", background: "transparent", color: tc, fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 12, outline: "none", textAlign: "right", padding: 0 }} /></div></div>)}</div><div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, padding: "6px 8px", borderRadius: 8, background: driftBig ? alpha("#D4726A", 0.12) : alpha(tc, 0.06), border: driftBig ? "1px solid #D4726A40" : "none" }}><span style={{ fontSize: 10.5, fontFamily: "var(--font-h)", color: driftBig ? "#D4726A" : "var(--muted)", fontWeight: 700 }}>{driftBig ? `Items sum ${fmt(sum)} ≠ receipt ${fmt(total)} (Δ${drift > 0 ? "+" : ""}${fmt(drift)})` : total > 0 ? `Items sum ${fmt(sum)} ≈ ${fmt(total)}` : `Items sum ${fmt(sum)}`}</span></div><div style={{ display: "flex", gap: 6, marginTop: 8 }}><button onClick={confirmItemsImport} style={{ flex: 2, padding: "8px", border: "none", borderRadius: 9, background: tc, color: "#fff", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>Add {itemsPreview.items.length} item{itemsPreview.items.length === 1 ? "" : "s"}</button><button onClick={() => sItemsPreview(null)} style={{ flex: 1, padding: "8px", border: "1.5px solid var(--border)", borderRadius: 9, background: "transparent", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Cancel</button></div></div>; })()}
        </div>

        <button onClick={submit} disabled={submitting} style={{ width: "100%", padding: "15px", border: "none", borderRadius: 16, background: submitting ? alpha(tc, 0.6) : tc, color: "#fff", fontSize: 15, fontFamily: "var(--font-h)", fontWeight: 800, letterSpacing: ".3px", cursor: submitting ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, boxShadow: `0 8px 22px ${alpha(tc, 0.4)}` }}>
          {submitting && <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite" /></path></svg>}
          {!submitting && <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">{isInc ? <><line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" /></> : <><line x1="12" y1="5" x2="12" y2="19" /><polyline points="19 12 12 19 5 12" /></>}</svg>}
          {submitting ? "Uploading…" : (isExp ? "Add Expense" : "Add Income")}
          {!submitting && parseFloat(amt) > 0 && <span style={{ opacity: 0.85, fontWeight: 700 }}>· {fmt(inrAmt)}</span>}
        </button>
      </>;
    })()}
    {type === "recurring" && <><div style={{ fontFamily: "var(--font-h)", fontSize: 10, color: "var(--muted)", letterSpacing: "1.5px", fontWeight: 700, marginBottom: 14 }}>BILL</div><label style={ls}>Name</label><input value={rName} onChange={e => sRN(e.target.value)} placeholder="e.g. Netflix, Rent…" style={{ ...is, marginBottom: 12 }} /><label style={ls}>Amount ({CUR})</label><input type="number" value={rAmt} onChange={e => sRA(e.target.value)} placeholder="0" style={{ ...is, fontSize: 24, fontWeight: 700, fontFamily: "var(--font-h)", textAlign: "center", padding: "14px", color: "#A78BFA", borderColor: "#A78BFA", marginBottom: 16 }} /><div style={{ height: 1, background: "var(--border)", margin: "4px 0 16px" }} /><div style={{ fontFamily: "var(--font-h)", fontSize: 10, color: "var(--muted)", letterSpacing: "1.5px", fontWeight: 700, marginBottom: 14 }}>CATEGORY</div><div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>{(rCats || RC).map(c => <button key={c.id} onClick={() => sRC(c.id)} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 12, fontFamily: "var(--font-b)", border: `1.5px solid ${rCat === c.id ? c.color : "var(--border)"}`, background: rCat === c.id ? c.color + "18" : "var(--card)", color: rCat === c.id ? c.color : "var(--ts)", cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}><DI2 id={c.id} accent={c.neon || c.color} size={13} />{c.name}</button>)}</div>
      {rCat === "other_rec" && <input value={rOther} onChange={e => sRO(e.target.value)} placeholder="Name this category…" style={{ ...is, marginBottom: 12 }} />}
      <div style={{ height: 1, background: "var(--border)", margin: "4px 0 16px" }} /><div style={{ fontFamily: "var(--font-h)", fontSize: 10, color: "var(--muted)", letterSpacing: "1.5px", fontWeight: 700, marginBottom: 14 }}>SCHEDULE</div><label style={ls}>Default wallet</label><WB wallets={aw} sel={rWal} onSel={sRW} />{isUpiLite(aw.find(w => w.id === rWal) || {}) && <p style={{ fontSize: 11, color: "#00B4D8", fontFamily: "var(--font-h)", fontWeight: 600, marginTop: -8, marginBottom: 12, lineHeight: 1.4 }}>UPI Lite has a ₹5000 cap. You can switch wallets each time you mark it paid — this is just the default.</p>}<label style={ls}>Frequency</label><div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>{[{ id: "monthly", label: "Monthly" }, { id: "yearly", label: "Yearly" }, { id: "custom", label: "Every X Days" }].map(f => <button key={f.id} onClick={() => sRF(f.id)} style={{ flex: 1, padding: "9px", borderRadius: 9, fontSize: 12, fontFamily: "var(--font-h)", border: `1.5px solid ${rFreq === f.id ? "#A78BFA" : "var(--border)"}`, background: rFreq === f.id ? "#A78BFA18" : "var(--card)", color: rFreq === f.id ? "#A78BFA" : "var(--muted)", cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap" }}>{f.label}</button>)}</div>
      {rFreq === "monthly" && <div style={{ marginBottom: 12 }}><label style={ls}>Day of Month</label><input type="number" min={1} max={31} value={rDay} onChange={e => sRD(e.target.value)} style={{ ...is, textAlign: "center", fontFamily: "var(--font-h)", fontWeight: 600 }} /></div>}
      {rFreq === "yearly" && <div style={{ display: "flex", gap: 8, marginBottom: 12 }}><div style={{ flex: 1 }}><label style={ls}>Month (1–12)</label><input type="number" min={1} max={12} value={rYM} onChange={e => sRYM(e.target.value)} style={{ ...is, textAlign: "center", fontFamily: "var(--font-h)", fontWeight: 600 }} /></div><div style={{ flex: 1 }}><label style={ls}>Day</label><input type="number" min={1} max={31} value={rYD} onChange={e => sRYD(e.target.value)} style={{ ...is, textAlign: "center", fontFamily: "var(--font-h)", fontWeight: 600 }} /></div></div>}
      {rFreq === "yearly" && (() => { const maxD = new Date(new Date().getFullYear(), Number(rYM), 0).getDate(); return Number(rYD) > maxD ? <div style={{ fontSize: 11, color: "#E07A5F", marginTop: -8, marginBottom: 8 }}>{"Day " + rYD + " → clamps to " + maxD + " in " + ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(rYM)] + ". Bill fires on last available day."}</div> : null; })()}
      {rFreq === "custom" && <div style={{ marginBottom: 12 }}><label style={ls}>Every how many days?</label><input type="number" min={1} value={rInt} onChange={e => sRI(e.target.value)} style={{ ...is, textAlign: "center", fontFamily: "var(--font-h)", fontWeight: 600 }} /></div>}
      <label style={ls}>Start Date</label><input type="date" value={rStart} onChange={e => sRS(e.target.value)} style={{ ...is, marginBottom: 18 }} /><button onClick={submitRec} style={{ width: "100%", padding: "14px", border: "none", borderRadius: 12, background: "#A78BFA", color: "#fff", fontSize: 15, fontFamily: "var(--font-h)", fontWeight: 600, cursor: "pointer" }}>Add Recurring</button></>}</div>
}

const TxCard = memo(function TxCard({ item: it, categories: cats, incomeSources: isrc, events: evs, onDelete: od, recurringCats: rCats, wallets: wl = WALLETS, onRefund: oRef }) {
  const [grpOpen, setGrpOpen] = useState(false);
  // Settlement GROUP: several settlements made in one go (a partial/net settle
  // pays down multiple IOUs at once) collapse into one summary card. Tap to
  // expand into the individual settlement cards (rendered as normal TxCards).
  if (it.__group) {
    const accent = it.direction === "owed" ? "#6BAA75" : "#E07A5F";
    const gW = wl.find(x => x.id === it.walletId); const n = it.items.length;
    return <div style={{ ...cc, borderRadius: 14, marginBottom: 10, overflow: "hidden" }}>
      <div onClick={() => setGrpOpen(o => !o)} style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, cursor: "pointer" }}>
        <div style={{ width: 44, height: 44, borderRadius: 12, background: accent + "14", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><DI2 id={it.direction === "owed" ? "received" : "paid"} accent={accent} size={22} /></div>
        <div style={{ flex: 1, minWidth: 0 }}><div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}><span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-h)" }}>{it.direction === "owed" ? `${it.splitName} paid back` : `Paid ${it.splitName}`}</span><span style={{ fontSize: 8, fontFamily: "var(--font-h)", fontWeight: 600, color: accent, background: accent + "15", padding: "1px 5px", borderRadius: 3 }}>{n} PAYMENTS</span></div><div style={{ fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-b)", marginTop: 2, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{gW?.name} · {dl(it.date)} · tap to {grpOpen ? "hide" : "see"} {n}</div></div>
        <div style={{ fontFamily: "var(--font-h)", fontWeight: 600, fontSize: 15, color: accent, flexShrink: 0 }}>{it.direction === "owed" ? "+" : "−"}{fmt(it.amount)}</div>
        <span style={{ fontSize: 10, color: "var(--muted)", transition: "transform 0.2s", display: "inline-block", transform: grpOpen ? "rotate(0deg)" : "rotate(-90deg)", flexShrink: 0 }}>▾</span>
      </div>
      {grpOpen && <div style={{ borderTop: "1px solid var(--border)", padding: "8px 10px 2px", background: "var(--bg)" }}><div style={{ borderLeft: `2px solid ${accent}40`, paddingLeft: 8 }}>{it.items.map(child => <TxCard key={child.id} item={child} categories={cats} incomeSources={isrc} events={evs} onDelete={od} recurringCats={rCats} wallets={wl} onRefund={oRef} />)}</div></div>}
    </div>;
  }
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
  return <div style={{ ...cc, borderRadius: 14, padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}><div style={{ width: 44, height: 44, borderRadius: 12, background: (cat?.color || "#999") + "14", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{cat ? <DI2 id={cat.id} accent={cat.neon || cat.color} size={22} /> : <span style={{ fontSize: 22 }}>❓</span>}</div><div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}><div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}><span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-h)" }}>{cat?.name || "Unknown"}</span>{isE && <span style={{ fontSize: 7, fontFamily: "var(--font-h)", fontWeight: 600, color: isFix(it) ? "#A78BFA" : "#FBBF24", background: isFix(it) ? "#A78BFA15" : "#FBBF2415", padding: "1px 5px", borderRadius: 3 }}>{isFix(it) ? "FIXED" : "FLEX"}</span>}{w && <span style={{ fontSize: 9, fontFamily: "var(--font-h)", fontWeight: 600, color: w.color, background: w.color + "18", padding: "2px 6px", borderRadius: 4, display: "inline-flex", alignItems: "center", gap: 2 }}><DI2 id={w.id} accent={w.neon || w.color} size={10} /></span>}{isE && it.walletId === "__tracked__" && <span title="Logged for the event ledger — not paid from your wallets" style={{ fontSize: 8, fontFamily: "var(--font-h)", fontWeight: 700, color: "#7B8CDE", background: "#7B8CDE18", padding: "2px 6px", borderRadius: 4, letterSpacing: "0.3px" }}>PAID BY {(it.paidBy || "?").toUpperCase()}</span>}</div><div style={{ fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-b)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{evT && <span style={{ fontWeight: 600, color: "var(--ts)" }}>{evT} · </span>}{dl(it.date)}{(() => { const dn = dispNote(it.note); return dn ? " · " + dn : ""; })()}</div>{fxMeta && <div style={{ fontSize: 10, color: "#7B8CDE", fontFamily: "var(--font-h)", fontWeight: 600, marginTop: 3, letterSpacing: "0.3px" }}>{fxMeta.currency} {fxMeta.originalAmount} @ {Number(fxMeta.rateUsed).toFixed(2)}</div>}
    {(isE || isI) && it.receipt_url && (() => { let urls; try { urls = JSON.parse(it.receipt_url); if (!Array.isArray(urls)) urls = [it.receipt_url]; } catch { urls = [it.receipt_url]; } return <div style={{ marginTop: 3, display: "flex", gap: 8, flexWrap: "wrap" }}>{urls.map((u, i) => { const isPdf = typeof u === "string" && (u.startsWith("data:application/pdf") || u.toLowerCase().endsWith(".pdf")); return <a key={i} href={u} target="_blank" rel="noopener noreferrer" style={{ fontSize: 10, color: "#6BAA75", fontFamily: "var(--font-h)", fontWeight: 600, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 3 }}>{isPdf ? <FilePdf size={12} /> : <Receipt size={12} />}{urls.length > 1 ? `${isPdf ? "PDF" : "Receipt"} ${i + 1}` : (isPdf ? "PDF" : "Receipt")}</a>; })}</div>; })()}</div><div style={{ fontFamily: "var(--font-h)", fontWeight: 600, fontSize: 15, color: isE ? "#E07A5F" : "#6BAA75", flexShrink: 0 }}>{isE ? "−" : "+"}{fmt(it.amount)}</div>{isE && oRef && it.walletId !== "__tracked__" && <button onClick={() => oRef(it)} title="Refund this expense as income" style={{ background: "none", border: "none", color: "#6BAA75", cursor: "pointer", fontSize: 14, opacity: 0.5, flexShrink: 0, padding: "0 2px" }}>↩</button>}<button onClick={() => od(it.id, it.type)} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 14, opacity: 0.35, flexShrink: 0 }}>✕</button></div>
});

function CalM({ wallet: w, currentBal: cb, onSave: os, onClose: cl, onViewLedger: ovl }) {
  useLockBodyScroll();
  const [v, sV] = useState(String(roundMoney(cb)));
  const [note, sNote] = useState("");
  const numV = Number(v) || 0;
  const isUL = isUpiLite(w);
  const overCap = isUL && numV > 5000;
  const isNeg = numV < 0;
  const gap = roundMoney(numV - roundMoney(cb));
  const gapPos = gap > 0;
  return <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={cl}><div onClick={e => e.stopPropagation()} style={{ background: "var(--card)", borderRadius: "20px 20px 0 0", padding: 28, width: "100%", maxWidth: 430 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 16, fontWeight: 700, color: "var(--text)", marginBottom: 6, display: "flex", alignItems: "center", gap: 8 }}><DI2 id={w.id} accent={w.neon || w.color} size={20} /> Reconcile {w.name}</div><p style={{ fontSize: 13, color: "var(--muted)", fontFamily: "var(--font-b)", marginBottom: 16, lineHeight: 1.5 }}>NOMAD balance: <strong>{fmt(roundMoney(cb))}</strong>. Enter your actual balance from your bank or UPI app.{isUL && " UPI Lite max ₹5000 (RBI)."}</p><label style={ls}>Actual Balance ({CUR})</label><input type="number" value={v} onChange={e => sV(e.target.value)} style={{ ...is, fontSize: 28, fontWeight: 700, fontFamily: "var(--font-h)", textAlign: "center", padding: "16px", color: (overCap || isNeg) ? "#D4726A" : w.color, borderColor: (overCap || isNeg) ? "#D4726A" : w.color, marginBottom: 8 }} />{overCap && <p style={{ fontSize: 11, color: "#D4726A", marginBottom: 6, fontFamily: "var(--font-h)", fontWeight: 600 }}>Exceeds ₹5000 UPI Lite cap</p>}{isNeg && <p style={{ fontSize: 11, color: "#D4726A", marginBottom: 6, fontFamily: "var(--font-h)", fontWeight: 600 }}>Cannot be negative</p>}{gap !== 0 && !overCap && !isNeg && <div style={{ fontSize: 12, fontFamily: "var(--font-h)", fontWeight: 700, color: gapPos ? "#6BAA75" : "#D4726A", background: gapPos ? "#6BAA7515" : "#D4726A15", borderRadius: 8, padding: "7px 14px", marginBottom: 10, textAlign: "center" }}>Adjustment: {gapPos ? "+" : ""}{fmt(gap)} will be logged</div>}<input value={note} onChange={e => sNote(e.target.value)} placeholder="Reason (optional): bank charge, missed UPI, cash ATM…" style={{ ...is, fontSize: 12, marginBottom: 16, color: "var(--text)" }} />{ovl && <button onClick={ovl} style={{ width: "100%", padding: "10px", marginBottom: 12, border: "1px dashed var(--border)", borderRadius: 10, background: "transparent", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}><IconHistory size={13} />View running balance to find a mismatch</button>}<div style={{ display: "flex", gap: 10 }}><button onClick={cl} style={{ flex: 1, padding: 14, border: "1.5px solid var(--border)", borderRadius: 12, background: "transparent", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 14, cursor: "pointer" }}>Cancel</button><button disabled={overCap || isNeg} onClick={() => { os(numV, note); cl(); }} style={{ flex: 2, padding: 14, border: "none", borderRadius: 12, background: (overCap || isNeg) ? "#ccc" : w.color, color: "#fff", fontFamily: "var(--font-h)", fontSize: 14, cursor: (overCap || isNeg) ? "not-allowed" : "pointer", fontWeight: 700 }}>{gap === 0 ? "Verify ✓" : "Set Balance"}</button></div></div></div>
}
function RecountM({ wallet: w, currentBal: cb, onClose: cl }) {
  useLockBodyScroll();
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
  return <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={cl}><div onClick={e => e.stopPropagation()} style={{ background: "var(--card)", borderRadius: "20px 20px 0 0", padding: "20px 20px 24px", width: "100%", maxWidth: 430, maxHeight: "88vh", overflowY: "auto" }}><div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 16, fontWeight: 700, color: "var(--text)", display: "flex", alignItems: "center", gap: 6 }}><Hash size={16} weight="bold" />Count Cash</div><button onClick={reset} style={{ background: "none", border: "none", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 11, cursor: "pointer", padding: "2px 6px", opacity: 0.7 }}>Reset</button></div><p style={{ fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-b)", marginBottom: 14, lineHeight: 1.4 }}>App shows <strong>{fmt(roundMoney(cb))}</strong>.{savedAt ? <span> Last saved {savedAt}.</span> : " Tap + for each note."}</p>{DENOMS.map(d => { const cnt = counts[d]; return <div key={d} style={{ display: "flex", alignItems: "center", paddingBottom: 8, marginBottom: 8, borderBottom: "1px solid var(--border)", opacity: cnt === 0 ? 0.4 : 1 }}><span style={{ fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 14, color: "var(--text)", width: 48 }}>₹{d}</span><div style={{ display: "flex", alignItems: "center", marginLeft: "auto" }}><button onClick={() => adj(d, -1)} style={{ width: 34, height: 34, border: "1.5px solid var(--border)", borderRadius: "8px 0 0 8px", background: "var(--bg)", color: "var(--muted)", fontSize: 18, cursor: "pointer", fontWeight: 700, lineHeight: 1 }}>−</button><div style={{ width: 42, height: 34, border: "1.5px solid var(--border)", borderLeft: "none", borderRight: "none", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 15, color: "var(--text)", background: "var(--bg)" }}>{cnt}</div><button onClick={() => adj(d, 1)} style={{ width: 34, height: 34, border: `1.5px solid ${cnt > 0 ? w.color : "var(--border)"}`, borderRadius: "0 8px 8px 0", background: cnt > 0 ? w.color + "18" : "var(--bg)", color: cnt > 0 ? w.color : "var(--muted)", fontSize: 18, cursor: "pointer", fontWeight: 700, lineHeight: 1 }}>+</button></div><span style={{ fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, color: "var(--text)", width: 60, textAlign: "right", visibility: cnt > 0 ? "visible" : "hidden" }}>{fmt(d * cnt)}</span></div>; })}<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0 6px", borderTop: "2px solid var(--border)", marginTop: 4 }}><span style={{ fontFamily: "var(--font-h)", fontWeight: 600, fontSize: 13, color: "var(--muted)" }}>Counted</span><span style={{ fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 20, color: "var(--text)" }}>{fmt(counted)}</span></div>{gap !== 0 && counted > 0 && <div style={{ fontSize: 12, fontFamily: "var(--font-h)", fontWeight: 700, color: isShort ? "#E07A5F" : "#6BAA75", background: isShort ? "#E07A5F15" : "#6BAA7515", borderRadius: 8, padding: "7px 14px", margin: "8px 0 4px", textAlign: "center" }}>{isShort ? `${fmt(Math.abs(gap))} short` : `${fmt(gap)} extra`}</div>}<div style={{ display: "flex", gap: 10, marginTop: 14 }}><button onClick={cl} style={{ flex: 1, padding: 14, border: "1.5px solid var(--border)", borderRadius: 12, background: "transparent", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 14, cursor: "pointer" }}>Close</button><button onClick={() => { save(); cl(); }} style={{ flex: 2, padding: 14, border: "none", borderRadius: 12, background: w.color, color: "#fff", fontFamily: "var(--font-h)", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Save Count</button></div></div></div>;
}

// Single-wallet, all-history running-balance ledger. Unlike the History
// timeline (month-filtered, all wallets mixed), this lists every transaction
// touching ONE wallet newest-first with the balance after each — so you can
// line it up against a bank/UPI statement and spot the entry you forgot to log.
function LedgerM({ wallet: w, rows, curBal, onReconcile, lastVerifyLabel, onClose: cl }) {
  useLockBodyScroll();
  // Rows carry `verified` (computed by the parent from the wallet's last
  // reconcile): everything at/before your last verify shows a green check,
  // anything logged since shows none. No tapping — verifying the wallet is
  // what stamps the rows. Only reserve the badge gutter when something is
  // actually verified, so an un-reconciled wallet looks exactly as before.
  const anyVerified = rows.some(r => r.verified);
  return <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={cl}>
    <div onClick={e => e.stopPropagation()} style={{ background: "var(--card)", borderRadius: "20px 20px 0 0", padding: "20px 20px 24px", width: "100%", maxWidth: 430, maxHeight: "88vh", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>{onReconcile && <button onClick={() => { hapticLight(); onReconcile(); }} aria-label="Back to reconcile" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", fontSize: 22, lineHeight: 1, padding: "0 6px 0 0", fontFamily: "var(--font-h)" }}>←</button>}<DI2 id={w.id} accent={w.neon || w.color} size={20} /><div style={{ fontFamily: "var(--font-h)", fontSize: 16, fontWeight: 700, color: "var(--text)" }}>{w.name} · Running balance</div></div>
      <p style={{ fontSize: 12.5, color: "var(--muted)", fontFamily: "var(--font-b)", marginBottom: anyVerified ? 8 : 14, lineHeight: 1.5 }}>Compare top-down against your bank/UPI statement. The first row where NOMAD and your statement disagree is where an entry is missing. NOMAD balance: <strong style={{ color: w.color }}>{fmt(curBal)}</strong>.</p>
      {anyVerified && <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 12, fontSize: 11, color: "#6BAA75", fontFamily: "var(--font-h)", fontWeight: 600 }}><CheckCircle size={14} weight="fill" color="#6BAA75" />Verified through your last check{lastVerifyLabel ? ` · ${lastVerifyLabel}` : ""}</div>}
      <div style={{ flex: 1, overflowY: "auto", margin: "0 -4px" }}>
        {rows.length === 0 ? <div style={{ textAlign: "center", padding: "40px 20px", color: "var(--muted)", fontSize: 13 }}>No transactions on this wallet yet.</div> : rows.map((r, i) => <div key={r.id || i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 4px", borderBottom: i < rows.length - 1 ? "1px solid var(--border)" : "none" }}>
          {anyVerified && <div style={{ width: 18, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 0 }} title={r.verified ? "Verified against your last check" : "Logged since your last verify"}>{r.verified && <CheckCircle size={18} weight="fill" color="#6BAA75" />}</div>}
          <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12.5, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label}</div><div style={{ fontSize: 10.5, color: "var(--muted)", fontFamily: "var(--font-b)", marginTop: 1 }}>{dl(r.date)}{r.note ? " · " + r.note : ""}</div></div>
          <div style={{ textAlign: "right", flexShrink: 0 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12.5, fontWeight: 700, color: r.delta < 0 ? "#E07A5F" : "#6BAA75" }}>{r.delta < 0 ? "−" : "+"}{fmt(Math.abs(r.delta))}</div><div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 600, marginTop: 1 }}>= {fmt(r.after)}</div></div>
        </div>)}
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
        <button onClick={cl} style={{ flex: 1, padding: 14, border: "1.5px solid var(--border)", borderRadius: 12, background: "transparent", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 14, cursor: "pointer" }}>Close</button>
        {onReconcile && <button onClick={onReconcile} style={{ flex: 2, padding: 14, border: "none", borderRadius: 12, background: w.color, color: "#fff", fontFamily: "var(--font-h)", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Reconcile this wallet</button>}
      </div>
    </div>
  </div>;
}

function RecEditPanel({ r, recCats, onSave, onClose, wallets: wl = WALLETS }) {
  useLockBodyScroll();
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

function TopoBg() { return <div style={{ position: "absolute", inset: 0, zIndex: 0, overflow: "hidden", pointerEvents: "none" }}><svg viewBox="0 0 375 812" preserveAspectRatio="xMidYMid slice" style={{ width: "100%", height: "100%", opacity: 0.13 }} xmlns="http://www.w3.org/2000/svg"><ellipse cx="180" cy="300" rx="280" ry="180" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="180" cy="300" rx="240" ry="145" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="180" cy="300" rx="200" ry="112" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="180" cy="300" rx="160" ry="82" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="180" cy="300" rx="120" ry="55" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="180" cy="300" rx="80" ry="32" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="180" cy="300" rx="42" ry="14" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="300" cy="560" rx="220" ry="160" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="300" cy="560" rx="185" ry="128" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="300" cy="560" rx="148" ry="98" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="300" cy="560" rx="112" ry="70" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="300" cy="560" rx="76" ry="46" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="300" cy="560" rx="42" ry="24" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="340" cy="140" rx="130" ry="90" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="340" cy="140" rx="100" ry="66" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="340" cy="140" rx="70" ry="44" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="340" cy="140" rx="42" ry="26" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="340" cy="140" rx="20" ry="12" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="40" cy="700" rx="180" ry="130" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="40" cy="700" rx="140" ry="98" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="40" cy="700" rx="100" ry="68" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="40" cy="700" rx="62" ry="40" fill="none" stroke="#7A6A50" strokeWidth="1"/><ellipse cx="40" cy="700" rx="30" ry="18" fill="none" stroke="#7A6A50" strokeWidth="1"/><path d="M 60 300 Q 120 260 180 300 Q 240 340 310 310" fill="none" stroke="#7A6A50" strokeWidth="1"/><path d="M 40 380 Q 130 340 200 370 Q 280 405 350 370" fill="none" stroke="#7A6A50" strokeWidth="1"/><path d="M 20 460 Q 110 420 190 445 Q 270 470 360 440" fill="none" stroke="#7A6A50" strokeWidth="1"/><path d="M 100 180 Q 160 155 220 175 Q 290 200 350 185" fill="none" stroke="#7A6A50" strokeWidth="1"/></svg></div>; }

function AnimNum({ value, money = true, dur = 650 }) {
  const [disp, setDisp] = useState(0);
  const prevRef = useRef(0);
  useEffect(() => {
    const from = prevRef.current, to = Number(value) || 0;
    if (from === to) return;
    prevRef.current = to;
    const t0 = performance.now();
    let raf;
    const tick = now => {
      const p = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      setDisp(roundMoney(from + (to - from) * e));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, dur]);
  return <>{money ? fmt(disp) : String(Math.round(disp))}</>;
}

function Events({ events: evs, expenses: ex, splits: sp, settlements: stl, categories: cats, wallets: wl = WALLETS, staleByEvent = {}, onCreate: oC, onAddExp: oE, onAddSplit: oS, onSettleSplit: oSS, onSettleEventNet: oSEN, onDeleteSplit: oDS, onSkipSplit: oSK = () => {}, onUnskipSplit: oUnskip = () => {}, onDeleteExp: oDE, onEditExp: oEditExp = () => {}, onEditSplit: oEditSplit = () => {}, onMarkDone: oMD, onReopen: oRO, onDelete: oD, onUpdate: oU, onToast: showT = () => {}, dm = false }) {
  const [view, sV] = useState("list"), [selId, sSel] = useState(null), [nn, sNN] = useState(""), [ne, sNE] = useState("film"), [evType, sEvType] = useState("solo"), [evParts, sEvParts] = useState([""]), [evTab, sEvTab] = useState("active");
  const [ea, sEA] = useState(""), [ec, sEC] = useState(cats[0]?.id || ""), [ew, sEW] = useState(wl[0]?.id || "bank"), [en, sEN] = useState(""), [ePaidBy, sEPaidBy] = useState("me");
  // Group-expense split controls: who's included (exclusions only — empty = all),
  // equal vs custom-amount mode, and the per-person custom amounts.
  const [eSplitMode, sESplitMode] = useState("equal"), [eSplitExcl, sESplitExcl] = useState(() => new Set()), [eSplitAmts, sESplitAmts] = useState({});
  const [eEditId, sEEditId] = useState(null); // when set, the Add Expense sheet is editing this expense
  const [eIouEditId, sEIouEditId] = useState(null); // when set, the Add Split sheet is editing this manual IOU
  const resetSplitUI = () => { sESplitMode("equal"); sESplitExcl(new Set()); sESplitAmts({}); };
  const [sn, sSN] = useState(""), [sa, sSA] = useState(""), [sd, sSD] = useState("owed"), [stgt, sSTgt] = useState(null), [spNote, sSPNote] = useState("");
  const [bsMode, sBsM] = useState("equal"), [bsTotal, sBsT] = useState(""), [bsPpl, sBsP] = useState([{ name: "", amount: "" }]), [bsCat, sBsC] = useState(cats[0]?.id || ""), [bsW, sBsW] = useState(wl[0]?.id || "bank"), [bsNote, sBsN] = useState(""), [bsStep, sBsS] = useState(1);
  const [evDelConfirm, sEvDelConfirm] = useState(null);
  const [expDelId, sExpDelId] = useState(null); // expense pending delete-confirm
  const [doneConfirm, sDoneConfirm] = useState(false), [suTgt, sSuTgt] = useState(null), [suW, sSuW] = useState(null), [suAmt, sSuAmt] = useState("");
  const [editOpen, sEditOpen] = useState(false), [enName, sEnName] = useState(""), [enIcon, sEnIcon] = useState("film"), [enParts, sEnParts] = useState([]), [enNew, sEnNew] = useState("");
  const [nd, sND] = useState(localDateKey()), [enDate, sEnDate] = useState(""), [showSettled, sShowSettled] = useState(false);
  const [addSheet, sAddSheet] = useState(null);
  const fmtDate = d => { if (!d) return ""; const dt = new Date(d + "T00:00:00"), M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]; return `${String(dt.getDate()).padStart(2, "0")} ${M[dt.getMonth()]} ${dt.getFullYear()}`; };
  const sel = evs.find(e => e.id === selId);
  const create = () => { if (!nn.trim()) { showT("Give the event a name", "error"); return; } const reserved = new Set(["you", "me"]); const parts = evType === "group" ? evParts.map(p => p.trim()).filter((p, i, arr) => p && !reserved.has(p.toLowerCase()) && arr.findIndex(x => x.toLowerCase() === p.toLowerCase()) === i) : []; if (evType === "group" && parts.length === 0) { showT("Add at least one participant for a group event", "error"); return; } const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(nd) ? nd : localDateKey(); oC({ id: uid(), name: nn.trim(), emoji: ne, date: dateOk, status: "active", type: evType, participants: parts }); sNN(""); sNE("film"); sEvType("solo"); sEvParts([""]); sND(localDateKey()); sV("list") };
  // Shared split computation for add AND edit of a group expense. Resolves the
  // payer, validates the chosen split, and returns { splitWith, payer,
  // paidByField } — or { error } for the toast. Equal/custom/subset all flow
  // through here so add and edit can never drift apart.
  const computeExpSplit = (a) => {
    const isGrp = sel.type === "group";
    const partsList = isGrp ? (sel.participants || []).filter((v, i, arr) => v && v.trim() && arr.findIndex(x => x.toLowerCase() === v.toLowerCase()) === i) : [];
    const payer = isGrp ? (ePaidBy === "me" ? "You" : (partsList.find(p => p.toLowerCase() === String(ePaidBy).toLowerCase()) || "You")) : undefined;
    const paidByField = isGrp ? (payer === "You" ? "me" : payer) : undefined;
    let splitWith = null;
    if (isGrp && partsList.length > 0) {
      const allP = ["You", ...partsList];
      const included = allP.filter(p => !eSplitExcl.has(p));
      if (included.length === 0) return { error: "Pick at least one person to split with" };
      if (eSplitMode === "custom") {
        const map = {}; let sum = 0;
        for (const p of included) { const v = parseAmount(eSplitAmts[p] ?? ""); const val = Number.isFinite(v) && v > 0 ? roundMoney(v) : 0; map[p] = val; sum = roundMoney(sum + val); }
        if (Math.abs(sum - a) > 0.05) return { error: `Custom shares add up to ${fmt(sum)}, not ${fmt(a)}` };
        splitWith = map;
      } else {
        const eq = distributeAmount(a, included.length);
        splitWith = Object.fromEntries(included.map((p, i) => [p, eq[i] || 0]));
      }
    }
    return { splitWith, payer, paidByField, isGrp };
  };
  // Create the auto-IOUs for a group expense from its split breakdown. When you
  // paid, each included person owes you their share; when someone else paid, only
  // YOUR share is tracked as a debt to them.
  const makeExpIOUs = (gid, splitWith, payer, noteBase) => {
    if (!splitWith) return;
    if (payer === "You") {
      Object.entries(splitWith).forEach(([person, share]) => { if (person === "You" || !(share > 0)) return; oS({ id: uid(), name: person, amount: share, direction: "owed", settled: false, eventId: sel.id, groupId: gid, note: `Auto: ${noteBase}` }); });
    } else {
      const yourShare = splitWith["You"] || 0;
      if (yourShare > 0) oS({ id: uid(), name: payer, amount: yourShare, direction: "owe", settled: false, eventId: sel.id, groupId: gid, note: `Auto: ${noteBase}` });
    }
  };
  // Save edits to an existing event expense: regenerates its auto-IOUs from the
  // new amount/split (clearing the old ones + their settlements via onEditExp).
  const saveExpEdit = () => {
    const exp = ex.find(e => e.id === eEditId); if (!exp) { showT("Expense not found", "error"); return false; }
    const a = parseAmount(ea); if (!Number.isFinite(a) || a <= 0) { showT("Enter a valid amount", "error"); return false; }
    const cs = computeExpSplit(a); if (cs.error) { showT(cs.error, "error"); return false; }
    const gid = exp.groupId || exp.id;
    const okE = oEditExp(eEditId, { amount: a, categoryId: ec, walletId: ew, note: en, paidBy: cs.paidByField || null, splitWith: cs.splitWith || null, ...(cs.splitWith ? { groupId: gid } : {}) });
    if (okE === false) return false;
    makeExpIOUs(gid, cs.splitWith, cs.payer, (en || cats.find(c => c.id === ec)?.name || "Group expense").slice(0, 400));
    sEEditId(null); sEA(""); sEN(""); resetSplitUI();
    showT("Expense updated", "success");
    return true;
  };
  const openEditExp = (exp) => {
    sEEditId(exp.id); sEA(String(exp.amount)); sEC(exp.categoryId || cats[0]?.id || ""); sEW(exp.walletId && exp.walletId !== "__tracked__" ? exp.walletId : (wl[0]?.id || "bank")); sEN(exp.note || ""); sEPaidBy(!exp.paidBy || exp.paidBy === "me" ? "me" : exp.paidBy);
    const sw = exp.splitWith;
    if (sw && typeof sw === "object") {
      const allP = ["You", ...(sel.participants || []).filter((v, i, arr) => v && v.trim() && arr.findIndex(x => x.toLowerCase() === v.toLowerCase()) === i)];
      const excl = new Set(allP.filter(p => !(Number(sw[p]) > 0)));
      const included = allP.filter(p => !excl.has(p));
      const eq = distributeAmount(exp.amount, Math.max(1, included.length));
      const isEqual = included.every((p, i) => Math.abs((Number(sw[p]) || 0) - (eq[i] || 0)) < 0.005);
      sESplitExcl(excl); sESplitMode(isEqual ? "equal" : "custom"); sESplitAmts(Object.fromEntries(included.map(p => [p, String(sw[p])])));
    } else { resetSplitUI(); }
    sAddSheet("expense");
  };
  const addExp = () => {
    const a = parseAmount(ea); if (!Number.isFinite(a) || a <= 0 || !sel) { showT("Enter a valid amount", "error"); return false; }
    const cs = computeExpSplit(a); if (cs.error) { showT(cs.error, "error"); return false; }
    const expId = uid();
    const ok = oE({ id: expId, amount: a, categoryId: ec, walletId: ew, note: en, date: localDateKey(), eventId: sel.id, ...(cs.paidByField ? { paidBy: cs.paidByField } : {}), ...(cs.splitWith ? { splitWith: cs.splitWith, groupId: expId } : {}) });
    if (ok !== false) {
      if (cs.splitWith) {
        const noteBase = (en || cats.find(c => c.id === ec)?.name || "Group expense").slice(0, 400);
        makeExpIOUs(expId, cs.splitWith, cs.payer, noteBase);
      }
      sEA(""); sEN(""); resetSplitUI();
      return true;
    }
    return false;
  };
  const addSplit = () => { const a = parseAmount(sa); if (!sn.trim() || !Number.isFinite(a) || a <= 0 || !sel) { if (!sn.trim()) showT("Enter a name", "error"); else if (sa) showT("Enter a valid amount", "error"); return false; } if (a > 10000000) { showT("Amount too large (max ₹1 crore)", "error"); return false; } if (eIouEditId) { oEditSplit(eIouEditId, { name: sn.trim(), amount: roundMoney(a), direction: sd, note: spNote || "" }); sEIouEditId(null); sSN(""); sSA(""); sSPNote(""); showT("IOU updated", "success"); return true; } oS({ id: uid(), name: sn.trim(), amount: roundMoney(a), direction: sd, settled: false, eventId: sel.id, note: spNote }); sSN(""); sSA(""); sSPNote(""); return true; };
  const openEditSplit = (s) => { sEIouEditId(s.id); sSN(s.name || ""); sSA(String(s.amount)); sSD(s.direction || "owed"); sSPNote(s.note || ""); sAddSheet("split"); };
  // One pass over expenses/settlements grouped by event, instead of re-filtering
  // both arrays for every event card (the list header sums netSpent over ALL events).
  const evAgg = useMemo(() => {
    const m = {};
    const get = id => (m[id] = m[id] || { exps: [], out: 0, inn: 0 });
    ex.forEach(x => { if (x.eventId) get(x.eventId).exps.push(x); });
    (stl || []).forEach(x => { if (x.eventId) { if (x.direction === "owe") get(x.eventId).out += x.amount; else if (x.direction === "owed") get(x.eventId).inn += x.amount; } });
    return m;
  }, [ex, stl]);
  const netSpent = (evId) => {
    const ev = evs.find(x => x.id === evId);
    const agg = evAgg[evId] || { exps: [], out: 0, inn: 0 };
    const eExps = agg.exps;
    const e = eExps.reduce((s, x) => s + x.amount, 0);
    const settleOut = agg.out;
    const settleIn = agg.inn;
    if (ev?.type === "group") {
      const parts = (ev.participants || []).filter((v, i, arr) => v && v.trim() && arr.findIndex(x => x.toLowerCase() === v.toLowerCase()) === i);
      // Your own share across this event's expenses, honouring each expense's
      // splitWith breakdown (unequal/subset splits) and falling back to an equal
      // split where absent — must agree with the per-expense split records.
      return Math.max(0, expenseShareMap(eExps, ["You", ...parts])["You"] || 0);
    }
    return Math.max(0, e + settleOut - settleIn);
  };
  const paidBySplit = useMemo(() => { const m = {}; (stl || []).forEach(x => { if (x.splitId != null) m[x.splitId] = (m[x.splitId] || 0) + x.amount; }); return m; }, [stl]);
  const remainForSplit = s => roundMoney(s.amount - (paidBySplit[s.id] || 0));
  // Entry forms, modals, and the bill splitter are component-level state shared
  // by every event. Always navigate into detail through goDetail (never raw
  // sSel/sV) so a half-filled form can't leak onto the next event.
  const goDetail = (id) => { sSel(id); sEPaidBy("me"); sEA(""); sEN(""); sEC(cats[0]?.id || ""); sEW(wl[0]?.id || "bank"); sSN(""); sSA(""); sSPNote(""); sSD("owed"); sSTgt(null); sBsS(1); sBsM("equal"); sBsT(""); sBsP([{ name: "", amount: "" }]); sBsN(""); sBsC(cats[0]?.id || ""); sBsW(wl[0]?.id || "bank"); sEvDelConfirm(null); sDoneConfirm(false); sSuTgt(null); sSuAmt(""); sEditOpen(false); sShowSettled(false); sAddSheet(null); sEEditId(null); sEIouEditId(null); resetSplitUI(); sV("detail"); };

  const delEvPendingCnt = evDelConfirm ? sp.filter(s => s.eventId === evDelConfirm && !s.settled && !s.skipped && !s.deleted_at).length : 0;
  const confirmOverlay = evDelConfirm ? (
    <div style={{ position: "fixed", inset: 0, background: dm ? "rgba(0,0,0,0.65)" : "rgba(20,10,0,0.45)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div style={{ background: dm ? "#1a1108" : "#f5f0e6", backgroundImage: `radial-gradient(circle, ${dm ? "rgba(180,140,90,0.12)" : "rgba(140,100,50,0.1)"} 1.2px, transparent 1.2px)`, backgroundSize: "18px 18px", backgroundPosition: "9px 9px", borderRadius: "20px 20px 0 0", padding: "28px 24px 40px", width: "100%", maxWidth: 430, maxHeight: "80vh", overflowY: "auto", borderTop: `1px solid ${dm ? "rgba(180,140,90,0.25)" : "rgba(160,120,70,0.2)"}` }}>
        <div style={{ fontFamily: "var(--font-h)", fontSize: 16, fontWeight: 700, color: dm ? "#f0e6d3" : "#2a1f10", marginBottom: 8 }}>Delete Event?</div>
        <div style={{ fontSize: 13, color: delEvPendingCnt > 0 ? "#c0524a" : (dm ? "#8a7560" : "#9a8060"), fontFamily: "var(--font-b)", marginBottom: 24, lineHeight: 1.6 }}>{delEvPendingCnt > 0 ? `Heads up — this event still has ${delEvPendingCnt} unsettled IOU${delEvPendingCnt === 1 ? "" : "s"}. ` : ""}Deleting removes the event together with its splits and settlements (logged expenses stay in your history). You can Undo for a few seconds, or restore later from Settings → Recently Deleted.</div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={() => sEvDelConfirm(null)} style={{ flex: 1, padding: 13, border: `1px solid ${dm ? "rgba(200,169,110,0.35)" : "rgba(138,96,48,0.3)"}`, borderRadius: 10, background: dm ? "rgba(30,22,14,0.7)" : "rgba(240,234,220,0.8)", color: dm ? "#c8a96e" : "#8a6030", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
          <button onClick={() => { oD(evDelConfirm); sEvDelConfirm(null); if (view === "detail") sV("list"); }} style={{ flex: 1, padding: 13, border: "none", borderRadius: 10, background: "#c0524a", color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Delete</button>
        </div>
      </div>
    </div>
  ) : null;

  const pC = dm ? "#1a1208" : "#F7F3EC", inkC = dm ? "#f0e6d3" : "#2C2416", mutC = dm ? "#8a7560" : "#9C8F7A", cardC = dm ? "#251a0e" : "#ffffff", stoneC = dm ? "#362510" : "#EDE8DF", stripC = dm ? "#0f0a05" : "#2C2416", terraC = "#C4603A";
  const brdC = dm ? "rgba(180,140,90,0.22)" : "rgba(224,217,206,0.9)";
  const wis = { minWidth: 0, background: dm ? "rgba(15,10,5,0.45)" : "rgba(255,255,255,0.6)", border: `1px solid ${brdC}`, borderRadius: 10, padding: "11px 14px", color: inkC, fontSize: 14, fontFamily: "var(--font-b)", outline: "none", width: "100%", boxSizing: "border-box" };
  const wls = { fontSize: 10, color: mutC, textTransform: "uppercase", letterSpacing: "1.2px", marginBottom: 6, display: "block", fontWeight: 600 };
  if (view === "create") return <div style={{ position: "relative", background: pC, height: "calc(100vh - 90px)", display: "flex", flexDirection: "column", overflow: "hidden", textAlign: "left" }}><TopoBg />
    <div style={{ position: "relative", zIndex: 10, padding: "max(18px, calc(env(safe-area-inset-top, 0px) + 12px)) 20px 14px" }}><button className="evPress" onClick={() => sV("list")} style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", color: mutC, cursor: "pointer", fontSize: 13, letterSpacing: "0.5px", padding: 0 }}><CaretLeft size={15} />Events</button></div>
    <div style={{ position: "relative", zIndex: 10, flex: 1, overflowY: "auto", padding: "2px 22px 28px" }}>
      <div style={{ fontFamily: "'Playfair Display', Georgia, serif", fontSize: 24, color: inkC, letterSpacing: "-0.3px", animation: "evSlideUp 0.4s ease both" }}>New Event</div>
      <div style={{ fontSize: 11, color: mutC, letterSpacing: "1.2px", textTransform: "uppercase", marginTop: 2, marginBottom: 20, animation: "evSlideUp 0.4s ease both" }}>Track an outing, trip or plan</div>
      <div style={{ display: "flex", gap: 8, marginBottom: 18, animation: "evSlideUp 0.4s 0.05s ease both" }}>{[{ id: "solo", label: "Solo", icon: "pin", sub: "only my spending tracked" }, { id: "group", label: "Group", icon: "users", sub: "shared total + who owes whom" }].map(t => <button key={t.id} className="evPress" onClick={() => sEvType(t.id)} style={{ flex: 1, padding: "12px 14px", borderRadius: 14, border: `1px solid ${evType === t.id ? terraC : brdC}`, background: evType === t.id ? "rgba(196,96,58,0.07)" : "transparent", cursor: "pointer", textAlign: "left" }}><div style={{ display: "flex", alignItems: "center", gap: 7 }}>{t.icon === "pin" ? <PushPin size={14} color={evType === t.id ? terraC : mutC} /> : <Users size={14} color={evType === t.id ? terraC : mutC} />}<span style={{ fontSize: 13, fontWeight: 600, color: evType === t.id ? terraC : inkC }}>{t.label}</span></div><div style={{ fontSize: 10, color: mutC, marginTop: 3, lineHeight: 1.4 }}>{t.sub}</div></button>)}</div>
      <div style={{ animation: "evSlideUp 0.4s 0.08s ease both" }}><label style={wls}>Icon</label><div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>{EI.map(id => <button key={id} className="evPress" onClick={() => sNE(id)} style={{ width: 38, height: 38, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", border: `1px solid ${ne === id ? terraC : brdC}`, background: ne === id ? "rgba(196,96,58,0.1)" : "transparent", cursor: "pointer", color: ne === id ? terraC : mutC }}><EvIcon id={id} size={18} /></button>)}</div><label style={wls}>Event Name</label><input value={nn} onChange={e => sNN(e.target.value)} placeholder="e.g. Movie Night, Goa Trip…" style={{ ...wis, marginBottom: 16 }} /><label style={wls}>Date</label><input type="date" value={nd} onChange={e => sND(e.target.value)} style={{ ...wis, marginBottom: evType === "group" ? 16 : 22 }} />{evType === "group" && <div style={{ marginBottom: 22 }}><label style={wls}>Participants ("You" is always included)</label>{evParts.map((p, i) => <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}><input value={p} onChange={e => sEvParts(pp => pp.map((x, idx) => idx === i ? e.target.value : x))} placeholder={`Person ${i + 1} name`} style={{ ...wis, flex: 1, width: "auto" }} />{evParts.length > 1 && <button className="evPress" onClick={() => sEvParts(pp => pp.filter((_, idx) => idx !== i))} style={{ background: "none", border: "none", color: mutC, cursor: "pointer", opacity: 0.5, display: "flex", padding: 0 }}><IconX size={15} /></button>}</div>)}<button className="evPress" onClick={() => sEvParts(p => [...p, ""])} style={{ background: "none", border: `1px dashed ${brdC}`, borderRadius: 10, padding: "9px 14px", fontSize: 12, color: mutC, cursor: "pointer", width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}><IconPlus size={13} />Add person</button></div>}<button className="evPress" onClick={create} style={{ width: "100%", padding: 15, border: "none", borderRadius: 14, background: terraC, color: "#fff", fontSize: 14, fontWeight: 700, letterSpacing: "0.3px", cursor: "pointer", boxShadow: "0 4px 16px rgba(196,96,58,0.3)", display: "flex", alignItems: "center", justifyContent: "center", gap: 7 }}><IconPlus size={15} />Create Event</button></div>
    </div></div>;

  if (view === "detail" && sel) {
    const eExps = ex.filter(e => e.eventId === sel.id), eSp = sp.filter(s => s.eventId === sel.id), ns = netSpent(sel.id), tp = eExps.reduce((s, e) => s + e.amount, 0);
    const isGroup = sel.type === "group";
    const allParts = isGroup ? ["You", ...(sel.participants || []).filter((v, i, arr) => v && v.trim() && arr.findIndex(x => x.toLowerCase() === v.toLowerCase()) === i)] : [];
    const grpPaid = isGroup ? allParts.reduce((acc, p) => { const pl = p.toLowerCase(); acc[p] = eExps.filter(e => p === "You" ? (!e.paidBy || e.paidBy === "me") : (e.paidBy || "").toLowerCase() === pl).reduce((s, e) => s + e.amount, 0); return acc; }, {}) : {};
    const grpTotal = isGroup ? Object.values(grpPaid).reduce((s, v) => s + v, 0) : 0;
    const grpShareMap = isGroup && allParts.length > 0 ? expenseShareMap(eExps, allParts) : {};
    const grpShare = isGroup && allParts.length > 0 ? (grpShareMap["You"] ?? roundMoney(grpTotal / allParts.length)) : 0;
    // grpSettled reconciles the EXPENSE-derived balance only, so it must count
    // settlements of the auto-IOUs created by addExp (they carry a groupId that
    // matches an event expense) — never settlements of manually-added split IOUs,
    // which live in their own owe/owed tally. Counting those here over-subtracts
    // and leaves a phantom balance after everything looks settled.
    const grpExpIds = new Set(eExps.map(e => e.id));
    const eStl = isGroup ? (stl || []).filter(s => s.eventId === sel.id && s.groupId && grpExpIds.has(s.groupId)) : [];
    const grpSettled = isGroup ? Object.fromEntries(allParts.map(p => {
      if (p === "You") {
        const out = eStl.filter(s => s.direction === "owe").reduce((t, s) => t + s.amount, 0);
        const inn = eStl.filter(s => s.direction === "owed").reduce((t, s) => t + s.amount, 0);
        return [p, inn - out];
      }
      const pl = p.toLowerCase();
      const out = eStl.filter(s => s.direction === "owe" && (s.splitName || "").toLowerCase() === pl).reduce((t, s) => t + s.amount, 0);
      const inn = eStl.filter(s => s.direction === "owed" && (s.splitName || "").toLowerCase() === pl).reduce((t, s) => t + s.amount, 0);
      return [p, out - inn];
    })) : {};
    const tO = eSp.filter(s => s.direction === "owe" && !s.settled).reduce((t, s) => t + s.amount, 0), tI = eSp.filter(s => s.direction === "owed" && !s.settled).reduce((t, s) => t + s.amount, 0);
    const suggested = (() => { if (!isGroup || allParts.length < 2) return []; const bals = allParts.map(p => ({ name: p, bal: roundMoney((grpPaid[p] || 0) - (grpShareMap[p] ?? grpShare) - (grpSettled[p] || 0)) })); const cr = bals.filter(b => b.bal > 0.01).map(b => ({ ...b })).sort((a, b) => b.bal - a.bal); const db = bals.filter(b => b.bal < -0.01).map(b => ({ ...b })).sort((a, b) => a.bal - b.bal); const out = []; let ci = 0, di = 0; while (ci < cr.length && di < db.length) { const amt = roundMoney(Math.min(cr[ci].bal, -db[di].bal)); out.push({ from: db[di].name, to: cr[ci].name, amt }); cr[ci].bal = roundMoney(cr[ci].bal - amt); db[di].bal = roundMoney(db[di].bal + amt); if (cr[ci].bal < 0.01) ci++; if (db[di].bal > -0.01) di++; } return out; })();
    const staleIds = new Set((staleByEvent[sel.id] || []).map(x => x.id));
    const pendingCnt = eSp.filter(x => !x.settled).length;
    const partActive = p => { const pl = p.toLowerCase(); return eExps.some(e => (e.paidBy || "").toLowerCase() === pl) || eSp.some(x => (x.name || "").toLowerCase() === pl) || eStl.some(x => (x.splitName || "").toLowerCase() === pl); };
    const openEdit = () => { sEnName(sel.name); sEnIcon(sel.emoji || "film"); sEnParts([...(sel.participants || [])]); sEnNew(""); sEnDate(sel.date || localDateKey()); sEditOpen(true); };
    const saveEdit = () => { const nm2 = enName.trim(); if (!nm2) { showT("Event name can't be empty", "error"); return; } oU({ ...sel, name: nm2, emoji: enIcon, date: /^\d{4}-\d{2}-\d{2}$/.test(enDate) ? enDate : sel.date, ...(isGroup ? { participants: enParts } : {}) }); sEditOpen(false); };
    const addEnPart = () => { const v = enNew.trim(); if (!v) return; const reserved = new Set(["you", "me"]); if (reserved.has(v.toLowerCase()) || enParts.some(x => x.toLowerCase() === v.toLowerCase())) { showT("That name is taken or reserved", "error"); return; } sEnParts(pp => [...pp, v]); sEnNew(""); };
    const shareSummary = () => { const lines = [`${sel.name} — ${fmtDate(sel.date)}`]; if (isGroup) { lines.push(`Group total ${fmt(grpTotal)} · ${fmt(grpShare)} each (${allParts.length} people)`, "", "Paid:"); allParts.forEach(p => lines.push(`• ${p}: ${fmt(grpPaid[p] || 0)}`)); if (suggested.length) { lines.push("", "Settle up:"); suggested.forEach(x => lines.push(`• ${x.from} → ${x.to}: ${fmt(x.amt)}`)); } } else { lines.push(`Net spent ${fmt(ns)} · total paid ${fmt(tp)}`); if (eExps.length) { lines.push("", "Expenses:"); [...eExps].reverse().forEach(e => { const cat = cats.find(c => c.id === e.categoryId); lines.push(`• ${cat?.name || "Other"}${e.note ? ` (${e.note})` : ""}: ${fmt(e.amount)}`); }); } } const text = lines.join("\n"); if (navigator.share) { navigator.share({ text }).catch(() => {}); } else if (navigator.clipboard?.writeText) { navigator.clipboard.writeText(text).then(() => showT("Summary copied — paste it anywhere", "success")).catch(() => showT("Could not copy summary", "error")); } else { showT("Sharing not supported here", "error"); } };
    const acc = "#E07A5F", grn = "#6BAA75", ind = "#7B8CDE", gld = "#FBBF24";
    const ccL = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: 20 };
    const secHd = { fontFamily: "var(--font-h)", fontSize: 11, color: "var(--muted)", fontWeight: 600, letterSpacing: "0.5px" };
    const icoBtn = { width: 36, height: 36, borderRadius: "50%", border: "1px solid var(--border)", background: "var(--card)", color: "var(--muted)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", padding: 0, flexShrink: 0 };
    const shO = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" };
    const shI = { background: "var(--card)", borderRadius: "20px 20px 0 0", padding: "20px 18px calc(env(safe-area-inset-bottom, 0px) + 24px)", width: "100%", maxWidth: 430, maxHeight: "88vh", overflowY: "auto", textAlign: "left", borderTop: "1px solid var(--border)" };
    const shHd = (t, close) => <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{t}</div><button onClick={close} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", display: "flex", padding: 4 }}><IconX size={16} /></button></div>;
    return <div style={{ textAlign: "left", padding: "10px 16px calc(env(safe-area-inset-bottom, 0px) + 120px)", maxWidth: 520, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}><button className="evPress" onClick={() => sV("list")} style={{ display: "flex", alignItems: "center", gap: 4, background: "var(--card)", border: "1px solid var(--border)", borderRadius: 20, padding: "8px 14px 8px 10px", color: "var(--ts)", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}><IconChevronLeft size={14} />Events</button><div style={{ display: "flex", gap: 8 }}><button className="evPress" onClick={shareSummary} title="Share summary" style={icoBtn}><ShareNetwork size={15} /></button><button className="evPress" onClick={openEdit} title="Edit event" style={icoBtn}><PencilSimple size={15} /></button><button className="evPress" onClick={() => sEvDelConfirm(sel.id)} title="Delete event" style={{ ...icoBtn, color: "#D4726A", borderColor: "#D4726A40" }}><Trash size={15} /></button></div></div>
      <div style={{ position: "relative", overflow: "hidden", borderRadius: 24, padding: 18, background: "linear-gradient(150deg, #2b2b3a, #18181f)", marginBottom: 14, animation: "evSlideUp 0.4s ease both" }}>
        <div style={{ position: "absolute", top: -60, right: -40, width: 200, height: 200, borderRadius: "50%", background: "radial-gradient(circle, rgba(224,122,95,0.22), transparent 70%)", pointerEvents: "none" }} />
        <div style={{ position: "relative", display: "flex", alignItems: "flex-start", gap: 12 }}><div style={{ width: 42, height: 42, borderRadius: 14, background: "rgba(224,122,95,0.16)", display: "flex", alignItems: "center", justifyContent: "center", color: acc, flexShrink: 0 }}><EvIcon id={sel.emoji} size={22} /></div><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 17, fontWeight: 700, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sel.name}</div><div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginTop: 3, fontFamily: "var(--font-b)" }}>{fmtDate(sel.date)} · <span style={{ color: sel.status === "active" ? gld : "#7ED99B", fontWeight: 600 }}>{sel.status === "active" ? "Active" : "Done"}</span>{isGroup && <span> · Group</span>}</div></div>{sel.status === "active" ? <button className="evPress" onClick={() => pendingCnt > 0 ? sDoneConfirm(true) : oMD(sel.id)} style={{ display: "flex", alignItems: "center", gap: 4, padding: "7px 12px", border: "none", borderRadius: 18, background: "rgba(107,170,117,0.22)", color: "#7ED99B", fontFamily: "var(--font-h)", fontSize: 11, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}><IconCheck size={12} />Done</button> : <button className="evPress" onClick={() => oRO(sel.id)} style={{ display: "flex", alignItems: "center", gap: 4, padding: "7px 12px", border: "none", borderRadius: 18, background: "rgba(251,191,36,0.18)", color: gld, fontFamily: "var(--font-h)", fontSize: 11, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}><IconClock size={12} />Reopen</button>}</div>
        <div style={{ position: "relative", marginTop: 16 }}><div style={{ fontSize: 10, color: "rgba(255,255,255,0.45)", fontFamily: "var(--font-h)", fontWeight: 600, letterSpacing: "1.2px" }}>{isGroup ? "GROUP TOTAL" : "NET SPENT"}</div><div style={{ fontFamily: "var(--font-h)", fontSize: 34, fontWeight: 800, color: "#fff", lineHeight: 1.15, margin: "2px 0 4px" }}><AnimNum value={isGroup ? grpTotal : ns} /></div><div style={{ fontSize: 11.5, color: "rgba(255,255,255,0.55)", fontFamily: "var(--font-b)" }}>{isGroup ? <>Your share <strong style={{ color: "#fff" }}>{fmt(grpShare)}</strong> · {allParts.length} people</> : <>Total paid <strong style={{ color: "#fff" }}>{fmt(tp)}</strong> · {eExps.length} {eExps.length === 1 ? "entry" : "entries"}</>}</div></div>
        {eExps.length > 0 && (() => { const m = {}; eExps.forEach(e => { m[e.categoryId] = (m[e.categoryId] || 0) + e.amount; }); const rows = Object.entries(m).map(([cid, amt]) => ({ cat: cats.find(c => c.id === cid) || { id: cid, name: "Other", color: "#8A8A9A" }, amt })).sort((a, b) => b.amt - a.amt); const top = rows.slice(0, 3), rest = rows.length - top.length; return <div style={{ position: "relative", marginTop: 14 }}><div style={{ display: "flex", height: 5, borderRadius: 3, overflow: "hidden", gap: 2, marginBottom: 7 }}>{rows.map(r => <div key={r.cat.id} style={{ width: `${Math.max(2, r.amt / tp * 100)}%`, background: r.cat.color, borderRadius: 3 }} />)}</div><div style={{ display: "flex", flexWrap: "wrap", gap: "3px 12px" }}>{top.map(r => <span key={r.cat.id} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, color: "rgba(255,255,255,0.6)", fontFamily: "var(--font-b)" }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: r.cat.color, flexShrink: 0 }} />{r.cat.name} <strong style={{ color: "rgba(255,255,255,0.85)" }}>{fmt(r.amt)}</strong></span>)}{rest > 0 && <span style={{ fontSize: 10, color: "rgba(255,255,255,0.45)" }}>+{rest} more</span>}</div></div>; })()}
      </div>
      {sel.status === "active" && <div style={{ display: "flex", gap: 8, marginBottom: 14, animation: "evSlideUp 0.4s 0.05s ease both" }}><button className="evPress" onClick={() => { sEEditId(null); resetSplitUI(); sAddSheet("expense"); }} style={{ flex: 1, padding: "12px 6px", borderRadius: 14, border: `1.5px solid ${acc}40`, background: acc + "14", color: acc, fontFamily: "var(--font-h)", fontSize: 12.5, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}><IconPlus size={14} />Expense</button><button className="evPress" onClick={() => { sEIouEditId(null); sSN(""); sSA(""); sSD("owed"); sSPNote(""); sAddSheet("split"); }} style={{ flex: 1, padding: "12px 6px", borderRadius: 14, border: `1.5px solid ${grn}40`, background: grn + "14", color: grn, fontFamily: "var(--font-h)", fontSize: 12.5, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}><ArrowsLeftRight size={14} />Split</button>{!isGroup && <button className="evPress" onClick={() => sAddSheet("bill")} style={{ flex: 1, padding: "12px 6px", borderRadius: 14, border: `1.5px solid ${ind}40`, background: ind + "14", color: ind, fontFamily: "var(--font-h)", fontSize: 12.5, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}><Receipt size={14} />Bill Split</button>}</div>}
      {eSp.length > 0 && <div style={{ display: "flex", gap: 8, marginBottom: 14, animation: "evSlideUp 0.4s 0.08s ease both" }}><div style={{ ...ccL, flex: 1, borderRadius: 16, padding: "11px 14px" }}><div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9, color: acc, letterSpacing: "0.8px", fontFamily: "var(--font-h)", fontWeight: 700 }}><IconArrowUp size={10} />YOU OWE</div><div style={{ fontFamily: "var(--font-h)", fontSize: 18, fontWeight: 700, color: acc, marginTop: 3 }}><AnimNum value={tO} /></div></div><div style={{ ...ccL, flex: 1, borderRadius: 16, padding: "11px 14px" }}><div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9, color: grn, letterSpacing: "0.8px", fontFamily: "var(--font-h)", fontWeight: 700 }}><IconArrowDown size={10} />OWED TO YOU</div><div style={{ fontFamily: "var(--font-h)", fontSize: 18, fontWeight: 700, color: grn, marginTop: 3 }}><AnimNum value={tI} /></div></div></div>}
      {eExps.length === 0 && eSp.length === 0 && <div style={{ ...ccL, textAlign: "center", padding: "28px 20px", marginBottom: 14, animation: "evSlideUp 0.4s 0.1s ease both" }}><div style={{ display: "flex", justifyContent: "center", marginBottom: 8, color: "var(--muted)", opacity: 0.6 }}><Compass size={30} /></div><div style={{ fontFamily: "var(--font-h)", fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Nothing logged yet</div><div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 4, fontFamily: "var(--font-b)" }}>{sel.status === "active" ? "Use the buttons above to add the first expense." : "No spending was recorded for this event."}</div></div>}
      {isGroup && allParts.length > 1 && <div style={{ ...ccL, padding: "14px 16px 6px", marginBottom: 14, animation: "evSlideUp 0.4s 0.1s ease both" }}><div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}><span style={secHd}>BALANCES</span><span style={{ fontSize: 10.5, color: "var(--muted)", fontFamily: "var(--font-b)" }}>your share {fmt(grpShare)}</span></div>{allParts.map(p => { const paid = grpPaid[p] || 0, bal = roundMoney(paid - (grpShareMap[p] ?? grpShare) - (grpSettled[p] || 0)); const settledP = Math.abs(bal) < 0.01; const av = avatarColor(p); return <div key={p} style={{ display: "flex", alignItems: "center", gap: 11, padding: "10px 0", borderBottom: "1px solid var(--border)", animation: "evRowIn 0.35s ease both" }}><div style={{ width: 34, height: 34, borderRadius: "50%", background: av + "1C", color: av, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, fontFamily: "var(--font-h)", flexShrink: 0 }}>{initials(p)}</div><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-h)" }}>{p}</div><div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 1, fontFamily: "var(--font-b)" }}>paid {fmt(paid)} · share {fmt(grpShareMap[p] ?? grpShare)}</div></div><div style={{ textAlign: "right", flexShrink: 0 }}>{settledP ? <span style={{ fontSize: 11, color: "var(--muted)", display: "inline-flex", alignItems: "center", gap: 3 }}><IconCheck size={11} />settled</span> : <><div style={{ fontFamily: "var(--font-h)", fontSize: 14.5, fontWeight: 700, color: bal > 0 ? grn : acc }}>{fmt(Math.abs(bal))}</div><div style={{ fontSize: 8.5, letterSpacing: "0.8px", color: bal > 0 ? grn : acc, fontFamily: "var(--font-h)", fontWeight: 600 }}>{bal > 0 ? "GETS BACK" : "OWES"}</div></>}</div></div>; })}{suggested.length > 0 && <div style={{ padding: "10px 0 8px" }}><div style={{ ...secHd, marginBottom: 8 }}>SETTLE UP</div>{suggested.map((g, i) => { const involvesYou = g.from === "You" || g.to === "You"; const openSu = () => { sSuTgt(g); sSuW(wl[0]?.id || "bank"); sSuAmt(String(g.amt)); }; return <div key={i} role={involvesYou ? "button" : undefined} tabIndex={involvesYou ? 0 : undefined} onKeyDown={involvesYou ? e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openSu(); } } : undefined} onClick={involvesYou ? openSu : undefined} className={involvesYou ? "evPress" : undefined} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", marginBottom: 6, borderRadius: 12, background: involvesYou ? ind + "12" : "var(--bg)", border: `1px solid ${involvesYou ? ind + "35" : "var(--border)"}`, cursor: involvesYou ? "pointer" : "default", animation: "evRowIn 0.35s ease both", animationDelay: `${Math.min(i, 8) * 0.05}s` }}><span style={{ fontSize: 12.5, fontWeight: 600, fontFamily: "var(--font-h)", color: g.from === "You" ? acc : "var(--text)" }}>{g.from}</span><span style={{ display: "inline-flex", animation: "evNudge 1.6s ease-in-out infinite", color: "var(--muted)" }}><ArrowRight size={12} /></span><span style={{ fontSize: 12.5, fontWeight: 600, fontFamily: "var(--font-h)", color: g.to === "You" ? grn : "var(--text)" }}>{g.to}</span><span style={{ marginLeft: "auto", fontFamily: "var(--font-h)", fontSize: 13.5, fontWeight: 700, color: "var(--text)" }}>{fmt(g.amt)}</span>{involvesYou && <span style={{ fontSize: 10, fontWeight: 700, color: ind, fontFamily: "var(--font-h)", display: "inline-flex", alignItems: "center", gap: 2 }}>Settle<IconChevronRight size={11} /></span>}</div>; })}</div>}</div>}
      {eExps.length > 0 && <div style={{ ...ccL, padding: "14px 16px 6px", marginBottom: 14, animation: "evSlideUp 0.4s 0.13s ease both" }}><div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}><span style={secHd}>EXPENSES</span><span style={{ fontSize: 10.5, color: "var(--muted)", fontFamily: "var(--font-b)" }}>{eExps.length}</span></div>{[...eExps].reverse().map((e, xi, arr) => { const cat = cats.find(c => c.id === e.categoryId) || { id: "other", name: "Other", color: "#999", neon: "#999" }; return <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 11, padding: "10px 0", borderBottom: xi < arr.length - 1 ? "1px solid var(--border)" : "none", animation: "evRowIn 0.35s ease both", animationDelay: `${Math.min(xi, 8) * 0.04}s` }}><div style={{ width: 34, height: 34, borderRadius: 11, background: (cat.color || "#999") + "16", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><DI2 id={cat.id} accent={cat.neon || cat.color} size={17} /></div><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-h)" }}>{cat.name}</div>{e.note && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontFamily: "var(--font-b)" }}>{e.note}</div>}{isGroup && e.paidBy && e.paidBy !== "me" && <div style={{ fontSize: 10, color: ind, marginTop: 1, fontFamily: "var(--font-h)", fontWeight: 600 }}>paid by {e.paidBy}</div>}</div><span style={{ fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 14, color: acc, flexShrink: 0 }}>−{fmt(e.amount)}</span>{sel.status === "active" && <button className="evPress" onClick={() => openEditExp(e)} title="Edit expense" style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", opacity: 0.5, flexShrink: 0, padding: 2, display: "flex" }}><IconPencil size={14} /></button>}{sel.status === "active" && <button className="evPress" onClick={() => sExpDelId(e.id)} title="Delete expense" style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", opacity: 0.5, flexShrink: 0, padding: 2, display: "flex" }}><IconX size={14} /></button>}</div>; })}</div>}
      {eSp.length > 0 && <div style={{ ...ccL, padding: "14px 16px 6px", marginBottom: 14, animation: "evSlideUp 0.4s 0.16s ease both" }}><div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}><span style={secHd}>SPLITS</span><span style={{ fontSize: 10.5, color: "var(--muted)", fontFamily: "var(--font-b)" }}>{eSp.length}</span></div>{(() => { const pend = eSp.filter(x => !x.settled), doneSp = eSp.filter(x => x.settled); const rows = showSettled ? [...pend, ...doneSp] : pend; return <>{rows.map((s, si) => { const settledOrSkip = s.settled || s.skipped; return <div key={s.id} style={{ padding: "12px 2px", borderBottom: (si < rows.length - 1 || doneSp.length > 0) ? "1px solid var(--border)" : "none", opacity: s.settled ? 0.55 : 1, animation: "evRowIn 0.35s ease both", animationDelay: `${Math.min(si, 8) * 0.04}s` }}><div style={{ display: "flex", alignItems: "center", gap: 11 }}><div style={{ width: 34, height: 34, borderRadius: "50%", background: (s.skipped ? "#F4A261" : s.settled || s.direction !== "owe" ? grn : acc) + "16", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: s.skipped ? "#F4A261" : s.settled || s.direction !== "owe" ? grn : acc }}>{s.skipped ? <IconPlayerSkipForward size={15} /> : s.settled ? <CheckCircle size={16} weight="fill" /> : s.direction === "owe" ? <ArrowUpRight size={15} /> : <ArrowDownLeft size={15} />}</div><div style={{ flex: 1, minWidth: 0 }}><div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}><span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", fontFamily: "var(--font-h)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{s.name}</span><span style={{ fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 15, color: s.skipped ? "#F4A261" : s.direction === "owe" ? acc : grn, textDecoration: s.skipped ? "line-through" : "none", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{fmt(s.amount)}</span></div><div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 2, fontFamily: "var(--font-b)", lineHeight: 1.4 }}>{s.skipped ? `Skipped${(paidBySplit[s.id] || 0) > 0.005 ? ` · ${fmt(remainForSplit(s))} written off` : ""}` : s.settled ? "Settled" : s.direction === "owe" ? "You owe" : "Owes you"}{!s.settled && (paidBySplit[s.id] || 0) > 0.005 && <span style={{ color: ind, fontWeight: 600 }}> · {fmt(paidBySplit[s.id])} paid, {fmt(remainForSplit(s))} left</span>}{!s.settled && staleIds.has(s.id) && <span style={{ color: acc, fontWeight: 600 }}> · pending 2+ days</span>}</div>{s.note && <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2, fontStyle: "italic", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontFamily: "var(--font-b)" }}>{s.note}</div>}</div></div><div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 7, marginTop: 9, marginLeft: 45 }}>{!s.settled && !s.groupId && <button className="evPress" onClick={() => openEditSplit(s)} title="Edit IOU" style={{ border: "1px solid var(--border)", background: "var(--bg)", borderRadius: 10, padding: "6px 10px", color: "var(--muted)", cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", gap: 4, fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 600 }}><IconPencil size={13} />Edit</button>}{!s.settled && <button className="evPress" onClick={() => sSTgt(s)} style={{ border: "none", background: s.direction === "owe" ? acc : grn, borderRadius: 10, padding: "6px 14px", fontSize: 11.5, fontWeight: 700, fontFamily: "var(--font-h)", color: "#fff", cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", gap: 4 }}><IconCheck size={13} />Settle</button>}{!s.settled && <button className="evPress" onClick={() => oSK(s.id)} title="Skip — write off without payment" style={{ border: "1px solid #F4A26140", background: "#F4A26112", borderRadius: 10, padding: "6px 10px", color: "#F4A261", cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", gap: 4, fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 600 }}><IconPlayerSkipForward size={13} />Skip</button>}{s.skipped && <button className="evPress" onClick={() => oUnskip(s.id)} title="Restore — undo skip, back to pending" style={{ border: "1px solid #6BAA7540", background: "#6BAA7512", borderRadius: 10, padding: "6px 10px", color: "#6BAA75", cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", gap: 4, fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 600 }}><IconHistory size={13} />Restore</button>}<button className="evPress" onClick={() => oDS(s.id)} title="Delete IOU" style={{ background: "none", border: "1px solid var(--border)", borderRadius: 10, color: "var(--muted)", cursor: "pointer", flexShrink: 0, padding: "6px 8px", display: "flex", alignItems: "center", opacity: settledOrSkip ? 0.6 : 1 }}><IconX size={14} /></button></div></div>; })}{doneSp.length > 0 && <button className="evPress" onClick={() => sShowSettled(v => !v)} style={{ width: "100%", background: "none", border: "none", padding: "10px 0", display: "flex", alignItems: "center", justifyContent: "center", gap: 5, color: "var(--muted)", fontSize: 10.5, fontFamily: "var(--font-h)", fontWeight: 600, cursor: "pointer" }}>{showSettled ? "Hide" : "Show"} {doneSp.length} settled<IconChevronRight size={12} style={{ transform: showSettled ? "rotate(90deg)" : "none", transition: "transform 0.2s" }} /></button>}</>; })()}</div>}
      {addSheet === "expense" && <div style={shO} onClick={() => { sEEditId(null); sAddSheet(null); }}><div onClick={e => e.stopPropagation()} style={shI}>{shHd(eEditId ? "Edit Expense" : "Add Expense", () => { sEEditId(null); sAddSheet(null); })}<div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>{cats.map(c => <button key={c.id} onClick={() => sEC(c.id)} style={{ padding: "7px 12px", borderRadius: 10, fontSize: 12, fontFamily: "var(--font-b)", border: `1.5px solid ${ec === c.id ? c.color : "var(--border)"}`, background: ec === c.id ? c.color + "18" : "var(--bg)", color: ec === c.id ? c.color : "var(--ts)", cursor: "pointer", fontWeight: ec === c.id ? 600 : 400, display: "flex", alignItems: "center", gap: 4 }}><DI2 id={c.id} accent={c.neon || c.color} size={14} />{c.name}</button>)}</div>{isGroup && <div style={{ marginBottom: 12 }}><label style={ls}>Paid by</label><div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{["me", ...(sel.participants || [])].map(p => { const label = p === "me" ? "You" : p; return <button key={p} onClick={() => sEPaidBy(p)} style={{ padding: "8px 14px", borderRadius: 10, fontSize: 12, fontFamily: "var(--font-h)", border: `1.5px solid ${ePaidBy === p ? ind : "var(--border)"}`, background: ePaidBy === p ? ind + "18" : "var(--bg)", color: ePaidBy === p ? ind : "var(--ts)", cursor: "pointer", fontWeight: ePaidBy === p ? 600 : 400 }}>{label}</button>; })}</div></div>}{(!isGroup || ePaidBy === "me") && <><label style={ls}>Paid From</label><div style={{ display: "flex", gap: 6, marginBottom: 12 }}>{wl.map(w => <button key={w.id} onClick={() => sEW(w.id)} style={{ flex: 1, minWidth: 0, padding: "9px 4px", borderRadius: 10, border: `1.5px solid ${ew === w.id ? w.color : "var(--border)"}`, background: ew === w.id ? w.color + "15" : "var(--bg)", fontSize: 12, fontWeight: ew === w.id ? 600 : 500, fontFamily: "var(--font-h)", color: ew === w.id ? w.color : "var(--muted)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}><DI2 id={w.id} accent={w.neon || w.color} size={12} />{w.name}</button>)}</div></>}<div style={{ display: "flex", gap: 8, marginBottom: 14 }}><input type="number" inputMode="decimal" value={ea} onChange={e => sEA(e.target.value)} placeholder="₹" style={{ ...is, width: 90, flexShrink: 0 }} /><input value={en} onChange={e => sEN(e.target.value)} placeholder="Note (optional)" style={{ ...is, flex: 1, minWidth: 0 }} /></div>{isGroup && (sel.participants || []).filter((v, i, arr) => v && v.trim() && arr.findIndex(x => x.toLowerCase() === v.toLowerCase()) === i).length > 0 && (() => { const allP = ["You", ...(sel.participants || []).filter((v, i, arr) => v && v.trim() && arr.findIndex(x => x.toLowerCase() === v.toLowerCase()) === i)]; const included = allP.filter(p => !eSplitExcl.has(p)); const amtNum = (() => { const n = parseAmount(ea); return Number.isFinite(n) && n > 0 ? n : 0; })(); const eq = distributeAmount(amtNum, Math.max(1, included.length)); const customSum = included.reduce((s, p) => { const n = parseAmount(eSplitAmts[p] ?? ""); return s + (Number.isFinite(n) && n > 0 ? n : 0); }, 0); const toggle = p => sESplitExcl(prev => { const n = new Set(prev); n.has(p) ? n.delete(p) : n.add(p); return n; }); const off = roundMoney(amtNum - customSum); return <div style={{ marginBottom: 14 }}><label style={ls}>Split between</label><div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>{allP.map(p => { const on = !eSplitExcl.has(p); return <button key={p} onClick={() => toggle(p)} style={{ padding: "6px 11px", borderRadius: 10, fontSize: 12, fontFamily: "var(--font-h)", border: `1.5px solid ${on ? grn : "var(--border)"}`, background: on ? grn + "18" : "var(--bg)", color: on ? grn : "var(--muted)", cursor: "pointer", fontWeight: on ? 600 : 400, textDecoration: on ? "none" : "line-through" }}>{p}</button>; })}</div><div style={{ display: "flex", gap: 6, marginBottom: 8 }}>{[["equal", "Equal"], ["custom", "Custom"]].map(([m, lbl]) => <button key={m} onClick={() => sESplitMode(m)} style={{ flex: 1, padding: "7px", borderRadius: 9, fontSize: 11.5, fontFamily: "var(--font-h)", border: `1.5px solid ${eSplitMode === m ? ind : "var(--border)"}`, background: eSplitMode === m ? ind + "18" : "var(--bg)", color: eSplitMode === m ? ind : "var(--muted)", cursor: "pointer", fontWeight: 600 }}>{lbl}</button>)}</div>{eSplitMode === "equal" ? <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-b)" }}>{included.length > 0 ? `${fmt(eq[0] || 0)} each · ${included.length} ${included.length === 1 ? "person" : "people"}` : "Pick at least one person"}</div> : <div>{included.map(p => <div key={p} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}><span style={{ flex: 1, fontSize: 12, fontFamily: "var(--font-h)", color: "var(--text)" }}>{p}</span><input type="number" inputMode="decimal" value={eSplitAmts[p] ?? ""} onChange={e => sESplitAmts(prev => ({ ...prev, [p]: e.target.value }))} placeholder="₹" style={{ ...is, width: 90, marginBottom: 0 }} /></div>)}<div style={{ fontSize: 10.5, fontFamily: "var(--font-h)", fontWeight: 600, color: Math.abs(off) > 0.05 ? acc : grn, marginTop: 2 }}>{fmt(customSum)} / {fmt(amtNum)}{Math.abs(off) > 0.05 ? ` · ${off > 0 ? "short" : "over"} ${fmt(Math.abs(off))}` : " ✓"}</div></div>}</div>; })()}<button className="evPress" onClick={() => { if ((eEditId ? saveExpEdit() : addExp()) === true) sAddSheet(null); }} style={{ width: "100%", padding: 14, border: "none", borderRadius: 12, background: acc, color: "#fff", fontFamily: "var(--font-h)", fontSize: 14, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>{eEditId ? <><IconCheck size={15} />Save Changes</> : <><IconPlus size={15} />Add Expense</>}</button></div></div>}
      {addSheet === "split" && <div style={shO} onClick={() => { sEIouEditId(null); sAddSheet(null); }}><div onClick={e => e.stopPropagation()} style={shI}>{shHd(eIouEditId ? "Edit Split" : "Add Split", () => { sEIouEditId(null); sAddSheet(null); })}<div style={{ display: "flex", gap: 6, marginBottom: 12 }}>{["owed", "owe"].map(d => <button key={d} onClick={() => sSD(d)} style={{ flex: 1, minWidth: 0, padding: "10px 6px", borderRadius: 10, fontSize: 12, fontFamily: "var(--font-h)", border: `1.5px solid ${sd === d ? (d === "owe" ? acc : grn) : "var(--border)"}`, background: sd === d ? (d === "owe" ? acc + "18" : grn + "18") : "var(--bg)", color: sd === d ? (d === "owe" ? acc : grn) : "var(--muted)", cursor: "pointer", fontWeight: sd === d ? 600 : 500, display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}>{d === "owe" ? <ArrowUpRight size={13} /> : <ArrowDownLeft size={13} />}{d === "owe" ? "I owe them" : "They owe me"}</button>)}</div><input value={sn} onChange={e => sSN(e.target.value)} placeholder="Friend name" style={{ ...is, marginBottom: 10 }} /><div style={{ display: "flex", gap: 8, marginBottom: 14 }}><input type="number" inputMode="decimal" value={sa} onChange={e => sSA(e.target.value)} placeholder="₹" style={{ ...is, width: 90, flexShrink: 0 }} /><input value={spNote} onChange={e => sSPNote(e.target.value)} placeholder="Note (optional)" style={{ ...is, flex: 1, minWidth: 0 }} /></div><button className="evPress" onClick={() => { if (addSplit() === true) sAddSheet(null); }} style={{ width: "100%", padding: 14, border: "none", borderRadius: 12, background: grn, color: "#fff", fontFamily: "var(--font-h)", fontSize: 14, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>{eIouEditId ? <><IconCheck size={15} />Save</> : <><IconPlus size={15} />Add Split</>}</button></div></div>}
      {/* Bill Splitter is solo-event only: in group events the per-expense
          "Paid by" flow already creates the IOUs, and the BALANCES card
          reconciles only against those + settlements — splitter-made IOUs
          would double-track the same money. */}
      {addSheet === "bill" && !isGroup && <div style={shO} onClick={() => { sBsS(1); sBsT(""); sBsP([{ name: "", amount: "" }]); sBsN(""); sAddSheet(null); }}><div onClick={e => e.stopPropagation()} style={shI}>{(() => {
        const totalNum = (() => { const n = parseAmount(bsTotal); return Number.isFinite(n) && n > 0 ? n : 0; })(), validPpl = bsPpl.filter(p => p.name.trim()), hc = validPpl.length + 1;
        const equalShares = distributeAmount(totalNum, hc), eqMy = equalShares[0] || 0, eqOthers = validPpl.map((_, i) => equalShares[i + 1] || 0);
        const custOT = bsPpl.reduce((s, p) => s + ((Number.isFinite(parseAmount(p.amount)) ? parseAmount(p.amount) : 0)), 0), custMy = Math.max(0, totalNum - custOT);
        const myShare = bsMode === "equal" ? eqMy : custMy;
        const canSub = totalNum > 0 && validPpl.length > 0 && (bsMode === "equal" || (custOT > 0 && custOT <= totalNum));
        const bsReset = () => { sBsT(""); sBsP([{ name: "", amount: "" }]); sBsN(""); sBsS(1); };
        const bsClose = () => { bsReset(); sAddSheet(null); };
        const bsSubmit = () => { if (!canSub || !sel) return; const gid = uid(); if (totalNum > 0) { const ok = oE({ amount: totalNum, categoryId: bsCat, walletId: bsW, note: bsNote || `Bill split — paid by you (your share ${fmt(myShare)})`, date: localDateKey(), eventId: sel.id, groupId: gid }); if (ok === false) return } validPpl.forEach((p, idx) => { const amt = bsMode === "equal" ? eqOthers[idx] : roundMoney((Number.isFinite(parseAmount(p.amount)) ? parseAmount(p.amount) : 0)); if (amt > 0) oS({ id: uid(), name: p.name.trim(), amount: amt, direction: "owed", settled: false, eventId: sel.id, groupId: gid }) }); sBsS(3); setTimeout(() => { bsReset(); sAddSheet(c => c === "bill" ? null : c); }, 1600) };
        if (bsStep === 3) return <div style={{ textAlign: "center", padding: "22px 0 10px" }}><div style={{ display: "flex", justifyContent: "center", marginBottom: 8, color: grn }}><CheckCircle size={36} weight="fill" /></div><div style={{ fontFamily: "var(--font-h)", fontSize: 14, color: grn, fontWeight: 700 }}>Split recorded</div><div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4, fontFamily: "var(--font-b)" }}>Full bill paid. Your final share is {fmt(myShare)}.</div></div>;
        if (bsStep === 2) { const cat = cats.find(c => c.id === bsCat) || cats[0]; return <>{shHd("Confirm Split", bsClose)}<div style={{ background: acc + "10", borderRadius: 12, padding: "12px 14px", marginBottom: 10 }}><div style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 600, letterSpacing: "0.8px", marginBottom: 6 }}>PAID NOW</div><div style={{ display: "flex", alignItems: "center", gap: 10 }}><DI2 id={cat?.id} accent={cat?.neon || cat?.color} size={20} /><div style={{ flex: 1, minWidth: 0, fontSize: 13, fontFamily: "var(--font-h)", fontWeight: 600, color: "var(--text)" }}>Full bill from {wl.find(w => w.id === bsW)?.name || "wallet"}</div><div style={{ fontSize: 17, fontWeight: 700, fontFamily: "var(--font-h)", color: acc }}>−{fmt(totalNum)}</div></div></div><div style={{ background: grn + "10", borderRadius: 12, padding: "10px 14px", marginBottom: 14, display: "flex", justifyContent: "space-between", fontSize: 12.5, fontFamily: "var(--font-h)", color: "var(--ts)" }}><span>Your final share</span><span style={{ fontWeight: 700, color: acc }}>{fmt(myShare)}</span></div><div style={{ marginBottom: 16 }}><div style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 600, letterSpacing: "0.8px", marginBottom: 6 }}>THEY OWE YOU</div>{validPpl.map((p, i) => { const amt = bsMode === "equal" ? eqOthers[i] : roundMoney((Number.isFinite(parseAmount(p.amount)) ? parseAmount(p.amount) : 0)); return <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border)" }}><span style={{ fontSize: 13, fontFamily: "var(--font-h)", color: "var(--text)" }}>{p.name}</span><span style={{ fontSize: 13, fontFamily: "var(--font-h)", fontWeight: 600, color: grn }}>{fmt(amt)}</span></div> })}</div><div style={{ display: "flex", gap: 8 }}><button className="evPress" onClick={() => sBsS(1)} style={{ flex: 1, padding: 13, border: "1.5px solid var(--border)", borderRadius: 12, background: "transparent", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 13, cursor: "pointer" }}>Back</button><button className="evPress" onClick={bsSubmit} style={{ flex: 2, padding: 13, border: "none", borderRadius: 12, background: grn, color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}><IconCheck size={14} />Confirm</button></div></>; }
        return <>{shHd("Bill Splitter", bsClose)}<div style={{ display: "flex", gap: 6, marginBottom: 14 }}>{[{ id: "equal", label: "Equal Split" }, { id: "custom", label: "Custom Split" }].map(m => <button key={m.id} onClick={() => sBsM(m.id)} style={{ flex: 1, minWidth: 0, padding: "10px 6px", borderRadius: 10, fontSize: 12, fontFamily: "var(--font-h)", border: `1.5px solid ${bsMode === m.id ? ind : "var(--border)"}`, background: bsMode === m.id ? ind + "18" : "var(--bg)", color: bsMode === m.id ? ind : "var(--muted)", cursor: "pointer", fontWeight: 600 }}>{m.label}</button>)}</div><label style={ls}>Total Bill (₹)</label><input type="number" inputMode="decimal" value={bsTotal} onChange={e => sBsT(e.target.value)} placeholder="0" style={{ ...is, marginBottom: 12, fontSize: 22, fontWeight: 700, fontFamily: "var(--font-h)", textAlign: "center" }} /><label style={ls}>Note (optional)</label><input value={bsNote} onChange={e => sBsN(e.target.value)} placeholder="What was this bill for?" style={{ ...is, marginBottom: 12 }} /><label style={ls}>People (excluding you)</label>{bsPpl.map((p, i) => <div key={i} style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center" }}><input value={p.name} onChange={e => sBsP(pp => pp.map((x, idx) => idx === i ? { ...x, name: e.target.value } : x))} placeholder="Name" style={{ ...is, flex: 1, minWidth: 0 }} />{bsMode === "custom" && <input type="number" inputMode="decimal" value={p.amount} onChange={e => sBsP(pp => pp.map((x, idx) => idx === i ? { ...x, amount: e.target.value } : x))} placeholder="₹" style={{ ...is, width: 78, flexShrink: 0 }} />}{bsMode === "custom" && p.name.trim() && !(Number.isFinite(parseAmount(p.amount)) && parseAmount(p.amount) > 0) && <span style={{ fontSize: 10, color: acc, flexShrink: 0, fontFamily: "var(--font-h)", fontWeight: 600 }}>₹0!</span>}{bsPpl.length > 1 && <button onClick={() => sBsP(pp => pp.filter((_, idx) => idx !== i))} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", opacity: 0.5, display: "flex", padding: 2 }}><IconX size={14} /></button>}</div>)}<button className="evPress" onClick={() => sBsP(p => [...p, { name: "", amount: "" }])} style={{ background: "none", border: "1.5px dashed var(--border)", borderRadius: 10, padding: "9px 14px", fontSize: 12, color: "var(--muted)", cursor: "pointer", fontFamily: "var(--font-h)", marginBottom: 12, width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}><IconPlus size={13} />Add person</button>{totalNum > 0 && validPpl.length > 0 && <div style={{ background: "var(--bg)", borderRadius: 10, padding: "10px 14px", marginBottom: 12, border: "1px solid var(--border)" }}>{bsMode === "equal" ? <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontFamily: "var(--font-h)", color: "var(--ts)" }}><span>Per person ({hc})</span><span style={{ fontWeight: 600 }}>{fmt(equalShares[0] || 0)}</span></div> : <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontFamily: "var(--font-h)", color: custOT > totalNum ? acc : "var(--ts)" }}><span>Others total</span><span style={{ fontWeight: 600 }}>{fmt(custOT)} / {fmt(totalNum)}{custOT > totalNum ? " (over!)" : ""}</span></div>}<div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontFamily: "var(--font-h)", color: acc, fontWeight: 700, marginTop: 6 }}><span>Your share</span><span>{fmt(myShare)}</span></div></div>}<label style={ls}>Category</label><div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>{cats.map(c => <button key={c.id} onClick={() => sBsC(c.id)} style={{ padding: "7px 12px", borderRadius: 10, fontSize: 12, fontFamily: "var(--font-b)", border: `1.5px solid ${bsCat === c.id ? c.color : "var(--border)"}`, background: bsCat === c.id ? c.color + "18" : "var(--bg)", color: bsCat === c.id ? c.color : "var(--ts)", cursor: "pointer", fontWeight: bsCat === c.id ? 600 : 400, display: "flex", alignItems: "center", gap: 4 }}><DI2 id={c.id} accent={c.neon || c.color} size={14} />{c.name}</button>)}</div><label style={ls}>Paid From</label><div style={{ display: "flex", gap: 6, marginBottom: 14 }}>{wl.map(w => <button key={w.id} onClick={() => sBsW(w.id)} style={{ flex: 1, minWidth: 0, padding: "9px 4px", borderRadius: 10, border: `1.5px solid ${bsW === w.id ? w.color : "var(--border)"}`, background: bsW === w.id ? w.color + "15" : "var(--bg)", fontSize: 12, fontWeight: bsW === w.id ? 600 : 500, fontFamily: "var(--font-h)", color: bsW === w.id ? w.color : "var(--muted)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}><DI2 id={w.id} accent={w.neon || w.color} size={12} />{w.name}</button>)}</div><button className="evPress" onClick={() => { if (canSub) sBsS(2) }} disabled={!canSub} style={{ width: "100%", padding: 14, border: "none", borderRadius: 12, background: canSub ? grn : "var(--border)", color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 700, cursor: canSub ? "pointer" : "default", opacity: canSub ? 1 : 0.6, display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}>Review Split<ArrowRight size={13} /></button></>;
      })()}</div></div>}
      {doneConfirm && <div style={shO} onClick={() => sDoneConfirm(false)}><div onClick={e => e.stopPropagation()} style={shI}><div style={{ fontFamily: "var(--font-h)", fontSize: 16, fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>Mark event done?</div><div style={{ fontSize: 13, color: "var(--muted)", fontFamily: "var(--font-b)", marginBottom: 20, lineHeight: 1.6 }}>{pendingCnt} unsettled IOU{pendingCnt === 1 ? "" : "s"} remain in this event. They stay visible and can still be settled later — and you can reopen the event any time.</div><div style={{ display: "flex", gap: 10 }}><button className="evPress" onClick={() => sDoneConfirm(false)} style={{ flex: 1, padding: 13, border: "1.5px solid var(--border)", borderRadius: 12, background: "transparent", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Cancel</button><button className="evPress" onClick={() => { oMD(sel.id); sDoneConfirm(false); }} style={{ flex: 1, padding: 13, border: "none", borderRadius: 12, background: grn, color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Mark Done</button></div></div></div>}
      {suTgt && <div style={shO} onClick={() => sSuTgt(null)}><div onClick={e => e.stopPropagation()} style={shI}><div style={{ fontFamily: "var(--font-h)", fontSize: 16, fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>Settle up with {suTgt.from === "You" ? suTgt.to : suTgt.from}</div><div style={{ fontSize: 13, color: "var(--muted)", fontFamily: "var(--font-b)", marginBottom: 16, lineHeight: 1.6 }}>{suTgt.from === "You" ? <>You pay <strong style={{ color: "var(--text)" }}>{suTgt.to}</strong></> : <><strong style={{ color: "var(--text)" }}>{suTgt.from}</strong> pays you</>} <strong style={{ color: "var(--text)", fontFamily: "var(--font-h)" }}>{fmt(suTgt.amt)}</strong> — pay the full amount to clear it in one move, or enter less to settle part of it now.</div><label style={ls}>Amount</label><input type="number" inputMode="decimal" value={suAmt} onChange={e => sSuAmt(e.target.value)} placeholder="₹" style={{ ...is, marginBottom: 6 }} /><div style={{ fontSize: 10.5, color: "var(--muted)", fontFamily: "var(--font-b)", marginBottom: 16 }}>Full balance {fmt(suTgt.amt)}{(() => { const n = parseAmount(suAmt); return Number.isFinite(n) && n > 0 && n < suTgt.amt - 0.005 ? ` · ${fmt(roundMoney(suTgt.amt - n))} will stay pending` : ""; })()}</div><label style={ls}>{suTgt.from === "You" ? "Pay from" : "Receive into"}</label><div style={{ display: "flex", gap: 6, marginBottom: 18 }}>{wl.map(w => <button key={w.id} className="evPress" onClick={() => sSuW(w.id)} style={{ flex: 1, minWidth: 0, padding: "10px 4px", borderRadius: 10, border: `1.5px solid ${suW === w.id ? w.color : "var(--border)"}`, background: suW === w.id ? w.color + "15" : "var(--bg)", fontSize: 12, fontWeight: suW === w.id ? 600 : 500, fontFamily: "var(--font-h)", color: suW === w.id ? w.color : "var(--muted)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}><DI2 id={w.id} accent={w.neon || w.color} size={12} />{w.name}</button>)}</div><div style={{ display: "flex", gap: 10 }}><button className="evPress" onClick={() => sSuTgt(null)} style={{ flex: 1, padding: 13, border: "1.5px solid var(--border)", borderRadius: 12, background: "transparent", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Cancel</button><button className="evPress" onClick={() => { const ok = oSEN(sel.id, suTgt.from === "You" ? suTgt.to : suTgt.from, suW, suAmt); if (ok !== false) sSuTgt(null); }} style={{ flex: 2, padding: 13, border: "none", borderRadius: 12, background: grn, color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}><IconCheck size={14} />Settle {(() => { const n = parseAmount(suAmt); return fmt(Number.isFinite(n) && n > 0 ? roundMoney(Math.min(n, suTgt.amt)) : suTgt.amt); })()}</button></div></div></div>}
      {editOpen && <div style={shO} onClick={() => sEditOpen(false)}><div onClick={e => e.stopPropagation()} style={shI}>{shHd("Edit Event", () => sEditOpen(false))}<label style={ls}>Name</label><input value={enName} onChange={e => sEnName(e.target.value)} style={{ ...is, marginBottom: 12 }} /><label style={ls}>Icon</label><div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>{EI.map(id => <button key={id} className="evPress" onClick={() => sEnIcon(id)} style={{ width: 38, height: 38, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", border: `1.5px solid ${enIcon === id ? acc : "var(--border)"}`, background: enIcon === id ? acc + "15" : "var(--bg)", cursor: "pointer", color: enIcon === id ? acc : "var(--muted)" }}><EvIcon id={id} size={18} /></button>)}</div><label style={ls}>Date</label><input type="date" value={enDate} onChange={e => sEnDate(e.target.value)} style={{ ...is, marginBottom: 12 }} />{isGroup && <><label style={ls}>Participants</label><div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>{enParts.map(p => { const locked = partActive(p); return <span key={p} title={locked ? "Has expenses or IOUs in this event — can't be removed" : undefined} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "7px 11px", borderRadius: 10, fontSize: 12, border: "1.5px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-b)" }}>{p}{locked ? <span style={{ fontSize: 9, color: "var(--muted)", letterSpacing: "0.5px" }}>in use</span> : <button onClick={() => sEnParts(pp => pp.filter(x => x !== p))} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", padding: 0, display: "flex" }}><IconX size={12} /></button>}</span>; })}</div><div style={{ display: "flex", gap: 6, marginBottom: 6 }}><input value={enNew} onChange={e => sEnNew(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addEnPart(); }} placeholder="Add person" style={{ ...is, flex: 1, minWidth: 0 }} /><button className="evPress" onClick={addEnPart} style={{ padding: "10px 15px", border: "none", borderRadius: 10, background: acc, color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", flexShrink: 0 }}><IconPlus size={15} /></button></div><div style={{ fontSize: 10.5, color: "var(--muted)", marginBottom: 14, lineHeight: 1.5, fontFamily: "var(--font-b)" }}>People with recorded expenses or IOUs can't be removed. Adding or removing people changes how totals are shared.</div></>}<button className="evPress" onClick={() => { const nid = uid(); oC({ id: nid, name: sel.name, emoji: sel.emoji, date: localDateKey(), status: "active", type: sel.type, participants: [...(sel.participants || [])] }); sEditOpen(false); goDetail(nid); showT("Event duplicated — fresh copy, no expenses", "success"); }} style={{ width: "100%", padding: 11, marginBottom: 12, border: "1.5px dashed var(--border)", borderRadius: 10, background: "transparent", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}><IconPlus size={13} />Duplicate as new event</button><div style={{ display: "flex", gap: 10 }}><button className="evPress" onClick={() => sEditOpen(false)} style={{ flex: 1, padding: 13, border: "1.5px solid var(--border)", borderRadius: 12, background: "transparent", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Cancel</button><button className="evPress" onClick={saveEdit} style={{ flex: 2, padding: 13, border: "none", borderRadius: 12, background: acc, color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Save Changes</button></div></div></div>}
      {stgt && <SettleM split={stgt} remaining={remainForSplit(stgt)} wallets={wl} onConfirm={(wid, amount) => { oSS(stgt.id, wid, amount); sSTgt(null) }} onClose={() => sSTgt(null)} />}{expDelId && (() => { const exp = ex.find(e => e.id === expDelId); if (!exp) return null; const cat = cats.find(c => c.id === exp.categoryId); const linked = exp.groupId ? sp.filter(s => s.groupId === exp.groupId && !s.deleted_at).length : 0; return <div style={shO} onClick={() => sExpDelId(null)}><div onClick={e => e.stopPropagation()} style={shI}><div style={{ fontFamily: "var(--font-h)", fontSize: 16, fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>Delete this expense?</div><div style={{ fontSize: 13, color: "var(--muted)", fontFamily: "var(--font-b)", marginBottom: 20, lineHeight: 1.6 }}>{cat?.name || "Expense"}{exp.note ? ` · ${exp.note}` : ""} — {fmt(exp.amount)}.{linked > 0 ? ` Also removes ${linked} linked split${linked === 1 ? "" : "s"} from this group expense.` : ""} You can undo right after.</div><div style={{ display: "flex", gap: 10 }}><button className="evPress" onClick={() => sExpDelId(null)} style={{ flex: 1, padding: 13, border: "1.5px solid var(--border)", borderRadius: 12, background: "transparent", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Cancel</button><button className="evPress" onClick={() => { oDE(expDelId); sExpDelId(null); }} style={{ flex: 1, padding: 13, border: "none", borderRadius: 12, background: "#c0524a", color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Delete</button></div></div></div>; })()}{confirmOverlay}</div>
  }

  if (view === "lite") return <NomadLite onBack={() => sV("list")} onToast={showT} />;
  const active = [...evs.filter(e => e.status === "active")].sort((a, b) => (b.date || "").localeCompare(a.date || "")), done = [...evs.filter(e => e.status === "completed")].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const totalNs = evs.reduce((s, ev) => s + netSpent(ev.id), 0), unsettledCnt = evs.filter(ev => sp.some(s => s.eventId === ev.id && !s.settled)).length;
  const tabEvs = evTab === "active" ? active : evTab === "past" ? done : [...active, ...done];
  const MONTH_N = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const grouped = Object.entries(tabEvs.reduce((acc, ev) => { const d = ev.date ? new Date(ev.date + "T12:00:00") : null; const k = d ? `${MONTH_N[d.getMonth()]} ${d.getFullYear()}` : "Unknown"; if (!acc[k]) acc[k] = []; acc[k].push(ev); return acc; }, {}));
  return <div style={{ position: "relative", background: pC, height: "calc(100vh - 90px)", display: "flex", flexDirection: "column", overflow: "hidden" }}><TopoBg /><div style={{ position: "relative", zIndex: 10, padding: "max(20px, calc(env(safe-area-inset-top, 0px) + 14px)) 24px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}><div><div style={{ fontFamily: "'Playfair Display', Georgia, serif", fontSize: 26, color: inkC, letterSpacing: "-0.3px", fontWeight: 400 }}>Events</div><div style={{ fontSize: 11, color: mutC, letterSpacing: "1.2px", textTransform: "uppercase", marginTop: 2 }}>Track shared spending</div></div><button onClick={() => sV("lite")} className="evPress" aria-label="Open NOMAD Lite" title="NOMAD Lite" style={{ width: 38, height: 38, borderRadius: 12, background: stoneC, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid rgba(184,150,62,0.2)", cursor: "pointer", padding: 0 }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" stroke={mutC} strokeWidth="1.5"/><path d="M12 8V12L14 14" stroke={mutC} strokeWidth="1.5" strokeLinecap="round"/><path d="M2 12H4M20 12H22M12 2V4M12 20V22" stroke={mutC} strokeWidth="1.5" strokeLinecap="round"/></svg></button></div><div style={{ position: "relative", zIndex: 10, margin: "0 20px 20px", background: stripC, borderRadius: 14, padding: "14px 18px", display: "flex", justifyContent: "space-between", alignItems: "center" }}><div style={{ textAlign: "center" }}><div style={{ fontSize: 15, fontWeight: 500, color: "#C9A84C", fontFamily: "'Playfair Display', Georgia, serif" }}>{evs.length}</div><div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", letterSpacing: "0.8px", textTransform: "uppercase", marginTop: 2 }}>Events</div></div><div style={{ width: 1, height: 28, background: "rgba(255,255,255,0.1)" }} /><div style={{ textAlign: "center" }}><div style={{ fontSize: 15, fontWeight: 500, color: "#C9A84C", fontFamily: "'Playfair Display', Georgia, serif" }}>{fmt(totalNs)}</div><div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", letterSpacing: "0.8px", textTransform: "uppercase", marginTop: 2 }}>Total</div></div><div style={{ width: 1, height: 28, background: "rgba(255,255,255,0.1)" }} /><div style={{ textAlign: "center" }}><div style={{ fontSize: 15, fontWeight: 500, color: "#C9A84C", fontFamily: "'Playfair Display', Georgia, serif" }}>{unsettledCnt}</div><div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", letterSpacing: "0.8px", textTransform: "uppercase", marginTop: 2 }}>Unsettled</div></div></div><div style={{ position: "relative", zIndex: 10, display: "flex", margin: "0 20px 20px", background: stoneC, borderRadius: 10, padding: 3 }}>{[["active","Active"],["past","Past"],["all","All"]].map(([t,l]) => <div key={t} onClick={() => sEvTab(t)} style={{ flex: 1, textAlign: "center", padding: 8, fontSize: 12, fontWeight: 500, color: evTab === t ? inkC : mutC, borderRadius: 8, cursor: "pointer", background: evTab === t ? pC : "transparent", boxShadow: evTab === t ? "0 1px 4px rgba(0,0,0,0.1)" : "none", letterSpacing: "0.5px", transition: "all 0.2s" }}>{l}</div>)}</div><div style={{ position: "relative", zIndex: 10, flex: 1, overflowY: "auto" }}>{tabEvs.length === 0 ? <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 40px 20px", gap: 12, opacity: 0, animation: "evFadeIn 0.6s 0.3s ease both" }}><svg style={{ opacity: 0.15, marginBottom: 8 }} width="80" height="80" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="40" cy="40" r="36" stroke="#2C2416" strokeWidth="1.5"/><circle cx="40" cy="40" r="28" stroke="#2C2416" strokeWidth="1"/><circle cx="40" cy="40" r="3" fill="#2C2416"/><path d="M40 20L44 38L40 36L36 38Z" fill="#C4603A"/><path d="M40 60L36 42L40 44L44 42Z" fill="#2C2416" opacity="0.4"/><path d="M20 40L38 36L36 40L38 44Z" fill="#2C2416" opacity="0.4"/><path d="M60 40L42 44L44 40L42 36Z" fill="#2C2416" opacity="0.4"/><text x="40" y="14" textAnchor="middle" fontFamily="sans-serif" fontSize="7" fill="#2C2416" opacity="0.6">N</text><text x="40" y="70" textAnchor="middle" fontFamily="sans-serif" fontSize="7" fill="#2C2416" opacity="0.6">S</text><text x="14" y="43" textAnchor="middle" fontFamily="sans-serif" fontSize="7" fill="#2C2416" opacity="0.6">W</text><text x="67" y="43" textAnchor="middle" fontFamily="sans-serif" fontSize="7" fill="#2C2416" opacity="0.6">E</text></svg><div style={{ fontFamily: "'Playfair Display', Georgia, serif", fontSize: 16, color: inkC, opacity: 0.6, textAlign: "center" }}>No {evTab === "all" ? "" : evTab + " "}events</div><div style={{ fontSize: 12, color: mutC, textAlign: "center", lineHeight: 1.6 }}>Add an event to start tracking shared costs with friends or family</div></div> : grouped.map(([month, mEvs]) => <div key={month}><div style={{ padding: "0 24px 12px", fontSize: 10, letterSpacing: "1.8px", textTransform: "uppercase", color: mutC, display: "flex", alignItems: "center", gap: 10 }}>{month}<div style={{ flex: 1, height: 1, background: "linear-gradient(to right, rgba(156,143,122,0.3), transparent)" }} /></div>{mEvs.map((ev, ei) => { const ns = netSpent(ev.id), isDone = ev.status === "completed", ps = sp.filter(s => s.eventId === ev.id && !s.settled).length, stalePs = (staleByEvent[ev.id] || []).length; return <div key={ev.id} onClick={() => goDetail(ev.id)} style={{ margin: "0 20px 12px", background: cardC, borderRadius: 16, padding: "16px 18px", display: "flex", alignItems: "center", gap: 14, boxShadow: "0 2px 12px rgba(44,36,22,0.07), 0 1px 3px rgba(44,36,22,0.05)", border: stalePs > 0 ? "1.5px solid #D4726A" : "1px solid rgba(224,217,206,0.8)", cursor: "pointer", animation: "evSlideUp 0.4s ease both", animationDelay: `${ei * 0.06}s` }}><div style={{ width: 42, height: 42, borderRadius: 12, background: "linear-gradient(135deg, #F5EFE4, #EDE5D4)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "1px solid rgba(184,150,62,0.15)" }}><EvIcon id={ev.emoji} size={20} /></div><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 15, fontWeight: 500, color: inkC, letterSpacing: "-0.1px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ev.name}</div><div style={{ fontSize: 12, color: mutC, marginTop: 2 }}>{fmtDate(ev.date)}{!isDone && ps > 0 ? ` · ${ps} pending` : ""}{stalePs > 0 && <span style={{ color: "#D4726A", fontWeight: 600 }}> · {stalePs} stale 2+ days</span>}</div></div><div style={{ textAlign: "right", flexShrink: 0 }}><div style={{ fontFamily: "'Playfair Display', Georgia, serif", fontSize: 17, color: inkC, fontWeight: 500 }}>{fmt(ns)}</div><div style={{ display: "inline-flex", alignItems: "center", gap: 4, marginTop: 4, background: isDone ? "rgba(90,122,90,0.1)" : "rgba(184,150,62,0.1)", color: isDone ? "#5A7A5A" : "#B8963E", fontSize: 10, fontWeight: 500, letterSpacing: "0.5px", padding: "3px 8px", borderRadius: 20, border: `1px solid ${isDone ? "rgba(90,122,90,0.2)" : "rgba(184,150,62,0.2)"}` }}>{isDone ? "✓ done" : "active"}</div></div><button onClick={e => { e.stopPropagation(); sEvDelConfirm(ev.id); }} style={{ background: "none", border: "none", color: mutC, cursor: "pointer", padding: "2px 4px", opacity: 0.4, flexShrink: 0, display: "flex" }}><IconX size={14} /></button></div>; })}</div>)}</div><button onClick={() => { sND(localDateKey()); sV("create"); }} style={{ position: "relative", zIndex: 10, margin: "16px 20px 20px", background: terraC, borderRadius: 14, padding: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, color: "white", fontSize: 14, fontWeight: 500, cursor: "pointer", border: "none", boxShadow: "0 4px 16px rgba(196,96,58,0.3)", letterSpacing: "0.3px", width: "calc(100% - 40px)" }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 5V19M5 12H19" stroke="white" strokeWidth="2" strokeLinecap="round"/></svg>New Event</button>{confirmOverlay}</div>;
}

function NI({ type: t, active: a }) {
  const c = a ? "#E07A5F" : "var(--muted)";
  if (t === "dashboard") return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="11" width="7" height="10" rx="1.5" /><rect x="3" y="13" width="7" height="8" rx="1.5" /></svg>;
  if (t === "add") return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>;
  if (t === "events") return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /><circle cx="12" cy="16" r="2" /></svg>;
  if (t === "history") return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><path d="M12 8v4l3 3" /><circle cx="12" cy="12" r="9" /></svg>;
  if (t === "settings") return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>;
  if (t === "calendar") return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="3" y1="10" x2="21" y2="10" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="16" y1="2" x2="16" y2="6" /></svg>;
  return null
}

// Clean card style
const cc = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: 20, boxShadow: "0 2px 16px rgba(0,0,0,0.04)" };

export default function Nomad() {
  const [module, setModule] = useState("finance");
  const [showSetup, setShowSetup] = useState(false);
  const [backendOpen, sBackendOpen] = useState(false);
  const [haptics, sHaptics] = useState(hapticsEnabled());
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
  const [tab, sTab] = useState("dashboard"), [ex, sEx] = useState([]), [inc, sInc] = useState([]), [tr, sTr] = useState([]), [stl, sStl] = useState([]), [cats, sCats] = useState(DC), [isrc, sIsrc] = useState(DI), [sp, sSp] = useState([]), [evs, sEvs] = useState([]), [rec, sRec] = useState([]), [fm, sFm] = useState(localDateKey().slice(0, 7)), [loaded, sL] = useState(false), [ld, sLd] = useState(false), [dm, sDm] = useState(false), [toasts, sToasts] = useState([]), [nn, sNN] = useState(""), [ne2, sNE2] = useState("📁"), [nc, sNC] = useState("#E07A5F"), [mt, sMt] = useState("expense"), [clr, sClr] = useState(false), [nukeTxt, sNukeTxt] = useState(""), [addSeg, sAddSeg] = useState("log"), [calW, sCalW] = useState(null), [recountW, sRecountW] = useState(null), [ledgerW, sLedgerW] = useState(null), [wsb, sWsb] = useState({});
  const [pendingSync, sPendingSync] = useState(getPendingSyncCount());
  const [deadLetterCount, sDeadLetterCount] = useState(getDeadLetterCount());
  const [calLog, sCalLog] = useState(() => { try { return JSON.parse(localStorage.getItem("nomad-cal-log") || "[]"); } catch { return []; } });
  // First-seen timestamp per active split id. `createdAt` is NOT persisted to
  // Supabase (not in COLS.splits, no DB column), so it's lost on every reload —
  // which made the "IOU pending 2+ days" banner fire for every synced split.
  // This local map records when each unsettled split was first observed, giving
  // a reliable age fallback without a DB migration.
  const [splitSeen, sSplitSeen] = useState(() => { try { return JSON.parse(localStorage.getItem("nomad-split-seen-v1") || "{}"); } catch { return {}; } });
  const [dlBanner, sDlBanner] = useState(() => getDeadLetterCount() > 0);
  const [localBanner, sLocalBanner] = useState(localMode);
  const [online, sOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  const [staleData, sStaleData] = useState(false);
  const [swUpdate, sSwUpdate] = useState(false);
  const [manageXp, sManageXp] = useState(false);
  const [recAllOpen, sRecAllOpen] = useState(false); // partial-collapse for the Settings → Recurring bill list
  const [recDelConfirm, sRecDelConfirm] = useState(null);
  const [recEditId, sRecEditId] = useState(null);
  const [recDelItems, sRecDelItems] = useState(null);
  const [recDelLoading, sRecDelLoading] = useState(false);
  const [csvPreview, sCsvPreview] = useState(null);
  const [ledgerPreview, sLedgerPreview] = useState(null);
  const [ledgerLoading, sLedgerLoading] = useState(false);
  const [budgets, sBudgets] = useState({});
  const [budgetSettingsOpen, sBudgetSettingsOpen] = useState(false);
  const [scoreOpen, sScoreOpen] = useState(false);
  const [hSearch, sHSearch] = useState(""), [hMinAmt, sHMinAmt] = useState(""), [hMaxAmt, sHMaxAmt] = useState(""), [hDateFrom, sHDateFrom] = useState(""), [hDateTo, sHDateTo] = useState(""), [hType, sHType] = useState("all"), [hWallet, sHWallet] = useState(""), [hShowFilters, sHShowFilters] = useState(false), [hTimeline, sHTimeline] = useState(false), [hCalDay, sHCalDay] = useState(null);
  const [drillCat, sDrillCat] = useState(null);
  const [bulkMode, sBulkMode] = useState(false);
  const [bulkSel, sBulkSel] = useState(new Set());
  const [autoRules, sAutoRules] = useState(() => { try { return JSON.parse(localStorage.getItem("nomad-auto-rules") || "[]"); } catch { return []; } });
  const [autoRulesOpen, sAutoRulesOpen] = useState(false);
  const [subSugOpen, sSubSugOpen] = useState(false);
  // Per-payment wallet override for a due recurring bill: payRec = bill id in
  // "choose wallet" mode, payRecWal = the wallet picked for THIS payment. The
  // bill's saved walletId stays the default; this just overrides per cycle.
  const [payRec, sPayRec] = useState(null), [payRecWal, sPayRecWal] = useState(null);
  const [newRuleKw, sNewRuleKw] = useState(""), [newRuleCat, sNewRuleCat] = useState("");
  const [editingCat, sEditingCat] = useState(null); // {id, name} for inline rename
  const [wallets, sWallets] = useState(() => { try { const s = localStorage.getItem("nomad-wallets-v1"); return s ? JSON.parse(s) : WALLETS; } catch { return WALLETS; } });
  const [aiNarr, sAiNarr] = useState(() => { try { const s = localStorage.getItem("nomad-ai-narrative"); if (!s) return null; const p = JSON.parse(s); if (Date.now() - p.ts > 86400000) return null; return p; } catch { return null; } });
  const [aiNarrLoading, sAiNarrLoading] = useState(false);
  const [narPeriod, sNarPeriod] = useState("month");
  const [aiOpen, sAiOpen] = useState(false);
  // Cross-device prefs sync capability: "unknown" until load() probes the
  // user_prefs table, then "on" (table exists) or "off" (not migrated → stay
  // localStorage-only, never attempt writes so un-migrated users see no errors).
  const [prefsSync, sPrefsSync] = useState("unknown");
  const prefsSaveRef = useRef(null);
  // Snapshot of the prefs blob we last loaded-from / pushed-to the server. The
  // save effect pushes ONLY when the current blob differs from this — otherwise
  // it would re-upload categories on EVERY load (prefsSync flips unknown→on each
  // refresh), perpetually showing "Syncing 1 change" for a no-op. load() seeds
  // this ref with the remote/seeded baseline so the on-load run is a no-op.
  const lastPrefsRef = useRef(null);
  // Push categories / income sources to user_prefs (debounced) ONLY when they
  // actually changed. Gated on prefsSync==="on" so it's a no-op until the table
  // is confirmed present. A single JSONB row keyed "nomad".
  useEffect(() => {
    if (!loaded || prefsSync !== "on" || !SB_ENABLED) return;
    const blob = JSON.stringify({ categories: cats, incomeSources: isrc });
    if (blob === lastPrefsRef.current) return; // nothing changed since last sync — don't re-queue
    if (prefsSaveRef.current) clearTimeout(prefsSaveRef.current);
    prefsSaveRef.current = setTimeout(() => {
      lastPrefsRef.current = blob;
      sbUpsert("user_prefs", [{ key: "nomad", value: { categories: cats, incomeSources: isrc }, updated_at: new Date().toISOString() }], "user_prefs:nomad");
    }, 1200);
    return () => { if (prefsSaveRef.current) clearTimeout(prefsSaveRef.current); };
  }, [cats, isrc, loaded, prefsSync]);
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
    // Haptic echo of the outcome (success/error only — the util ignores
    // info/warn so on-load reminders stay silent, and throttles bursts).
    hapticForToast(type);
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
    // Update banner keys off a WAITING service worker (the SW no longer
    // skipWaiting()s, so controllerchange won't fire until the user accepts).
    // Uses navigator.serviceWorker.ready, NOT getRegistration(): registration
    // happens in main.jsx on window load, which can land AFTER this mount
    // effect — getRegistration() would resolve undefined on a first visit and
    // this listener would never attach for the whole session. ready resolves
    // once the registration exists. Covers all three phases of an update:
    // already waiting, currently installing, and one that starts later
    // (updatefound) while the app is open.
    if ("serviceWorker" in navigator) navigator.serviceWorker.ready.then(reg => { const watch = w => { if (!w) return; const fire = () => { if (w.state === "installed" && navigator.serviceWorker.controller) sSwUpdate(true); }; fire(); w.addEventListener("statechange", fire); }; if (reg.waiting) sSwUpdate(true); watch(reg.installing); reg.addEventListener("updatefound", () => watch(reg.installing)); }).catch(() => {});
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  // load() runs on mount AND can be invoked manually (Settings → Force resync).
  // Declared at component scope (not inside useEffect) so the button handler
  // can call it with the latest closures.
  const load = async ({ skipLocal = false } = {}) => {
    if (!skipLocal) {
      // Show local data instantly — zero startup delay
      loadLocalBackup({ sEx, sInc, sTr, sStl, sCats, sIsrc, sSp, sRec, sEvs, sDm, sWsb, sRecCats });
      sL(true);
    }
    if (!SB_ENABLED || (typeof navigator !== "undefined" && !navigator.onLine)) return false;
      // Flush any pending offline writes before reading remote state, so newly
      // added rows (especially ones still in the queue from the previous tab
      // session) commit before we mirror Supabase back into local state.
      try { await flushSyncQueue(); } catch { /* keep going on flush failure */ }
      // Background refresh — replace with authoritative Supabase data
      try {
        const [dbEx, dbInc, dbTr, dbStl, dbSp, dbRec, dbWsb, dbEvs, delEx, delInc, delTr, delSp, delRec, delEvs] = await Promise.all([
          sbGet("expenses"), sbGet("incomes"), sbGet("transfers"), sbGet("settlements"),
          sbGet("splits"), sbGet("recurring"), sbGet("wallet_balances"), sbGet("events"),
          // Tombstones — soft-deleted IDs so deletes made on other devices
          // propagate here instead of being resurrected from the local backup.
          sbGetDeleted("expenses"), sbGetDeleted("incomes"), sbGetDeleted("transfers"),
          sbGetDeleted("splits"), sbGetDeleted("recurring"), sbGetDeleted("events"),
        ]);
        const delIds = (rows) => new Set((rows || []).map(r => r.id).filter(id => id != null));
        const hadRemoteFailure = [dbEx, dbInc, dbTr, dbStl, dbSp, dbRec, dbWsb, dbEvs].some(x => x === null);
        if (hadRemoteFailure) return false;
        // First-time connect: migrate local data up to Supabase
        // Include wallet_balances: an account with only calibrated balances and
        // zero transactions must NOT be treated as a first-time connect, else a
        // fresh device returns early before applying the remote balances.
        const sbHasData = [dbEx, dbInc, dbTr, dbStl, dbSp, dbRec, dbEvs, dbWsb].some(x => x && x.length > 0);
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
          return true; // local data already rendered, nothing to replace
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
        const exM  = mergeRemote({ table: "expenses",  remote: dbEx,           local: localBackup.expenses,   ...deps, remoteDeletedIds: delIds(delEx) });
        const incM = mergeRemote({ table: "incomes",   remote: dbInc,          local: localBackup.incomes,    ...deps, remoteDeletedIds: delIds(delInc) });
        const trM  = mergeRemote({ table: "transfers", remote: dbTr,           local: localBackup.transfers,  ...deps, remoteDeletedIds: delIds(delTr) });
        const spM  = mergeRemote({ table: "splits",    remote: dbSp,           local: localBackup.splits,     ...deps, remoteDeletedIds: delIds(delSp) });
        const recM = mergeRemote({ table: "recurring", remote: dbRec,          local: localBackup.recurring,  ...deps, remoteDeletedIds: delIds(delRec) });
        const evsM = mergeRemote({ table: "events",    remote: normalizedEvs,  local: localBackup.events,     ...deps, remoteDeletedIds: delIds(delEvs) });
        const stlM = mergeRemote({ table: "settlements", remote: dbStl,         local: localBackup.settlements, ...deps });
        // Apply via FUNCTIONAL updates merged against the LIVE state unioned
        // with the backup — never the backup alone. The Promise.all above can
        // take seconds; anything the user logs in that window exists only in
        // live state (its POST is in flight, so it's not in the offline queue,
        // and the 800ms-debounced nomad-v5 write may not have fired). Setting
        // exM.next directly would wipe those rows from state, and the next
        // debounced backup would then persist the wiped state — entries
        // silently vanish exactly when several are logged in quick succession.
        const applyMerge = (setter, table, remote, backupRows, deletedIds) =>
          setter(prev => mergeRemote({ table, remote, local: unionById(prev, backupRows), ...deps, remoteDeletedIds: deletedIds }).next);
        applyMerge(sEx,  "expenses",   dbEx,          localBackup.expenses,    delIds(delEx));
        applyMerge(sInc, "incomes",    dbInc,         localBackup.incomes,     delIds(delInc));
        applyMerge(sTr,  "transfers",  dbTr,          localBackup.transfers,   delIds(delTr));
        applyMerge(sStl, "settlements", dbStl,        localBackup.settlements, undefined);
        applyMerge(sSp,  "splits",     dbSp,          localBackup.splits,      delIds(delSp));
        applyMerge(sRec, "recurring",  dbRec,         localBackup.recurring,   delIds(delRec));
        applyMerge(sEvs, "events",     normalizedEvs, localBackup.events,      delIds(delEvs));
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
        heal("settlements", COLS.settlements, stlM.orphans);
        // Same race guard for wallet start balances: a recalibration whose
        // wallet_balances upsert is still queued (offline / 5xx-retry) must not
        // be reverted by the stale remote read — keep the local value for those.
        if (dbWsb?.length) { sWsb(prev => { const wb = {}; wallets.forEach(w => { wb[w.id] = 0; }); dbWsb.forEach(r => { wb[r.wallet_id] = r.balance; }); Object.keys(prev || {}).forEach(wid => { if (hasPendingDedupeKey(`wallet_balances:${wid}`)) wb[wid] = prev[wid]; }); return wb; }); }
        // Cross-device prefs (categories / income sources / write-off tags) via
        // the user_prefs JSONB table. Best-effort: if the table isn't migrated the
        // GET 4xxs and we stay localStorage-only (prefsSync "off" → the save effect
        // halts, so un-migrated users see no errors). Remote prefs are authoritative
        // when present and not pending a local upsert — a category added on another
        // device follows you here; the write-off map is UNIONED (local edits win on
        // key conflict) so tags from both devices survive. Equality-guarded so a
        // 60s background pull doesn't churn state when nothing changed.
        let appliedRemotePrefs = false;
        try {
          const rp = await fetchWithTimeout(`${SB_URL}/rest/v1/user_prefs?key=eq.nomad&select=value&limit=1`, { headers: sbH });
          if (rp.ok) {
            sPrefsSync("on");
            const pv = (await rp.json())[0]?.value || null;
            if (pv && !hasPendingDedupeKey("user_prefs:nomad")) {
              if (Array.isArray(pv.categories) && pv.categories.length) { appliedRemotePrefs = true; if (JSON.stringify(pv.categories) !== JSON.stringify(cats)) sCats(pv.categories); }
              if (Array.isArray(pv.incomeSources) && pv.incomeSources.length) { appliedRemotePrefs = true; if (JSON.stringify(pv.incomeSources) !== JSON.stringify(isrc)) sIsrc(pv.incomeSources); }
            }
            // First connect with no prefs row yet: seed it from local setup so the
            // other devices can pull it.
            if (!pv) { const lp0 = (() => { try { return JSON.parse(localStorage.getItem("nomad-v5") || "{}"); } catch { return {}; } })(); sbUpsert("user_prefs", [{ key: "nomad", value: { categories: lp0.categories || cats, incomeSources: lp0.incomeSources || isrc }, updated_at: new Date().toISOString() }], "user_prefs:nomad"); }
            // Baseline the save-effect guard to the synced blob so the post-load
            // render doesn't re-push identical prefs (the phantom "Syncing 1 change").
            { const wasPending = hasPendingDedupeKey("user_prefs:nomad"); const baseCats = (pv && !wasPending && Array.isArray(pv.categories) && pv.categories.length) ? pv.categories : cats; const baseSrc = (pv && !wasPending && Array.isArray(pv.incomeSources) && pv.incomeSources.length) ? pv.incomeSources : isrc; lastPrefsRef.current = JSON.stringify({ categories: baseCats, incomeSources: baseSrc }); }
          } else if (rp.status === 400 || rp.status === 404) {
            sPrefsSync("off");
          }
        } catch { /* network — capability stays as-is */ }
        // Local-only prefs restore from the nomad-v5 backup — ONLY on the initial
        // mount load (never a background re-pull, which would race the 800ms backup
        // debounce and revert a just-made change), and only for prefs not already
        // adopted from remote user_prefs above.
        if (!skipLocal) {
          try {
            const lp = JSON.parse(localStorage.getItem("nomad-v5") || "{}");
            if (lp.darkMode !== undefined) sDm(lp.darkMode);
            if (!appliedRemotePrefs) {
              if (lp.categories?.length) sCats(lp.categories);
              if (lp.incomeSources?.length) sIsrc(lp.incomeSources);
            }
          } catch { }
        }
        return true;
      } catch { /* network error — local data stays */ return false; }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);
  // Cross-device live pull. An open tab fetched remote ONCE on mount, so a row
  // added on another device never appeared here until a full reload — the core
  // "new entries missing on other device" symptom. Re-pull on tab refocus and on
  // a periodic timer. load({skipLocal:true}) flushes the offline write queue
  // first (so our own queued writes propagate too) then re-fetches + merges;
  // mergeRemote keeps any pending-upsert local row, so a background pull can
  // never clobber an in-flight edit. loadRef tracks the latest closure so the
  // interval doesn't fire a stale merge.
  const loadRef = useRef(null);
  useEffect(() => { loadRef.current = load; });
  useEffect(() => {
    if (!SB_ENABLED) return;
    const pull = () => { if ((typeof navigator === "undefined" || navigator.onLine) && (typeof document === "undefined" || document.visibilityState === "visible")) loadRef.current?.({ skipLocal: true }); };
    const onVis = () => { if (document.visibilityState === "visible") pull(); };
    const id = setInterval(pull, 60000);
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
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
  const quickPatterns = useMemo(() => { const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 60); const cutStr = localDateKey(cutoff); const counts = {}; ex.filter(e => !e.deleted_at && !isTrackedExp(e) && (e.date || "") >= cutStr).forEach(e => { const k = `${e.amount}|${e.categoryId || ""}|${e.walletId || "upi_lite"}|${(e.note || "").slice(0, 30)}`; if (!counts[k]) counts[k] = { count: 0, amount: e.amount, categoryId: e.categoryId || "", walletId: e.walletId || "upi_lite", note: e.note || "" }; counts[k].count++; }); return Object.values(counts).filter(p => p.count >= 2).sort((a, b) => b.count - a.count).slice(0, 5); }, [ex]);
  const finStreak = useMemo(() => { const allDays = new Set([...ex, ...inc].map(t => String(t.date || "").slice(0, 10))); let s = 0; const d = new Date(); while (true) { const k = localDateKey(d); if (!allDays.has(k)) break; s++; d.setDate(d.getDate() - 1); } return s; }, [ex, inc]);
  const finScore = useMemo(() => computeFinanceScore({ expenses: ex.filter(e => !isTrackedExp(e)), incomes: inc, recurring: rec }), [ex, inc, rec]);
  const subSuggestions = useMemo(() => { const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 90); const cutStr = localDateKey(cutoff); const recNames = new Set(rec.map(r => r.name.toLowerCase().trim())); const groups = {}; ex.filter(e => !e.deleted_at && !isTrackedExp(e) && (e.date || "") >= cutStr).forEach(e => { const k = (e.note || "").toLowerCase().trim(); if (!k || k.length < 3) return; if (!groups[k]) groups[k] = []; groups[k].push(e); }); return Object.values(groups).filter(g => g.length >= 2).map(g => { const amounts = g.map(e => e.amount); const avgAmt = roundMoney(amounts.reduce((s, a) => s + a, 0) / amounts.length); const name = g[0].note || ""; if (recNames.has(name.toLowerCase().trim())) return null; return { name, categoryId: g[0].categoryId, walletId: g[0].walletId || "bank", count: g.length, avgAmt }; }).filter(Boolean).sort((a, b) => b.count - a.count).slice(0, 5); }, [ex, rec]);
  const flt = useMemo(() => fm === "all" ? { expenses: ex, incomes: inc, settlements: stl } : { expenses: ex.filter(e => mk(e.date) === fm), incomes: inc.filter(i => mk(i.date) === fm), settlements: stl.filter(s => mk(s.date) === fm) }, [ex, inc, stl, fm]);
  const tI = flt.incomes.reduce((s, i) => s + i.amount, 0), tE = Math.max(0, flt.expenses.filter(e => !isTrackedExp(e)).reduce((s, e) => s + e.amount, 0) + flt.settlements.filter(s => s.direction === "owe").reduce((s, x) => s + x.amount, 0) - flt.settlements.filter(s => s.direction === "owed").reduce((s, x) => s + x.amount, 0));
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
    if (hWallet) items = items.filter(it => it.walletId === hWallet || it.fromWallet === hWallet || it.toWallet === hWallet);
    return items.sort(historySortCompare);
  }, [flt, ex, inc, tr, stl, fm, hSearch, hMinAmt, hMaxAmt, hDateFrom, hDateTo, hType, hWallet, cats, isrc, evs]);
  // What the list actually renders: settlements made together (same person, day,
  // direction — e.g. a partial/net settle that pays down several IOUs at once)
  // collapse into one expandable summary card so History isn't flooded with rows.
  // Bulk-select and timeline need flat per-row items, so skip grouping there.
  // historyItems stays flat (bulk delete + result count read it directly).
  const renderItems = useMemo(() => {
    if (bulkMode || hTimeline) return historyItems;
    const groups = new Map(); const out = [];
    for (const it of historyItems) {
      if (it.type !== "settlement") { out.push(it); continue; }
      const key = `${(it.splitName || "").trim().toLowerCase()}|${it.date}|${it.direction}`;
      const g = groups.get(key);
      if (g) g.items.push(it);
      else { const c = { __group: true, type: "settlement", direction: it.direction, splitName: it.splitName, date: it.date, walletId: it.walletId, items: [it], id: "sg_" + key }; groups.set(key, c); out.push(c); }
    }
    return out.map(o => o.__group ? (o.items.length === 1 ? o.items[0] : { ...o, amount: roundMoney(o.items.reduce((t, s) => t + s.amount, 0)) }) : o);
  }, [historyItems, bulkMode, hTimeline]);
  const timelineData = useMemo(() => {
    // Only consumed by history rows when the timeline toggle is ON — skip the
    // full ledger walk entirely while it's off (every tx edit re-runs this memo).
    if (!hTimeline) return {};
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
    // Single forward pass: Σ wDelta over all[0..i] is a running prefix sum per
    // wallet (accumulated in the same j-ascending order the old per-tx
    // slice().reduce() used, so results are bit-identical) — O(n·wallets)
    // instead of O(n²·wallets).
    const map = {};
    const prefix = {};
    wallets.forEach(w => { prefix[w.id] = 0; });
    all.forEach((tx) => {
      const after = {}, before = {};
      const tts = txTs(tx);
      wallets.forEach(w => {
        const cals = calsByWallet[w.id] || [];
        const futureGapSum = cals.filter(c => c.ts > tts).reduce((s, c) => s + (c.gap || 0), 0);
        const histStartBal = (wsb[w.id] || 0) - futureGapSum;
        const d = wDelta(tx, w.id);
        prefix[w.id] += d;
        const aft = histStartBal + prefix[w.id];
        after[w.id] = aft;
        before[w.id] = aft - d;
      });
      map[tx.id] = { before, after };
    });
    return map;
  }, [ex, inc, tr, stl, wsb, wallets, calLog, hTimeline]);

  const budgetStatus = useMemo(() => { const cm = localDateKey().slice(0, 7); const splitCatById = new Map(sp.map(x => [x.id, x.categoryId])); const splitCat = (id) => splitCatById.get(id); const mEx = ex.filter(e => mk(e.date) === cm && !isTrackedExp(e)); const mStl = (stl || []).filter(s => s.direction === "owe" && mk(s.date) === cm); return Object.entries(budgets).filter(entry => entry[1] > 0).map(([cid, lim]) => { const exSum = mEx.filter(e => e.categoryId === cid).reduce((s, e) => s + e.amount, 0); const stlSum = mStl.filter(s => (s.categoryId || splitCat(s.splitId)) === cid).reduce((s, x) => s + x.amount, 0); const spent = roundMoney(exSum + stlSum); const cat = cats.find(c => c.id === cid) || { id: cid, name: cid, color: "#999", neon: "#999" }; const pct = Math.min(100, Math.round(spent / lim * 100)); return { cid, cat, spent, lim, pct }; }); }, [budgets, ex, stl, sp, cats]);

  // Settlements that the user PAID OUT count as real spending, categorized by
  // the linked split's categoryId (snapshot on the settlement, or fetched from
  // the split as a fallback for older rows). Mapped to expense-shape so the
  // spending-breakdown, per-day/per-week chart, and spending-by-category
  // aggregations can include them without forking their logic.
  const settlementsAsExpenses = useMemo(() => {
    const splitCatById = new Map((sp || []).map(x => [x.id, x.categoryId]));
    const splitCat = (id) => splitCatById.get(id);
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
  const exAll = useMemo(() => [...ex.filter(e => !isTrackedExp(e)), ...settlementsAsExpenses], [ex, settlementsAsExpenses]);
  const fltExAll = useMemo(() => fm === "all" ? exAll : exAll.filter(e => mk(e.date) === fm), [exAll, fm]);

  // Keep the first-seen map in sync with active splits: backfill new ids, prune
  // settled/skipped/deleted/removed ones so it can't grow unbounded.
  useEffect(() => {
    sSplitSeen(prev => {
      const now = Date.now();
      const active = (sp || []).filter(s => s && s.id != null && !s.settled && !s.deleted_at && !s.skipped);
      const next = {};
      let changed = false;
      active.forEach(s => {
        if (prev[s.id]) { next[s.id] = prev[s.id]; }
        else { const t = s.createdAt ? new Date(s.createdAt).getTime() : NaN; next[s.id] = Number.isFinite(t) ? t : now; changed = true; }
      });
      if (!changed && Object.keys(prev).length === Object.keys(next).length) return prev;
      try { localStorage.setItem("nomad-split-seen-v1", JSON.stringify(next)); } catch { /* quota */ }
      return next;
    });
  }, [sp]);
  // Stale split detection — IOUs older than 2 days that aren't settled/skipped/deleted.
  // Age source, in priority: in-memory createdAt → linked event.date → first-seen
  // timestamp (splitSeen). Unknown age is NOT treated as stale, so a synced split
  // whose createdAt was dropped on reload can never falsely show "pending 2+ days".
  const staleSplits = useMemo(() => {
    const cutoffMs = Date.now() - 2 * 24 * 60 * 60 * 1000;
    return (sp || []).filter(s => {
      if (s.settled || s.deleted_at || s.skipped) return false;
      let t = null;
      if (s.date) { const x = new Date(s.date + "T12:00:00").getTime(); if (Number.isFinite(x)) t = x; }
      if (t == null && s.createdAt) { const x = new Date(s.createdAt).getTime(); if (Number.isFinite(x)) t = x; }
      if (t == null && s.eventId) { const ev = evs.find(e => e.id === s.eventId); if (ev?.date) { const x = new Date(ev.date + "T00:00:00").getTime(); if (Number.isFinite(x)) t = x; } }
      if (t == null && Number.isFinite(splitSeen[s.id])) t = splitSeen[s.id];
      if (t == null) return false;
      return t < cutoffMs;
    });
  }, [sp, evs, splitSeen]);
  const stalePersonal = useMemo(() => staleSplits.filter(s => !s.eventId), [staleSplits]);
  const staleByEvent = useMemo(() => { const m = {}; staleSplits.forEach(s => { if (s.eventId) (m[s.eventId] = m[s.eventId] || []).push(s); }); return m; }, [staleSplits]);
  // Bad-debt ledger: aggregate the UNPAID remainder of every skipped IOU. A
  // skipped "owed" IOU is money owed to you that you've written off (a loss); a
  // skipped "owe" IOU is a debt of yours that was forgiven (a gain). These are
  // non-cash — they never touched a wallet — so they're surfaced as their own
  // ledger rather than folded into wallet balances or the spending/savings score.
  const writeOffs = useMemo(() => {
    let lost = 0, forgiven = 0;
    (sp || []).forEach(s => {
      if (!s || !s.skipped || s.deleted_at) return;
      const paid = (stl || []).filter(x => x.splitId === s.id).reduce((t, x) => t + x.amount, 0);
      const rem = roundMoney((s.amount || 0) - paid);
      if (rem <= 0.005) return;
      if (s.direction === "owed") lost = roundMoney(lost + rem); else forgiven = roundMoney(forgiven + rem);
    });
    return { lost, forgiven, net: roundMoney(forgiven - lost) };
  }, [sp, stl]);

  const wBal = useMemo(() => { const b = {}; wallets.forEach(w => { b[w.id] = roundMoney(wsb[w.id] || 0); }); inc.forEach(i => { const w = i.walletId || "bank"; if (b[w] !== undefined) b[w] = roundMoney(b[w] + i.amount) }); ex.forEach(e => { const w = e.walletId || "upi_lite"; if (b[w] !== undefined) b[w] = roundMoney(b[w] - e.amount) }); tr.forEach(t => { if (b[t.fromWallet] !== undefined) b[t.fromWallet] = roundMoney(b[t.fromWallet] - t.amount); if (b[t.toWallet] !== undefined) b[t.toWallet] = roundMoney(b[t.toWallet] + t.amount) }); stl.forEach(s => { if (b[s.walletId] !== undefined) { if (s.direction === "owed") b[s.walletId] = roundMoney(b[s.walletId] + s.amount); else b[s.walletId] = roundMoney(b[s.walletId] - s.amount) } }); return b }, [ex, inc, tr, stl, wsb, wallets]);
  const mBal = roundMoney(Object.values(wBal).reduce((s, v) => s + v, 0));
  // Per-wallet verification state. NOMAD can't read your bank, so "verified"
  // means "you recently confirmed the real balance here and nothing has piled
  // up since". A wallet goes stale on the first new txn OR after time
  // (3 days), and shows "drift" when your LAST reconcile found a non-zero gap
  // (i.e. you'd been missing entries — patch the balance AND add what's missing).
  const VFY_STALE_TX = 1, VFY_STALE_DAYS = 3, VFY_GAP_TOL = 1;
  const walletVerify = useMemo(() => {
    const out = {};
    wallets.forEach(w => {
      const logs = calLog.filter(l => l.wId === w.id).sort((a, b) => b.ts - a.ts);
      const last = logs[0] || null;
      // Count activity since the last reconcile — or all activity when the wallet
      // was never reconciled. A never-verified wallet shouldn't park in a dead
      // "Verify" forever: once it has any activity it escalates to "stale"
      // ("Check") to nudge a first reconcile; only a truly empty wallet stays "new".
      const sinceTs = last ? last.ts : 0;
      const sinceDate = last ? last.date : null;
      // A txn is "new since verify" if it happened after the reconcile. Rows added
      // this session carry a precise created_at; rows reloaded from Supabase don't
      // (the core tables have no created_at column), so fall back to the txn DATE
      // and compare days — NOT a 23:59:59 stamp, which would make a same-day txn
      // that already existed at reconcile time falsely un-verify the wallet.
      const isNewSince = (t) => {
        const precise = t.created_at || t.createdAt || t.updated_at;
        if (precise) return new Date(precise).getTime() > sinceTs;
        if (!t.date) return false;
        return last ? t.date > sinceDate : true;
      };
      let newTx = 0;
      const cnt = (arr, hit) => arr.forEach(t => { if (hit(t) && isNewSince(t)) newTx++; });
      cnt(ex, t => (t.walletId || "upi_lite") === w.id);
      cnt(inc, t => (t.walletId || "bank") === w.id);
      cnt(tr, t => t.fromWallet === w.id || t.toWallet === w.id);
      cnt(stl, t => t.walletId === w.id);
      if (!last) { out[w.id] = { state: newTx > 0 ? "stale" : "new", last: null, newTx, days: null }; return; }
      const days = Math.floor((Date.now() - last.ts) / 86400000);
      let state;
      if (Math.abs(last.gap || 0) >= VFY_GAP_TOL) state = "drift";
      else if (newTx >= VFY_STALE_TX || days >= VFY_STALE_DAYS) state = "stale";
      else state = "ok";
      out[w.id] = { state, last, newTx, days };
    });
    return out;
  }, [wallets, calLog, ex, inc, tr, stl]);
  // Lion message: fetch once after data loads, then refresh at most every 10
  // min. Previously fired on every `ex.length` change → spammed /api/ai-chat
  // each time the user added or deleted any transaction.
  const lastLionFetchRef = useRef(0);
  useEffect(() => {
    if (!loaded) return;
    const now = Date.now();
    if (now - lastLionFetchRef.current < 10 * 60 * 1000) return;
    lastLionFetchRef.current = now;
    sLionMsgLoading(true);
    const cm = localDateKey().slice(0, 7);
    const totalInc = inc.reduce((s, i) => s + i.amount, 0);
    const myEx = ex.filter(e => !isTrackedExp(e));
    const totalExp = myEx.reduce((s, e) => s + e.amount, 0);
    const catTotals = {};
    myEx.forEach(e => { catTotals[e.categoryId] = (catTotals[e.categoryId] || 0) + e.amount; });
    const topCats = Object.entries(catTotals).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, amt]) => ({ name: cats.find(c => c.id === id)?.name || id, amount: amt, pct: totalExp > 0 ? Math.round(amt / totalExp * 100) : 0 }));
    const wBals = wallets.map(w => ({ name: w.name, balance: roundMoney(wBal[w.id] || 0) }));
    const LION_ANGLES = ["Channel a disappointed but loving parent", "Be a dramatic Bollywood narrator", "Sound like Gordon Ramsay reviewing my finances", "Be an overly enthusiastic life coach", "Be cryptic like a fortune cookie", "Sound like a cricket commentator calling my spending", "Be a strict school teacher grading my money habits", "Be a bewildered stock market analyst", "Sound like a proud desi dad comparing me to neighbours", "Be a suspenseful movie trailer narrator"];
    const angle = LION_ANGLES[Math.floor(Math.random() * LION_ANGLES.length)];
    fetch("/api/ai-chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: `Give me ONE witty line (max 15 words) as my cheeky lion finance mascot. Style: ${angle}. Use actual numbers from my data — no generic filler!`, context: { month: cm, totalIncome: totalInc, totalExpense: totalExp, topCategories: topCats, walletBalances: wBals, recurringCount: rec.filter(r => r.active !== false).length, streak: finStreak } }) })
      .then(r => r.json())
      .then(d => { if (d.answer) sLionMsg(d.answer.replace(/^["']|["']$/g, "").slice(0, 120)); sLionMsgLoading(false); })
      .catch(() => { sLionMsg(TIPS[Math.floor(Math.random() * TIPS.length)]); sLionMsgLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  const dance = () => { sLd(true); setTimeout(() => sLd(false), 1800) };
  const toSB = (obj, keys) => Object.fromEntries(keys.map(k => [k, obj[k] ?? null]));
  // Compute historical balance up to and including a given date for a wallet
  const balanceOnDate = (walletId, date) => {
    // wsb is the *current* starting balance (post-calibration). Calibrations
    // shift it by `gap` at a specific timestamp — so for any `date` before a
    // calibration's ts, we must subtract gaps from calibrations stamped AFTER
    // that date. Without this, a backdated balance check sees an inflated
    // (or deflated) historical balance and either rejects valid expenses or
    // accepts overdrafts. Same correction the timeline-data memo already does.
    const dayEnd = new Date(date + "T23:59:59").getTime();
    const futureGapSum = (calLog || []).filter(c => c.wId === walletId && c.ts > dayEnd).reduce((s, c) => s + (c.gap || 0), 0);
    const start = (wsb[walletId] || 0) - futureGapSum;
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
    // IOU settlements paid OUT of this wallet (direction "owe") are real debits
    // too — include them or the daily/monthly UPI Lite cap can be silently blown
    // by settling IOUs from UPI Lite (settlements bypass the expenses array).
    const stDay = (stl || []).filter(s => s.walletId === walletId && s.direction === "owe" && s.date === date).reduce((t, s) => t + s.amount, 0);
    const stMonth = (stl || []).filter(s => s.walletId === walletId && s.direction === "owe" && String(s.date || "").slice(0, 7) === mk).reduce((t, s) => t + s.amount, 0);
    return { day: roundMoney(day + stDay), month: roundMoney(month + stMonth) };
  };

  // `balanceDelta` is for BATCH imports only: wBal/balanceOnDate come from
  // state that doesn't update until the next render, so every entry in a
  // tight loop would otherwise be validated against the PRE-batch balance
  // (and store a stale balBefore). Callers thread the net effect of the
  // batch entries already accepted so each one sees the balance the previous
  // ones left behind — as if they'd been typed one at a time.
  const addE = (data, { balanceDelta = 0 } = {}) => {
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
    const b = roundMoney((isBackdated ? balanceOnDate(data.walletId, data.date) : (wBal[data.walletId] || 0)) + balanceDelta);
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
    if (budgets[data.categoryId] > 0) { const cm = localDateKey().slice(0, 7); const prev = ex.filter(e => e.categoryId === data.categoryId && mk(e.date) === cm && !isTrackedExp(e)).reduce((s, e) => s + e.amount, 0); const tot = prev + amt; const lim = budgets[data.categoryId]; const cn = cats.find(c => c.id === data.categoryId)?.name || data.categoryId; if (tot >= lim) showT(`${cn} budget exceeded! ${fmt(tot)} / ${fmt(lim)}`, "error"); else if (tot >= lim * 0.8) showT(`${cn} at ${Math.round(tot / lim * 100)}% of budget (${fmt(lim)})`, "info"); }
    showT(online ? "Expense added" : "Expense saved offline", "success");
    return true;
  };
  const addI = (data, { balanceDelta = 0 } = {}) => { const amt = roundMoney(data.amount); if (isUpiLite(data.walletId, wallets)) { showT("UPI Lite is for spending only", "error"); return false } if (amt <= 0) { showT("Enter a valid amount", "error"); return false } if (amt > 10000000) { showT("Amount too large (max ₹1 crore)", "error"); return false } if (typeof data.note === "string" && data.note.length > 500) data = { ...data, note: data.note.slice(0, 500) }; const isBackdated = data.date && data.date < localDateKey(); const balBefore = roundMoney((isBackdated ? balanceOnDate(data.walletId, data.date) : (wBal[data.walletId] || 0)) + balanceDelta); const rec = { id: uid(), type: "income", ...data, amount: amt, balBefore, created_at: new Date().toISOString() }; sInc(p => [rec, ...p]); sbUpsert("incomes", [toSB(rec, COLS.incomes)]); dance(); showT(online ? "Income added" : "Income saved offline", "success"); return true };
  const addT = data => { const amt = roundMoney(data.amount); if (amt <= 0) { showT("Enter an amount above zero", "error"); return false } if (amt > 10000000) { showT("Amount too large (max ₹1 crore)", "error"); return false } if (!data.fromWallet || !data.toWallet) { showT("Pick a source and a destination wallet", "error"); return false } if (data.fromWallet === data.toWallet) { showT("Source and destination must be different wallets", "error"); return false } const isBackdated = data.date && data.date < localDateKey(); const fromBalBefore = roundMoney(isBackdated ? balanceOnDate(data.fromWallet, data.date) : (wBal[data.fromWallet] || 0)); if (fromBalBefore < amt) { showT(`Insufficient balance`, "error"); return false } if (typeof data.note === "string" && data.note.length > 500) data = { ...data, note: data.note.slice(0, 500) }; const toBalBefore = roundMoney(isBackdated ? balanceOnDate(data.toWallet, data.date) : (wBal[data.toWallet] || 0)); if (isUpiLite(data.toWallet, wallets) && exceedsUpiLiteBalance(toBalBefore, amt)) { showT(`UPI Lite max balance is ₹${UPI_LITE_MAX_BALANCE} (RBI rule)`, "error"); return false } const rec = { id: uid(), type: "transfer", ...data, amount: amt, fromBalBefore, toBalBefore, created_at: new Date().toISOString() }; sTr(p => [rec, ...p]); sbUpsert("transfers", [toSB(rec, COLS.transfers)]); dance(); showT(online ? "Transfer done" : "Transfer queued offline", "success"); return true };
  const refundItem = exp => { if (!exp || exp.amount <= 0 || exp.walletId === "__tracked__") return; const src = isrc[0]; if (!src) { showT("No income source configured", "error"); return; } let destW = exp.walletId, rerouted = false; if (isUpiLite(destW, wallets)) { const alt = wallets.find(w => w.id === "bank" && !isUpiLite(w, wallets)) || wallets.find(w => !isUpiLite(w, wallets)); if (!alt) { showT("No wallet can receive a refund — UPI Lite is spend-only", "error"); return; } destW = alt.id; rerouted = true; } const note = ("Refund: " + (exp.note || cats.find(c => c.id === exp.categoryId)?.name || "")).slice(0, 500); const ok = addI({ id: uid(), amount: exp.amount, sourceId: src.id, walletId: destW, note, date: localDateKey() }); if (ok !== false && rerouted) showT(`Refund added to ${wallets.find(w => w.id === destW)?.name || destW} (UPI Lite can't receive)`, "info"); };
  const settle = (sid, wid, payAmt, date) => {
    const s = sp.find(x => x.id === sid);
    if (!s) return false;
    const today = localDateKey();
    const day = date && date <= today ? date : today;
    const prevPaid = stl.filter(x => x.splitId === sid).reduce((t, x) => t + x.amount, 0);
    const remaining = roundMoney(s.amount - prevPaid);
    if (remaining < -0.005) { showT(`Over-settled — ${fmt(prevPaid)} paid against ${fmt(s.amount)} IOU. Check sync issues in Settings.`, "error"); return false; }
    const hasPayAmt = payAmt != null && payAmt !== "";
    const payNum = hasPayAmt ? Number(payAmt) : null;
    if (hasPayAmt && (!Number.isFinite(payNum) || payNum <= 0)) { showT("Enter a valid amount", "error"); return false; }
    const amount = hasPayAmt ? roundMoney(Math.min(payNum, remaining)) : remaining;
    if (amount <= 0) { showT("Already fully settled", "info"); return false; }
    if (s.direction === "owe") {
      const b = roundMoney(day < today ? balanceOnDate(wid, day) : (wBal[wid] || 0));
      if (b < amount) { showT(`Not enough — need ${fmt(amount)}, have ${fmt(b)}`, "error"); return false }
      if (isUpiLite(wid, wallets)) {
        const u = upiLiteUsage(day, wid);
        if (roundMoney(u.day + amount) > 5000) { showT(`UPI Lite daily cap ₹5000 exceeded (₹${u.day} used)`, "error"); return false }
        if (roundMoney(u.month + amount) > 100000) { showT(`UPI Lite monthly cap ₹1L exceeded`, "error"); return false }
        if (roundMoney(u.day + amount) > 4500) { showT(`Heads up: UPI Lite at ₹${roundMoney(u.day + amount)} today`, "info") }
      }
    }
    if (s.direction === "owed" && isUpiLite(wid, wallets)) { showT("UPI Lite cannot receive money", "error"); return false }
    const rec = { id: uid(), type: "settlement", splitName: s.name, splitId: s.id, amount, direction: s.direction, walletId: wid, date: day, createdAt: new Date().toISOString(), ...(s.categoryId && { categoryId: s.categoryId }), ...(s.note && { note: s.note }), ...(s.groupId && { groupId: s.groupId }), ...(s.eventId && { eventId: s.eventId }) };
    sStl(p => [...p, rec]);
    sbUpsert("settlements", [toSB(rec, COLS.settlements)]);
    const newTotal = roundMoney(prevPaid + amount);
    const fullySettled = newTotal >= s.amount - 0.005;
    if (fullySettled) { sSp(p => p.map(x => x.id === sid ? { ...x, settled: true } : x)); sbUpsert("splits", [{ id: sid, settled: true }], `splits:${sid}`); showT(online ? "Fully settled ✓" : "Settlement queued offline", "success"); }
    else { showT(`Paid ${fmt(amount)} · ${fmt(roundMoney(s.amount - newTotal))} still remaining`, "success"); }
    return true;
  };
  // Settle a person's whole balance with a single net movement. When someone
  // both owes you and is owed by you, the two sides cancel — only the net needs
  // to actually change hands. We record an offsetting settlement against every
  // pending IOU (so each links/categorizes correctly) but validate wallet funds
  // against the NET, so you only need the net amount on hand to clear everything.
  // sources: null → personal IOUs only (original behavior). { general, eventIds } →
  // ATOMIC cross-source settle for the wallet's "Settle everything": general (when
  // general is true) + each listed event's expense-derived IOUs, netted and
  // validated in ONE pass against ONE wallet snapshot. Looping the per-source
  // handlers instead would validate every payout against the same stale wBal
  // (it's a useMemo — no re-render happens between synchronous calls in a click
  // handler), letting two payouts jointly overdraw a wallet — and would stack
  // one toast per source.
  const settleNet = (name, wid, payAmt, sources = null) => {
    const remOf = s => roundMoney(s.amount - stl.filter(x => x.splitId === s.id).reduce((t, x) => t + x.amount, 0));
    const nameLc = String(name || "").trim().toLowerCase();
    const evSet = sources ? new Set(sources.eventIds || []) : null;
    const evExp = {}; if (evSet) evSet.forEach(id => { evExp[id] = new Set(ex.filter(e => e.eventId === id && !e.deleted_at).map(e => e.id)); });
    const inScope = s => !s.eventId ? (sources ? sources.general !== false : true) : (evSet ? evSet.has(s.eventId) && !!s.groupId && evExp[s.eventId].has(s.groupId) : false);
    const items = sp.filter(s => (s.name || "").trim().toLowerCase() === nameLc && !s.deleted_at && !s.settled && !s.skipped && inScope(s)).map(s => ({ s, rem: remOf(s) })).filter(x => x.rem > 0.005);
    if (!items.length) { showT("Nothing pending to settle", "info"); return false; }
    const net = roundMoney(items.reduce((t, x) => t + (x.s.direction === "owed" ? x.rem : -x.rem), 0));
    const hasPayAmt = payAmt != null && payAmt !== "";
    const payNum = hasPayAmt ? Number(payAmt) : null;
    if (hasPayAmt && (!Number.isFinite(payNum) || payNum <= 0)) { showT("Enter a valid amount", "error"); return false; }
    const today = localDateKey();
    const mkRec = (x, amt) => ({ id: uid(), type: "settlement", splitName: x.s.name, splitId: x.s.id, amount: amt, direction: x.s.direction, walletId: wid, date: today, createdAt: new Date().toISOString(), ...(x.s.categoryId && { categoryId: x.s.categoryId }), ...(x.s.note && { note: x.s.note }), ...(x.s.groupId && { groupId: x.s.groupId }), ...(x.s.eventId && { eventId: x.s.eventId }) });
    // Partial: pay down the net direction only, up to the capped amount. The
    // remainder (and any opposite-direction IOUs) stay pending for a later settle.
    if (hasPayAmt && roundMoney(payNum) < Math.abs(net) - 0.005) {
      const dir = net > 0 ? "owed" : "owe";
      if (dir === "owed" && isUpiLite(wid, wallets)) { showT("UPI Lite cannot receive money — pick another wallet", "error"); return false; }
      let cap = roundMoney(Math.min(payNum, Math.abs(net)));
      if (dir === "owe") {
        const b = roundMoney(wBal[wid] || 0);
        if (b < cap) { showT(`Not enough — need ${fmt(cap)}, ${wallets.find(w => w.id === wid)?.name || "wallet"} has ${fmt(b)}`, "error"); return false; }
        if (isUpiLite(wid, wallets)) { const u = upiLiteUsage(today, wid); if (roundMoney(u.day + cap) > 5000) { showT(`UPI Lite daily cap ₹5000 exceeded (₹${u.day} used)`, "error"); return false; } if (roundMoney(u.month + cap) > 100000) { showT("UPI Lite monthly cap ₹1L exceeded", "error"); return false; } }
      }
      const recs = []; const doneIds = [];
      // General IOUs pay down before event IOUs so a partial amount clears the
      // person's direct debts first (matches the wallet's stated allocation).
      const ordered = items.filter(i => i.s.direction === dir).sort((a, b) => (a.s.eventId ? 1 : 0) - (b.s.eventId ? 1 : 0));
      for (const x of ordered) {
        if (cap <= 0.005) break;
        const pay = roundMoney(Math.min(x.rem, cap));
        recs.push(mkRec(x, pay));
        if (pay >= x.rem - 0.005) doneIds.push(x.s.id);
        cap = roundMoney(cap - pay);
      }
      const paid = roundMoney(recs.reduce((t, r) => t + r.amount, 0));
      sStl(p => [...p, ...recs]);
      sbUpsert("settlements", recs.map(r => toSB(r, COLS.settlements)));
      if (doneIds.length) { sSp(p => p.map(x => doneIds.includes(x.id) ? { ...x, settled: true } : x)); doneIds.forEach(id => sbUpsert("splits", [{ id, settled: true }], `splits:${id}`)); }
      showT(`Settled ${fmt(paid)} with ${name} · ${fmt(roundMoney(Math.abs(net) - paid))} left`, online ? "success" : "info");
      return true;
    }
    // Full net settle: owe/owed cancel, only the net moves.
    const youPay = net < -0.005;
    const hasIncoming = net > 0.005 || items.some(x => x.s.direction === "owed");
    if (hasIncoming && isUpiLite(wid, wallets)) { showT("UPI Lite cannot receive money — pick another wallet", "error"); return false; }
    if (youPay) {
      const b = roundMoney(wBal[wid] || 0);
      if (b < -net) { showT(`Not enough — net is ${fmt(-net)}, ${wallets.find(w => w.id === wid)?.name || "wallet"} has ${fmt(b)}`, "error"); return false; }
      if (isUpiLite(wid, wallets)) { const u = upiLiteUsage(today, wid); if (roundMoney(u.day + (-net)) > 5000) { showT(`UPI Lite daily cap ₹5000 exceeded (₹${u.day} used)`, "error"); return false; } if (roundMoney(u.month + (-net)) > 100000) { showT("UPI Lite monthly cap ₹1L exceeded", "error"); return false; } }
    }
    const recs = items.map(x => mkRec(x, x.rem));
    const ids = items.map(x => x.s.id);
    sStl(p => [...p, ...recs]);
    sbUpsert("settlements", recs.map(r => toSB(r, COLS.settlements)));
    sSp(p => p.map(x => ids.includes(x.id) ? { ...x, settled: true } : x));
    ids.forEach(id => sbUpsert("splits", [{ id, settled: true }], `splits:${id}`));
    showT(Math.abs(net) < 0.005 ? `Settled up with ${name} ✓` : youPay ? `Paid net ${fmt(-net)} to ${name} ✓` : `Received net ${fmt(net)} from ${name} ✓`, online ? "success" : "info");
    return true;
  };
  // Event-scoped sibling of settleNet: settles a participant's EXPENSE-derived
  // IOUs inside ONE event (the "Settle Up" suggestion in the group ledger). It
  // deliberately ignores manually-added split IOUs — those have their own per-IOU
  // Settle button — and only touches the auto-IOUs created by addExp (groupId
  // matches an event expense), so the suggestion's amount, the settlement, and the
  // grpSettled reconciliation all line up. Records keep their eventId + groupId so
  // grpSettled picks them up. An optional payAmt settles only part of the net.
  const settleEventNet = (eventId, name, wid, payAmt) => {
    const remOf = s => roundMoney(s.amount - stl.filter(x => x.splitId === s.id).reduce((t, x) => t + x.amount, 0));
    const nameLc = String(name || "").toLowerCase();
    const expIds = new Set(ex.filter(e => e.eventId === eventId && !e.deleted_at).map(e => e.id));
    const items = sp.filter(s => s.eventId === eventId && (s.name || "").toLowerCase() === nameLc && s.groupId && expIds.has(s.groupId) && !s.deleted_at && !s.settled && !s.skipped).map(s => ({ s, rem: remOf(s) })).filter(x => x.rem > 0.005);
    if (!items.length) { showT(`No pending IOUs with ${name} in this event`, "info"); return false; }
    const net = roundMoney(items.reduce((t, x) => t + (x.s.direction === "owed" ? x.rem : -x.rem), 0));
    const hasPayAmt = payAmt != null && payAmt !== "";
    const payNum = hasPayAmt ? Number(payAmt) : null;
    if (hasPayAmt && (!Number.isFinite(payNum) || payNum <= 0)) { showT("Enter a valid amount", "error"); return false; }
    const today = localDateKey();
    const mkRec = (x, amt) => ({ id: uid(), type: "settlement", splitName: x.s.name, splitId: x.s.id, amount: amt, direction: x.s.direction, walletId: wid, date: today, createdAt: new Date().toISOString(), eventId, ...(x.s.categoryId && { categoryId: x.s.categoryId }), ...(x.s.note && { note: x.s.note }), ...(x.s.groupId && { groupId: x.s.groupId }) });
    // Partial: pay down the net direction only, up to the capped amount. The
    // remainder (and any opposite-direction IOUs) stay pending for a later settle.
    if (hasPayAmt && roundMoney(payNum) < Math.abs(net) - 0.005) {
      const dir = net > 0 ? "owed" : "owe";
      if (dir === "owed" && isUpiLite(wid, wallets)) { showT("UPI Lite cannot receive money — pick another wallet", "error"); return false; }
      let cap = roundMoney(Math.min(payNum, Math.abs(net)));
      if (dir === "owe") {
        const b = roundMoney(wBal[wid] || 0);
        if (b < cap) { showT(`Not enough — need ${fmt(cap)}, ${wallets.find(w => w.id === wid)?.name || "wallet"} has ${fmt(b)}`, "error"); return false; }
        if (isUpiLite(wid, wallets)) { const u = upiLiteUsage(today, wid); if (roundMoney(u.day + cap) > 5000) { showT(`UPI Lite daily cap ₹5000 exceeded (₹${u.day} used)`, "error"); return false; } if (roundMoney(u.month + cap) > 100000) { showT("UPI Lite monthly cap ₹1L exceeded", "error"); return false; } }
      }
      const recs = []; const doneIds = [];
      for (const x of items.filter(i => i.s.direction === dir)) {
        if (cap <= 0.005) break;
        const pay = roundMoney(Math.min(x.rem, cap));
        recs.push(mkRec(x, pay));
        if (pay >= x.rem - 0.005) doneIds.push(x.s.id);
        cap = roundMoney(cap - pay);
      }
      const paid = roundMoney(recs.reduce((t, r) => t + r.amount, 0));
      sStl(p => [...p, ...recs]);
      sbUpsert("settlements", recs.map(r => toSB(r, COLS.settlements)));
      if (doneIds.length) { sSp(p => p.map(x => doneIds.includes(x.id) ? { ...x, settled: true } : x)); doneIds.forEach(id => sbUpsert("splits", [{ id, settled: true }], `splits:${id}`)); }
      showT(`Settled ${fmt(paid)} with ${name} · ${fmt(roundMoney(Math.abs(net) - paid))} left`, online ? "success" : "info");
      return true;
    }
    // Full net settle: clear every expense IOU (owe/owed cancel) in one move.
    const youPay = net < -0.005;
    const hasIncoming = net > 0.005 || items.some(x => x.s.direction === "owed");
    if (hasIncoming && isUpiLite(wid, wallets)) { showT("UPI Lite cannot receive money — pick another wallet", "error"); return false; }
    if (youPay) {
      const b = roundMoney(wBal[wid] || 0);
      if (b < -net) { showT(`Not enough — net is ${fmt(-net)}, ${wallets.find(w => w.id === wid)?.name || "wallet"} has ${fmt(b)}`, "error"); return false; }
      if (isUpiLite(wid, wallets)) { const u = upiLiteUsage(today, wid); if (roundMoney(u.day + (-net)) > 5000) { showT(`UPI Lite daily cap ₹5000 exceeded (₹${u.day} used)`, "error"); return false; } if (roundMoney(u.month + (-net)) > 100000) { showT("UPI Lite monthly cap ₹1L exceeded", "error"); return false; } }
    }
    const recs = items.map(x => mkRec(x, x.rem));
    const ids = items.map(x => x.s.id);
    sStl(p => [...p, ...recs]);
    sbUpsert("settlements", recs.map(r => toSB(r, COLS.settlements)));
    sSp(p => p.map(x => ids.includes(x.id) ? { ...x, settled: true } : x));
    ids.forEach(id => sbUpsert("splits", [{ id, settled: true }], `splits:${id}`));
    showT(Math.abs(net) < 0.005 ? `Settled up with ${name} ✓` : youPay ? `Paid net ${fmt(-net)} to ${name} ✓` : `Received net ${fmt(net)} from ${name} ✓`, online ? "success" : "info");
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
    else if (buf.type === "event") { sEvs(p => [buf.exp, ...p]); sbUpsert("events", [{ ...toSB(buf.exp, COLS.events), deleted_at: null }]); if (buf.splits?.length) { sSp(p => [...p, ...buf.splits]); sbUpsert("splits", buf.splits.map(s => ({ ...toSB(s, COLS.splits), deleted_at: null }))); } if (buf.settlements?.length) { sStl(p => [...p, ...buf.settlements]); sbUpsert("settlements", buf.settlements.map(s => toSB(s, COLS.settlements))); } }
    else if (buf.type === "split") { sSp(p => [...p, buf.exp]); sbUpsert("splits", [{ ...toSB(buf.exp, COLS.splits), deleted_at: null }]); }
    else if (buf.type === "skip") { sSp(p => p.map(x => x.id === buf.id ? { ...x, settled: false, skipped: false } : x)); sbUpsert("splits", [{ id: buf.id, settled: false, skipped: false }], `splits:${buf.id}`); }
    undoBuffersRef.current.delete(toastId);
    dismissToast(toastId);
    showT("Restored", "success");
  };

  const showUndoToast = (msg, buffer) => {
    hapticMedium(); // a delete is significant — give it weight beyond the info toast
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
      const s = sp.find(x => x.id === id); if (!s) return;
      sSp(p => p.filter(x => x.id !== id)); sbDelete("splits", id);
      showUndoToast("IOU deleted", { type: "split", exp: s });
    }
  }, [ex, sp, stl, inc, tr]);
  // Skip = write-off without payment; undo-able. Unskip restores a skipped IOU to pending.
  // Both single-sourced so Events + IOUWallet stay consistent (and reversible).
  const skipSplit = useCallback(id => { const s = sp.find(x => x.id === id); if (!s) return; sSp(p => p.map(x => x.id === id ? { ...x, settled: true, skipped: true } : x)); sbUpsert("splits", [{ id, settled: true, skipped: true }], `splits:${id}`); showUndoToast("IOU skipped — written off", { type: "skip", id }); }, [sp]);
  const unskipSplit = useCallback(id => { const s = sp.find(x => x.id === id); if (!s) return; sSp(p => p.map(x => x.id === id ? { ...x, settled: false, skipped: false } : x)); sbUpsert("splits", [{ id, settled: false, skipped: false }], `splits:${id}`); showT("IOU restored to pending", "success"); }, [sp]);
  const addRec = r => { sRec(p => [...p, r]); sbUpsert("recurring", [toSB(r, COLS.recurring)]); showT(r.name + " added as recurring", "success"); };
  const addCust = () => { if (!nn.trim()) return; const id = nn.trim().toLowerCase().replace(/\s+/g, "_") + "_" + uid(), item = { id, name: nn.trim(), emoji: ne2, color: nc }; if (mt === "expense") sCats(p => [...p, item]); else sIsrc(p => [...p, item]); sNN(""); sNE2("📁"); sNC("#E07A5F") };
  const handleCal = (wId, desired, note = "") => {
    if (isUpiLite(wId, wallets) && desired > UPI_LITE_MAX_BALANCE) {
      showT(`UPI Lite max balance is ₹${UPI_LITE_MAX_BALANCE} (RBI rule)`, "error");
      return;
    }
    if (desired < 0) {
      showT("Balance cannot be negative", "error");
      return;
    }
    const cur = roundMoney(wBal[wId] || 0);
    const gap = roundMoney(desired - cur);
    const wName = wallets.find(w => w.id === wId)?.name || wId;
    const start = wsb[wId] || 0, newStart = start + (desired - cur);
    // gap === 0 is a verification (balance already matches): skip the no-op
    // balance write, but STILL record it in the cal-log below so walletVerify
    // clears "Drift" and stamps "Verified" — the cal-log IS the verification
    // record. gap !== 0 is a real reconcile, so persist the new start balance.
    if (gap !== 0) {
      sWsb(p => ({ ...p, [wId]: newStart }));
      sbUpsert("wallet_balances", [{ wallet_id: wId, balance: newStart }], `wallet_balances:${wId}`);
    }
    try {
      const prev = JSON.parse(localStorage.getItem("nomad-cal-log") || "[]");
      const entry = { wId, wName, date: localDateKey(), before: cur, after: roundMoney(desired), gap, note: note.trim(), ts: Date.now() };
      const updated = [entry, ...prev].slice(0, 50);
      localStorage.setItem("nomad-cal-log", JSON.stringify(updated));
      sCalLog(updated);
    } catch { }
    showT(gap === 0 ? `✓ ${wName} verified — balance in sync` : `${gap > 0 ? "Added" : "Removed"} ${fmt(Math.abs(gap))} — reconciliation logged`, "success");
  };
  const expCSV = () => { const esc = s => String(s || "").replace(/"/g, '""'); let csv = "Type,Date,Amount,Category/Source,Wallet,Note\n"; inc.forEach(i => { csv += `Income,${i.date},${i.amount},"${esc(isrc.find(s => s.id === i.sourceId)?.name)}","${esc(wallets.find(x => x.id === i.walletId)?.name)}","${esc(i.note)}"\n` }); ex.forEach(e => { csv += `Expense,${e.date},${e.amount},"${esc(cats.find(c => c.id === e.categoryId)?.name)}","${esc(wallets.find(x => x.id === e.walletId)?.name)}","${esc(e.note)}"\n` }); tr.forEach(t => { csv += `Transfer,${t.date},${t.amount},"${esc(wallets.find(x => x.id === t.fromWallet)?.name || t.fromWallet)}→${esc(wallets.find(x => x.id === t.toWallet)?.name || t.toWallet)}","","${esc(t.note)}"\n` }); stl.forEach(s => { csv += `Settlement,${s.date},${s.amount},"${esc(s.splitName)}","${esc(wallets.find(w => w.id === s.walletId)?.name)}","${esc(s.direction)}"\n` }); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = `nomad_${localDateKey()}.csv`; a.click() };
  const expBackup = () => { const data = JSON.stringify({ expenses: ex, incomes: inc, transfers: tr, settlements: stl, categories: cats, incomeSources: isrc, splits: sp, events: evs, recurring: rec, darkMode: dm, walletStartBal: wsb, wallets, autoRules, budgets, _v: "nomad-v9", _date: new Date().toISOString() }, null, 2); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([data], { type: "application/json" })); a.download = `nomad_backup_${localDateKey()}.json`; a.click(); showT("Backup downloaded", "success") };
  // True when a row's receipt_url holds at least one locally-stored data: URL —
  // either the whole value, or one element of a JSON-array of URLs. Single source
  // of truth for the Local Receipts count, the migrate filter, and the discard
  // filter (they used to each inline their own copy and drift apart).
  const rowHasLocalReceipt = (row) => {
    const u = row?.receipt_url;
    if (typeof u !== "string") return false;
    if (u.startsWith("data:")) return true;
    try { const arr = JSON.parse(u); return Array.isArray(arr) && arr.some(x => typeof x === "string" && x.startsWith("data:")); }
    catch { return false; }
  };
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
    const processRow = async (row, table, setState, cols) => {
      let urls;
      try { urls = JSON.parse(row.receipt_url); if (!Array.isArray(urls)) urls = [row.receipt_url]; }
      catch { urls = [row.receipt_url]; }
      const newUrls = await Promise.all(urls.map(async (u) => {
        if (typeof u !== "string" || !u.startsWith("data:")) return u;
        let file;
        try { file = dataUrlToFile(u); }
        catch { if (!firstError) firstError = "Receipt image data is corrupt — can't re-upload. Use 'Discard local copy' to clear it."; console.warn("Migration: corrupt data URL on row", row.id); return u; }
        try {
          return await uploadReceipt(file, { throwOnFail: true });
        } catch (e) {
          if (!firstError) firstError = e?.message || "Upload failed";
          console.warn("Migration upload failed:", e?.message || e);
          return u;
        }
      }));
      const anyUpdated = newUrls.some((u, i) => u !== urls[i] && !u.startsWith("data:"));
      if (!anyUpdated) { failed++; return; }
      const final = newUrls.length === 1 ? newUrls[0] : JSON.stringify(newUrls);
      // Persist the FULL row (same write path as addE/addI) so the new Cloudinary
      // URL reliably reaches Supabase. The old code sent a partial {id,receipt_url}
      // upsert and ignored its result — when that write didn't stick, the next
      // load() (mergeRemote always prefers the remote row) overwrote the local
      // cloud URL back to the stored data: URL and the nag card came right back.
      // Verify the write succeeded before counting the receipt migrated.
      setState(prev => prev.map(x => x.id === row.id ? { ...x, receipt_url: final } : x));
      if (SB_ENABLED) {
        const wr = await sbUpsert(table, [toSB({ ...row, receipt_url: final }, cols)]);
        if (!wr.ok && !wr.queued) { if (!firstError) firstError = "Image uploaded but the database update failed — check connection and retry."; failed++; return; }
      }
      // Only count a row migrated when EVERY receipt on it is now a remote URL.
      // A multi-page row where one page still won't upload keeps its data: URL,
      // so it stays in the Local Receipts count — calling it "migrated" would
      // contradict the card. Count those as failed so the toast matches reality.
      const stillLocal = newUrls.some(u => typeof u === "string" && u.startsWith("data:"));
      if (stillLocal) { if (!firstError) firstError = "Some receipt pages couldn't upload — re-run or discard the rest."; failed++; }
      else migrated++;
    };
    const localEx = ex.filter(rowHasLocalReceipt);
    const localInc = inc.filter(rowHasLocalReceipt);
    if (localEx.length + localInc.length === 0) { sLrMigrating(false); showT("No local receipts to migrate", "info"); return; }
    for (const r of localEx) await processRow(r, "expenses", sEx, COLS.expenses);
    for (const r of localInc) await processRow(r, "incomes", sInc, COLS.incomes);
    sLrMigrating(false);
    const total = migrated + failed;
    if (migrated > 0 && failed === 0) showT(`Migrated ${migrated} receipt${migrated === 1 ? "" : "s"} to Cloudinary`, "success");
    else if (migrated > 0) showT(`Migrated ${migrated} of ${total} · ${failed} failed: ${firstError || "unknown error"}`, "info");
    else showT(`All ${failed} migration attempt${failed === 1 ? "" : "s"} failed: ${firstError || "unknown error"}`, "error");
  };
  // Escape hatch for receipts that won't re-upload (corrupt base64, or an
  // oversized PDF Cloudinary keeps rejecting) — without this the nag card was
  // stuck forever. Strips only the data: URLs from each row and KEEPS any
  // Cloudinary URL already present, so a receipt that's genuinely in the cloud
  // keeps its cloud copy and just sheds the redundant local blob. Pure-local
  // receipts (never uploaded) lose the image; the transaction itself is untouched.
  const discardLocalReceipts = () => {
    const localEx = ex.filter(rowHasLocalReceipt);
    const localInc = inc.filter(rowHasLocalReceipt);
    const n = localEx.length + localInc.length;
    if (n === 0) return;
    if (!window.confirm(`Remove ${n} locally-stored receipt image${n === 1 ? "" : "s"}?\n\nReceipts already uploaded to Cloudinary keep their cloud copy. Any image that was never uploaded will be lost — the transaction stays.`)) return;
    const strip = (row, table, setState, cols) => {
      let urls;
      try { urls = JSON.parse(row.receipt_url); if (!Array.isArray(urls)) urls = [row.receipt_url]; }
      catch { urls = [row.receipt_url]; }
      const kept = urls.filter(u => typeof u === "string" && !u.startsWith("data:"));
      const final = kept.length === 0 ? null : kept.length === 1 ? kept[0] : JSON.stringify(kept);
      setState(prev => prev.map(x => x.id === row.id ? { ...x, receipt_url: final } : x));
      if (SB_ENABLED) sbUpsert(table, [toSB({ ...row, receipt_url: final }, cols)]);
    };
    localEx.forEach(r => strip(r, "expenses", sEx, COLS.expenses));
    localInc.forEach(r => strip(r, "incomes", sInc, COLS.incomes));
    showT(`Cleared ${n} local receipt${n === 1 ? "" : "s"}`, "success");
  };
  const impCsv = (file) => { const r = new FileReader(); r.onerror = () => showT("Failed to read CSV file", "error"); r.onload = e => { const rows = parseBankCsv(e.target.result); if (rows.length === 0) { showT("No valid rows found — check CSV format", "error"); return; } const matched = rows.map(row => { const note = (row.note || "").toLowerCase(); const rule = autoRules.find(ru => note.includes(ru.keyword.toLowerCase())); return rule ? { ...row, categoryId: rule.categoryId } : row; }); const autoCount = matched.filter(row => row.categoryId).length; sCsvPreview(matched); showT(`Parsed ${rows.length} rows${autoCount ? ` · ${autoCount} auto-categorized` : ""} — review and confirm`, "info"); }; r.readAsText(file); };
  // Running per-wallet balance for batch imports — see the addE balanceDelta
  // comment. Backdated entries are validated against balanceOnDate(entry.date),
  // so only batch entries dated on/before that date count toward their delta;
  // today/future entries check live wBal, so every accepted batch entry counts.
  const makeBatchTracker = () => {
    const applied = [];
    return {
      deltaFor: (walletId, date, isBackdated) => roundMoney(applied.filter(x => x.walletId === walletId && (!isBackdated || x.date <= date)).reduce((s, x) => s + x.amt, 0)),
      record: (walletId, date, amt) => applied.push({ walletId, date, amt }),
    };
  };
  const confirmCsvImport = () => { if (!csvPreview?.length) return; let imported = 0; const batch = makeBatchTracker(), today = localDateKey(); const defWallet = wallets[0]?.id || "bank"; const defCat = cats[0]?.id || "food"; const defSrc = isrc[0]?.id || "allowance"; csvPreview.forEach(row => { const amount = roundMoney(Number(row.amount) || 0); const isBackdated = row.date < today; const balanceDelta = batch.deltaFor(defWallet, row.date, isBackdated); const ok = row.type === "income" ? addI({ id: uid(), amount, sourceId: defSrc, walletId: defWallet, date: row.date, note: (row.note || "").slice(0, 500) }, { balanceDelta }) : addE({ id: uid(), amount, categoryId: row.categoryId || defCat, walletId: defWallet, date: row.date, note: (row.note || "").slice(0, 500) }, { balanceDelta }); if (ok !== false) { imported++; batch.record(defWallet, row.date, row.type === "income" ? amount : -amount); } }); sCsvPreview(null); showT(`Imported ${imported} transactions — recategorize as needed`, "success"); };
  const impLedger = async (file) => {
    if (ledgerLoading) return;
    sLedgerLoading(true); sLedgerPreview(null);
    try {
      // Compress to 800px JPEG (same as scanReceipt) so phone photos don't
      // blow the 2.8 MB backend limit. PDFs sent through unchanged — only
      // images need compression.
      const isPdf = file?.type === "application/pdf";
      let imageBase64, mimeType;
      if (isPdf) {
        const dataUrl = await new Promise((resolve, reject) => { const r = new FileReader(); r.onerror = reject; r.onload = () => resolve(r.result); r.readAsDataURL(file); });
        const [, b64] = String(dataUrl).split(",");
        imageBase64 = b64;
        mimeType = "application/pdf";
      } else {
        const url = URL.createObjectURL(file);
        try {
          const compressed = await new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
              if (!img.width || !img.height) { reject(new Error("Image has zero dimensions.")); return; }
              const scale = Math.min(1, 800 / Math.max(img.width, img.height));
              const w = Math.round(img.width * scale);
              const h = Math.round(img.height * scale);
              const canvas = document.createElement("canvas");
              canvas.width = w; canvas.height = h;
              canvas.getContext("2d").drawImage(img, 0, 0, w, h);
              resolve(canvas.toDataURL("image/jpeg", 0.7));
            };
            img.onerror = () => reject(new Error("Image load failed."));
            img.src = url;
          });
          imageBase64 = compressed.replace(/^data:image\/jpeg;base64,/, "");
          mimeType = "image/jpeg";
        } finally { URL.revokeObjectURL(url); }
      }
      const r = await fetch("/api/food-vision", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "ledger", imageBase64, mimeType }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Ledger OCR failed");
      if (!Array.isArray(d.entries) || d.entries.length === 0) { showT("No entries detected in photo", "info"); return; }
      sLedgerPreview(d.entries);
      showT(`Found ${d.entries.length} entries — review and confirm`, "info");
    } catch (e) {
      showT(e.message || "Failed to read photo", "error");
    } finally {
      sLedgerLoading(false);
    }
  };
  const confirmLedgerImport = () => {
    if (!ledgerPreview?.length) return;
    let imported = 0;
    const batch = makeBatchTracker(), today = localDateKey();
    ledgerPreview.forEach(en => {
      const amount = roundMoney(Number(en.amount) || 0);
      if (amount <= 0 || !en.date) return;
      const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(en.date) ? en.date : localDateKey();
      const noteStr = (en.note || "").slice(0, 500);
      const wid = wallets[0]?.id || "bank";
      const balanceDelta = batch.deltaFor(wid, dateOk, dateOk < today);
      const ok = en.type === "income"
        ? addI({ id: uid(), amount, sourceId: isrc[0]?.id || "allowance", walletId: wid, date: dateOk, note: noteStr }, { balanceDelta })
        : addE({ id: uid(), amount, categoryId: cats[0]?.id || "food", walletId: wid, date: dateOk, note: noteStr }, { balanceDelta });
      if (ok !== false) { imported++; batch.record(wid, dateOk, en.type === "income" ? amount : -amount); }
    });
    sLedgerPreview(null);
    showT(`Imported ${imported} of ${ledgerPreview.length} entries — recategorize as needed`, "success");
  };
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

  if (showSetup) return <CredentialSetup onDone={() => window.location.reload()} onCancel={() => setShowSetup(false)} />;
  if (!loaded) return null;
  const theme = dm ? { "--bg": "#000000", "--card": "#0F0F0F", "--border": "#1F1F1F", "--text": "#E5E7EB", "--ts": "#9CA3AF", "--muted": "#6B7280", "--nav-bg": "rgba(0,0,0,0.95)", "--neu-bg": "#161616", "--neu-lt": "#242424", "--neu-dk": "#000000" } : { "--bg": "#F2F0EB", "--card": "#FFF", "--border": "rgba(0,0,0,0.06)", "--text": "#1A1A2E", "--ts": "#4A4A5A", "--muted": "#8A8A9A", "--nav-bg": "rgba(242,240,235,0.92)", "--neu-bg": "#F2F0EB", "--neu-lt": "#FFFFFF", "--neu-dk": "#D4CFC6" };

  return <div className="nmClip" style={{ ...theme, fontFamily: "var(--font-b)", background: "var(--bg)", color: "var(--text)", minHeight: "100vh", width: "100%", maxWidth: 430, margin: "0 auto", padding: "0 0 110px", boxSizing: "border-box" }}><style>{`
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Nunito:wght@400;500;600;700;800&family=Playfair+Display:wght@400;500&display=swap');
:root{--font-h:'Plus Jakarta Sans',sans-serif;--font-b:'Nunito',sans-serif}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{overflow-x:hidden;overflow-x:clip;max-width:100%}
.nmClip{overflow-x:hidden;overflow-x:clip}
body{background:${dm ? "#000000" : "#F2F0EB"}}
input[type=date]{color-scheme:${dm ? "dark" : "light"}}input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none}input[type=number]{-moz-appearance:textfield}
::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
button{transition:transform 0.1s ease,opacity 0.15s ease}button:active{transform:scale(0.96)}
@keyframes fi{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
@keyframes fis{from{opacity:0;transform:scale(0.95)}to{opacity:1;transform:scale(1)}}
@keyframes ld{from{transform:translateY(-6px) rotate(-5deg)}to{transform:translateY(-4px) rotate(5deg)}}
@keyframes ti{from{opacity:0;transform:translateY(-16px)}to{opacity:1;transform:translateY(0)}}
@keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.6}}
@keyframes nmSpin{to{transform:rotate(360deg)}}
@keyframes ripple{0%{transform:translate(-50%,-50%) scale(0.25);opacity:0.5}65%{opacity:0.18}100%{transform:translate(-50%,-50%) scale(2.8);opacity:0}}
@keyframes navsplash{0%{transform:translate(-50%,-50%) scale(0);opacity:0.55}100%{transform:translate(-50%,-50%) scale(2.6);opacity:0}}
.nm-hscroll::-webkit-scrollbar{height:0}.nm-hscroll{scrollbar-width:none}
@keyframes daySelGlow{0%{box-shadow:0 0 0 1px rgba(224,122,95,0.0)}30%{box-shadow:0 0 16px 3px rgba(224,122,95,0.42),0 0 0 2px rgba(224,122,95,0.85)}100%{box-shadow:0 0 6px 0 rgba(224,122,95,0.12),0 0 0 1.5px rgba(224,122,95,0.4)}}
.day-selected{border-radius:14px;background:linear-gradient(90deg,rgba(224,122,95,0.10),rgba(107,170,117,0.06));box-shadow:0 0 6px 0 rgba(224,122,95,0.12),0 0 0 1.5px rgba(224,122,95,0.4);animation:daySelGlow 1.15s cubic-bezier(0.34,1.56,0.64,1)}
.pe{animation:fi 0.3s ease-out}.pse{animation:fis 0.25s ease-out}
.card-hover{transition:box-shadow 0.2s ease,transform 0.2s ease}
.card-hover:hover{box-shadow:0 4px 24px rgba(0,0,0,0.08);transform:translateY(-1px)}
`}</style>

    {(!online || pendingSync > 0) && <div style={{ position: "sticky", top: 0, zIndex: 120, margin: "0 12px 10px", padding: "8px 12px", borderRadius: 14, background: online ? "#FFF3D6" : "#FDE7E4", border: `1px solid ${online ? "#F1C96B" : "#E7A39B"}`, color: online ? "#7A5600" : "#9F3E33", fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 600, letterSpacing: "0.01em", textAlign: "center" }}>{!online ? "Offline. Changes sync later." : `Saving ${getPendingSyncSummary().label || (pendingSync + " change" + (pendingSync === 1 ? "" : "s"))}…`}</div>}
    {localMode && localBanner && <div style={{ position: "sticky", top: 0, zIndex: 120, margin: "0 12px 10px", padding: "8px 12px", borderRadius: 14, background: "#FFF3D6", border: "1px solid #F1C96B", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}><span style={{ fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 600, color: "#7A5600" }}>📦 Local-only mode. Add credentials for cloud sync + AI.</span><div style={{ display: "flex", gap: 6, flexShrink: 0 }}><button onClick={() => setShowSetup(true)} style={{ fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 700, background: "#7C4A2A", border: "none", color: "#fff", borderRadius: 6, padding: "3px 8px", cursor: "pointer" }}>Setup</button><button onClick={() => sLocalBanner(false)} style={{ fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 600, background: "none", border: "none", color: "#7A5600", cursor: "pointer", opacity: 0.6 }}>✕</button></div></div>}
    {staleData && <div style={{ position: "sticky", top: 0, zIndex: 120, margin: "0 12px 10px", padding: "8px 12px", borderRadius: 14, background: "#EDE9FE", border: "1px solid #A78BFA50", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}><span style={{ fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 600, color: "#4C1D95" }}>Another tab updated data.</span><div style={{ display: "flex", gap: 6, flexShrink: 0 }}><button onClick={() => window.location.reload()} style={{ fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 700, background: "#7C3AED", border: "none", color: "#fff", borderRadius: 6, padding: "3px 8px", cursor: "pointer" }}>Reload</button><button onClick={() => sStaleData(false)} style={{ fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 600, background: "none", border: "none", color: "#4C1D95", cursor: "pointer", opacity: 0.6 }}>✕</button></div></div>}
    {swUpdate && <div style={{ position: "sticky", top: 0, zIndex: 121, margin: "0 12px 10px", padding: "8px 12px", borderRadius: 14, background: "#ECFDF5", border: "1px solid #6BAA7550", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}><span style={{ fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 600, color: "#065F46", display: "flex", alignItems: "center", gap: 6 }}><Confetti size={16} weight="fill" />App updated — reload to see changes.</span><div style={{ display: "flex", gap: 6, flexShrink: 0 }}><button onClick={() => { try { sessionStorage.setItem("nomad-sw-accept", "1"); } catch { /* storage blocked — fallback reload below still works */ } navigator.serviceWorker.getRegistration().then(reg => { if (reg?.waiting) reg.waiting.postMessage("SKIP_WAITING"); else window.location.reload(); }).catch(() => window.location.reload()); }} style={{ fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 700, background: "#6BAA75", border: "none", color: "#fff", borderRadius: 6, padding: "3px 8px", cursor: "pointer" }}>Reload</button><button onClick={() => sSwUpdate(false)} style={{ fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 600, background: "none", border: "none", color: "#065F46", cursor: "pointer", opacity: 0.6 }}>✕</button></div></div>}


    {(() => {
      if (module === "finance" && tab !== "dashboard") return null;
      return <div style={{ position: "sticky", top: 0, zIndex: 100, background: dm ? "rgba(0,0,0,0.97)" : "rgba(242,240,235,0.97)", borderBottom: `1px solid ${dm ? "#1F1F1F" : "rgba(0,0,0,0.06)"}`, padding: "12px 20px 10px", transition: "padding 0.2s" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{ fontFamily: "'Plus Jakarta Sans',sans-serif", fontSize: 20, fontWeight: 700, color: dm ? "#E5E7EB" : "#1A1A2E", letterSpacing: "0.04em", lineHeight: 1 }}>NOMAD</div>
          <span style={{ fontFamily: "var(--font-h)", fontSize: 11, color: dm ? "#6B7280" : "var(--muted)", fontWeight: 600, letterSpacing: "1.5px" }}>{new Date().toLocaleDateString("en-US", { weekday: "short" }).toUpperCase()} · {new Date().getDate()} {new Date().toLocaleDateString("en-US", { month: "short" }).toUpperCase()}</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => { hapticSelection(); setModule("finance") }} style={{ flex: 1, padding: "7px 0", borderRadius: 100, fontSize: 12, fontFamily: "var(--font-h)", fontWeight: 600, border: `1.5px solid ${module === "finance" ? "#E07A5F" : dm ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.1)"}`, cursor: "pointer", background: module === "finance" ? "#E07A5F" : "transparent", color: module === "finance" ? "#fff" : dm ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.35)", letterSpacing: "0.5px", transition: "all 0.2s" }}>Finance</button>
          <button onClick={() => { hapticSelection(); setModule("routine"); }} style={{ flex: 1, padding: "7px 0", borderRadius: 100, fontSize: 12, fontFamily: "var(--font-h)", fontWeight: 600, border: `1.5px solid ${module === "routine" ? "#EF9F27" : dm ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.1)"}`, cursor: "pointer", background: module === "routine" ? "#EF9F27" : "transparent", color: module === "routine" ? "#fff" : dm ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.35)", letterSpacing: "0.5px", transition: "all 0.2s" }}>Routine</button>
        </div>
      </div>
    })()}

    {module === "routine" && <RoutineApp darkMode={dm} />}
    {module === "finance" && <div style={{ padding: "0 16px" }}>

      {(tab === "dashboard" || tab === "history") && <div style={{ display: "flex", gap: 6, overflowX: "auto", padding: "12px 0 16px", scrollbarWidth: "none" }}><button onClick={() => { sFm("all"); sHCalDay(null); }} style={{ padding: "7px 16px", borderRadius: 20, fontSize: 12, fontFamily: "var(--font-h)", border: `1.5px solid ${fm === "all" ? "#E07A5F" : "var(--border)"}`, background: fm === "all" ? "#E07A5F" : "var(--card)", color: fm === "all" ? "#fff" : "var(--muted)", cursor: "pointer", whiteSpace: "nowrap", fontWeight: 500 }}>All</button>{allM.map(m => <button key={m} onClick={() => { sFm(m); sHCalDay(null); }} style={{ padding: "7px 16px", borderRadius: 20, fontSize: 12, fontFamily: "var(--font-h)", border: `1.5px solid ${fm === m ? "#6BAA75" : "var(--border)"}`, background: fm === m ? "#6BAA75" : "var(--card)", color: fm === m ? "#fff" : "var(--muted)", cursor: "pointer", whiteSpace: "nowrap", fontWeight: 500 }}>{ml(m)}</button>)}</div>}

      {tab === "dashboard" && <div className="pe">
        {(() => {
          const tod = new Date(), todS = localDateKey(tod), snoozed = (() => { try { return JSON.parse(localStorage.getItem("nomad-rec-snooze") || "{}"); } catch { return {}; } })(), due = rec.filter(r => isRecurringDueToday(r, todS) && !(snoozed[r.id] && snoozed[r.id] > todS));
          // Pay a due bill from the chosen wallet (the per-cycle override). The
          // bill's saved walletId is untouched, so next month it pre-selects the
          // same default again. addE returns false on a cap/validation block —
          // keep the picker open so the user can pick another wallet.
          const payDue = (r, walletId) => { const ok = addE({ amount: r.amount, categoryId: r.categoryId, walletId, date: todS, note: r.name + " (recurring)", recurring: true }); if (ok === false) return; const updated = { ...r, lastPaidDate: todS, lastSkippedDate: null }; sRec(p => p.map(x => x.id === r.id ? updated : x)); sbUpsert("recurring", [toSB(updated, COLS.recurring)], null, getVersion("recurring", r.id) ? { "If-Unmodified-Since": getVersion("recurring", r.id) } : {}); showT(`${r.name} paid from ${wallets.find(w => w.id === walletId)?.name || "wallet"} — ${fmt(r.amount)}`, "success"); sPayRec(null); sPayRecWal(null); };
          return due.length > 0 && <div style={{ marginBottom: 14 }}>{due.map(r => { const cat = resolveRecCategory(r.categoryId, [RC, recCats], r.categoryName); const wal = wallets.find(w => w.id === r.walletId) || { name: r.walletId }; const picking = payRec === r.id; const selWal = payRecWal || r.walletId; return <div key={r.id} style={{ ...cc, borderLeft: "3px solid #E07A5F", borderRadius: 14, padding: "14px 16px", marginBottom: 8 }}><div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}><Warning size={16} color="#E07A5F" weight="fill" /><div style={{ flex: 1 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{(() => { const od = recurringDaysOverdue(r, todS); return <>{r.name} {od > 0 ? "overdue" : "due today"} — {fmt(r.amount)}{od > 0 ? <span style={{ marginLeft: 6, padding: "2px 6px", borderRadius: 4, background: "#D4726A", color: "#fff", fontSize: 10, fontWeight: 600 }}>{od}d overdue</span> : null}</>; })()}</div><div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{wal.name} → {cat.name}</div></div></div>{picking ? <div><div style={{ fontSize: 10, fontFamily: "var(--font-h)", color: "var(--muted)", fontWeight: 700, letterSpacing: "0.5px", marginBottom: 6 }}>PAID FROM</div><div style={{ display: "flex", gap: 6, marginBottom: 8 }}>{wallets.map(w => { const on = selWal === w.id; return <button key={w.id} onClick={() => sPayRecWal(w.id)} style={{ flex: 1, padding: "8px 4px", borderRadius: 9, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, border: `2px solid ${on ? w.color : "var(--border)"}`, background: on ? w.color + "15" : "var(--card)", cursor: "pointer" }}><DI2 id={w.id} accent={w.neon || w.color} size={15} /><span style={{ fontSize: 9, fontFamily: "var(--font-h)", fontWeight: on ? 700 : 500, color: on ? w.color : "var(--muted)" }}>{w.name}</span></button>; })}</div>{isUpiLite(wallets.find(w => w.id === selWal) || {}) && <div style={{ fontSize: 10, color: "#00B4D8", fontFamily: "var(--font-h)", fontWeight: 600, marginBottom: 8 }}>UPI Lite · ₹5000 cap — blocked if short, just pick another.</div>}<div style={{ display: "flex", gap: 6 }}><button onClick={(ev) => { if (ev.currentTarget.disabled) return; ev.currentTarget.disabled = true; payDue(r, selWal); ev.currentTarget.disabled = false; }} style={{ flex: 2, padding: "8px", border: "none", borderRadius: 8, background: "#6BAA75", color: "#fff", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>✓ Confirm paid</button><button onClick={() => { sPayRec(null); sPayRecWal(null); }} style={{ flex: 1, padding: "8px", border: "1.5px solid var(--border)", borderRadius: 8, background: "var(--card)", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Cancel</button></div></div> : <div style={{ display: "flex", gap: 6 }}><button onClick={() => { sPayRec(r.id); sPayRecWal(r.walletId); }} style={{ flex: 1, padding: "8px", border: "none", borderRadius: 8, background: "#6BAA75", color: "#fff", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>✓ Paid</button><button onClick={(ev) => { if (ev.currentTarget.disabled) return; ev.currentTarget.disabled = true; const updated = { ...r, lastSkippedDate: todS }; sRec(p => p.map(x => x.id === r.id ? updated : x)); sbUpsert("recurring", [toSB(updated, COLS.recurring)], null, getVersion("recurring", r.id) ? { "If-Unmodified-Since": getVersion("recurring", r.id) } : {}); showT("Skipped for this cycle", "info") }} style={{ flex: 1, padding: "8px", border: "1.5px solid var(--border)", borderRadius: 8, background: "var(--card)", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Skip</button><button onClick={() => { const snoozeUntil = localDateKey(new Date(Date.now() + 864e5)); const snoozed = JSON.parse(localStorage.getItem("nomad-rec-snooze") || "{}"); snoozed[r.id] = snoozeUntil; localStorage.setItem("nomad-rec-snooze", JSON.stringify(snoozed)); sRec(p => [...p]); showT("Snoozed until tomorrow", "info") }} style={{ flex: 1, padding: "8px", border: "1.5px solid var(--border)", borderRadius: 8, background: "var(--card)", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Snooze</button></div>}</div> })}</div>
        })()}
        {loaded && ex.length === 0 && inc.length === 0 && <div style={{ ...cc, padding: "18px 20px", marginBottom: 14, borderLeft: "3px solid #7B8CDE" }}><div style={{ fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}><HandWaving size={16} weight="fill" />Welcome to NOMAD</div><div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.6, marginBottom: 12 }}>Track expenses, income, and recurring bills.<br />Tap <strong>Add</strong> below to log your first transaction.</div><div style={{ display: "flex", gap: 8 }}><button onClick={() => sTab("add")} style={{ flex: 1, padding: "9px", border: "none", borderRadius: 9, background: "#E07A5F", color: "#fff", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>+ Add Expense</button><button onClick={() => sTab("settings")} style={{ padding: "9px 14px", border: "1.5px solid var(--border)", borderRadius: 9, background: "var(--card)", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Settings</button></div></div>}
        {(() => { const saved = roundMoney(tI - tE); const savedPct = tI > 0 ? Math.round((saved / tI) * 100) : null; return <div style={{ ...cc, padding: "26px 22px 20px", marginBottom: 16, textAlign: "center" }}><div style={{ fontFamily: "var(--font-h)", fontSize: 11, color: "var(--muted)", letterSpacing: "1.5px", textTransform: "uppercase", fontWeight: 500 }}>Total Balance</div><div style={{ fontSize: 36, fontWeight: 700, fontFamily: "var(--font-h)", color: mBal >= 0 ? "#6BAA75" : "#E07A5F", marginTop: 6, lineHeight: 1.2 }}>{fmt(mBal)}</div><div style={{ borderTop: "1px dashed var(--border)", marginTop: 18, paddingTop: 16 }}><div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 }}><div><div style={{ fontFamily: "var(--font-h)", fontSize: 9, color: "var(--muted)", letterSpacing: "0.5px", fontWeight: 600 }}>IN</div><div style={{ fontFamily: "var(--font-h)", fontSize: 13, color: "#6BAA75", marginTop: 3, fontWeight: 700, whiteSpace: "nowrap" }}>{fmt(tI)}</div></div><div style={{ borderLeft: "1px solid var(--border)", borderRight: "1px solid var(--border)", padding: "0 4px" }}><div style={{ fontFamily: "var(--font-h)", fontSize: 9, color: "var(--muted)", letterSpacing: "0.5px", fontWeight: 600 }}>OUT</div><div style={{ fontFamily: "var(--font-h)", fontSize: 13, color: "#E07A5F", marginTop: 3, fontWeight: 700, whiteSpace: "nowrap" }}>{fmt(tE)}</div></div><div><div style={{ fontFamily: "var(--font-h)", fontSize: 9, color: "var(--muted)", letterSpacing: "0.5px", fontWeight: 600 }}>{saved >= 0 ? "SAVED" : "OVERSPEND"}</div><div style={{ fontFamily: "var(--font-h)", fontSize: 13, color: saved >= 0 ? "#7B8CDE" : "#D4726A", marginTop: 3, fontWeight: 700, whiteSpace: "nowrap" }}>{fmt(Math.abs(saved))}</div>{savedPct !== null && saved >= 0 && <div style={{ fontSize: 9, color: "var(--muted)", fontFamily: "var(--font-h)", marginTop: 1, fontWeight: 600 }}>{savedPct}% of in</div>}</div></div></div></div>; })()}

        <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(wallets.length, 3)}, minmax(0, 1fr))`, gap: 8, marginBottom: 14 }}>{wallets.map(w => { const b = roundMoney(wBal[w.id] || 0); return <div key={w.id} onClick={() => { hapticLight(); sCalW(w); }} className="card-hover" style={{ ...cc, minWidth: 0, padding: "12px 10px", cursor: "pointer", borderLeft: `3px solid ${w.color}`, borderRadius: 14 }}><div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 8 }}><DI2 id={w.id} accent={w.neon || w.color} size={14} /><span style={{ fontSize: 9.5, fontFamily: "var(--font-h)", fontWeight: 600, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flex: 1 }}>{w.name}</span>{w.id === "cash" && <button onClick={e => { e.stopPropagation(); sRecountW(w); }} title="Count cash" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", fontSize: 12, padding: "1px 3px", lineHeight: 1, opacity: 0.5, flexShrink: 0 }}>⟳</button>}</div><div style={{ fontSize: 16, fontWeight: 700, fontFamily: "var(--font-h)", color: b >= 0 ? w.color : "#E07A5F" }}>{fmt(b)}</div>{(() => { const v = walletVerify[w.id] || { state: "new" }; const cfg = { ok: { c: "#6BAA75", icon: <IconCheck size={9} stroke={3} />, t: "Verified" }, stale: { c: "#FBBF24", icon: <IconClock size={9} />, t: "Check" }, drift: { c: "#D4726A", icon: <Warning size={9} weight="fill" />, t: "Drift" }, new: { c: "var(--muted)", icon: <Scales size={9} />, t: "Verify" } }[v.state]; return <div title={v.state === "drift" ? `Last check was off by ${fmt(Math.abs(v.last.gap))} — tap to reconcile & find the missing entry` : v.state === "stale" ? `${v.newTx ? v.newTx + " new txn" + (v.newTx === 1 ? "" : "s") : v.days + "d"} ${v.last ? "since last verified" : "logged — never verified"} — tap to reconcile` : v.state === "ok" ? `Verified ${v.last.date}` : "Never verified — tap to set your real balance"} style={{ marginTop: 5, display: "inline-flex", alignItems: "center", gap: 3, fontSize: 8, fontFamily: "var(--font-h)", fontWeight: 700, color: cfg.c, background: v.state === "new" ? "var(--bg)" : cfg.c + "1A", borderRadius: 5, padding: "2px 5px", lineHeight: 1, maxWidth: "100%" }}>{cfg.icon}<span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{cfg.t}</span></div>; })()}</div> })}</div>

        <LionM balance={mBal} dancing={ld} aiMsg={lionMsg} aiLoading={lionMsgLoading} onTap={() => sChatOpen(true)} />
        {(() => { const sl = scoreLabel(finScore.score); return <div style={{ ...cc, padding: "10px 16px", marginBottom: 12 }}><div onClick={() => sScoreOpen(o => !o)} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}><div style={{ width: 44, height: 44, borderRadius: "50%", border: `2.5px solid ${sl.color}`, background: sl.color + "18", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><span style={{ fontFamily: "var(--font-h)", fontSize: 15, fontWeight: 800, color: sl.color }}>{finScore.score}</span></div><div style={{ flex: 1 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 700, color: "var(--text)" }}>Health Score — {sl.label}</div><div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>Savings · Bills · Spread · Logging</div></div>{finStreak > 1 && <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", borderRadius: 8, background: "#FBBF2415", border: "1px solid #FBBF24" }}><Fire size={14} weight="fill" color="#FBBF24" /><span style={{ fontFamily: "var(--font-h)", fontSize: 11, fontWeight: 700, color: "#FBBF24" }}>{finStreak}d</span></div>}<span style={{ fontSize: 10, color: "var(--muted)", transition: "transform 0.2s", display: "inline-block", transform: scoreOpen ? "rotate(0deg)" : "rotate(-90deg)" }}>▾</span></div>{scoreOpen && <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>{[{ label: "Savings", score: finScore.breakdown.savings, max: 35, hint: "income vs spending" }, { label: "Bills", score: finScore.breakdown.bills, max: 25, hint: "recurring bills" }, { label: "Spread", score: finScore.breakdown.spread, max: 20, hint: "category diversity" }, { label: "Logging", score: finScore.breakdown.logging, max: 20, hint: "days tracked" }].map(({ label, score: sc, max, hint }) => { const pct = Math.round(sc / max * 100); const bc = pct >= 80 ? "#6BAA75" : pct >= 50 ? "#FBBF24" : "#E07A5F"; return <div key={label}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}><span style={{ fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 600, color: "var(--text)" }}>{label}</span><span style={{ fontSize: 10, color: "var(--muted)" }}>{sc}/{max} · {hint}</span></div><div style={{ height: 4, borderRadius: 2, background: "var(--border)" }}><div style={{ height: "100%", width: `${pct}%`, background: bc, borderRadius: 2 }} /></div></div>; })}</div>}</div>; })()}
        {stalePersonal.length > 0 && (() => { const owed = stalePersonal.filter(s => s.direction === "owed"); const owe = stalePersonal.filter(s => s.direction === "owe"); const owedTot = owed.reduce((t, s) => t + (s.amount - (stl||[]).filter(x => x.splitId === s.id).reduce((u, x) => u + x.amount, 0)), 0); const oweTot = owe.reduce((t, s) => t + (s.amount - (stl||[]).filter(x => x.splitId === s.id).reduce((u, x) => u + x.amount, 0)), 0); return <div onClick={() => { sTab("add"); sAddSeg("iou"); }} style={{ ...cc, padding: "12px 14px", marginBottom: 12, border: "1.5px solid #F4A261", background: "#F4A26115", cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}><IconClock size={20} color="#D4726A" style={{ flexShrink: 0 }} /><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 700, color: "#D4726A" }}>{stalePersonal.length} IOU{stalePersonal.length === 1 ? "" : "s"} pending 2+ days</div><div style={{ fontSize: 11, color: "var(--ts)", fontFamily: "var(--font-b)", marginTop: 2 }}>{owed.length > 0 && <span style={{ color: "#6BAA75" }}>Owed {fmt(owedTot)}</span>}{owed.length > 0 && owe.length > 0 && " · "}{owe.length > 0 && <span style={{ color: "#E07A5F" }}>You owe {fmt(oweTot)}</span>}</div></div><IconChevronRight size={18} color="var(--muted)" /></div>; })()}
        {/* IOU summary card — MUST mirror IOUWallet's personMap scope (personal IOUs + IOUs of explicitly ACTIVE events; completed / deleted / legacy-status events excluded) so this net and the wallet's Net tile always agree. */}
        {(() => { const activeEv = new Set(evs.filter(e => e.status === "active").map(e => e.id)); const paid = {}; (stl || []).forEach(x => { if (x.splitId != null) paid[x.splitId] = (paid[x.splitId] || 0) + x.amount; }); const remOf = s => roundMoney(s.amount - (paid[s.id] || 0)); const nameNet = {}; sp.filter(s => !s.deleted_at && !s.settled && !s.skipped && (!s.eventId || activeEv.has(s.eventId))).forEach(s => { const n = (s.name || "").trim().toLowerCase(); if (!n) return; nameNet[n] = (nameNet[n] || 0) + (s.direction === "owed" ? remOf(s) : -remOf(s)); }); const nets = Object.values(nameNet); const owedT = nets.filter(v => v > 0.5).reduce((t, v) => t + v, 0); const oweT = nets.filter(v => v < -0.5).reduce((t, v) => t - v, 0); const netT = roundMoney(owedT - oweT); const ppl = nets.filter(v => Math.abs(v) > 0.5).length; const near0 = Math.abs(netT) < 0.5; return <div onClick={() => { sTab("add"); sAddSeg("iou"); }} className="card-hover" style={{ ...cc, padding: "16px 18px", marginBottom: 14, cursor: "pointer", position: "relative", overflow: "hidden" }}><div style={{ position: "absolute", bottom: 0, right: 0, width: 60, height: 3, borderRadius: "3px 0 0 0", background: "#D4726A" }} /><div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: ppl ? 12 : 0 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "#D4726A", letterSpacing: "0.5px", fontWeight: 700 }}>IOUs · 1:1 Splits</div><div style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-h)" }}>{ppl ? `${ppl} ${ppl === 1 ? "person" : "people"} · manage` : "All settled · add"}</span><IconChevronRight size={16} color="var(--muted)" /></div></div>{ppl > 0 && <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12 }}><div><div style={{ fontSize: 9, color: "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 600, letterSpacing: "0.5px" }}>NET</div><div style={{ fontFamily: "var(--font-h)", fontSize: 24, fontWeight: 800, color: near0 ? "var(--muted)" : netT >= 0 ? "#6BAA75" : "#E07A5F", lineHeight: 1.1 }}>{near0 ? "₹0" : (netT >= 0 ? "+" : "−") + fmt(Math.abs(netT)).slice(1)}</div></div><div style={{ display: "flex", gap: 14 }}><div style={{ textAlign: "right" }}><div style={{ fontSize: 9, color: "#6BAA75", fontFamily: "var(--font-h)", fontWeight: 600, letterSpacing: "0.5px" }}>OWED ↑</div><div style={{ fontFamily: "var(--font-h)", fontSize: 15, fontWeight: 700, color: "#6BAA75", marginTop: 2 }}>{fmt(owedT)}</div></div><div style={{ textAlign: "right" }}><div style={{ fontSize: 9, color: "#E07A5F", fontFamily: "var(--font-h)", fontWeight: 600, letterSpacing: "0.5px" }}>YOU OWE ↓</div><div style={{ fontFamily: "var(--font-h)", fontSize: 15, fontWeight: 700, color: "#E07A5F", marginTop: 2 }}>{fmt(oweT)}</div></div></div></div>}</div>; })()}
        {(writeOffs.lost > 0 || writeOffs.forgiven > 0) && <div style={{ ...cc, padding: "14px 16px", marginBottom: 14, position: "relative", overflow: "hidden" }}><div style={{ position: "absolute", bottom: 0, right: 0, width: 60, height: 3, borderRadius: "3px 0 0 0", background: "#F4A261" }} /><div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}><IconPlayerSkipForward size={14} color="#F4A261" /><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "#F4A261", fontWeight: 700, letterSpacing: "0.5px" }}>Write-offs</div></div><div style={{ display: "flex", gap: 10 }}><div style={{ flex: 1, textAlign: "center", padding: "10px 8px", background: "#E07A5F10", borderRadius: 12, border: "1px solid #E07A5F20" }}><div style={{ fontSize: 9, color: "#E07A5F", fontFamily: "var(--font-h)", fontWeight: 600, letterSpacing: "0.5px", marginBottom: 3 }}>WRITTEN OFF</div><div style={{ fontSize: 16, fontWeight: 700, fontFamily: "var(--font-h)", color: "#E07A5F" }}>{fmt(writeOffs.lost)}</div><div style={{ fontSize: 9, color: "var(--muted)", fontFamily: "var(--font-b)", marginTop: 2 }}>owed to you, given up</div></div><div style={{ flex: 1, textAlign: "center", padding: "10px 8px", background: "#6BAA7510", borderRadius: 12, border: "1px solid #6BAA7520" }}><div style={{ fontSize: 9, color: "#6BAA75", fontFamily: "var(--font-h)", fontWeight: 600, letterSpacing: "0.5px", marginBottom: 3 }}>FORGIVEN</div><div style={{ fontSize: 16, fontWeight: 700, fontFamily: "var(--font-h)", color: "#6BAA75" }}>{fmt(writeOffs.forgiven)}</div><div style={{ fontSize: 9, color: "var(--muted)", fontFamily: "var(--font-b)", marginTop: 2 }}>your debt waived</div></div></div><div style={{ fontSize: 10.5, color: "var(--muted)", fontFamily: "var(--font-b)", marginTop: 8, textAlign: "center" }}>Net {writeOffs.net >= 0 ? "gain" : "loss"} {fmt(Math.abs(writeOffs.net))} · non-cash, excluded from wallet balances</div></div>}
        {(() => { const accent = "#A78BFA"; const NARR_DAYS = narPeriod === "week" ? 7 : narPeriod === "quarter" ? 90 : 30; const genNarrative = async () => { sAiNarrLoading(true); try { const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - NARR_DAYS); const c = localDateKey(cutoff); const nEx = ex.filter(e => String(e.date || "") >= c); const nInc = inc.filter(i => String(i.date || "") >= c); if (nEx.length === 0 && nInc.length === 0) { showT(`No transactions in the last ${NARR_DAYS} days`, "info"); sAiNarrLoading(false); return; } const body = { mode: "narrative", period: `last ${NARR_DAYS} days`, expenses: redactTransactions(nEx), incomes: redactTransactions(nInc) }; const r = await fetch("/api/ai-analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const data = await r.json(); if (!r.ok) throw new Error(data.error || "AI narrative failed"); const result = { headline: data.headline, body: data.body, highlights: data.highlights || [], period: narPeriod, ts: Date.now() }; sAiNarr(result); try { localStorage.setItem("nomad-ai-narrative", JSON.stringify(result)); } catch { /* quota */ } } catch (e) { showT(e.message || "AI narrative unavailable", "error"); } finally { sAiNarrLoading(false); } }; return <div style={{ ...cc, padding: "12px 14px", marginBottom: 14, borderLeft: `3px solid ${accent}` }}><div onClick={() => sAiOpen(o => !o)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: aiOpen ? 10 : 0, cursor: "pointer" }}><div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}><Sparkle size={14} weight="fill" color={accent} /><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: accent, fontWeight: 700, letterSpacing: "0.5px" }}>AI Narrative</div>{aiNarr && <span style={{ fontSize: 9, color: "var(--muted)", fontFamily: "var(--font-h)", whiteSpace: "nowrap" }}>{aiNarr.period || ""} · {Math.round((Date.now() - aiNarr.ts) / 60000)}m</span>}</div><span style={{ fontSize: 10, color: "var(--muted)", transition: "transform 0.2s", display: "inline-block", transform: aiOpen ? "rotate(0deg)" : "rotate(-90deg)" }}>▾</span></div>{aiOpen && <><div style={{ display: "flex", gap: 4, marginBottom: 8 }}>{["week", "month", "quarter"].map(p => <button key={p} onClick={() => sNarPeriod(p)} style={{ flex: 1, padding: "6px 10px", borderRadius: 8, border: `1.5px solid ${narPeriod === p ? accent : "var(--border)"}`, background: narPeriod === p ? accent + "18" : "var(--card)", color: narPeriod === p ? accent : "var(--muted)", fontFamily: "var(--font-h)", fontSize: 11, fontWeight: 600, cursor: "pointer", textTransform: "capitalize" }}>{p}</button>)}</div><button onClick={genNarrative} disabled={aiNarrLoading} style={{ width: "100%", padding: "9px", borderRadius: 9, border: `1.5px solid ${accent}`, background: aiNarrLoading ? "var(--border)" : accent + "15", color: accent, fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 700, cursor: aiNarrLoading ? "default" : "pointer", marginBottom: aiNarr ? 10 : 0 }}>{aiNarrLoading ? "Writing…" : aiNarr ? `Regenerate ${narPeriod} narrative` : `Generate ${narPeriod} narrative`}</button>{aiNarr && <div style={{ padding: "9px 11px", background: "var(--bg)", borderRadius: 8, borderLeft: `2px solid ${accent}` }}>{aiNarr.headline && <div style={{ fontFamily: "var(--font-h)", fontSize: 12.5, fontWeight: 800, color: "var(--text)", marginBottom: 6 }}>{aiNarr.headline}</div>}{aiNarr.body && <div style={{ fontSize: 11.5, color: "var(--ts)", lineHeight: 1.55, marginBottom: (aiNarr.highlights || []).length ? 8 : 0, whiteSpace: "pre-line" }}>{aiNarr.body}</div>}{(aiNarr.highlights || []).length > 0 && <ul style={{ paddingLeft: 16, margin: 0 }}>{aiNarr.highlights.map((h, i) => <li key={i} style={{ fontSize: 11, color: "var(--ts)", marginBottom: 3, lineHeight: 1.4 }}>{h}</li>)}</ul>}</div>}</>}</div>; })()}
        {(() => { const cm = localDateKey().slice(0, 7), mE = exAll.filter(e => mk(e.date) === cm), fixT = mE.filter(isFix).reduce((s, e) => s + e.amount, 0), flxT = mE.filter(e => !isFix(e)).reduce((s, e) => s + e.amount, 0), tot = fixT + flxT, fixP = tot > 0 ? Math.round(fixT / tot * 100) : 0, flxP = 100 - fixP; return <div style={{ ...cc, padding: "16px 18px", marginBottom: 14, position: "relative", overflow: "hidden" }}><div style={{ position: "absolute", bottom: 0, right: 0, width: 60, height: 3, borderRadius: "3px 0 0 0", background: "#A78BFA" }} /><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "#A78BFA", fontWeight: 700, letterSpacing: "0.5px" }}>Fixed vs Flexible</div><div style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-h)" }}>This Month</div></div>{tot === 0 ? <p style={{ color: "var(--muted)", fontSize: 13, textAlign: "center", padding: "8px 0" }}>No expenses this month</p> : <><div style={{ height: 8, borderRadius: 4, background: "#FBBF24", overflow: "hidden", marginBottom: 10 }}><div style={{ height: "100%", width: `${fixP}%`, background: "#A78BFA", borderRadius: 4 }} /></div><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}><div style={{ display: "flex", alignItems: "center", gap: 6 }}><div style={{ width: 8, height: 8, borderRadius: 2, background: "#A78BFA", flexShrink: 0 }} /><span style={{ fontSize: 12, fontFamily: "var(--font-h)", color: "var(--ts)" }}>Fixed</span></div><span style={{ fontSize: 12, fontFamily: "var(--font-h)", fontWeight: 600, color: "var(--text)" }}>{fmt(fixT)} <span style={{ color: "var(--muted)", fontWeight: 400 }}>({fixP}%)</span></span></div><div style={{ display: "flex", justifyContent: "space-between" }}><div style={{ display: "flex", alignItems: "center", gap: 6 }}><div style={{ width: 8, height: 8, borderRadius: 2, background: "#FBBF24", flexShrink: 0 }} /><span style={{ fontSize: 12, fontFamily: "var(--font-h)", color: "var(--ts)" }}>Flexible</span></div><span style={{ fontSize: 12, fontFamily: "var(--font-h)", fontWeight: 600, color: "var(--text)" }}>{fmt(flxT)} <span style={{ color: "var(--muted)", fontWeight: 400 }}>({flxP}%)</span></span></div></>}</div> })()}
        {budgetStatus.length > 0 && <div style={{ ...cc, padding: "16px 18px", marginBottom: 14, position: "relative", overflow: "hidden" }}><div style={{ position: "absolute", bottom: 0, right: 0, width: 60, height: 3, borderRadius: "3px 0 0 0", background: "#7B8CDE" }} /><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "#7B8CDE", fontWeight: 700, letterSpacing: "0.5px" }}>Monthly Budgets</div><button onClick={() => { sTab("settings"); sBudgetSettingsOpen(true); }} style={{ fontSize: 10, color: "#7B8CDE", fontFamily: "var(--font-h)", fontWeight: 600, background: "none", border: "none", cursor: "pointer", padding: 0 }}>Edit ›</button></div>{budgetStatus.map(({ cid, cat, spent, lim, pct }) => { const bc = pct >= 100 ? "#D4726A" : pct >= 80 ? "#FBBF24" : "#6BAA75"; return <div key={cid} style={{ marginBottom: 10 }}><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, alignItems: "center" }}><div style={{ display: "flex", alignItems: "center", gap: 6 }}><DI2 id={cid} accent={cat.neon || cat.color} size={14} /><span style={{ fontSize: 12, fontFamily: "var(--font-h)", color: "var(--text)", fontWeight: 600 }}>{cat.name}</span>{pct >= 100 && <span style={{ fontSize: 9, fontFamily: "var(--font-h)", fontWeight: 700, color: "#D4726A", background: "#D4726A15", padding: "1px 5px", borderRadius: 3 }}>OVER</span>}</div><span style={{ fontSize: 11, fontFamily: "var(--font-h)", color: bc, fontWeight: 700 }}>{fmt(spent)} / {fmt(lim)}</span></div><div style={{ height: 5, borderRadius: 3, background: "var(--border)", overflow: "hidden" }}><div style={{ height: "100%", width: `${pct}%`, background: bc, borderRadius: 3 }} /></div></div>; })}</div>}
        <SpendingBreakdown expenses={exAll} categories={cats} period={trendPeriod} onPeriodChange={sTrendPeriod} formatCurrency={fmt} darkMode={dm} />
        <div style={{ ...cc, padding: 18, marginBottom: 16, position: "relative", overflow: "hidden" }}><div style={{ position: "absolute", bottom: 0, right: 0, width: 60, height: 3, borderRadius: "3px 0 0 0", background: "#E07A5F" }} /><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "#E07A5F", marginBottom: 16, letterSpacing: "0.5px", fontWeight: 700 }}>Spending by Category</div>{fltExAll.length === 0 ? <p style={{ color: "var(--muted)", fontSize: 13, textAlign: "center", padding: 20 }}>No expenses yet</p> : (() => { const t = {}; fltExAll.forEach(e => { t[e.categoryId] = (t[e.categoryId] || 0) + e.amount }); const s = Object.entries(t).sort((a, b) => b[1] - a[1]), mx = s[0]?.[1] || 1; const curM = fm !== "all" ? fm : localDateKey().slice(0, 7); const prevDate = new Date(curM + "-01"); prevDate.setMonth(prevDate.getMonth() - 1); const prevM = prevDate.toISOString().slice(0, 7); const prevT = {}; exAll.filter(e => mk(e.date) === prevM).forEach(e => { prevT[e.categoryId] = (prevT[e.categoryId] || 0) + e.amount }); return s.map(([cid, total]) => { const c = cats.find(x => x.id === cid) || { id: cid, name: cid.split("_")[0].replace(/^\w/, l => l.toUpperCase()), color: "#6366F1", neon: "#818CF8" }; const cExps = fltExAll.filter(e => e.categoryId === cid); const realEx = cExps.filter(e => !e.__settlement); const ctag = realEx.length > 0 && realEx.every(isFix) ? "fixed" : "flexible"; const prevTotal = prevT[cid] || 0; const momPct = prevTotal > 0 ? Math.round((total - prevTotal) / prevTotal * 100) : null; const isDrilled = drillCat === cid; const allTx = isDrilled ? [...cExps].sort((a, b) => (b.date || "").localeCompare(a.date || "")) : []; return <div key={cid} style={{ marginBottom: 12 }}><div onClick={() => sDrillCat(isDrilled ? null : cid)} style={{ display: "flex", alignItems: "center", gap: 12, cursor: "pointer" }}><span style={{ width: 30, display: "flex", justifyContent: "center" }}><DI2 id={c.id} accent={c.neon || c.color} size={20} /></span><div style={{ flex: 1 }}><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}><div style={{ display: "flex", alignItems: "center" }}><span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-h)" }}>{c.name}</span><span style={{ fontSize: 8, fontFamily: "var(--font-h)", fontWeight: 600, color: ctag === "fixed" ? "#A78BFA" : "#FBBF24", background: ctag === "fixed" ? "#A78BFA15" : "#FBBF2415", padding: "2px 6px", borderRadius: 4, marginLeft: 6 }}>{ctag === "fixed" ? "FIXED" : "FLEX"}</span><span style={{ fontSize: 9, color: "var(--muted)", marginLeft: 6, fontFamily: "var(--font-h)" }}>{cExps.length} tx</span></div><div style={{ display: "flex", alignItems: "center", gap: 6 }}>{momPct !== null && <span style={{ fontSize: 9, fontFamily: "var(--font-h)", fontWeight: 700, color: momPct > 0 ? "#E07A5F" : "#6BAA75", background: momPct > 0 ? "#E07A5F15" : "#6BAA7515", padding: "1px 5px", borderRadius: 3 }}>{momPct > 0 ? "+" : ""}{momPct}% MoM</span>}<span style={{ fontSize: 13, fontFamily: "var(--font-h)", color: "var(--ts)", fontWeight: 500 }}>{fmt(total)}</span></div></div><div style={{ height: 5, borderRadius: 3, background: "var(--border)", overflow: "hidden" }}><div style={{ height: "100%", width: `${(total / mx) * 100}%`, background: c.color, borderRadius: 3 }} /></div></div><span style={{ fontSize: 10, color: "var(--muted)" }}>{isDrilled ? "▲" : "▼"}</span></div>{isDrilled && <div style={{ marginLeft: 42, marginTop: 6, padding: "8px 10px", background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)", maxHeight: 260, overflowY: "auto" }}>{allTx.length === 0 && <div style={{ fontSize: 11, color: "var(--muted)", textAlign: "center", padding: 8 }}>No entries</div>}{allTx.map(tx => <div key={tx.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, paddingBottom: 6, borderBottom: "1px dashed var(--border)" }}><div style={{ flex: 1, minWidth: 0, marginRight: 8 }}><div style={{ fontSize: 11, color: "var(--ts)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-h)", fontWeight: 600 }}>{tx.note || "(no note)"}{tx.__settlement && <span style={{ marginLeft: 5, fontSize: 8, color: "#D4726A", background: "#D4726A15", padding: "1px 4px", borderRadius: 3, fontWeight: 700 }}>SPLIT</span>}</div><div style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-b)", marginTop: 1 }}>{dl(tx.date)}</div></div><span style={{ fontSize: 12, fontFamily: "var(--font-h)", color: "var(--text)", fontWeight: 600, flexShrink: 0 }}>{fmt(tx.amount)}</span></div>)}</div>}</div> }) })()}</div>
        </div>}

      {tab === "add" && <div className="pse" style={{ paddingTop: 20 }}><div style={{ display: "flex", gap: 6, marginBottom: 16 }}>{[["log", "Log"], ["iou", "IOU · Splits"]].map(([s, lbl]) => <button key={s} onClick={() => sAddSeg(s)} style={{ flex: 1, padding: "9px", borderRadius: 10, fontSize: 12, fontFamily: "var(--font-h)", fontWeight: 600, cursor: "pointer", border: `1.5px solid ${addSeg === s ? "#E07A5F" : "var(--border)"}`, background: addSeg === s ? "#E07A5F" : "var(--card)", color: addSeg === s ? "#fff" : "var(--muted)" }}>{lbl}</button>)}</div>{addSeg === "log" && <AddPage categories={cats} incomeSources={isrc} recurringCats={recCats} onAddExpense={addE} onAddIncome={addI} onAddTransfer={addT} onAddRec={addRec} onError={showT} patterns={quickPatterns} autoRules={autoRules} onLearnRule={rule => { sAutoRules(prev => { if (prev.find(r => r.keyword === rule.keyword)) return prev; return [...prev, rule]; }); }} wallets={wallets} cloudinaryEnabled={!!_creds.cloudName} />}{addSeg === "iou" && <IOUWallet splits={sp} settlements={stl} categories={cats} wallets={wallets} events={evs} fmt={fmt} uid={uid} isUpiLite={isUpiLite} SettleModal={SettleM} onAdd={s => { const sr = { ...s, createdAt: new Date().toISOString() }; sSp(p => [...p, sr]); sbUpsert("splits", [toSB(sr, COLS.splits)]); }} onSettle={settle} onSettleNet={settleNet} onSettleEventNet={settleEventNet} onSkip={skipSplit} onUnskip={unskipSplit} onDelete={id => delItem(id, "split")} onError={msg => showT(msg, "error")} />}</div>}
      {tab === "events" && <div className="pse" style={{ background: "transparent", padding: 0 }}><Events events={evs} expenses={ex} splits={sp} settlements={stl} categories={cats} wallets={wallets} staleByEvent={staleByEvent} onCreate={ev => { sEvs(p => [...p, ev]); sbUpsert("events", [toSB(ev, COLS.events)]) }} onAddExp={addE} onAddSplit={s => { const sr = { ...s, createdAt: new Date().toISOString() }; sSp(p => [...p, sr]); sbUpsert("splits", [toSB(sr, COLS.splits)]); showT(sr.direction === "owe" ? `You owe ${sr.name} ${fmt(sr.amount)}` : `${sr.name} owes you ${fmt(sr.amount)}`, "info") }} onSettleSplit={settle} onSettleEventNet={settleEventNet} onDeleteSplit={id => delItem(id, "split")} onSkipSplit={skipSplit} onUnskipSplit={unskipSplit} onEditSplit={(id, patch) => { sSp(p => p.map(s => s.id === id ? { ...s, ...patch } : s)); sbUpsert("splits", [{ id, ...patch }]); }} onDeleteExp={id => delItem(id, "expense")} onEditExp={(id, patch) => { const exp = ex.find(e => e.id === id); if (!exp) return false; const gid = exp.groupId || exp.id; sSp(p => p.filter(s => s.groupId !== gid)); sStl(p => p.filter(s => s.groupId !== gid)); sbDeleteWhere("splits", `group_id=eq.${gid}`); sbDeleteWhere("settlements", `group_id=eq.${gid}`); const wallet = patch.paidBy && patch.paidBy !== "me" ? "__tracked__" : (patch.walletId ?? exp.walletId); const updated = { ...exp, ...patch, walletId: wallet }; sEx(p => p.map(e => e.id === id ? updated : e)); sbUpsert("expenses", [toSB(updated, COLS.expenses)]); return true; }} onMarkDone={id => { sEvs(p => p.map(e => e.id === id ? { ...e, status: "completed" } : e)); sbUpsert("events", [{ id, status: "completed" }]) }} onReopen={id => { sEvs(p => p.map(e => e.id === id ? { ...e, status: "active" } : e)); sbUpsert("events", [{ id, status: "active" }]); showT("Event reopened", "info") }} onUpdate={ev => { sEvs(p => p.map(e => e.id === ev.id ? ev : e)); sbUpsert("events", [toSB(ev, COLS.events)]); showT("Event updated", "success") }} onToast={showT} onDelete={id => { const ev = evs.find(e => e.id === id); if (!ev) return; const evSplits = sp.filter(s => s.eventId === id && !s.deleted_at); const evStls = stl.filter(s => s.eventId === id); sEvs(p => p.filter(e => e.id !== id)); sbDelete("events", id); if (evSplits.length) { sSp(p => p.filter(s => s.eventId !== id)); evSplits.forEach(s => sbDelete("splits", s.id)); } if (evStls.length) { sStl(p => p.filter(s => s.eventId !== id)); sbDeleteWhere("settlements", `event_id=eq.${id}`); } showUndoToast(ev.name + " deleted", { type: "event", exp: ev, splits: evSplits, settlements: evStls }); }} dm={dm} /></div>}
      {tab === "history" && <div className="pe"><CalendarView compact expenses={exAll} incomes={inc} transfers={tr} categories={cats.concat(isrc)} wallets={wallets} selectedDay={hCalDay} onDayClick={d => { sHCalDay(d); if (d) { const dm = d.slice(0, 7); if (fm !== "all" && fm !== dm) sFm(dm); if (typeof document !== "undefined") { const scrollToDay = () => { const el = document.querySelector(`[data-history-date="${d}"]`); if (el) el.scrollIntoView({ block: "start", behavior: "smooth" }); }; requestAnimationFrame(() => requestAnimationFrame(scrollToDay)); } } }} />{(() => { const activeCount = [hSearch.trim(), hMinAmt, hMaxAmt, hDateFrom, hDateTo, hType !== "all" ? "x" : "", hWallet].filter(Boolean).length; const clearAll = () => { sHSearch(""); sHMinAmt(""); sHMaxAmt(""); sHDateFrom(""); sHDateTo(""); sHType("all"); sHWallet(""); sHShowFilters(false); }; return <div style={{ marginBottom: 14 }}><input value={hSearch} onChange={e => sHSearch(e.target.value)} placeholder="Search note, category…" style={{ ...is, marginBottom: 8, padding: "10px 14px" }} /><div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}><button onClick={() => { sBulkMode(v => !v); sBulkSel(new Set()); }} style={{ flex: "1 1 auto", padding: "9px 12px", borderRadius: 10, border: `1.5px solid ${bulkMode ? "#E07A5F" : "var(--border)"}`, background: bulkMode ? "#E07A5F18" : "var(--card)", color: bulkMode ? "#E07A5F" : "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Select</button><button onClick={() => sHShowFilters(!hShowFilters)} style={{ flex: "1 1 auto", padding: "9px 12px", borderRadius: 10, border: `1.5px solid ${activeCount > 0 ? "#E07A5F" : "var(--border)"}`, background: activeCount > 0 ? "#E07A5F18" : "var(--card)", color: activeCount > 0 ? "#E07A5F" : "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5 }}>Filter{activeCount > 0 && <span style={{ background: "#E07A5F", color: "#fff", borderRadius: "50%", width: 16, height: 16, fontSize: 9, display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>{activeCount}</span>}</button>{activeCount > 0 && <button onClick={clearAll} style={{ flex: "1 1 auto", padding: "9px 12px", borderRadius: 10, border: "1.5px solid var(--border)", background: "var(--card)", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Clear</button>}<button onClick={() => sHTimeline(v => !v)} title="Timeline view" style={{ padding: "9px 12px", borderRadius: 10, border: `1.5px solid ${hTimeline ? "#A78BFA" : "var(--border)"}`, background: hTimeline ? "#A78BFA18" : "var(--card)", color: hTimeline ? "#A78BFA" : "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: "pointer", flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center" }}><Timer size={14} /></button></div>{hShowFilters && <div style={{ ...cc, padding: 14, marginBottom: 8 }}><div style={{ display: "flex", gap: 5, marginBottom: 10, flexWrap: "wrap" }}>{["all", "expense", "income", "transfer", "settlement", "recurring"].map(t => <button key={t} onClick={() => sHType(t)} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 600, border: `1.5px solid ${hType === t ? "#7B8CDE" : "var(--border)"}`, background: hType === t ? "#7B8CDE18" : "var(--card)", color: hType === t ? "#7B8CDE" : "var(--muted)", cursor: "pointer" }}>{t.charAt(0).toUpperCase() + t.slice(1)}</button>)}</div><div style={{ display: "flex", gap: 5, marginBottom: 12, flexWrap: "wrap" }}><button onClick={() => sHWallet("")} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 600, border: `1.5px solid ${hWallet === "" ? "#2DD4BF" : "var(--border)"}`, background: hWallet === "" ? "#2DD4BF18" : "var(--card)", color: hWallet === "" ? "#2DD4BF" : "var(--muted)", cursor: "pointer" }}>All wallets</button>{wallets.map(w => <button key={w.id} onClick={() => sHWallet(hWallet === w.id ? "" : w.id)} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 600, border: `1.5px solid ${hWallet === w.id ? "#2DD4BF" : "var(--border)"}`, background: hWallet === w.id ? "#2DD4BF18" : "var(--card)", color: hWallet === w.id ? "#2DD4BF" : "var(--muted)", cursor: "pointer" }}>{w.name}</button>)}</div><div style={{ display: "flex", gap: 8, marginBottom: 10 }}><div style={{ flex: 1 }}><label style={{ ...ls, fontSize: 10 }}>Min ₹</label><input type="number" value={hMinAmt} onChange={e => sHMinAmt(e.target.value)} placeholder="0" style={{ ...is, padding: "8px 10px", marginBottom: 0 }} /></div><div style={{ flex: 1 }}><label style={{ ...ls, fontSize: 10 }}>Max ₹</label><input type="number" value={hMaxAmt} onChange={e => sHMaxAmt(e.target.value)} placeholder="∞" style={{ ...is, padding: "8px 10px", marginBottom: 0 }} /></div></div><div style={{ display: "flex", gap: 8 }}><div style={{ flex: 1 }}><label style={{ ...ls, fontSize: 10 }}>From Date</label><input type="date" value={hDateFrom} onChange={e => sHDateFrom(e.target.value)} style={{ ...is, padding: "8px 10px", marginBottom: 0 }} /></div><div style={{ flex: 1 }}><label style={{ ...ls, fontSize: 10 }}>To Date</label><input type="date" value={hDateTo} onChange={e => sHDateTo(e.target.value)} style={{ ...is, padding: "8px 10px", marginBottom: 0 }} /></div></div></div>}{activeCount > 0 && <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-h)", textAlign: "center", marginTop: 4 }}>{historyItems.length} result{historyItems.length !== 1 ? "s" : ""}</div>}</div>; })()}{bulkMode && bulkSel.size > 0 && <div style={{ position: "sticky", top: 0, zIndex: 10, background: "#E07A5F", color: "#fff", padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", borderRadius: 10, marginBottom: 8 }}><span style={{ fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 600 }}>{bulkSel.size} selected</span><div style={{ display: "flex", gap: 8 }}><button onClick={() => { [...bulkSel].forEach(id => { const it = historyItems.find(x => x.id === id); if (it) delItem(id, it.type); }); sBulkSel(new Set()); sBulkMode(false); showT(`Deleted ${bulkSel.size} items`, "success"); }} style={{ padding: "6px 14px", border: "none", borderRadius: 8, background: "#fff", color: "#E07A5F", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Delete {bulkSel.size}</button><button onClick={() => { sBulkMode(false); sBulkSel(new Set()); }} style={{ padding: "6px 12px", border: "1.5px solid rgba(255,255,255,0.5)", borderRadius: 8, background: "transparent", color: "#fff", fontFamily: "var(--font-h)", fontSize: 12, cursor: "pointer" }}>Cancel</button></div></div>}
{renderItems.map(it => { const tlBal = hTimeline ? timelineData[it.id] : null; const hasSB = hTimeline && (it.balBefore !== undefined || it.fromBalBefore !== undefined); const showTL = tlBal || hasSB; const tlWallets = showTL ? (it.type === "transfer" ? [{ id: it.fromWallet }, { id: it.toWallet }] : [{ id: it.type === "expense" ? (it.walletId || "upi_lite") : it.type === "income" ? (it.walletId || "bank") : it.walletId }]) : []; return <div key={it.id} data-history-date={it.date} className={hCalDay === it.date ? "day-selected" : undefined} style={{ position: "relative", ...(hTimeline ? { paddingLeft: 28, marginBottom: 4 } : {}) }}>{hTimeline && <div style={{ position: "absolute", left: 10, top: 0, bottom: 0, width: 2, background: "var(--border)" }} />}{hTimeline && <div style={{ position: "absolute", left: 5, top: 22, width: 12, height: 12, borderRadius: "50%", background: it.type === "expense" ? "#E07A5F" : it.type === "income" ? "#6BAA75" : "#7B8CDE", border: "2px solid var(--bg)", zIndex: 1 }} />}<div style={{ display: "flex", alignItems: "stretch", gap: 6 }}>{bulkMode && <div onClick={() => sBulkSel(p => { const n = new Set(p); n.has(it.id) ? n.delete(it.id) : n.add(it.id); return n; })} style={{ display: "flex", alignItems: "center", padding: "0 4px", cursor: "pointer", flexShrink: 0 }}><div style={{ width: 20, height: 20, borderRadius: 5, border: `2px solid ${bulkSel.has(it.id) ? "#E07A5F" : "var(--border)"}`, background: bulkSel.has(it.id) ? "#E07A5F" : "var(--card)", display: "flex", alignItems: "center", justifyContent: "center" }}>{bulkSel.has(it.id) && <span style={{ color: "#fff", fontSize: 11, fontWeight: 700 }}>✓</span>}</div></div>}<div style={{ flex: 1, minWidth: 0 }}><TxCard item={it} categories={cats} incomeSources={isrc} events={evs} onDelete={delItem} recurringCats={recCats} wallets={wallets} onRefund={refundItem} />{showTL && <div style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "0 4px 10px 4px", marginTop: -4 }}>{tlWallets.map(tw => { const wName = wallets.find(w => w.id === tw.id)?.name || tw.id; let bef, aft; if (it.type === "transfer" && it.fromBalBefore !== undefined) { bef = tw.id === it.fromWallet ? it.fromBalBefore : (it.toBalBefore ?? 0); aft = tw.id === it.fromWallet ? roundMoney(it.fromBalBefore - it.amount) : roundMoney((it.toBalBefore ?? 0) + it.amount); } else if (it.balBefore !== undefined) { bef = it.balBefore; aft = roundMoney(it.balBefore + (it.type === "expense" ? -it.amount : it.amount)); } else { bef = tlBal?.before[tw.id] ?? 0; aft = tlBal?.after[tw.id] ?? 0; } return <div key={tw.id} style={{ fontSize: 10, fontFamily: "var(--font-h)", color: "var(--muted)", background: "var(--bg)", borderRadius: 6, padding: "3px 8px", display: "inline-flex", alignItems: "center", gap: 5, border: "1px solid var(--border)" }}><span style={{ fontWeight: 600, color: "var(--ts)", fontSize: 9 }}>{wName}</span><span>{fmt(bef)}</span><span style={{ opacity: 0.4, fontSize: 9 }}>→</span><span style={{ fontWeight: 700, color: bef > aft ? "#E07A5F" : bef < aft ? "#6BAA75" : "var(--muted)" }}>{fmt(aft)}</span></div>; })}</div>}</div></div></div>; })}{historyItems.length === 0 && <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--muted)", fontSize: 14, lineHeight: 1.8 }}>{flt.expenses.length === 0 && flt.incomes.length === 0 ? <><div style={{ marginBottom: 12 }}><ClipboardText size={32} color="var(--muted)" /></div><div style={{ fontFamily: "var(--font-h)", fontSize: 15, fontWeight: 600, color: "var(--ts)", marginBottom: 6 }}>No transactions yet</div><div style={{ fontSize: 12, marginBottom: 20 }}>Log expenses, income, and transfers<br />to see your spending history here.</div><button onClick={() => sTab("add")} style={{ padding: "12px 28px", border: "none", borderRadius: 12, background: "#E07A5F", color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>+ Add First Transaction</button></> : "No results match your filters."}</div>}</div>}

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
          {(recAllOpen ? rec : rec.slice(0, 3)).map(r => {
            const rc = resolveRecCategory(r.categoryId, [RC, recCats], r.categoryName);
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
          {rec.length > 3 && <button onClick={() => { hapticSelection(); sRecAllOpen(o => !o); }} style={{ width: "100%", padding: "8px", border: "1px dashed var(--border)", borderRadius: 8, background: "none", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, cursor: "pointer", marginTop: 2 }}>{recAllOpen ? "Show less ▲" : `Show all ${rec.length} ▼`}</button>}
        </div>
        {(() => { const list = mt === "expense" ? cats : isrc; const shown = manageXp ? list : list.slice(0, 2); return <div style={{ ...cc, padding: 20, marginBottom: 14 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "var(--muted)", marginBottom: 14, letterSpacing: "0.5px", fontWeight: 600 }}>Manage</div><div style={{ display: "flex", gap: 6, marginBottom: 16 }}>{["expense", "income", "recurring"].map(t => <button key={t} onClick={() => { sMt(t); sManageXp(false) }} style={{ flex: 1, padding: "9px", borderRadius: 10, fontSize: 11, fontFamily: "var(--font-h)", border: `1.5px solid ${mt === t ? (t === "expense" ? "#E07A5F" : t === "income" ? "#6BAA75" : "#A78BFA") : "var(--border)"}`, background: mt === t ? (t === "expense" ? "#E07A5F" : t === "income" ? "#6BAA75" : "#A78BFA") : "var(--card)", color: mt === t ? "#fff" : "var(--muted)", cursor: "pointer", fontWeight: 500 }}>{t === "expense" ? "Categories" : t === "income" ? "Income" : "Recurring"}</button>)}</div>{mt === "recurring" ? <>{(manageXp ? recCats : recCats.slice(0, 2)).map(c => <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "var(--bg)", borderRadius: 10, marginBottom: 6, border: "1px solid var(--border)" }}><DI2 id={c.id} accent={c.neon || c.color} size={18} /><span style={{ flex: 1, fontSize: 13, color: "var(--text)", fontWeight: 500, fontFamily: "var(--font-h)" }}>{c.name}</span><span style={{ width: 14, height: 14, borderRadius: "50%", background: c.color, flexShrink: 0 }} /><button onClick={() => { if (RC.find(d => d.id === c.id)) return; sRecCats(p => p.filter(x => x.id !== c.id)); }} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 14, padding: "2px 6px", opacity: RC.find(d => d.id === c.id) ? 0.15 : 0.5 }}>✕</button></div>)}{recCats.length > 2 && <button onClick={() => sManageXp(!manageXp)} style={{ width: "100%", padding: "8px", border: "1px dashed var(--border)", borderRadius: 8, background: "none", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, cursor: "pointer", marginBottom: 6 }}>{manageXp ? `Show less ▲` : `Show all ${recCats.length} ▼`}</button>}<div style={{ borderTop: "1px solid var(--border)", marginTop: 14, paddingTop: 14 }}><label style={ls}>Add New</label><div style={{ display: "flex", gap: 6, marginBottom: 10 }}><input value={ne2} onChange={e => sNE2(e.target.value)} maxLength={2} style={{ ...is, width: 48, textAlign: "center", flexShrink: 0 }} /><input value={nn} onChange={e => sNN(e.target.value)} placeholder="Name…" style={is} /><input type="color" value={nc} onChange={e => sNC(e.target.value)} style={{ width: 42, height: 42, border: "none", cursor: "pointer", borderRadius: 8, flexShrink: 0 }} /></div><button onClick={() => { if (!nn.trim()) return; const id = nn.trim().toLowerCase().replace(/\s+/g, "_") + "_" + uid(); sRecCats(p => [...p, { id, name: nn.trim(), emoji: ne2, color: nc, neon: nc }]); sNN(""); sNE2("📁"); sNC("#E07A5F"); }} style={{ width: "100%", padding: "11px", border: "none", borderRadius: 10, background: "#A78BFA", color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, cursor: "pointer", fontWeight: 600 }}>+ Add Category</button></div></> : <>{shown.map(c => <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "var(--bg)", borderRadius: 10, marginBottom: 6, border: "1px solid var(--border)" }}><DI2 id={c.id} accent={c.neon || c.color} size={18} />{editingCat?.id === c.id ? <input value={editingCat.name} onChange={e => sEditingCat(p => ({ ...p, name: e.target.value }))} onBlur={() => { if (editingCat.name.trim()) { if (mt === "expense") sCats(p => p.map(x => x.id === c.id ? { ...x, name: editingCat.name.trim() } : x)); else sIsrc(p => p.map(x => x.id === c.id ? { ...x, name: editingCat.name.trim() } : x)); } sEditingCat(null); }} onKeyDown={e => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") sEditingCat(null); }} autoFocus style={{ flex: 1, padding: "4px 8px", borderRadius: 6, border: "1.5px solid #7B8CDE", background: "var(--bg)", color: "var(--text)", fontSize: 13, fontFamily: "var(--font-h)", outline: "none" }} /> : <span onClick={() => sEditingCat({ id: c.id, name: c.name })} style={{ flex: 1, fontSize: 13, color: "var(--text)", fontWeight: 500, fontFamily: "var(--font-h)", cursor: "text" }}>{c.name}</span>}{(() => { const n = mt === "expense" ? ex.filter(e => e.categoryId === c.id).length : inc.filter(i => i.sourceId === c.id).length; return n > 0 ? <span style={{ fontSize: 9, color: "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 600, flexShrink: 0 }}>{n} txn{n !== 1 ? "s" : ""}</span> : null; })()}<span style={{ width: 14, height: 14, borderRadius: "50%", background: c.color }} /><button onClick={() => { const orphans = mt === "expense" ? ex.filter(e => e.categoryId === c.id).length : inc.filter(i => i.sourceId === c.id).length; if (mt === "expense") sCats(p => p.filter(x => x.id !== c.id)); else sIsrc(p => p.filter(x => x.id !== c.id)); if (orphans > 0) showT(`⚠ ${orphans} transaction${orphans !== 1 ? "s" : ""} now show as Unknown`, "info"); }} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 14, padding: "2px 6px", opacity: 0.5 }}>✕</button></div>)}{list.length > 2 && <button onClick={() => sManageXp(!manageXp)} style={{ width: "100%", padding: "8px", border: "1px dashed var(--border)", borderRadius: 8, background: "none", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, cursor: "pointer", marginBottom: 6 }}>{manageXp ? `Show less ▲` : `Show all ${list.length} ▼`}</button>}<div style={{ borderTop: "1px solid var(--border)", marginTop: 14, paddingTop: 14 }}><label style={ls}>Add New</label><div style={{ display: "flex", gap: 6, marginBottom: 10 }}><input value={ne2} onChange={e => sNE2(e.target.value)} maxLength={2} style={{ ...is, width: 48, textAlign: "center", flexShrink: 0 }} /><input value={nn} onChange={e => sNN(e.target.value)} placeholder="Name…" style={is} /><input type="color" value={nc} onChange={e => sNC(e.target.value)} style={{ width: 42, height: 42, border: "none", cursor: "pointer", borderRadius: 8, flexShrink: 0 }} /></div><button onClick={addCust} style={{ width: "100%", padding: "11px", border: "none", borderRadius: 10, background: "#7B8CDE", color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, cursor: "pointer", fontWeight: 600 }}>+ Add {mt === "expense" ? "Category" : "Source"}</button></div></>}</div> })()}
        <div style={{ ...cc, padding: "14px 20px", marginBottom: 14 }}><div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}><div style={{ minWidth: 0 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "var(--muted)", letterSpacing: "0.5px", fontWeight: 600 }}>Haptics</div><div style={{ fontSize: 11, color: "var(--muted)", marginTop: 3, fontFamily: "var(--font-b)", lineHeight: 1.4 }}>Vibration feedback on taps & actions{typeof navigator !== "undefined" && !navigator.vibrate ? " — not supported on this device" : ""}</div></div><button onClick={() => { const next = !haptics; setHapticsEnabled(next); sHaptics(next); if (next) hapticLight(); }} aria-pressed={haptics} aria-label="Toggle haptics" style={{ width: 46, height: 26, borderRadius: 13, border: "none", cursor: "pointer", background: haptics ? "#6BAA75" : "var(--border)", position: "relative", flexShrink: 0, transition: "background 0.2s" }}><span style={{ position: "absolute", top: 3, left: haptics ? 23 : 3, width: 20, height: 20, borderRadius: "50%", background: "#fff", transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.3)" }} /></button></div></div>
        <div style={{ ...cc, padding: 20, marginBottom: 14 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "var(--muted)", marginBottom: 14, letterSpacing: "0.5px", fontWeight: 600 }}>Export</div><button onClick={expCSV} style={{ width: "100%", padding: "13px", border: "none", borderRadius: 10, background: "#E07A5F", color: "#fff", fontFamily: "var(--font-h)", fontSize: 14, cursor: "pointer", fontWeight: 600 }}>Download CSV</button><p style={{ fontSize: 12, color: "var(--muted)", marginTop: 10, lineHeight: 1.6, fontStyle: "italic" }}>Upload to ChatGPT or Claude for analysis.</p></div>
        <div style={{ ...cc, padding: 20, marginBottom: 14 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "var(--muted)", marginBottom: 14, letterSpacing: "0.5px", fontWeight: 600 }}>Backup & Restore</div><div style={{ display: "flex", gap: 8, marginBottom: 8 }}><button onClick={expBackup} style={{ flex: 1, padding: "13px", border: "none", borderRadius: 10, background: "#6BAA75", color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, cursor: "pointer", fontWeight: 600 }}>Backup</button><label style={{ flex: 1, padding: "13px", border: "1.5px solid #7B8CDE", borderRadius: 10, background: "#7B8CDE12", color: "#7B8CDE", fontFamily: "var(--font-h)", fontSize: 13, cursor: "pointer", fontWeight: 600, textAlign: "center" }}>Restore<input type="file" accept=".json" onChange={e => { if (e.target.files[0]) impBackup(e.target.files[0]); e.target.value = "" }} style={{ display: "none" }} /></label></div><label style={{ display: "block", width: "100%", padding: "11px", border: "1.5px solid #c9a96e", borderRadius: 10, background: "#c9a96e12", color: "#c9a96e", fontFamily: "var(--font-h)", fontSize: 13, cursor: "pointer", fontWeight: 600, textAlign: "center", marginBottom: 8, boxSizing: "border-box" }}>Import Bank CSV<input type="file" accept=".csv" onChange={e => { if (e.target.files[0]) impCsv(e.target.files[0]); e.target.value = ""; }} style={{ display: "none" }} /></label><label style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, width: "100%", padding: "11px", border: "1.5px solid #A78BFA", borderRadius: 10, background: ledgerLoading ? "var(--border)" : "#A78BFA12", color: "#A78BFA", fontFamily: "var(--font-h)", fontSize: 13, cursor: ledgerLoading ? "default" : "pointer", fontWeight: 600, textAlign: "center", marginBottom: 8, boxSizing: "border-box", opacity: ledgerLoading ? 0.7 : 1 }}><Robot size={14} weight="fill" />{ledgerLoading ? "Reading photo…" : "Import from ledger photo (AI)"}<input type="file" accept="image/*" capture="environment" disabled={ledgerLoading} onChange={e => { if (e.target.files[0]) impLedger(e.target.files[0]); e.target.value = ""; }} style={{ display: "none" }} /></label>{ledgerPreview && <div style={{ background: "var(--bg)", borderRadius: 10, padding: "12px 14px", marginBottom: 8, border: "1px solid #A78BFA40" }}><div style={{ fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 700, color: "#A78BFA", marginBottom: 8 }}>LEDGER PREVIEW — {ledgerPreview.length} ENTRIES</div>{ledgerPreview.slice(0, 6).map((en, i) => <div key={i} style={{ fontSize: 11, color: "var(--ts)", marginBottom: 4, display: "flex", gap: 8, justifyContent: "space-between" }}><span style={{ color: en.type === "income" ? "#6BAA75" : "#E07A5F", fontWeight: 700, flexShrink: 0 }}>{en.type === "income" ? "+" : "−"}₹{en.amount}</span><span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{en.note || "—"}</span><span style={{ flexShrink: 0 }}>{en.date || "?"}</span></div>)}{ledgerPreview.length > 6 && <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 4 }}>…and {ledgerPreview.length - 6} more</div>}<div style={{ fontSize: 10, color: "var(--muted)", marginTop: 6, marginBottom: 8 }}>Imported entries land in the first category/source/wallet. Recategorize after import.</div><div style={{ display: "flex", gap: 8 }}><button onClick={confirmLedgerImport} style={{ flex: 2, padding: "10px", border: "none", borderRadius: 8, background: "#A78BFA", color: "#fff", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Import {ledgerPreview.length} entries</button><button onClick={() => sLedgerPreview(null)} style={{ flex: 1, padding: "10px", border: "1.5px solid var(--border)", borderRadius: 8, background: "transparent", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, cursor: "pointer" }}>Cancel</button></div></div>}{csvPreview && <div style={{ background: "var(--bg)", borderRadius: 10, padding: "12px 14px", marginBottom: 8, border: "1px solid #c9a96e40" }}><div style={{ fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 700, color: "#c9a96e", marginBottom: 8 }}>PREVIEW — {csvPreview.length} ROWS</div>{csvPreview.slice(0, 4).map((r, i) => <div key={i} style={{ fontSize: 11, color: "var(--ts)", marginBottom: 4, display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center" }}><span style={{ color: r.type === "income" ? "#6BAA75" : "#E07A5F", fontWeight: 700, flexShrink: 0 }}>{r.type === "income" ? "+" : "−"}₹{r.amount}</span><span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.note || "—"}</span>{r.categoryId && <span style={{ fontSize: 9, color: "#6BAA75", fontFamily: "var(--font-h)", fontWeight: 700, flexShrink: 0, background: "#6BAA7518", padding: "1px 5px", borderRadius: 4 }}>{cats.find(c => c.id === r.categoryId)?.name}</span>}<span style={{ flexShrink: 0, color: "var(--muted)" }}>{r.date}</span></div>)}{csvPreview.length > 4 && <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 4 }}>…and {csvPreview.length - 4} more</div>}<div style={{ fontSize: 10, color: "var(--muted)", marginTop: 6, marginBottom: 8 }}>Expenses → Food category, Bank wallet. Income → Allowance source. Recategorize after import.</div><div style={{ display: "flex", gap: 8 }}><button onClick={confirmCsvImport} style={{ flex: 2, padding: "10px", border: "none", borderRadius: 8, background: "#6BAA75", color: "#fff", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Import {csvPreview.length} transactions</button><button onClick={() => sCsvPreview(null)} style={{ flex: 1, padding: "10px", border: "1.5px solid var(--border)", borderRadius: 8, background: "transparent", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, cursor: "pointer" }}>Cancel</button></div></div>}<p style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.6, fontStyle: "italic" }}>Backup saves all data as JSON. Restore replaces current data. Import CSV adds bank statement transactions.</p></div>
        <div style={{ ...cc, padding: "14px 20px", marginBottom: 14 }}><div onClick={() => sBackendOpen(v => !v)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "var(--muted)", letterSpacing: "0.5px", fontWeight: 600 }}>Backend</div><span style={{ fontSize: 11, color: "var(--muted)" }}>{backendOpen ? "▲" : "▼"}</span></div>{backendOpen && <div style={{ marginTop: 14 }}><div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}><div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "var(--bg)", borderRadius: 10, border: "1px solid var(--border)" }}><div style={{ width: 8, height: 8, borderRadius: "50%", background: _creds.sbUrl ? "#6BAA75" : "#FBBF24", flexShrink: 0 }} /><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 11, fontWeight: 700, fontFamily: "var(--font-h)", color: "var(--text)" }}>Supabase</div><div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-b)", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{_creds.sbUrl ? _creds.sbUrl.replace("https://", "").replace(".supabase.co", "") + ".supabase.co" : "Not configured"}</div></div></div><div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "var(--bg)", borderRadius: 10, border: "1px solid var(--border)" }}><div style={{ width: 8, height: 8, borderRadius: "50%", background: _creds.cloudName ? "#6BAA75" : "#FBBF24", flexShrink: 0 }} /><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 11, fontWeight: 700, fontFamily: "var(--font-h)", color: "var(--text)" }}>Cloudinary</div><div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-b)", marginTop: 1 }}>{_creds.cloudName ? (_creds.apiKey ? _creds.cloudName + " (signed)" : _creds.cloudName + " (unsigned preset)") : "Not configured"}</div></div></div></div><div style={{ display: "flex", gap: 8, marginBottom: 8 }}><button onClick={() => { const data = JSON.stringify(_creds, null, 2); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([data], { type: "application/json" })); a.download = "nomad_credentials.json"; a.click(); showT("Credentials exported", "success"); }} style={{ flex: 1, padding: "11px", border: "1.5px solid #6BAA75", borderRadius: 10, background: "#6BAA7512", color: "#6BAA75", fontFamily: "var(--font-h)", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>Export</button><label style={{ flex: 1, padding: "11px", border: "1.5px solid #7B8CDE", borderRadius: 10, background: "#7B8CDE12", color: "#7B8CDE", fontFamily: "var(--font-h)", fontSize: 12, cursor: "pointer", fontWeight: 600, textAlign: "center" }}>Import<input type="file" accept=".json" style={{ display: "none" }} onChange={e => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onerror = () => showT("Failed to read file", "error"); r.onload = ev => { try { const d = JSON.parse(ev.target.result); if (!d.sbUrl || !d.sbKey) { showT("Invalid credentials file", "error"); return; } localStorage.setItem("nomad-credentials", JSON.stringify(d)); showT("Credentials imported — reloading…", "success"); setTimeout(() => window.location.reload(), 1000); } catch { showT("Failed to read file", "error"); } }; r.readAsText(f); e.target.value = ""; }} /></label></div><button onClick={() => setShowSetup(true)} style={{ width: "100%", padding: "11px", border: "1.5px solid var(--border)", borderRadius: 10, background: "var(--card)", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>Edit Credentials</button></div>}</div>
        <div style={{ ...cc, padding: "14px 20px", marginBottom: 14 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "var(--muted)", marginBottom: 12, letterSpacing: "0.5px", fontWeight: 600 }}>Sync Status</div><div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", background: "var(--bg)", borderRadius: 10, border: "1px solid var(--border)", marginBottom: 10 }}><div><div style={{ fontSize: 12, fontFamily: "var(--font-h)", fontWeight: 600, color: "var(--text)" }}>{online ? (pendingSync > 0 ? `${pendingSync} change${pendingSync === 1 ? "" : "s"} pending` : "All changes synced") : "Offline — changes will sync when online"}</div><div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2, fontFamily: "var(--font-h)" }}>{online ? "Connected to Supabase" : "Working from local copy"}</div></div><div style={{ width: 8, height: 8, borderRadius: "50%", background: !online ? "#D4726A" : pendingSync > 0 ? "#FBBF24" : "#6BAA75", flexShrink: 0 }} /></div><div style={{ display: "flex", gap: 6 }}><button disabled={!online || pendingSync === 0} onClick={() => { flushSyncQueue().then(r => { if (r.synced > 0) showT(`Synced ${r.synced} change${r.synced === 1 ? "" : "s"}`, "success"); else if (r.pending > 0) showT(`${r.pending} change${r.pending === 1 ? "" : "s"} still pending — server may be unreachable`, "info"); else showT("Nothing to sync", "info"); }).catch(() => showT("Sync failed", "error")); }} style={{ flex: 1, padding: "10px", border: "1.5px solid var(--border)", borderRadius: 10, background: "var(--card)", color: (!online || pendingSync === 0) ? "var(--muted)" : "var(--text)", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: (!online || pendingSync === 0) ? "not-allowed" : "pointer", opacity: (!online || pendingSync === 0) ? 0.5 : 1 }}>Push pending</button><button disabled={!online || !SB_ENABLED} onClick={() => { showT("Pulling latest from cloud…", "info"); load({ skipLocal: true }).then(ok => { showT(ok ? "Pulled latest from cloud ✓" : "Pull failed — check network or credentials", ok ? "success" : "error"); }).catch(() => showT("Pull failed", "error")); }} title={!SB_ENABLED ? "Add Supabase credentials first" : ""} style={{ flex: 1, padding: "10px", border: `1.5px solid ${(online && SB_ENABLED) ? "#7B8CDE" : "var(--border)"}`, borderRadius: 10, background: (online && SB_ENABLED) ? "#7B8CDE12" : "var(--card)", color: (online && SB_ENABLED) ? "#7B8CDE" : "var(--muted)", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 700, cursor: (online && SB_ENABLED) ? "pointer" : "not-allowed", opacity: (online && SB_ENABLED) ? 1 : 0.5 }}>Pull from cloud</button></div>{deadLetterCount > 0 && <div style={{ marginTop: 10, padding: "10px 12px", background: "#D4726A12", border: "1px solid #D4726A30", borderRadius: 10 }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><div style={{ fontSize: 12, fontFamily: "var(--font-h)", fontWeight: 600, color: "#D4726A" }}>{deadLetterCount} failed change{deadLetterCount === 1 ? "" : "s"}</div><button onClick={() => { clearDeadLetter(); sDeadLetterCount(0); showT("Failed queue cleared", "info"); }} style={{ fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 600, background: "none", border: "none", color: "#D4726A", cursor: "pointer", padding: "2px 6px" }}>Dismiss</button></div><div style={{ fontSize: 10, color: "var(--muted)", marginTop: 3, fontFamily: "var(--font-b)" }}>These changes couldn't be saved after 3 retries. They've been discarded from the queue.</div></div>}</div>
        {(() => { const count = ex.filter(rowHasLocalReceipt).length + inc.filter(rowHasLocalReceipt).length; if (count === 0) return null; return <div style={{ ...cc, padding: "14px 20px", marginBottom: 14, borderLeft: "3px solid #FBBF24" }}><div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}><div><div style={{ fontFamily: "var(--font-h)", fontSize: 13, color: "#c8820a", fontWeight: 700, letterSpacing: "0.5px" }}>Local Receipts</div><div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{count} receipt{count === 1 ? "" : "s"} saved on this device only</div></div><div style={{ fontSize: 11, color: "#c8820a", fontWeight: 700, fontFamily: "var(--font-h)", background: "#FBBF2415", borderRadius: 8, padding: "4px 10px" }}>{count}</div></div><p style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.5, marginBottom: 10 }}>These were attached while offline or when Cloudinary upload failed. They're stored as base64 in the database (large rows). Tap below to re-upload to Cloudinary.</p>{(() => { const rows = [...ex.filter(rowHasLocalReceipt).map(r => ({ ...r, _k: "E" })), ...inc.filter(rowHasLocalReceipt).map(r => ({ ...r, _k: "I" }))]; return <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 }}>{rows.slice(0, 8).map(r => <div key={r._k + r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 11, fontFamily: "var(--font-h)", color: "var(--text)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 9px" }}><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><span style={{ fontWeight: 700 }}>{fmt(r.amount)}</span>{r.note ? " · " + dispNote(r.note) : ""}</span><span style={{ flexShrink: 0, color: "var(--muted)", fontWeight: 600 }}>{r.date || ""}</span></div>)}{rows.length > 8 && <div style={{ fontSize: 10, color: "var(--muted)", textAlign: "center", fontFamily: "var(--font-b)" }}>…and {rows.length - 8} more</div>}</div>; })()}<button disabled={lrMigrating || !_creds.cloudName || !online} onClick={migrateLocalReceipts} style={{ width: "100%", padding: "10px", border: "1.5px solid #c8820a", borderRadius: 10, background: lrMigrating ? "var(--border)" : "#FBBF2412", color: "#c8820a", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 700, cursor: (lrMigrating || !_creds.cloudName || !online) ? "not-allowed" : "pointer", opacity: (lrMigrating || !_creds.cloudName || !online) ? 0.5 : 1 }}>{lrMigrating ? "Uploading…" : !_creds.cloudName ? "Add Cloudinary credentials first" : !online ? "Offline — connect to retry" : `Re-upload ${count} receipt${count === 1 ? "" : "s"} to Cloudinary`}</button><button disabled={lrMigrating} onClick={discardLocalReceipts} style={{ width: "100%", padding: "8px", marginTop: 8, border: "none", borderRadius: 8, background: "none", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 11, fontWeight: 600, cursor: lrMigrating ? "not-allowed" : "pointer", textDecoration: "underline", opacity: lrMigrating ? 0.4 : 1 }}>Already in cloud? Discard local cop{count === 1 ? "y" : "ies"}</button></div>; })()}
        <div style={{ ...cc, padding: 20, marginBottom: 14 }}><div onClick={() => { sRecDelOpen(o => !o); if (!recDelOpen && recDelItems === null) loadRecentlyDeleted(); }} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", marginBottom: recDelOpen ? 12 : 0 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "var(--muted)", letterSpacing: "0.5px", fontWeight: 600 }}>Recently Deleted</div><span style={{ fontSize: 10, color: "var(--muted)", transition: "transform 0.2s", display: "inline-block", transform: recDelOpen ? "rotate(0deg)" : "rotate(-90deg)" }}>▾</span></div>{recDelOpen && (recDelItems === null ? <button onClick={loadRecentlyDeleted} disabled={recDelLoading} style={{ width: "100%", padding: "10px", border: "1.5px solid var(--border)", borderRadius: 10, background: "var(--card)", color: recDelLoading ? "var(--muted)" : "var(--text)", fontFamily: "var(--font-h)", fontSize: 12, fontWeight: 600, cursor: recDelLoading ? "not-allowed" : "pointer", opacity: recDelLoading ? 0.6 : 1 }}>{recDelLoading ? "Loading…" : "Load deleted items (last 30 days)"}</button> : recDelItems.length === 0 ? <div style={{ fontSize: 12, color: "var(--muted)", textAlign: "center", padding: "8px 0" }}>No items deleted in the last 30 days</div> : <><button onClick={() => { const cutoff = new Date(Date.now() - 30 * 864e5).toISOString(); if (!window.confirm("Permanently delete all items soft-deleted more than 30 days ago? This cannot be undone.")) return; ["expenses","incomes","transfers","recurring","events","splits"].forEach(t => sbDeleteWhere(t, "deleted_at=lt." + cutoff)); showT("Expired items (>30 days) purged from database", "success"); }} style={{ width: "100%", padding: "8px", border: "1.5px solid #D4726A", borderRadius: 8, background: "#D4726A10", color: "#D4726A", fontFamily: "var(--font-h)", fontSize: 11, fontWeight: 600, cursor: "pointer", marginBottom: 10, display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}><Trash size={12} />Purge expired (&gt;30 days old)</button>{recDelItems.map(item => <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid var(--border)" }}><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 12, fontFamily: "var(--font-h)", fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item._tbl === "recurring" ? item.name : item._tbl === "splits" ? (item.name + " · " + fmt(item.amount) + (item.note ? " · " + item.note : "")) : (fmt(item.amount) + (item.note ? " · " + item.note : "") + " · " + (item.date || ""))}</div><div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>{item._tbl} · deleted {new Date(item.deleted_at).toLocaleDateString()}</div></div><button onClick={() => restoreDeleted(item)} style={{ padding: "5px 10px", border: "1.5px solid #6BAA75", borderRadius: 7, background: "#6BAA7512", color: "#6BAA75", fontFamily: "var(--font-h)", fontSize: 11, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}>Restore</button><button onClick={() => { sbDeleteWhere(item._tbl, "id=eq." + item.id); sRecDelItems(p => p.filter(i => i.id !== item.id)); showT("Permanently deleted", "success"); }} style={{ padding: "5px 8px", border: "1.5px solid #D4726A", borderRadius: 7, background: "#D4726A10", color: "#D4726A", fontFamily: "var(--font-h)", fontSize: 11, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}>✕</button></div>)}</>)}</div>
        <div style={{ ...cc, padding: 20, marginBottom: 14 }}><div style={{ fontFamily: "var(--font-h)", fontSize: 12, color: "var(--muted)", marginBottom: 14, letterSpacing: "0.5px", fontWeight: 600 }}>Danger Zone</div>{!clr ? <button onClick={() => { sClr(true); sNukeTxt(""); }} style={{ width: "100%", padding: "13px", border: "1.5px solid #D4726A", borderRadius: 10, background: "#D4726A12", color: "#D4726A", fontFamily: "var(--font-h)", fontSize: 13, cursor: "pointer", fontWeight: 600 }}>Clear All Data</button> : <div><p style={{ fontSize: 13, color: "#D4726A", marginBottom: 8, lineHeight: 1.5 }}>Delete everything permanently?</p>{getPendingSyncCount() > 0 && <p style={{ fontSize: 12, color: "#E07A5F", marginBottom: 8, lineHeight: 1.5, display: "flex", alignItems: "flex-start", gap: 4 }}><Warning size={14} weight="fill" style={{ flexShrink: 0, marginTop: 1 }} /><span>{getPendingSyncCount()} unsaved change{getPendingSyncCount() === 1 ? "" : "s"} pending sync — will be permanently lost.</span></p>}<button onClick={expBackup} style={{ width: "100%", padding: "9px", border: "1.5px solid #6BAA75", borderRadius: 8, background: "#6BAA7512", color: "#6BAA75", fontFamily: "var(--font-h)", fontSize: 12, cursor: "pointer", fontWeight: 600, marginBottom: 10 }}>↓ Download backup first</button><p style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>Type <strong>DELETE</strong> to confirm:</p><input value={nukeTxt} onChange={e => sNukeTxt(e.target.value)} placeholder="DELETE" autoCapitalize="characters" style={{ width: "100%", padding: "9px 11px", border: "1px solid #D4726A", borderRadius: 8, marginBottom: 10, fontSize: 13, fontFamily: "monospace", background: "var(--card)", color: "var(--text)" }} /><div style={{ display: "flex", gap: 8 }}><button onClick={() => { sClr(false); sNukeTxt(""); }} style={{ flex: 1, padding: "11px", border: "1.5px solid var(--border)", borderRadius: 10, background: "var(--card)", color: "var(--ts)", fontFamily: "var(--font-h)", fontSize: 13, cursor: "pointer" }}>Cancel</button><button disabled={nukeTxt !== "DELETE"} onClick={() => { if (nukeTxt !== "DELETE") return; sEx([]); sInc([]); sTr([]); sStl([]); sCats(DC); sIsrc(DI); sSp([]); sEvs([]); sRec([]); sWsb({}); sClr(false); sNukeTxt(""); Object.keys(localStorage).filter(k => k.startsWith("nomad-") && k !== "nomad-credentials").forEach(k => localStorage.removeItem(k));["expenses", "incomes", "transfers", "settlements", "splits", "recurring", "events"].forEach(t => sbDeleteWhere(t, "id=neq.null")); sbDeleteWhere("wallet_balances", "wallet_id=neq.null"); showT(online ? "Data cleared" : "Clear queued for sync", "success") }} style={{ flex: 1, padding: "11px", border: "none", borderRadius: 10, background: nukeTxt === "DELETE" ? "#D4726A" : "#D4726A66", color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, cursor: nukeTxt === "DELETE" ? "pointer" : "not-allowed", fontWeight: 600 }}>Yes, Delete</button></div></div>}</div>
        <div style={{ textAlign: "center", padding: "24px 20px", color: "var(--muted)", fontSize: 12, lineHeight: 1.8, fontStyle: "italic" }}>NOMAD v10.5 — Track smart. Spend wise. 🦁</div></div>}

    </div>}

    {module === "finance" && (() => { const cm = localDateKey().slice(0, 7); const totalInc = inc.reduce((s, i) => s + i.amount, 0); const myEx = ex.filter(e => !isTrackedExp(e)); const totalExp = myEx.reduce((s, e) => s + e.amount, 0); const catTotals = {}; myEx.forEach(e => { catTotals[e.categoryId] = (catTotals[e.categoryId] || 0) + e.amount; }); const topCats = Object.entries(catTotals).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, amt]) => ({ name: cats.find(c => c.id === id)?.name || id, amount: amt, pct: totalExp > 0 ? Math.round(amt / totalExp * 100) : 0 })); const wBals = wallets.map(w => ({ name: w.name, balance: roundMoney(wBal[w.id] || 0) })); const allTxRedacted = redactTransactions(ex).map(e => ({ date: e.date, amount: e.amount, category: cats.find(c => c.id === e.categoryId)?.name || e.categoryId || "Unknown", note: e.note || "" })).sort((a, b) => (b.date || "").localeCompare(a.date || "")); const sendChat = async (q) => { if (!q.trim() || chatLoading) return; const userMsg = { role: "user", content: q.trim() }; sChatMsgs(p => [...p, userMsg]); sChatInput(""); sChatLoading(true); try { const r = await fetch("/api/ai-chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q.trim(), context: { month: cm, totalIncome: totalInc, totalExpense: totalExp, topCategories: topCats, recentExpenses: allTxRedacted.slice(0, 300), totalTransactions: ex.length + inc.length, walletBalances: wBals, recurringCount: rec.filter(r => r.active !== false).length, streak: finStreak } }) }); const d = await r.json(); sChatMsgs(p => [...p, { role: "assistant", content: r.ok ? d.answer : (d.error || "Something went wrong.") }]); } catch { sChatMsgs(p => [...p, { role: "assistant", content: "Network error — check your connection." }]); } finally { sChatLoading(false); } }; const QUICK_QS = ["Where am I overspending?", "How's my savings rate?", "Any unusual spending?", "Can I afford a big purchase?"]; const chatView = chatMsgs.length > 0 ? "chat" : "home"; return <><style>{`@keyframes chatBounce { 0%, 60%, 100% { transform: translateY(0); opacity: 0.4; } 30% { transform: translateY(-6px); opacity: 1; } } @keyframes chatSlideUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } } @keyframes chatFadeIn { from { opacity: 0; } to { opacity: 1; } } @keyframes chatExpand { from { opacity: 0; transform: scale(0.92) translateY(20px); transform-origin: bottom center; } to { opacity: 1; transform: scale(1) translateY(0); transform-origin: bottom center; } }`}</style>{chatOpen && <div style={{ position: "fixed", inset: 0, background: "rgba(44,40,32,0.45)", zIndex: 54, display: "flex", flexDirection: "column", justifyContent: "flex-end", animation: "chatFadeIn 0.2s ease" }} onClick={(e) => { if (e.target === e.currentTarget) sChatOpen(false); }}><div style={{ background: "#F5F0EB", borderRadius: "24px 24px 0 0", height: "82%", display: "flex", flexDirection: "column", overflow: "hidden", animation: "chatExpand 0.28s cubic-bezier(0.34,1.56,0.64,1) forwards" }}><div style={{ padding: "16px 20px 12px", borderBottom: "1px solid #D9D0C4", display: "flex", alignItems: "center", justifyContent: "space-between", background: "#FFFFFF" }}><div style={{ display: "flex", alignItems: "center", gap: 10 }}><Lion mood="happy" size={36} /><div><div style={{ fontSize: 15, fontWeight: 700, color: "#D4704A", letterSpacing: 0.5 }}>Ask NOMAD</div><div style={{ fontSize: 11, color: "#8C8278" }}>All-time data · always honest</div></div></div><div style={{ display: "flex", gap: 8, alignItems: "center" }}>{chatMsgs.length > 0 && <button onClick={() => { sChatMsgs([]); sChatInput(""); }} style={{ fontSize: 12, color: "#8C8278", background: "none", border: "none", cursor: "pointer", padding: "4px 8px", borderRadius: 8, fontFamily: "inherit" }}>Clear</button>}<button onClick={() => sChatOpen(false)} style={{ width: 28, height: 28, borderRadius: "50%", background: "#EAE4DC", border: "none", cursor: "pointer", fontSize: 14, color: "#8C8278", display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button></div></div><div style={{ flex: 1, overflowY: "auto", padding: "16px 16px 8px", display: "flex", flexDirection: "column" }}>{chatView === "home" ? <><div style={{ display: "flex", gap: 10, marginBottom: 20, animation: "chatSlideUp 0.3s ease forwards" }}><div style={{ flexShrink: 0, marginTop: 2 }}><Lion mood="happy" size={28} /></div><div style={{ background: "#FFFFFF", borderRadius: "4px 16px 16px 16px", padding: "12px 14px", fontSize: 13.5, color: "#2C2820", lineHeight: 1.6, boxShadow: "0 1px 4px rgba(0,0,0,0.07)", maxWidth: "80%" }}>Ask anything about your finances. I'm grounded in your <strong>full transaction history</strong>.</div></div><div style={{ fontSize: 11, letterSpacing: 1.5, color: "#8C8278", marginBottom: 10, paddingLeft: 2 }}>QUICK QUESTIONS</div>{QUICK_QS.map((q, i) => <button key={q} onClick={() => sendChat(q)} style={{ background: "#FFFFFF", border: "1px solid #D9D0C4", borderRadius: 14, padding: "12px 16px", textAlign: "left", fontSize: 13.5, color: "#2C2820", cursor: "pointer", marginBottom: 8, fontFamily: "'Georgia', serif", lineHeight: 1.4, animation: `chatSlideUp 0.3s ease ${i * 0.07}s forwards`, opacity: 0 }}>{q}</button>)}</> : <>{chatMsgs.map((m, i) => <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start", marginBottom: 10, animation: "chatSlideUp 0.3s ease forwards", opacity: 0 }}>{m.role === "assistant" && <div style={{ flexShrink: 0, marginRight: 8, marginTop: 2 }}><Lion mood="happy" size={28} /></div>}<div style={{ maxWidth: "76%", padding: "10px 13px", borderRadius: m.role === "user" ? "16px 16px 4px 16px" : "4px 16px 16px 16px", background: m.role === "user" ? "#D4704A" : "#FFFFFF", color: m.role === "user" ? "#FFFFFF" : "#2C2820", fontSize: 13.5, lineHeight: 1.55, boxShadow: m.role === "user" ? "0 2px 8px rgba(212,112,74,0.25)" : "0 1px 4px rgba(0,0,0,0.08)", fontFamily: "'Georgia', serif" }} dangerouslySetInnerHTML={{ __html: String(m.content || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>") }} /></div>)}{chatLoading && <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 10 }}><div style={{ flexShrink: 0, marginRight: 8, marginTop: 2 }}><Lion mood="happy" size={28} /></div><div style={{ background: "#FFFFFF", borderRadius: "4px 16px 16px 16px", padding: "10px 13px", boxShadow: "0 1px 4px rgba(0,0,0,0.08)" }}><div style={{ display: "flex", gap: 4, alignItems: "center", padding: "4px 0" }}>{[0,1,2].map(j => <div key={j} style={{ width: 7, height: 7, borderRadius: "50%", background: "#D4704A", animation: `chatBounce 1.2s ease-in-out ${j * 0.2}s infinite` }} />)}</div></div></div>}</>}</div><div style={{ padding: "10px 12px", borderTop: "1px solid #D9D0C4", display: "flex", gap: 8, background: "#FFFFFF" }}><input value={chatInput} onChange={e => sChatInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(chatInput); } }} placeholder="Ask about your finances…" style={{ flex: 1, padding: "9px 12px", borderRadius: 10, border: "1.5px solid #D9D0C4", background: "#F5F0EB", color: "#2C2820", fontSize: 13, fontFamily: "'Georgia', serif", outline: "none" }} /><button onClick={() => sendChat(chatInput)} disabled={chatLoading || !chatInput.trim()} style={{ padding: "9px 14px", borderRadius: 10, border: "none", background: chatLoading || !chatInput.trim() ? "#D9D0C4" : "#D4704A", color: "#fff", fontSize: 16, fontWeight: 700, cursor: chatLoading || !chatInput.trim() ? "not-allowed" : "pointer" }}>→</button></div></div></div>}</>; })()}
    {module === "finance" && dlBanner && deadLetterCount > 0 && <div style={{ position: "fixed", bottom: 84, left: 0, right: 0, maxWidth: 430, margin: "0 auto", background: "#D4726A", color: "#fff", padding: "10px 14px", display: "flex", alignItems: "center", gap: 8, zIndex: 49, fontSize: 12, fontFamily: "var(--font-h)", fontWeight: 600, boxShadow: "0 -2px 10px rgba(212,114,106,0.4)" }}><span style={{ flex: 1 }}>⚠ {deadLetterCount} change{deadLetterCount === 1 ? "" : "s"} failed to sync</span><button onClick={() => { sTab("settings"); sDlBanner(false); }} style={{ background: "rgba(255,255,255,0.25)", border: "none", borderRadius: 8, color: "#fff", fontFamily: "var(--font-h)", fontSize: 11, fontWeight: 700, padding: "4px 10px", cursor: "pointer" }}>Fix ›</button><button onClick={() => sDlBanner(false)} style={{ background: "none", border: "none", color: "#fff", fontSize: 18, cursor: "pointer", padding: "0 2px", lineHeight: 1, opacity: 0.8 }}>✕</button></div>}
{module === "finance" && <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, maxWidth: 430, margin: "0 auto", zIndex: 50, paddingBottom: "env(safe-area-inset-bottom)" }}><div style={{ position: "relative", height: 76 }}><svg width="100%" height="76" viewBox="0 0 430 76" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, display: "block", filter: "drop-shadow(0 -2px 12px rgba(0,0,0,0.07))" }}><path d="M0,18 L158,18 C184,18 185,52 215,52 C245,52 246,18 272,18 L430,18 L430,76 L0,76 Z" fill="var(--nav-bg)" stroke="var(--border)" strokeWidth="1" /></svg><div style={{ position: "absolute", inset: "18px 0 0 0", display: "flex" }}>{[{ id: "dashboard", label: "Home" }, { id: "events", label: "Events" }, { id: "__fab", label: "" }, { id: "history", label: "History" }, { id: "settings", label: "Settings" }].map(n => n.id === "__fab" ? <div key="__fab" style={{ flex: 1 }} /> : <button key={n.id} onClick={() => { hapticSelection(); sTab(n.id); }} style={{ flex: 1, padding: "8px 0 0", border: "none", background: "none", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, cursor: "pointer", opacity: tab === n.id ? 1 : 0.45 }}><div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>{tab === n.id && <span key={"rip" + n.id} style={{ position: "absolute", top: "50%", left: "50%", width: 30, height: 30, borderRadius: "50%", background: "#E07A5F", pointerEvents: "none", animation: "ripple 0.6s ease-out forwards" }} />}<NI type={n.id} active={tab === n.id} />{n.id === "settings" && deadLetterCount > 0 && <div style={{ position: "absolute", top: -2, right: -2, width: 8, height: 8, borderRadius: "50%", background: "#D4726A", border: "2px solid var(--nav-bg)" }} />}</div><span style={{ fontFamily: "var(--font-h)", fontSize: 9, color: tab === n.id ? "#E07A5F" : "var(--muted)", fontWeight: tab === n.id ? 600 : 400 }}>{n.label}</span></button>)}</div><button onClick={() => { hapticLight(); sTab("add"); }} aria-label="Add" style={{ position: "absolute", top: -18, left: "50%", width: 58, height: 58, borderRadius: "50%", border: "none", background: tab === "add" ? "#D4704A" : "#E07A5F", color: "#fff", cursor: "pointer", boxShadow: "0 8px 20px rgba(224,122,95,0.42), 0 2px 6px rgba(224,122,95,0.28)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", transform: `translateX(-50%) scale(${tab === "add" ? 0.94 : 1})`, transition: "transform 0.18s cubic-bezier(0.34,1.56,0.64,1), background 0.18s ease" }}>{tab === "add" && <span key="fabrip" style={{ position: "absolute", top: "50%", left: "50%", width: 58, height: 58, borderRadius: "50%", background: "rgba(255,255,255,0.45)", pointerEvents: "none", animation: "navsplash 0.6s ease-out forwards" }} />}<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" style={{ position: "relative", zIndex: 1 }}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg></button></div></div>}

    {calW && <CalM wallet={calW} currentBal={wBal[calW.id] || 0} onSave={(v, note) => handleCal(calW.id, v, note)} onViewLedger={() => { const wv = calW; sCalW(null); sLedgerW(wv); }} onClose={() => sCalW(null)} />}{recountW && <RecountM wallet={recountW} currentBal={wBal[recountW.id] || 0} onClose={() => sRecountW(null)} />}{ledgerW && (() => { const wid = ledgerW.id; const touches = (it) => it.type === "expense" ? (it.walletId || "upi_lite") === wid : it.type === "income" ? (it.walletId || "bank") === wid : it.type === "transfer" ? (it.fromWallet === wid || it.toWallet === wid) : it.type === "settlement" ? it.walletId === wid : false; const all = [...ex.map(e => ({ ...e, type: "expense" })), ...inc.map(i => ({ ...i, type: "income" })), ...tr.map(t => ({ ...t, type: "transfer" })), ...stl.map(s => ({ ...s, type: "settlement" }))].filter(touches).sort(historySortCompare); const labelFor = (it) => it.type === "expense" ? (cats.find(c => c.id === it.categoryId)?.name || recCats.find(c => c.id === it.categoryId)?.name || "Expense") : it.type === "income" ? (isrc.find(s => s.id === it.sourceId)?.name || "Income") : it.type === "transfer" ? (it.fromWallet === wid ? `Transfer → ${wallets.find(x => x.id === it.toWallet)?.name || "?"}` : `Transfer ← ${wallets.find(x => x.id === it.fromWallet)?.name || "?"}`) : (it.splitName ? `Settle · ${it.splitName}` : "Settlement"); const lastV = walletVerify[wid]?.last; const rowVerified = (it) => { if (!lastV) return false; const precise = it.created_at || it.createdAt || it.updated_at; if (precise) return new Date(precise).getTime() <= lastV.ts; if (!it.date) return false; return it.date <= lastV.date; }; const wD = (it) => { if (it.type === "expense") return (it.walletId || "upi_lite") === wid ? -it.amount : 0; if (it.type === "income") return (it.walletId || "bank") === wid ? it.amount : 0; if (it.type === "transfer") return it.fromWallet === wid ? -it.amount : it.toWallet === wid ? it.amount : 0; if (it.type === "settlement") return it.walletId === wid ? (it.direction === "owed" ? it.amount : -it.amount) : 0; return 0; }; const _txTs = (it) => { const t = it.created_at || it.createdAt || it.updated_at; return t ? new Date(t).getTime() : new Date(it.date + "T23:59:59").getTime(); }; const _cals = (calLog || []).filter(c => c.wId === wid); const _chrono = [...all].sort((a, b) => { const dd = new Date(a.date) - new Date(b.date); if (dd !== 0) return dd; return new Date(a.created_at || a.createdAt || a.updated_at || 0) - new Date(b.created_at || b.createdAt || b.updated_at || 0); }); const _afterById = {}; let _prefix = 0; _chrono.forEach(it => { const _fg = _cals.filter(c => c.ts > _txTs(it)).reduce((s, c) => s + (c.gap || 0), 0); _prefix += wD(it); _afterById[it.id] = (wsb[wid] || 0) - _fg + _prefix; }); const rows = all.map(it => { const d = wD(it); return { id: it.id, label: labelFor(it), date: it.date, note: dispNote(it.note), delta: roundMoney(d), after: roundMoney(_afterById[it.id] ?? 0), verified: rowVerified(it) }; }); const lastVerifyLabel = lastV ? dl(lastV.date) : null; return <LedgerM wallet={ledgerW} rows={rows} curBal={roundMoney(wBal[wid] || 0)} lastVerifyLabel={lastVerifyLabel} onReconcile={() => { const wv = ledgerW; sLedgerW(null); sCalW(wv); }} onClose={() => sLedgerW(null)} />; })()}
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
