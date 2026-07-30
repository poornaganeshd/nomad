import { test, expect } from "@playwright/test";
import { gotoLocal, readBackup, funded } from "./helpers.js";

// Typeahead over previously-logged people, on both surfaces that need it, plus
// the two layout/animation regressions that shipped alongside it:
//
//  • Add form → "Split with friends": used to render EVERY known name as an
//    unfiltered wall of chips (hard-capped at 12, so person #13 was unreachable)
//    with an input that could only ever CREATE someone new — typing "a" filtered
//    nothing.
//  • New IOU → name field: substring-matched but unranked, inside an
//    overflow-x strip that showed ~3 chips with no hint the rest existed.
//  • Quick add: a long note made an unbounded-width chip, so the last chip was
//    sliced off at the viewport edge mid-word.
//  • The quick-add card MORPH left an opaque blank panel shrunk over the
//    "New IOU" button for the whole close, which read as the button breaking.

const today = () => new Date().toISOString().slice(0, 10);

// Recency order is oldest-last: Arun is the most recent, Nithish the oldest.
const PEOPLE = ["Arun", "Ayyapan", "Dharun", "Rakesh", "Nithish"];
const peopleSplits = (extra = []) => [
  ...PEOPLE.map((name, i) => ({
    id: `sp-${i}`, name, amount: 50, direction: "owed", settled: true,
    date: today(), createdAt: new Date(Date.now() - i * 864e5).toISOString(),
  })),
  ...extra,
];

async function openSplitPicker(page) {
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: /Split with friends/ }).click();
  return page.getByPlaceholder(/Search or add a friend/);
}

// Suggestion chips carry the bare name as their whole label; the create chip is
// `Add “…”` and the chosen pills expose only a "Remove X…" button, so an exact
// name regex isolates the suggestion row in DOM (= ranked) order.
const suggestionOrder = (page) =>
  page.locator("button").filter({ hasText: new RegExp(`^(${PEOPLE.join("|")}|Zoya)$`) }).allInnerTexts();

const chosen = (page, name) => page.getByRole("button", { name: `Remove ${name} from the split` });

test("split picker: typing narrows to matching people, prefix hits first", async ({ page }) => {
  await gotoLocal(page, { splits: peopleSplits(), ...funded() });
  const search = await openSplitPicker(page);

  // With no query every known person is offered (first page).
  await expect(page.getByRole("button", { name: "Nithish", exact: true })).toBeVisible();

  await search.fill("a");
  // Nithish has no "a" — it must drop out entirely.
  await expect(page.getByRole("button", { name: "Nithish", exact: true })).toHaveCount(0);
  // Arun / Ayyapan start with "a" and outrank Dharun / Rakesh, which merely
  // contain one. Within a tier, recency order is preserved.
  expect(await suggestionOrder(page)).toEqual(["Arun", "Ayyapan", "Dharun", "Rakesh"]);

  await search.fill("dh");
  expect(await suggestionOrder(page)).toEqual(["Dharun"]);
});

test("split picker: tapping a suggestion adds them, × removes them", async ({ page }) => {
  await gotoLocal(page, { splits: peopleSplits(), ...funded() });
  const search = await openSplitPicker(page);

  await search.fill("rak");
  await page.getByRole("button", { name: "Rakesh", exact: true }).click();
  await expect(chosen(page, "Rakesh")).toBeVisible();
  // The search box clears and the chosen person leaves the suggestion list.
  await expect(search).toHaveValue("");
  await expect(page.getByRole("button", { name: "Rakesh", exact: true })).toHaveCount(0);

  await chosen(page, "Rakesh").click();
  await expect(chosen(page, "Rakesh")).toHaveCount(0);
  // ...and returns to the pool.
  await expect(page.getByRole("button", { name: "Rakesh", exact: true })).toBeVisible();
});

test("split picker: Enter takes the top hit when you typed a prefix of it", async ({ page }) => {
  await gotoLocal(page, { splits: peopleSplits(), ...funded() });
  const search = await openSplitPicker(page);

  await search.fill("nit");
  await search.press("Enter");
  // Not a new person called "nit".
  await expect(chosen(page, "Nithish")).toBeVisible();

  // Different case still attaches to the canonical spelling instead of forking.
  await search.fill("rakesh");
  await search.press("Enter");
  await expect(chosen(page, "Rakesh")).toBeVisible();
});

