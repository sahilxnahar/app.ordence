/**
 * ⭐⭐ TRADING, BATCH 2 — PRICES THAT ACTUALLY SELL, AND s.15(3).
 *
 * 🔴 BOTH HALVES FAIL SILENTLY. A card selected on the wrong rule quotes
 *    a customer their list price instead of their contract price; a
 *    rebate credited under an agreement signed too late takes back tax
 *    that was never recoverable. Nothing errors either way.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  PricingError,
  quoteQuantity,
  selectRateCard,
  stripTax,
  validateSlabs,
  type CandidateCard,
} from "@/lib/pricing/resolve";
import {
  DiscountError,
  allocateRebate,
  assessPostSupplyDiscount,
  earliestSupplyDate,
  rebateForTurnover,
  type InvoiceShare,
} from "@/lib/gst/discounts";
import type { Slab } from "@/db/schema/pricing";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const sqlCode = (s: string) => s.replace(/--[^\n]*/g, "");

const SQL = read("SQL-FILES/0057_pricing_discounts.sql");
const PRICING_ACTIONS = read("server/actions/pricing.ts");
const DISCOUNT_ACTIONS = read("server/actions/discounts.ts");
const RESOLVE_LIB = read("lib/pricing/resolve.ts");
const DISCOUNT_LIB = read("lib/gst/discounts.ts");
const PRICE_PAGE = read("app/(crm)/rates/price-check/page.tsx");
const DISCOUNT_PAGE = read("app/(crm)/gst/discounts/page.tsx");
const PRICE_UI = read("components/rates/price-check.tsx");
const REGISTRY = read("lib/modules/registry.ts");
const PRICING_SCHEMA = read("db/schema/pricing.ts");

function fnBody(src: string, name: string): string {
  const c = code(src);
  const start = c.indexOf(`export async function ${name}`);
  expect(start, name).toBeGreaterThan(-1);
  const after = c.indexOf("export async function", start + 10);
  return after === -1 ? c.slice(start) : c.slice(start, after);
}

const card = (over: Partial<CandidateCard> = {}): CandidateCard => ({
  id: "c1",
  code: "LIST",
  name: "House list",
  scope: "list",
  slabMode: "flat",
  priority: 100,
  customerCompanyId: null,
  appliesToKind: "stock_item",
  appliesToId: "item-1",
  channel: null,
  validFrom: null,
  validTo: null,
  daysOfWeek: null,
  baseAmountMinor: 10_000n,
  taxRateBps: 1800,
  isTaxInclusive: false,
  floorPriceMinor: null,
  isActive: true,
  ...over,
});

const slab = (seq: number, upTo: bigint | null, unit: bigint): Slab => ({
  sequence: seq,
  upToQuantity: upTo,
  unitAmountMinor: unit,
  fixedAmountMinor: 0n,
});

/* ================================================================== */

