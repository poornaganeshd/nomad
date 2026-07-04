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
  const lower = String(transcript).toLowerCase();
  // Capture the amount BEFORE stripping punctuation so thousands separators
  // ("1,500") and decimals ("3.50") survive. The old code replaced "," and "."
  // with spaces first, which truncated "1,500" → 1 and "3.50" → 3. The capture
  // group keeps grouping/decimal chars; parseAmount normalises EU/US/Indian forms.
  const amtMatch = lower.match(/(?:rs\.?|rupees?|₹)?\s*(\d[\d,]*(?:\.\d+)?)\s*(?:rs\.?|rupees?|₹|bucks?)?/);
  const parsedAmt = amtMatch ? parseAmount(amtMatch[1]) : NaN;
  const amount = Number.isFinite(parsedAmt) ? parsedAmt : null;
  // Drop the matched amount span first, THEN normalise punctuation/whitespace for
  // wallet/category/note matching.
  const txt = (amtMatch ? lower.replace(amtMatch[0], " ") : lower).replace(/[,.!?]/g, " ").replace(/\s+/g, " ").trim();
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
  let note = txt.replace(/\b(rs|rupees?|bucks?|paid|spent|got|received|added)\b/g, " ");
  if (wid) (walletAliases[wid] || []).forEach(a => { note = note.replace(new RegExp("\\b" + a + "\\b", "g"), " "); });
  note = note.replace(/\s+/g, " ").trim();
  return { amount, walletId: wid, categoryId: cid, note: note || null };
}

// Parse bank-statement CSV text into [{date, amount, note, type, ref?, balance?}] rows.
// Handles HDFC/ICICI/SBI/generic formats. Debit columns → expense, Credit columns → income.
// `ref` (UTR/cheque/reference no) and `balance` (running balance) are included only
// when the statement has those columns — reconciliation uses them for idempotent
// re-import and closing-balance cross-checks.
export const parseBankCsv = (text) => {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const parseRow = line => { const cells = []; let cur = "", inQ = false; for (const ch of line) { if (ch === '"') { inQ = !inQ; } else if (ch === ',' && !inQ) { cells.push(cur.trim()); cur = ""; } else { cur += ch; } } cells.push(cur.trim()); return cells.map(c => c.replace(/^"|"$/g, "").trim()); };
  // Real bank exports (SBI/HDFC XLS-to-CSV) put account-holder preamble rows above
  // the column header. Scan the first 20 lines for the row that has both a date-ish
  // and an amount-ish column; fall back to line 0 (old behaviour) if none found.
  const looksLikeHeader = (cells) => {
    const h = cells.map(c => c.toLowerCase());
    return h.some(c => c.includes("date")) && h.some(c => ["debit", "credit", "withdrawal", "deposit", "amount", "amt", "dr", "cr"].some(k => c === k || (k.length > 2 && c.includes(k))));
  };
  let headerIdx = 0;
  for (let i = 0; i < Math.min(lines.length - 1, 20); i++) {
    if (looksLikeHeader(parseRow(lines[i]))) { headerIdx = i; break; }
  }
  const headers = parseRow(lines[headerIdx]).map(h => h.toLowerCase());
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
  const refCol = colIdx(["ref no", "ref no.", "ref no./cheque no", "chq./ref.no.", "chq/ref no", "cheque no", "chq no", "reference no", "reference", "utr", "utr no", "utr number", "transaction id", "txn id"]);
  const balCol = colIdx(["balance", "closing balance", "running balance", "available balance", "balance amt"]);
  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = parseRow(lines[i]);
    if (cells.length < 2) continue;
    const rawDate = dateCol >= 0 ? cells[dateCol] : null;
    if (!rawDate) continue;
    const parsedDate = (() => {
      // DD/MM/YYYY or DD-MM-YYYY (Indian bank format) FIRST. `new Date("05/11/2024")`
      // mis-reads slash dates as US MM/DD and silently swaps day↔month for any day ≤ 12
      // (so 5 Nov becomes 11 May). Tests only used day=15 (>12), which forced Date to
      // fail and hid the swap.
      const m = rawDate.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
      if (m) {
        const day = Number(m[1]), mon = Number(m[2]);
        if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) {
          const y = m[3].length === 2 ? "20" + m[3] : m[3];
          return `${y}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        }
      }
      // ISO (YYYY-MM-DD) or month-name formats — let Date parse.
      const d = new Date(rawDate);
      if (!Number.isNaN(d.getTime())) return localDateKey(d);
      return null;
    })();
    if (!parsedDate) continue;
    const cleanAmt = v => parseFloat((v || "").replace(/[^0-9.]/g, "")) || 0;
    const debit = debitCol >= 0 ? cleanAmt(cells[debitCol]) : 0;
    const credit = creditCol >= 0 ? cleanAmt(cells[creditCol]) : 0;
    const generic = amtCol >= 0 ? cleanAmt(cells[amtCol]) : 0;
    const note = descCol >= 0 ? cells[descCol] : "";
    // Extra fields kept optional so rows without these columns keep the old shape.
    const rawRef = refCol >= 0 ? (cells[refCol] || "").trim() : "";
    const rawBal = balCol >= 0 ? (cells[balCol] || "").trim() : "";
    const extra = { ...(rawRef ? { ref: rawRef } : {}), ...(rawBal ? { balance: cleanAmt(rawBal) } : {}) };
    if (debit > 0) rows.push({ date: parsedDate, amount: debit, note, type: "expense", ...extra });
    else if (credit > 0) rows.push({ date: parsedDate, amount: credit, note, type: "income", ...extra });
    else if (generic > 0) rows.push({ date: parsedDate, amount: generic, note, type: "expense", ...extra });
  }
  return rows;
};
