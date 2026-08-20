"use client";

/**
 * Ordence — ⭐⭐⭐ WHAT DO YOUR COLUMNS MEAN
 * Version: v1.89.0-alpha · Wave 2A
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE CASE THIS SCREEN EXISTS FOR
 * ══════════════════════════════════════════════════════════════════════
 * A column headed `GSTIN` holding PANs, next to a column called `F7`
 * holding the real GSTINs. Before Phase 9 the first won at confidence
 * 1.00 — which is the auto-commit threshold — and four hundred parties
 * migrated with their PAN in the GSTIN column, with nothing on screen
 * saying it was a guess.
 *
 * `proposeMapping` now scores that heading at `CONTRADICTED_HEADER`,
 * below the threshold, and writes a sentence saying the heading and the
 * contents disagree. This screen is the half of that fix a customer can
 * see.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THREE THINGS ABOUT THE LAYOUT THAT ARE NOT LAYOUT
 * ══════════════════════════════════════════════════════════════════════
 * ① 🔴 THE WARNING IS ON THE ROW, NEVER IN A SUMMARY AT THE BOTTOM. A
 *    list of cautions under a table of thirty rows is a list that names
 *    a column the reader then has to go and find. The person has to see
 *    it in the same glance as the column it is about, or they will click
 *    past it — which is precisely what happened to the four hundred
 *    parties.
 *
 * ② ⭐ THREE SAMPLE VALUES UNDER THE CUSTOMER'S COLUMN. This is the
 *    whole mechanism by which a person can check a mapping at all. "72%
 *    confident" is not checkable; `27AABCR5055K1Z7 · 27AAACS1429B1ZP ·
 *    24AAGCS4576P1ZI` under a column mapped to GSTIN is checkable in one
 *    second, and so is `AABCR5055K` under the same heading.
 *
 * ③ THEIR COLUMN ON THE LEFT, OURS IN THE MIDDLE, HOW SURE ON THE RIGHT.
 *    The customer's file is the thing they know; it is the anchor and it
 *    reads first.
 *
 * ⚠️ AND A CAUTION THAT ALWAYS FIRES GETS CLICKED PAST. Nothing here
 * emits a per-row note for a column that was read cleanly. A row with no
 * band under it is the ordinary case and is meant to be — the bands are
 * scarce so that they are read.
 */

import { CircleAlert, TriangleAlert } from "lucide-react";
import {
  AUTO_COMMIT_THRESHOLD,
  SCORE,
  type ColumnProposal,
  type MappingProposal,
} from "@/lib/import/proposal";

/** How many values are shown under a column. Three fits and three is enough. */
export const SAMPLE_VALUES_SHOWN = 3;

export type MappingReviewProps = {
  proposal: MappingProposal;
  /**
   * The file's data rows, header row EXCLUDED, as the wizard already
   * holds them.
   *
   * ⚠️ THE VALUES NEVER LEAVE THE BROWSER TO GET HERE. `lib/import/`
   * reads the file client-side; this component is handed what is already
   * in memory. Fetching samples back from a server would put a second
   * copy of the customer's master data on our side to render three cells.
   */
  sampleRows: readonly (readonly string[])[];
  /** field → the source header the person chose. */
  overrides: Readonly<Record<string, string>>;
  onOverride: (field: string, sourceHeader: string) => void;
};

/**
 * ⭐ HOW SURE, IN WORDS FIRST.
 *
 * ⚠️ THE NUMBER IS SHOWN TOO, AND SECOND. A percentage on its own is not
 * something a person can act on; a percentage beside "needs your eye"
 * lets somebody who has seen a few of these tell 0.60 from 0.85.
 */
function certainty(column: ColumnProposal): {
  label: string;
  tone: "settled" | "check" | "blocked";
} {
  if (column.sourceIndex < 0) {
    return column.required
      ? { label: "Not found in your file", tone: "blocked" }
      : { label: "Not in your file", tone: "settled" };
  }
  if (column.confidence >= AUTO_COMMIT_THRESHOLD) return { label: "Certain", tone: "settled" };
  return { label: "Needs your eye", tone: "check" };
}

