/**
 * ⭐⭐ ENGINE 8b — BATCH, EXPIRY, SERIAL AND GOODS COMING BACK.
 *
 * 🔴 THE ARITHMETIC TESTS ARE THE POINT AGAIN. FEFO ordering, an expiry
 *    boundary and a tax deadline all fail SILENTLY — nothing crashes,
 *    every screen looks right, and the loss appears months later as a
 *    write-off somebody blames the buyer for.
 *
 * ⚠️ EVERY DATE-DEPENDENT FUNCTION TAKES `today` AS AN ARGUMENT, which
 * is what makes the day a batch expires testable at all.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  BatchError,
  DEFAULT_EXPIRY_WARNING_DAYS,
  RETURN_CONDITION_META,
  SERIAL_TRANSITIONS,
  allocateFefo,
  canTransitionSerial,
  creditNoteDeadlineVerdict,
  creditNoteTaxDeadline,
  daysBetween,
  expiryFromShelfLife,
  expiryVerdict,
  itcReversalOnWriteOff,
  meetsResidualShelfLife,
  summariseBatches,
  warrantyStatus,
  warrantyUntil,
} from "@/lib/inventory/batch";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const sqlCode = (s: string) => s.replace(/--[^\n]*/g, "");

const SQL = read("SQL-FILES/0055_batch_serial_returns.sql");
const BATCH_ACTIONS = read("server/actions/batches.ts");
const RETURN_ACTIONS = read("server/actions/goods-returns.ts");
const LIB = read("lib/inventory/batch.ts");
const BATCH_PAGE = read("app/(crm)/inventory/batches/page.tsx");
const SERIAL_PAGE = read("app/(crm)/inventory/serials/page.tsx");
const RETURN_PAGE = read("app/(crm)/inventory/returns/page.tsx");
const RETURN_FORM = read("components/inventory/receive-return.tsx");
const BATCH_UI = read("components/inventory/batch-actions.tsx");
const REGISTRY = read("lib/modules/registry.ts");

/**
 * The body of one exported action, bounded by the next export.
 *
 * ⚠️ SLICING TO END-OF-FILE WOULD COUNT EVERY LATER FUNCTION'S
 * `withTenant(` too, and a "one transaction" assertion that silently
 * measures five functions is an assertion that proves nothing.
 */
function fnBody(src: string, name: string): string {
  const c = code(src);
  const start = c.indexOf(`export async function ${name}`);
  expect(start, name).toBeGreaterThan(-1);
  const after = c.indexOf("export async function", start + 10);
  return after === -1 ? c.slice(start) : c.slice(start, after);
}

const batch = (over: Partial<Parameters<typeof allocateFefo>[0]["batches"][number]> = {}) => ({
  batchNo: "B1",
  expiryDate: "2026-12-31",
  availableMilli: 100_000n,
  receivedAt: "2026-01-01T00:00:00.000Z",
  status: "active" as const,
  ...over,
});

/* ================================================================== */

