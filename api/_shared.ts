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
  } else if (s.frequency === "monthly") {
    n.setUTCMonth(n.getUTCMonth() + 1);
    if (s.send_day_of_month != null) n.setUTCDate(Math.min(s.send_day_of_month, 28));
  } else if (s.frequency === "quarterly") {
    n.setUTCMonth(n.getUTCMonth() + 3);
    if (s.send_day_of_month != null) n.setUTCDate(Math.min(s.send_day_of_month, 28));
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
      <td style="padding:10px 20px 10px 24px;font-size:13px;color:#cccccc;font-family:'Segoe UI',Arial,sans-serif;white-space:nowrap;">${c.name}</td>
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

  const [expenses, incomes, transfers, allExpenses, allIncomes, allTransfers] = await Promise.all([
    s.include_expenses  ? userGet(sbUrl, sbKey, `/expenses?date=gte.${pStart}&date=lte.${pEnd}${catFilter}&select=*`)  : [],
    s.include_incomes   ? userGet(sbUrl, sbKey, `/incomes?date=gte.${pStart}&date=lte.${pEnd}&select=*`)               : [],
    s.include_transfers ? userGet(sbUrl, sbKey, `/transfers?date=gte.${pStart}&date=lte.${pEnd}&select=*`)             : [],
    userGet(sbUrl, sbKey, `/expenses?date=gte.${backupCutoff}&select=*&order=date.desc`),
    userGet(sbUrl, sbKey, `/incomes?date=gte.${backupCutoff}&select=*&order=date.desc`),
    userGet(sbUrl, sbKey, `/transfers?date=gte.${backupCutoff}&select=*&order=date.desc`),
  ]) as [Expense[], Income[], Transfer[], Expense[], Income[], Transfer[]];

  const totalSpent     = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
  const totalIncome    = incomes.reduce((sum, i)  => sum + Number(i.amount), 0);
  const totalTransfers = transfers.reduce((sum, t) => sum + Number(t.amount), 0);
  const catMap = new Map<string, number>();
  expenses.forEach(e => catMap.set(e.categoryId, (catMap.get(e.categoryId) ?? 0) + Number(e.amount)));
  const byCategory = Array.from(catMap.entries()).map(([id, amount]) => ({ name: prettyCategory(id), amount }));

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
