/**
 * Purchases → the double-entry ledger, and the seventh gate.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  buildPurchasePosting,
  buildRcmPosting,
  purchaseRolesUsed,
  PURCHASE_ROLE_META,
  type PurchaseLeg,
  type PurchaseLineFacts,
} from "@/lib/accounting/sales-posting";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const POST = read("server/accounting/post-sales.ts");
const PURCHASES = read("server/actions/purchases.ts");
const GATE = read("scripts/check-posting-coverage.mjs");

function sides(legs: readonly PurchaseLeg[]) {
  let debit = 0n;
  let credit = 0n;
  for (const l of legs) {
    if (l.entryType === "debit") debit += l.amountMinor;
    else credit += l.amountMinor;
  }
  return { debit, credit };
}
const find = (legs: readonly PurchaseLeg[], role: string) =>
  legs.find((l) => l.role === role);

/** ₹1,000 + 18% intra-State, fully eligible. */
const ELIGIBLE: PurchaseLineFacts = {
  taxableValueMinor: 100_000n,
  cgstMinor: 9_000n,
  sgstMinor: 9_000n,
  igstMinor: 0n,
  cessMinor: 0n,
  itcBlocked: false,
};

const BLOCKED: PurchaseLineFacts = { ...ELIGIBLE, itcBlocked: true };

/* ================================================================== */

describe("🔴 a vendor bill balances", () => {
  it("debits expense and input tax, credits the creditor", () => {
    const legs = buildPurchasePosting({
      lines: [ELIGIBLE],
      roundOffMinor: 0n,
      totalMinor: 118_000n,
      invoiceNumber: "V/2026/114",
      vendorName: "Bharat Cement",
    });
    expect(sides(legs).debit).toBe(118_000n);
    expect(sides(legs).credit).toBe(118_000n);
    expect(find(legs, "expense")?.amountMinor).toBe(100_000n);
    expect(find(legs, "input_cgst")?.amountMinor).toBe(9_000n);
    expect(find(legs, "payable")?.entryType).toBe("credit");
  });
});

describe("🔴 BLOCKED input tax is COST, never an asset", () => {
  /**
   * Section 17(5) credit can never be claimed. Parking it in an input-tax
   * ledger creates an asset that will never convert to anything and leaves
   * a credit ledger that never reconciles to the portal.
   */
  it("adds blocked tax to the expense and posts no input-tax leg", () => {
    const legs = buildPurchasePosting({
      lines: [BLOCKED],
      roundOffMinor: 0n,
      totalMinor: 118_000n,
      invoiceNumber: "V/1",
      vendorName: null,
    });
    expect(find(legs, "expense")?.amountMinor).toBe(118_000n);
    expect(find(legs, "input_cgst")).toBeUndefined();
    expect(find(legs, "input_sgst")).toBeUndefined();
    expect(sides(legs).debit).toBe(sides(legs).credit);
  });

  /** The eligible split is taken line by line, never apportioned. */
  it("splits a mixed bill exactly, with no apportionment", () => {
    const legs = buildPurchasePosting({
      lines: [ELIGIBLE, BLOCKED],
      roundOffMinor: 0n,
      totalMinor: 236_000n,
      invoiceNumber: "V/2",
      vendorName: null,
    });
    expect(find(legs, "expense")?.amountMinor).toBe(100_000n + 118_000n);
    expect(find(legs, "input_cgst")?.amountMinor).toBe(9_000n);
    expect(find(legs, "input_sgst")?.amountMinor).toBe(9_000n);
    expect(sides(legs).debit).toBe(236_000n);
  });

  /** Rule 42 common credit enters the ledger in full and is reversed separately. */
  it("only `blocked` is cost — the module says so where it is read", () => {
    expect(read("lib/accounting/sales-posting.ts")).toContain("Rule 42 common credit");
    expect(code(PURCHASES)).toContain('l.itcEligibility === "blocked"');
  });
});

