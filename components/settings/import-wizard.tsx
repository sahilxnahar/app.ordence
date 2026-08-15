"use client";

/**
 * Ordence — The Import Wizard
 * Version: v1.57.0-alpha (Batch 57)
 *
 * ══════════════════════════════════════════════════════════════════════
 * FOUR STEPS, AND THE ORDER OF STEPS 2 AND 3 IS THE SAFETY PROPERTY
 * ══════════════════════════════════════════════════════════════════════
 *   1. What are you importing?          (and take the blank template)
 *   2. The file.
 *   3. 🔴 What happens to records that already exist? — BEFORE the run.
 *   4. Dry run, then commit.
 *
 * ⚠️ STEP 3 COMES BEFORE THE DRY RUN AND HAS NO PRESELECTED ANSWER
 *    (constraint 3).
 *
 * The natural place to ask is after the preview, when the wizard can say
 * "we found 340 matches — update them?". It is also the place where the
 * answer stops being a decision. By then the customer has chosen a file,
 * waited for an upload, read a report and is committed to finishing;
 * "yes" is the path to being done, and "yes" here means overwriting 340
 * records they may not have looked at. Asked first, with the file still
 * in front of them and nothing invested, it is a real choice about their
 * own data.
 *
 * ⚠️ AND NOTHING IS PRE-TICKED. A default is the mechanism by which a
 * decision stops being made — the server schema has no default either, so
 * this is enforced rather than merely encouraged.
 *
 * ⚠️ THE COMMIT BUTTON DOES NOT EXIST UNTIL A PREVIEW HAS RUN. Not
 * disabled — absent. A disabled control invites the question "how do I
 * enable this", and the answer we want the customer to reach is "look at
 * the dry run first", which is the same answer whether or not they were
 * going to.
 */

import { useMemo, useState, useTransition } from "react";
import { ArrowDownToLine, FileSpreadsheet, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ImportReportPanel } from "@/components/settings/import-report-panel";
import {
  IMPORT_ENTITIES,
  MAX_IMPORT_ROWS,
  buildTemplateCsv,
  type DuplicateMode,
  type ImportEntityKey,
  type ImportReport,
} from "@/lib/import";
import type { ActionResult } from "@/lib/validators/crm";

type Action = (input: {
  entity: string;
  csvText: string;
  duplicateMode: DuplicateMode;
}) => Promise<ActionResult<ImportReport>>;

/**
 * ⚠️ THE CONSEQUENCE IS IN THE LABEL, NOT IN A TOOLTIP.
 *
 * "Skip / Update / Fail" is three words that describe the mechanism and
 * none that describe what happens to the customer's data. The sentence
 * under each option is what the person is actually choosing between, and
 * `update` says the destructive part out loud — including that a name
 * match is not proof of identity, which is the specific way this can go
 * wrong for a company or an unregistered party.
 */
const DUPLICATE_OPTIONS: Array<{
  value: DuplicateMode;
  title: string;
  detail: string;
  recommended?: boolean;
}> = [
  {
    value: "skip",
    title: "Leave the existing record alone",
    detail:
      "The row is counted as skipped and nothing about the record you already " +
      "have changes. Safe to run twice — it is what makes re-uploading a whole " +
      "file after fixing a few rows harmless.",
    recommended: true,
  },
  {
    value: "update",
    title: "Overwrite the existing record with the row in this file",
    detail:
      "This is a mass edit of records you already have, not just an import. " +
      "Two different businesses can share a name, so where a match was made on " +
      "name rather than on a domain or a GSTIN, this can overwrite the wrong " +
      "record. Blank cells in the file are treated as 'not supplied' and will " +
      "not erase what is already there.",
  },
  {
    value: "fail",
    title: "Refuse the row and tell me about it",
    detail:
      "Nothing is written for that row and it appears in the failed-rows " +
      "download. Choose this when the file is supposed to be all new records " +
      "and a match means something is wrong.",
  },
];

