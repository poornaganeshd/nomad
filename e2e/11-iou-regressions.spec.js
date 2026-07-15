import { test, expect } from "@playwright/test";
import { gotoLocal, readBackup } from "./helpers.js";

// Regression pins for the IOU-wallet bug streak (PRs #125–#128 + follow-ups).
// Each test reproduces a bug that actually shipped once; if any of them fails,
// that exact bug is back. Everything drives the real app (local-only mode) —
// no mocked handlers, so wiring regressions fail too.

const TODAY = new Date().toISOString().slice(0, 10);
const split = (o) => ({ id: "s-" + Math.random().toString(36).slice(2), settled: false, date: TODAY, ...o });

async function openIou(page) {
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "IOU · Splits", exact: true }).click();
}

// One person spanning every source shape: personal, active event (expense-
// derived + manual), completed event, deleted event, legacy status-less event.
function mixedSeed() {
  return {
    expenses: [{ id: "x1", amount: 195, categoryId: "food", walletId: "__tracked__", paidBy: "Rakesh", date: TODAY, eventId: "evA", groupId: "x1" }],
    splits: [
      split({ id: "p1", name: "Rakesh", amount: 200, direction: "owed", note: "Lunch" }),
      split({ id: "p2", name: "Rakesh", amount: 97.5, direction: "owed", eventId: "evA", groupId: "x1" }),
      split({ id: "p3", name: "Rakesh", amount: 45, direction: "owed", note: "Manual snack", eventId: "evA" }),
      split({ id: "p4", name: "Rakesh", amount: 35, direction: "owed", eventId: "evDone" }),
      split({ id: "p5", name: "Rakesh", amount: 50, direction: "owed", eventId: "evGone" }),
      split({ id: "p6", name: "Rakesh", amount: 20, direction: "owed", eventId: "evLegacy" }),
    ],
    events: [
      { id: "evA", name: "Goa Trip", status: "active", date: TODAY },
      { id: "evDone", name: "Done Trip", status: "completed", date: TODAY },
      { id: "evLegacy", name: "Legacy Thing", date: TODAY }, // no status — pre-status data
      // evGone intentionally absent: orphaned splits from a deleted event
    ],
  };
}
// Countable net: 200 + 97.5 + 45 = 342.5 (evDone/evGone/evLegacy excluded).

test("wallet and dashboard agree on the merged net and exclude past/zombie events", async ({ page }) => {
  await gotoLocal(page, mixedSeed());
  // Dashboard IOU card mirrors the wallet scope (was: personal-only → tiles disagreed)
  await expect(page.getByText("IOUs · 1:1 Splits")).toBeVisible();
  await expect(page.getByText("+342.5").first()).toBeVisible();
  await openIou(page);
  // Wallet Net tile: same figure (completed/deleted/legacy event IOUs excluded)
  await expect(page.getByText("+342.5").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Open Rakesh/ })).toContainText("342.5");
});

test("person view separates Personal and Events pills; zombie events stay out", async ({ page }) => {
  await gotoLocal(page, mixedSeed());
  await openIou(page);
  await page.getByRole("button", { name: /Open Rakesh/ }).click();
  await expect(page.getByRole("button", { name: /^Personal/ })).toBeVisible();
  // Only the ACTIVE event counts toward the pill
  const evPill = page.getByRole("button", { name: /Events · 1/ });
  await expect(evPill).toBeVisible();
  // Personal segment shows the general IOU but no event rows
  await expect(page.getByText("Lunch")).toBeVisible();
  await expect(page.getByText("Manual snack")).toHaveCount(0);
  await evPill.click();
  await expect(page.getByText("Goa Trip").first()).toBeVisible();
  await expect(page.getByText("Manual snack")).toBeVisible();
  await expect(page.getByText("Done Trip")).toHaveCount(0);
  await expect(page.getByText("Legacy Thing")).toHaveCount(0);
  await expect(page.getByText("Lunch")).toBeHidden(); // personal row not in Events segment
});

test("Settle everything shows the header net and clears manual event IOUs too", async ({ page }) => {
  await gotoLocal(page, mixedSeed());
  await openIou(page);
  await page.getByRole("button", { name: /Open Rakesh/ }).click();
  await expect(page.getByText("Owes you ₹342.5")).toBeVisible();
  // Was: button showed only expense-derived groups (₹297.5) and a confusing
  // "excludes manual IOUs" note — the figure must equal the header net.
  const btn = page.getByRole("button", { name: /Settle everything/ });
  await expect(btn).toContainText("342.5");
  await btn.click();
  await page.getByRole("button", { name: /Collect .*& settle/ }).click();
  // All three countable splits settle — including the manual event IOU —
  // and event settlements keep their eventId (ledger reconciliation).
  await expect.poll(async () => (await readBackup(page)).settlements?.length ?? 0).toBe(3);
  const b = await readBackup(page);
  expect(b.splits.find((s) => s.id === "p1").settled).toBe(true);
  expect(b.splits.find((s) => s.id === "p2").settled).toBe(true);
  expect(b.splits.find((s) => s.id === "p3").settled).toBe(true);
  expect(b.settlements.find((s) => s.splitId === "p3").eventId).toBe("evA");
  expect(b.settlements.find((s) => s.splitId === "p3").groupId).toBeFalsy();
  // Zombie-event IOUs untouched
  expect(b.splits.find((s) => s.id === "p4").settled).toBe(false);
});

