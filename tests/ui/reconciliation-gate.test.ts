/**
 * Ordence — ⭐⭐⭐ BATCH 49: THE RECONCILIATION GATE
 * Version: v1.46.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS BATCH DID, AND WHY IT NEEDED DOING
 * ══════════════════════════════════════════════════════════════════════
 * The receivables ageing report is described on its own screen as "the
 * number a bank asks for". It is built from `demand_notices`. The books
 * are built from `journal_entries`. Until this batch NOTHING had ever
 * compared the two — and three routine operations move one without
 * moving the other:
 *
 *   • `withdrawDemand` removes a served demand from the report and posts
 *     no reversing entry;
 *   • `replaceDemand` supersedes one and posts no reversing entry;
 *   • `markReceiptBounced` puts outstanding back on the report and posts
 *     no reversing entry.
 *
 * `lib/accounting/cash-flow.ts` had already settled the doctrine for the
 * cash flow statement in Batch 65: compute twice by two routes that
 * share no ledger, and when they disagree render NO figure — not amber,
 * not asterisked, and not the "true" one either. This batch generalises
 * that doctrine and applies it to the billing and receivables reports.
 *
 * The assertions fall into seven groups:
 *   ① the gate exists, is pure, and reaches the screens
 *   ② the check compares two INDEPENDENT computations
 *   ③ a breach names what disagrees and by how much
 *   ④ rounding is not a breach — but the tolerance is stated and capped
 *   ⑤ an unconfigured workspace is not a pass
 *   ⑥ a breached report yields NO figures, structurally
 *   ⑦ what the receivables reports must equal, and what billing must
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  EXACT,
  ONE_PAISA,
  TOLERANCE_CEILING_MINOR,
  describeBreach,
  reconcile,
  serializeReconciliation,
} from "@/lib/reconciliation/gate";
import {
  AGEING_BREACH_CAUSES,
  COLLECTION_ROLES,
  LEDGER_TRANSACTION_STATUSES,
  RECEIVABLE_CONTROL_ROLE,
  reconcileAgeingReport,
  reconcileStatement,
} from "@/lib/reconciliation/receivables";
import {
  APPLIED_EVENT_STATUS,
  REVERSING_EVENT_TYPES,
  SETTLING_EVENT_TYPES,
  reconcileBillingHistory,
} from "@/lib/reconciliation/billing";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const GATE = read("lib/reconciliation/gate.ts");
const AR = read("lib/reconciliation/receivables.ts");
const BILL = read("lib/reconciliation/billing.ts");
const RECEIVABLE_ACTIONS = read("server/actions/receivables.ts");
const BILLING_ACTIONS = read("server/actions/billing.ts");
const AGEING_PAGE = read("app/(crm)/receivables/page.tsx");
const BILLING_PAGE = read("app/(crm)/billing/page.tsx");
const NOTICE = read("components/reconciliation/reconciliation-notice.tsx");

/**
 * ⚠️ ABSENCE IS ASSERTED AGAINST COMMENT-STRIPPED SOURCE.
 * These files explain at length what they must NOT do — "not amber",
 * "never inferred from an amount", "no figures at all" — so a naive
 * `not.toContain` search would match the prose that forbids the thing
 * and pass while the code did it. Same helper as
 * `tests/ui/order-create.test.ts`.
 */
const codeOnly = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

/** A check that agrees exactly, for reuse. */
const passing = (amount = 100_000n) => ({
  id: "c1",
  claim: "The report must equal the books.",
  toleranceMinor: EXACT,
  report: { label: "the report", source: "documents", amountMinor: amount },
  ledger: { label: "the books", source: "journal_entries", amountMinor: amount },
});

/* ================================================================== */
/* ① IT EXISTS, IT IS PURE, AND IT REACHES THE SCREENS                 */
/* ================================================================== */

