// Read EVERY row of a PostgREST table, a page at a time.
//
// Supabase caps every response at the project's "Max rows" setting (1000 by
// default), and a `limit` in the URL cannot raise it — the server clamps it.
// sbGet used to ask for `limit=50000` believing that overrode the cap, so the
// moment someone had logged their 1001st expense the read came back short:
// a fresh device showed the wrong balances, and every background pull called
// the rows it had not received "lost writes" and re-uploaded them, every
// minute, indefinitely. Which 1000 rows came back was not even stable — there
// was no ORDER BY.
//
// So: order by the primary key, ask for the total with `Prefer: count=exact`,
// and walk `offset` until we hold that many rows. The page size is whatever
// the server actually returned, so a project with Max rows set to 500 (or
// 5000) paginates correctly too. A failed page fails the WHOLE read — a
// partial table is worse than none, since the merge treats absence as meaning
// something.
//
// `fetchFn(url, init)` is injected so this stays pure and testable.
// Returns { ok: true, rows } or { ok: false, status }.

export const PAGE_SIZE = 1000;
const MAX_PAGES = 200; // 200k rows — a runaway guard, not a real limit

export const totalFromContentRange = (header) => {
  // "0-999/2345", "*/0", "0-999/*"
  const m = /\/(\d+)\s*$/.exec(String(header || ""));
  return m ? Number(m[1]) : null;
};

export async function fetchAllRows(fetchFn, urlBase, headers = {}, { orderCol = "id", pageSize = PAGE_SIZE } = {}) {
  const sep = urlBase.includes("?") ? "&" : "?";
  const url = (offset) => `${urlBase}${sep}order=${encodeURIComponent(orderCol)}.asc&limit=${pageSize}&offset=${offset}`;
  const first = await fetchFn(url(0), { headers: { ...headers, Prefer: "count=exact" } });
  if (!first.ok) return { ok: false, status: first.status };
  let rows = await first.json();
  if (!Array.isArray(rows)) return { ok: false, status: first.status };
  const total = totalFromContentRange(first.headers?.get?.("content-range"));
  for (let page = 1; page < MAX_PAGES; page++) {
    // With a known total, stop once we have it. Without one (header stripped
    // by a proxy), stop on a short or empty page — the best we can do.
    if (total != null ? rows.length >= total : rows.length % pageSize !== 0) break;
    const r = await fetchFn(url(rows.length), { headers });
    if (!r.ok) return { ok: false, status: r.status };
    const next = await r.json();
    if (!Array.isArray(next)) return { ok: false, status: r.status };
    if (next.length === 0) break;
    rows = rows.concat(next);
  }
  return { ok: true, rows };
}
