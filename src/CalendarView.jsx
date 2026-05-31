import { useMemo, useState } from "react";
import { localDateKey } from "./financeUtils";

const fmt = n => "₹" + (Number(n) || 0).toLocaleString("en-IN");

export default function CalendarView({
  expenses = [],
  incomes = [],
  transfers = [],
  categories = [],
  wallets = [],
  onTxClick,
}) {
  const today = new Date();
  const [vY, sY] = useState(today.getFullYear());
  const [vM, sM] = useState(today.getMonth());
  const [sel, sSel] = useState(localDateKey());

  const clampSelToMonth = (yy, mm) => {
    const last = new Date(yy, mm + 1, 0).getDate();
    const isCur = yy === today.getFullYear() && mm === today.getMonth();
    const day = isCur ? today.getDate() : 1;
    sSel(`${yy}-${String(mm + 1).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`);
  };
  const goB = () => {
    const ny = vM === 0 ? vY - 1 : vY;
    const nm = vM === 0 ? 11 : vM - 1;
    sY(ny); sM(nm); clampSelToMonth(ny, nm);
  };
  const goF = () => {
    if (vY === today.getFullYear() && vM === today.getMonth()) return;
    const ny = vM === 11 ? vY + 1 : vY;
    const nm = vM === 11 ? 0 : vM + 1;
    sY(ny); sM(nm); clampSelToMonth(ny, nm);
  };
  const iC = vY === today.getFullYear() && vM === today.getMonth();
  const fd = new Date(vY, vM, 1).getDay();
  const dim = new Date(vY, vM + 1, 0).getDate();
  const mn = new Date(vY, vM).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const pfx = `${vY}-${String(vM + 1).padStart(2, "0")}`;

  const dayMap = useMemo(() => {
    const m = {};
    expenses.forEach(e => {
      if (typeof e.date !== "string" || !e.date.startsWith(pfx)) return;
      if (!m[e.date]) m[e.date] = { exp: 0, inc: 0 };
      m[e.date].exp += Number(e.amount) || 0;
    });
    incomes.forEach(i => {
      if (typeof i.date !== "string" || !i.date.startsWith(pfx)) return;
      if (!m[i.date]) m[i.date] = { exp: 0, inc: 0 };
      m[i.date].inc += Number(i.amount) || 0;
    });
    return m;
  }, [expenses, incomes, pfx]);

  const monthTotal = useMemo(() => {
    let exp = 0, inc = 0, days = 0;
    Object.values(dayMap).forEach(v => {
      exp += v.exp;
      inc += v.inc;
      if (v.exp > 0 || v.inc > 0) days++;
    });
    return { exp, inc, days };
  }, [dayMap]);

  const maxDay = Math.max(...Object.values(dayMap).map(v => v.exp), 1);

  const cellColor = exp => {
    if (!exp) return "var(--bg)";
    const r = exp / maxDay;
    if (r < 0.25) return "#6BAA7530";
    if (r < 0.5) return "#FBBF2430";
    if (r < 0.75) return "#E07A5F30";
    return "#D4726A30";
  };

  const cells = [];
  for (let i = 0; i < fd; i++) cells.push(<div key={`e${i}`} style={{ aspectRatio: "1", minHeight: 48 }} />);
  for (let d = 1; d <= dim; d++) {
    const ds = `${pfx}-${String(d).padStart(2, "0")}`;
    const dat = dayMap[ds] || { exp: 0, inc: 0 };
    const isT = iC && d === today.getDate();
    const isSel = sel === ds;
    cells.push(
      <div
        key={d}
        onClick={() => sSel(ds)}
        style={{
          aspectRatio: "1",
          minHeight: 48,
          borderRadius: 10,
          background: isSel ? "#E07A5F" : cellColor(dat.exp),
          border: isSel ? "2px solid #E07A5F" : isT ? "2px solid var(--text)" : "1px solid var(--border)",
          padding: 4,
          cursor: "pointer",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          transition: "all 0.12s",
        }}
      >
        <div style={{
          fontSize: 11,
          fontFamily: "var(--font-h)",
          fontWeight: isT || isSel ? 700 : 500,
          color: isSel ? "#fff" : "var(--text)",
          lineHeight: 1,
        }}>{d}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 3, justifyContent: "flex-end" }}>
          {dat.inc > 0 && (
            <div style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: isSel ? "#fff" : "#6BAA75",
              flexShrink: 0,
            }} />
          )}
          {dat.exp > 0 && (
            <div style={{
              fontSize: 8,
              fontFamily: "var(--font-h)",
              fontWeight: 700,
              color: isSel ? "#fff" : "#E07A5F",
              lineHeight: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
            }}>
              {dat.exp >= 1000 ? `₹${(dat.exp / 1000).toFixed(1)}k` : `₹${Math.round(dat.exp)}`}
            </div>
          )}
        </div>
      </div>
    );
  }

  const selDayTxns = useMemo(() => {
    if (!sel) return [];
    const ex = expenses.filter(e => e.date === sel).map(e => ({ ...e, _type: "expense" }));
    const inc = incomes.filter(i => i.date === sel).map(i => ({ ...i, _type: "income" }));
    const tr = transfers.filter(t => t.date === sel).map(t => ({ ...t, _type: "transfer" }));
    return [...ex, ...inc, ...tr].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  }, [sel, expenses, incomes, transfers]);

  const catName = id => categories.find(c => c.id === id)?.name || id || "Unknown";
  const catColor = id => categories.find(c => c.id === id)?.color || "#999";
  const walName = id => wallets.find(w => w.id === id)?.name || id || "Unknown";

  const selDate = sel ? new Date(`${sel}T00:00:00`) : null;
  const selLabel = selDate ? selDate.toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long" }) : "";

  return (
    <div>
      <div style={{
        background: "var(--card)",
        border: "1px solid var(--border)",
        borderRadius: 14,
        padding: 14,
        marginBottom: 14,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <button onClick={goB} style={navBtn}>←</button>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontFamily: "var(--font-h)", fontSize: 14, fontWeight: 700, color: "var(--text)" }}>{mn}</div>
            {!iC && (
              <button
                onClick={() => { sY(today.getFullYear()); sM(today.getMonth()); sSel(localDateKey()); }}
                style={{ background: "none", border: "none", fontSize: 10, color: "#E07A5F", cursor: "pointer", fontFamily: "var(--font-h)", fontWeight: 600, marginTop: 2 }}
              >Jump to today</button>
            )}
          </div>
          <button onClick={goF} style={{ ...navBtn, opacity: iC ? 0.3 : 1 }}>→</button>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          {[
            { l: "SPENT", v: fmt(monthTotal.exp), c: "#E07A5F" },
            { l: "EARNED", v: fmt(monthTotal.inc), c: "#6BAA75" },
            { l: "DAYS", v: `${monthTotal.days}/${dim}`, c: "var(--muted)" },
          ].map(x => (
            <div key={x.l} style={{ flex: 1, background: "var(--bg)", borderRadius: 8, padding: "8px 10px", textAlign: "center" }}>
              <div style={{ fontSize: 9, color: "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 600 }}>{x.l}</div>
              <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "var(--font-h)", color: x.c, marginTop: 2 }}>{x.v}</div>
            </div>
          ))}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, marginBottom: 4 }}>
          {"SMTWTFS".split("").map((d, i) => (
            <div key={i} style={{ textAlign: "center", fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 600, padding: "4px 0" }}>{d}</div>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>{cells}</div>
      </div>

      <div style={{
        background: "var(--card)",
        border: "1px solid var(--border)",
        borderRadius: 14,
        padding: 14,
        marginBottom: 14,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{ fontFamily: "var(--font-h)", fontSize: 13, color: "var(--text)", fontWeight: 700 }}>{selLabel}</div>
          {selDayTxns.length > 0 && (
            <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 600 }}>
              {selDayTxns.length} tx
            </div>
          )}
        </div>

        {selDayTxns.length === 0 ? (
          <div style={{
            padding: "24px 12px",
            textAlign: "center",
            color: "var(--muted)",
            fontSize: 12,
            fontFamily: "var(--font-h)",
          }}>No transactions on this day</div>
        ) : (
          <div>
            {selDayTxns.map(t => {
              const isExp = t._type === "expense";
              const isInc = t._type === "income";
              const isTr = t._type === "transfer";
              const color = isExp ? "#E07A5F" : isInc ? "#6BAA75" : "#7B8CDE";
              const label = isExp ? catName(t.categoryId) : isInc ? catName(t.sourceId) : `${walName(t.fromWallet)} → ${walName(t.toWallet)}`;
              const sign = isExp ? "−" : isInc ? "+" : "↔";
              return (
                <div
                  key={t.id}
                  onClick={onTxClick ? () => onTxClick(t) : undefined}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "10px 0",
                    borderBottom: "1px dashed var(--border)",
                    cursor: onTxClick ? "pointer" : "default",
                  }}
                >
                  <div style={{
                    width: 4,
                    alignSelf: "stretch",
                    borderRadius: 2,
                    background: isExp ? catColor(t.categoryId) : color,
                  }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontFamily: "var(--font-h)",
                      fontSize: 12,
                      fontWeight: 600,
                      color: "var(--text)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}>{t.note || label}</div>
                    <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2, fontFamily: "var(--font-h)" }}>
                      {label}{!isTr && t.walletId ? ` · ${walName(t.walletId)}` : ""}
                    </div>
                  </div>
                  <div style={{
                    fontSize: 13,
                    fontFamily: "var(--font-h)",
                    fontWeight: 700,
                    color,
                    flexShrink: 0,
                  }}>
                    {sign}{fmt(t.amount)}
                  </div>
                </div>
              );
            })}
            {(() => {
              const exp = selDayTxns.filter(t => t._type === "expense").reduce((s, t) => s + (Number(t.amount) || 0), 0);
              const inc = selDayTxns.filter(t => t._type === "income").reduce((s, t) => s + (Number(t.amount) || 0), 0);
              return (
                <div style={{ display: "flex", gap: 12, marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
                  {exp > 0 && (
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 9, color: "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 600 }}>SPENT</div>
                      <div style={{ fontSize: 13, color: "#E07A5F", fontFamily: "var(--font-h)", fontWeight: 700, marginTop: 2 }}>{fmt(exp)}</div>
                    </div>
                  )}
                  {inc > 0 && (
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 9, color: "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 600 }}>EARNED</div>
                      <div style={{ fontSize: 13, color: "#6BAA75", fontFamily: "var(--font-h)", fontWeight: 700, marginTop: 2 }}>{fmt(inc)}</div>
                    </div>
                  )}
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 9, color: "var(--muted)", fontFamily: "var(--font-h)", fontWeight: 600 }}>NET</div>
                    <div style={{
                      fontSize: 13,
                      color: inc - exp >= 0 ? "#6BAA75" : "#E07A5F",
                      fontFamily: "var(--font-h)",
                      fontWeight: 700,
                      marginTop: 2,
                    }}>{fmt(inc - exp)}</div>
                  </div>
                </div>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}

const navBtn = {
  background: "none",
  border: "1px solid var(--border)",
  borderRadius: 8,
  width: 34,
  height: 34,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  color: "var(--muted)",
  fontSize: 14,
};
