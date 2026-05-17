import { describe, it, expect } from "vitest";
import { COLS } from "../dbCols";

describe("COLS — canonical DB column definitions", () => {
  it("covers all expected tables", () => {
    const tables = ["expenses", "incomes", "transfers", "settlements", "splits", "recurring", "events"];
    for (const t of tables) {
      expect(COLS, `missing table: ${t}`).toHaveProperty(t);
      expect(Array.isArray(COLS[t]), `${t} must be an array`).toBe(true);
      expect(COLS[t].length, `${t} must not be empty`).toBeGreaterThan(0);
    }
  });

  it("every table starts with id", () => {
    for (const [table, cols] of Object.entries(COLS)) {
      expect(cols[0], `${table} must start with "id"`).toBe("id");
    }
  });

  it("no duplicate columns in any table", () => {
    for (const [table, cols] of Object.entries(COLS)) {
      const unique = new Set(cols);
      expect(unique.size, `${table} has duplicate column names`).toBe(cols.length);
    }
  });

  it("expenses includes receipt_url, paidBy, and balBefore", () => {
    expect(COLS.expenses).toContain("receipt_url");
    expect(COLS.expenses).toContain("paidBy");
    expect(COLS.expenses).toContain("balBefore");
    expect(COLS.expenses).toContain("categoryId");
    expect(COLS.expenses).toContain("walletId");
    expect(COLS.expenses).toContain("date");
  });

  it("incomes includes receipt_url and balBefore", () => {
    expect(COLS.incomes).toContain("receipt_url");
    expect(COLS.incomes).toContain("balBefore");
    expect(COLS.incomes).toContain("sourceId");
    expect(COLS.incomes).toContain("walletId");
  });

  it("transfers includes fromBalBefore and toBalBefore", () => {
    expect(COLS.transfers).toContain("fromBalBefore");
    expect(COLS.transfers).toContain("toBalBefore");
    expect(COLS.transfers).toContain("fromWallet");
    expect(COLS.transfers).toContain("toWallet");
  });

  it("splits includes note (regression: undo path was missing it)", () => {
    expect(COLS.splits).toContain("note");
    expect(COLS.splits).toContain("direction");
    expect(COLS.splits).toContain("settled");
  });

  it("recurring includes all scheduling fields", () => {
    const required = [
      "frequency", "dayOfMonth", "intervalDays",
      "yearMonth", "yearDay", "startDate",
      "active", "lastPaidDate", "lastSkippedDate",
    ];
    for (const f of required) {
      expect(COLS.recurring, `recurring must include "${f}"`).toContain(f);
    }
  });

  it("events includes participants", () => {
    expect(COLS.events).toContain("participants");
    expect(COLS.events).toContain("status");
    expect(COLS.events).toContain("type");
  });

  it("all column names are non-empty strings", () => {
    for (const [table, cols] of Object.entries(COLS)) {
      for (const col of cols) {
        expect(typeof col, `${table}: column must be a string`).toBe("string");
        expect(col.trim().length, `${table}: column name must not be empty`).toBeGreaterThan(0);
      }
    }
  });
});
