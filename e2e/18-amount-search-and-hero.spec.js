import { test, expect } from "@playwright/test";
import { gotoLocal, funded } from "./helpers.js";

// Two screen-reported issues:
//
//  • History search reported "0 results" for "105" with a ₹105 expense sitting
//    on the calendar directly above the box — the filter only ever looked at
//    note / category / source / split / event names, never the amount.
//  • The terrain hero sat inside the page column's 16px padding and parked a
//    flat `L430,lastY` bar across its right end from x=410, so the graph had
//    dead gutters down both sides and a level strip at the right regardless of
//    what the balance did.

const today = () => new Date().toISOString().slice(0, 10);
const day = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };

const exp = (o) => ({
  id: `x-${Math.random().toString(36).slice(2)}`, type: "expense", amount: 100,
  categoryId: "food", walletId: "bank", note: "", date: today(), balBefore: 9999, ...o,
});

const ROWS = [
  exp({ amount: 105, note: "Curd + rice", walletId: "bank" }),
  exp({ amount: 105.4, note: "Rounds down to 105", walletId: "cash" }),
  exp({ amount: 1050, note: "Gas cylinder", categoryId: "rent" }),
  exp({ amount: 330, note: "Curdrice big" }),
];

async function openSearch(page, state) {
  await gotoLocal(page, { expenses: ROWS, ...funded(), ...state });
  await page.getByRole("button", { name: "History", exact: true }).click();
  const search = page.locator("input[placeholder*='Search']");
  await search.scrollIntoViewIfNeeded();
  return search;
}

test("history search: a bare number finds transactions by amount", async ({ page }) => {
  const search = await openSearch(page);
  await search.fill("105");

  await expect(page.getByText("Curd + rice")).toBeVisible();
  // Whole-rupee queries match to the nearest rupee.
  await expect(page.getByText("Rounds down to 105")).toBeVisible();
  // ...but NOT as a digit substring, or every search becomes noise.
  await expect(page.getByText("Gas cylinder")).toHaveCount(0);
  await expect(page.getByText("2 results", { exact: false })).toBeVisible();
});

test("history search: tokens are ANDed across text and amount, in any order", async ({ page }) => {
  const search = await openSearch(page);

  await search.fill("curd 105");
  await expect(page.getByText("Curd + rice")).toBeVisible();
  await expect(page.getByText("Curdrice big")).toHaveCount(0);   // right word, wrong amount
  await expect(page.getByText("Rounds down to 105")).toHaveCount(0); // right amount, wrong word

  // Same two tokens the other way round.
  await search.fill("105 curd");
  await expect(page.getByText("Curd + rice")).toBeVisible();
});

test("history search: wallet names are searchable", async ({ page }) => {
  const search = await openSearch(page);
  await search.fill("cash");
  await expect(page.getByText("Rounds down to 105")).toBeVisible();
  await expect(page.getByText("Curd + rice")).toHaveCount(0); // that one is on Bank
});

