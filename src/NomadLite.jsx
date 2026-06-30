import { useState, useEffect, useMemo, useCallback } from "react";
import { IconChevronLeft, IconRefresh, IconPlus, IconX, IconTrash, IconCircleCheck, IconAlertTriangle, IconCopy, IconBrandWhatsapp, IconPrinter, IconHome, IconBolt, IconAirConditioning, IconDroplet, IconFlame, IconBulb, IconWind, IconWashMachine, IconFridge, IconDeviceTv, IconToolsKitchen2 } from "@tabler/icons-react";
import { LS_KEY, DEFAULT_STATE, loadState, computeSplit, computeTipSplit, uid, avatarColor, groupColor, initials, fmt, pctFmt, guessIcon, ICON_KEYS } from "./nomadLiteSplit";
import { hapticSelection, hapticLight, hapticMedium } from "./haptics";

/*
 * NOMAD Lite — standalone quick-calculator presets that live under the Events tab.
 * First preset: "Current Split" (electricity / shared-utility bill splitter).
 *
 * Theme is GLOBAL: this component relies entirely on the app-level CSS variables
 * (--bg / --card / --text / --ts / --muted / --border / --font-h / --font-b) that
 * App.jsx sets on the root and that flip with the main dark-mode toggle. There is
 * deliberately no local theme switch here.
 *
 * Persistence is localStorage-only (key `nomad-lite-v1`) — Lite data is never
 * written to Supabase. It is a calculator, not synced finance state. Pure split
 * logic + helpers live in ./nomadLiteSplit.js — that module is UNCHANGED by this
 * redesign; the per-group optional `icon` field added here just rides along on the
 * group object (computeSplit spreads it through untouched).
 */

// App-consistent accent palette (terracotta family) — intentional brand colours,
// not theme tokens, so they stay constant across light/dark.
const ACCENT = "#E07A5F";
const ACCENT_DEEP = "#C4603A";
const AMBER = "#C9882B";
const GREEN = "#1D9E75";

// keyboard activation for clickable non-button elements (Enter / Space)
const kbd = fn => e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } };

// ── claymorphism design tokens ──
// Built on the app-level neumorphic CSS vars (--neu-bg / --neu-lt / --neu-dk)
// that App.jsx flips with dark mode, so these soft clay shadows invert with the
// theme automatically. CLAY_RAISED = puffy/inflated element; CLAY_SOFT = lighter
// pop for chips/buttons; CLAY_INSET / CLAY_PRESSED = recessed wells (inputs, track).
const CLAY_RAISED = "6px 6px 16px var(--neu-dk), -6px -6px 16px var(--neu-lt), inset 2px 2px 4px var(--neu-lt), inset -3px -3px 6px var(--neu-dk)";
const CLAY_SOFT = "5px 5px 12px var(--neu-dk), -5px -5px 12px var(--neu-lt)";
const CLAY_INSET = "inset 4px 4px 9px var(--neu-dk), inset -4px -4px 9px var(--neu-lt)";
const CLAY_PRESSED = "inset 3px 3px 7px var(--neu-dk), inset -3px -3px 7px var(--neu-lt)";

// ── small style helpers (claymorphism) ──
const card = { background: "var(--card)", borderRadius: 24, padding: 18, marginBottom: 16, border: "none", boxShadow: CLAY_RAISED };
const inputS = { width: "100%", background: "var(--neu-bg)", border: "none", color: "var(--text)", fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 15, padding: "13px 14px", borderRadius: 14, outline: "none", boxSizing: "border-box", boxShadow: CLAY_INSET };
const labelS = { display: "block", fontSize: 12, fontWeight: 700, color: "var(--ts)", marginBottom: 7, fontFamily: "var(--font-h)" };
const hintS = { fontSize: 11, color: "var(--muted)", marginTop: 7, fontWeight: 600, fontFamily: "var(--font-b)" };
const stepBtn = { width: 48, height: 48, borderRadius: 16, border: "none", background: "var(--neu-bg)", color: "var(--text)", fontSize: 22, fontWeight: 700, cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: CLAY_SOFT };

// ── appliance icons (optional, additive — auto-guessed from the group name) ──
const APPLIANCE_ICONS = { bolt: IconBolt, ac: IconAirConditioning, water: IconDroplet, flame: IconFlame, bulb: IconBulb, fan: IconWind, wash: IconWashMachine, fridge: IconFridge, tv: IconDeviceTv, kitchen: IconToolsKitchen2 };
const GroupIcon = ({ g, size = 18, color }) => { const I = APPLIANCE_ICONS[g.icon] || APPLIANCE_ICONS[guessIcon(g.name)] || IconBolt; return <I size={size} color={color} stroke={2} />; };

// Allocation ring. `size`/`stroke` let the same component serve the hero (compact)
// and any larger use. Center content is supplied by the caller via overlay.
function Donut({ segments, total, size = 168, stroke = 24 }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const segs = segments.filter(s => s.amount > 0.001);
  const lens = segs.map(s => (total > 0 ? s.amount / total : 0) * c);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={stroke} />
      {segs.map((seg, i) => {
        const len = lens[i];
        const before = lens.slice(0, i).reduce((a, b) => a + b, 0);
        return <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={seg.color} strokeWidth={stroke} strokeDasharray={`${len} ${c - len}`} strokeDashoffset={c - before} transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ transition: "stroke-dasharray 0.6s ease, stroke-dashoffset 0.6s ease" }} />;
      })}
    </svg>
  );
}

