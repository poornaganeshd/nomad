import { useState, useRef, useEffect, Fragment } from "react";
import { roundMoney, localDateKey } from "./financeUtils";
import { parseAmount } from "./txParsers";
import { CaretLeft, CaretRight, CaretDown, CaretUp, CheckCircle, ArrowUp, ArrowDown, Plus, Trash, SkipForward, CurrencyInr, Wallet, X, ArrowCounterClockwise } from "@phosphor-icons/react";

// ── 1:1 IOU "card wallet" — NEUMORPHIC / pastel re-skin ─────────────────────
// Presentational re-skin of the personal (non-event) split/IOU experience.
// Owns ZERO data/settle logic — every mutation routes back through the same App
// handlers the old <Splits> used (onAdd / onSettle / onSettleNet / onSkip /
// onDelete). Group-event splits are untouched (Events tab); this filters !eventId.
//
// Design language: soft neumorphism. Surfaces share the page background and gain
// depth from paired soft shadows (light highlight top-left + soft dark shadow
// bottom-right). Generous rounding, low contrast, pastel accents. Pressed /
// selected controls use an INSET shadow. Theme-aware via --neu-bg/-lt/-dk vars
// (set on the app root in App.jsx), with inline rgba fallbacks so it degrades.
//
// Interaction (unchanged):
//  • Home = Apple-Wallet CASCADE. Largest-balance person is the fully-shown FRONT
//    card at the bottom; others peek their header upward. Swipe down (or tap the
//    hint) fans them into a flat list; swipe up restacks. Pure gesture.
//  • Quick-add = card MORPH. Tapping + on a card grows that card's rect into a
//    full-screen soft compose panel (shared-element); close shrinks it back.
//    +New IOU morphs from the button.

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

// cascade geometry
const CARD_H = 118, PEEK = 46, GAP = 18;

