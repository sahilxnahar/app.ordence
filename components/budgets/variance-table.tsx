/**
 * Ordence — ⭐⭐ THE VARIANCE TABLE
 * Version: v1.47.0-alpha · Batch 68
 *
 * A server component. It renders and decides nothing — every figure is
 * already decided by `lib/accounting/budget.ts`, which is where the sign
 * convention lives.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE SIGN CONVENTION IS PRINTED ON THE PAGE, IN WORDS, NEXT TO THE
 *    FIGURE — NOT ONLY IN THE COLOUR
 * ══════════════════════════════════════════════════════════════════════
 * A minus sign in a column headed "Variance" is ambiguous to everybody
 * who did not write the code: is −₹40,000 forty thousand over, or forty
 * thousand under? The answer here is "adverse", and the word is on the
 * row.
 *
 * ⚠️ AND THE ARITHMETIC IS DIFFERENT FOR THE TWO HALVES OF THE P&L,
 * which is precisely why the word matters. Spending ₹9,00,000 against a
 * ₹10,00,000 budget is FAVOURABLE. Earning ₹9,00,000 against a
 * ₹10,00,000 budget is ADVERSE. Both are +₹1,00,000 or −₹1,00,000
 * depending on which formula you picked, and a reader scanning for red
 * would miss every revenue shortfall in the business.
 *
 * ⚠️ THERE IS NO GREEN TICK ON A FAVOURABLE LINE. Under-spending on
 * maintenance, on marketing or on safety is exactly how a favourable
 * variance is manufactured, and a product that congratulated somebody
 * for it would be encouraging the thing it was built to expose. The
 * arithmetic is reported; the judgement is the reader's.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 "NOT BUDGETED" IS A WORD, NOT A ZERO AND NOT A DASH
 * ══════════════════════════════════════════════════════════════════════
 * A missing budget rendered as ₹0.00 turns every unbudgeted account into
 * a 100%-over-budget crisis on the day the screen ships, and a screen
 * that is red everywhere is a screen nobody opens twice. A missing
 * budget rendered as an em dash reads as a rendering failure. It says
 * "not budgeted", the variance column says "—", and the actual is shown
 * in full, because an unbudgeted cost is the most interesting line on
 * the report.
 */

import type { SerializedReconciliation } from "@/lib/reconciliation/gate";
import { ReconciliationNotice } from "@/components/reconciliation/reconciliation-notice";
import { UNCOSTED_LABEL } from "@/lib/accounting/cost-centre";

/**
 * ⚠️ MINOR UNITS IN, DISPLAY OUT, NEVER PARSED TO A NUMBER. The strings
 * that arrive here are `bigint` paise serialised across the RSC
 * boundary. `Number("420000000")` is fine today and silently wrong at
 * ₹90,07,19,92,54,740.99, which is inside the range of a real estate
 * developer's annual revenue budget stated in paise.
 */
export function inrFromMinor(minor: string | null | undefined): string {
  if (minor === null || minor === undefined || minor === "") return "—";
  const negative = minor.startsWith("-");
  const digits = (negative ? minor.slice(1) : minor).padStart(3, "0");
  const whole = digits.slice(0, -2) || "0";
  const frac = digits.slice(-2);
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  return `${negative ? "-" : ""}₹${grouped}.${frac}`;
}

/** Basis points as a string to "12.34%". Never via a float. */
export function percentFromBasisPoints(bp: string | null): string {
  if (bp === null) return "—";
  const negative = bp.startsWith("-");
  const digits = (negative ? bp.slice(1) : bp).padStart(3, "0");
  const whole = digits.slice(0, -2) || "0";
  return `${negative ? "-" : ""}${whole}.${digits.slice(-2)}%`;
}

export type VarianceRow = {
  ledgerId: string;
  ledgerCode: string;
  ledgerName: string;
  accountType: string;
  costCentreKey: string;
  costCentreCode: string;
  costCentreName: string;
  isUncosted: boolean;
  budgetMinor: string | null;
  actualMinor: string;
  varianceMinor: string | null;
  varianceLabel: string;
  varianceBasisPoints: string | null;
  status: string;
};

function VarianceCell({ row }: { row: VarianceRow }) {
  if (row.varianceMinor === null) {
    return <span className="text-xs text-muted-foreground">not budgeted</span>;
  }
  const adverse = row.varianceLabel === "adverse";
  return (
    <span className={adverse ? "text-destructive tabular-nums" : "tabular-nums"}>
      {inrFromMinor(row.varianceMinor)}{" "}
      <span className="text-xs text-muted-foreground">{row.varianceLabel}</span>
    </span>
  );
}

