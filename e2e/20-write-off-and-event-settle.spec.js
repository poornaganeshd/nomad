import { test, expect } from "@playwright/test";
import { gotoLocal, readBackup } from "./helpers.js";

// Full write-off (amount 0) in the IOU wallet, and the event settle-up path.

const today = () => new Date().toISOString().slice(0, 10);
const owed = (id, amount, name = "Rakesh", extra = {}) => ({ id, name, amount, direction: "owed", settled: false, date: today(), ...extra });
const owe = (id, amount, name = "Rakesh", extra = {}) => ({ id, name, amount, direction: "owe", settled: false, date: today(), ...extra });
const bankFloat = () => ({ id: "e2e-inc", type: "income", amount: 5000, walletId: "bank", sourceId: "allowance", date: today() });

const amountField = (page) => page.locator('input[type="number"]').last();

async function openNetSheet(page, who = "Rakesh") {
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "IOU · Splits", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(`Open ${who}`) }).click();
  await page.getByRole("button", { name: /Settle up/ }).first().click();
}

test("amount 0 offers a full write-off and is inert until it is ticked", async ({ page }) => {
  await gotoLocal(page, { splits: [owed("e2e-a", 300)] });
  await openNetSheet(page);

  await amountField(page).fill("0");
  // Nothing moves, so there is no wallet to pick.
  await expect(page.getByText("Receive into")).toHaveCount(0);
  // A tap that wipes a debt is never one keystroke away.
  const confirm = page.getByRole("button", { name: /Enter an amount, or tick write-off/ });
  await expect(confirm).toBeVisible();
  await expect(confirm).toBeDisabled();

  await page.getByRole("button", { name: /Write off the whole/ }).click();
  await page.getByRole("button", { name: /Write off .*300 & close/ }).click();

  await expect.poll(async () => (await readBackup(page)).splits?.[0]?.skipped).toBe(true);
  const backup = await readBackup(page);
  expect(backup.splits[0].settled).toBe(true);
  // No cash moved, so no settlement row may exist.
  expect(backup.settlements ?? []).toHaveLength(0);
});

test("a full write-off closes both directions and books the true net loss", async ({ page }) => {
  // They owe you 500, you owe them 200 — walking away costs you 300 net.
  await gotoLocal(page, { splits: [owed("e2e-a", 500), owe("e2e-b", 200)], incomes: [bankFloat()] });
  await openNetSheet(page);

  await amountField(page).fill("0");
  await page.getByRole("button", { name: /Write off the whole/ }).click();
  await page.getByRole("button", { name: /Write off .*300 & close/ }).click();

  await expect.poll(async () => (await readBackup(page)).splits?.filter((s) => s.skipped).length ?? 0).toBe(2);
  const backup = await readBackup(page);
  expect(backup.settlements ?? []).toHaveLength(0);

  // Write-off ledger: ₹500 given up, ₹200 waived → net loss ₹300.
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByText("Write-offs")).toBeVisible();
  await expect(page.getByText(/Net loss .*300/)).toBeVisible();
});

test("typing 0 without ticking never books a full settle", async ({ page }) => {
  // The old behaviour: 0 fell through the partial test and settled the whole net
  // as if it had been paid in full.
  await gotoLocal(page, { splits: [owed("e2e-a", 300)] });
  await openNetSheet(page);

  await amountField(page).fill("0");
  await page.getByRole("button", { name: /Enter an amount, or tick write-off/ }).click({ force: true });

  await page.waitForTimeout(300);
  const backup = await readBackup(page);
  expect(backup.settlements ?? []).toHaveLength(0);
  expect(backup.splits[0].settled).toBeFalsy();
  expect(backup.splits[0].skipped).toBeFalsy();
});

// ── events ──────────────────────────────────────────────────────────────────

const groupEvent = () => ({ id: "e2e-ev", name: "Goa Trip", type: "group", participants: ["Rakesh"], status: "active", date: today(), icon: "travel" });
// You paid ₹1000 for two, so Rakesh owes you his ₹500 share.
const groupExpense = () => ({ id: "e2e-exp", type: "expense", amount: 1000, categoryId: "food", walletId: "bank", eventId: "e2e-ev", groupId: "e2e-exp", note: "Dinner", date: today(), balBefore: 5000 });
const groupIou = (extra = {}) => ({ id: "e2e-iou", name: "Rakesh", amount: 500, direction: "owed", settled: false, eventId: "e2e-ev", groupId: "e2e-exp", note: "Auto: Dinner", date: today(), ...extra });

