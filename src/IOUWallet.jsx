import { useState } from "react";
import { roundMoney, localDateKey } from "./financeUtils";
import { parseAmount } from "./txParsers";

// ── 1:1 IOU "card wallet" ───────────────────────────────────────────────────
// Presentational re-skin of the personal (non-event) split/IOU experience,
// modelled on the "Settle · Card Wallet" mockup but themed to NOMAD's CSS vars
// so it works in both light and dark. It owns ZERO data/settle logic — every
// mutation routes back through the same App handlers the old <Splits> used
// (onAdd / onSettle / onSettleNet / onSkip / onDelete). Group-event splits are
// untouched (they live in the Events tab); this filters to `!eventId`.
//
// Helpers injected as props because they live in App.jsx (the monolith) and are
// not exported: `fmt` (INR formatter), `uid` (client id), `isUpiLite` (wallet
// guard) and `SettleModal` (the existing themed per-IOU settle sheet, reused for
// "record payment" so partial / wallet / cap validation stays identical).

// pure, file-local (mirrors avatarColor / initials in App.jsx)
const PALS = ["#E07A5F", "#6BAA75", "#7B8CDE", "#F4A261", "#81B29A", "#A78BFA", "#F2CC8F", "#E07A5F"];
const avatarColor = name => { let h = 0; for (const c of String(name || "")) h = (h * 31 + c.charCodeAt(0)) & 0xffff; return PALS[h % PALS.length]; };
const initials = name => String(name || "").trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || "").join("") || "?";
const shade = (hex, p) => { try { const n = parseInt(hex.slice(1), 16); let r = n >> 16, g = (n >> 8) & 255, b = n & 255; r = Math.round(r * (1 - p)); g = Math.round(g * (1 - p)); b = Math.round(b * (1 - p)); return `rgb(${r},${g},${b})`; } catch { return hex; } };
const iouDateKey = it => it.date || (it.createdAt ? localDateKey(new Date(it.createdAt)) : (it.created_at ? localDateKey(new Date(it.created_at)) : ""));
const relDate = d => { if (!d) return ""; const t = /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + "T12:00:00") : new Date(d); const diff = Math.round((Date.now() - t) / 864e5); if (Number.isNaN(diff)) return ""; if (diff <= 0) return "Today"; if (diff === 1) return "Yesterday"; if (diff < 7) return diff + "d ago"; return t.toLocaleDateString("en-IN", { day: "numeric", month: "short" }); };

const EMBER = "#E07A5F", MINT = "#6BAA75", VIOLET = "#7B8CDE", AMBER = "#F4A261";