/**
 * 🔴 THE ONE ROW-LEVEL BAND, AND WHAT PUTS IT THERE.
 *
 * Three things, and each of them is a decision the customer is the only
 * one who can make:
 *
 *   ① The heading and the contents disagree — the GSTIN/PAN case.
 *   ② The AI mapper and the values disagree — `column.conflict`, which
 *     `proposeMapping` sets and never resolves silently.
 *   ③ A required column that nothing in the file matched.
 *
 * ⚠️ A LOW-BUT-UNCONTESTED SCORE IS NOT ONE OF THEM. A column matched on
 * a source profile's spelling scores 0.85 and is fine; banding it would
 * put a warning on most columns of every Tally file, and a warning on
 * most rows is a warning on none.
 */
function rowWarning(column: ColumnProposal): { text: string; blocking: boolean } | null {
  if (column.sourceIndex < 0 && column.required) {
    return {
      text:
        `Nothing in your file matched "${column.header}", and a row without it cannot be ` +
        `imported. Pick the column that holds it, or add the column to your file and ` +
        `upload it again.`,
      blocking: true,
    };
  }
  if (column.conflict) return { text: column.conflict, blocking: false };
  const headerBasis = column.basis === "exact-header" || column.basis === "alias";
  if (headerBasis && column.confidence <= SCORE.CONTRADICTED_HEADER) {
    /**
     * ⚠️ THE SENTENCE IS `why`, VERBATIM. It already names the column,
     * says what the values look like and says which of the two can be
     * counted. Rewriting it here would be a second copy of the reasoning
     * that drifts from the scorer the first time the scorer changes.
     */
    return { text: column.why, blocking: false };
  }
  return null;
}

