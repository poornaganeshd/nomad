import { describe, it, expect } from 'vitest';
import {
  UPI_LITE_MAX_BALANCE,
  exceedsUpiLiteBalance,
  defaultSettleWalletId,
  resolveRecCategory,
  settlementNetAmount,
  isSuspiciousExcess,
} from '../financeUtils.js';

// Regression "wall" for the class of bugs that kept recurring in App.jsx:
// the same decision inlined in several places, then drifting apart. Each helper
// below is the single source of truth; these tests pin the behaviour so a
// re-inlined / diverged copy fails CI instead of shipping a user-visible bug.

// Mirrors App.jsx isUpiLite for the object form.
const isUL = (w) => w?.id === 'upi_lite' || w?.upiLite === true;
const WALLETS = [
  { id: 'upi_lite', name: 'UPI Lite' },
  { id: 'bank', name: 'Bank' },
  { id: 'cash', name: 'Cash' },
];

describe('exceedsUpiLiteBalance — UPI Lite ₹5000 ceiling', () => {
  it('exposes the RBI cap as a single constant', () => {
    expect(UPI_LITE_MAX_BALANCE).toBe(5000);
  });

  it('blocks a top-up that would breach the cap (the transfer-into-UPI-Lite bug)', () => {
    // Bug: transfers credited UPI Lite with no ceiling check, unlike calibration
    // and income. Cash ₹10k → UPI Lite (at ₹0) of ₹8k must be rejected.
    expect(exceedsUpiLiteBalance(0, 8000)).toBe(true);
    expect(exceedsUpiLiteBalance(4000, 2000)).toBe(true); // 6000 > 5000
  });

  it('allows a top-up that lands at or under the cap', () => {
    expect(exceedsUpiLiteBalance(0, 5000)).toBe(false); // exactly at cap
    expect(exceedsUpiLiteBalance(3000, 1500)).toBe(false); // 4500
  });

  it('treats junk/blank inputs as zero', () => {
    expect(exceedsUpiLiteBalance(undefined, undefined)).toBe(false);
    expect(exceedsUpiLiteBalance(null, 4999.999)).toBe(false);
  });
});

describe('defaultSettleWalletId — never default a receive to UPI Lite', () => {
  it('a receive ("owed") defaults to the first non-UPI-Lite wallet', () => {
    // Bug: SettleM defaulted to wallets[0] (UPI Lite); for a receive that wallet
    // is filtered out of the buttons AND rejected on save, so a no-tap confirm
    // always errored. The default must be a wallet that can actually receive.
    expect(defaultSettleWalletId('owed', WALLETS, isUL)).toBe('bank');
  });

  it('a payment ("owe") may default to the first wallet, UPI Lite included', () => {
    expect(defaultSettleWalletId('owe', WALLETS, isUL)).toBe('upi_lite');
  });

  it('falls back to the only wallet even if it is UPI Lite (degenerate setup)', () => {
    expect(defaultSettleWalletId('owed', [{ id: 'upi_lite' }], isUL)).toBe('upi_lite');
  });
});

describe('resolveRecCategory — recurring bills use recurring categories', () => {
  const RC = [
    { id: 'ott', name: 'OTT / Subscriptions', color: '#E879F9', neon: '#F0ABFC' },
    { id: 'other_rec', name: 'Other', color: '#8A8A9A', neon: '#A0A0B0' },
  ];
  const userRec = [{ id: 'gym', name: 'Gym', color: '#34D399', neon: '#6EE7B7' }];

  it('resolves a built-in recurring id to its proper name, not the raw id', () => {
    // Bug: the home due card looked the category up in expense `cats`, so an
    // "ott" bill rendered the raw id "ott" instead of "OTT / Subscriptions".
    expect(resolveRecCategory('ott', [RC, userRec]).name).toBe('OTT / Subscriptions');
  });

  it('resolves a user-defined recurring category from the second list', () => {
    expect(resolveRecCategory('gym', [RC, userRec]).name).toBe('Gym');
  });

  it('honours a custom categoryName for an unknown id ("other_rec" custom)', () => {
    expect(resolveRecCategory('missing', [RC, userRec], 'Maid salary').name).toBe('Maid salary');
  });

  it('falls back to the raw id with a neutral colour when nothing matches', () => {
    const r = resolveRecCategory('zzz', [RC]);
    expect(r.name).toBe('zzz');
    expect(r.color).toBeTruthy();
    expect(r.neon).toBeTruthy();
  });

  it('first matching list wins (priority order)', () => {
    const a = [{ id: 'dup', name: 'From A' }];
    const b = [{ id: 'dup', name: 'From B' }];
    expect(resolveRecCategory('dup', [a, b]).name).toBe('From A');
  });
});

describe('settlementNetAmount — split ledgers reconcile net of overpay excess', () => {
  it('subtracts the excess from an overpaid settlement (owed ₹11.66, sent ₹12)', () => {
    // `amount` is the cash that moved (wallet truth); the split ledger must see
    // only the portion that pays the IOU or the extra paise become phantom credit.
    expect(settlementNetAmount({ amount: 12, excess: 0.34 })).toBe(11.66);
  });

  it('is the full amount when there is no excess (normal settlement)', () => {
    expect(settlementNetAmount({ amount: 11.66 })).toBe(11.66);
    expect(settlementNetAmount({ amount: 11.66, excess: null })).toBe(11.66);
  });

  it('rounds to paisa like every other money path', () => {
    expect(settlementNetAmount({ amount: 10.005, excess: 0.001 })).toBe(10.0);
  });

  it('treats junk/blank input as zero', () => {
    expect(settlementNetAmount(null)).toBe(0);
    expect(settlementNetAmount({})).toBe(0);
    expect(settlementNetAmount({ amount: 'x', excess: 'y' })).toBe(0);
  });
});

describe('isSuspiciousExcess — fat-finger guard on overpaid settles', () => {
  it('lets a tip-sized surplus through (₹0.34 on ₹11.66)', () => {
    expect(isSuspiciousExcess(0.34, 11.66)).toBe(false);
  });

  it('flags a surplus over 20% of the amount due (typo territory)', () => {
    // 120 typed instead of 12 → excess 108.34 on 11.66 due.
    expect(isSuspiciousExcess(108.34, 11.66)).toBe(true);
    expect(isSuspiciousExcess(3, 11.66)).toBe(true); // 3 > 20% of 11.66
  });

  it('flags any surplus above ₹50 regardless of ratio', () => {
    expect(isSuspiciousExcess(51, 1000)).toBe(true); // 5.1% but large absolute
  });

  it('allows under both thresholds (₹40 extra on ₹1000 due)', () => {
    expect(isSuspiciousExcess(40, 1000)).toBe(false);
  });

  it('no excess or junk input → never suspicious', () => {
    expect(isSuspiciousExcess(0, 11.66)).toBe(false);
    expect(isSuspiciousExcess(undefined, undefined)).toBe(false);
  });
});
