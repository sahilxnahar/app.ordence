/**
 * ⭐⭐ TRADING, BATCH 1 — STOCK TRANSFERS AND LANDED COST.
 *
 * 🔴 BOTH ENGINES FAIL SILENTLY WHEN THEY FAIL. A branch transfer
 *    recorded on the wrong document understates one GSTIN's outward
 *    supply and denies the other its credit; a freight bill capitalised
 *    onto the wrong half of a consignment overstates closing stock and
 *    the margin already reported. Nothing errors in either case, and the
 *    totals still add up.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  TRANSFER_TRANSITIONS,
  TransferError,
  canTransitionTransfer,
  rule28Value,
  transferHealth,
  transferTaxTreatment,
  transferVariance,
} from "@/lib/inventory/transfer";
import {
  LANDED_COST_TYPES,
  LandedCostError,
  apportion,
  marginAgainstLanded,
  splitBetweenStockAndCogs,
  summariseLandedCost,
} from "@/lib/inventory/landed-cost";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const sqlCode = (s: string) => s.replace(/--[^\n]*/g, "");

const SQL = read("SQL-FILES/0056_transfers_landed_cost.sql");
const TRANSFER_ACTIONS = read("server/actions/transfers.ts");
const LANDED_ACTIONS = read("server/actions/landed-cost.ts");
const TRANSFER_LIB = read("lib/inventory/transfer.ts");
const LANDED_LIB = read("lib/inventory/landed-cost.ts");
const TRANSFER_PAGE = read("app/(crm)/inventory/transfers/page.tsx");
const TRANSFER_DETAIL = read("app/(crm)/inventory/transfers/[id]/page.tsx");
const LANDED_PAGE = read("app/(crm)/purchases/landed-cost/page.tsx");
const TRANSFER_UI = read("components/inventory/transfer-actions.tsx");
const REGISTRY = read("lib/modules/registry.ts");

function fnBody(src: string, name: string): string {
  const c = code(src);
  const start = c.indexOf(`export async function ${name}`);
  expect(start, name).toBeGreaterThan(-1);
  const after = c.indexOf("export async function", start + 10);
  return after === -1 ? c.slice(start) : c.slice(start, after);
}

const PUNE = "27AAACO1234A1Z5";
const BLR = "29AAACO1234A1Z1";
const PUNE_SEZ = "27AAACO1234A2Z2";

/* ================================================================== */

describe("🔴 a transfer between our own godowns can be a taxable supply", () => {
  /**
   * 🔴 Section 25(4) makes each registration a distinct person; Schedule
   * I para 2 makes a supply between them taxable with no consideration.
   */
  it("two GSTINs means a tax invoice with IGST", () => {
    const t = transferTaxTreatment({
      fromGstin: PUNE,
      toGstin: BLR,
      fromStateCode: "27",
      toStateCode: "29",
    });
    expect(t.isTaxableSupply).toBe(true);
    expect(t.documentType).toBe("tax_invoice");
    expect(t.taxKind).toBe("igst");
    expect(t.authority).toContain("25(4)");
    expect(t.authority).toContain("Schedule I");
  });

  /**
   * ⚠️ THE INTUITIVE MISTAKE, IN BOTH DIRECTIONS. Two godowns in
   * DIFFERENT states under ONE GSTIN are still not a supply.
   */
  it("one GSTIN across two states is NOT a supply", () => {
    const t = transferTaxTreatment({
      fromGstin: PUNE,
      toGstin: PUNE,
      fromStateCode: "27",
      toStateCode: "29",
    });
    expect(t.isTaxableSupply).toBe(false);
    expect(t.documentType).toBe("delivery_challan");
    expect(t.taxKind).toBe("none");
    expect(t.authority).toContain("Rule 55");
  });

  /** ⚠️ And two GSTINs in ONE state ARE — an SEZ unit, or two verticals. */
  it("two GSTINs in one state IS a supply, with CGST and SGST", () => {
    const t = transferTaxTreatment({
      fromGstin: PUNE,
      toGstin: PUNE_SEZ,
      fromStateCode: "27",
      toStateCode: "27",
    });
    expect(t.isTaxableSupply).toBe(true);
    expect(t.taxKind).toBe("cgst_sgst");
  });

  /**
   * ⚠️ A MISSING GSTIN IS NOT "DIFFERENT". Treating it as different
   * would raise a tax invoice for every internal move in a workspace
   * that has not filled the field in.
   */
  it("a godown with no GSTIN recorded is treated as the same registration", () => {
    const t = transferTaxTreatment({
      fromGstin: PUNE,
      toGstin: null,
      fromStateCode: "27",
      toStateCode: "29",
    });
    expect(t.isTaxableSupply).toBe(false);
  });
});

