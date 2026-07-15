import { useState, useRef, useEffect, useMemo } from "react";
import { roundMoney, localDateKey, defaultSettleWalletId, settlementNetAmount, isSuspiciousExcess } from "./financeUtils";
import { parseAmount } from "./txParsers";
import { useLockBodyScroll } from "./scrollLock";
import { CaretLeft, CaretRight, CheckCircle, ArrowUp, ArrowDown, Plus, Trash, SkipForward, CurrencyInr, Wallet, X, ArrowCounterClockwise, PencilSimple } from "@phosphor-icons/react";

// ── 1:1 IOU "card wallet" — NEUMORPHIC / pastel re-skin ─────────────────────
// The dedicated IOU section. Shows ONE merged net per person (general 1:1 IOUs
// + their event-split shares), but event IOUs are never flattened into the
// personal list — the person view groups them by source and every settle
// routes to the matching App handler (onSettleNet / onSettleEventNet /
// onSettle). Owns ZERO data/settle logic; the Events tab reads the same splits
// state, so both stay in lock-step.
//
// Design language: soft neumorphism. Surfaces share the page background and gain
// depth from paired soft shadows (light highlight top-left + soft dark shadow
// bottom-right). Generous rounding, low contrast, pastel accents. Pressed /
// selected controls use an INSET shadow. Theme-aware via --neu-bg/-lt/-dk vars
// (set on the app root in App.jsx), with inline rgba fallbacks so it degrades.
//
// Interaction:
//  • Home = flat column of person cards (no swipe gestures — the old cascade's
//    stack/spread gesture could wedge the layout). Tap a card to open it.
//  • Quick-add = card MORPH. Tapping + on a card grows that card's rect into a
//    full-screen soft compose panel (shared-element); close shrinks it back.
//    +New IOU morphs from the button. Body scroll locks while it's open.

// pastel avatar / person-card fills. A fixed 8-swatch palette collided fast —
// hash % 8 gave two nearby people the same colour. Instead spin the hue by the
// golden angle (137.5°) per name: consecutive hashes land far apart on the wheel,
// so distinct names read as distinct pastels. Fixed low-sat / high-light keeps
// them soft; ink() still gets a real hex to pick its foreground from.
const hslToHex = (h, s, l) => { s /= 100; l /= 100; const k = n => (n + h / 30) % 12; const a = s * Math.min(l, 1 - l); const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); const to = n => Math.round(255 * f(n)).toString(16).padStart(2, "0"); return "#" + to(0) + to(8) + to(4); };
const avatarColor = name => { let h = 0; for (const c of String(name || "")) h = (h * 31 + c.charCodeAt(0)) & 0xffff; const hue = (h * 137.508) % 360; return hslToHex(hue, 46, 80); };
const initials = name => String(name || "").trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || "").join("") || "?";
const iouDateKey = it => it.date || (it.createdAt ? localDateKey(new Date(it.createdAt)) : (it.created_at ? localDateKey(new Date(it.created_at)) : ""));
const relDate = d => { if (!d) return ""; const t = /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + "T12:00:00") : new Date(d); const diff = Math.round((Date.now() - t) / 864e5); if (Number.isNaN(diff)) return ""; if (diff <= 0) return "Today"; if (diff === 1) return "Yesterday"; if (diff < 7) return diff + "d ago"; return t.toLocaleDateString("en-IN", { day: "numeric", month: "short" }); };

// soft pastel semantics
const MINT = "#7FBE9E", CORAL = "#E89B8B", VIOLET = "#A9A7E0", AMBER = "#E2B978";

// neumorphic atoms (theme-aware vars + rgba fallback)
const SURF = "var(--neu-bg, var(--card))";
const NEU_RAISED = "6px 6px 14px var(--neu-dk,rgba(0,0,0,.16)), -6px -6px 14px var(--neu-lt,rgba(255,255,255,.7))";
const NEU_SM = "4px 4px 9px var(--neu-dk,rgba(0,0,0,.15)), -4px -4px 9px var(--neu-lt,rgba(255,255,255,.65))";
const NEU_INSET = "inset 4px 4px 9px var(--neu-dk,rgba(0,0,0,.18)), inset -4px -4px 9px var(--neu-lt,rgba(255,255,255,.6))";
const RAD = 20, RAD_SM = 14;
const EASE = "cubic-bezier(.2,.85,.25,1)";
// soft foreground for a flat pastel block (gentle dark on light, soft light on dark)
const lum = hex => { try { const n = parseInt(hex.slice(1), 16); return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255); } catch { return 0; } };
const ink = hex => lum(hex) > 140 ? "#46435A" : "#EDEAF2";

// keyboard activation for clickable non-button elements (Enter / Space)
const kbd = fn => e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } };

// signed money label: +₹120 / −₹45 (uses the app's fmt, swaps its ₹ prefix)
const fmtSigned = (v, fmt) => (v > 0 ? "+" : "−") + fmt(Math.abs(v)).slice(1);

// vertical gap between the flat person cards
const GAP = 18;