test("Settle everything validates the COMBINED payout atomically (no overdraft)", async ({ page }) => {
  // Was: each source validated against the same stale balance — two ₹80
  // payouts both passed against ₹100 and drove the wallet to −₹60.
  await gotoLocal(page, {
    walletStartBal: { bank: 100, cash: 0, upi_lite: 0 },
    expenses: [{ id: "x1", amount: 160, categoryId: "food", walletId: "__tracked__", paidBy: "Ravi", date: TODAY, eventId: "evE", groupId: "x1" }],
    splits: [
      split({ id: "s1", name: "Ravi", amount: 80, direction: "owe", note: "Cab" }),
      split({ id: "s2", name: "Ravi", amount: 80, direction: "owe", eventId: "evE", groupId: "x1" }),
    ],
    events: [{ id: "evE", name: "Trip", status: "active", date: TODAY }],
  });
  await openIou(page);
  await page.getByRole("button", { name: /Open Ravi/ }).click();
  await page.getByRole("button", { name: /Settle everything/ }).click();
  await page.getByRole("button", { name: "Bank", exact: true }).click();
  await page.getByRole("button", { name: /Pay .*& settle/ }).click();
  await expect(page.getByText(/Not enough — need/)).toBeVisible();
  const b = await readBackup(page);
  expect(b.settlements?.length ?? 0).toBe(0);
  expect(b.splits.every((s) => !s.settled)).toBe(true);
});

test("partial Settle everything pays General first and keeps eventId on event settlements", async ({ page }) => {
  await gotoLocal(page, {
    walletStartBal: { bank: 100000, cash: 0, upi_lite: 0 },
    expenses: [{ id: "x1", amount: 160, categoryId: "food", walletId: "__tracked__", paidBy: "Ravi", date: TODAY, eventId: "evE", groupId: "x1" }],
    splits: [
      split({ id: "s1", name: "Ravi", amount: 80, direction: "owe", note: "Cab" }),
      split({ id: "s2", name: "Ravi", amount: 80, direction: "owe", eventId: "evE", groupId: "x1" }),
    ],
    events: [{ id: "evE", name: "Trip", status: "active", date: TODAY }],
  });
  await openIou(page);
  await page.getByRole("button", { name: /Open Ravi/ }).click();
  await page.getByRole("button", { name: /Settle everything/ }).click();
  await page.locator("input[type='number']").last().fill("100");
  await page.getByRole("button", { name: "Bank", exact: true }).click();
  await page.getByRole("button", { name: /Pay .*& settle/ }).click();
  await expect.poll(async () => (await readBackup(page)).settlements?.length ?? 0).toBe(2);
  const b = await readBackup(page);
  const gen = b.settlements.find((s) => s.splitId === "s1");
  const ev = b.settlements.find((s) => s.splitId === "s2");
  expect(gen.amount).toBe(80); // General cleared fully first
  expect(gen.eventId).toBeFalsy();
  expect(ev.amount).toBe(20); // remainder pays down the event IOU
  expect(ev.eventId).toBe("evE");
  expect(b.splits.find((s) => s.id === "s1").settled).toBe(true);
  expect(b.splits.find((s) => s.id === "s2").settled).toBe(false);
});

test("a person known only from events still offers Add IOU via the Personal pill", async ({ page }) => {
  // Was: the view force-landed on Events with no pills and no Add button.
  await gotoLocal(page, {
    expenses: [{ id: "x1", amount: 110, categoryId: "food", walletId: "__tracked__", paidBy: "Kala", date: TODAY, eventId: "evE", groupId: "x1" }],
    splits: [split({ id: "k1", name: "Kala", amount: 55, direction: "owed", eventId: "evE", groupId: "x1" })],
    events: [{ id: "evE", name: "Trip", status: "active", date: TODAY }],
  });
  await openIou(page);
  await page.getByRole("button", { name: /Open Kala/ }).click();
  await expect(page.getByText("Trip").first()).toBeVisible(); // lands on Events (only data it has)
  await page.getByRole("button", { name: /^Personal/ }).click();
  await expect(page.getByText("No personal IOUs with Kala")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add IOU with Kala" })).toBeVisible();
});

test("quick-add morph locks page scroll while open and releases on close", async ({ page }) => {
  // Was: no effective lock (body-only) — and once, a stuck overlay ate taps.
  await gotoLocal(page, { splits: [split({ id: "m1", name: "Asha", amount: 120, direction: "owed" })] });
  await openIou(page);
  await page.getByRole("button", { name: "Add IOU with Asha" }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.style.overflow)).toBe("hidden");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.style.overflow)).toBe("");
  // The dying overlay must not intercept: the card is clickable right away
  await page.getByRole("button", { name: /Open Asha/ }).click();
  await expect(page.getByText("Owes you ₹120")).toBeVisible();
});

test("Net tile opens a per-source breakdown that matches the tile", async ({ page }) => {
  await gotoLocal(page, mixedSeed());
  await openIou(page);
  await page.getByRole("button", { name: "Show net breakdown" }).click();
  await expect(page.getByText("Net breakdown")).toBeVisible();
  // Per-source parts: General + the active event only, summing to the tile
  await expect(page.getByText(/General \+200/)).toBeVisible();
  await expect(page.getByText(/Goa Trip \+142.5/)).toBeVisible();
  await expect(page.getByText("+342.5").last()).toBeVisible();
});