describe("🔴 specificity beats priority beats recency", () => {
  /**
   * 🔴 THE RULE PEOPLE ARE MOST SURPRISED BY UNTIL IT PROTECTS THEM. A
   *    rate negotiated in a supply agreement last year must never be
   *    overridden by a house list published yesterday.
   */
  it("a card naming the customer beats a higher-priority general list", () => {
    const s = selectRateCard({
      cards: [
        card({ id: "list", code: "LIST", scope: "promotional", priority: 900 }),
        card({
          id: "cust",
          code: "CUST",
          scope: "contracted",
          priority: 10,
          customerCompanyId: "co-1",
        }),
      ],
      customerCompanyId: "co-1",
      appliesToKind: "stock_item",
      appliesToId: "item-1",
      onDate: "2026-08-13",
    });
    expect(s?.card.code).toBe("CUST");
    expect(s?.reason).toContain("negotiated with this customer");
  });

  /** ⚠️ And a card belonging to ANOTHER customer never applies. */
  it("another customer's card is not a candidate", () => {
    const s = selectRateCard({
      cards: [card({ customerCompanyId: "co-2", code: "OTHER" })],
      customerCompanyId: "co-1",
      appliesToKind: "stock_item",
      appliesToId: "item-1",
      onDate: "2026-08-13",
    });
    expect(s).toBeNull();
  });

  it("a card for this item beats one that prices everything", () => {
    const s = selectRateCard({
      cards: [
        card({ id: "any", code: "ANY", appliesToId: null }),
        card({ id: "item", code: "ITEM" }),
      ],
      customerCompanyId: null,
      appliesToKind: "stock_item",
      appliesToId: "item-1",
      onDate: "2026-08-13",
    });
    expect(s?.card.code).toBe("ITEM");
  });

  /**
   * ⚠️ HALF-OPEN VALIDITY: `validTo` IS EXCLUSIVE. A card ending
   * 31 March and one starting 31 March would otherwise both apply that
   * day and the answer would depend on sort order.
   */
  it("validTo is exclusive", () => {
    const args = {
      cards: [card({ validFrom: "2026-01-01", validTo: "2026-03-31" })],
      customerCompanyId: null,
      appliesToKind: "stock_item",
      appliesToId: "item-1",
    };
    expect(selectRateCard({ ...args, onDate: "2026-03-30" })).not.toBeNull();
    expect(selectRateCard({ ...args, onDate: "2026-03-31" })).toBeNull();
  });

  it("an inactive card never applies", () => {
    const s = selectRateCard({
      cards: [card({ isActive: false })],
      customerCompanyId: null,
      appliesToKind: "stock_item",
      appliesToId: "item-1",
      onDate: "2026-08-13",
    });
    expect(s).toBeNull();
  });

  /**
   * ⚠️ A quote that changes between being given and being honoured is a
   * quote nobody trusts. The card code is the final tie-break.
   */
  it("is deterministic when everything else ties", () => {
    const cards = [card({ id: "z", code: "ZED" }), card({ id: "a", code: "ABLE" })];
    const args = {
      customerCompanyId: null,
      appliesToKind: "stock_item",
      appliesToId: "item-1",
      onDate: "2026-08-13",
    };
    expect(selectRateCard({ cards, ...args })?.card.code).toBe("ABLE");
    expect(selectRateCard({ cards: [...cards].reverse(), ...args })?.card.code).toBe(
      "ABLE",
    );
  });

  it("a day-of-week mask is honoured", () => {
    /** 13 August 2026 is a Thursday — index 3 with Monday = 0. */
    const weekdays = card({ daysOfWeek: "1111100" });
    const weekends = card({ daysOfWeek: "0000011" });
    const args = {
      customerCompanyId: null,
      appliesToKind: "stock_item",
      appliesToId: "item-1",
      onDate: "2026-08-13",
    };
    expect(selectRateCard({ cards: [weekdays], ...args })).not.toBeNull();
    expect(selectRateCard({ cards: [weekends], ...args })).toBeNull();
  });
});

describe("🔴 slab bands that cannot overlap or leave a gap", () => {
  /** 🔴 Two bands covering one quantity give two prices. */
  it("catches bands that do not climb", () => {
    const p = validateSlabs([slab(1, 100n, 10n), slab(2, 100n, 9n), slab(3, null, 8n)]);
    expect(p.some((x) => x.sequence === 2)).toBe(true);
    expect(p.find((x) => x.sequence === 2)?.problem).toContain("two prices");
  });

  /** ⚠️ A second "and everything above" band can never be reached. */
  it("catches two open-ended bands", () => {
    const p = validateSlabs([slab(1, null, 10n), slab(2, null, 9n)]);
    expect(p.length).toBeGreaterThan(0);
    expect(p.some((x) => x.problem.includes("never be reached"))).toBe(true);
  });

  it("catches a band that comes after the open-ended one", () => {
    const p = validateSlabs([slab(1, 100n, 10n), slab(2, null, 9n), slab(3, 500n, 8n)]);
    expect(p.some((x) => x.sequence === 3)).toBe(true);
  });

  /**
   * 🔴 THE QUIET ONE. Flat pricing falls through to the last band, so a
   *    quantity above the top is charged at the TOP rate rather than
   *    erroring — and nobody finds that by looking at the card.
   */
  it("warns when nothing prices a quantity above the top band", () => {
    const p = validateSlabs([slab(1, 100n, 10n), slab(2, 500n, 9n)]);
    expect(p.some((x) => x.problem.includes("Nothing prices a quantity above"))).toBe(
      true,
    );
  });

  it("a clean ladder has no problems", () => {
    expect(
      validateSlabs([slab(1, 100n, 10n), slab(2, 500n, 9n), slab(3, null, 8n)]),
    ).toEqual([]);
  });
});

