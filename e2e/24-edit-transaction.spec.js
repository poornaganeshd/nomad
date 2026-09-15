import { test, expect } from "@playwright/test";
import { gotoLocal, dismissBanner, makeExpense, funded, readBackup } from "./helpers.js";

const iso = (d) => d.toISOString().slice(0, 10);
const today = new Date();

// History used to be delete-only — fixing a typo'd amount meant deleting the
// row and typing it again, which loses its created_at and teaches the category
// model nothing.
test("edit an expense's amount, category and note from History", async ({ page }) => {
  await gotoLocal(page, { ...funded(), expenses: [makeExpense({ id: "e1", amount: 250, note: "Cofee", categoryId: "food" })] });
  await dismissBanner(page);
  await page.getByRole("button", { name: "History" }).click();

  await page.getByRole("button", { name: "Edit" }).first().click();
  await expect(page.getByText("Edit expense", { exact: true })).toBeVisible();

  await page.locator("input[type='number']").first().fill("420");
  await page.locator("input[placeholder='Optional']").fill("Coffee");
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect.poll(async () => (await readBackup(page)).expenses?.[0]?.amount).toBe(420);
  const row = (await readBackup(page)).expenses[0];
  expect(row.note).toBe("Coffee");
  expect(row.id).toBe("e1"); // same row — not a delete + re-add
});

test("an edit that would overdraw the wallet is refused and keeps the sheet open", async ({ page }) => {
  await gotoLocal(page, {
    walletStartBal: { bank: 1000, cash: 0, upi_lite: 0 },
    expenses: [makeExpense({ id: "e1", amount: 200, walletId: "bank" })],
  });
  await dismissBanner(page);
  await page.getByRole("button", { name: "History" }).click();
  await page.getByRole("button", { name: "Edit" }).first().click();

  // Bank STARTED at 1000 and this 200 is already spent, so the live balance is
  // 800 and the most this row can grow to is 1000.
  await page.locator("input[type='number']").first().fill("1100");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(/Not enough in Bank/)).toBeVisible();
  await expect(page.getByText("Edit expense", { exact: true })).toBeVisible(); // still open
  expect((await readBackup(page)).expenses[0].amount).toBe(200);

  // The row's OWN spend is not double-counted: 1000 spends the wallet to zero
  // and goes through. Checking 1000 against the live 800 would have refused it.
  await page.locator("input[type='number']").first().fill("1000");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(async () => (await readBackup(page)).expenses?.[0]?.amount).toBe(1000);
});

test("a split expense sends you to its event instead of editing in place", async ({ page }) => {
  const gid = "grp-1";
  await gotoLocal(page, {
    ...funded(),
    expenses: [makeExpense({ id: "e1", amount: 600, note: "Dinner", groupId: gid })],
    splits: [{ id: "sp1", name: "Rafi", amount: 200, direction: "owed", settled: false, groupId: gid, date: iso(today) }],
  });
  await dismissBanner(page);
  await page.getByRole("button", { name: "History" }).click();
  await page.getByRole("button", { name: "Edit" }).first().click();

  await expect(page.getByText(/split with 1 person/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
});

test("a transfer is editable on both ends", async ({ page }) => {
  await gotoLocal(page, {
    walletStartBal: { bank: 5000, cash: 100, upi_lite: 0 },
    transfers: [{ id: "t1", type: "transfer", amount: 300, fromWallet: "bank", toWallet: "cash", date: iso(today) }],
  });
  await dismissBanner(page);
  await page.getByRole("button", { name: "History" }).click();
  await page.getByRole("button", { name: "Edit" }).first().click();
  await expect(page.getByText("Edit transfer", { exact: true })).toBeVisible();

  await page.locator("input[type='number']").first().fill("450");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(async () => (await readBackup(page)).transfers?.[0]?.amount).toBe(450);
});
