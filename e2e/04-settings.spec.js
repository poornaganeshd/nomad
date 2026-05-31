import { test, expect } from "@playwright/test";
import { gotoLocal, readBackup, makeExpense } from "./helpers.js";

// Seed one expense so the empty-dashboard welcome card (which renders its OWN
// "Settings" button) is suppressed — otherwise the nav "Settings" button
// collides with it under Playwright strict mode.
const seeded = { expenses: [makeExpense()] };

test("settings tab shows core controls", async ({ page }) => {
  await gotoLocal(page, seeded);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByText("Dark Mode", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download CSV", exact: true })).toBeVisible();
});

test("dark mode toggle flips persisted theme", async ({ page }) => {
  await gotoLocal(page, seeded);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const before = (await readBackup(page)).darkMode ?? false;
  // The toggle pill is the second child of the Dark Mode card (sibling of the label block)
  await page.getByText("Dark Mode", { exact: true }).locator("xpath=../../div[2]").click();
  await expect.poll(async () => (await readBackup(page)).darkMode ?? false).toBe(!before);
});

test("wallet manager expands and shows add control", async ({ page }) => {
  await gotoLocal(page, seeded);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByText("Wallets", { exact: true }).click();
  await expect(page.getByRole("button", { name: "+ Add Wallet", exact: true })).toBeVisible();
});
