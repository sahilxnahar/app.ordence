/**
 * Ordence — ⭐⭐⭐ WHAT A PROFILE IS ALLOWED TO CONTRIBUTE, AND HOW MUCH
 * Version: v1.84.1-alpha · Phase 9
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE MEASUREMENT THIS FILE EXISTS BECAUSE OF
 * ══════════════════════════════════════════════════════════════════════
 * The obvious way to feed profile header spellings into the mapper is to
 * append them to `ImportColumn.aliases`. It is one line, it needs no
 * change to `lib/import/proposal.ts`, and IT INVERTS THE RULE THIS PHASE
 * IS UNDER.
 *
 *     SCORE.ALIAS          0.95
 *     SCORE.DECISIVE_SHAPE 0.90
 *
 * An alias match is scored HIGHER than "every value in this column is
 * unmistakably this thing", and in `candidatesFor` the alias branch
 * `return`s before the value evidence is even looked at. So a profile
 * that said "Zoho calls the GSTIN column `GST Identification Number`"
 * would win against a column whose every value IS a GSTIN — which is the
 * exact file `lib/import/shapes.ts` opens by describing: a column HEADED
 * "GSTIN" that turns out to hold PANs.
 *
 * ⚠️ MEASURED, NOT REASONED. `tests/ui/import-profiles.test.ts` builds
 * that file, injects the profile spellings as aliases the wrong way, and
 * asserts that the PAN column wins — so the day somebody re-orders those
 * two constants, the test that documents the hazard fails and says why.
 *
 * ⭐ THE FIX IS A SCORE BAND OF ITS OWN, and it is a four-line change to
 * a file this phase does not own. It is written out in full in
 * `PATCH-REQUEST-PHASE-9.md` §1. Until it lands, nothing merges these
 * spellings into any entity's aliases — this module hands out DATA and
 * states the band it must be scored in.
 */

import { evidenceFor, EVIDENCE_SAMPLE_ROWS } from "../shapes";
import { resolveCivilDateFormat, type DateResolution } from "./dates";
import { resolveNegativeStyle, type AmountResolution } from "./amounts";
import type { ProfileDetection } from "./detect";
import type { CivilDateFormatKey, NegativeStyleKey } from "./types";

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE BAND. STRICTLY BELOW `SCORE.DECISIVE_SHAPE`, STRICTLY ABOVE
 *    `SCORE.TOKEN_CONTAINMENT`.
 * ══════════════════════════════════════════════════════════════════════
 * Below 0.90 because the values must win. Above 0.70 because "this is
 * what Zoho Books calls that column, and this file IS a Zoho Books
 * export" is better evidence than two headings sharing a word.
 *
 * ⚠️ AND BELOW `AUTO_COMMIT_THRESHOLD` (0.90) AS A CONSEQUENCE, WHICH IS
 * THE PROPERTY THAT MATTERS MOST: a column mapped only on a profile's say
 * so can never carry a plan into auto-commit on its own. A person looks
 * at it. That is the correct weight for a claim about what a system
 * usually writes.
 */
export const PROFILE_HEADER_SCORE = 0.85;

export type ProfileHeaderPrior = {
  /** The entity field this spelling is a name for. */
  readonly field: string;
  /** The system's own spellings, as written. */
  readonly spellings: readonly string[];
  /** The sentence the wizard shows. Names the system, so it can be argued with. */
  readonly why: string;
};

/**
 * ⭐ THE PRIORS FOR ONE RECOGNISED FILE. Empty when nothing was
 * recognised, which is the fallback's whole behaviour: the generic path
 * is left exactly as it was.
 */
export function profileHeaderPriors(detection: ProfileDetection): readonly ProfileHeaderPrior[] {
  const { profile, match } = detection;
  if (!match) return [];
  const entry = profile.exports.find((e) => e.id === match.exportId);
  if (!entry) return [];

  const byField = new Map<string, string[]>();
  for (const header of entry.headers) {
    byField.set(header.field, [...(byField.get(header.field) ?? []), header.spelling]);
  }

  return [...byField.entries()].map(([field, spellings]) => ({
    field,
    spellings,
    why:
      `${spellings.map((s) => `"${s}"`).join(" and ")} ` +
      `${spellings.length === 1 ? "is what" : "are what"} ${profile.label} calls this column in ` +
      `its ${entry.title}. That is a starting point rather than a reading of your data — if the ` +
      `values in this column say otherwise, the values win.`,
  }));
}

