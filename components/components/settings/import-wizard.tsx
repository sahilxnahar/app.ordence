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
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ WAVE 6 — THE SAME FOUR STEPS, FOR A MIGRATION
 * ══════════════════════════════════════════════════════════════════════
 * Three things changed and the shape did not:
 *
 * ① ANY FILE, NOT A CSV. `lib/import/sources/` reads Excel, JSON and
 *    Tally XML IN THE BROWSER — every reader in it is pure — into
 *    exactly the record stream `parseCsv` produces. The format is
 *    detected from the BYTES, never the file name, because a file name
 *    is a claim by whoever renamed it.
 *
 * ② THE COLUMNS ARE PROPOSED, WITH A REASON AND A CONFIDENCE. A file of
 *    `F1 F2 F3` used to be unimportable; `lib/import/shapes.ts` matches
 *    on what the values ARE. Every proposal says why, because a mapping
 *    somebody clicked past is not a mapping somebody decided.
 *
 * ③ 🔴 MORE THAN `MAX_IMPORT_ROWS` NO LONGER MEANS "SPLIT YOUR FILE".
 *    The browser sends it in chunks under one run, and the run refuses
 *    to report itself as finished until every row is accounted for. The
 *    file never leaves the customer's machine.
 */

import { useMemo, useState, useTransition } from "react";
import { ArrowDownToLine, FileSpreadsheet, TriangleAlert, Upload } from "lucide-react";
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
import type { CsvRecord } from "@/lib/import/csv";
import type { MappingProposal } from "@/lib/import/proposal";
import { EVIDENCE_SAMPLE_ROWS } from "@/lib/import/shapes";
/**
 * ⭐ THE READERS RUN HERE, IN THE BROWSER. That is only possible because
 * `lib/import/sources/` imports no database and no `node:` module — the
 * same purity that lets the blank template be built client-side.
 *
 * ⚠️ AND IT IS WHY THE CUSTOMER'S FILE NEVER LEAVES THEIR MACHINE.
 * A migration file is a workspace's entire master data; uploading it to
 * be parsed would put a second copy of it on our side for no reason the
 * customer asked for.
 */
import {
  readSource,
  SourceReadError,
  SOURCE_FORMAT_LABELS,
  type ImportSourceFormat,
} from "@/lib/import/sources";

/**
 * ⚠️ `csvText` OR `records`, NEVER BOTH — the server schema refuses both.
 * Pasted text goes as text; a chosen file goes as records, because it has
 * already been read correctly and putting it back through CSV would
 * reintroduce every quoting ambiguity between the file and the importer.
 */
type Action = (input: {
  entity: string;
  csvText?: string;
  records?: CsvRecord[];
  sourceFormat?: ImportSourceFormat;
  sourceName?: string;
  sourceSheet?: string;
  run?: { id: string; chunkIndex: number };
  duplicateMode: DuplicateMode;
}) => Promise<ActionResult<ImportReport>>;

type BeginRun = (input: {
  entity: string;
  sourceFormat: ImportSourceFormat;
  sourceName?: string;
  sourceSheet?: string;
  duplicateMode: DuplicateMode;
  expectedRows: number;
}) => Promise<ActionResult<{ runId: string; chunkSize: number }>>;

type EndRun = (input: {
  runId: string;
  abandoned?: boolean;
}) => Promise<ActionResult<{
  status: "completed" | "incomplete";
  message: string;
  unaccounted: number;
}>>;

type Propose = (input: {
  entity: string;
  headers: string[];
  sampleRows: string[][];
  useAi: boolean;
}) => Promise<ActionResult<{
  proposal: MappingProposal;
  autoCommit: { allowed: boolean; reason: string };
  policy: string;
  aiRefusal?: string;
}>>;

