import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { initOfflineSync } from './offlineSync'

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
    // controllerchange now fires only after the user accepts the update banner
    // (App.jsx posts SKIP_WAITING to the waiting SW) — the new SW no longer
    // skipWaiting()s on install, so deploys can't hard-reload a live session.
    // hadController guards the very first install: claim() on a fresh visit
    // also fires controllerchange, and that one must NOT reload.
    let hadController = !!navigator.serviceWorker.controller
    let reloaded = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) { hadController = true; return }
      if (reloaded) return
      reloaded = true
      window.location.reload()
    })
  })
}

initOfflineSync()

createRoot(document.getElementById('root')).render(
  <App />
)
