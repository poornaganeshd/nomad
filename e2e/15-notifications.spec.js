import { test, expect } from "@playwright/test";
import { gotoLocal, funded, readBackup } from "./helpers.js";

// Notification centre (bell in the dashboard header → src/notifications.js).
// The daily IOU/bill reminders used to exist only as 2-second toasts stacked
// over the dashboard; now they also land in a list you can come back to, kept
// in localStorage. Action confirmations ("Expense added") must stay toast-only.

const today = () => new Date().toISOString().slice(0, 10);
const owe = (id, amount, name = "Rakesh") => ({ id, name, amount, direction: "owe", settled: false, date: today() });

const bell = (page) => page.getByRole("button", { name: /^Notifications/ });
const readStore = (page) => page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem("nomad-notifications-v1") || "[]"); } catch { return []; }
});

test("outstanding IOUs land in the notification centre, aggregated per person", async ({ page }) => {
  await gotoLocal(page, { splits: [owe("a", 15), owe("b", 10), owe("c", 92.5)] });

  // One entry for the person, carrying the combined balance — not three.
  await expect.poll(async () => (await readStore(page)).length, { timeout: 10000 }).toBe(1);
  const [entry] = await readStore(page);
  expect(entry.kind).toBe("iou");
  expect(entry.title).toContain("117.5");
  expect(entry.title).toContain("Rakesh");

  await bell(page).click();
  await expect(page.getByText("Notifications", { exact: true })).toBeVisible();
  await expect(page.getByText(/You owe .*117\.5.*Rakesh/).first()).toBeVisible();
});

test("the bell shows an unread badge and opening clears it", async ({ page }) => {
  await gotoLocal(page, { splits: [owe("a", 300)] });
  await expect.poll(async () => (await readStore(page)).length, { timeout: 10000 }).toBe(1);

  await expect(bell(page)).toHaveAccessibleName(/1 unread/);
  await bell(page).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(bell(page)).toHaveAccessibleName("Notifications");
  await expect.poll(async () => (await readStore(page))[0]?.read).toBe(true);
});

test("notifications persist across a reload and Clear all empties the list", async ({ page }) => {
  await gotoLocal(page, { splits: [owe("a", 300)] });
  await expect.poll(async () => (await readStore(page)).length, { timeout: 10000 }).toBe(1);

  await page.reload();
  await expect(bell(page)).toBeVisible();
  expect(await readStore(page)).toHaveLength(1);

  await bell(page).click();
  await page.getByRole("button", { name: "Clear all", exact: true }).click();
  await expect(page.getByText(/Nothing needs you right now/)).toBeVisible();
  expect(await readStore(page)).toHaveLength(0);
});

test("action confirmations stay toasts and never reach the notification centre", async ({ page }) => {
  // Fund the wallet — addE() rejects an expense above the wallet balance.
  await gotoLocal(page, funded());
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.locator("input[placeholder='0']").first().fill("125");
  await page.getByRole("button", { name: /Food & Drinks/ }).click();
  await page.getByRole("button", { name: "Add Expense" }).click();
  await expect.poll(async () => (await readBackup(page)).expenses?.length ?? 0).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Home", exact: true }).click();
  expect(await readStore(page)).toHaveLength(0);
});

test("settling the person clears their notification automatically", async ({ page }) => {
  // ₹300 owed to Rakesh, and enough in Bank to actually pay it.
  await gotoLocal(page, {
    splits: [owe("a", 300)],
    incomes: [{ id: "e2e-inc", type: "income", amount: 5000, walletId: "bank", sourceId: "allowance", date: today() }],
  });
  await expect.poll(async () => (await readStore(page)).length, { timeout: 10000 }).toBe(1);

  // Settle in full through the net sheet.
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "IOU · Splits", exact: true }).click();
  await page.getByRole("button", { name: /Open Rakesh/ }).click();
  await page.getByRole("button", { name: /Settle up/ }).first().click();
  await page.getByRole("button", { name: "Bank", exact: true }).last().click();
  await page.getByRole("button", { name: /& settle/ }).click();

  // The claim is no longer true, so the entry goes on its own — no dismissing.
  await expect.poll(async () => (await readStore(page)).length, { timeout: 10000 }).toBe(0);
});

test("a partial settle rewrites the notification to the remaining balance", async ({ page }) => {
  await gotoLocal(page, {
    splits: [owe("a", 300)],
    incomes: [{ id: "e2e-inc", type: "income", amount: 5000, walletId: "bank", sourceId: "allowance", date: today() }],
  });
  await expect.poll(async () => (await readStore(page)).length, { timeout: 10000 }).toBe(1);
  expect((await readStore(page))[0].title).toContain("300");

  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "IOU · Splits", exact: true }).click();
  await page.getByRole("button", { name: /Open Rakesh/ }).click();
  await page.getByRole("button", { name: /Settle up/ }).first().click();
  await page.getByRole("button", { name: "Bank", exact: true }).last().click();
  await page.locator('input[type="number"]').last().fill("240");
  await page.getByRole("button", { name: /^Pay .*240/ }).click();

  // Still outstanding, but for ₹60 — not the original ₹300.
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect.poll(async () => (await readStore(page))[0]?.title, { timeout: 10000 }).toContain("60");
});

test("tapping an IOU notification opens that person in the IOU wallet", async ({ page }) => {
  await gotoLocal(page, { splits: [owe("a", 300)] });
  await expect.poll(async () => (await readStore(page)).length, { timeout: 10000 }).toBe(1);

  await bell(page).click();
  await page.getByText(/You owe .*300.*Rakesh/).first().click();

  // Landed on the person's detail view in the IOU wallet.
  await expect(page.getByRole("button", { name: /Settle up/ }).first()).toBeVisible();
  await expect(page.getByText("Rakesh").first()).toBeVisible();
});

test("the Home nav carries an unread dot from other tabs", async ({ page }) => {
  await gotoLocal(page, { splits: [owe("a", 300)] });
  await expect.poll(async () => (await readStore(page)).length, { timeout: 10000 }).toBe(1);

  // The bell lives in the dashboard header; from History the nav dot is the cue.
  await page.getByRole("button", { name: "History", exact: true }).click();
  const homeNav = page.getByRole("button", { name: "Home", exact: true });
  await expect(homeNav.locator("div[style*='border-radius: 50%']").first()).toBeVisible();
});
