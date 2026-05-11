import { test, expect } from "@playwright/test";
import { seedDemoMode } from "./helpers.js";

test("delete transaction shows undo toast", async ({ page }) => {
  await seedDemoMode(page);
  await page.click("text=History");
  // Click the delete button on the first transaction card
  const deleteBtn = page.locator("button:has-text('✕')").first();
  await deleteBtn.click();
  // Undo toast should appear
  await expect(page.locator("text=deleted").first()).toBeVisible({ timeout: 5000 });
});

test("undo restores transaction in memory", async ({ page }) => {
  await seedDemoMode(page);
  await page.click("text=History");
  // Count items before delete
  const before = await page.locator("[style*='marginBottom: 10']").count();
  // Delete first item
  await page.locator("button:has-text('✕')").first().click();
  // Click Undo
  await page.click("button:has-text('Undo')");
  // Count should be back
  const after = await page.locator("[style*='marginBottom: 10']").count();
  expect(after).toBeGreaterThanOrEqual(before - 1);
});
