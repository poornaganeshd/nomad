import { describe, it, expect, beforeEach } from "vitest";
import {
  buildLedger,
  reconcile,
  statementClosingBalance,
  loadImportedRefs,
  saveImportedRefs,
  IMPORTED_REFS_KEY,
} from "../bankReconcile.js";

beforeEach(() => {
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// buildLedger
// ---------------------------------------------------------------------------
describe("buildLedger", () => {
  it("scopes expenses/incomes to the wallet and assigns directions", () => {
    const ledger = buildLedger({
      expenses: [
        { id: "e1", walletId: "bank", date: "2026-06-10", amount: 450, note: "swiggy" },
        { id: "e2", walletId: "cash", date: "2026-06-10", amount: 100 },
      ],
      incomes: [{ id: "i1", walletId: "bank", date: "2026-06-01", amount: 50000, note: "salary" }],
      walletId: "bank",
    });
    expect(ledger).toEqual([
      { id: "e1", kind: "expense", date: "2026-06-10", amount: 450, dir: "debit", note: "swiggy" },
      { id: "i1", kind: "income", date: "2026-06-01", amount: 50000, dir: "credit", note: "salary" },
    ]);
  });

  it("maps transfers to debit on fromWallet and credit on toWallet", () => {
    const transfers = [{ id: "t1", fromWallet: "bank", toWallet: "upi_lite", date: "2026-06-05", amount: 2000 }];
    const bankSide = buildLedger({ transfers, walletId: "bank" });
    const liteSide = buildLedger({ transfers, walletId: "upi_lite" });
    expect(bankSide[0]).toMatchObject({ id: "t1", kind: "transfer", dir: "debit" });
    expect(liteSide[0]).toMatchObject({ id: "t1", kind: "transfer", dir: "credit" });
  });

  it("maps settlements: direction owed → credit, owe → debit", () => {
    const ledger = buildLedger({
      settlements: [
        { id: "s1", walletId: "bank", date: "2026-06-08", amount: 300, direction: "owed", splitName: "Ravi" },
        { id: "s2", walletId: "bank", date: "2026-06-09", amount: 150, direction: "owe", splitName: "Anu" },
      ],
      walletId: "bank",
    });
    expect(ledger[0]).toMatchObject({ id: "s1", dir: "credit", note: "Ravi" });
    expect(ledger[1]).toMatchObject({ id: "s2", dir: "debit", note: "Anu" });
  });

  it("merges receipt line-items sharing a groupId into one summed debit", () => {
    const ledger = buildLedger({
      expenses: [
        { id: "a", walletId: "bank", date: "2026-07-04", amount: 100, categoryId: "food", groupId: "g1", note: "Apple" },
        { id: "b", walletId: "bank", date: "2026-07-04", amount: 100, categoryId: "other", groupId: "g1", note: "Pen" },
        { id: "c", walletId: "bank", date: "2026-07-04", amount: 100, categoryId: "personal", groupId: "g1", note: "Washing Powder" },
        { id: "d", walletId: "bank", date: "2026-07-04", amount: 50, note: "chai" },
      ],
      walletId: "bank",
    });
    expect(ledger).toHaveLength(2);
    expect(ledger[0]).toMatchObject({ id: "a", amount: 300, dir: "debit" });
    expect(ledger[1]).toMatchObject({ id: "d", amount: 50 });
    // and the summed entry matches a single ₹300 statement debit
    const r = reconcile([{ date: "2026-07-04", amount: 300, type: "expense", note: "POS SUPERMART" }], ledger);
    expect(r.matched).toHaveLength(1);
    expect(r.missing).toHaveLength(0);
  });

  it("keeps a lone groupId expense (event group-expense) unmerged", () => {
    const ledger = buildLedger({
      expenses: [{ id: "e1", walletId: "bank", date: "2026-07-01", amount: 900, groupId: "gx", note: "goa dinner" }],
      walletId: "bank",
    });
    expect(ledger).toEqual([{ id: "e1", kind: "expense", date: "2026-07-01", amount: 900, dir: "debit", note: "goa dinner" }]);
  });

  it("drops entries with no date or non-positive amount", () => {
    const ledger = buildLedger({
      expenses: [
        { id: "e1", walletId: "bank", date: "", amount: 100 },
        { id: "e2", walletId: "bank", date: "2026-06-01", amount: 0 },
      ],
      walletId: "bank",
    });
    expect(ledger).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------
describe("reconcile", () => {
  const ledgerOf = (...entries) => entries.map((e, i) => ({ id: "l" + i, kind: "expense", note: "", ...e }));

  it("matches exact amount + direction on the same date", () => {
    const rows = [{ date: "2026-06-10", amount: 450, note: "UPI-SWIGGY", type: "expense" }];
    const ledger = ledgerOf({ date: "2026-06-10", amount: 450, dir: "debit" });
    const r = reconcile(rows, ledger);
    expect(r.matched).toHaveLength(1);
    expect(r.missing).toHaveLength(0);
  });

  it("matches within the ±2 day window but not beyond", () => {
    const rows = [
      { date: "2026-06-10", amount: 450, type: "expense" },
      { date: "2026-06-20", amount: 900, type: "expense" },
    ];
    const ledger = ledgerOf(
      { date: "2026-06-12", amount: 450, dir: "debit" },
      { date: "2026-06-15", amount: 900, dir: "debit" },
    );
    const r = reconcile(rows, ledger);
    expect(r.matched.map(m => m.row.amount)).toEqual([450]);
    expect(r.missing.map(m => m.amount)).toEqual([900]);
  });

  it("does not cross directions — statement credit can't match logged expense", () => {
    const rows = [{ date: "2026-06-10", amount: 450, type: "income" }];
    const ledger = ledgerOf({ date: "2026-06-10", amount: 450, dir: "debit" });
    const r = reconcile(rows, ledger);
    expect(r.matched).toHaveLength(0);
    expect(r.missing).toHaveLength(1);
  });

  it("consumes each ledger entry once — two identical debits need two logs", () => {
    const rows = [
      { date: "2026-06-10", amount: 120, type: "expense", note: "coffee 1" },
      { date: "2026-06-10", amount: 120, type: "expense", note: "coffee 2" },
    ];
    const ledger = ledgerOf({ date: "2026-06-10", amount: 120, dir: "debit" });
    const r = reconcile(rows, ledger);
    expect(r.matched).toHaveLength(1);
    expect(r.missing).toHaveLength(1);
  });

  it("prefers the nearest-date candidate", () => {
    const rows = [{ date: "2026-06-10", amount: 500, type: "expense" }];
    const ledger = ledgerOf(
      { date: "2026-06-08", amount: 500, dir: "debit" },
      { date: "2026-06-10", amount: 500, dir: "debit" },
    );
    const r = reconcile(rows, ledger);
    expect(r.matched[0].entry.date).toBe("2026-06-10");
  });

  it("skips rows whose ref was already imported", () => {
    const rows = [
      { date: "2026-06-10", amount: 450, type: "expense", ref: "UTR1" },
      { date: "2026-06-11", amount: 900, type: "expense", ref: "UTR2" },
    ];
    const r = reconcile(rows, [], { importedRefs: new Set(["UTR1"]) });
    expect(r.alreadyImported.map(x => x.ref)).toEqual(["UTR1"]);
    expect(r.missing.map(x => x.ref)).toEqual(["UTR2"]);
  });

  it("treats sub-paisa amount differences as equal (float residue)", () => {
    const rows = [{ date: "2026-06-10", amount: 0.1 + 0.2, type: "expense" }];
    const ledger = ledgerOf({ date: "2026-06-10", amount: 0.3, dir: "debit" });
    expect(reconcile(rows, ledger).matched).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// statementClosingBalance
// ---------------------------------------------------------------------------
describe("statementClosingBalance", () => {
  it("returns the balance of the latest-dated row that has one", () => {
    const rows = [
      { date: "2026-06-10", amount: 450, type: "expense", balance: 10000 },
      { date: "2026-06-15", amount: 200, type: "expense", balance: 9800 },
      { date: "2026-06-12", amount: 100, type: "expense", balance: 9900 },
    ];
    expect(statementClosingBalance(rows)).toEqual({ date: "2026-06-15", balance: 9800 });
  });

  it("returns null when no row carries a balance", () => {
    expect(statementClosingBalance([{ date: "2026-06-10", amount: 450, type: "expense" }])).toBeNull();
    expect(statementClosingBalance([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// imported-refs persistence
// ---------------------------------------------------------------------------
describe("imported refs", () => {
  it("round-trips refs scoped per wallet", () => {
    saveImportedRefs("bank", ["UTR1", "UTR2"]);
    saveImportedRefs("icici", ["UTR9"]);
    expect(loadImportedRefs("bank")).toEqual(new Set(["UTR1", "UTR2"]));
    expect(loadImportedRefs("icici")).toEqual(new Set(["UTR9"]));
  });

  it("merges with existing refs instead of overwriting", () => {
    saveImportedRefs("bank", ["UTR1"]);
    saveImportedRefs("bank", ["UTR2"]);
    expect(loadImportedRefs("bank")).toEqual(new Set(["UTR1", "UTR2"]));
  });

  it("survives corrupt storage", () => {
    localStorage.setItem(IMPORTED_REFS_KEY, "{not json");
    expect(loadImportedRefs("bank")).toEqual(new Set());
    saveImportedRefs("bank", ["UTR1"]);
    expect(loadImportedRefs("bank")).toEqual(new Set(["UTR1"]));
  });
});
