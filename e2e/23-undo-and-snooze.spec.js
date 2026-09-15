import { test, expect } from "@playwright/test";
import { gotoLocal, dismissBanner, makeExpense, funded, readBackup } from "./helpers.js";

const iso = (d) => d.toISOString().slice(0, 10);
const today = new Date();

// Undoing a deleted GROUP expense restored its IOUs on screen but re-upserted
// them without clearing deleted_at, so the soft delete still stood server-side
// and the 60s background pull dropped them again a minute later. Local-only
// mode has no server, so this pins the observable half: Undo brings the IOUs
// back, and the rows it writes are marked undeleted.
test("undo of a group expense brings its IOUs back, not just the expense", async ({ page }) => {
  const gid = "grp-e2e-1";
  await gotoLocal(page, {
    ...funded(),
    expenses: [makeExpense({ id: "exp1", amount: 600, note: "Dinner", groupId: gid })],
    splits: [
      { id: "sp1", name: "Rafi", amount: 200, direction: "owed", settled: false, groupId: gid, note: "Auto: Dinner", date: iso(today) },
      { id: "sp2", name: "Rakesh", amount: 200, direction: "owed", settled: false, groupId: gid, note: "Auto: Dinner", date: iso(today) },
    ],
  });
  await dismissBanner(page);

  await page.getByRole("button", { name: "History" }).click();
  await expect(page.getByText("Dinner", { exact: false }).first()).toBeVisible();

  // Delete the group expense — its IOUs go with it.
  await page.getByRole("button", { name: "✕", exact: true }).first().click();
  await expect(page.getByText("Expense deleted", { exact: false })).toBeVisible();
  await expect.poll(async () => (await readBackup(page)).splits?.length ?? -1).toBe(0);

  // Undo restores both, and the splits are explicitly un-deleted.
  await page.getByRole("button", { name: /undo/i }).click();
  await expect.poll(async () => (await readBackup(page)).splits?.length ?? -1).toBe(2);
  const splits = (await readBackup(page)).splits;
  expect(splits.map(s => s.id).sort()).toEqual(["sp1", "sp2"]);
  expect(splits.every(s => !s.deleted_at)).toBe(true);
});

// Snooze used to be honoured only by the dashboard's due-bill cards, so the
// notification centre kept claiming a snoozed bill was due — and its row
// deep-linked back to a dashboard list the bill was no longer in.
test("snoozing a bill silences the notification centre too, not just the card", async ({ page }) => {
  await gotoLocal(page, {
    ...funded(),
    expenses: [makeExpense()],
    recurring: [{ id: "r1", name: "Rent", amount: 1750, categoryId: "rent", walletId: "bank", frequency: "monthly", dayOfMonth: today.getDate(), startDate: iso(new Date(today.getFullYear(), today.getMonth() - 3, 1)), active: true }],
  });
  await dismissBanner(page);

  await expect(page.getByText(/due today/i).first()).toBeVisible();

  // The notification centre lists it before the snooze.
  const bell = page.getByRole("button", { name: /Notifications/i });
  await bell.click();
  const claim = page.getByRole("button", { name: /Rent is due/ });
  await expect(claim).toHaveCount(1);
  await page.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByRole("button", { name: "Snooze", exact: true }).click();
  await expect(page.getByText(/Snoozed until tomorrow/i)).toBeVisible();
  await expect(page.getByText(/due today/i)).toHaveCount(0);

  // ...and the claim is gone from the centre as well — reconcileNotifications
  // drops an entry whose cause buildReminders no longer reports.
  await bell.click();
  await expect(page.getByRole("button", { name: /Rent is due/ })).toHaveCount(0);
});
