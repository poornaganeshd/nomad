import { describe, it, expect } from "vitest";
import { parseAmount, parseVoiceTx, parseBankCsv } from "../txParsers.js";

// ---------------------------------------------------------------------------
// parseAmount
// ---------------------------------------------------------------------------
describe("parseAmount", () => {
  it("passes numbers through unchanged", () => {
    expect(parseAmount(42)).toBe(42);
    expect(parseAmount(0)).toBe(0);
  });

  it("returns NaN for null/undefined/empty", () => {
    expect(parseAmount(null)).toBeNaN();
    expect(parseAmount(undefined)).toBeNaN();
    expect(parseAmount("")).toBeNaN();
    expect(parseAmount("   ")).toBeNaN();
  });

  it("parses plain decimals", () => {
    expect(parseAmount("3.24")).toBe(3.24);
    expect(parseAmount(" 100 ")).toBe(100);
  });

  it("treats a lone comma with 1-2 trailing digits as EU decimal", () => {
    expect(parseAmount("3,24")).toBe(3.24);
    expect(parseAmount("3,2")).toBe(3.2);
  });

  it("strips US-style thousands separators", () => {
    expect(parseAmount("1,234.56")).toBe(1234.56);
    expect(parseAmount("1,000")).toBe(1000);
  });

  it("strips Indian-style grouping", () => {
    expect(parseAmount("1,23,456.78")).toBe(123456.78);
  });

  it("does not misread 3+ trailing digits after a comma as decimal", () => {
    // "1,234" → thousands, not 1.234
    expect(parseAmount("1,234")).toBe(1234);
  });
});

// ---------------------------------------------------------------------------
// parseVoiceTx
// ---------------------------------------------------------------------------
const WALLETS = [{ id: "upi_lite", name: "UPI Lite" }, { id: "bank", name: "Bank" }, { id: "cash", name: "Cash" }];
const CATS = [{ id: "food", name: "Food" }, { id: "coffee", name: "Coffee" }];

describe("parseVoiceTx", () => {
  it("returns empty object for falsy transcript", () => {
    expect(parseVoiceTx("")).toEqual({});
    expect(parseVoiceTx(null)).toEqual({});
  });

  it("extracts amount, wallet, category and cleaned note", () => {
    const r = parseVoiceTx("paid 300 for coffee from bank", { wallets: WALLETS, categories: CATS });
    expect(r.amount).toBe(300);
    expect(r.walletId).toBe("bank");
    expect(r.categoryId).toBe("coffee");
    // "from" is not in the filler list, so it survives; "bank" (a wallet alias) is stripped.
    expect(r.note).toBe("for coffee from");
  });

  it("matches wallet aliases (upi → upi_lite)", () => {
    const r = parseVoiceTx("500 upi", { wallets: WALLETS, categories: CATS });
    expect(r.amount).toBe(500);
    expect(r.walletId).toBe("upi_lite");
  });

  it("returns null fields when nothing matches", () => {
    const r = parseVoiceTx("hello world", { wallets: WALLETS, categories: CATS });
    expect(r.amount).toBeNull();
    expect(r.walletId).toBeNull();
    expect(r.categoryId).toBeNull();
  });

  it("handles ₹ and rs prefixes", () => {
    expect(parseVoiceTx("spent rs 250 cash", { wallets: WALLETS }).amount).toBe(250);
    expect(parseVoiceTx("₹99 cash", { wallets: WALLETS }).amount).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// parseBankCsv
// ---------------------------------------------------------------------------
describe("parseBankCsv", () => {
  it("returns [] for empty or header-only input", () => {
    expect(parseBankCsv("")).toEqual([]);
    expect(parseBankCsv("Date,Amount")).toEqual([]);
  });

  it("maps debit column to expense and credit column to income", () => {
    const csv = [
      "Date,Narration,Debit,Credit",
      "15/01/2024,Groceries,1200,",
      "16/01/2024,Salary,,50000",
    ].join("\n");
    const rows = parseBankCsv(csv);
    expect(rows).toEqual([
      { date: "2024-01-15", amount: 1200, note: "Groceries", type: "expense" },
      { date: "2024-01-16", amount: 50000, note: "Salary", type: "income" },
    ]);
  });

  it("falls back to a generic Amount column as expense", () => {
    const rows = parseBankCsv("Date,Description,Amount\n15/01/2024,Coffee,150");
    expect(rows).toEqual([{ date: "2024-01-15", amount: 150, note: "Coffee", type: "expense" }]);
  });

  it("does not mis-detect a Description column as Credit via the 'cr' substring", () => {
    // Regression: substring matching let "cr" hit "des(cr)iption", picking the
    // wrong column and dropping the row. Exact-match-first + length>2 guard fixes it.
    const csv = "Date,Description,Credit,Debit\n15/01/2024,Salary,5000,";
    const rows = parseBankCsv(csv);
    expect(rows).toEqual([{ date: "2024-01-15", amount: 5000, note: "Salary", type: "income" }]);
  });

  it("parses dd-mm-yy dates and quoted cells containing commas", () => {
    const csv = 'Date,Narration,Debit,Credit\n"15-01-24","Shop, Inc",100,';
    const rows = parseBankCsv(csv);
    expect(rows).toEqual([{ date: "2024-01-15", amount: 100, note: "Shop, Inc", type: "expense" }]);
  });

  it("reads DD/MM dates with day <= 12 as Indian, not US MM/DD", () => {
    // Regression: new Date("05/11/2024") parses as US May 11. For an Indian
    // statement (DD/MM) this is 5 November. day<=12 made both interpretations
    // valid, so the swap was silent.
    const csv = "Date,Narration,Debit,Credit\n05/11/2024,Diwali shopping,2500,";
    const rows = parseBankCsv(csv);
    expect(rows).toEqual([{ date: "2024-11-05", amount: 2500, note: "Diwali shopping", type: "expense" }]);
  });

  it("still parses ISO YYYY-MM-DD dates", () => {
    const rows = parseBankCsv("Date,Description,Amount\n2024-03-07,Book,300");
    expect(rows).toEqual([{ date: "2024-03-07", amount: 300, note: "Book", type: "expense" }]);
  });

  it("skips rows with no usable date or amount", () => {
    const csv = ["Date,Narration,Debit,Credit", "not-a-date,Foo,10,", "15/01/2024,Bar,0,0"].join("\n");
    expect(parseBankCsv(csv)).toEqual([]);
  });
});
