/**
 * ⭐⭐ TIME → INVOICE — the last step of the Legal / Professional engine.
 *
 * 🔴 THE FAILURE THIS WHOLE SUITE IS SHAPED AROUND: an invoice raised
 *    without the entries being marked billed. The client is charged, the
 *    hours stay "unbilled", and next month the same hours are charged
 *    again. Nothing errors. Nothing looks wrong. The firm finds out when
 *    the client does.
 *
 * ⚠️ THESE ARE STRUCTURAL TESTS, NOT DATABASE TESTS. They assert that
 * the code has the shape that makes the failure impossible — one
 * transaction, a count check, no re-pricing — which is exactly what a
 * later refactor is liable to quietly undo.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** Comments say WHY a rule exists. A negative assertion must never read them. */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const sqlCode = (s: string) => s.replace(/--[^\n]*/g, "");

const ACTIONS = read("server/actions/time-billing.ts");
const SQL = read("SQL-FILES/0053_time_and_billing.sql");
const PAGE = read("app/(crm)/time/page.tsx");
const BILL = read("components/billing/bill-time.tsx");
const RECORD = read("components/billing/record-time.tsx");
const RATE_FORM = read("components/billing/billing-rate-form.tsx");
const REGISTRY = read("lib/modules/registry.ts");

/** The body of `raiseInvoiceFromTime`, comments stripped. */
const FN = (() => {
  const c = code(ACTIONS);
  const start = c.indexOf("export async function raiseInvoiceFromTime");
  expect(start, "raiseInvoiceFromTime must exist").toBeGreaterThan(-1);
  return c.slice(start);
})();

/* ================================================================== */

