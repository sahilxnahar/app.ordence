"use client";

/**
 * Ordence , ⭐⭐ THE UNDO, WIRED
 * Version: v1.92.0-alpha · integration, closing the 2A/2B seam
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS FILE EXISTS AND NEITHER WAVE WROTE IT
 * ══════════════════════════════════════════════════════════════════════
 * Wave 2B built `undoImportRun` , the action over a 1,197-line reversal
 * engine that had been proven against a real PostgreSQL and called by
 * nothing. Wave 2A built the migration screens. **Neither wired them
 * together**, and neither was wrong to: 2A's brief was written before the
 * action existed, and 2B does not own screens.
 *
 * ⚠️ THE GATE FOUND IT, NOT A REVIEWER. Applying 2B took
 * `check:action-reach` from its 119 baseline to 120: "a server action , a
 * public URL , that no screen calls". Applying 2A did not bring it back
 * down. That is the seam, named by a number.
 *
 * ⭐ AND IT IS THE DEFECT THIS WHOLE PROJECT KEEPS FINDING, arriving one
 * level up: not a function nobody calls, but two waves that each did
 * their half correctly. Parallel work does not remove integration; it
 * concentrates it here.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { undoImportRun } from "@/server/actions/import-reversal";

type Outcome = { tone: "ok" | "partial" | "refused"; message: string } | null;

export function UndoRun({
  runId,
  label,
}: {
  runId: string;
  label: string;
}): React.JSX.Element {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const router = useRouter();

  /**
   * 🔴 TWO CLICKS, AND THE SECOND ONE SAYS WHAT IT DOES.
   *
   * An undo removes rows a customer's staff may have been working in for
   * hours. `window.confirm` was the obvious choice and is the wrong one:
   * it cannot show which migration, and a dialog that says "Are you
   * sure?" about an unnamed thing is a dialog people dismiss.
   */
  if (!confirming && outcome === null) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
      >
        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
        Undo this migration
      </button>
    );
  }

  if (outcome !== null) {
    /*
     * ⚠️ THE THREE OUTCOMES ARE NOT THREE SHADES OF THE SAME THING.
     * "reversed" is done. "partial" means rows are STILL THERE and the
     * customer must not import the file again on top of them. "refused"
     * means nothing moved. Collapsing them into success/failure is how a
     * customer starts their migration again over rows that never left.
     */
    const tone =
      outcome.tone === "ok"
        ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200"
        : outcome.tone === "partial"
          ? "border-red-300 bg-red-50 text-red-900 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200"
          : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200";
    return (
      <p className={`rounded-md border px-3 py-2 text-xs ${tone}`}>{outcome.message}</p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs dark:border-amber-900/60 dark:bg-amber-950/30">
      <span className="text-amber-900 dark:text-amber-200">
        Undo <b>{label}</b>? Rows this migration created will be removed, and rows it
        overwrote will be put back as they were.
      </span>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await undoImportRun({ runId });
            if (!result.ok) {
              setOutcome({ tone: "refused", message: result.error });
              return;
            }
            const d = result.data;
            setOutcome(
              d.status === "reversed"
                ? { tone: "ok", message: d.message }
                : { tone: "partial", message: d.message },
            );
            /*
             * ⚠️ REFRESH EVEN ON A PARTIAL. The counts on this page moved
             * whatever the outcome, and leaving a stale census beside a
             * message saying rows were removed is two screens disagreeing
             * about the same migration.
             */
            router.refresh();
          })
        }
        className="rounded-md bg-red-700 px-2.5 py-1 font-medium text-white disabled:opacity-60"
      >
        {pending ? "Undoing…" : "Yes, undo it"}
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => setConfirming(false)}
        className="rounded-md border border-border bg-background px-2.5 py-1"
      >
        Keep it
      </button>
    </div>
  );
}
