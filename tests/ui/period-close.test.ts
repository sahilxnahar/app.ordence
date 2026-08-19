/**
 * Ordence — ⭐⭐⭐ CLOSING A MONTH
 * Version: v1.27.0-alpha · Batch 19
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A PERIOD WITH UNPOSTED DOCUMENTS BALANCES PERFECTLY
 * ══════════════════════════════════════════════════════════════════════
 * That is the whole reason this batch exists, and it is why the existing
 * balance check — careful, correct, and in place since v0.5.0 — could
 * never have caught it. The missing entries are missing from BOTH sides.
 * Zero equals zero.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  closeVerdict,
  describeStranded,
  periodContains,
  periodHasEnded,
  type CloseBlocker,
} from "@/lib/accounting/close-checklist";
import { salesTransactionKey, salesTransactionKeyCandidates } from "@/server/accounting/post-sales";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

function blocker(over: Partial<CloseBlocker> = {}): CloseBlocker {
  return {
    key: "k",
    source: "sales invoice",
    severity: "blocking",
    count: 1,
    headline: "1 sales invoice is not in the ledger",
    consequence: "the books are short by that much",
    where: "/invoices",
    amountMinor: null,
    oldest: null,
    ...over,
  };
}

/* ================================================================== */
/* 🔴 THE VENDOR PAYMENT KEY                                           */
/* ================================================================== */

describe("the transaction key tags", () => {
  /**
   * 🔴 THE DEFECT. `vendor_payment` was added to the union in v1.11.0
   * and never added to the tag chain, so it fell through to the default
   * and carried `RCP` — the CUSTOMER RECEIPT tag. Money leaving the
   * company, keyed as money arriving.
   *
   * ⚠️ And the comment three lines above the chain warned about exactly
   * this: "any unlisted kind silently becomes a receipt key".
   */
  it("gives a vendor payment its own tag, not the receipt tag", () => {
    expect(salesTransactionKey("vendor_payment", "abc")).toBe("SALES:VPY:abc");
    expect(salesTransactionKey("receipt", "abc")).toBe("SALES:RCP:abc");
  });

  /**
   * 🔴🔴 THE PART THAT WOULD HAVE DOUBLE-POSTED.
   *
   * The key IS the idempotency guard. A vendor payment posted before the
   * rename carries `SALES:RCP:<id>`; a lookup for only `SALES:VPY:<id>`
   * finds nothing, posts the journal again, and credits the bank twice —
   * reporting success, with the only symptom a reconciliation out by
   * exactly one payment.
   */
  it("still recognises the legacy key a vendor payment was posted under", () => {
    const keys = salesTransactionKeyCandidates("vendor_payment", "abc");
    expect(keys).toContain("SALES:VPY:abc");
    expect(keys).toContain("SALES:RCP:abc");
    /** ⚠️ Current first — the write always uses `keys[0]`. */
    expect(keys[0]).toBe("SALES:VPY:abc");
  });

  it("returns only the current key for a kind that never changed", () => {
    expect(salesTransactionKeyCandidates("invoice", "abc")).toEqual(["SALES:INV:abc"]);
  });

  /**
   * ⭐ THE STRUCTURAL FIX. The chain was fifteen nested ternaries ending
   * in `: "RCP"`, so a new kind silently inherited the receipt tag. A
   * `Record` keyed on the union makes the COMPILER refuse — which is
   * what the comment asked for and could not enforce.
   */
  it("uses an exhaustive map so a kind with no tag cannot compile", () => {
    const src = read("server/accounting/post-sales.ts");
    expect(src).toContain("const SALES_KEY_TAGS: Record<SalesKeyKind, string>");
    expect(src).not.toContain('kind === "credit_note"\n');
  });

  /**
   * 🔴 THE TAGS ARE WRITTEN TWICE — once in TypeScript for the writers,
   * once in SQL for the close check, because the join has to happen in
   * the database. A mismatch would report every document of that kind as
   * unposted and block every close.
   */
  it("keeps the SQL tags in the close check agreeing with the TypeScript ones", () => {
    const readiness = read("server/accounting/close-readiness.ts");
    const pairs: [Parameters<typeof salesTransactionKey>[0], string][] = [
      ["invoice", "INV"],
      ["receipt", "RCP"],
      ["purchase", "PI"],
      ["ra_bill", "RAB"],
      ["vendor_payment", "VPY"],
      ["demand", "DMD"],
    ];
    for (const [kind, tag] of pairs) {
      expect(salesTransactionKey(kind, "x")).toBe(`SALES:${tag}:x`);
      expect(readiness).toContain(`"${tag}"`);
    }
    /** ⚠️ And the legacy tag is still listed for vendor payments. */
    expect(readiness).toContain('tags: ["VPY", "RCP"]');
  });
});