describe("🔴 one transaction, or the same hours get billed twice", () => {
  /**
   * The invoice INSERT and the UPDATE that marks entries billed must sit
   * inside the same `withTenant` callback. Split across two calls, a
   * crash between them leaves an invoice sent and hours still unbilled.
   */
  it("the invoice and the marking-as-billed are in ONE withTenant block", () => {
    const opens = FN.split("withTenant(").length - 1;
    expect(opens, "exactly one transaction").toBe(1);

    const invoiceAt = FN.indexOf(".insert(salesInvoices)");
    const markAt = FN.indexOf(".update(timeEntries)");
    const txAt = FN.indexOf("withTenant(");

    expect(invoiceAt).toBeGreaterThan(txAt);
    expect(markAt).toBeGreaterThan(invoiceAt);
  });

  /**
   * ⚠️ THE CONCURRENCY GUARD. Two people billing the same entries in the
   * same second each see them approved; one UPDATE wins and the other
   * marks fewer rows than it selected. Without this the loser still gets
   * an invoice — for hours somebody else already billed.
   */
  it("a count mismatch throws, so the whole thing rolls back", () => {
    expect(FN).toContain("marked.length !== entries.length");
    const idx = FN.indexOf("marked.length !== entries.length");
    expect(FN.slice(idx, idx + 400)).toContain("throw new Error");
  });

  /** Only rows still `approved` are marked — the update itself is the lock. */
  it("the marking UPDATE re-checks the status it selected on", () => {
    const idx = FN.indexOf(".update(timeEntries)");
    const block = FN.slice(idx, idx + 800);
    expect(block).toContain('eq(timeEntries.status, "approved")');
    expect(block).toContain("inArray(timeEntries.id, data.entryIds)");
  });

  /** Nothing is ever removed — a billed hour keeps its row and gains an invoice. */
  it("nothing is deleted anywhere in the function", () => {
    expect(FN).not.toMatch(/\.delete\(/);
  });

  /**
   * 🔴 THE DATABASE REFUSES THE HALF-STATE TOO. Even if this code were
   * wrong, `(status = 'billed') = (invoice_id IS NOT NULL)` cannot
   * survive COMMIT.
   */
  it("the database also refuses billed-without-an-invoice", () => {
    expect(SQL).toContain("(status = 'billed') = (invoice_id IS NOT NULL)");
  });
});

describe("🔴 the value comes from the entry, never from re-pricing", () => {
  /**
   * ⚠️ THE ENTIRE POINT OF THE EFFECTIVE-DATED RATE TABLE. Re-resolving
   * the rate at invoice time would bill a year of unbilled March work at
   * today's card — silently, and always in one direction.
   */
  it("the invoice does not resolve a rate", () => {
    expect(FN).not.toContain("resolveRate");
    expect(FN).not.toContain("timeValueMinor(");
  });

  it("line value is summed from valueMinor on the entries", () => {
    expect(FN).toContain("toBigIntAmount(e.valueMinor)");
    expect(FN).toContain("unitPriceMinor: l.valueMinor");
  });

  /**
   * ⚠️ QUANTITY IS ONE AND THE UNIT PRICE IS THE LINE VALUE, so
   * `price × quantity` cannot disagree with the timesheet by a few
   * paise. The hours are stated in the description instead.
   */
  it("quantity is 1.000 so the arithmetic cannot drift", () => {
    expect(FN).toContain('quantity: "1.000"');
    expect(FN).toContain("minutesToHoursLabel(");
  });
});

describe("⚠️ the five refusals, each naming its count", () => {
  const CASES: readonly [string, string][] = [
    ["wrongCompany", "different client"],
    ["alreadyBilled", "already on an invoice"],
    ["notApproved", "not been approved"],
    ["nonBillable", "non-billable"],
    ["unrated", "no rate"],
  ];

  for (const [name, phrase] of CASES) {
    it(`refuses ${name}, and says how many`, () => {
      expect(FN, name).toContain(`const ${name} = entries.filter(`);
      const idx = FN.indexOf(`const ${name} = entries.filter(`);
      const block = FN.slice(idx, idx + 700);
      expect(block, name).toContain("throw new Error");
      expect(block, name).toContain(`${name}.length`);
      expect(block.toLowerCase(), name).toContain(phrase);
    });
  }

  /**
   * ⚠️ REFUSED, NOT SILENTLY DROPPED. A bill that quietly excludes half
   * of what was selected is worse than one that refuses — nobody
   * notices, and the excluded hours are billed to the other client next
   * month.
   */
  it("a mixed-client selection is refused rather than filtered", () => {
    const idx = FN.indexOf("const wrongCompany");
    const block = FN.slice(idx, idx + 500);
    expect(block).toContain("throw new Error");
    expect(block).not.toContain("entries = entries.filter");
  });
});

describe("⚠️ it is a services invoice, and it is a draft", () => {
  /** 🔴 Rule 48(1) requires three copies for goods and two for services. */
  it("supplyType is services", () => {
    expect(FN).toContain('supplyType: "services"');
    expect(FN).not.toContain('supplyType: "goods"');
  });

  /** SAC, not HSN — Rule 46 requires the service accounting code. */
  it("defaults to a SAC code, not an HSN", () => {
    expect(FN).toContain('data.sacCode ?? "9982"');
  });

  /**
   * ⚠️ Rule 46(b) numbering happens at ISSUE, from the issued-only
   * sequence. A draft carrying a real number would burn one every time
   * somebody previewed a bill and abandoned it.
   */
  it("the invoice is created as a draft with a placeholder number", () => {
    expect(FN).toContain('status: "draft"');
    expect(FN).toContain("DRAFT-");
  });

  it("raising an invoice from time is audited", () => {
    expect(FN).toContain("writeAudit(");
    expect(FN).toContain("fromTimeEntries");
  });
});

describe("⭐ the screen that makes the engine reachable", () => {
  /**
   * 🔴 v1.1.0 shipped every one of these functions with nothing able to
   * call them. A tested engine nobody can reach is a spreadsheet.
   */
  it("the page calls the engine", () => {
    expect(PAGE).toContain("getUnbilledTime");
    expect(PAGE).toContain("getBillingRates");
    expect(BILL).toContain("raiseInvoiceFromTime");
    expect(BILL).toContain("approveTimeEntries");
    expect(BILL).toContain("writeOffTimeEntries");
    expect(RECORD).toContain("recordTimeEntry");
    expect(RATE_FORM).toContain("saveBillingRate");
  });

  it("it is in the menu, so somebody can find it", () => {
    expect(REGISTRY).toContain('href: "/time"');
    expect(REGISTRY).toContain('navId: "time"');
  });

  /**
   * ⚠️ APPROVED AND PENDING ARE NEVER ADDED. One "unbilled WIP" figure
   * combining both is the number that makes a partner think the month
   * went better than it did.
   */
  it("the screen never sums approved and pending time", () => {
    const c = code(PAGE);
    expect(c).toContain("approvedValueMinor");
    expect(c).toContain("pendingValueMinor");
    expect(c).not.toMatch(/approvedValueMinor\s*\)?\s*\+\s*/);
    expect(c).not.toMatch(/approvedMinutes\s*\+\s*summary\.pendingMinutes/);
  });

  /** An unrated entry is not missing from a total — it is zero inside it. */
  it("unrated entries get their own alarm", () => {
    expect(PAGE).toContain("unratedCount");
    expect(BILL).toContain("rated");
  });

  /**
   * ⚠️ SELECTION IS PER CLIENT BECAUSE AN INVOICE IS PER CLIENT. A
   * screen that lets somebody tick forty boxes across three clients and
   * THEN refuses has wasted their afternoon.
   */
  it("entries are grouped by client before anything can be selected", () => {
    expect(PAGE).toContain("companyId ?? \"__internal__\"");
    expect(BILL).toContain("companyId: string | null");
    expect(BILL).toContain("canBill");
  });

  /** Internal time has no client, so it can never become an invoice. */
  it("internal time cannot be billed", () => {
    expect(PAGE).toContain('canBill={key !== "__internal__"}');
  });

  /**
   * ⭐ THE ROUNDING IS SHOWN BEFORE IT IS APPLIED. Somebody types "7m"
   * and the client is charged for twelve minutes; if that first appears
   * on the invoice, the first person to discover the convention is the
   * client.
   */
  it("the entry form previews the rounding using the shared function", () => {
    expect(RECORD).toContain("billableMinutes(");
    expect(RECORD).toContain("parseDuration(");
    expect(RECORD).toContain('from "@/lib/billing/time"');
  });

  /** A form that looks like it edits a rate will be used as though it does. */
  it("the rate form adds a row and never edits one", () => {
    const c = code(RATE_FORM);
    expect(c).toContain("saveBillingRate");
    expect(c).toContain("effectiveFrom");
    expect(c).not.toMatch(/updateBillingRate|deleteBillingRate/);
  });

  /** ₹8,000 becoming ₹80.00 is what a second money parser buys you. */
  it("the rate form parses rupees with the shared parseMoney", () => {
    expect(RATE_FORM).toContain("parseMoney");
    expect(code(RATE_FORM)).not.toMatch(/\*\s*100\b/);
  });
});

describe("⚠️ the boundary rules still hold", () => {
  /** Every export in a "use server" file is a browser-reachable endpoint. */
  it("the actions file exports only async functions", () => {
    const c = code(ACTIONS);
    expect(c.startsWith('"use server"')).toBe(true);
    const exports = c.match(/^export\s+(?!async function)(?:const|function|let|var|class)\s+\w+/gm);
    expect(exports ?? []).toEqual([]);
  });

  /** The three client components must say so, or they run on the server. */
  it("every interactive component declares itself a client component", () => {
    for (const [name, src] of [
      ["bill-time", BILL],
      ["record-time", RECORD],
      ["billing-rate-form", RATE_FORM],
    ] as const) {
      expect(src.startsWith('"use client"'), name).toBe(true);
    }
  });

  /** The page reads on the server; nothing about it belongs in a browser. */
  it("the page is a server component", () => {
    expect(PAGE.startsWith('"use client"')).toBe(false);
    expect(PAGE).toContain('export const dynamic = "force-dynamic"');
  });

  /** `0053` is still the only migration this work needs. */
  it("no new migration was required for the screen", () => {
    expect(sqlCode(SQL)).toContain("CREATE TABLE IF NOT EXISTS time_entries");
  });
});
