import { test, expect } from "@playwright/test";
import { gotoLocal, readBackup, funded } from "./helpers.js";

test("add expense flow persists to local backup", async ({ page }) => {
  // Fund the bank wallet — addE() rejects an expense above the wallet balance.
  await gotoLocal(page, funded());
  await page.getByRole("button", { name: "Add", exact: true }).click();
  // Expense is the default segment — fill amount and submit
  await page.locator("input[placeholder='0']").first().fill("500");
  // Submit button text gains a "· ₹500.00" suffix once an amount is entered, so
  // match by substring (it's the only "Add Expense" button on the add page).
  await page.getByRole("button", { name: "Add Expense" }).click();
  await expect
    .poll(async () => (await readBackup(page)).expenses?.length ?? 0)
    .toBeGreaterThan(0);
});

test("add income flow persists to local backup", async ({ page }) => {
  await gotoLocal(page);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  // Switch to the Income segment, then fill and submit
  await page.getByRole("button", { name: "Income", exact: true }).click();
  await page.locator("input[placeholder='0']").first().fill("10000");
  await page.getByRole("button", { name: "Add Income" }).click();
  await expect
    .poll(async () => (await readBackup(page)).incomes?.length ?? 0)
    .toBeGreaterThan(0);
});
