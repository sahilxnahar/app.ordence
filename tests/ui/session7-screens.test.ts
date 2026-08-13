/**
 * Session 7 — credit note on paper, statement, GSTR-1, allocation.
 *
 * These read source. Every one of these screens compiles fine while
 * netting two figures that must never be netted, or while quietly
 * reimplementing a parser that already exists.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseMoney } from "@/lib/billing/money";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/**
 * ⚠️ PROSE ASSERTIONS MUST IGNORE WHITESPACE. JSX wraps a sentence
 * wherever the formatter decides, so "reverse the input tax credit"
 * appears in the file as "reverse the input tax\n credit". A test that
 * matches the raw text is asserting against Prettier's line width, and
 * it breaks the next time the sentence is edited by one word.
 */
const flat = (s: string) => s.replace(/\s+/g, " ");

const CN_PRINT = read("app/(print)/credit-notes/[id]/print/page.tsx");
const STATEMENT = read("app/(crm)/companies/[id]/statement/page.tsx");
const GSTR1 = read("app/(crm)/gst/gstr1/page.tsx");
const RECEIPTS = read("app/(crm)/receipts/page.tsx");
const RECEIPT = read("app/(crm)/receipts/[id]/page.tsx");
const ALLOCATE = read("components/invoices/allocate-receipt.tsx");
const ACTIONS = read("server/actions/sales-invoices.ts");
const REGISTRY = read("lib/modules/registry.ts");

const SCREENS = [CN_PRINT, STATEMENT, GSTR1, RECEIPTS, RECEIPT, ALLOCATE];

/* ================================================================== */

describe("🔴 the credit note is a document the customer receives", () => {
  /** Rule 53 — without it this is an invoice with a minus sign. */
  it("names the original invoice and its date in the header", () => {
    const header = CN_PRINT.slice(0, CN_PRINT.indexOf("Recipient"));
    expect(header).toContain("Against Invoice");
    expect(header).toContain("Invoice Date");
  });

  it("says CREDIT NOTE, not TAX INVOICE", () => {
    expect(CN_PRINT).toContain("Credit Note");
    expect(CN_PRINT).not.toContain("Tax Invoice");
  });

  /** They have an obligation here; figures alone leave them to work it out. */
  it("tells the recipient to reverse the input tax credit", () => {
    expect(flat(CN_PRINT)).toContain("reverse the input tax credit");
  });

  it("prints the statutory ground on the face of it", () => {
    expect(code(CN_PRINT)).toContain("CREDIT_NOTE_REASON_META");
    expect(CN_PRINT).toContain("Reason for credit");
  });

  /** "Minus Four Thousand Rupees" reads as money owed TO the customer. */
  it("speaks the amount as a positive credit, never as a negative", () => {
    const body = code(ACTIONS);
    const fn = body.slice(body.indexOf("export async function getCreditNoteForPrint"));
    expect(fn).toContain("rupeesInWords(toBigIntAmount(note.totalMinor))");
    expect(fn).not.toMatch(/rupeesInWords\(\s*-/);
  });

  it("is reachable from the credit note screen", () => {
    const detail = read("app/(crm)/credit-notes/[id]/page.tsx");
    expect(detail).toContain("/print");
  });
});

describe("🔴 the statement never nets the three figures", () => {
  it("shows overdue, not-yet-due and unapplied credit as separate cards", () => {
    expect(STATEMENT).toContain("Not yet due");
    expect(STATEMENT).toContain("Unapplied credit");
    expect(STATEMENT).toContain("Overdue");
  });

  /**
   * Netting produces a smaller, friendlier number that is wrong in the one
   * conversation this page exists for.
   */
  it("does no arithmetic across those three figures", () => {
    const c = code(STATEMENT);
    expect(c).not.toMatch(/outstandingMinor\s*\)\s*-\s*BigInt/);
    expect(c).not.toMatch(/BigInt\(s\.outstandingMinor\)/);
  });

  /** Chasing somebody for money they already sent is our failure, not theirs. */
  it("names unapplied credit as our filing gap and links to fixing it", () => {
    const block = STATEMENT.slice(STATEMENT.indexOf("hasUnappliedCredit &&"));
    expect(flat(block)).toContain("already sent");
    expect(block).toContain("/receipts");
  });

  it("ages from the due date and says so on the page", () => {
    expect(flat(STATEMENT)).toContain("Aged from the due date");
  });

  it("carries a running balance and a closing line", () => {
    expect(STATEMENT).toContain("balanceMinor");
    expect(STATEMENT).toContain("Balance as at");
  });

  /** `/statements` is already the P&L and balance sheet. */
  it("lives under the company, not under the financial-statements route", () => {
    expect(() => read("app/(crm)/companies/[id]/statement/page.tsx")).not.toThrow();
  });
});

