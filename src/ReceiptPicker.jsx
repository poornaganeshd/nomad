import { useState, useRef, useImperativeHandle, forwardRef, useEffect } from "react";
import { uploadReceipt } from "./receiptUpload";

const MAX = 5;

const ReceiptPicker = forwardRef(function ReceiptPicker({ cloudinaryEnabled = true }, ref) {
  const [items, setItems]       = useState([]); // { id, file, localUrl }
  const [showMenu, setShowMenu] = useState(false);
  const [hovered, setHovered]   = useState(false);
  const cameraRef  = useRef();
  const galleryRef = useRef();
  // Track the latest items in a ref so the unmount cleanup sees them.
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Revoke any outstanding object URLs when the picker unmounts so blobs from
  // an abandoned Add form don't linger in memory until page reload.
  useEffect(() => () => { itemsRef.current.forEach(it => URL.revokeObjectURL(it.localUrl)); }, []);

  // ── Exposed to parent via ref ──────────────────────────────────
  useImperativeHandle(ref, () => ({
    // Upload all pending files, return array of Cloudinary URLs.
    // Throws on any failure so the caller can surface a clear error
    // toast and keep the picker state intact for retry.
    async upload() {
      if (items.length === 0) return [];
      const results = await Promise.allSettled(items.map(it => uploadReceipt(it.file)));
      const failed = results.filter(r => r.status === "rejected");
      if (failed.length > 0) {
        const reason = failed[0].reason?.message || "Upload failed";
        const msg = failed.length === items.length
          ? `Receipt upload failed: ${reason}`
          : `${failed.length} of ${items.length} receipts failed to upload: ${reason}`;
        throw new Error(msg);
      }
      return results.map(r => r.value);
    },
    clear() {
      setItems(prev => { prev.forEach(it => URL.revokeObjectURL(it.localUrl)); return []; });
      setShowMenu(false);
    },
    get count() { return items.length; },
  }));

  // ── Helpers ────────────────────────────────────────────────────
  const addFiles = (fileList) => {
    const next = Array.from(fileList).slice(0, MAX - items.length).map(file => ({
      id: Math.random().toString(36).slice(2),
      file,
      localUrl: URL.createObjectURL(file),
      isPdf: file.type === "application/pdf",
    }));
    setItems(prev => [...prev, ...next]);
    setShowMenu(false);
  };

  const remove = (id) => {
    setItems(prev => {
      const it = prev.find(x => x.id === id);
      if (it) URL.revokeObjectURL(it.localUrl);
      return prev.filter(x => x.id !== id);
    });
  };

  const canAdd = items.length < MAX;

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div>
      {/* Thumbnail strip */}
      {items.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          {items.map(it => (
            <div key={it.id} style={{ position: "relative", width: 64, height: 64, borderRadius: 10, overflow: "hidden", border: "1.5px solid var(--border)", flexShrink: 0, background: it.isPdf ? "#7B8CDE18" : "transparent", display: "flex", alignItems: "center", justifyContent: "center" }}>
              {it.isPdf ? <span style={{ fontSize: 28 }}>📄</span> : <img src={it.localUrl} alt="receipt" style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
              <button
                onClick={() => remove(it.id)}
                style={{ position: "absolute", top: 3, right: 3, width: 18, height: 18, borderRadius: "50%", background: "rgba(0,0,0,0.6)", border: "none", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, padding: 0, lineHeight: 1 }}
              >✕</button>
            </div>
          ))}
        </div>
      )}

      {/* Add button + source menu */}
      {!cloudinaryEnabled && items.length === 0 && (
        <div style={{ fontSize: 11, color: "var(--muted)", fontStyle: "italic" }}>Add Cloudinary in Settings to attach receipts</div>
      )}
      {cloudinaryEnabled && canAdd && (
        <div style={{ position: "relative", display: "inline-block" }}>
          {/* Backdrop to close menu */}
          {showMenu && (
            <div style={{ position: "fixed", inset: 0, zIndex: 98 }} onClick={() => setShowMenu(false)} />
          )}

          {/* The dashed button */}
          <button
            onClick={() => setShowMenu(v => !v)}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            style={{
              display: "inline-flex", alignItems: "center", gap: 7,
              padding: "9px 16px",
              border: `1.5px dashed ${hovered ? "var(--text)" : "var(--border)"}`,
              borderRadius: 10,
              cursor: "pointer",
              fontSize: 12,
              fontFamily: "var(--font-h)",
              fontWeight: 600,
              color: hovered ? "var(--text)" : "var(--muted)",
              background: hovered ? "var(--bg)" : "transparent",
              transition: "color 0.15s, border-color 0.15s, background 0.15s",
            }}
          >
            {/* camera icon */}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
            {items.length > 0 ? `Add Receipt (${items.length}/${MAX})` : "Attach Receipt"}
          </button>

          {/* Source picker menu */}
          {showMenu && (
            <div style={{
              position: "absolute", bottom: "calc(100% + 8px)", left: 0, zIndex: 99,
              background: "var(--card)", border: "1px solid var(--border)",
              borderRadius: 12, overflow: "hidden",
              boxShadow: "0 4px 20px rgba(0,0,0,0.14)",
              minWidth: 160,
            }}>
              {/* Camera option */}
              <label style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", cursor: "pointer", fontSize: 13, fontFamily: "var(--font-h)", fontWeight: 600, color: "var(--text)" }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
                Camera
                <input ref={cameraRef} type="file" accept="image/*" capture="environment"
                  onChange={e => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = ""; }}
                  style={{ display: "none" }}
                />
              </label>

              <div style={{ height: 1, background: "var(--border)", margin: "0 12px" }} />

              {/* Gallery option */}
              <label style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", cursor: "pointer", fontSize: 13, fontFamily: "var(--font-h)", fontWeight: 600, color: "var(--text)" }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <polyline points="21 15 16 10 5 21" />
                </svg>
                Gallery
                <input ref={galleryRef} type="file" accept="image/*" multiple
                  onChange={e => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = ""; }}
                  style={{ display: "none" }}
                />
              </label>

              <div style={{ height: 1, background: "var(--border)", margin: "0 12px" }} />

              {/* PDF option */}
              <label style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", cursor: "pointer", fontSize: 13, fontFamily: "var(--font-h)", fontWeight: 600, color: "var(--text)" }}>
                <span style={{ fontSize: 15 }}>📄</span>
                PDF / File
                <input type="file" accept="image/*,application/pdf" multiple
                  onChange={e => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = ""; }}
                  style={{ display: "none" }}
                />
              </label>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export default ReceiptPicker;
