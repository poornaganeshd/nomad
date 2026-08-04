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

// Two identical expenses make a quick-add pattern. `n` controls how many times
// each is logged, which drives the chip's frequency ridge.
const qaExpense = (over, n = 2) => Array.from({ length: n }, (_, i) => ({
  id: `qa-${over.note}-${i}`, type: "expense", amount: 150, categoryId: "other",
  walletId: "bank", note: "Pattern", date: today(), balBefore: 9999, ...over,
  id2: undefined,
})).map((r, i) => ({ ...r, id: `qa-${r.note}-${i}` }));

const LONG_NOTE = "Nippon multicap (recurring monthly SIP mandate)";

test("quick add: a long note is clipped inside its chip, never off the screen", async ({ page }) => {
  await gotoLocal(page, { expenses: qaExpense({ note: LONG_NOTE }), ...funded() });
  await page.getByRole("button", { name: "Add", exact: true }).click();

  const chip = page.getByRole("button", { name: new RegExp(LONG_NOTE.slice(0, 16)) }).first();
  await expect(chip).toBeVisible();
  const m = await chip.evaluate((el) => {
    const row = el.parentElement;
    return { chipW: el.getBoundingClientRect().width, rowW: row.clientWidth, rowScroll: row.scrollWidth };
  });
  // The row wraps instead of scrolling, so nothing can hide past its right edge,
  // and the chip itself stays inside the row.
  expect(m.rowScroll).toBeLessThanOrEqual(m.rowW + 1);
  expect(m.chipW).toBeLessThanOrEqual(m.rowW);
});

test("quick add: chips carry their category colour, even when it is a CSS var", async ({ page }) => {
  // `coffee` seeds its colour as var(--warn) — alpha() used to hex-parse that,
  // get NaN, fall back to 0 and paint the chip translucent BLACK. Every tinted
  // surface for coffee / rent (var(--acc2)) was affected, which is why the chips
  // stopped looking category-coloured.
  await gotoLocal(page, {
    expenses: [...qaExpense({ note: "Filter coffee", categoryId: "coffee", amount: 90 }),
               ...qaExpense({ note: "Curd", categoryId: "food", amount: 10 })],
    ...funded(),
  });
  await page.getByRole("button", { name: "Add", exact: true }).click();

  for (const note of ["Filter coffee", "Curd"]) {
    const chip = page.getByRole("button", { name: new RegExp(note) }).first();
    const paint = await chip.evaluate((el) => {
      const rgb = (v) => (v.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const spine = el.querySelector("span");
      return {
        border: rgb(getComputedStyle(el).borderTopColor),
        spine: rgb(getComputedStyle(spine).backgroundColor),
        amount: rgb(getComputedStyle(el.querySelector("span[style*='tabular-nums']")).color),
        meterWidth: spine.getBoundingClientRect().width,
      };
    });
    // Nothing may resolve to pure black — that is precisely the NaN fallback.
    [paint.border, paint.spine, paint.amount].forEach((c) => {
      expect(c.length).toBe(3);
      expect(c.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    });
    // The frequency meter along the pill's bottom edge is drawn.
    expect(paint.meterWidth).toBeGreaterThan(0);
  }
});

test("quick add: every category wears its OWN colour, and an unknown one is not Food", async ({ page }) => {
  // Four hues that must stay visibly apart at 34px: food orange, transport cyan,
  // health mint, coffee amber (a CSS var). "ghostcat" is a category that no
  // longer exists — it used to fall back to a hardcoded coral, which is Food's
  // own hue, so a renamed or deleted category sat in the rail impersonating one.
  await gotoLocal(page, {
    expenses: [
      ...qaExpense({ note: "Curd", categoryId: "food", amount: 10 }),
      ...qaExpense({ note: "Auto to office", categoryId: "transport", amount: 60 }),
      ...qaExpense({ note: "Gym protein", categoryId: "health", amount: 180 }),
      ...qaExpense({ note: "Filter coffee", categoryId: "coffee", amount: 25 }),
      ...qaExpense({ note: "Mystery buy", categoryId: "ghostcat", amount: 44 }),
    ],
    ...funded(),
  });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("button", { name: /Quick add .*Curd/ })).toBeVisible();

  const hues = await page.evaluate(() => {
    const rgb = (v) => (v.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const out = {};
    for (const b of document.querySelectorAll("button")) {
      const label = b.getAttribute("aria-label") || "";
      if (!label.startsWith("Quick add ")) continue;
      out[label.replace(/^Quick add \S+ /, "")] = rgb(getComputedStyle(b.querySelector("span[style*='tabular-nums']")).color);
    }
    return out;
  });

  const names = Object.keys(hues);
  expect(names).toHaveLength(5);
  // Every pill's amount is a distinct colour — no two categories share a hue.
  const seen = names.map((n) => hues[n].join(","));
  expect(new Set(seen).size).toBe(5);
  // And they are far apart, not five shades of the same orange.
  const dist = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      expect(dist(hues[names[i]], hues[names[j]])).toBeGreaterThan(25);
    }
  }
});