/* ================================================================== */
/* ⭐⭐⭐ THE VERDICT                                                   */
/* ================================================================== */

describe("the close verdict", () => {
  it("is ready when nothing is stranded", () => {
    const v = closeVerdict([]);
    expect(v.ready).toBe(true);
    expect(v.strandedCount).toBe(0);
    expect(v.overrideWarning).toBeNull();
    expect(v.headline).toContain("Ready to close");
  });

  /**
   * ⚠️ AN ADVISORY NEVER BLOCKS, and confusing the two is how a check
   * gets overridden in its first week — after which the override is
   * routine and the refusal has become a click.
   */
  it("is still ready with advisories, and says how many", () => {
    const v = closeVerdict([
      blocker({ key: "a", severity: "advisory", source: "GST return" }),
    ]);
    expect(v.ready).toBe(true);
    expect(v.advisory).toHaveLength(1);
    expect(v.blocking).toHaveLength(0);
    expect(v.headline).toContain("1 thing worth a look");
  });

  it("refuses when anything is stranded, and counts documents not categories", () => {
    const v = closeVerdict([
      blocker({ key: "a", count: 3 }),
      blocker({ key: "b", count: 8, source: "vendor payment" }),
    ]);
    expect(v.ready).toBe(false);
    expect(v.strandedCount).toBe(11);
    expect(v.headline).toContain("11 documents");
  });

  /**
   * ⚠️ SORTED BY COUNT, NOT ALPHABETICALLY. The module with forty
   * stranded documents is the one to open first, and by name
   * `brokerage` would sit above it.
   */
  it("puts the biggest pile first", () => {
    const v = closeVerdict([
      blocker({ key: "brokerage", source: "brokerage bill", count: 2 }),
      blocker({ key: "vendor", source: "vendor payment", count: 40 }),
    ]);
    expect(v.blocking[0]!.key).toBe("vendor");
  });

  it("breaks ties on the key so the order is stable", () => {
    const a = blocker({ key: "aaa", count: 5 });
    const z = blocker({ key: "zzz", count: 5 });
    expect(closeVerdict([z, a]).blocking.map((b) => b.key)).toEqual(["aaa", "zzz"]);
  });

  /**
   * ⭐ THE OVERRIDE TEXT NAMES THE CONSEQUENCE AND THE REMEDY, and is
   * deliberately not reassuring — the period lock makes this permanent.
   */
  it("spells out what closing anyway would do", () => {
    const v = closeVerdict([blocker({ count: 4 })]);
    expect(v.overrideWarning).toContain("impossible to post");
    expect(v.overrideWarning).toContain("critical audit event");
  });

  it("uses the singular when exactly one document is stranded", () => {
    const v = closeVerdict([blocker({ count: 1 })]);
    expect(v.headline).toContain("1 document dated in this period has");
    expect(v.overrideWarning).toContain("this document");
  });

  /** ⚠️ Names the modules, so the total is already allocated work. */
  it("describes what is stranded by module", () => {
    const text = describeStranded([
      blocker({ key: "a", source: "sales invoice", count: 3 }),
      blocker({ key: "b", source: "vendor payment", count: 1 }),
    ]);
    expect(text).toBe("3 sales invoices, 1 vendor payment");
  });
});

/* ================================================================== */
/* THE PERIOD ITSELF                                                   */
/* ================================================================== */

describe("the period boundaries", () => {
  const july = { startDate: "2026-07-01", endDate: "2026-07-31" };

  /**
   * ⚠️ INCLUSIVE AT BOTH ENDS, because that is what `financial_periods`
   * stores and what the existing close query compares against. This
   * function exists so the readiness check and the close cannot disagree
   * about which days are in the period.
   */
  it("includes both end days", () => {
    expect(periodContains(july, "2026-07-01")).toBe(true);
    expect(periodContains(july, "2026-07-31")).toBe(true);
    expect(periodContains(july, "2026-06-30")).toBe(false);
    expect(periodContains(july, "2026-08-01")).toBe(false);
  });

  /**
   * 🔴 A MONTH THAT HAS NOT ENDED CANNOT BE FINAL, and this is not a
   * smaller mistake than sealing over unposted documents — everything
   * recorded for the rest of the month is stranded by construction.
   */
  it("refuses a period that is still running, including on its last day", () => {
    expect(periodHasEnded(july, "2026-07-15")).toBe(false);
    expect(periodHasEnded(july, "2026-07-31")).toBe(false);
    expect(periodHasEnded(july, "2026-08-01")).toBe(true);
  });
});

