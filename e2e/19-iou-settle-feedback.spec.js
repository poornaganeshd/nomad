import { test, expect } from "@playwright/test";
import { gotoLocal, readBackup } from "./helpers.js";

// Feedback around an IOU settle: the celebration, and what happens when a settle
// is REFUSED. All three regressions here were silent — nothing crashed, the app
// just told the user something untrue.

const today = () => new Date().toISOString().slice(0, 10);
const owed = (id, amount, name = "Rakesh") => ({ id, name, amount, direction: "owed", settled: false, date: today() });
const owe = (id, amount, name = "Rakesh") => ({ id, name, amount, direction: "owe", settled: false, date: today() });

const confetti = (page) => page.locator("[data-nm-confetti]");
const amountField = (page) => page.locator('input[type="number"]').last();

async function openWallet(page) {
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "IOU · Splits", exact: true }).click();
}

test("confetti fires once on a settle and never replays on navigation", async ({ page }) => {
  // Two IOUs so the person stays on the wallet's active list after one settles.
  await gotoLocal(page, { splits: [owed("e2e-a", 100), owed("e2e-b", 40)] });
  await openWallet(page);
  await page.getByRole("button", { name: /Open Rakesh/ }).click();

  await expect(confetti(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Record", exact: true }).first().click();
  await page.getByRole("button", { name: /^Received/ }).click();
  await expect(confetti(page)).toHaveCount(1);

  // It clears itself. The trigger used to stay set for the rest of the session.
  await expect(confetti(page)).toHaveCount(0, { timeout: 5000 });

  // `sheets` sits at a different child index in the home tree than in the person
  // tree, so React remounts Confetti on every switch between them. With a stuck
  // trigger that meant a burst on every back-tap, long after the settle.
  await page.getByRole("button", { name: "Back to wallet" }).click();
  await expect(page.getByRole("button", { name: /Open Rakesh/ })).toBeVisible();
  await expect(confetti(page)).toHaveCount(0);
  await page.getByRole("button", { name: /Open Rakesh/ }).click();
  await expect(confetti(page)).toHaveCount(0);
});

test("a partial payment is not celebrated — the IOU is still open", async ({ page }) => {
  await gotoLocal(page, { splits: [owed("e2e-a", 100)] });
  await openWallet(page);
  await page.getByRole("button", { name: /Open Rakesh/ }).click();
  await page.getByRole("button", { name: "Record", exact: true }).click();

  await amountField(page).fill("40");
  await expect(page.getByText(/will remain as pending IOU/)).toBeVisible();
  await page.getByRole("button", { name: /^Received/ }).click();

  await expect.poll(async () => (await readBackup(page)).settlements?.length ?? 0).toBe(1);
  await expect(confetti(page)).toHaveCount(0);
});

test("a refused settle keeps the sheet open with the entered amount intact", async ({ page }) => {
  // Paying ₹300 from UPI Lite (the default pay-from) with no balance anywhere:
  // settle() refuses. The sheet used to close anyway, throwing away the amount,
  // date and wallet — the only three things the user could change to fix it.
  await gotoLocal(page, { splits: [owe("e2e-a", 300)] });
  await openWallet(page);
  await page.getByRole("button", { name: /Open Rakesh/ }).click();
  await page.getByRole("button", { name: "Record", exact: true }).click();

  await page.getByRole("button", { name: /^Paid/ }).click();

  await expect(page.getByText(/Not enough/)).toBeVisible();
  await expect(page.getByText("PAY FROM")).toBeVisible();
  await expect(amountField(page)).toHaveValue("300");
  expect((await readBackup(page)).settlements ?? []).toHaveLength(0);
  await expect(confetti(page)).toHaveCount(0);
});

test("a settle overpay alone does not raise a Write-offs card", async ({ page }) => {
  // ₹0.34 of change coming back is an offset AGAINST write-offs, not one itself.
  // Gating the card on it too produced a "Write-offs" card reading ₹0, ₹0 and
  // "Net gain ₹0".
  await gotoLocal(page, { splits: [owed("e2e-jai", 11.66, "Jai akash")] });
  await openWallet(page);
  await page.getByRole("button", { name: /Open Jai akash/ }).click();
  await page.getByRole("button", { name: "Record", exact: true }).click();

  await amountField(page).fill("12");
  await page.getByRole("button", { name: /^Received/ }).click();
  await expect.poll(async () => (await readBackup(page)).settlements?.[0]?.excess).toBe(0.34);

  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByText("Write-offs")).toHaveCount(0);
});