export default function IOUWallet({ splits = [], settlements = [], categories = [], wallets = [], events = [], fmt = n => "₹" + n, uid = () => Math.random().toString(36).slice(2), isUpiLite = () => false, SettleModal = null, onAdd = () => {}, onSettle = () => {}, onSettleNet = () => {}, onSettleEventNet = () => {}, onSkip = () => {}, onUnskip = () => {}, onDelete = () => {}, onError = () => {} }) {
  const [view, sView] = useState("home");        // home | person
  const [cur, sCur] = useState(null);            // current person name
  const [layout, sLayout] = useState("stack");   // stack (cascade) | cards (gesture: swipe down spreads, up restacks)
  const [settleTgt, sSettleTgt] = useState(null);// single split → SettleModal
  const [netSheet, sNetSheet] = useState(null);  // person name → whole-person net sheet
  const [delId, sDelId] = useState(null);
  const [adding, sAdding] = useState(false);     // person-detail add toggle
  const [morph, sMorph] = useState(null);        // { name, rect } → card-morph quick-add
  const [burst, sBurst] = useState(0);           // confetti trigger (increments on a settle)
  const touchY = useRef(null);                   // swipe gesture start-Y
  const touchX = useRef(null);                   // start-X (reject diagonal scrolls)
  const openMorph = (name, rect) => sMorph({ name, rect });

  // ── derived: canonical people + nets (mirrors App.jsx Splits aggregation) ──
  // Event splits are now folded in alongside personal IOUs so one person's whole
  // balance — general + every event they're in — lives in one place. Each split
  // keeps its eventId, so the person-detail view groups them back by source and
  // settling routes to the matching handler (onSettleNet vs onSettleEventNet).
  const evName = id => events.find(e => e.id === id)?.name || "Event";
  const paidBy = {}; settlements.filter(s => s.splitId != null).forEach(s => { paidBy[s.splitId] = (paidBy[s.splitId] || 0) + s.amount; });
  const remOf = s => roundMoney(s.amount - (paidBy[s.id] || 0));
  const canon = {}; const dispOf = raw => { const k = String(raw || "").trim().toLowerCase(); if (!k) return ""; if (!canon[k]) canon[k] = String(raw).trim(); return canon[k]; };
  const personMap = {}; splits.filter(s => !s.deleted_at).forEach(s => { const n = dispOf(s.name); if (!n) return; if (!personMap[n]) personMap[n] = { splits: [], net: 0 }; personMap[n].splits.push(s); if (!s.settled && !s.skipped) personMap[n].net += s.direction === "owed" ? remOf(s) : -remOf(s); });
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
    const sub = open.length ? (srcSummary || (last ? `${last.note || (categories.find(c => c.id === last.categoryId)?.name || "IOU")} · ${relDate(last.date || last.createdAt)}` : "")) : "All settled";
    return { n, up, down, c1, openCount: open.length, sub, dir: up ? "Owes you" : down ? "You owe" : "Settled", amt: Math.abs(n) < 0.5 ? "—" : fmt(Math.abs(n)) };
  };
  const openPerson = name => { sCur(name); sView("person"); sAdding(false); sMorph(null); };
  const addFormProps = { categories, uid, onAdd, onError, onDone: () => sAdding(false) };

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
    return <div>
      <div onClick={() => { sView("home"); sCur(null); }} role="button" tabIndex={0} onKeyDown={kbd(() => { sView("home"); sCur(null); })} aria-label="Back to wallet" style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--muted)", fontSize: 12.5, fontWeight: 700, fontFamily: "var(--font-h)", cursor: "pointer", padding: "7px 12px", marginBottom: 8, borderRadius: 12, background: SURF, boxShadow: NEU_SM }}><CaretLeft size={14} weight="bold" /> Wallet</div>
      <div style={{ display: "flex", alignItems: "center", gap: 13, marginBottom: 16 }}>
        <div style={{ width: 50, height: 50, borderRadius: 16, background: ac, color: ink(ac), display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 17, boxShadow: NEU_SM }}>{initials(cur)}</div>
        <div><div style={{ fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 19, color: "var(--text)" }}>{cur}</div><div style={{ fontSize: 12.5, fontWeight: 700, marginTop: 2, color: Math.abs(n) < 0.5 ? "var(--muted)" : pos ? MINT : CORAL }}>{Math.abs(n) < 0.5 ? <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><CheckCircle size={13} weight="fill" /> All settled up</span> : pos ? `Owes you ${fmt(n)}` : `You owe ${fmt(-n)}`}</div></div>
      </div>
      {groupList.map((g, gi) => { const gpos = g.net > 0.5, gactive = Math.abs(g.net) > 0.5; const gcol = gpos ? MINT : CORAL; const firstEv = g.eventId && (gi === 0 || !groupList[gi - 1].eventId); return <Fragment key={g.key}>{firstEv && <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "2px 2px 14px" }}><span style={{ fontSize: 10, fontFamily: "var(--font-h)", fontWeight: 800, color: VIOLET, letterSpacing: ".7px", textTransform: "uppercase", whiteSpace: "nowrap" }}>From events</span><div style={{ flex: 1, height: 1, background: "var(--border)" }} /></div>}<div style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10, paddingLeft: 2 }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>{g.eventId ? <span style={{ fontSize: 11, fontFamily: "var(--font-h)", fontWeight: 800, color: VIOLET, background: VIOLET + "22", padding: "4px 10px", borderRadius: 9, display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 190 }}><span style={{ width: 6, height: 6, borderRadius: 6, background: VIOLET, flexShrink: 0 }} />{g.label}</span> : <span style={{ fontSize: 10.5, fontFamily: "var(--font-h)", fontWeight: 800, color: "var(--muted)", letterSpacing: ".7px", textTransform: "uppercase" }}>General</span>}<span style={{ fontSize: 11.5, fontWeight: 800, fontFamily: "var(--font-h)", color: gactive ? gcol : "var(--muted)", fontVariantNumeric: "tabular-nums" }}>{!gactive ? "settled" : (gpos ? "+" : "−") + fmt(Math.abs(g.net)).slice(1)}</span></div>
          {gactive && g.canNet && <button onClick={() => sNetSheet({ name: cur, net: g.net, eventId: g.eventId, label: g.eventId ? g.label : null })} style={{ border: "none", borderRadius: 11, boxShadow: NEU_SM, padding: "6px 13px", cursor: "pointer", background: gcol, color: ink(gcol), fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 11, display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0 }}><CheckCircle size={13} weight="fill" /> Settle up</button>}
        </div>
        {sortRows(g.splits).map(s => {
        const done = s.settled && !s.skipped, skip = s.skipped, owe = s.direction === "owe", col = owe ? CORAL : MINT;
        const rem = remOf(s), part = !done && !skip && rem < s.amount - 0.005;
        const c = categories.find(x => x.id === s.categoryId);
        return <div key={s.id} style={{ ...neuCard, marginBottom: 12, overflow: "hidden", opacity: done || skip ? 0.6 : 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "12px 14px" }}>
            <div style={{ width: 32, height: 32, borderRadius: 11, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 14, background: SURF, boxShadow: NEU_INSET, color: col }}>{c?.emoji || (owe ? <ArrowDown size={15} weight="bold" color={CORAL} /> : <ArrowUp size={15} weight="bold" color={MINT} />)}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 13, color: "var(--text)", display: "flex", alignItems: "center", gap: 6 }}>{s.note || c?.name || (owe ? "You owe" : "Owes you")}{done && <span style={tagS(MINT)}>Settled</span>}{skip && <span style={tagS(AMBER)}>Skipped</span>}{!done && !skip && <span style={tagS(col)}>{owe ? "You owe" : "Owes you"}</span>}</div>
              <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 3, fontWeight: 600 }}>{c?.name || "IOU"} · {relDate(s.date || s.createdAt)}{part ? ` · ${fmt(rem)} left` : ""}</div>
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
      </div></Fragment>; })}
      {!adding ? <button onClick={() => sAdding(true)} style={{ width: "100%", border: "none", borderRadius: RAD_SM, padding: 13, background: SURF, boxShadow: NEU_SM, color: "var(--ts)", fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 12.5, cursor: "pointer", marginTop: 8, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6 }}><Plus size={15} weight="bold" /> Add IOU with {cur}</button> : <AddForm fixedName={cur} {...addFormProps} />}
      {SettleModal && settleTgt && <SettleModal split={settleTgt} remaining={remOf(settleTgt)} wallets={wallets} onConfirm={(wid, amount, date) => { const r = onSettle(settleTgt.id, wid, amount, date); sSettleTgt(null); if (r !== false) sBurst(b => b + 1); }} onClose={() => sSettleTgt(null)} />}
      {netSheet && <NetSheet desc={netSheet} wallets={wallets} fmt={fmt} isUpiLite={isUpiLite} onConfirm={(wid, amt) => { const r = netSheet.eventId ? onSettleEventNet(netSheet.eventId, netSheet.name, wid, amt) : onSettleNet(netSheet.name, wid, amt); if (r !== false) sBurst(b => b + 1); return r; }} onClose={() => sNetSheet(null)} />}{burst > 0 && <Confetti key={burst} />}
    </div>;
  }

  // ── HOME (neumorphic card wallet) ─────────────────────────────────────────
  const near0 = Math.abs(net) < 0.5;
  const N = active.length;
  const stackH = N > 0 ? (N - 1) * PEEK + CARD_H : 0;
  const spreadH = N > 0 ? N * (CARD_H + GAP) - GAP : 0;
  // cascade: front (biggest, i=0) sits fully-shown at the bottom; the rest peek their
  // header upward. top grows with reverse-rank; z so the front covers the peeks.
  const cardPos = i => layout === "stack"
    ? { top: (N - 1 - i) * PEEK, zIndex: N - i }
    : { top: i * (CARD_H + GAP), zIndex: 1 };

  return <div>
    <div style={{ display: "flex", alignItems: "stretch", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
      <div style={{ ...neuCard, padding: "9px 15px", display: "inline-flex", flexDirection: "column", justifyContent: "center" }}><span style={{ fontSize: 9, color: "var(--muted)", fontWeight: 700, letterSpacing: ".8px", textTransform: "uppercase" }}>Net</span><b style={{ fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 20, letterSpacing: "-.6px", fontVariantNumeric: "tabular-nums", color: near0 ? "var(--muted)" : net >= 0 ? MINT : CORAL }}>{near0 ? "₹0" : (net >= 0 ? "+" : "−") + fmt(Math.abs(net)).slice(1)}</b></div>
      <div style={{ ...neuCard, padding: "9px 15px", display: "flex", alignItems: "center", gap: 14, fontSize: 12, fontWeight: 700, fontFamily: "var(--font-h)", fontVariantNumeric: "tabular-nums" }}><span style={{ color: MINT, display: "inline-flex", alignItems: "center", gap: 3 }}><ArrowUp size={14} weight="bold" /> {fmt(owedTot)}</span><span style={{ color: CORAL, display: "inline-flex", alignItems: "center", gap: 3 }}><ArrowDown size={14} weight="bold" /> {fmt(oweTot)}</span></div>
    </div>
    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
      <button onClick={e => openMorph("__new__", e.currentTarget.getBoundingClientRect())} style={{ border: "none", borderRadius: RAD_SM, boxShadow: NEU_SM, padding: "10px 16px", cursor: "pointer", color: ink(CORAL), background: CORAL, fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 6 }}><Plus size={16} weight="bold" /> New IOU</button>
    </div>

    {active.length === 0 && people.length === 0 && <div style={{ ...neuCard, textAlign: "center", padding: "42px 18px", color: "var(--muted)" }}><div style={{ marginBottom: 12, display: "flex", justifyContent: "center" }}><div style={{ width: 58, height: 58, borderRadius: 18, background: SURF, boxShadow: NEU_INSET, display: "flex", alignItems: "center", justifyContent: "center" }}><Wallet size={28} color="var(--ts)" weight="duotone" /></div></div><div style={{ fontFamily: "var(--font-h)", color: "var(--text)", fontSize: 15, fontWeight: 800, marginBottom: 5 }}>No IOUs yet</div><div style={{ fontSize: 12.5, fontWeight: 500 }}>Tap “New IOU” to add your first.</div></div>}

    {active.length > 0 && <div
      onTouchStart={e => { touchY.current = e.touches[0]?.clientY ?? null; touchX.current = e.touches[0]?.clientX ?? null; }}
      onTouchEnd={e => {
        const sY = touchY.current, sX = touchX.current; touchY.current = null; touchX.current = null;
        if (sY == null) return;
        const dy = (e.changedTouches[0]?.clientY ?? sY) - sY;
        const dx = (e.changedTouches[0]?.clientX ?? (sX ?? 0)) - (sX ?? 0);
        // Deliberate swipe only: needs 64px of travel and must be clearly vertical
        // (|dy| > 1.6·|dx|) so a tap, a short drag, or a diagonal scroll doesn't flip
        // the layout. Was 28px with no direction guard — far too slippery.
        if (Math.abs(dy) < 64 || Math.abs(dy) < Math.abs(dx) * 1.6) return;
        if (dy > 0 && layout === "stack") sLayout("cards"); else if (dy < 0 && layout === "cards") sLayout("stack");
      }}
      style={{ position: "relative", height: layout === "stack" ? stackH : spreadH, transition: `height .42s ${EASE}` }}
    >{active.map((name, i) => <div key={name} style={{ position: "absolute", left: 4, right: 4, height: CARD_H, ...cardPos(i), transition: `top .42s ${EASE}` }}><PersonCard name={name} info={cardInfo(name)} showAdd={layout === "cards"} onOpen={() => layout === "stack" ? sLayout("cards") : openPerson(name)} onQuickAdd={rect => openMorph(name, rect)} /></div>)}</div>}
    {active.length > 0 && layout === "stack" && <div onClick={() => sLayout("cards")} role="button" tabIndex={0} onKeyDown={kbd(() => sLayout("cards"))} aria-label="Spread cards" style={hintStyle}><CaretDown size={15} weight="bold" /> Swipe down to spread{active.length > 1 ? ` · ${active.length} cards` : ""}</div>}
    {active.length > 1 && layout === "cards" && <div onClick={() => sLayout("stack")} role="button" tabIndex={0} onKeyDown={kbd(() => sLayout("stack"))} aria-label="Stack cards" style={hintStyle}><CaretUp size={15} weight="bold" /> Swipe up to stack</div>}

    {settledPeople.length > 0 && <details style={{ marginTop: 18 }}><summary style={{ fontSize: 11.5, color: "var(--muted)", cursor: "pointer", fontFamily: "var(--font-h)", fontWeight: 700 }}><CheckCircle size={12} weight="fill" style={{ verticalAlign: "-2px", marginRight: 4 }} />Settled up ({settledPeople.length})</summary><div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 9 }}>{settledPeople.map(name => <div key={name} onClick={() => openPerson(name)} role="button" tabIndex={0} onKeyDown={kbd(() => openPerson(name))} aria-label={`Open ${name}, settled`} style={{ display: "flex", alignItems: "center", gap: 11, padding: "11px 14px", ...neuCard, opacity: 0.72, cursor: "pointer" }}><div style={{ width: 32, height: 32, borderRadius: 11, background: avatarColor(name), color: ink(avatarColor(name)), display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 12, boxShadow: NEU_SM }}>{initials(name)}</div><span style={{ flex: 1, fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 700, color: "var(--ts)" }}>{name}</span><span style={{ fontSize: 11, color: MINT, fontFamily: "var(--font-h)", fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 3 }}><CheckCircle size={12} weight="fill" /> settled</span></div>)}</div></details>}

    {SettleModal && settleTgt && <SettleModal split={settleTgt} remaining={remOf(settleTgt)} wallets={wallets} onConfirm={(wid, amount, date) => { const r = onSettle(settleTgt.id, wid, amount, date); sSettleTgt(null); if (r !== false) sBurst(b => b + 1); }} onClose={() => sSettleTgt(null)} />}
    {netSheet && <NetSheet desc={netSheet} wallets={wallets} fmt={fmt} isUpiLite={isUpiLite} onConfirm={(wid, amt) => { const r = netSheet.eventId ? onSettleEventNet(netSheet.eventId, netSheet.name, wid, amt) : onSettleNet(netSheet.name, wid, amt); if (r !== false) sBurst(b => b + 1); return r; }} onClose={() => sNetSheet(null)} />}
    {morph && <MorphCompose rect={morph.rect} name={morph.name} categories={categories} uid={uid} onAdd={onAdd} onError={onError} onClose={() => sMorph(null)} />}
    {burst > 0 && <Confetti key={burst} />}
  </div>;
}

