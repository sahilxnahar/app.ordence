/**
 * Ordence — ⭐⭐⭐ BATCH 65: THE CASH FLOW STATEMENT, AND THE STATUS FILTER
 * Version: v1.44.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 PART ONE — THERE WAS NO THIRD STATEMENT
 * ══════════════════════════════════════════════════════════════════════
 * A profitable business runs out of money. The P&L said ₹40 lakh of
 * profit, the balance sheet said ₹40 lakh of receivables, and nothing in
 * the product said the bank had ₹11,000 in it and payroll was Friday.
 *
 * ⭐ AND THE HALF THAT IS EASY TO GET WRONG IS NOT THE ARITHMETIC — it is
 * an identity and it falls out of double entry. It is the RECONCILIATION.
 * The closing cash figure is computed twice by two routes that share no
 * ledger, and if they disagree the statement must say so rather than
 * render a number. A cash flow figure that is nearly right is acted on
 * exactly like one that is right.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 PART TWO — NO STATEMENT FILTERED `transactions.status`
 * ══════════════════════════════════════════════════════════════════════
 * A `void` transaction was counted in the trial balance, the P&L and the
 * balance sheet exactly like a real one.
 *
 * ⚠️ AND THE OBVIOUS FIX IS THE WRONG ONE. "Posted only" is what every
 * single-transaction lookup in this codebase uses, and on a statement it
 * is worse than no filter: `reverseTransaction` writes the mirror entry
 * as a NEW `posted` transaction and marks the ORIGINAL `reversed`, so
 * "posted only" keeps every correction and drops every thing corrected.
 * Turnover goes negative by the value of each reversed sale, in a
 * statement that balances perfectly.
 *
 * These assertions fall into five groups:
 *   ① the module exists, is pure, and reaches the screen
 *   ② the indirect method is an identity, and reconciles
 *   ③ it refuses to render a number when it does not reconcile
 *   ④ cash ledgers are identified structurally, never by name
 *   ⑤ the status set is posted + reversed, and nothing else
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildCashFlow, explainCashFlowFailure } from "@/lib/accounting/cash-flow";
import type { CashLedger, LedgerMovement } from "@/lib/accounting/cash-flow";
import { previousDay, resolveStatementPeriod } from "@/lib/accounting/periods";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const CASHFLOW = read("lib/accounting/cash-flow.ts");
const PERIODS = read("lib/accounting/periods.ts");
const ACTIONS = read("server/actions/accounting.ts");
const STATEMENTS = read("app/(crm)/statements/page.tsx");
const ACCOUNTING = read("app/(crm)/accounting/page.tsx");

/**
 * ⚠️ ABSENCE IS ASSERTED AGAINST COMMENT-STRIPPED SOURCE.
 * These files explain at length what they must NOT do — "never match a
 * ledger by name", "do not add depreciation back a second time" — and
 * those sentences contain the very words a naive grep looks for. A test
 * that searches the raw text fails on the comment warning against the
 * thing. Strip first, then assert. Same helper as
 * `tests/ui/order-create.test.ts`.
 */
const codeOnly = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

/* ================================================================== */
/* A WORKED YEAR, IN PAISE                                             */
/* ================================================================== */

/**
 * ⭐ ONE FINANCIAL YEAR, BUILT FROM WHOLE BALANCED TRANSACTIONS so that
 * the movements below are the movements a real ledger would produce:
 *
 *   ① Sale on credit                 Dr Receivables 10,00,000
 *                                        Cr Revenue        10,00,000
 *   ② Customer pays 6,00,000         Dr Bank         6,00,000
 *                                        Cr Receivables     6,00,000
 *   ③ Expenses paid in cash          Dr Expenses     2,00,000
 *                                        Cr Bank            2,00,000
 *   ④ Depreciation                   Dr Depreciation   50,000
 *                                        Cr Accum. depn      50,000   ← NON-CASH
 *   ⑤ Plant bought on credit         Dr Plant        3,00,000
 *                                        Cr Payables        3,00,000   ← NON-CASH
 *
 * 🔴 ④ AND ⑤ ARE THE INTERESTING ONES. Neither touched the bank, and
 * neither is named anywhere in `lib/accounting/cash-flow.ts`. They have
 * to come out right purely from their movements.
 *
 * Profit for the year: 10,00,000 − 2,00,000 − 50,000 = ₹7,50,000.
 * Cash actually moved:  6,00,000 − 2,00,000        = ₹4,00,000.
 * The gap between those two numbers is the entire reason this statement
 * exists, and it is what the lines below have to explain.
 */