test("history search: the box shows its own state and clears itself", async ({ page }) => {
  const search = await openSearch(page);
  await search.fill("105");

  // The Filter badge counts only the HIDDEN filters — a plain search lighting up
  // "Filter 1" read as "something you can't see is suppressing your results".
  await expect(page.getByRole("button", { name: "Filter", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(search).toHaveValue("");
  await expect(page.getByText("Gas cylinder")).toBeVisible(); // unfiltered again
});

test("history search: a numeric miss explains the rounding rule", async ({ page }) => {
  const search = await openSearch(page);
  await search.fill("777");
  await expect(page.getByText("0 results", { exact: false })).toBeVisible();
  await expect(page.getByText(/Amounts match to the nearest rupee/)).toBeVisible();
});

test("terrain hero: the graph runs edge to edge and closes into both top corners", async ({ page }) => {
  // 30 days of movement so the trail has a real shape to draw.
  const expenses = [];
  for (let i = 0; i < 30; i++) expenses.push(exp({ amount: 80 + (i * 37) % 400, date: day(i), note: `d${i}` }));
  await gotoLocal(page, { expenses, ...funded() });

  const svg = page.locator('svg[aria-label^="Balance over the last"]');
  await expect(svg).toBeVisible();

  const m = await svg.evaluate((el) => {
    const root = el.closest(".nmClip");
    return {
      svg: el.getBoundingClientRect().width,
      column: root.getBoundingClientRect().width,
      d: el.querySelector("path").getAttribute("d"),
      viewBox: el.getAttribute("viewBox"),
    };
  });

  // Full bleed: the chart is as wide as the app column, not inset by its 16px
  // padding. (The root's overflow-x: clip keeps the bleed off the page scroll.)
  expect(m.svg).toBeGreaterThanOrEqual(m.column - 1);

  // The fill closes into the top-right AND top-left corners of the viewBox.
  const [, , vbW] = m.viewBox.split(/\s+/).map(Number);
  expect(m.d).toContain(`L${vbW},0`);
  expect(m.d.trimEnd().endsWith("L0,0 Z")).toBe(true);

  // The level run-out at the right edge is short. It used to start at x=410 of
  // 430 — a ~5% dead flat strip, which is what made the hero read as flat.
  // The curve part of `d` is everything before the first L command; its final
  // coordinate pair is the last real data point.
  const curves = m.d.split(/\sL/)[0];
  const pairs = curves.match(/\d+(?:\.\d+)?,\d+(?:\.\d+)?/g);
  const lastData = parseFloat(pairs[pairs.length - 1].split(",")[0]);
  expect(vbW - lastData).toBeLessThanOrEqual(15);
});

test("terrain hero: the fill is a gradient that dissolves at the ceiling", async ({ page }) => {
  const expenses = [];
  for (let i = 0; i < 30; i++) expenses.push(exp({ amount: 80 + (i * 37) % 400, date: day(i), note: `d${i}` }));
  await gotoLocal(page, { expenses, ...funded() });

  const svg = page.locator('svg[aria-label^="Balance over the last"]');
  const fill = await svg.evaluate((el) => {
    const bands = [...el.querySelectorAll("path")].filter((p) => p.getAttribute("fill") !== "none");
    const grad = el.querySelector("#nmTerrainFill");
    const stops = [...grad.querySelectorAll("stop")].map((s) => ({
      offset: s.getAttribute("offset"),
      op: Number(getComputedStyle(s).stopOpacity),
    }));
    return { bandFills: bands.map((p) => p.getAttribute("fill")), stops };
  });

  // Every band is painted with the shared gradient, not a flat fillOpacity — a
  // flat fill is what made the area above the ridgeline a uniform slab cut off
  // by a straight line across the top (with square corners at both ends).
  expect(fill.bandFills.length).toBeGreaterThan(0);
  fill.bandFills.forEach((f) => expect(f).toBe("url(#nmTerrainFill)"));
  // Transparent at the ceiling, opaque at the ridgeline.
  expect(fill.stops[0].op).toBe(0);
  expect(fill.stops[fill.stops.length - 1].op).toBeGreaterThan(0.9);
});

test("terrain hero: the axis labels sit inside the chart", async ({ page }) => {
  await gotoLocal(page, { expenses: [exp({ amount: 200 })], ...funded() });

  const chart = page.locator('svg[aria-label^="Balance over the last"]').locator("xpath=..");
  const box = await chart.boundingBox();
  for (const label of ["30 days back", "today"]) {
    const r = await page.getByText(label, { exact: true }).boundingBox();
    // Fully within the chart's own box — they used to need a separate row above
    // it, which pushed the terrain down and drew a line of text right where the
    // fill was being cut off.
    expect(r.y).toBeGreaterThanOrEqual(box.y - 1);
    expect(r.y + r.height).toBeLessThanOrEqual(box.y + box.height + 1);
  }
});

test("wallet tiles: compact, with the share silhouette still proportional", async ({ page }) => {
  await gotoLocal(page, { expenses: [exp({ amount: 200 })], ...funded() });

  const tile = page.locator(".card-hover").filter({ hasText: /UPI Lite/i }).first();
  const m = await tile.evaluate((el) => {
    const svg = el.querySelector("svg");
    return {
      h: el.getBoundingClientRect().height,
      silhouette: svg ? svg.getBoundingClientRect().height : 0,
      // Vertical gap between the icon chip and the wallet-name label — an 11px
      // margin under a 28px chip was the single biggest dead band in the tile.
      iconGap: (() => {
        const chip = el.querySelector("span[style*='dashed']");
        const name = chip?.parentElement?.querySelector("div");
        if (!chip || !name) return null;
        return name.getBoundingClientRect().top - chip.getBoundingClientRect().bottom;
      })(),
    };
  });

  // Guard against re-inflating the tile: it was ~180px for four short lines of
  // content and now sits around 135.
  expect(m.h).toBeLessThanOrEqual(152);
  expect(m.iconGap).toBeLessThanOrEqual(9);
  // ...and the silhouette still reads as "this wallet's share of your money":
  // it must stay roughly a third of the (now shorter) tile, not swell to fill it.
  expect(m.silhouette / m.h).toBeGreaterThan(0.22);
  expect(m.silhouette / m.h).toBeLessThan(0.45);
});
