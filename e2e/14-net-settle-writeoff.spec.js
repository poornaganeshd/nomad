import { test, expect } from "@playwright/test";
import { gotoLocal, readBackup } from "./helpers.js";

// Partial NET settle + "write off the rest" (NetSheet → settleNet's
// forgiveRemainder in App.jsx). Paying part of a person's net used to strand
// the unpaid tail: the only way to close it was skipping every leftover IOU
// one at a time, so the person kept nagging as if nothing had been paid.

const today = () => new Date().toISOString().slice(0, 10);
const oweRakesh = (id, amount) => ({ id, name: "Rakesh", amount, direction: "owe", settled: false, date: today() });

// Fund a wallet the honest way — wBal is derived from transactions, so an
// income row is what actually gives the sheet something to pay from.
const bankFloat = () => ({ id: "e2e-inc", type: "income", amount: 5000, walletId: "bank", sourceId: "allowance", date: today() });

async function openNetSheet(page) {
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "IOU · Splits", exact: true }).click();
  await page.getByRole("button", { name: /Open Rakesh/ }).click();
  await page.getByRole("button", { name: /Settle up/ }).first().click();
  // Default pay-from is UPI Lite (wallets[0]) which has no balance here.
  await page.getByRole("button", { name: "Bank", exact: true }).last().click();
}

const amountField = (page) => page.locator('input[type="number"]').last();
const splitById = (backup, id) => backup.splits?.find((s) => s.id === id);

test("partial net settle leaves the rest pending by default", async ({ page }) => {
  await gotoLocal(page, { splits: [oweRakesh("e2e-a", 300)], incomes: [bankFloat()] });
  await openNetSheet(page);

  await amountField(page).fill("240");
  await expect(page.getByRole("button", { name: /Write off the remaining/ })).toBeVisible();
  await page.getByRole("button", { name: /^Pay .*240/ }).click();

  await expect.poll(async () => (await readBackup(page)).settlements?.length ?? 0).toBe(1);
  const backup = await readBackup(page);
  expect(backup.settlements[0].amount).toBe(240);
  // Still owed: ₹60 outstanding, IOU untouched.
  expect(splitById(backup, "e2e-a").settled).toBeFalsy();
  expect(splitById(backup, "e2e-a").skipped).toBeFalsy();
});

test("ticking write-off closes the person and books the remainder", async ({ page }) => {
  await gotoLocal(page, { splits: [oweRakesh("e2e-a", 300)], incomes: [bankFloat()] });
  await openNetSheet(page);

  await amountField(page).fill("240");
  await page.getByRole("button", { name: /Write off the remaining/ }).click();
  await page.getByRole("button", { name: /& close/ }).click();

  await expect.poll(async () => splitById(await readBackup(page), "e2e-a")?.skipped).toBe(true);
  const backup = await readBackup(page);
  expect(backup.settlements[0].amount).toBe(240);
  expect(splitById(backup, "e2e-a").settled).toBe(true);

  // ₹60 lands in the write-off ledger on Home.
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByText(/60/).first()).toBeVisible();
});

test("write-off across several IOUs settles what was paid and forgives the tail", async ({ page }) => {
  await gotoLocal(page, {
    splits: [oweRakesh("e2e-a", 15), oweRakesh("e2e-b", 10), oweRakesh("e2e-c", 92.5)],
    incomes: [bankFloat()],
  });
  await openNetSheet(page);

  await amountField(page).fill("30");
  await page.getByRole("button", { name: /Write off the remaining/ }).click();
  await page.getByRole("button", { name: /& close/ }).click();

  await expect.poll(async () => splitById(await readBackup(page), "e2e-c")?.skipped).toBe(true);
  const backup = await readBackup(page);
  // Fully covered IOUs are settled, NOT written off.
  expect(splitById(backup, "e2e-a")).toMatchObject({ settled: true });
  expect(splitById(backup, "e2e-a").skipped).toBeFalsy();
  expect(splitById(backup, "e2e-b").skipped).toBeFalsy();
  // The partially-paid one carries the write-off.
  expect(splitById(backup, "e2e-c")).toMatchObject({ settled: true, skipped: true });
  expect(backup.settlements.reduce((t, s) => t + s.amount, 0)).toBe(30);
  // Nothing left pending — the person is closed.
  expect(backup.splits.filter((s) => !s.settled && !s.skipped)).toHaveLength(0);
});
