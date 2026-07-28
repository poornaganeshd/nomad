// Canonical Supabase column lists for every core table.
// Every toSB() call in App.jsx uses these — add a new field here and it
// propagates to ALL write paths (add, undo, first-connect sync, etc.)
// automatically. Never write an inline array in a toSB() call.
export const COLS = {
  expenses:    ["id", "amount", "categoryId", "walletId", "note", "date", "eventId", "groupId", "receipt_url", "paidBy", "balBefore", "splitWith"],
  incomes:     ["id", "amount", "sourceId", "walletId", "note", "date", "receipt_url", "balBefore"],
  transfers:   ["id", "amount", "fromWallet", "toWallet", "note", "date", "fromBalBefore", "toBalBefore"],
  settlements: ["id", "amount", "splitName", "splitId", "direction", "walletId", "date", "groupId", "eventId", "categoryId", "note", "excess"],
  // `skipped` (the write-off flag) MUST be here even though every settle path
  // also sends it in a partial {id, settled, skipped} upsert: the FULL-row write
  // paths go through toSB, and a column missing there is dropped. Without it a
  // first-connect migration, a self-heal re-upsert, or an undo-restore re-inserts
  // the row with skipped defaulting to FALSE — every written-off IOU comes back
  // as outstanding and the write-off ledger empties.
  splits:      ["id", "name", "amount", "direction", "settled", "skipped", "eventId", "groupId", "note", "categoryId", "date"],
  recurring:   ["id", "name", "amount", "categoryId", "categoryName", "walletId", "frequency", "dayOfMonth", "intervalDays", "yearMonth", "yearDay", "startDate", "active", "lastPaidDate", "lastSkippedDate"],
  events:      ["id", "name", "emoji", "date", "status", "type", "participants"],
};
