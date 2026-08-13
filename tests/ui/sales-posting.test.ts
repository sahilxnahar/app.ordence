/**
 * Sales → the double-entry ledger.
 *
 * The leg builders are tested for real. If any of these is wrong, the
 * books are wrong in a way that BALANCES — which is the only kind of
 * accounting error nobody catches by looking.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  assertBalances,
  buildCreditNotePosting,
  buildInvoicePosting,
  buildReceiptPosting,
  POSTING_ROLE_META,
  PostingImbalance,
  rolesUsed,
  type PostingLeg,
  type SalesTaxBreakdown,
} from "@/lib/accounting/sales-posting";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const flat = (s: string) => s.replace(/\s+/g, " ");

const POST = read("server/accounting/post-sales.ts");
const ACTIONS = read("server/actions/sales-invoices.ts");
const POSTING_ACTIONS = read("server/actions/sales-posting.ts");
const SQL = read("SQL-FILES/0051_sales_posting_accounts.sql");
const PAGE = read("app/(crm)/accounting/posting/page.tsx");
const SETUP = read("components/invoices/posting-setup.tsx");

/** ₹1,000 + 18% intra-State = ₹1,180. */
const INTRA: SalesTaxBreakdown = {
  taxableValueMinor: 100_000n,
  cgstMinor: 9_000n,
  sgstMinor: 9_000n,
  igstMinor: 0n,
  cessMinor: 0n,
  roundOffMinor: 0n,
  totalMinor: 118_000n,
};

const INTER: SalesTaxBreakdown = {
  taxableValueMinor: 100_000n,
  cgstMinor: 0n,
  sgstMinor: 0n,
  igstMinor: 18_000n,
  cessMinor: 0n,
  roundOffMinor: 0n,
  totalMinor: 118_000n,
};

function sides(legs: readonly PostingLeg[]) {
  let debit = 0n;
  let credit = 0n;
  for (const l of legs) {
    if (l.entryType === "debit") debit += l.amountMinor;
    else credit += l.amountMinor;
  }
  return { debit, credit };
}

function amountFor(legs: readonly PostingLeg[], role: string) {
  return legs.find((l) => l.role === role);
}

/* ================================================================== */

describe("🔴 every posting balances, by construction", () => {
  it("an intra-State invoice", () => {
    const legs = buildInvoicePosting({
      tax: INTRA,
      invoiceNumber: "ORD/2627/00001",
      customerName: "Acme Infra LLP",
    });
    const { debit, credit } = sides(legs);
    expect(debit).toBe(118_000n);
    expect(credit).toBe(118_000n);
  });

  /**
   * ⚠️ The single most common way a small ERP gets books wrong: crediting
   * the whole invoice to sales overstates turnover by the GST and leaves
   * the Government's money nowhere on the balance sheet.
   */
  it("credits SALES net of tax, never the gross", () => {
    const legs = buildInvoicePosting({
      tax: INTRA,
      invoiceNumber: "X",
      customerName: null,
    });
    expect(amountFor(legs, "revenue")?.amountMinor).toBe(100_000n);
    expect(amountFor(legs, "revenue")?.entryType).toBe("credit");
    expect(amountFor(legs, "receivable")?.amountMinor).toBe(118_000n);
    expect(amountFor(legs, "receivable")?.entryType).toBe("debit");
  });

  it("puts the tax in its own liability legs, split by head", () => {
    const legs = buildInvoicePosting({ tax: INTRA, invoiceNumber: "X", customerName: null });
    expect(amountFor(legs, "output_cgst")?.amountMinor).toBe(9_000n);
    expect(amountFor(legs, "output_sgst")?.amountMinor).toBe(9_000n);
    expect(amountFor(legs, "output_igst")).toBeUndefined();
  });

  /** An intra-State invoice must not force a tenant to map an IGST ledger. */
  it("drops zero legs entirely rather than posting ₹0.00", () => {
    const legs = buildInvoicePosting({ tax: INTER, invoiceNumber: "X", customerName: null });
    expect(rolesUsed(legs).sort()).toEqual(["output_igst", "receivable", "revenue"]);
  });
});

describe("🔴 the round-off leg is the BALANCING leg, not a nicety", () => {
  /**
   * If it were dropped as "only paise", the debit to the customer would
   * differ from the sum of the credits and the deferred constraint trigger
   * would refuse the whole transaction at COMMIT — surfacing as "issuing
   * the invoice failed" with no clue why.
   */
  it("balances a positive round-off as a CREDIT", () => {
    const tax: SalesTaxBreakdown = { ...INTRA, roundOffMinor: 40n, totalMinor: 118_040n };
    const legs = buildInvoicePosting({ tax, invoiceNumber: "X", customerName: null });
    expect(amountFor(legs, "round_off")?.entryType).toBe("credit");
    expect(sides(legs).debit).toBe(sides(legs).credit);
  });

  /** A negative round-off is a DEBIT, never a credit carrying a minus sign. */
  it("balances a negative round-off as a DEBIT of a positive amount", () => {
    const tax: SalesTaxBreakdown = { ...INTRA, roundOffMinor: -60n, totalMinor: 117_940n };
    const legs = buildInvoicePosting({ tax, invoiceNumber: "X", customerName: null });
    const ro = amountFor(legs, "round_off");
    expect(ro?.entryType).toBe("debit");
    expect(ro?.amountMinor).toBe(60n);
    expect(sides(legs).debit).toBe(sides(legs).credit);
  });

  it("omits the leg completely when there is no rounding", () => {
    const legs = buildInvoicePosting({ tax: INTRA, invoiceNumber: "X", customerName: null });
    expect(amountFor(legs, "round_off")).toBeUndefined();
  });
});

