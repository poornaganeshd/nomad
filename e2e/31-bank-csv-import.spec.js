import { test, expect } from "@playwright/test";
import { gotoLocal, dismissBanner, funded, readBackup, makeExpense } from "./helpers.js";

// Bank CSV import booked every row into wallets[0] — UPI Lite in the default
// seed order — so the salary credit was refused ("UPI Lite is for spending
// only") and larger expenses were more than UPI Lite can hold, under a preview that said "Bank
// wallet". And a signed Amount column imported that salary as an EXPENSE.

const today = new Date();
const d = (n) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - n);
const ddmmyyyy = (x) => `${String(x.getDate()).padStart(2, "0")}/${String(x.getMonth() + 1).padStart(2, "0")}/${x.getFullYear()}`;
const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;

test("a signed bank CSV lands in Bank, with the credit as income", async ({ page }) => {
  // One seeded (cash) expense suppresses the empty-dashboard welcome card and
  // its own "Settings" button, which would collide with the nav button.
  await gotoLocal(page, { ...funded(20000), expenses: [makeExpense({ walletId: "cash", date: iso(today) })] });
  await dismissBanner(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  const csv = [
    "Account statement for XXXX1234",
    "Txn Date,Narration,Amount",
    `${ddmmyyyy(d(3))} 09:14,SALARY SEPT,"50,000.00"`,
    `${ddmmyyyy(d(2))} 13:02,SWIGGY ORDER,-450.00`,
    `${ddmmyyyy(d(1))} 20:45,BIG BAZAAR,-7200.00`,
  ].join("\n");
  await page.locator('input[type="file"][accept=".csv"]').setInputFiles({ name: "statement.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });

  await expect(page.getByText(/PREVIEW — 3 ROWS/)).toBeVisible();
  // The preview names the wallet the rows will actually land in.
  await expect(page.getByText(/Bank wallet/)).toBeVisible();
  await page.getByRole("button", { name: "Import 3 transactions", exact: true }).click();
  await expect(page.getByText(/Imported 3 transactions/)).toBeVisible();

  await expect.poll(async () => {
    const b = await readBackup(page);
    return [(b.incomes || []).length, (b.expenses || []).filter(e => e.walletId === "bank").length];
  }, { timeout: 5000 }).toEqual([1, 2]);
  const b = await readBackup(page);
  expect(b.incomes[0]).toMatchObject({ amount: 50000, walletId: "bank", date: iso(d(3)) });
  // UPI Lite can never hold ₹7,200 (its balance caps at ₹5,000) — it only got
  // in because it went to Bank.
  expect(b.expenses.filter(e => e.walletId === "bank").map(e => e.amount).sort((x, y) => x - y)).toEqual([450, 7200]);
});
