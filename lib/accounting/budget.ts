/**
 * Ordence — ⭐⭐⭐ BUDGET VERSUS ACTUAL
 * Version: v1.47.0-alpha · Batch 68
 *
 * Pure. No database, no clock, no imports from `server/`. Money is
 * `bigint` paise throughout and never passes through a `Number` — not
 * even for a percentage, which is why the variance percentage below is
 * carried in BASIS POINTS as a bigint rather than as a float.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 THE SIGN CONVENTION. STATED ONCE, HERE, AND NOWHERE ELSE.
 * ══════════════════════════════════════════════════════════════════════
 *
 *      A POSITIVE VARIANCE IS FAVOURABLE. A NEGATIVE VARIANCE IS
 *      ADVERSE. ON EVERY LINE, IN EVERY TOTAL, FOR EVERY ACCOUNT TYPE.
 *
 * That single sentence is the whole convention, and the arithmetic that
 * produces it is DIFFERENT for the two sides of the P&L:
 *
 *      expense   variance = budget − actual
 *      revenue   variance = actual − budget
 *
 * ⚠️ THE TWO FORMULAS ARE OPPOSITE AND THAT IS NOT A BUG. Over-spending
 * on an expense and under-achieving on revenue are both bad news, and
 * they are bad news in opposite arithmetic directions. Spending
 * ₹9,00,000 against a ₹10,00,000 budget is ₹1,00,000 FAVOURABLE. Earning
 * ₹9,00,000 against a ₹10,00,000 budget is ₹1,00,000 ADVERSE. A report
 * that used one formula for both would print those two situations with
 * the same sign, and a reader scanning a column of figures for red would
 * miss every revenue shortfall in the business.
 *
 * 🔴 THE FAILURE THIS PREVENTS IS NOT AN ARITHMETIC ONE, IT IS A READING
 * ONE. The most common real-world version of this bug is a report where
 * every line is `actual − budget`: the expense lines are then negative
 * when things are going WELL, so the finance team learns that red means
 * nothing on the expense half of the page — and then reads the revenue
 * half the same way.
 *
 * ⭐ AND THE WORD IS PRINTED, NOT JUST THE SIGN. `varianceLabel()`
 * returns "favourable" or "adverse", and the UI shows it beside the
 * figure. A minus sign in front of a number in a column headed
 * "Variance" is ambiguous to everybody who did not write the code; the
 * word is not.
 *
 * ⚠️ ONE CONSEQUENCE, STATED SO NOBODY "FIXES" IT: A FAVOURABLE EXPENSE
 * VARIANCE IS NOT AUTOMATICALLY GOOD NEWS. Under-spending on
 * maintenance, on marketing, or on safety is exactly how a favourable
 * variance is manufactured. This module reports the arithmetic; the
 * screen does not congratulate anybody. There is no green tick on a
 * favourable line and there never should be.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 ZERO BUDGET IS NOT THE SAME FACT AS NO BUDGET
 * ══════════════════════════════════════════════════════════════════════
 * `budgetMinor: 0n` means somebody typed zero — "we are spending nothing
 * on entertainment this quarter" is a decision, and ₹40,000 of actual
 * against it is a ₹40,000 adverse variance somebody has to explain.
 *
 * `budgetMinor: null` means NOBODY HAS LOOKED. There is no variance to
 * report, because there is nothing to vary from.
 *
 * ⚠️ RENDERING THE SECOND AS THE FIRST — defaulting a missing budget to
 * zero — turns every unbudgeted account in the workspace into a
 * 100%-over-budget crisis on the day the screen ships, and a screen that
 * is red everywhere on day one is a screen nobody opens again. Rendering
 * the FIRST as the second hides the only overspend on the page.
 *
 * So `budgetMinor` is `bigint | null`, `varianceMinor` is `bigint |
 * null`, and `status` distinguishes `unbudgeted` from every other state.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE PERCENTAGE IS BASIS POINTS, AND IT IS NULL WHEN THE BUDGET IS
 *    ZERO
 * ══════════════════════════════════════════════════════════════════════
 * ₹40,000 spent against a budget of zero is not "infinite percent over"
 * and it is definitely not "0%", which is what `x / 0 |> Math.round`
 * quietly renders after `Infinity` meets `toFixed`. It is a number with
 * no percentage, and the column shows an em dash while the rupee
 * variance beside it shows the whole ₹40,000.
 *
 * ⭐ AND IT IS `bigint` BASIS POINTS RATHER THAN A `number` PERCENT
 * because this module has a rule that money never becomes a float and a
 * ratio of two money figures is close enough to money to keep the rule.
 * 1234n basis points is 12.34%. The division truncates TOWARDS ZERO,
 * which under-states the magnitude of both a favourable and an adverse
 * variance by less than a basis point and never flips a sign.
 */