describe("⭐ Rule 28 — what value to put on it", () => {
  /**
   * ⚠️ THE SECOND PROVISO IS WHAT MAKES BRANCH TRANSFERS WORKABLE: where
   * the recipient is eligible for full ITC, the invoice value IS the
   * open market value.
   */
  it("cost is a fine value when the receiving branch has full credit", () => {
    const v = rule28Value({ costMinor: 100_000n, recipientHasFullItc: true });
    expect(v.valueMinor).toBe(100_000n);
    expect(v.needsOpenMarketValue).toBe(false);
    expect(v.reason).toContain("second proviso");
  });

  /**
   * 🔴 AND WHERE IT IS NOT, THE PRODUCT SAYS SO RATHER THAN INVENTING A
   *    NUMBER. An open market value is real work somebody has to do.
   */
  it("flags that an open market value is needed when the proviso does not apply", () => {
    const v = rule28Value({ costMinor: 100_000n, recipientHasFullItc: false });
    expect(v.needsOpenMarketValue).toBe(true);
    expect(v.reason).toContain("placeholder");
  });

  it("an explicit open market value wins when one is given", () => {
    const v = rule28Value({
      costMinor: 100_000n,
      recipientHasFullItc: false,
      openMarketValueMinor: 130_000n,
    });
    expect(v.valueMinor).toBe(130_000n);
    expect(v.needsOpenMarketValue).toBe(false);
  });
});

describe("🔴 what left and never arrived", () => {
  const line = (over: Record<string, unknown> = {}) => ({
    lineNo: 1,
    description: "Cement",
    qtyDispatchedMilli: 100_000n,
    qtyReceivedMilli: 98_000n,
    unitCostMinor: 35_000n,
    ...over,
  });

  /**
   * 🔴 THE FAILURE THIS EXISTS FOR: receiving 98 and moving on makes the
   * two missing bags simply gone, with nothing naming why.
   */
  it("names the shortfall and values it", () => {
    const v = transferVariance([line()]);
    expect(v.lines).toHaveLength(1);
    expect(v.totalShortMilli).toBe(2_000n);
    /** 2 units at ₹350.00 = ₹700.00 */
    expect(v.totalLossMinor).toBe(70_000n);
  });

  /** ⚠️ More arriving than left is stock from nowhere. */
  it("refuses an excess rather than netting it", () => {
    expect(() =>
      transferVariance([line({ qtyReceivedMilli: 105_000n })]),
    ).toThrow(TransferError);
  });

  it("an uncounted line is reported, not assumed complete", () => {
    const v = transferVariance([line({ qtyReceivedMilli: null })]);
    expect(v.fullyCounted).toBe(false);
    expect(v.lines).toHaveLength(0);
  });

  it("a clean receipt has no variance", () => {
    const v = transferVariance([line({ qtyReceivedMilli: 100_000n })]);
    expect(v.lines).toHaveLength(0);
    expect(v.fullyCounted).toBe(true);
  });
});

