"use client";

/**
 * Ordence — The Import Report
 * Version: v1.57.0-alpha (Batch 57)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 CONSTRAINT 2 ON SCREEN: WHICH ROWS FAILED, AND GIVE THEM BACK
 * ══════════════════════════════════════════════════════════════════════
 * This panel renders both the dry run and the real run, and it is ONE
 * component on purpose. Two renderers would be the second place a preview
 * and a commit could drift apart, after the two validators the framework
 * refuses to have (see `lib/import/plan.ts`). The only thing that changes
 * between them is the tense of a verb, taken from `report.mode`.
 *
 * ⚠️ THE ORDER OF THIS SCREEN IS AN ARGUMENT.
 *
 *   1. The counts, with the failures NOT hidden behind a tab. "982 will
 *      be created, 18 will fail" is the whole answer, and the 18 is the
 *      half a customer must not be able to skip past.
 *   2. The download of the failed rows, immediately under the counts and
 *      ABOVE the row table — because it is the action, and the table is
 *      the evidence. An import that reports "100 errors" without giving
 *      the rows back is an import nobody can finish.
 *   3. What was ignored: columns in the file no field claimed. An
 *      unmapped column is the one failure that leaves no trace in any
 *      row, so it has to be stated or it is invisible.
 *   4. The rows themselves, failures first.
 */

import type { ReactNode } from "react";
import { AlertTriangle, ArrowDownToLine, CheckCircle2, Info, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ImportReport, RowDisposition } from "@/lib/import";

/**
 * ⚠️ THE VERB CARRIES THE TENSE, AND NOTHING ELSE DOES.
 *
 * A preview that says "created" is a lie about work that has not
 * happened; a commit that says "will create" leaves the customer unsure
 * whether to press something else. One table, indexed by mode.
 */
const VERB: Record<"preview" | "commit", Record<RowDisposition, string>> = {
  preview: {
    create: "will be created",
    update: "will be updated",
    skip: "will be skipped",
    error: "will fail",
  },
  commit: {
    create: "created",
    update: "updated",
    skip: "skipped",
    error: "failed",
  },
};

const TONE: Record<RowDisposition, string> = {
  create: "text-emerald-700 dark:text-emerald-400",
  update: "text-sky-700 dark:text-sky-400",
  skip: "text-muted-foreground",
  error: "text-destructive",
};

/**
 * ⚠️ THE BOM IS NOT OPTIONAL ON THE WAY OUT EITHER.
 *
 * `lib/documents/csv.ts` says why for the server download path and the
 * same holds here: without `﻿` Excel opens UTF-8 as the legacy system
 * codepage, and every ₹ becomes â‚¹ while Hindi and Marathi names become
 * mojibake. This file is going straight back into the customer's
 * spreadsheet, so it is the one place where getting it wrong is
 * guaranteed to be seen.
 *
 * ⚠️ And `lib/import/csv.ts` strips the BOM on the way back IN, which is
 * what closes the loop — otherwise the first header of the re-uploaded
 * file would be `﻿Name` and the whole file would be refused for a
 * missing required column.
 */
function downloadCsv(csv: string, filename: string) {
  const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Without the revoke the blob is held for the lifetime of the document.
  URL.revokeObjectURL(url);
}

