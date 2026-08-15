"use client";

/**
 * Ordence — ⭐⭐ The Opening-Balance Wizard
 * Version: v1.58.0-alpha (Batch 58)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS IS NOT THE GENERAL IMPORT WIZARD WITH FOUR MORE RADIO
 *    BUTTONS ON IT
 * ══════════════════════════════════════════════════════════════════════
 * `components/settings/import-wizard.tsx` loads LISTS: contacts,
 * companies, GST parties. Any one of them can be loaded on its own, in
 * any order, on any day, and nothing about one changes what another
 * means.
 *
 * An opening position is not a list. It is four files that describe ONE
 * moment, they have an ORDER, and getting the order wrong produces the
 * classic migration failure: an ageing report that sums to ₹5,02,000
 * beside a balance sheet that says ₹5,00,000, forever, with nobody able
 * to say which is right. That sequence has to be on the screen, which
 * means the screen is different, which is this.
 *
 * ⚠️ AND IT DOES NOT DUPLICATE THE ENGINE. The same two server actions,
 * the same `lib/import` decision layer, the same report panel. What is
 * new here is the ORDER and the WARNINGS — everything that runs is
 * shared, so a dry run on this screen and a dry run on that one cannot
 * disagree.
 *
 * ⚠️ THE DUPLICATE OPTIONS ARE READ FROM THE ENTITY, NOT HARD-CODED.
 * None of the opening entities has an "overwrite" — a posted journal
 * entry is corrected by reversal, and an issued invoice is frozen by a
 * database trigger. Offering a button that the server refuses is worse
 * than not offering it, so the list comes from `entity.duplicateModes`.
 */

import { useMemo, useState, useTransition } from "react";
import { ArrowDownToLine, FileSpreadsheet, Scale, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ImportReportPanel } from "@/components/settings/import-report-panel";
import {
  MAX_IMPORT_ROWS,
  OPENING_IMPORT_ENTITIES,
  OPENING_IMPORT_ENTITY_KEYS,
  buildTemplateCsv,
  type DuplicateMode,
  type ImportReport,
  type OpeningImportEntityKey,
} from "@/lib/import";
import type { ActionResult } from "@/lib/validators/crm";

type Action = (input: {
  entity: string;
  csvText: string;
  duplicateMode: DuplicateMode;
}) => Promise<ActionResult<ImportReport>>;

/**
 * ⚠️ THE CONSEQUENCE IS IN THE LABEL, NOT IN A TOOLTIP. Same reasoning as
 * the general wizard: "skip / fail" describes a mechanism and says
 * nothing about what happens to the customer's books.
 */
const DUPLICATE_OPTIONS: Record<
  Exclude<DuplicateMode, "update">,
  { title: string; detail: string }
> = {
  skip: {
    title: "Leave what is already here alone",
    detail:
      "Anything already imported is counted as skipped and nothing changes. This " +
      "is what makes re-uploading the whole file after fixing two rows harmless — " +
      "it cannot double your books.",
  },
  fail: {
    title: "Tell me if any of it is already here",
    detail:
      "Nothing is written for a row that already exists, and it appears in the " +
      "failed-rows download. Choose this when this file is supposed to be the " +
      "first and only time these figures go in.",
  },
};

/**
 * ⭐ THE SEQUENCE, STATED BEFORE ANYTHING IS UPLOADED.
 *
 * 🔴 THE THIRD PARAGRAPH IS THE ONE THAT MATTERS. Debtors appear twice in
 * a migration pack — once as a control total in the trial balance and
 * once as the sum of the unpaid invoices — and if both posted to the
 * ledger the workspace would open with twice the debtors and a balance
 * sheet that still balanced. Exactly one of them posts, and it is the
 * trial balance. Saying so here is what stops somebody "helpfully"
 * leaving debtors out of it.
 */
