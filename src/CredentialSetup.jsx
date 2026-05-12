import { useState } from "react";
import { getCredentials, saveCredentials } from "./credentials";

const STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,opsz,wght@0,8..18,400;0,8..18,500;0,8..18,600;0,8..18,700;0,8..18,800;1,8..18,400&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  .ns-root {
    min-height: 100vh;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    background: #F4F0EA;
    font-family: 'Plus Jakarta Sans', sans-serif;
    padding: 48px 20px 80px;
  }

  .ns-col { width: 100%; max-width: 420px; }

  /* ── Header ── */
  .ns-head { text-align: center; margin-bottom: 32px; }

  .ns-title {
    font-size: 23px; font-weight: 800; letter-spacing: 6px;
    color: #2C1F0E; margin-bottom: 8px;
    text-transform: uppercase;
  }
  .ns-subtitle {
    font-size: 13px; color: #8C7B62; line-height: 1.7; font-weight: 400;
  }

  /* ── Cards ── */
  .ns-card {
    background: #FFFFFF;
    border: 1.5px solid rgba(0,0,0,0.07);
    border-radius: 18px;
    padding: 22px 22px 24px;
    margin-bottom: 12px;
    position: relative;
    overflow: hidden;
    box-shadow: 0 2px 12px rgba(0,0,0,0.05);
    transition: box-shadow 0.2s;
  }
  .ns-card-sb::before {
    content: '';
    position: absolute; top: 0; left: 0; bottom: 0; width: 4px;
    background: linear-gradient(180deg, #5AAB87, #2E8B5A);
    border-radius: 18px 0 0 18px;
  }
  .ns-card-sb:hover { box-shadow: 0 4px 20px rgba(46,139,90,0.12); }

  .ns-card-cl::before {
    content: '';
    position: absolute; top: 0; left: 0; bottom: 0; width: 4px;
    background: linear-gradient(180deg, #B8845A, #8B5E3C);
    border-radius: 18px 0 0 18px;
  }
  .ns-card-cl:hover { box-shadow: 0 4px 20px rgba(139,94,60,0.12); }

  .ns-card-head {
    display: flex; align-items: center; gap: 10px;
    margin-bottom: 20px;
  }
  .ns-card-icon-wrap {
    width: 36px; height: 36px; border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .ns-card-sb .ns-card-icon-wrap {
    background: #E8F5EE;
    box-shadow: 0 1px 6px rgba(46,139,90,0.15);
  }
  .ns-card-cl .ns-card-icon-wrap {
    background: #F5EDE4;
    box-shadow: 0 1px 6px rgba(139,94,60,0.15);
  }
  .ns-card-name {
    font-size: 14px; font-weight: 700; color: #1E1209;
    letter-spacing: 0.2px; flex: 1;
  }

  .ns-badge {
    font-size: 10px; font-weight: 700; letter-spacing: 0.4px;
    border-radius: 20px; padding: 3px 9px;
    text-transform: uppercase; flex-shrink: 0;
  }
  .ns-badge-req {
    background: #FDEEE4;
    color: #9B4E1A;
  }
  .ns-badge-opt {
    background: #EEF0E6;
    color: #6B7340;
  }

  /* ── Fields ── */
  .ns-field { margin-bottom: 14px; }
  .ns-field:last-child { margin-bottom: 0; }

  .ns-label {
    display: block; font-size: 12px; font-weight: 600;
    color: #4A3728; margin-bottom: 6px;
  }
  .ns-hint {
    font-size: 11px; color: #A8967E; font-style: italic;
    margin-bottom: 16px; line-height: 1.55; display: block;
  }

  .ns-input {
    width: 100%; padding: 11px 14px;
    border-radius: 10px;
    border: 1.5px solid #E0D8CE;
    background: #FAF7F4;
    color: #1E1209;
    font-size: 13px; font-family: 'Plus Jakarta Sans', sans-serif;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
    -webkit-appearance: none;
  }
  .ns-input::placeholder { color: #C5B8A8; }

  .ns-card-sb .ns-input:focus {
    border-color: #5AAB87;
    box-shadow: 0 0 0 3px rgba(90,171,135,0.12), inset 3px 0 0 #5AAB87;
    background: #F5FBF8;
  }
  .ns-card-cl .ns-input:focus {
    border-color: #B8845A;
    box-shadow: 0 0 0 3px rgba(184,132,90,0.12), inset 3px 0 0 #B8845A;
    background: #FBF7F3;
  }

  /* ── Error ── */
  .ns-error {
    font-size: 12px; font-weight: 600; color: #9B4E1A;
    padding: 10px 14px; background: #FDF0E8;
    border: 1px solid #F0C8A8; border-radius: 10px;
    text-align: center; margin: 4px 0 8px;
  }

  /* ── Footer ── */
  .ns-footer { margin-top: 18px; display: flex; flex-direction: column; gap: 8px; }

  .ns-btn-primary {
    width: 100%; padding: 14px;
    border-radius: 12px; border: none;
    background: #7C4A2A;
    color: #FDF6EE;
    font-family: 'Plus Jakarta Sans', sans-serif;
    font-size: 14px; font-weight: 700;
    cursor: pointer; letter-spacing: 0.3px;
    box-shadow: 0 2px 10px rgba(124,74,42,0.30);
    transition: background 0.15s, box-shadow 0.15s, transform 0.1s;
  }
  .ns-btn-primary:hover {
    background: #6A3D22;
    box-shadow: 0 4px 16px rgba(124,74,42,0.38);
    transform: translateY(-1px);
  }
  .ns-btn-primary:active { transform: scale(0.99); }

  .ns-btn-restore {
    width: 100%; padding: 13px;
    border-radius: 12px;
    border: 1.5px solid #C4A882;
    background: transparent;
    color: #7C5A38;
    font-family: 'Plus Jakarta Sans', sans-serif;
    font-size: 13px; font-weight: 600;
    cursor: pointer; text-align: center; display: block;
    transition: background 0.15s, border-color 0.15s;
  }
  .ns-btn-restore:hover {
    background: #F5EDE2;
    border-color: #A07040;
  }

  .ns-btn-cancel {
    width: 100%; padding: 12px;
    border-radius: 12px;
    border: 1.5px solid #DDD5C8;
    background: transparent;
    color: #B0A090;
    font-family: 'Plus Jakarta Sans', sans-serif;
    font-size: 13px; font-weight: 500;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }
  .ns-btn-cancel:hover { color: #7C4A2A; border-color: #C4A882; }

  .ns-guide-link {
    display: flex; align-items: center; justify-content: center; gap: 4px;
    font-size: 12px; color: #B0A090; font-weight: 500;
    background: none; border: none; cursor: pointer;
    width: 100%; padding: 6px;
    font-family: 'Plus Jakarta Sans', sans-serif;
    transition: color 0.15s;
  }
  .ns-guide-link:hover { color: #7C4A2A; }

  /* ── Guide panel ── */
  .ns-guide {
    background: #FBF7F2;
    border: 1px solid #E8DDD0;
    border-radius: 12px;
    padding: 16px 18px;
    font-size: 12px; color: #5C4A36; line-height: 1.9;
  }
  .ns-guide strong { color: #2C1F0E; font-weight: 700; }
  .ns-guide em { color: #8B5E3C; font-style: normal; font-weight: 600; }

  /* ── Divider ── */
  .ns-div {
    height: 1px; background: #EDE6DC; margin: 4px 0;
  }

  /* ── Landing screen ── */
  .ns-landing-hero {
    text-align: center; padding: 24px 0 28px;
  }
  .ns-landing-logo {
    font-size: 36px; font-weight: 800; letter-spacing: 10px;
    color: #2C1F0E; text-transform: uppercase; margin-bottom: 10px;
  }
  .ns-landing-tagline {
    font-size: 14px; color: #6B5744; line-height: 1.7; font-weight: 500;
  }
  .ns-features {
    display: flex; flex-direction: column; gap: 8px; margin-bottom: 24px;
  }
  .ns-feature-row {
    display: flex; align-items: center; gap: 12px;
    padding: 11px 14px;
    background: #FAF7F4; border: 1px solid #EDE6DC; border-radius: 12px;
    font-size: 13px; font-weight: 600; color: #2C1F0E;
  }
  .ns-feature-icon { font-size: 16px; flex-shrink: 0; }
  .ns-btn-backend {
    width: 100%; padding: 14px;
    border-radius: 14px; border: 2px solid #C4A882;
    background: transparent; color: #7C4A2A;
    font-family: 'Plus Jakarta Sans', sans-serif;
    font-size: 14px; font-weight: 700; cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .ns-btn-backend:hover { background: #F5EDE2; border-color: #A07040; }
`;


/* ── SVG icons ── */
function IconDb() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <ellipse cx="9" cy="5" rx="6" ry="2.5" stroke="#2E8B5A" strokeWidth="1.6" fill="rgba(90,171,135,0.14)" />
      <path d="M3 5v4c0 1.38 2.686 2.5 6 2.5S15 10.38 15 9V5" stroke="#2E8B5A" strokeWidth="1.6" fill="none" />
      <path d="M3 9v4c0 1.38 2.686 2.5 6 2.5S15 14.38 15 13V9" stroke="#2E8B5A" strokeWidth="1.6" fill="none" />
    </svg>
  );
}
function IconCloud() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M13.5 12.5H5a3 3 0 1 1 .424-5.976A4 4 0 1 1 13.5 9a2.5 2.5 0 0 1 0 3.5z"
        stroke="#8B5E3C" strokeWidth="1.6" strokeLinejoin="round"
        fill="rgba(184,132,90,0.14)" />
    </svg>
  );
}
function IconLock() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none"
      style={{ display: "inline", verticalAlign: "middle", marginRight: 4, opacity: 0.55 }}>
      <rect x="2.5" y="6" width="9" height="6.5" rx="2" stroke="#8B5E3C" strokeWidth="1.4" fill="rgba(139,94,60,0.08)" />
      <path d="M4.5 6V4.5a2.5 2.5 0 0 1 5 0V6" stroke="#8B5E3C" strokeWidth="1.4" fill="none" />
    </svg>
  );
}

export default function CredentialSetup({ onDone, onCancel }) {
  const existing = getCredentials();
  const [sbUrl, setSbUrl]               = useState(existing.sbUrl || "");
  const [sbKey, setSbKey]               = useState(existing.sbKey || "");
  const [cloudName, setCloudName]       = useState(existing.cloudName || "");
  const [uploadPreset, setUploadPreset] = useState(existing.uploadPreset || "");
  const [apiKey, setApiKey]             = useState(existing.apiKey || "");
  const [apiSecret, setApiSecret]       = useState(existing.apiSecret || "");
  const [error, setError]               = useState("");
  const [showGuide, setShowGuide]       = useState(false);

  const importConfig = (file) => {
    if (!file) return;
    const r = new FileReader();
    r.onload = (e) => {
      try {
        const d = JSON.parse(e.target.result);
        const isStr = (v) => typeof v === "string" && v.trim().length > 0;
        if (!d || typeof d !== "object" || !isStr(d.sbUrl) || !isStr(d.sbKey)) {
          setError("Invalid config — sbUrl and sbKey must be non-empty strings."); return;
        }
        if (!/^https:\/\/[a-z0-9]{20}\.supabase\.co\/?$/.test(d.sbUrl.trim())) {
          setError("Invalid Supabase URL format. Expected https://{20-char-ref}.supabase.co"); return;
        }
        saveCredentials({
          sbUrl: d.sbUrl.trim(),
          sbKey: d.sbKey.trim(),
          cloudName: typeof d.cloudName === "string" ? d.cloudName.trim() : "",
          uploadPreset: typeof d.uploadPreset === "string" ? d.uploadPreset.trim() : "",
          apiKey: typeof d.apiKey === "string" ? d.apiKey.trim() : "",
          apiSecret: typeof d.apiSecret === "string" ? d.apiSecret.trim() : "",
        });
        onDone();
      } catch { setError("Failed to read config file."); }
    };
    r.readAsText(file);
  };

  const save = () => {
    if (!sbUrl.trim() || !sbKey.trim()) { setError("Supabase URL and Anon Key are required."); return; }
    saveCredentials({ sbUrl: sbUrl.trim(), sbKey: sbKey.trim(), cloudName: cloudName.trim(), uploadPreset: uploadPreset.trim(), apiKey: apiKey.trim(), apiSecret: apiSecret.trim() });
    onDone();
  };

  return (
    <div className="ns-root">
      <style>{STYLES}</style>
      <div className="ns-col">

        {/* ── Header ── */}
        <div className="ns-head">
          <div className="ns-title">NOMAD</div>
          <div className="ns-subtitle">
            Connect your own backend.<br />Your data stays completely private.
          </div>
        </div>

        {/* ── Supabase card ── */}
        <div className="ns-card ns-card-sb">
          <div className="ns-card-head">
            <div className="ns-card-icon-wrap"><IconDb /></div>
            <span className="ns-card-name">Supabase</span>
            <span className="ns-badge ns-badge-req">Required</span>
          </div>
          <div className="ns-field">
            <label className="ns-label">Project URL</label>
            <input className="ns-input" value={sbUrl}
              onChange={e => { setSbUrl(e.target.value); setError(""); }}
              placeholder="https://xxxx.supabase.co"
              autoComplete="off" spellCheck={false} />
          </div>
          <div className="ns-field">
            <label className="ns-label"><IconLock />Anon / Public Key</label>
            <input className="ns-input" value={sbKey}
              onChange={e => { setSbKey(e.target.value); setError(""); }}
              placeholder="eyJhbGciOiJIUzI1NiIs…"
              autoComplete="off" spellCheck={false} />
          </div>
        </div>

        {/* ── Cloudinary card ── */}
        <div className="ns-card ns-card-cl">
          <div className="ns-card-head">
            <div className="ns-card-icon-wrap"><IconCloud /></div>
            <span className="ns-card-name">Cloudinary</span>
            <span className="ns-badge ns-badge-opt">Optional</span>
          </div>
          <span className="ns-hint">Only needed for receipt photo uploads. Use API Key + Secret for signed uploads (recommended).</span>
          <div className="ns-field">
            <label className="ns-label">Cloud Name</label>
            <input className="ns-input" value={cloudName}
              onChange={e => setCloudName(e.target.value)}
              placeholder="your-cloud-name"
              autoComplete="off" spellCheck={false} />
          </div>
          <div className="ns-field">
            <label className="ns-label">API Key <span style={{ fontWeight: 400, opacity: 0.7 }}>(signed — recommended)</span></label>
            <input className="ns-input" value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="123456789012345"
              autoComplete="off" spellCheck={false} />
          </div>
          <div className="ns-field">
            <label className="ns-label">API Secret <span style={{ fontWeight: 400, opacity: 0.7 }}>(signed — recommended)</span></label>
            <input className="ns-input" type="password" value={apiSecret}
              onChange={e => setApiSecret(e.target.value)}
              placeholder="your-api-secret"
              autoComplete="off" spellCheck={false} />
          </div>
          <div className="ns-field">
            <label className="ns-label">Upload Preset <span style={{ fontWeight: 400, opacity: 0.7 }}>(unsigned — if no API Secret)</span></label>
            <input className="ns-input" value={uploadPreset}
              onChange={e => setUploadPreset(e.target.value)}
              placeholder="receipt_upload"
              autoComplete="off" spellCheck={false} />
          </div>
        </div>

        {/* ── Error ── */}
        {error && <div className="ns-error">{error}</div>}

        {/* ── Footer ── */}
        <div className="ns-footer">
          <button className="ns-btn-primary" onClick={save}>
            Save &amp; Continue →
          </button>

          <label className="ns-btn-restore">
            ↩ Restore from config backup
            <input type="file" accept=".json" style={{ display: "none" }}
              onChange={e => { if (e.target.files[0]) importConfig(e.target.files[0]); e.target.value = ""; }} />
          </label>

          {onCancel && (
            <button className="ns-btn-cancel" onClick={onCancel}>Cancel</button>
          )}

          <div className="ns-div" />

          <button className="ns-guide-link" onClick={() => setShowGuide(v => !v)}>
            How do I get these credentials? <span style={{ fontWeight: 700 }}>↗</span>
          </button>

          {showGuide && (
            <div className="ns-guide">
              <strong>Supabase (free)</strong><br />
              1. Sign up at supabase.com → New project<br />
              2. Settings → API → copy "Project URL" &amp; "anon public" key<br />
              3. Run <em>nomad_setup.sql</em> in the SQL Editor<br />
              <br />
              <strong>Cloudinary (free, optional)</strong><br />
              1. Sign up at cloudinary.com<br />
              2. Dashboard → copy your "Cloud name"<br />
              3. For signed uploads (recommended): Settings → API Keys → copy API Key &amp; Secret<br />
              4. For unsigned uploads: Settings → Upload → add unsigned preset → copy name
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