export function ImportReportPanel({ report }: { report: ImportReport }) {
  if (report.fatal) {
    return (
      <section
        role="alert"
        className="rounded-lg border border-destructive/40 bg-destructive/5 p-4"
      >
        <h3 className="flex items-center gap-2 text-sm font-semibold text-destructive">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          This file could not be read
        </h3>
        <p className="mt-2 text-sm">{report.fatal}</p>
        <p className="mt-2 text-xs text-muted-foreground">
          Nothing has been imported.
        </p>
      </section>
    );
  }

  const verbs = VERB[report.mode];
  const failures = report.rows.filter((r) => r.disposition === "error");
  const successes = report.rows.filter((r) => r.disposition !== "error");

  return (
    <section className="space-y-4">
      {/* ── 1. THE COUNTS ─────────────────────────────────────────── */}
      <div className="rounded-lg border bg-card p-4">
        <h3 className="text-sm font-semibold">
          {report.mode === "preview" ? "Dry run" : "Import finished"} —{" "}
          {report.totalRows} row{report.totalRows === 1 ? "" : "s"} read
        </h3>

        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Count
            icon={<CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
            value={report.counts.create}
            label={`new ${report.noun.many} ${verbs.create}`}
            tone={TONE.create}
          />
          <Count
            icon={<Info className="h-4 w-4" aria-hidden="true" />}
            value={report.counts.update}
            label={`existing ${verbs.update}`}
            tone={TONE.update}
          />
          <Count
            icon={<SkipForward className="h-4 w-4" aria-hidden="true" />}
            value={report.counts.skip}
            label={`already here, ${verbs.skip}`}
            tone={TONE.skip}
          />
          <Count
            icon={<AlertTriangle className="h-4 w-4" aria-hidden="true" />}
            value={report.counts.error}
            label={verbs.error}
            tone={TONE.error}
          />
        </dl>

        {/*
          ⭐ PARTIAL SUCCESS, SAID OUT LOUD (constraint 2). A customer who
          has never met an importer assumes all-or-nothing, and the number
          they need is not "18 failed" but "the other 982 are in". Left
          unsaid, the sensible reaction to any failure count is to assume
          nothing worked and start again — which, on a re-upload, is when
          duplicate handling stops being theoretical.
        */}
        {report.counts.error > 0 ? (
          <p className="mt-3 rounded-md bg-muted p-3 text-sm">
            {report.mode === "commit" ? (
              <>
                <strong>
                  {report.counts.create + report.counts.update} row
                  {report.counts.create + report.counts.update === 1 ? "" : "s"} went in.
                </strong>{" "}
                The {report.counts.error} below did not, and nothing else was rolled
                back — a partly-successful import is the normal outcome. Download the
                failed rows, fix them, and upload that file. Rows already imported will
                not be duplicated.
              </>
            ) : (
              <>
                <strong>Nothing has been written yet.</strong> If you continue,{" "}
                {report.counts.create + report.counts.update} row
                {report.counts.create + report.counts.update === 1 ? "" : "s"} will go
                in and the {report.counts.error} below will not. You can download the
                failing rows now, fix them, and import them separately.
              </>
            )}
          </p>
        ) : null}
      </div>

      {/* ── 2. THE ROWS BACK ──────────────────────────────────────── */}
      {report.failedRowsCsv ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
          <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-100">
            Take the {report.counts.error} failed row
            {report.counts.error === 1 ? "" : "s"} away and fix them
          </h3>
          <p className="mt-1 text-sm text-amber-900/90 dark:text-amber-100/90">
            The file below has those rows only, with your original columns and one
            extra column saying what was wrong with each. Fix them there and upload
            that file — it is a valid import file on its own.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() =>
              downloadCsv(
                report.failedRowsCsv ?? "",
                `${report.entityKey}-rows-to-fix.csv`,
              )
            }
          >
            <ArrowDownToLine className="mr-1.5 h-4 w-4" aria-hidden="true" />
            Download failed rows
          </Button>
        </div>
      ) : null}

      {/* ── 3. WHAT WAS IGNORED ───────────────────────────────────── */}
      {report.unrecognisedHeaders.length > 0 ? (
        <div className="rounded-lg border bg-card p-4">
          <h3 className="text-sm font-semibold">Columns that were ignored</h3>
          {/*
            🔴 STATED, NEVER JUST IGNORED. A column that fails to map
            leaves no trace in any row: the import succeeds completely
            while silently discarding, say, every phone number in the
            file, and nobody notices for months.
          */}
          <p className="mt-1 text-sm text-muted-foreground">
            Nothing was imported from{" "}
            <span className="font-medium text-foreground">
              {report.unrecognisedHeaders.join(", ")}
            </span>
            . If one of those is data you need, rename it to match a column in the
            table above and run this again.
          </p>
        </div>
      ) : null}

      {/* ── 4. THE ROWS ───────────────────────────────────────────── */}
      {report.rows.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <caption className="sr-only">
              Row-by-row outcome of this import
            </caption>
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="p-3 font-medium">Row</th>
                <th scope="col" className="p-3 font-medium">{report.noun.one}</th>
                <th scope="col" className="p-3 font-medium">Outcome</th>
                <th scope="col" className="p-3 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              {/* Failures first, always. They are the actionable half. */}
              {[...failures, ...successes].map((row) => (
                <tr key={row.recordNumber} className="border-b last:border-0 align-top">
                  <td className="p-3 tabular-nums text-muted-foreground">
                    {row.recordNumber}
                  </td>
                  <td className="p-3 font-medium">{row.label}</td>
                  <td className={`p-3 ${TONE[row.disposition]}`}>
                    {verbs[row.disposition]}
                  </td>
                  <td className="p-3 text-muted-foreground">
                    {row.errors.length > 0
                      ? row.errors.map((e, i) => (
                          <p key={i}>
                            {e.column ? (
                              <span className="font-medium text-foreground">
                                {e.column}:{" "}
                              </span>
                            ) : null}
                            {e.message}
                          </p>
                        ))
                      : (row.matchedOn ?? "")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/*
            ⚠️ THE TRUNCATION IS DISCLOSED. Successes are sampled because a
            thousand rows of "will be created" is payload rather than
            information — but a table that quietly shows 20 of 982 and says
            nothing reads like the other 962 were lost.
          */}
          {report.counts.create + report.counts.update + report.counts.skip >
          report.successSampleShown ? (
            <p className="border-t p-3 text-xs text-muted-foreground">
              Showing the first {report.successSampleShown} rows that succeeded, and
              every row that did not. The counts above cover all{" "}
              {report.totalRows}.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function Count({
  icon,
  value,
  label,
  tone,
}: {
  icon: ReactNode;
  value: number;
  label: string;
  tone: string;
}) {
  return (
    <div>
      <dt className={`flex items-center gap-1.5 text-xs ${tone}`}>
        {icon}
        {label}
      </dt>
      <dd className={`mt-0.5 text-2xl font-semibold tabular-nums ${tone}`}>{value}</dd>
    </div>
  );
}
