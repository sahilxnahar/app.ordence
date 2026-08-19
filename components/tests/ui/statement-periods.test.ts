/**
 * Ordence — ⭐⭐ BATCH 37: THE THREE STATEMENTS TAKE A PERIOD
 * Version: v1.43.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE P&L, THE BALANCE SHEET AND THE TRIAL BALANCE WERE SINCE INCEPTION
 * ══════════════════════════════════════════════════════════════════════
 * `getTrialBalance()` took no arguments and summed every entry the tenant
 * had ever posted; both statements were derived from it. There was no
 * date parameter anywhere in the path, so a customer in year two could
 * not produce a financial-year statement at all — and the statement they
 * did get looked entirely reasonable while showing two years of trading.
 *
 * ⭐ AND THE HALF OF THIS THAT IS EASY TO GET WRONG: the balance sheet
 * must NOT take the from-date. It is a position at an instant,
 * accumulated from inception. Filtered by a from-date it drops every
 * opening balance — cash, fixed assets, capital, loans — and still
 * balances while doing it, so nothing on the page contradicts it.
 *
 * These assertions therefore fall into three groups:
 *   ① the period exists and reaches the database
 *   ② the balance sheet is as-at, not a range
 *   ③ the default is the Indian financial year, and the maths is right
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  fyStartFor,
  fyEndFor,
  fyLabelFor,
  previousFyFor,
  resolveStatementPeriod,
  isIsoDate,
  formatIso,
  todayInIndia,
} from "@/lib/accounting/periods";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const PERIODS = read("lib/accounting/periods.ts");
const ACTIONS = read("server/actions/accounting.ts");
const STATEMENTS = read("app/(crm)/statements/page.tsx");
const ACCOUNTING = read("app/(crm)/accounting/page.tsx");

/**
 * ⚠️ ABSENCE IS ASSERTED AGAINST COMMENT-STRIPPED SOURCE.
 * These files explain at length what they must NOT do — "do not give the
 * balance sheet a from-date" appears in prose in three of them. A test
 * that greps the raw text for `from: period.from` near the balance sheet
 * fails on the comment warning against it. This has bitten this
 * repository repeatedly; strip first, then assert.
 */
const codeOnly = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

/* ================================================================== */
/* ① THE PERIOD EXISTS AND REACHES THE DATABASE                        */
/* ================================================================== */

