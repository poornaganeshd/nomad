import { test, expect } from "@playwright/test";
import { seedDemoMode } from "./helpers.js";

test("history tab shows transactions", async ({ page }) => {
  await seedDemoMode(page);
  await page.click("text=History");
  // Demo data has transactions
  await expect(page.locator("[style*='marginBottom: 10']").first()).toBeVisible({ timeout: 5000 });
});

test("search filters transactions", async ({ page }) => {
  await seedDemoMode(page);
  await page.click("text=History");
  // Type in search box
  await page.fill("input[placeholder*='Search']", "zzznotfound");
  await expect(page.locator("text=No results match your filters.")).toBeVisible({ timeout: 3000 });
});

test("filter panel toggles", async ({ page }) => {
  await seedDemoMode(page);
  await page.click("text=History");
  await page.click("button:has-text('Filter')");
  // Type buttons should appear
  await expect(page.locator("button:has-text('Expense')").first()).toBeVisible();
});
