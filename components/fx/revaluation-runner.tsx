"use client";

/**
 * Ordence — ⭐⭐ STEP ONE: RUN THE REPORTING-DATE RESTATEMENT
 * Batch 0101 · the multi-currency console
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 RUNNING IS NOT POSTING, AND THIS COMPONENT CANNOT POST
 * ══════════════════════════════════════════════════════════════════════
 * It calls `runFxRevaluation`, which computes the restatement and records
 * every line it considered — including the ones it deliberately did not
 * touch. Then it fetches the working with `getRevaluationLines` and shows
 * it, skips and all, BEFORE anybody is offered the ledger.
 *
 * The posting control lives in `post-revaluation.tsx` and calls a
 * different action. There is no code path in this file that reaches the
 * ledger.
 *
 * ⚠️ THE DATE HAS NO DEFAULT. A reporting date is 31 March, or 30 June,
 * or the day the auditor asked for. It is essentially never the day
 * somebody happens to be sitting at the screen, and defaulting to today
 * would produce a run against a date nobody meant.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  getRevaluationLines,
  runFxRevaluation,
  type RevaluationLineRow,
  type RevaluationSummary,
} from "@/server/actions/fx";
import { labelled } from "./fx-format";
import { PostRevaluation } from "./post-revaluation";
import { RevaluationWorking } from "./revaluation-working";

export function RevaluationRunner({
  canRevalue,
  functionalCurrency,
  functionalCurrencyIsAssumed,
}: {
  canRevalue: boolean;
  functionalCurrency: string;
  /** True when nobody chose one and the default was used. Said out loud. */
  functionalCurrencyIsAssumed: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [asOfDate, setAsOfDate] = React.useState("");
  const [note, setNote] = React.useState("");
  const [summary, setSummary] = React.useState<RevaluationSummary | null>(null);
  const [lines, setLines] = React.useState<readonly RevaluationLineRow[] | null>(null);
  const [linesCurrency, setLinesCurrency] = React.useState(functionalCurrency);
  const [error, setError] = React.useState<string | null>(null);

  function run() {
    if (asOfDate === "") return;
    startTransition(async () => {
      const outcome = await runFxRevaluation({ asOfDate, note: note.trim() || null });
      if (!outcome.ok) {
        setSummary(null);
        setLines(null);
        setError(outcome.error);
        return;
      }
      setError(null);
      setSummary(outcome.data);

      /**
       * ⭐ THE WORKING IS FETCHED IMMEDIATELY AND IS NOT OPTIONAL. A
       * summary on its own — "gain 12,340, 3 restated, 2 skipped" — is
       * the shape of a number nobody can check.
       */
      const working = await getRevaluationLines(outcome.data.revaluationId);
      if (working.ok) {
        setLines(working.data.lines);
        setLinesCurrency(working.data.functionalCurrency);
      } else {
        setLines(null);
        setError(working.error);
      }
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Restate at a reporting date</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Monetary items — receivables, payables, cash — are restated at the closing rate
          (AS 11 ¶11(a)). Non-monetary items carried at historical cost are not (¶11(b)), and
          the ones that were skipped are listed with their reason.
        </p>

        <p className="text-xs text-muted-foreground">
          Your books are kept in <span className="font-medium">{functionalCurrency}</span>
          {functionalCurrencyIsAssumed ? (
            /*
              🔴 THE ASSUMPTION, SAID OUT LOUD. Nobody chose a functional
              currency for this workspace, so INR was used. A figure whose
              currency was assumed rather than chosen must say so on the
              screen where somebody is about to book it.
            */
            <span data-testid="fx-currency-assumed">
              {" "}
              — assumed, because no functional currency has been set for this workspace. Set
              it in Settings · Financial before relying on this.
            </span>
          ) : (
            "."
          )}
        </p>

        {!canRevalue ? (
          <p className="text-sm text-muted-foreground" data-testid="fx-revalue-denied">
            You do not have permission to run a restatement. It posts a journal and moves the
            reported profit, so <span className="font-mono text-xs">fx:revalue</span> is held
            separately. Ask an administrator.
          </p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="fx-asof" required>
                  Reporting date
                </Label>
                <Input
                  id="fx-asof"
                  type="date"
                  required
                  value={asOfDate}
                  onChange={(e) => setAsOfDate(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  The day the closing rate is taken at. No default — 31 March is a decision,
                  not today&apos;s date.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="fx-reval-note">Note</Label>
                <Input
                  id="fx-reval-note"
                  placeholder="Year-end restatement, FY 2025-26"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
            </div>

            <Button type="button" onClick={run} disabled={pending || asOfDate === ""}>
              {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Step 1 — run the restatement
            </Button>
          </>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        {summary && (
          <div className="space-y-4" data-testid="fx-run-summary">
            <div className="grid gap-3 sm:grid-cols-3">
              <Figure
                label="Exchange gain"
                value={labelled(summary.gain, summary.functionalCurrency)}
              />
              <Figure
                label="Exchange loss"
                value={labelled(summary.loss, summary.functionalCurrency)}
              />
              <Figure
                label="Net"
                value={labelled(summary.net, summary.functionalCurrency)}
                hint="Gain less loss. The two halves are stored; the net is not."
              />
            </div>

            <p className="text-xs text-muted-foreground">
              {summary.restatedCount} item{summary.restatedCount === 1 ? "" : "s"} restated ·{" "}
              {summary.skippedCount} not restated · reporting date {summary.asOfDate}
            </p>

            {summary.missingRates.length > 0 && (
              <p className="text-xs text-destructive" data-testid="fx-missing-rates">
                No closing rate is on file for {summary.missingRates.join(", ")} at{" "}
                {summary.asOfDate}. Those items were left alone rather than restated at a
                guessed rate — enter the rate and run the date again.
              </p>
            )}

            {lines && (
              <RevaluationWorking functionalCurrency={linesCurrency} lines={lines} />
            )}

            <PostRevaluation
              revaluationId={summary.revaluationId}
              posted={summary.posted}
              unpostedReason={summary.unpostedReason}
              canRevalue={canRevalue}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Figure({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