describe("the reconciliation gate", () => {
  it("exists as a shared module rather than once per report", () => {
    expect(existsSync(join(ROOT, "lib/reconciliation/gate.ts"))).toBe(true);
    expect(existsSync(join(ROOT, "lib/reconciliation/receivables.ts"))).toBe(true);
    expect(existsSync(join(ROOT, "lib/reconciliation/billing.ts"))).toBe(true);
  });

  /**
   * ⚠️ PURE, LIKE `lib/accounting/cash-flow.ts`. A gate that needed a
   * database to exercise is a gate whose failure modes are tested by
   * nobody — and its whole job is to be right about the failure modes.
   */
  it("is pure: no database, no server-only imports, no clock", () => {
    for (const src of [GATE, AR, BILL]) {
      const code = codeOnly(src);
      expect(code).not.toContain("server-only");
      expect(code).not.toContain('from "@/db"');
      expect(code).not.toContain("drizzle-orm");
      expect(code).not.toContain("new Date(");
      expect(code).not.toContain("Date.now(");
    }
  });

  /**
   * 🔴 MONEY IS `bigint` PAISE AND NEVER A FLOAT. A gate whose own
   * arithmetic drifted would report breaches it created itself, which is
   * the fastest possible way to get a reconciliation switched off.
   */
  it("never converts an amount to a Number", () => {
    for (const src of [GATE, AR, BILL]) {
      const code = codeOnly(src);
      expect(code).not.toContain("parseFloat");
      expect(code).not.toContain("parseInt");
      expect(code).not.toMatch(/Number\(\s*\w*[Mm]inor/);
    }
  });

  it("is wired into both reports and both screens", () => {
    expect(codeOnly(RECEIVABLE_ACTIONS)).toContain("reconcileAgeingReport");
    expect(codeOnly(RECEIVABLE_ACTIONS)).toContain("reconcileStatement");
    expect(codeOnly(BILLING_ACTIONS)).toContain("reconcileBillingHistory");
    expect(codeOnly(AGEING_PAGE)).toContain("ReconciliationNotice");
    expect(codeOnly(BILLING_PAGE)).toContain("ReconciliationNotice");
  });
});

/* ================================================================== */
/* ② TWO **INDEPENDENT** COMPUTATIONS, NOT ONE NUMBER AGAINST ITSELF   */
/* ================================================================== */

describe("the check compares two independent computations", () => {
  /**
   * 🔴 THE DESIGN POINT EVERYTHING ELSE HANGS OFF. A check that reads
   * the same query twice proves only that the query is deterministic,
   * and it looks exactly like a real check on the screen.
   */
  it("treats two sides quoting the same source as a failure, not a pass", () => {
    const verdict = reconcile({
      subject: "Something",
      ledgerConfigured: true,
      checks: [
        {
          id: "self",
          claim: "The total must equal the total.",
          toleranceMinor: EXACT,
          report: { label: "the report", source: "demand_notices", amountMinor: 500n },
          ledger: { label: "the books", source: "demand_notices", amountMinor: 500n },
        },
      ],
    });

    // The amounts agree exactly. It still fails.
    expect(verdict.state).toBe("breached");
    expect(verdict.renderable).toBe(false);
    expect(verdict.breaches.join(" ")).toContain("compares a number with itself");
  });

  it("passes the same figures when the two sources genuinely differ", () => {
    const verdict = reconcile({
      subject: "Something",
      ledgerConfigured: true,
      checks: [passing(500n)],
    });
    expect(verdict.state).toBe("reconciled");
    expect(verdict.renderable).toBe(true);
    expect(verdict.verified).toBe(true);
  });

  /**
   * ⚠️ THE LEDGER SIDE MUST NOT BE FETCHED THROUGH THE REPORT'S OWN
   * TABLES. The receivables action reaches `journal_entries` via the
   * tenant's posting-role map; if it ever started deriving the control
   * balance from `demand_notices` the check would become a tautology
   * while still rendering a tick.
   */
  it("loads the ledger side from the journal, via the posting-role map", () => {
    const code = codeOnly(RECEIVABLE_ACTIONS);
    expect(code).toContain("salesPostingAccounts");
    expect(code).toContain("journalEntries");
    expect(code).toContain("RECEIVABLE_CONTROL_ROLE");
  });

  /**
   * 🔴 THE CONTROL ACCOUNT IS FOUND STRUCTURALLY, NEVER BY NAME. Every
   * tenant builds their own chart of accounts; a ledger matched on
   * `%receivable%` reconciles against the wrong account, silently, for
   * anybody who called theirs "Sundry debtors".
   */
  it("identifies the control account by posting role, never by ledger name", () => {
    expect(RECEIVABLE_CONTROL_ROLE).toBe("booking_receivable");
    const code = codeOnly(AR) + codeOnly(RECEIVABLE_ACTIONS);
    expect(code).not.toMatch(/ilike|%receivable%|LIKE '1/i);
  });

  /**
   * ⚠️ "IN THE BOOKS" MEANS `posted` AND `reversed`, matching the trial
   * balance exactly. A gate that defines it differently fires on healthy
   * data — `reverseTransaction` writes the correction as `posted` and
   * marks the original `reversed`, so "posted only" drops every entry
   * that was ever corrected and puts the control account below the
   * report by the value of each one.
   */
  it("counts the same transaction statuses the financial statements do", () => {
    expect([...LEDGER_TRANSACTION_STATUSES]).toEqual(["posted", "reversed"]);
    expect([...LEDGER_TRANSACTION_STATUSES]).not.toContain("void");
    expect([...LEDGER_TRANSACTION_STATUSES]).not.toContain("pending");
  });
});

/* ================================================================== */
/* ③ A BREACH NAMES WHAT DISAGREES AND BY HOW MUCH                     */
/* ================================================================== */

describe("a breach is actionable, not an outage", () => {
  /**
   * 🔴 "AR ageing says ₹4,20,000.00, the receivables control account says
   * ₹4,05,500.00" is a work item. "Reconciliation failed" is a support
   * ticket that comes back with this sentence typed out by hand.
   */
  it("states both figures and the gap, in rupees", () => {
    const verdict = reconcileAgeingReport({
      ageingTotalMinor: 42_000_000n, // ₹4,20,000.00
      control: {
        configured: true,
        label: "Sundry debtors (1210)",
        balanceMinor: 40_550_000n, // ₹4,05,500.00
      },
      showsInterest: false,
      asOf: "2026-08-15",
      today: "2026-08-15",
    });

    expect(verdict.state).toBe("breached");
    const said = verdict.breaches.join(" ");
    expect(said).toContain("₹4,20,000.00");
    expect(said).toContain("₹4,05,500.00");
    expect(said).toContain("₹14,500.00");
    // And it says WHICH side is the higher, so the reader knows whether
    // the report is overstating or the books are understating.
    expect(said).toContain("higher by");
  });

  it("names the report figure first and the ledger figure second", () => {
    const sentence = describeBreach({
      id: "x",
      claim: "c",
      toleranceMinor: EXACT,
      report: { label: "AR ageing", source: "a", amountMinor: 1_000n },
      ledger: { label: "the control account", source: "b", amountMinor: 400n },
      differenceMinor: 600n,
      breached: true,
      sentence: "",
    });
    expect(sentence.indexOf("AR ageing")).toBeLessThan(
      sentence.indexOf("the control account"),
    );
    expect(sentence).toContain("₹6.00");
  });

  /**
   * ⚠️ THE CAUSES TRAVEL WITH THE BREACH. Every one of these is
   * reachable from the UI today and each one moves the report without
   * moving the ledger. Listing them turns a twenty-minute investigation
   * into a twenty-minute investigation instead of a support round trip.
   */
  it("ships named causes rather than a generic apology", () => {
    expect(AGEING_BREACH_CAUSES.length).toBeGreaterThanOrEqual(3);
    const all = AGEING_BREACH_CAUSES.join(" ");
    expect(all).toContain("withdrawn or superseded");
    expect(all).toContain("bounced");
    expect(codeOnly(RECEIVABLE_ACTIONS)).toContain("AGEING_BREACH_CAUSES");
  });
});

/* ================================================================== */
/* ④ ROUNDING IS NOT A BREACH — AND THE TOLERANCE IS TINY AND CAPPED   */
/* ================================================================== */

describe("the rounding tolerance", () => {
  it("is stated per check and has no default", () => {
    // `toleranceMinor` is required on the input type; the value used by
    // every check in this batch is exact, and that is a claim about the
    // arithmetic on both sides rather than an oversight.
    expect(EXACT).toBe(0n);
    expect(ONE_PAISA).toBe(1n);
  });

  /**
   * 🔴 UNDER ONE RUPEE, ALWAYS. A tolerance wide enough to hide a
   * missing invoice is a tolerance that hides missing invoices.
   */
  it("is capped below one rupee", () => {
    expect(TOLERANCE_CEILING_MINOR).toBe(100n);
  });

  it("does not fail a check for a residue inside a stated band", () => {
    const verdict = reconcile({
      subject: "Something",
      ledgerConfigured: true,
      checks: [
        {
          id: "rounded",
          claim: "It must equal.",
          toleranceMinor: ONE_PAISA,
          report: { label: "the report", source: "a", amountMinor: 100_001n },
          ledger: { label: "the books", source: "b", amountMinor: 100_000n },
        },
      ],
    });
    expect(verdict.state).toBe("reconciled");
  });

  /**
   * 🔴 AN OVER-WIDE TOLERANCE MAKES THE GATE STRICTER, NOT LOOSER. The
   * fail-safe direction matters: honouring a ₹500 band while grumbling
   * in a note below the fold would let the widening work, and the screen
   * would go green. Ignoring it makes the change get noticed.
   */
  it("refuses a rupee-scale tolerance and compares exactly instead", () => {
    const verdict = reconcile({
      subject: "Something",
      ledgerConfigured: true,
      checks: [
        {
          id: "wide",
          claim: "It must equal.",
          // ₹500 — wide enough to swallow a line item.
          toleranceMinor: 50_000n,
          report: { label: "the report", source: "a", amountMinor: 100_100n },
          ledger: { label: "the books", source: "b", amountMinor: 100_000n },
        },
      ],
    });
    expect(verdict.state).toBe("breached");
    expect(verdict.breaches.join(" ")).toContain("outside the permitted range");
    // And the honoured tolerance is zero, not the rejected value.
    expect(verdict.checks[0]?.toleranceMinor).toBe(0n);
  });

  it("treats a negative tolerance the same way rather than failing everything", () => {
    const verdict = reconcile({
      subject: "Something",
      ledgerConfigured: true,
      checks: [{ ...passing(700n), toleranceMinor: -5n }],
    });
    // The figures agree exactly, so the only complaint is the tolerance.
    expect(verdict.breaches.join(" ")).toContain("outside the permitted range");
    expect(verdict.checks[0]?.differenceMinor).toBe(0n);
  });

  /**
   * ⚠️ BOTH RECEIVABLES CHECKS ARE EXACT, and that is asserted rather
   * than trusted: both sides are sums of the same `bigint` paise with no
   * division between the source row and the compared total, so a band
   * would buy nothing and hide up to its own width of a real gap.
   */
  it("is exact for every check this batch ships", () => {
    const ageing = reconcileAgeingReport({
      ageingTotalMinor: 0n,
      control: { configured: true, label: "L", balanceMinor: 0n },
      showsInterest: false,
      asOf: "2026-08-15",
      today: "2026-08-15",
    });
    const statement = reconcileStatement({
      outstandingMinor: 0n,
      receivedMinor: 0n,
      tdsCreditMinor: 0n,
      control: { configured: true, label: "L", balanceMinor: 0n },
      collectionDebitsMinor: 0n,
      collectionsConfigured: true,
      collectionsLabel: "Bank",
    });
    const billing = reconcileBillingHistory({
      registerPaidMinor: 0n,
      eventLogPaidMinor: 0n,
      hasBillingHistory: true,
    });

    for (const verdict of [ageing, statement, billing]) {
      for (const check of verdict.checks) expect(check.toleranceMinor).toBe(0n);
    }
  });
});

/* ================================================================== */
/* ⑤ AN UNCONFIGURED WORKSPACE IS NOT A PASS                           */
/* ================================================================== */

describe("the first run, with no ledger configured", () => {
  /**
   * 🔴 ZERO EQUALS ZERO IS NOT EVIDENCE. On a new workspace nothing is
   * mapped, both sides are zero, and a naive gate paints a green tick
   * over a report nothing has ever checked.
   */
  it("is a third state, not a reconciled one", () => {
    const verdict = reconcileAgeingReport({
      ageingTotalMinor: 0n,
      control: { configured: false, label: "not mapped", balanceMinor: 0n },
      showsInterest: false,
      asOf: "2026-08-15",
      today: "2026-08-15",
    });
    expect(verdict.state).toBe("unconfigured");
    expect(verdict.verified).toBe(false);
    expect(verdict.notes.join(" ")).toContain("No receivables control account is mapped");
  });

  /**
   * ⚠️ AND THE FIGURES STILL SHOW, which is where this DEPARTS from
   * `buildCashFlow` on purpose. A cash flow statement is a statement
   * ABOUT the cash ledgers, so with none there is no statement. An
   * ageing report is a statement about DEMAND NOTICES — primary
   * documents that exist whether or not anybody mapped a chart of
   * accounts — and the ledger is the CHECK, not the subject. Withholding
   * it would take the only receivables view away from every tenant who
   * has not configured accounting, in service of a check that was never
   * available to them.
   */
  it("still renders the figures, because nothing contradicts them", () => {
    const verdict = reconcileAgeingReport({
      ageingTotalMinor: 42_000_000n,
      control: { configured: false, label: "not mapped", balanceMinor: 0n },
      showsInterest: false,
      asOf: "2026-08-15",
      today: "2026-08-15",
    });
    expect(verdict.state).toBe("unconfigured");
    expect(verdict.renderable).toBe(true);
    expect(verdict.verified).toBe(false);
  });

  /**
   * 🔴 `renderable` AND `verified` ARE TWO FLAGS, NOT ONE. An UNCHECKED
   * number and a number that FAILED its check are different facts and
   * must not look the same.
   */
  it("distinguishes unchecked from checked-and-wrong", () => {
    const unchecked = reconcile({
      subject: "S",
      ledgerConfigured: false,
      checks: [passing(0n)],
    });
    const wrong = reconcile({
      subject: "S",
      ledgerConfigured: true,
      checks: [
        {
          ...passing(0n),
          ledger: { label: "the books", source: "journal_entries", amountMinor: 1n },
        },
      ],
    });

    expect(unchecked.renderable).toBe(true);
    expect(unchecked.verified).toBe(false);
    expect(wrong.renderable).toBe(false);
    expect(wrong.verified).toBe(false);
  });

  /**
   * ⚠️ A BREACH OUTRANKS A MISSING CONFIGURATION. The unconfigured test
   * runs AFTER the checks; testing it first would swallow a real breach
   * under a mild "not set up yet" notice — the softest presentation of
   * the loudest fact.
   */
  it("reports a breach even when the ledger is only partly configured", () => {
    const verdict = reconcileStatement({
      outstandingMinor: 500_000n,
      receivedMinor: 0n,
      tdsCreditMinor: 0n,
      // Control account mapped and disagreeing…
      control: { configured: true, label: "Debtors (1210)", balanceMinor: 0n },
      // …while the collection roles are not mapped at all.
      collectionDebitsMinor: 0n,
      collectionsConfigured: false,
      collectionsLabel: "not mapped",
    });
    expect(verdict.state).toBe("breached");
    expect(verdict.renderable).toBe(false);
  });

  /**
   * 🔴 "CONFIGURED" IS A STRUCTURAL FACT, NEVER INFERRED FROM AN AMOUNT.
   * A gate that read "unconfigured" off `0n === 0n` would let a tenant
   * whose control balance is coincidentally zero slip out of the checked
   * state entirely.
   */
  it("derives the configured flag from the posting-role map, not the balance", () => {
    const code = codeOnly(RECEIVABLE_ACTIONS);
    expect(code).toContain("configured: rows.length > 0");
    expect(code).not.toContain("configured: balanceMinor !== 0n");
  });

  it("says a brand-new billing workspace has nothing to reconcile", () => {
    const verdict = reconcileBillingHistory({
      registerPaidMinor: 0n,
      eventLogPaidMinor: 0n,
      hasBillingHistory: false,
    });
    expect(verdict.state).toBe("unconfigured");
    expect(verdict.verified).toBe(false);
    expect(verdict.notes.join(" ")).toContain("never been invoiced");
  });

  /**
   * ⚠️ AN ISSUED-BUT-UNPAID INVOICE IS **CHECKED**, NOT UNCONFIGURED.
   * The register says nothing arrived and the log agrees, and that
   * agreement is worth something. Only the total absence of both is a
   * workspace with nothing to check.
   */
  it("counts an unpaid invoice as a checkable state", () => {
    const verdict = reconcileBillingHistory({
      registerPaidMinor: 0n,
      eventLogPaidMinor: 0n,
      hasBillingHistory: true,
    });
    expect(verdict.state).toBe("reconciled");
    expect(verdict.verified).toBe(true);
  });
});

/* ================================================================== */
/* ⑥ A BREACHED REPORT YIELDS NO FIGURES, STRUCTURALLY                 */
/* ================================================================== */

describe("what a breached report returns", () => {
  /**
   * 🔴 THE FIGURES ARE **ABSENT** FROM THE PAYLOAD, not zeroed and not
   * hidden behind a boolean the screen is trusted to check. A page that
   * ignores the gate fails to compile rather than printing a wrong
   * total, and that matters because more screens will consume these
   * actions than exist today.
   */
  it("returns the ageing figures under an optional key", () => {
    const code = codeOnly(RECEIVABLE_ACTIONS);
    expect(code).toContain("figures?: AgeingFigures");
    expect(code).toContain("figures?: StatementFigures");
    expect(code).toContain("if (!verdict.renderable)");
  });

  /**
   * ⚠️ THE NARRATIVE GOES WITH THE NUMBERS. Every line of it quotes a
   * rupee amount; returning the prose while withholding the totals hands
   * over exactly the figures the gate refused, in sentences — and prose
   * reads as MORE authoritative because somebody appears to have written
   * it.
   */
  it("keeps the statement narrative inside the withheld figures", () => {
    const code = codeOnly(RECEIVABLE_ACTIONS);
    const figures = code.slice(
      code.indexOf("export type StatementFigures"),
      code.indexOf("export type StatementResult"),
    );
    expect(figures).toContain("narrative");
  });

  /**
   * 🔴 AND THE SCREEN DOES NOT RENDER THE CONTROL-ACCOUNT BALANCE EITHER,
   * even though it is a fact read straight off the ledger. `cash-flow.ts`
   * settled this: a true number printed under a heading that has just
   * failed its own check is read as verified.
   */
  it("renders the banner alone when the ageing report does not reconcile", () => {
    const code = codeOnly(AGEING_PAGE);
    expect(code).toContain("if (!figures)");
    // The bucket table is reached only after the guard.
    expect(code.indexOf("if (!figures)")).toBeLessThan(code.indexOf("BUCKETS.map"));
  });

  it("drops the settlement column from the billing table on a breach", () => {
    const code = codeOnly(BILLING_PAGE);
    expect(code).toContain("settlementUsable");
    expect(code).toContain('reconciliation.state !== "breached"');
    // The "still owing" card is a subtraction of the withheld figure, so
    // it goes dark with it — chasing a customer who has paid is the harm.
    expect(code).toContain("const owing = settlementUsable");
  });

  it("strips the paid amounts from the payload rather than blanking them", () => {
    const code = codeOnly(BILLING_ACTIONS);
    expect(code).toContain("amountPaidMinor: _p");
    expect(code).toContain("verdict.renderable");
  });

  /**
   * ⚠️ THE BANNER IS NEVER AMBER. Amber means "a number you can still
   * use", and a receivables total that disagrees with the books is not
   * one. There is no half-trusted state, so there is no half-trusted
   * colour.
   */
  it("uses red for a breach and never amber", () => {
    const code = codeOnly(NOTICE);
    expect(code).toContain("border-red-400");
    expect(code).not.toContain("amber");
    // And no green tick on the passing state either — a tick invites the
    // reader to stop reading.
    expect(code).not.toContain("text-green");
  });

  it("serialises every amount as a string, because bigint cannot cross the boundary", () => {
    const wire = serializeReconciliation(
      reconcile({ subject: "S", ledgerConfigured: true, checks: [passing(12_345n)] }),
    );
    expect(typeof wire.checks[0]?.reportMinor).toBe("string");
    expect(wire.checks[0]?.reportMinor).toBe("12345");
    expect(() => JSON.stringify(wire)).not.toThrow();
  });
});

/* ================================================================== */
/* ⑦ WHAT EACH REPORT ASSERTS, AND WHAT IT MUST EQUAL                  */
/* ================================================================== */

describe("the receivables ageing report", () => {
  it("must equal the receivables control account balance", () => {
    const verdict = reconcileAgeingReport({
      ageingTotalMinor: 1_000_000n,
      control: { configured: true, label: "Debtors (1210)", balanceMinor: 1_000_000n },
      showsInterest: false,
      asOf: "2026-08-15",
      today: "2026-08-15",
    });
    expect(verdict.state).toBe("reconciled");
    expect(verdict.checks[0]?.id).toBe("ageing-total-vs-control");
  });

  /**
   * 🔴 A BACK-DATED AGEING REPORT CANNOT BE RECONCILED, AND SAYS SO.
   * `ageingRows` selects demands by their CURRENT status and computes
   * outstanding from the demand row as it stands NOW; `asOf` only buckets
   * and accrues. So a report headed "as at 31 March" shows today's
   * balances arranged into March's buckets. The ledger side has no such
   * ambiguity. Quietly reconciling the two would be the worst option
   * available: the figures would tie and the reader would take a
   * two-date mixture as verified.
   */
  it("refuses when the as-at date is not today", () => {
    const verdict = reconcileAgeingReport({
      ageingTotalMinor: 1_000_000n,
      control: { configured: true, label: "Debtors (1210)", balanceMinor: 1_000_000n },
      showsInterest: false,
      asOf: "2026-03-31",
      today: "2026-08-15",
    });
    // Same figures on both sides — and it still refuses.
    expect(verdict.state).toBe("breached");
    expect(verdict.renderable).toBe(false);
    expect(verdict.breaches.join(" ")).toContain("as they stand today");
  });

  /**
   * ⚠️ THE INTEREST COLUMN HAS NO LEDGER COUNTERPART AT ALL.
   * `delay_interest_income` is declared as a posting role and nothing in
   * the product ever posts to it. So that figure is not wrong, it is
   * UNCHECKABLE — and letting it sit silently inside a card headed
   * "reconciled" is the exact laundering this batch exists to stop.
   */
  it("declares the interest figure as unchecked even when everything else passes", () => {
    const verdict = reconcileAgeingReport({
      ageingTotalMinor: 1_000_000n,
      control: { configured: true, label: "Debtors (1210)", balanceMinor: 1_000_000n },
      showsInterest: true,
      asOf: "2026-08-15",
      today: "2026-08-15",
    });
    expect(verdict.state).toBe("reconciled");
    expect(verdict.notes.join(" ")).toContain("never posted to the ledger");
  });

  /**
   * ⚠️ THE GATE RUNS ON THE WORKSPACE-WIDE TOTAL EVEN WHEN A PROJECT
   * FILTER IS APPLIED. A journal entry carries a BOOKING as its
   * counterparty and has no project column, so a per-project slice of
   * the control account does not exist. Skipping the check whenever a
   * filter is applied would switch the gate off exactly when somebody is
   * drilling into a figure they already distrust.
   */
  it("reconciles the unfiltered total when the display is filtered", () => {
    const code = codeOnly(RECEIVABLE_ACTIONS);
    expect(code).toContain("workspaceTotalMinor");
    expect(code).toContain("ageingTotalMinor: workspaceTotalMinor");
  });
});

describe("the statement of account", () => {
  /**
   * ⚠️ TWO CHECKS, NOT ONE COMBINED FIGURE. "Still owes" and "has paid"
   * fail for different reasons and are fixed by different people, and a
   * single combined check is satisfied by an error in each direction
   * cancelling out — the one case where BOTH halves are wrong.
   */
  it("checks what is owed and what was collected separately", () => {
    const verdict = reconcileStatement({
      outstandingMinor: 300_000n,
      receivedMinor: 700_000n,
      tdsCreditMinor: 0n,
      control: { configured: true, label: "Debtors (1210)", balanceMinor: 300_000n },
      collectionDebitsMinor: 700_000n,
      collectionsConfigured: true,
      collectionsLabel: "HDFC current (1010)",
    });
    expect(verdict.state).toBe("reconciled");
    expect(verdict.checks.map((c) => c.id)).toEqual([
      "statement-outstanding-vs-control",
      "statement-collected-vs-cash",
    ]);
  });

  it("would pass a single combined check that both halves fail", () => {
    // Owed is ₹1,000 too high; collected is ₹1,000 too low. A combined
    // check nets to zero. Two checks catch both.
    const verdict = reconcileStatement({
      outstandingMinor: 400_000n,
      receivedMinor: 600_000n,
      tdsCreditMinor: 0n,
      control: { configured: true, label: "Debtors (1210)", balanceMinor: 300_000n },
      collectionDebitsMinor: 700_000n,
      collectionsConfigured: true,
      collectionsLabel: "HDFC current (1010)",
    });
    expect(verdict.state).toBe("breached");
    expect(verdict.checks.filter((c) => c.breached)).toHaveLength(2);
  });

  /**
   * 🔴 TDS UNDER SECTION 194-IA IS RECEIVED MONEY. A buyer paying for a
   * flat above ₹50 lakh deducts 1% and pays it to the Government on the
   * developer's behalf, and `buildBookingReceiptPosting` debits it
   * alongside the bank. Leaving it out of the collected side would show
   * every such booking as permanently 1% short.
   */
  it("counts TDS as money collected, alongside the bank", () => {
    expect([...COLLECTION_ROLES]).toEqual(["bank", "tds_receivable"]);
    const verdict = reconcileStatement({
      outstandingMinor: 0n,
      receivedMinor: 9_900_000n,
      tdsCreditMinor: 100_000n,
      control: { configured: true, label: "Debtors (1210)", balanceMinor: 0n },
      collectionDebitsMinor: 10_000_000n,
      collectionsConfigured: true,
      collectionsLabel: "HDFC current (1010), TDS receivable (1450)",
    });
    expect(verdict.state).toBe("reconciled");
  });

  /**
   * ⚠️ DEBITS ONLY, NOT THE NET MOVEMENT. A cancellation refund CREDITS
   * the bank against the same booking; netting it off would make a
   * refunded booking look like one that never paid.
   */
  it("compares collections against ledger DEBITS, never the net movement", () => {
    expect(codeOnly(RECEIVABLE_ACTIONS)).toContain("collections.debitMinor");
    expect(codeOnly(RECEIVABLE_ACTIONS)).not.toContain(
      "collectionDebitsMinor: collections.balanceMinor",
    );
  });
});

describe("the subscription billing history", () => {
  /**
   * 🔴 THE SECOND SOURCE IS THE APPEND-ONLY PAYMENT LOG. There is no
   * double-entry ledger behind platform billing, and that is not a
   * reason to skip the check: a mutable summary
   * (`invoices.amount_paid_minor`) checked against a provider-verified,
   * uniquely-indexed event log is exactly the shape of a bank
   * reconciliation, and it fails the same way.
   */
  it("checks the invoice register against the payment event log", () => {
    const verdict = reconcileBillingHistory({
      registerPaidMinor: 500_000n,
      eventLogPaidMinor: 500_000n,
      hasBillingHistory: true,
    });
    expect(verdict.checks[0]?.id).toBe("invoice-paid-vs-event-log");
    expect(verdict.state).toBe("reconciled");
  });

  it("names both figures when the register lags the log", () => {
    const verdict = reconcileBillingHistory({
      registerPaidMinor: 0n,
      eventLogPaidMinor: 500_000n,
      hasBillingHistory: true,
    });
    expect(verdict.state).toBe("breached");
    const said = verdict.breaches.join(" ");
    expect(said).toContain("₹5,000.00");
    expect(said).toContain("the payment event log");
  });

  /**
   * ⚠️ ONLY EVENTS THAT WERE ACTUALLY APPLIED, AND ONLY ONES THAT NAME
   * AN INVOICE. `received`, `ignored_duplicate`, `ignored_unknown_tenant`
   * and `failed` are recorded precisely BECAUSE they were not applied —
   * counting a duplicate doubles a payment and counting a failure
   * invents one.
   */
  it("counts only processed, invoice-bearing money events", () => {
    expect(APPLIED_EVENT_STATUS).toBe("processed");
    expect([...SETTLING_EVENT_TYPES]).toEqual(["payment_succeeded", "invoice_paid"]);
    expect([...REVERSING_EVENT_TYPES]).toEqual(["payment_refunded"]);
    const code = codeOnly(BILLING_ACTIONS);
    expect(code).toContain("invoiceId} IS NOT NULL");
    expect(code).toContain("APPLIED_EVENT_STATUS");
  });

  /**
   * 🔴 THE PAGE LIMIT MUST NOT BOUND THE CHECK. A reconciliation over
   * the most recent sixty invoices passes on a workspace whose
   * sixty-first is the unapplied one, and it would start and stop
   * failing as new invoices pushed old ones off the page — a gate whose
   * verdict depends on a display parameter can be turned off by paging.
   */
  it("aggregates the whole register, not the page", () => {
    const code = codeOnly(BILLING_ACTIONS);
    const body = code.slice(code.indexOf("export async function listInvoices"));
    const aggregate = body.slice(body.indexOf("invoiceCount"));
    expect(aggregate.slice(0, aggregate.indexOf("paymentEvents"))).not.toContain(
      ".limit(",
    );
  });
});
