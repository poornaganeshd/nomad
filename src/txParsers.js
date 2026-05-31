// Pure transaction parsers extracted from App.jsx so they can be unit-tested
// without rendering the monolith. No React, no component state, no side effects.
import { localDateKey } from "./financeUtils";

// Locale-aware amount parser. Accepts "3.24", "3,24" (EU decimal), "1,234.56" (US thousands), "1,23,456.78" (Indian).
// Returns NaN for empty / unparseable input — callers should guard with Number.isFinite.
export const parseAmount = (s) => {
  if (typeof s === "number") return s;
  if (s == null) return NaN;
  const str = String(s).trim();
  if (!str) return NaN;
  const hasComma = str.includes(",");
  const hasPeriod = str.includes(".");
  if (hasComma && !hasPeriod && str.split(",").length === 2 && /,\d{1,2}$/.test(str)) return Number(str.replace(",", "."));
  return Number(str.replace(/,/g, ""));
};

// Parse a spoken transaction ("paid 300 for coffee from bank") into structured fields.
// wallets/categories let the caller resolve names to ids; everything is matched case-insensitively.
export function parseVoiceTx(transcript, { wallets = [], categories = [] } = {}) {
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

// Parse bank-statement CSV text into [{date, amount, note, type}] rows.
// Handles HDFC/ICICI/SBI/generic formats. Debit columns → expense, Credit columns → income.
export const parseBankCsv = (text) => {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const parseRow = line => { const cells = []; let cur = "", inQ = false; for (const ch of line) { if (ch === '"') { inQ = !inQ; } else if (ch === ',' && !inQ) { cells.push(cur.trim()); cur = ""; } else { cur += ch; } } cells.push(cur.trim()); return cells.map(c => c.replace(/^"|"$/g, "").trim()); };
  const headers = parseRow(lines[0]).map(h => h.toLowerCase());
  // Exact header match first so short abbreviations like "dr"/"cr" (debit/credit
  // columns in Indian statements) work. Substring matching skips ≤2-char keywords —
  // otherwise "cr" matches "des(cr)iption" and mis-detects the credit column on
  // SBI/generic CSVs that put Description before the Credit column.
  const colIdx = (keywords) => {
    const exact = headers.findIndex(h => keywords.includes(h));
    if (exact >= 0) return exact;
    return headers.findIndex(h => keywords.some(k => k.length > 2 && h.includes(k)));
  };
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