export function ImportWizard({
  preview,
  commit,
}: {
  preview: Action;
  commit: Action;
}) {
  const [entityKey, setEntityKey] = useState<ImportEntityKey>("companies");
  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [duplicateMode, setDuplicateMode] = useState<DuplicateMode | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const entity = IMPORT_ENTITIES[entityKey];

  /*
   * ⭐ THE TEMPLATE IS BUILT IN THE BROWSER FROM THE SAME COLUMN LIST THE
   * SERVER MAPS AGAINST. Not a static file in `public/`, and not a second
   * server round trip — a checked-in template is a copy of the column
   * list that goes stale the first time a column is added, and a stale
   * template is worse than none because the customer trusts it.
   *
   * This is only possible because `lib/import/` is pure: it imports no
   * database and no `node:` module, so it can be in a client bundle.
   */
  const template = useMemo(() => buildTemplateCsv(entity.columns), [entity]);

  function reset() {
    setReport(null);
    setError(null);
  }

  async function readFile(file: File) {
    reset();
    setFileName(file.name);
    /*
     * ⚠️ `File.text()` DECODES AS UTF-8, which is what we want, and it
     * leaves the BOM in place — Excel's `EF BB BF` becomes `﻿` at the
     * start of the string. `lib/import/csv.ts` strips it. Nothing is done
     * about it here, deliberately: one place, so no reader of a CSV in
     * this codebase has to remember.
     */
    setCsvText(await file.text());
  }

  function run(action: Action, mode: "preview" | "commit") {
    if (!duplicateMode) {
      setError("Choose what should happen to records that already exist.");
      return;
    }
    setError(null);
    start(async () => {
      const result = await action({ entity: entityKey, csvText, duplicateMode });
      if (!result.ok) {
        setError(result.error);
        setReport(null);
        return;
      }
      setReport(result.data);
    });
  }

  const canRun = csvText.trim() !== "" && duplicateMode !== null && !pending;
  const previewedCleanly =
    report !== null && report.mode === "preview" && report.fatal === null;

  return (
    <div className="space-y-8">
      {/* ── STEP 1 ────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">1. What are you importing?</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {(Object.keys(IMPORT_ENTITIES) as ImportEntityKey[]).map((key) => {
            const def = IMPORT_ENTITIES[key];
            const active = key === entityKey;
            return (
              <label
                key={key}
                className={`cursor-pointer rounded-lg border p-4 ${
                  active ? "border-primary bg-primary/5" : "border-border bg-card"
                }`}
              >
                <span className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="entity"
                    value={key}
                    checked={active}
                    className="mt-1"
                    onChange={() => {
                      setEntityKey(key);
                      reset();
                    }}
                  />
                  <span>
                    <span className="block text-sm font-medium">{def.label}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {def.description}
                    </span>
                  </span>
                </span>
              </label>
            );
          })}
        </div>

        <div className="rounded-lg border bg-card">
          <div className="flex items-center justify-between gap-3 border-b p-3">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <FileSpreadsheet className="h-4 w-4" aria-hidden="true" />
              Columns for {entity.label.toLowerCase()}
            </h3>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const blob = new Blob([`﻿${template}`], {
                  type: "text/csv;charset=utf-8;",
                });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `${entityKey}-template.csv`;
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              <ArrowDownToLine className="mr-1.5 h-4 w-4" aria-hidden="true" />
              Blank template
            </Button>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="p-3 font-medium">Column</th>
                <th scope="col" className="p-3 font-medium">Needed</th>
                <th scope="col" className="p-3 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody>
              {entity.columns.map((column) => (
                <tr key={column.field} className="border-b last:border-0 align-top">
                  <td className="p-3 font-medium">{column.header}</td>
                  <td className="p-3 text-xs text-muted-foreground">
                    {column.required ? "Required" : "Optional"}
                  </td>
                  <td className="p-3 text-xs text-muted-foreground">{column.help}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {/*
            Spelling is not the constraint, and saying so prevents a
            support conversation. `Company Name`, `company_name` and
            `COMPANY NAME` all match.
          */}
          <p className="border-t p-3 text-xs text-muted-foreground">
            Capitals, spaces and underscores in your headings do not matter — and
            common alternatives are recognised. Columns this does not recognise are
            ignored and listed in the report rather than causing a failure. Up to{" "}
            {MAX_IMPORT_ROWS} rows per file.
          </p>
        </div>
      </section>

      {/* ── STEP 2 ────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">2. The file</h2>
        <div className="rounded-lg border bg-card p-4">
          <Label htmlFor="import-file" className="text-sm">
            Choose a CSV
          </Label>
          <input
            id="import-file"
            type="file"
            accept=".csv,text/csv"
            className="mt-2 block w-full text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void readFile(file);
            }}
          />
          {fileName ? (
            <p className="mt-2 text-xs text-muted-foreground">Loaded {fileName}.</p>
          ) : null}

          <div className="mt-4">
            <Label htmlFor="import-text" className="text-sm">
              Or paste the rows
            </Label>
            <Textarea
              id="import-text"
              className="mt-2 font-mono text-xs"
              rows={6}
              value={csvText}
              placeholder={template}
              onChange={(e) => {
                setCsvText(e.target.value);
                setFileName(null);
                reset();
              }}
            />
          </div>
          {/*
            ⚠️ EXPORTING AS CSV IS THE STEP CUSTOMERS GET WRONG, and the
            failure is silent: an .xlsx renamed to .csv parses as binary
            noise and produces a bewildering report.
          */}
          <p className="mt-2 text-xs text-muted-foreground">
            From Excel or Google Sheets use File → Save as / Download → CSV. Commas
            and line breaks inside a cell are fine as long as the cell is quoted,
            which every spreadsheet does automatically.
          </p>
        </div>
      </section>

      {/* ── STEP 3 — BEFORE THE RUN, NOT AFTER ────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">
          3. What if a {entity.noun.one} is already here?
        </h2>
        <p className="text-sm text-muted-foreground">
          {/*
            🔴 THE NATURAL KEY, NAMED, IN THE CUSTOMER'S WORDS. "We match
            on a natural key" means nothing to anybody; "we match on the
            GSTIN, and on the name where there is no GSTIN" is a rule they
            can check against their own file before they run it.
          */}
          {entityKey === "companies"
            ? "Two rows are the same company when they have the same domain — or, where there is no domain, the same name."
            : "Two rows are the same party when they have the same GSTIN and are both customers or both vendors — or, where there is no GSTIN, the same legal name."}{" "}
          This is checked against what is already in your workspace and against the
          rest of this file, so running the same file twice will not double your data.
        </p>
        <div className="space-y-2">
          {DUPLICATE_OPTIONS.map((option) => (
            <label
              key={option.value}
              className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${
                duplicateMode === option.value
                  ? "border-primary bg-primary/5"
                  : "border-border bg-card"
              }`}
            >
              <input
                type="radio"
                name="duplicateMode"
                value={option.value}
                className="mt-1"
                checked={duplicateMode === option.value}
                onChange={() => {
                  setDuplicateMode(option.value);
                  reset();
                }}
              />
              <span>
                <span className="block text-sm font-medium">
                  {option.title}
                  {option.recommended ? (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      recommended
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {option.detail}
                </span>
              </span>
            </label>
          ))}
        </div>
      </section>

      {/* ── STEP 4 ────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">4. Check, then import</h2>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            disabled={!canRun}
            onClick={() => run(preview, "preview")}
          >
            {pending ? "Working…" : "Dry run"}
          </Button>

          {/*
            ⚠️ ABSENT UNTIL A CLEAN PREVIEW EXISTS, not disabled — and it
            disappears again the moment the file, the entity or the
            duplicate choice changes (every one of those calls `reset()`).
            A commit button that survived a change to the file would
            import something other than what was previewed, which is
            constraint 1 defeated by the user interface rather than by the
            server.
          */}
          {previewedCleanly ? (
            <Button
              type="button"
              disabled={pending}
              onClick={() => run(commit, "commit")}
            >
              <Upload className="mr-1.5 h-4 w-4" aria-hidden="true" />
              {pending
                ? "Importing…"
                : `Import ${(report?.counts.create ?? 0) + (report?.counts.update ?? 0)} row${
                    (report?.counts.create ?? 0) + (report?.counts.update ?? 0) === 1
                      ? ""
                      : "s"
                  }`}
            </Button>
          ) : null}
        </div>

        {/*
          🔴 WHAT THE DRY RUN CANNOT PROMISE, SAID PLAINLY.
          The preview runs exactly the same checks the import does — that
          is the design, and it is why the numbers can be trusted. Two
          things are still genuinely unknowable, and claiming otherwise is
          how a dry run stops being believed the first time it is wrong.
        */}
        {previewedCleanly ? (
          <p className="text-xs text-muted-foreground">
            The dry run above used exactly the same checks the import uses — same
            code, same rules — so those numbers are what will happen. Two things it
            cannot see: a rule enforced only inside the database, and anything a
            colleague changes between now and pressing the button. If either bites,
            the affected rows come back in the failed-rows download rather than
            stopping the import.
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {report ? <ImportReportPanel report={report} /> : null}
      </section>
    </div>
  );
}