import { fyLabelFor } from "./periods";

/* ------------------------------------------------------------------ */
/* PARSING A TYPED BUDGET FIGURE                                       */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ A BUDGET IS TYPED BY A HUMAN INTO A TEXT BOX, SO IT IS PARSED FROM
 * A STRING AND NEVER FROM A `Number`.
 *
 * 🔴 `Math.round(Number("1.005") * 100)` IS 100, NOT 101. The IEEE-754
 * double nearest to 1.005 is 1.00499999999999989…, so the obvious
 * implementation loses a paisa on a value a person can and does type. On
 * a budget that paisa is trivial; the habit is not, and this is the file
 * where the habit is either kept or broken.
 *
 * ⭐ ZERO IS ACCEPTED. See the header — it is a decision, not an absence.
 * A negative budget is refused: the direction comes from the ledger's
 * account type, and a minus sign here would give the report two ways to
 * say "adverse" that disagree with each other.
 */
export const BUDGET_AMOUNT_MAX_MINOR = 10n ** 17n; // ₹1,00,00,00,00,00,000.00

export type ParsedBudgetAmount =
  | { ok: true; minor: bigint }
  | { ok: false; reason: string };

export function parseBudgetAmount(raw: string): ParsedBudgetAmount {
  const trimmed = raw.trim().replace(/,/g, "");
  if (trimmed === "") return { ok: false, reason: "Enter an amount, or 0 to budget nothing." };
  if (!/^\d{1,17}(\.\d{1,2})?$/.test(trimmed)) {
    return {
      ok: false,
      reason:
        "Enter a positive amount with at most two decimals. A budget has no sign — whether a variance is favourable or adverse comes from the account.",
    };
  }
  const [whole = "0", fraction = ""] = trimmed.split(".");
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
  if (minor >= BUDGET_AMOUNT_MAX_MINOR) {
    return { ok: false, reason: "That amount is larger than this product will store." };
  }
  return { ok: true, minor };
}

/**
 * ⭐ A SIGNED 2-DECIMAL STRING TO PAISE.
 *
 * ⚠️ `toMinorUnits` IN `lib/validators/accounting.ts` REFUSES A MINUS
 * SIGN, correctly — it parses amounts on a journal leg, and a negative
 * amount there would give the ledger two ways to express a credit. The
 * P&L's `netResult` is a different kind of figure: it is a RESULT, and a
 * loss is a real and common one. Reusing the leg parser here would throw
 * on every loss-making workspace, on the read path, at the exact moment
 * the reconciliation gate is trying to compare two totals.
 *
 * 🔴 AND IT PARSES FROM THE STRING RATHER THAN VIA `Number`. Postgres
 * hands back an exact decimal string; a round trip through a double can
 * only lose information.
 */
export function parseSignedMinor(decimal: string): bigint {
  const trimmed = decimal.trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new Error(`Not a 2-decimal money string: "${decimal}".`);
  }
  const negative = trimmed.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? trimmed.slice(1) : trimmed).split(".");
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
  return negative ? -minor : minor;
}