describe("🔴 FEFO, not FIFO — the headline", () => {
  /**
   * 🔴 THE FAILURE THIS ENGINE EXISTS FOR. Batch A arrived first and
   * expires LAST. FIFO ships A and leaves B to die on the shelf; the
   * rotation report looks healthy the whole time.
   */
  it("ships the batch that expires first, not the one received first", () => {
    const plan = allocateFefo({
      requiredMilli: 50_000n,
      today: "2026-04-01",
      batches: [
        batch({ batchNo: "A", receivedAt: "2026-01-01T00:00:00.000Z", expiryDate: "2026-12-31" }),
        batch({ batchNo: "B", receivedAt: "2026-03-01T00:00:00.000Z", expiryDate: "2026-06-30" }),
      ],
    });
    expect(plan.allocations[0]?.batchNo).toBe("B");
  });

  /**
   * ⚠️ A BATCH WITH NO EXPIRY GOES LAST, NOT FIRST. Sorting nulls first
   * ("we don't know, use it up") ships a new receipt ahead of stock that
   * genuinely dies next month — the exact failure FEFO prevents.
   */
  it("a batch with no expiry date sorts LAST", () => {
    const plan = allocateFefo({
      requiredMilli: 250_000n,
      today: "2026-04-01",
      batches: [
        batch({ batchNo: "NOEXP", expiryDate: null }),
        batch({ batchNo: "SOON", expiryDate: "2026-05-01" }),
      ],
    });
    expect(plan.allocations.map((a) => a.batchNo)).toEqual(["SOON", "NOEXP"]);
  });

  /** FIFO survives as the tie-break, so equal expiries still rotate. */
  it("equal expiries fall back to oldest receipt, then to batch number", () => {
    const plan = allocateFefo({
      requiredMilli: 250_000n,
      today: "2026-04-01",
      batches: [
        batch({ batchNo: "Z", receivedAt: "2026-02-01T00:00:00.000Z" }),
        batch({ batchNo: "A", receivedAt: "2026-01-01T00:00:00.000Z" }),
      ],
    });
    expect(plan.allocations.map((a) => a.batchNo)).toEqual(["A", "Z"]);
  });

  /**
   * ⚠️ A picking list that changes between being printed and being
   * confirmed is a picking list nobody trusts.
   */
  it("is deterministic when everything else is equal", () => {
    const batches = [batch({ batchNo: "M" }), batch({ batchNo: "C" })];
    const a = allocateFefo({ requiredMilli: 10_000n, today: "2026-04-01", batches });
    const b = allocateFefo({ requiredMilli: 10_000n, today: "2026-04-01", batches });
    expect(a.allocations).toEqual(b.allocations);
    expect(a.allocations[0]?.batchNo).toBe("C");
  });

  /** ⚠️ A shortfall is returned, never allocated away silently. */
  it("reports a shortfall rather than quietly allocating less", () => {
    const plan = allocateFefo({
      requiredMilli: 500_000n,
      today: "2026-04-01",
      batches: [batch({ availableMilli: 100_000n })],
    });
    expect(plan.shortfallMilli).toBe(400_000n);
  });

  it("skips expired, quarantined and recalled stock, and says why", () => {
    const plan = allocateFefo({
      requiredMilli: 10_000n,
      today: "2026-04-01",
      batches: [
        batch({ batchNo: "OLD", expiryDate: "2026-01-01" }),
        batch({ batchNo: "QUAR", status: "quarantined" }),
        batch({ batchNo: "REC", status: "recalled" }),
      ],
    });
    expect(plan.allocations).toHaveLength(0);
    expect(plan.skipped.map((s) => s.batchNo).sort()).toEqual(["OLD", "QUAR", "REC"]);
    expect(plan.skipped.find((s) => s.batchNo === "REC")?.reason).toContain("recalled");
  });

  /** Shipping expired stock has to be an explicit decision. */
  it("expired stock ships only when somebody asks for it", () => {
    const args = {
      requiredMilli: 10_000n,
      today: "2026-04-01",
      batches: [batch({ expiryDate: "2026-01-01" })],
    };
    expect(allocateFefo(args).allocations).toHaveLength(0);
    expect(allocateFefo({ ...args, allowExpired: true }).allocations).toHaveLength(1);
  });

  it("refuses a non-positive request", () => {
    expect(() =>
      allocateFefo({ requiredMilli: 0n, today: "2026-04-01", batches: [] }),
    ).toThrow(BatchError);
  });
});