export default function IOUWallet({ splits = [], settlements = [], categories = [], wallets = [], fmt = n => "₹" + n, uid = () => Math.random().toString(36).slice(2), isUpiLite = () => false, SettleModal = null, onAdd = () => {}, onSettle = () => {}, onSettleNet = () => {}, onSkip = () => {}, onDelete = () => {}, onError = () => {} }) {
  const [view, sView] = useState("home");        // home | person
  const [cur, sCur] = useState(null);            // current person name
  const [layout, sLayout] = useState("stack");   // stack | cards | deck
  const [settleTgt, sSettleTgt] = useState(null);// single split → SettleModal
  const [netSheet, sNetSheet] = useState(null);  // person name → whole-person net sheet
  const [delId, sDelId] = useState(null);
  const [adding, sAdding] = useState(false);

  // ── derived: canonical people + nets (mirrors App.jsx Splits aggregation) ──
  const paidBy = {}; settlements.filter(s => s.splitId != null && !s.eventId).forEach(s => { paidBy[s.splitId] = (paidBy[s.splitId] || 0) + s.amount; });
  const remOf = s => roundMoney(s.amount - (paidBy[s.id] || 0));
  const canon = {}; const dispOf = raw => { const k = String(raw || "").trim().toLowerCase(); if (!k) return ""; if (!canon[k]) canon[k] = String(raw).trim(); return canon[k]; };
  const personMap = {}; splits.filter(s => !s.eventId && !s.deleted_at).forEach(s => { const n = dispOf(s.name); if (!n) return; if (!personMap[n]) personMap[n] = { splits: [], net: 0 }; personMap[n].splits.push(s); if (!s.settled && !s.skipped) personMap[n].net += s.direction === "owed" ? remOf(s) : -remOf(s); });
  const people = Object.keys(personMap);
  const isResolved = n => personMap[n].splits.every(s => s.settled || s.skipped);
  const active = people.filter(n => !isResolved(n)).sort((a, b) => Math.abs(personMap[b].net) - Math.abs(personMap[a].net));
  const settledPeople = people.filter(isResolved);
  const owedTot = active.filter(n => personMap[n].net > 0.5).reduce((t, n) => t + personMap[n].net, 0);
  const oweTot = active.filter(n => personMap[n].net < -0.5).reduce((t, n) => t - personMap[n].net, 0);
  const net = roundMoney(owedTot - oweTot);

  const card = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: 16 };

  // ── add-IOU form (shared by home + person) ───────────────────────────────
  const AddForm = ({ fixedName }) => {
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
      if (!fixedName) sAdding(false);
    };
    const accent = dir === "owe" ? EMBER : MINT;
    return <div style={{ ...card, padding: 14, marginTop: 10 }}>
      <div style={{ display: "flex", gap: 7, marginBottom: 10 }}>
        {[["owe", "↓ I owe them"], ["owed", "↑ They owe me"]].map(([d, lbl]) => <button key={d} onClick={() => sDir(d)} style={{ flex: 1, padding: 9, borderRadius: 10, fontSize: 11.5, fontFamily: "var(--font-h)", fontWeight: 700, cursor: "pointer", border: `1.5px solid ${dir === d ? (d === "owe" ? EMBER : MINT) : "var(--border)"}`, background: dir === d ? (d === "owe" ? EMBER + "18" : MINT + "18") : "var(--card)", color: dir === d ? (d === "owe" ? EMBER : MINT) : "var(--muted)" }}>{lbl}</button>)}
      </div>
      {!fixedName && <input value={nm} onChange={e => sNm(e.target.value)} placeholder="Friend's name" style={inp} />}
      {categories.length > 0 && <div style={{ display: "flex", gap: 6, overflowX: "auto", scrollbarWidth: "none", marginBottom: 9, paddingBottom: 2 }}>{categories.map(c => <button key={c.id} onClick={() => sCatId(c.id)} style={{ flexShrink: 0, padding: "6px 11px", borderRadius: 9, fontSize: 11.5, fontFamily: "var(--font-h)", fontWeight: catId === c.id ? 700 : 500, cursor: "pointer", whiteSpace: "nowrap", border: `1.5px solid ${catId === c.id ? c.color : "var(--border)"}`, background: catId === c.id ? c.color + "18" : "var(--card)", color: catId === c.id ? c.color : "var(--muted)", display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 9, height: 9, borderRadius: 3, background: c.color, flexShrink: 0 }} />{c.emoji ? c.emoji + " " : ""}{c.name}</button>)}</div>}
      <div style={{ display: "flex", gap: 7, marginBottom: 9 }}>
        <input type="number" inputMode="decimal" value={amt} onChange={e => sAmt(e.target.value)} placeholder="₹ amount" style={{ ...inp, marginBottom: 0, flex: 1, fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 16 }} />
        <input type="date" value={date} max={localDateKey()} onChange={e => sDate(e.target.value)} style={{ ...inp, marginBottom: 0, flex: "0 0 132px", colorScheme: "light dark" }} />
      </div>
      <input value={note} onChange={e => sNote(e.target.value)} placeholder="Note (optional)" style={inp} />
      <button onClick={submit} style={{ width: "100%", padding: 12, border: "none", borderRadius: 11, cursor: "pointer", color: "#fff", fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 13, background: accent }}>Add IOU</button>
    </div>;
  };

  // ── person card (used by all three layouts) ──────────────────────────────
  const cardInfo = name => {
    const pm = personMap[name]; const n = pm.net; const up = n > 0.5, down = n < -0.5;
    const c1 = avatarColor(name); const c2 = shade(c1, 0.5);
    const open = pm.splits.filter(s => !s.settled && !s.skipped);
    const last = open.slice().sort((a, b) => iouDateKey(b).localeCompare(iouDateKey(a)))[0];
    const sub = open.length ? (last ? `${last.note || (categories.find(c => c.id === last.categoryId)?.name || "IOU")} · ${relDate(last.date || last.createdAt)}` : "") : "All settled";
    return { n, up, down, c1, c2, openCount: open.length, sub, dir: up ? "OWES YOU" : down ? "YOU OWE" : "SETTLED", amt: Math.abs(n) < 0.5 ? "—" : fmt(Math.abs(n)) };
  };
  const pillStyle = d => ({ display: "inline-flex", alignItems: "center", fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 10, padding: "3px 8px", borderRadius: 8, background: d === "up" ? "rgba(255,255,255,.22)" : d === "dn" ? "rgba(0,0,0,.22)" : "rgba(255,255,255,.16)", color: "#fff" });
  const openPerson = name => { sCur(name); sView("person"); sAdding(false); };

  const PersonCard = ({ name }) => {
    const d = cardInfo(name);
    return <div onClick={() => openPerson(name)} style={{ position: "relative", borderRadius: 18, overflow: "hidden", cursor: "pointer", padding: "14px 16px", minHeight: 96, display: "flex", flexDirection: "column", justifyContent: "space-between", background: `linear-gradient(135deg, ${d.c1}, ${d.c2})`, boxShadow: "0 10px 24px -16px #000" }}>
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(150deg, rgba(255,255,255,.18), transparent 45%)", pointerEvents: "none" }} />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", position: "relative" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <span style={{ width: 32, height: 23, borderRadius: 6, background: "linear-gradient(135deg,#ffe7a8,#caa24e)", flexShrink: 0, boxShadow: "inset 0 0 0 1px rgba(0,0,0,.15)" }} />
          <div style={{ minWidth: 0 }}><div style={{ fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 15, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</div><div style={{ fontSize: 10.5, color: "rgba(255,255,255,.82)", fontWeight: 500, marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 180 }}>{d.sub || "No open IOUs"}</div></div>
        </div>
        <span style={pillStyle(d.up ? "up" : d.down ? "dn" : "flat")}>{d.dir}</span>
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", position: "relative", marginTop: 8 }}>
        <div><div style={{ fontSize: 9.5, color: "rgba(255,255,255,.75)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".6px", marginBottom: 2 }}>balance{d.openCount > 1 ? ` · ${d.openCount} IOUs` : ""}</div><div style={{ fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 24, color: "#fff", fontVariantNumeric: "tabular-nums", letterSpacing: "-.6px" }}>{d.amt}</div></div>
        <span style={{ color: "rgba(255,255,255,.7)", fontSize: 20 }}>›</span>
      </div>
    </div>;
  };

  // ── PERSON DETAIL ─────────────────────────────────────────────────────────
  if (view === "person" && cur && personMap[cur]) {
    const pm = personMap[cur]; const n = pm.net; const pos = n > 0.5; const ac = avatarColor(cur);
    const rows = pm.splits.slice().sort((a, b) => { const ra = (a.settled || a.skipped) ? 1 : 0, rb = (b.settled || b.skipped) ? 1 : 0; if (ra !== rb) return ra - rb; return iouDateKey(b).localeCompare(iouDateKey(a)); });
    return <div>
      <div onClick={() => { sView("home"); sCur(null); }} style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--muted)", fontSize: 12.5, fontWeight: 600, fontFamily: "var(--font-h)", cursor: "pointer", padding: "6px 0", marginBottom: 4 }}>‹ Wallet</div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <div style={{ width: 46, height: 46, borderRadius: 14, background: ac, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 16, color: "#fff" }}>{initials(cur)}</div>
        <div><div style={{ fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 18, color: "var(--text)" }}>{cur}</div><div style={{ fontSize: 12.5, fontWeight: 600, marginTop: 2, color: Math.abs(n) < 0.5 ? "var(--muted)" : pos ? MINT : EMBER }}>{Math.abs(n) < 0.5 ? "All settled up ✓" : pos ? `Owes you ${fmt(n)}` : `You owe ${fmt(-n)}`}</div></div>
      </div>
      {Math.abs(n) >= 0.5 && <button onClick={() => sNetSheet(cur)} style={{ width: "100%", border: "none", borderRadius: 13, padding: 13, cursor: "pointer", color: "#fff", fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 13.5, marginBottom: 14, background: pos ? MINT : EMBER }}>✓ Settle up · {pos ? `collect ${fmt(n)}` : `pay ${fmt(-n)}`}</button>}
      {rows.map(s => {
        const done = s.settled && !s.skipped, skip = s.skipped, owe = s.direction === "owe", col = owe ? EMBER : MINT;
        const rem = remOf(s), part = !done && !skip && rem < s.amount - 0.005;
        const c = categories.find(x => x.id === s.categoryId);
        return <div key={s.id} style={{ ...card, borderRadius: 13, marginBottom: 8, overflow: "hidden", opacity: done || skip ? 0.55 : 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 13px" }}>
            <div style={{ width: 28, height: 28, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 13, background: (owe ? EMBER : MINT) + "1f" }}>{c?.emoji || (owe ? "↓" : "↑")}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: "var(--font-h)", fontWeight: 600, fontSize: 13, color: "var(--text)", display: "flex", alignItems: "center", gap: 6 }}>{s.note || c?.name || (owe ? "You owe" : "Owes you")}{done && <span style={tag(MINT)}>Settled</span>}{skip && <span style={tag(AMBER)}>Skipped</span>}{!done && !skip && <span style={tag(col)}>{owe ? "You owe" : "Owes you"}</span>}</div>
              <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 3 }}>{c?.name || "IOU"} · {relDate(s.date || s.createdAt)}{part ? ` · ${fmt(rem)} left` : ""}</div>
            </div>
            <div style={{ textAlign: "right", flexShrink: 0 }}><div style={{ fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 15, color: done || skip ? "var(--muted)" : col, fontVariantNumeric: "tabular-nums" }}>{fmt(s.amount)}</div>{part && <div style={{ fontSize: 9, color: "var(--muted)", fontWeight: 600, marginTop: 1 }}>paid {fmt(roundMoney(s.amount - rem))}</div>}</div>
          </div>
          {delId === s.id && <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 13px", background: EMBER + "12", borderTop: "1px solid var(--border)" }}><span style={{ flex: 1, fontSize: 11, fontFamily: "var(--font-h)", color: EMBER, fontWeight: 600 }}>Delete permanently?</span><button onClick={() => sDelId(null)} style={miniBtn("var(--muted)")}>Cancel</button><button onClick={() => { onDelete(s.id); sDelId(null); }} style={{ ...miniBtn("#fff"), background: EMBER, border: "none" }}>Delete</button></div>}
          {!done && !skip && delId !== s.id && <div style={{ display: "flex", borderTop: "1px solid var(--border)" }}>
            <button onClick={() => sSettleTgt(s)} style={actBtn(MINT, 2)}>⤷ Record payment</button>
            <div style={{ width: 1, background: "var(--border)" }} />
            <button onClick={() => onSkip(s.id)} style={actBtn(AMBER, 1)}>⤼ Skip</button>
            <div style={{ width: 1, background: "var(--border)" }} />
            <button onClick={() => sDelId(s.id)} style={{ ...actBtn(EMBER, 0), flex: "0 0 44px" }}>🗑</button>
          </div>}
        </div>;
      })}
      {!adding ? <button onClick={() => sAdding(true)} style={dashBtn}>＋ Add IOU with {cur}</button> : <AddForm fixedName={cur} />}
      {SettleModal && settleTgt && <SettleModal split={settleTgt} remaining={remOf(settleTgt)} wallets={wallets} onConfirm={(wid, amount, date) => { onSettle(settleTgt.id, wid, amount, date); sSettleTgt(null); }} onClose={() => sSettleTgt(null)} />}
      {netSheet && <NetSheet name={netSheet} pm={personMap[netSheet]} wallets={wallets} fmt={fmt} isUpiLite={isUpiLite} onSettleNet={onSettleNet} onClose={() => sNetSheet(null)} />}
    </div>;
  }

  // ── HOME (card wallet) ────────────────────────────────────────────────────
  const near0 = Math.abs(net) < 0.5;
  const switchBtn = (l, lbl) => <button onClick={() => sLayout(l)} style={{ border: 0, background: layout === l ? "var(--card)" : "transparent", color: layout === l ? "var(--text)" : "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 600, fontSize: 11.5, padding: "6px 13px", borderRadius: 8, cursor: "pointer", boxShadow: layout === l ? "inset 0 0 0 1px var(--border)" : "none" }}>{lbl}</button>;
  return <div>
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
      <div style={{ display: "inline-flex", alignItems: "baseline", gap: 6, padding: "7px 13px", borderRadius: 13, border: "1px solid var(--border)", background: "var(--card)" }}><span style={{ fontSize: 10, color: "var(--muted)", fontWeight: 600, letterSpacing: ".3px" }}>NET</span><b style={{ fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 18, letterSpacing: "-.5px", fontVariantNumeric: "tabular-nums", color: near0 ? "var(--muted)" : net >= 0 ? MINT : EMBER }}>{near0 ? "₹0" : (net >= 0 ? "+" : "−") + fmt(Math.abs(net)).slice(1)}</b></div>
      <div style={{ display: "flex", gap: 14, fontSize: 11.5, fontWeight: 700, fontFamily: "var(--font-h)", fontVariantNumeric: "tabular-nums" }}><span style={{ color: MINT }}>↑ {fmt(owedTot)}</span><span style={{ color: EMBER }}>↓ {fmt(oweTot)}</span></div>
    </div>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 12 }}>
      <div style={{ display: "inline-flex", gap: 3, padding: 3, borderRadius: 11, background: "var(--bg)", border: "1px solid var(--border)" }}>{switchBtn("stack", "Stack")}{switchBtn("cards", "Cards")}{switchBtn("deck", "Deck")}</div>
      <button onClick={() => sAdding(a => !a)} style={{ border: "none", borderRadius: 11, padding: "8px 14px", cursor: "pointer", color: "#fff", background: EMBER, fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 12 }}>＋ New IOU</button>
    </div>
    {adding && <AddForm />}
    {active.length === 0 && people.length === 0 && <div style={{ textAlign: "center", padding: "44px 18px", color: "var(--muted)" }}><div style={{ fontSize: 26, marginBottom: 8 }}>🪶</div><div style={{ fontFamily: "var(--font-h)", color: "var(--text)", fontSize: 14, fontWeight: 700, marginBottom: 4 }}>No IOUs yet</div><div style={{ fontSize: 12 }}>Tap “New IOU” to add your first.</div></div>}

    {active.length > 0 && layout === "cards" && <div style={{ display: "flex", flexDirection: "column", gap: 11, marginTop: adding ? 12 : 0 }}>{active.map(name => <PersonCard key={name} name={name} />)}</div>}
    {active.length > 0 && layout === "stack" && <div style={{ marginTop: adding ? 12 : 0 }}>{active.map((name, i) => <div key={name} style={{ marginTop: i === 0 ? 0 : -54, position: "relative", zIndex: i }}><PersonCard name={name} /></div>)}</div>}
    {active.length > 0 && layout === "deck" && <div style={{ display: "flex", gap: 14, overflowX: "auto", scrollSnapType: "x mandatory", padding: "4px 2px 14px", scrollbarWidth: "none", marginTop: adding ? 12 : 0 }}>{active.map(name => <div key={name} style={{ flex: "0 0 80%", scrollSnapAlign: "center" }}><PersonCard name={name} /></div>)}</div>}

    {settledPeople.length > 0 && <details style={{ marginTop: 14 }}><summary style={{ fontSize: 11.5, color: "var(--muted)", cursor: "pointer", fontFamily: "var(--font-h)", fontWeight: 600 }}>✓ Settled up ({settledPeople.length})</summary><div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>{settledPeople.map(name => <div key={name} onClick={() => openPerson(name)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 13px", ...card, borderRadius: 12, opacity: 0.6, cursor: "pointer" }}><div style={{ width: 30, height: 30, borderRadius: 9, background: avatarColor(name), display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 11, color: "#fff" }}>{initials(name)}</div><span style={{ flex: 1, fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 600, color: "var(--ts)" }}>{name}</span><span style={{ fontSize: 11, color: MINT, fontFamily: "var(--font-h)", fontWeight: 600 }}>✓ settled</span></div>)}</div></details>}

    {SettleModal && settleTgt && <SettleModal split={settleTgt} remaining={remOf(settleTgt)} wallets={wallets} onConfirm={(wid, amount, date) => { onSettle(settleTgt.id, wid, amount, date); sSettleTgt(null); }} onClose={() => sSettleTgt(null)} />}
    {netSheet && <NetSheet name={netSheet} pm={personMap[netSheet]} wallets={wallets} fmt={fmt} isUpiLite={isUpiLite} onSettleNet={onSettleNet} onClose={() => sNetSheet(null)} />}
  </div>;
}

// Whole-person net settle sheet (themed) → routes to App's settleNet, which
// nets owe/owed and validates wallet funds against the net only. Empty amount =
// settle the full net; a smaller amount = partial (settleNet handles the math).
function NetSheet({ name, pm, wallets, fmt, isUpiLite, onSettleNet, onClose }) {
  const n = roundMoney(pm?.net || 0); const absNet = Math.abs(n); const pos = n > 0.5;
  const recv = pos; // receiving money → UPI Lite not allowed
  const opts = recv ? wallets.filter(w => !isUpiLite(w)) : wallets;
  const [wid, sWid] = useState((opts[0] || wallets[0])?.id);
  const [amt, sAmt] = useState(String(absNet));
  const entered = parseAmount(amt); const validEntered = Number.isFinite(entered) && entered > 0;
  const partial = validEntered && roundMoney(entered) < absNet - 0.005;
  const accent = pos ? "#6BAA75" : "#E07A5F";
  return <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
    <div onClick={e => e.stopPropagation()} style={{ background: "var(--card)", borderRadius: "20px 20px 0 0", padding: 22, width: "100%", maxWidth: 430 }}>
      <div style={{ width: 36, height: 4, borderRadius: 99, background: "var(--border)", margin: "0 auto 14px" }} />
      <div style={{ fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 16, color: "var(--text)", marginBottom: 3 }}>Settle with {name}</div>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14 }}>Nets every open IOU — owe and owed cancel to the net.</div>
      <div style={{ textAlign: "center", marginBottom: 14 }}><div style={{ fontSize: 12, color: "var(--muted)" }}>{pos ? `Collect from ${name}` : `Pay ${name}`}</div><div style={{ fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 34, letterSpacing: "-1px", color: accent, margin: "4px 0", fontVariantNumeric: "tabular-nums" }}>{fmt(absNet)}</div></div>
      <div style={{ fontSize: 10, fontFamily: "var(--font-h)", color: "var(--muted)", fontWeight: 600, letterSpacing: ".5px", marginBottom: 6 }}>AMOUNT{partial ? " (PARTIAL)" : ""}</div>
      <input type="number" inputMode="decimal" value={amt} onChange={e => sAmt(e.target.value)} style={{ ...inp, fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 17 }} />
      <div style={{ fontSize: 10, fontFamily: "var(--font-h)", color: "var(--muted)", fontWeight: 600, letterSpacing: ".5px", marginBottom: 7 }}>{pos ? "RECEIVE INTO" : "PAY FROM"}</div>
      <div style={{ display: "flex", gap: 7, marginBottom: 16 }}>{opts.map(w => <button key={w.id} onClick={() => sWid(w.id)} style={{ flex: 1, padding: "9px 5px", borderRadius: 11, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, cursor: "pointer", border: `2px solid ${wid === w.id ? w.color : "var(--border)"}`, background: wid === w.id ? w.color + "15" : "var(--card)" }}><span style={{ width: 14, height: 14, borderRadius: 4, background: w.color }} /><span style={{ fontSize: 9.5, fontFamily: "var(--font-h)", fontWeight: wid === w.id ? 700 : 500, color: wid === w.id ? w.color : "var(--muted)" }}>{w.name}</span></button>)}</div>
      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={onClose} style={{ flex: 1, padding: 13, border: "1.5px solid var(--border)", borderRadius: 12, background: "transparent", color: "var(--muted)", fontFamily: "var(--font-h)", fontSize: 13, cursor: "pointer" }}>Cancel</button>
        <button onClick={ev => { if (ev.currentTarget.disabled) return; ev.currentTarget.disabled = true; const ok = onSettleNet(name, wid, partial ? amt : ""); if (ok !== false) onClose(); else ev.currentTarget.disabled = false; }} style={{ flex: 2, padding: 13, border: "none", borderRadius: 12, background: accent, color: "#fff", fontFamily: "var(--font-h)", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>{pos ? "Collect" : "Pay"} {fmt(partial ? roundMoney(entered) : absNet)} & settle</button>
      </div>
    </div>
  </div>;
}

// shared inline style atoms
const inp = { background: "var(--bg)", border: "1.5px solid var(--border)", borderRadius: 10, padding: "10px 13px", color: "var(--text)", fontSize: 14, fontFamily: "var(--font-b)", outline: "none", width: "100%", boxSizing: "border-box", marginBottom: 9 };
const tag = c => ({ fontSize: 9, fontFamily: "var(--font-h)", fontWeight: 700, padding: "2px 6px", borderRadius: 6, background: c + "20", color: c });
const actBtn = (c, flex) => ({ flex: flex || 1, border: 0, background: "transparent", padding: "9px 4px", cursor: "pointer", fontFamily: "var(--font-h)", fontWeight: 600, fontSize: 11, color: c, display: "flex", alignItems: "center", justifyContent: "center", gap: 4 });
const miniBtn = c => ({ padding: "4px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "transparent", color: c, fontFamily: "var(--font-h)", fontSize: 10, fontWeight: 700, cursor: "pointer" });
const dashBtn = { width: "100%", border: "1px dashed var(--border)", borderRadius: 13, padding: 12, background: "var(--bg)", color: "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 600, fontSize: 12.5, cursor: "pointer", marginTop: 6 };
