import { test, expect } from "@playwright/test";
import { gotoLocal, readBackup } from "./helpers.js";

// The 1:1 IOU card-wallet lives in the Add tab's "IOU · Splits" segment. These
// flows exercise the real App handlers (onAdd → splits, onSettleNet →
// settlements) so a UI/wiring regression fails CI, not just the pure math.

async function openIou(page) {
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "IOU · Splits", exact: true }).click();
}

test("adding a 1:1 IOU persists to splits", async ({ page }) => {
  await gotoLocal(page);
  await openIou(page);
  await page.getByRole("button", { name: /New IOU/ }).click();
  await page.getByPlaceholder("Friend's name").fill("Rahul");
  await page.getByPlaceholder("₹ amount").fill("500");
  await page.getByRole("button", { name: "Add IOU", exact: true }).click();

  await expect.poll(async () => (await readBackup(page)).splits?.length ?? 0).toBeGreaterThan(0);
  await expect(page.getByText("Rahul").first()).toBeVisible();
});

test("settling a person nets to a settlement and marks the split settled", async ({ page }) => {
  const split = { id: "s1", name: "Meera", amount: 300, direction: "owed", settled: false, date: new Date().toISOString().slice(0, 10) };
  await gotoLocal(page, { splits: [split] });
  await openIou(page);

  // flat card list (the old swipe cascade is gone): one tap opens the person
  await page.getByRole("button", { name: /Open Meera/ }).click();
  // person detail → whole-person settle sheet
  await page.getByRole("button", { name: /Settle up/ }).click();
  await page.getByRole("button", { name: /Collect.*settle/ }).click();

  await expect.poll(async () => (await readBackup(page)).settlements?.length ?? 0).toBeGreaterThan(0);
  await expect
    .poll(async () => (await readBackup(page)).splits?.find(s => s.id === "s1")?.settled)
    .toBe(true);
});

test("the add form keeps focus + typed value across re-renders", async ({ page }) => {
  // Regression guard for the hoisted AddForm: typing must not remount the input.
  await gotoLocal(page);
  await openIou(page);
  await page.getByRole("button", { name: /New IOU/ }).click();
  const name = page.getByPlaceholder("Friend's name");
  await name.click();
  await name.pressSequentially("Ananya", { delay: 20 });
  await expect(name).toHaveValue("Ananya");
  await expect(name).toBeFocused();
});