describe("🔴 the expiry boundary", () => {
  /**
   * 🔴 STOCK IS SALEABLE **ON** ITS EXPIRY DATE. Treating the date as
   * exclusive throws away a day of good stock on every batch a business
   * ever holds — quietly, and always in the same direction.
   */
  it("stock is still saleable on the day it expires", () => {
    const v = expiryVerdict({ expiryDate: "2026-08-13", today: "2026-08-13" });
    expect(v.saleable).toBe(true);
    expect(v.bucket).toBe("expiring_now");
    expect(v.daysLeft).toBe(0);
  });

  it("and not the day after", () => {
    const v = expiryVerdict({ expiryDate: "2026-08-13", today: "2026-08-14" });
    expect(v.saleable).toBe(false);
    expect(v.bucket).toBe("expired");
    expect(v.label).toContain("1 day ago");
  });

  it("warns inside the window and stays quiet outside it", () => {
    expect(DEFAULT_EXPIRY_WARNING_DAYS).toBe(90);
    expect(
      expiryVerdict({ expiryDate: "2026-10-01", today: "2026-08-13" }).bucket,
    ).toBe("expiring_soon");
    expect(
      expiryVerdict({ expiryDate: "2027-10-01", today: "2026-08-13" }).bucket,
    ).toBe("fresh");
  });

  /** A supermarket wants 70% of shelf life; a cement dealer wants 90 days. */
  it("the warning window is per item, not global", () => {
    expect(
      expiryVerdict({ expiryDate: "2026-09-15", today: "2026-08-13", warningDays: 10 })
        .bucket,
    ).toBe("fresh");
  });

  it("no expiry recorded is not an error", () => {
    const v = expiryVerdict({ expiryDate: null, today: "2026-08-13" });
    expect(v.bucket).toBe("no_expiry");
    expect(v.saleable).toBe(true);
  });

  it("a recalled batch is never saleable, whatever its date says", () => {
    const v = expiryVerdict({
      expiryDate: "2030-01-01",
      today: "2026-08-13",
      status: "recalled",
    });
    expect(v.saleable).toBe(false);
    expect(v.label).toBe("Recalled");
  });

  it("derives an expiry from a manufacture date and a shelf life", () => {
    expect(
      expiryFromShelfLife({ manufactureDate: "2026-01-01", shelfLifeDays: 90 }),
    ).toBe("2026-04-01");
    expect(daysBetween("2026-01-01", "2026-04-01")).toBe(90);
  });

  /**
   * ⚠️ THE RULE A RETAIL CHAIN WRITES INTO A CONTRACT. "At least 70% of
   * shelf life on delivery" — and a consignment that fails is refused at
   * the gate with the lorry already there.
   */
  it("computes residual shelf life against a contractual percentage", () => {
    const r = meetsResidualShelfLife({
      manufactureDate: "2026-01-01",
      expiryDate: "2027-01-01",
      onDate: "2026-04-01",
      requiredPercent: 70,
    });
    expect(r.residualPercent).toBe(75);
    expect(r.ok).toBe(true);

    const bad = meetsResidualShelfLife({
      manufactureDate: "2026-01-01",
      expiryDate: "2027-01-01",
      onDate: "2026-10-01",
      requiredPercent: 70,
    });
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain("refused at the customer");
  });

  /** ⚠️ Expired and expiring are never summed. */
  it("summarises expired and expiring separately", () => {
    const s = summariseBatches(
      [
        { expiryDate: "2026-01-01", quantityMilli: 1000n, valueMinor: 10_000n, status: "active" },
        { expiryDate: "2026-09-01", quantityMilli: 1000n, valueMinor: 20_000n, status: "active" },
        { expiryDate: "2030-01-01", quantityMilli: 1000n, valueMinor: 30_000n, status: "active" },
      ],
      "2026-08-13",
    );
    expect(s.expiredValueMinor).toBe(10_000n);
    expect(s.expiringValueMinor).toBe(20_000n);
    expect(s.freshValueMinor).toBe(30_000n);
  });
});

