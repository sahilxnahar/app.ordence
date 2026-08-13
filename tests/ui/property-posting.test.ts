/**
 * Real estate → the ledger.
 *
 * 🔴 The whole file exists for one rule: money taken from a home buyer
 * before possession is a LIABILITY, not revenue.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildDemandPosting,
  buildBookingReceiptPosting,
  buildPossessionPosting,
  propertyRolesUsed,
  PROPERTY_ROLE_META,
  type PropertyLeg,
} from "@/lib/accounting/sales-posting";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const POST = read("server/accounting/post-sales.ts");
const RECEIVABLES = read("server/actions/receivables.ts");
const GATE = read("scripts/check-posting-coverage.mjs");

function sides(legs: readonly PropertyLeg[]) {
  let debit = 0n;
  let credit = 0n;
  for (const l of legs) {
    if (l.entryType === "debit") debit += l.amountMinor;
    else credit += l.amountMinor;
  }
  return { debit, credit };
}
const find = (legs: readonly PropertyLeg[], role: string) =>
  legs.find((l) => l.role === role);

/** ₹20,00,000 instalment + 5% GST. */
const DEMAND = {
  principalMinor: 200_000_000n,
  cgstMinor: 5_000_000n,
  sgstMinor: 5_000_000n,
  igstMinor: 0n,
  cessMinor: 0n,
  totalMinor: 210_000_000n,
  demandNumber: "DN/0042",
  bookingReference: "BK-118",
  buyerName: "R. Iyer",
};

/* ================================================================== */

describe("🔴 a demand notice creates a LIABILITY, never revenue", () => {
  const legs = buildDemandPosting(DEMAND);

  /**
   * Under Ind AS 115 a residential developer transfers control at
   * possession. Booking demands to revenue reports an entire pre-sales
   * book as turnover — profit that has never existed, and tax on it.
   */
  it("credits Advance from Customers, and nothing reaches revenue", () => {
    expect(find(legs, "customer_advance")?.entryType).toBe("credit");
    expect(find(legs, "customer_advance")?.amountMinor).toBe(200_000_000n);
    expect(find(legs, "property_revenue")).toBeUndefined();
  });

  it("the advance role is a LIABILITY in the chart of accounts", () => {
    expect(PROPERTY_ROLE_META.customer_advance.accountType).toBe("liability");
    expect(PROPERTY_ROLE_META.customer_advance.tallyGroup).toBe("Current Liabilities");
  });

  /** Time of supply for construction services: earlier of invoice or payment. */
  it("but the GST liability DOES arise now", () => {
    expect(find(legs, "output_cgst")?.amountMinor).toBe(5_000_000n);
    expect(find(legs, "output_sgst")?.amountMinor).toBe(5_000_000n);
  });

  it("balances, debtor against advance plus tax", () => {
    expect(find(legs, "booking_receivable")?.amountMinor).toBe(210_000_000n);
    expect(sides(legs).debit).toBe(sides(legs).credit);
  });

  /** One debt split across two ledgers is a debt nobody can reconcile. */
  it("reuses the SALES output-tax roles rather than twinning them", () => {
    expect(propertyRolesUsed(legs)).toContain("output_cgst");
    expect(propertyRolesUsed(legs).some((r) => String(r).includes("property_cgst"))).toBe(false);
  });
});

describe("🔴 a receipt converts a receivable to cash, and nothing else", () => {
  const legs = buildBookingReceiptPosting({
    cashMinor: 198_000_000n,
    tdsMinor: 2_000_000n,
    receiptNumber: "RC/0091",
    bookingReference: "BK-118",
    buyerName: "R. Iyer",
  });

  /** Posting to revenue as well is the double-count that doubles turnover. */
  it("touches neither revenue nor the advance", () => {
    expect(find(legs, "property_revenue")).toBeUndefined();
    expect(find(legs, "customer_advance")).toBeUndefined();
  });

  /**
   * A buyer paying above ₹50 lakh deducts 1% under 194-IA. Recording only
   * the bank credit leaves the booking permanently short and dunns
   * somebody who paid in full.
   */
  it("treats Section 194-IA TDS as money received", () => {
    expect(find(legs, "tds_receivable")?.entryType).toBe("debit");
    expect(find(legs, "tds_receivable")?.amountMinor).toBe(2_000_000n);
    expect(find(legs, "booking_receivable")?.amountMinor).toBe(200_000_000n);
    expect(sides(legs).debit).toBe(sides(legs).credit);
  });

  it("a receipt with no TDS is two legs", () => {
    const plain = buildBookingReceiptPosting({
      cashMinor: 50_000_000n,
      tdsMinor: 0n,
      receiptNumber: "RC/1",
      bookingReference: "BK-1",
      buyerName: null,
    });
    expect(propertyRolesUsed(plain).sort()).toEqual(["bank", "booking_receivable"]);
  });
});

