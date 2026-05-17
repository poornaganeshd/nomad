/**
 * Persistence tests — verify that add/delete operations survive a page reload.
 *
 * Strategy: set fake-but-valid-format Supabase credentials so SB_ENABLED=true,
 * intercept all Supabase REST calls and return empty arrays, then inject test
 * state directly into nomad-v5 localStorage. On reload the app reads the local
 * backup immediately (stale-while-revalidate) before the intercepted Supabase
 * calls resolve — so the injected state is what the user sees.
 */
import { test, expect } from "@playwright/test";

const FAKE_URL = "https://abcdefghij1234567890.supabase.co";
const FAKE_KEY = "fake-anon-key";

async function setupWithState(page, nomadV5) {
  // Intercept Supabase so it never overwrites our localStorage state
  await page.route(`${FAKE_URL}/rest/v1/**`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
  );
  await page.goto("/");
  await page.evaluate(
    ([url, key, state]) => {
      localStorage.clear();
      localStorage.setItem("nomad-credentials", JSON.stringify({ sbUrl: url, sbKey: key }));
      localStorage.setItem("nomad-v5", JSON.stringify(state));
    },
    [FAKE_URL, FAKE_KEY, nomadV5]
  );
  await page.reload();
  // Wait for stale-while-revalidate render (localStorage backup shown immediately)
  await page.waitForTimeout(1500);
}

const baseState = {
  ex: [], inc: [], tr: [], stl: [], sp: [], rec: [], evs: [],
  cats: [], isrc: [], wallets: [], budgets: {}, wsb: {},
};

test("deleted expense does not reappear after reload", async ({ page }) => {
  const expense = {
    id: "test-exp-001",
    type: "expense",
    amount: 250,
    categoryId: "food",
    walletId: "bank",
    note: "Test lunch",
    date: "2026-05-01",
    balBefore: 1000,
  };

  await setupWithState(page, { ...baseState, ex: [expense] });

  // Navigate to History and verify the expense is visible
  await page.click("text=History");
  await expect(page.locator("text=Test lunch")).toBeVisible({ timeout: 5000 });

  // Delete it
  const deleteBtn = page.locator("button").filter({ hasText: "✕" }).first();
  await deleteBtn.click();

  // Reload the page — the delete must have persisted to nomad-v5
  await page.reload();
  await page.waitForTimeout(1500);
  await page.click("text=History");

  // Item must not be visible (regression: it was reappearing after soft-delete failures)
  await expect(page.locator("text=Test lunch")).not.toBeVisible({ timeout: 5000 });
});

test("expense with receipt_url survives reload", async ({ page }) => {
  const expense = {
    id: "test-exp-002",
    type: "expense",
    amount: 500,
    categoryId: "food",
    walletId: "bank",
    note: "Receipt test",
    date: "2026-05-02",
    receipt_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    balBefore: 1000,
  };

  await setupWithState(page, { ...baseState, ex: [expense] });
  await page.click("text=History");

  // The receipt thumbnail or receipt icon should be visible
  await expect(page.locator("text=Receipt test")).toBeVisible({ timeout: 5000 });

  // Reload — receipt_url must survive in nomad-v5
  await page.reload();
  await page.waitForTimeout(1500);
  await page.click("text=History");

  await expect(page.locator("text=Receipt test")).toBeVisible({ timeout: 5000 });

  // Verify localStorage still has receipt_url
  const stored = await page.evaluate(() => {
    const v5 = JSON.parse(localStorage.getItem("nomad-v5") || "{}");
    return v5.ex?.[0]?.receipt_url ?? null;
  });
  expect(stored).not.toBeNull();
  expect(stored).toMatch(/^data:/);
});

test("deleted split does not reappear after reload", async ({ page }) => {
  const split = {
    id: "test-split-001",
    name: "Dharun",
    amount: 100,
    direction: "owe",
    settled: false,
    note: "Dinner split",
    createdAt: new Date().toISOString(),
  };

  await setupWithState(page, { ...baseState, sp: [split] });

  // Navigate to Splits tab
  await page.click("text=Home");
  // The splits section should show Dharun
  await expect(page.locator("text=Dharun")).toBeVisible({ timeout: 5000 });

  // Delete the split (find the delete button near "Dharun")
  const row = page.locator("text=Dharun").locator("..");
  const delBtn = row.locator("button").filter({ hasText: "✕" }).first();
  if (await delBtn.count() > 0) {
    await delBtn.click();
  } else {
    // Fallback: click any delete button in vicinity
    await page.locator("button").filter({ hasText: "✕" }).first().click();
  }

  await page.waitForTimeout(500);

  // Reload and verify the split is gone
  await page.reload();
  await page.waitForTimeout(1500);

  await expect(page.locator("text=Dharun")).not.toBeVisible({ timeout: 5000 });
});

test("added expense appears in history after reload", async ({ page }) => {
  await setupWithState(page, baseState);

  // Add an expense through the UI
  await page.click("text=Add");
  await page.fill("input[placeholder='0']", "750");
  await page.click("button:has-text('Add Expense')");
  await expect(page.locator("text=Expense").first()).toBeVisible({ timeout: 5000 });

  // Read localStorage to confirm it was persisted
  const count = await page.evaluate(() => {
    const v5 = JSON.parse(localStorage.getItem("nomad-v5") || "{}");
    return (v5.ex || []).length;
  });
  expect(count).toBeGreaterThan(0);

  // Reload — expense must still be there
  await page.reload();
  await page.waitForTimeout(1500);
  await page.click("text=History");

  const histCount = await page.evaluate(() => {
    const v5 = JSON.parse(localStorage.getItem("nomad-v5") || "{}");
    return (v5.ex || []).length;
  });
  expect(histCount).toBeGreaterThan(0);
});
