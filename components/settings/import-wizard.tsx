"use client";

/**
 * Ordence — The Import Wizard
 * Version: v1.89.0-alpha · Wave 2A
 *
 * ══════════════════════════════════════════════════════════════════════
 * FOUR STEPS, AND THE ORDER OF STEPS 3 AND 4 IS THE SAFETY PROPERTY
 * ══════════════════════════════════════════════════════════════════════
 *   1. What are you importing?          (and where it sits in the order)
 *   2. The file, and what your columns mean.
 *   3. 🔴 What happens to records that already exist? — BEFORE the run.
 *   4. Dry run, then commit.
 *
 * ⚠️ STEP 3 COMES BEFORE THE DRY RUN AND HAS NO PRESELECTED ANSWER.
 * The natural place to ask is after the preview, when the wizard can say
 * "we found 340 matches — update them?". It is also the place where the
 * answer stops being a decision: by then the customer has chosen a file,
 * waited for an upload, read a report and is committed to finishing.
 * "Yes" is the path to being done, and "yes" here means overwriting 340
 * records they may not have looked at.
 *
 * ⚠️ THE COMMIT BUTTON DOES NOT EXIST UNTIL A PREVIEW HAS RUN. Not
 * disabled — absent. A disabled control invites "how do I enable this",
 * and the answer we want is "look at the dry run first".
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ WAVE 2A — WHAT CHANGED, AND WHY EACH OF IT IS A DEFECT REPAIRED
 * ══════════════════════════════════════════════════════════════════════
 * ① 🔴 EIGHTEEN ENTITIES, NOT TWO. This screen offered `IMPORT_ENTITIES`
 *    — companies and GST parties — while `ALL_IMPORT_ENTITIES` has held
 *    eighteen since Phase 9. Sixteen entities were built, contracted,
 *    given writers, proven against a real PostgreSQL, and reachable by
 *    nobody. The picker is now the load-order screen itself, so choosing
 *    what to import and knowing when to import it are one act.
 *
 * ② 🔴 THE FILE IS FINGERPRINTED. `beginImportRun` has REQUIRED a
 *    `sha256:` fingerprint over the bytes since Phase 2 and this wizard
 *    never sent one, so every migration failed at the first call. See
 *    `components/import/fingerprint.ts` for what the fingerprint is over
 *    and why that matters.
 *
 * ③ ⭐ `resumed` AND `note` ARE RENDERED. "Starting" and "picking up
 *    where the last attempt stopped" are different sentences, and a
 *    customer shown the first when the second is true will wonder why the
 *    progress bar begins at 60%.
 *
 * ④ ⚠️ THE DUPLICATE STEP READS THE ENTITY. It used to carry
 *    `entityKey === "companies" ? "…domain…" : "…GSTIN…"` — the exact
 *    ternary `ImportEntityDefinition.duplicateRule` was added to delete —
 *    so every entity after the second was described to the customer as a
 *    GST party. It now reads `duplicateRule`, `duplicateModes` and
 *    `contract.duplicateDecision`, so an entity that cannot be overwritten
 *    does not offer overwriting.
 *
 * ⑤ ⭐ THE TALLY VIEW PICKER. `TALLY_VIEW_LABELS` is documented "one line
 *    each, for a picker" and there has been no picker since v1.74.0-alpha;
 *    Phase 9 added three more views to the same silence. Five views, one
 *    file, and only the first was reachable.
 */

