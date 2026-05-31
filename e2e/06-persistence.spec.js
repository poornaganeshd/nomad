/**
 * Persistence tests — verify add/delete survive a full page reload.
 *
 * In local-only mode (no Supabase creds) the app reads and writes the `nomad-v5`
 * localStorage backup and never touches the network, so no request mocking is
 * needed. The backup write is debounced (~800ms), so we poll the backup before
 * reloading rather than using a fixed timeout.
 */
import { test, expect } from "@playwright/test";
import { gotoLocal, dismissBanner, readBackup, makeExpense, funded } from "./helpers.js";

async function reloadAndWait(page) {
  await page.reload();
  await expect(page.getByRole("button", { name: "Add", exact: true })).toBeVisible({ timeout: 15000 });
}

test("deleted expense does not reappear after reload", async ({ page }) => {
  await gotoLocal(page, { expenses: [makeExpense({ note: "Test lunch" })] });
  await page.getByRole("button", { name: "History", exact: true }).click();
  await dismissBanner(page);
  await expect(page.getByText("Test lunch")).toBeVisible({ timeout: 5000 });

  await page.getByRole("button", { name: "✕", exact: true }).click();
  // Wait until the delete is flushed to the local backup before reloading
  await expect.poll(async () => (await readBackup(page)).expenses?.length ?? 0).toBe(0);

  await reloadAndWait(page);
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.getByText("Test lunch")).toHaveCount(0);
});

test("expense with receipt_url survives reload", async ({ page }) => {
  const receipt =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  await gotoLocal(page, { expenses: [makeExpense({ note: "Receipt test", receipt_url: receipt })] });
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.getByText("Receipt test")).toBeVisible({ timeout: 5000 });

  await reloadAndWait(page);
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.getByText("Receipt test")).toBeVisible({ timeout: 5000 });

  const stored = (await readBackup(page)).expenses?.[0]?.receipt_url ?? null;
  expect(stored).toMatch(/^data:/);
});

test("seeded split survives reload round-trip", async ({ page }) => {
  const split = {
    id: "e2e-split-001",
    name: "Dharun",
    amount: 100,
    direction: "owe",
    settled: false,
    note: "Dinner split",
    date: "2026-05-01",
    createdAt: new Date().toISOString(),
  };
  await gotoLocal(page, { splits: [split] });

  await reloadAndWait(page);
  const splits = (await readBackup(page)).splits ?? [];
  expect(splits.map((s) => s.id)).toContain("e2e-split-001");
});

test("added expense survives reload", async ({ page }) => {
  // Fund the bank wallet — addE() rejects an expense above the wallet balance.
  await gotoLocal(page, funded());
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.locator("input[placeholder='0']").first().fill("750");
  await page.getByRole("button", { name: "Add Expense" }).click();
  await expect.poll(async () => (await readBackup(page)).expenses?.length ?? 0).toBeGreaterThan(0);

  await reloadAndWait(page);
  const count = (await readBackup(page)).expenses?.length ?? 0;
  expect(count).toBeGreaterThan(0);
});