describe("🔴 the state machine", () => {
  /**
   * 🔴 A DISPATCHED TRANSFER CANNOT BE CANCELLED. The goods are on a
   *    lorry, and cancelling would leave stock in a transit warehouse
   *    that no document accounts for.
   */
  it("dispatched cannot be cancelled, and it says why", () => {
    expect(TRANSFER_TRANSITIONS.dispatched).not.toContain("cancelled");
    const v = canTransitionTransfer("dispatched", "cancelled");
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("already left");
  });

  it("draft can be dispatched or cancelled", () => {
    expect(canTransitionTransfer("draft", "dispatched").allowed).toBe(true);
    expect(canTransitionTransfer("draft", "cancelled").allowed).toBe(true);
  });

  it("received is terminal", () => {
    expect(TRANSFER_TRANSITIONS.received).toEqual([]);
  });
});

describe("⚠️ how long it has been on the road", () => {
  const now = new Date("2026-08-13T10:00:00Z");

  it("a long transit is flagged as a receipt nobody entered", () => {
    const h = transferHealth({
      status: "dispatched",
      dispatchedAt: new Date("2026-07-20T10:00:00Z"),
      now,
    });
    expect(h.tone).toBe("danger");
    expect(h.detail).toContain("receipt was never entered");
  });

  it("a normal transit warns without alarming", () => {
    const h = transferHealth({
      status: "dispatched",
      dispatchedAt: new Date("2026-08-12T10:00:00Z"),
      now,
    });
    expect(h.tone).toBe("warn");
    expect(h.detail).toContain("neither godown");
  });
});

/* ================================================================== */

describe("🔴 recoverable taxes never enter inventory", () => {
  /**
   * 🔴 THE ONE EVERYBODY CAPITALISES BY ACCIDENT. IGST on imports
   *    arrives on the same bill of entry as basic customs duty.
   */
  it("IGST on imports is recoverable and customs duty is not", () => {
    expect(LANDED_COST_TYPES.customs_igst.recoverable).toBe(true);
    expect(LANDED_COST_TYPES.customs_duty.recoverable).toBe(false);
    expect(LANDED_COST_TYPES.customs_igst.note).toContain("RECOVERABLE");
  });

  it("exactly one charge type is recoverable", () => {
    const recoverable = Object.entries(LANDED_COST_TYPES)
      .filter(([, m]) => m.recoverable)
      .map(([k]) => k);
    expect(recoverable).toEqual(["customs_igst"]);
  });

  /**
   * ⚠️ FREIGHT BY WEIGHT, NOT VALUE. A container of feathers and lead
   * apportioned by value gives the lead almost no freight.
   */
  it("freight defaults to weight, insurance to value", () => {
    expect(LANDED_COST_TYPES.freight_inward.defaultBasis).toBe("weight");
    expect(LANDED_COST_TYPES.insurance.defaultBasis).toBe("value");
  });

  it("the summary keeps capitalised and recoverable apart", () => {
    const s = summariseLandedCost({
      purchaseMinor: 10_000_000n,
      charges: [
        { amountMinor: 500_000n, recoverable: false },
        { amountMinor: 1_800_000n, recoverable: true },
      ],
    });
    expect(s.capitalisedMinor).toBe(500_000n);
    expect(s.recoverableMinor).toBe(1_800_000n);
    /** 🔴 The recoverable half is NOT in the landed figure. */
    expect(s.landedMinor).toBe(10_500_000n);
    expect(s.upliftBps).toBe(500);
    expect(s.explanation).toContain("input credit, not a cost");
  });
});

