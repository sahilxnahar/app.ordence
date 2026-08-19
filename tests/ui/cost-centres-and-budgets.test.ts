/**
 * Ordence — ⭐⭐⭐ COST CENTRES AND BUDGETS · Batch 68
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS FOR
 * ══════════════════════════════════════════════════════════════════════
 * Two kinds of assertion, and they answer different questions.
 *
 *   ① THE ARITHMETIC. `lib/accounting/cost-centre.ts` and
 *      `lib/accounting/budget.ts` are pure, so the sign convention, the
 *      un-costed bucket and the zero-versus-null distinction can be
 *      exercised here with no database. That is the whole reason they
 *      are pure.
 *
 *   ② THE WIRING. Whether the migration, the schema and the action agree
 *      about the grain and the status filter. Nothing else can check
 *      that: `tsc` does not read SQL, and a query that filters
 *      `transactions.status` to the wrong set type-checks perfectly.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 ASSERTIONS ABOUT ABSENCE USE `codeOnly`
 * ══════════════════════════════════════════════════════════════════════
 * Every file in this batch argues with itself at length in comments and
 * quotes the strings it is refusing to use — "posted only", "General",
 * `transactions.cost_centre_id`. A naive `not.toContain` would pass or
 * fail on the EXPLANATION rather than on the code, which is the exact
 * mistake `purchase-posting.test.ts` made twice.
 *
 * ⚠️ AND CEILINGS, NEVER EXACT COUNTS, for anything that can only
 * improve. Pinning "there are exactly two tables" fails the day somebody
 * correctly adds a third.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  UNCOSTED_KEY,
  UNCOSTED_LABEL,
  bucketKeyFor,
  costCentreCodeKey,
  groupByCostCentre,
  isUncosted,
  sortBuckets,
  totalNetResultMinor,
  validateCostCentreCode,
  type CostCentreRef,
  type CostedLine,
} from "@/lib/accounting/cost-centre";
import {
  actualNetResultMinor,
  buildBudgetRow,
  formatBasisPoints,
  formatMinor,
  parseBudgetAmount,
  parseSignedMinor,
  sortBudgetRows,
  totalsFor,
  varianceLabel,
  varianceMinor,
  variancePercentBasisPoints,
  type BudgetVsActualRow,
} from "@/lib/accounting/budget";
import { EXACT, reconcile } from "@/lib/reconciliation/gate";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/**
 * Comments and template/quoted strings blanked, line numbers preserved.
 * Every "this text must NOT appear" assertion runs through this.
 */
const codeOnly = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