describe("🔴 the purchase round-off is the MIRROR of the sales one", () => {
  /** Copying the sales sign produces a transaction that fails at COMMIT. */
  it("a positive round-off is a DEBIT on a purchase", () => {
    const legs = buildPurchasePosting({
      lines: [ELIGIBLE],
      roundOffMinor: 30n,
      totalMinor: 118_030n,
      invoiceNumber: "V/3",
      vendorName: null,
    });
    expect(find(legs, "purchase_round_off")?.entryType).toBe("debit");
    expect(sides(legs).debit).toBe(sides(legs).credit);
  });

  it("a negative round-off is a CREDIT of a positive amount", () => {
    const legs = buildPurchasePosting({
      lines: [ELIGIBLE],
      roundOffMinor: -45n,
      totalMinor: 117_955n,
      invoiceNumber: "V/4",
      vendorName: null,
    });
    const ro = find(legs, "purchase_round_off");
    expect(ro?.entryType).toBe("credit");
    expect(ro?.amountMinor).toBe(45n);
    expect(sides(legs).debit).toBe(sides(legs).credit);
  });
});

describe("🔴 reverse charge is cash out AND credit in", () => {
  const legs = buildRcmPosting({
    rcmTaxMinor: 18_000n,
    invoiceNumber: "V/5",
    rcmSection: "9(3)",
    vendorName: "Freight Co",
  });

  /** Booking only the credit gives a return with a credit and no liability. */
  it("posts both legs, never just the credit", () => {
    expect(purchaseRolesUsed(legs).sort()).toEqual(["input_tax_rcm", "rcm_payable"]);
    expect(find(legs, "input_tax_rcm")?.entryType).toBe("debit");
    expect(find(legs, "rcm_payable")?.entryType).toBe("credit");
    expect(sides(legs).debit).toBe(sides(legs).credit);
  });

  it("names the section on the entry, because it is the evidence", () => {
    expect(legs[0]?.description).toContain("9(3)");
  });

  it("no RCM means no legs at all", () => {
    expect(
      buildRcmPosting({
        rcmTaxMinor: 0n,
        invoiceNumber: "V/6",
        rcmSection: null,
        vendorName: null,
      }),
    ).toEqual([]);
  });

  /**
   * The vendor is not a party to this tax. Folding it into the bill would
   * credit the VENDOR money owed to the GOVERNMENT.
   */
  it("is a SEPARATE transaction, and rcm_tax_minor is not in the total", () => {
    const c = code(POST);
    expect(c).toContain("const rcmKey = `${key}:RCM`");
    expect(c).not.toMatch(/totalMinor:\s*args\.totalMinor\s*\+\s*args\.rcmTaxMinor/);
  });

  /** Writing the bill first would strand the liability behind the idempotency key. */
  it("checks BOTH postings' roles before writing either", () => {
    const c = code(POST);
    const at = c.indexOf("const missing = [");
    expect(at).toBeGreaterThan(-1);
    expect(c.slice(at, at + 400)).toContain("purchaseRolesUsed(rcmLegs)");
    expect(c.indexOf("const written: string[] = []")).toBeGreaterThan(at);
  });
});

describe("⭐ the purchase roles are explainable", () => {
  it("input tax is an ASSET and RCM payable is a LIABILITY", () => {
    expect(PURCHASE_ROLE_META.input_cgst.accountType).toBe("asset");
    expect(PURCHASE_ROLE_META.rcm_payable.accountType).toBe("liability");
    expect(PURCHASE_ROLE_META.rcm_payable.help).toContain("49(4)");
  });

  it("the expense role says blocked tax lands there", () => {
    expect(PURCHASE_ROLE_META.expense.help).toContain("17(5)");
  });

  it("every purchase role has a Tally group", () => {
    for (const [role, meta] of Object.entries(PURCHASE_ROLE_META)) {
      expect(meta.tallyGroup.length, role).toBeGreaterThan(0);
    }
  });
});

