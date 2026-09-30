import { test, expect } from "@playwright/test";
import { gotoLocal, dismissBanner, makeExpense, funded } from "./helpers.js";

// Spending by Category was hard-pinned to the current month, so last month's
// breakdown was unreachable from the dashboard. It now carries the same
// ‹ month › stepper as Category Share, and its change badges compare
// like-for-like and never print an unreadable percentage off a tiny base.

const today = new Date();
const localIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const monthsAgo = (n, day = 15) => localIso(new Date(today.getFullYear(), today.getMonth() - n, day));
const todayIso = localIso(today);

test("steps back into last month and forward again", async ({ page }) => {
  await gotoLocal(page, {
    ...funded(),
    expenses: [
      makeExpense({ amount: 900, categoryId: "food", note: "This month food", date: todayIso }),
      makeExpense({ amount: 400, categoryId: "travel", note: "Old travel", date: monthsAgo(1) }),
    ],
  });
  await dismissBanner(page);

  const card = page.getByTestId("category-spend");
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByText("This month", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Later month" })).toBeDisabled();
  await expect(card.getByText("Food & Drinks", { exact: true })).toBeVisible();
  await expect(card.getByText("Travel", { exact: true })).toHaveCount(0);

  await card.getByRole("button", { name: "Earlier month" }).click();
  await expect(card.getByText(/^[A-Z][a-z]{2} \d{4}$/)).toBeVisible();
  await expect(card.getByText("Travel", { exact: true })).toBeVisible();
  await expect(card.getByText("Food & Drinks", { exact: true })).toHaveCount(0);

  // The drill-down lists THAT month's entries.
  await card.getByText("Travel", { exact: true }).click();
  await expect(card.getByText("Old travel", { exact: true })).toBeVisible();

  // Floor: nothing older than the oldest expense, so back stops here.
  await expect(card.getByRole("button", { name: "Earlier month" })).toBeDisabled();

  await card.getByRole("button", { name: "Later month" }).click();
  await expect(card.getByText("This month", { exact: true })).toBeVisible();
  await expect(card.getByText("Food & Drinks", { exact: true })).toBeVisible();
});

test("a tiny base reads as a multiple, and a recurring category keeps its real name", async ({ page }) => {
  await gotoLocal(page, {
    ...funded(),
    expenses: [
      makeExpense({ amount: 1, categoryId: "entertainment", note: "Test", date: monthsAgo(1, 1) }),
      makeExpense({ amount: 485.22, categoryId: "entertainment", note: "Concert", date: todayIso }),
      makeExpense({ amount: 500, categoryId: "sip", note: "SIP", date: todayIso, recurring: true }),
    ],
  });
  await dismissBanner(page);

  const card = page.getByTestId("category-spend");
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByText("485×", { exact: false })).toBeVisible();
  await expect(card.getByText(/48\d{3}%/)).toHaveCount(0);
  // "sip" is a recurring-bill category (RC), not an expense category. It used
  // to fall back to its id ("Sip") while the donut above said "SIP / MF".
  await expect(card.getByText("SIP / MF", { exact: true })).toBeVisible();
  await expect(card.getByText("FIXED", { exact: true })).toBeVisible();
});

test("rows never overflow the card on a narrow phone", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await gotoLocal(page, {
    ...funded(),
    expenses: [
      makeExpense({ amount: 123456.78, categoryId: "entertainment", note: "Big", date: todayIso }),
      makeExpense({ amount: 2801.71, categoryId: "food", note: "Food", date: todayIso }),
    ],
  });
  await dismissBanner(page);

  const card = page.getByTestId("category-spend");
  await card.scrollIntoViewIfNeeded();
  const cardBox = await card.boundingBox();
  for (const name of ["Entertainment", "Food & Drinks"]) {
    const row = card.getByRole("button", { name: new RegExp(name) });
    const box = await row.boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
    // Name and amount share one line — the old layout wrapped both into stacks.
    const label = card.getByText(name, { exact: true });
    const lb = await label.boundingBox();
    expect(lb.height).toBeLessThan(24);
  }
});