// ── card-morph quick-add (module-level; grows from a rect to full-screen) ──
function MorphCompose({ rect, name, categories = [], uid, onAdd, onError = () => {}, onClose }) {
  const [open, sOpen] = useState(false);
  useEffect(() => { const id = requestAnimationFrame(() => sOpen(true)); return () => cancelAnimationFrame(id); }, []);
  const close = () => { sOpen(false); setTimeout(onClose, 380); };
  const vw = typeof window !== "undefined" ? window.innerWidth : 400, vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const M = 12;
  const isNew = name === "__new__";
  // centered, content-sized card (not full-screen) — free-name needs the extra name field
  const W = Math.min(vw - 2 * M, 440);
  const H = Math.min(vh - 2 * M, isNew ? 472 : 414);
  const r = rect || { top: vh / 2 - 60, left: (vw - W) / 2, width: W, height: 120 };
  const pos = open ? { top: Math.max(M, (vh - H) / 2), left: (vw - W) / 2, width: W, height: H } : { top: r.top, left: r.left, width: r.width, height: r.height };
  const accent = name === "__new__" ? CORAL : avatarColor(name);
  const at = ink(accent);
  return <div style={{ position: "fixed", inset: 0, zIndex: 260 }}>
    <div onClick={close} style={{ position: "absolute", inset: 0, background: "rgba(20,18,30,.45)", backdropFilter: "blur(2px)", opacity: open ? 1 : 0, transition: "opacity .34s" }} />
    <div style={{ position: "fixed", ...pos, background: SURF, borderRadius: open ? RAD : RAD, boxShadow: open ? NEU_RAISED : "none", overflow: "hidden", transition: `top .4s ${EASE}, left .4s ${EASE}, width .4s ${EASE}, height .4s ${EASE}, box-shadow .3s` }}>
      <div style={{ background: accent, color: at, padding: "16px 18px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ minWidth: 0 }}><div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".8px", opacity: .8 }}>New IOU</div><div style={{ fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 23, letterSpacing: "-.3px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name === "__new__" ? "Someone new" : name}</div></div>
        <button onClick={close} aria-label="Close" style={{ width: 38, height: 38, border: "none", borderRadius: 13, background: "rgba(255,255,255,.35)", color: at, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}><X size={20} weight="bold" /></button>
      </div>
      <div style={{ opacity: open ? 1 : 0, transition: "opacity .25s", transitionDelay: open ? ".16s" : "0s", height: "calc(100% - 72px)", overflowY: "auto", padding: 18, boxSizing: "border-box" }}>
        <AddForm fixedName={name === "__new__" ? undefined : name} categories={categories} uid={uid} onAdd={s => { onAdd(s); close(); }} onError={onError} onDone={() => {}} bare big />
      </div>
    </div>
  </div>;
}

// ── add-IOU form (module-level so it never remounts on a parent render) ──
function AddForm({ fixedName, categories = [], uid, onAdd, onError = () => {}, onDone = () => {}, bare = false, big = false }) {
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
  return <div ref={ref} onClick={onOpen} role="button" tabIndex={0} onKeyDown={kbd(onOpen)} aria-label={`Open ${name}, ${d.dir.toLowerCase()} ${d.amt}`} style={{ position: "relative", height: "100%", boxSizing: "border-box", cursor: "pointer", padding: "14px 16px", display: "flex", flexDirection: "column", justifyContent: "space-between", background: d.c1, borderRadius: RAD, color: txt, overflow: "hidden", boxShadow: NEU_RAISED }}>
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

// Whole-person net settle sheet (neumorphic) → routes to App's settleNet, which
// nets owe/owed and validates wallet funds against the net only. Empty amount =
// settle the full net; a smaller amount = partial (settleNet handles the math).
function NetSheet({ desc, wallets, fmt, isUpiLite, onConfirm, onClose }) {
  const name = desc?.name; const n = roundMoney(desc?.net || 0); const absNet = Math.abs(n); const pos = n > 0.5;
  const recv = pos; // receiving money → UPI Lite not allowed
  const opts = recv ? wallets.filter(w => !isUpiLite(w)) : wallets;
  const [wid, sWid] = useState((opts[0] || wallets[0])?.id);
  const [amt, sAmt] = useState(String(absNet));
  const entered = parseAmount(amt); const validEntered = Number.isFinite(entered) && entered > 0;
  const partial = validEntered && roundMoney(entered) < absNet - 0.005;
  const accent = pos ? MINT : CORAL;
  return <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,18,30,.5)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
    <div onClick={e => e.stopPropagation()} style={{ background: SURF, borderRadius: "24px 24px 0 0", width: "100%", maxWidth: 430, boxShadow: NEU_RAISED, overflow: "hidden" }}>
      <div style={{ background: accent, color: ink(accent), padding: "16px 20px" }}>
        <div style={{ fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 17 }}>Settle with {name}</div>
        <div style={{ fontSize: 11.5, fontWeight: 600, opacity: .82, marginTop: 2 }}>{desc?.label ? `Event · ${desc.label} — nets this event's IOUs.` : "Nets every general IOU — owe and owed cancel."}</div>
      </div>
      <div style={{ padding: 20 }}>
        <div style={{ textAlign: "center", marginBottom: 16 }}><div style={{ fontSize: 10.5, color: "var(--muted)", fontWeight: 700 }}>{pos ? `Collect from ${name}` : `Pay ${name}`}</div><div style={{ fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 36, letterSpacing: "-1.2px", color: accent, margin: "4px 0", fontVariantNumeric: "tabular-nums" }}>{fmt(absNet)}</div></div>
        <div style={{ fontSize: 10, fontFamily: "var(--font-h)", color: "var(--muted)", fontWeight: 700, letterSpacing: ".5px", marginBottom: 7, textTransform: "uppercase" }}>Amount{partial ? " (partial)" : ""}</div>
        <input type="number" inputMode="decimal" value={amt} onChange={e => sAmt(e.target.value)} style={{ ...inpN, fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 18 }} />
        <div style={{ fontSize: 10, fontFamily: "var(--font-h)", color: "var(--muted)", fontWeight: 700, letterSpacing: ".5px", marginBottom: 8, textTransform: "uppercase" }}>{pos ? "Receive into" : "Pay from"}</div>
        <div style={{ display: "flex", gap: 9, marginBottom: 18 }}>{opts.map(w => { const on = wid === w.id; return <button key={w.id} onClick={() => sWid(w.id)} style={{ flex: 1, padding: "11px 5px", borderRadius: 14, display: "flex", flexDirection: "column", alignItems: "center", gap: 5, cursor: "pointer", border: "none", boxShadow: on ? NEU_INSET : NEU_SM, background: on ? w.color + "30" : SURF, transition: "box-shadow .15s, background .15s" }}><span style={{ width: 14, height: 14, borderRadius: 5, background: w.color }} /><span style={{ fontSize: 9.5, fontFamily: "var(--font-h)", fontWeight: 700, color: on ? "var(--text)" : "var(--muted)" }}>{w.name}</span></button>; })}</div>
        <div style={{ display: "flex", gap: 11 }}>
          <button onClick={onClose} style={{ flex: 1, padding: 13, border: "none", borderRadius: 14, background: SURF, boxShadow: NEU_SM, color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Cancel</button>
          <button onClick={ev => { if (ev.currentTarget.disabled) return; ev.currentTarget.disabled = true; const ok = onConfirm(wid, partial ? amt : ""); if (ok !== false) onClose(); else ev.currentTarget.disabled = false; }} style={{ flex: 2, padding: 13, border: "none", borderRadius: 14, boxShadow: NEU_SM, background: accent, color: ink(accent), fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>{pos ? "Collect" : "Pay"} {fmt(partial ? roundMoney(entered) : absNet)} & settle</button>
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
const hintStyle = { display: "flex", alignItems: "center", justifyContent: "center", gap: 5, marginTop: 14, color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 11.5, fontWeight: 700, cursor: "pointer" };
const tagS = c => ({ fontSize: 9, fontFamily: "var(--font-h)", fontWeight: 700, padding: "2px 7px", borderRadius: 7, background: c + "26", color: c });
const actS = (c, flex) => ({ flex: flex || 1, border: 0, background: "transparent", padding: "11px 4px", cursor: "pointer", fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 11.5, color: c, display: "flex", alignItems: "center", justifyContent: "center", gap: 4 });
const miniS = c => ({ padding: "6px 12px", border: "none", borderRadius: 9, background: SURF, boxShadow: NEU_SM, color: c, fontFamily: "var(--font-h)", fontSize: 10.5, fontWeight: 700, cursor: "pointer" });
