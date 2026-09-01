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

// The case the balances card and the IOU ledger used to disagree on. You pay
// ₹300 three ways, then A pays ₹60 three ways:
//   IOUs recorded: A owes You 100, B owes You 100, You owe A 20
//   NOT recorded:  B owes A 20 (neither side is You)
// Fair shares put A down 60 and B down 120; the IOU ledger puts A at 80 and B at
// 100. Both route the same ₹180 to you — but only the IOU plan is recordable, so
// that is what the card, SETTLE UP and the settle sheet all now show.
const trioEvent = () => ({ id: "ev3", name: "Trio Trip", type: "group", participants: ["A", "B"], status: "active", date: today(), icon: "travel" });
const trioState = () => ({
  events: [trioEvent()],
  expenses: [
    { id: "x1", type: "expense", amount: 300, categoryId: "food", walletId: "bank", eventId: "ev3", groupId: "x1", splitWith: { You: 100, A: 100, B: 100 }, note: "Hotel", date: today(), balBefore: 5000 },
    { id: "x2", type: "expense", amount: 60, categoryId: "food", walletId: "__tracked__", eventId: "ev3", groupId: "x2", paidBy: "A", splitWith: { You: 20, A: 20, B: 20 }, note: "Cab", date: today() },
  ],
  splits: [
    { id: "p1", name: "A", amount: 100, direction: "owed", settled: false, eventId: "ev3", groupId: "x1", date: today() },
    { id: "p2", name: "B", amount: 100, direction: "owed", settled: false, eventId: "ev3", groupId: "x1", date: today() },
    { id: "p3", name: "A", amount: 20, direction: "owe", settled: false, eventId: "ev3", groupId: "x2", date: today() },
  ],
  incomes: [bankFloat()],
});

test("balances card quotes the IOU ledger and names the debt it cannot track", async ({ page }) => {
  await gotoLocal(page, trioState());
  await page.getByRole("button", { name: "Events", exact: true }).click();
  await page.getByText("Trio Trip").first().click();

  await expect(page.getByText("BALANCES")).toBeVisible();
  // The IOU figures, not the simplifier's 60 / 120.
  await expect(page.getByText("₹80", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("₹100", { exact: true }).first()).toBeVisible();
  // ...and the simplifier's plan (B pays 120, A pays 60) is not offered at all.
  await expect(page.getByRole("button", { name: /B You ₹120/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /A You ₹60/ })).toHaveCount(0);
  // Your own row is unchanged either way.
  await expect(page.getByText("₹180", { exact: true }).first()).toBeVisible();
  // Every SETTLE UP row routes through You, because every tracked debt does.
  await expect(page.getByRole("button", { name: "A You ₹80 Settle" })).toBeVisible();
  await expect(page.getByRole("button", { name: "B You ₹100 Settle" })).toBeVisible();
  // The ₹20 B owes A is stated, not silently folded into a number.
  await expect(page.getByText(/Also owes .*20 to A .* not tracked here/)).toBeVisible();
  await expect(page.getByText(/Also owed .*20 from B .* not tracked here/)).toBeVisible();
});

test("settling from that card moves exactly what the row promised", async ({ page }) => {
  await gotoLocal(page, trioState());
  await page.getByRole("button", { name: "Events", exact: true }).click();
  await page.getByText("Trio Trip").first().click();

  // A's row: the IOU net is 80 (100 owed to you, less the 20 you owe them).
  await page.getByRole("button", { name: "A You ₹80 Settle" }).click();
  await expect(page.getByText("Settle up with A")).toBeVisible();
  await expect(amountField(page)).toHaveValue("80");
  await page.getByRole("button", { name: /^Settle ₹80$/ }).click();

  // Two settlement rows (the +100 and the −20) netting to the ₹80 promised.
  await expect.poll(async () => (await readBackup(page)).settlements?.length ?? 0).toBe(2);
  const backup = await readBackup(page);
  const cash = backup.settlements.reduce((t, s) => t + (s.direction === "owed" ? s.amount : -s.amount), 0);
  expect(Math.round(cash * 100) / 100).toBe(80);
  expect(backup.splits.filter((s) => s.name === "A" && !s.settled)).toHaveLength(0);
});

test("a person you are square with settles without writing anything off", async ({ page }) => {
  // ₹500 owed to you in an event, ₹500 owed by you in general: the net is zero,
  // so "Settle everything ₹0" is the only net settle on offer. It prefilled the
  // amount with "0", which read as a full write-off — the confirm stayed
  // DISABLED until you ticked one, and ticking it filed both sides as forgiven
  // debt. Being square is not a loss, and it has to be closable in one tap.
  await gotoLocal(page, {
    events: [groupEvent()],
    expenses: [groupExpense()],
    splits: [groupIou(), owe("e2e-gen", 500)],
  });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "IOU · Splits", exact: true }).click();
  await page.getByRole("button", { name: /Open Rakesh/ }).click();
  await page.getByRole("button", { name: /Settle everything/ }).click();

  // Nothing to enter, nowhere to move it, nothing to forgive.
  await expect(page.getByText(/All square with Rakesh/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Write off/ })).toHaveCount(0);
  const confirm = page.getByRole("button", { name: /nothing changes hands/ });
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect.poll(async () => (await readBackup(page)).splits?.filter((s) => s.settled).length ?? 0).toBe(2);
  const backup = await readBackup(page);
  // Settled, NOT written off — these debts were paid, by cancelling out.
  expect(backup.splits.some((s) => s.skipped)).toBe(false);

  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByText("Write-offs")).toHaveCount(0);
});