describe("🔴 the seventh gate", () => {
  it("passes on the current tree", () => {
    const out = execFileSync("node", ["scripts/check-posting-coverage.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(out).toContain("Posting coverage declared");
  });

  /** A gate whose exemption list is a wildcard is a gate that passes forever. */
  it("its exemption list is explicit, not a pattern", () => {
    expect(GATE).toContain("KNOWN_UNPOSTED");
    expect(GATE).not.toMatch(/KNOWN_UNPOSTED\s*=\s*\[?\s*\/.*\//);
  });

  /** Otherwise the debt list lies about how much is left. */
  it("FAILS a module that both posts and sits on the debt list", () => {
    expect(GATE).toContain("AND is still on KNOWN_UNPOSTED");
  });

  /**
   * ⚠️ THIS ASSERTED A COUNT (">= 7") AND THAT WAS THE WRONG TEST.
   * It passed while one entry had no session, as long as seven others
   * did — and it broke the moment the list legitimately shrank, which is
   * the one thing the list is supposed to do. It now checks EVERY entry.
   */
  /**
   * ══════════════════════════════════════════════════════════════════
   * ⭐⭐⭐ REWRITTEN IN v1.28.0-alpha, BECAUSE THE LIST WENT EMPTY
   * ══════════════════════════════════════════════════════════════════
   * This asserted `keys.length > 0` — that there was ALWAYS at least one
   * excuse. It was a fair assumption for twenty-six sessions and it
   * failed the moment `metering` posted and `billing` was recognised as
   * a category error rather than debt.
   *
   * ⚠️ AND THE LAZY FIX WOULD HAVE BEEN TO DELETE THE ASSERTION. The
   * rule it protects still matters: an excuse without a reason and a
   * session is an entry nobody will ever remove, because there is
   * nothing written down to argue against.
   *
   * ⭐ SO IT NOW ASSERTS THE RULE RATHER THAN THE POPULATION: every
   * excuse that exists is explained, and zero excuses is a legitimate —
   * and, as of this version, the actual — state.
   */
  it("every excuse that exists names a reason and a session", () => {
    const block = GATE.slice(GATE.indexOf("KNOWN_UNPOSTED = {"), GATE.indexOf("/** Any of these"));

    /**
     * ⚠️ EACH ENTRY'S OWN TEXT, NOT A COUNT OF THE WHOLE BLOCK.
     *
     * The first version counted `Session \d+\.` across the block and
     * compared it to the number of keys. That broke the moment the block
     * gained COMMENTARY quoting a removed entry — the prose explaining
     * why `metering` left mentions the session it was added in, and the
     * count went to one against zero keys.
     *
     * ⭐ Counting two things and hoping they line up is not the rule.
     * The rule is that each entry explains itself, so each entry is
     * matched with its own value.
     */
    const entries = [...block.matchAll(/\n {2}(?:"[a-z-]+"|[a-z-]+):\s*(?:\n\s*)?"((?:[^"\\]|\\.)*)"/g)];
    for (const [, text] of entries) {
      expect(text).toMatch(/Session \d+[a-z]?\./);
      /** A reason, not just a citation. */
      expect(text.length).toBeGreaterThan(40);
    }
  });

  /**
   * ⭐ AND THE LIST IS EMPTY TODAY. Worth asserting explicitly rather
   * than leaving as an absence: if an entry comes back, this fails and
   * whoever added it has to say so out loud.
   */
  it("has nothing outstanding", () => {
    const block = GATE.slice(GATE.indexOf("KNOWN_UNPOSTED = {"), GATE.indexOf("/** Any of these"));
    const keys = block.match(/\n {2}(?:"[a-z-]+"|[a-z-]+):/g) ?? [];
    expect(keys).toHaveLength(0);
  });

  it("is wired into package.json", () => {
    expect(read("package.json")).toContain('"check:posting"');
  });
});

describe("🔴 purchases now reach the ledger", () => {
  it("recordPurchaseInvoice posts inside the same transaction", () => {
    expect(code(PURCHASES)).toContain("postPurchaseInvoice(tx, {");
  });

  it("reads the lines it just inserted, by the right column", () => {
    expect(code(PURCHASES)).toContain("purchaseInvoiceLines.purchaseInvoiceId");
  });

  /** A March bill posted in April moves cost across a financial year. */
  it("posts on the bill's date, never today", () => {
    const c = code(POST);
    expect(c).toContain("transactionDate: args.invoiceDate");
  });

  it("the backlog and the setup screen both know about purchases", () => {
    expect(read("server/actions/sales-posting.ts")).toContain('kind: "purchase" as const');
    expect(read("app/(crm)/accounting/posting/page.tsx")).toContain("Vendor bill");
    /** ⚠️ Asserts the MECHANISM — that the form splits by side — not the
     *  heading text, which is prose somebody will reword. */
    expect(read("components/invoices/posting-setup.tsx")).toContain("r.side === side");
  });
});
