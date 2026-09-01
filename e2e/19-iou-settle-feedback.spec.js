import { test, expect } from "@playwright/test";
import { gotoLocal, readBackup } from "./helpers.js";

// Feedback around an IOU settle: the celebration, and what happens when a settle
// is REFUSED. Every regression here was silent — nothing crashed, the app just
// told the user something untrue.

const today = () => new Date().toISOString().slice(0, 10);
const owed = (id, amount, name = "Rakesh") => ({ id, name, amount, direction: "owed", settled: false, date: today() });
const owe = (id, amount, name = "Rakesh") => ({ id, name, amount, direction: "owe", settled: false, date: today() });

const confetti = (page) => page.locator("[data-nm-confetti]");
// `expect(locator).toHaveCount(0)` RETRIES until it matches, so it passes the
// moment a burst clears itself 1.4s later — it can never catch one that fired.
// Every "was not celebrated" assertion has to read the count once, at a moment
// we know the settle has already committed (its toast is on screen).
const expectNoBurst = async (page) => expect(await confetti(page).count()).toBe(0);
const amountField = (page) => page.locator('input[type="number"]').last();

async function openWallet(page) {
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "IOU · Splits", exact: true }).click();
}

test("confetti fires once on a settle and never replays on navigation", async ({ page }) => {
  // Two IOUs so the person stays on the wallet's active list after one settles.
  await gotoLocal(page, { splits: [owed("e2e-a", 100), owed("e2e-b", 40)] });
  await openWallet(page);
  await page.getByRole("button", { name: /Open Rakesh/ }).click();

  await expect(confetti(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Record", exact: true }).first().click();
  await page.getByRole("button", { name: /^Received/ }).click();
  await expect(confetti(page)).toHaveCount(1);

  // It clears itself. The trigger used to stay set for the rest of the session.
  await expect(confetti(page)).toHaveCount(0, { timeout: 5000 });

  // A stuck trigger meant a burst on every back-tap, long after the settle —
  // `sheets` used to sit at a different child index in each view tree, so any
  // switch between them remounted Confetti and replayed it.
  await page.getByRole("button", { name: "Back to wallet" }).click();
  await expect(page.getByRole("button", { name: /Open Rakesh/ })).toBeVisible();
  await expectNoBurst(page);
  await page.getByRole("button", { name: /Open Rakesh/ }).click();
  await expect(page.getByRole("button", { name: "Record", exact: true }).first()).toBeVisible();
  await expectNoBurst(page);
});

test("the burst survives a mid-flight navigation instead of restarting", async ({ page }) => {
  // `sheets` used to sit at a different child index in the person tree than in
  // the home tree, so React unmounted and remounted <Confetti> on every switch
  // between them. Tapping back while a burst was still in flight replayed it
  // from the top — and tapping back and forth kept it alive indefinitely.
  await gotoLocal(page, { splits: [owed("e2e-a", 100), owed("e2e-b", 40)] });
  await openWallet(page);
  await page.getByRole("button", { name: /Open Rakesh/ }).click();
  await page.getByRole("button", { name: "Record", exact: true }).first().click();
  await page.getByRole("button", { name: /^Received/ }).click();
  await expect(confetti(page)).toHaveCount(1);

  // Stamp the live overlay and navigate in ONE round trip, so the assertion
  // can't race the 1.4s burst. A remount would replace this node with a fresh,
  // unstamped one.
  await page.evaluate(() => {
    document.querySelector("[data-nm-confetti]")?.setAttribute("data-e2e-stamp", "1");
    document.querySelector('[aria-label="Back to wallet"]')?.click();
  });
  await expect(page.getByRole("button", { name: /Open Rakesh/ })).toBeVisible();
  await expect(confetti(page)).toHaveAttribute("data-e2e-stamp", "1");

  // And it still ends on its own schedule.
  await expect(confetti(page)).toHaveCount(0, { timeout: 5000 });
});

test("a full write-off is not celebrated — that money is gone", async ({ page }) => {
  // Closing an IOU and being paid for it are not the same event. `closes` said
  // "the row is now closed", which a write-off satisfies, so walking away from
  // ₹300 threw the same confetti as collecting it.
  await gotoLocal(page, { splits: [owed("e2e-a", 300)] });
  await openWallet(page);
  await page.getByRole("button", { name: /Open Rakesh/ }).click();
  await page.getByRole("button", { name: /Settle up/ }).first().click();

  await amountField(page).fill("0");
  await page.getByRole("button", { name: /Write off the whole/ }).click();
  await page.getByRole("button", { name: /Write off .*300 & close/ }).click();

  // Assert on the toast, not on the persisted backup: the local-backup write is
  // debounced ~800ms and polling for it outlasts the 1.4s burst, so a confetti
  // check that waits for storage passes whether or not anything ever fired.
  await expect(page.getByText(/written off with Rakesh/)).toBeVisible();
  await expectNoBurst(page);
  await expect.poll(async () => (await readBackup(page)).splits?.[0]?.skipped).toBe(true);
});

test("a partial accepted as full and final is not celebrated either", async ({ page }) => {
  // ₹240 in, ₹60 given up. The IOU closes, but not because it was paid.
  await gotoLocal(page, { splits: [owed("e2e-a", 300)] });
  await openWallet(page);
  await page.getByRole("button", { name: /Open Rakesh/ }).click();
  await page.getByRole("button", { name: "Record", exact: true }).click();

  await amountField(page).fill("240");
  await page.getByRole("button", { name: /Write off the remaining/ }).click();
  await page.getByRole("button", { name: /^Received/ }).click();

  await expect(page.getByText(/written off/).first()).toBeVisible();
  await expectNoBurst(page);
  await expect.poll(async () => (await readBackup(page)).splits?.[0]?.skipped).toBe(true);
});

test("a partial payment is not celebrated — the IOU is still open", async ({ page }) => {
  await gotoLocal(page, { splits: [owed("e2e-a", 100)] });
  await openWallet(page);
  await page.getByRole("button", { name: /Open Rakesh/ }).click();
  await page.getByRole("button", { name: "Record", exact: true }).click();

  await amountField(page).fill("40");
  await expect(page.getByText(/will remain as pending IOU/)).toBeVisible();
  await page.getByRole("button", { name: /^Received/ }).click();

  await expect(page.getByText(/still remaining/)).toBeVisible();
  await expectNoBurst(page);
  await expect.poll(async () => (await readBackup(page)).settlements?.length ?? 0).toBe(1);
});

test("a refused settle keeps the sheet open with the entered amount intact", async ({ page }) => {
  // Paying ₹300 from UPI Lite (the default pay-from) with no balance anywhere:
  // settle() refuses. The sheet used to close anyway, throwing away the amount,
  // date and wallet — the only three things the user could change to fix it.
  await gotoLocal(page, { splits: [owe("e2e-a", 300)] });
  await openWallet(page);
  await page.getByRole("button", { name: /Open Rakesh/ }).click();
  await page.getByRole("button", { name: "Record", exact: true }).click();

  await page.getByRole("button", { name: /^Paid/ }).click();

  await expect(page.getByText(/Not enough/)).toBeVisible();
  await expect(page.getByText("PAY FROM")).toBeVisible();
  await expect(amountField(page)).toHaveValue("300");
  expect((await readBackup(page)).settlements ?? []).toHaveLength(0);
  await expectNoBurst(page);
});

test("a settle overpay alone does not raise a Write-offs card", async ({ page }) => {
  // ₹0.34 of change coming back is an offset AGAINST write-offs, not one itself.
  // Gating the card on it too produced a "Write-offs" card reading ₹0, ₹0 and
  // "Net gain ₹0".
  await gotoLocal(page, { splits: [owed("e2e-jai", 11.66, "Jai akash")] });
  await openWallet(page);
  await page.getByRole("button", { name: /Open Jai akash/ }).click();
  await page.getByRole("button", { name: "Record", exact: true }).click();

  await amountField(page).fill("12");
  await page.getByRole("button", { name: /^Received/ }).click();
  await expect.poll(async () => (await readBackup(page)).settlements?.[0]?.excess).toBe(0.34);

  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByText("Write-offs")).toHaveCount(0);
});
