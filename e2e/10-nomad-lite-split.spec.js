import { test, expect } from "@playwright/test";
import { gotoLocal } from "./helpers.js";

// NOMAD Lite "Current Split" — reached via Events → Open NOMAD Lite → preset.
// Lite state lives in its own localStorage key (nomad-lite-v1), seeded here after
// boot; the preset reads it on mount. These cover the redesigned segmented flow
// and the bugs fixed this round (effective %, even-split note, per-person math).

const LITE = {
  scenarioName: "June 2026", totalBill: "2400", baseBill: "600", baseTouched: true,
  mode: "auto", manualExtra: "", baseRate: "200",
  people: [{ id: "P1", name: "Aarav" }, { id: "P2", name: "Diya" }, { id: "P3", name: "Kiran" }],
  baseMembers: ["P1", "P2", "P3"],
  groups: [
    { id: "G1", name: "Air conditioner", pct: 50, members: ["P1"], note: "", icon: "" },
    { id: "G2", name: "Geyser", pct: 17, members: ["P2", "P3"], note: "", icon: "" },
    { id: "G3", name: "Induction", pct: 33, members: ["P2"], note: "", icon: "" },
  ],
};

async function openLite(page, lite = LITE) {
  await gotoLocal(page);
  await page.evaluate((d) => localStorage.setItem("nomad-lite-v1", JSON.stringify(d)), lite);
  await page.getByRole("button", { name: "Events", exact: true }).click();
  await page.getByRole("button", { name: "Open NOMAD Lite" }).click();
  await page.getByRole("button", { name: /Current Split/ }).click();
}

test("computes per-person totals and shows a balanced hero", async ({ page }) => {
  await openLite(page);
  await expect(page.getByText("Balanced", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Split", exact: true }).click();
  // base 200 each; AC 900→Aarav, Geyser 306→Diya+Kiran (153 ea), Induction 594→Diya
  await expect(page.getByText("₹1,100.00")).toBeVisible(); // Aarav
  await expect(page.getByText("₹947.00")).toBeVisible();   // Diya
  await expect(page.getByText("₹353.00")).toBeVisible();   // Kiran
});

test("Extras rows show the effective (normalized) share, not the raw pct", async ({ page }) => {
  await openLite(page);
  await page.getByRole("button", { name: "Extras", exact: true }).click();
  await expect(page.getByText(/50% of extra/)).toBeVisible();
});

test("even split shows a note in People and ignores base/appliances", async ({ page }) => {
  await openLite(page);
  await page.getByRole("button", { name: "Split evenly", exact: true }).click();
  await page.getByRole("button", { name: "People", exact: true }).click();
  await expect(page.getByText(/Even split is on/)).toBeVisible();
});

test("adding an appliance opens its editor ready to edit", async ({ page }) => {
  await openLite(page, { ...LITE, groups: [] });
  await page.getByRole("button", { name: "Extras", exact: true }).click();
  await page.getByRole("button", { name: /Add appliance/ }).click();
  await expect(page.locator("input[value='New appliance']")).toBeVisible();
  await expect(page.getByRole("button", { name: /Remove appliance/ })).toBeVisible();
});

test("Tip & Tax Split preset computes per-head total", async ({ page }) => {
  await gotoLocal(page);
  await page.getByRole("button", { name: "Events", exact: true }).click();
  await page.getByRole("button", { name: "Open NOMAD Lite" }).click();
  await page.getByRole("button", { name: /Tip & Tax Split/ }).click();
  // bill 1000 + default 10% tip (100) + 5% tax (50) = 1150, default 2 people → 575
  await page.locator("input[placeholder='0']").first().fill("1000");
  await expect(page.getByText("₹575.00")).toBeVisible();
});
