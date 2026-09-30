import nodemailer from "nodemailer";
import { subDays, format } from "date-fns";

export interface UserEntry { supabase_url: string; anon_key: string; }
export interface Schedule {
  id: string; user_id: string; email: string;
  frequency: "weekly" | "monthly" | "quarterly" | "custom";
  custom_days: number | null; send_hour: number;
  send_day_of_week: number | null; send_day_of_month: number | null;
  include_expenses: boolean; include_incomes: boolean; include_transfers: boolean;
  selected_categories: string[] | null;
  next_send_at: string; is_active: boolean;
}
interface Expense  { amount: number; categoryId: string; walletId: string; date: string; note?: string; }
interface Income   { amount: number; sourceId: string;   walletId: string; date: string; }
interface Transfer { amount: number; fromWallet: string; toWallet: string; date: string; note?: string; }

export function makeHeaders(key: string) {
  return { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}`, Prefer: "return=representation" };
}
export async function userGet(baseUrl: string, key: string, path: string) {
  const r = await fetch(`${baseUrl}/rest/v1${path}`, { headers: makeHeaders(key) });
  if (!r.ok) throw new Error(`GET ${baseUrl}${path} → ${r.status}`);
  return r.json();
}
// Read EVERY row a PostgREST query matches, a page at a time. Port of
// src/sbPaging.js fetchAllRows (api/ is CommonJS and cannot import src/).
//
// Supabase clamps every response to the project's "Max rows" (1000 by default)
// whatever `limit` the URL asks for, so a plain userGet silently returns the
// first 1000 rows. The 365-day backup attached to every report email read
// expenses that way — anyone logging ~3 a day got a "backup" missing months
// of data with nothing to say so — and the reminder cron's settlements read
// did too, so past 1000 settlements "You owe ₹X" stopped subtracting payments.
//
// `order` must be a TOTAL order (end on a unique column) or offset paging can
// skip or repeat rows between pages. The page size is whatever the server
// actually returned, so a project with Max rows set to 500 still pages right.
// A failed page fails the whole read — a partial table is worse than none.
const MAX_PAGES = 200; // 200k rows — a runaway guard, not a real limit
export async function userGetAll(baseUrl: string, key: string, path: string, order = "id.asc", fetchImpl: typeof fetch = fetch): Promise<unknown[]> {
  const sep = path.includes("?") ? "&" : "?";
  const url = (offset: number) => `${baseUrl}/rest/v1${path}${sep}order=${order}&offset=${offset}`;
  const first = await fetchImpl(url(0), { headers: { ...makeHeaders(key), Prefer: "count=exact" } });
  if (!first.ok) throw new Error(`GET ${baseUrl}${path} → ${first.status}`);
  const head: unknown = await first.json();
  if (!Array.isArray(head)) throw new Error(`GET ${baseUrl}${path} → not a list`);
  let rows: unknown[] = head;
  const m = /\/(\d+)\s*$/.exec(String(first.headers?.get?.("content-range") || ""));
  const total = m ? Number(m[1]) : null;
  const pageSize = rows.length;
  for (let page = 1; page < MAX_PAGES && pageSize > 0; page++) {
    // Known total → stop once we hold it. Unknown (header stripped by a
    // proxy) → stop on a short page, the best that can be done.
    if (total != null ? rows.length >= total : rows.length % pageSize !== 0) break;
    const r = await fetchImpl(url(rows.length), { headers: makeHeaders(key) });
    if (!r.ok) throw new Error(`GET ${baseUrl}${path} → ${r.status}`);
    const next: unknown = await r.json();
    if (!Array.isArray(next)) throw new Error(`GET ${baseUrl}${path} → not a list`);
    if (next.length === 0) break;
    rows = rows.concat(next);
  }
  return rows;
}

// A group expense someone ELSE paid is stored with this placeholder wallet: it
// records the event's total, but none of it left your wallets (your share is a
// separate IOU). The app leaves it out of every spend figure (isTrackedExp in
// App.jsx); the email report counted it as money you spent.
export const isTrackedExpense = (e: { walletId?: string | null }) => e?.walletId === "__tracked__";

const escHtml = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

export async function userPatch(baseUrl: string, key: string, path: string, body: object) {
  await fetch(`${baseUrl}/rest/v1${path}`, { method: "PATCH", headers: makeHeaders(key), body: JSON.stringify(body) });
}
export async function userPost(baseUrl: string, key: string, table: string, body: object) {
  await fetch(`${baseUrl}/rest/v1/${table}`, { method: "POST", headers: makeHeaders(key), body: JSON.stringify(body) });
}

export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last!: Error;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); }
    catch (e) { last = e as Error; if (i < attempts) await new Promise(r => setTimeout(r, 2 ** i * 1000)); }
  }
  throw last;
}

export function getPeriod(s: Schedule, now: Date) {
  // Use UTC-based arithmetic so results are timezone-independent
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  if (s.frequency === "weekly")    return { start: subDays(now, 7), end: subDays(now, 1) };
  if (s.frequency === "monthly") {
    const pm = m === 0 ? 11 : m - 1, py = m === 0 ? y - 1 : y;
    return { start: new Date(Date.UTC(py, pm, 1)), end: new Date(Date.UTC(py, pm + 1, 0)) };
  }
  if (s.frequency === "quarterly") {
    const em = m === 0 ? 11 : m - 1, ey = m === 0 ? y - 1 : y;
    const sm = ((m - 3) + 12) % 12, sy = m < 3 ? y - 1 : y;
    return { start: new Date(Date.UTC(sy, sm, 1)), end: new Date(Date.UTC(ey, em + 1, 0)) };
  }
  return { start: subDays(now, s.custom_days ?? 7), end: subDays(now, 1) };
}
export function getNextSendAt(s: Schedule, now: Date): Date {
  const n = new Date(now);
  if (s.frequency === "weekly") {
    n.setUTCDate(n.getUTCDate() + 7);
    if (s.send_day_of_week != null) {
      const diff = ((s.send_day_of_week - n.getUTCDay()) + 7) % 7;
      if (diff !== 0) n.setUTCDate(n.getUTCDate() + diff);
    }
  } else if (s.frequency === "monthly" || s.frequency === "quarterly") {
    // Use setUTCFullYear(y, m, d) atomically — calling setUTCMonth() on a date
    // with day=31 silently overflows when the target month has <31 days (e.g.
    // Jan 31 → setUTCMonth(1) lands on Mar 2/3, skipping Feb entirely).
    const step = s.frequency === "monthly" ? 1 : 3;
    const targetMonth = n.getUTCMonth() + step;  // setUTCFullYear handles month >= 12 by rolling the year
    const targetYear  = n.getUTCFullYear();
    const lastDay     = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    const targetDay   = s.send_day_of_month != null
      ? Math.min(s.send_day_of_month, lastDay)
      : Math.min(n.getUTCDate(), lastDay);
    n.setUTCFullYear(targetYear, targetMonth, targetDay);
  } else {
    n.setUTCDate(n.getUTCDate() + (s.custom_days ?? 7));
  }
  // Convert IST send_hour to UTC (IST = UTC+5:30)
  const istMin = s.send_hour * 60 - 330;
  const utcMin = ((istMin % 1440) + 1440) % 1440;
  if (istMin < 0) n.setUTCDate(n.getUTCDate() - 1);
  n.setUTCHours(Math.floor(utcMin / 60), utcMin % 60, 0, 0);
  return n;
}

// User categories live only in the client (DC constant + custom additions). The
// server cron has no categories table to join against, so render a best-effort
// friendly name from the id: snake_case → "Title Case".
export function prettyCategory(id: string | undefined | null): string {
  if (!id) return "Uncategorized";
  return id.split(/[_\-]+/).map(w => w ? w.charAt(0).toUpperCase() + w.slice(1) : "").join(" ").trim() || id;
}

// The figures the report states. Money only: a group expense someone else
// paid (isTrackedExpense) is not spending of yours, and amounts are summed in
// paisa so a month of ₹x.10 entries can't print as ₹1,234.5600000001.
export function reportTotals(expenses: Expense[], incomes: Income[], transfers: Transfer[]) {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const own = (expenses || []).filter(e => !isTrackedExpense(e));
  const totalSpent     = r2(own.reduce((sum, e) => sum + (Number(e.amount) || 0), 0));
  const totalIncome    = r2((incomes || []).reduce((sum, i) => sum + (Number(i.amount) || 0), 0));
  const totalTransfers = r2((transfers || []).reduce((sum, t) => sum + (Number(t.amount) || 0), 0));
  const catMap = new Map<string, number>();
  own.forEach(e => catMap.set(e.categoryId, r2((catMap.get(e.categoryId) ?? 0) + (Number(e.amount) || 0))));
  const byCategory = Array.from(catMap.entries()).map(([id, amount]) => ({ name: prettyCategory(id), amount }));
  return { totalSpent, totalIncome, totalTransfers, byCategory };
}

function buildCsv(expenses: Expense[], incomes: Income[], transfers: Transfer[], s: Schedule) {
  const q = (v?: string) => `"${(v ?? "").replace(/"/g, '""')}"`;
  let csv = "Type,Date,Amount,Category/Source/From,To/Wallet,Note\n";
  if (s.include_incomes)   incomes.forEach(i   => { csv += `Income,${i.date},${i.amount},${q(prettyCategory(i.sourceId))},${q(i.walletId)},\n`; });
  if (s.include_expenses)  expenses.forEach(e  => { csv += `Expense,${e.date},${e.amount},${q(prettyCategory(e.categoryId))},${q(e.walletId)},${q(e.note)}\n`; });
  if (s.include_transfers) transfers.forEach(t => { csv += `Transfer,${t.date},${t.amount},${q(t.fromWallet)},${q(t.toWallet)},${q(t.note)}\n`; });
  return csv;
}
function buildBackup(expenses: Expense[], incomes: Income[], transfers: Transfer[]) {
  return JSON.stringify({ expenses, incomes, transfers, _v: "nomad-v9", _date: new Date().toISOString() }, null, 2);
}

