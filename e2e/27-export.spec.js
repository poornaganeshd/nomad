import { test, expect } from "@playwright/test";
import { gotoLocal, dismissBanner, makeExpense, funded } from "./helpers.js";

// Export was a single flat CSV plus a JSON backup only NOMAD can read.
test("spreadsheet export downloads a workbook for the chosen period", async ({ page }) => {
  await gotoLocal(page, { ...funded(), expenses: [makeExpense({ amount: 250, note: "Lunch" })] });
  await dismissBanner(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Spreadsheet", exact: true }).click();
  const file = await dl;
  expect(file.suggestedFilename()).toMatch(/\.xls$/);
});

test("the period chips drive the filename", async ({ page }) => {
  await gotoLocal(page, { ...funded(), expenses: [makeExpense()] });
  await dismissBanner(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  await page.getByRole("button", { name: "All time", exact: true }).click();
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Spreadsheet", exact: true }).click();
  expect((await dl).suggestedFilename()).toBe("nomad_all_time.xls");
});

test("the statement opens a printable page rather than downloading a file", async ({ page, context }) => {
  await gotoLocal(page, { ...funded(), expenses: [makeExpense({ amount: 250, note: "Lunch" })] });
  await dismissBanner(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  const popup = context.waitForEvent("page");
  await page.getByRole("button", { name: "Statement / PDF", exact: true }).click();
  const win = await popup;
  await expect(win.locator("h1")).toHaveText("NOMAD statement");
  await expect(win.getByText("Money out")).toBeVisible();
  await expect(win.getByText("Lunch")).toBeVisible();
});