describe("🔴 largest remainder — the apportionment sums exactly", () => {
  /**
   * 🔴 ₹10,000 over three equal lines is 3,333.33 × 3 = 9,999.99. The
   *    missing paisa has to land somewhere, or the total capitalised
   *    does not equal the invoice that was paid.
   */
  it("three equal lines still sum to the whole charge", () => {
    const out = apportion({
      totalMinor: 1_000_000n,
      lines: [
        { key: "a", basis: 1n },
        { key: "b", basis: 1n },
        { key: "c", basis: 1n },
      ],
    });
    const total = out.reduce((s, o) => s + o.allocatedMinor, 0n);
    expect(total).toBe(1_000_000n);
    expect(out.map((o) => o.allocatedMinor).sort()).toEqual([
      333_333n,
      333_333n,
      333_334n,
    ]);
  });

  it("an awkward ratio still sums exactly", () => {
    for (const total of [1n, 7n, 99n, 100_003n, 987_654_321n]) {
      const out = apportion({
        totalMinor: total,
        lines: [
          { key: "a", basis: 17n },
          { key: "b", basis: 41n },
          { key: "c", basis: 3n },
          { key: "d", basis: 129n },
        ],
      });
      expect(out.reduce((s, o) => s + o.allocatedMinor, 0n), String(total)).toBe(total);
    }
  });

  /**
   * ⚠️ A re-run that produces a different apportionment is a re-run
   * nobody trusts. The key is the second sort field for exactly this.
   */
  it("is deterministic across runs", () => {
    const lines = [
      { key: "z", basis: 1n },
      { key: "a", basis: 1n },
    ];
    const a = apportion({ totalMinor: 101n, lines });
    const b = apportion({ totalMinor: 101n, lines });
    expect(a).toEqual(b);
    /** The extra paisa goes to the lower key when remainders tie. */
    expect(a.find((x) => x.key === "a")?.allocatedMinor).toBe(51n);
  });

  /** ⚠️ A free-sample line has no value and should carry no freight. */
  it("a zero-basis line gets nothing", () => {
    const out = apportion({
      totalMinor: 1000n,
      lines: [
        { key: "paid", basis: 100n },
        { key: "free", basis: 0n },
      ],
    });
    expect(out.find((o) => o.key === "free")?.allocatedMinor).toBe(0n);
    expect(out.find((o) => o.key === "paid")?.allocatedMinor).toBe(1000n);
  });

  /** ⚠️ Nobody entered weights — splitting equally is the honest fallback. */
  it("falls back to an equal split when every basis is zero", () => {
    const out = apportion({
      totalMinor: 100n,
      lines: [
        { key: "a", basis: 0n },
        { key: "b", basis: 0n },
        { key: "c", basis: 0n },
      ],
    });
    expect(out.reduce((s, o) => s + o.allocatedMinor, 0n)).toBe(100n);
  });

  it("refuses a negative charge or a negative basis", () => {
    expect(() =>
      apportion({ totalMinor: -1n, lines: [{ key: "a", basis: 1n }] }),
    ).toThrow(LandedCostError);
    expect(() =>
      apportion({ totalMinor: 100n, lines: [{ key: "a", basis: -1n }] }),
    ).toThrow(LandedCostError);
    expect(() => apportion({ totalMinor: 100n, lines: [] })).toThrow(LandedCostError);
  });
});

