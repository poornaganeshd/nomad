import { useMemo, useState } from "react";
import { redactTransactions, redact } from "./redactor";
import { localDateKey } from "./financeUtils";

const fmt = n => "₹" + (Number(n) || 0).toLocaleString("en-IN");

async function callAnalyze(mode, body) {
  const r = await fetch("/api/ai-analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, ...body }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "AI failed");
  return data;
}

function Card({ title, desc, color = "#7B8CDE", children, busy, onRun, runLabel = "Run" }) {
  const [open, sOpen] = useState(false);
  return (
    <div style={{
      background: "var(--card)",
      border: "1px solid var(--border)",
      borderLeft: `3px solid ${color}`,
      borderRadius: 14,
      padding: 14,
      marginBottom: 12,
    }}>
      <div onClick={() => sOpen(v => !v)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: "var(--font-h)", fontSize: 13, color: "var(--text)", fontWeight: 700 }}>{title}</div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 3, lineHeight: 1.5 }}>{desc}</div>
        </div>
        <span style={{ fontSize: 11, color: "var(--muted)", marginLeft: 8 }}>{open ? "▲" : "▼"}</span>
      </div>
      {open && (
        <div style={{ marginTop: 12 }}>
          {children}
          {onRun && (
            <button
              onClick={onRun}
              disabled={busy}
              style={{
                width: "100%",
                padding: "10px",
                marginTop: 10,
                border: "none",
                borderRadius: 10,
                background: busy ? "var(--border)" : color,
                color: "#fff",
                fontFamily: "var(--font-h)",
                fontSize: 12,
                fontWeight: 700,
                cursor: busy ? "default" : "pointer",
              }}
            >
              {busy ? "Running…" : runLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ResultBox({ children }) {
  return (
    <div style={{
      background: "var(--bg)",
      borderRadius: 10,
      padding: 10,
      marginTop: 10,
      fontSize: 12,
      color: "var(--text)",
      fontFamily: "var(--font-b)",
      lineHeight: 1.5,
    }}>{children}</div>
  );
}

export default function AIHub({
  expenses = [],
  incomes = [],
  categories = [],
  budgets = {},
  recurring = [],
  onApplyBudgets,
  onApplyMerchantRules,
  onShowToast,
}) {
  const showT = onShowToast || (() => {});

  // Recent 90 days slice — used by most modes. Use localDateKey, not
  // toISOString().slice(0,10): stored dates are local-TZ; UTC slicing drops a
  // day for users east of UTC in the first hours after midnight.
  const recent90 = useMemo(() => {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 90);
    const c = localDateKey(cutoff);
    return {
      expenses: expenses.filter(e => String(e.date || "") >= c),
      incomes:  incomes.filter(i => String(i.date || "") >= c),
    };
  }, [expenses, incomes]);

  const moodLogs = useMemo(() => {
    try {
      const raw = JSON.parse(localStorage.getItem("form_data") || "{}");
      return Object.entries(raw).map(([date, d]) => ({
        date,
        mood: d?.moodChip || d?.energyChip || "",
        sleepQuality: d?.sleepQuality || "",
        water: Number(d?.water || 0),
      })).filter(m => m.mood || m.sleepQuality || m.water > 0);
    } catch { return []; }
  }, []);

  // ---- 1. Subscriptions ----
  const [subResult, sSubResult] = useState(null);
  const [subBusy, sSubBusy] = useState(false);
  const runSubs = async () => {
    sSubBusy(true); sSubResult(null);
    try {
      const data = await callAnalyze("subscriptions", { transactions: redactTransactions(recent90.expenses) });
      sSubResult(data);
    } catch (e) { showT(e.message, "error"); }
    finally { sSubBusy(false); }
  };

  // ---- 2. Anomaly scan ----
  const [anomResults, sAnomResults] = useState(null);
  const [anomBusy, sAnomBusy] = useState(false);
  const runAnom = async () => {
    sAnomBusy(true); sAnomResults(null);
    try {
      const month = new Date(); month.setDate(month.getDate() - 30);
      const monthC = localDateKey(month);
      const candidates = recent90.expenses.filter(e => String(e.date || "") >= monthC);
      const history = redactTransactions(recent90.expenses);

      // Heuristic prefilter: only spend on AI for txns above 1.5× their category median.
      // Cuts AI calls 5-10× while keeping recall high for genuine outliers.
      const byCat = new Map();
      recent90.expenses.forEach(e => {
        if (!byCat.has(e.categoryId)) byCat.set(e.categoryId, []);
        byCat.get(e.categoryId).push(Number(e.amount) || 0);
      });
      const medians = new Map();
      byCat.forEach((arr, cid) => {
        const sorted = [...arr].sort((a, b) => a - b);
        medians.set(cid, sorted[Math.floor(sorted.length / 2)] || 0);
      });
      const prioritized = candidates
        .filter(e => {
          const med = medians.get(e.categoryId) || 0;
          return med === 0 || Number(e.amount) > med * 1.5;
        })
        .slice(0, 20);

      // Parallelize in batches of 5 to avoid overwhelming the AI provider.
      const flagged = [];
      const BATCH = 5;
      for (let i = 0; i < prioritized.length; i += BATCH) {
        const batch = prioritized.slice(i, i + BATCH);
        const results = await Promise.allSettled(batch.map(tx => callAnalyze("anomaly", {
          txn: { date: tx.date, amount: tx.amount, categoryId: tx.categoryId, note: redact(tx.note || "") },
          history,
        })));
        results.forEach((r, idx) => {
          if (r.status === "fulfilled" && r.value.anomaly && r.value.severity !== "none" && r.value.severity !== "low") {
            flagged.push({ tx: batch[idx], ...r.value });
          }
        });
        if (flagged.length >= 8) break;
      }
      sAnomResults({ flagged });
    } catch (e) { showT(e.message, "error"); }
    finally { sAnomBusy(false); }
  };

  // ---- 3. Duplicates ----
  const [dupResult, sDupResult] = useState(null);
  const [dupBusy, sDupBusy] = useState(false);
  const runDups = async () => {
    sDupBusy(true); sDupResult(null);
    try {
      const data = await callAnalyze("duplicates", {
        transactions: redactTransactions(recent90.expenses).map((t, idx) => ({ ...t, id: recent90.expenses[idx]?.id })),
      });
      sDupResult(data);
    } catch (e) { showT(e.message, "error"); }
    finally { sDupBusy(false); }
  };

  // ---- 4. Merchant cleanup ----
  const [merchResult, sMerchResult] = useState(null);
  const [merchBusy, sMerchBusy] = useState(false);
  const runMerch = async () => {
    sMerchBusy(true); sMerchResult(null);
    try {
      const notes = [...new Set(recent90.expenses.map(e => redact(e.note || "")).filter(n => n.length > 1))].slice(0, 100);
      const data = await callAnalyze("merchants", { notes });
      sMerchResult(data);
    } catch (e) { showT(e.message, "error"); }
    finally { sMerchBusy(false); }
  };

  // ---- 5. Narrative ----
  const [narResult, sNarResult] = useState(null);
  const [narBusy, sNarBusy] = useState(false);
  const [narPeriod, sNarPeriod] = useState("week");
  const runNarrative = async () => {
    sNarBusy(true); sNarResult(null);
    try {
      const days = narPeriod === "week" ? 7 : narPeriod === "month" ? 30 : 90;
      const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - days);
      const c = localDateKey(cutoff);
      const ex = expenses.filter(e => String(e.date || "") >= c);
      const inc = incomes.filter(i => String(i.date || "") >= c);
      const data = await callAnalyze("narrative", {
        period: `last ${days} days`,
        expenses: redactTransactions(ex),
        incomes:  redactTransactions(inc),
      });
      sNarResult(data);
    } catch (e) { showT(e.message, "error"); }
    finally { sNarBusy(false); }
  };

  // ---- 6. What-if ----
  const [whatInput, sWhatInput] = useState("");
  const [whatResult, sWhatResult] = useState(null);
  const [whatBusy, sWhatBusy] = useState(false);
  const runWhat = async () => {
    if (!whatInput.trim()) { showT("Type a scenario first", "info"); return; }
    sWhatBusy(true); sWhatResult(null);
    try {
      const data = await callAnalyze("whatif", {
        scenario: whatInput.trim(),
        expenses: redactTransactions(recent90.expenses),
      });
      sWhatResult(data);
    } catch (e) { showT(e.message, "error"); }
    finally { sWhatBusy(false); }
  };

  // ---- 7. Budget suggest ----
  const [budResult, sBudResult] = useState(null);
  const [budBusy, sBudBusy] = useState(false);
  const runBud = async () => {
    sBudBusy(true); sBudResult(null);
    try {
      const data = await callAnalyze("budget-suggest", {
        expenses: redactTransactions(recent90.expenses),
        categories: categories.map(c => ({ id: c.id, name: c.name })),
      });
      sBudResult(data);
    } catch (e) { showT(e.message, "error"); }
    finally { sBudBusy(false); }
  };

  // ---- 8. Mood correlation ----
  const [moodResult, sMoodResult] = useState(null);
  const [moodBusy, sMoodBusy] = useState(false);
  const runMood = async () => {
    if (moodLogs.length < 5) { showT("Need at least 5 routine logs", "info"); return; }
    sMoodBusy(true); sMoodResult(null);
    try {
      const data = await callAnalyze("mood-correlation", {
        expenses: redactTransactions(recent90.expenses),
        moods:    moodLogs.slice(-90),
      });
      sMoodResult(data);
    } catch (e) { showT(e.message, "error"); }
    finally { sMoodBusy(false); }
  };

  // ---- 9. Tax ----
  const [taxResult, sTaxResult] = useState(null);
  const [taxBusy, sTaxBusy] = useState(false);
  const runTax = async () => {
    sTaxBusy(true); sTaxResult(null);
    try {
      const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 12);
      const c = localDateKey(cutoff);
      const yearEx = expenses.filter(e => String(e.date || "") >= c);
      const data = await callAnalyze("tax", {
        expenses: redactTransactions(yearEx),
        fy: new Date().getFullYear().toString(),
      });
      sTaxResult(data);
    } catch (e) { showT(e.message, "error"); }
    finally { sTaxBusy(false); }
  };

  // ---- 10. Smart reminders ----
  const [remResult, sRemResult] = useState(null);
  const [remBusy, sRemBusy] = useState(false);
  const runRem = async () => {
    sRemBusy(true); sRemResult(null);
    try {
      const data = await callAnalyze("smart-reminders", {
        today: localDateKey(),
        expenses: redactTransactions(recent90.expenses),
      });
      sRemResult(data);
    } catch (e) { showT(e.message, "error"); }
    finally { sRemBusy(false); }
  };

  // ---- 11. Goal coach ----
  const [coachResult, sCoachResult] = useState(null);
  const [coachBusy, sCoachBusy] = useState(false);
  const runCoach = async () => {
    if (!Object.keys(budgets).length) { showT("Set budgets first in Settings", "info"); return; }
    sCoachBusy(true); sCoachResult(null);
    try {
      const now = new Date();
      const cm = localDateKey(now).slice(0, 7);
      const monthExp = expenses.filter(e => (e.date || "").slice(0, 7) === cm);
      const data = await callAnalyze("goal-coach", {
        budgets,
        monthExpenses: redactTransactions(monthExp),
        dayOfMonth: now.getDate(),
        daysInMonth: new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(),
      });
      sCoachResult(data);
    } catch (e) { showT(e.message, "error"); }
    finally { sCoachBusy(false); }
  };

  const catName = id => categories.find(c => c.id === id)?.name || id;

  return (
    <div>
      <div style={{
        background: "linear-gradient(135deg, #E07A5F22 0%, #7B8CDE22 100%)",
        borderRadius: 14,
        padding: 14,
        marginBottom: 14,
      }}>
        <div style={{ fontFamily: "var(--font-h)", fontSize: 15, fontWeight: 700, color: "var(--text)" }}>AI Toolbox</div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4, lineHeight: 1.5 }}>Insight tools grounded in your data. Tap any card to expand.</div>
      </div>

      <Card title="Subscription Detector" desc="Find suspected recurring charges (Netflix, gym, SaaS) in your 90-day log." color="#7B8CDE" busy={subBusy} onRun={runSubs}>
        {subResult && (
          <ResultBox>
            {subResult.subscriptions?.length === 0 ? "No recurring patterns detected." : subResult.subscriptions.map((s, i) => (
              <div key={i} style={{ display: "flex", gap: 8, padding: "6px 0", borderBottom: i < subResult.subscriptions.length - 1 ? "1px dashed var(--border)" : "none" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontFamily: "var(--font-h)" }}>{s.merchant}</div>
                  <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>{s.cadence} · {s.note}</div>
                </div>
                <div style={{ fontFamily: "var(--font-h)", fontWeight: 700, color: "#E07A5F" }}>{fmt(s.amount)}</div>
              </div>
            ))}
          </ResultBox>
        )}
      </Card>

      <Card title="Anomaly Scanner" desc="Scan last 30 days and flag transactions that look out of pattern." color="#E07A5F" busy={anomBusy} onRun={runAnom} runLabel="Scan last 30 days">
        {anomResults && (
          <ResultBox>
            {anomResults.flagged.length === 0 ? "All clear — no significant outliers." : anomResults.flagged.map((a, i) => (
              <div key={i} style={{ padding: "8px 0", borderBottom: i < anomResults.flagged.length - 1 ? "1px dashed var(--border)" : "none" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontFamily: "var(--font-h)", fontWeight: 700 }}>{fmt(a.tx.amount)} {catName(a.tx.categoryId)}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: a.severity === "high" ? "#D4726A" : "#FBBF24" }}>{a.severity.toUpperCase()}</span>
                </div>
                <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.5 }}>{a.reason}</div>
              </div>
            ))}
          </ResultBox>
        )}
      </Card>

      <Card title="Duplicate Detector" desc="Find probable double-logged transactions (same amount + merchant close in time)." color="#FBBF24" busy={dupBusy} onRun={runDups}>
        {dupResult && (
          <ResultBox>
            {dupResult.duplicates?.length === 0 ? "No duplicates found." : dupResult.duplicates.map((d, i) => (
              <div key={i} style={{ padding: "6px 0", borderBottom: i < dupResult.duplicates.length - 1 ? "1px dashed var(--border)" : "none" }}>
                <div style={{ fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 11 }}>{d.confidence.toUpperCase()} · {d.reason}</div>
                <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>IDs: {(d.ids || []).join(", ")}</div>
              </div>
            ))}
          </ResultBox>
        )}
      </Card>

      <Card title="Merchant Cleanup" desc="Normalize messy notes ('strbcks', 'Starbucks Koramangala') to canonical names." color="#6BAA75" busy={merchBusy} onRun={runMerch}>
        {merchResult && (
          <ResultBox>
            {merchResult.mappings?.length === 0 ? "No mappings produced." : (
              <>
                {merchResult.mappings.slice(0, 12).map((m, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, padding: "4px 0", fontSize: 11 }}>
                    <span style={{ color: "var(--muted)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.raw}</span>
                    <span>→</span>
                    <span style={{ fontWeight: 700, fontFamily: "var(--font-h)" }}>{m.canonical}</span>
                    <span style={{ fontSize: 9, color: "var(--muted)", flexShrink: 0 }}>{m.sector}</span>
                  </div>
                ))}
                {onApplyMerchantRules && (
                  <button
                    onClick={() => onApplyMerchantRules(merchResult.mappings)}
                    style={{ width: "100%", marginTop: 8, padding: "8px", border: "1.5px solid #6BAA75", borderRadius: 8, background: "transparent", color: "#6BAA75", fontFamily: "var(--font-h)", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                  >Save as autocategorize rules</button>
                )}
              </>
            )}
          </ResultBox>
        )}
      </Card>

      <Card title="AI Narrative" desc="Written summary of your week / month / quarter." color="#A78BFA" busy={narBusy} onRun={runNarrative} runLabel={`Generate ${narPeriod} narrative`}>
        <div style={{ display: "flex", gap: 4 }}>
          {["week", "month", "quarter"].map(p => (
            <button
              key={p}
              onClick={() => sNarPeriod(p)}
              style={{
                flex: 1,
                padding: "6px 10px",
                borderRadius: 8,
                border: `1.5px solid ${narPeriod === p ? "#A78BFA" : "var(--border)"}`,
                background: narPeriod === p ? "#A78BFA18" : "var(--card)",
                color: narPeriod === p ? "#A78BFA" : "var(--muted)",
                fontFamily: "var(--font-h)",
                fontSize: 11,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >{p}</button>
          ))}
        </div>
        {narResult && (
          <ResultBox>
            <div style={{ fontFamily: "var(--font-h)", fontWeight: 700, marginBottom: 6 }}>{narResult.headline}</div>
            <div style={{ marginBottom: 8 }}>{narResult.body}</div>
            <ul style={{ paddingLeft: 18, margin: 0 }}>
              {(narResult.highlights || []).map((h, i) => <li key={i} style={{ marginBottom: 3 }}>{h}</li>)}
            </ul>
          </ResultBox>
        )}
      </Card>

      <Card title="What-if Simulator" desc="Type a scenario; AI projects monthly + yearly impact based on your history." color="#7B8CDE" busy={whatBusy} onRun={runWhat} runLabel="Simulate">
        <input
          value={whatInput}
          onChange={e => sWhatInput(e.target.value)}
          placeholder="e.g. cut dining 30%"
          style={{
            width: "100%",
            padding: "9px 12px",
            borderRadius: 10,
            border: "1.5px solid var(--border)",
            background: "var(--bg)",
            color: "var(--text)",
            fontSize: 13,
            fontFamily: "var(--font-b)",
            outline: "none",
            boxSizing: "border-box",
          }}
        />
        {whatResult && (
          <ResultBox>
            <div style={{ fontFamily: "var(--font-h)", fontWeight: 700, marginBottom: 6 }}>{whatResult.projection}</div>
            <div style={{ display: "flex", gap: 8, margin: "8px 0" }}>
              <div style={{ flex: 1, padding: 8, background: "var(--card)", borderRadius: 8 }}>
                <div style={{ fontSize: 9, color: "var(--muted)" }}>MONTHLY</div>
                <div style={{ fontSize: 14, color: "#6BAA75", fontFamily: "var(--font-h)", fontWeight: 700 }}>{fmt(whatResult.monthlySaving)}</div>
              </div>
              <div style={{ flex: 1, padding: 8, background: "var(--card)", borderRadius: 8 }}>
                <div style={{ fontSize: 9, color: "var(--muted)" }}>YEARLY</div>
                <div style={{ fontSize: 14, color: "#6BAA75", fontFamily: "var(--font-h)", fontWeight: 700 }}>{fmt(whatResult.yearlySaving)}</div>
              </div>
              <div style={{ flex: 1, padding: 8, background: "var(--card)", borderRadius: 8 }}>
                <div style={{ fontSize: 9, color: "var(--muted)" }}>FEASIBLE</div>
                <div style={{ fontSize: 12, color: "var(--text)", fontFamily: "var(--font-h)", fontWeight: 700, textTransform: "uppercase" }}>{whatResult.feasibility}</div>
              </div>
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)", fontStyle: "italic" }}>💡 {whatResult.tip}</div>
          </ResultBox>
        )}
      </Card>

      <Card title="Budget Recommender" desc="Suggest realistic monthly limits per category from your 90-day data." color="#7B8CDE" busy={budBusy} onRun={runBud}>
        {budResult && (
          <ResultBox>
            {budResult.suggestions?.length === 0 ? "Not enough data." : (
              <>
                {budResult.suggestions.map((s, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, padding: "6px 0", fontSize: 11, alignItems: "center" }}>
                    <span style={{ flex: 1, fontFamily: "var(--font-h)", fontWeight: 700 }}>{catName(s.categoryId)}</span>
                    <span style={{ fontFamily: "var(--font-h)", color: "#7B8CDE", fontWeight: 700 }}>{fmt(s.suggestedLimit)}</span>
                    <span style={{ fontSize: 9, color: "var(--muted)" }}>vs ₹{Math.round(s.p90Spent || 0)}</span>
                  </div>
                ))}
                {onApplyBudgets && (
                  <button
                    onClick={() => onApplyBudgets(Object.fromEntries(budResult.suggestions.map(s => [s.categoryId, s.suggestedLimit])))}
                    style={{ width: "100%", marginTop: 8, padding: "8px", border: "1.5px solid #7B8CDE", borderRadius: 8, background: "transparent", color: "#7B8CDE", fontFamily: "var(--font-h)", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                  >Apply suggested budgets</button>
                )}
              </>
            )}
          </ResultBox>
        )}
      </Card>

      <Card title="Mood ↔ Spend" desc="Correlate Routine mood/sleep logs with daily spending. Unique to NOMAD." color="#FBBF24" busy={moodBusy} onRun={runMood}>
        <div style={{ fontSize: 11, color: "var(--muted)" }}>Routine logs available: {moodLogs.length}</div>
        {moodResult && (
          <ResultBox>
            <div style={{ marginBottom: 8, fontStyle: "italic" }}>{moodResult.summary}</div>
            {(moodResult.correlations || []).map((c, i) => (
              <div key={i} style={{ padding: "6px 0", borderBottom: i < moodResult.correlations.length - 1 ? "1px dashed var(--border)" : "none" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                  <span style={{ fontFamily: "var(--font-h)", fontWeight: 700 }}>{c.factor}</span>
                  <span style={{ fontFamily: "var(--font-h)", fontWeight: 700, color: c.spendDelta?.startsWith("+") ? "#E07A5F" : "#6BAA75" }}>{c.spendDelta}</span>
                </div>
                <div style={{ fontSize: 10, color: "var(--muted)" }}>{c.evidence}</div>
              </div>
            ))}
          </ResultBox>
        )}
      </Card>

      <Card title="Tax Helper (India)" desc="Classify last 12 months expenses by 80C / 80D / HRA etc." color="#6BAA75" busy={taxBusy} onRun={runTax}>
        {taxResult && (
          <ResultBox>
            <div style={{ marginBottom: 8 }}>{taxResult.summary}</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#6BAA75", fontFamily: "var(--font-h)", marginBottom: 6 }}>Total deductible: {fmt(taxResult.totalDeductible)}</div>
            {(taxResult.items || []).map((it, i) => (
              <div key={i} style={{ display: "flex", gap: 8, padding: "4px 0", fontSize: 11, borderBottom: i < taxResult.items.length - 1 ? "1px dashed var(--border)" : "none" }}>
                <span style={{ flex: 1, fontFamily: "var(--font-h)", fontWeight: 700 }}>{it.section}</span>
                <span style={{ flex: 2, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.note}</span>
                <span style={{ fontFamily: "var(--font-h)", color: "#6BAA75", fontWeight: 700 }}>{fmt(it.amount)}</span>
              </div>
            ))}
          </ResultBox>
        )}
      </Card>

      <Card title="Smart Reminders" desc="Predict what you usually log today based on past patterns." color="#A78BFA" busy={remBusy} onRun={runRem}>
        {remResult && (
          <ResultBox>
            {remResult.reminders?.length === 0 ? "No patterns strong enough yet." : remResult.reminders.map((r, i) => (
              <div key={i} style={{ padding: "8px 0", borderBottom: i < remResult.reminders.length - 1 ? "1px dashed var(--border)" : "none" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                  <span style={{ fontFamily: "var(--font-h)", fontWeight: 700 }}>{r.title}</span>
                  <span style={{ fontSize: 9, fontWeight: 700, color: r.priority === "high" ? "#D4726A" : r.priority === "medium" ? "#FBBF24" : "var(--muted)" }}>{r.priority?.toUpperCase()}</span>
                </div>
                <div style={{ fontSize: 11, color: "var(--muted)" }}>{r.detail}</div>
              </div>
            ))}
          </ResultBox>
        )}
      </Card>

      <Card title="Goal / Budget Coach" desc="Mid-month nudge: where you stand vs budgets, what to cut." color="#E07A5F" busy={coachBusy} onRun={runCoach}>
        <div style={{ fontSize: 11, color: "var(--muted)" }}>Budgets set: {Object.keys(budgets).length}</div>
        {coachResult && (
          <ResultBox>
            <div style={{
              fontSize: 10,
              fontWeight: 700,
              color: coachResult.status === "off-track" ? "#D4726A" : coachResult.status === "warning" ? "#E07A5F" : coachResult.status === "watch" ? "#FBBF24" : "#6BAA75",
              marginBottom: 6,
              fontFamily: "var(--font-h)",
              textTransform: "uppercase",
            }}>{coachResult.status}</div>
            <div style={{ marginBottom: 8 }}>{coachResult.message}</div>
            {(coachResult.actions || []).map((a, i) => (
              <div key={i} style={{ padding: "5px 0", display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontFamily: "var(--font-h)", fontWeight: 700, fontSize: 11 }}>• {a.label}</span>
                <span style={{ fontSize: 10, color: "#6BAA75", fontWeight: 700 }}>{a.impact}</span>
              </div>
            ))}
          </ResultBox>
        )}
      </Card>

      <div style={{ textAlign: "center", padding: "20px 8px", color: "var(--muted)", fontSize: 11, lineHeight: 1.6 }}>
        Recurring count: {recurring.length} · Budgets: {Object.keys(budgets).length} · Routine logs: {moodLogs.length}
        <br />
        All data redacted of PII before AI calls.
        <br />
        <span style={{ fontStyle: "italic" }}>Receipt scan, line-item split (editable), and ledger photo import live inside Add and Settings — not duplicated here.</span>
      </div>
    </div>
  );
}