async function openEventSettle(page) {
  await page.getByRole("button", { name: "Events", exact: true }).click();
  await page.getByText("Goa Trip").first().click();
  await page.getByText("Rakesh", { exact: true }).last().waitFor();
  await page.locator("text=Settle").filter({ hasText: /^Settle$/ }).first().click();
}

test("event settle-up does not default to a wallet that cannot receive", async ({ page }) => {
  // `sSuW(wl[0])` defaulted to UPI Lite, which is spend-only — so "Rakesh pays
  // you" was refused on every first tap with no hint why.
  await gotoLocal(page, { events: [groupEvent()], expenses: [groupExpense()], splits: [groupIou()], incomes: [bankFloat()] });
  await openEventSettle(page);

  await expect(page.getByText("Receive into")).toBeVisible();
  // UPI Lite is not even offered when money is coming in.
  await expect(page.getByRole("button", { name: /UPI Lite/ })).toHaveCount(0);

  await page.getByRole("button", { name: /^Settle / }).click();
  await expect.poll(async () => (await readBackup(page)).settlements?.length ?? 0).toBe(1);
  const stl = (await readBackup(page)).settlements[0];
  expect(stl.amount).toBe(500);
  expect(stl.walletId).not.toBe("upi_lite");
});

test("an event IOU can be written off from the settle sheet", async ({ page }) => {
  await gotoLocal(page, { events: [groupEvent()], expenses: [groupExpense()], splits: [groupIou()], incomes: [bankFloat()] });
  await openEventSettle(page);

  await amountField(page).fill("0");
  await page.getByRole("button", { name: /Write off the whole/ }).click();
  await page.getByRole("button", { name: /^Write off ₹500$/ }).click();

  await expect.poll(async () => (await readBackup(page)).splits?.[0]?.skipped).toBe(true);
  expect((await readBackup(page)).settlements ?? []).toHaveLength(0);
});

test("a written-off event IOU stops showing as an outstanding balance", async ({ page }) => {
  // grpSettled counted settlements only, so a written-off IOU left the BALANCES
  // card quoting the debt and SETTLE UP proposing a transfer that the handler
  // then refused — an event that could never be closed.
  await gotoLocal(page, {
    events: [groupEvent()],
    expenses: [groupExpense()],
    splits: [groupIou({ settled: true, skipped: true })],
  });
  await page.getByRole("button", { name: "Events", exact: true }).click();
  await page.getByText("Goa Trip").first().click();

  await expect(page.getByText("BALANCES")).toBeVisible();
  await expect(page.getByText("SETTLE UP")).toHaveCount(0);
  await expect(page.getByText("settled").first()).toBeVisible();
});

test("an event whose IOUs cannot net per-group still gets a whole-person settle", async ({ page }) => {
  // Mixing an expense-derived IOU with a manually-added one hides the per-group
  // "Settle up" (settleEventNet handles expense-derived IOUs only). Gating the
  // whole-person button on "2+ pending groups" then left no net settle at all,
  // so every IOU had to be closed by hand.
  await gotoLocal(page, {
    events: [groupEvent()],
    expenses: [groupExpense()],
    splits: [
      groupIou(),
      { id: "e2e-manual", name: "Rakesh", amount: 120, direction: "owed", settled: false, eventId: "e2e-ev", date: today() },
    ],
  });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "IOU · Splits", exact: true }).click();
  await page.getByRole("button", { name: /Open Rakesh/ }).click();

  // No per-group net button for the mixed event…
  await expect(page.getByRole("button", { name: /Settle up$/ })).toHaveCount(0);
  // …but the whole-person settle is offered, at the full ₹620 net.
  await page.getByRole("button", { name: /Settle everything .*620/ }).click();
  await page.getByRole("button", { name: /^Collect .*620/ }).click();

  await expect.poll(async () => (await readBackup(page)).settlements?.length ?? 0).toBe(2);
  const backup = await readBackup(page);
  expect(backup.splits.filter((s) => !s.settled && !s.skipped)).toHaveLength(0);
  expect(backup.settlements.reduce((t, s) => t + s.amount, 0)).toBe(620);
});
