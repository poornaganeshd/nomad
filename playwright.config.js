import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: 1,
  use: {
    baseURL: "http://localhost:5173",
    viewport: { width: 390, height: 844 }, // iPhone 14 Pro
    trace: "on-first-retry",
    // The PWA service worker reloads the page on `controllerchange` (main.jsx),
    // which destroys the test's execution context mid-run. Block SW in e2e.
    serviceWorkers: "block",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
  },
});
