/**
 * _ai-provider.ts — Shared AI provider waterfall for NOMAD
 *
 * Three providers tried in order: Groq → NVIDIA → Gemini.
 * Any provider whose API key is missing is skipped silently.
 * On failure (non-2xx, timeout, bad JSON) the next provider is tried.
 *
 * Two call modes:
 *   callText(prompt, systemPrompt?)  — text completion
 *   callVision(imageBase64, mimeType, prompt) — vision (image + text)
 *
 * All three providers expose an OpenAI-compatible REST API, so one
 * request builder covers all of them.
 */

const TIMEOUT_MS = 15_000;

interface Provider {
  name: string;
  textUrl: string;
  visionUrl: string;
  textModel: string;
  visionModel: string;
  apiKey: string;
}

function getProviders(): Provider[] {
  const all: Provider[] = [
    {
      name: "groq",
      textUrl:   "https://api.groq.com/openai/v1/chat/completions",
      visionUrl: "https://api.groq.com/openai/v1/chat/completions",
      textModel:   "llama-3.3-70b-versatile",
      visionModel: "meta-llama/llama-4-scout-17b-16e-instruct",
      apiKey: process.env.GROQ_API_KEY ?? "",
    },
    {
      name: "nvidia",
      textUrl:   "https://integrate.api.nvidia.com/v1/chat/completions",
      visionUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
      textModel:   "meta/llama-3.3-70b-instruct",
      visionModel: "meta/llama-3.2-11b-vision-instruct",
      apiKey: process.env.NVIDIA_API_KEY ?? "",
    },
    {
      name: "gemini",
      textUrl:   "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      visionUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      textModel:   "gemini-2.0-flash",
      visionModel: "gemini-2.0-flash",
      apiKey: process.env.GEMINI_API_KEY ?? "",
    },
  ];
  return all.filter(p => p.apiKey.length > 0);
}

/**
 * Strip markdown code fences and extract the first JSON object/array from text.
 * Handles:
 *   - Leading/trailing ``` fences
 *   - JSON embedded mid-text (extracts first {...} or [...] block)
 * Throws on invalid JSON.
 */
export function extractJSON<T>(text: string): T {
  // First try: strip markdown fences and parse directly
  let cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  // Second try: extract first {...} block in case model added preamble text
  if (!cleaned.startsWith("{") && !cleaned.startsWith("[")) {
    const match = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (match) cleaned = match[1];
  }

  return JSON.parse(cleaned) as T;
}

/** Build an OpenAI-compatible request body for a text-only prompt. */
function textBody(model: string, systemPrompt: string, userPrompt: string) {
  return {
    model,
    max_tokens: 1024,   // 512 was too small for multi-insight responses
    temperature: 0.2,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userPrompt   },
    ],
  };
}

/** Build an OpenAI-compatible request body for a vision prompt. */
function visionBody(
  model: string,
  systemPrompt: string,
  imageBase64: string,
  mimeType: string,
  userPrompt: string,
  maxTokens = 1024,
) {
  return {
    model,
    max_tokens: maxTokens,
    temperature: 0.2,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: `data:${mimeType};base64,${imageBase64}` },
          },
          { type: "text", text: userPrompt },
        ],
      },
    ],
  };
}

