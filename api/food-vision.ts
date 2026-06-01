/**
 * food-vision.ts  POST /api/food-vision
 *
 * Accepts a compressed food photo (base64) and returns structured nutrition
 * data estimated for Indian serving sizes, using a 3-provider AI waterfall.
 *
 * Request body:
 *   { imageBase64: string, mimeType?: string }
 *
 * Response 200:
 *   {
 *     name:         string   — e.g. "Dal Tadka"
 *     serving_desc: string   — e.g. "1 bowl (~250g)"
 *     calories:     number   — kcal
 *     protein_g:    number
 *     carbs_g:      number
 *     fat_g:        number
 *     confidence:   "high" | "medium" | "low"
 *     provider:     string   — which provider answered
 *   }
 *
 * Response 4xx / 5xx:
 *   { error: string, details?: string[] }
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { callVisionWithProvider, extractJSON, AiProviderError, configuredProviderCount } from "./_ai-provider.js";

// Vercel Hobby plan caps total serverless functions at 12. This endpoint
// routes BOTH food-vision and receipt-OCR requests via a `type` body param
// to keep the function count under the limit. Default type = "food" so
// existing /api/food-vision callers keep working without changes.

// ~2 MB base64 limit — client must compress to 800px JPEG before sending.
// A 800×800 JPEG at 70% is typically 60-120 KB → base64 ~160 KB.
// 2.8 MB gives comfortable headroom even for large phones.
const MAX_BASE64_BYTES = 2_800_000;

const FOOD_SYSTEM_PROMPT = `You are a nutrition expert specialising in Indian home-cooked food and restaurant meals.
Analyse the food photo and return ONLY valid JSON with no markdown fences or explanation:
{
  "name":         "itemised list of every visible item with counts/portions joined by ' + ' (e.g. '1 carrot + 4 papaya slices + 2 eggs + 3 dates + 1 dry date + handful of peanuts')",
  "serving_desc": "overall portion description (e.g. 1 plate, 1 bowl, snack plate)",
  "calories":     320,
  "protein_g":    12,
  "carbs_g":      45,
  "fat_g":        8,
  "confidence":   "high"
}

Rules:
- Enumerate EVERY distinct visible item separately with an estimated count or portion size. Do NOT generalise to a single dish name like "Mixed Snack Plate" or "Assorted Fruits" — list each item.
- Join items with " + " (space, plus, space). Use specific counts when countable (e.g. "2 eggs", "3 dates"), portion words otherwise (e.g. "handful of peanuts", "4 papaya slices").
- For a recognised single composed dish (e.g. Dal Tadka, Aloo Paratha) without separable items, the name may be the dish name.
- Use standard Indian home-cooked portion sizes as reference.
- Calories and macros must be the SUM across all listed items.
- confidence: "high" if items are clearly identifiable, "medium" if partially obscured or mixed, "low" if unrecognisable.
- All numeric values must be integers or one-decimal floats — never null or strings.
- Return exactly this JSON structure, nothing else.`;

const FOOD_USER_PROMPT = "Identify every visible food item in this photo. List each item separately with its count or portion size, then estimate combined nutrition for the visible Indian portions.";

const RECEIPT_SYSTEM_PROMPT = `You are an OCR assistant that extracts structured data from receipt photos.
Analyse the receipt and return ONLY valid JSON with no markdown fences or explanation:
{
  "merchant":   "store or merchant name as printed",
  "amount":     420.50,
  "date":       "2026-05-22",
  "currency":   "INR",
  "confidence": "high"
}

Rules:
- amount: total payable (after tax/discount). Strip currency symbols. Return as number.
- date: ISO YYYY-MM-DD. If only DD/MM/YYYY or DD-MMM is visible, convert. If no date readable, return "".
- currency: ISO 4217 code. Default "INR" if symbol is ₹ or Rs. Use "USD" for $, "EUR" for €, etc.
- confidence: "high" if all fields are clearly legible, "medium" if amount is clear but other fields blurry, "low" if mostly unreadable.
- If multiple totals appear, use the final grand total (after taxes).
- Return exactly this JSON structure, nothing else.`;

const RECEIPT_USER_PROMPT = "Extract merchant, total amount, date, and currency from this receipt.";

const RECEIPT_ITEMS_SYSTEM_PROMPT = `You are an OCR assistant that extracts line items from a receipt photo.
Return ONLY valid JSON with no markdown fences:
{
  "merchant":   "store name",
  "total":      420.50,
  "currency":   "INR",
  "items": [
    { "name": "Coke 500ml", "qty": 2, "amount": 80, "category": "Food" },
    { "name": "Bread",      "qty": 1, "amount": 45, "category": "Groceries" }
  ],
  "confidence": "high"
}

Rules:
- items: one entry per visible line. amount = price for that line (qty × unit price).
- category: short hint (Food, Groceries, Personal, Household, Other).
- Items amounts should sum approximately to total (allow ±5 for taxes/discounts).
- If line is unreadable, skip it.
- Return at least 1 item.`;

const RECEIPT_ITEMS_USER_PROMPT = "Extract each line item with quantity, amount, and a short category hint.";

const LEDGER_SYSTEM_PROMPT = `You are an OCR assistant that extracts transactions from a photo of a handwritten or printed personal ledger / expense book.
Return ONLY valid JSON with no markdown fences:
{
  "entries": [
    { "date": "2026-05-22", "amount": 120, "note": "tea", "type": "expense", "confidence": "high" },
    { "date": "2026-05-22", "amount": 50,  "note": "bus", "type": "expense", "confidence": "medium" }
  ]
}

Rules:
- date: ISO YYYY-MM-DD. If only DD/MM is visible, infer current year. If unreadable, return "".
- amount: integer or one-decimal ₹. Strip currency symbols.
- type: "expense" | "income".
- note: short description from the ledger row.
- confidence: high | medium | low per row.
- Skip rows that are pure totals / headers / illegible.
- Cap at 40 entries.`;

const LEDGER_USER_PROMPT = "Extract each ledger row as a transaction. Skip totals and headers.";

interface FoodResult {
  name: string;
  serving_desc: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  confidence: "high" | "medium" | "low";
  provider?: string;
}

interface ReceiptResult {
  merchant: string;
  amount: number;
  date: string;
  currency: string;
  confidence: "high" | "medium" | "low";
  provider?: string;
}

interface ReceiptItem {
  name:     string;
  qty:      number;
  amount:   number;
  category: string;
}

interface ReceiptItemsResult {
  merchant: string;
  total:    number;
  currency: string;
  items:    ReceiptItem[];
  confidence: "high" | "medium" | "low";
  provider?: string;
}

interface LedgerEntry {
  date:       string;
  amount:     number;
  note:       string;
  type:       "expense" | "income";
  confidence: "high" | "medium" | "low";
}

interface LedgerResult {
  entries:  LedgerEntry[];
  provider?: string;
}

function validateFood(obj: unknown): obj is FoodResult {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.name         === "string" &&
    typeof o.serving_desc === "string" &&
    typeof o.calories     === "number" &&
    typeof o.protein_g    === "number" &&
    typeof o.carbs_g      === "number" &&
    typeof o.fat_g        === "number" &&
    ["high", "medium", "low"].includes(o.confidence as string)
  );
}

function validateReceipt(obj: unknown): obj is ReceiptResult {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.merchant   === "string" &&
    typeof o.amount     === "number" &&
    typeof o.date       === "string" &&
    typeof o.currency   === "string" &&
    ["high", "medium", "low"].includes(o.confidence as string)
  );
}

function validateReceiptItems(obj: unknown): obj is ReceiptItemsResult {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  if (typeof o.merchant !== "string" || typeof o.total !== "number" || typeof o.currency !== "string") return false;
  if (!Array.isArray(o.items) || o.items.length === 0) return false;
  return o.items.every(it => {
    if (!it || typeof it !== "object") return false;
    const i = it as Record<string, unknown>;
    return typeof i.name === "string" && typeof i.qty === "number" && typeof i.amount === "number" && typeof i.category === "string";
  });
}

function validateLedger(obj: unknown): obj is LedgerResult {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  if (!Array.isArray(o.entries)) return false;
  return o.entries.every(en => {
    if (!en || typeof en !== "object") return false;
    const e = en as Record<string, unknown>;
    const conf = e.confidence;
    const okConf = conf === undefined || ["high", "medium", "low"].includes(conf as string);
    return (
      typeof e.date === "string" &&
      typeof e.amount === "number" &&
      typeof e.note === "string" &&
      ["expense", "income"].includes(e.type as string) &&
      okConf
    );
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  if (configuredProviderCount() === 0) {
    return res.status(503).json({
      error: "No AI vision providers configured. Add GEMINI_API_KEY, GROQ_API_KEY, or NVIDIA_API_KEY to Vercel env vars.",
    });
  }

  const body = req.body ?? {};
  const { imageBase64, mimeType = "image/jpeg", type = "food" } = body as {
    imageBase64?: string;
    mimeType?: string;
    type?: "food" | "receipt" | "receipt-items" | "ledger";
  };

  if (!imageBase64 || typeof imageBase64 !== "string") {
    return res.status(400).json({ error: "imageBase64 (string) required in request body." });
  }

  if (imageBase64.length > MAX_BASE64_BYTES) {
    return res.status(413).json({
      error: `Image too large (${Math.round(imageBase64.length / 1024)} KB base64). Compress to under 800px before sending.`,
    });
  }

  // Validate mimeType is image/* or application/pdf. PDF is forwarded as-is to
  // the AI provider — Gemini's OpenAI-compat layer accepts it via image_url
  // with a data:application/pdf payload; Groq/NVIDIA reject and the provider
  // waterfall falls through to whichever provider can read it.
  if (!mimeType.startsWith("image/") && mimeType !== "application/pdf") {
    return res.status(400).json({ error: `mimeType must be image/* or application/pdf, got: ${mimeType}` });
  }

  const systemPrompt =
    type === "receipt"       ? RECEIPT_SYSTEM_PROMPT       :
    type === "receipt-items" ? RECEIPT_ITEMS_SYSTEM_PROMPT :
    type === "ledger"        ? LEDGER_SYSTEM_PROMPT        :
                               FOOD_SYSTEM_PROMPT;
  const userPrompt =
    type === "receipt"       ? RECEIPT_USER_PROMPT       :
    type === "receipt-items" ? RECEIPT_ITEMS_USER_PROMPT :
    type === "ledger"        ? LEDGER_USER_PROMPT        :
                               FOOD_USER_PROMPT;
  const label =
    type === "receipt"       ? "receipt-ocr"   :
    type === "receipt-items" ? "receipt-items" :
    type === "ledger"        ? "ledger-ocr"    :
                               "food-vision";

  try {
    const { content: raw, provider } = await callVisionWithProvider(imageBase64, mimeType, userPrompt, systemPrompt);

    let parsed: unknown;
    try {
      parsed = extractJSON(raw);
    } catch {
      console.error(`[${label}] JSON parse failed. Raw response:`, raw.slice(0, 300));
      return res.status(502).json({
        error: "AI returned non-JSON response. Try again or enter manually.",
      });
    }

    if (type === "receipt") {
      if (!validateReceipt(parsed)) {
        console.error(`[${label}] Invalid result shape:`, JSON.stringify(parsed).slice(0, 300));
        return res.status(502).json({ error: "AI returned unexpected data shape. Try again or enter manually." });
      }
      const result: ReceiptResult = {
        merchant:   parsed.merchant.trim(),
        amount:     Math.round(parsed.amount * 100) / 100,
        date:       parsed.date.trim(),
        currency:   (parsed.currency.trim().toUpperCase() || "INR"),
        confidence: parsed.confidence,
        provider,
      };
      return res.status(200).json(result);
    }

    if (type === "receipt-items") {
      if (!validateReceiptItems(parsed)) {
        console.error(`[${label}] Invalid result shape:`, JSON.stringify(parsed).slice(0, 300));
        return res.status(502).json({ error: "AI returned unexpected data shape. Try again or enter manually." });
      }
      const result: ReceiptItemsResult = {
        merchant:   parsed.merchant.trim(),
        total:      Math.round(parsed.total * 100) / 100,
        currency:   (parsed.currency.trim().toUpperCase() || "INR"),
        items:      parsed.items.map(i => ({
          name:     i.name.trim(),
          qty:      Math.max(1, Math.round(i.qty)),
          amount:   Math.round(i.amount * 100) / 100,
          category: i.category.trim() || "Other",
        })),
        confidence: parsed.confidence,
        provider,
      };
      return res.status(200).json(result);
    }

    if (type === "ledger") {
      if (!validateLedger(parsed)) {
        console.error(`[${label}] Invalid result shape:`, JSON.stringify(parsed).slice(0, 300));
        return res.status(502).json({ error: "AI returned unexpected data shape. Try again or enter manually." });
      }
      const result: LedgerResult = {
        entries:  parsed.entries.slice(0, 40).map(e => ({
          date:       e.date.trim(),
          amount:     Math.round(e.amount * 100) / 100,
          note:       e.note.trim(),
          type:       e.type,
          confidence: e.confidence || "medium",
        })),
        provider,
      };
      return res.status(200).json(result);
    }

    if (!validateFood(parsed)) {
      console.error(`[${label}] Invalid result shape:`, JSON.stringify(parsed).slice(0, 300));
      return res.status(502).json({
        error: "AI returned unexpected data shape. Try again or enter manually.",
      });
    }

    const result: FoodResult = {
      name:         parsed.name.trim(),
      serving_desc: parsed.serving_desc.trim(),
      calories:     Math.round(parsed.calories),
      protein_g:    Math.round(parsed.protein_g * 10) / 10,
      carbs_g:      Math.round(parsed.carbs_g   * 10) / 10,
      fat_g:        Math.round(parsed.fat_g      * 10) / 10,
      confidence:   parsed.confidence,
      provider,
    };
    return res.status(200).json(result);

  } catch (err) {
    if (err instanceof AiProviderError) {
      console.error(`[${label}] All providers failed:`, err.providerErrors);
      const errMsg =
        type === "receipt"       ? "Receipt OCR unavailable — all AI providers failed. Enter manually." :
        type === "receipt-items" ? "Line-item OCR unavailable — all AI providers failed. Enter manually." :
        type === "ledger"        ? "Ledger OCR unavailable — all AI providers failed. Enter manually." :
                                   "Food analysis unavailable — all AI providers failed. Enter nutrition manually.";
      return res.status(502).json({
        error: errMsg,
        details: err.providerErrors,
      });
    }
    console.error(`[${label}] Unexpected error:`, err);
    return res.status(500).json({ error: "Internal server error." });
  }
}
