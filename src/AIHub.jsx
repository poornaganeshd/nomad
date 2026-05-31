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

async function callVision(type, file) {
  const reader = new FileReader();
  const dataUrl = await new Promise((resolve, reject) => {
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const [meta, base64] = String(dataUrl).split(",");
  const mimeMatch = meta.match(/data:([^;]+)/);
  const mimeType = mimeMatch ? mimeMatch[1] : "image/jpeg";
  const r = await fetch("/api/food-vision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, imageBase64: base64, mimeType }),
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
  wallets = [],
  budgets = {},
  recurring = [],
  onAddTransactions,
  onApplyBudgets,
  onApplyMerchantRules,
  onShowToast,
}) {
  const showT = onShowToast || (() => {});

  // Recent 90 days slice — used by most modes
  const recent90 = useMemo(() => {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 90);
    const c = cutoff.toISOString().slice(0, 10);
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
      const monthC = month.toISOString().slice(0, 10);
      const recentTxs = recent90.expenses.filter(e => String(e.date || "") >= monthC).slice(0, 30);
      const history = redactTransactions(recent90.expenses);
      const flagged = [];
      for (const tx of recentTxs) {
        try {
          const data = await callAnalyze("anomaly", {
            txn: { date: tx.date, amount: tx.amount, categoryId: tx.categoryId, note: redact(tx.note || "") },
            history,
          });
          if (data.anomaly && data.severity !== "none" && data.severity !== "low") {
            flagged.push({ tx, ...data });
          }
        } catch { /* ignore individual failures */ }
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
      const c = cutoff.toISOString().slice(0, 10);
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
      const c = cutoff.toISOString().slice(0, 10);
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
      const cm = now.toISOString().slice(0, 7);
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

  // ---- 12. Voice parse demo ----
  const [voiceInput, sVoiceInput] = useState("");
  const [voiceResult, sVoiceResult] = useState(null);
  const [voiceBusy, sVoiceBusy] = useState(false);
  const runVoice = async () => {
    if (!voiceInput.trim()) { showT("Type or paste a transcript", "info"); return; }
    sVoiceBusy(true); sVoiceResult(null);
    try {
      const data = await callAnalyze("voice-parse", {
        transcript: redact(voiceInput.trim()),
        wallets: wallets.map(w => ({ id: w.id, name: w.name })),
        categories: categories.map(c => ({ id: c.id, name: c.name })),
      });
      sVoiceResult(data);
    } catch (e) { showT(e.message, "error"); }
    finally { sVoiceBusy(false); }
  };

  // ---- 13. Split categories ----
  const [splitNote, sSplitNote] = useState("");
  const [splitAmt, sSplitAmt] = useState("");
  const [splitCat, sSplitCat] = useState("");
  const [splitResult, sSplitResult] = useState(null);
  const [splitBusy, sSplitBusy] = useState(false);
  const runSplit = async () => {
    const amt = parseFloat(splitAmt);
    if (!amt || !splitNote.trim()) { showT("Enter amount and note", "info"); return; }
    sSplitBusy(true); sSplitResult(null);
    try {
      const data = await callAnalyze("split-cats", {
        expense: { amount: amt, note: redact(splitNote.trim()), categoryId: splitCat },
        categories: categories.map(c => ({ id: c.id, name: c.name })),
      });
      sSplitResult(data);
    } catch (e) { showT(e.message, "error"); }
    finally { sSplitBusy(false); }
  };

  // ---- 14. Receipt line items ----
  const [itemsResult, sItemsResult] = useState(null);
  const [itemsBusy, sItemsBusy] = useState(false);
  const onItemsUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    sItemsBusy(true); sItemsResult(null);
    try {
      const data = await callVision("receipt-items", file);
      sItemsResult(data);
    } catch (err) { showT(err.message, "error"); }
    finally { sItemsBusy(false); e.target.value = ""; }
  };

  // ---- 15. Ledger OCR ----
  const [ledgerResult, sLedgerResult] = useState(null);
  const [ledgerBusy, sLedgerBusy] = useState(false);
  const onLedgerUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    sLedgerBusy(true); sLedgerResult(null);
    try {
      const data = await callVision("ledger", file);
      sLedgerResult(data);
    } catch (err) { showT(err.message, "error"); }
    finally { sLedgerBusy(false); e.target.value = ""; }
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
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4, lineHeight: 1.5 }}>15 AI features grounded in your data. Tap any card to expand.</div>
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

      <Card title="Voice Parser (AI)" desc="Paste/dictate any phrasing; AI extracts amount, wallet, category, note." color="#7B8CDE" busy={voiceBusy} onRun={runVoice} runLabel="Parse">
        <textarea
          value={voiceInput}
          onChange={e => sVoiceInput(e.target.value)}
          placeholder="e.g. paid 2k for groceries from bank, split with roomie"
          rows={2}
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
            resize: "vertical",
          }}
        />
        {voiceResult && (
          <ResultBox>
            <pre style={{ margin: 0, fontSize: 11, fontFamily: "monospace", whiteSpace: "pre-wrap" }}>{JSON.stringify(voiceResult, null, 2)}</pre>
          </ResultBox>
        )}
      </Card>

      <Card title="Category Split Suggester" desc="One expense, multi-category split (Amazon order = groceries + electronics)." color="#A78BFA" busy={splitBusy} onRun={runSplit} runLabel="Suggest split">
        <div style={{ display: "flex", gap: 6 }}>
          <input
            value={splitAmt}
            onChange={e => sSplitAmt(e.target.value)}
            placeholder="Amount"
            type="number"
            style={{ flex: 1, padding: "9px 12px", borderRadius: 10, border: "1.5px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 13, outline: "none", boxSizing: "border-box" }}
          />
          <select
            value={splitCat}
            onChange={e => sSplitCat(e.target.value)}
            style={{ flex: 1, padding: "9px 12px", borderRadius: 10, border: "1.5px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 13, outline: "none" }}
          >
            <option value="">Current category</option>
            {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <input
          value={splitNote}
          onChange={e => sSplitNote(e.target.value)}
          placeholder="Note (e.g. amazon: milk, headphones, soap)"
          style={{ width: "100%", marginTop: 6, padding: "9px 12px", borderRadius: 10, border: "1.5px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 13, outline: "none", boxSizing: "border-box" }}
        />
        {splitResult && (
          <ResultBox>
            {(splitResult.splits || []).map((s, i) => (
              <div key={i} style={{ display: "flex", gap: 8, padding: "4px 0", fontSize: 11 }}>
                <span style={{ flex: 1, fontFamily: "var(--font-h)", fontWeight: 700 }}>{catName(s.categoryId)}</span>
                <span style={{ flex: 1, color: "var(--muted)" }}>{s.reason}</span>
                <span style={{ fontFamily: "var(--font-h)", color: "#A78BFA", fontWeight: 700 }}>{fmt(s.amount)}</span>
              </div>
            ))}
          </ResultBox>
        )}
      </Card>

      <Card title="Receipt Line Items" desc="Photo of receipt → each item with qty, amount, category hint." color="#6BAA75">
        <label style={{ display: "block", width: "100%", padding: "10px", border: "1.5px solid #6BAA75", borderRadius: 10, background: "#6BAA7512", color: "#6BAA75", fontFamily: "var(--font-h)", fontSize: 12, cursor: "pointer", fontWeight: 700, textAlign: "center" }}>
          {itemsBusy ? "Reading…" : "Upload receipt photo"}
          <input type="file" accept="image/*" capture="environment" onChange={onItemsUpload} style={{ display: "none" }} disabled={itemsBusy} />
        </label>
        {itemsResult && (
          <ResultBox>
            <div style={{ fontFamily: "var(--font-h)", fontWeight: 700, marginBottom: 6 }}>{itemsResult.merchant} · {fmt(itemsResult.total)}</div>
            {(itemsResult.items || []).map((it, i) => (
              <div key={i} style={{ display: "flex", gap: 8, padding: "4px 0", fontSize: 11, borderBottom: i < itemsResult.items.length - 1 ? "1px dashed var(--border)" : "none" }}>
                <span style={{ flex: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.name}</span>
                <span style={{ color: "var(--muted)", flexShrink: 0 }}>×{it.qty}</span>
                <span style={{ fontSize: 9, color: "var(--muted)", flexShrink: 0 }}>{it.category}</span>
                <span style={{ fontFamily: "var(--font-h)", color: "#6BAA75", fontWeight: 700, flexShrink: 0 }}>{fmt(it.amount)}</span>
              </div>
            ))}
          </ResultBox>
        )}
      </Card>

      <Card title="Ledger OCR" desc="Photo of a handwritten ledger / expense diary → batch import transactions." color="#c9a96e">
        <label style={{ display: "block", width: "100%", padding: "10px", border: "1.5px solid #c9a96e", borderRadius: 10, background: "#c9a96e12", color: "#c9a96e", fontFamily: "var(--font-h)", fontSize: 12, cursor: "pointer", fontWeight: 700, textAlign: "center" }}>
          {ledgerBusy ? "Reading…" : "Upload ledger photo"}
          <input type="file" accept="image/*" capture="environment" onChange={onLedgerUpload} style={{ display: "none" }} disabled={ledgerBusy} />
        </label>
        {ledgerResult && (
          <ResultBox>
            <div style={{ fontFamily: "var(--font-h)", fontWeight: 700, marginBottom: 6 }}>{(ledgerResult.entries || []).length} entries detected</div>
            {(ledgerResult.entries || []).slice(0, 10).map((en, i) => (
              <div key={i} style={{ display: "flex", gap: 8, padding: "4px 0", fontSize: 11 }}>
                <span style={{ color: "var(--muted)", flexShrink: 0 }}>{en.date || "?"}</span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{en.note}</span>
                <span style={{ fontFamily: "var(--font-h)", color: en.type === "income" ? "#6BAA75" : "#E07A5F", fontWeight: 700 }}>{en.type === "income" ? "+" : "−"}{fmt(en.amount)}</span>
              </div>
            ))}
            {(ledgerResult.entries || []).length > 10 && (
              <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 4 }}>…and {ledgerResult.entries.length - 10} more</div>
            )}
            {onAddTransactions && ledgerResult.entries?.length > 0 && (
              <button
                onClick={() => onAddTransactions(ledgerResult.entries)}
                style={{ width: "100%", marginTop: 8, padding: "8px", border: "1.5px solid #c9a96e", borderRadius: 8, background: "transparent", color: "#c9a96e", fontFamily: "var(--font-h)", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
              >Import all {ledgerResult.entries.length}</button>
            )}
          </ResultBox>
        )}
      </Card>

      <div style={{ textAlign: "center", padding: "20px 8px", color: "var(--muted)", fontSize: 11, lineHeight: 1.6 }}>
        Recurring count: {recurring.length} · Budgets: {Object.keys(budgets).length} · Routine logs: {moodLogs.length}
        <br />
        All data redacted of PII before AI calls.
      </div>
    </div>
  );
}
