/**
 * Ordence — ⭐⭐⭐ THE CAVEATS ON A PAYSLIP, SHOWN RATHER THAN SWALLOWED
 * Version: v1.43.0-alpha · Batch 107
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A PAYSLIP THAT QUIETLY UNDERSTATES TAX IS WORSE THAN ONE THAT SAYS
 *    WHY
 * ══════════════════════════════════════════════════════════════════════
 * `lib/payroll/statutory.ts` is unusually honest for a tax engine. It
 * does not guess. When a salary is in surcharge territory it REFUSES to
 * compute surcharge and marginal relief, and it says in the result that
 * the figure is understated. When the year's estimated tax has already
 * been withheld it says that too. When declared investments were ignored
 * because the employee is on the new regime, it says that. Every one of
 * those sentences was written to be read by the person whose money it
 * is, and `buildPayslip` stores them on the row.
 *
 * ⚠️ AND EVERY LAYER BETWEEN THERE AND HERE IS AN OPPORTUNITY TO LOSE
 * THEM. They are verbose next to a rupee figure, they make the document
 * look uncertain, and the natural instinct on a screen for employees is
 * to show the number and hide the hedging. That instinct is exactly
 * backwards. The employee cannot act on the number — it is already
 * deducted — but they CAN act on "this excludes surcharge, ask your
 * accountant", which is the difference between a correct return in July
 * and a demand with interest the following year.
 *
 * ⭐ SO THE TAX CAVEATS ARE PULLED OUT AND SHOWN FIRST, NOT MIXED IN.
 * `buildPayslip` prefixes them "Income tax: " precisely so they can be
 * found again, and a note that says the tax is an estimate deserves more
 * of the reader's attention than one that says the professional tax slab
 * for Karnataka was applied.
 */

/**
 * ⚠️ THE PREFIX IS A CONVENTION, NOT A SCHEMA, AND THE FALLBACK MATTERS.
 *
 * If `buildPayslip` ever stops prefixing, this partition silently sorts
 * every caveat into "other" — where it is still SHOWN, just less
 * prominently. Nothing disappears. A cleverer split that dropped notes
 * it did not recognise would fail in the one direction this whole file
 * exists to prevent.
 */
const TAX_PREFIX = "Income tax:";

export function partitionNotes(notes: readonly string[]): {
  tax: string[];
  other: string[];
} {
  const tax: string[] = [];
  const other: string[] = [];
  for (const note of notes) {
    if (note.startsWith(TAX_PREFIX)) tax.push(note.slice(TAX_PREFIX.length).trim());
    else other.push(note);
  }
  return { tax, other };
}

export function PayslipCaveats({
  notes,
  problems,
  tdsIsProjection,
  tdsOverridden,
}: {
  notes: string[];
  problems: string[];
  tdsIsProjection: boolean;
  tdsOverridden: boolean;
}) {
  const { tax, other } = partitionNotes(notes);

  return (
    <div className="space-y-3">
      {/*
        🔴 PROBLEMS FIRST, ABOVE EVERYTHING, IN RED.

        ⚠️ `approvePayrollRun` refuses while any payslip carries a
        problem, so on an approved run this should be empty. The one that
        gets through is the one nobody expected — and the employee is the
        person most likely to notice it and least likely to be told.
      */}
      {problems.length > 0 ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
          <p className="text-xs font-semibold text-destructive">
            Something on this payslip is not right
          </p>
          <ul className="mt-1 space-y-1 text-xs text-destructive">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            Show this to whoever runs payroll. It is a figure the system itself is not
            confident about, not a rounding difference.
          </p>
        </div>
      ) : null}

      {/*
        ⭐⭐ THE TAX CAVEATS, WITH THE HEADLINE STATED BEFORE THEM.

        ⚠️ "Estimate" IS SAID IN THE HEADING RATHER THAN LEFT TO THE
        CAVEAT TEXT. Monthly TDS under section 192 is one twelfth of the
        tax on a PROJECTED annual income — a projection built from
        declarations the employee may not have made yet. Somebody reading
        their first payslip has no reason to know that, and "your tax
        will be trued up" is not a sentence that can wait until the
        fourth bullet.
      */}
      {tdsIsProjection || tdsOverridden || tax.length > 0 ? (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/5 p-3">
          <p className="text-xs font-semibold">About the income tax figure</p>

          {tdsOverridden ? (
            <p className="mt-1 text-xs text-muted-foreground">
              This month&rsquo;s income tax is a figure your accountant entered for you
              directly. Ordence has not calculated it.
            </p>
          ) : null}

          {tdsIsProjection ? (
            <p className="mt-1 text-xs text-muted-foreground">
              This is an estimate, not a settled amount. Tax on salary is deducted against a
              projection of your whole year&rsquo;s income, and the projection is corrected as
              the year goes on — so the monthly figure can move.
            </p>
          ) : null}

          {tax.length > 0 ? (
            <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
              {tax.map((c) => (
                <li key={c}>• {c}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/*
        ⚠️ THE REST ARE STILL SHOWN. They explain the PF ceiling, the ESI
        wage limit and which State's professional tax slab was applied —
        the three deductions employees ask about most, and the three that
        look arbitrary without a sentence beside them.
      */}
      {other.length > 0 ? (
        <div className="rounded-md border bg-muted/30 p-3">
          <p className="text-xs font-semibold">How your deductions were worked out</p>
          <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
            {other.map((n) => (
              <li key={n}>• {n}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
