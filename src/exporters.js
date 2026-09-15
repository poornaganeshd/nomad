// exporters.js — the ledger as something other people's software can read.
//
// Export was one flat CSV (every row type crammed into six columns, so
// "Category/Source" means three different things depending on the row) plus a
// JSON backup that only NOMAD can open. Neither is what you hand an accountant,
// attach to a reimbursement claim, or open next to a bank statement.
//
// Two formats, no dependencies:
//
//   • SpreadsheetML 2003 (.xls) — Excel, LibreOffice, Numbers and Google Sheets
//     all open it. Real worksheets, so each row type gets its OWN columns
//     instead of sharing one lowest-common-denominator header, and numbers
//     arrive as numbers rather than text that needs re-typing before it sums.
//     A bundled xlsx writer would be ~100 kB of the main chunk for this.
//
//   • A printable HTML statement — the browser's own "Save as PDF" turns it
//     into a PDF. A real PDF writer is another large dependency, and a print
//     stylesheet gives the same artifact plus the ability to actually print it.
//
// Pure string builders: no DOM, no download, no clock beyond what is passed in.

// Built from char codes so no literal control byte ends up in this source file
// (and so eslint's no-irregular-whitespace has nothing to trip on).
const XML_ILLEGAL = new RegExp("[" + "\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F" + "]", "g");