test("quick add: one tap LOGS the pattern, with undo — no scroll to a save button", async ({ page }) => {
  // The whole point of a quick-add pattern is that nothing is left to decide:
  // amount, category, wallet and note are all settled by having logged it twice
  // already. Filling the form still made you scroll past the amount hero to a
  // save button, which was the entire cost of logging it.
  await gotoLocal(page, { expenses: qaExpense({ note: "Curd", categoryId: "food", amount: 10 }), ...funded() });
  await page.getByRole("button", { name: "Add", exact: true }).click();

  const chip = page.getByRole("button", { name: /Quick add .*Curd/ }).first();
  await chip.click();

  // The expense is written straight away...
  await expect.poll(async () => {
    const { expenses = [] } = await readBackup(page);
    return expenses.filter((e) => e.note === "Curd" && e.amount === 10).length;
  }).toBe(3); // the 2 seeded + the one just logged
  // ...the pill says so, and the form is left alone.
  await expect(chip).toContainText("Logged");
  await expect(page.locator("input[placeholder='0']").first()).toHaveValue("");
  // ...and it reverts on its own.
  await expect(chip).toContainText("Curd", { timeout: 4000 });

  // A tap that spends money has to be reversible in the same gesture.
  await page.getByRole("button", { name: "UNDO" }).click();
  await expect.poll(async () => {
    const { expenses = [] } = await readBackup(page);
    return expenses.filter((e) => e.note === "Curd" && e.amount === 10).length;
  }).toBe(2);
});

test("quick add: holding a pill fills the form instead of logging it", async ({ page }) => {
  await gotoLocal(page, { expenses: qaExpense({ note: "Curd", categoryId: "food", amount: 10 }), ...funded() });
  await page.getByRole("button", { name: "Add", exact: true }).click();

  const chip = page.getByRole("button", { name: /Quick add .*Curd/ }).first();
  const box = await chip.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();

  await expect(chip).toContainText("Filled");
  await expect(page.locator("input[placeholder='0']").first()).toHaveValue("10");
  // The hold must NOT also log it — the click that follows the release is
  // swallowed, or a hold would both fill the form and spend the money.
  const { expenses = [] } = await readBackup(page);
  expect(expenses.filter((e) => e.note === "Curd" && e.amount === 10)).toHaveLength(2);
});

test("quick add: pills stay one compact wrapping rail, category by category", async ({ page }) => {
  // The rail replaced per-category shelves that cost ~570px of scroll to save
  // typing — backwards for the one screen whose job is to be fast. It has to
  // stay short AND keep a category's patterns adjacent.
  await gotoLocal(page, {
    expenses: [
      ...qaExpense({ note: "Curd", categoryId: "food", amount: 10 }),
      ...qaExpense({ note: "Auto to office", categoryId: "transport", amount: 60 }),
      ...qaExpense({ note: "Water", categoryId: "food", amount: 20 }),
    ],
    ...funded(),
  });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("button", { name: /Quick add .*Curd/ })).toBeVisible();

  const rail = await page.evaluate(() => {
    const pills = [...document.querySelectorAll("button")]
      .filter((b) => (b.getAttribute("aria-label") || "").startsWith("Quick add "));
    const row = pills[0].parentElement;
    return {
      count: pills.length,
      order: pills.map((b) => b.getAttribute("aria-label")),
      height: row.getBoundingClientRect().height,
      pillHeight: pills[0].getBoundingClientRect().height,
      // Wraps rather than hiding pills past a horizontal scroll edge.
      scrollsSideways: row.scrollWidth > row.clientWidth + 1,
      insidePage: pills.every((b) => b.getBoundingClientRect().right <= row.getBoundingClientRect().right + 1),
    };
  });
  expect(rail.count).toBe(3);
  // Food's two patterns sit together even though Transport was logged between
  // them — the rail is ordered by category run.
  expect(rail.order[0]).toMatch(/Curd/);
  expect(rail.order[1]).toMatch(/Water/);
  expect(rail.order[2]).toMatch(/Auto to office/);
  expect(rail.pillHeight).toBeLessThanOrEqual(40);
  expect(rail.height).toBeLessThan(90);
  expect(rail.scrollsSideways).toBe(false);
  expect(rail.insidePage).toBe(true);
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
