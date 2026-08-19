import { test, expect } from "@playwright/test";
import { gotoLocal, readBackup, funded } from "./helpers.js";

// Where a category comes from when you never picked one.
//
// The Add form no longer opens on a pre-selected category. That default looked
// identical to a decision, so every add carried a "is this right?" step, and any
// default left untouched was recorded as a labelled example — teaching the model
// categories nobody had ever chosen. Empty instead, resolved at save:
//
//   confident        → filled in while you type, with the reason on screen
//   plausible        → filed at save, named in the toast
//   nothing to go on → refused, with a toast asking you to pick

const dayAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

const exp = (id, note, categoryId, n, extra = {}) => ({
  id, type: "expense", amount: 300, categoryId, walletId: "bank",
  note, date: dayAgo(n), balBefore: 90000, ...extra,
});

const history = (note, categoryId, extra) => [0, 1, 2, 3].map((i) => exp(`h${i}`, note, categoryId, i + 1, extra));

// Same wallet, same amount bucket, four different categories: a history that
// makes the wallet and the amount say nothing at all.
const mixed = () => ["food", "travel", "shopping", "health"].map((c, i) => exp(`h${i}`, `spend ${i}`, c, i + 1));

const openAdd = async (page, amount = "300") => {
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.locator("input[placeholder='0']").first().fill(amount);
};
const noteField = (page) => page.getByPlaceholder("Add a note…");
const saved = async (page, note) => (await readBackup(page)).expenses?.find((e) => e.note === note);

test("no category is selected when the form opens", async ({ page }) => {
  // Four Food expenses in history — under the old smart-defaults rule that made
  // Food the pre-selected chip. The suggestion is now an ORDERING, not a pick.
  await gotoLocal(page, { ...funded(), expenses: history("Zomato dinner", "food") });
  await openAdd(page);

  await expect(page.getByText("— filed from your note if you skip it")).toBeVisible();
  // Nothing is claimed yet, so there is nothing to explain either.
  await expect(page.getByText(/Set to/)).toHaveCount(0);
});

test("forgetting the category is fine when the note is known — it files it and says so", async ({ page }) => {
  await gotoLocal(page, { ...funded(), expenses: history("Zomato dinner", "food") });
  await openAdd(page);
  await noteField(page).fill("zomato again");

  // Confident: filled in before the save, so the toast is not the first you hear of it.
  await expect(page.getByText(/Set to/)).toBeVisible();
  await page.getByRole("button", { name: "Add Expense" }).click();
  await expect.poll(async () => (await saved(page, "zomato again"))?.categoryId).toBe("food");
});

test("a merchant typed a different way still resolves", async ({ page }) => {
  // Exact-token matching alone treated this as a shop it had never seen, so it
  // fell through to the AI (absent here) and then to the user.
  await gotoLocal(page, { ...funded(), expenses: history("Swiggy order", "food") });
  await openAdd(page);
  await noteField(page).fill("swiggyinstamart");

  await page.getByRole("button", { name: "Add Expense" }).click();
  await expect.poll(async () => (await saved(page, "swiggyinstamart"))?.categoryId).toBe("food");
});

test("a note it cannot place blocks the save and asks, instead of guessing", async ({ page }) => {
  // Mixed history: the same wallet and the same amount bucket across four
  // different categories, so the context tier genuinely has nothing to say
  // either. Nothing above the bar means nothing gets filed.
  await gotoLocal(page, { ...funded(), expenses: mixed() });
  await openAdd(page);
  await noteField(page).fill("qwertyuiop");
  await page.getByRole("button", { name: "Add Expense" }).click();

  await expect(page.getByText("Pick a category — that note is new to us")).toBeVisible();
  await expect(page.getByText("— pick one, this note is new to us")).toBeVisible();
  // Nothing was written, and the form still holds everything that was typed.
  await expect.poll(async () => (await readBackup(page)).expenses.filter((e) => !e.id.startsWith("h")).length).toBe(0);
  await expect(noteField(page)).toHaveValue("qwertyuiop");

  // One tap is all it wanted.
  await page.getByRole("button", { name: /Health/ }).click();
  await page.getByRole("button", { name: "Add Expense" }).click();
  await expect.poll(async () => (await saved(page, "qwertyuiop"))?.categoryId).toBe("health");
});

test("habit alone never files anything — it only orders the picker", async ({ page }) => {
  // Every expense in history is Food, so Food leads the picker. But this entry is
  // on a wallet and in an amount range the model has never seen, and carries no
  // note, so ALL that is left is "you spend on Food a lot" — which is not evidence
  // about this transaction and must never be the reason something got filed.
  await gotoLocal(page, { ...funded(), expenses: history("Zomato dinner", "food", { walletId: "cash" }) });
  await openAdd(page, "1200");
  await page.getByRole("button", { name: /Bank/ }).click();
  await page.getByRole("button", { name: "Add Expense" }).click();

  await expect(page.getByText("Pick a category", { exact: false })).toBeVisible();
  await expect.poll(async () => (await readBackup(page)).expenses.filter((e) => !e.id.startsWith("h")).length).toBe(0);
});

test("the category clears after a save, so the next entry starts blank again", async ({ page }) => {
  await gotoLocal(page, { ...funded(), expenses: history("Zomato dinner", "food") });
  await openAdd(page);
  await page.getByRole("button", { name: /Health/ }).click();
  await noteField(page).fill("chemist");
  await page.getByRole("button", { name: "Add Expense" }).click();
  await expect.poll(async () => (await saved(page, "chemist"))?.categoryId).toBe("health");

  // A category carried over from the last save is the pre-selected default all
  // over again — and the one thing it is guaranteed to be wrong about is the
  // NEXT purchase.
  await expect(page.getByText("— filed from your note if you skip it")).toBeVisible();
});
