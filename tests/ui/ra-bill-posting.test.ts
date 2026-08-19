/**
 * RA bills → the ledger.
 *
 * The negative-net case is the reason this file is long. A lean month
 * where recovered advances exceed work certified is normal, and it is
 * the shape that breaks a naive posting.
 */
import { describe, expect, it } from "vitest";
import { POSTING_MODULES, POSTING_ROLE_REGISTRY } from "@/lib/accounting/sales-posting";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildRaBillPosting,
  constructionRolesUsed,
  CONSTRUCTION_ROLE_META,
  type ConstructionLeg,
} from "@/lib/accounting/sales-posting";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const RA = read("server/actions/ra-bills.ts");
const POST = read("server/accounting/post-sales.ts");
const GATE = read("scripts/check-posting-coverage.mjs");

function sides(legs: readonly ConstructionLeg[]) {
  let debit = 0n;
  let credit = 0n;
  for (const l of legs) {
    if (l.entryType === "debit") debit += l.amountMinor;
    else credit += l.amountMinor;
  }
  return { debit, credit };
}
const find = (legs: readonly ConstructionLeg[], role: string) =>
  legs.find((l) => l.role === role);

/** ₹10,00,000 certified · 5% retention · 1% cess · 2% TDS · ₹50,000 advance recovered. */
const NORMAL = {
  grossValueMinor: 100_000_000n,
  retentionAmountMinor: 5_000_000n,
  cessAmountMinor: 1_000_000n,
  tdsAmountMinor: 2_000_000n,
  otherDeductionsMinor: 5_000_000n,
  netPayableMinor: 87_000_000n,
  billNumber: "RA-3",
  contractorName: "Shree Constructions",
};

/* ================================================================== */

describe("🔴 a certified RA bill balances", () => {
  const legs = buildRaBillPosting(NORMAL);

  it("debits WIP with the GROSS, before any deduction", () => {
    expect(find(legs, "wip")?.amountMinor).toBe(100_000_000n);
    expect(find(legs, "wip")?.entryType).toBe("debit");
    expect(sides(legs).debit).toBe(sides(legs).credit);
  });

  /**
   * The work was done and the money is owed; it is simply not payable
   * yet. Netting it against WIP understates the asset and makes the
   * release, months later, look like a fresh expense.
   */
  it("holds retention as a LIABILITY, not as a reduction of cost", () => {
    expect(find(legs, "retention_payable")?.entryType).toBe("credit");
    expect(find(legs, "retention_payable")?.amountMinor).toBe(5_000_000n);
    expect(CONSTRUCTION_ROLE_META.retention_payable.accountType).toBe("liability");
  });

  it("credits every statutory deduction separately", () => {
    expect(find(legs, "tds_payable")?.amountMinor).toBe(2_000_000n);
    expect(find(legs, "labour_cess_payable")?.amountMinor).toBe(1_000_000n);
    expect(find(legs, "contractor_recovery")?.amountMinor).toBe(5_000_000n);
  });

  it("credits the contractor only what they actually receive", () => {
    expect(find(legs, "payable")?.amountMinor).toBe(87_000_000n);
    expect(find(legs, "payable")?.entryType).toBe("credit");
  });
});

describe("🔴 a NEGATIVE net payable is normal, and flips the leg", () => {
  /**
   * `db/schema/contracting.ts` says so outright: recovered advances can
   * exceed the work certified in a lean month. The contractor then owes
   * US — so the payable is a DEBIT, never a credit with a minus sign.
   */
  const lean = buildRaBillPosting({
    ...NORMAL,
    grossValueMinor: 10_000_000n,
    retentionAmountMinor: 500_000n,
    cessAmountMinor: 100_000n,
    tdsAmountMinor: 200_000n,
    otherDeductionsMinor: 12_000_000n,
    netPayableMinor: -2_800_000n,
    billNumber: "RA-4",
  });

  it("still balances", () => {
    expect(sides(lean).debit).toBe(sides(lean).credit);
  });

  it("debits the contractor, with a POSITIVE amount", () => {
    const p = find(lean, "payable");
    expect(p?.entryType).toBe("debit");
    expect(p?.amountMinor).toBe(2_800_000n);
  });

  it("says on the entry why the contractor is being debited", () => {
    expect(find(lean, "payable")?.description).toContain("recovered in excess");
  });
});

describe("zero legs drop out", () => {
  it("a bill with no retention, cess or TDS posts two legs", () => {
    const legs = buildRaBillPosting({
      grossValueMinor: 5_000_000n,
      retentionAmountMinor: 0n,
      cessAmountMinor: 0n,
      tdsAmountMinor: 0n,
      otherDeductionsMinor: 0n,
      netPayableMinor: 5_000_000n,
      billNumber: "RA-1",
      contractorName: null,
    });
    expect(constructionRolesUsed(legs).sort()).toEqual(["payable", "wip"]);
  });
});

