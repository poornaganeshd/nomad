import type { VercelRequest, VercelResponse } from "@vercel/node";

// Matches the real Supabase project-ref host. Anchored end-to-end ($) so a
// look-alike like "<ref>.supabase.co.attacker.com" can't pass and turn this
// public endpoint into an open relay / SSRF pivot.
const SUPABASE_HOST_RE = /^[a-z0-9]{20}\.supabase\.co$/;
const UPSTREAM_TIMEOUT_MS = 20_000;
const KEY_TTL_DAYS = 30;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { idempotencyKey, dedupeKey, method, path, body, headers } = (req.body ?? {}) as {
    idempotencyKey?: string;
    dedupeKey?: string;
    method?: string;
    path?: string;
    body?: string | null;
    headers?: Record<string, string>;
  };

  // Idempotency must dedupe *retries of one operation*, never two distinct
  // operations that happen to target the same record. idempotencyKey is a
  // per-operation token (stable across requeue/retry, unique per logical
  // write); dedupeKey is the client's record-level queue-coalescing key and is
  // deliberately reused across writes, so keying the cache on it would silently
  // drop legitimate follow-up writes (the cause of "data not syncing"). Prefer
  // the per-operation token; fall back to dedupeKey only for older clients.
  const cacheKey = idempotencyKey ?? dedupeKey ?? null;

  if (!method || !path || typeof path !== "string") {
    return res.status(400).json({ error: "method and path are required" });
  }

  // Security: only forward to valid Supabase project URLs. Parse the URL and
  // validate the HOST exactly — an unanchored prefix match would let
  // "<ref>.supabase.co.attacker.com" through and proxy the caller's headers
  // (incl. anon key) to an attacker-controlled host.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(path);
  } catch {
    return res.status(400).json({ error: "path must be a valid URL" });
  }
  if (parsedUrl.protocol !== "https:" || !SUPABASE_HOST_RE.test(parsedUrl.hostname)) {
    return res.status(400).json({ error: "path must be a Supabase REST URL" });
  }

  // Base URL (origin) and anon key so we can query nomad_sync_keys.
  const baseUrl = parsedUrl.origin;
  const anonKey =
    headers?.["apikey"] ??
    headers?.["Authorization"]?.replace(/^Bearer\s+/i, "") ??
    null;

  // ── Idempotency check ────────────────────────────────────────────────────
  // If we have a cacheKey and can identify the Supabase instance, check
  // whether this exact operation was already successfully applied.
  if (cacheKey && baseUrl && anonKey) {
    try {
      const checkRes = await fetch(
        `${baseUrl}/rest/v1/nomad_sync_keys?key=eq.${encodeURIComponent(cacheKey)}&select=result&limit=1`,
        {
          headers: {
            "Content-Type": "application/json",
            apikey: anonKey,
            Authorization: `Bearer ${anonKey}`,
          },
        }
      );
      if (checkRes.ok) {
        const rows = (await checkRes.json()) as Array<{ result: unknown }>;
        if (rows.length > 0) {
          // Already processed — return the cached response, no re-apply.
          const cached = rows[0].result;
          return res.status(200).json(cached ?? {});
        }
      }
      // If the table doesn't exist yet (404/400) we fall through and forward
      // the request normally — the table will be created on first nomad_setup run.
    } catch {
      // Network/parse error on the check — fall through and forward anyway.
    }
  }

  // ── Forward to Supabase ──────────────────────────────────────────────────
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);

  let upstreamRes: Response;
  let responseText: string;
  try {
    upstreamRes = await fetch(path, {
      method,
      headers: (headers ?? {}) as Record<string, string>,
      body: body ?? undefined,
      signal: ctrl.signal,
    });
    responseText = await upstreamRes.text();
  } catch (e: unknown) {
    clearTimeout(timer);
    if ((e as Error)?.name === "AbortError") {
      return res.status(504).json({ error: "Upstream timeout" });
    }
    return res.status(502).json({ error: "Upstream error", detail: (e as Error)?.message });
  } finally {
    clearTimeout(timer);
  }

  // ── Store idempotency key on success ─────────────────────────────────────
  if (upstreamRes.ok && cacheKey && baseUrl && anonKey) {
    let resultJson: unknown = null;
    try { resultJson = JSON.parse(responseText); } catch { /* non-JSON body — store null */ }

    // Fire-and-forget: don't block the client response waiting for key storage.
    Promise.all([
      // Store the key.
      fetch(`${baseUrl}/rest/v1/nomad_sync_keys`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: anonKey,
          Authorization: `Bearer ${anonKey}`,
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify({ key: cacheKey, result: resultJson }),
      }),
      // Prune keys older than TTL so the table doesn't grow unbounded.
      fetch(
        `${baseUrl}/rest/v1/nomad_sync_keys?created_at=lt.${new Date(
          Date.now() - KEY_TTL_DAYS * 24 * 60 * 60 * 1000
        ).toISOString()}`,
        {
          method: "DELETE",
          headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
        }
      ),
    ]).catch(() => {});
  }

  // ── Return upstream response unchanged ───────────────────────────────────
  const contentType = upstreamRes.headers.get("Content-Type") ?? "application/json";
  res.status(upstreamRes.status).setHeader("Content-Type", contentType).send(responseText);
}