function buildHtml(opts: { schedule: Schedule; periodStart: Date; periodEnd: Date; totalSpent: number; totalIncome: number; totalTransfers: number; byCategory: { name: string; amount: number }[] }) {
  const { schedule: s, periodStart, periodEnd, totalSpent, totalIncome, totalTransfers, byCategory } = opts;
  const inr  = (n: number) => "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
  const net  = totalIncome - totalSpent;
  const netC = net >= 0 ? "#6BAA75" : "#D4726A";
  const label  = s.frequency === "custom" ? `Every ${s.custom_days}d` : s.frequency.charAt(0).toUpperCase() + s.frequency.slice(1);
  const period = `${format(periodStart, "MMM d")} – ${format(periodEnd, "MMM d, yyyy")}`;

  const catRows = byCategory.sort((a, b) => b.amount - a.amount).slice(0, 10).map(c => {
    const pct = totalSpent > 0 ? Math.round((c.amount / totalSpent) * 100) : 0;
    return `<tr>
      <td style="padding:10px 20px 10px 24px;font-size:13px;color:#cccccc;font-family:'Segoe UI',Arial,sans-serif;white-space:nowrap;">${escHtml(c.name)}</td>
      <td style="padding:10px 8px;width:100%;"><div style="height:6px;border-radius:3px;background:#2a2a2a;"><div style="height:6px;border-radius:3px;background:#c9a96e;width:${Math.max(4, pct)}%;"></div></div></td>
      <td style="padding:10px 24px 10px 8px;font-size:13px;color:#c9a96e;font-family:'Segoe UI',Arial,sans-serif;text-align:right;font-weight:700;white-space:nowrap;">${inr(c.amount)} <span style="color:#555;font-weight:400;font-size:11px;">${pct}%</span></td>
    </tr>`;
  }).join("");

  const statCards = [
    s.include_expenses  && `<td style="background:#242424;border-radius:12px;padding:16px;vertical-align:top;"><div style="font-size:9px;color:#666;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">Spent</div><div style="font-size:20px;font-weight:800;color:#c9a96e;">${inr(totalSpent)}</div></td>`,
    s.include_incomes   && `<td width="8"></td><td style="background:#242424;border-radius:12px;padding:16px;vertical-align:top;"><div style="font-size:9px;color:#666;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">Income</div><div style="font-size:20px;font-weight:800;color:#6BAA75;">${inr(totalIncome)}</div></td>`,
    `<td width="8"></td><td style="background:#242424;border-radius:12px;padding:16px;vertical-align:top;"><div style="font-size:9px;color:#666;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">Net</div><div style="font-size:20px;font-weight:800;color:${netC};">${net >= 0 ? "+" : ""}${inr(net)}</div></td>`,
    s.include_transfers && `<td width="8"></td><td style="background:#242424;border-radius:12px;padding:16px;vertical-align:top;"><div style="font-size:9px;color:#666;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">Transfers</div><div style="font-size:20px;font-weight:800;color:#7B8CDE;">${inr(totalTransfers)}</div></td>`,
  ].filter(Boolean).join("");

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f0f0f;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0f0f;padding:32px 16px;"><tr><td>
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;">
  <tr><td style="background:#1a1a1a;border-radius:16px 16px 0 0;padding:36px 32px 28px;">
    <div style="font-size:30px;margin-bottom:6px;">🦁</div>
    <div style="font-size:22px;font-weight:800;color:#fff;letter-spacing:4px;margin-bottom:6px;">NOMAD</div>
    <div style="font-size:13px;color:#c9a96e;font-weight:600;">${label} Report &nbsp;·&nbsp; ${period}</div>
  </td></tr>
  <tr><td style="background:#1a1a1a;padding:0 24px 28px;"><table width="100%" cellpadding="0" cellspacing="0"><tr>${statCards}</tr></table></td></tr>
  ${s.include_expenses ? `<tr><td style="background:#1e1e1e;padding:28px 8px 20px;">
    <div style="font-size:10px;font-weight:700;color:#555;letter-spacing:1px;text-transform:uppercase;margin:0 24px 14px;">Spending by Category</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      ${catRows || '<tr><td colspan="3" style="padding:20px 24px;color:#555;font-size:13px;text-align:center;">No expenses this period</td></tr>'}
    </table>
  </td></tr>` : ""}
  <tr><td style="background:#141414;border-radius:0 0 16px 16px;padding:22px 32px;border-top:1px solid #2a2a2a;">
    <div style="font-size:12px;color:#555;line-height:2.2;">
      📎 &nbsp;Attached: <span style="color:#888;">nomad_report.csv &amp; nomad_backup.json</span><br>
      🔒 &nbsp;Your data lives in your own Supabase — NOMAD never stores it centrally.<br>
      <span style="color:#c9a96e;font-weight:600;">NOMAD</span> &nbsp;·&nbsp; Track smart. Spend wise. 🦁
    </div>
  </td></tr>
</table></td></tr></table></body></html>`;
}

export async function processSchedule(
  s: Schedule,
  sbUrl: string,
  sbKey: string,
  transporter: nodemailer.Transporter,
  gmailUser: string,
  now: Date,
) {
  const { start, end } = getPeriod(s, now);
  const pStart = format(start, "yyyy-MM-dd");
  const pEnd   = format(end,   "yyyy-MM-dd");
  const catFilter = s.selected_categories?.length ? `&categoryId=in.(${s.selected_categories.join(",")})` : "";

  // Cap the "full backup" attachment at the last 365 days. The previous code
  // fetched all-time history per user per cron tick, producing multi-MB
  // attachments for long-time users that could bounce on recipient size limits
  // and made the cron very slow. Most users use the email primarily for the
  // current period; a 1-year rolling backup is more than enough for the rest.
  const backupCutoff = format(subDays(now, 365), "yyyy-MM-dd");

  // Exclude soft-deleted rows (deleted_at IS NOT NULL). Without this, items the
  // user deleted in-app still inflate report totals and get resurrected from the
  // backup attachment on restore — the frontend filters them everywhere, so the
  // email/backup must match. (deleted_at is added to all core tables by
  // nomad_setup.sql, the same script that creates report_schedules.)
  // Paged (userGetAll): a plain read stops at Supabase's 1000-row cap, which a
  // year of expenses passes easily — the backup attachment came back short.
  const PERIOD = "date.asc,id.asc", RECENT = "date.desc,id.desc";
  const [expenses, incomes, transfers, allExpenses, allIncomes, allTransfers] = await Promise.all([
    s.include_expenses  ? userGetAll(sbUrl, sbKey, `/expenses?date=gte.${pStart}&date=lte.${pEnd}${catFilter}&deleted_at=is.null&select=*`, PERIOD)  : [],
    s.include_incomes   ? userGetAll(sbUrl, sbKey, `/incomes?date=gte.${pStart}&date=lte.${pEnd}&deleted_at=is.null&select=*`, PERIOD)               : [],
    s.include_transfers ? userGetAll(sbUrl, sbKey, `/transfers?date=gte.${pStart}&date=lte.${pEnd}&deleted_at=is.null&select=*`, PERIOD)             : [],
    userGetAll(sbUrl, sbKey, `/expenses?date=gte.${backupCutoff}&deleted_at=is.null&select=*`, RECENT),
    userGetAll(sbUrl, sbKey, `/incomes?date=gte.${backupCutoff}&deleted_at=is.null&select=*`, RECENT),
    userGetAll(sbUrl, sbKey, `/transfers?date=gte.${backupCutoff}&deleted_at=is.null&select=*`, RECENT),
  ]) as [Expense[], Income[], Transfer[], Expense[], Income[], Transfer[]];

  const { totalSpent, totalIncome, totalTransfers, byCategory } = reportTotals(expenses, incomes, transfers);

  const lbl    = `${s.frequency}_${format(end, "yyyy-MM-dd")}`;
  const fLabel = s.frequency === "custom" ? `Every ${s.custom_days}d` : s.frequency.charAt(0).toUpperCase() + s.frequency.slice(1);

  await transporter.sendMail({
    from: `NOMAD Reports <${gmailUser}>`,
    to: s.email,
    subject: `🦁 NOMAD ${fLabel} Report — ${format(start, "MMM d")} to ${format(end, "MMM d, yyyy")}`,
    html: buildHtml({ schedule: s, periodStart: start, periodEnd: end, totalSpent, totalIncome, totalTransfers, byCategory }),
    attachments: [
      { filename: `nomad_${lbl}.csv`,         content: buildCsv(expenses, incomes, transfers, s) },
      { filename: `nomad_backup_${format(now, "yyyy-MM-dd")}.json`, content: buildBackup(allExpenses, allIncomes, allTransfers) },
    ],
  });
}
