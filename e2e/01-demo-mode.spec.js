import { test, expect } from "@playwright/test";
import { seedDemoMode } from "./helpers.js";

test("demo mode loads with sample data", async ({ page }) => {
  await seedDemoMode(page);
  await expect(page.locator("text=Demo Mode")).toBeVisible();
  // Dashboard shows wallet balances
  await expect(page.locator("text=Bank").first()).toBeVisible();
});

test("exit demo mode shows credential setup", async ({ page }) => {
  await seedDemoMode(page);
  await page.click("text=Exit");
  await page.evaluate(() => localStorage.removeItem("nomad-demo-mode"));
  await page.reload();
  // Should show landing / credential setup
  await expect(page.locator("text=Connect Backend").first()).toBeVisible();
});
