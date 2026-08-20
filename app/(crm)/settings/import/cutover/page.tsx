/**
 * Ordence — ⭐⭐⭐ RECONCILIATION AND CUTOVER
 * Version: v1.89.0-alpha · Wave 2A
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE QUESTION THIS PAGE ANSWERS IS "MAY I SWITCH THE OLD SYSTEM OFF"
 * ══════════════════════════════════════════════════════════════════════
 * Not "did the import finish" — a finished import can be missing a third
 * of the money and every screen in the product will look plausible. The
 * only honest answer compares two numbers that came from two different
 * places and shows the distance between them.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT IS MEASURED HERE, AND WHAT HONESTLY IS NOT
 * ══════════════════════════════════════════════════════════════════════
 * MEASURED — the row census, per migration run. `expectedRows` was
 * declared by the browser BEFORE the first chunk was sent, and
 * `rowsWritten + rowsSkipped + rowsFailed` is what the server accounted
 * for afterwards. Two numbers, two sources, and their distance is exactly
 * "how many rows never arrived". The database refuses to mark a run
 * `completed` while that distance is not zero
 * (`import_runs_completed_is_complete`), so this page and the run status
 * cannot disagree.
 *
 * NOT MEASURED — the control totals. "Your trial balance says debtors are
 * 4,81,200 and the invoices that came in total 4,79,800" requires reading
 * the customer's own opening trial balance back and footing the imported
 * sub-ledgers against it. That measurement lives on the server, over the
 * provenance sidecar, and it does not exist yet — Track M8. See
 * `PATCH-REQUEST-WAVE-2A.md` §1 for the exact function this page is
 * waiting for.
 *
 * ⚠️ SO IT IS RENDERED AS `not-checked`, WITH THE REASON, AND IT KEEPS
 * THIS PAGE OFF GREEN. That is the entire point of the shape:
 * `cutoverVerdict` cannot return "everything ties" while one unmeasured
 * line exists, so a migration whose money nobody has checked reads
 * "3 of 4 checks ran" and never "all good". A page that went green here
 * would be the exact failure this wave exists to prevent, and it would be
 * green by omission — the cheapest kind of lie a screen can tell.
 */

import Link from "next/link";
import { ClipboardCheck } from "lucide-react";
import {
  Reconciliation,
  type ReconciliationLine,
} from "@/components/import/reconciliation";
import { ALL_IMPORT_ENTITIES, isImportEntityKey } from "@/lib/import";
import { getImportRuns } from "@/server/actions/import";
import { UndoRun } from "@/components/import/undo-run";

export const dynamic = "force-dynamic";

/**
 * ⚠️ THE CONTROL-TOTAL LINE IS DECLARED, NOT INVENTED PER ENTITY. One
 * honest sentence about the whole unmeasured half beats four fabricated
 * lines that each look like a check.
 */
const CONTROL_TOTALS: ReconciliationLine = {
  key: "control-totals",
  label: "Control totals — debtors, creditors, stock, trial balance",
  unit: { kind: "money", currency: "INR" },
  declaredLabel: "your trial balance",
  importedLabel: "imported and footed",
  measure: {
    kind: "not-checked",
    why:
      "Ordence cannot yet foot the invoices, bills and stock it imported back against " +
      "the opening trial balance you gave it, so nobody has checked that the money " +
      "agrees. This is not a zero and it is not a pass — it is a check that has not " +
      "run. Until it does, foot these four totals against your old system by hand " +
      "before you switch it off.",
  },
};

