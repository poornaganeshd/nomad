import { test, expect } from "@playwright/test";
import { funded, readBackup } from "./helpers.js";

// 1×1 transparent PNG — a real, decodable image so ReceiptPicker's canvas
// compression (compressImage → drawImage → toDataURL) succeeds in headless.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

const OCR_RESPONSE = {
  merchant: "",
  total: 200,
  currency: "INR",
  confidence: "high",
  items: [
    { name: "Movie",   qty: 1, amount: 150, category: "Entertainment" },
    { name: "Popcorn", qty: 1, amount: 50,  category: "Food" },
  ],
};

// Boot local-only, but WITH a Cloudinary cloudName so the receipt picker is
// enabled (cloudinaryEnabled = !!_creds.cloudName). No sbUrl → still localMode,
// no network. The /api/food-vision OCR call is mocked.
async function boot(page) {
  await page.route("**/api/food-vision", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(OCR_RESPONSE) })
  );
  // Same hermetic font-abort as helpers.gotoLocal — hanging remote font fetches
  // on restricted networks stall the `load` event past the test timeout.
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto("/");
  await page.evaluate((s) => {
    localStorage.clear();
    localStorage.setItem("nomad-v5", JSON.stringify(s));
    localStorage.setItem("nomad-credentials", JSON.stringify({ cloudName: "demo" }));
  }, { ...funded(100000), _modified: Date.now() });
  await page.reload();
  await expect(page.getByRole("button", { name: "Add", exact: true })).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: "Add", exact: true }).click();
}

async function attachAndExtract(page) {
  await page.getByRole("button", { name: /Attach Receipt/ }).click();
  await page.locator('input[type="file"][accept="image/*"][multiple]').setInputFiles({
    name: "receipt.png", mimeType: "image/png", buffer: PNG_1x1,
  });
  // Wait for the thumbnail to render so receiptPickerRef has committed the file
  // (hasAny=true) before extracting — otherwise the click races React state and
  // extractItems bails with "Add a receipt first".
  await expect(page.getByAltText("receipt")).toBeVisible();
  await page.getByTitle("Split into line items — from a receipt, or from your note + amount if none is attached").click();
  // Wait on the editor rows themselves (the thing the tests act on), generous
  // timeout so heavy parallel-suite load (canvas compress + OCR round-trip)
  // can't flake the extract step.
  await expect(page.getByText("RECEIPT ITEMS", { exact: false })).toBeVisible({ timeout: 25000 });
  await expect(page.getByPlaceholder("Item")).toHaveCount(2, { timeout: 25000 });
}

test("receipt-items: rows are editable (name + amount drive the live total)", async ({ page }) => {
  await boot(page);
  await attachAndExtract(page);

  // Both AI line items render as editable name inputs.
  await expect(page.getByPlaceholder("Item")).toHaveCount(2);
  await expect(page.getByPlaceholder("Item").nth(0)).toHaveValue("Movie");
  await expect(page.getByPlaceholder("Item").nth(1)).toHaveValue("Popcorn");

  // Sum matches receipt total at first.
  await expect(page.getByText(/Items sum ₹200 ≈ ₹200/)).toBeVisible();

  // Editing a per-line amount flows into the live drift check.
  // number inputs on the page: [hero amount, movie amount, popcorn amount]
  await page.locator('input[type="number"]').nth(2).fill("75");
  await expect(page.getByText(/Items sum ₹225 ≠ receipt ₹200/)).toBeVisible();
});

test("receipt-items: edit name + category, then import adds one expense per line", async ({ page }) => {
  await boot(page);
  await attachAndExtract(page);

  // Rename the first line and re-categorise it.
  await page.getByPlaceholder("Item").nth(0).fill("Cinema");
  await page.locator("select").nth(0).selectOption({ label: "Health" });

  await page.getByRole("button", { name: /Add 2 items/ }).click();
  await expect(page.getByText(/Added 2 of 2 line items/)).toBeVisible();

  // Both lines landed as real expenses with the edited fields.
  await expect.poll(async () => (await readBackup(page)).expenses?.length ?? 0).toBe(2);
  const { expenses } = await readBackup(page);
  const cinema = expenses.find((e) => e.note === "Cinema");
  const popcorn = expenses.find((e) => e.note === "Popcorn");
  expect(cinema).toBeTruthy();
  expect(cinema.categoryId).toBe("health");   // category edit persisted
  expect(popcorn).toBeTruthy();
  expect(popcorn.categoryId).toBe("food");     // "Food" hint fuzzy-matched "Food & Drinks"
});
