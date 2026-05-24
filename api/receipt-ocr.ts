/**
 * receipt-ocr.ts  POST /api/receipt-ocr
 *
 * Accepts a compressed receipt photo (base64) and extracts merchant,
 * amount (INR), and date using a 3-provider AI vision waterfall.
 *
 * Mirrors api/food-vision.ts structure — same provider helpers,
 * same base64 size limit, same error model.
 *
 * Request body:
 *   { imageBase64: string, mimeType?: string }
 *
 * Response 200:
 *   {
 *     merchant:   string   — e.g. "Starbucks"
 *     amount:     number   — INR total
 *     date:       string   — ISO YYYY-MM-DD (best guess) or "" if not visible
 *     currency:   string   — ISO code, default "INR"
 *     confidence: "high" | "medium" | "low"
 *     provider:   string
 *   }
 *
 * Response 4xx / 5xx:
 *   { error: string, details?: string[] }
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { callVisionWithProvider, extractJSON, AiProviderError, configuredProviderCount } from "./_ai-provider.js";

const MAX_BASE64_BYTES = 2_800_000;

const SYSTEM_PROMPT = `You are an OCR assistant that extracts structured data from receipt photos.
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

const USER_PROMPT = "Extract merchant, total amount, date, and currency from this receipt.";

interface ReceiptResult {
  merchant: string;
  amount: number;
  date: string;
  currency: string;
  confidence: "high" | "medium" | "low";
  provider?: string;
}

function validateResult(obj: unknown): obj is ReceiptResult {
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
  const { imageBase64, mimeType = "image/jpeg" } = body as {
    imageBase64?: string;
    mimeType?: string;
  };

  if (!imageBase64 || typeof imageBase64 !== "string") {
    return res.status(400).json({ error: "imageBase64 (string) required in request body." });
  }

  if (imageBase64.length > MAX_BASE64_BYTES) {
    return res.status(413).json({
      error: `Image too large (${Math.round(imageBase64.length / 1024)} KB base64). Compress to under 800px before sending.`,
    });
  }

  if (!mimeType.startsWith("image/")) {
    return res.status(400).json({ error: `mimeType must be an image type, got: ${mimeType}` });
  }

  try {
    const { content: raw, provider } = await callVisionWithProvider(imageBase64, mimeType, USER_PROMPT, SYSTEM_PROMPT);

    let parsed: unknown;
    try {
      parsed = extractJSON(raw);
    } catch {
      console.error("[receipt-ocr] JSON parse failed. Raw response:", raw.slice(0, 300));
      return res.status(502).json({
        error: "AI returned non-JSON response. Try again or enter manually.",
      });
    }

    if (!validateResult(parsed)) {
      console.error("[receipt-ocr] Invalid result shape:", JSON.stringify(parsed).slice(0, 300));
      return res.status(502).json({
        error: "AI returned unexpected data shape. Try again or enter manually.",
      });
    }

    const result: ReceiptResult = {
      merchant:   parsed.merchant.trim(),
      amount:     Math.round(parsed.amount * 100) / 100,
      date:       parsed.date.trim(),
      currency:   parsed.currency.trim().toUpperCase() || "INR",
      confidence: parsed.confidence,
      provider,
    };

    return res.status(200).json(result);

  } catch (err) {
    if (err instanceof AiProviderError) {
      console.error("[receipt-ocr] All providers failed:", err.providerErrors);
      return res.status(502).json({
        error: "Receipt OCR unavailable — all AI providers failed. Enter manually.",
        details: err.providerErrors,
      });
    }
    console.error("[receipt-ocr] Unexpected error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
}