describe("🔴 the freight bill arrives after the goods", () => {
  /**
   * 🔴 PUTTING ALL OF IT ON WHAT IS LEFT IS WRONG TWICE — it overstates
   *    closing stock AND the margin already reported, and the total is
   *    right so nothing looks odd.
   */
  it("splits the charge in proportion to what is still on hand", () => {
    const s = splitBetweenStockAndCogs({
      allocatedMinor: 100_000n,
      qtyReceivedMilli: 100_000n,
      qtyStillOnHandMilli: 40_000n,
    });
    expect(s.toInventoryMinor).toBe(40_000n);
    expect(s.toCogsMinor).toBe(60_000n);
    expect(s.soldFraction).toBe("60.0%");
    expect(s.explanation).toContain("overstate");
  });

  /**
   * ⚠️ COGS IS THE REMAINDER, never computed independently. Two
   * roundings that are supposed to add to a total do not.
   */
  it("the two halves always add back to the whole charge", () => {
    for (const onHand of [0n, 1n, 33_333n, 66_667n, 99_999n, 100_000n]) {
      const s = splitBetweenStockAndCogs({
        allocatedMinor: 100_003n,
        qtyReceivedMilli: 100_000n,
        qtyStillOnHandMilli: onHand,
      });
      expect(s.toInventoryMinor + s.toCogsMinor, String(onHand)).toBe(100_003n);
    }
  });

  it("nothing sold means the whole charge is capitalised", () => {
    const s = splitBetweenStockAndCogs({
      allocatedMinor: 100_000n,
      qtyReceivedMilli: 100_000n,
      qtyStillOnHandMilli: 100_000n,
    });
    expect(s.toInventoryMinor).toBe(100_000n);
    expect(s.toCogsMinor).toBe(0n);
  });

  /**
   * ⚠️ MORE ON HAND THAN CAME IN means the balance is picking up another
   * consignment, and apportioning against it would push this freight
   * onto goods it never touched.
   */
  it("refuses to split against stock from another consignment", () => {
    expect(() =>
      splitBetweenStockAndCogs({
        allocatedMinor: 100n,
        qtyReceivedMilli: 100n,
        qtyStillOnHandMilli: 500n,
      }),
    ).toThrow(LandedCostError);
  });
});

describe("⚠️ the margin check nobody runs until it is too late", () => {
  it("catches a price that is profitable on the invoice and a loss on landing", () => {
    const r = marginAgainstLanded({
      sellingPriceMinor: 10_500n,
      landedUnitCostMinor: 10_800n,
    });
    expect(r.belowCost).toBe(true);
    expect(r.detail).toContain("below what the goods actually cost");
  });

  it("reports the margin against landed cost, not invoice price", () => {
    const r = marginAgainstLanded({
      sellingPriceMinor: 12_000n,
      landedUnitCostMinor: 10_800n,
    });
    expect(r.belowCost).toBe(false);
    expect(r.detail).toContain("landed cost");
  });
});