describe("🔴 progressive versus flat — 27% of the bill", () => {
  const slabs = [slab(1, 100n, 450n), slab(2, 300n, 620n), slab(3, null, 800n)];

  it("progressive charges each band for the part inside it", () => {
    const q = quoteQuantity({
      card: card({ slabMode: "progressive" }),
      slabs,
      quantity: 250n,
    });
    /** 100 × 450 + 150 × 620 = 45,000 + 93,000 */
    expect(q.lineAmountMinor).toBe(138_000n);
    expect(q.reason).toContain("Progressive");
  });

  it("flat charges the whole quantity at the band it lands in", () => {
    const q = quoteQuantity({ card: card({ slabMode: "flat" }), slabs, quantity: 250n });
    expect(q.lineAmountMinor).toBe(155_000n);
    expect(q.reason).toContain("Flat");
  });

  /**
   * ⚠️ THE LINE IS COMPUTED FIRST AND THE UNIT DERIVED. Under
   * progressive pricing there is no single unit price; deriving the line
   * from a rounded unit figure would lose paise on every quantity,
   * always in the same direction.
   */
  it("the unit price is derived from the line, not the other way round", () => {
    const q = quoteQuantity({
      card: card({ slabMode: "progressive" }),
      slabs,
      quantity: 250n,
    });
    expect(q.unitPriceMinor).toBe(552n);
    /** 552 × 250 = 138,000 — but only because it rounded that way. */
    expect(q.lineAmountMinor).toBe(138_000n);
  });

  it("refuses a non-positive quantity", () => {
    expect(() =>
      quoteQuantity({ card: card(), slabs, quantity: 0n }),
    ).toThrow(PricingError);
  });

  /**
   * 🔴 THE FLOOR AND THE LANDED COST ARE WARNINGS, NOT REFUSALS. A
   *    trader genuinely does sell below list to clear stock — but never
   *    by accident.
   */
  it("warns below the card's floor", () => {
    const q = quoteQuantity({
      card: card({ slabMode: "flat", floorPriceMinor: 700n }),
      slabs,
      quantity: 250n,
    });
    expect(q.warnings.some((w) => w.includes("below the floor"))).toBe(true);
  });

  it("warns below the LANDED cost, not the invoice price", () => {
    const q = quoteQuantity({
      card: card({ slabMode: "flat" }),
      slabs,
      quantity: 250n,
      landedUnitCostMinor: 700n,
    });
    expect(q.warnings.some((w) => w.includes("cost to land"))).toBe(true);
  });
});

describe("⚠️ tax-inclusive prices", () => {
  /**
   * 🔴 ₹118 AT 18% IS ₹100 + ₹18. Dividing by 1.18 in floating point
   *    gives 99.99999999999999, and the invoice shows ₹117.99 against a
   *    shelf price of ₹118.
   */
  it("strips tax exactly, with the tax as the remainder", () => {
    const r = stripTax({ inclusiveMinor: 11_800n, taxRateBps: 1800 });
    expect(r.taxableMinor).toBe(10_000n);
    expect(r.taxMinor).toBe(1_800n);
    expect(r.taxableMinor + r.taxMinor).toBe(11_800n);
  });

  it("the two halves always add back, at any awkward figure", () => {
    for (const amt of [1n, 7n, 99n, 11_799n, 987_654_321n]) {
      const r = stripTax({ inclusiveMinor: amt, taxRateBps: 1200 });
      expect(r.taxableMinor + r.taxMinor, String(amt)).toBe(amt);
    }
  });
});

