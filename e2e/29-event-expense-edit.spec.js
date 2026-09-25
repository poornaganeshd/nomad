import { test, expect } from "@playwright/test";
import { gotoLocal, readBackup } from "./helpers.js";

// Editing an event expense deleted and re-created its IOUs on EVERY save, and
// took their settlements with them. Fixing a typo in the note therefore erased
// the repayment Rakesh had already made: the ₹500 left the bank balance and the
// IOU came back as unpaid.

const today = () => new Date().toISOString().slice(0, 10);
const state = () => ({
  events: [{ id: "ev", name: "Goa Trip", type: "group", participants: ["Rakesh"], status: "active", date: today(), icon: "travel" }],
  expenses: [{ id: "x1", type: "expense", amount: 1000, categoryId: "food", walletId: "bank", eventId: "ev", groupId: "x1", splitWith: { You: 500, Rakesh: 500 }, note: "Dinnr", date: today(), balBefore: 5000 }],
  splits: [{ id: "iou", name: "Rakesh", amount: 500, direction: "owed", settled: true, eventId: "ev", groupId: "x1", note: "Auto: Dinnr", date: today() }],
  settlements: [{ id: "st", splitId: "iou", name: "Rakesh", amount: 500, direction: "owed", walletId: "bank", eventId: "ev", groupId: "x1", date: today() }],
  incomes: [{ id: "inc", type: "income", amount: 5000, walletId: "bank", sourceId: "allowance", date: today() }],
});

async function openEdit(page) {
  await page.getByRole("button", { name: "Events", exact: true }).click();
  await page.getByText("Goa Trip").first().click();
  await page.getByTitle("Edit expense").first().click();
}

test("fixing an event expense's note keeps its IOU and the repayment against it", async ({ page }) => {
  await gotoLocal(page, state());
  await openEdit(page);
  await page.locator('input[value="Dinnr"]').fill("Dinner");
  await page.getByRole("button", { name: /Save/ }).last().click();

  await expect.poll(async () => (await readBackup(page)).expenses?.[0]?.note).toBe("Dinner");
  const b = await readBackup(page);
  expect(b.splits.map((s) => s.id)).toEqual(["iou"]);
  expect(b.splits[0].settled).toBe(true);
  expect(b.settlements.map((s) => s.id)).toEqual(["st"]);
});

test("changing the split of a repaid expense is refused instead of erasing the payment", async ({ page }) => {
  await gotoLocal(page, state());
  await openEdit(page);
  await page.locator('input[value="1000"]').fill("1200");
  await page.getByRole("button", { name: /Save/ }).last().click();

  await expect(page.getByText(/Payments are recorded against this expense/)).toBeVisible();
  const b = await readBackup(page);
  expect(b.expenses[0].amount).toBe(1000);
  expect(b.settlements).toHaveLength(1);
});

test("an event expense edit cannot overdraw the wallet", async ({ page }) => {
  const s = state();
  s.splits[0].settled = false; s.settlements = [];
  await gotoLocal(page, s);
  await openEdit(page);
  await page.locator('input[value="1000"]').fill("90000");
  await page.getByRole("button", { name: /Save/ }).last().click();

  await expect(page.getByText(/Not enough in Bank/)).toBeVisible();
  expect((await readBackup(page)).expenses[0].amount).toBe(1000);
});

test("the New Event button clears the tab bar even under the local-only banner", async ({ page }) => {
  // The Events column was a fixed calc(100vh - 90px) tall, so every sticky
  // banner above it (the local-only nudge every new user sees) pushed its
  // bottom — and New Event — underneath the tab bar.
  await gotoLocal(page, state());
  await expect(page.getByText("Local-only mode", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Events", exact: true }).click();
  const btn = await page.getByRole("button", { name: /New Event/ }).boundingBox();
  const nav = await page.getByRole("button", { name: "History", exact: true }).boundingBox();
  expect(btn.y + btn.height).toBeLessThanOrEqual(nav.y);
});
