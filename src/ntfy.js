// Client-side ntfy push notifications.
//
// Fits NOMAD's BYODB / local-first model: there is NO server component and no
// new env vars. Config lives in localStorage only, and the browser POSTs
// directly to the ntfy server (ntfy.sh sends permissive CORS headers, so a
// plain fetch from the SPA works). The user subscribes to their chosen topic
// in the ntfy mobile/desktop app to receive the push.
//
// Limitation by design: pushes only fire while a NOMAD tab is open (e.g. when
// the app is opened and bill reminders are evaluated). This is intentional —
// keeping it client-only means it works with zero backend setup.

const KEY = "nomad-ntfy-v1";
const DEFAULT_SERVER = "https://ntfy.sh";

// ntfy Title/Tags/Priority live in HTTP headers, which must be ISO-8859-1 /
// ASCII-safe. The message BODY is UTF-8, so anything non-ASCII (e.g. the ₹
// sign in "You owe ₹500") must go in the body, never the Title header.

export const getNtfyConfig = () => {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) || "{}");
    return {
      enabled: !!c.enabled,
      server: (c.server || DEFAULT_SERVER),
      topic: (c.topic || ""),
    };
  } catch {
    return { enabled: false, server: DEFAULT_SERVER, topic: "" };
  }
};

export const saveNtfyConfig = (c) => {
  const clean = {
    enabled: !!(c && c.enabled),
    server: ((c && c.server) || DEFAULT_SERVER).trim().replace(/\/+$/, "") || DEFAULT_SERVER,
    topic: ((c && c.topic) || "").trim(),
  };
  localStorage.setItem(KEY, JSON.stringify(clean));
  return clean;
};

// Ready to publish = user opted in AND gave a topic AND a server.
export const isNtfyConfigured = (c) => !!(c && c.enabled && c.topic && c.server);

// Build the publish URL for a topic. ntfy topics are a single path segment.
export function ntfyUrl(server, topic) {
  const base = (server || DEFAULT_SERVER).trim().replace(/\/+$/, "");
  const t = (topic || "").trim();
  if (!t) throw new Error("ntfy topic is required");
  return `${base}/${encodeURIComponent(t)}`;
}

// Map a NOMAD reminder/toast type to an ntfy priority + tag set. Tags are
// emoji shortcodes (https://ntfy.sh/docs/emojis/) — all ASCII, header-safe.
export function ntfyMeta(type) {
  switch (type) {
    case "warn":
      return { priority: "high", tags: ["warning", "money_with_wings"] };
    case "error":
      return { priority: "urgent", tags: ["rotating_light"] };
    case "success":
      return { priority: "default", tags: ["white_check_mark"] };
    default:
      return { priority: "default", tags: ["bell"] };
  }
}

// Publish a single notification. Returns { ok, ... } and never throws for a
// non-configured client (so callers can fire-and-forget). Network/HTTP errors
// are surfaced via ok:false so a "Send test" button can report them.
export async function publishNtfy(
  config,
  { title = "NOMAD", message = "", type = "info", tags, priority } = {},
  fetchImpl = (typeof fetch !== "undefined" ? fetch : null),
) {
  if (!isNtfyConfigured(config)) return { ok: false, skipped: true };
  if (!fetchImpl) return { ok: false, error: "fetch unavailable" };
  const meta = ntfyMeta(type);
  // Strip characters that are illegal in HTTP header values (newlines) and any
  // non-ASCII from the Title (it lives in a header). The body keeps full UTF-8.
  const safeTitle = String(title).replace(/[\r\n]+/g, " ").replace(/[^\x20-\x7E]/g, "").trim() || "NOMAD";
  const headers = {
    Title: safeTitle,
    Priority: priority || meta.priority,
    Tags: (tags || meta.tags).join(","),
  };
  try {
    const res = await fetchImpl(ntfyUrl(config.server, config.topic), {
      method: "POST",
      headers,
      body: String(message),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e?.message || "network error" };
  }
}