describe("🔴 a credit note is a MIRROR, not a negative invoice", () => {
  const legs = buildCreditNotePosting({
    tax: INTRA,
    creditNoteNumber: "CN/00001",
    invoiceNumber: "ORD/2627/00001",
    customerName: "Acme Infra LLP",
  });

  it("balances", () => {
    expect(sides(legs).debit).toBe(sides(legs).credit);
    expect(sides(legs).debit).toBe(118_000n);
  });

  /**
   * Posting negative credits would also balance, and would make the month
   * read as gross sales with a negative bolted on — which is not what a
   * P&L shows and not what Tally accepts.
   */
  it("DEBITS revenue and CREDITS the customer, every amount positive", () => {
    expect(amountFor(legs, "revenue")?.entryType).toBe("debit");
    expect(amountFor(legs, "receivable")?.entryType).toBe("credit");
    for (const l of legs) expect(l.amountMinor > 0n).toBe(true);
  });

  /** Otherwise the tenant owes tax on a supply that came back. */
  it("reverses the output tax rather than leaving it behind", () => {
    expect(amountFor(legs, "output_cgst")?.entryType).toBe("debit");
    expect(amountFor(legs, "output_sgst")?.entryType).toBe("debit");
  });

  it("is exactly the invoice posting with every direction flipped", () => {
    const inv = buildInvoicePosting({
      tax: INTRA,
      invoiceNumber: "ORD/2627/00001",
      customerName: "Acme Infra LLP",
    });
    expect(rolesUsed(legs).sort()).toEqual(rolesUsed(inv).sort());
    for (const role of rolesUsed(inv)) {
      expect(amountFor(legs, role)?.amountMinor).toBe(amountFor(inv, role)?.amountMinor);
      expect(amountFor(legs, role)?.entryType).not.toBe(amountFor(inv, role)?.entryType);
    }
  });
});

describe("🔴 a receipt, and what TDS is", () => {
  const legs = buildReceiptPosting({
    cashMinor: 90_000n,
    tdsMinor: 10_000n,
    receiptNumber: "RCP/000001",
    customerName: "Acme Infra LLP",
  });

  it("balances", () => {
    expect(sides(legs).debit).toBe(100_000n);
    expect(sides(legs).credit).toBe(100_000n);
  });

  /**
   * The customer paid it to the Government on our behalf. Treating it as a
   * discount understates assets and the credit is then never claimed.
   */
  it("debits TDS to an ASSET, it does not write it off", () => {
    expect(amountFor(legs, "tds_receivable")?.entryType).toBe("debit");
    expect(amountFor(legs, "tds_receivable")?.amountMinor).toBe(10_000n);
  });

  /** Crediting only the cash leaves a permanent shortfall on their account. */
  it("credits the customer cash PLUS TDS", () => {
    expect(amountFor(legs, "receivable")?.amountMinor).toBe(100_000n);
  });

  it("a receipt with no TDS has no TDS leg", () => {
    const plain = buildReceiptPosting({
      cashMinor: 50_000n,
      tdsMinor: 0n,
      receiptNumber: "R",
      customerName: null,
    });
    expect(rolesUsed(plain).sort()).toEqual(["bank", "receivable"]);
  });
});

describe("🔴 the balance guard itself", () => {
  it("throws when debits and credits differ, and says by how much", () => {
    expect(() =>
      assertBalances([
        { role: "receivable", entryType: "debit", amountMinor: 100n, description: "" },
        { role: "revenue", entryType: "credit", amountMinor: 99n, description: "" },
      ]),
    ).toThrow(PostingImbalance);
    try {
      assertBalances([
        { role: "receivable", entryType: "debit", amountMinor: 100n, description: "" },
        { role: "revenue", entryType: "credit", amountMinor: 99n, description: "" },
      ]);
    } catch (e) {
      expect((e as Error).message).toContain("1 paise");
    }
  });

  /** Direction belongs in entryType; a sign is a second, contradictory way. */
  it("refuses a negative amount even if the two sides would net", () => {
    expect(() =>
      assertBalances([
        { role: "revenue", entryType: "credit", amountMinor: -100n, description: "" },
        { role: "receivable", entryType: "debit", amountMinor: -100n, description: "" },
      ]),
    ).toThrow(/negative/);
  });
});