test("split picker: an unknown name is offered as someone new", async ({ page }) => {
  await gotoLocal(page, { splits: peopleSplits(), ...funded() });
  const search = await openSplitPicker(page);

  // One character is a search, not a request to create a person named "z".
  await search.fill("z");
  await expect(page.getByRole("button", { name: /^Add “/ })).toHaveCount(0);

  await search.fill("Zoya");
  await expect(page.getByText(/No one you've split with matches “Zoya”/)).toBeVisible();
  await page.getByRole("button", { name: 'Add “Zoya”' }).click();
  await expect(chosen(page, "Zoya")).toBeVisible();
});

test("split picker: a soft-deleted IOU stops suggesting its person", async ({ page }) => {
  const ghost = {
    id: "sp-ghost", name: "Ghostly", amount: 10, direction: "owed", settled: false,
    date: today(), createdAt: new Date().toISOString(), deleted_at: new Date().toISOString(),
  };
  await gotoLocal(page, { splits: peopleSplits([ghost]), ...funded() });
  const search = await openSplitPicker(page);

  await search.fill("ghost");
  await expect(page.getByRole("button", { name: "Ghostly", exact: true })).toHaveCount(0);
  await expect(page.getByText(/No one you've split with matches/)).toBeVisible();
});

test("split picker: chosen people drive the share preview and the saved IOUs", async ({ page }) => {
  await gotoLocal(page, { splits: peopleSplits(), ...funded() });
  const search = await openSplitPicker(page);

  await search.fill("arun");
  await search.press("Enter");
  await search.fill("rakesh");
  await search.press("Enter");
  await page.locator("input[placeholder='0']").first().fill("300");

  await expect(page.getByText("₹300 ÷ 3 (you + 2) → each ₹100 · 2 IOUs on save")).toBeVisible();
  await expect(page.getByText("Splitting with · 3")).toBeVisible();

  await page.getByRole("button", { name: "Add Expense" }).click();
  await expect.poll(async () => {
    const { splits = [] } = await readBackup(page);
    return splits.filter((s) => !s.settled && s.amount === 100).length;
  }).toBe(2);
});

test("quick add: a long note is clipped inside its chip, never off the screen", async ({ page }) => {
  // Two identical expenses make a quick-add pattern; the note is deliberately
  // long enough that an unbounded chip would run past the viewport.
  const mk = (i) => ({
    id: `qa-${i}`, type: "expense", amount: 150, categoryId: "other", walletId: "bank",
    note: "Nippon multicap (recurring monthly SIP mandate)", date: today(), balBefore: 9999,
  });
  await gotoLocal(page, { expenses: [mk(1), mk(2)], ...funded() });
  await page.getByRole("button", { name: "Add", exact: true }).click();

  const row = page.getByText("Quick add").locator("xpath=following-sibling::div[1]");
  await expect(row).toBeVisible();
  // The row wraps instead of scrolling, so nothing can hide past its right edge.
  const box = await row.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(box.scroll).toBeLessThanOrEqual(box.client + 1);
  // ...and the chip itself stays inside the row.
  const chip = row.getByRole("button").first();
  const widths = await chip.evaluate((el) => ({ chip: el.getBoundingClientRect().width, row: el.parentElement.clientWidth }));
  expect(widths.chip).toBeLessThanOrEqual(widths.row);
});

test("new IOU: the name field is a ranked typeahead and a tap fills it", async ({ page }) => {
  await gotoLocal(page, { splits: peopleSplits() });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "IOU · Splits", exact: true }).click();
  await page.getByRole("button", { name: /New IOU/ }).click();

  const name = page.getByPlaceholder("Friend's name");
  await name.fill("a");
  await expect(page.getByRole("button", { name: "Use Arun" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use Nithish" })).toHaveCount(0);

  // Fuzzy tier: an in-order subsequence still finds the person rather than
  // silently offering to create a duplicate.
  await name.fill("dhrn");
  await expect(page.getByRole("button", { name: "Use Dharun" })).toBeVisible();

  await page.getByRole("button", { name: "Use Dharun" }).click();
  await expect(name).toHaveValue("Dharun");
});

// The morph card is the only element carrying a transform-origin, and its header
// is the only place "Someone new" appears (the kicker above it renders as
// "New IOU" — uppercased in CSS — which would also match the wallet's button).
const morphHeading = (page) => page.getByText("Someone new", { exact: true });
const morphCard = (page) =>
  morphHeading(page).locator("xpath=ancestor::div[contains(@style,'transform-origin')][1]");

test("new IOU morph: the card fades as it scales, so closing leaves no blank plate", async ({ page }) => {
  await gotoLocal(page, { splits: peopleSplits() });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "IOU · Splits", exact: true }).click();
  const newIou = page.getByRole("button", { name: /New IOU/ });
  await newIou.click();

  // The card fades IN as it grows, so it starts translucent and settles at 1.
  await expect
    .poll(() => morphCard(page).evaluate((el) => getComputedStyle(el).opacity), { timeout: 3000 })
    .toBe("1");
  const style = await morphCard(page).evaluate((el) => {
    const s = getComputedStyle(el);
    return { props: s.transitionProperty, dur: s.transitionDuration };
  });
  // Opacity is the load-bearing part: transform alone shrank a fully opaque
  // panel onto the button and parked it there for the whole animation.
  expect(style.props).toContain("opacity");
  expect(style.props).toContain("transform");
  // And it stays snappy — the old 380ms both ways is what read as lag.
  style.dur.split(",").forEach((d) => expect(parseFloat(d)).toBeLessThanOrEqual(0.32));

  await page.getByRole("button", { name: "Close" }).click();
  await expect(morphHeading(page)).toHaveCount(0);
  await expect(newIou).toBeVisible();
});

test("new IOU morph: reduced motion closes immediately", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await gotoLocal(page, { splits: peopleSplits() });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "IOU · Splits", exact: true }).click();
  await page.getByRole("button", { name: /New IOU/ }).click();
  await expect(morphCard(page)).toBeVisible();

  const t0 = Date.now();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(morphHeading(page)).toHaveCount(0);
  expect(Date.now() - t0).toBeLessThan(400);
});