/** Integer paise to a plain 2-decimal string. Never via a float. */
export function formatMinor(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  return `${negative ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/* THE SIGN CONVENTION, AS CODE                                        */
/* ------------------------------------------------------------------ */

export type BudgetAccountType = "revenue" | "expense";

/**
 * 🔴 THE ONE FUNCTION THAT DECIDES THE SIGN. Every variance in the
 * product comes through here, so there is exactly one place to read the
 * convention from and exactly one place to get it wrong.
 *
 * Returns FAVOURABLE-POSITIVE. See the header.
 */
export function varianceMinor(
  accountType: BudgetAccountType,
  budgetMinor: bigint,
  actualMinor: bigint,
): bigint {
  return accountType === "expense" ? budgetMinor - actualMinor : actualMinor - budgetMinor;
}

/**
 * The word that goes beside the figure.
 *
 * ⚠️ ZERO IS "ON BUDGET", NOT "FAVOURABLE". Landing exactly on the
 * number is neither good news nor bad news, and colouring it green would
 * make a report where nothing has been posted yet look like a triumph.
 */
export function varianceLabel(variance: bigint): "favourable" | "adverse" | "on budget" {
  if (variance > 0n) return "favourable";
  if (variance < 0n) return "adverse";
  return "on budget";
}

/**
 * Variance as basis points of the budget. `null` when the budget is
 * zero — see the header. 1234n is 12.34%.
 */
export function variancePercentBasisPoints(
  budgetMinor: bigint,
  varianceValue: bigint,
): bigint | null {
  if (budgetMinor === 0n) return null;
  return (varianceValue * 10_000n) / budgetMinor;
}

/** "12.34%" from basis points, without ever touching a float. */
export function formatBasisPoints(bp: bigint | null): string {
  if (bp === null) return "—";
  const negative = bp < 0n;
  const abs = negative ? -bp : bp;
  return `${negative ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}%`;
}

/* ------------------------------------------------------------------ */
/* A ROW OF THE REPORT                                                 */
/* ------------------------------------------------------------------ */

/**
 * `unbudgeted` — actual activity with no budget line at all. Reported,
 *    never treated as a zero budget. See the header.
 * `unspent`    — a budget line with no activity against it. Also
 *    reported: a department that has not started spending against an
 *    approved budget is a fact somebody planning cash wants.
 * `measured`   — both sides present.
 */
export type BudgetRowStatus = "measured" | "unbudgeted" | "unspent";

export type BudgetVsActualInput = {
  ledgerId: string;
  ledgerCode: string;
  ledgerName: string;
  accountType: BudgetAccountType;
  /** The un-costed bucket's key is `UNCOSTED_KEY`, never null. */
  costCentreKey: string;
  costCentreCode: string;
  costCentreName: string;
  /** `null` means nobody has budgeted this. NOT zero. */
  budgetMinor: bigint | null;
  /**
   * ⭐ ALWAYS SIGNED IN THE ACCOUNT'S OWN DIRECTION: an expense actual is
   * debits less credits, a revenue actual is credits less debits. So a
   * credit note reduces revenue and a refunded expense reduces cost, and
   * both arrive here as a smaller positive number rather than as a
   * negative one that has to be re-interpreted downstream.
   */
  actualMinor: bigint;
};

export type BudgetVsActualRow = BudgetVsActualInput & {
  status: BudgetRowStatus;
  /** Favourable-positive. `null` exactly when `status === "unbudgeted"`. */
  varianceMinor: bigint | null;
  varianceLabel: "favourable" | "adverse" | "on budget" | "not budgeted";
  /** Basis points of budget. `null` when there is no budget or it is zero. */
  varianceBasisPoints: bigint | null;
};

export function buildBudgetRow(input: BudgetVsActualInput): BudgetVsActualRow {
  if (input.budgetMinor === null) {
    return {
      ...input,
      status: "unbudgeted",
      varianceMinor: null,
      varianceLabel: "not budgeted",
      varianceBasisPoints: null,
    };
  }
  const variance = varianceMinor(input.accountType, input.budgetMinor, input.actualMinor);
  return {
    ...input,
    status: input.actualMinor === 0n ? "unspent" : "measured",
    varianceMinor: variance,
    varianceLabel: varianceLabel(variance),
    varianceBasisPoints: variancePercentBasisPoints(input.budgetMinor, variance),
  };
}

/* ------------------------------------------------------------------ */
/* THE REPORT                                                          */
/* ------------------------------------------------------------------ */

export type BudgetTotals = {
  /** Sum of every budgeted revenue line. */
  revenueBudgetMinor: bigint;
  revenueActualMinor: bigint;
  expenseBudgetMinor: bigint;
  expenseActualMinor: bigint;
  /** Favourable-positive, aggregated with the same rule as a line. */
  revenueVarianceMinor: bigint;
  expenseVarianceMinor: bigint;
  /**
   * ⭐ THE ONE FIGURE A BOARD ACTUALLY ASKS FOR, AND IT IS THE SUM OF THE
   * TWO ABOVE RATHER THAN A THIRD FORMULA.
   *
   * Budgeted profit less actual profit would give the same number today
   * and would drift the first time somebody adds a third account type,
   * because it re-derives the convention instead of applying it. Adding
   * the two favourable-positive halves cannot drift: they are already in
   * the reader's sign.
   */
  netVarianceMinor: bigint;
  /**
   * 🔴 ACTUALS WITH NO BUDGET ARE COUNTED IN THE ACTUAL TOTALS AND
   * EXCLUDED FROM THE VARIANCE TOTALS, and this is the only asymmetry in
   * the whole report.
   *
   * ⚠️ IT IS DELIBERATE AND IT IS THE HONEST OPTION. Including them in
   * the variance would silently treat "nobody budgeted this" as "budget
   * zero" — see the header — and turn every unbudgeted account into an
   * overspend. Excluding them from the ACTUAL total would break the
   * reconciliation against the P&L, which is the check that makes this
   * whole screen defensible. So they are in one total and not the other,
   * and `unbudgetedActualMinor` states the size of the gap in words so
   * nobody has to derive it by subtraction.
   */
  unbudgetedActualMinor: bigint;
  unbudgetedRowCount: number;
};

export function totalsFor(rows: readonly BudgetVsActualRow[]): BudgetTotals {
  const t: BudgetTotals = {
    revenueBudgetMinor: 0n,
    revenueActualMinor: 0n,
    expenseBudgetMinor: 0n,
    expenseActualMinor: 0n,
    revenueVarianceMinor: 0n,
    expenseVarianceMinor: 0n,
    netVarianceMinor: 0n,
    unbudgetedActualMinor: 0n,
    unbudgetedRowCount: 0,
  };

  for (const row of rows) {
    const revenue = row.accountType === "revenue";
    if (revenue) t.revenueActualMinor += row.actualMinor;
    else t.expenseActualMinor += row.actualMinor;

    if (row.budgetMinor === null) {
      t.unbudgetedActualMinor += row.actualMinor;
      t.unbudgetedRowCount += 1;
      continue;
    }
    if (revenue) {
      t.revenueBudgetMinor += row.budgetMinor;
      t.revenueVarianceMinor += row.varianceMinor ?? 0n;
    } else {
      t.expenseBudgetMinor += row.budgetMinor;
      t.expenseVarianceMinor += row.varianceMinor ?? 0n;
    }
  }

  t.netVarianceMinor = t.revenueVarianceMinor + t.expenseVarianceMinor;
  return t;
}

/**
 * ⭐ THE ACTUALS, RE-EXPRESSED AS A PROFIT.
 *
 * Revenue less expense, positive is a profit — the same definition
 * `getProfitAndLoss` uses. This is the figure that is compared against
 * the P&L by the reconciliation gate, and it is derived from the ROWS
 * THAT ARE ON SCREEN rather than from the query that produced them.
 * A check that re-reads its own source proves only that the query is
 * deterministic; see `lib/reconciliation/gate.ts` ①.
 */
export function actualNetResultMinor(rows: readonly BudgetVsActualRow[]): bigint {
  return rows.reduce(
    (acc, r) => acc + (r.accountType === "revenue" ? r.actualMinor : -r.actualMinor),
    0n,
  );
}

/* ------------------------------------------------------------------ */
/* SORTING                                                             */
/* ------------------------------------------------------------------ */

/**
 * Revenue before expense, then by ledger code, then by cost centre code
 * with the un-costed bucket last — the same order `sortBuckets` uses, so
 * the two screens read as one report.
 */
export function sortBudgetRows(
  rows: readonly BudgetVsActualRow[],
  uncostedKey: string,
): BudgetVsActualRow[] {
  const centreRank = (r: BudgetVsActualRow) => (r.costCentreKey === uncostedKey ? 1 : 0);
  return [...rows].sort(
    (a, b) =>
      (a.accountType === "revenue" ? 0 : 1) - (b.accountType === "revenue" ? 0 : 1) ||
      a.ledgerCode.localeCompare(b.ledgerCode) ||
      centreRank(a) - centreRank(b) ||
      a.costCentreCode.localeCompare(b.costCentreCode) ||
      a.costCentreName.localeCompare(b.costCentreName),
  );
}

/* ------------------------------------------------------------------ */
/* LABELS                                                              */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE FINANCIAL YEAR IS INDIAN — 1 APRIL TO 31 MARCH — AND THE LABEL
 * IS DERIVED FROM THE PERIOD'S OWN START DATE RATHER THAN FROM THE
 * CLOCK. A budget screen headed with today's FY while showing last
 * year's period is how somebody approves the wrong year's numbers.
 */
export function budgetPeriodLabel(periodName: string, startDate: string): string {
  return `${periodName} · ${fyLabelFor(startDate)}`;
}
