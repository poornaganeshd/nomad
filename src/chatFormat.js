// chatFormat.js — render Ask-NOMAD's markdown-ish replies as clean HTML.
//
// The finance model is told to list transactions as pipe rows
// (`date|amount|category|wallet|note`) or "·"-separated bullets. Rendered raw
// (the old code only did **bold** + <br>) that's an unreadable wall of pipes —
// the "reply is very bad" bug. This turns those rows into tidy transaction
// lines with a right-aligned ₹ amount, and handles bold / bullets / section
// labels / paragraphs. Output is an HTML string for dangerouslySetInnerHTML;
// every user/model-derived substring is HTML-escaped first.

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// Inline formatting on already-escaped text: **bold** and `code`.
const inline = (s) => esc(s)
  .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
  .replace(/`([^`]+)`/g, "<code>$1</code>");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-06-14" → "14 Jun". Anything unparseable is returned trimmed as-is.
export function prettyDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  if (!m) return String(s).trim();
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] || m[2]}`;
}

const inr = (n) => "₹" + Math.round(Number(n)).toLocaleString("en-IN");
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s).trim());
const isAmount = (s) => /^[+\-−]?\s*₹?\s*\d[\d,]*(\.\d+)?$/.test(String(s).trim());
const num = (s) => Number(String(s).replace(/[₹,\s+−-]/g, ""));

// Turn one line into a transaction row {date, amount, sign, desc}, or null if it
// isn't one. Accepts "|"- or "·"-separated fields, with an optional leading
// bullet. Column order is inferred (first date-looking field, first
// amount-looking field, the rest = description) so it survives model reordering.
// Guards against false positives on prose: needs an amount AND (a date OR ≥3
// fields).
export function parseTxRow(line) {
  const s = String(line).replace(/^\s*[-*•]\s+/, "").trim();
  let parts;
  if (s.includes("|")) parts = s.split("|");
  else if ((s.match(/·/g) || []).length >= 2) parts = s.split("·");
  else return null;
  parts = parts.map((p) => p.trim()).filter(Boolean);
  let date = null, amount = null, sign = "";
  const rest = [];
  for (const p of parts) {
    if (date === null && isDate(p)) { date = p; continue; }
    if (amount === null && isAmount(p)) { amount = num(p); sign = /^[+]/.test(p) ? "+" : (/^[−-]/.test(p) ? "−" : ""); continue; }
    rest.push(p);
  }
  if (amount === null || !(date || parts.length >= 3)) return null;
  return { date, amount, sign, desc: rest.join(" · ") };
}

// Full reply → HTML. Consecutive transaction rows are grouped into one card.
export function renderChatHtml(raw) {
  const lines = String(raw == null ? "" : raw).split(/\r?\n/);
  const out = [];
  let txBuf = [];
  const flush = () => { if (txBuf.length) { out.push(`<div class="nmd-txs">${txBuf.join("")}</div>`); txBuf = []; } };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) { flush(); out.push('<div class="nmd-sp"></div>'); continue; }
    const tx = parseTxRow(line);
    if (tx) {
      const cls = tx.sign === "+" ? " nmd-in" : "";
      txBuf.push(`<div class="nmd-tx"><span class="nmd-tx-d">${tx.date ? esc(prettyDate(tx.date)) : ""}</span><span class="nmd-tx-n">${inline(tx.desc)}</span><span class="nmd-tx-a${cls}">${tx.sign ? esc(tx.sign) + " " : ""}${esc(inr(tx.amount))}</span></div>`);
      continue;
    }
    flush();
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    if (bullet) { out.push(`<div class="nmd-li"><span class="nmd-dot">•</span><span>${inline(bullet[1])}</span></div>`); continue; }
    // A short line ending in ":" (and carrying no ₹) reads as a section label.
    if (/^.{1,44}:$/.test(line) && !/₹/.test(line)) { out.push(`<div class="nmd-h">${inline(line)}</div>`); continue; }
    out.push(`<div class="nmd-p">${inline(line)}</div>`);
  }
  flush();
  return out.join("");
}