/* ================================================================== */

describe("🔴 section 15(3)(b) — the year-end rebate trap", () => {
  /**
   * 🔴 THE FAILURE THIS ENGINE EXISTS FOR. A rebate agreed in December
   *    on the year's turnover cannot reduce the GST on April's sales.
   */
  it("an agreement signed after the earliest supply cannot reduce tax", () => {
    const v = assessPostSupplyDiscount({
      agreementDate: "2026-12-01",
      earliestSupplyDate: "2026-04-05",
      linkedInvoiceCount: 40,
      recipientReversalConfirmed: true,
    });
    expect(v.reducesTax).toBe(false);
    expect(v.timing).toBe("post_supply_unagreed");
    expect(v.reason).toContain("2026-04-05");
    expect(v.outstanding.join(" ")).toContain("financial credit note");
  });

  /** ⚠️ "At or before" — the same day qualifies. */
  it("an agreement dated the same day as the supply qualifies", () => {
    const v = assessPostSupplyDiscount({
      agreementDate: "2026-04-05",
      earliestSupplyDate: "2026-04-05",
      linkedInvoiceCount: 1,
      recipientReversalConfirmed: true,
    });
    expect(v.reducesTax).toBe(true);
  });

  it("no agreement at all means no tax reduction, and says what to do", () => {
    const v = assessPostSupplyDiscount({
      agreementDate: null,
      earliestSupplyDate: "2026-04-05",
      linkedInvoiceCount: 10,
      recipientReversalConfirmed: true,
    });
    expect(v.reducesTax).toBe(false);
    expect(v.outstanding.join(" ")).toContain("BEFORE the period");
  });

  /** 🔴 The linkage is not decoration — s.15(3)(b)(i) requires it. */
  it("an unlinked rebate cannot reduce tax", () => {
    const v = assessPostSupplyDiscount({
      agreementDate: "2026-01-01",
      earliestSupplyDate: "2026-04-05",
      linkedInvoiceCount: 0,
      recipientReversalConfirmed: true,
    });
    expect(v.reducesTax).toBe(false);
    expect(v.outstanding.join(" ")).toContain("specific invoices");
  });

  /**
   * ⭐ CIRCULAR 212/6/2024 WAS WITHDRAWN ON 1 OCTOBER 2025 — but
   *    s.15(3)(b)(ii) was not amended. Reading the withdrawal as "the
   *    condition is gone" is wrong in the direction that loses an
   *    assessment.
   */
  it("the recipient's reversal is still required after the circular was withdrawn", () => {
    const v = assessPostSupplyDiscount({
      agreementDate: "2026-01-01",
      earliestSupplyDate: "2026-04-05",
      linkedInvoiceCount: 10,
      recipientReversalConfirmed: false,
    });
    expect(v.reducesTax).toBe(false);
    expect(v.outstanding.join(" ")).toContain("253/10/2025");
    expect(v.outstanding.join(" ")).toContain("was not");
  });

  it("everything met means the tax comes back", () => {
    const v = assessPostSupplyDiscount({
      agreementDate: "2026-01-01",
      earliestSupplyDate: "2026-04-05",
      linkedInvoiceCount: 40,
      recipientReversalConfirmed: true,
    });
    expect(v.reducesTax).toBe(true);
    expect(v.outstanding).toEqual([]);
  });
});