export default async function ImportCutoverPage() {
  const runs = await getImportRuns();

  /**
   * ⚠️ A FAILURE TO READ THE RUNS IS NOT AN EMPTY LIST. "You have imported
   * nothing" and "we could not look" are different facts, and this page
   * exists to keep exactly that pair apart.
   */
  const lines: ReconciliationLine[] = !runs.ok
    ? [
        {
          key: "runs-unreadable",
          label: "Rows in every migration",
          unit: { kind: "count", noun: "row" },
          declaredLabel: "rows in your files",
          importedLabel: "rows accounted for",
          measure: {
            kind: "not-checked",
            why: `Your migration history could not be read just now, so the row census did not run. ${runs.error}`,
          },
        },
      ]
    : runs.data.map((run): ReconciliationLine => {
        /**
         * ⚠️ THE ENTITY KEY ARRIVES FROM THE DATABASE AS A STRING AND IS
         * CHECKED FOR MEMBERSHIP RATHER THAN LOOKED UP. `isImportEntityKey`
         * is the one allowlist; a bare index on an unchecked string is the
         * prototype lookup this codebase refuses everywhere else, and a key
         * whose entity has since been renamed is shown as itself instead of
         * crashing the page somebody opens to check their cutover.
         */
        const known = isImportEntityKey(run.entityKey)
          ? ALL_IMPORT_ENTITIES[run.entityKey].label
          : run.entityKey;
        const label = `${known}${run.sourceName ? ` — ${run.sourceName}` : ""}`;
        const accounted = run.rowsWritten + run.rowsSkipped + run.rowsFailed;

        /**
         * 🔴 A RUN STILL IN FLIGHT IS NOT A SHORTFALL. Its rows have not
         * arrived YET, which is a different fact from rows that never
         * will, and showing it in red would teach people that red on this
         * page means "wait a moment".
         */
        if (run.status === "running" && run.finishedAt === null) {
          return {
            key: run.id,
            label,
            unit: { kind: "count", noun: "row" },
            declaredLabel: "rows in your file",
            importedLabel: "rows accounted for",
            measure: {
              kind: "not-checked",
              why: "This migration is still running, so its rows cannot be counted yet.",
            },
          };
        }

        return {
          key: run.id,
          label,
          unit: { kind: "count", noun: "row" },
          declaredLabel: "rows in your file",
          importedLabel: "rows accounted for",
          measure: {
            kind: "measured",
            declared: BigInt(run.expectedRows),
            imported: BigInt(accounted),
          },
        };
      });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <ClipboardCheck className="h-5 w-5" aria-hidden="true" />
          Does it tie?
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Before you switch your old system off. Every line here is two numbers from
          two different places and the distance between them — one number on its own
          is a receipt, not a check.
        </p>
      </header>

      <Reconciliation lines={[...lines, CONTROL_TOTALS]} title="Cutover checks" />

      {/*
        ⭐⭐ INTEGRATION , THE UNDO, WIRED.

        Wave 2B built `undoImportRun` over a reversal engine proven against
        a real database and called by nothing; Wave 2A built these screens
        before that action existed. Neither wave was wrong , the seam is
        what integration is for, and `check:action-reach` is what named it,
        going from its 119 baseline to 120 when 2B landed alone.

        ⚠️ IT IS HERE AND NOT ON THE IMPORT INDEX ON PURPOSE. This is the
        page somebody opens when a number does not tie, which is the moment
        an undo is actually wanted. Beside the upload button it would be
        offered at the moment it is most likely to be a mistake.
      */}
      {runs.ok && runs.data.length > 0 ? (
        <section className="space-y-2 border-t border-border pt-5">
          <h2 className="text-sm font-medium">Undo a migration</h2>
          <p className="text-xs text-muted-foreground">
            Removes what a migration created and puts back what it overwrote. One
            that cannot be fully undone says so and names every row it could not
            reach , it never reports success with rows left behind.
          </p>
          <ul className="space-y-2">
            {runs.data.map((run) => (
              <li key={`undo-${run.id}`}>
                <UndoRun
                  runId={run.id}
                  label={
                    isImportEntityKey(run.entityKey)
                      ? ALL_IMPORT_ENTITIES[run.entityKey].label
                      : run.entityKey
                  }
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="text-sm text-muted-foreground">
        A line that does not agree is not necessarily data that is lost: uploading the
        same file again is recognised as the same file and picks up where it stopped.{" "}
        <Link href="/settings/import" className="underline underline-offset-2">
          Back to import
        </Link>
        .
      </p>
    </div>
  );
}
