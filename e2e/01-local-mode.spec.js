import { test, expect } from "@playwright/test";
import { gotoLocal } from "./helpers.js";

test("local-only mode boots straight into the finance app", async ({ page }) => {
  await gotoLocal(page);
  // Dashboard total-balance card + bottom-nav Add button confirm the app rendered
  await expect(page.getByText("Total Balance")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add", exact: true })).toBeVisible();
});

test("local-only banner nudges to add credentials", async ({ page }) => {
  await gotoLocal(page);
  await expect(page.getByText("Local-only mode", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Setup", exact: true })).toBeVisible();
});
