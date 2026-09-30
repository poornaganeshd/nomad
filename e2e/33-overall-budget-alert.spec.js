import { test, expect } from "@playwright/test";
import { gotoLocal, dismissBanner, makeExpense, funded } from "./helpers.js";

// The overall budget cap ("I'm allowed ₹1,000 this month, all in") had no alert
// of any kind — crossing it was silent unless you happened to open the card.

const now = new Date();
const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

test("crossing the overall cap says so, and the bell keeps saying so", async ({ page }) => {
  await gotoLocal(page, { ...funded(), expenses: [makeExpense({ amount: 700, date: todayIso, walletId: "bank" })] });
  await page.evaluate(() => localStorage.setItem("nomad-budget-cfg", JSON.stringify({ period: "monthly", total: 1000, rollover: false })));
  await page.reload();
  await expect(page.getByRole("button", { name: "Add", exact: true })).toBeVisible({ timeout: 15000 });
  await dismissBanner(page);

  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.locator("input[placeholder='0']").first().fill("400");
  await page.getByRole("button", { name: "Add Expense" }).click();
  await expect(page.getByText(/Overall budget exceeded — ₹1,100 of ₹1,000 this month/)).toBeVisible();

  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.getByRole("button", { name: /Notifications/i }).click();
  await expect(page.getByText("Overall budget exceeded", { exact: true })).toBeVisible();
});
