import { test, expect } from "@playwright/test";
import { gotoLocal, dismissBanner, makeExpense, funded, readBackup } from "./helpers.js";

// The reported bug, driven through the real UI: an OVERDUE bill paid after its
// due month has rolled over would not clear. Tapping Paid booked the expense and
// left the card up, so every tap booked another one.
//
// The scenario needs a due date in a PREVIOUS month while today is in this one.
// A bill whose day-of-month falls later than today has exactly that shape: on
// the 20th, a bill due on the 25th last fell due on the 25th of LAST month.

// The clock is pinned to the 20th of the current month, so the premise holds
// on every calendar day. It used to read the real date and skip itself from
// the 24th on — the last week of every month ran none of these tests.
const now = new Date();
const today = new Date(now.getFullYear(), now.getMonth(), 20, 10, 0, 0);
const DOM = 25;
const localIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const monthsBack = (n) => localIso(new Date(today.getFullYear(), today.getMonth() - n, DOM));

const overdueRent = {
  id: "r1", name: "Rent", amount: 1750, categoryId: "rent", walletId: "bank",
  frequency: "monthly", dayOfMonth: DOM, startDate: monthsBack(6), active: true,
  lastPaidDate: null, lastSkippedDate: null,
};

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(today);
});

test("an overdue bill paid after the month rolled over clears and stays cleared", async ({ page }) => {
  await gotoLocal(page, { ...funded(), expenses: [makeExpense({ date: localIso(today) })], recurring: [overdueRent] });
  await dismissBanner(page);

  // It shows as overdue, not "due today" — the due date is in a previous month.
  await expect(page.getByText(/Rent overdue/i).first()).toBeVisible();

  await page.getByRole("button", { name: "✓ Paid", exact: true }).click();
  await page.getByRole("button", { name: "✓ Confirm paid", exact: true }).click();

  // The card must go. Before the fix it stayed, because the payment stamp's
  // month never matched the due date's month.
  await expect(page.getByText(/Rent overdue/i)).toHaveCount(0);

  // Exactly ONE rent expense was booked, not one per tap. The nomad-v5 backup
  // is written on an 800ms debounce, so poll rather than reading it instantly.
  await expect.poll(async () => {
    const backup = await readBackup(page);
    return (backup.expenses || []).filter(e => (e.note || "").startsWith("Rent")).length;
  }, { timeout: 5000 }).toBe(1);
  const backup = await readBackup(page);
  expect(backup.expenses.find(e => (e.note || "").startsWith("Rent")).amount).toBe(1750);

  // ...and it survives a reload rather than coming back.
  await page.reload();
  await expect(page.getByRole("button", { name: "Add", exact: true })).toBeVisible();
  await expect(page.getByText(/Rent overdue/i)).toHaveCount(0);
});

test("skipping an overdue bill clears it without booking an expense", async ({ page }) => {
  await gotoLocal(page, { ...funded(), expenses: [makeExpense({ date: localIso(today) })], recurring: [overdueRent] });
  await dismissBanner(page);

  await expect(page.getByText(/Rent overdue/i).first()).toBeVisible();
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(page.getByText(/Skipped for this cycle/i)).toBeVisible();
  await expect(page.getByText(/Rent overdue/i)).toHaveCount(0);

  const backup = await readBackup(page);
  expect((backup.expenses || []).filter(e => (e.note || "").startsWith("Rent"))).toHaveLength(0);
});

test("the notification centre agrees with the card once the bill is paid", async ({ page }) => {
  await gotoLocal(page, { ...funded(), expenses: [makeExpense({ date: localIso(today) })], recurring: [overdueRent] });
  await dismissBanner(page);

  const bell = page.getByRole("button", { name: /Notifications/i });
  await bell.click();
  await expect(page.getByRole("button", { name: /Rent is due/ })).toHaveCount(1);
  await page.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByRole("button", { name: "✓ Paid", exact: true }).click();
  await page.getByRole("button", { name: "✓ Confirm paid", exact: true }).click();
  await expect(page.getByText(/Rent overdue/i)).toHaveCount(0);

  // The shade is derived from the same predicate, so it must drop the claim too.
  await bell.click();
  await expect(page.getByRole("button", { name: /Rent is due/ })).toHaveCount(0);
});
