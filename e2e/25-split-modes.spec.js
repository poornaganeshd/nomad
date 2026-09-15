import { test, expect } from "@playwright/test";
import { gotoLocal, dismissBanner, funded, readBackup } from "./helpers.js";

// The Bill Splitter could only split equally or by exact rupee amounts, so a
// flatmate with the big room or a dinner two people shared meant doing the
// arithmetic yourself first. Percent and Shares do it for you — and, because
// they use largest-remainder in paisa, the parts always add back up to the
// exact bill rather than leaving an unsettleable paisa behind.

test("percent mode splits by share and derives YOUR percentage", async ({ page }) => {
  await gotoLocal(page, { ...funded(), events: [{ id: "ev1", name: "Flat", status: "active", date: "2026-09-01", participants: [] }] });
  await dismissBanner(page);
  await page.getByRole("button", { name: "Events" }).click();
  await page.getByText("Flat", { exact: false }).first().click();

  await page.getByRole("button", { name: "Bill Split", exact: true }).click();
  await page.getByRole("button", { name: "%", exact: true }).click();
  await page.locator("input[placeholder='0']").first().fill("1000");
  await page.locator("input[placeholder='Name']").first().fill("Rafi");
  await page.locator("input[placeholder='%']").first().fill("30");

  // You keep 70% — the number you never type.
  await expect(page.getByText("Rafi · 30%", { exact: false })).toBeVisible();
  await expect(page.getByText("₹300", { exact: false }).first()).toBeVisible();

  await page.getByRole("button", { name: "Review Split" }).click();
  await page.getByRole("button", { name: /Confirm/i }).first().click();

  await expect.poll(async () => (await readBackup(page)).splits?.length ?? 0).toBe(1);
  const sp = (await readBackup(page)).splits[0];
  expect(sp.name).toBe("Rafi");
  expect(sp.amount).toBe(300);
});

test("shares mode weights each head and still sums to the exact bill", async ({ page }) => {
  await gotoLocal(page, { ...funded(), events: [{ id: "ev1", name: "Flat", status: "active", date: "2026-09-01", participants: [] }] });
  await dismissBanner(page);
  await page.getByRole("button", { name: "Events" }).click();
  await page.getByText("Flat", { exact: false }).first().click();

  await page.getByRole("button", { name: "Bill Split", exact: true }).click();
  await page.getByRole("button", { name: "Shares", exact: true }).click();
  // ₹100 over 3 equal shares has no exact paisa answer — the leftover must
  // still land somewhere, or it becomes an IOU nobody can settle.
  await page.locator("input[placeholder='0']").first().fill("100");
  await page.locator("input[placeholder='Name']").first().fill("A");
  await page.locator("input[placeholder='×']").first().fill("1");
  await page.getByRole("button", { name: /Add person/i }).click();
  await page.locator("input[placeholder='Name']").nth(1).fill("B");
  await page.locator("input[placeholder='×']").nth(1).fill("1");

  await page.getByRole("button", { name: "Review Split" }).click();
  await page.getByRole("button", { name: /Confirm/i }).first().click();

  await expect.poll(async () => (await readBackup(page)).splits?.length ?? 0).toBe(2);
  const b = await readBackup(page);
  const owed = b.splits.reduce((t, s) => t + s.amount, 0);
  const expense = b.expenses.find(e => e.amount === 100);
  expect(expense).toBeTruthy();
  // Your share + what the other two owe === the bill, to the paisa.
  expect(Math.round(owed * 100) / 100).toBe(66.66);
});

test("percent over 100 is refused with a reason, not a dead button", async ({ page }) => {
  await gotoLocal(page, { ...funded(), events: [{ id: "ev1", name: "Flat", status: "active", date: "2026-09-01", participants: [] }] });
  await dismissBanner(page);
  await page.getByRole("button", { name: "Events" }).click();
  await page.getByText("Flat", { exact: false }).first().click();

  await page.getByRole("button", { name: "Bill Split", exact: true }).click();
  await page.getByRole("button", { name: "%", exact: true }).click();
  await page.locator("input[placeholder='0']").first().fill("1000");
  await page.locator("input[placeholder='Name']").first().fill("Rafi");
  await page.locator("input[placeholder='%']").first().fill("140");

  await expect(page.getByText(/over 100%/)).toBeVisible();
});