const RUPEE = 100n; // paise per rupee. Money is bigint, never a float.
const R = (rupees: bigint) => rupees * RUPEE;

const BANK: CashLedger = {
  ledgerId: "led-bank",
  code: "1100",
  name: "HDFC current",
  source: "bank_account",
};

const YEAR_MOVEMENTS: LedgerMovement[] = [
  // Debit-positive, exactly as `ledgerBalances` produces them.
  { ledgerId: "led-bank", code: "1100", name: "HDFC current", type: "operating", accountType: "asset", movementMinor: R(400_000n) },
  { ledgerId: "led-recv", code: "1200", name: "Sundry debtors", type: "operating", accountType: "asset", movementMinor: R(400_000n) },
  { ledgerId: "led-plant", code: "1500", name: "Plant & machinery", type: "operating", accountType: "asset", movementMinor: R(300_000n) },
  { ledgerId: "led-depn", code: "1590", name: "Accumulated depreciation", type: "operating", accountType: "asset", movementMinor: -R(50_000n) },
  { ledgerId: "led-pay", code: "2100", name: "Sundry creditors", type: "operating", accountType: "liability", movementMinor: -R(300_000n) },
  { ledgerId: "led-rev", code: "4000", name: "Sales", type: "operating", accountType: "revenue", movementMinor: -R(1_000_000n) },
  { ledgerId: "led-exp", code: "5000", name: "Administrative expenses", type: "operating", accountType: "expense", movementMinor: R(200_000n) },
  { ledgerId: "led-dep", code: "5400", name: "Depreciation", type: "operating", accountType: "expense", movementMinor: R(50_000n) },
];

const OPENING = R(100_000n);
const CLOSING = R(500_000n); // opening 1,00,000 + 4,00,000 moved.

const cleanYear = () =>
  buildCashFlow({
    movements: YEAR_MOVEMENTS,
    cashLedgers: [BANK],
    openingCashMinor: OPENING,
    actualClosingCashMinor: CLOSING,
  });

/* ================================================================== */
/* ① THE MODULE EXISTS, IS PURE, AND REACHES THE SCREEN                */
/* ================================================================== */