describe("🔴 section 17(5)(h) — the credit that goes back", () => {
  /**
   * ⚠️ MOST SOFTWARE DOES ONLY THE STOCK HALF. The books balance, the
   * GST position does not, and it surfaces at an assessment with
   * interest running from the original claim.
   */
  it("reverses the credit claimed on written-off goods", () => {
    const r = itcReversalOnWriteOff({
      costMinor: 10_000_00n,
      itcRateBps: 1800,
      reason: "expiry",
    });
    expect(r.reversalMinor).toBe(180_000n);
    expect(r.arguable).toBe(false);
    expect(r.explanation).toContain("s.17(5)(h)");
  });

  /**
   * ⚠️ ROUNDED HALF UP. `bigint` division truncates, which would
   * under-reverse by up to a paisa every time — always in the
   * taxpayer's favour, which is not where a rounding rule should sit by
   * accident when the counterparty is the Government.
   */
  it("rounds half up rather than truncating", () => {
    expect(
      itcReversalOnWriteOff({ costMinor: 3n, itcRateBps: 1800, reason: "expiry" })
        .reversalMinor,
    ).toBe(1n);
  });

  /** Free samples are named in the section directly. */
  it("free samples are caught by name", () => {
    const r = itcReversalOnWriteOff({
      costMinor: 100_000n,
      itcRateBps: 1200,
      reason: "sample",
    });
    expect(r.reversalMinor).toBe(12_000n);
    expect(r.explanation).toContain("Free samples");
  });

  /**
   * ⭐ THE PRODUCT DOES NOT PRETEND THE LAW IS SETTLED WHERE IT IS NOT.
   * A manufacturer whose inputs lost their identity in production has a
   * real argument, and the CBIC's own circular leaves a route open.
   */
  it("flags the manufacturer position as arguable rather than deciding it", () => {
    const r = itcReversalOnWriteOff({
      costMinor: 100_000n,
      itcRateBps: 1800,
      reason: "expiry",
      isManufactured: true,
    });
    expect(r.arguable).toBe(true);
    expect(r.explanation).toContain("real argument");
  });

  it("refuses nonsense inputs", () => {
    expect(() =>
      itcReversalOnWriteOff({ costMinor: -1n, itcRateBps: 1800, reason: "expiry" }),
    ).toThrow(BatchError);
    expect(() =>
      itcReversalOnWriteOff({ costMinor: 1n, itcRateBps: 18.5, reason: "expiry" }),
    ).toThrow(BatchError);
  });
});

describe("🔴 section 34(2) — the deadline that costs the tax", () => {
  /**
   * 🔴 THE INDIAN FINANCIAL YEAR. A supply on 30 March 2026 sits in
   * FY 2025-26 with a deadline of 30 November 2026. Two days later it
   * sits in FY 2026-27 and has a full year more. Reading the calendar
   * year gets one of those wrong every single year.
   */
  it("30 March and 2 April are a year apart", () => {
    expect(creditNoteTaxDeadline({ supplyDate: "2026-03-30" })).toBe("2026-11-30");
    expect(creditNoteTaxDeadline({ supplyDate: "2026-04-02" })).toBe("2027-11-30");
  });

  /** The annual return, if filed earlier, caps it. */
  it("an earlier annual return wins", () => {
    expect(
      creditNoteTaxDeadline({
        supplyDate: "2026-04-02",
        annualReturnFiledOn: "2027-09-15",
      }),
    ).toBe("2027-09-15");
    /** And a later one does not. */
    expect(
      creditNoteTaxDeadline({
        supplyDate: "2026-04-02",
        annualReturnFiledOn: "2027-12-31",
      }),
    ).toBe("2027-11-30");
  });

  /**
   * 🔴 AFTER THE DEADLINE THE CREDIT NOTE IS STILL LEGAL. The customer
   * still owes less; the GST is simply gone. So this is a countdown, not
   * a validation — it must never block a return.
   */
  it("a lapsed deadline reports lost tax rather than refusing the return", () => {
    /** FY 2024-25 → the window closed on 30 November 2025. */
    const v = creditNoteDeadlineVerdict({
      supplyDate: "2024-06-01",
      today: "2026-08-13",
    });
    expect(v.deadline).toBe("2025-11-30");
    expect(v.taxRecoverable).toBe(false);
    expect(v.detail).toContain("still be raised");
    expect(v.detail).toContain("cannot be recovered");
  });

  it("warns inside the last month", () => {
    const v = creditNoteDeadlineVerdict({
      supplyDate: "2025-06-01",
      today: "2026-11-15",
    });
    expect(v.taxRecoverable).toBe(true);
    expect(v.label).toContain("days to adjust");
  });

  it("names the money at stake when it is given", () => {
    const v = creditNoteDeadlineVerdict({
      supplyDate: "2024-06-01",
      today: "2026-08-13",
      taxAtStakeMinor: 180_000n,
    });
    expect(v.detail).toContain("1800.00");
  });
});

