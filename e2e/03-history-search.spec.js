import { test, expect } from "@playwright/test";
import { gotoLocal, makeExpense } from "./helpers.js";

test("history tab shows seeded transactions", async ({ page }) => {
  await gotoLocal(page, { expenses: [makeExpense({ note: "Groceries" })] });
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.getByText("Groceries")).toBeVisible({ timeout: 5000 });
});

test("search with no match shows empty-filter message", async ({ page }) => {
  await gotoLocal(page, { expenses: [makeExpense({ note: "Groceries" })] });
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.locator("input[placeholder*='Search']").fill("zzznotfound");
  await expect(page.getByText("No results match your filters.")).toBeVisible({ timeout: 5000 });
});

test("filter panel reveals type buttons", async ({ page }) => {
  await gotoLocal(page, { expenses: [makeExpense({ note: "Groceries" })] });
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await expect(page.getByRole("button", { name: "Expense", exact: true })).toBeVisible();
});