const SEQUENCE: Array<{ step: string; detail: string }> = [
  {
    step: "Your companies and vendors first",
    detail:
      "An unpaid invoice has to name a customer and an unpaid bill has to name a " +
      "vendor. Neither is created here — use Settings → Import for those, then " +
      "come back.",
  },
  {
    step: "Then your chart of accounts",
    detail:
      "Opening balances post against accounts that already exist. An account " +
      "carries a type that decides which side of the balance sheet it appears on, " +
      "and that cannot be guessed from a trial balance line.",
  },
  {
    step: "Then the trial balance — including debtors and creditors",
    detail:
      "This is the only file that posts to your ledger, and it is where your " +
      "Sundry Debtors and Sundry Creditors totals belong. The invoice and bill " +
      "files below add the DETAIL behind those totals; they deliberately post " +
      "nothing, so nothing is counted twice.",
  },
  {
    step: "Then the detail: invoices, bills, stock",
    detail:
      "Each carries its own date, which is its age. Compare the totals the dry run " +
      "reports against the control accounts in your trial balance — a difference " +
      "means one of the two is wrong, and today is the only day anybody can still " +
      "find it.",
  },
];

export function OpeningBalanceWizard({
  preview,
  commit,
}: {
  preview: Action;
  commit: Action;
}) {
  const [entityKey, setEntityKey] = useState<OpeningImportEntityKey>(
    "opening-trial-balance",
  );
  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [duplicateMode, setDuplicateMode] = useState<DuplicateMode | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const entity = OPENING_IMPORT_ENTITIES[entityKey];

  /*
   * ⭐ BUILT IN THE BROWSER FROM THE SAME COLUMN LIST THE SERVER MAPS
   * AGAINST. A checked-in template file is a copy of the column list that
   * goes stale the first time a column is added — and a stale template is
   * worse than none, because the customer trusts it. Possible only
   * because `lib/import/` is pure.
   */
  const template = useMemo(() => buildTemplateCsv(entity.columns), [entity]);

  const modes = (entity.duplicateModes ?? ["skip", "fail"]).filter(
    (m): m is Exclude<DuplicateMode, "update"> => m !== "update",
  );

  function reset() {
    setReport(null);
    setError(null);
  }

  async function readFile(file: File) {
    reset();
    setFileName(file.name);
    setCsvText(await file.text());
  }

  function run(action: Action, mode: "preview" | "commit") {
    if (!duplicateMode) {
      setError("Choose what should happen to figures that are already here.");
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
  const willWrite = (report?.counts.create ?? 0) + (report?.counts.update ?? 0);

  return (
    <div className="space-y-8">
      {/* ── THE ORDER, BEFORE ANYTHING ELSE ───────────────────────── */}
      <section className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-100">
          <Scale className="h-4 w-4" aria-hidden="true" />
          The order matters, and this is it
        </h2>
        <ol className="mt-3 space-y-2.5 text-sm text-amber-900/90 dark:text-amber-100/90">
          {SEQUENCE.map((item, index) => (
            <li key={item.step} className="flex gap-2">
              <span className="font-semibold tabular-nums">{index + 1}.</span>
              <span>
                <strong className="font-medium">{item.step}.</strong> {item.detail}
              </span>
            </li>
          ))}
        </ol>
      </section>

      {/* ── STEP 1 ────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">1. Which part of the opening position?</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {OPENING_IMPORT_ENTITY_KEYS.map((key) => {
            const def = OPENING_IMPORT_ENTITIES[key];
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
                    name="openingEntity"
                    value={key}
                    checked={active}
                    className="mt-1"
                    onChange={() => {
                      setEntityKey(key);
                      setDuplicateMode(null);
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

        {/*
          🔴 THE ALL-OR-NOTHING WARNING, ON THE ONE ENTITY IT APPLIES TO.
          Every other import in this product is partial-success, which the
          general import screen says out loud — so a customer arriving
          here already believes the failures will simply come back as a
          file. For the trial balance that is not true, and finding out
          afterwards is finding out that a run they thought was 38 of 40
          was 0 of 40.
        */}
        {entity.atomic ? (
          <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <strong className="font-medium">
              This file goes in whole or not at all.
            </strong>{" "}
            A trial balance is one journal entry. If two lines cannot be read,
            nothing is imported — importing the other thirty-eight would leave a
            ledger that does not balance. And{" "}
            <strong className="font-medium">
              a trial balance whose debits and credits differ is refused
            </strong>
            : no suspense account is created for you. A difference means one of your
            balances is wrong, and the moment it appears is the only moment anybody
            can still find it. If your old system&rsquo;s own trial balance genuinely
            did not tie, add a line for a suspense account you have created and named
            yourself — it will then be on your balance sheet, which is where a
            difference belongs.
          </p>
        ) : null}

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
          <p className="border-t p-3 text-xs text-muted-foreground">
            Capitals, spaces and underscores in your headings do not matter, and
            common alternatives are recognised. Amounts are rupees — no symbol
            needed, and a comma in 1,25,000 is fine. Dates are YYYY-MM-DD:
            day-first and month-first dates are refused rather than guessed,
            because 01/02/2026 is two different days. Up to {MAX_IMPORT_ROWS} rows
            per file.
          </p>
        </div>
      </section>

      {/* ── STEP 2 ────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">2. The file</h2>
        <div className="rounded-lg border bg-card p-4">
          <Label htmlFor="opening-file" className="text-sm">
            Choose a CSV
          </Label>
          <input
            id="opening-file"
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
            <Label htmlFor="opening-text" className="text-sm">
              Or paste the rows
            </Label>
            <Textarea
              id="opening-text"
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
        </div>
      </section>

      {/* ── STEP 3 — BEFORE THE RUN, NOT AFTER ────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">
          3. What if some of this is already here?
        </h2>
        {/*
          🔴 THE KEY, NAMED, IN THE CUSTOMER'S WORDS AND TAKEN FROM THE
          ENTITY. "We match on a natural key" means nothing to anybody.
          Reading it from `entity.duplicateRule` rather than from a
          ternary in this file is what stops the fifth entity being
          described to the customer as the second one.
        */}
        <p className="text-sm text-muted-foreground">{entity.duplicateRule}</p>
        <div className="space-y-2">
          {modes.map((mode) => {
            const option = DUPLICATE_OPTIONS[mode];
            return (
              <label
                key={mode}
                className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${
                  duplicateMode === mode
                    ? "border-primary bg-primary/5"
                    : "border-border bg-card"
                }`}
              >
                <input
                  type="radio"
                  name="openingDuplicateMode"
                  value={mode}
                  className="mt-1"
                  checked={duplicateMode === mode}
                  onChange={() => {
                    setDuplicateMode(mode);
                    reset();
                  }}
                />
                <span>
                  <span className="block text-sm font-medium">
                    {option.title}
                    {mode === "skip" ? (
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
            );
          })}
        </div>
        {/*
          ⚠️ WHY THERE IS NO "OVERWRITE", SAID RATHER THAN LEFT AS AN
          ABSENCE. A missing option reads as a missing feature; the reason
          it is missing is the interesting part.
        */}
        <p className="text-xs text-muted-foreground">
          There is no &ldquo;overwrite what is already there&rdquo; here, and that is
          deliberate. A posted journal entry is corrected by reversing it and posting
          a new one, which leaves a trail somebody can follow; an issued invoice is
          frozen. Rewriting either from a spreadsheet is not an operation your books
          can perform.
        </p>
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
            duplicate choice changes. A commit button that survived a
            change to the file would import something other than what was
            previewed.
          */}
          {previewedCleanly && willWrite > 0 ? (
            <Button
              type="button"
              disabled={pending}
              onClick={() => run(commit, "commit")}
            >
              <Upload className="mr-1.5 h-4 w-4" aria-hidden="true" />
              {pending ? "Importing…" : `Import ${willWrite} row${willWrite === 1 ? "" : "s"}`}
            </Button>
          ) : null}
        </div>

        {previewedCleanly ? (
          <p className="text-xs text-muted-foreground">
            The dry run used exactly the same code the import uses — the same
            validation, the same account and customer lookups, the same
            already-imported check — so those numbers are what will happen. Two
            things it cannot see: a rule enforced only inside the database, and
            anything a colleague changes between now and pressing the button. If
            either bites, the affected rows come back in the failed-rows download.
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