describe("🔴 serials — one unit, once", () => {
  /**
   * 🔴 `dispatched → dispatched` IS ABSENT AND THAT IS THE POINT. One
   * machine promised to two customers is found by the second one.
   */
  it("a dispatched unit cannot be dispatched again", () => {
    expect(SERIAL_TRANSITIONS.dispatched).not.toContain("dispatched");
    const v = canTransitionSerial("dispatched", "dispatched");
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("already");
  });

  it("it has to come back before it can go out again", () => {
    expect(canTransitionSerial("dispatched", "returned").allowed).toBe(true);
    expect(canTransitionSerial("returned", "in_stock").allowed).toBe(true);
  });

  /** Terminal. A scrapped unit does not come back. */
  it("scrapped is terminal", () => {
    expect(SERIAL_TRANSITIONS.scrapped).toEqual([]);
    expect(canTransitionSerial("scrapped", "in_stock").reason).toContain(
      "does not come back",
    );
  });

  /**
   * 🔴 WARRANTY RUNS FROM DISPATCH. A panel that sat in a store for eight
   * months has not used eight months of its cover, and telling a
   * customer it has is a dispute the record created.
   */
  it("warranty is counted in whole months from dispatch", () => {
    expect(warrantyUntil({ dispatchedOn: "2026-08-13", warrantyMonths: 60 })).toBe(
      "2031-08-13",
    );
  });

  /**
   * ⚠️ 31 JANUARY PLUS ONE MONTH IS 28 FEBRUARY, NOT 3 MARCH. Overflow
   * gives a customer three extra days in some months and none in others
   * — arbitrary, and impossible to explain when it is disputed.
   */
  it("clamps to the end of a shorter month rather than overflowing", () => {
    expect(warrantyUntil({ dispatchedOn: "2026-01-31", warrantyMonths: 1 })).toBe(
      "2026-02-28",
    );
    expect(warrantyUntil({ dispatchedOn: "2027-12-31", warrantyMonths: 2 })).toBe(
      "2028-02-29",
    );
  });

  it("the last day of a warranty is a full day", () => {
    expect(
      warrantyStatus({ warrantyUntil: "2026-08-13", today: "2026-08-13" }).inWarranty,
    ).toBe(true);
    expect(
      warrantyStatus({ warrantyUntil: "2026-08-13", today: "2026-08-14" }).inWarranty,
    ).toBe(false);
  });

  it("refuses a fractional warranty", () => {
    expect(() =>
      warrantyUntil({ dispatchedOn: "2026-08-13", warrantyMonths: 1.5 }),
    ).toThrow(BatchError);
  });
});

describe("⚠️ what a returned condition means", () => {
  /** 🔴 Only `saleable` goes back on the shelf. */
  it("exactly one condition is saleable", () => {
    const saleable = Object.entries(RETURN_CONDITION_META).filter(
      ([, m]) => m.saleable,
    );
    expect(saleable.map(([k]) => k)).toEqual(["saleable"]);
  });

  it("each condition carries the reason, not just a label", () => {
    for (const [k, m] of Object.entries(RETURN_CONDITION_META)) {
      expect(m.note.length, k).toBeGreaterThan(20);
    }
    expect(RETURN_CONDITION_META.damaged.note).toContain("next customer");
    expect(RETURN_CONDITION_META.expired.note).toContain("17(5)(h)");
  });
});