const esc = (v) => String(v ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;")
  // Control characters are not legal in XML 1.0 and make Excel refuse the whole
  // file — one stray byte in one note would break the entire export.
  .replace(XML_ILLEGAL, "");

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const cell = (v) => isNum(v)
  ? `<Cell><Data ss:Type="Number">${v}</Data></Cell>`
  : `<Cell><Data ss:Type="String">${esc(v)}</Data></Cell>`;
const row = (cells) => `<Row>${cells.map(cell).join("")}</Row>`;
const headerRow = (cells) => `<Row>${cells.map(c => `<Cell ss:StyleID="h"><Data ss:Type="String">${esc(c)}</Data></Cell>`).join("")}</Row>`;

const sheet = (name, header, rows, widths) => {
  // Excel rejects : \ / ? * [ ] in a sheet name and caps it at 31 chars.
  const safe = String(name).replace(/[:\\/?*[\]]/g, " ").slice(0, 31);
  const cols = (widths || header.map(() => 110)).map(w => `<Column ss:Width="${w}"/>`).join("");
  return `<Worksheet ss:Name="${esc(safe)}"><Table>${cols}${headerRow(header)}${rows.map(row).join("")}</Table></Worksheet>`;
};

/** Rows whose `date` falls in [from, to], with null bounds meaning unbounded. */
export const inPeriod = (rows, from, to) => (rows || []).filter(r => {
  if (!r || r.deleted_at) return false;
  const d = r.date;
  if (typeof d !== "string") return false;
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
});

const nameOf = (list, id, fallback = "") => (list || []).find(x => x && x.id === id)?.name || fallback || id || "";

/**
 * The whole ledger as a SpreadsheetML workbook.
 *
 * One worksheet per row type, each with the columns that type actually has —
 * an expense has a category, a transfer has two wallets, a settlement has a
 * direction and a person. The single-CSV export had to pretend they were the
 * same shape.
 */
export function buildWorkbook({ expenses = [], incomes = [], transfers = [], settlements = [], splits = [], wallets = [], categories = [], sources = [], events = [], balances = {}, from = null, to = null, today = "" } = {}) {
  const w = (id) => nameOf(wallets, id, id);
  const c = (id) => nameOf(categories, id, id);
  const s = (id) => nameOf(sources, id, id);
  const ev = (id) => (id ? nameOf(events, id, "") : "");

  const ex = inPeriod(expenses, from, to);
  const inc = inPeriod(incomes, from, to);
  const tr = inPeriod(transfers, from, to);
  const st = inPeriod(settlements, from, to);
  const sp = (splits || []).filter(x => x && !x.deleted_at);

  const sum = (rows) => Math.round(rows.reduce((t, r) => t + (Number(r.amount) || 0), 0) * 100) / 100;
  const totalIn = sum(inc), totalOut = sum(ex);

  const sheets = [
    sheet("Summary", ["Item", "Value"], [
      ["Period", from || to ? `${from || "start"} to ${to || today || "today"}` : "All time"],
      ["Generated", today],
      ["Income", totalIn],
      ["Expenses", totalOut],
      ["Net", Math.round((totalIn - totalOut) * 100) / 100],
      ["Transactions", ex.length + inc.length + tr.length + st.length],
      ...(wallets.length ? [["", ""], ["Wallet", "Balance"]] : []),
      ...wallets.map(x => [x.name, Math.round((Number(balances[x.id]) || 0) * 100) / 100]),
    ], [170, 150]),

    sheet("Expenses", ["Date", "Amount", "Category", "Wallet", "Note", "Event"],
      ex.map(e => [e.date, Number(e.amount) || 0, c(e.categoryId), e.walletId === "__tracked__" ? "(paid by someone else)" : w(e.walletId), e.note || "", ev(e.eventId)]),
      [90, 90, 130, 120, 240, 130]),

    sheet("Income", ["Date", "Amount", "Source", "Wallet", "Note"],
      inc.map(i => [i.date, Number(i.amount) || 0, s(i.sourceId), w(i.walletId), i.note || ""]),
      [90, 90, 130, 120, 240]),

    sheet("Transfers", ["Date", "Amount", "From", "To", "Note"],
      tr.map(t => [t.date, Number(t.amount) || 0, w(t.fromWallet), w(t.toWallet), t.note || ""]),
      [90, 90, 120, 120, 240]),

    sheet("Settlements", ["Date", "Amount", "Person", "Direction", "Wallet", "Event"],
      st.map(x => [x.date, Number(x.amount) || 0, x.splitName || "", x.direction === "owed" ? "Received" : "Paid", w(x.walletId), ev(x.eventId)]),
      [90, 90, 130, 100, 120, 130]),

    sheet("IOUs", ["Date", "Person", "Amount", "Direction", "Status", "Event", "Note"],
      sp.map(x => [x.date || "", x.name || "", Number(x.amount) || 0, x.direction === "owed" ? "Owes you" : "You owe", x.skipped ? "Written off" : x.settled ? "Settled" : "Pending", ev(x.eventId), x.note || ""]),
      [90, 130, 90, 100, 110, 130, 200]),
  ];

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles><Style ss:ID="h"><Font ss:Bold="1"/><Interior ss:Color="#EFEAE0" ss:Pattern="Solid"/></Style></Styles>
${sheets.join("\n")}
</Workbook>`;
}

/**
 * A printable statement for one period — the thing you actually hand someone.
 *
 * Self-contained HTML with its own print stylesheet, so "Save as PDF" in the
 * browser's print dialog produces the PDF without shipping a PDF writer.
 */
export function buildStatementHtml({ expenses = [], incomes = [], transfers = [], settlements = [], wallets = [], categories = [], sources = [], balances = {}, from = null, to = null, today = "", periodLabel = "All time", currency = "₹" } = {}) {
  const w = (id) => nameOf(wallets, id, id);
  const money = (n) => `${currency}${(Math.round((Number(n) || 0) * 100) / 100).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  const ex = inPeriod(expenses, from, to);
  const inc = inPeriod(incomes, from, to);
  const tr = inPeriod(transfers, from, to);
  const st = inPeriod(settlements, from, to);
  const totalIn = inc.reduce((t, r) => t + (Number(r.amount) || 0), 0);
  const totalOut = ex.reduce((t, r) => t + (Number(r.amount) || 0), 0);

  const byCat = {};
  ex.forEach(e => { const k = nameOf(categories, e.categoryId, "Other"); byCat[k] = (byCat[k] || 0) + (Number(e.amount) || 0); });
  const catRows = Object.entries(byCat).sort((a, b) => b[1] - a[1]);

  const all = [
    ...inc.map(r => ({ ...r, _k: "Income", _label: nameOf(sources, r.sourceId, "Income"), _sign: 1, _wallet: w(r.walletId) })),
    ...ex.map(r => ({ ...r, _k: "Expense", _label: nameOf(categories, r.categoryId, "Other"), _sign: -1, _wallet: r.walletId === "__tracked__" ? "tracked" : w(r.walletId) })),
    ...tr.map(r => ({ ...r, _k: "Transfer", _label: `${w(r.fromWallet)} → ${w(r.toWallet)}`, _sign: 0, _wallet: "" })),
    ...st.map(r => ({ ...r, _k: "Settlement", _label: r.splitName || "", _sign: r.direction === "owed" ? 1 : -1, _wallet: w(r.walletId) })),
  ].sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const tx = all.map(r => `<tr><td>${esc(r.date)}</td><td>${esc(r._k)}</td><td>${esc(r._label)}</td><td>${esc(r._wallet)}</td><td class="n">${esc(r.note || "")}</td><td class="amt ${r._sign < 0 ? "neg" : r._sign > 0 ? "pos" : ""}">${r._sign < 0 ? "−" : r._sign > 0 ? "+" : ""}${money(r.amount)}</td></tr>`).join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>NOMAD statement — ${esc(periodLabel)}</title>
<style>
  @page { margin: 14mm; }
  * { box-sizing: border-box; }
  body { font: 12px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1b1b1b; margin: 0; padding: 22px; }
  h1 { font-size: 20px; margin: 0 0 2px; letter-spacing: -0.01em; }
  .sub { color: #666; font-size: 12px; margin-bottom: 18px; }
  .cards { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
  .card { flex: 1; min-width: 130px; border: 1px solid #e2ddd3; border-radius: 8px; padding: 10px 12px; }
  .card .k { font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: #777; }
  .card .v { font-size: 17px; font-weight: 700; margin-top: 3px; }
  h2 { font-size: 13px; margin: 20px 0 7px; text-transform: uppercase; letter-spacing: 0.07em; color: #555; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: #777; border-bottom: 1.5px solid #ddd; padding: 6px; }
  td { padding: 5px 6px; border-bottom: 1px solid #f0ece5; vertical-align: top; }
  td.amt { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; font-weight: 600; }
  td.n { color: #555; max-width: 220px; word-break: break-word; }
  .pos { color: #2e7d4f; } .neg { color: #b4472f; }
  .empty { color: #888; padding: 14px 0; }
  @media print { body { padding: 0; } tr { break-inside: avoid; } h2 { break-after: avoid; } }
</style></head><body>
<h1>NOMAD statement</h1>
<div class="sub">${esc(periodLabel)}${from || to ? ` &middot; ${esc(from || "start")} to ${esc(to || today)}` : ""} &middot; generated ${esc(today)}</div>
<div class="cards">
  <div class="card"><div class="k">Money in</div><div class="v pos">${money(totalIn)}</div></div>
  <div class="card"><div class="k">Money out</div><div class="v neg">${money(totalOut)}</div></div>
  <div class="card"><div class="k">Net</div><div class="v">${money(totalIn - totalOut)}</div></div>
  <div class="card"><div class="k">Entries</div><div class="v">${all.length}</div></div>
</div>
${catRows.length ? `<h2>Where it went</h2><table><thead><tr><th>Category</th><th style="text-align:right">Amount</th><th style="text-align:right">Share</th></tr></thead><tbody>${catRows.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="amt">${money(v)}</td><td class="amt">${totalOut > 0 ? Math.round((v / totalOut) * 100) : 0}%</td></tr>`).join("")}</tbody></table>` : ""}
${wallets.length ? `<h2>Balances</h2><table><thead><tr><th>Wallet</th><th style="text-align:right">Balance</th></tr></thead><tbody>${wallets.map(x => `<tr><td>${esc(x.name)}</td><td class="amt">${money(balances[x.id] || 0)}</td></tr>`).join("")}</tbody></table>` : ""}
<h2>Transactions</h2>
${all.length ? `<table><thead><tr><th>Date</th><th>Type</th><th>Category / Person</th><th>Wallet</th><th>Note</th><th style="text-align:right">Amount</th></tr></thead><tbody>${tx}</tbody></table>` : `<div class="empty">Nothing logged in this period.</div>`}
</body></html>`;
}
