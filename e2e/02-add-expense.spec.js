import { test, expect } from "@playwright/test";
import { seedDemoMode } from "./helpers.js";

test("add expense flow", async ({ page }) => {
  await seedDemoMode(page);
  // Navigate to Add tab
  await page.click("text=Add");
  // Expense tab is default — fill amount
  await page.fill("input[placeholder='0']", "500");
  // Submit
  await page.click("button:has-text('Add Expense')");
  // Toast should appear
  await expect(page.locator("text=Expense")).toBeVisible({ timeout: 5000 });
});

test("add income flow", async ({ page }) => {
  await seedDemoMode(page);
  await page.click("text=Add");
  // Switch to income tab
  await page.click("text=Income");
  await page.fill("input[placeholder='0']", "10000");
  await page.click("button:has-text('Add Income')");
  await expect(page.locator("text=Income")).toBeVisible({ timeout: 5000 });
});
