import { test, expect } from "@playwright/test";
import { gotoLocal, dismissBanner, makeExpense, funded, readBackup } from "./helpers.js";

const now = new Date();
const localIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayIso = localIso(now);
const monthsBack = (n) => localIso(new Date(now.getFullYear(), now.getMonth() - n, 1));

// An electricity bill is an ESTIMATE: "Paid" used to book exactly the stored
// ₹2,000 whatever the bill actually said, leaving a wrong expense to find and
// edit in History.
test("a bill can be marked paid at the amount actually paid", async ({ page }) => {
  await gotoLocal(page, {
    ...funded(),
    expenses: [makeExpense({ date: todayIso })],
    recurring: [{ id: "r1", name: "Electricity", amount: 2000, categoryId: "utilities", walletId: "bank", frequency: "monthly", dayOfMonth: now.getDate(), startDate: monthsBack(3), active: true }],
  });
  await dismissBanner(page);

  await page.getByRole("button", { name: "✓ Paid", exact: true }).click();
  const amount = page.getByRole("textbox", { name: "Amount paid" });
  await expect(amount).toHaveValue("2000");
  await amount.fill("1,840.50");
  await page.getByRole("button", { name: "✓ Confirm paid", exact: true }).click();
  await expect(page.getByText(/Electricity paid from Bank — ₹1,840\.50/)).toBeVisible();

  await expect.poll(async () => {
    const b = await readBackup(page);
    return (b.expenses || []).filter(e => (e.note || "").startsWith("Electricity")).map(e => e.amount);
  }, { timeout: 5000 }).toEqual([1840.5]);
  // The schedule itself keeps its estimate for next month.
  const b = await readBackup(page);
  expect(b.recurring[0].amount).toBe(2000);
});

test("an empty amount is refused rather than booked as ₹0", async ({ page }) => {
  await gotoLocal(page, {
    ...funded(),
    expenses: [makeExpense({ date: todayIso })],
    recurring: [{ id: "r1", name: "Phone", amount: 499, categoryId: "recharge", walletId: "bank", frequency: "monthly", dayOfMonth: now.getDate(), startDate: monthsBack(3), active: true }],
  });
  await dismissBanner(page);
  await page.getByRole("button", { name: "✓ Paid", exact: true }).click();
  await page.getByRole("textbox", { name: "Amount paid" }).fill("0");
  await page.getByRole("button", { name: "✓ Confirm paid", exact: true }).click();
  await expect(page.getByText("Enter the amount paid")).toBeVisible();
  await expect(page.getByText(/Phone (is )?due/i).first()).toBeVisible();
});

// Deleting a category in use was a single tap with no undo.
test("deleting a category that transactions use asks first", async ({ page }) => {
  await gotoLocal(page, { ...funded(), expenses: [makeExpense({ categoryId: "food", date: todayIso })] });
  await dismissBanner(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  let asked = null;
  page.once("dialog", (d) => { asked = d.message(); d.dismiss(); });
  await page.getByRole("button", { name: "Delete Food & Drinks" }).click();
  expect(asked).toMatch(/1 transaction will keep its amount but lose this category/);
  await expect(page.getByRole("button", { name: "Delete Food & Drinks" })).toBeVisible();
});