describe("all three statements take a period", () => {
  it("ships the shared period module", () => {
    expect(existsSync(join(ROOT, "lib/accounting/periods.ts"))).toBe(true);
  });

  it("gives the trial balance, the P&L and the balance sheet a parameter", () => {
    const code = codeOnly(ACTIONS);
    expect(code).toMatch(
      /export async function getTrialBalance\(\s*input\?: StatementPeriodInput/,
    );
    expect(code).toMatch(
      /export async function getProfitAndLoss\(\s*input\?: StatementPeriodInput/,
    );
    expect(code).toMatch(
      /export async function getBalanceSheet\(\s*input\?: StatementPeriodInput/,
    );
  });

  /**
   * 🔴 THE PARAMETER HAS TO REACH THE SQL. A date argument that is
   * accepted, validated, echoed back in the heading and then never
   * applied is worse than no parameter: the statement is labelled
   * "FY 2025-26" and contains everything since inception.
   */
  it("filters on the transaction date in the query", () => {
    const code = codeOnly(ACTIONS);
    expect(code).toContain("lte(transactions.transactionDate, window.to)");
    expect(code).toContain("gte(transactions.transactionDate, window.from)");
  });

  /**
   * ⚠️ AND IT FILTERS ON `transactionDate`, NOT `createdAt`. A journal
   * back-dated to March but typed in June belongs in March's P&L.
   * Filtering on the insert timestamp moves money into the period it was
   * keyed in, which silently restates a year already filed against.
   */
  it("does not filter statements by the row's insert timestamp", () => {
    const code = codeOnly(ACTIONS);
    expect(code).not.toContain("gte(transactions.createdAt");
    expect(code).not.toContain("lte(transactions.createdAt");
    expect(code).not.toContain("gte(journalEntries.createdAt");
    expect(code).not.toContain("lte(journalEntries.createdAt");
  });

  /**
   * ⚠️ THE DATE PREDICATE CANNOT LIVE IN THE WHERE CLAUSE. The ledger
   * table is LEFT JOINed to its entries so that a dormant account still
   * appears with a balance; a WHERE on the right-hand table collapses
   * that into an inner join and the dormant bank account disappears from
   * the balance sheet entirely.
   */
  it("keeps the ledger join a LEFT JOIN so dormant accounts still appear", () => {
    const code = codeOnly(ACTIONS);
    expect(code).toContain(".leftJoin(transactions, inPeriod)");
    expect(code).toMatch(/\.where\(and\(eq\(ledgers\.tenantId, tenantId\), isNull\(ledgers\.deletedAt\)\)\)/);
  });

  /**
   * ⚠️ AND THE ON-CLAUSE PREDICATE ALONE FILTERS NOTHING. The SUM reads
   * `journal_entries.amount`, which is still populated when only the
   * transactions join failed. `transactions.id IS NOT NULL` inside the
   * CASE is what actually excludes an out-of-period amount.
   */
  it("excludes out-of-period amounts inside the aggregate, not just in the join", () => {
    const code = codeOnly(ACTIONS);
    /**
     * ⚠️ THIS USED TO BE `expect(guards.length).toBe(2)` AND BATCH 0108
     * BROKE IT BY ADDING A THIRD CORRECT AGGREGATE — the count of legs
     * that have no `amount_minor`, which must carry the same period guard
     * as the two sums or it would report legs from outside the period.
     *
     * A pinned count is a SHAPE. It cannot tell "somebody added a guarded
     * aggregate" from "somebody added an unguarded one", so it failed the
     * safe change and would have passed the dangerous one had the new
     * expression been number three of three with the guard on a different
     * line. The invariant is that EVERY aggregate over the left-joined
     * journal carries the guard, which is what is checked now.
     */
    const block = code.slice(
      code.indexOf("totalDebitMinor:"),
      code.indexOf("unscaledLegs:") + 400,
    );
    const aggregates = block.match(/(COALESCE\(SUM\(CASE WHEN|COUNT\(\*\) FILTER \(WHERE)/g) ?? [];
    const guards = block.match(/\$\{transactions\.id\} IS NOT NULL/g) ?? [];
    expect(aggregates.length).toBeGreaterThanOrEqual(3);
    expect(guards.length).toBe(aggregates.length);
  });

  it("is tenant-scoped on every join in the statement query", () => {
    const code = codeOnly(ACTIONS);
    expect(code).toContain("eq(journalEntries.tenantId, tenantId)");
    expect(code).toContain("eq(transactions.tenantId, tenantId)");
  });

  /**
   * ⚠️ EVERY `"use server"` EXPORT IS A URL THE BROWSER CAN POST TO.
   * An unguarded statement reader returns a company's complete financial
   * position to anyone who knows the action id.
   */
  /**
   * ⭐ WAVE 9 — see the same change in `tests/ui/cash-flow.test.ts`. A
   * session proves the caller is somebody; `ledgers:read` proves they are
   * somebody this workspace has decided may read its books.
   */
  it("guards each new statement export on the permission, not merely on a session", () => {
    const code = codeOnly(ACTIONS);
    const bodies = code.split(/export async function /).slice(1);
    for (const name of ["getTrialBalance", "getProfitAndLoss", "getBalanceSheet"]) {
      const body = bodies.find((b) => b.startsWith(name));
      expect(body, `${name} is exported`).toBeDefined();
      expect(body, `${name} is guarded`).toContain('await requirePermission("ledgers:read")');
      expect(body, `${name} no longer relies on a session alone`).not.toContain(
        "await requireTenantContext()",
      );
    }
  });

  it("wires the period through both screens", () => {
    const statements = codeOnly(STATEMENTS);
    expect(statements).toContain("searchParams");
    expect(statements).toContain("resolveStatementPeriod");
    expect(statements).toContain("getProfitAndLoss(");
    expect(statements).toContain("getBalanceSheet(");

    const accounting = codeOnly(ACCOUNTING);
    expect(accounting).toContain("resolveStatementPeriod");
    expect(accounting).toContain("getTrialBalance({ from: period.from, to: period.to })");
  });

  /** The user has to be able to change it without editing a URL by hand. */
  it("renders date inputs on both screens", () => {
    for (const src of [STATEMENTS, ACCOUNTING]) {
      const code = codeOnly(src);
      expect(code).toContain('method="get"');
      expect(code).toContain('name="from"');
      expect(code).toContain('name="to"');
      expect(code).toContain('type="date"');
    }
  });
});

/* ================================================================== */
/* ② 🔴 THE BALANCE SHEET IS A POINT IN TIME, NOT A RANGE              */
/* ================================================================== */

describe("the balance sheet is as at a date", () => {
  /**
   * 🔴 THE ASSERTION THIS WHOLE FILE EXISTS FOR.
   * `getBalanceSheet` must pass `from: null` — since inception — to the
   * balance query. Passing `period.from` filters out every opening
   * balance and reports a company with no assets, in a statement that
   * still balances.
   */
  it("asks for balances since inception, never from the period start", () => {
    const code = codeOnly(ACTIONS);
    const body = code.slice(code.indexOf("export async function getBalanceSheet"));
    const call = body.slice(body.indexOf("ledgerBalances("), body.indexOf("});"));

    expect(call).toContain("from: null");
    expect(call).toContain("to: period.asAt");
    expect(call).not.toContain("period.from");
  });

  it("exposes an as-at date rather than a range", () => {
    expect(codeOnly(ACTIONS)).toContain("asAt: period.asAt");
    expect(codeOnly(STATEMENTS)).toContain("bsResult.data.asAt");
  });

  /** `asAt` is the period's to-date, and the type says so. */
  it("resolves asAt to the end of the requested range", () => {
    const p = resolveStatementPeriod({ from: "2025-04-01", to: "2026-03-31" });
    expect(p.asAt).toBe("2026-03-31");
    expect(p.asAt).toBe(p.to);
  });

  /**
   * ⚠️ THE OTHER HALF OF THE SAME MISTAKE. Once the P&L is scoped to one
   * year, `Assets = Liabilities + Equity + (Revenue − Expenses)` no
   * longer holds against the PERIOD result — the difference is last
   * year's retained profit. Without a brought-forward line every
   * year-two customer is told in red that their books do not balance.
   */
  it("carries retained profit forward so the identity still holds", () => {
    expect(codeOnly(ACTIONS)).toContain("retainedResultToDate");
    const statements = codeOnly(STATEMENTS);
    expect(statements).toContain("const broughtForward = retainedToDate - netResult");
    expect(statements).toContain(
      "const identityGap = totalAssets - (totalLiabilities + totalEquity + retainedToDate)",
    );
    expect(STATEMENTS).toContain("Retained result brought forward");
  });

  /**
   * ⚠️ THE BALANCE SHEET RETURNS NO REVENUE OR EXPENSE LEDGERS AND THE
   * P&L RETURNS NOTHING ELSE. Mixing them is one careless `.map()` away
   * from adding a bank balance to turnover.
   */
  it("splits the ledgers between the two statements", () => {
    const code = codeOnly(ACTIONS);
    expect(code).toContain('const PL_TYPES = new Set(["revenue", "expense"]);');
    expect(code).toContain("balances.filter((r) => PL_TYPES.has(r.accountType))");
    expect(code).toContain("balances.filter((r) => !PL_TYPES.has(r.accountType))");
  });
});

/* ================================================================== */
/* ③ THE DEFAULT IS THE INDIAN FINANCIAL YEAR                          */
/* ================================================================== */

describe("the financial year", () => {
  it("runs 1 April to 31 March", () => {
    expect(fyStartFor("2026-02-14")).toBe("2025-04-01");
    expect(fyEndFor("2026-02-14")).toBe("2026-03-31");

    // The two boundary days, which is where a calendar-year assumption shows.
    expect(fyStartFor("2025-03-31")).toBe("2024-04-01");
    expect(fyStartFor("2025-04-01")).toBe("2025-04-01");
    expect(fyEndFor("2025-04-01")).toBe("2026-03-31");
    expect(fyEndFor("2026-03-31")).toBe("2026-03-31");
  });

  it("labels the year the way an Indian accountant writes it", () => {
    expect(fyLabelFor("2025-06-30")).toBe("FY 2025-26");
    expect(fyLabelFor("2026-01-31")).toBe("FY 2025-26");
    // The century roll, where a two-digit suffix is easy to get wrong.
    expect(fyLabelFor("2099-12-31")).toBe("FY 2099-00");
  });

  it("offers the previous financial year, which is what year two asks for", () => {
    expect(previousFyFor("2026-02-14")).toEqual({
      from: "2024-04-01",
      to: "2025-03-31",
    });
  });

  /**
   * ⚠️ THE DEFAULT IS ONE YEAR, NOT ALL OF TIME. A since-inception
   * default over-reports plausibly against a range that is printed
   * nowhere; a financial-year default can only under-report, against a
   * range that is printed at the top of the statement.
   */
  it("defaults to the current financial year", () => {
    const p = resolveStatementPeriod(undefined, "2026-02-14");
    expect(p.from).toBe("2025-04-01");
    expect(p.to).toBe("2026-03-31");
    expect(p.isDefault).toBe(true);
    expect(p.fyLabel).toBe("FY 2025-26");
  });

  it("does not default to inception", () => {
    const p = resolveStatementPeriod({}, "2026-02-14");
    expect(p.from).not.toBe("1970-01-01");
    expect(p.from.slice(5)).toBe("04-01");
  });

  it("honours an explicit range", () => {
    const p = resolveStatementPeriod({ from: "2025-07-01", to: "2025-09-30" }, "2026-02-14");
    expect(p).toMatchObject({
      from: "2025-07-01",
      to: "2025-09-30",
      asAt: "2025-09-30",
      isDefault: false,
      fyLabel: null,
    });
  });

  /**
   * ⚠️ A QUERY STRING IS ANYTHING. A malformed date must not 500 a
   * financial statement; it falls back, and the resolved dates are what
   * the pickers display so the user can see what they actually got.
   */
  it("falls back rather than throwing on junk", () => {
    for (const bad of ["", "yesterday", "2026-13-01", "2026-02-30x", "01/04/2025", null]) {
      const p = resolveStatementPeriod({ from: bad, to: bad }, "2026-02-14");
      expect(p.from).toBe("2025-04-01");
      expect(p.to).toBe("2026-03-31");
    }
  });

  /**
   * ⚠️ A REVERSED RANGE IS SWAPPED, NOT OBEYED. `from > to` selects no
   * transactions, and an empty P&L is indistinguishable from a business
   * that traded nothing — the exact failure this work exists to prevent.
   */
  it("swaps a reversed range instead of returning an empty statement", () => {
    const p = resolveStatementPeriod({ from: "2026-03-31", to: "2025-04-01" });
    expect(p.from).toBe("2025-04-01");
    expect(p.to).toBe("2026-03-31");
    expect(p.asAt).toBe("2026-03-31");
  });

  it("only accepts a well-formed ISO date", () => {
    expect(isIsoDate("2025-04-01")).toBe(true);
    expect(isIsoDate("2025-4-1")).toBe(false);
    expect(isIsoDate("2025-00-10")).toBe(false);
    expect(isIsoDate("2025-04-32")).toBe(false);
    expect(isIsoDate(20250401)).toBe(false);
    expect(isIsoDate(undefined)).toBe(false);
  });

  /**
   * ⚠️ TODAY IN INDIA, NOT TODAY IN UTC. `toISOString().slice(0, 10)`
   * returns yesterday between midnight and 05:30 IST. On one night a
   * year that yesterday is 31 March, and the statement opens on the
   * closing year instead of the new one.
   */
  it("takes today from Asia/Kolkata", () => {
    expect(isIsoDate(todayInIndia())).toBe(true);

    // 2026-04-01 at 00:30 IST is still 2026-03-31 in UTC.
    const justAfterMidnightIst = new Date("2026-03-31T19:00:00.000Z");
    expect(justAfterMidnightIst.toISOString().slice(0, 10)).toBe("2026-03-31");
    expect(todayInIndia(justAfterMidnightIst)).toBe("2026-04-01");

    // And that one hop moves the whole default period on by a year.
    expect(resolveStatementPeriod(undefined, todayInIndia(justAfterMidnightIst)).from).toBe(
      "2026-04-01",
    );
  });

  /** Dates are formatted by slicing, never by `new Date(iso)`. */
  it("formats a date without a timezone round trip", () => {
    expect(formatIso("2026-03-31")).toBe("31 Mar 2026");
    expect(formatIso("2025-04-01")).toBe("1 Apr 2025");
    expect(codeOnly(PERIODS)).not.toContain("new Date(iso)");
    expect(codeOnly(PERIODS)).not.toContain("toISOString()");
  });

  /**
   * ⚠️ NOT IMPORTED FROM `server/payroll/run.ts`. An identical helper
   * lives there; importing it would make every P&L boundary in the
   * product move if payroll ever needs a different year.
   */
  it("does not reach across into the payroll module", () => {
    expect(codeOnly(PERIODS)).not.toContain("server/payroll");
    expect(codeOnly(ACTIONS)).not.toContain("server/payroll");
  });
});

/* ================================================================== */
/* ④ MONEY IS STILL BIGINT PAISE                                       */
/* ================================================================== */

describe("money on the statement path", () => {
  /**
   * 🔴 `BigInt("1234.56")` THROWS — IT DOES NOT ROUND.
   * The statements page read the accounting action's two-decimal strings
   * as if they were minor units and called `BigInt` on them directly, so
   * a tenant with a single ledger row crashed the page on load. Even
   * "0.00" throws. The conversion now goes through `toMinor`.
   */
  it("parses the server's decimal strings before treating them as paise", () => {
    const code = codeOnly(STATEMENTS);
    expect(code).toContain("function toMinor(");
    expect(code).toContain("toMinor(row.balance)");
    expect(code).not.toContain("BigInt(row.balance");
  });

  /** No float ever stands between the database and a rupee figure. */
  it("keeps the aggregate out of IEEE-754", () => {
    const code = codeOnly(ACTIONS);
    /**
     * ⚠️ THIS USED TO ASSERT `toMinorUnits(r.totalDebit)`. Batch 0108
     * removed that call: the aggregate now comes out of Postgres already
     * in minor units, so there is nothing to convert — which is a stronger
     * form of "out of IEEE-754" than the one the old assertion pinned.
     *
     * 🔴 AND `toMinorUnits` WAS ITSELF A HARDCODED HUNDRED whose regex
     * refused a third decimal, so a Kuwaiti trial balance did not merely
     * come out wrong: it threw. The old test protected the float property
     * and was blind to the currency one.
     */
    expect(code).toContain("BigInt(r.totalDebitMinor)");
    expect(code).toContain("BigInt(r.totalCreditMinor)");
    expect(code).not.toContain("Number(r.totalDebit)");
    expect(code).not.toContain("Number(r.totalCredit)");
    expect(code).not.toContain("parseFloat");
  });
});
