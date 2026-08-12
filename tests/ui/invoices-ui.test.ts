/**
 * The invoices screens.
 *
 * These read source. A page compiles fine while leading with the wrong
 * number, and "leads with the wrong number" is not a type error.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const LIST = read("app/(crm)/invoices/page.tsx");
const DETAIL = read("app/(crm)/invoices/[id]/page.tsx");
const ACTIONS = read("server/actions/sales-invoices.ts");
const REGISTRY = read("lib/modules/registry.ts");

describe("🔴 money is never floated on the way to the screen", () => {
  it("neither page divides by 100", () => {
    expect(code(LIST)).not.toMatch(/\/\s*100\b/);
    expect(code(DETAIL)).not.toMatch(/Number\([^)]*\)\s*\/\s*100/);
  });

  it("both format from digit strings", () => {
    expect(code(LIST)).toContain("padStart(3");
    expect(code(DETAIL)).toContain("padStart(3");
  });

  it("the action serialises every amount", () => {
    const body = code(ACTIONS).slice(code(ACTIONS).indexOf("export async function listInvoices"));
    expect(body).toContain("serializeAmount");
    expect(body).not.toMatch(/totalMinor:\s*Number\(/);
  });
});

describe("🔴 the register leads with overdue VALUE, not a count", () => {
  it("computes an overdue amount, not just a tally", () => {
    expect(code(ACTIONS)).toContain("overdueMinor");
  });

  it("the page shows the value above the count", () => {
    const overdueBlock = LIST.slice(LIST.indexOf("Overdue"), LIST.indexOf("Outstanding"));
    expect(overdueBlock).toContain("inr(summary.overdueMinor)");
  });

  /**
   * An invoice on 60-day terms raised 45 days ago is not late. Ageing from
   * the invoice date rings a customer who owes nothing yet.
   */
  it("ages from the due date, falling back to the invoice date", () => {
    const body = code(ACTIONS);
    expect(body).toContain("r.dueDate ? String(r.dueDate) : String(r.invoiceDate)");
  });

  it("takes today once, not per row", () => {
    const listBody = code(ACTIONS).slice(code(ACTIONS).indexOf("export async function listInvoices"));
    expect((listBody.match(/new Date\(\)\.toISOString/g) ?? []).length).toBe(1);
  });

  it("does not count a paid or cancelled invoice as overdue", () => {
    expect(code(ACTIONS)).toMatch(/status === "paid" \|\| r\.status === "cancelled"/);
  });
});

describe("⭐ the Rule 46 report is finally rendered", () => {
  it("the detail action runs checkRule46", () => {
    expect(code(ACTIONS)).toContain("checkRule46(");
  });

  it("the page renders both blocking and advisory findings", () => {
    expect(DETAIL).toContain("rule46.blocking");
    expect(DETAIL).toContain("rule46.advisory");
  });

  /** "Missing field" teaches nobody. "Rule 46(g)" can be looked up. */
  it("shows the clause and the remedy, not just a message", () => {
    expect(DETAIL).toContain("{f.rule}");
    expect(DETAIL).toContain("{f.remedy}");
  });

  it("reports rather than refusing — no throw on findings", () => {
    const detailBody = code(ACTIONS).slice(
      code(ACTIONS).indexOf("export async function getInvoiceDetail"),
    );
    expect(detailBody).not.toMatch(/if \(!report\.ok\)[\s\S]{0,60}throw/);
  });
});

describe("🔴 tax heads are shown separately", () => {
  /**
   * A customer's accountant reconciles CGST, SGST and IGST against three
   * different ledgers. One combined "GST" figure makes them redo the
   * split by hand from a document that already knew it.
   */
  it("never renders a single combined GST total in the summary", () => {
    const summary = DETAIL.slice(DETAIL.indexOf("Taxable value"));
    expect(summary).toContain("CGST");
    expect(summary).toContain("IGST");
  });

  it("labels the state half UTGST on an intra-UT supply", () => {
    expect(DETAIL).toContain('invoice.isUnionTerritory ? "UTGST" : "SGST"');
  });
});

describe("🔴 a missing invoice is indistinguishable from someone else's", () => {
  it("uses notFound(), never an error page", () => {
    expect(code(DETAIL)).toContain("notFound()");
  });
});

describe("the screen is reachable", () => {
  it("is registered in the module registry under money", () => {
    expect(REGISTRY).toContain('href: "/invoices"');
    const entry = REGISTRY.slice(REGISTRY.indexOf("invoices: {"), REGISTRY.indexOf("purchases: {"));
    expect(entry).toContain('group: "money"');
    expect(entry).toContain('status: "live"');
  });
});
