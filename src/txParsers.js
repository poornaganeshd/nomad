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

// ——— UPI-app statement text → transaction rows (deterministic, no AI) ———
// GPay/PhonePe "Download statement" PDFs are text PDFs with a rigid per-txn
// block once pdfText.js reassembles the lines:
//   01 Jun, 2026 Paid to Thicknaagar Raman ₹500
//   07:16 PM UPI Transaction ID: 615293622557
//   Paid by State Bank of India 1062
// Parsing this locally is the PRIMARY statement path — it works offline, costs
// nothing, and cannot fail because an AI provider is down (the exact failure
// users kept hitting). AI parse / vision OCR are fallbacks for other layouts.
const _MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// A row line must carry: date, a direction keyword, and a trailing ₹amount.
// Requiring the keyword is what keeps header lines like the statement-period
// summary ("01 June 2026 - 30 June 2026 ₹6,835.50 ₹19,480.90") from matching.
const _UPI_ROW = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\s*[·|,-]?\s*(Paid to|Received from|Sent to|Money sent to|Refund from|Cashback from|Payment to|Transfer to|Transfer from|Self transfer)\s+(.*?)\s*₹\s?([\d,]+(?:\.\d{1,2})?)\s*$/i;
const _INCOME_DIR = /^(received from|refund from|cashback from|transfer from)$/i;
export const parseUpiStatement = (text) => {
  const rows = [];
  let cur = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = _UPI_ROW.exec(line);
    if (m) {
      const mon = _MON[m[2].slice(0, 3).toLowerCase()];
      const amount = parseFloat(m[6].replace(/,/g, ""));
      if (!mon || !(amount > 0)) { cur = null; continue; }
      const dir = m[4].toLowerCase();
      cur = {
        date: `${m[3]}-${String(mon).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`,
        amount,
        type: _INCOME_DIR.test(dir) ? "income" : "expense",
        note: (m[5] || "").trim() || m[4],
        ref: "",
      };
      rows.push(cur);
      continue;
    }
    // Continuation lines: attach the UPI transaction ID to the row above so
    // re-uploads dedupe via importedRefs exactly like the AI/OCR paths.
    if (cur && !cur.ref) {
      const r = /UPI\s+Transaction\s+ID\s*:?\s*([A-Za-z0-9]+)/i.exec(line);
      if (r) cur.ref = r[1];
    }
  }
  return rows;
};

// BHIM / bank "Transaction History" exports are HTML tables. Convert them to
// plain text lines (one table row per line, cells space-joined) so the same
// statement parsers (parseUpiStatement / AI text parse) can read them. Uses
// DOMParser when available (browser + jsdom); regex-strip fallback otherwise.
export function htmlStatementToText(html) {
  const src = String(html || "");
  try {
    if (typeof DOMParser !== "undefined") {
      const doc = new DOMParser().parseFromString(src, "text/html");
      doc.querySelectorAll("script,style,noscript").forEach((n) => n.remove());
      const rows = Array.from(doc.querySelectorAll("tr"))
        .map((tr) => Array.from(tr.querySelectorAll("th,td")).map((c) => (c.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean).join("  "))
        .filter(Boolean);
      if (rows.length) return rows.join("\n");
      // No tables — treat each leaf block element as one line (body.textContent
      // would glue sibling blocks together with no separator).
      const blocks = Array.from(doc.body ? doc.body.querySelectorAll("div,p,li,h1,h2,h3,h4,h5,h6,section,article") : [])
        .filter((el) => !el.querySelector("div,p,li,table,section,article"))
        .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
      if (blocks.length) return blocks.join("\n");
      return (doc.body ? doc.body.textContent : "").split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
    }
  } catch { /* malformed markup — fall through to the regex strip */ }
  return src
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(tr|p|div|li|h[1-6]|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}