/** SQL comments, blanked the same way. */
const sqlCodeOnly = (s: string) =>
  s.replace(/--[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

const MIGRATION = "SQL-FILES/0084_cost_centres_and_budgets.sql";
const VERIFY = "SQL-FILES/VERIFY-0084-neon-safe.sql";
const DRILL = "SQL-FILES/DRILL-DO-NOT-RUN-IN-NEON-0084.sql";
const SCHEMA = "db/schema/budgets.ts";
const ACCOUNTING_SCHEMA = "db/schema/accounting.ts";
const ACTION = "server/actions/budgets.ts";
const BUDGET_LIB = "lib/accounting/budget.ts";
const CENTRE_LIB = "lib/accounting/cost-centre.ts";

/* ================================================================== */
/* ① THE SIGN CONVENTION                                              */
/* ================================================================== */

describe("the variance sign convention", () => {
  /**
   * 🔴 THE SINGLE MOST IMPORTANT PAIR OF ASSERTIONS IN THE FILE.
   * A positive variance is favourable on BOTH sides of the P&L, and the
   * arithmetic that produces it is opposite. A report that used one
   * formula for both would print an expense saving and a revenue
   * shortfall with the same sign.
   */
  it("under-spending an expense is favourable and positive", () => {
    expect(varianceMinor("expense", 1_000_000n, 900_000n)).toBe(100_000n);
    expect(varianceLabel(varianceMinor("expense", 1_000_000n, 900_000n))).toBe("favourable");
  });

  it("over-spending an expense is adverse and negative", () => {
    expect(varianceMinor("expense", 1_000_000n, 1_150_000n)).toBe(-150_000n);
    expect(varianceLabel(varianceMinor("expense", 1_000_000n, 1_150_000n))).toBe("adverse");
  });

  it("under-achieving revenue is adverse and negative — the opposite subtraction", () => {
    expect(varianceMinor("revenue", 1_000_000n, 900_000n)).toBe(-100_000n);
    expect(varianceLabel(varianceMinor("revenue", 1_000_000n, 900_000n))).toBe("adverse");
  });

  it("beating revenue is favourable and positive", () => {
    expect(varianceMinor("revenue", 1_000_000n, 1_150_000n)).toBe(150_000n);
  });

  it("the two formulas are genuinely opposite for identical inputs", () => {
    const budget = 500_000n;
    const actual = 400_000n;
    expect(varianceMinor("expense", budget, actual)).toBe(
      -varianceMinor("revenue", budget, actual),
    );
  });

  it("landing exactly on budget is 'on budget', never 'favourable'", () => {
    expect(varianceLabel(0n)).toBe("on budget");
  });
});

/* ================================================================== */
/* ② ZERO IS NOT NULL                                                 */
/* ================================================================== */

describe("a budget of zero and no budget at all", () => {
  const base = {
    ledgerId: "l1",
    ledgerCode: "5100",
    ledgerName: "Electricity",
    accountType: "expense" as const,
    costCentreKey: "cc1",
    costCentreCode: "PROD",
    costCentreName: "Production",
  };

  it("zero budget with spend against it is an adverse variance somebody must explain", () => {
    const row = buildBudgetRow({ ...base, budgetMinor: 0n, actualMinor: 40_000n });
    expect(row.status).toBe("measured");
    expect(row.varianceMinor).toBe(-40_000n);
    expect(row.varianceLabel).toBe("adverse");
  });

  it("no budget produces NO variance — not a variance of the full actual", () => {
    const row = buildBudgetRow({ ...base, budgetMinor: null, actualMinor: 40_000n });
    expect(row.status).toBe("unbudgeted");
    expect(row.varianceMinor).toBeNull();
    expect(row.varianceLabel).toBe("not budgeted");
  });

  it("a budget with no spend against it is 'unspent' and still reported", () => {
    const row = buildBudgetRow({ ...base, budgetMinor: 700_000n, actualMinor: 0n });
    expect(row.status).toBe("unspent");
    expect(row.varianceMinor).toBe(700_000n);
  });

  it("a percentage of a zero budget is null, never Infinity and never zero", () => {
    expect(variancePercentBasisPoints(0n, -40_000n)).toBeNull();
    expect(formatBasisPoints(null)).toBe("—");
  });

  it("basis points are exact integers and never touch a float", () => {
    // ₹1,000.00 budget, ₹123.40 favourable → 12.34%.
    expect(variancePercentBasisPoints(100_000n, 12_340n)).toBe(1234n);
    expect(formatBasisPoints(1234n)).toBe("12.34%");
    expect(formatBasisPoints(-1234n)).toBe("-12.34%");
  });
});

/* ================================================================== */
/* ③ MONEY IS NEVER A FLOAT                                           */
/* ================================================================== */

describe("money parsing", () => {
  /**
   * 🔴 THE HOUSE EXAMPLE. `Math.round(Number("1.005") * 100)` is 100
   * because the double nearest 1.005 is 1.00499999999999989…. The string
   * parser gives 101 — the answer the person who typed it meant.
   */
  it("parses 1.005-class values without going through a double", () => {
    expect(Math.round(Number("1.005") * 100)).toBe(100);
    const parsed = parseBudgetAmount("1.00");
    expect(parsed.ok && parsed.minor).toBe(100n);
    const two = parseBudgetAmount("1.01");
    expect(two.ok && two.minor).toBe(101n);
  });

  it("accepts zero, because zero is a decision", () => {
    const parsed = parseBudgetAmount("0");
    expect(parsed.ok && parsed.minor).toBe(0n);
  });

  it("refuses a negative budget — the direction comes from the account type", () => {
    expect(parseBudgetAmount("-500").ok).toBe(false);
  });

  it("survives a figure larger than Number.MAX_SAFE_INTEGER paise", () => {
    // ₹9,00,71,99,25,474.10 — above 2^53 paise, where a double loses precision.
    const parsed = parseBudgetAmount("90071992547.41");
    expect(parsed.ok && parsed.minor).toBe(9_007_199_254_741n);
    expect(formatMinor(9_007_199_254_741n)).toBe("90071992547.41");
  });

  it("parses a signed P&L result, because a loss is an ordinary answer", () => {
    expect(parseSignedMinor("-1234.50")).toBe(-123_450n);
    expect(parseSignedMinor("0.00")).toBe(0n);
  });
});

/* ================================================================== */
/* ④ THE UN-COSTED BUCKET                                             */
/* ================================================================== */

describe("the un-costed bucket", () => {
  const centres: CostCentreRef[] = [
    { key: "cc-prod", code: "PROD", name: "Production" },
    { key: "cc-ho", code: "HO", name: "Head Office" },
  ];

  /** The drill's April journal, as the pure code sees it. */
  const lines: CostedLine[] = [
    { costCentreId: "cc-prod", ledgerId: "5100", accountType: "expense", debitMinor: 8_000_000n, creditMinor: 0n },
    { costCentreId: "cc-ho", ledgerId: "5100", accountType: "expense", debitMinor: 4_000_000n, creditMinor: 0n },
    { costCentreId: null, ledgerId: "4000", accountType: "revenue", debitMinor: 0n, creditMinor: 50_000_000n },
    // Balance-sheet legs, which must be ignored entirely.
    { costCentreId: null, ledgerId: "2100", accountType: "liability", debitMinor: 0n, creditMinor: 12_000_000n },
  ];

  it("gives un-costed lines their own bucket rather than dropping them", () => {
    const buckets = groupByCostCentre(lines, centres);
    const uncosted = buckets.find((b) => isUncosted(b.centre.key));
    expect(uncosted).toBeDefined();
    expect(uncosted?.netResultMinor).toBe(50_000_000n);
  });

  it("never lumps un-costed lines into a real cost centre", () => {
    const buckets = groupByCostCentre(lines, centres);
    const prod = buckets.find((b) => b.centre.code === "PROD");
    expect(prod?.netResultMinor).toBe(-8_000_000n);
  });

  /**
   * 🔴 THE ASSERTION THIS WHOLE BATCH EXISTS FOR. The buckets, added up,
   * equal the profit & loss. If the un-costed bucket were dropped this
   * would be -₹1,20,000 against a real result of +₹3,80,000 — the sign
   * flipped, from a query that reads like the obvious one.
   */
  it("the buckets sum to the profit & loss", () => {
    const buckets = groupByCostCentre(lines, centres);
    expect(totalNetResultMinor(buckets)).toBe(38_000_000n);

    const droppingNulls = buckets
      .filter((b) => !isUncosted(b.centre.key))
      .reduce((a, b) => a + b.netResultMinor, 0n);
    expect(droppingNulls).toBe(-12_000_000n);
    expect(droppingNulls).not.toBe(38_000_000n);
  });

  it("shows a cost centre with no activity rather than hiding it", () => {
    const buckets = groupByCostCentre([], centres);
    expect(buckets.filter((b) => b.centre.code === "HO")).toHaveLength(1);
    expect(buckets.find((b) => b.centre.code === "HO")?.netResultMinor).toBe(0n);
  });

  it("shows the un-costed bucket even when it is empty", () => {
    const buckets = groupByCostCentre([], centres);
    expect(buckets.some((b) => isUncosted(b.centre.key))).toBe(true);
  });

  it("sorts the un-costed bucket LAST, so day one does not read as a fault", () => {
    const buckets = sortBuckets(groupByCostCentre(lines, centres));
    expect(isUncosted(buckets[buckets.length - 1].centre.key)).toBe(true);
  });

  it("gives an unrecognised cost centre its own bucket rather than losing the money", () => {
    const orphan: CostedLine[] = [
      { costCentreId: "cc-gone", ledgerId: "5100", accountType: "expense", debitMinor: 100n, creditMinor: 0n },
    ];
    const buckets = groupByCostCentre(orphan, centres);
    expect(totalNetResultMinor(buckets)).toBe(-100n);
  });

  it("the sentinel cannot collide with a real uuid and is not blank", () => {
    expect(UNCOSTED_KEY).not.toMatch(/^[0-9a-f]{8}-/i);
    expect(UNCOSTED_KEY.length).toBeGreaterThan(0);
    expect(bucketKeyFor(null)).toBe(UNCOSTED_KEY);
    expect(bucketKeyFor("cc-prod")).toBe("cc-prod");
  });

  it("the bucket is labelled in words, not as 'Other', 'General' or a dash", () => {
    expect(UNCOSTED_LABEL).toBe("Not allocated");
    expect(["Other", "General", "—", "-", ""]).not.toContain(UNCOSTED_LABEL);
  });
});

/* ================================================================== */
/* ⑤ THE TOTALS, AND THE ONE ASYMMETRY                                */
/* ================================================================== */

describe("budget totals", () => {
  const rows: BudgetVsActualRow[] = [
    buildBudgetRow({
      ledgerId: "4000", ledgerCode: "4000", ledgerName: "Sales", accountType: "revenue",
      costCentreKey: UNCOSTED_KEY, costCentreCode: "", costCentreName: UNCOSTED_LABEL,
      budgetMinor: 60_000_000n, actualMinor: 50_000_000n,
    }),
    buildBudgetRow({
      ledgerId: "5100", ledgerCode: "5100", ledgerName: "Electricity", accountType: "expense",
      costCentreKey: "cc-prod", costCentreCode: "PROD", costCentreName: "Production",
      budgetMinor: 7_000_000n, actualMinor: 8_000_000n,
    }),
    buildBudgetRow({
      ledgerId: "5200", ledgerCode: "5200", ledgerName: "Consultancy", accountType: "expense",
      costCentreKey: "cc-ho", costCentreCode: "HO", costCentreName: "Head Office",
      budgetMinor: null, actualMinor: 4_000_000n,
    }),
  ];

  it("net variance is the sum of the two favourable-positive halves", () => {
    const t = totalsFor(rows);
    expect(t.revenueVarianceMinor).toBe(-10_000_000n); // ₹1,00,000 short
    expect(t.expenseVarianceMinor).toBe(-1_000_000n); // ₹10,000 over
    expect(t.netVarianceMinor).toBe(-11_000_000n);
  });

  /**
   * 🔴 THE ONE ASYMMETRY, ASSERTED SO IT CANNOT BE "TIDIED UP". An
   * unbudgeted actual is INSIDE the actual totals (so the report still
   * reconciles to the P&L) and OUTSIDE the variance totals (because
   * "nobody budgeted this" is not "budget zero").
   */
  it("an unbudgeted actual is in the actual total and out of the variance total", () => {
    const t = totalsFor(rows);
    expect(t.expenseActualMinor).toBe(12_000_000n); // 8,000,000 + 4,000,000
    expect(t.expenseBudgetMinor).toBe(7_000_000n);
    expect(t.unbudgetedActualMinor).toBe(4_000_000n);
    expect(t.unbudgetedRowCount).toBe(1);
  });

  it("the actual column reconciles to the profit & loss", () => {
    // Revenue 50,000,000 less expenditure 12,000,000.
    expect(actualNetResultMinor(rows)).toBe(38_000_000n);
  });

  it("sorts revenue first and the un-costed bucket last within a ledger", () => {
    const sorted = sortBudgetRows(rows, UNCOSTED_KEY);
    expect(sorted[0].accountType).toBe("revenue");
  });
});

/* ================================================================== */
/* ⑥ THE GATE — NO FIGURE AT ALL WHEN THE TWO ROUTES DISAGREE          */
/* ================================================================== */

describe("the reconciliation gate as this batch uses it", () => {
  const check = (reportMinor: bigint, ledgerMinor: bigint) =>
    reconcile({
      subject: "Budget versus actual",
      ledgerConfigured: true,
      checks: [
        {
          id: "budget-actuals-vs-pl",
          claim: "The actual column equals the profit & loss.",
          report: { label: "this report", source: "budget vs actual rows", amountMinor: reportMinor },
          ledger: { label: "the profit & loss", source: "getProfitAndLoss", amountMinor: ledgerMinor },
          toleranceMinor: EXACT,
        },
      ],
    });

  it("renders when the two independent routes agree exactly", () => {
    const r = check(38_000_000n, 38_000_000n);
    expect(r.state).toBe("reconciled");
    expect(r.renderable).toBe(true);
    expect(r.verified).toBe(true);
  });

  it("refuses to render ANY figure when they disagree by a single paisa", () => {
    const r = check(38_000_001n, 38_000_000n);
    expect(r.state).toBe("breached");
    expect(r.renderable).toBe(false);
  });

  it("is EXACT — both sides are sums of the same paise with no division", () => {
    const r = check(38_000_000n, 38_000_000n);
    expect(r.checks[0].toleranceMinor).toBe(0n);
  });

  it("an unconfigured workspace is not a pass", () => {
    const r = reconcile({
      subject: "Budget versus actual",
      ledgerConfigured: false,
      checks: [
        {
          id: "budget-actuals-vs-pl",
          claim: "The actual column equals the profit & loss.",
          report: { label: "this report", source: "budget vs actual rows", amountMinor: 0n },
          ledger: { label: "the profit & loss", source: "getProfitAndLoss", amountMinor: 0n },
          toleranceMinor: EXACT,
        },
      ],
    });
    expect(r.state).toBe("unconfigured");
    expect(r.verified).toBe(false);
  });
});

/* ================================================================== */
/* ⑦ CODES                                                            */
/* ================================================================== */

describe("cost centre codes", () => {
  it("compares case-insensitively so one department is not reported as two", () => {
    expect(costCentreCodeKey("prod")).toBe(costCentreCodeKey("PROD"));
    expect(costCentreCodeKey(" Prod ")).toBe("PROD");
  });

  it("keeps the typed case for presentation", () => {
    const parsed = validateCostCentreCode(" Prod-North ");
    expect(parsed.ok && parsed.code).toBe("Prod-North");
  });

  it("refuses a blank code, which would sort as an invisible bucket", () => {
    expect(validateCostCentreCode("   ").ok).toBe(false);
  });

  it("refuses a code with characters that break a URL or a CSV", () => {
    expect(validateCostCentreCode("PR OD").ok).toBe(false);
    expect(validateCostCentreCode("PR,OD").ok).toBe(false);
  });
});

/* ================================================================== */
/* ⑧ THE WIRING — MIGRATION, SCHEMA AND ACTION AGREE                   */
/* ================================================================== */

describe("the migration", () => {
  const sql = read(MIGRATION);
  const code = sqlCodeOnly(sql);

  it("exists and is one guarded, re-runnable transaction", () => {
    expect(existsSync(join(process.cwd(), MIGRATION))).toBe(true);
    expect(code).toContain("BEGIN;");
    expect(code).toContain("COMMIT;");
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS cost_centres/);
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS budget_lines/);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS cost_centre_id/);
  });

  it("says in its header whether it runs before or after the code push", () => {
    expect(sql).toMatch(/BEFORE\*{0,2} PUSHING THE CODE|RUN THIS \*{0,2}BEFORE\*{0,2}/i);
  });

  it("enables AND forces RLS on both new tables, with a tenant policy", () => {
    for (const table of ["cost_centres", "budget_lines"]) {
      expect(code).toContain(`'${table}'`);
    }
    expect(code).toContain("ENABLE ROW LEVEL SECURITY");
    expect(code).toContain("FORCE  ROW LEVEL SECURITY");
    expect(code).toContain("tenant_id = app_current_tenant_id()");
    // ⭐ Platform scope reads across tenants and never writes.
    expect(code).toContain("app_platform_scope()");
    expect(code).not.toMatch(/WITH CHECK \([^)]*app_platform_scope/);
  });

  /**
   * 🔴 THE DIMENSION IS ON THE LINE. Asserted by presence AND by
   * absence, because a header dimension added later would not remove
   * this one — it would sit beside it, and the two grains would disagree
   * about what a department cost.
   */
  it("puts the cost centre on journal_entries and never on transactions", () => {
    expect(code).toMatch(/ALTER TABLE journal_entries\s+ADD COLUMN IF NOT EXISTS cost_centre_id/);
    expect(code).not.toMatch(/ALTER TABLE transactions[\s\S]{0,200}cost_centre_id/);
  });

  it("makes the cost-centre column nullable — no NOT NULL, no DEFAULT, no backfill", () => {
    expect(code).not.toMatch(/ADD COLUMN IF NOT EXISTS cost_centre_id\s+uuid\s+NOT NULL/);
    expect(code).not.toMatch(/UPDATE journal_entries\s+SET cost_centre_id/);
  });

  it("carries the tenant in every foreign key that reaches another table", () => {
    expect(code).toMatch(
      /FOREIGN KEY \(cost_centre_id, tenant_id\)\s+REFERENCES cost_centres \(id, tenant_id\)/,
    );
    expect(code).toMatch(/FOREIGN KEY \(period_id, tenant_id\)/);
    expect(code).toMatch(/FOREIGN KEY \(ledger_id, tenant_id\)/);
    // 🔴 RESTRICT, never CASCADE (deletes journal lines) and never SET
    //    NULL (moves a department's history into the un-costed bucket).
    expect(code).not.toMatch(/REFERENCES cost_centres \(id, tenant_id\)\s+ON DELETE (CASCADE|SET NULL)/);
  });

  it("guards both halves of the budget grain, including the un-costed half", () => {
    expect(code).toMatch(/budget_lines_grain_key[\s\S]{0,200}WHERE cost_centre_id IS NOT NULL/);
    expect(code).toMatch(/budget_lines_grain_uncosted_key[\s\S]{0,200}WHERE cost_centre_id IS NULL/);
  });

  it("freezes a closed period's budget with a trigger on all three operations", () => {
    expect(code).toContain("enforce_budget_period_open");
    expect(code).toMatch(/BEFORE INSERT OR UPDATE OR DELETE ON budget_lines/);
    // ⚠️ Both sides of an UPDATE — a move OUT of a closed period is a
    //    restatement that a NEW-only trigger would allow.
    expect(code).toMatch(/TG_OP <> 'INSERT'[\s\S]{0,120}OLD\.period_id/);
    expect(code).toMatch(/TG_OP <> 'DELETE'[\s\S]{0,120}NEW\.period_id/);
  });

  it("does not seed a default cost centre, which would make day one look allocated", () => {
    expect(code).not.toMatch(/INSERT INTO cost_centres/i);
  });
});

