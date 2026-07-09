/**
 * ai-chat.ts  POST /api/ai-chat
 *
 * Conversational finance Q&A grounded in the user's own transaction data.
 * The client sends the question + a compact ALL-TIME dataset (PII-redacted
 * client-side): every expense/income row as pipe-compact fields with wallet
 * and category names, plus month / all-time summaries, recurring bills and
 * pending IOUs. The model is instructed to filter, sum and compare those rows
 * itself — so "everything over ₹500 from cash last month" is answerable.
 *
 * No persistent memory — each call is independent (stateless). For a personal
 * single-user app this is fine; the context payload carries the data.
 *
 * Request body:
 *   {
 *     question: string
 *     context: {
 *       today?:          string  YYYY-MM-DD (client-local — anchors "last month")
 *       month?:          string  YYYY-MM current month
 *       monthIncome?:    number   monthExpense?: number     (current month)
 *       allTimeIncome?:  number   allTimeExpense?: number
 *       expenses?:       Array<{ d, a, c, w, n }>  all-time, newest first, redacted
 *       incomes?:        Array<{ d, a, s, w, n }>
 *       coverage?:       { from, to, total, sent }
 *       topCategories?:  Array<{ name, amount, pct }>
 *       walletBalances?: Array<{ name, balance }>
 *       recurringBills?: Array<{ name, amount }>
 *       iou?:            { owedToMe, iOwe }
 *       recurringCount?: number
 *       streak?:         number
 *       // legacy shape (lion one-liner still sends these):
 *       totalIncome?: number  totalExpense?: number
 *     }
 *   }
 *
 * Response 200:
 *   { answer: string }
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { callText, AiProviderError, configuredProviderCount } from "./_ai-provider.js";

const SYSTEM_PROMPT = `You are NOMAD's personal finance analyst for an Indian user tracking money in INR (₹).
Every message includes the user's ACTUAL transaction rows (all-time, newest first) plus summaries. You are expected to compute answers from those rows — filter by date range, wallet, category, amount threshold, or keyword; sum, count, average and compare. Never say you lack data when matching rows exist; if a question falls outside the covered date range, say exactly what range you do have.

Rules for answering:
- Do the math from the rows. "Spends over ₹500 from Cash last month" → filter rows by wallet=Cash, amount>500, date in last calendar month (anchor on TODAY's date given in context), then list them.
- When listing transactions: one per line, "DD MMM · ₹amount · category · note", max 15 lines, then "…and N more totalling ₹X".
- Use **bold** for key numbers, ₹ with Indian digit grouping (₹1,24,500), round to whole rupees unless paise matter.
- Be concise and direct — a smart friend who knows finance. 2-5 sentences around any list.
- Actionable, specific advice tied to their numbers; no generic platitudes.
- Indian context: UPI, EMIs, salary day, festivals, rent, SIPs.
- If truly unanswerable from the data, say so in one line and name what to log.`;

interface TopCategory { name: string; amount: number; pct: number; }
interface WalletBalance { name: string; balance: number; }
interface CompactExpense { d?: string; a?: number; c?: string; w?: string; n?: string; }
interface CompactIncome { d?: string; a?: number; s?: string; w?: string; n?: string; }

interface ChatContext {
  today?:          string;
  month?:          string;
  monthIncome?:    number;
  monthExpense?:   number;
  allTimeIncome?:  number;
  allTimeExpense?: number;
  expenses?:       CompactExpense[];
  incomes?:        CompactIncome[];
  coverage?:       { from?: string; to?: string; total?: number; sent?: number };
  topCategories?:  TopCategory[];
  walletBalances?: WalletBalance[];
  recurringBills?: { name?: string; amount?: number; due?: string | null }[];
  iou?:            { owedToMe?: number; iOwe?: number };
  recurringCount?: number;
  streak?:         number;
  // legacy fields — the lion mascot one-liner still posts this shape
  totalIncome?:    number;
  totalExpense?:   number;
}

// Keep the prompt inside a sane token budget: rows are ~45 chars each, so
// 500 expense rows ≈ 22 KB ≈ 6k tokens — well within every provider's window.
const MAX_EXPENSE_ROWS = 500;
const MAX_INCOME_ROWS  = 200;

const rupee = (n: number) => `₹${Math.round(n)}`;
// Row fields land in a pipe-separated, newline-terminated table; a note (or a
// user-named category/wallet) containing "|" or a newline would inject phantom
// columns/rows and corrupt the model's parsing.
const cell = (v: unknown) => String(v ?? "").replace(/[|\r\n]+/g, " ").trim();

function buildPrompt(question: string, ctx: ChatContext): string {
  const today = ctx.today || new Date().toISOString().slice(0, 10);
  const month = ctx.month || today.slice(0, 7);
  const sections: string[] = [`TODAY: ${today} (current month ${month})`];

  const wallets = ctx.walletBalances || [];
  if (wallets.length) sections.push(`WALLET BALANCES:\n${wallets.map(w => `  ${w.name}: ${rupee(w.balance)}`).join("\n")}`);

  if (ctx.monthIncome != null || ctx.monthExpense != null) {
    const mi = ctx.monthIncome || 0, me = ctx.monthExpense || 0;
    sections.push(`THIS MONTH (${month}): income ${rupee(mi)}, expenses ${rupee(me)}, net ${rupee(mi - me)}`);
  }
  if (ctx.allTimeIncome != null || ctx.allTimeExpense != null) {
    const ai = ctx.allTimeIncome || 0, ae = ctx.allTimeExpense || 0;
    sections.push(`ALL-TIME: income ${rupee(ai)}, expenses ${rupee(ae)}, net ${rupee(ai - ae)}`);
  }
  // legacy one-liner shape: all-time totals under old names
  if (ctx.allTimeExpense == null && (ctx.totalIncome != null || ctx.totalExpense != null)) {
    sections.push(`TOTALS: income ${rupee(ctx.totalIncome || 0)}, expenses ${rupee(ctx.totalExpense || 0)}`);
  }

  const topCats = ctx.topCategories || [];
  if (topCats.length) sections.push(`TOP CATEGORIES (all-time):\n${topCats.map(c => `  ${c.name}: ${rupee(c.amount)} (${c.pct}%)`).join("\n")}`);

  const bills = ctx.recurringBills || [];
  if (bills.length) sections.push(`ACTIVE RECURRING BILLS (${bills.length}):\n${bills.map(b => `  ${b.name || "bill"}: ${rupee(b.amount || 0)}${b.due ? ` (next due ${b.due})` : ""}`).join("\n")}`);
  else if (ctx.recurringCount) sections.push(`Active recurring bills: ${ctx.recurringCount}`);

  if (ctx.iou && ((ctx.iou.owedToMe || 0) > 0 || (ctx.iou.iOwe || 0) > 0)) {
    sections.push(`PENDING IOUs: others owe user ${rupee(ctx.iou.owedToMe || 0)}, user owes ${rupee(ctx.iou.iOwe || 0)}`);
  }
  if (ctx.streak) sections.push(`Logging streak: ${ctx.streak} days`);

  const exp = (ctx.expenses || []).slice(0, MAX_EXPENSE_ROWS);
  if (exp.length) {
    const cov = ctx.coverage || {};
    const from = cov.from || exp[exp.length - 1]?.d || "?";
    const to = cov.to || exp[0]?.d || "?";
    const totalNote = cov.total && cov.total > exp.length ? ` of ${cov.total} total (oldest omitted)` : "";
    sections.push(`EXPENSE ROWS — ${exp.length} rows${totalNote}, newest first, covering ${from} → ${to}.
Format: date|amount|category|wallet|note
${exp.map(e => `${e.d}|${e.a}|${cell(e.c) || "?"}|${cell(e.w) || "?"}|${cell(e.n)}`).join("\n")}`);
  } else {
    // No expense rows in this request (e.g. the lion mascot one-liner sends
    // summaries only) — tell the model so the "compute from rows" instruction
    // doesn't make it complain about missing data.
    sections.push("(No expense rows were included in this request — answer from the summaries above and any income rows below.)");
  }

  const inc = (ctx.incomes || []).slice(0, MAX_INCOME_ROWS);
  if (inc.length) {
    sections.push(`INCOME ROWS — ${inc.length} rows, newest first.
Format: date|amount|source|wallet|note
${inc.map(i => `${i.d}|${i.a}|${cell(i.s) || "?"}|${cell(i.w) || "?"}|${cell(i.n)}`).join("\n")}`);
  }

  return `${sections.join("\n\n")}\n\nUser question: ${question.trim()}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  if (configuredProviderCount() === 0) {
    return res.status(503).json({ error: "No AI providers configured." });
  }

  const { question, context = {} } = (req.body ?? {}) as {
    question?: string;
    context?: ChatContext;
  };

  if (!question || typeof question !== "string" || question.trim().length < 3) {
    return res.status(400).json({ error: "question must be a non-empty string." });
  }

  const prompt = buildPrompt(question, context);

  try {
    // 1024 tokens truncates a 15-line transaction listing mid-table; 1600
    // covers the largest allowed answer with headroom. The 500-row prompt
    // also needs more than the default 15s generation budget — but stay at
    // 20s/attempt so a 3-provider waterfall still fits Vercel's 60s cap.
    const raw = await callText(prompt, SYSTEM_PROMPT, { maxTokens: 1600, timeoutMs: 20_000 });
    return res.status(200).json({ answer: raw.trim() });

  } catch (err) {
    if (err instanceof AiProviderError) {
      return res.status(502).json({ error: "All AI providers failed. Try again later.", details: err.providerErrors });
    }
    console.error("[ai-chat] Unexpected error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
}