export default function IOUWallet({ splits = [], settlements = [], categories = [], wallets = [], events = [], fmt = n => "₹" + n, uid = () => Math.random().toString(36).slice(2), isUpiLite = () => false, SettleModal = null, onAdd = () => {}, onSettle = () => {}, onSettleNet = () => {}, onSettleEventNet = () => {}, onSkip = () => {}, onUnskip = () => {}, onDelete = () => {}, onRenamePerson = () => {}, onError = () => {} }) {
  const [view, sView] = useState("home");        // home | person
  const [cur, sCur] = useState(null);            // current person name
  const [settleTgt, sSettleTgt] = useState(null);// single split → SettleModal
  const [netSheet, sNetSheet] = useState(null);  // person name → whole-person net sheet
  const [delId, sDelId] = useState(null);
  const [adding, sAdding] = useState(false);     // person-detail add toggle
  const [seg, sSeg] = useState("personal");      // person-detail pill: personal | events
  const [netBk, sNetBk] = useState(false);       // home Net tile → breakdown sheet
  const [morph, sMorph] = useState(null);        // { name, rect } → card-morph quick-add
  const [renName, sRenName] = useState(null);    // person-detail rename/merge draft (null = closed)
  const [burst, sBurst] = useState(0);           // confetti trigger (increments on a settle)
  const openMorph = (name, rect) => sMorph({ name, rect });

  // ── derived: canonical people + nets (mirrors App.jsx Splits aggregation) ──
  // MERGED NET: event splits are folded in alongside personal IOUs so one
  // person's whole balance — general + every event they're in — lives in one
  // place. They are NEVER flattened together though: each split keeps its
  // eventId, the person-detail view groups them back by source ("General" +
  // one section per event), and settling routes to the matching handler
  // (onSettleNet vs onSettleEventNet) so event ledgers stay intact.
  // Derived wallet model, memoized on its only inputs — App re-renders every
  // 60s from the background pull (plus toasts etc.), and without useMemo this
  // re-walked every split/settlement row on each of those renders for nothing.
  const model = useMemo(() => {
    const evMap = new Map(events.map(e => [e.id, e]));
    // Event IOUs reach this wallet ONLY while their event is explicitly ACTIVE
    // (allowlist, not a completed-blocklist). This keeps out completed events
    // AND the two zombie shapes that used to leak in forever: splits whose
    // event was deleted (orphaned eventId), and events with a missing/legacy
    // status — both invisible in the Events tab (its lists match only
    // "active"/"completed" exactly), so the user had no way to clear them.
    // Every creation path sets status: "active", so healthy data always
    // qualifies; excluded IOUs still live inside their event in the Events tab
    // (payments there credit the wallet as always), and reopening an event
    // brings its pending IOUs back here automatically.
    const activeEv = new Set(events.filter(e => e.status === "active").map(e => e.id));
    const paidBy = {}; settlements.forEach(s => { if (s.splitId != null) paidBy[s.splitId] = (paidBy[s.splitId] || 0) + settlementNetAmount(s); });
    const rem = s => roundMoney(s.amount - (paidBy[s.id] || 0));
    const canon = {}; const dispOf = raw => { const k = String(raw || "").trim().toLowerCase(); if (!k) return ""; if (!canon[k]) canon[k] = String(raw).trim(); return canon[k]; };
    const personMap = {};
    splits.filter(s => !s.deleted_at && (!s.eventId || activeEv.has(s.eventId))).forEach(s => {
      const n = dispOf(s.name); if (!n) return;
      if (!personMap[n]) personMap[n] = { splits: [], net: 0, parts: {} };
      personMap[n].splits.push(s);
      if (s.settled || s.skipped) return;
      const signed = s.direction === "owed" ? rem(s) : -rem(s);
      personMap[n].net += signed;
      // Per-source parts feed the Net-breakdown sheet — accumulated in the SAME
      // pass as net, so the tile and the breakdown that explains it can't drift.
      const pk = s.eventId || "__g__";
      if (!personMap[n].parts[pk]) personMap[n].parts[pk] = { label: s.eventId ? (evMap.get(s.eventId)?.name || "Event") : "General", net: 0 };
      personMap[n].parts[pk].net += signed;
    });
    return { evMap, paidBy, personMap };
  }, [splits, settlements, events]);
  const { paidBy, personMap } = model;
  const evName = id => model.evMap.get(id)?.name || "Event";
  const remOf = s => roundMoney(s.amount - (paidBy[s.id] || 0));
  const catMap = useMemo(() => new Map(categories.map(c => [c.id, c])), [categories]);
  const people = Object.keys(personMap);
  const isResolved = n => personMap[n].splits.every(s => s.settled || s.skipped);
  const active = people.filter(n => !isResolved(n)).sort((a, b) => Math.abs(personMap[b].net) - Math.abs(personMap[a].net));
  const settledPeople = people.filter(isResolved);
  const owedTot = active.filter(n => personMap[n].net > 0.5).reduce((t, n) => t + personMap[n].net, 0);
  const oweTot = active.filter(n => personMap[n].net < -0.5).reduce((t, n) => t - personMap[n].net, 0);
  const net = roundMoney(owedTot - oweTot);

  // person-card display data (pure over personMap + props; not a component)
  const cardInfo = name => {
    const pm = personMap[name]; const n = pm.net; const up = n > 0.5, down = n < -0.5;
    const c1 = avatarColor(name);
    const open = pm.splits.filter(s => !s.settled && !s.skipped);
    const last = open.slice().sort((a, b) => iouDateKey(b).localeCompare(iouDateKey(a)))[0];
    // Subtitle prefers a source summary (general + N events) when the balance
    // spans more than one place, else falls back to the latest IOU's note/date.
    const evCount = new Set(open.filter(s => s.eventId).map(s => s.eventId)).size;
    const hasGen = open.some(s => !s.eventId);
    const srcSummary = evCount > 0 ? `${evCount} event${evCount > 1 ? "s" : ""}${hasGen ? " + general" : ""}` : "";
    const sub = open.length ? (srcSummary || (last ? `${last.note || (catMap.get(last.categoryId)?.name || "IOU")} · ${relDate(last.date || last.createdAt)}` : "")) : "All settled";
    return { n, up, down, c1, openCount: open.length, sub, dir: up ? "Owes you" : down ? "You owe" : "Settled", amt: Math.abs(n) < 0.5 ? "—" : fmt(Math.abs(n)) };
  };
  const openPerson = name => { sCur(name); sView("person"); sAdding(false); sSeg(personMap[name]?.splits.some(s => !s.eventId) ? "personal" : "events"); sMorph(null); sRenName(null); };
  const addFormProps = { categories, uid, onAdd, onError, onDone: () => sAdding(false) };

  // Whole-person "settle everything": ONE atomic call into App's settleNet with
  // an explicit sources scope (general + the nettable events). The handler nets
  // every in-scope IOU in a single pass, validates funds/UPI-Lite against the
  // COMBINED net once, and each settlement record keeps its split's eventId, so
  // event ledgers still reconcile per source. (Looping the per-source handlers
  // here was a real overdraft bug: each loop iteration validated against the
  // same stale wBal snapshot, so two payouts could jointly overdraw a wallet.)
  const settleAllWith = (name, groups, wid, amt) => onSettleNet(name, wid, amt, { general: groups.some(g => !g.eventId), eventIds: groups.filter(g => g.eventId).map(g => g.eventId) });

  // Settle modals shared by BOTH views (person detail + wallet home) — a single
  // definition so the net-settle routing can't drift between render sites.
  const sheets = <>
    {SettleModal && settleTgt && <SettleModal split={settleTgt} remaining={remOf(settleTgt)} wallets={wallets} onConfirm={(wid, amount, date, opts) => { const r = onSettle(settleTgt.id, wid, amount, date, opts); sSettleTgt(null); if (r !== false) sBurst(b => b + 1); }} onClose={() => sSettleTgt(null)} />}
    {netSheet && <NetSheet desc={netSheet} wallets={wallets} fmt={fmt} isUpiLite={isUpiLite} onConfirm={(wid, amt) => { const r = netSheet.all ? settleAllWith(netSheet.name, netSheet.groups, wid, amt) : netSheet.eventId ? onSettleEventNet(netSheet.eventId, netSheet.name, wid, amt) : onSettleNet(netSheet.name, wid, amt); if (r !== false) sBurst(b => b + 1); return r; }} onClose={() => sNetSheet(null)} />}
    {burst > 0 && <Confetti key={burst} />}
  </>;

  // ── PERSON DETAIL ─────────────────────────────────────────────────────────
  if (view === "person" && cur && personMap[cur]) {
    const pm = personMap[cur]; const n = pm.net; const pos = n > 0.5; const ac = avatarColor(cur);
    const sortRows = arr => arr.slice().sort((a, b) => { const ra = (a.settled || a.skipped) ? 1 : 0, rb = (b.settled || b.skipped) ? 1 : 0; if (ra !== rb) return ra - rb; return iouDateKey(b).localeCompare(iouDateKey(a)); });
    // Group this person's IOUs by source: "General" (no eventId) + one section per
    // event. Each group carries its own pending net so it can be settled on its
    // own — general via onSettleNet, an event via onSettleEventNet — keeping the
    // Events tab and this wallet in lock-step (both read the same splits state).
    const groupMap = {}; pm.splits.forEach(s => { const key = s.eventId || "__general__"; if (!groupMap[key]) groupMap[key] = { key, eventId: s.eventId || null, label: s.eventId ? evName(s.eventId) : "General", splits: [], net: 0 }; groupMap[key].splits.push(s); if (!s.settled && !s.skipped) groupMap[key].net += s.direction === "owed" ? remOf(s) : -remOf(s); });
    // canNet decides whether a one-tap net "Settle up" is offered for the group.
    // General → always (onSettleNet). Event → only when every pending IOU is
    // expense-derived (has a groupId), because onSettleEventNet settles those
    // alone; a manual-only event IOU would make the net button a no-op, so we
    // hide it there and let each row settle via its own Record button instead.
    Object.values(groupMap).forEach(g => { if (!g.eventId) { g.canNet = true; return; } const pend = g.splits.filter(s => !s.settled && !s.skipped); g.canNet = pend.length > 0 && pend.every(s => !!s.groupId); });
    const groupList = Object.values(groupMap).sort((a, b) => (a.eventId ? 1 : 0) - (b.eventId ? 1 : 0) || Math.abs(b.net) - Math.abs(a.net));
    // Whole-person settle: offered when 2+ groups still have pending IOUs.
    // Scope = EVERY pending group (manual event IOUs included — App's
    // settleNet handles them), so the button's amount is exactly the header
    // net: what actually changes hands to clear this person completely.
    const pendGroups = groupList.filter(g => g.splits.some(s => !s.settled && !s.skipped));
    // Two-pill layout: "Personal" (general IOUs + add form) and "Events" (every
    // event group). Only one segment renders at a time, so a person with many
    // events no longer produces an endless scroll. When the person only has one
    // kind, the pills are hidden and that kind shows directly.
    const genGroup = groupMap.__general__ || null;
    const evGroups = groupList.filter(g => g.eventId);
    // Pills show whenever the person has ANY event IOUs — even with no personal
    // ones yet, the Personal pill must stay reachable (it holds the only "Add
    // IOU" entry point; an events-only person would otherwise have no way to
    // start a 1:1 IOU). openPerson picks the landing segment by data shape.
    const curSeg = evGroups.length ? seg : "personal";
    const evNetSum = roundMoney(evGroups.reduce((t, g) => t + g.net, 0));
    const segNetTxt = v => Math.abs(v) < 0.005 ? "" : ` ${fmtSigned(v, fmt)}`;
    // Rename person; if the new name matches ANOTHER existing person it becomes
    // a merge — every IOU moves under that person (dupes like "Jay akash" vs
    // "Jayakash" collapse into one row, zero data loss).
    const mergeTarget = renName ? people.find(p => p.toLowerCase() === renName.trim().toLowerCase() && p.toLowerCase() !== cur.toLowerCase()) : null;
    const saveRename = () => {
      const t = (renName || "").trim();
      if (!t || t === cur) { sRenName(null); return; }
      const target = people.find(p => p.toLowerCase() === t.toLowerCase() && p.toLowerCase() !== cur.toLowerCase());
      onRenamePerson(cur, target || t);
      sRenName(null);
      sCur(target || t);
    };
    const renderGroup = g => { const gpos = g.net > 0.5, gactive = Math.abs(g.net) > 0.5; const gcol = gpos ? MINT : CORAL; return <div key={g.key} style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10, paddingLeft: 2 }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>{g.eventId ? <span style={{ fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 800, color: VIOLET, background: VIOLET + "22", padding: "4px 10px", borderRadius: 9, display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 190 }}><span style={{ width: 6, height: 6, borderRadius: 6, background: VIOLET, flexShrink: 0 }} />{g.label}</span> : <span style={{ fontSize: 10.5, fontFamily: "var(--font-h)", fontWeight: 800, color: "var(--muted)", letterSpacing: ".7px", textTransform: "uppercase" }}>General</span>}<span style={{ fontSize: 11.5, fontWeight: 800, fontFamily: "var(--font-h)", color: gactive ? gcol : "var(--muted)", fontVariantNumeric: "tabular-nums" }}>{!gactive ? "settled" : fmtSigned(g.net, fmt)}</span></div>
        {gactive && g.canNet && <button onClick={() => sNetSheet({ name: cur, net: g.net, eventId: g.eventId, label: g.eventId ? g.label : null })} style={{ border: "none", borderRadius: 11, boxShadow: NEU_SM, padding: "6px 13px", cursor: "pointer", background: gcol, color: ink(gcol), fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 11, display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0 }}><CheckCircle size={13} weight="fill" /> Settle up</button>}
      </div>
      {sortRows(g.splits).map(s => {
        const done = s.settled && !s.skipped, skip = s.skipped, owe = s.direction === "owe", col = owe ? CORAL : MINT;
        const rem = remOf(s), part = !done && !skip && rem < s.amount - 0.005;
        const c = catMap.get(s.categoryId);
        const rd = relDate(s.date || s.createdAt);
        return <div key={s.id} style={{ ...neuCard, marginBottom: 12, overflow: "hidden", opacity: done || skip ? 0.6 : 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "12px 14px" }}>
            <div style={{ width: 32, height: 32, borderRadius: 11, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 14, background: SURF, boxShadow: NEU_INSET, color: col }}>{c?.emoji || (owe ? <ArrowDown size={15} weight="bold" color={CORAL} /> : <ArrowUp size={15} weight="bold" color={MINT} />)}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 13, color: "var(--text)", display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}><span title={s.note || ""} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{s.note || c?.name || "IOU"}</span>{done && <span style={{ ...tagS(MINT), flexShrink: 0 }}>Settled</span>}{skip && <span style={{ ...tagS(AMBER), flexShrink: 0 }}>Skipped</span>}{!done && !skip && <span style={{ ...tagS(col), flexShrink: 0 }}>{owe ? "You owe" : "Owes you"}</span>}</div>
              <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 3, fontWeight: 600 }}>{c?.name || "IOU"}{rd ? ` · ${rd}` : ""}{part ? ` · ${fmt(rem)} left` : ""}</div>
            </div>
            <div style={{ textAlign: "right", flexShrink: 0 }}><div style={{ fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 16, color: done || skip ? "var(--muted)" : col, fontVariantNumeric: "tabular-nums" }}>{fmt(s.amount)}</div>{part && <div style={{ fontSize: 9.5, color: "var(--muted)", fontWeight: 600, marginTop: 1 }}>paid {fmt(roundMoney(s.amount - rem))}</div>}</div>
          </div>
          {delId === s.id && <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", background: CORAL + "1f" }}><span style={{ flex: 1, fontSize: 11.5, fontFamily: "var(--font-h)", color: CORAL, fontWeight: 700 }}>Delete permanently?</span><button onClick={() => sDelId(null)} style={miniS("var(--muted)")}>Cancel</button><button onClick={() => { onDelete(s.id); sDelId(null); }} style={{ ...miniS(ink(CORAL)), background: CORAL }}>Delete</button></div>}
          {!done && !skip && delId !== s.id && <div style={{ display: "flex", borderTop: "1px solid var(--border)" }}>
            <button onClick={() => sSettleTgt(s)} style={actS(MINT, 2)}><CurrencyInr size={14} weight="bold" /> Record</button>
            <div style={{ width: 1, background: "var(--border)" }} />
            <button onClick={() => onSkip(s.id)} style={actS(AMBER, 1)}><SkipForward size={14} weight="bold" /> Skip</button>
            <div style={{ width: 1, background: "var(--border)" }} />
            <button onClick={() => sDelId(s.id)} style={{ ...actS(CORAL, 0), flex: "0 0 46px" }}><Trash size={15} weight="bold" /></button>
          </div>}
          {skip && delId !== s.id && <div style={{ display: "flex", borderTop: "1px solid var(--border)" }}>
            <button onClick={() => onUnskip(s.id)} style={actS(MINT, 1)}><ArrowCounterClockwise size={14} weight="bold" /> Restore</button>
            <div style={{ width: 1, background: "var(--border)" }} />
            <button onClick={() => sDelId(s.id)} style={{ ...actS(CORAL, 0), flex: "0 0 46px" }}><Trash size={15} weight="bold" /></button>
          </div>}
        </div>;
      })}
    </div>; };
    return <div>
      <div onClick={() => { sView("home"); sCur(null); }} role="button" tabIndex={0} onKeyDown={kbd(() => { sView("home"); sCur(null); })} aria-label="Back to wallet" style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--muted)", fontSize: 12.5, fontWeight: 700, fontFamily: "var(--font-h)", cursor: "pointer", padding: "7px 12px", marginBottom: 8, borderRadius: 12, background: SURF, boxShadow: NEU_SM }}><CaretLeft size={14} weight="bold" /> Wallet</div>
      <div style={{ display: "flex", alignItems: "center", gap: 13, marginBottom: 16 }}>
        <div style={{ width: 50, height: 50, borderRadius: 16, background: ac, color: ink(ac), display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 17, boxShadow: NEU_SM }}>{initials(cur)}</div>
        <div style={{ minWidth: 0, flex: 1 }}>{renName === null ? <div style={{ fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 19, color: "var(--text)", display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}><span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{cur}</span><button onClick={() => sRenName(cur)} aria-label={`Rename or merge ${cur}`} title="Rename / merge" style={{ border: "none", background: "none", color: "var(--muted)", cursor: "pointer", padding: 3, display: "inline-flex", flexShrink: 0 }}><PencilSimple size={15} /></button></div> : <div><div style={{ display: "flex", alignItems: "center", gap: 7 }}><input value={renName} onChange={e => sRenName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") saveRename(); if (e.key === "Escape") sRenName(null); }} autoFocus aria-label="New name" style={{ ...inpN, marginBottom: 0, padding: "8px 11px", fontSize: 14, fontWeight: 700, flex: 1, minWidth: 0 }} /><button onClick={saveRename} aria-label="Save name" style={{ width: 34, height: 34, border: "none", borderRadius: 11, boxShadow: NEU_SM, background: MINT, color: ink(MINT), display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}><CheckCircle size={16} weight="bold" /></button><button onClick={() => sRenName(null)} aria-label="Cancel rename" style={{ width: 34, height: 34, border: "none", borderRadius: 11, boxShadow: NEU_SM, background: SURF, color: "var(--ts)", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}><X size={15} weight="bold" /></button></div>{mergeTarget && <div style={{ fontSize: 10.5, color: AMBER, fontFamily: "var(--font-h)", fontWeight: 700, marginTop: 5 }}>Merges into “{mergeTarget}” — all IOUs combine under one person.</div>}</div>}<div style={{ fontSize: 12.5, fontWeight: 700, marginTop: 2, color: Math.abs(n) < 0.5 ? "var(--muted)" : pos ? MINT : CORAL }}>{Math.abs(n) < 0.5 ? <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><CheckCircle size={13} weight="fill" /> All settled up</span> : pos ? `Owes you ${fmt(n)}` : `You owe ${fmt(-n)}`}</div></div>
      </div>
      {pendGroups.length > 1 && <button onClick={() => sNetSheet({ name: cur, net: n, all: true, groups: pendGroups.map(g => ({ eventId: g.eventId, net: g.net })), count: pendGroups.length })} style={{ width: "100%", border: "none", borderRadius: RAD_SM, padding: "11px 14px", marginBottom: 14, cursor: "pointer", background: pos ? MINT : CORAL, color: ink(pos ? MINT : CORAL), fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 13, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, boxShadow: NEU_SM }}><CheckCircle size={15} weight="fill" /> Settle everything {fmt(Math.abs(n))}</button>}
      {evGroups.length > 0 && <div style={{ display: "flex", gap: 9, marginBottom: 14 }}>
        {[["personal", "Personal", genGroup?.net || 0], ["events", `Events · ${evGroups.length}`, evNetSum]].map(([id, lbl, v]) => { const on = curSeg === id; return <button key={id} onClick={() => sSeg(id)} aria-pressed={on} style={{ flex: 1, padding: "10px 8px", borderRadius: RAD_SM, border: "none", cursor: "pointer", fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 12, boxShadow: on ? NEU_INSET : NEU_SM, background: on ? (id === "events" ? VIOLET + "2e" : MINT + "2e") : SURF, color: on ? "var(--text)" : "var(--muted)", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, transition: "box-shadow .15s, background .15s" }}>{lbl}<span style={{ fontSize: 10.5, fontWeight: 800, fontVariantNumeric: "tabular-nums", color: Math.abs(v) < 0.005 ? "var(--muted)" : v > 0 ? MINT : CORAL }}>{segNetTxt(v)}</span></button>; })}
      </div>}
      {curSeg === "personal" && genGroup && renderGroup(genGroup)}
      {curSeg === "personal" && !genGroup && <div style={{ ...neuCard, textAlign: "center", padding: "22px 16px", color: "var(--muted)", fontSize: 12, fontWeight: 600, marginBottom: 14 }}>No personal IOUs with {cur} yet.</div>}
      {curSeg === "events" && evGroups.map(renderGroup)}
      <div style={{ display: curSeg === "personal" ? undefined : "none" }}>{!adding ? <button onClick={() => sAdding(true)} style={{ width: "100%", border: "none", borderRadius: RAD_SM, padding: 13, background: SURF, boxShadow: NEU_SM, color: "var(--ts)", fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 12.5, cursor: "pointer", marginTop: 8, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6 }}><Plus size={15} weight="bold" /> Add IOU with {cur}</button> : <AddForm fixedName={cur} {...addFormProps} />}</div>
      {sheets}
    </div>;
  }

  // ── HOME (neumorphic card wallet) ─────────────────────────────────────────
  const near0 = Math.abs(net) < 0.5;
  // Net-tile breakdown rows: straight projection of the memoized model's
  // per-person parts (no second accumulation — see the model comment). Only
  // shaped while the sheet is open.
  const bkRows = !netBk ? [] : people.map(name => ({ name, net: roundMoney(personMap[name].net), parts: Object.values(personMap[name].parts).map(p => ({ ...p, net: roundMoney(p.net) })).filter(p => Math.abs(p.net) > 0.005) })).filter(r => Math.abs(r.net) > 0.005).sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

  return <div>
    <div style={{ display: "flex", alignItems: "stretch", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
      <div onClick={() => sNetBk(true)} role="button" tabIndex={0} onKeyDown={kbd(() => sNetBk(true))} aria-label="Show net breakdown" style={{ ...neuCard, padding: "9px 15px", display: "inline-flex", flexDirection: "column", justifyContent: "center", cursor: "pointer" }}><span style={{ fontSize: 9, color: "var(--muted)", fontWeight: 700, letterSpacing: ".8px", textTransform: "uppercase" }}>Net · tap</span><b style={{ fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 20, letterSpacing: "-.6px", fontVariantNumeric: "tabular-nums", color: near0 ? "var(--muted)" : net >= 0 ? MINT : CORAL }}>{near0 ? "₹0" : (net >= 0 ? "+" : "−") + fmt(Math.abs(net)).slice(1)}</b></div>
      <div style={{ ...neuCard, padding: "9px 15px", display: "flex", alignItems: "center", gap: 14, fontSize: 12, fontWeight: 700, fontFamily: "var(--font-h)", fontVariantNumeric: "tabular-nums" }}><span style={{ color: MINT, display: "inline-flex", alignItems: "center", gap: 3 }}><ArrowUp size={14} weight="bold" /> {fmt(owedTot)}</span><span style={{ color: CORAL, display: "inline-flex", alignItems: "center", gap: 3 }}><ArrowDown size={14} weight="bold" /> {fmt(oweTot)}</span></div>
    </div>
    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
      <button onClick={e => openMorph("__new__", e.currentTarget.getBoundingClientRect())} style={{ border: "none", borderRadius: RAD_SM, boxShadow: NEU_SM, padding: "10px 16px", cursor: "pointer", color: ink(CORAL), background: CORAL, fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 6 }}><Plus size={16} weight="bold" /> New IOU</button>
    </div>

    {active.length === 0 && people.length === 0 && <div style={{ ...neuCard, textAlign: "center", padding: "42px 18px", color: "var(--muted)" }}><div style={{ marginBottom: 12, display: "flex", justifyContent: "center" }}><div style={{ width: 58, height: 58, borderRadius: 18, background: SURF, boxShadow: NEU_INSET, display: "flex", alignItems: "center", justifyContent: "center" }}><Wallet size={28} color="var(--ts)" weight="duotone" /></div></div><div style={{ fontFamily: "var(--font-h)", color: "var(--text)", fontSize: 15, fontWeight: 800, marginBottom: 5 }}>No IOUs yet</div><div style={{ fontSize: 12.5, fontWeight: 500 }}>Tap “New IOU” to add your first.</div></div>}

    {active.length > 0 && <div style={{ display: "flex", flexDirection: "column", gap: GAP }}>
      {active.map(name => <PersonCard key={name} name={name} info={cardInfo(name)} showAdd onOpen={() => openPerson(name)} onQuickAdd={rect => openMorph(name, rect)} />)}
    </div>}

    {settledPeople.length > 0 && <details style={{ marginTop: 18 }}><summary style={{ fontSize: 11.5, color: "var(--muted)", cursor: "pointer", fontFamily: "var(--font-h)", fontWeight: 700 }}><CheckCircle size={12} weight="fill" style={{ verticalAlign: "-2px", marginRight: 4 }} />Settled up ({settledPeople.length})</summary><div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 9 }}>{settledPeople.map(name => <div key={name} onClick={() => openPerson(name)} role="button" tabIndex={0} onKeyDown={kbd(() => openPerson(name))} aria-label={`Open ${name}, settled`} style={{ display: "flex", alignItems: "center", gap: 11, padding: "11px 14px", ...neuCard, opacity: 0.72, cursor: "pointer" }}><div style={{ width: 32, height: 32, borderRadius: 11, background: avatarColor(name), color: ink(avatarColor(name)), display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 12, boxShadow: NEU_SM }}>{initials(name)}</div><span style={{ flex: 1, fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 700, color: "var(--ts)" }}>{name}</span><span style={{ fontSize: 11, color: MINT, fontFamily: "var(--font-h)", fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 3 }}><CheckCircle size={12} weight="fill" /> settled</span><button onClick={e => { e.stopPropagation(); openMorph(name, e.currentTarget.getBoundingClientRect()); }} aria-label={`New IOU with ${name}`} title="New IOU" style={{ width: 30, height: 30, border: "none", borderRadius: 10, boxShadow: NEU_SM, background: SURF, color: "var(--ts)", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}><Plus size={14} weight="bold" /></button></div>)}</div></details>}

    {sheets}
    {morph && <MorphCompose rect={morph.rect} name={morph.name} categories={categories} uid={uid} onAdd={onAdd} onError={onError} suggestions={people} onClose={() => sMorph(null)} />}
    {netBk && <NetBreakdown rows={bkRows} net={net} owedTot={owedTot} oweTot={oweTot} fmt={fmt} onOpenPerson={name => { sNetBk(false); openPerson(name); }} onClose={() => sNetBk(false)} />}
  </div>;
}

// ── card-morph quick-add (module-level; grows from a rect to full-screen) ──
function MorphCompose({ rect, name, categories = [], uid, onAdd, onError = () => {}, suggestions = [], onClose }) {
  const [open, sOpen] = useState(false);
  useLockBodyScroll();
  useEffect(() => { const id = requestAnimationFrame(() => sOpen(true)); return () => cancelAnimationFrame(id); }, []);
  const close = () => { sOpen(false); setTimeout(onClose, 380); };
  const vw = typeof window !== "undefined" ? window.innerWidth : 400, vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const M = 12;
  const isNew = name === "__new__";
  // centered, content-sized card (not full-screen) — free-name needs the extra name field
  const W = Math.min(vw - 2 * M, 440);
  const H = Math.min(vh - 2 * M, isNew ? 472 : 414);
  const pos = { top: Math.max(M, (vh - H) / 2), left: (vw - W) / 2, width: W, height: H };
  const r = rect || { top: pos.top + 40, left: pos.left + W * 0.2, width: W * 0.6, height: 120 };
  // GPU-only morph: the card sits at its FINAL rect and animates `transform`
  // from the source button's rect. Animating top/left/width/height re-layouts
  // every frame under the heavy neumorphic shadows and visibly lags on phones.
  const closedT = `translate(${r.left - pos.left}px, ${r.top - pos.top}px) scale(${r.width / W}, ${r.height / H})`;
  const accent = name === "__new__" ? CORAL : avatarColor(name);
  const at = ink(accent);
  return <div style={{ position: "fixed", inset: 0, zIndex: 260, pointerEvents: open ? "auto" : "none" }}>
    <div onClick={close} style={{ position: "absolute", inset: 0, background: "rgba(20,18,30,.45)", opacity: open ? 1 : 0, transition: "opacity .34s" }} />
    <div style={{ position: "fixed", ...pos, background: SURF, borderRadius: RAD, boxShadow: NEU_RAISED, overflow: "hidden", transform: open ? "translate(0px, 0px) scale(1, 1)" : closedT, transformOrigin: "top left", transition: `transform .38s ${EASE}`, willChange: "transform" }}>
      <div style={{ background: accent, color: at, padding: "16px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", opacity: open ? 1 : 0, transition: "opacity .22s", transitionDelay: open ? ".1s" : "0s" }}>
        <div style={{ minWidth: 0 }}><div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".8px", opacity: .8 }}>New IOU</div><div style={{ fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 23, letterSpacing: "-.3px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name === "__new__" ? "Someone new" : name}</div></div>
        <button onClick={close} aria-label="Close" style={{ width: 38, height: 38, border: "none", borderRadius: 13, background: "rgba(255,255,255,.35)", color: at, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}><X size={20} weight="bold" /></button>
      </div>
      <div style={{ opacity: open ? 1 : 0, transition: "opacity .25s", transitionDelay: open ? ".16s" : "0s", height: "calc(100% - 72px)", overflowY: "auto", padding: 18, boxSizing: "border-box" }}>
        <AddForm fixedName={name === "__new__" ? undefined : name} categories={categories} uid={uid} onAdd={s => { onAdd(s); close(); }} onError={onError} onDone={() => {}} suggestions={suggestions} bare big />
      </div>
    </div>
  </div>;
}

// ── add-IOU form (module-level so it never remounts on a parent render) ──
function AddForm({ fixedName, categories = [], uid, onAdd, onError = () => {}, onDone = () => {}, suggestions = [], bare = false, big = false }) {
  const [dir, sDir] = useState("owed");
  const [nm, sNm] = useState("");
  const [amt, sAmt] = useState("");
  const [note, sNote] = useState("");
  const [catId, sCatId] = useState(categories[0]?.id || "");
  const [date, sDate] = useState(localDateKey());
  const name = fixedName || nm.trim();
  const submit = () => {
    const a = parseAmount(amt);
    if (!name) { onError("Enter a name"); return; }
    if (!Number.isFinite(a) || a <= 0) { onError("Enter a valid amount"); return; }
    onAdd({ id: uid(), name, amount: a, direction: dir, settled: false, note: note.trim() || undefined, categoryId: catId || undefined, date: date || localDateKey() });
    sNm(""); sAmt(""); sNote(""); sDate(localDateKey());
    if (!fixedName) onDone();
  };
  const accent = dir === "owe" ? CORAL : MINT;
  return <div style={bare ? { padding: 0 } : { ...neuCard, padding: 15, marginTop: 12 }}>
    <div style={{ display: "flex", gap: 9, marginBottom: 13 }}>
      {[["owe", ArrowDown, "I owe them"], ["owed", ArrowUp, "They owe me"]].map(([d, Ico, lbl]) => { const ac = d === "owe" ? CORAL : MINT; const on = dir === d; return <button key={d} onClick={() => sDir(d)} style={{ flex: 1, padding: big ? 13 : 11, borderRadius: RAD_SM, fontSize: 12, fontFamily: "var(--font-h)", fontWeight: 700, cursor: "pointer", border: "none", boxShadow: on ? NEU_INSET : NEU_SM, background: on ? ac + "30" : SURF, color: on ? (d === "owe" ? CORAL : MINT) : "var(--muted)", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, transition: "box-shadow .15s, background .15s" }}><Ico size={15} weight="bold" /> {lbl}</button>; })}
    </div>
    {!fixedName && <input value={nm} onChange={e => sNm(e.target.value)} placeholder="Friend's name" style={{ ...inpN, ...(big ? { fontSize: 16 } : {}) }} />}
    {!fixedName && (() => { const q = nm.trim().toLowerCase(); const sugg = suggestions.filter(p => p.toLowerCase() !== q && (!q || p.toLowerCase().includes(q))).slice(0, 6); return sugg.length ? <div style={{ display: "flex", gap: 7, overflowX: "auto", scrollbarWidth: "none", marginBottom: 11, paddingBottom: 2 }}>{sugg.map(p => <button key={p} onClick={() => sNm(p)} style={{ flexShrink: 0, border: "none", borderRadius: 11, boxShadow: NEU_SM, background: SURF, color: "var(--ts)", fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 11.5, padding: "7px 12px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 16, height: 16, borderRadius: 6, background: avatarColor(p), color: ink(avatarColor(p)), display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 8.5, fontWeight: 800 }}>{initials(p)}</span>{p}</button>)}</div> : null; })()}
    {categories.length > 0 && <div style={{ display: "flex", gap: 8, overflowX: "auto", scrollbarWidth: "none", marginBottom: 11, paddingBottom: 4, paddingTop: 2 }}>{categories.map(c => { const on = catId === c.id; return <button key={c.id} onClick={() => sCatId(c.id)} style={{ flexShrink: 0, padding: "8px 12px", borderRadius: 12, fontSize: 11.5, fontFamily: "var(--font-h)", fontWeight: on ? 700 : 600, cursor: "pointer", whiteSpace: "nowrap", border: "none", boxShadow: on ? NEU_INSET : NEU_SM, background: on ? c.color + "33" : SURF, color: on ? "var(--text)" : "var(--muted)", display: "inline-flex", alignItems: "center", gap: 6, transition: "box-shadow .15s, background .15s" }}><span style={{ width: 9, height: 9, borderRadius: 9, background: c.color, flexShrink: 0 }} />{c.emoji ? c.emoji + " " : ""}{c.name}</button>; })}</div>}
    <div style={{ display: "flex", gap: 9, marginBottom: 11 }}>
      <input type="number" inputMode="decimal" value={amt} onChange={e => sAmt(e.target.value)} placeholder="₹ amount" style={{ ...inpN, marginBottom: 0, flex: 1, fontFamily: "var(--font-h)", fontWeight: 800, fontSize: big ? 24 : 18 }} />
      <input type="date" value={date} max={localDateKey()} onChange={e => sDate(e.target.value)} style={{ ...inpN, marginBottom: 0, flex: "0 0 132px", colorScheme: "light dark" }} />
    </div>
    <input value={note} onChange={e => sNote(e.target.value)} placeholder="Note (optional)" style={inpN} />
    <button onClick={submit} style={{ width: "100%", padding: big ? 15 : 13, border: "none", borderRadius: RAD_SM, boxShadow: NEU_SM, cursor: "pointer", color: ink(accent), background: accent, fontFamily: "var(--font-h)", fontWeight: 800, fontSize: big ? 15 : 13.5 }}>Add IOU</button>
  </div>;
}

// ── person card (module-level; pastel neumorphic block; fills its absolute wrapper) ──
function PersonCard({ name, info, onOpen, showAdd = false, onQuickAdd = () => {} }) {
  const d = info;
  const ref = useRef(null);
  const txt = ink(d.c1);
  const sub = "rgba(50,48,72,.62)";
  const glass = "rgba(255,255,255,.42)";
  const quick = e => { e.stopPropagation(); onQuickAdd(ref.current ? ref.current.getBoundingClientRect() : null); };
  return <div ref={ref} onClick={onOpen} role="button" tabIndex={0} onKeyDown={kbd(onOpen)} aria-label={`Open ${name}, ${d.dir.toLowerCase()} ${d.amt}`} style={{ position: "relative", minHeight: 104, boxSizing: "border-box", cursor: "pointer", padding: "14px 16px", display: "flex", flexDirection: "column", justifyContent: "space-between", background: d.c1, borderRadius: RAD, color: txt, overflow: "hidden", boxShadow: NEU_RAISED }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 11, minWidth: 0 }}>
        <span style={{ width: 34, height: 24, borderRadius: 7, background: glass, flexShrink: 0, boxShadow: "inset 1px 1px 2px rgba(255,255,255,.6), inset -1px -1px 2px rgba(0,0,0,.08)" }} />
        <div style={{ minWidth: 0 }}><div style={{ fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 16, letterSpacing: "-.2px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: txt }}>{name}</div><div style={{ fontSize: 10.5, color: sub, fontWeight: 600, marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 180 }}>{d.sub || "No open IOUs"}</div></div>
      </div>
      <span style={{ fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 9.5, padding: "4px 9px", borderRadius: 10, background: glass, color: txt, whiteSpace: "nowrap", flexShrink: 0, textTransform: "uppercase", letterSpacing: ".3px" }}>{d.dir}</span>
    </div>
    <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
      <div><div style={{ fontSize: 9, color: sub, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".7px", marginBottom: 1 }}>balance{d.openCount > 1 ? ` · ${d.openCount} IOUs` : ""}</div><div style={{ fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 26, color: txt, fontVariantNumeric: "tabular-nums", letterSpacing: "-.8px" }}>{d.amt}</div></div>
      {showAdd ? <button onClick={quick} aria-label={`Add IOU with ${name}`} style={{ width: 36, height: 36, border: "none", borderRadius: 12, background: glass, color: txt, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0, boxShadow: "2px 2px 5px rgba(0,0,0,.12), -2px -2px 5px rgba(255,255,255,.45)" }}><Plus size={18} weight="bold" /></button> : <CaretRight size={20} color={txt} weight="bold" />}
    </div>
  </div>;
}

// Net-tile breakdown sheet: every person contributing to the wallet net, with
// their per-source parts (General / each event). Tapping a row jumps into that
// person. Read-only — it exists so a puzzling net (e.g. "−3.5?!") explains
// itself without archaeology. People at or under the ±₹0.50 display threshold
// are listed but flagged as not counted in the tile.
function NetBreakdown({ rows = [], net = 0, owedTot = 0, oweTot = 0, fmt, onOpenPerson = () => {}, onClose }) {
  useLockBodyScroll();
  return <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,18,30,.5)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
    <div onClick={e => e.stopPropagation()} style={{ background: SURF, borderRadius: "24px 24px 0 0", width: "100%", maxWidth: 430, maxHeight: "78vh", boxShadow: NEU_RAISED, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "16px 20px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div><div style={{ fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 16, color: "var(--text)" }}>Net breakdown</div><div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, marginTop: 2, fontVariantNumeric: "tabular-nums" }}><span style={{ color: MINT }}>↑ {fmt(owedTot)}</span> owed to you − <span style={{ color: CORAL }}>↓ {fmt(oweTot)}</span> you owe</div></div>
        <b style={{ fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 22, fontVariantNumeric: "tabular-nums", color: Math.abs(net) < 0.005 ? "var(--muted)" : net >= 0 ? MINT : CORAL, flexShrink: 0 }}>{Math.abs(net) < 0.005 ? "₹0" : fmtSigned(net, fmt)}</b>
      </div>
      <div style={{ overflowY: "auto", padding: "2px 14px 8px" }}>
        {rows.length === 0 && <div style={{ textAlign: "center", color: "var(--muted)", fontSize: 12, fontWeight: 600, padding: "22px 0" }}>Nothing pending — the net is ₹0.</div>}
        {rows.map(r => { const rpos = r.net > 0; const counted = Math.abs(r.net) > 0.5; const ac = avatarColor(r.name); return <div key={r.name} onClick={() => onOpenPerson(r.name)} role="button" tabIndex={0} onKeyDown={kbd(() => onOpenPerson(r.name))} aria-label={`Open ${r.name}`} style={{ display: "flex", alignItems: "center", gap: 11, padding: "11px 10px", borderRadius: RAD_SM, cursor: "pointer", marginBottom: 4 }}>
          <div style={{ width: 34, height: 34, borderRadius: 12, background: ac, color: ink(ac), display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 12, boxShadow: NEU_SM }}>{initials(r.name)}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 13, color: "var(--text)", display: "flex", alignItems: "center", gap: 6 }}>{r.name}{!counted && <span style={tagS(AMBER)}>≤ ₹0.50 · not counted</span>}</div>
            <div style={{ fontSize: 10.5, color: "var(--muted)", fontWeight: 600, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.parts.map(p => `${p.label} ${fmtSigned(p.net, fmt)}`).join(" · ")}</div>
          </div>
          <b style={{ fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 15, fontVariantNumeric: "tabular-nums", color: rpos ? MINT : CORAL, flexShrink: 0 }}>{fmtSigned(r.net, fmt)}</b>
        </div>; })}
      </div>
      <div style={{ padding: "10px 20px 18px" }}>
        <button onClick={onClose} style={{ width: "100%", padding: 13, border: "none", borderRadius: 14, background: SURF, boxShadow: NEU_SM, color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Close</button>
      </div>
    </div>
  </div>;
}

// Whole-person net settle sheet (neumorphic) → routes to App's settleNet, which
// nets owe/owed and validates wallet funds against the net only. Empty amount =
// settle the full net; a smaller amount = partial (settleNet handles the math).
function NetSheet({ desc, wallets, fmt, isUpiLite, onConfirm, onClose }) {
  useLockBodyScroll();
  const name = desc?.name; const n = roundMoney(desc?.net || 0); const absNet = Math.abs(n); const pos = n > 0.5;
  const recv = pos; // receiving money → UPI Lite not allowed
  const opts = recv ? wallets.filter(w => !isUpiLite(w)) : wallets;
  const [wid, sWid] = useState(defaultSettleWalletId(pos ? "owed" : "owe", wallets, isUpiLite));
  const [amt, sAmt] = useState(String(absNet));
  const [armed, sArmed] = useState(false);
  const entered = parseAmount(amt); const validEntered = Number.isFinite(entered) && entered > 0;
  const partial = validEntered && roundMoney(entered) < absNet - 0.005;
  // Overpay (entered > net) is honoured for general/whole-person settles: the
  // wallet takes the real cash and the surplus offsets the write-off ledger.
  // Event-scoped settles stay capped at the net — their amount must line up
  // with the group ledger's grpSettled reconciliation.
  const overAllowed = !desc?.eventId;
  const over = validEntered && overAllowed && roundMoney(entered) > absNet + 0.005;
  const extra = over ? roundMoney(entered - absNet) : 0;
  const bigOver = isSuspiciousExcess(extra, absNet);
  const accent = pos ? MINT : CORAL;
  return <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,18,30,.5)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
    <div onClick={e => e.stopPropagation()} style={{ background: SURF, borderRadius: "24px 24px 0 0", width: "100%", maxWidth: 430, boxShadow: NEU_RAISED, overflow: "hidden" }}>
      <div style={{ background: accent, color: ink(accent), padding: "16px 20px" }}>
        <div style={{ fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 17 }}>Settle with {name}</div>
        <div style={{ fontSize: 11.5, fontWeight: 600, opacity: .82, marginTop: 2 }}>{desc?.all ? `Everything across ${desc.count} sources — settled per source, event ledgers stay intact.` : desc?.label ? `Event · ${desc.label} — nets this event's IOUs.` : "Nets every general IOU — owe and owed cancel."}</div>
      </div>
      <div style={{ padding: 20 }}>
        <div style={{ textAlign: "center", marginBottom: 16 }}><div style={{ fontSize: 10.5, color: "var(--muted)", fontWeight: 700 }}>{pos ? `Collect from ${name}` : `Pay ${name}`}</div><div style={{ fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 36, letterSpacing: "-1.2px", color: accent, margin: "4px 0", fontVariantNumeric: "tabular-nums" }}>{fmt(absNet)}</div></div>
        <div style={{ fontSize: 10, fontFamily: "var(--font-h)", color: "var(--muted)", fontWeight: 700, letterSpacing: ".5px", marginBottom: 7, textTransform: "uppercase" }}>Amount{partial ? " (partial)" : over ? " (includes extra)" : ""}</div>
        <input type="number" inputMode="decimal" value={amt} onChange={e => { sAmt(e.target.value); sArmed(false); }} style={{ ...inpN, fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 18 }} />
        {over && <div style={{ fontSize: 10.5, fontFamily: "var(--font-h)", fontWeight: 700, color: AMBER, margin: "-6px 0 10px" }}>{fmt(extra)} over the {fmt(absNet)} net — extra goes to the wallet and offsets write-offs</div>}
        <div style={{ fontSize: 10, fontFamily: "var(--font-h)", color: "var(--muted)", fontWeight: 700, letterSpacing: ".5px", marginBottom: 8, textTransform: "uppercase" }}>{pos ? "Receive into" : "Pay from"}</div>
        <div style={{ display: "flex", gap: 9, marginBottom: 18 }}>{opts.map(w => { const on = wid === w.id; return <button key={w.id} onClick={() => sWid(w.id)} style={{ flex: 1, padding: "11px 5px", borderRadius: 14, display: "flex", flexDirection: "column", alignItems: "center", gap: 5, cursor: "pointer", border: "none", boxShadow: on ? NEU_INSET : NEU_SM, background: on ? w.color + "30" : SURF, transition: "box-shadow .15s, background .15s" }}><span style={{ width: 14, height: 14, borderRadius: 5, background: w.color }} /><span style={{ fontSize: 9.5, fontFamily: "var(--font-h)", fontWeight: 700, color: on ? "var(--text)" : "var(--muted)" }}>{w.name}</span></button>; })}</div>
        <div style={{ display: "flex", gap: 11 }}>
          <button onClick={onClose} style={{ flex: 1, padding: 13, border: "none", borderRadius: 14, background: SURF, boxShadow: NEU_SM, color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Cancel</button>
          <button onClick={ev => { if (ev.currentTarget.disabled) return; if (bigOver && !armed) { sArmed(true); return; } ev.currentTarget.disabled = true; const ok = onConfirm(wid, partial || over ? amt : ""); if (ok !== false) onClose(); else ev.currentTarget.disabled = false; }} style={{ flex: 2, padding: 13, border: "none", borderRadius: 14, boxShadow: NEU_SM, background: bigOver && armed ? AMBER : accent, color: ink(bigOver && armed ? AMBER : accent), fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>{bigOver && armed ? `Tap again — ${fmt(extra)} extra is intentional` : `${pos ? "Collect" : "Pay"} ${fmt(partial || over ? roundMoney(entered) : absNet)} & settle`}</button>
        </div>
      </div>
    </div>
  </div>;
}

// Lightweight settle celebration — particles animated via the Web Animations
// API (no CSS keyframes / deps), self-cleaning. Re-mounted via a changing `key`
// so each settle replays it. pointer-events:none + aria-hidden = invisible to
// clicks and screen readers.
function Confetti() {
  const ref = useRef(null);
  useEffect(() => {
    const root = ref.current;
    if (!root || typeof root.animate !== "function") return;
    const colors = [CORAL, MINT, VIOLET, AMBER, "#ffffff"];
    const parts = [];
    for (let i = 0; i < 18; i++) {
      const sp = document.createElement("span");
      const sz = 6 + Math.random() * 6;
      sp.style.cssText = `position:absolute;top:42%;left:50%;width:${sz}px;height:${sz * 1.4}px;background:${colors[i % colors.length]};border-radius:2px;will-change:transform,opacity`;
      root.appendChild(sp);
      const ang = Math.random() * Math.PI * 2, dist = 70 + Math.random() * 150;
      const dx = Math.cos(ang) * dist, dy = Math.sin(ang) * dist - 40;
      sp.animate([{ transform: "translate(-50%,-50%) rotate(0deg)", opacity: 1 }, { transform: `translate(${dx}px,${dy}px) rotate(${Math.random() * 720 - 360}deg)`, opacity: 0 }], { duration: 900 + Math.random() * 500, easing: "cubic-bezier(.2,.6,.3,1)", fill: "forwards" });
      parts.push(sp);
    }
    return () => parts.forEach(p => p.remove());
  }, []);
  return <div ref={ref} aria-hidden="true" style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 300, overflow: "hidden" }} />;
}

// shared neumorphic inline style atoms
const neuCard = { background: SURF, border: "none", borderRadius: RAD, boxShadow: NEU_RAISED };
const inpN = { background: SURF, border: "none", borderRadius: RAD_SM, boxShadow: NEU_INSET, padding: "12px 14px", color: "var(--text)", fontSize: 14, fontFamily: "var(--font-b)", outline: "none", width: "100%", boxSizing: "border-box", marginBottom: 10 };
const tagS = c => ({ fontSize: 9, fontFamily: "var(--font-h)", fontWeight: 700, padding: "2px 7px", borderRadius: 7, background: c + "26", color: c });
const actS = (c, flex) => ({ flex: flex || 1, border: 0, background: "transparent", padding: "11px 4px", cursor: "pointer", fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 11.5, color: c, display: "flex", alignItems: "center", justifyContent: "center", gap: 4 });
const miniS = c => ({ padding: "6px 12px", border: "none", borderRadius: 9, background: SURF, boxShadow: NEU_SM, color: c, fontFamily: "var(--font-h)", fontSize: 10.5, fontWeight: 700, cursor: "pointer" });