/** The format priors, which are a property of the SYSTEM rather than of one export. */
export function profileFormatPriors(detection: ProfileDetection): {
  readonly dateFormats: readonly CivilDateFormatKey[];
  readonly negativeStyles: readonly NegativeStyleKey[];
} {
  return {
    dateFormats: detection.profile.dateFormats,
    negativeStyles: detection.profile.negativeStyles,
  };
}

/* ------------------------------------------------------------------ */
/* RESOLVING A WHOLE FILE                                              */
/* ------------------------------------------------------------------ */

export type ColumnFormatFinding = {
  readonly index: number;
  readonly header: string;
  readonly date: DateResolution | null;
  readonly amount: AmountResolution | null;
};

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ `shapes.ts` CHOOSES WHICH COLUMNS ARE DATES. THE PROFILE ONLY
 *     EVER SUPPLIES AN ORDER.
 * ══════════════════════════════════════════════════════════════════════
 * This is the subordination rule as executable code rather than as a
 * paragraph. A column is a candidate for date resolution because
 * `evidenceFor` says its values look like civil dates — a fact about the
 * customer's data — and never because a profile said the third column of
 * a Tally export is a date. A profile that named a free-text column as a
 * date never reaches `resolveCivilDateFormat` at all.
 *
 * ⚠️ AND FOR AMOUNTS THE RESOLVER IS ITS OWN TEST. A column of company
 * names is refused by every negative style and comes back `unreadable`.
 * The one place a separate heuristic appears is `looksLikeAmounts` below,
 * and its scope is deliberately tiny: it decides whether an `unreadable`
 * result is worth a SENTENCE, never what a value is. Nothing downstream
 * sees it.
 *
 * ⚠️ ONLY INTERESTING COLUMNS ARE RETURNED. A money column with no
 * negatives in it produces no finding: there was no question, so there is
 * nothing to tell the customer, and a screen of empty reassurances is how
 * the one line that matters gets skipped.
 */