export function MappingReview({
  proposal,
  sampleRows,
  overrides,
  onOverride,
}: MappingReviewProps) {
  /**
   * ⚠️ SAMPLES ARE LOOKED UP BY THE CHOSEN HEADER, NOT BY
   * `column.sourceIndex`. The moment somebody changes the picker, the
   * three values under it must be the values of the column they just
   * chose — otherwise the check they are being asked to make is a check
   * of the old answer, which is worse than showing nothing.
   */
  function samplesFor(sourceHeader: string): string[] {
    const index = proposal.sourceHeaders.indexOf(sourceHeader);
    if (index < 0) return [];
    const out: string[] = [];
    for (const row of sampleRows) {
      const value = (row[index] ?? "").trim();
      if (value === "") continue;
      out.push(value);
      if (out.length === SAMPLE_VALUES_SHOWN) break;
    }
    return out;
  }

  /**
   * ⚠️ FILE-LEVEL CAUTIONS ONLY. Anything that is also a row's `conflict`
   * is dropped here, because it is already on that row — see ① above. A
   * sentence in two places is a sentence the reader stops trusting the
   * position of.
   */
  const rowTexts = new Set(
    proposal.columns.map((c) => c.conflict).filter((c): c is string => Boolean(c)),
  );
  const fileCautions = proposal.cautions.filter((c) => !rowTexts.has(c));

  return (
    <div className="space-y-3">
      {fileCautions.length > 0 ? (
        <ul className="space-y-2">
          {fileCautions.map((caution) => (
            <li
              key={caution}
              className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs"
            >
              <TriangleAlert
                className="mt-px h-3.5 w-3.5 shrink-0 text-amber-600"
                aria-hidden="true"
              />
              <span>{caution}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="p-3 font-medium">Your column</th>
              <th scope="col" className="p-3 font-medium">Ordence field</th>
              <th scope="col" className="p-3 font-medium">How sure, and why</th>
            </tr>
          </thead>
          <tbody>
            {proposal.columns.map((column) => {
              const chosen = overrides[column.field] ?? column.sourceHeader ?? "";
              const samples = samplesFor(chosen);
              const sure = certainty(column);
              const warning = rowWarning(column);

              return (
                <tr key={column.field} className="border-b align-top last:border-0">
                  {/* ── LEFT: THEIR COLUMN, AND WHAT IS IN IT ─────── */}
                  <td className="p-3">
                    <select
                      aria-label={`Which of your columns is ${column.header}`}
                      className="h-9 w-full min-w-44 rounded-md border border-input bg-background px-2 text-sm"
                      value={chosen}
                      onChange={(e) => onOverride(column.field, e.target.value)}
                    >
                      <option value="">— not in my file —</option>
                      {proposal.sourceHeaders.map((header) => (
                        <option key={header} value={header}>
                          {header}
                        </option>
                      ))}
                    </select>

                    {/*
                      ⭐ THE THREE VALUES. `tabular-nums` because half of
                      what appears here is GSTINs, invoice numbers and
                      amounts, and a column of those that does not line up
                      is a column nobody scans.
                    */}
                    {samples.length > 0 ? (
                      <ul className="mt-1.5 space-y-0.5 text-xs tabular-nums text-muted-foreground">
                        {samples.map((value, index) => (
                          <li key={`${value}-${index}`} className="truncate" title={value}>
                            {value}
                          </li>
                        ))}
                      </ul>
                    ) : chosen !== "" ? (
                      /*
                        ⚠️ "EMPTY" AND "NOT LOOKED AT" ARE DIFFERENT
                        FACTS. A column whose first rows are blank is a
                        real thing the customer should see before they
                        map it.
                      */
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        The first rows of this column are empty.
                      </p>
                    ) : null}
                  </td>

                  {/* ── MIDDLE: OURS ──────────────────────────────── */}
                  <td className="p-3">
                    <span className="font-medium">{column.header}</span>
                    {column.required ? (
                      <span className="ml-2 text-xs text-muted-foreground">required</span>
                    ) : null}
                  </td>

                  {/* ── RIGHT: HOW SURE, AND WHY ──────────────────── */}
                  <td className="p-3 text-xs">
                    <span
                      className={
                        sure.tone === "blocked"
                          ? "font-medium text-destructive"
                          : sure.tone === "check"
                            ? "font-medium text-amber-700"
                            : "font-medium"
                      }
                    >
                      {sure.label}
                    </span>
                    {column.sourceIndex >= 0 ? (
                      <span className="ml-2 tabular-nums text-muted-foreground">
                        {Math.round(column.confidence * 100)}%
                      </span>
                    ) : null}
                    {/*
                      ⚠️ NOT TWICE. When the band below IS this sentence —
                      the contradicted-heading case, where `why` already
                      says everything there is to say — printing it here as
                      well puts the same words in the row twice, and a
                      reader who has read a sentence skips its repeat,
                      including the second time when it is the warning.
                    */}
                    {warning?.text === column.why ? null : (
                      <p className="mt-1 text-muted-foreground">{column.why}</p>
                    )}

                    {/* 🔴 INLINE. On the row. Never at the bottom. */}
                    {warning ? (
                      <p
                        className={`mt-2 flex gap-2 rounded-md p-2 ${
                          warning.blocking
                            ? "border border-destructive/50 bg-destructive/5"
                            : "border border-amber-500/40 bg-amber-500/5"
                        }`}
                      >
                        {warning.blocking ? (
                          <CircleAlert
                            className="mt-px h-3.5 w-3.5 shrink-0 text-destructive"
                            aria-hidden="true"
                          />
                        ) : (
                          <TriangleAlert
                            className="mt-px h-3.5 w-3.5 shrink-0 text-amber-600"
                            aria-hidden="true"
                          />
                        )}
                        <span>{warning.text}</span>
                      </p>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