/* ================================================================== */
/* 🔴 WIRED IN, NOT MERELY WRITTEN                                     */
/* ================================================================== */

describe("the check actually guards the close", () => {
  const periods = () => read("server/actions/periods.ts");

  /**
   * ⭐ IT RUNS BEFORE THE BALANCE CHECK, deliberately. A month with
   * missing documents will usually balance, so reporting the balance
   * first would tell somebody the books are fine and then refuse.
   */
  it("runs the readiness check before the balance check", () => {
    const src = periods();
    expect(src).toContain("closeReadiness(ctx.tenant.id");
    expect(src.indexOf("closeReadiness(ctx.tenant.id")).toBeLessThan(
      src.indexOf("Verify the books balance"),
    );
  });

  it("refuses a close with stranded documents unless a reason is given", () => {
    const src = periods();
    expect(src).toContain("!verdict.ready && !data.strandDocumentsReason");
  });

  /**
   * ⚠️ THE OVERRIDE NEEDS A WRITTEN REASON AND `forceUnbalanced` DOES
   * NOT. An unbalanced period is visible on every report forever; a
   * period sealed over missing entries looks perfect.
   */
  it("demands a written reason of real length for the override", () => {
    const schema = read("lib/validators/periods.ts");
    expect(schema).toContain("strandDocumentsReason");
    expect(schema).toMatch(/strandDocumentsReason[\s\S]{0,400}\.min\(\s*20/);
    /** `forceUnbalanced` is still just a boolean — the asymmetry is the point. */
    expect(schema).toContain("forceUnbalanced: z.boolean().default(false)");
  });

  it("refuses to close a period that has not ended", () => {
    expect(periods()).toContain("periodHasEnded({ endDate: period.endDate }, today)");
  });

  /** ⭐ The audit record names the modules, not just a count. */
  it("names the stranded documents in the audit record and raises severity", () => {
    const src = periods();
    expect(src).toContain("describeStranded(verdict.blocking)");
    expect(src).toContain("wasBalanced && verdict.strandedCount === 0 ? \"notice\" : \"critical\"");
  });

  /**
   * ⚠️ THE CHECKLIST IS GATED ON `periods:read`, NOT `periods:close`.
   * The people who post are deliberately not the people who close, so
   * gating it on the closing permission would show the worklist only to
   * the person who cannot act on it.
   */
  it("lets the people who post see the checklist", () => {
    expect(periods()).toContain('requirePermission("periods:read")');
  });
});

describe("a failed probe blocks rather than passing", () => {
  /**
   * 🔴 A CHECK THAT SILENTLY SKIPS WHAT IT CANNOT READ AND REPORTS THE
   * MONTH READY IS WORSE THAN NOT HAVING THE CHECK.
   */
  it("turns an unreadable source into a blocking item", () => {
    const src = read("server/accounting/close-readiness.ts");
    expect(src).toContain("unreadable");
    expect(src).toContain("A MISSING TABLE IS NOT A CLEAN PERIOD");
  });

  /**
   * ⚠️ Identifiers raw, values parameterised. The first draft
   * interpolated the tenant id into the raw string — safe only because
   * of where it came from, which is one refactor from not being safe.
   */
  it("parameterises the tenant id rather than interpolating it", () => {
    const src = read("server/accounting/close-readiness.ts");
    expect(src).toContain("d.tenant_id = ${args.tenantId}::uuid");
    expect(src).not.toContain("'${args.tenantId}'::uuid");
  });
});

describe("the screen is reachable", () => {
  it("has a route and a registry entry gated on the close feature", () => {
    expect(read("app/(crm)/accounting/close/page.tsx")).toContain("CloseBoard");
    const registry = read("lib/modules/registry.ts");
    expect(registry).toContain('href: "/accounting/close"');
    expect(registry).toContain('feature: "accounting.period_close"');
  });

  /**
   * ⭐ OLDEST OPEN PERIOD FIRST. Sealing October while September is open
   * would let a September document be posted into a month already
   * reported.
   */
  it("defaults to the oldest open period", () => {
    expect(read("app/(crm)/accounting/close/page.tsx")).toContain(
      "THE OLDEST OPEN PERIOD, NOT THE NEWEST",
    );
  });
});