describe("🔴 the rules that live in the database", () => {
  /** 🔴 The unique key that makes one batch mean one thing. */
  it("one row per item and batch number", () => {
    expect(SQL).toContain("stock_batches_item_batch_unique");
  });

  /**
   * 🔴 THE TRIGGER THIS WHOLE MIGRATION EXISTS FOR: two receipts of one
   * lot with two typed expiry dates, and no error.
   */
  it("a second receipt with a different expiry is refused, naming both dates", () => {
    expect(SQL).toContain("ordence_link_stock_batch");
    expect(SQL).toContain("NEW.expiry_date <> b.expiry_date");
    expect(SQL).toContain("already recorded as expiring on %");
  });

  /**
   * ⚠️ FIRES BEFORE `trg_validate_stock_movement` — "l" sorts before
   * "v" — so a rejected movement cannot leave a batch row behind it.
   */
  it("the batch trigger is named so it fires before validation", () => {
    expect(SQL).toContain("trg_link_stock_batch");
    expect("trg_link_stock_batch" < "trg_validate_stock_movement").toBe(true);
  });

  /** A declared tracking mode that nothing enforces is a label. */
  it("a batch-tracked item cannot be received without a batch number", () => {
    expect(SQL).toContain("item.tracking_mode = 'batch'");
    expect(SQL).toContain("is batch-tracked, so this receipt needs a batch number");
  });

  it("a serial-tracked item cannot be received without serials", () => {
    expect(SQL).toContain("item.tracking_mode = 'serial'");
  });

  /** 🔴 A flag a picker never reads is not a quarantine. */
  it("nothing is issued from a recalled or written-off batch", () => {
    expect(SQL).toContain("b.status IN ('recalled', 'written_off', 'expired')");
    expect(SQL).toContain("Stock cannot be issued from it");
  });

  /** ⭐ …but the movements that REMOVE the bad stock are let through. */
  it("write-offs and reversals can still take the bad stock out", () => {
    expect(SQL).toContain("'expiry','damage','reversal','adjustment','transfer_out'");
  });

  it("one serial, one unit, once", () => {
    expect(SQL).toContain("stock_serials_unique");
  });

  /** 🔴 Two invoices with one serial is one machine promised twice. */
  it("a dispatched serial cannot be dispatched again", () => {
    expect(SQL).toContain("ordence_guard_serial_dispatch");
    expect(SQL).toContain("has already left");
  });

  /** 🔴 Damaged goods put back on the shelf are picked for the next customer. */
  it("unsaleable returns cannot land in a selling warehouse", () => {
    expect(SQL).toContain("ordence_guard_return_destination");
    expect(SQL).toContain("wh.warehouse_type <> 'quarantine'");
  });

  /** ⭐ The constraint that makes 17(5)(h) unskippable. */
  it("a zero ITC reversal has to be explained", () => {
    expect(SQL).toContain("stock_write_offs_zero_itc_is_explained");
  });

  it("a dispatched serial holds no warehouse", () => {
    expect(SQL).toContain("stock_serials_dispatched_has_left");
  });

  it("every new table is tenant-isolated and forced", () => {
    for (const t of [
      "stock_batches",
      "stock_serials",
      "goods_returns",
      "goods_return_lines",
      "stock_write_offs",
    ]) {
      expect(SQL, t).toContain(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
      expect(SQL, t).toContain(`${t}_tenant_isolation`);
    }
  });

  /**
   * ⚠️ NO STORED `days_to_expiry`. It needs a nightly job, and the night
   * the job does not run the screen says stock is fine on the day it
   * stopped being fine.
   */
  it("there is no stored days-to-expiry column", () => {
    expect(sqlCode(SQL)).not.toMatch(/days_to_expiry/);
  });

  /** ⚠️ `batch_no` stays, so no existing query had to change. */
  it("batch_id is ADDED beside batch_no, not replacing it", () => {
    expect(SQL).toContain("ADD COLUMN IF NOT EXISTS batch_id");
    expect(sqlCode(SQL)).not.toMatch(/DROP COLUMN[^;]*batch_no/);
  });
});

describe("🔴 the rules that live in the actions", () => {
  const b = code(BATCH_ACTIONS);
  const r = code(RETURN_ACTIONS);

  /**
   * 🔴 BOTH HALVES IN ONE TRANSACTION. A write-off committed without its
   * reversal is books that balance and a GST position that does not —
   * the combination nobody catches by looking.
   */
  it("the write-off and its ITC reversal are one transaction", () => {
    const fn = fnBody(BATCH_ACTIONS, "writeOffBatch");
    expect(fn.split("withTenant(").length - 1).toBe(1);
    const movementAt = fn.indexOf(".insert(stockMovements)");
    const writeOffAt = fn.indexOf(".insert(stockWriteOffs)");
    expect(movementAt).toBeGreaterThan(-1);
    expect(writeOffAt).toBeGreaterThan(movementAt);
  });

  /**
   * ⚠️ THE COST IS PRO-RATED FROM THE BALANCE, NEVER TYPED. A form field
   * lets somebody destroy ₹4,00,000 of stock and declare ₹40,000.
   */
  it("the write-off value comes from the balance, not from a form field", () => {
    const fn = fnBody(BATCH_ACTIONS, "writeOffBatch");
    expect(fn).toContain("balanceValue * wantedMilli");
    expect(fn).not.toMatch(/costMinor:\s*BigInt\(data\./);
  });

  it("a zero reversal is refused without a sentence", () => {
    expect(b).toContain("reversal.reversalMinor === 0n");
    expect(b).toContain("s.17(5)(h) reversal gets missed");
  });

  /**
   * ⚠️ A WRITTEN-OFF BATCH IS TERMINAL. Reviving it would put stock back
   * on the books that has had its credit reversed, and nothing would
   * reverse the reversal.
   */
  it("a written-off batch cannot be revived", () => {
    expect(b).toContain('batch.status === "written_off"');
    expect(b).toContain("no credit behind it");
  });

  /** ⭐ FEFO reads AVAILABLE, not on hand. Reserved stock belongs to somebody. */
  it("FEFO allocates from available, not from on hand", () => {
    const fn = fnBody(BATCH_ACTIONS, "planFefoPick");
    expect(fn).toContain("toMilli(r.quantityReserved");
  });

  /**
   * 🔴 NO EXPIRY DATE IS SENT WITH A RETURN MOVEMENT. Whoever is at the
   * door would type today plus the shelf life, resetting the clock on
   * stock that has aged at a customer.
   */
  it("a return movement never carries an expiry date", () => {
    const fn = fnBody(RETURN_ACTIONS, "receiveGoodsReturn");
    const insert = fn.slice(fn.indexOf(".insert(stockMovements)"));
    expect(insert.slice(0, 1200)).not.toContain("expiryDate");
  });

  /**
   * ⭐ THE DEADLINE RUNS FROM THE ORIGINAL SUPPLY, NOT THE RETURN. Using
   * the return date gets every case backwards.
   */
  it("the s.34(2) deadline is computed from the invoice date", () => {
    expect(r).toContain("creditNoteTaxDeadline({ supplyDate })");
    expect(r).not.toMatch(/creditNoteTaxDeadline\(\{\s*supplyDate:\s*data\.returnDate/);
  });

  it("the return and its stock movements are one transaction", () => {
    const fn = fnBody(RETURN_ACTIONS, "receiveGoodsReturn");
    expect(fn.split("withTenant(").length - 1).toBe(1);
  });

  /** ⚠️ Refused with a sentence before the trigger throws a constraint. */
  it("damaged returns into a selling warehouse are refused by name", () => {
    expect(r).toContain('wh.type !== "quarantine"');
    expect(r).toContain("picked for the next customer");
  });

  /** Every export in a "use server" file is a browser-reachable endpoint. */
  it("both action files export only async functions and types", () => {
    for (const [n, s] of [
      ["batches", b],
      ["goods-returns", r],
    ] as const) {
      expect(s.startsWith('"use server"'), n).toBe(true);
      const bad = s.match(/^export\s+(?:const|let|var|class|function)\s+\w+/gm);
      expect(bad ?? [], n).toEqual([]);
    }
  });
});

describe("⭐ the screens", () => {
  it("all three are in the menu", () => {
    for (const href of [
      "/inventory/batches",
      "/inventory/serials",
      "/inventory/returns",
    ]) {
      expect(REGISTRY, href).toContain(`href: "${href}"`);
    }
  });

  /** ⚠️ Expired and expiring are shown as two figures, never one. */
  it("the batch screen never sums expired and expiring", () => {
    const c = code(BATCH_PAGE);
    expect(c).toContain("expiredValueMinor");
    expect(c).toContain("expiringValueMinor");
    expect(c).not.toMatch(/expiredValueMinor\s*\)?\s*\+/);
  });

  /** ⭐ FEFO is named on the screen — a rule nobody knows about is a rule
   *  they find out from a write-off. */
  it("the batch screen says which rotation rule it uses", () => {
    expect(BATCH_PAGE).toContain("first-expired-first-out");
  });

  it("the returns screen shows lapsed and at-risk separately", () => {
    const c = code(RETURN_PAGE);
    expect(c).toContain("lapsed");
    expect(c).toContain("atRisk");
    expect(c).not.toMatch(/lapsed\s*\+\s*atRisk/);
  });

  /** ⚠️ Warned about BEFORE the database refuses somebody's return. */
  it("a missing quarantine warehouse is called out before it blocks anybody", () => {
    expect(RETURN_PAGE).toContain("hasQuarantine");
    expect(RETURN_PAGE).toContain("no quarantine warehouse");
  });

  /** 🔴 There is nowhere on the return form to type a new expiry. */
  it("the return form has no expiry field", () => {
    expect(RETURN_FORM).not.toMatch(/setExpiry|expiryDate:/);
    expect(RETURN_FORM).toContain("keeps the expiry it was received with");
  });

  /**
   * ⚠️ TWO IMPLEMENTATIONS OF A TAX RULE IS TWO ANSWERS, and the person
   * reading the screen would believe the wrong one.
   */
  it("the client re-uses the same pure functions the server does", () => {
    expect(BATCH_UI).toContain("itcReversalOnWriteOff");
    expect(RETURN_FORM).toContain("creditNoteDeadlineVerdict");
    expect(RETURN_FORM).toContain("RETURN_CONDITION_META");
  });

  it("the write-off form shows the tax before the button is pressed", () => {
    expect(BATCH_UI).toContain("input tax credit to reverse");
    expect(BATCH_UI).toContain("17(5)(h)");
  });

  it("the serial screen explains that warranty runs from dispatch", () => {
    expect(SERIAL_PAGE).toContain("from the day each unit shipped");
  });

  it("pages are server components and the forms are client components", () => {
    for (const p of [BATCH_PAGE, SERIAL_PAGE, RETURN_PAGE]) {
      expect(p.startsWith('"use client"')).toBe(false);
    }
    for (const c of [BATCH_UI, RETURN_FORM]) {
      expect(c.startsWith('"use client"')).toBe(true);
    }
  });

  /** The engine is pure and has no clock. */
  it("the library reads no clock", () => {
    const c = code(LIB);
    expect(c).not.toMatch(/Date\.now\(\)/);
    expect(c).not.toMatch(/new Date\(\)/);
  });
});