import { useMemo, useState, useTransition } from "react";
import { ArrowDownToLine, FileSpreadsheet, TriangleAlert, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ImportReportPanel } from "@/components/settings/import-report-panel";
import { LoadOrder } from "@/components/import/load-order";
import { MappingReview } from "@/components/import/mapping-review";
import {
  fingerprintBytes,
  FingerprintUnavailableError,
} from "@/components/import/fingerprint";
import { formatCount } from "@/components/import/figures";
import {
  ALL_IMPORT_ENTITIES,
  MAX_IMPORT_ROWS,
  buildTemplateCsv,
  isImportEntityKey,
  type AnyImportEntityKey,
  type DuplicateMode,
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
  TALLY_VIEWS,
  TALLY_VIEW_LABELS,
  isTallyView,
  type ImportSourceFormat,
  type TallyView,
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

/**
 * 🔴 `sourceFingerprint` IS NOT OPTIONAL HERE EITHER. Typing it optional
 * to "keep the change small" is how a required server input goes unsent
 * for two waves — which is exactly what happened.
 */
type BeginRun = (input: {
  entity: string;
  sourceFormat: ImportSourceFormat;
  sourceName?: string;
  sourceSheet?: string;
  duplicateMode: DuplicateMode;
  expectedRows: number;
  sourceFingerprint: string;
}) => Promise<ActionResult<{
  runId: string;
  chunkSize: number;
  resumed: boolean;
  note: string | null;
}>>;

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
 * match is not proof of identity.
 *
 * ⚠️ THERE IS NO `recommended` FLAG IN THIS TABLE ANY MORE. Which mode is
 * recommended is a property of the ENTITY — `contract.duplicateDecision`
 * — and a flag here would be a second answer that disagrees with the
 * contract for sixteen of the eighteen entities.
 */
const DUPLICATE_OPTIONS: Array<{
  value: DuplicateMode;
  title: string;
  detail: string;
}> = [
  {
    value: "skip",
    title: "Leave the existing record alone",
    detail:
      "The row is counted as skipped and nothing about the record you already " +
      "have changes. Safe to run twice — it is what makes re-uploading a whole " +
      "file after fixing a few rows harmless.",
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

const ALL_DUPLICATE_MODES: readonly DuplicateMode[] = ["skip", "update", "fail"];

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
  const [entityKey, setEntityKey] = useState<AnyImportEntityKey>("companies");
  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [duplicateMode, setDuplicateMode] = useState<DuplicateMode | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const [records, setRecords] = useState<CsvRecord[] | null>(null);
  const [sourceFormat, setSourceFormat] = useState<ImportSourceFormat | null>(null);
  const [sourceNotes, setSourceNotes] = useState<readonly string[]>([]);
  const [sheetNames, setSheetNames] = useState<readonly string[]>([]);
  const [selectedSheet, setSelectedSheet] = useState<string | null>(null);
  /** ⭐ WAVE 2A. Which Tally view the XML was read as. Five exist. */
  const [tallyView, setTallyView] = useState<TallyView>("ledger-masters");
  /** ⚠️ Kept so changing the sheet or the view re-reads without asking for the file again. */
  const [fileBytes, setFileBytes] = useState<Uint8Array | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  /** ⭐ WAVE 2A. What `beginImportRun` said when it started or resumed. */
  const [runNote, setRunNote] = useState<string | null>(null);
  const [proposal, setProposal] = useState<MappingProposal | null>(null);
  const [autoCommit, setAutoCommit] = useState<{ allowed: boolean; reason: string } | null>(null);
  const [aiRefusal, setAiRefusal] = useState<string | null>(null);
  const [useAi, setUseAi] = useState(false);
  /** field → the file column the person chose, when they changed one. */
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [mappingSettled, setMappingSettled] = useState(false);

  const entity = ALL_IMPORT_ENTITIES[entityKey];

  /*
   * ⭐ THE TEMPLATE IS BUILT IN THE BROWSER FROM THE SAME COLUMN LIST THE
   * SERVER MAPS AGAINST. Not a static file in `public/`, and not a second
   * server round trip — a checked-in template is a copy of the column
   * list that goes stale the first time a column is added, and a stale
   * template is worse than none because the customer trusts it.
   */
  const template = useMemo(() => buildTemplateCsv(entity.columns), [entity]);

  /**
   * ⚠️ THE MODES ON OFFER ARE THE ENTITY'S, AND THE SERVER AGREES.
   * `server/actions/import.ts` refuses a mode outside `duplicateModes`;
   * offering one here would be a control whose only outcome is an error
   * message — an opening journal entry cannot be overwritten, because
   * `journal_entries` is append-only by design.
   */
  const offeredModes = entity.duplicateModes ?? ALL_DUPLICATE_MODES;
  const recommended = entity.contract.duplicateDecision.recommended;

  function reset() {
    setReport(null);
    setError(null);
    setProgress(null);
    setRunNote(null);
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
   * ⚠️ CHANGING THE ENTITY CLEARS THE MAPPING AND THE REPORT, NOT THE
   * FILE. A person who picked the wrong record type for the right file
   * should not have to choose the file again — but a proposal made
   * against the old entity's columns, and a dry run of it, are answers to
   * a question that is no longer being asked.
   */
  function chooseEntity(key: string) {
    if (!isImportEntityKey(key)) return;
    setEntityKey(key);
    setDuplicateMode(null);
    reset();
    resetMapping();
  }

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
   * beside the records would have to be threaded through the planner, the
   * preview, the commit and the failed-rows CSV, and any one of those
   * forgetting it is a silent mis-import.
   *
   * ⚠️ AND IT DOES NOT CHANGE THE FILE'S FINGERPRINT, WHICH IS CORRECT.
   * The fingerprint is over the bytes the customer uploaded. Correcting a
   * mapping and pressing import again is the SAME upload and must resume
   * the same run, not start a rival one.
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
   * it as UTF-8 first destroys it. The bytes are also what `detectFormat`
   * needs — the format comes from the BYTES, never from the file name —
   * and they are what the fingerprint is taken over.
   */
  async function readFile(file: File) {
    resetSource();
    setFileName(file.name);
    const bytes = new Uint8Array(await file.arrayBuffer());
    setFileBytes(bytes);
    parseBytes(bytes, file.name, null, "ledger-masters");
  }

  function parseBytes(
    bytes: Uint8Array,
    name: string,
    sheet: string | null,
    view: TallyView,
  ) {
    try {
      const table = readSource(bytes, {
        fileName: name,
        ...(sheet ? { sheet } : {}),
        /**
         * ⭐ WAVE 2A — WHICH TALLY VIEW. `readTally` defaults to
         * `ledger-masters`, so a customer whose file is a day book of
         * vouchers saw a list of ledgers and no way to ask for anything
         * else. The default is unchanged; it is now a default rather than
         * the only reachable answer.
         */
        tallyView: view,
      });
      setRecords([...table.records]);
      setSourceFormat(table.format);
      setSourceNotes(table.notes);
      setSheetNames(table.sheetNames ?? []);
      setSelectedSheet(table.selectedSheet ?? null);
      setTallyView(view);
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
  const sampleRows = useMemo(
    () => (records ? records.slice(1, EVIDENCE_SAMPLE_ROWS + 1).map((r) => r.cells) : []),
    [records],
  );

  function run(action: Action, _mode: "preview" | "commit") {
    if (!duplicateMode) {
      setError("Choose what should happen to records that already exist.");
      return;
    }
    setError(null);
    start(async () => {
      /**
       * ⚠️ THE DRY RUN ONLY EVER LOOKS AT THE FIRST PART. Planning forty
       * thousand rows in one request is the thing chunking exists to
       * avoid, and a preview that times out is a preview nobody runs. The
       * sentence under the button says so.
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
   * 🔴 IT STOPS AT THE FIRST FAILED CHUNK rather than carrying on. A loop
   * that swallowed a failure and continued would produce a run that ended
   * "successfully" with a hole in the middle, invisible until somebody
   * counted.
   */
  function runMigration() {
    if (!duplicateMode || !records || !sourceFormat) return;
    /**
     * 🔴 NO BYTES, NO RUN — AND IT IS A REFUSAL WITH A SENTENCE, NOT A
     * SILENT RETURN. The only way to reach this with records and no bytes
     * is a future edit that lets pasted text be migrated, and the failure
     * it would otherwise produce is `beginImportRun` rejecting a
     * fingerprint that is `undefined`.
     */
    if (!fileBytes) {
      setError(
        "A migration this size is tracked against the file it came from, so it has to be " +
          "uploaded as a file rather than pasted in.",
      );
      return;
    }
    const header = records[0]!;
    const dataRows = records.slice(1);
    setError(null);

    start(async () => {
      let sourceFingerprint: string;
      try {
        sourceFingerprint = await fingerprintBytes(fileBytes);
      } catch (err) {
        setError(
          err instanceof FingerprintUnavailableError
            ? err.message
            : "This file could not be fingerprinted, so nothing was started.",
        );
        return;
      }

      const begun = await beginRun({
        entity: entityKey,
        sourceFormat,
        ...(fileName ? { sourceName: fileName } : {}),
        ...(selectedSheet ? { sourceSheet: selectedSheet } : {}),
        duplicateMode,
        expectedRows: dataRows.length,
        sourceFingerprint,
      });
      if (!begun.ok) {
        setError(begun.error);
        return;
      }

      /**
       * ⭐ "STARTING" AND "PICKING UP WHERE THE LAST ATTEMPT STOPPED" ARE
       * DIFFERENT SENTENCES. `beginImportRun` distinguishes them and the
       * distinction used to die in this function.
       */
      setRunNote(
        begun.data.note ??
          (begun.data.resumed
            ? "Picking up where the last attempt stopped. The rows already here will be " +
              "recognised rather than duplicated."
            : "Starting a new migration for this file."),
      );

      const { runId, chunkSize } = begun.data;
      const chunkCount = Math.ceil(dataRows.length / chunkSize);
      let lastReport: ImportReport | null = null;
      let stopped: string | null = null;

      for (let index = 0; index < chunkCount; index += 1) {
        setProgress(
          `Part ${formatCount(index + 1)} of ${formatCount(chunkCount)} — ${formatCount(
            Math.min((index + 1) * chunkSize, dataRows.length),
          )} of ${formatCount(dataRows.length)} rows`,
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

      /**
       * ⚠️ NO `abandoned` FLAG FROM HERE, AND THE OLD ONE WAS DEAD CODE.
       * This call used to read `...(stopped ? { abandoned: false } : {})`
       * — which passes `false` on one branch and omits it on the other,
       * where it defaults to `false`. Two spellings of the same value, so
       * `abandoned: true` had no caller anywhere in the product and the
       * `abandoned` run status was unreachable.
       *
       * 🔴 AND SETTING IT HERE WOULD BE WRONG, not merely useless. A
       * chunk that failed is a FAILURE; "abandoned" means the person
       * walked away, which this code path cannot observe because it is
       * still running. Claiming it would relabel every broken migration
       * as somebody's change of mind. See `PATCH-REQUEST-WAVE-2A.md` §3.
       */
      const ended = await endRun({ runId });
      setProgress(null);
      if (lastReport) setReport(lastReport);

      if (stopped) {
        setError(`${stopped}${ended.ok ? ` ${ended.data.message}` : ""}`);
        return;
      }
      if (ended.ok) {
        /**
         * ⚠️ THE FINISHING SENTENCE IS SHOWN AS AN ERROR WHEN ROWS ARE
         * MISSING. "Your migration is missing 1,600 rows" is not
         * information, it is a problem.
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

        {/*
          ⭐⭐⭐ THE PICKER IS THE ORDER. Choosing what to import and
          knowing when it can be imported are the same question, and a
          flat list of eighteen radio buttons answers only the first —
          which is how a customer loads their invoices on Monday morning
          and gets nine hundred unresolved-customer errors.
        */}
        <LoadOrder selected={entityKey} onChoose={chooseEntity} />

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
            Capitals, spaces and underscores in your headings do not matter — and
            common alternatives are recognised. Columns this does not recognise are
            ignored and listed in the report rather than causing a failure. Files
            larger than {formatCount(MAX_IMPORT_ROWS)} rows are imported in parts
            under one migration.
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
              MORE. The format is decided from the BYTES — a `.csv` that is
              really an `.xlsx` is routine, and produces a bewildering
              report when the name is trusted.
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
                ? ` — ${formatCount(dataRowCount)} row${dataRowCount === 1 ? "" : "s"}`
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
                  resetMapping();
                  parseBytes(fileBytes, fileName, e.target.value, tallyView);
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
            ⭐⭐ WAVE 2A — THE TALLY VIEW PICKER.

            🔴 ONE FILE, FIVE ANSWERS, AND ONLY ONE OF THEM WAS REACHABLE.
            A Tally export is not a table; it is an envelope out of which
            `readTally` can build five different tables — the ledgers, the
            vouchers, the voucher-type census, the cost-centre allocations
            and the bill references. `TALLY_VIEW_LABELS` has said "one line
            each, for a picker" since v1.74.0-alpha, and there was no
            picker, so a customer whose file was a day book saw a list of
            ledgers and no way to ask for anything else.

            ⚠️ IT RE-READS THE SAME BYTES. Changing the view is not a new
            file and must not be treated as one — the fingerprint, and
            therefore the run, is unchanged.
          */}
          {sourceFormat === "tally-xml" ? (
            <div className="mt-3">
              <Label htmlFor="import-tally-view" className="text-sm">
                What should Ordence read out of this Tally file?
              </Label>
              <select
                id="import-tally-view"
                className="mt-2 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={tallyView}
                onChange={(e) => {
                  if (!fileBytes || !fileName) return;
                  const next = e.target.value;
                  if (!isTallyView(next)) return;
                  reset();
                  resetMapping();
                  parseBytes(fileBytes, fileName, selectedSheet, next);
                }}
              >
                {TALLY_VIEWS.map((view) => (
                  <option key={view} value={view}>
                    {TALLY_VIEW_LABELS[view]}
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
          <p className="mt-2 text-xs text-muted-foreground">
            Excel workbooks (.xlsx), CSV, JSON and a Tally export are all read
            directly — you do not need to convert anything first. An Excel file is
            better than a CSV of the same data: it keeps invoice numbers, GSTINs and
            dates as what they are, where a CSV turns them into whatever the
            spreadsheet decided.
          </p>
        </div>
      </section>

      {/* ── STEP 2b — WHAT DO YOUR COLUMNS MEAN? ──────────────────── */}
      {records && records.length > 1 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">2b. What do your columns mean?</h2>
          <p className="text-sm text-muted-foreground">
            Ordence matches your columns on their headings and on what the values in
            them actually look like — so a column of GSTINs is recognised whatever it
            is called, and a column CALLED GSTIN that holds something else says so.
            Three of your own values are shown under each column: that is the check,
            and it takes a second.
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
              <MappingReview
                proposal={proposal}
                sampleRows={sampleRows}
                overrides={overrides}
                onOverride={(field, sourceHeader) => {
                  setOverrides((current) => ({ ...current, [field]: sourceHeader }));
                  setMappingSettled(false);
                }}
              />

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
        {/*
          🔴 THE MATCHING RULE, IN THE CUSTOMER'S WORDS, FROM THE ENTITY.
          "We match on a natural key" means nothing to anybody; "we match
          on the GSTIN, and on the name where there is no GSTIN" is a rule
          they can check against their own file before they run it.

          ⚠️ AND IT IS READ FROM `entity.duplicateRule` RATHER THAN CHOSEN
          BY A TERNARY ON THE ENTITY KEY. The ternary that used to be here
          is named in `lib/import/types.ts` as the reason that member
          exists: with eighteen entities it described sixteen of them as a
          GST party, at the moment the customer decides what happens to
          their data.
        */}
        {entity.duplicateRule ? (
          <p className="text-sm text-muted-foreground">{entity.duplicateRule}</p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          Matches are checked against what is already in your workspace and against
          the rest of this file, so running the same file twice will not double your
          data.
        </p>
        <div className="space-y-2">
          {DUPLICATE_OPTIONS.filter((option) => offeredModes.includes(option.value)).map(
            (option) => (
              <label
                key={option.value}
                className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${
                  duplicateMode === option.value
                    ? "border-primary bg-primary/5"
                    : "border-border bg-card"
                }`}
              >
                {/*
                  ⚠️ NOTHING IS PRE-TICKED. A default is the mechanism by
                  which a decision stops being made — and the server schema
                  has no default either, so this is enforced rather than
                  merely encouraged. "Recommended" is a label, not a
                  selection.
                */}
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
                    {option.value === recommended ? (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        recommended
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {option.detail}
                  </span>
                  {/*
                    ⭐ WHY IT IS THE RECOMMENDATION, FROM THE CONTRACT.
                    A recommendation with no reason is a recommendation
                    nobody can overrule with confidence.
                  */}
                  {option.value === recommended ? (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {entity.contract.duplicateDecision.because}
                    </span>
                  ) : null}
                </span>
              </label>
            ),
          )}
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
          */}
          {previewedCleanly && !needsChunking ? (
            <Button type="button" disabled={pending} onClick={() => run(commit, "commit")}>
              <Upload className="mr-1.5 h-4 w-4" aria-hidden="true" />
              {pending
                ? "Importing…"
                : `Import ${formatCount(
                    (report?.counts.create ?? 0) + (report?.counts.update ?? 0),
                  )} row${
                    (report?.counts.create ?? 0) + (report?.counts.update ?? 0) === 1 ? "" : "s"
                  }`}
            </Button>
          ) : null}

          {previewedCleanly && needsChunking && dataRowCount !== null ? (
            <Button type="button" disabled={pending} onClick={runMigration}>
              <Upload className="mr-1.5 h-4 w-4" aria-hidden="true" />
              {pending ? "Migrating…" : `Import all ${formatCount(dataRowCount)} rows`}
            </Button>
          ) : null}
        </div>

        {/*
          🔴 WHAT THE DRY RUN COVERED, WHEN THE FILE IS BIGGER THAN ONE
          PART. A preview that silently examined the first thousand rows of
          forty thousand and said nothing would be worse than no preview.
        */}
        {needsChunking && dataRowCount !== null ? (
          <p className="flex gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            <TriangleAlert className="mt-px h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              This file has {formatCount(dataRowCount)} rows, so it is imported in{" "}
              {formatCount(Math.ceil(dataRowCount / MAX_IMPORT_ROWS))} parts of up to{" "}
              {formatCount(MAX_IMPORT_ROWS)}. The dry run above covered the{" "}
              <strong>first part only</strong> — it is a check on your columns and your
              file&apos;s shape, not a count of the whole thing. Ordence keeps track of
              the parts, and will tell you plainly if any of them did not arrive. If the
              connection drops you can upload the same file again: it is recognised as
              the same file and picks up where it stopped.
            </span>
          </p>
        ) : null}

        {/*
          ⭐ WHETHER THIS IS A NEW MIGRATION OR THE SAME ONE CONTINUING.
          Shown above the progress line, because it is the sentence that
          explains a progress bar that starts at 60%.
        */}
        {runNote ? (
          <p
            aria-live="polite"
            className="rounded-md border border-border bg-muted/40 p-3 text-sm"
          >
            {runNote}
          </p>
        ) : null}

        {progress ? (
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {progress}
          </p>
        ) : null}

        {/*
          🔴 WHAT THE DRY RUN CANNOT PROMISE, SAID PLAINLY.
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
