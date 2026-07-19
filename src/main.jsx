import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { initOfflineSync } from './offlineSync'
import { attachGlobalHaptics } from './haptics'

// One delegated listener gives every interactive tap its haptic tick — no
// per-button wiring (see haptics.js).
attachGlobalHaptics()

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
    // controllerchange now fires only after the user accepts the update banner
    // (App.jsx posts SKIP_WAITING to the waiting SW) — the new SW no longer
    // skipWaiting()s on install, so deploys can't hard-reload a live session.
    // hadController guards the very first install: claim() on a fresh visit
    // also fires controllerchange, and that one must NOT reload.
    // The reload is also scoped to THE TAB THAT ACCEPTED: clients.claim()
    // swaps the controller in every open tab, but only the tab whose banner
    // was tapped carries the per-tab sessionStorage flag — other tabs keep
    // running (the new SW serves them network-first, so they aren't stale)
    // instead of being yanked mid-entry by a reload they didn't ask for.
    let hadController = !!navigator.serviceWorker.controller
    let reloaded = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) { hadController = true; return }
      if (reloaded) return
      let accepted = false
      try { accepted = sessionStorage.getItem('nomad-sw-accept') === '1'; sessionStorage.removeItem('nomad-sw-accept') } catch { /* storage blocked — stay put */ }
      if (!accepted) return
      reloaded = true
      window.location.reload()
    })
  })
}

initOfflineSync()

createRoot(document.getElementById('root')).render(
  <App />
)