// ── The Current Split preset (redesigned: segmented live flow) ──
function CurrentSplit({ onToast }) {
  const [st, setSt] = useState(loadState);
  const [seg, setSeg] = useState("bill");          // bill | people | extras | split
  const [evenSplit, setEvenSplit] = useState(false);
  const [view, setView] = useState("cards");       // cards | table (Split panel)
  const [editingPersonId, setEditingPersonId] = useState(null);
  const [expandedGroup, setExpandedGroup] = useState(null);
  const [iconPickGroup, setIconPickGroup] = useState(null);
  const [newPerson, setNewPerson] = useState("");
  const [addingPerson, setAddingPerson] = useState(false);

  // persist
  useEffect(() => { try { localStorage.setItem(LS_KEY, JSON.stringify(st)); } catch { /* quota */ } }, [st]);

  const set = (patch) => setSt(s => ({ ...s, ...(typeof patch === "function" ? patch(s) : patch) }));
  // Bill amounts are free-text strings; strip anything that isn't a digit/dot so
  // a stray "-" or "e" can't make computeSplit/donut math go weird.
  const numOnly = (v) => String(v).replace(/[^0-9.]/g, "");

  // auto-suggest base load = baseRate × (#base members), unless user typed their own
  useEffect(() => {
    if (st.baseTouched) return;
    const rate = Number(st.baseRate) || 0;
    const count = st.baseMembers.length || st.people.length;
    const suggested = count ? String(rate * count) : "";
    if (suggested !== st.baseBill) setSt(s => (s.baseTouched ? s : { ...s, baseBill: suggested }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.baseRate, st.baseMembers, st.people, st.baseTouched]);

  // results are always live now (no Calculate gate)
  const result = useMemo(() => computeSplit(st, { evenSplit }), [st, evenSplit]);

  // people ops (each fires a haptic so taps feel physical even with no toast)
  const addPerson = (name) => { name = name.trim(); if (!name) return; const p = { id: uid("P"), name }; hapticLight(); set(s => ({ people: [...s.people, p], baseMembers: [...s.baseMembers, p.id] })); };
  const removePerson = (id) => { hapticMedium(); set(s => ({ people: s.people.filter(p => p.id !== id), baseMembers: s.baseMembers.filter(x => x !== id), groups: s.groups.map(g => ({ ...g, members: g.members.filter(x => x !== id) })) })); };
  const renamePerson = (id, name) => set(s => ({ people: s.people.map(p => p.id === id ? { ...p, name: name.trim() || p.name } : p) }));
  const toggleBase = (id) => { hapticSelection(); set(s => ({ baseMembers: s.baseMembers.includes(id) ? s.baseMembers.filter(x => x !== id) : [...s.baseMembers, id] })); };

  // group ops (icon defaults to an auto-guess from the name; user can re-pick)
  const addGroup = () => { const id = uid("G"); hapticLight(); set(s => ({ groups: [...s.groups, { id, name: "New appliance", pct: 0, members: [], note: "", icon: "" }] })); return id; };
  const removeGroup = (id) => { hapticMedium(); set(s => ({ groups: s.groups.filter(g => g.id !== id) })); };
  const updateGroup = (id, patch) => set(s => ({ groups: s.groups.map(g => g.id === id ? { ...g, ...patch } : g) }));
  const toggleGroupMember = (gId, pId) => { hapticSelection(); set(s => ({ groups: s.groups.map(g => g.id === gId ? { ...g, members: g.members.includes(pId) ? g.members.filter(x => x !== pId) : [...g.members, pId] } : g) })); };

  const reset = () => { hapticMedium(); setSt(s => ({ ...DEFAULT_STATE, baseRate: s.baseRate, people: s.people, baseMembers: s.baseMembers, groups: s.groups.map(g => ({ ...g })) })); setEvenSplit(false); setSeg("bill"); onToast?.("Started a new bill", "info"); };

  const grand = st.people.reduce((s, p) => s + (result.perPersonTotal[p.id] || 0), 0);
  const shareText = useCallback(() => {
    const name = st.scenarioName.trim() || "Current split";
    let txt = name + "\n";
    st.people.forEach(p => { txt += `${p.name}: ${fmt(result.perPersonTotal[p.id])}\n`; });
    txt += `Total collected: ${fmt(st.people.reduce((s, p) => s + (result.perPersonTotal[p.id] || 0), 0))}`;
    return txt;
  }, [result, st.scenarioName, st.people]);
  const copy = () => { navigator.clipboard?.writeText(shareText()).then(() => onToast?.("Copied to clipboard", "success")).catch(() => onToast?.("Could not copy", "error")); };
  const whatsapp = () => { window.open(`https://wa.me/?text=${encodeURIComponent(shareText())}`, "_blank"); };

  const totalNum = Number(st.totalBill) || 0;
  const baseNum = Number(st.baseBill) || 0;

  // ── donut / bar segments (shared by hero ring + Split bar) ──
  let donutSegments = [], donutTotal = 0, banners = [];
  if (evenSplit) {
    donutSegments = [{ label: "Equal split", amount: result.total, color: ACCENT }];
    donutTotal = result.total;
    banners.push({ kind: "warn", text: `Splitting ${fmt(result.total)} evenly across ${st.people.length} people — base load and appliance groups aren't used here.`, action: "detailed" });
  } else {
    donutSegments = [{ label: "Base load", amount: result.base, color: "var(--muted)" }, ...result.groupBreak.map(g => ({ label: g.name, amount: g.amt, color: g.color }))];
    if (result.unallocated > 0.5) donutSegments.push({ label: "Not yet assigned", amount: result.unallocated, color: "var(--border)" });
    donutTotal = result.base + result.extra;
    if (result.normalized) banners.push({ kind: "warn", text: `Group shares added up to ${pctFmt(result.rawTotalPct)}, so they were auto-scaled to fit 100% of the extra.` });
    if (result.unallocated > 0.5) banners.push({ kind: "warn", text: st.groups.length === 0 ? `No appliance groups yet, so ${fmt(result.unallocated)} of extra isn't assigned to anyone. Add one under Extras.` : `${fmt(result.unallocated)} of extra isn't assigned — give your appliance groups a share % under Extras.` });
    if (st.mode === "manual" && totalNum > 0) { const diff = totalNum - (result.base + result.extra); if (Math.abs(diff) > 0.5) banners.push({ kind: "warn", text: `Total bill (${fmt(totalNum)}) doesn't match base + extra (${fmt(result.base + result.extra)}) — off by ${fmt(Math.abs(diff))}.` }); }
  }
  const visSegs = donutSegments.filter(s => s.amount > 0.001);
  const balanced = !evenSplit ? result.unallocated <= 0.5 && st.groups.length > 0 : st.people.length > 0;
  const perHead = st.people.length ? grand / st.people.length : 0;

  // ── status badge for the hero ──
  const badge = (() => {
    if (st.people.length === 0) return { c: AMBER, bg: AMBER + "1f", icon: <IconAlertTriangle size={14} />, t: "Add people to start" };
    if (evenSplit) return { c: GREEN, bg: GREEN + "1f", icon: <IconCircleCheck size={14} />, t: `Even · ${fmt(perHead)}/head` };
    if (result.unallocated > 0.5) return { c: AMBER, bg: AMBER + "1f", icon: <IconAlertTriangle size={14} />, t: `${fmt(result.unallocated)} unassigned` };
    return { c: GREEN, bg: GREEN + "1f", icon: <IconCircleCheck size={14} />, t: "Balanced" };
  })();

  const segTab = (id, label) => (
    <button key={id} onClick={() => { hapticSelection(); setSeg(id); }} style={{ flex: 1, border: "none", background: seg === id ? "var(--card)" : "transparent", color: seg === id ? "var(--text)" : "var(--muted)", fontFamily: "var(--font-h)", fontWeight: seg === id ? 800 : 700, fontSize: 12.5, padding: "9px 2px", borderRadius: 12, cursor: "pointer", boxShadow: seg === id ? CLAY_SOFT : "none", transition: "box-shadow .2s" }}>{label}</button>
  );

  return (
    <div>
      {/* ── anchored summary hero ── */}
      <div style={{ ...card, display: "flex", alignItems: "center", gap: 14, padding: 16 }}>
        <div style={{ position: "relative", width: 84, height: 84, flexShrink: 0 }}>
          <Donut segments={donutSegments} total={donutTotal} size={84} stroke={11} />
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontSize: 11, fontWeight: 800, fontVariantNumeric: "tabular-nums", color: "var(--text)", fontFamily: "var(--font-h)" }}>{fmt(donutTotal).replace(".00", "")}</span>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 700, fontFamily: "var(--font-b)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{(st.scenarioName.trim() || "This bill")} · total</div>
          <div style={{ fontSize: 26, fontWeight: 800, lineHeight: 1.1, margin: "2px 0", color: "var(--text)", fontFamily: "var(--font-h)", fontVariantNumeric: "tabular-nums" }}>{fmt(donutTotal)}</div>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 700, color: badge.c, background: badge.bg, padding: "3px 9px", borderRadius: 8 }}>{badge.icon}{badge.t}</span>
        </div>
        <button onClick={reset} title="Start new bill" style={{ width: 40, height: 40, borderRadius: 14, border: "none", background: "var(--neu-bg)", color: "var(--ts)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, boxShadow: CLAY_SOFT }}><IconRefresh size={17} /></button>
      </div>

      {/* ── segmented nav ── */}
      <div style={{ display: "flex", gap: 5, background: "var(--neu-bg)", borderRadius: 16, padding: 6, marginBottom: 16, boxShadow: CLAY_PRESSED }}>
        {segTab("bill", "Bill")}{segTab("people", "People")}{segTab("extras", "Extras")}{segTab("split", "Split")}
      </div>

      {/* ── BILL ── */}
      {seg === "bill" && (
        <div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
            <div style={{ background: "var(--card)", border: "none", borderRadius: 20, padding: 14, boxShadow: CLAY_RAISED }}>
              <div style={labelS}>Total bill</div>
              <div style={{ position: "relative" }}>
                <span style={{ position: "absolute", left: 2, top: "50%", transform: "translateY(-50%)", fontWeight: 800, color: "var(--muted)" }}>₹</span>
                <input type="number" min="0" inputMode="decimal" value={st.totalBill} onChange={e => set({ totalBill: numOnly(e.target.value) })} placeholder="0" style={{ ...inputS, padding: "4px 0 4px 16px", fontSize: 22, border: "none", background: "transparent", borderRadius: 0 }} />
              </div>
            </div>
            <div style={{ background: "var(--card)", border: "none", borderRadius: 20, padding: 14, boxShadow: CLAY_RAISED }}>
              <div style={labelS}>Base load</div>
              <div style={{ position: "relative" }}>
                <span style={{ position: "absolute", left: 2, top: "50%", transform: "translateY(-50%)", fontWeight: 800, color: "var(--muted)" }}>₹</span>
                <input type="number" min="0" inputMode="decimal" value={st.baseBill} onChange={e => set({ baseBill: numOnly(e.target.value), baseTouched: true })} placeholder="0" style={{ ...inputS, padding: "4px 0 4px 16px", fontSize: 22, border: "none", background: "transparent", borderRadius: 0 }} />
              </div>
            </div>
          </div>

          <div style={card}>
            <label style={labelS}>Name this bill</label>
            <input value={st.scenarioName} onChange={e => set({ scenarioName: e.target.value })} placeholder="e.g. June 2026" style={{ ...inputS, marginBottom: 14 }} />

            <label style={labelS}>How is the bill divided?</label>
            <div style={{ display: "flex", gap: 5, background: "var(--neu-bg)", borderRadius: 14, padding: 5, marginBottom: 12, boxShadow: CLAY_PRESSED }}>
              {[[false, "Detailed split"], [true, "Split evenly"]].map(([v, l]) => (
                <button key={String(v)} onClick={() => { hapticSelection(); setEvenSplit(v); }} style={{ flex: 1, padding: "10px 4px", borderRadius: 11, border: "none", background: evenSplit === v ? "var(--text)" : "transparent", color: evenSplit === v ? "var(--bg)" : "var(--ts)", fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 12, cursor: "pointer", boxShadow: evenSplit === v ? CLAY_SOFT : "none", transition: "box-shadow .2s" }}>{l}</button>
              ))}
            </div>

            {!evenSplit && <>
              <p style={hintS}>≈ ₹{st.baseRate || 105} × {st.baseMembers.length || 0} people sharing base · base set under People.</p>
              <label style={{ ...labelS, marginTop: 14 }}>How should the extra be worked out?</label>
              <div style={{ display: "flex", background: "var(--neu-bg)", borderRadius: 14, padding: 5, gap: 5, boxShadow: CLAY_PRESSED }}>
                {[["auto", "Auto = Total − Base"], ["manual", "Enter extra myself"]].map(([m, l]) => (
                  <button key={m} onClick={() => { hapticSelection(); set({ mode: m }); }} style={{ flex: 1, padding: "11px 6px", borderRadius: 11, border: "none", background: st.mode === m ? "var(--text)" : "transparent", color: st.mode === m ? "var(--bg)" : "var(--ts)", fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 12, cursor: "pointer", boxShadow: st.mode === m ? CLAY_SOFT : "none", transition: "box-shadow .2s" }}>{l}</button>
                ))}
              </div>
              {st.mode === "manual" && (
                <div style={{ marginTop: 14 }}>
                  <label style={labelS}>Extra amount (₹)</label>
                  <div style={{ position: "relative" }}>
                    <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", fontWeight: 800, color: "var(--muted)" }}>₹</span>
                    <input type="number" min="0" inputMode="decimal" value={st.manualExtra} onChange={e => set({ manualExtra: numOnly(e.target.value) })} placeholder="0" style={{ ...inputS, paddingLeft: 30 }} />
                  </div>
                </div>
              )}
              {st.mode === "auto" && <p style={hintS}>Extra above base = <b style={{ color: "var(--text)" }}>₹{Math.max(0, totalNum - baseNum).toLocaleString("en-IN")}</b>, shared by appliance use. Each rupee lands somewhere — the ring stays full.</p>}
            </>}
            {evenSplit && <p style={hintS}>Whole bill split equally across everyone in People — base load and appliance groups are ignored.</p>}
          </div>
        </div>
      )}

      {/* ── PEOPLE ── */}
      {seg === "people" && (
        <div>
          <div style={{ fontSize: 12, color: "var(--ts)", fontWeight: 700, marginBottom: 9, fontFamily: "var(--font-h)" }}>Who's splitting</div>
          <div style={{ display: "flex", gap: 14, overflowX: "auto", paddingBottom: 8, marginBottom: 6, scrollbarWidth: "none" }}>
            {st.people.map(p => (
              <div key={p.id} style={{ textAlign: "center", flexShrink: 0, width: 54 }}>
                <div onClick={() => setEditingPersonId(editingPersonId === p.id ? null : p.id)} role="button" tabIndex={0} onKeyDown={kbd(() => setEditingPersonId(editingPersonId === p.id ? null : p.id))} aria-label={`Edit ${p.name}`} style={{ width: 46, height: 46, borderRadius: "50%", background: avatarColor(p.id), color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 800, margin: "0 auto", cursor: "pointer", fontFamily: "var(--font-h)", outline: editingPersonId === p.id ? `2px solid var(--text)` : "none", outlineOffset: 2 }}>{initials(p.name)}</div>
                <div style={{ fontSize: 12, marginTop: 5, color: "var(--text)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
              </div>
            ))}
            <div style={{ textAlign: "center", flexShrink: 0, width: 54 }}>
              <div onClick={() => setAddingPerson(a => !a)} role="button" tabIndex={0} onKeyDown={kbd(() => setAddingPerson(a => !a))} aria-label="Add a person" style={{ width: 46, height: 46, borderRadius: "50%", background: "transparent", border: "1px dashed var(--border)", color: "var(--muted)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto", cursor: "pointer" }}><IconPlus size={18} /></div>
              <div style={{ fontSize: 12, marginTop: 5, color: "var(--muted)", fontWeight: 600 }}>Add</div>
            </div>
          </div>

          {st.people.length === 0 && !addingPerson && <div style={{ textAlign: "center", padding: "14px 0", color: "var(--muted)", fontSize: 13, fontWeight: 600 }}>Tap Add to start your household</div>}

          {addingPerson && (
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <input autoFocus value={newPerson} onChange={e => setNewPerson(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { addPerson(newPerson); setNewPerson(""); } }} placeholder="Add a person" style={{ ...inputS, flex: 1 }} />
              <button onClick={() => { addPerson(newPerson); setNewPerson(""); }} style={{ width: 46, borderRadius: 14, border: "none", background: ACCENT, color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, boxShadow: CLAY_SOFT }}><IconPlus size={20} /></button>
            </div>
          )}

          {editingPersonId && st.people.find(p => p.id === editingPersonId) && (
            <div style={{ ...card, padding: 12, display: "flex", alignItems: "center", gap: 8 }}>
              <input key={editingPersonId} autoFocus defaultValue={st.people.find(p => p.id === editingPersonId).name} onBlur={e => renamePerson(editingPersonId, e.target.value)} onKeyDown={e => { if (e.key === "Enter") { renamePerson(editingPersonId, e.target.value); setEditingPersonId(null); } if (e.key === "Escape") setEditingPersonId(null); }} style={{ ...inputS, flex: 1, border: `1.5px solid ${ACCENT}` }} />
              <button onClick={() => { removePerson(editingPersonId); setEditingPersonId(null); }} style={{ width: 40, height: 40, borderRadius: 14, border: "none", background: "var(--neu-bg)", color: "#c0524a", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, boxShadow: CLAY_SOFT }}><IconTrash size={16} /></button>
              <button onClick={() => setEditingPersonId(null)} style={{ width: 40, height: 40, borderRadius: 14, border: "none", background: "var(--neu-bg)", color: "var(--muted)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, boxShadow: CLAY_SOFT }}><IconX size={16} /></button>
            </div>
          )}

          {evenSplit ? (
            <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600, margin: "8px 0", fontFamily: "var(--font-b)", lineHeight: 1.5 }}>Even split is on — base load &amp; appliances are ignored. Everyone pays {fmt(perHead)}. Switch to <b style={{ color: "var(--text)" }}>Detailed split</b> under Bill to use base &amp; appliances.</div>
          ) : (<>
            <div style={{ ...card, padding: 16, marginTop: 4 }}>
              <label style={labelS}>Base rate per person</label>
              <div style={{ display: "flex", alignItems: "stretch", gap: 10 }}>
                <div style={{ position: "relative", flex: 1 }}>
                  <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", fontWeight: 800, color: "var(--muted)" }}>₹</span>
                  <input type="number" min="0" inputMode="decimal" value={st.baseRate} onChange={e => set({ baseRate: numOnly(e.target.value) })} placeholder="105" style={{ ...inputS, paddingLeft: 30 }} />
                </div>
                <button onClick={() => { hapticMedium(); set(s => ({ baseBill: String((Number(s.baseRate) || 0) * (s.baseMembers.length || s.people.length)), baseTouched: false })); }} title="Recalculate base load from this rate" style={{ border: "none", background: ACCENT, color: "#fff", fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 12.5, padding: "0 16px", borderRadius: 14, cursor: "pointer", flexShrink: 0, boxShadow: CLAY_SOFT }}>Apply</button>
              </div>
              <p style={hintS}>Default ₹/person for the fixed base load. Base load auto-fills to <b style={{ color: "var(--text)" }}>rate × people sharing base</b> ({st.baseMembers.length || st.people.length || 0}) = <b style={{ color: "var(--text)" }}>₹{((Number(st.baseRate) || 0) * (st.baseMembers.length || st.people.length || 0)).toLocaleString("en-IN")}</b> — until you type a base load yourself on Bill.</p>
            </div>
            <div style={{ fontSize: 12, color: "var(--ts)", fontWeight: 700, margin: "8px 0 8px", fontFamily: "var(--font-h)", display: "flex", alignItems: "center", gap: 6 }}><IconHome size={14} />Shares base load · {fmt(result.basePerPerson)} each</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
              {st.people.length === 0 && <span style={{ fontSize: 12.5, color: "var(--muted)", fontWeight: 700 }}>Add people first</span>}
              {st.people.map(p => {
                const on = st.baseMembers.includes(p.id);
                return (
                  <button key={p.id} onClick={() => toggleBase(p.id)} style={{ display: "flex", alignItems: "center", gap: 7, background: on ? ACCENT + "1f" : "var(--neu-bg)", border: "none", borderRadius: 22, padding: "5px 13px 5px 5px", cursor: "pointer", boxShadow: on ? `inset 0 0 0 1.5px ${ACCENT}, ${CLAY_SOFT}` : CLAY_SOFT }}>
                    <div style={{ width: 26, height: 26, borderRadius: "50%", background: avatarColor(p.id), display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 10, fontFamily: "var(--font-h)" }}>{initials(p.name)}</div>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: on ? ACCENT_DEEP : "var(--ts)" }}>{on ? "✓ " : ""}{p.name}</span>
                  </button>
                );
              })}
            </div>
          </>)}
        </div>
      )}

      {/* ── EXTRAS ── */}
      {seg === "extras" && (
        <div>
          {st.groups.length === 0 && <div style={{ textAlign: "center", padding: "18px 0", color: "var(--muted)", fontSize: 13, fontWeight: 600, lineHeight: 1.5 }}>No appliance / extra groups yet — add induction, AC, washing machine, or anything that adds to the bill.</div>}
          {st.groups.map((g, idx) => {
            const gb = result.groupBreak.find(x => x.id === g.id);
            const memberNames = st.people.filter(p => g.members.includes(p.id)).map(p => p.name).join(", ") || "no one yet";
            const open = expandedGroup === g.id;
            return (
              <div key={g.id} style={{ borderBottom: "0.5px solid var(--border)" }}>
                <div onClick={() => { hapticSelection(); setExpandedGroup(open ? null : g.id); setIconPickGroup(null); }} role="button" tabIndex={0} aria-expanded={open} aria-label={`Edit ${g.name}`} onKeyDown={kbd(() => { setExpandedGroup(open ? null : g.id); setIconPickGroup(null); })} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 0", cursor: "pointer" }}>
                  <div style={{ width: 34, height: 34, borderRadius: 9, background: groupColor(idx) + "22", color: groupColor(idx), display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><GroupIcon g={g} size={18} color={groupColor(idx)} /></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text)", fontFamily: "var(--font-h)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.name}</div>
                    <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{memberNames} · {pctFmt(gb ? gb.effPct : (Number(g.pct) || 0))} of extra</div>
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: groupColor(idx), fontFamily: "var(--font-h)", flexShrink: 0 }}>{fmt(gb ? gb.amt : 0)}</div>
                </div>

                {open && (
                  <div style={{ ...card, marginTop: 0, marginBottom: 12, background: "var(--neu-bg)", boxShadow: CLAY_INSET }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <button onClick={() => setIconPickGroup(iconPickGroup === g.id ? null : g.id)} title="Pick icon" style={{ width: 38, height: 38, borderRadius: 10, background: groupColor(idx) + "22", color: groupColor(idx), border: "none", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, cursor: "pointer" }}><GroupIcon g={g} size={19} color={groupColor(idx)} /></button>
                      <input value={g.name} onChange={e => updateGroup(g.id, { name: e.target.value })} style={{ ...inputS, flex: 1 }} />
                      <div style={{ display: "flex", alignItems: "center", gap: 4, background: "var(--card)", borderRadius: 13, padding: "0 10px", border: "none", boxShadow: CLAY_SOFT }}>
                        <input type="number" min="0" max="100" value={g.pct} onChange={e => updateGroup(g.id, { pct: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} style={{ width: 38, background: "transparent", border: "none", textAlign: "right", fontWeight: 800, fontSize: 14, color: "var(--text)", outline: "none", fontFamily: "var(--font-h)", padding: "10px 0" }} />
                        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)" }}>%</span>
                      </div>
                    </div>

                    {iconPickGroup === g.id && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 10 }}>
                        {ICON_KEYS.map(k => { const I = APPLIANCE_ICONS[k]; const on = (g.icon || guessIcon(g.name)) === k; return <button key={k} onClick={() => { updateGroup(g.id, { icon: k }); setIconPickGroup(null); }} style={{ width: 38, height: 38, borderRadius: 10, background: on ? groupColor(idx) + "22" : "var(--card)", color: on ? groupColor(idx) : "var(--ts)", border: `1.5px solid ${on ? groupColor(idx) : "var(--border)"}`, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}><I size={18} stroke={2} /></button>; })}
                      </div>
                    )}

                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
                      {st.people.length === 0 && <span style={{ fontSize: 12.5, color: "var(--muted)", fontWeight: 700 }}>Add people under People first</span>}
                      {st.people.map(p => {
                        const on = g.members.includes(p.id);
                        return (
                          <button key={p.id} onClick={() => toggleGroupMember(g.id, p.id)} style={{ display: "flex", alignItems: "center", gap: 7, background: on ? ACCENT + "1f" : "var(--card)", border: "none", borderRadius: 22, padding: "5px 13px 5px 5px", cursor: "pointer", boxShadow: on ? `inset 0 0 0 1.5px ${ACCENT}, ${CLAY_SOFT}` : CLAY_SOFT }}>
                            <div style={{ width: 26, height: 26, borderRadius: "50%", background: avatarColor(p.id), display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 10, fontFamily: "var(--font-h)" }}>{initials(p.name)}</div>
                            <span style={{ fontSize: 12, fontWeight: 700, color: on ? ACCENT_DEEP : "var(--ts)" }}>{on ? "✓ " : ""}{p.name}</span>
                          </button>
                        );
                      })}
                    </div>
                    <input value={g.note || ""} onChange={e => updateGroup(g.id, { note: e.target.value })} placeholder="Add a note (optional) — e.g. used after 8pm" style={{ width: "100%", background: "transparent", border: "none", borderTop: "1px dashed var(--border)", marginTop: 12, padding: "10px 0 0", fontSize: 12, fontWeight: 600, color: "var(--ts)", outline: "none", boxSizing: "border-box", fontFamily: "var(--font-b)" }} />
                    <button onClick={() => { removeGroup(g.id); setExpandedGroup(null); }} style={{ marginTop: 10, border: "none", background: "transparent", color: "#c0524a", fontWeight: 700, fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", gap: 5, padding: 0, fontFamily: "var(--font-h)" }}><IconTrash size={14} />Remove appliance</button>
                  </div>
                )}
              </div>
            );
          })}
          <button onClick={() => { const id = addGroup(); setExpandedGroup(id); setIconPickGroup(null); }} style={{ width: "100%", marginTop: 14, border: "1px dashed var(--border)", background: "transparent", fontSize: 12.5, fontWeight: 700, padding: 12, borderRadius: 12, color: "var(--ts)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontFamily: "var(--font-h)" }}><IconPlus size={15} />Add appliance / extra</button>
        </div>
      )}

      {/* ── SPLIT ── */}
      {seg === "split" && (
        <div>
          {visSegs.length > 0 && (
            <div style={{ display: "flex", height: 10, borderRadius: 6, overflow: "hidden", marginBottom: 10 }}>
              {visSegs.map((s, i) => <div key={i} style={{ width: `${donutTotal > 0 ? (s.amount / donutTotal) * 100 : 0}%`, background: s.color, transition: "width 0.5s ease" }} />)}
            </div>
          )}

          {banners.map((b, i) => (
            <div key={i} style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: "12px 13px", borderRadius: 12, fontSize: 12.5, fontWeight: 700, lineHeight: 1.45, marginBottom: 12, background: AMBER + "1f", color: AMBER }}>
              <IconAlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{b.text}{b.action === "detailed" && <button onClick={() => setEvenSplit(false)} style={{ background: "none", border: "none", color: AMBER, fontWeight: 800, textDecoration: "underline", cursor: "pointer", marginLeft: 4, fontSize: 12.5 }}>Use detailed split instead</button>}</span>
            </div>
          ))}

          <div style={{ display: "flex", background: "var(--neu-bg)", borderRadius: 14, padding: 5, gap: 5, marginBottom: 14, boxShadow: CLAY_PRESSED }}>
            {[["cards", "Cards"], ["table", "Table"]].map(([v, l]) => (
              <button key={v} onClick={() => { hapticSelection(); setView(v); }} style={{ flex: 1, padding: "10px 6px", borderRadius: 11, border: "none", background: view === v ? "var(--text)" : "transparent", color: view === v ? "var(--bg)" : "var(--ts)", fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 12, cursor: "pointer", boxShadow: view === v ? CLAY_SOFT : "none", transition: "box-shadow .2s" }}>{l}</button>
            ))}
          </div>

          {st.people.length === 0 ? (
            <div style={{ textAlign: "center", padding: "26px 0", color: "var(--muted)", fontSize: 13, fontWeight: 600 }}>Add people to see the split</div>
          ) : view === "cards" ? (
            <div>
              {st.people.map(p => {
                const lines = evenSplit ? [] : result.groupBreak.filter(g => g.members.includes(p.id));
                const baseAmt = evenSplit ? 0 : (st.baseMembers.includes(p.id) ? result.basePerPerson : 0);
                const tags = evenSplit ? "Equal share" : ([st.baseMembers.includes(p.id) ? "Base" : null, ...lines.map(g => g.name)].filter(Boolean).join(" · ") || "No charges");
                return (
                  <div key={p.id} style={{ ...card, padding: 14 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                      <div style={{ width: 36, height: 36, borderRadius: "50%", background: avatarColor(p.id), display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 13, flexShrink: 0, fontFamily: "var(--font-h)" }}>{initials(p.name)}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 800, fontSize: 14.5, color: "var(--text)", fontFamily: "var(--font-h)" }}>{p.name}</div>
                        <div style={{ fontSize: 11.5, color: "var(--muted)", fontWeight: 700, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tags}</div>
                      </div>
                      <span style={{ fontWeight: 800, fontSize: 16.5, fontVariantNumeric: "tabular-nums", color: "var(--text)", fontFamily: "var(--font-h)" }}>{fmt(result.perPersonTotal[p.id])}</span>
                    </div>
                    {!evenSplit && (
                      <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px dashed var(--border)" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "3px 0", color: "var(--ts)", fontWeight: 700 }}><span>Base load</span><span>{fmt(baseAmt)}</span></div>
                        {lines.map(g => <div key={g.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "3px 0", color: "var(--ts)", fontWeight: 700 }}><span>{g.name}</span><span>{fmt(g.share)}</span></div>)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ overflowX: "auto", background: "var(--card)", borderRadius: 20, border: "none", boxShadow: CLAY_RAISED }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                <thead>
                  <tr>
                    <th style={{ padding: "11px 13px", textAlign: "left", fontSize: 10.5, textTransform: "uppercase", color: "var(--muted)", fontWeight: 800, background: "var(--bg)" }}>Person</th>
                    {!evenSplit && <th style={{ padding: "11px 13px", textAlign: "right", fontSize: 10.5, textTransform: "uppercase", color: "var(--muted)", fontWeight: 800, background: "var(--bg)" }}>Base</th>}
                    {!evenSplit && result.groupBreak.map(g => <th key={g.id} style={{ padding: "11px 13px", textAlign: "right", fontSize: 10.5, textTransform: "uppercase", color: "var(--muted)", fontWeight: 800, background: "var(--bg)" }}>{g.name}</th>)}
                    <th style={{ padding: "11px 13px", textAlign: "right", fontSize: 10.5, textTransform: "uppercase", color: "var(--muted)", fontWeight: 800, background: "var(--bg)" }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {st.people.map(p => {
                    const baseAmt = evenSplit ? 0 : (st.baseMembers.includes(p.id) ? result.basePerPerson : 0);
                    return (
                      <tr key={p.id}>
                        <td style={{ padding: "11px 13px", fontWeight: 700, borderTop: "1px solid var(--border)", color: "var(--text)" }}>{p.name}</td>
                        {!evenSplit && <td style={{ padding: "11px 13px", textAlign: "right", fontWeight: 700, borderTop: "1px solid var(--border)", color: "var(--text)" }}>{fmt(baseAmt)}</td>}
                        {!evenSplit && result.groupBreak.map(g => <td key={g.id} style={{ padding: "11px 13px", textAlign: "right", fontWeight: 700, borderTop: "1px solid var(--border)", color: "var(--text)" }}>{g.members.includes(p.id) ? fmt(g.share) : "—"}</td>)}
                        <td style={{ padding: "11px 13px", textAlign: "right", fontWeight: 700, borderTop: "1px solid var(--border)", color: "var(--text)" }}>{fmt(result.perPersonTotal[p.id])}</td>
                      </tr>
                    );
                  })}
                  <tr>
                    <td style={{ padding: "11px 13px", fontWeight: 800, borderTop: "1px solid var(--border)", color: ACCENT_DEEP }}>Collected</td>
                    {!evenSplit && <td style={{ padding: "11px 13px", textAlign: "right", fontWeight: 800, borderTop: "1px solid var(--border)", color: ACCENT_DEEP }}>{fmt(result.base)}</td>}
                    {!evenSplit && result.groupBreak.map(g => <td key={g.id} style={{ padding: "11px 13px", textAlign: "right", fontWeight: 800, borderTop: "1px solid var(--border)", color: ACCENT_DEEP }}>{fmt(g.amt)}</td>)}
                    <td style={{ padding: "11px 13px", textAlign: "right", fontWeight: 800, borderTop: "1px solid var(--border)", color: ACCENT_DEEP }}>{fmt(grand)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {st.people.length > 0 && <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
            <button onClick={() => { hapticLight(); copy(); }} style={{ flex: "1 1 calc(33% - 6px)", justifyContent: "center", display: "flex", alignItems: "center", gap: 6, border: "none", background: "var(--card)", color: "var(--text)", fontWeight: 800, fontSize: 12.5, padding: "12px 10px", borderRadius: 14, cursor: "pointer", boxShadow: CLAY_SOFT }}><IconCopy size={15} />Copy</button>
            <button onClick={() => { hapticLight(); whatsapp(); }} style={{ flex: "1 1 calc(33% - 6px)", justifyContent: "center", display: "flex", alignItems: "center", gap: 6, border: "none", background: "var(--card)", color: "var(--text)", fontWeight: 800, fontSize: 12.5, padding: "12px 10px", borderRadius: 14, cursor: "pointer", boxShadow: CLAY_SOFT }}><IconBrandWhatsapp size={15} />Share</button>
            <button onClick={() => { hapticLight(); window.print(); }} style={{ flex: "1 1 calc(33% - 6px)", justifyContent: "center", display: "flex", alignItems: "center", gap: 6, border: "none", background: "var(--card)", color: "var(--text)", fontWeight: 800, fontSize: 12.5, padding: "12px 10px", borderRadius: 14, cursor: "pointer", boxShadow: CLAY_SOFT }}><IconPrinter size={15} />Print</button>
          </div>}
        </div>
      )}

      {/* ── share bar (footer) ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16, padding: "12px 4px", borderTop: "0.5px solid var(--border)", background: "var(--bg)" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 700 }}>Collected</div>
          <div style={{ fontSize: 15, fontWeight: 800, color: "var(--text)", fontFamily: "var(--font-h)", fontVariantNumeric: "tabular-nums" }}>{fmt(grand)} <span style={{ fontSize: 11, fontWeight: 700, color: balanced ? GREEN : AMBER }}>· {balanced ? "balanced" : "check totals"}</span></div>
        </div>
        <button onClick={() => { hapticMedium(); if (st.people.length === 0) { onToast?.("Add people first", "error"); setSeg("people"); return; } setSeg("split"); copy(); }} style={{ border: "none", background: ACCENT, color: "#fff", fontSize: 13, fontWeight: 800, padding: "12px 20px", borderRadius: 16, cursor: "pointer", flexShrink: 0, fontFamily: "var(--font-h)", boxShadow: CLAY_SOFT }}>Share split</button>
      </div>
    </div>
  );
}

// ── Tip & Tax Split preset (ephemeral calculator; no persistence needed) ──
function TipSplit() {
  const [bill, setBill] = useState("");
  const [tipPct, setTipPct] = useState("10");
  const [taxPct, setTaxPct] = useState("5");
  const [people, setPeople] = useState(2);
  const num = (v) => String(v).replace(/[^0-9.]/g, "");
  const r = computeTipSplit({ bill, tipPct, taxPct, people });
  return (
    <div>
      <div style={card}>
        <label style={labelS}>Bill amount (pre-tax)</label>
        <div style={{ position: "relative", marginBottom: 16 }}>
          <span style={{ position: "absolute", left: 16, top: "50%", transform: "translateY(-50%)", fontWeight: 800, color: "var(--muted)", fontSize: 18 }}>₹</span>
          <input type="number" min="0" inputMode="decimal" value={bill} onChange={e => setBill(num(e.target.value))} placeholder="0" style={{ ...inputS, fontSize: 28, fontWeight: 800, textAlign: "center", padding: "16px 13px", fontVariantNumeric: "tabular-nums" }} />
        </div>
        <label style={labelS}>Tip</label>
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          {["5", "10", "15", "18", "20"].map(p => { const on = tipPct === p; return <button key={p} onClick={() => { hapticSelection(); setTipPct(p); }} style={{ flex: 1, padding: "10px 4px", borderRadius: 13, border: "none", background: on ? ACCENT + "1f" : "var(--neu-bg)", color: on ? ACCENT_DEEP : "var(--ts)", fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 12.5, cursor: "pointer", boxShadow: on ? `inset 0 0 0 1.5px ${ACCENT}, ${CLAY_SOFT}` : CLAY_SOFT }}>{p}%</button>; })}
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <div style={{ flex: 1 }}><label style={{ ...labelS, fontSize: 11 }}>Custom tip %</label><input type="number" min="0" inputMode="decimal" value={tipPct} onChange={e => setTipPct(num(e.target.value))} style={inputS} /></div>
          <div style={{ flex: 1 }}><label style={{ ...labelS, fontSize: 11 }}>Tax %</label><input type="number" min="0" inputMode="decimal" value={taxPct} onChange={e => setTaxPct(num(e.target.value))} style={inputS} /></div>
        </div>
        <label style={labelS}>Split between</label>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button aria-label="Fewer people" onClick={() => { hapticSelection(); setPeople(p => Math.max(1, p - 1)); }} style={stepBtn}>−</button>
          <div style={{ flex: 1, textAlign: "center", fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 20, color: "var(--text)" }}>{people} <span style={{ fontSize: 13, fontWeight: 700, color: "var(--muted)" }}>{people === 1 ? "person" : "people"}</span></div>
          <button aria-label="More people" onClick={() => { hapticSelection(); setPeople(p => Math.min(99, p + 1)); }} style={stepBtn}>+</button>
        </div>
      </div>
      <div style={{ ...card, textAlign: "center", padding: 20 }}>
        <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 700, fontFamily: "var(--font-h)", letterSpacing: "0.5px", textTransform: "uppercase" }}>Each person pays</div>
        <div style={{ fontSize: 36, fontWeight: 800, fontFamily: "var(--font-h)", color: ACCENT, margin: "4px 0", fontVariantNumeric: "tabular-nums" }}>{fmt(r.perHead)}</div>
        <div style={{ borderTop: "1px dashed var(--border)", marginTop: 14, paddingTop: 14, display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 4 }}>
          {[["Bill", r.bill], ["Tax", r.tax], ["Tip", r.tip], ["Total", r.grand]].map(([lbl, v], i) => <div key={lbl} style={{ borderLeft: i ? "1px solid var(--border)" : "none" }}><div style={{ fontSize: 9, color: "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 700, letterSpacing: "0.5px" }}>{lbl.toUpperCase()}</div><div style={{ fontSize: 12.5, fontFamily: "var(--font-h)", fontWeight: 700, color: lbl === "Total" ? "var(--text)" : "var(--ts)", marginTop: 3 }}>{fmt(v)}</div></div>)}
        </div>
      </div>
    </div>
  );
}

// Future presets register here — keeps NOMAD Lite a shell that grows.
const PRESETS = [
  { id: "current-split", name: "Current Split", desc: "Split a shared electricity / utility bill by base load + appliances", icon: "⚡", color: ACCENT, Component: CurrentSplit },
  { id: "tip-split", name: "Tip & Tax Split", desc: "Split a restaurant bill with tip and tax across the table", icon: "🍽️", color: AMBER, Component: TipSplit },
];

export default function NomadLite({ onBack, onToast = () => {} }) {
  const [active, setActive] = useState(null);
  const preset = PRESETS.find(p => p.id === active);

  return (
    <div style={{ position: "relative", background: "var(--bg)", minHeight: "calc(100vh - 90px)", display: "flex", flexDirection: "column" }}>
      <div style={{ position: "sticky", top: 0, zIndex: 10, background: "var(--bg)", padding: "max(18px, calc(env(safe-area-inset-top, 0px) + 12px)) 20px 12px", display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={() => { hapticLight(); preset ? setActive(null) : onBack(); }} style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 13, letterSpacing: "0.5px", padding: 0, fontFamily: "var(--font-h)" }}><IconChevronLeft size={15} /> {preset ? "Presets" : "Events"}</button>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: "var(--font-h)", fontSize: 16, fontWeight: 800, color: "var(--text)", letterSpacing: "-0.3px" }}>NOMAD <span style={{ color: ACCENT }}>Lite</span></span>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "6px 20px 100px" }}>
        {!preset ? (
          <div>
            <p style={{ fontSize: 13, color: "var(--muted)", fontWeight: 600, margin: "2px 0 16px", lineHeight: 1.5 }}>Quick calculators, no logging needed. Pick a preset.</p>
            {PRESETS.map(p => (
              <button key={p.id} onClick={() => { hapticLight(); setActive(p.id); }} style={{ ...card, width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 14, cursor: "pointer" }}>
                <div style={{ width: 48, height: 48, borderRadius: 16, background: p.color + "1f", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, flexShrink: 0, boxShadow: CLAY_SOFT }}>{p.icon}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 15, color: "var(--text)" }}>{p.name}</div>
                  <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600, marginTop: 2, lineHeight: 1.4 }}>{p.desc}</div>
                </div>
                <span style={{ color: "var(--muted)", fontSize: 20, flexShrink: 0 }}>›</span>
              </button>
            ))}
            <div style={{ textAlign: "center", padding: "18px 12px", color: "var(--muted)", fontSize: 12.5, fontWeight: 600 }}>More presets on the way.</div>
          </div>
        ) : (
          <preset.Component onToast={onToast} />
        )}
      </div>
    </div>
  );
}
