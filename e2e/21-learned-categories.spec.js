import { test, expect } from "@playwright/test";
import { gotoLocal, readBackup, funded } from "./helpers.js";

// The learned category model (src/categoryModel.js) wired through the Add form.
// The model itself is unit-tested; what these cover is the loop working on real
// state — backfill from history, learning from a save, correcting, and above all
// NOT overwriting a category you chose yourself.

const dayAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

const exp = (id, note, categoryId, n) => ({
  id, type: "expense", amount: 300, categoryId, walletId: "bank",
  note, date: dayAgo(n), balBefore: 90000,
});

// Enough repetition to clear the confidence bar — one sighting deliberately is
// not enough to start filling the form in for you.
const history = (note, categoryId) => [0, 1, 2, 3].map((i) => exp(`h${i}`, note, categoryId, i + 1));

const openAdd = async (page) => {
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.locator("input[placeholder='0']").first().fill("300");
};
const noteField = (page) => page.getByPlaceholder("Add a note…");
const savedCat = async (page, id) => (await readBackup(page)).expenses?.find((e) => e.id !== undefined && e.note && !e.id.startsWith("h") && (!id || e.note === id))?.categoryId;

test("a merchant learned from existing history fills the category in, and says why", async ({ page }) => {
  // Nothing was ever taught by hand — this all comes from the expense history
  // that was already sitting there.
  await gotoLocal(page, { ...funded(), expenses: history("Zomato dinner", "food") });
  await openAdd(page);
  await noteField(page).fill("zomato again");

  await expect(page.getByText(/Set to/)).toBeVisible();
  await expect(page.getByText(/you file .zomato. here/)).toBeVisible();

  await page.getByRole("button", { name: "Add Expense" }).click();
  await expect.poll(() => savedCat(page, "zomato again")).toBe("food");
});

test("it learns a brand new merchant from one save and applies it next time", async ({ page }) => {
  await gotoLocal(page, { ...funded(), expenses: history("Kalyan silks", "personal") });
  await openAdd(page);
  await noteField(page).fill("kalyan silks");
  await expect(page.getByText(/Set to/)).toBeVisible();
  await page.getByRole("button", { name: "Add Expense" }).click();
  await expect.poll(() => savedCat(page, "kalyan silks")).toBe("personal");

  // Same merchant again in a fresh entry — still filled, now including the save
  // we just made as evidence.
  await page.locator("input[placeholder='0']").first().fill("120");
  await noteField(page).fill("kalyan silks");
  await expect(page.getByText(/Set to/)).toBeVisible();
  await page.getByRole("button", { name: "Add Expense" }).click();
  await expect.poll(async () => (await readBackup(page)).expenses.filter((e) => e.categoryId === "personal").length).toBeGreaterThanOrEqual(6);
});

test("choosing a category yourself is never overwritten by typing", async ({ page }) => {
  // The old rule matcher called sCat() unconditionally on every keystroke, so a
  // note could stomp the category you had just picked by hand.
  await gotoLocal(page, { ...funded(), expenses: history("Zomato dinner", "food") });
  await openAdd(page);
  await page.getByRole("button", { name: /Health/ }).click();
  await noteField(page).fill("zomato again");

  // No explainer — we did not touch it.
  await expect(page.getByText(/Set to/)).toHaveCount(0);
  await page.getByRole("button", { name: "Add Expense" }).click();
  await expect.poll(() => savedCat(page, "zomato again")).toBe("health");
});

test("correcting it once is enough — the next entry follows the correction", async ({ page }) => {
  // Four saves say Entertainment. Overriding once has to stick, or the feature
  // breaks its own promise: you told it the answer and it kept suggesting the
  // other thing.
  await gotoLocal(page, { ...funded(), expenses: history("Swiggy order", "entertainment") });
  await openAdd(page);
  await noteField(page).fill("swiggy order");
  await expect(page.getByText(/Set to/)).toBeVisible();

  await page.getByRole("button", { name: /Food & Drinks/ }).click();
  await page.getByRole("button", { name: "Add Expense" }).click();
  await expect.poll(() => savedCat(page, "swiggy order")).toBe("food");

  await page.locator("input[placeholder='0']").first().fill("250");
  await noteField(page).fill("swiggy order");
  await expect(page.getByText(/Set to/)).toBeVisible();
  await page.getByRole("button", { name: "Add Expense" }).click();
  await expect.poll(async () => (await readBackup(page)).expenses.filter((e) => e.categoryId === "food").length).toBe(2);
});

test("auto-fill re-arms after a save — one manual pick does not switch it off", async ({ page }) => {
  // catId survives a save, so without re-arming, overriding once would disable
  // auto-categorization for the rest of the session.
  await gotoLocal(page, { ...funded(), expenses: history("Zomato dinner", "food") });
  await openAdd(page);
  await page.getByRole("button", { name: /Health/ }).click();
  await noteField(page).fill("chemist");
  await page.getByRole("button", { name: "Add Expense" }).click();
  await expect.poll(() => savedCat(page, "chemist")).toBe("health");

  await page.locator("input[placeholder='0']").first().fill("400");
  await noteField(page).fill("zomato again");
  await expect(page.getByText(/Set to/)).toBeVisible();
  await page.getByRole("button", { name: "Add Expense" }).click();
  await expect.poll(() => savedCat(page, "zomato again")).toBe("food");
});

test("an unknown merchant is left alone — no guess, no explainer", async ({ page }) => {
  await gotoLocal(page, { ...funded(), expenses: history("Zomato dinner", "food") });
  await openAdd(page);
  await noteField(page).fill("qwertyuiop");
  // The local model has nothing; without AI configured nothing should be claimed.
  await expect(page.getByText(/you file /)).toHaveCount(0);
});
