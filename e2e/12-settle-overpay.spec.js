import { test, expect } from "@playwright/test";
import { gotoLocal, readBackup } from "./helpers.js";

// Overpay / underpay settles through the real per-IOU Record modal (SettleM →
// settle() in App.jsx): excess lands on the settlement row and offsets the
// write-off ledger; a suspicious surplus needs a second tap; an accepted
// underpay writes off the remainder. UI wiring regressions fail here, not
// just the pure-math mirrors in src/__tests__.

const today = () => new Date().toISOString().slice(0, 10);
const jai = () => ({ id: "e2e-jai", name: "Jai akash", amount: 11.66, direction: "owed", settled: false, note: "Dosa batter", date: today() });
const writtenOff = () => ({ id: "e2e-old", name: "Rakesh", amount: 5, direction: "owed", settled: true, skipped: true, date: today() });

async function openRecordModal(page) {
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "IOU · Splits", exact: true }).click();
  await page.getByRole("button", { name: /Open Jai akash/ }).click();
  await page.getByRole("button", { name: "Record", exact: true }).click();
}

// The modal renders last in the DOM, so its amount field is the last spinbutton.
const amountField = (page) => page.locator('input[type="number"]').last();

test("overpay ₹12 on ₹11.66: wallet gets 12, excess 0.34 offsets write-offs", async ({ page }) => {
  await gotoLocal(page, { splits: [jai(), writtenOff()] });
  await openRecordModal(page);

  await amountField(page).fill("12");
  await expect(page.getByText(/over the .*11\.66.* due/)).toBeVisible();
  await page.getByRole("button", { name: /Received/ }).click();

  await expect.poll(async () => (await readBackup(page)).settlements?.[0]?.excess).toBe(0.34);
  const backup = await readBackup(page);
  expect(backup.settlements[0].amount).toBe(12);
  expect(backup.splits.find((s) => s.id === "e2e-jai").settled).toBe(true);

  // Write-off card: ₹5 written off earlier, minus the recovered 34p.
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByText(/4\.66/).first()).toBeVisible();
  await expect(page.getByText(/0\.34 recovered/)).toBeVisible();
});

test("fat-finger overpay (120 for 12) needs a second, armed tap", async ({ page }) => {
  await gotoLocal(page, { splits: [jai()] });
  await openRecordModal(page);

  await amountField(page).fill("120");
  await page.getByRole("button", { name: /Received/ }).click();

  // First tap arms instead of committing — nothing written yet.
  await expect(page.getByRole("button", { name: /Tap again/ })).toBeVisible();
  expect((await readBackup(page)).settlements ?? []).toHaveLength(0);

  await page.getByRole("button", { name: /Tap again/ }).click();
  await expect.poll(async () => (await readBackup(page)).settlements?.length ?? 0).toBe(1);
  const stl = (await readBackup(page)).settlements[0];
  expect(stl.amount).toBe(120);
  expect(stl.excess).toBe(108.34);
});

test("underpay accepted as full & final writes off the remainder", async ({ page }) => {
  await gotoLocal(page, { splits: [jai()] });
  await openRecordModal(page);

  await amountField(page).fill("11.5");
  await page.getByRole("button", { name: /Write off the remaining/ }).click();
  await expect(page.getByText(/written off — IOU closes for good/)).toBeVisible();
  await page.getByRole("button", { name: /Received/ }).click();

  await expect
    .poll(async () => (await readBackup(page)).splits?.find((s) => s.id === "e2e-jai")?.skipped)
    .toBe(true);
  const backup = await readBackup(page);
  expect(backup.splits.find((s) => s.id === "e2e-jai").settled).toBe(true);
  expect(backup.settlements[0].amount).toBe(11.5);
  expect(backup.settlements[0].excess ?? null).toBeNull();

  // 16p remainder surfaces as a write-off on Home.
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByText(/0\.16/).first()).toBeVisible();
});
