import { useState, useEffect, useMemo, useCallback } from "react";
import { LS_KEY, DEFAULT_STATE, loadState, computeSplit, uid, avatarColor, groupColor, initials, fmt, pctFmt } from "./nomadLiteSplit";

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
 * logic + helpers live in ./nomadLiteSplit.js.
 */

// App-consistent accent palette (terracotta family) — intentional brand colours,
// not theme tokens, so they stay constant across light/dark.
const ACCENT = "#E07A5F";
const ACCENT_DEEP = "#C4603A";
const AMBER = "#C9882B";

// ── small style helpers ──
const card = { background: "var(--card)", borderRadius: 18, padding: 16, marginBottom: 14, border: "1px solid var(--border)", boxShadow: "0 2px 10px rgba(44,36,22,0.05)" };
const inputS = { width: "100%", background: "var(--bg)", border: "1.5px solid var(--border)", color: "var(--text)", fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 15, padding: "11px 12px", borderRadius: 12, outline: "none", boxSizing: "border-box" };
const labelS = { display: "block", fontSize: 12, fontWeight: 700, color: "var(--ts)", marginBottom: 6, fontFamily: "var(--font-h)" };
const hintS = { fontSize: 11, color: "var(--muted)", marginTop: 6, fontWeight: 600, fontFamily: "var(--font-b)" };
const sectionLabel = { fontSize: 11, fontWeight: 800, letterSpacing: "0.5px", textTransform: "uppercase", color: "var(--muted)", margin: "18px 0 10px", fontFamily: "var(--font-h)" };