describe("⭐ the roles are explainable, and the two TDS roles are distinguished", () => {
  /**
   * `tds_payable` is tax we DEDUCT from a contractor. `tds_receivable` is
   * tax our customers deduct from us. Confusing them puts a liability in
   * an asset ledger and is invisible on a balance sheet that still
   * balances.
   */
  it("TDS payable warns that it is not TDS receivable", () => {
    expect(CONSTRUCTION_ROLE_META.tds_payable.help).toContain("Receivable");
    expect(CONSTRUCTION_ROLE_META.tds_payable.accountType).toBe("liability");
  });

  it("WIP is an asset, not an expense", () => {
    expect(CONSTRUCTION_ROLE_META.wip.accountType).toBe("asset");
  });

  /** Honesty about a bucket beats a split that was invented. */
  it("the recovery bucket admits it is mixed", () => {
    expect(CONSTRUCTION_ROLE_META.contractor_recovery.help).toContain("mixed bucket");
  });

  it("the setup screen has a construction section", () => {
    /**
     * ⚠️ THIS USED TO GREP THE FORM FOR THE WORD "construction", which was
     * true only because the section headings were hardcoded there. Batch
     * 0108 made the sections come from the registry, so the form no longer
     * contains the literal — and the section is more present than before,
     * not less. Assert the registry, which is now the thing that decides.
     */
    expect(POSTING_MODULES.construction).toBeDefined();
    expect(POSTING_ROLE_REGISTRY.some((r) => r.modules.includes("construction"))).toBe(true);
    expect(read("components/invoices/posting-setup.tsx")).toContain("moduleStatus");
  });
});

describe("🔴 posted on certification", () => {
  it("certifyRaBill posts, inside the same transaction", () => {
    const c = code(RA);
    const seg = c.slice(
      c.indexOf("export async function certifyRaBill"),
      c.indexOf("export async function approveRaBill"),
    );
    expect(seg).toContain("postRaBill(tx, {");
  });

  /** approveRaBill must NOT post — that would double-count on approval. */
  it("approveRaBill does not post", () => {
    const c = code(RA);
    const seg = c.slice(c.indexOf("export async function approveRaBill"));
    expect(seg).not.toContain("postRaBill(");
  });

  /** March work certified on 4 April is March's cost. */
  it("dates the entry by the work period, not by today", () => {
    expect(code(RA)).toContain("certified.periodTo");
  });

  it("the backlog knows about RA bills, from certified onward", () => {
    const c = code(read("server/actions/sales-posting.ts"));
    expect(c).toContain('kind: "ra_bill" as const');
    expect(c).toContain('inArray(raBills.status, ["certified", "approved", "paid"])');
  });

  it("has its own idempotency tag", () => {
    expect(code(POST)).toContain('"RAB"');
  });
});

describe("🔴 the gate's debt list was corrected, not just extended", () => {
  /** Approving a variation moves no money; the RA bill it feeds does. */
  it("variations was REMOVED from the financial list, with a reason", () => {
    expect(GATE).not.toMatch(/^\s*"variations",$/m);
    expect(GATE).toContain("moves no money on its own");
  });

  /**
   * ⭐⭐⭐ UPDATED IN v1.23.0-alpha, BECAUSE THE DEBT WAS PAID.
   *
   * The excuse went through two corrections and then stopped being an
   * excuse. It first claimed labour needed "five legs with statutory due
   * dates", which was wrong about the blocker. It was corrected to "no
   * payroll run exists", which was right. Batch 15 built the payroll
   * run, so `labour` is off the financial list entirely and `payroll` is
   * on it, posting.
   *
   * ⚠️ THIS TEST NOW ASSERTS THE OUTCOME RATHER THAN THE EXCUSE. An
   * assertion that a debt note still exists is an assertion that the
   * debt is never paid.
   */
  it("the labour debt was cleared by building the thing it was waiting for", () => {
    // `labour` is no longer a financial module: attendance and piece
    // rates are inputs, and the document with the economic effect is the
    // payroll run.
    expect(GATE).not.toMatch(/^\s*"labour",$/m);
    expect(GATE).toMatch(/^\s*"payroll",$/m);
    expect(GATE).toContain("The document is the payroll run".toUpperCase());

    /**
     * ⚠️ THE NEGATIVES RUN AGAINST COMMENT-STRIPPED SOURCE. Both old
     * wordings survive in the comment that EXPLAINS the history, and a
     * test whose only remedy is deleting that explanation is a bad test.
     * This has now caught me three times.
     */
    expect(code(GATE)).not.toContain("five legs with statutory due dates");
    expect(code(GATE)).not.toContain("No payroll run exists");
  });

  it("ra-bills is off the debt list because it now posts", () => {
    const block = GATE.slice(GATE.indexOf("KNOWN_UNPOSTED = {"), GATE.indexOf("/** Any of these"));
    expect(block).not.toContain('"ra-bills"');
  });
});
