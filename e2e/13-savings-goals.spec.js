import { test, expect } from "@playwright/test";
import { gotoLocal, dismissBanner, makeExpense } from "./helpers.js";

// Savings goals live in localStorage `nomad-goals-v1` (synced via user_prefs
// when cloud sync is on — irrelevant here in local-only mode). Managed from
// Settings → Savings Goals; the dashboard card only renders once a goal exists.
// One seeded expense suppresses the empty-dashboard welcome card, whose own
// "Settings" button collides with the nav button under strict mode (see 04).
const seeded = { expenses: [makeExpense()] };

const readGoals = (page) =>
  page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem("nomad-goals-v1") || "[]");
    } catch {
      return [];
    }
  });

async function createGoal(page, { name, target, date }) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByText("Savings Goals", { exact: true }).click();
  await page.locator("input[placeholder='Name (e.g. Goa trip, iPhone)…']").fill(name);
  await page.locator("input[placeholder='₹ target']").fill(String(target));
  if (date) await page.locator("input[type='date']").fill(date);
  await page.getByRole("button", { name: "+ Add Goal" }).click();
}

test("create a goal, set money aside, and see it on the dashboard", async ({ page }) => {
  await gotoLocal(page, seeded);
  await createGoal(page, { name: "Goa trip", target: 10000 });
  await expect.poll(async () => (await readGoals(page)).length).toBe(1);

  // Contribute ₹2500 — pure marker, no wallet involved.
  await page.locator("input[placeholder='₹ amount']").fill("2500");
  await page.getByRole("button", { name: "+ Set aside" }).click();
  await expect.poll(async () => (await readGoals(page))[0]?.saved).toBe(2500);

  // Dashboard card renders the goal with its progress.
  await page.getByRole("button", { name: "Home" }).click();
  await expect(page.getByText("Savings Goals", { exact: true })).toBeVisible();
  await expect(page.getByText("Goa trip", { exact: true })).toBeVisible();
});

test("reaching the target flips the goal to DONE", async ({ page }) => {
  await gotoLocal(page, seeded);
  await createGoal(page, { name: "iPhone", target: 500 });
  await page.locator("input[placeholder='₹ amount']").fill("500");
  await page.getByRole("button", { name: "+ Set aside" }).click();
  await expect(page.getByText("DONE", { exact: true })).toBeVisible();
  // A finished goal offers no contribution input anymore.
  await expect(page.locator("input[placeholder='₹ amount']")).toHaveCount(0);
});

test("goals survive a reload and deletion removes the dashboard card", async ({ page }) => {
  await gotoLocal(page, seeded);
  await createGoal(page, { name: "Emergency fund", target: 20000, date: "2099-12-31" });
  await expect.poll(async () => (await readGoals(page)).length).toBe(1);

  await page.reload();
  await dismissBanner(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByText("Savings Goals", { exact: true }).click();
  await expect(page.getByText("Emergency fund", { exact: true })).toBeVisible();

  await page.getByTitle("Delete goal Emergency fund").click();
  await expect.poll(async () => (await readGoals(page)).length).toBe(0);
  await page.getByRole("button", { name: "Home" }).click();
  await expect(page.getByText("Savings Goals", { exact: true })).toHaveCount(0);
});