describe("🔴 GSTR-1 is built, never filed, and says so", () => {
  it("states plainly that nothing has been transmitted", () => {
    expect(flat(GSTR1)).toContain("has not been filed");
  });

  /** A return you cannot look at because it has a problem cannot be diagnosed. */
  it("renders warnings above the figures and still renders the return", () => {
    const warnAt = GSTR1.indexOf("warnings.length > 0");
    const totalsAt = GSTR1.indexOf("Taxable value");
    expect(warnAt).toBeGreaterThan(-1);
    expect(warnAt).toBeLessThan(totalsAt);
  });

  /** GSTR-1 is filed for a completed month. */
  it("defaults to last month, not the current one", () => {
    expect(code(GSTR1)).toContain("previousMonth()");
    expect(code(GSTR1)).toContain("setUTCMonth(d.getUTCMonth() - 1)");
  });

  /**
   * `lib/gstr1/build.ts` converts to rupees once, at the edge, because the
   * portal expects rupees. Dividing again here would be a hundredfold error.
   */
  it("does not re-scale figures that are already rupees", () => {
    const c = code(GSTR1);
    expect(c).not.toMatch(/\/\s*100\b/);
    expect(c).not.toContain("padStart(3");
  });

  it("carries every table the return needs", () => {
    for (const t of ["4A — B2B", "5A — B2C Large", "7 — B2C Small", "CDNR", "CDNUR", "12 — HSN", "13 — Documents issued"]) {
      expect(GSTR1, t).toContain(t);
    }
  });

  /** Rule 53 again — an unmatched credit note is the officer's first question. */
  it("flags a credit note that names no original invoice", () => {
    expect(GSTR1).toContain("🔴 missing");
  });

  it("is reachable from the GST screen", () => {
    expect(read("app/(crm)/gst/page.tsx")).toContain("/gst/gstr1");
  });
});

describe("🔴 unapplied cash", () => {
  it("TDS counts as received, not as a shortfall", () => {
    const body = code(ACTIONS);
    const fn = body.slice(body.indexOf("export async function listUnappliedReceipts"));
    expect(fn).toContain("tdsCreditMinor");
    expect(fn).toMatch(/amountMinor\)\s*\+[\s\S]{0,80}tdsCreditMinor/);
  });

  /** Money that came back is not money waiting to be applied. */
  it("bounced receipts are excluded", () => {
    const body = code(ACTIONS);
    const fn = body.slice(body.indexOf("export async function listUnappliedReceipts"));
    expect(fn).toContain('notInArray(customerReceipts.status, ["bounced"])');
  });

  /** One company's payment against another's invoice is two wrong balances. */
  it("the picker only ever offers that customer's invoices", () => {
    const body = code(ACTIONS);
    const fn = body.slice(body.indexOf("export async function getReceiptAllocation"));
    expect(fn).toContain("eq(salesInvoices.companyId, r.companyId)");
  });

  it("drafts, cancelled and fully-settled invoices are not offered", () => {
    const body = code(ACTIONS);
    const fn = body.slice(body.indexOf("export async function getReceiptAllocation"));
    expect(fn).toContain('notInArray(salesInvoices.status, ["draft", "cancelled"])');
    expect(fn).toContain("outstandingMinorRaw > 0n");
  });

  it("the register leads with value, not a count", () => {
    const head = RECEIPTS.slice(0, RECEIPTS.indexOf("Why it matters"));
    expect(head).toContain("Sitting unapplied");
    expect(head).toContain("inr(summary.unappliedTotalMinor)");
  });
});

describe("🔴 the allocation is typed, and money never floats", () => {
  /**
   * Oldest-first quietly settles a disputed invoice and leaves a current one
   * short — the dispute vanishes from ageing and survives in the customer's
   * mind.
   */
  it("oldest-first is a button, never the state the form opens in", () => {
    expect(code(ALLOCATE)).toContain("fillOldestFirst");
    expect(code(ALLOCATE)).toMatch(/useState<Record<string, string>>\(\{\}\)/);
  });

  /** A second money parser fails the same way a second tax engine does. */
  it("delegates to parseMoney rather than carrying its own regex", () => {
    const c = code(ALLOCATE);
    expect(c).toContain("parseMoney(");
    expect(c).not.toMatch(/BigInt\(whole/);
    expect(c).not.toMatch(/\\d\{0,2\}/);
  });

  it("never touches parseFloat", () => {
    for (const src of SCREENS) {
      expect(code(src)).not.toContain("parseFloat");
    }
  });

  /** `parseFloat("1234.35") * 100` is 123434.99999999999. */
  it("and the parser it delegates to is exact on the case floats get wrong", () => {
    expect(parseMoney("1234.35", "INR")).toBe(123_435n);
    expect(parseMoney("0.10", "INR") + parseMoney("0.20", "INR")).toBe(30n);
  });

  /**
   * `parseMoney` allows a negative because billing has genuine credits.
   * An allocation does not — minus ₹500 would increase what is owed from a
   * screen labelled "receipt".
   */
  it("refuses a negative even though parseMoney would accept one", () => {
    expect(parseMoney("-500", "INR")).toBe(-50_000n);
    expect(code(ALLOCATE)).toContain('t.startsWith("-")');
  });

  it("leaving money unapplied is allowed and is not shown as an error", () => {
    expect(flat(ALLOCATE)).toContain("an advance sits unapplied");
  });

  it("refuses more than the receipt has left, and says by how much", () => {
    expect(code(ALLOCATE)).toContain("overReceipt");
    expect(flat(ALLOCATE)).toContain("more than this receipt has left");
  });
});

describe("🔴 money on every new screen formats from digit strings", () => {
  it("no screen divides by 100", () => {
    for (const src of [CN_PRINT, STATEMENT, RECEIPTS, RECEIPT, ALLOCATE]) {
      expect(code(src)).not.toMatch(/Number\([^)]*\)\s*\/\s*100/);
      expect(code(src)).toContain("padStart(3");
    }
  });
});

describe("the screens are reachable", () => {
  it("receipts is in the module registry under money", () => {
    expect(REGISTRY).toContain('navId: "receipts"');
    expect(REGISTRY).toContain('"/receipts"');
  });

  it("a missing record is indistinguishable from someone else's", () => {
    for (const src of [CN_PRINT, STATEMENT, RECEIPT]) {
      expect(code(src)).toContain("notFound()");
    }
  });

  it("the receipt links onward to that customer's statement", () => {
    expect(RECEIPT).toContain("/statement");
  });
});