async function callProvider(
  provider: Provider,
  url: string,
  body: object,
): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "(unreadable)");
    throw new Error(`${provider.name} HTTP ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json() as { choices?: { message?: { content?: string } }[] };
  const content = data?.choices?.[0]?.message?.content ?? "";
  if (!content) throw new Error(`${provider.name}: empty response`);
  return content;
}

/**
 * Text completion with provider waterfall.
 * Returns raw string content from the model.
 * Throws AiProviderError when all providers fail.
 */
export async function callText(
  userPrompt: string,
  systemPrompt = "You are a helpful assistant. Return only valid JSON.",
): Promise<string> {
  const providers = getProviders();
  if (providers.length === 0) throw new AiProviderError("No AI API keys configured.", []);

  const errors: string[] = [];
  for (const p of providers) {
    try {
      const body = textBody(p.textModel, systemPrompt, userPrompt);
      return await callProvider(p, p.textUrl, body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(msg);
      console.error(`[ai-provider] ${p.name} text failed:`, msg);
    }
  }
  throw new AiProviderError("All AI providers failed.", errors);
}

/**
 * Fan-out text completion: the same prompt goes to EVERY configured provider
 * in parallel and all successful answers come back. The waterfall (callText)
 * settles for the first answer; this exists for consensus judging — e.g. the
 * reconcile mode majority-votes across providers instead of trusting one.
 * Providers that fail are dropped silently (their errors are collected).
 * Throws AiProviderError only when NO provider succeeds.
 */
export async function callTextAll(
  userPrompt: string,
  systemPrompt = "You are a helpful assistant. Return only valid JSON.",
): Promise<{ provider: string; content: string }[]> {
  const providers = getProviders();
  if (providers.length === 0) throw new AiProviderError("No AI API keys configured.", []);

  const settled = await Promise.allSettled(
    providers.map(async p => ({
      provider: p.name,
      content: await callProvider(p, p.textUrl, textBody(p.textModel, systemPrompt, userPrompt)),
    })),
  );
  const ok: { provider: string; content: string }[] = [];
  const errors: string[] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") ok.push(s.value);
    else {
      const msg = s.reason instanceof Error ? s.reason.message : String(s.reason);
      errors.push(msg);
      console.error(`[ai-provider] ${providers[i].name} text (fan-out) failed:`, msg);
    }
  });
  if (ok.length === 0) throw new AiProviderError("All AI providers failed.", errors);
  return ok;
}

/**
 * Vision completion with provider waterfall.
 * imageBase64 — raw base64 string (no data: prefix).
 * mimeType    — e.g. "image/jpeg"
 * Returns raw string content from the model.
 */
export async function callVision(
  imageBase64: string,
  mimeType: string,
  userPrompt: string,
  systemPrompt = "You are a helpful assistant. Return only valid JSON.",
): Promise<string> {
  const providers = getProviders();
  if (providers.length === 0) throw new AiProviderError("No AI API keys configured.", []);

  const errors: string[] = [];
  for (const p of providers) {
    try {
      const body = visionBody(p.visionModel, systemPrompt, imageBase64, mimeType, userPrompt);
      return await callProvider(p, p.visionUrl, body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(msg);
      console.error(`[ai-provider] ${p.name} vision failed:`, msg);
    }
  }
  throw new AiProviderError("All AI providers failed.", errors);
}

/**
 * Vision completion with provider waterfall — returns content AND provider name.
 * Use this when the caller wants to surface which provider answered (e.g. food-vision.ts).
 */
export async function callVisionWithProvider(
  imageBase64: string,
  mimeType: string,
  userPrompt: string,
  systemPrompt = "You are a helpful assistant. Return only valid JSON.",
  opts: { maxTokens?: number } = {},
): Promise<{ content: string; provider: string }> {
  const providers = getProviders();
  if (providers.length === 0) throw new AiProviderError("No AI API keys configured.", []);

  const errors: string[] = [];
  for (const p of providers) {
    try {
      const body = visionBody(p.visionModel, systemPrompt, imageBase64, mimeType, userPrompt, opts.maxTokens);
      const content = await callProvider(p, p.visionUrl, body);
      return { content, provider: p.name };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(msg);
      console.error(`[ai-provider] ${p.name} vision failed:`, msg);
    }
  }
  throw new AiProviderError("All AI providers failed.", errors);
}

/** Thrown when every provider in the waterfall has been exhausted. */
export class AiProviderError extends Error {
  public readonly providerErrors: string[];
  constructor(message: string, providerErrors: string[]) {
    super(message);
    this.name = "AiProviderError";
    this.providerErrors = providerErrors;
  }
}

/** Convenience: how many providers are currently configured? */
export function configuredProviderCount(): number {
  return getProviders().length;
}