describe("🔴 the rules that live in the database", () => {
  /** 🔴 A taxable transfer is an invoice, not a challan. */
  it("a taxable transfer must carry a tax invoice and both GSTINs", () => {
    expect(SQL).toContain("stock_transfers_taxable_needs_invoice");
    expect(SQL).toContain("stock_transfers_taxable_names_both_gstins");
  });

  /** ⚠️ And the mirror — a challan carries no tax. */
  it("a delivery challan carries no tax", () => {
    expect(SQL).toContain("stock_transfers_challan_is_untaxed");
  });

  it("goods cannot arrive before they left", () => {
    expect(SQL).toContain("stock_transfers_received_after_dispatch");
  });

  /** 🔴 An excess receipt creates stock out of nothing. */
  it("more cannot arrive than left", () => {
    expect(SQL).toContain("stock_transfer_lines_no_excess");
    expect(SQL).toContain("qty_received <= qty_dispatched");
  });

  /**
   * 🔴 THE GUARD THAT MAKES THE TRANSIT MODEL WORK. If a sale could be
   *    posted against a transit location, the whole thing collapses back
   *    to stock sold from a lorry.
   */
  it("nothing is sold out of a transit location", () => {
    expect(SQL).toContain("ordence_guard_transit_warehouse");
    expect(SQL).toContain("wh.warehouse_type <> 'transit'");
    expect(SQL).toContain("is a transit location");
  });

  /** 🔴 A recoverable charge cannot be capitalised. */
  it("a recoverable charge cannot reach applied status", () => {
    expect(SQL).toContain("landed_costs_recoverable_is_not_capitalised");
  });

  /** 🔴 The split cannot lose a paisa. */
  it("the inventory and COGS halves must add to the allocation", () => {
    expect(SQL).toContain("landed_cost_allocations_split_is_whole");
    expect(SQL).toContain("to_inventory_minor + to_cogs_minor = allocated_minor");
  });

  it("a transfer cannot move stock to where it already is", () => {
    expect(SQL).toContain("stock_transfers_two_places");
  });

  it("every new table is tenant-isolated and forced", () => {
    for (const t of [
      "stock_transfers",
      "stock_transfer_lines",
      "landed_costs",
      "landed_cost_allocations",
    ]) {
      expect(SQL, t).toContain(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
      expect(SQL, t).toContain(`${t}_tenant_isolation`);
    }
  });

  /**
   * ⚠️ NO SECOND ANSWER TO "WHAT DO WE OWN". Goods in transit are a real
   * balance in a real warehouse, so the existing trigger, valuation and
   * stock counts all handle them unchanged.
   */
  it("there is no separate in-transit quantity column", () => {
    expect(sqlCode(SQL)).not.toMatch(/quantity_in_transit/);
  });
});

describe("🔴 the rules that live in the actions", () => {
  const t = code(TRANSFER_ACTIONS);
  const l = code(LANDED_ACTIONS);

  /**
   * 🔴 IF THE OUT COMMITTED AND THE IN DID NOT, the stock would be gone
   *    from the source and in no location at all.
   */
  it("dispatch posts both movements in one transaction", () => {
    const fn = fnBody(TRANSFER_ACTIONS, "dispatchTransfer");
    expect(fn.split("withTenant(").length - 1).toBe(1);
    expect(fn).toContain('reason: "transfer_out"');
    expect(fn).toContain('reason: "transfer_in"');
  });

  it("receipt is also one transaction", () => {
    const fn = fnBody(TRANSFER_ACTIONS, "receiveTransfer");
    expect(fn.split("withTenant(").length - 1).toBe(1);
  });

  /** ⭐ The value travels with the goods so the far end prices them right. */
  it("the unit cost travels into transit with the stock", () => {
    const fn = fnBody(TRANSFER_ACTIONS, "dispatchTransfer");
    expect(fn.split("unitCostMinor: l.unitCostMinor").length - 1).toBe(2);
  });

  /**
   * 🔴 A SHORTAGE NEEDS A NAMED HUMAN. It is a loss AND an ITC reversal
   *    under s.17(5)(h), which is not something a receipt screen should
   *    do quietly.
   */
  it("a shortfall is refused without an approver", () => {
    const fn = fnBody(TRANSFER_ACTIONS, "receiveTransfer");
    expect(fn).toContain("!data.varianceApprovedBy");
    expect(fn).toContain("17(5)(h)");
  });

  it("the shortfall leaves transit as a loss, not as nothing", () => {
    const fn = fnBody(TRANSFER_ACTIONS, "receiveTransfer");
    expect(fn).toContain("itcReversalOnWriteOff");
    expect(fn).toContain("stock_transfer_variance");
  });

  /** 🔴 The transit location must actually be one. */
  it("parking goods in a selling warehouse is refused", () => {
    const fn = fnBody(TRANSFER_ACTIONS, "createTransfer");
    expect(fn).toContain('transit.type !== "transit"');
  });

  /** 🔴 The decision comes from the pure function, not from the states. */
  it("the tax treatment is decided by the shared function", () => {
    expect(t).toContain("transferTaxTreatment(");
    expect(t).toContain("fromGstin: from.gstin");
    expect(t).not.toMatch(/isTaxableSupply:\s*from\.stateCode/);
  });

  /** 🔴 Recoverable is taken from the law, not from a checkbox. */
  it("isRecoverable comes from the charge type", () => {
    const fn = fnBody(LANDED_ACTIONS, "recordLandedCost");
    expect(fn).toContain("isRecoverable: meta.recoverable");
    expect(fn).not.toMatch(/isRecoverable:\s*data\./);
  });

  it("a recoverable charge cannot be applied", () => {
    const fn = fnBody(LANDED_ACTIONS, "applyLandedCost");
    expect(fn).toContain("charge.isRecoverable");
    expect(fn).toContain("inflate closing stock");
  });

  /** ⚠️ A draft purchase's lines can still change. */
  it("a charge cannot be recorded against a draft purchase", () => {
    const fn = fnBody(LANDED_ACTIONS, "recordLandedCost");
    expect(fn).toContain('inv.status === "draft"');
  });

  it("the apportionment and the split use the shared functions", () => {
    const fn = fnBody(LANDED_ACTIONS, "applyLandedCost");
    expect(fn).toContain("apportion(");
    expect(fn).toContain("splitBetweenStockAndCogs(");
  });

  /** Every export in a "use server" file is a browser-reachable endpoint. */
  it("both action files export only async functions and types", () => {
    for (const [n, s] of [
      ["transfers", t],
      ["landed-cost", l],
    ] as const) {
      expect(s.startsWith('"use server"'), n).toBe(true);
      const bad = s.match(/^export\s+(?:const|let|var|class|function)\s+\w+/gm);
      expect(bad ?? [], n).toEqual([]);
    }
  });
});

describe("⭐ the screens", () => {
  it("both are in the menu", () => {
    expect(REGISTRY).toContain('href: "/inventory/transfers"');
    expect(REGISTRY).toContain('href: "/purchases/landed-cost"');
  });

  /** ⚠️ Finding out at save time means re-keying the whole document. */
  it("the create form answers the supply question before any lines", () => {
    expect(TRANSFER_UI).toContain("transferTaxTreatment");
    expect(TRANSFER_UI).toContain("needs a tax invoice");
    expect(TRANSFER_UI).toContain("Rule 55");
  });

  it("the form warns that dispatch cannot be undone", () => {
    expect(TRANSFER_UI).toContain("cannot be cancelled");
  });

  /** 🔴 The shortfall is named and valued on the receive form. */
  it("the receive form shows the shortfall with its value", () => {
    expect(TRANSFER_UI).toContain("transferVariance");
    expect(TRANSFER_UI).toContain("left and never arrived");
    expect(TRANSFER_UI).toContain("17(5)(h)");
  });

  it("a missing transit location is called out before it blocks anybody", () => {
    expect(TRANSFER_PAGE).toContain("hasTransit");
    expect(TRANSFER_PAGE).toContain("no transit location");
  });

  it("the detail screen shows the authority, not just a label", () => {
    expect(TRANSFER_DETAIL).toContain("treatmentAuthority");
  });

  /** ⚠️ The recoverable column is shown separately, always. */
  it("the landed-cost screen never folds recoverable into the total", () => {
    const c = code(LANDED_PAGE);
    expect(c).toContain("recoverableMinor");
    expect(c).toContain("capitalisedMinor");
    expect(c).not.toMatch(/capitalisedMinor\s*\)?\s*\+\s*.*recoverableMinor/);
  });

  it("it explains which charges count and which do not", () => {
    expect(LANDED_PAGE).toContain("LANDED_COST_TYPES");
    expect(LANDED_PAGE).toContain("subsequently recoverable");
  });

  it("pages are server components and the form is a client component", () => {
    for (const p of [TRANSFER_PAGE, TRANSFER_DETAIL, LANDED_PAGE]) {
      expect(p.startsWith('"use client"')).toBe(false);
    }
    expect(TRANSFER_UI.startsWith('"use client"')).toBe(true);
  });

  /** Both engines are pure and have no clock. */
  it("neither library reads a clock", () => {
    for (const [n, s] of [
      ["transfer", TRANSFER_LIB],
      ["landed-cost", LANDED_LIB],
    ] as const) {
      const c = code(s);
      expect(c, n).not.toMatch(/Date\.now\(\)/);
      expect(c, n).not.toMatch(/new Date\(\)/);
    }
  });
});