describe("🔴 possession is the ONLY place revenue is recognised", () => {
  const legs = buildPossessionPosting({
    advanceMinor: 800_000_000n,
    bookingReference: "BK-118",
    unitLabel: "A-1204",
    buyerName: "R. Iyer",
  });

  it("moves the advance into revenue", () => {
    expect(find(legs, "customer_advance")?.entryType).toBe("debit");
    expect(find(legs, "property_revenue")?.entryType).toBe("credit");
    expect(sides(legs).debit).toBe(sides(legs).credit);
  });

  /**
   * A buyer may still owe the final instalment on the day they take the
   * keys. Control has transferred and the revenue is earned in full.
   */
  it("recognises the whole advance, not the cash collected", () => {
    expect(find(legs, "property_revenue")?.amountMinor).toBe(800_000_000n);
  });

  it("names the unit on the entry", () => {
    expect(find(legs, "property_revenue")?.description).toContain("A-1204");
  });

  /** Burying it in a receipt recognises revenue on whichever instalment landed last. */
  it("is its own action and its own transaction", () => {
    expect(code(POST)).toContain("export async function postPossession");
    expect(code(POST)).toContain('salesTransactionKey("possession"');
  });
});

describe("⭐ the counterparty is the BOOKING — the Session 2 question, settled", () => {
  /**
   * `bookings` has a lead and a unit and no company. Inventing a company
   * per home buyer would create thousands of shell CRM records whose only
   * purpose is to satisfy a foreign key.
   */
  it("posts against the booking, not an invented company", () => {
    const c = code(POST);
    expect(c).toContain('const BOOKING_COUNTERPARTY = "booking"');
    expect(c).toContain("counterpartyType: BOOKING_COUNTERPARTY");
  });

  it("still carries a name, so Tally has a party", () => {
    expect(code(POST)).toContain("counterpartyName: args.buyerName");
  });
});

describe("🔴 wired into the real actions", () => {
  it("serveDemand posts the demand", () => {
    const c = code(RECEIVABLES);
    const seg = c.slice(c.indexOf("export async function serveDemand"));
    expect(seg).toContain("postDemandNotice(tx, {");
  });

  it("recordPayment posts the receipt", () => {
    const c = code(RECEIVABLES);
    const seg = c.slice(c.indexOf("export async function recordPayment"));
    expect(seg).toContain("postBookingReceipt(tx, {");
  });

  /** Posting on the due date moves a project's GST into the next month, every time. */
  it("dates the demand by the NOTICE date, not the due date", () => {
    expect(code(RECEIVABLES)).toContain("servedOn: String(d.noticeDate)");
  });
});

describe("🔴 the gate's debt list shrank by decision again", () => {
  it("receivables is off the list because it now posts", () => {
    const block = GATE.slice(GATE.indexOf("KNOWN_UNPOSTED = {"), GATE.indexOf("/** Any of these"));
    expect(block).not.toContain("receivables:");
  });

  /**
   * The old excuse blamed an open design decision. The decision is
   * settled; what is actually missing is forfeiture and brokerage.
   */
  it("the sales-bookings excuse was corrected to what is really missing", () => {
    expect(GATE).toContain("moves no money");
    expect(code(GATE)).not.toContain("blocked on the same decision");
  });
});

describe("⭐ forfeiture and delay interest have roles, ready for 11b", () => {
  it("forfeiture warns that RERA caps it", () => {
    expect(PROPERTY_ROLE_META.forfeiture_income.help).toContain("RERA caps");
  });

  it("delay interest is income, not a reduction of receivable", () => {
    expect(PROPERTY_ROLE_META.delay_interest_income.accountType).toBe("revenue");
  });
});
