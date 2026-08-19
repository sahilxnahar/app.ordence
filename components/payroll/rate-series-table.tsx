"use client";

/**
 * Ordence — ⭐⭐⭐ THE RATE TABLE, AUDITABLE
 * Version: v1.46.0-alpha · Batch 52
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A RATE TABLE WITHOUT THESE TWO FACTS IS A LIST OF NUMBERS
 * ══════════════════════════════════════════════════════════════════════
 * Design point 3, and it is the difference between a screen and an
 * audit trail. Every row shows:
 *
 *   ① WHETHER IT IS THE ONE IN FORCE TODAY. Five dated rows and no
 *     marker means the reader has to do `pickEffective` in their head,
 *     and for `professional_tax` and `income_tax_slab` — where the
 *     engine unions rows rather than picking one — they will do it
 *     wrong, because "the most recent one" is not the rule there.
 *
 *   ② WHICH PAYROLL RUNS READ IT. This is what turns "the ceiling was
 *     ₹15,000 from April 2024" into "and PR-2024-04 through PR-2025-03
 *     were computed on it". Without it, nobody can answer the only
 *     question that ever gets asked about a rate table, which is why a
 *     particular payslip says what it says.
 *
 * ⚠️ AND BOTH ARE DERIVED RATHER THAN RECORDED, which the screen says
 * out loud. There is no column linking a run to the rate rows it read;
 * `listStatutoryRates` replays the engine's selection at each run's
 * period end. That is exact today and becomes retrospective if a row's
 * dates are later corrected. Presenting a derivation as a record would
 * be the worse of the two failures.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 AND AN OVERLAP ALREADY IN THE TABLE IS SHOWN AS AN ALARM
 * ══════════════════════════════════════════════════════════════════════
 * `addRateRevision` refuses to create one. It cannot undo one that
 * arrived from the seed, an import or a psql prompt, and until migration
 * 0082 adds an exclusion constraint the database will not either. An
 * overlap makes payroll non-deterministic — see `resolutionFor` in
 * `lib/payroll/rate-periods.ts` — so it is rendered at the top of the
 * series in red rather than left for somebody to notice.
 */

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  RateCorrectionDialog,
  type CorrectionResult,
} from "@/components/payroll/rate-correction-dialog";
import { percentFromBp, rupeesFromMinor } from "@/lib/payroll/rate-periods";

export type RunRef = {
  id: string;
  runNo: string;
  periodStart: string;
  periodEnd: string;
  status: string;
};

export type RateRow = {
  id: string;
  kind: string;
  scope: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  payload: Record<string, unknown>;
  note: string | null;
  inForceToday: boolean;
  runs: readonly RunRef[];
  settledRunNos: readonly string[];
  overlapsWith: readonly string[];
};

export type RateSeries = {
  key: string;
  kind: string;
  scope: string | null;
  label: string;
  resolution: "single" | "union";
  rows: readonly RateRow[];
  inForceTodayIds: readonly string[];
};

/**
 * ⭐ THE FIGURES IN WORDS, NEXT TO THE RAW OBJECT AND NOT INSTEAD OF IT.
 *
 * ⚠️ A SUMMARY THAT REPLACED THE PAYLOAD WOULD HIDE THE FIELD THIS
 * FORMATTER DOES NOT KNOW ABOUT. Somebody reading a rate table is
 * checking it against a gazette notification, and a field silently
 * omitted from the summary is a field they will not check. So the raw
 * JSON stays visible underneath — the summary is a reading aid, not a
 * replacement.
 */
function summarise(kind: string, payload: Record<string, unknown>): string[] {
  const bp = (v: unknown) => (typeof v === "number" ? percentFromBp(v) : "—");
  const money = (v: unknown) => (typeof v === "string" ? rupeesFromMinor(v) : "—");

  if (kind === "pf") {
    return [
      `Employee ${bp(payload.employeeRateBp)}`,
      `Employer ${bp(payload.employerRateBp)}, of which pension ${bp(payload.pensionRateBp)}`,
      `EDLI ${bp(payload.edliRateBp)} · admin ${bp(payload.adminRateBp)}`,
      `Wage ceiling ${money(payload.wageCeilingMinor)} · pension ceiling ${money(payload.pensionCeilingMinor)}`,
    ];
  }
  if (kind === "esi") {
    return [
      `Employee ${bp(payload.employeeRateBp)} · employer ${bp(payload.employerRateBp)}`,
      // ⚠️ SAID AS A CLIFF, NOT A CEILING. ESI stops entirely above the
      // limit; PF contributes on the limit. Reading one as the other
      // deducts from somebody who is not covered at all.
      `Gross limit ${money(payload.wageLimitMinor)} — above it there is no contribution at all, not a capped one`,
    ];
  }
  if (kind === "income_tax") {
    return [
      `Standard deduction ${money(payload.standardDeductionMinor)}`,
      `Rebate up to ${money(payload.rebateMaxMinor)} at or below ${money(payload.rebateLimitMinor)}`,
      `Cess ${bp(payload.cessRateBp)}`,
    ];
  }
  if (kind === "income_tax_slab" || kind === "professional_tax") {
    const slabs = Array.isArray(payload.slabs)
      ? (payload.slabs as Record<string, unknown>[])
      : [];
    return slabs.map((s) => {
      const upper = s.toMinor === null || s.toMinor === undefined ? "above" : money(s.toMinor);
      const band =
        s.toMinor === null || s.toMinor === undefined
          ? `${money(s.fromMinor)} and above`
          : `${money(s.fromMinor)} to ${upper}`;
      if (kind === "income_tax_slab") return `${band}: ${bp(s.rateBp)}`;
      const feb =
        s.februaryAmountMinor === null || s.februaryAmountMinor === undefined
          ? ""
          : ` (${money(s.februaryAmountMinor)} in February)`;
      return `${band}: ${money(s.amountMinor)}${feb}`;
    });
  }
  return [];
}

