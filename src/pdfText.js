// pdfText.js — client-side PDF text extraction (lazy-loaded pdfjs-dist).
//
// Why this exists: the old statement flow shipped the whole PDF to Gemini's
// native vision API, so it only worked when GEMINI_API_KEY was set AND the
// vision OCR happened to succeed — the "Statement OCR unavailable — all AI
// providers failed" dead-end users kept hitting. Almost every bank / UPI
// statement (GPay, PhonePe, Paytm, bank e-statements) is a *text* PDF, so we
// can pull the text on-device and hand it to ANY text model. Scanned / image
// PDFs yield little text; callers detect that (via `looksLikeText`) and fall
// back to the vision path.
//
// pdfjs is dynamically imported so it lands in its own chunk — the ~1 MB
// library never touches the main bundle and only loads when a PDF is attached.

let _pdfjsPromise = null;

async function loadPdfjs() {
  if (!_pdfjsPromise) {
    _pdfjsPromise = (async () => {
      const pdfjs = await import("pdfjs-dist");
      // Vite resolves the `?url` suffix to the emitted worker asset URL; the
      // worker must match the library version, so we point at pdfjs's own file.
      const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    })().catch((e) => { _pdfjsPromise = null; throw e; });
  }
  return _pdfjsPromise;
}

// Reassemble a page's text items into readable lines. pdfjs returns each glyph
// run with a transform matrix ([a,b,c,d,x,y]); items sharing a y-band belong to
// the same visual row, so a statement line (date · amount · narration) stays
// together instead of collapsing into one giant blob.
function itemsToLines(items) {
  const rows = [];
  for (const it of items) {
    const str = typeof it.str === "string" ? it.str : "";
    if (!str) continue;
    const y = Array.isArray(it.transform) ? Math.round(it.transform[5]) : 0;
    const x = Array.isArray(it.transform) ? it.transform[4] : 0;
    // Bucket to the nearest 3px so slightly-misaligned glyphs still group.
    const key = Math.round(y / 3) * 3;
    let row = rows.find((r) => Math.abs(r.y - key) <= 3);
    if (!row) { row = { y: key, cells: [] }; rows.push(row); }
    row.cells.push({ x, str });
  }
  // PDF y grows upward → sort rows top-to-bottom (descending y); cells L→R.
  rows.sort((a, b) => b.y - a.y);
  return rows
    .map((r) => r.cells.sort((a, b) => a.x - b.x).map((c) => c.str).join(" ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

// Extract plain text from a PDF File/Blob. Never throws — returns "" on any
// failure so the caller can transparently fall back to vision OCR.
export async function extractPdfText(file, { maxPages = 40 } = {}) {
  try {
    const pdfjs = await loadPdfjs();
    const buf = await file.arrayBuffer();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true }).promise;
    const pages = Math.min(doc.numPages, maxPages);
    const out = [];
    for (let p = 1; p <= pages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const text = itemsToLines(content.items || []);
      if (text) out.push(text);
      // Release page resources as we go so a big statement can't balloon memory.
      page.cleanup?.();
    }
    try { await doc.destroy(); } catch { /* best-effort cleanup */ }
    return out.join("\n").trim();
  } catch {
    return "";
  }
}

// Heuristic: does the extracted text carry enough real content to parse, or is
// this a scanned/image PDF that needs vision OCR? A statement worth parsing has
// digits (amounts/dates) and a handful of lines; a scanned PDF extracts a few
// stray ligatures at most.
export function looksLikeText(text) {
  if (!text || text.length < 40) return false;
  const digits = (text.match(/\d/g) || []).length;
  const lines = text.split("\n").filter((l) => l.trim().length > 2).length;
  return digits >= 8 && lines >= 3;
}