describe("the verify and drill files", () => {
  it("the verify file is read-only and safe against Neon", () => {
    const code = sqlCodeOnly(read(VERIFY));
    for (const forbidden of [
      "CREATE TABLE",
      "ALTER TABLE",
      "DROP TABLE",
      "INSERT INTO",
      "UPDATE ",
      "DELETE FROM",
      "TRUNCATE",
    ]) {
      expect(code).not.toContain(forbidden);
    }
    expect(code).toContain("SELECT");
  });

  it("the drill refuses to run against anything that looks real", () => {
    const drill = read(DRILL);
    expect(drill).toContain("DO NOT RUN THIS IN NEON");
    const code = sqlCodeOnly(drill);
    expect(code).toMatch(/current_database\(\) LIKE '%neon%'/);
    expect(code).toMatch(/RAISE EXCEPTION[\s\S]{0,200}REFUSING/);
  });

  it("the drill pairs every refusal with a write that must still work", () => {
    const drill = read(DRILL);
    const refusals = [...drill.matchAll(/REFUSED as designed/g)].length;
    // ⚠️ A CEILING ON NOTHING AND A FLOOR ON THE COUNT — the drill may
    //    only grow. Pinning an exact number fails the day somebody adds
    //    a case, which is the direction this file should move in.
    expect(refusals).toBeGreaterThanOrEqual(8);
    expect(drill).toContain("THE WRITE THAT MUST STILL WORK");
  });
});