describe("⭐ the rebate bands", () => {
  const slabs = [
    { fromTurnoverMinor: 5_000_000_00n, rateBps: 200 },
    { fromTurnoverMinor: 10_000_000_00n, rateBps: 250 },
  ];

  /**
   * ⚠️ THE WHOLE TURNOVER AT THE BAND IT REACHES — the flat reading,
   * which is what a trading rebate agreement almost always says.
   */
  it("rebates the whole turnover at the band reached", () => {
    const r = rebateForTurnover({ turnoverMinor: 12_000_000_00n, slabs });
    expect(r.rateBps).toBe(250);
    expect(r.discountMinor).toBe(30_000_000n);
  });

  /** ⭐ The figure a salesperson opens the screen for in late March. */
  it("reports how far the next band is", () => {
    const r = rebateForTurnover({ turnoverMinor: 6_000_000_00n, slabs });
    expect(r.rateBps).toBe(200);
    expect(r.toNextBandMinor).toBe(4_000_000_00n);
    expect(r.nextRateBps).toBe(250);
  });

  it("below the first band earns nothing", () => {
    const r = rebateForTurnover({ turnoverMinor: 1_000_000_00n, slabs });
    expect(r.discountMinor).toBe(0n);
    expect(r.nextRateBps).toBe(200);
  });

  it("refuses nonsense", () => {
    expect(() => rebateForTurnover({ turnoverMinor: -1n, slabs })).toThrow(
      DiscountError,
    );
    expect(() =>
      rebateForTurnover({
        turnoverMinor: 1n,
        slabs: [{ fromTurnoverMinor: 0n, rateBps: 2.5 }],
      }),
    ).toThrow(DiscountError);
  });
});

describe("🔴 apportioning the rebate across the invoices that earned it", () => {
  const inv = (n: string, taxable: bigint, rate: number, date = "2026-04-05") => ({
    invoiceId: `i-${n}`,
    invoiceNumber: n,
    invoiceDate: date,
    taxableMinor: taxable,
    taxRateBps: rate,
  });

  /** ⚠️ Largest remainder, so the shares sum to the rebate exactly. */
  it("the shares always sum to the rebate", () => {
    for (const total of [1n, 7n, 100_003n, 987_654_321n]) {
      const r = allocateRebate({
        discountMinor: total,
        invoices: [
          inv("A", 17n, 1800),
          inv("B", 41n, 1800),
          inv("C", 3n, 1800),
        ],
      });
      expect(
        r.shares.reduce((s, x) => s + x.allocatedMinor, 0n),
        String(total),
      ).toBe(total);
    }
  });

  /**
   * 🔴 THE TAX IS PER INVOICE, AT THAT INVOICE'S RATE. A rebate spanning
   *    5%, 12% and 18% goods has no single rate, and an average would
   *    reclaim the wrong amount on every line.
   */
  it("tax is computed at each invoice's own rate", () => {
    const r = allocateRebate({
      discountMinor: 20_000n,
      invoices: [inv("A", 100_000n, 500), inv("B", 100_000n, 1800)],
    });
    const a = r.shares.find((s) => s.invoiceNumber === "A");
    const b = r.shares.find((s) => s.invoiceNumber === "B");
    expect(a?.allocatedMinor).toBe(10_000n);
    expect(b?.allocatedMinor).toBe(10_000n);
    expect(a?.taxAllocatedMinor).toBe(500n);
    expect(b?.taxAllocatedMinor).toBe(1_800n);
    expect(r.taxTotalMinor).toBe(2_300n);
  });

  /** 🔴 A lump sum with no invoices behind it is what the section refuses. */
  it("refuses to allocate against no invoices", () => {
    expect(() => allocateRebate({ discountMinor: 100n, invoices: [] })).toThrow(
      DiscountError,
    );
  });

  it("is deterministic", () => {
    const invoices = [inv("Z", 1n, 1800), inv("A", 1n, 1800)];
    const a = allocateRebate({ discountMinor: 101n, invoices });
    const b = allocateRebate({ discountMinor: 101n, invoices });
    expect(a.shares).toEqual(b.shares);
  });

  /**
   * ⚠️ THE EARLIEST SUPPLY, NOT THE LATEST. Testing the agreement date
   * against the latest invoice would pass a whole year's rebate on an
   * agreement signed in October.
   */
  it("the earliest supply date is what the agreement is tested against", () => {
    const invoices: InvoiceShare[] = [
      inv("B", 1n, 1800, "2026-09-01"),
      inv("A", 1n, 1800, "2026-04-05"),
    ];
    expect(earliestSupplyDate(invoices)).toBe("2026-04-05");
  });
});