export function VarianceTable({
  rows,
  totals,
  reconciliation,
  caption,
}: {
  rows: readonly VarianceRow[];
  totals: {
    revenueBudgetMinor: string;
    revenueActualMinor: string;
    revenueVarianceMinor: string;
    expenseBudgetMinor: string;
    expenseActualMinor: string;
    expenseVarianceMinor: string;
    netVarianceMinor: string;
    unbudgetedActualMinor: string;
    unbudgetedRowCount: string;
  };
  reconciliation: SerializedReconciliation;
  caption: string;
}) {
  /**
   * 🔴 THE GATE DECIDES WHETHER ANY FIGURE APPEARS AT ALL.
   *
   * ⚠️ THE EARLY RETURN IS THE MECHANISM AND IT MUST STAY AN EARLY
   * RETURN. Rendering the table behind a banner — greyed out, asterisked,
   * "provisional" — is the version of this that always gets asked for and
   * it defeats the whole point: a correct-looking number printed under a
   * heading that has just failed its own check reads to the person
   * holding it as VERIFICATION.
   */
  if (!reconciliation.renderable) {
    return (
      <ReconciliationNotice
        reconciliation={reconciliation}
        breachCauses={[
          "A journal line was coded to a cost centre that this report cannot name — check that no cost centre has been removed directly in the database.",
          "This report and the profit & loss are reading different transaction statuses. Both must be `posted` and `reversed`: a reversal is posted while the entry it reverses is reversed, and keeping one without the other leaves a correction in the books with nothing to correct.",
          "A ledger was soft-deleted between the two reads.",
        ]}
      />
    );
  }

  return (
    <div className="space-y-3">
      <ReconciliationNotice reconciliation={reconciliation} />

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-medium">Account</th>
              <th scope="col" className="px-3 py-2 text-left font-medium">Cost centre</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Budget</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Actual</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Variance</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">%</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  Nothing budgeted and nothing posted for this period.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={`${row.ledgerId}::${row.costCentreKey}`}>
                <td className="px-3 py-2">
                  <span className="font-mono text-xs">{row.ledgerCode}</span> {row.ledgerName}
                  <span className="ml-2 text-xs text-muted-foreground">{row.accountType}</span>
                </td>
                <td className="px-3 py-2">
                  {/*
                    ⚠️ "Not allocated" IS WRITTEN OUT, never left blank and
                    never called "Other" or "General". Both of those read
                    like a department, and a reader who takes them for one
                    stops asking why the line is so large.
                  */}
                  {row.isUncosted ? (
                    <span className="text-muted-foreground">{UNCOSTED_LABEL}</span>
                  ) : (
                    <>
                      <span className="font-mono text-xs">{row.costCentreCode}</span>{" "}
                      {row.costCentreName}
                    </>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {row.budgetMinor === null ? (
                    <span className="text-xs text-muted-foreground">not budgeted</span>
                  ) : (
                    inrFromMinor(row.budgetMinor)
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {inrFromMinor(row.actualMinor)}
                </td>
                <td className="px-3 py-2 text-right">
                  <VarianceCell row={row} />
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-xs text-muted-foreground">
                  {percentFromBasisPoints(row.varianceBasisPoints)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 border-border bg-muted/30 text-sm">
            <tr>
              <td className="px-3 py-2 font-medium" colSpan={2}>Revenue</td>
              <td className="px-3 py-2 text-right tabular-nums">{inrFromMinor(totals.revenueBudgetMinor)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{inrFromMinor(totals.revenueActualMinor)}</td>
              <td className="px-3 py-2 text-right tabular-nums" colSpan={2}>
                {inrFromMinor(totals.revenueVarianceMinor)}
              </td>
            </tr>
            <tr>
              <td className="px-3 py-2 font-medium" colSpan={2}>Expenditure</td>
              <td className="px-3 py-2 text-right tabular-nums">{inrFromMinor(totals.expenseBudgetMinor)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{inrFromMinor(totals.expenseActualMinor)}</td>
              <td className="px-3 py-2 text-right tabular-nums" colSpan={2}>
                {inrFromMinor(totals.expenseVarianceMinor)}
              </td>
            </tr>
            <tr className="border-t border-border font-semibold">
              <td className="px-3 py-2" colSpan={4}>
                Net variance
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  positive is favourable
                </span>
              </td>
              <td className="px-3 py-2 text-right tabular-nums" colSpan={2}>
                {inrFromMinor(totals.netVarianceMinor)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/*
        🔴 THE ONE ASYMMETRY IN THE REPORT, STATED ON THE PAGE RATHER THAN
        LEFT TO BE DERIVED BY SUBTRACTION. Unbudgeted actuals are inside
        the actual totals (so the report still reconciles to the P&L) and
        outside the variance totals (because "nobody budgeted this" is not
        "budget zero"). Somebody who adds the columns up by hand will find
        that gap; this sentence is what stops them concluding the report
        is broken.
      */}
      {totals.unbudgetedRowCount !== "0" && (
        <p className="rounded-md border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
          {totals.unbudgetedRowCount} line(s) totalling{" "}
          {inrFromMinor(totals.unbudgetedActualMinor)} have activity but no budget. They
          are counted in the actual totals and excluded from the variance totals — a
          missing budget is not a budget of zero, and showing it as one would report
          every unbudgeted account as a crisis.
        </p>
      )}
    </div>
  );
}
