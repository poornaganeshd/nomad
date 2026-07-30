import { test, expect } from "@playwright/test";
import { gotoLocal, makeExpense } from "./helpers.js";

test("history tab shows seeded transactions", async ({ page }) => {
  await gotoLocal(page, { expenses: [makeExpense({ note: "Groceries" })] });
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.getByText("Groceries")).toBeVisible({ timeout: 5000 });
});

test("search with no match names the query it could not find", async ({ page }) => {
  await gotoLocal(page, { expenses: [makeExpense({ note: "Groceries" })] });
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.locator("input[placeholder*='Search']").fill("zzznotfound");
  // A search that finds nothing says so in its own terms — the generic
  // "No results match your filters." is now reserved for the filter panel,
  // where it isn't misleading about what was actually looked at.
  await expect(page.getByText("No match for “zzznotfound”")).toBeVisible({ timeout: 5000 });
  await expect(page.getByText(/Searched notes, amounts, categories/)).toBeVisible();
});

test("filter panel reveals type buttons", async ({ page }) => {
  await gotoLocal(page, { expenses: [makeExpense({ note: "Groceries" })] });
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await expect(page.getByRole("button", { name: "Expense", exact: true })).toBeVisible();
});