export function RateSeriesTable({
  series,
  asOf,
  canCorrect,
  onCorrect,
}: {
  series: readonly RateSeries[];
  asOf: string;
  /** ⚠️ `payroll.manage` AND `payroll.approve`. One is not enough. */
  canCorrect: boolean;
  onCorrect: (input: {
    rowId: string;
    payloadJson: string;
    effectiveFrom: string;
    effectiveTo: string | null;
    reason: string;
    acknowledgeRuns: string[];
  }) => Promise<CorrectionResult>;
}) {
  return (
    <div className="space-y-4">
      {series.map((s) => {
        const overlapping = s.rows.filter((r) => r.overlapsWith.length > 0);
        const nothingToday = s.inForceTodayIds.length === 0;

        return (
          <Card key={s.key}>
            <CardHeader className="pb-2">
              <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                {s.label}
                {/*
                  ⭐ THE RESOLUTION RULE IS ON THE SCREEN because it
                  changes what "in force today" means. For pf, esi and
                  income tax exactly one row wins. For slab tables every
                  row in force applies together, and a reader who assumes
                  the newest one supersedes will misread the whole
                  series.
                */}
                <Badge variant="outline">
                  {s.resolution === "single"
                    ? "one row applies at a time"
                    : "every row in force applies together"}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* 🔴 DESIGN POINT 4, VISIBLE. */}
              {overlapping.length > 0 ? (
                <div className="rounded border border-destructive p-2 text-xs">
                  <p className="font-semibold">
                    {overlapping.length} row{overlapping.length === 1 ? "" : "s"} in this series
                    overlap in time.
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    {s.resolution === "single"
                      ? "Two rows in force on the same day means payroll reads whichever one it happens to pick, and the same period can compute differently twice. Close one of the periods before the next run."
                      : "Every row in force is read together, so overlapping slab tables are concatenated into one ladder and the same band is charged twice. This produces a confident, plausible, roughly doubled figure with nothing reporting a problem."}
                  </p>
                </div>
              ) : null}

              {/* ⚠️ NO RATE TODAY IS A REFUSAL TO COMPUTE, NOT A ZERO. */}
              {nothingToday ? (
                <div className="rounded border border-amber-500 p-2 text-xs">
                  Nothing in this series is in force on {asOf}. A payroll run dated today would
                  find no rate and say so on every payslip rather than deducting zero — that is
                  deliberate, but it means the run cannot be approved until this is filled in.
                </div>
              ) : null}

              {s.rows.map((row) => (
                <div
                  key={row.id}
                  className={`rounded border p-3 text-xs ${
                    row.inForceToday ? "border-foreground/40" : "border-border"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">
                      {row.effectiveFrom} to {row.effectiveTo ?? "open"}
                    </span>
                    {/* ⭐ DESIGN POINT 3 ①. */}
                    {row.inForceToday ? (
                      <Badge>in force today</Badge>
                    ) : (
                      <Badge variant="outline">
                        {row.effectiveFrom > asOf ? "not yet in force" : "superseded"}
                      </Badge>
                    )}
                    {row.settledRunNos.length > 0 ? (
                      <Badge variant="secondary">
                        {row.settledRunNos.length} signed-off run
                        {row.settledRunNos.length === 1 ? "" : "s"}
                      </Badge>
                    ) : null}
                  </div>

                  <ul className="mt-2 space-y-0.5 text-muted-foreground">
                    {summarise(row.kind, row.payload).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>

                  {/* ⭐ DESIGN POINT 3 ②. */}
                  <div className="mt-2">
                    {row.runs.length === 0 ? (
                      <p className="text-muted-foreground">
                        No payroll run has been computed against this row.
                      </p>
                    ) : (
                      <p className="text-muted-foreground">
                        Read by{" "}
                        {row.runs.map((r, i) => (
                          <span key={r.id}>
                            {i > 0 ? ", " : ""}
                            <span className="font-mono">{r.runNo}</span>
                            <span> ({r.status})</span>
                          </span>
                        ))}
                        .
                      </p>
                    )}
                  </div>

                  {row.note ? (
                    <pre className="mt-2 whitespace-pre-wrap font-sans text-muted-foreground">
                      {row.note}
                    </pre>
                  ) : null}

                  <details className="mt-2">
                    <summary className="cursor-pointer text-muted-foreground">
                      The stored figures
                    </summary>
                    <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 font-mono">
                      {JSON.stringify(row.payload, null, 2)}
                    </pre>
                  </details>

                  {/*
                    🔴 THE CORRECTION DOOR OPENS ONLY WHERE THERE IS
                    SOMETHING TO RESTATE. A row no signed-off run read is
                    not corrected — a new dated row is added at the
                    ordinary door, which leaves the history intact. Two
                    ways to do the harmless thing is one too many, and
                    the second one is the one people learn.
                  */}
                  {canCorrect && row.settledRunNos.length > 0 ? (
                    <div className="mt-3">
                      <RateCorrectionDialog
                        rowId={row.id}
                        label={`${s.label}, ${row.effectiveFrom} to ${row.effectiveTo ?? "open"}`}
                        effectiveFrom={row.effectiveFrom}
                        effectiveTo={row.effectiveTo}
                        payloadJson={JSON.stringify(row.payload, null, 2)}
                        settledRunNos={row.settledRunNos}
                        onCorrect={onCorrect}
                      />
                    </div>
                  ) : null}
                </div>
              ))}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
