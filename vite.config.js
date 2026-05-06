import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

// Replaces the hard-coded CACHE_NAME version in sw.js at build time so
// developers never have to manually bump it. Each production build gets a
// unique base-36 timestamp; cache invalidation is guaranteed automatically.
const injectSwVersion = () => ({
  name: 'inject-sw-version',
  closeBundle() {
    const ver = Date.now().toString(36);
    try {
      const p = resolve('dist', 'sw.js');
      writeFileSync(p, readFileSync(p, 'utf8').replace(/nomad-app-v[\w-]+/, `nomad-app-${ver}`));
    } catch { /* no dist/sw.js during dev — safe to ignore */ }
  },
});

export default defineConfig({
  plugins: [react(), injectSwVersion()],
  server: {
    hmr: { protocol: "ws", host: "localhost" }
  },
  build: {
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name]-[hash]-${Date.now()}.js`,
      }
    }
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{js,jsx}', 'api/**/*.ts'],
      exclude: ['src/main.jsx', 'src/App.css', 'src/index.css'],
    },
  },
})