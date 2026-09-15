import { test, expect } from "@playwright/test";
import { gotoLocal, dismissBanner, makeExpense, funded } from "./helpers.js";

// Three dashboard changes that had no e2e cover:
//   • the due-bill card moved ABOVE the balance hero (a deadline outranks a
//     readout, and it used to sit below the fold on a phone);
//   • the streak sheet redesign (trail ring, weekday-aligned calendar,
//     milestone ladder, shield slots);
//   • Category Share can now walk back into past months, which it could not
//     reach at all — every range was anchored to today.

const iso = (d) => d.toISOString().slice(0, 10);
const today = new Date();
const monthsAgo = (n) => { const d = new Date(today.getFullYear(), today.getMonth() - n, 15); return iso(d); };

test("a bill due today sits above the 'where you stand' hero", async ({ page }) => {
  await gotoLocal(page, {
    ...funded(),
    expenses: [makeExpense()],
    recurring: [{ id: "r1", name: "Rent", amount: 1750, categoryId: "rent", walletId: "bank", frequency: "monthly", dayOfMonth: today.getDate(), startDate: monthsAgo(3), active: true }],
  });
  await dismissBanner(page);

  const due = page.getByText(/due today/i).first();
  await expect(due).toBeVisible();
  const hero = page.getByText("Where you stand", { exact: false }).first();
  await expect(hero).toBeVisible();

  const dueBox = await due.boundingBox();
  const heroBox = await hero.boundingBox();
  expect(dueBox.y).toBeLessThan(heroBox.y);
});

test("streak sheet: trail ring, weekday-aligned calendar, milestone ladder", async ({ page }) => {
  // Three consecutive logged days → a live 3-day streak, so the badge shows.
  const day = (n) => iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() - n));
  await gotoLocal(page, {
    ...funded(),
    expenses: [makeExpense({ date: day(0) }), makeExpense({ date: day(1) }), makeExpense({ date: day(2) })],
  });
  await dismissBanner(page);

  await page.getByTitle(/streak/i).first().click();
  await expect(page.getByText("Your trail", { exact: true })).toBeVisible();

  // The ring is an SVG, not a flat bar — progress toward the next marker.
  const sheet = page.getByText("Your trail", { exact: true }).locator("xpath=ancestor::div[3]");
  await expect(sheet.locator("svg circle")).toHaveCount(2);

  // Stat tiles replace the whispered "Longest 3 · Shields 0/2" line.
  await expect(page.getByText("Longest", { exact: true })).toBeVisible();
  await expect(page.getByText("Shields", { exact: true })).toBeVisible();
  await expect(page.getByText("Logged / 28", { exact: true })).toBeVisible();

  // Milestone ladder, with the next marker counted down rather than implied.
  await expect(page.getByText("Markers", { exact: true })).toBeVisible();
  await expect(page.getByText(/days? to 7/)).toBeVisible();

  // The calendar is weekday-aligned: real headers, and 28 day cells plus the
  // leading pad make whole weeks. Without the pad the columns meant nothing.
  await expect(page.getByText("Last 4 weeks", { exact: true })).toBeVisible();
  const grid = page.getByText("Last 4 weeks", { exact: true }).locator("xpath=following-sibling::div[2]");
  const cellCount = await grid.locator("> div").count();
  expect(cellCount % 7).toBe(0);
  expect(cellCount).toBeGreaterThanOrEqual(28);

  await expect(page.getByText("Logged", { exact: true })).toBeVisible();
  await expect(page.getByText("Missed", { exact: true })).toBeVisible();
});

test("Category Share steps back into past months", async ({ page }) => {
  await gotoLocal(page, {
    ...funded(),
    expenses: [
      makeExpense({ amount: 900, categoryId: "food", note: "This month food" }),
      makeExpense({ amount: 400, categoryId: "travel", note: "Old travel", date: monthsAgo(1) }),
    ],
  });
  await dismissBanner(page);

  const card = page.getByText("Category Share", { exact: true }).locator("xpath=ancestor::div[2]");
  await expect(card.getByText("This month", { exact: true })).toBeVisible();

  // Forward is the edge of the timeline — there is no future to browse.
  await expect(card.getByRole("button", { name: "Later period" })).toBeDisabled();

  // Back reaches last month, which was previously unreachable from this card.
  await card.getByRole("button", { name: "Earlier period" }).click();
  await expect(card.getByText(/^[A-Z][a-z]{2} \d{4}$/)).toBeVisible();
  await expect(card.getByRole("button", { name: "Later period" })).toBeEnabled();

  // And the donut is now showing THAT month's categories, not this month's.
  await expect(card.getByText("Travel", { exact: false })).toBeVisible();

  // The stepper stops at the oldest expense rather than walking into blank
  // history forever.
  const back = card.getByRole("button", { name: "Earlier period" });
  await expect(back).toBeDisabled();

  await card.getByRole("button", { name: "Later period" }).click();
  await expect(card.getByText("This month", { exact: true })).toBeVisible();
});
