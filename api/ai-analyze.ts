/**
 * ai-analyze.ts  POST /api/ai-analyze
 *
 * Omnibus AI endpoint. One serverless function, many modes — picked via the
 * `mode` body field. Keeps function count under the Vercel Hobby cap (12).
 *
 * Modes:
 *   voice-parse        Transcript → { amount, walletId, categoryId, type, note }
 *   subscriptions      Txns → list of suspected recurring/subscription patterns
 *   anomaly            One new txn + history → outlier verdict
 *   duplicates         Txns → list of duplicate pairs
 *   merchants          Note list → canonical merchant mapping
 *   narrative          Period txns → written summary
 *   whatif             Scenario prompt + history → projected impact
 *   budget-suggest     History → suggested ₹ limit per category
 *   mood-correlation   Finance + mood logs → correlation insights
 *   tax                Txns → tax-deductible classification (India 80C etc.)
 *   split-cats         One expense → multi-category split suggestion
 *   smart-reminders    Schedule context → predictive nudges
 *   goal-coach         Budgets vs spend → coaching message
 *
 * All callers should redact PII with src/redactor.js before sending.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { callText, extractJSON, AiProviderError, configuredProviderCount } from "./_ai-provider.js";

type Mode =
  | "voice-parse"
  | "subscriptions"
  | "anomaly"
  | "duplicates"
  | "merchants"
  | "narrative"
  | "whatif"
  | "budget-suggest"
  | "mood-correlation"
  | "tax"
  | "split-cats"
  | "smart-reminders"
  | "goal-coach";

interface Wallet   { id: string; name: string; }
interface Category { id: string; name: string; }
interface Txn {
  date?:       string;
  amount?:     number;
  categoryId?: string;
  walletId?:   string;
  note?:       string;
  type?:       string;
  id?:         string;
}
interface MoodLog {
  date:  string;
  mood?: string;
  sleepQuality?: string;
  water?: number;
}

interface ModeHandler {
  systemPrompt: string;
  buildUser: (body: Record<string, unknown>) => string;
  validate:   (parsed: unknown) => boolean;
}

const MODES: Record<Mode, ModeHandler> = {
  "voice-parse": {
    systemPrompt: `You are a transaction parser for an Indian finance app. Convert a spoken transcript into structured JSON.
Return ONLY valid JSON:
{ "amount": 250, "type": "expense", "categoryId": "food", "walletId": "upi_lite", "note": "tea with friends", "confidence": "high" }

Rules:
- type ∈ {"expense","income","transfer"}.
- amount: integer ₹. If transcript says "2k" / "two thousand" → 2000.
- categoryId / walletId MUST be IDs from the provided lists, or null when unsure.
- note: clean human-readable note WITHOUT the amount or wallet name.
- confidence: high | medium | low.`,
    buildUser: (b) => {
      const transcript   = String(b.transcript || "").trim();
      const wallets      = (b.wallets    as Wallet[])    || [];
      const categories   = (b.categories as Category[])  || [];
      return `Transcript: "${transcript.slice(0, 400)}"

Wallets:
${wallets.map(w => `- ${w.id}: ${w.name}`).join("\n")}

Categories:
${categories.map(c => `- ${c.id}: ${c.name}`).join("\n")}

Parse to JSON.`;
    },
    validate: (p) => {
      if (!p || typeof p !== "object") return false;
      const o = p as Record<string, unknown>;
      return typeof o.amount === "number" && typeof o.type === "string";
    },
  },

  subscriptions: {
    systemPrompt: `You are a subscription detector. Given a transaction history, identify suspected recurring/subscription charges (Netflix, Spotify, rent, mobile bill, gym, SaaS).
Return ONLY valid JSON:
{
  "subscriptions": [
    { "merchant": "Netflix", "amount": 199, "cadence": "monthly", "lastDate": "2026-05-12", "confidence": "high", "note": "Appears 3 months in a row at same amount" }
  ]
}

Rules:
- cadence ∈ {"weekly","monthly","yearly","unknown"}.
- Only include patterns with ≥2 occurrences within 90 days.
- Group by merchant name (normalize minor spelling variations).
- Sort highest amount first. Cap at 12 entries.`,
    buildUser: (b) => {
      const txns = ((b.transactions as Txn[]) || []).slice(0, 400);
      return `Transactions (note, amount, date):
${txns.map(t => `${t.date || ""} ₹${t.amount} ${t.note || ""}`).join("\n")}

Identify recurring subscriptions.`;
    },
    validate: (p) => {
      if (!p || typeof p !== "object") return false;
      return Array.isArray((p as Record<string, unknown>).subscriptions);
    },
  },

  anomaly: {
    systemPrompt: `You are an anomaly detector for personal finance. Given one new transaction and a recent history, decide if it is unusual.
Return ONLY valid JSON:
{ "anomaly": true, "severity": "medium", "reason": "Groceries usually ₹800 — this ₹3200 is 4× typical", "compareAvg": 800 }

Rules:
- severity ∈ {"none","low","medium","high"}. "none" means not anomalous.
- reason: one short sentence with specific ₹ numbers.
- If insufficient history (<5 same-category txns), severity = "none".`,
    buildUser: (b) => {
      const tx = b.txn as Txn;
      const history = ((b.history as Txn[]) || []).slice(0, 200);
      return `New transaction:
date: ${tx?.date}, amount: ₹${tx?.amount}, category: ${tx?.categoryId}, note: ${tx?.note || ""}

Recent history (same category):
${history.filter(h => h.categoryId === tx?.categoryId).map(h => `${h.date} ₹${h.amount} ${h.note || ""}`).join("\n")}

Is the new transaction unusual?`;
    },
    validate: (p) => {
      if (!p || typeof p !== "object") return false;
      const o = p as Record<string, unknown>;
      return typeof o.anomaly === "boolean" && typeof o.severity === "string";
    },
  },

  duplicates: {
    systemPrompt: `You are a duplicate transaction detector. Find pairs that look like double-logs (same merchant + amount within a small time window).
Return ONLY valid JSON:
{
  "duplicates": [
    { "ids": ["abc", "def"], "reason": "Same amount ₹120 and 'Starbucks' note, 7 minutes apart", "confidence": "high" }
  ]
}

Rules:
- Only flag pairs within 60 minutes (or same date if no time available) and amount equal or within ±₹1.
- confidence: high (clearly duplicate), medium (likely), low (possible).
- Cap at 20 pairs.`,
    buildUser: (b) => {
      const txns = ((b.transactions as Txn[]) || []).slice(0, 300);
      return `Transactions (id, date, amount, note):
${txns.map(t => `${t.id} ${t.date || ""} ₹${t.amount} ${t.note || ""}`).join("\n")}

Find duplicate pairs.`;
    },
    validate: (p) => Boolean(p && typeof p === "object" && Array.isArray((p as Record<string, unknown>).duplicates)),
  },

  merchants: {
    systemPrompt: `You are a merchant-name normalizer for Indian finance. Map messy free-text notes to canonical merchant names.
Return ONLY valid JSON:
{
  "mappings": [
    { "raw": "strbcks koramangala", "canonical": "Starbucks", "sector": "Dining" },
    { "raw": "swgy",                "canonical": "Swiggy",    "sector": "Food Delivery" }
  ]
}

Rules:
- canonical: brand name in title case (Starbucks, not "STARBUCKS COFFEE PRIVATE LIMITED").
- sector: short category (Dining, Food Delivery, Transport, Shopping, Utilities, Entertainment, Health, Personal, Other).
- One entry per raw note. Skip notes that have no recognizable merchant.`,
    buildUser: (b) => {
      const notes = ((b.notes as string[]) || []).slice(0, 200);
      return `Notes:
${notes.map((n, i) => `${i + 1}. ${n}`).join("\n")}

Normalize to canonical merchants.`;
    },
    validate: (p) => Boolean(p && typeof p === "object" && Array.isArray((p as Record<string, unknown>).mappings)),
  },

  narrative: {
    systemPrompt: `You are a personal finance writer. Produce a short narrative summary of a period's spending — like a weekly newsletter to oneself.
Return ONLY valid JSON:
{
  "headline": "Tighter week, food bills jumped",
  "body":     "2-3 paragraphs of plain English narrative",
  "highlights": ["bullet 1", "bullet 2", "bullet 3"]
}

Rules:
- Tone: warm, direct, specific. ₹ symbol on amounts. Round to nearest ₹10.
- Reference actual categories and amounts from the data.
- Body 2-3 paragraphs, max 120 words.
- 3 highlights, each one line.`,
    buildUser: (b) => {
      const period = String(b.period || "this period");
      const expenses = ((b.expenses as Txn[]) || []).slice(0, 200);
      const incomes  = ((b.incomes  as Txn[]) || []).slice(0, 80);
      const tE = expenses.reduce((s, e) => s + (e.amount || 0), 0);
      const tI = incomes.reduce((s, i) => s + (i.amount || 0), 0);
      return `Period: ${period}
Income: ₹${Math.round(tI)}
Expense: ₹${Math.round(tE)}
Net: ₹${Math.round(tI - tE)}

Expenses (date, amount, category, note):
${expenses.map(e => `${e.date} ₹${e.amount} ${e.categoryId} ${e.note || ""}`).join("\n")}

Write the narrative.`;
    },
    validate: (p) => {
      if (!p || typeof p !== "object") return false;
      const o = p as Record<string, unknown>;
      return typeof o.headline === "string" && typeof o.body === "string" && Array.isArray(o.highlights);
    },
  },

  whatif: {
    systemPrompt: `You are a what-if finance simulator. Given a user scenario and their spending history, project the impact.
Return ONLY valid JSON:
{
  "projection": "If you cut dining 30% you save ₹2,100/mo → ₹25,200/yr",
  "monthlySaving": 2100,
  "yearlySaving": 25200,
  "feasibility": "high",
  "tip": "Cap dining to 1× per weekend"
}

Rules:
- monthlySaving / yearlySaving: integers ₹.
- feasibility: high | medium | low — based on how realistic the cut is.
- projection: one-sentence headline with numbers.
- tip: actionable, ≤ 12 words.`,
    buildUser: (b) => {
      const scenario = String(b.scenario || "").trim();
      const expenses = ((b.expenses as Txn[]) || []).slice(0, 200);
      return `Scenario: ${scenario}

Last 90 days expenses (amount, category, note):
${expenses.map(e => `₹${e.amount} ${e.categoryId} ${e.note || ""}`).join("\n")}

Project the impact.`;
    },
    validate: (p) => {
      if (!p || typeof p !== "object") return false;
      const o = p as Record<string, unknown>;
      return typeof o.projection === "string" && typeof o.monthlySaving === "number";
    },
  },

  "budget-suggest": {
    systemPrompt: `You suggest realistic monthly ₹ budgets per category for an Indian user based on their 90-day spending.
Return ONLY valid JSON:
{
  "suggestions": [
    { "categoryId": "food", "suggestedLimit": 6000, "p90Spent": 7200, "reason": "10% trim from 90-day p90" }
  ]
}

Rules:
- suggestedLimit: integer ₹, round to nearest ₹100. Aim for 5-15% reduction from the observed median monthly spend.
- One entry per category with ≥3 transactions in 90 days. Sort by suggestedLimit descending.
- reason: ≤ 14 words.`,
    buildUser: (b) => {
      const expenses   = ((b.expenses   as Txn[])      || []).slice(0, 400);
      const categories = ((b.categories as Category[]) || []);
      return `Categories: ${categories.map(c => `${c.id}=${c.name}`).join(", ")}

90-day expenses (date, amount, category):
${expenses.map(e => `${e.date} ₹${e.amount} ${e.categoryId}`).join("\n")}

Suggest monthly budgets.`;
    },
    validate: (p) => Boolean(p && typeof p === "object" && Array.isArray((p as Record<string, unknown>).suggestions)),
  },

  "mood-correlation": {
    systemPrompt: `You correlate daily mood/wellness logs with daily spending. Identify links worth knowing.
Return ONLY valid JSON:
{
  "correlations": [
    { "factor": "mood=sad", "spendDelta": "+38%", "evidence": "On 6 sad days you spent avg ₹1,400 vs ₹1,010 baseline", "confidence": "medium" }
  ],
  "summary": "1-2 sentences explaining the strongest link"
}

Rules:
- factor: mood / sleep / water / habit identifier.
- spendDelta: "+X%" or "-X%" vs baseline.
- confidence: high (≥15 same-state days), medium (5-14), low (<5).
- Cap at 5 correlations. Sort by absolute delta.`,
    buildUser: (b) => {
      const txns      = ((b.expenses as Txn[])     || []).slice(0, 400);
      const moodLogs  = ((b.moods    as MoodLog[]) || []).slice(0, 200);
      return `Daily mood logs (date, mood, sleep, water):
${moodLogs.map(m => `${m.date} mood=${m.mood || "-"} sleep=${m.sleepQuality || "-"} water=${m.water ?? 0}`).join("\n")}

Daily expenses (date, amount):
${txns.map(t => `${t.date} ₹${t.amount}`).join("\n")}

Find mood↔spend correlations.`;
    },
    validate: (p) => {
      if (!p || typeof p !== "object") return false;
      const o = p as Record<string, unknown>;
      return Array.isArray(o.correlations) && typeof o.summary === "string";
    },
  },

  tax: {
    systemPrompt: `You classify Indian tax-deductible expenses for personal income tax (old regime 80C/80D/80G etc.).
Return ONLY valid JSON:
{
  "items": [
    { "categoryId": "health", "section": "80D", "amount": 12000, "note": "Medical insurance premium", "confidence": "high" }
  ],
  "totalDeductible": 12000,
  "summary": "1-2 sentences with the biggest deduction opportunity"
}

Rules:
- section ∈ {"80C","80D","80G","80E","80TTA","HRA","Standard","Other"}.
- amount: integer ₹, summed across matching txns.
- Only include items with clear deductibility. Do not assume.
- Cap items at 10.`,
    buildUser: (b) => {
      const expenses = ((b.expenses as Txn[]) || []).slice(0, 400);
      const fy       = String(b.fy || "current");
      return `Financial year: ${fy}

Expenses (date, amount, category, note):
${expenses.map(e => `${e.date} ₹${e.amount} ${e.categoryId} ${e.note || ""}`).join("\n")}

Classify tax-deductible items.`;
    },
    validate: (p) => {
      if (!p || typeof p !== "object") return false;
      const o = p as Record<string, unknown>;
      return Array.isArray(o.items) && typeof o.summary === "string";
    },
  },

  "split-cats": {
    systemPrompt: `You split a single expense into multiple categories when the note suggests mixed items (e.g. Amazon order with groceries + electronics).
Return ONLY valid JSON:
{
  "splits": [
    { "categoryId": "groceries", "amount": 1200, "reason": "milk, vegetables" },
    { "categoryId": "shopping",  "amount": 800,  "reason": "headphones" }
  ],
  "confidence": "medium"
}

Rules:
- amounts must sum to the original total exactly.
- categoryId MUST be from the provided list.
- If the note has no clear split, return one item with the original category.
- confidence: high | medium | low.`,
    buildUser: (b) => {
      const expense    = b.expense as Txn;
      const categories = ((b.categories as Category[]) || []);
      return `Expense:
amount: ₹${expense?.amount}, currentCategory: ${expense?.categoryId}, note: ${expense?.note || ""}

Categories: ${categories.map(c => `${c.id}=${c.name}`).join(", ")}

Suggest a category split.`;
    },
    validate: (p) => Boolean(p && typeof p === "object" && Array.isArray((p as Record<string, unknown>).splits)),
  },

  "smart-reminders": {
    systemPrompt: `You generate predictive reminders based on a user's logging history.
Return ONLY valid JSON:
{
  "reminders": [
    { "title": "Grocery run usually today", "detail": "You logged groceries on the last 4 Tuesdays, avg ₹184", "priority": "medium", "categoryId": "groceries" }
  ]
}

Rules:
- priority: low | medium | high.
- detail: include the supporting pattern (count, weekday or day-of-month, average amount).
- CRITICAL: Only include reminders that match TODAY's weekday or day-of-month. If today is Tuesday, only surface patterns that repeat on Tuesdays or on this date. Do NOT surface Saturday patterns on a Tuesday.
- Only suggest reminders with ≥3 supporting data points.
- Cap at 5.`,
    buildUser: (b) => {
      const today = String(b.today || "");
      const dayName = today
        ? ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][new Date(`${today}T12:00:00`).getDay()]
        : "";
      const expenses = ((b.expenses as Txn[]) || []).slice(0, 400);
      return `Today: ${today}${dayName ? ` (${dayName})` : ""}

Expenses (date, amount, category, note):
${expenses.map(e => `${e.date} ₹${e.amount} ${e.categoryId} ${e.note || ""}`).join("\n")}

Generate smart reminders relevant to ${dayName || "today"}.`;
    },
    validate: (p) => Boolean(p && typeof p === "object" && Array.isArray((p as Record<string, unknown>).reminders)),
  },

  "goal-coach": {
    systemPrompt: `You are a personal finance coach. Given budgets, current spend, and recent history, produce a brief coaching message focused on staying on track.
Return ONLY valid JSON:
{
  "message": "You're 12 days into the month and 70% of your dining budget is used. Cap to 1 weekend meal out to finish strong.",
  "status": "warning",
  "actions": [
    { "label": "Cap weekend dining", "impact": "Save ₹800 this month" }
  ]
}

Rules:
- status: on-track | watch | warning | off-track.
- message: 1-2 sentences, specific numbers.
- actions: 1-3 items, each label ≤ 6 words.`,
    buildUser: (b) => {
      const budgets   = b.budgets   as Record<string, number> | undefined;
      const monthExp  = ((b.monthExpenses as Txn[]) || []).slice(0, 200);
      const dayOfMonth = Number(b.dayOfMonth || 1);
      const daysInMonth = Number(b.daysInMonth || 30);
      const lines = Object.entries(budgets || {}).map(([cid, lim]) => {
        const spent = monthExp.filter(e => e.categoryId === cid).reduce((s, e) => s + (e.amount || 0), 0);
        return `${cid}: spent ₹${Math.round(spent)} / limit ₹${lim}`;
      });
      return `Day ${dayOfMonth} of ${daysInMonth}

Budgets:
${lines.join("\n") || "(none set)"}

This month expenses (amount, category):
${monthExp.map(e => `₹${e.amount} ${e.categoryId}`).join("\n")}

Give a coaching message.`;
    },
    validate: (p) => {
      if (!p || typeof p !== "object") return false;
      const o = p as Record<string, unknown>;
      return typeof o.message === "string" && typeof o.status === "string";
    },
  },
};

// Post-process model output so callers get safe, normalized payloads regardless
// of small model quirks (out-of-list IDs, invalid enums, missing arrays).
function sanitize(mode: Mode, parsed: Record<string, unknown>, body: Record<string, unknown>): Record<string, unknown> {
  if (mode === "voice-parse") {
    const wallets    = (body.wallets    as Wallet[])    || [];
    const categories = (body.categories as Category[])  || [];
    const walletIds  = new Set(wallets.map(w => w.id));
    const catIds     = new Set(categories.map(c => c.id));
    const validTypes = new Set(["expense", "income", "transfer"]);
    return {
      ...parsed,
      type:       validTypes.has(String(parsed.type)) ? parsed.type : "expense",
      walletId:   walletIds.has(String(parsed.walletId))   ? parsed.walletId   : null,
      categoryId: catIds.has(String(parsed.categoryId))     ? parsed.categoryId : null,
    };
  }
  if (mode === "anomaly") {
    const validSev = new Set(["none", "low", "medium", "high"]);
    return {
      ...parsed,
      severity: validSev.has(String(parsed.severity)) ? parsed.severity : "none",
      anomaly:  Boolean(parsed.anomaly),
    };
  }
  if (mode === "tax") {
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    const totalDeductible = typeof parsed.totalDeductible === "number"
      ? parsed.totalDeductible
      : items.reduce((s: number, it: unknown) => {
          const a = (it as { amount?: number })?.amount;
          return s + (typeof a === "number" ? a : 0);
        }, 0);
    return { ...parsed, totalDeductible };
  }
  return parsed;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  if (configuredProviderCount() === 0) {
    return res.status(503).json({ error: "No AI providers configured." });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const mode = String(body.mode || "") as Mode;

  const modeHandler = MODES[mode];
  if (!modeHandler) {
    return res.status(400).json({ error: `Unknown mode "${mode}". Valid: ${Object.keys(MODES).join(", ")}` });
  }

  const userPrompt = modeHandler.buildUser(body);

  try {
    const raw = await callText(userPrompt, modeHandler.systemPrompt);

    let parsed: unknown;
    try { parsed = extractJSON(raw); }
    catch {
      console.error(`[ai-analyze:${mode}] JSON parse failed:`, raw.slice(0, 300));
      return res.status(502).json({ error: "AI returned non-JSON. Try again." });
    }

    if (!modeHandler.validate(parsed)) {
      console.error(`[ai-analyze:${mode}] Invalid shape:`, JSON.stringify(parsed).slice(0, 300));
      return res.status(502).json({ error: "AI returned unexpected data shape. Try again." });
    }

    const sanitized = sanitize(mode, parsed as Record<string, unknown>, body);
    return res.status(200).json(sanitized);

  } catch (err) {
    if (err instanceof AiProviderError) {
      console.error(`[ai-analyze:${mode}] All providers failed:`, err.providerErrors);
      return res.status(502).json({ error: "All AI providers failed.", details: err.providerErrors });
    }
    console.error(`[ai-analyze:${mode}] Unexpected error:`, err);
    return res.status(500).json({ error: "Internal server error." });
  }
}