describe("the cash flow statement exists", () => {
  it("ships a pure arithmetic module", () => {
    expect(existsSync(join(ROOT, "lib/accounting/cash-flow.ts"))).toBe(true);
  });

  /**
   * ⚠️ PURE, LIKE `lib/payroll/payslip.ts` AND FOR THE SAME REASON. A
   * cash flow statement is the kind of thing somebody checks by hand with
   * a calculator and a reason to care. Arithmetic that can only be
   * exercised by standing up Postgres gets tested once and then trusted
   * forever.
   */
  it("has no database, no clock and no server imports", () => {
    const code = codeOnly(CASHFLOW);
    expect(code).not.toContain('from "@/db"');
    expect(code).not.toContain("drizzle-orm");
    expect(code).not.toContain("withTenant");
    expect(code).not.toContain("new Date(");
    expect(code).not.toContain('"use server"');
  });

  /** 🔴 Money is bigint paise. No float ever touches a rupee figure. */
  it("keeps every figure out of IEEE-754", () => {
    for (const src of [CASHFLOW, ACTIONS]) {
      const code = codeOnly(src);
      expect(code).not.toContain("parseFloat");
      expect(code).not.toContain("toFixed(");
      expect(code).not.toMatch(/Number\((?!.*length)/);
    }
  });

  /**
   * ⚠️ EVERY `"use server"` EXPORT IS A URL THE BROWSER CAN POST TO. An
   * unguarded one here returns a company's bank balances to anybody who
   * knows the action id.
   */
  it("guards the new server export", () => {
    const code = codeOnly(ACTIONS);
    const body = code
      .split(/export async function /)
      .slice(1)
      .find((b) => b.startsWith("getCashFlowStatement"));
    expect(body, "getCashFlowStatement is exported").toBeDefined();
    expect(body).toContain("await requireTenantContext()");
  });

  it("is rendered on the statements page for the same period", () => {
    const code = codeOnly(STATEMENTS);
    expect(code).toContain("getCashFlowStatement(");
    expect(code).toContain("getCashFlowStatement({ from: period.from, to: period.to })");
    expect(code).toContain("<CashFlowCard");
  });

  /** And the ledger screen links to it, so it is reachable without a URL. */
  it("is linked from the accounting screen", () => {
    expect(codeOnly(ACCOUNTING)).toContain('href="/statements"');
  });
});

/* ================================================================== */
/* ② THE INDIRECT METHOD IS AN IDENTITY, AND IT RECONCILES             */
/* ================================================================== */

describe("the indirect method", () => {
  it("reconciles a clean year to the paisa", () => {
    const s = cleanYear();
    expect(s.problems).toEqual([]);
    expect(s.discrepancyMinor).toBe(0n);
    expect(s.snapshotGapMinor).toBe(0n);
    expect(s.reconciles).toBe(true);
    expect(s.usable).toBe(true);
    expect(explainCashFlowFailure(s)).toEqual([]);
  });

  it("starts from the period's profit, in the reader's sign", () => {
    // 10,00,000 revenue − 2,00,000 expenses − 50,000 depreciation.
    expect(cleanYear().netResultMinor).toBe(R(750_000n));
  });

  /**
   * 🔴 THE NUMBER THE WHOLE STATEMENT EXISTS TO PRODUCE. Profit was
   * ₹7,50,000 and the bank moved ₹4,00,000. A business reading only the
   * P&L is ₹3,50,000 more confident than it should be.
   */
  it("arrives at the movement the bank actually saw", () => {
    const s = cleanYear();
    expect(s.netMovementMinor).toBe(R(400_000n));
    expect(s.computedClosingCashMinor).toBe(CLOSING);
    expect(s.actualClosingCashMinor).toBe(CLOSING);
  });

  /**
   * ⭐⭐ DEPRECIATION IS ADDED BACK WITHOUT BEING NAMED.
   *
   * The ₹50,000 charge reduced the profit above. Its other leg — the
   * credit to accumulated depreciation — appears here as a POSITIVE cash
   * effect of exactly ₹50,000 and cancels it. Nothing in the module
   * looked for a ledger called "depreciation", and a tenant whose account
   * is called "Wear & tear" gets the identical answer.
   */
  it("adds back non-cash charges through their other leg, not by name", () => {
    const s = cleanYear();
    const accumulated = s.assetMovements.find((l) => l.code === "1590");
    expect(accumulated?.cashEffectMinor).toBe(R(50_000n));
    // And the module never mentions depreciation in code — only in prose.
    expect(codeOnly(CASHFLOW).toLowerCase()).not.toContain("deprecia");
  });

  /**
   * ⚠️ THE SIGNS, ONE BY ONE. Each of these is the one somebody flips.
   */
  it("signs every movement as an effect on cash", () => {
    const s = cleanYear();
    const line = (code: string) =>
      [...s.assetMovements, ...s.fundingMovements].find((l) => l.code === code)
        ?.cashEffectMinor;

    // Receivables ROSE by 4,00,000 — earned and not collected. Cash out.
    expect(line("1200")).toBe(-R(400_000n));
    // Plant bought. Cash out.
    expect(line("1500")).toBe(-R(300_000n));
    // Payables ROSE — incurred and not yet paid. Cash still in hand.
    expect(line("2100")).toBe(R(300_000n));

    expect(s.assetMovementTotalMinor).toBe(-R(650_000n));
    expect(s.fundingMovementTotalMinor).toBe(R(300_000n));
  });

  /**
   * 🔴 THE CASH LEDGER IS NOT ALSO A WORKING-CAPITAL LINE.
   * A bank account is an ASSET. Bucket by account type before checking
   * cash membership and the same rupees are counted on both sides of the
   * reconciliation — the gap comes out at exactly twice the period's cash
   * movement, which is large enough to look like a missing transaction
   * and shaped exactly like one.
   */
  it("never counts a cash ledger as a working-capital movement", () => {
    const s = cleanYear();
    const codes = [...s.assetMovements, ...s.fundingMovements].map((l) => l.ledgerId);
    expect(codes).not.toContain("led-bank");
    expect(s.directCashMovementMinor).toBe(R(400_000n));
  });

  /** A ledger listed twice by two different sources is still one ledger. */
  it("de-duplicates a ledger that is both a bank account and the mapped role", () => {
    const s = buildCashFlow({
      movements: YEAR_MOVEMENTS,
      cashLedgers: [BANK, { ...BANK, source: "posting_role" }],
      openingCashMinor: OPENING,
      actualClosingCashMinor: CLOSING,
    });
    expect(s.cashLedgers).toHaveLength(1);
    expect(s.usable).toBe(true);
    expect(s.directCashMovementMinor).toBe(R(400_000n));
  });

  /** A loss and a shrinking bank balance are the same arithmetic. */
  it("handles a loss and a fall in cash", () => {
    const s = buildCashFlow({
      movements: [
        { ledgerId: "led-bank", code: "1100", name: "HDFC current", type: "operating", accountType: "asset", movementMinor: -R(80_000n) },
        { ledgerId: "led-exp", code: "5000", name: "Expenses", type: "operating", accountType: "expense", movementMinor: R(80_000n) },
      ],
      cashLedgers: [BANK],
      openingCashMinor: R(100_000n),
      actualClosingCashMinor: R(20_000n),
    });
    expect(s.netResultMinor).toBe(-R(80_000n));
    expect(s.netMovementMinor).toBe(-R(80_000n));
    expect(s.usable).toBe(true);
  });
});

/* ================================================================== */
/* ③ 🔴 WHEN IT DOES NOT RECONCILE IT SAYS SO — IT DOES NOT GUESS      */
/* ================================================================== */

describe("the reconciliation", () => {
  /**
   * ⭐ THE FAULT THIS CATCHES IN THE FIELD: a ledger soft-deleted after
   * entries were posted to it. `ledgerBalances` filters on `deleted_at`,
   * so its movement vanishes from the statement while its journal entries
   * survive — and the trial balance, the P&L and the balance sheet all
   * still balance, because a filtered set of whole transactions always
   * does. Only the cash reconciliation notices.
   */
  it("refuses when a ledger's movement has gone missing", () => {
    const s = buildCashFlow({
      movements: YEAR_MOVEMENTS.filter((m) => m.ledgerId !== "led-plant"),
      cashLedgers: [BANK],
      openingCashMinor: OPENING,
      actualClosingCashMinor: CLOSING,
    });

    expect(s.reconciles).toBe(false);
    expect(s.usable).toBe(false);
    // Off by exactly the plant that disappeared.
    expect(s.discrepancyMinor).toBe(R(300_000n));
    // ⚠️ AND THE OTHER CHECK IS CLEAN — the cash ledgers themselves are
    // fine. The two gaps point at different faults on purpose.
    expect(s.snapshotGapMinor).toBe(0n);
    expect(explainCashFlowFailure(s).join(" ")).toContain("deleted");
  });

  /**
   * ⭐ THE OTHER FAULT: the three windows do not tile the timeline.
   * Taking the opening balance as at `from` rather than the day BEFORE
   * `from` counts day one twice. Both gaps then fire, and they fire by
   * the same amount, which is how they are told apart from the case above.
   */
  it("refuses when the opening balance covers the wrong range", () => {
    const s = buildCashFlow({
      movements: YEAR_MOVEMENTS,
      cashLedgers: [BANK],
      openingCashMinor: OPENING + R(12_000n), // day one, counted twice.
      actualClosingCashMinor: CLOSING,
    });
    expect(s.reconciles).toBe(false);
    expect(s.usable).toBe(false);
    expect(s.discrepancyMinor).toBe(R(12_000n));
    expect(s.snapshotGapMinor).toBe(R(12_000n));
    expect(explainCashFlowFailure(s).join(" ")).toContain("range of dates");
  });

  /**
   * 🔴 THE CASE THAT RECONCILES PERFECTLY AND MEANS NOTHING.
   * With no cash ledger identified, opening is zero, closing is zero and
   * every account in the business lands in the working-capital lines. The
   * arithmetic closes. The page would render a complete, internally
   * consistent statement saying the company holds no money.
   */
  it("refuses when no ledger is identified as cash, even though it balances", () => {
    const s = buildCashFlow({
      movements: YEAR_MOVEMENTS,
      cashLedgers: [],
      openingCashMinor: 0n,
      actualClosingCashMinor: 0n,
    });
    expect(s.reconciles).toBe(true); // ← the arithmetic is fine …
    expect(s.usable).toBe(false); // ← … and the statement is not.
    expect(s.problems.join(" ")).toContain("No ledger");
    expect(explainCashFlowFailure(s).join(" ")).toContain("bank account");
  });

  /** A bank account pointing at a ledger that is no longer in the chart. */
  it("refuses when a linked bank ledger is not in the chart of accounts", () => {
    const s = buildCashFlow({
      movements: YEAR_MOVEMENTS,
      cashLedgers: [BANK, { ledgerId: "led-gone", code: "—", name: "ICICI closed", source: "bank_account" }],
      openingCashMinor: OPENING,
      actualClosingCashMinor: CLOSING,
    });
    expect(s.usable).toBe(false);
    expect(s.problems.join(" ")).toContain("ICICI closed");
  });

  /**
   * ⚠️ A P&L LEDGER MAPPED AS CASH SILENTLY CHANGES THE PROFIT. The
   * identity does not care which bucket a ledger is in as long as it is
   * in exactly one, so this closes perfectly while reporting the wrong
   * profit and the wrong bank balance.
   */
  it("refuses when a revenue or expense ledger is mapped as cash", () => {
    const s = buildCashFlow({
      movements: YEAR_MOVEMENTS,
      cashLedgers: [{ ledgerId: "led-rev", code: "4000", name: "Sales", source: "posting_role" }],
      openingCashMinor: 0n,
      actualClosingCashMinor: R(1_000_000n),
    });
    expect(s.usable).toBe(false);
    expect(s.problems.join(" ")).toContain("revenue");
  });

  /** An account type outside the five in the enum is named, not swallowed. */
  it("names an account type it cannot classify", () => {
    const s = buildCashFlow({
      movements: [
        ...YEAR_MOVEMENTS,
        { ledgerId: "led-odd", code: "9999", name: "Mystery", type: "operating", accountType: "contra", movementMinor: R(1n) },
      ],
      cashLedgers: [BANK],
      openingCashMinor: OPENING,
      actualClosingCashMinor: CLOSING,
    });
    expect(s.usable).toBe(false);
    expect(s.problems.join(" ")).toContain("Mystery");
  });

  /**
   * 🔴 THE PAGE RENDERS THE REASONS INSTEAD OF THE FIGURES.
   * Not a number in amber, not a number with an asterisk. The person
   * reading this page is deciding whether payroll clears on Friday.
   */
  it("gates the whole card on `usable`", () => {
    const code = codeOnly(STATEMENTS);
    expect(code).toContain("if (!data.usable)");
    expect(code).toContain("data.failureReasons.map(");

    // The figures live AFTER the early return, so an unusable statement
    // reaches none of them.
    const card = code.slice(code.indexOf("function CashFlowCard"));
    const guard = card.indexOf("if (!data.usable)");
    const firstFigure = card.indexOf("data.actualClosingCash");
    expect(guard).toBeGreaterThan(-1);
    expect(firstFigure).toBeGreaterThan(guard);
  });

  /**
   * ⚠️ AND THE CASH-FLOW LINES ARE NOT PUT THROUGH THE PAGE'S SIGN FLIP.
   * `cashEffect` already arrives in the reader's sign — positive is cash
   * in, for a liability as much as for an asset. Passing it through
   * `presentationBalance` would invert the liability and equity lines
   * only, and the reconciliation would then reject a perfectly good
   * ledger over an error in the rendering.
   */
  it("does not flip the sign of a cash effect for presentation", () => {
    const card = codeOnly(STATEMENTS).slice(
      codeOnly(STATEMENTS).indexOf("function CashFlowSection"),
    );
    const end = card.indexOf("function PeriodPicker");
    expect(card.slice(0, end)).not.toContain("presentationBalance");
  });
});

/* ================================================================== */
/* ④ CASH LEDGERS ARE IDENTIFIED STRUCTURALLY, NEVER BY NAME           */
/* ================================================================== */

describe("how a cash ledger is found", () => {
  /**
   * 🔴 `db/schema/accounting.ts` already settled this argument for the
   * posting-role table: "A LEDGER CANNOT BE GUESSED FROM ITS NAME OR ITS
   * CODE. Every tenant builds their own chart of accounts."
   *
   * ⚠️ AND A NAME MATCH FAILS SILENTLY HERE. A missed cash ledger keeps
   * the statement reconciling — it simply moves out of the cash line and
   * into the working-capital lines — and reports less money than the
   * business has, which is the one error nobody double-checks.
   */
  it("uses the bank-account link and the posting role, not a name match", () => {
    const code = codeOnly(ACTIONS);
    expect(code).toContain("bankAccounts.ledgerId");
    expect(code).toContain("salesPostingAccounts.ledgerId");
    expect(code).toContain('eq(salesPostingAccounts.role, "bank")');

    expect(code).not.toContain("ilike");
    expect(code).not.toContain("%bank%");
    expect(code).not.toContain("%cash%");
    expect(code).not.toContain("LIKE '1");

    /**
     * ⚠️ AND NOT `ledgers.bank_details` EITHER, which is the near-miss.
     * It is a free-text jsonb blob filled in on the create-ledger form —
     * a tenant can type a bank name into it for a ledger that is not a
     * bank account, and can leave it empty on one that is. It describes
     * an account; it does not assert that this ledger IS one.
     * (`createLedgerSchema` at the top of the file writes it, which is
     * why this assertion is scoped to the lookup rather than the file.)
     */
    const lookup = code.slice(
      code.indexOf("async function cashLedgersFor"),
      code.indexOf("export async function getCashFlowStatement"),
    );
    expect(lookup).not.toContain("bankDetails");
    expect(lookup).toContain("eq(bankAccounts.tenantId, tenantId)");
  });

  /** The reader is told which accounts "cash and bank" actually means. */
  it("lists the identified accounts on the page", () => {
    expect(codeOnly(STATEMENTS)).toContain("data.cashLedgers.map(");
  });

  /**
   * 🔴 THE OPENING BALANCE IS AS AT THE DAY BEFORE THE PERIOD OPENED.
   * Using `period.from` itself counts the first day in both the opening
   * balance and the period's movement — and on the many years where
   * nothing was posted on 1 April it reconciles perfectly and is wrong
   * only for the customers who traded that day.
   */
  it("takes the opening position from the day before the period", () => {
    const code = codeOnly(ACTIONS);
    expect(code).toContain("const openingAsAt = previousDay(period.from)");
    const body = code.slice(code.indexOf("export async function getCashFlowStatement"));
    const loads = body.slice(body.indexOf("Promise.all(["), body.indexOf("]);"));
    expect(loads).toContain("{ from: null, to: openingAsAt }");
    expect(loads).toContain("{ from: null, to: period.asAt }");
    expect(loads).toContain("{ from: period.from, to: period.to }");
    // 🔴 A cumulative position is never filtered by a from-date.
    expect(loads).not.toContain("{ from: period.from, to: period.asAt }");
  });

  it("computes the day before without a Date object", () => {
    expect(previousDay("2025-04-01")).toBe("2025-03-31");
    expect(previousDay("2026-01-01")).toBe("2025-12-31");
    expect(previousDay("2025-03-02")).toBe("2025-03-01");
    // Leap years, both directions.
    expect(previousDay("2024-03-01")).toBe("2024-02-29");
    expect(previousDay("2025-03-01")).toBe("2025-02-28");
    expect(previousDay("2100-03-01")).toBe("2100-02-28"); // century, not a leap year
    expect(previousDay("2000-03-01")).toBe("2000-02-29"); // divisible by 400
    // Junk falls back rather than throwing — a query string is anything.
    expect(previousDay("not-a-date")).toBe("not-a-date");

    const code = codeOnly(PERIODS);
    expect(code).not.toContain("setDate(");
    expect(code).not.toContain("getTime()");
    expect(code).not.toContain("86400");
    expect(code).not.toContain("toISOString()");
  });

  it("lines the opening date up with the default financial year", () => {
    const p = resolveStatementPeriod(undefined, "2026-02-14");
    expect(p.from).toBe("2025-04-01");
    expect(previousDay(p.from)).toBe("2025-03-31");
  });
});

/* ================================================================== */
/* ⑤ 🔴 THE TRANSACTION STATUS SET                                     */
/* ================================================================== */

describe("which transactions are in the books", () => {
  /**
   * 🔴 NOTHING IN THE STATEMENT PATH FILTERED STATUS AT ALL. A `void`
   * transaction was counted in the trial balance, the P&L and the balance
   * sheet exactly like a real one.
   */
  it("filters the statement query on transaction status", () => {
    const code = codeOnly(ACTIONS);
    expect(code).toContain("inArray(transactions.status,");
    expect(code).toMatch(
      /const STATEMENT_TRANSACTION_STATUSES\s*=\s*\["posted",\s*"reversed"\]\s*as const;/,
    );
  });

  /**
   * 🔴🔴 `reversed` IS IN, AND THIS IS THE ASSERTION THAT MATTERS.
   *
   * `reverseTransaction` inserts the mirror entry as a NEW transaction
   * with status `posted` and marks the ORIGINAL `reversed`. Filter to
   * "posted only" and the statement keeps every correction and drops
   * every thing corrected: a reversed ₹5,00,000 sale leaves turnover
   * ₹5,00,000 LOWER than it ever was, in a statement that still balances,
   * because the reversal is itself a balanced transaction.
   */
  it("keeps a reversal and the entry it reverses together", () => {
    const code = codeOnly(ACTIONS);
    expect(code).not.toContain('eq(transactions.status, "posted")');
    expect(code).not.toMatch(/STATEMENT_TRANSACTION_STATUSES\s*=\s*\["posted"\]/);
    // And the reasoning is on the page, not only in a commit message.
    expect(ACTIONS).toContain("BOTH ARE IN THE STATEMENT");
  });

  /** `void` and `pending` are not facts and are not in the set. */
  it("excludes void and unposted transactions", () => {
    const list = ACTIONS.slice(
      ACTIONS.indexOf("const STATEMENT_TRANSACTION_STATUSES"),
    ).slice(0, 200);
    expect(list).not.toContain('"void"');
    expect(list).not.toContain('"pending"');
  });

  /**
   * ⚠️ THE PREDICATE BELONGS WITH THE DATE PREDICATE IN THE JOIN, NOT IN
   * THE `WHERE`. The ledger table is LEFT JOINed so a dormant account
   * still shows a balance; a predicate on the right-hand table in the
   * WHERE clause collapses that into an inner join and every ledger with
   * no in-period activity drops off the balance sheet.
   */
  it("puts the status predicate in the join, not the where clause", () => {
    const code = codeOnly(ACTIONS);
    const start = code.indexOf("const inPeriod = and(");
    const join = code.slice(start, code.indexOf("const rows = await withTenant"));
    expect(join).toContain("inArray(transactions.status,");
    expect(code).toContain(".leftJoin(transactions, inPeriod)");
    expect(code).toMatch(
      /\.where\(and\(eq\(ledgers\.tenantId, tenantId\), isNull\(ledgers\.deletedAt\)\)\)/,
    );
  });

  /**
   * ⚠️ ONE DEFINITION OF "IN THE BOOKS", SHARED BY ALL FOUR STATEMENTS.
   * The filter lives in `ledgerBalances`, which the trial balance, the
   * P&L, the balance sheet and the cash flow all go through. Four
   * statements built from four definitions is how a set of accounts stops
   * cross-footing.
   */
  it("applies the filter once, in the shared query", () => {
    const code = codeOnly(ACTIONS);
    expect(code.match(/inArray\(transactions\.status,/g) ?? []).toHaveLength(1);
    for (const fn of [
      "getTrialBalance",
      "getProfitAndLoss",
      "getBalanceSheet",
      "getCashFlowStatement",
    ]) {
      const body = code
        .split(/export async function /)
        .slice(1)
        .find((b) => b.startsWith(fn));
      expect(body, `${fn} exists`).toBeDefined();
      expect(body, `${fn} goes through ledgerBalances`).toContain("ledgerBalances(");
    }
  });

  /**
   * ⚠️ A CHANGE TO NUMBERS ALREADY ON SCREEN IS SAID OUT LOUD, ON THE
   * SCREEN. A bookkeeper comparing today's trial balance against last
   * week's printout needs to be able to see why they differ.
   */
  it("tells the user what is counted", () => {
    expect(ACCOUNTING).toContain("Posted and reversed transactions");
    expect(STATEMENTS).toContain("Posted and reversed");
  });
});
