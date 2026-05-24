import { getCredentials } from "./credentials";
const MAX_WIDTH = 800;
const QUALITY = 0.7;

// Compress image via canvas before upload
export function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const blobUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(blobUrl);
      const scale = Math.min(1, MAX_WIDTH / img.width);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(blob => {
        if (!blob) { reject(new Error("Compression failed")); return; }
        resolve(blob);
      }, "image/jpeg", QUALITY);
    };
    img.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error("Failed to load image")); };
    img.src = blobUrl;
  });
}

// SHA-1 hex digest via Web Crypto API (available in all modern browsers + Node 14.17+)
async function sha1Hex(str) {
  const buf = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Returns true when a receipt URL is a locally-stored data URL (no Cloudinary).
// Use this in UI to show a "stored locally" badge or suppress broken-link warnings.
export function isLocalReceipt(url) {
  return typeof url === "string" && url.startsWith("data:");
}

// Compress a file and return it as a base64 data URL (local storage fallback).
function toDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(blob);
  });
}

// Compress + upload to Cloudinary.
//
// Two modes (backwards-compatible):
//   Signed   — apiKey + apiSecret present → SHA-1 signature, no upload preset required
//   Unsigned — uploadPreset present, no apiSecret required
//
// Local fallback — when Cloudinary is not configured (no cloudName) OR when the
//   Cloudinary upload fails (network error, CORS, etc.), the file is compressed and
//   returned as a base64 data URL stored directly in the expense's receipt_url column.
//   Callers should check isLocalReceipt(url) to surface a "stored locally" notice.
//
// Returns the secure_url (remote) or a data: URL (local fallback).
//
// When `{throwOnFail: true}` is passed, Cloudinary errors (4xx, 5xx, network)
// throw with the actual server message instead of silently falling back. Used
// by the manual migrate-local-receipts flow so the user sees the real reason
// the upload failed (bad preset, signed-only, quota, etc).
export async function uploadReceipt(file, opts = {}) {
  const creds = getCredentials();
  const { cloudName, apiKey, apiSecret, uploadPreset } = creds;
  const throwOnFail = !!opts.throwOnFail;

  const isPdf = file.type === "application/pdf";
  const blob = isPdf ? file : await compressImage(file);

  // No Cloudinary configured — store locally
  if (!cloudName) {
    if (throwOnFail) throw new Error("Cloudinary cloudName not configured");
    return await toDataUrl(blob);
  }

  // ── Cloudinary upload ─────────────────────────────────────────────────────
  const form = new FormData();
  form.append("file", blob, isPdf ? "receipt.pdf" : "receipt.jpg");

  if (apiKey && apiSecret) {
    // Signed upload
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await sha1Hex(`timestamp=${timestamp}${apiSecret}`);
    form.append("api_key", apiKey);
    form.append("timestamp", String(timestamp));
    form.append("signature", signature);
  } else if (uploadPreset) {
    // Unsigned upload via an unsigned upload preset
    form.append("upload_preset", uploadPreset);
  } else {
    if (throwOnFail) throw new Error("Cloudinary has no auth — set apiKey+apiSecret or uploadPreset");
    return await toDataUrl(blob);
  }

  try {
    // Cloudinary treats PDFs as images natively (multi-page). The /raw/upload
    // endpoint is for arbitrary binary files (zip, docx etc) — most unsigned
    // upload presets are scoped to resource_type=image and will 400 on /raw.
    // Use /image/upload for both images and PDFs so the same preset works.
    const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = err.error?.message || `Upload failed (${res.status})`;
      if (throwOnFail) throw new Error(msg);
      console.warn("Cloudinary upload rejected, storing receipt locally:", msg);
      return await toDataUrl(blob);
    }
    const data = await res.json();
    return data.secure_url;
  } catch (err) {
    if (throwOnFail) throw err;
    console.warn("Cloudinary upload failed, storing receipt locally:", err?.message || err);
    return await toDataUrl(blob);
  }
}