export function resolveColumnFormats(
  headerRow: readonly string[],
  rows: readonly (readonly string[])[],
  detection: ProfileDetection,
): readonly ColumnFormatFinding[] {
  const { dateFormats, negativeStyles } = profileFormatPriors(detection);
  const findings: ColumnFormatFinding[] = [];

  headerRow.forEach((header, index) => {
    const values = rows.map((row) => row[index] ?? "");
    const evidence = evidenceFor(values);

    /**
     * ══════════════════════════════════════════════════════════════
     * ⭐ THE RESOLVER IS ITS OWN TEST, AND IT IS A STRICTER ONE THAN
     *    `shapes.ts` COULD BE
     * ══════════════════════════════════════════════════════════════
     * `resolveCivilDateFormat` only ever returns a format that explains
     * EVERY value in the column. A column of company names is explained
     * by none and drops out here; a column of dates is explained by at
     * least one. That is a harder test than the 90% dominant-shape rule
     * `evidenceFor` applies, and it needs no second opinion about what
     * kind of column this is.
     *
     * 🔴 GATING ON `evidence.shape === "civil_date"` WAS THE FIRST
     * VERSION AND IT WAS WRONG IN THE ONE CASE THAT MATTERS MOST.
     * `shapes.ts`'s `CIVIL_DATE` is `\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}` —
     * digits only. `1-Apr-2026`, which is what Tally and Busy write, has
     * no dominant shape at all, so a Tally date column would never have
     * reached a resolver. Measured, and reported to M1 in
     * `PATCH-REQUEST-PHASE-9.md` §7.
     *
     * ⚠️ `evidence` IS STILL CONSULTED FOR ONE THING: whether a column
     * that NO format explains is worth complaining about. That is the
     * "this column holds two date formats" case, and it is only a
     * complaint if the column was trying to be dates.
     */
    const dateResolution = resolveCivilDateFormat(values, dateFormats);
    const looksDated = evidence.shape === "civil_date" || evidence.shape === "iso_date";
    const orderAmbiguous =
      dateResolution.format !== null &&
      (dateResolution.format.startsWith("dmy") || dateResolution.format.startsWith("mdy"));
    /**
     * ⚠️ AN ISO COLUMN PRODUCES NO LINE. There was no decision to report,
     * and a note per date column on every file is how the one note that
     * matters gets scrolled past. A day-first/month-first column always
     * produces one, even when the values settled it, because a date order
     * silently chosen is the migration failure that costs the most.
     */
    let date: DateResolution | null = null;
    switch (dateResolution.settledBy) {
      case "profile-prior":
      case "unresolved":
        /** A decision was made, or one is still owed. Both need saying. */
        date = dateResolution;
        break;
      case "values":
        /**
         * ⚠️ AN ISO OR MONTH-NAME COLUMN PRODUCES NO LINE. There was no
         * decision: `2026-04-01` and `1-Apr-2026` mean one day each. A
         * note per date column on every file is how the one note that
         * matters gets scrolled past. A day-first/month-first column
         * always produces one even when the values settled it, because a
         * date order silently chosen is the migration failure that costs
         * the most — and because the sentence names the value that
         * settled it, which is checkable in ten seconds.
         */
        date = orderAmbiguous || dateResolution.caution !== null ? dateResolution : null;
        break;
      case "unreadable":
        /**
         * 🔴 AND HERE `evidence` EARNS ITS KEEP. Every column of company
         * names is "unreadable" as a date. Complaining about all of them
         * would put a caution on half the columns of every file; the
         * complaint is only real when the column was trying to be dates,
         * and that is a question about the values, which is what
         * `shapes.ts` answers.
         */
        date = looksDated ? dateResolution : null;
        break;
      case "no-values":
        date = null;
        break;
    }

    let amount: AmountResolution | null = null;
    if (!date) {
      const resolved = resolveNegativeStyle(values, negativeStyles);
      /**
       * ⚠️ `unreadable` IS ONLY WORTH SAYING ABOUT A COLUMN THAT IS
       * TRYING TO BE AN AMOUNT. Every column of company names is
       * "unreadable" as an amount, and reporting that would put a
       * caution on half the columns of every file — which is how the one
       * caution that matters stops being read. `looksLikeAmounts` is a
       * local test used ONLY to decide whether to speak; it never decides
       * a value, and nothing downstream sees it.
       */
      const worthSaying =
        resolved.settledBy === "profile-prior" ||
        (resolved.settledBy === "values" && resolved.negatives > 0) ||
        (resolved.settledBy === "unreadable" && looksLikeAmounts(values));
      if (worthSaying) amount = resolved;
    }

    if (date || amount) {
      findings.push({ index, header, date, amount });
    }
  });

  return findings;
}

/**
 * The sentences, for `SourceTable.notes`.
 *
 * ⚠️ CAUTIONS FIRST AND THEN NOTHING ELSE FROM THAT COLUMN. A column that
 * needs a decision from the customer and a column that was read cleanly
 * are different kinds of line, and mixing them in one list is how the
 * first kind stops being read.
 */
/**
 * ⚠️ DELIBERATELY LOOSER THAN ANY STYLE. It matches what somebody was
 * TRYING to write as money — brackets, a trailing minus, a Dr/Cr marker,
 * a rupee sign — without deciding which convention that is. Being loose
 * is the point: this is the question "is this column about amounts at
 * all", and a strict answer to that question would be the strict answer
 * to a different one.
 */
const AMOUNT_ISH = /^[(₹]?\s*(?:rs\.?|inr)?\s*-?[\d,]+(?:\.\d+)?\s*\)?\s*(?:cr|dr|credit|debit)?\.?-?$/i;

function looksLikeAmounts(values: readonly string[]): boolean {
  const sample = values.slice(0, EVIDENCE_SAMPLE_ROWS).map((v) => v.trim()).filter((v) => v !== "");
  if (sample.length === 0) return false;
  const hits = sample.filter((v) => AMOUNT_ISH.test(v)).length;
  /** The same 90% threshold `shapes.ts` claims a dominant shape at. */
  return hits / sample.length >= 0.9;
}

export function describeColumnFormats(findings: readonly ColumnFormatFinding[]): string[] {
  const out: string[] = [];
  for (const finding of findings) {
    const named = finding.header.trim() === "" ? `column ${finding.index + 1}` : `"${finding.header}"`;
    for (const resolution of [finding.date, finding.amount]) {
      if (!resolution) continue;
      if (resolution.caution) out.push(`${named}: ${resolution.caution} ${resolution.why}`);
      else out.push(`${named}: ${resolution.why}`);
    }
  }
  return out;
}
