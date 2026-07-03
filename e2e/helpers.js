import { expect } from "@playwright/test";

// Empty nomad-v5 backup shaped with the REAL schema keys the app reads in
// loadLocalBackup() (App.jsx). categories/incomeSources are intentionally left
// empty so the app keeps its default seeds (the loader guards with `?.length`).
const EMPTY = {
  expenses: [],
  incomes: [],
  transfers: [],
  settlements: [],
  splits: [],
  events: [],
  recurring: [],
};

/**
 * Boot the app in local-only mode.
 *
 * With no Supabase credentials in localStorage the app runs entirely from the
 * `nomad-v5` local backup (localMode = !creds.sbUrl) and never hits the network,
 * so tests are deterministic without mocking Supabase. Optionally seed state via
 * the real schema keys (expenses, incomes, splits, …).
 *
 * Waits for the bottom-nav Add button so callers can interact immediately.
 */
export async function gotoLocal(page, state = {}) {
  // Abort remote font fetches: they're render-irrelevant to assertions, and on
  // restricted networks the hanging requests stall the `load` event past the
  // test timeout. Keeps the suite hermetic — no external hosts at all.
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto("/");
  await page.evaluate((s) => {
    localStorage.clear();
    localStorage.setItem("nomad-v5", JSON.stringify(s));
  }, { ...EMPTY, ...state, _modified: Date.now() });
  await page.reload();
  await expect(page.getByRole("button", { name: "Add", exact: true })).toBeVisible({ timeout: 15000 });
}

/**
 * Dismiss the amber "Local-only mode" banner so its ✕ button doesn't clash with
 * the per-row ✕ delete buttons in TxCard (both have accessible name "✕").
 */
export async function dismissBanner(page) {
  const banner = page.getByText("Local-only mode", { exact: false }).locator("xpath=ancestor::div[1]");
  if (await banner.count()) {
    await banner.getByRole("button", { name: "✕", exact: true }).click();
    await expect(page.getByText("Local-only mode", { exact: false })).toHaveCount(0);
  }
}

/** Read the persisted nomad-v5 backup as a parsed object. */
export async function readBackup(page) {
  return page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem("nomad-v5") || "{}");
    } catch {
      return {};
    }
  });
}

/**
 * Seed starting wallet balances. addE() (App.jsx) rejects an expense when the
 * wallet balance is below the amount ("Not enough in …"), so the add-expense
 * UI flow needs funds even though income/history seeding does not. Bank is the
 * default expense wallet.
 */
export function funded(bal = 100000) {
  return { walletStartBal: { bank: bal, cash: bal, upi_lite: 5000 } };
}

/**
 * Build a minimal expense row that renders in TxCard. Default date is TODAY so
 * the row matches the History tab's current-month filter (`fm` defaults to
 * `localDateKey().slice(0, 7)`); a hard-coded past date would silently fail
 * once the CI clock advances past it.
 */
export function makeExpense(overrides = {}) {
  return {
    id: "e2e-exp-" + Math.random().toString(36).slice(2),
    type: "expense",
    amount: 250,
    categoryId: "food",
    walletId: "bank",
    note: "Test expense",
    date: new Date().toISOString().slice(0, 10),
    balBefore: 1000,
    ...overrides,
  };
}