describe("🔴 the rules that live in the database", () => {
  /** ⭐ The most important line in the migration. */
  it("no second price list table was created, and it says why", () => {
    expect(sqlCode(SQL)).not.toMatch(/CREATE TABLE[^;]*customer_price_list/i);
    expect(SQL).toContain("THERE IS NO NEW PRICE LIST TABLE");
  });

  it("bands are validated by a trigger", () => {
    expect(SQL).toContain("ordence_validate_rate_slabs");
    expect(SQL).toContain("trg_validate_rate_slabs");
  });

  /** ⚠️ A row-level check would refuse a good multi-row insert halfway. */
  it("the band check is deferred, because the set is only coherent whole", () => {
    expect(SQL).toContain("DEFERRABLE INITIALLY DEFERRED");
  });

  /** ⭐ Stated: why not an EXCLUDE constraint. */
  it("the migration explains why it is not an EXCLUDE constraint", () => {
    expect(SQL).toContain("btree_gist");
  });

  /** 🔴 A tax-reducing rebate must name its agreement. */
  it("a tax-reducing discount needs an agreement and a reversal", () => {
    expect(SQL).toContain("post_supply_discounts_tax_needs_agreement");
    expect(SQL).toContain("post_supply_discounts_tax_needs_reversal");
  });

  /** ⚠️ Every verdict carries its reason, whichever way it went. */
  it("a verdict must be explained", () => {
    expect(SQL).toContain("post_supply_discounts_verdict_is_explained");
  });

  it("a floor price is nullable and non-negative", () => {
    expect(SQL).toContain("ADD COLUMN IF NOT EXISTS floor_price_minor");
    expect(SQL).toContain("rate_cards_floor_positive");
  });

  it("every new table is tenant-isolated and forced", () => {
    for (const t of [
      "price_agreements",
      "post_supply_discounts",
      "post_supply_discount_invoices",
    ]) {
      expect(SQL, t).toContain(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
      expect(SQL, t).toContain(`${t}_tenant_isolation`);
    }
  });

  /** ⚠️ A price is a fact about a customer, a quantity and a date. */
  it("there is no cached current price on a stock item", () => {
    expect(sqlCode(SQL)).not.toMatch(/ADD COLUMN[^;]*current_price/i);
  });
});

describe("🔴 the rules that live in the actions", () => {
  const p = code(PRICING_ACTIONS);
  const d = code(DISCOUNT_ACTIONS);

  /** ⚠️ A quote of ₹0.00 looks like a decision somebody made. */
  it("a missing price is said plainly, not returned as zero", () => {
    const fn = fnBody(PRICING_ACTIONS, "quoteLine");
    expect(fn).toContain("found: false");
    expect(fn).toContain("will not quote");
  });

  it("the resolver and the slab arithmetic are the shared ones", () => {
    expect(p).toContain("selectRateCard(");
    expect(p).toContain("quoteQuantity(");
    expect(p).toContain("validateSlabs(");
  });

  /** ⭐ The landed cost from 0056 reaches the quote. */
  it("the quote is checked against landed cost, not the invoice price", () => {
    const fn = fnBody(PRICING_ACTIONS, "quoteLine");
    expect(fn).toContain("landedUnitCostMinor");
    expect(fn).toContain("stockBalances");
  });

  /**
   * 🔴 THE ALLOCATION HAPPENS IN THE SAME TRANSACTION AS THE REBATE.
   *    Software that stores a rebate as one figure cannot produce the
   *    s.15(3)(b)(i) linkage afterwards, because the apportionment was
   *    never done.
   */
  it("the rebate and its invoice linkage are one transaction", () => {
    const fn = fnBody(DISCOUNT_ACTIONS, "computeRebate");
    expect(fn.split("withTenant(").length - 1).toBe(1);
    const rebateAt = fn.indexOf(".insert(postSupplyDiscounts)");
    const linkAt = fn.indexOf(".insert(postSupplyDiscountInvoices)");
    expect(rebateAt).toBeGreaterThan(-1);
    expect(linkAt).toBeGreaterThan(rebateAt);
  });

  /** ⚠️ A draft has no turnover; a cancelled sale did not happen. */
  it("only issued invoices count towards turnover", () => {
    const fn = fnBody(DISCOUNT_ACTIONS, "computeRebate");
    expect(fn).toContain("NOT IN ('draft', 'cancelled')");
  });

  /** 🔴 The verdict is stored with its reasoning. */
  it("the verdict and its reason are both persisted", () => {
    const fn = fnBody(DISCOUNT_ACTIONS, "computeRebate");
    expect(fn).toContain("reducesTax: verdict.reducesTax");
    expect(fn).toContain("verdictReason: verdict.reason");
  });

  /**
   * ⭐ RECORDING A LATE AGREEMENT IS ALLOWED AND WARNED ABOUT. Refusing
   *    it would make the product unusable for the arrangement most
   *    trading firms actually have.
   */
  it("a late agreement is recorded with a warning, not refused", () => {
    const fn = fnBody(DISCOUNT_ACTIONS, "savePriceAgreement");
    expect(fn).toContain("qualifiesForTaxAdjustment");
    expect(fn).toContain("financial credit note");
    expect(fn).not.toMatch(/throw new Error\([^)]*agreement is dated/);
  });

  /** Every export in a "use server" file is a browser-reachable endpoint. */
  it("both action files export only async functions and types", () => {
    for (const [n, s] of [
      ["pricing", p],
      ["discounts", d],
    ] as const) {
      expect(s.startsWith('"use server"'), n).toBe(true);
      const bad = s.match(/^export\s+(?:const|let|var|class|function)\s+\w+/gm);
      expect(bad ?? [], n).toEqual([]);
    }
  });
});

describe("⭐ the screens", () => {
  it("both are in the menu", () => {
    expect(REGISTRY).toContain('href: "/rates/price-check"');
    expect(REGISTRY).toContain('href: "/gst/discounts"');
  });

  /** ⚠️ The "why" is what makes it usable on the phone. */
  it("the price check shows which card won and what lost", () => {
    expect(PRICE_UI).toContain("selectionReason");
    expect(PRICE_UI).toContain("Also applied, and lost");
  });

  it("it states the rule that surprises people", () => {
    expect(PRICE_UI).toContain("always beats a general list");
  });

  /** 🔴 The gap is quiet: flat pricing falls through to the top band. */
  it("the rate-card health list explains why a gap matters", () => {
    expect(PRICE_PAGE).toContain("falls through");
    expect(PRICE_PAGE).toContain("withProblems");
  });

  /** ⚠️ Lost and recoverable are never summed. */
  it("the discounts screen keeps lost and recoverable apart", () => {
    const c = code(DISCOUNT_PAGE);
    expect(c).toContain("taxLostMinor");
    expect(c).toContain("taxRecoverableMinor");
    expect(c).not.toMatch(/taxLostMinor\s*\)?\s*\+\s*/);
  });

  /** ⭐ The current position on the withdrawn circular, on the screen. */
  it("the discounts screen states the 2025 circular withdrawal correctly", () => {
    expect(DISCOUNT_PAGE).toContain("253/10/2025");
    expect(DISCOUNT_PAGE).toContain("condition itself survived");
  });

  it("pages are server components and the form is a client component", () => {
    expect(PRICE_PAGE.startsWith('"use client"')).toBe(false);
    expect(DISCOUNT_PAGE.startsWith('"use client"')).toBe(false);
    expect(PRICE_UI.startsWith('"use client"')).toBe(true);
  });

  /** Both engines are pure and have no clock. */
  it("neither library reads a clock", () => {
    for (const [n, s] of [
      ["resolve", RESOLVE_LIB],
      ["discounts", DISCOUNT_LIB],
    ] as const) {
      const c = code(s);
      expect(c, n).not.toMatch(/Date\.now\(\)/);
      expect(c, n).not.toMatch(/new Date\(\)/);
    }
  });

  /** ⚠️ The rebate bands are NOT stored in the sales slab table. */
  it("rebate bands live on the agreement, not in rate_slabs", () => {
    expect(PRICING_SCHEMA).toContain("deliberately NOT a second slab table");
  });
});