describe("⭐ every role can be explained to the person mapping it", () => {
  it("has a label, a Tally group and help", () => {
    for (const [role, meta] of Object.entries(POSTING_ROLE_META)) {
      expect(meta.label.length, role).toBeGreaterThan(0);
      expect(meta.tallyGroup.length, role).toBeGreaterThan(0);
      expect(meta.help.length, role).toBeGreaterThan(10);
    }
  });

  /** Tax filed under "Indirect Expenses" gives a balance sheet with no liability. */
  it("files every output tax role under Duties & Taxes", () => {
    for (const role of ["output_cgst", "output_sgst", "output_igst", "output_cess"] as const) {
      expect(POSTING_ROLE_META[role].tallyGroup).toBe("Duties & Taxes");
      expect(POSTING_ROLE_META[role].accountType).toBe("liability");
    }
  });

  it("the mapping screen shows the group and the help, not bare role names", () => {
    expect(code(SETUP)).toContain("r.tallyGroup");
    expect(code(SETUP)).toContain("r.help");
  });
});

describe("🔴 posting is idempotent, and the database enforces it", () => {
  /** Two people pressing "post the backlog" both read "not posted" and both insert. */
  it("a partial unique index, not just an application check", () => {
    expect(SQL).toContain("CREATE UNIQUE INDEX IF NOT EXISTS transactions_sales_document_once");
    expect(SQL).toContain("WHERE transaction_number LIKE 'SALES:%'");
  });

  /**
   * A blanket index on (reference_type, reference_id) would also constrain
   * the billing invoices from Phase 32 and recurring contracts that post
   * monthly against one reference.
   */
  it("scoped by prefix so it cannot constrain other subsystems", () => {
    expect(SQL).not.toContain("ON transactions (tenant_id, reference_type, reference_id)");
  });

  it("the key is readable, not a hash", () => {
    expect(code(POST)).toContain("`SALES:${tag}:${documentId}`");
  });

  it("the button says it is safe to press twice", () => {
    expect(flat(SETUP)).toContain("Safe to run more than once");
  });
});

describe("🔴 posting never blocks issuing, and is never silent", () => {
  it("issueInvoice posts inside the same transaction", () => {
    const body = code(ACTIONS);
    const fn = body.slice(
      body.indexOf("export async function issueInvoice"),
      body.indexOf("export async function cancelInvoice"),
    );
    expect(fn).toContain("postSalesInvoice(tx, {");
  });

  it("issueCreditNote and recordCustomerReceipt post too", () => {
    const body = code(ACTIONS);
    expect(body).toContain("postSalesCreditNote(tx, {");
    expect(body).toContain("postCustomerReceipt(tx, {");
  });

  /**
   * A tenant with no chart of accounts must still be able to invoice —
   * but the document must not vanish from the books unremarked.
   */
  it("an unmapped role is skipped and named, never guessed at", () => {
    expect(code(POST)).toContain('reason: "unmapped_roles"');
    expect(code(POST)).not.toMatch(/roleMap\.get\([^)]*\)\s*\?\?\s*["']/);
  });

  /** A partial posting would not survive the Phase 4 balance trigger anyway. */
  it("refuses the WHOLE posting when any role is unmapped", () => {
    const c = code(POST);
    const at = c.indexOf("const missing =");
    expect(c.slice(at, at + 240)).toContain("return { posted: false");
  });

  /** The backlog is "issued, with no SALES: transaction" — it cannot drift. */
  it("the backlog is derived, not a status column", () => {
    expect(code(POSTING_ACTIONS)).toContain("postedKeys(");
    expect(code(POSTING_ACTIONS)).not.toMatch(/postingStatus|isPosted\b/);
  });

  it("drafts are never in the backlog", () => {
    expect(code(POSTING_ACTIONS)).toContain('["issued", "part_paid", "paid"]');
  });
});

describe("🔴 money reaches the ledger without touching a float", () => {
  it("amounts are formatted from bigint, never divided", () => {
    const c = code(POST);
    expect(c).toContain("formatMoneyPlain(l.amountMinor");
    expect(c).not.toMatch(/\/\s*100\b/);
    expect(c).not.toContain("parseFloat");
  });

  /** Adding both sides reports a ₹1,180 invoice as ₹2,360 — plausible and twice the truth. */
  it("totalAmount is the debit side, not the sum of every leg", () => {
    const c = code(POST);
    const at = c.indexOf("const debitTotal");
    expect(c.slice(at, at + 200)).toContain('l.entryType === "debit"');
  });

  /** An invoice dated 31 March posted on 2 April belongs in March. */
  it("posts on the document's date, never on today", () => {
    const c = code(POST);
    expect(c).toContain("transactionDate: args.invoiceDate");
    expect(c).not.toContain("transactionDate: new Date()");
  });
});

describe("the screen states the consequence, not the configuration", () => {
  it("says what an unmapped role costs, in terms of the P&L", () => {
    expect(flat(PAGE)).toContain("do not reach your P&amp;L");
  });

  it("shows the mapping and the backlog on one page", () => {
    expect(PAGE).toContain("PostingSetup");
    expect(PAGE).toContain("PostBacklogButton");
  });

  /** A silent cap reads as "that is all of them". */
  it("says out loud when the list is truncated", () => {
    expect(flat(PAGE)).toContain("Showing the oldest 200 of");
  });
});