function Donut({ segments, total }) {
  const size = 168, stroke = 24, r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const segs = segments.filter(s => s.amount > 0.001);
  // arc lengths + prefix offsets, computed without mutating render-scope state
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

// ── The Current Split preset ──
function CurrentSplit({ onToast }) {
  const [st, setSt] = useState(loadState);
  const [tab, setTab] = useState("calc"); // calc | setup
  const [view, setView] = useState("cards"); // cards | table (results)
  const [calc, setCalc] = useState(null); // { evenSplit:boolean } once a result is shown
  const [editingPersonId, setEditingPersonId] = useState(null);
  const [newPerson, setNewPerson] = useState("");
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupPct, setNewGroupPct] = useState("");

  // persist
  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(st)); } catch { /* quota */ }
  }, [st]);

  const set = (patch) => setSt(s => ({ ...s, ...(typeof patch === "function" ? patch(s) : patch) }));

  // auto-suggest base load = baseRate × (#base members), unless user typed their own
  useEffect(() => {
    if (st.baseTouched) return;
    const rate = Number(st.baseRate) || 0;
    const count = st.baseMembers.length || st.people.length;
    const suggested = count ? String(rate * count) : "";
    if (suggested !== st.baseBill) setSt(s => (s.baseTouched ? s : { ...s, baseBill: suggested }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.baseRate, st.baseMembers, st.people, st.baseTouched]);

  const result = useMemo(() => (calc ? computeSplit(st, { evenSplit: calc.evenSplit }) : null), [calc, st]);

  // people ops
  const addPerson = (name) => {
    name = name.trim();
    if (!name) return;
    const p = { id: uid("P"), name };
    set(s => ({ people: [...s.people, p], baseMembers: [...s.baseMembers, p.id] }));
  };
  const removePerson = (id) => set(s => ({
    people: s.people.filter(p => p.id !== id),
    baseMembers: s.baseMembers.filter(x => x !== id),
    groups: s.groups.map(g => ({ ...g, members: g.members.filter(x => x !== id) })),
  }));
  const renamePerson = (id, name) => set(s => ({ people: s.people.map(p => p.id === id ? { ...p, name: name.trim() || p.name } : p) }));
  const toggleBase = (id) => set(s => ({ baseMembers: s.baseMembers.includes(id) ? s.baseMembers.filter(x => x !== id) : [...s.baseMembers, id] }));

  // group ops
  const addGroup = (name, pct) => {
    name = name.trim();
    if (!name) return;
    set(s => ({ groups: [...s.groups, { id: uid("G"), name, pct: Math.max(0, Math.min(100, Number(pct) || 0)), members: [], note: "" }] }));
  };
  const removeGroup = (id) => set(s => ({ groups: s.groups.filter(g => g.id !== id) }));
  const updateGroup = (id, patch) => set(s => ({ groups: s.groups.map(g => g.id === id ? { ...g, ...patch } : g) }));
  const toggleGroupMember = (gId, pId) => set(s => ({ groups: s.groups.map(g => g.id === gId ? { ...g, members: g.members.includes(pId) ? g.members.filter(x => x !== pId) : [...g.members, pId] } : g) }));

  const doCalc = (even) => {
    if (!st.people.length) { onToast?.("Add people in Setup first", "error"); setTab("setup"); return; }
    setCalc({ evenSplit: !!even });
  };
  const reset = () => {
    setSt(s => ({ ...DEFAULT_STATE, baseRate: s.baseRate, people: s.people, baseMembers: s.baseMembers, groups: s.groups }));
    setCalc(null);
    onToast?.("Started a new bill", "info");
  };

  const shareText = useCallback(() => {
    if (!result) return "";
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

  // ── Setup tab ──
  if (tab === "setup") {
    return (
      <div>
        <div style={{ display: "flex", gap: 6, background: "var(--bg)", borderRadius: 12, padding: 4, marginBottom: 14 }}>
          {[["calc", "Calculate"], ["setup", "Setup"]].map(([t, l]) => (
            <button key={t} onClick={() => setTab(t)} style={{ flex: 1, padding: "9px 6px", borderRadius: 9, border: "none", background: tab === t ? "var(--text)" : "transparent", color: tab === t ? "var(--bg)" : "var(--ts)", fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 12.5, cursor: "pointer" }}>{l}</button>
          ))}
        </div>

        <div style={sectionLabel}>Household</div>
        <div style={card}>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={newPerson} onChange={e => setNewPerson(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { addPerson(newPerson); setNewPerson(""); } }} placeholder="Add a person" style={{ ...inputS, flex: 1 }} />
            <button onClick={() => { addPerson(newPerson); setNewPerson(""); }} style={{ width: 44, borderRadius: 12, border: "none", background: ACCENT, color: "#fff", cursor: "pointer", fontSize: 22, fontWeight: 700, flexShrink: 0 }}>+</button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
            {st.people.length === 0 && <div style={{ textAlign: "center", padding: "18px 0", color: "var(--muted)", fontSize: 13, fontWeight: 600 }}>No one here yet — add your housemates above</div>}
            {st.people.map(p => (
              <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, background: "var(--bg)", borderRadius: 14, padding: "8px 10px" }}>
                <div style={{ width: 34, height: 34, borderRadius: "50%", background: avatarColor(p.id), display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 12, flexShrink: 0, fontFamily: "var(--font-h)" }}>{initials(p.name)}</div>
                {editingPersonId === p.id ? (
                  <input autoFocus defaultValue={p.name} onBlur={e => { renamePerson(p.id, e.target.value); setEditingPersonId(null); }} onKeyDown={e => { if (e.key === "Enter") { renamePerson(p.id, e.target.value); setEditingPersonId(null); } if (e.key === "Escape") setEditingPersonId(null); }} style={{ ...inputS, flex: 1, padding: "7px 10px", border: `1.5px solid ${ACCENT}` }} />
                ) : (
                  <div onClick={() => setEditingPersonId(p.id)} style={{ flex: 1, fontWeight: 700, fontSize: 14.5, color: "var(--text)", cursor: "pointer", fontFamily: "var(--font-h)" }}>{p.name}</div>
                )}
                <button onClick={() => removePerson(p.id)} style={{ width: 30, height: 30, borderRadius: 10, border: "none", background: "transparent", color: "var(--muted)", cursor: "pointer", flexShrink: 0, fontSize: 16 }}>✕</button>
              </div>
            ))}
          </div>
        </div>

        <div style={sectionLabel}>Base load split</div>
        <div style={card}>
          <div style={{ marginBottom: 14 }}>
            <label style={labelS}>Default base rate per person (₹)</label>
            <input type="number" inputMode="decimal" min="0" value={st.baseRate} onChange={e => set({ baseRate: e.target.value })} style={inputS} />
            <p style={hintS}>Suggests the base-load total on the Calculate tab. Edit anytime.</p>
          </div>
          <label style={labelS}>Who shares the base load?</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {st.people.length === 0 && <span style={{ fontSize: 12.5, color: "var(--muted)", fontWeight: 700 }}>Add people first</span>}
            {st.people.map(p => {
              const on = st.baseMembers.includes(p.id);
              return (
                <button key={p.id} onClick={() => toggleBase(p.id)} style={{ display: "flex", alignItems: "center", gap: 7, background: on ? ACCENT + "1f" : "var(--bg)", border: `1.5px solid ${on ? ACCENT : "transparent"}`, borderRadius: 22, padding: "4px 12px 4px 4px", cursor: "pointer" }}>
                  <div style={{ width: 28, height: 28, borderRadius: "50%", background: avatarColor(p.id), display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 11, fontFamily: "var(--font-h)" }}>{initials(p.name)}</div>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: on ? ACCENT_DEEP : "var(--ts)" }}>{p.name}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div style={sectionLabel}>Appliance &amp; extra groups</div>
        <div style={card}>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={newGroupName} onChange={e => setNewGroupName(e.target.value)} placeholder="Group name, e.g. Induction" style={{ ...inputS, flex: 1 }} />
            <div style={{ display: "flex", alignItems: "center", gap: 4, background: "var(--bg)", borderRadius: 12, padding: "0 8px", border: "1.5px solid var(--border)" }}>
              <input type="number" min="0" max="100" value={newGroupPct} onChange={e => setNewGroupPct(e.target.value)} placeholder="0" style={{ width: 40, background: "transparent", border: "none", textAlign: "right", fontWeight: 800, fontSize: 14, color: "var(--text)", outline: "none", fontFamily: "var(--font-h)" }} />
              <span style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)" }}>%</span>
            </div>
            <button onClick={() => { addGroup(newGroupName, newGroupPct); setNewGroupName(""); setNewGroupPct(""); }} style={{ width: 44, borderRadius: 12, border: "none", background: ACCENT, color: "#fff", cursor: "pointer", fontSize: 22, fontWeight: 700, flexShrink: 0 }}>+</button>
          </div>
          <div style={{ marginTop: 14 }}>
            {st.groups.length === 0 && <div style={{ textAlign: "center", padding: "18px 0", color: "var(--muted)", fontSize: 13, fontWeight: 600, lineHeight: 1.5 }}>No extra groups yet — add induction, washing machine, or anything else that adds to the bill</div>}
            {st.groups.map((g, idx) => (
              <div key={g.id} style={{ background: "var(--bg)", borderRadius: 16, padding: 14, marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <div style={{ width: 28, height: 28, borderRadius: 9, background: groupColor(idx), flexShrink: 0 }} />
                  <input value={g.name} onChange={e => updateGroup(g.id, { name: e.target.value })} style={{ flex: 1, background: "transparent", border: "none", fontWeight: 800, fontSize: 14.5, color: "var(--text)", outline: "none", minWidth: 0, fontFamily: "var(--font-h)" }} />
                  <div style={{ display: "flex", alignItems: "center", gap: 4, background: "var(--card)", borderRadius: 11, padding: "5px 8px" }}>
                    <input type="number" min="0" max="100" value={g.pct} onChange={e => updateGroup(g.id, { pct: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} style={{ width: 36, background: "transparent", border: "none", textAlign: "right", fontWeight: 800, fontSize: 13, color: "var(--text)", outline: "none", fontFamily: "var(--font-h)" }} />
                    <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--muted)" }}>%</span>
                  </div>
                  <button onClick={() => removeGroup(g.id)} style={{ width: 30, height: 30, borderRadius: 10, border: "none", background: "transparent", color: "var(--muted)", cursor: "pointer", fontSize: 15 }}>✕</button>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
                  {st.people.length === 0 && <span style={{ fontSize: 12.5, color: "var(--muted)", fontWeight: 700 }}>Add people in Household first</span>}
                  {st.people.map(p => {
                    const on = g.members.includes(p.id);
                    return (
                      <button key={p.id} onClick={() => toggleGroupMember(g.id, p.id)} style={{ display: "flex", alignItems: "center", gap: 7, background: on ? ACCENT + "1f" : "var(--card)", border: `1.5px solid ${on ? ACCENT : "transparent"}`, borderRadius: 22, padding: "4px 12px 4px 4px", cursor: "pointer" }}>
                        <div style={{ width: 26, height: 26, borderRadius: "50%", background: avatarColor(p.id), display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 10, fontFamily: "var(--font-h)" }}>{initials(p.name)}</div>
                        <span style={{ fontSize: 12, fontWeight: 700, color: on ? ACCENT_DEEP : "var(--ts)" }}>{p.name}</span>
                      </button>
                    );
                  })}
                </div>
                <input value={g.note || ""} onChange={e => updateGroup(g.id, { note: e.target.value })} placeholder="Add a note (optional) — e.g. used after 8pm" style={{ width: "100%", background: "transparent", border: "none", borderTop: "1px dashed var(--border)", marginTop: 10, padding: "10px 0 0", fontSize: 12, fontWeight: 600, color: "var(--ts)", outline: "none", boxSizing: "border-box" }} />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── Calculate tab ──
  const billLabel = st.scenarioName.trim() || "This bill";
  let donutSegments = [], donutTotal = 0, banners = [];
  if (result) {
    if (result.evenSplit) {
      donutSegments = [{ label: "Equal split", amount: result.total, color: ACCENT }];
      donutTotal = result.total;
      banners.push({ kind: "warn", text: `Splitting ${fmt(result.total)} evenly across ${st.people.length} people — base load and appliance groups aren't used here.`, action: "detailed" });
    } else {
      donutSegments = [{ label: "Base load", amount: result.base, color: "var(--muted)" }, ...result.groupBreak.map(g => ({ label: g.name, amount: g.amt, color: g.color }))];
      if (result.unallocated > 0.5) donutSegments.push({ label: "Not yet assigned", amount: result.unallocated, color: "var(--border)" });
      donutTotal = result.base + result.extra;
      if (result.normalized) banners.push({ kind: "warn", text: `Group weights added up to ${pctFmt(result.rawTotalPct)}, so they were auto-scaled to fit 100% of the extra.` });
      if (result.unallocated > 0.5 && st.groups.length === 0) banners.push({ kind: "warn", text: `No appliance groups yet, so ${fmt(result.unallocated)} of extra isn't assigned to anyone. Add a group in Setup.` });
      if (st.mode === "manual" && totalNum > 0) {
        const diff = totalNum - (result.base + result.extra);
        if (Math.abs(diff) > 0.5) banners.push({ kind: "warn", text: `Total bill (${fmt(totalNum)}) doesn't match base + extra (${fmt(result.base + result.extra)}) — off by ${fmt(Math.abs(diff))}. Worth double-checking.` });
      }
    }
  }
  const grand = result ? st.people.reduce((s, p) => s + (result.perPersonTotal[p.id] || 0), 0) : 0;

  return (
    <div>
      <div style={{ display: "flex", gap: 6, background: "var(--bg)", borderRadius: 12, padding: 4, marginBottom: 14 }}>
        {[["calc", "Calculate"], ["setup", "Setup"]].map(([t, l]) => (
          <button key={t} onClick={() => setTab(t)} style={{ flex: 1, padding: "9px 6px", borderRadius: 9, border: "none", background: tab === t ? "var(--text)" : "transparent", color: tab === t ? "var(--bg)" : "var(--ts)", fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 12.5, cursor: "pointer" }}>{l}</button>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <input value={st.scenarioName} onChange={e => set({ scenarioName: e.target.value })} placeholder="Name this bill — e.g. June 2026" style={{ flex: 1, background: "transparent", border: "none", fontSize: 21, fontWeight: 800, padding: "8px 2px", color: "var(--text)", outline: "none", fontFamily: "var(--font-h)", minWidth: 0 }} />
        <button onClick={reset} title="Start new bill" style={{ width: 38, height: 38, borderRadius: 12, border: "none", background: "var(--bg)", color: "var(--ts)", cursor: "pointer", fontSize: 16, flexShrink: 0 }}>↻</button>
      </div>

      <div style={card}>
        <label style={labelS}>Total bill</label>
        <div style={{ position: "relative", marginBottom: 14 }}>
          <span style={{ position: "absolute", left: 16, top: "50%", transform: "translateY(-50%)", fontWeight: 800, color: "var(--muted)", fontSize: 18 }}>₹</span>
          <input type="number" min="0" inputMode="decimal" value={st.totalBill} onChange={e => set({ totalBill: e.target.value })} placeholder="0" style={{ ...inputS, fontSize: 28, fontWeight: 800, textAlign: "center", padding: "16px 13px", fontVariantNumeric: "tabular-nums" }} />
        </div>
        <label style={labelS}>Base load (₹) — lights, fans, fridge</label>
        <div style={{ position: "relative", marginBottom: 6 }}>
          <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", fontWeight: 800, color: "var(--muted)" }}>₹</span>
          <input type="number" min="0" inputMode="decimal" value={st.baseBill} onChange={e => set({ baseBill: e.target.value, baseTouched: true })} placeholder="0" style={{ ...inputS, paddingLeft: 30 }} />
        </div>
        <p style={hintS}>≈ ₹{st.baseRate || 105} × {st.baseMembers.length || 0} people sharing base</p>

        <label style={{ ...labelS, marginTop: 14 }}>How should the extra be worked out?</label>
        <div style={{ display: "flex", background: "var(--bg)", borderRadius: 12, padding: 4, gap: 4 }}>
          {[["auto", "Auto = Total − Base"], ["manual", "Enter extra myself"]].map(([m, l]) => (
            <button key={m} onClick={() => set({ mode: m })} style={{ flex: 1, padding: "10px 6px", borderRadius: 10, border: "none", background: st.mode === m ? "var(--text)" : "transparent", color: st.mode === m ? "var(--bg)" : "var(--ts)", fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 12, cursor: "pointer" }}>{l}</button>
          ))}
        </div>
        {st.mode === "manual" && (
          <div style={{ marginTop: 14 }}>
            <label style={labelS}>Extra amount (₹)</label>
            <div style={{ position: "relative" }}>
              <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", fontWeight: 800, color: "var(--muted)" }}>₹</span>
              <input type="number" min="0" inputMode="decimal" value={st.manualExtra} onChange={e => set({ manualExtra: e.target.value })} placeholder="0" style={{ ...inputS, paddingLeft: 30 }} />
            </div>
          </div>
        )}
        {st.mode === "auto" && <p style={hintS}>Extra will be ₹{Math.max(0, totalNum - baseNum).toLocaleString("en-IN")}</p>}
      </div>

      <button onClick={() => doCalc(false)} style={{ width: "100%", border: "none", background: ACCENT, color: "#fff", fontWeight: 800, fontSize: 16, padding: 15, borderRadius: 16, cursor: "pointer", boxShadow: "0 8px 20px rgba(224,122,95,0.28)" }}>Calculate split</button>
      <button onClick={() => doCalc(true)} style={{ width: "100%", marginTop: 10, border: "1.5px solid var(--border)", background: "var(--card)", color: "var(--text)", fontWeight: 800, fontSize: 13, padding: 12, borderRadius: 14, cursor: "pointer" }}>Or just split the total evenly</button>

      {result && (
        <div style={{ marginTop: 16 }}>
          <div style={{ ...card, display: "flex", flexDirection: "column", alignItems: "center", padding: 20 }}>
            <div style={{ position: "relative", width: 168, height: 168 }}>
              <Donut segments={donutSegments} total={donutTotal} />
              <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                <span style={{ fontSize: 20, fontWeight: 800, fontVariantNumeric: "tabular-nums", color: "var(--text)", fontFamily: "var(--font-h)" }}>{fmt(donutTotal)}</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", marginTop: 2, maxWidth: 110, textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{billLabel}</span>
              </div>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 16px", justifyContent: "center", marginTop: 14, width: "100%" }}>
              {donutSegments.filter(s => s.amount > 0.001).map((s, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, fontWeight: 700, color: "var(--text)" }}>
                  <span style={{ width: 9, height: 9, borderRadius: "50%", background: s.color, flexShrink: 0 }} />{s.label}<span style={{ color: "var(--muted)" }}>{fmt(s.amount)}</span>
                </div>
              ))}
            </div>
          </div>

          {banners.map((b, i) => (
            <div key={i} style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: "12px 13px", borderRadius: 12, fontSize: 12.5, fontWeight: 700, lineHeight: 1.45, marginBottom: 12, background: AMBER + "1f", color: AMBER }}>
              <span style={{ flexShrink: 0 }}>⚠</span>
              <span>{b.text}{b.action === "detailed" && <button onClick={() => setCalc({ evenSplit: false })} style={{ background: "none", border: "none", color: AMBER, fontWeight: 800, textDecoration: "underline", cursor: "pointer", marginLeft: 4, fontSize: 12.5 }}>Use detailed split instead</button>}</span>
            </div>
          ))}

          <div style={{ display: "flex", background: "var(--bg)", borderRadius: 12, padding: 4, gap: 4, marginBottom: 14 }}>
            {[["cards", "Cards"], ["table", "Table"]].map(([v, l]) => (
              <button key={v} onClick={() => setView(v)} style={{ flex: 1, padding: "9px 6px", borderRadius: 10, border: "none", background: view === v ? "var(--text)" : "transparent", color: view === v ? "var(--bg)" : "var(--ts)", fontFamily: "var(--font-h)", fontWeight: 800, fontSize: 12, cursor: "pointer" }}>{l}</button>
            ))}
          </div>

          <div style={sectionLabel}>Per person</div>
          {view === "cards" ? (
            <div>
              {st.people.map(p => {
                const lines = result.evenSplit ? [] : result.groupBreak.filter(g => g.members.includes(p.id));
                const baseAmt = result.evenSplit ? 0 : (st.baseMembers.includes(p.id) ? result.basePerPerson : 0);
                const tags = result.evenSplit ? "Equal share" : ([st.baseMembers.includes(p.id) ? "Base" : null, ...lines.map(g => g.name)].filter(Boolean).join(" · ") || "No charges");
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
                    {!result.evenSplit && (
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
            <div style={{ overflowX: "auto", background: "var(--card)", borderRadius: 16, border: "1px solid var(--border)" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                <thead>
                  <tr>
                    <th style={{ padding: "11px 13px", textAlign: "left", fontSize: 10.5, textTransform: "uppercase", color: "var(--muted)", fontWeight: 800, background: "var(--bg)" }}>Person</th>
                    {!result.evenSplit && <th style={{ padding: "11px 13px", textAlign: "right", fontSize: 10.5, textTransform: "uppercase", color: "var(--muted)", fontWeight: 800, background: "var(--bg)" }}>Base</th>}
                    {!result.evenSplit && result.groupBreak.map(g => <th key={g.id} style={{ padding: "11px 13px", textAlign: "right", fontSize: 10.5, textTransform: "uppercase", color: "var(--muted)", fontWeight: 800, background: "var(--bg)" }}>{g.name}</th>)}
                    <th style={{ padding: "11px 13px", textAlign: "right", fontSize: 10.5, textTransform: "uppercase", color: "var(--muted)", fontWeight: 800, background: "var(--bg)" }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {st.people.map(p => {
                    const baseAmt = result.evenSplit ? 0 : (st.baseMembers.includes(p.id) ? result.basePerPerson : 0);
                    return (
                      <tr key={p.id}>
                        <td style={{ padding: "11px 13px", fontWeight: 700, borderTop: "1px solid var(--border)", color: "var(--text)" }}>{p.name}</td>
                        {!result.evenSplit && <td style={{ padding: "11px 13px", textAlign: "right", fontWeight: 700, borderTop: "1px solid var(--border)", color: "var(--text)" }}>{fmt(baseAmt)}</td>}
                        {!result.evenSplit && result.groupBreak.map(g => <td key={g.id} style={{ padding: "11px 13px", textAlign: "right", fontWeight: 700, borderTop: "1px solid var(--border)", color: "var(--text)" }}>{g.members.includes(p.id) ? fmt(g.share) : "—"}</td>)}
                        <td style={{ padding: "11px 13px", textAlign: "right", fontWeight: 700, borderTop: "1px solid var(--border)", color: "var(--text)" }}>{fmt(result.perPersonTotal[p.id])}</td>
                      </tr>
                    );
                  })}
                  <tr>
                    <td style={{ padding: "11px 13px", fontWeight: 800, borderTop: "1px solid var(--border)", color: ACCENT_DEEP }}>Collected</td>
                    {!result.evenSplit && <td style={{ padding: "11px 13px", textAlign: "right", fontWeight: 800, borderTop: "1px solid var(--border)", color: ACCENT_DEEP }}>{fmt(result.base)}</td>}
                    {!result.evenSplit && result.groupBreak.map(g => <td key={g.id} style={{ padding: "11px 13px", textAlign: "right", fontWeight: 800, borderTop: "1px solid var(--border)", color: ACCENT_DEEP }}>{fmt(g.amt)}</td>)}
                    <td style={{ padding: "11px 13px", textAlign: "right", fontWeight: 800, borderTop: "1px solid var(--border)", color: ACCENT_DEEP }}>{fmt(grand)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
            <button onClick={copy} style={{ flex: "1 1 calc(50% - 4px)", justifyContent: "center", display: "flex", alignItems: "center", gap: 7, border: "1.5px solid var(--border)", background: "var(--card)", color: "var(--text)", fontWeight: 800, fontSize: 13, padding: "11px 14px", borderRadius: 12, cursor: "pointer" }}>Copy text</button>
            <button onClick={whatsapp} style={{ flex: "1 1 calc(50% - 4px)", justifyContent: "center", display: "flex", alignItems: "center", gap: 7, border: "1.5px solid var(--border)", background: "var(--card)", color: "var(--text)", fontWeight: 800, fontSize: 13, padding: "11px 14px", borderRadius: 12, cursor: "pointer" }}>WhatsApp</button>
            <button onClick={() => window.print()} style={{ flex: "1 1 calc(50% - 4px)", justifyContent: "center", display: "flex", alignItems: "center", gap: 7, border: "1.5px solid var(--border)", background: "var(--card)", color: "var(--text)", fontWeight: 800, fontSize: 13, padding: "11px 14px", borderRadius: 12, cursor: "pointer" }}>Print / PDF</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Future presets register here — keeps NOMAD Lite a shell that grows.
const PRESETS = [
  { id: "current-split", name: "Current Split", desc: "Split a shared electricity / utility bill by base load + appliances", icon: "⚡", color: ACCENT, Component: CurrentSplit },
];

export default function NomadLite({ onBack, onToast = () => {} }) {
  const [active, setActive] = useState(null);
  const preset = PRESETS.find(p => p.id === active);

  return (
    <div style={{ position: "relative", background: "var(--bg)", minHeight: "calc(100vh - 90px)", display: "flex", flexDirection: "column" }}>
      <div style={{ position: "sticky", top: 0, zIndex: 10, background: "var(--bg)", padding: "max(18px, calc(env(safe-area-inset-top, 0px) + 12px)) 20px 12px", display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={() => (preset ? setActive(null) : onBack())} style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 13, letterSpacing: "0.5px", padding: 0, fontFamily: "var(--font-h)" }}>‹ {preset ? "Presets" : "Events"}</button>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: "var(--font-h)", fontSize: 16, fontWeight: 800, color: "var(--text)", letterSpacing: "-0.3px" }}>NOMAD <span style={{ color: ACCENT }}>Lite</span></span>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "6px 20px 24px" }}>
        {!preset ? (
          <div>
            <p style={{ fontSize: 13, color: "var(--muted)", fontWeight: 600, margin: "2px 0 16px", lineHeight: 1.5 }}>Quick calculators, no logging needed. Pick a preset.</p>
            {PRESETS.map(p => (
              <button key={p.id} onClick={() => setActive(p.id)} style={{ ...card, width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 14, cursor: "pointer" }}>
                <div style={{ width: 46, height: 46, borderRadius: 14, background: p.color + "1f", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, flexShrink: 0 }}>{p.icon}</div>
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
