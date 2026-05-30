import { test, expect } from "@playwright/test";
import { seedDemoMode } from "./helpers.js";

test("settings tab opens", async ({ page }) => {
  await seedDemoMode(page);
  await page.click("text=Settings");
  await expect(page.locator("text=Dark Mode")).toBeVisible();
  await expect(page.locator("text=Export")).toBeVisible();
});

test("dark mode toggle works", async ({ page }) => {
  await seedDemoMode(page);
  await page.click("text=Settings");
  await page.click("text=Dark Mode");
  // Just assert the toggle didn't crash
  await expect(page.locator("text=Settings")).toBeVisible();
});

test("wallet manager opens", async ({ page }) => {
  await seedDemoMode(page);
  await page.click("text=Settings");
  await page.click("text=Wallets");
  await expect(page.locator("text=Add Wallet")).toBeVisible();
});