type Decide = (input: {
  entity: string;
  proposal: MappingProposal;
  outcome: "confirmed" | "corrected" | "discarded" | "auto";
  corrections: Record<string, { from: string | null; to: string | null }>;
}) => Promise<ActionResult<{ id: string }>>;

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
  beginRun,
  endRun,
  propose,
  decide,
}: {
  preview: Action;
  commit: Action;
  beginRun: BeginRun;
  endRun: EndRun;
  propose: Propose;
  decide: Decide;
}) {
  const [entityKey, setEntityKey] = useState<ImportEntityKey>("companies");
  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [duplicateMode, setDuplicateMode] = useState<DuplicateMode | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  /* ── WAVE 6 ─────────────────────────────────────────────────────── */
  const [records, setRecords] = useState<CsvRecord[] | null>(null);
  const [sourceFormat, setSourceFormat] = useState<ImportSourceFormat | null>(null);
  const [sourceNotes, setSourceNotes] = useState<readonly string[]>([]);
  const [sheetNames, setSheetNames] = useState<readonly string[]>([]);
  const [selectedSheet, setSelectedSheet] = useState<string | null>(null);
  /** ⚠️ Kept so changing the sheet re-reads without asking for the file again. */
  const [fileBytes, setFileBytes] = useState<Uint8Array | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [proposal, setProposal] = useState<MappingProposal | null>(null);
  const [autoCommit, setAutoCommit] = useState<{ allowed: boolean; reason: string } | null>(null);
  const [aiRefusal, setAiRefusal] = useState<string | null>(null);
  const [useAi, setUseAi] = useState(false);
  /** field → the file column the person chose, when they changed one. */
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [mappingSettled, setMappingSettled] = useState(false);

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
    setProgress(null);
  }

  /** ⚠️ Clears the FILE as well. Used when the source itself changes. */
  function resetSource() {
    reset();
    setRecords(null);
    setSourceFormat(null);
    setSourceNotes([]);
    setSheetNames([]);
    setSelectedSheet(null);
    setFileBytes(null);
    resetMapping();
  }

  function resetMapping() {
    setProposal(null);
    setAutoCommit(null);
    setAiRefusal(null);
    setOverrides({});
    setMappingSettled(false);
  }

  /**
   * ⭐⭐⭐ ASK WHAT THE COLUMNS MEAN.
   *
   * ⚠️ HEADERS AND A SAMPLE OF VALUES, AND THE VALUES DO NOT GO ANYWHERE
   * EXCEPT OUR OWN SERVER. `lib/import/shapes.ts` reads them there to
   * decide what each column IS; `server/import/ai-mapper.ts` sends only
   * headings and statistical descriptions onward when the model is used,
   * and refuses to send the call at all if a value ever reaches the
   * prompt.
   */
  function askForMapping(withAi: boolean) {
    if (!records || records.length < 2) return;
    const headers = records[0]!;
    const sample = records.slice(1, EVIDENCE_SAMPLE_ROWS + 1).map((r) => [...r.cells]);
    setAiRefusal(null);
    start(async () => {
      const result = await propose({
        entity: entityKey,
        headers: [...headers.cells],
        sampleRows: sample,
        useAi: withAi,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setProposal(result.data.proposal);
      setAutoCommit(result.data.autoCommit);
      setAiRefusal(result.data.aiRefusal ?? null);
      setOverrides({});
      setMappingSettled(false);
    });
  }

  /**
   * ⭐⭐⭐ APPLY THE MAPPING BY REWRITING THE HEADER ROW.
   *
   * 🔴 THIS IS NOT A SHORTCUT — IT IS WHY THE CORRECTION STICKS.
   * `planImportRecords` decides what each column is by matching the
   * header row against the entity's canonical headers. A mapping held
   * beside the records, as a separate structure, would have to be threaded
   * through the planner, the preview, the commit and the failed-rows CSV,
   * and any one of those forgetting it is a silent mis-import.
   *
   * Rewriting the header row means the planner matches EXACTLY, by the
   * same code path an already-correct file takes. There is no second
   * mapping mechanism to keep in step.
   *
   * ⚠️ A COLUMN NOBODY MAPPED KEEPS ITS ORIGINAL HEADING rather than being
   * blanked, so it still appears in the report as an unrecognised column —
   * which is how the customer finds out something was left behind.
   */
  function applyMapping(outcome: "confirmed" | "corrected") {
    if (!records || !proposal) return;
    const originalHeaders = records[0]!.cells;
    const rewritten = [...originalHeaders];

    const corrections: Record<string, { from: string | null; to: string | null }> = {};

    for (const column of proposal.columns) {
      const chosen = overrides[column.field] ?? column.sourceHeader ?? "";
      if (chosen !== (column.sourceHeader ?? "")) {
        corrections[column.field] = {
          from: column.sourceHeader,
          to: chosen === "" ? null : chosen,
        };
      }
      if (chosen === "") continue;
      const index = originalHeaders.indexOf(chosen);
      if (index >= 0) rewritten[index] = column.header;
    }

    setRecords([{ ...records[0]!, cells: rewritten }, ...records.slice(1)]);
    setMappingSettled(true);
    reset();

    const settled = Object.keys(corrections).length > 0 ? "corrected" : outcome;
    void decide({
      entity: entityKey,
      proposal,
      outcome: settled,
      corrections,
    });
  }

  /**
   * ⭐⭐⭐ READ ANY FILE, IN THE BROWSER.
   *
   * ⚠️ `arrayBuffer()` AND NOT `text()`. A spreadsheet is a zip; decoding
   * it as UTF-8 first destroys it. The bytes are also what
   * `detectFormat` needs — the format comes from the BYTES, never from
   * the file name, because a `.csv` that is really an `.xlsx` and an
   * `.xlsx` that is really an old `.xls` are both routine.
   *
   * ⚠️ THE BOM IS LEFT ALONE. `lib/import/csv.ts` strips it, in one
   * place, so no reader of a CSV in this codebase has to remember.
   */
  async function readFile(file: File) {
    resetSource();
    setFileName(file.name);
    const bytes = new Uint8Array(await file.arrayBuffer());
    setFileBytes(bytes);
    parseBytes(bytes, file.name, null);
  }

  function parseBytes(bytes: Uint8Array, name: string, sheet: string | null) {
    try {
      const table = readSource(bytes, {
        fileName: name,
        ...(sheet ? { sheet } : {}),
        /**
         * ⚠️ NO `inflateRaw` PASSED, AND A SPREADSHEET STILL OPENS.
         * `lib/import/sources/unzip.ts` falls back to
         * `lib/import/sources/inflate.ts` — two hundred lines of RFC 1951,
         * pure and synchronous — precisely so this runs in a browser,
         * where `node:zlib` does not exist and `DecompressionStream` is
         * asynchronous.
         */
      });
      setRecords([...table.records]);
      setSourceFormat(table.format);
      setSourceNotes(table.notes);
      setSheetNames(table.sheetNames ?? []);
      setSelectedSheet(table.selectedSheet ?? null);
      /** ⚠️ Text and records are mutually exclusive. See the Action type. */
      setCsvText("");
      setError(null);
    } catch (err) {
      setRecords(null);
      setSourceFormat(null);
      setError(
        err instanceof SourceReadError
          ? err.message
          : "That file could not be read. If it came out of another system, try exporting it as CSV.",
      );
    }
  }

  /**
   * ⭐ EITHER THE TEXT OR THE RECORDS, NEVER BOTH. The server schema
   * refuses both, so this is the one place that decides which.
   */
  function payload(): { csvText?: string } | { records: CsvRecord[] } {
    return records ? { records } : { csvText };
  }

  const dataRowCount = records ? Math.max(0, records.length - 1) : null;
  /** ⭐ More than one part means a migration rather than an upload. */
  const needsChunking = dataRowCount !== null && dataRowCount > MAX_IMPORT_ROWS;

  function run(action: Action, mode: "preview" | "commit") {
    if (!duplicateMode) {
      setError("Choose what should happen to records that already exist.");
      return;
    }
    setError(null);
    start(async () => {
      /**
       * ⚠️ THE DRY RUN ONLY EVER LOOKS AT THE FIRST PART. Planning
       * forty-thousand rows in one request is the thing chunking exists
       * to avoid, and a preview that times out is a preview nobody runs.
       * The sentence under the button says so — a preview silently
       * covering a fraction of the file would be worse than no preview.
       */
      const first =
        records && needsChunking ? [records[0]!, ...records.slice(1, MAX_IMPORT_ROWS + 1)] : null;

      const result = await action({
        entity: entityKey,
        duplicateMode,
        ...(first ? { records: first } : payload()),
        ...(sourceFormat ? { sourceFormat } : {}),
        ...(fileName ? { sourceName: fileName } : {}),
        ...(selectedSheet ? { sourceSheet: selectedSheet } : {}),
      });
      if (!result.ok) {
        setError(result.error);
        setReport(null);
        return;
      }
      setReport(result.data);
    });
  }

  /**
   * ⭐⭐⭐ THE MIGRATION. One run, many chunks, and a finish that refuses
   * to call itself complete when rows are missing.
   *
   * 🔴 IT STOPS AT THE FIRST FAILED CHUNK RATHER THAN CARRYING ON. A loop
   * that swallowed a failure and continued would produce a run that ended
   * "successfully" with a hole in the middle, and the hole would be
   * invisible until somebody counted. Stopping leaves the run marked
   * incomplete with the number of missing rows in the message, and
   * re-uploading the same file is safe — every entity matches on a
   * natural key, so the rows already here are recognised rather than
   * duplicated.
   */
  function runMigration() {
    if (!duplicateMode || !records || !sourceFormat) return;
    const header = records[0]!;
    const dataRows = records.slice(1);
    setError(null);

    start(async () => {
      const begun = await beginRun({
        entity: entityKey,
        sourceFormat,
        ...(fileName ? { sourceName: fileName } : {}),
        ...(selectedSheet ? { sourceSheet: selectedSheet } : {}),
        duplicateMode,
        expectedRows: dataRows.length,
      });
      if (!begun.ok) {
        setError(begun.error);
        return;
      }

      const { runId, chunkSize } = begun.data;
      const chunkCount = Math.ceil(dataRows.length / chunkSize);
      let lastReport: ImportReport | null = null;
      let stopped: string | null = null;

      for (let index = 0; index < chunkCount; index += 1) {
        setProgress(
          `Part ${index + 1} of ${chunkCount} — ${Math.min(
            (index + 1) * chunkSize,
            dataRows.length,
          ).toLocaleString("en-IN")} of ${dataRows.length.toLocaleString("en-IN")} rows`,
        );

        const slice = dataRows.slice(index * chunkSize, (index + 1) * chunkSize);
        const result = await commit({
          entity: entityKey,
          duplicateMode,
          records: [header, ...slice],
          sourceFormat,
          ...(fileName ? { sourceName: fileName } : {}),
          ...(selectedSheet ? { sourceSheet: selectedSheet } : {}),
          run: { id: runId, chunkIndex: index },
        });

        if (!result.ok) {
          stopped = result.error;
          break;
        }
        lastReport = result.data;
      }

      const ended = await endRun({ runId, ...(stopped ? { abandoned: false } : {}) });
      setProgress(null);
      if (lastReport) setReport(lastReport);

      if (stopped) {
        setError(
          `${stopped}${ended.ok ? ` ${ended.data.message}` : ""}`,
        );
        return;
      }
      if (ended.ok) {
        /**
         * ⚠️ THE FINISHING SENTENCE IS SHOWN AS AN ERROR WHEN ROWS ARE
         * MISSING. Not as a neutral note: "your migration is missing
         * 1,600 rows" is not information, it is a problem, and a customer
         * who reads it as a status line will not act on it.
         */
        if (ended.data.status === "completed") setProgress(ended.data.message);
        else setError(ended.data.message);
      }
    });
  }

  const hasSource = records !== null || csvText.trim() !== "";
  const canRun = hasSource && duplicateMode !== null && !pending;
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
            Choose a file
          </Label>
          <input
            id="import-file"
            type="file"
            /*
              ⚠️ THE `accept` LIST IS A HINT TO THE FILE PICKER AND NOTHING
              MORE. The format is decided from the BYTES — see
              `detectFormat` — because a `.csv` that is really an `.xlsx`,
              and an `.xlsx` that is really an old `.xls`, are both
              routine and both produce a bewildering report when the name
              is trusted.
            */
            accept=".csv,.txt,.xlsx,.json,.jsonl,.ndjson,.xml,text/csv,application/json"
            className="mt-2 block w-full text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void readFile(file);
            }}
          />
          {fileName && sourceFormat ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Loaded {fileName} as {SOURCE_FORMAT_LABELS[sourceFormat]}
              {dataRowCount !== null
                ? ` — ${dataRowCount.toLocaleString("en-IN")} row${dataRowCount === 1 ? "" : "s"}`
                : ""}
              .
            </p>
          ) : fileName ? (
            <p className="mt-2 text-xs text-muted-foreground">Loaded {fileName}.</p>
          ) : null}

          {/*
            ⚠️ THE SHEET PICKER EXISTS BECAUSE THE WRONG TAB IS A REAL
            FAILURE. A workbook with "Customers", "Vendors" and "Items"
            imported as whichever tab happened to be first is how somebody's
            vendor list becomes their customer list, and every row of it
            validates.
          */}
          {sheetNames.length > 1 ? (
            <div className="mt-3">
              <Label htmlFor="import-sheet" className="text-sm">
                Which sheet?
              </Label>
              <select
                id="import-sheet"
                className="mt-2 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={selectedSheet ?? ""}
                onChange={(e) => {
                  if (!fileBytes || !fileName) return;
                  reset();
                  parseBytes(fileBytes, fileName, e.target.value);
                }}
              >
                {sheetNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {/*
            🔴 WHAT THE READER HAD TO DECIDE, SAID BEFORE THE IMPORT RUNS.
            "Some cells hold twelve or more digits and were stored as
            numbers" is exactly the sentence a person needs while they can
            still go back to the source file — and useless afterwards.
          */}
          {sourceNotes.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {sourceNotes.map((note) => (
                <li
                  key={note}
                  className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs"
                >
                  <TriangleAlert
                    className="mt-px h-3.5 w-3.5 shrink-0 text-amber-600"
                    aria-hidden="true"
                  />
                  <span>{note}</span>
                </li>
              ))}
            </ul>
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
                /**
                 * ⚠️ PASTING CLEARS THE FILE. The two are mutually
                 * exclusive on the wire, and leaving a loaded spreadsheet
                 * in state while the person types would import the
                 * spreadsheet and show them the text.
                 */
                resetSource();
                setCsvText(e.target.value);
                setFileName(null);
              }}
            />
          </div>
          {/*
            ⚠️ EXPORTING AS CSV IS THE STEP CUSTOMERS GET WRONG, and the
            failure is silent: an .xlsx renamed to .csv parses as binary
            noise and produces a bewildering report.
          */}
          {/*
            ⚠️ THIS PARAGRAPH USED TO TELL PEOPLE TO SAVE AS CSV, and that
            advice was the cause of the failure it warned about: an .xlsx
            renamed rather than re-saved. Since wave 6 the spreadsheet is
            read directly, which also keeps the cell TYPES — so an invoice
            number of `0012345` survives, where the same file saved as CSV
            would have lost the leading zeroes before it ever reached us.
          */}
          <p className="mt-2 text-xs text-muted-foreground">
            Excel workbooks (.xlsx), CSV, JSON and a Tally day-book export are all
            read directly — you do not need to convert anything first. An Excel file
            is better than a CSV of the same data: it keeps invoice numbers, GSTINs
            and dates as what they are, where a CSV turns them into whatever the
            spreadsheet decided.
          </p>
        </div>
      </section>

      {/* ── STEP 2b — WHAT DO YOUR COLUMNS MEAN? ──────────────────── */}
      {records && records.length > 1 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">
            2b. What do your columns mean?
          </h2>
          <p className="text-sm text-muted-foreground">
            {/*
              ⭐ THE SENTENCE THAT MAKES THIS STEP WORTH HAVING. A file
              whose headings are `F1 F2 F3` used to be unimportable; the
              columns are now matched on what their VALUES are as well as
              on what they are called.
            */}
            Ordence matches your columns on their headings and on what the values in
            them actually look like — so a column of GSTINs is recognised whatever it
            is called. Check what it decided before you import; every match says why.
          </p>

          {!proposal ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" disabled={pending} onClick={() => askForMapping(false)}>
                {pending ? "Checking…" : "Check my columns"}
              </Button>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={useAi}
                  onChange={(e) => setUseAi(e.target.checked)}
                />
                {/*
                  🔴 THE SENTENCE IS THE CONSENT. A checkbox saying "use
                  AI" tells the customer nothing about what leaves their
                  machine, and a migration is the moment they have the most
                  data and the least idea what the product does with it.
                */}
                Also ask the AI mapper for headings in another language or an unusual
                abbreviation. Only your column HEADINGS and a description of each column
                (&ldquo;15 characters, 92% look like a GSTIN&rdquo;) are sent — never any
                of your data.
              </label>
              {useAi ? (
                <Button type="button" variant="outline" disabled={pending} onClick={() => askForMapping(true)}>
                  {pending ? "Asking…" : "Check with AI"}
                </Button>
              ) : null}
            </div>
          ) : null}

          {aiRefusal ? (
            <p className="flex gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
              <TriangleAlert className="mt-px h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{aiRefusal}</span>
            </p>
          ) : null}

          {proposal ? (
            <div className="space-y-3">
              <div className="overflow-x-auto rounded-lg border bg-card">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th scope="col" className="p-3 font-medium">Ordence field</th>
                      <th scope="col" className="p-3 font-medium">Your column</th>
                      <th scope="col" className="p-3 font-medium">Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {proposal.columns.map((column) => {
                      const chosen = overrides[column.field] ?? column.sourceHeader ?? "";
                      return (
                        <tr key={column.field} className="border-b align-top last:border-0">
                          <td className="p-3">
                            <span className="font-medium">{column.header}</span>
                            {column.required ? (
                              <span className="ml-2 text-xs text-muted-foreground">required</span>
                            ) : null}
                          </td>
                          <td className="p-3">
                            <select
                              aria-label={`Which of your columns is ${column.header}`}
                              className="h-9 w-full min-w-40 rounded-md border border-input bg-background px-2 text-sm"
                              value={chosen}
                              onChange={(e) => {
                                setOverrides((current) => ({
                                  ...current,
                                  [column.field]: e.target.value,
                                }));
                                setMappingSettled(false);
                              }}
                            >
                              <option value="">— not in my file —</option>
                              {proposal.sourceHeaders.map((header) => (
                                <option key={header} value={header}>
                                  {header}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="p-3 text-xs text-muted-foreground">
                            {/*
                              ⚠️ THE REASON, NOT A PERCENTAGE ON ITS OWN.
                              "72%" is not something a person can check.
                              "matched on its contents — 92% of its values
                              look like a GSTIN" is.
                            */}
                            {column.why}
                            {column.conflict ? (
                              <span className="mt-1 block text-amber-700">{column.conflict}</span>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {proposal.cautions.map((caution) => (
                <p
                  key={caution}
                  className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs"
                >
                  <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden="true" />
                  <span>{caution}</span>
                </p>
              ))}

              {/*
                ⚠️ WHY THIS FILE WILL NOT GO THROUGH ON ITS OWN, SAID EVEN
                WHEN THE WORKSPACE HAS NOT TURNED AUTOMATIC IMPORT ON. The
                reason is different in each case and "not available" would
                tell the customer nothing about which of four things to
                change.
              */}
              {autoCommit && !autoCommit.allowed ? (
                <p className="text-xs text-muted-foreground">{autoCommit.reason}</p>
              ) : null}

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    applyMapping(
                      Object.keys(overrides).length > 0 ? "corrected" : "confirmed",
                    )
                  }
                >
                  Use this mapping
                </Button>
                {mappingSettled ? (
                  <span className="text-xs text-muted-foreground">
                    Applied. The dry run below now uses it.
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

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
          {previewedCleanly && !needsChunking ? (
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

          {/*
            ⭐⭐⭐ THE MIGRATION BUTTON. Same rule as the ordinary commit —
            absent until a clean dry run exists, not disabled.
          */}
          {previewedCleanly && needsChunking && dataRowCount !== null ? (
            <Button type="button" disabled={pending} onClick={runMigration}>
              <Upload className="mr-1.5 h-4 w-4" aria-hidden="true" />
              {pending
                ? "Migrating…"
                : `Import all ${dataRowCount.toLocaleString("en-IN")} rows`}
            </Button>
          ) : null}
        </div>

        {/*
          🔴 WHAT THE DRY RUN COVERED, WHEN THE FILE IS BIGGER THAN ONE
          PART. A preview that silently examined the first thousand rows
          of forty thousand and said nothing would be worse than no
          preview — the customer would read its numbers as the whole file.
        */}
        {needsChunking && dataRowCount !== null ? (
          <p className="flex gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            <TriangleAlert className="mt-px h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              This file has {dataRowCount.toLocaleString("en-IN")} rows, so it is imported
              in {Math.ceil(dataRowCount / MAX_IMPORT_ROWS)} parts of up to{" "}
              {MAX_IMPORT_ROWS.toLocaleString("en-IN")}. The dry run above covered the{" "}
              <strong>first part only</strong> — it is a check on your columns and your
              file&apos;s shape, not a count of the whole thing. Ordence keeps track of
              the parts, and will tell you plainly if any of them did not arrive. If the
              connection drops you can upload the same file again: rows already here are
              recognised rather than duplicated.
            </span>
          </p>
        ) : null}

        {progress ? (
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {progress}
          </p>
        ) : null}

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
