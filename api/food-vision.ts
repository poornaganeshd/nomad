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
    type?: "food" | "receipt";
  };

  if (!imageBase64 || typeof imageBase64 !== "string") {
    return res.status(400).json({ error: "imageBase64 (string) required in request body." });
  }

  if (imageBase64.length > MAX_BASE64_BYTES) {
    return res.status(413).json({
      error: `Image too large (${Math.round(imageBase64.length / 1024)} KB base64). Compress to under 800px before sending.`,
    });
  }

  // Validate mimeType is image/*
  if (!mimeType.startsWith("image/")) {
    return res.status(400).json({ error: `mimeType must be an image type, got: ${mimeType}` });
  }

  const isReceipt = type === "receipt";
  const systemPrompt = isReceipt ? RECEIPT_SYSTEM_PROMPT : FOOD_SYSTEM_PROMPT;
  const userPrompt   = isReceipt ? RECEIPT_USER_PROMPT   : FOOD_USER_PROMPT;
  const label        = isReceipt ? "receipt-ocr"         : "food-vision";

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

    if (isReceipt) {
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
      return res.status(502).json({
        error: isReceipt
          ? "Receipt OCR unavailable — all AI providers failed. Enter manually."
          : "Food analysis unavailable — all AI providers failed. Enter nutrition manually.",
        details: err.providerErrors,
      });
    }
    console.error(`[${label}] Unexpected error:`, err);
    return res.status(500).json({ error: "Internal server error." });
  }
}
