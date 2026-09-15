import { test, expect } from "@playwright/test";
import { gotoLocal, dismissBanner, makeExpense, funded } from "./helpers.js";

// Search lived only in History and covered transactions. The only way back to a
// trip from six months ago was to scroll — and if it was completed, to know to
// switch tabs first.
const state = {
  ...funded(),
  events: [
    { id: "ev1", name: "Goa trip", status: "completed", date: "2026-03-10", participants: ["Rafi", "Rakesh"] },
    { id: "ev2", name: "Flat rent", status: "active", date: "2026-09-01", participants: ["Amit"] },
  ],
  expenses: [
    makeExpense({ id: "x1", amount: 5000, note: "Hotel", eventId: "ev1", date: "2026-03-10" }),
    makeExpense({ id: "x2", amount: 1750, note: "September", eventId: "ev2", date: "2026-09-01" }),
  ],
};

test("finds an event by name, across tabs", async ({ page }) => {
  await gotoLocal(page, state);
  await dismissBanner(page);
  await page.getByRole("button", { name: "Events" }).click();

  // "Goa trip" is COMPLETED, so the default Active tab does not list it.
  await expect(page.getByText("Goa trip")).toHaveCount(0);

  await page.getByPlaceholder("Search events, people, amounts…").fill("goa");
  await expect(page.getByText("Goa trip")).toBeVisible();
  await expect(page.getByText("Flat rent")).toHaveCount(0);
  await expect(page.getByText("1 event across all tabs")).toBeVisible();
});

test("finds an event by a participant who was on it", async ({ page }) => {
  await gotoLocal(page, state);
  await dismissBanner(page);
  await page.getByRole("button", { name: "Events" }).click();
  await page.getByPlaceholder("Search events, people, amounts…").fill("rakesh");
  await expect(page.getByText("Goa trip")).toBeVisible();
});

test("finds an event by an amount logged inside it", async ({ page }) => {
  await gotoLocal(page, state);
  await dismissBanner(page);
  await page.getByRole("button", { name: "Events" }).click();
  // The trip's own total is a different number from this single expense —
  // matching has to consider every amount the event carries.
  await page.getByPlaceholder("Search events, people, amounts…").fill("5000");
  await expect(page.getByText("Goa trip")).toBeVisible();
  await expect(page.getByText("Flat rent")).toHaveCount(0);
});

test("tokens are ANDed, and clearing restores the tab", async ({ page }) => {
  await gotoLocal(page, state);
  await dismissBanner(page);
  await page.getByRole("button", { name: "Events" }).click();
  const box = page.getByPlaceholder("Search events, people, amounts…");

  await box.fill("goa 5000");
  await expect(page.getByText("Goa trip")).toBeVisible();
  await box.fill("goa amit");           // never both on one event
  await expect(page.getByText("Goa trip")).toHaveCount(0);

  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(page.getByText("Flat rent")).toBeVisible();   // back to Active
  await expect(page.getByText("Goa trip")).toHaveCount(0);
});
