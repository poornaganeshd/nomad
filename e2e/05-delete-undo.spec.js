import { test, expect } from "@playwright/test";
import { gotoLocal, dismissBanner, makeExpense } from "./helpers.js";

test("delete transaction shows undo toast", async ({ page }) => {
  await gotoLocal(page, { expenses: [makeExpense({ note: "Delete me" })] });
  await page.getByRole("button", { name: "History", exact: true }).click();
  await dismissBanner(page);
  await page.getByRole("button", { name: "✕", exact: true }).click();
  await expect(page.getByText("Expense deleted")).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole("button", { name: "UNDO", exact: true })).toBeVisible();
});

test("undo restores the deleted transaction", async ({ page }) => {
  await gotoLocal(page, { expenses: [makeExpense({ note: "Bring me back" })] });
  await page.getByRole("button", { name: "History", exact: true }).click();
  await dismissBanner(page);
  await expect(page.getByText("Bring me back")).toBeVisible();
  await page.getByRole("button", { name: "✕", exact: true }).click();
  await expect(page.getByText("Bring me back")).toHaveCount(0);
  await page.getByRole("button", { name: "UNDO", exact: true }).click();
  await expect(page.getByText("Bring me back")).toBeVisible({ timeout: 5000 });
});
