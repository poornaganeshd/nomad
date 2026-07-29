import { test, expect } from "@playwright/test";
import { gotoLocal, dismissBanner, readBackup } from "./helpers.js";

// Deleting a settlement and then hitting UNDO used to mark the linked IOU
// `settled: true` unconditionally. For a PARTIAL payment (₹240 against a ₹300
// IOU) that closed the whole debt — the ₹60 you never paid simply vanished from
// the reminders, the IOU wallet and the write-off ledger. Undo must put the
// split back exactly as it was, not "as if fully paid".

const today = () => new Date().toISOString().slice(0, 10);

// Only the settlement renders in History (splits aren't history rows), so the
// single ✕ on the page is unambiguously this row's delete button.
const seed = {
  splits: [{ id: "e2e-iou", name: "Rakesh", amount: 300, direction: "owe", settled: false, date: today() }],
  settlements: [{ id: "e2e-stl", type: "settlement", splitId: "e2e-iou", splitName: "Rakesh", amount: 240, direction: "owe", walletId: "bank", date: today() }],
};

const splitById = (backup, id) => backup.splits?.find((s) => s.id === id);
const stlCount = async (page) => (await readBackup(page)).settlements?.length ?? 0;

// The nomad-v5 backup is written on an 800ms debounce, so asserting straight
// after a click reads the PREVIOUS state. Step through both real transitions —
// settlement gone, then settlement back — and only then inspect the split.
async function deleteThenUndo(page) {
  await page.getByRole("button", { name: "History", exact: true }).click();
  await dismissBanner(page);
  await expect(page.getByText("Paid Rakesh")).toBeVisible();

  await page.getByRole("button", { name: "✕", exact: true }).click();
  await expect.poll(() => stlCount(page), { timeout: 5000 }).toBe(0);

  await page.getByRole("button", { name: "UNDO", exact: true }).click();
  await expect.poll(() => stlCount(page), { timeout: 5000 }).toBe(1);
}

test("undoing a deleted PARTIAL settlement leaves the IOU open", async ({ page }) => {
  await gotoLocal(page, seed);
  await deleteThenUndo(page);

  const backup = await readBackup(page);
  // The payment is back...
  expect(backup.settlements[0].amount).toBe(240);
  // ...and the ₹60 tail is still owed.
  expect(splitById(backup, "e2e-iou").settled).toBeFalsy();
  expect(splitById(backup, "e2e-iou").skipped).toBeFalsy();
});

test("undoing a deleted FULL settlement restores the settled IOU", async ({ page }) => {
  await gotoLocal(page, {
    ...seed,
    splits: [{ ...seed.splits[0], settled: true }],
    settlements: [{ ...seed.settlements[0], amount: 300 }],
  });
  await deleteThenUndo(page);

  const backup = await readBackup(page);
  expect(backup.settlements[0].amount).toBe(300);
  expect(splitById(backup, "e2e-iou").settled).toBe(true);
});