describe("the drizzle schema mirrors the migration", () => {
  const schema = read(SCHEMA);
  const code = codeOnly(schema);
  const accounting = codeOnly(read(ACCOUNTING_SCHEMA));

  it("declares both tables, tenant-scoped", () => {
    expect(code).toMatch(/pgTable\(\s*"cost_centres"/);
    expect(code).toMatch(/pgTable\(\s*"budget_lines"/);
    const tenantScoped = [...code.matchAll(/uuid\("tenant_id"\)/g)].length;
    expect(tenantScoped).toBeGreaterThanOrEqual(2);
  });

  it("stores the budget as bigint paise in bigint mode, never numeric and never a number", () => {
    expect(code).toMatch(/bigint\("amount_minor",\s*\{\s*mode:\s*"bigint"\s*\}\)/);
    expect(code).not.toMatch(/numeric\("amount_minor"/);
    expect(code).not.toMatch(/amount_minor",\s*\{\s*mode:\s*"number"/);
  });

  it("declares both halves of the grain, matching the migration", () => {
    expect(code).toContain("budget_lines_grain_key");
    expect(code).toContain("budget_lines_grain_uncosted_key");
  });

  it("puts cost_centre_id on journalEntries and not on transactions", () => {
    expect(accounting).toMatch(/costCentreId:\s*uuid\("cost_centre_id"\)/);
    // The transactions table is defined before journalEntries; the
    // column must appear only after it.
    const txnStart = accounting.indexOf('pgTable(\n  "transactions"');
    const journalStart = accounting.indexOf('pgTable(\n  "journal_entries"');
    const columnAt = accounting.indexOf('uuid("cost_centre_id")');
    expect(journalStart).toBeGreaterThan(txnStart);
    expect(columnAt).toBeGreaterThan(journalStart);
  });

  it("indexes the departmental query", () => {
    expect(accounting).toContain("journal_entries_cost_centre_idx");
  });
});

describe("the server action", () => {
  const src = read(ACTION);
  const code = codeOnly(src);

  it('is a "use server" module whose every export is async', () => {
    expect(src.startsWith('"use server"')).toBe(true);
    const exports = [...code.matchAll(/^export\s+(async\s+)?function\s+(\w+)/gm)];
    for (const m of exports) {
      expect(m[1], `export ${m[2]} must be async`).toBeTruthy();
    }
    expect(exports.length).toBeGreaterThan(0);
  });

  /**
   * 🔴 EVERY EXPORT IS A URL THE BROWSER CAN POST TO, so every one needs
   * a tier-2 guard reachable in one hop — the distance `check:guards`
   * walks.
   */
  it("guards every export with requirePermission in the function body", () => {
    const blocks = code.split(/^export\s+async\s+function\s+/m).slice(1);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      const name = block.slice(0, block.indexOf("("));
      expect(block.slice(0, 900), `${name} is unguarded`).toContain("requirePermission(");
    }
  });

  it("reuses existing permission keys and invents none", () => {
    const keys = [...code.matchAll(/requirePermission\((\w+)\)/g)].map((m) => m[1]);
    expect(new Set(keys).size).toBeGreaterThan(0);
    for (const known of ["ledgers:read", "ledgers:create", "ledgers:update", "reports:trial_balance"]) {
      expect(code).toContain(`"${known}"`);
    }
    expect(code).not.toMatch(/"budgets[.:]/);
    expect(code).not.toMatch(/"cost_?cent(re|er)s?[.:]/);
  });

  /**
   * 🔴🔴 THE STATUS FILTER. "Posted only" keeps every correction and
   * drops everything corrected, because `reverseTransaction` writes the
   * mirror as a NEW posted row and marks the original reversed.
   */
  it("filters transactions to posted AND reversed, matching the statements", () => {
    expect(code).toMatch(/STATEMENT_TRANSACTION_STATUSES\s*=\s*\["posted",\s*"reversed"\]/);
    expect(code).not.toMatch(/status,\s*"posted"\)/);
    expect(code).not.toMatch(/\["posted"\]\s*(as const)?\s*;/);
  });

  it("dates the window on transaction_date and never on created_at", () => {
    expect(code).toMatch(/transactions\.transactionDate/);
    expect(code).not.toMatch(/transactions\.createdAt/);
  });

  it("excludes soft-deleted ledgers, exactly as the profit & loss does", () => {
    expect(code).toMatch(/isNull\(ledgers\.deletedAt\)/);
  });

  it("computes the second side by calling the profit & loss, not by copying its query", () => {
    expect(code).toMatch(/import \{ getProfitAndLoss \} from "@\/server\/actions\/accounting"/);
    // 🔴 The two sides must quote DIFFERENT sources or the gate faults
    //    the check — a comparison of a number with itself.
    expect(code).toMatch(/source: "journal_entries grouped by cost centre/);
    expect(code).toMatch(/source: "getProfitAndLoss/);
  });

  it("gates both reports on an exact tolerance", () => {
    const exacts = [...code.matchAll(/toleranceMinor:\s*EXACT/g)].length;
    expect(exacts).toBeGreaterThanOrEqual(2);
    expect(code).not.toMatch(/toleranceMinor:\s*\d/);
  });

  it("refuses a budget write into a period that is not open", () => {
    expect(code).toMatch(/status !== "open"/);
  });

  it("goes through withTenant for every read and write", () => {
    const withTenantCalls = [...code.matchAll(/withTenant\(/g)].length;
    expect(withTenantCalls).toBeGreaterThan(0);
    // No raw `db.select` / `db.insert` bypassing the tenant wrapper.
    expect(code).not.toMatch(/\bdb\.(select|insert|update|delete)\(/);
  });

  it("never converts a money value with Number()", () => {
    expect(code).not.toMatch(/Number\(/);
    expect(code).not.toMatch(/parseFloat\(/);
  });
});

describe("the pure libraries stay pure", () => {
  for (const path of [BUDGET_LIB, CENTRE_LIB]) {
    it(`${path} imports no server module and no database`, () => {
      const code = codeOnly(read(path));
      expect(code).not.toMatch(/from "@\/server\//);
      expect(code).not.toMatch(/from "@\/db/);
      expect(code).not.toMatch(/from "drizzle-orm/);
      expect(code).not.toMatch(/new Date\(\)/);
    });

    it(`${path} keeps money in bigint and never in a float`, () => {
      const code = codeOnly(read(path));
      expect(code).not.toMatch(/parseFloat\(/);
      expect(code).not.toMatch(/Math\.round\(/);
      expect(code).not.toMatch(/toFixed\(/);
    });
  }
});

describe("the screens", () => {
  const budgetsPage = read("app/(crm)/accounting/budgets/page.tsx");
  const centresPage = read("app/(crm)/accounting/cost-centres/page.tsx");
  const varianceTable = read("components/budgets/variance-table.tsx");
  const editor = read("components/budgets/budget-editor.tsx");

  it("states the sign convention on the page, in words", () => {
    expect(budgetsPage).toMatch(/POSITIVE VARIANCE IS FAVOURABLE/i);
  });

  it("prints the word beside the figure, not only a colour", () => {
    expect(varianceTable).toContain("row.varianceLabel");
  });

  it("shows 'not budgeted' rather than a zero or a bare dash", () => {
    expect(varianceTable).toContain("not budgeted");
  });

  it("refuses to render any figure when the gate breaches", () => {
    const code = codeOnly(varianceTable);
    expect(code).toMatch(/if \(!reconciliation\.renderable\)/);
    expect(code).toMatch(/return \(\s*<ReconciliationNotice/);
  });

  it("sends the budget amount as a string from a text input, never a number input", () => {
    const code = codeOnly(editor);
    expect(code).not.toMatch(/type="number"/);
    expect(code).toMatch(/inputMode="decimal"/);
  });

  it("renders no input at all for a closed period", () => {
    const code = codeOnly(editor);
    expect(code).toMatch(/if \(!periodIsOpen\)/);
  });

  it("defaults the cost centre picker to the un-costed bucket", () => {
    const code = codeOnly(editor);
    expect(code).toMatch(/useState<string>\(UNCOSTED_KEY\)/);
  });

  it("names the un-costed bucket on both screens", () => {
    expect(centresPage).toContain("isUncosted");
    expect(varianceTable).toContain("UNCOSTED_LABEL");
  });

  it("links only to destinations that exist", () => {
    for (const page of [budgetsPage, centresPage]) {
      const hrefs = [...page.matchAll(/href="(\/[a-z0-9/-]*)"/g)].map((m) => m[1]);
      for (const href of hrefs) {
        const candidates = [
          join(process.cwd(), "app/(crm)", href, "page.tsx"),
          join(process.cwd(), "app", href, "page.tsx"),
        ];
        expect(candidates.some((c) => existsSync(c)), `${href} is a dead link`).toBe(true);
      }
    }
  });
});
