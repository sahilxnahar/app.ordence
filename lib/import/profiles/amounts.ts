/**
 * Ordence — ⭐⭐⭐ HOW THIS SYSTEM WRITES A NEGATIVE, AND WHO DECIDED
 * Version: v1.84.1-alpha · Phase 9
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `(1,234.00)`, `1234.00 Cr` AND `-1234` ALL OCCUR, AND ONLY ONE OF
 *    THEM SURVIVES `coerceMoneyMinor`
 * ══════════════════════════════════════════════════════════════════════
 * `lib/import/values.ts` strips commas, spaces and a leading rupee sign
 * and then insists on `-?ddd(.dd)`. Everything else is refused with a
 * message about writing rupees — which is the right refusal for a typo
 * and the wrong one for a whole column, because a Tally or Busy export
 * writes its credits as `Cr` on every row and the customer sees four
 * thousand identical failures for a file that is not wrong.
 *
 * ⚠️ AND THE FAILURE THAT MATTERS IS NOT THE REFUSAL, IT IS THE SILENT
 * SUCCESS. `(1,234.00)` read by anything that strips punctuation is
 * `1234.00` — a positive. An opening trial balance whose credits all came
 * through positive still footed to something; it just was not the
 * customer's books. `lib/import/opening.ts` refuses a trial balance that
 * does not balance, and the sign convention is precisely what decides
 * whether it does.
 *
 * ⭐ SO THE STYLE IS A PER-PROFILE FACT, DECLARED, AND — like the date
 * format — RESOLVED AGAINST THE FILE'S OWN VALUES BEFORE IT IS USED.
 * The output is a plain signed decimal string that `coerceMoneyMinor`
 * accepts unaided, so the bigint arithmetic that file guards stays the
 * only arithmetic there is. Nothing here multiplies anything by 100.
 *
 * ⚠️ PURE, AND IT DOES NOT THROW. Same reason `lib/import/values.ts` does
 * not: a coercion failure is a fact about one cell, and one bad cell must
 * not end a run.
 */

import { EVIDENCE_SAMPLE_ROWS } from "../shapes";
import type { NegativeStyleKey } from "./types";

export const NEGATIVE_STYLES = [
  "leading-minus",
  "trailing-minus",
  "parentheses",
  "cr-suffix",
  "dr-cr-suffix",
] as const;

export function isNegativeStyleKey(value: unknown): value is NegativeStyleKey {
  return (NEGATIVE_STYLES as readonly string[]).includes(value as string);
}

export const NEGATIVE_STYLE_LABELS: Readonly<Record<NegativeStyleKey, string>> = Object.freeze({
  "leading-minus": "a minus sign in front (-1234.00)",
  "trailing-minus": "a minus sign after the number (1234.00-)",
  parentheses: "brackets around the number ((1,234.00))",
  "cr-suffix": "a Cr after the number (1234.00 Cr)",
  "dr-cr-suffix": "Dr or Cr after the number (1234.00 Dr / 1234.00 Cr)",
});

/**
 * ⚠️ THE SYMBOL IS STRIPPED HERE AND NOT LEFT FOR `coerceMoneyMinor`.
 * That function removes the rupee sign only at the START of the cleaned
 * string, so `-<symbol>1,234.00` — which is exactly what this module
 * would produce from a bracketed amount if it left the symbol alone —
 * reaches its pattern with a symbol in the middle and is refused.
 * Measured, not assumed; there is a case for it in
 * `tests/ui/import-profiles.test.ts`.
 */
const SYMBOL = /^(?:₹|rs\.?|inr)\s*/i;

/** Digits with either grouping — `1,234.56` and `1,23,456.78` both. */
const MAGNITUDE = /^\d[\d,]*(?:\.\d+)?$/;

export type AmountParse =
  | {
      readonly ok: true;
      /** A plain signed decimal string. `coerceMoneyMinor` accepts it as-is. */
      readonly value: string;
      readonly negative: boolean;
    }
  | { readonly ok: false; readonly message: string };

function magnitude(text: string): string | null {
  const bare = text.replace(SYMBOL, "").trim();
  return MAGNITUDE.test(bare) ? bare : null;
}

const CR = /^(.*?)\s*(?:cr|credit)\.?$/i;
const DR = /^(.*?)\s*(?:dr|debit)\.?$/i;

/**
 * ⭐ ONE STYLE, ONE STRING, ONE ANSWER — and DELIBERATELY STRICT.
 *
 * ⚠️ EACH STYLE ACCEPTS ITS OWN MARKER AND NO OTHER. A permissive reader
 * that took `(1234)`, `1234-` and `1234 Cr` under every style would make
 * all five styles explain every file, which would make the resolver below
 * unable to tell them apart — and an ambiguity that is never reported is
 * an assumption nobody knows was made. Strictness here is what makes the
 * evidence discriminating.
 *
 * ⚠️ AN UNMARKED NUMBER IS A POSITIVE UNDER EVERY STYLE. That is not a
 * hole: no system marks its positives, so every style has to accept one.
 */
export function applyNegativeStyle(raw: string, style: NegativeStyleKey): AmountParse {
  const value = raw.trim();
  if (value === "") return { ok: false, message: "This cell is empty." };

  const refuse: AmountParse = {
    ok: false,
    message: `"${value}" is not an amount written with ${NEGATIVE_STYLE_LABELS[style]}.`,
  };

  const plain = (text: string, negative: boolean): AmountParse => {
    const bare = magnitude(text);
    if (bare === null) return refuse;
    return { ok: true, value: negative ? `-${bare}` : bare, negative };
  };

  switch (style) {
    case "leading-minus": {
      if (value.startsWith("-")) return plain(value.slice(1), true);
      return plain(value, false);
    }
    case "trailing-minus": {
      if (value.endsWith("-")) return plain(value.slice(0, -1), true);
      return plain(value, false);
    }
    case "parentheses": {
      const m = /^\((.+)\)$/.exec(value);
      if (m) return plain(m[1] ?? "", true);
      return plain(value, false);
    }
    case "cr-suffix": {
      /**
       * 🔴 A `Dr` MARKER IS NOT ACCEPTED HERE, ON PURPOSE. A column that
       * carries both markers is `dr-cr-suffix`, and letting this style
       * swallow `Dr` as an unmarked positive would make the two
       * indistinguishable on every real file — the resolver would report
       * "settled by the values" for a question the values never settled.
       */
      if (DR.test(value)) return refuse;
      const m = CR.exec(value);
      if (m) return plain(m[1] ?? "", true);
      return plain(value, false);
    }
    case "dr-cr-suffix": {
      const cr = CR.exec(value);
      if (cr) return plain(cr[1] ?? "", true);
      const dr = DR.exec(value);
      if (dr) return plain(dr[1] ?? "", false);
      return plain(value, false);
    }
  }
}

/* ------------------------------------------------------------------ */
/* THE RESOLVER                                                        */
/* ------------------------------------------------------------------ */

export type AmountResolutionBasis =
  /** 🔴 Exactly one convention explains every value. Nothing can overrule it. */
  | "values"
  /**
   * ⚠️ SEVERAL EXPLAIN THIS SAMPLE AND READ IT TO THE SAME NUMBERS, AND
   * THE PROFILE CHOSE BETWEEN THEM — WHICH IS NOT COSMETIC. See
   * `resolveNegativeStyle` for why the choice matters for the rows the
   * sample did not reach.
   */
  | "profile-prior"
  /** Nothing in this column is negative, so nothing had to be decided. */
  | "no-negatives"
  /** No convention explains every value — the column holds two things. */
  | "unreadable"
  | "no-values";

export type AmountResolution = {
  readonly style: NegativeStyleKey | null;
  readonly settledBy: AmountResolutionBasis;
  readonly candidates: readonly NegativeStyleKey[];
  readonly sampled: number;
  /** How many sampled values come out negative under the chosen style. */
  readonly negatives: number;
  readonly why: string;
  readonly caution: string | null;
};

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE THING THE PRIOR IS ACTUALLY FOR, AND IT IS NOT THE SAMPLE
 * ══════════════════════════════════════════════════════════════════════
 * The five conventions above are mutually exclusive on any value that
 * carries a marker: `(1,234.00)` is refused by every style except
 * `parentheses`, `1234.00-` by every style except `trailing-minus`. So a
 * column whose sample CONTAINS a negative is settled by that sample, and
 * no profile is consulted. ⭐ That property is proved rather than
 * asserted — `tests/ui/import-profiles.test.ts` runs every marker value
 * through every style and checks that no two surviving readings ever
 * disagree. It is why this function has no "the readings disagree"
 * branch: with these five styles there is no such case, and a branch that
 * cannot be reached is the defect this repository keeps finding.
 *
 * ⚠️ WHAT IS LEFT IS THE CASE THAT MATTERS MOST, AND IT LOOKS LIKE THE
 * HARMLESS ONE. `EVIDENCE_SAMPLE_ROWS` is 200. A customer's file is
 * 40,000. A ledger column whose first 200 rows are all debits carries no
 * marker at all, every convention explains it, and the choice between
 * them reads as arbitrary — until row 8,000, which is `1,234.00 Cr`.
 * Under `leading-minus`, the alphabetically-first answer, that row is
 * refused. Under Tally's own `dr-cr-suffix` it is read correctly.
 *
 * ⭐ SO THE PROFILE'S ORDER DECIDES, AND THE RESULT SAYS SO. The prior is
 * still never allowed to introduce a reading the sample forbids: it is
 * only ever consulted among styles that already explain every value seen.
 */
export function resolveNegativeStyle(
  values: readonly string[],
  priors: readonly NegativeStyleKey[] = [],
): AmountResolution {
  const sample = values.slice(0, EVIDENCE_SAMPLE_ROWS).map((v) => v.trim()).filter((v) => v !== "");

  if (sample.length === 0) {
    return {
      style: null,
      settledBy: "no-values",
      candidates: [],
      sampled: 0,
      negatives: 0,
      why: "This column has no values in it.",
      caution: null,
    };
  }

  const readings = new Map<NegativeStyleKey, string[]>();
  const eliminatedBy = new Map<NegativeStyleKey, string>();

  for (const style of NEGATIVE_STYLES) {
    const out: string[] = [];
    let failed: string | null = null;
    for (const value of sample) {
      const parsed = applyNegativeStyle(value, style);
      if (!parsed.ok) {
        failed = value;
        break;
      }
      out.push(parsed.value);
    }
    if (failed === null) readings.set(style, out);
    else eliminatedBy.set(style, failed);
  }

  const candidates = [...readings.keys()];

  if (candidates.length === 0) {
    const seen = sample.slice(0, 3).map((v) => `"${v}"`).join(", ");
    const first = [...eliminatedBy.entries()][0];
    return {
      style: null,
      settledBy: "unreadable",
      candidates: [],
      sampled: sample.length,
      negatives: 0,
      why:
        `No single convention explains every value in this column. The first values are ${seen}` +
        (first ? `; ${NEGATIVE_STYLE_LABELS[first[0]]} was ruled out by "${first[1]}"` : "") +
        `. A column mixing brackets, trailing minuses and Cr markers has to be fixed in the file.`,
      caution:
        "Ordence will not guess how this column marks a negative. An amount read with the wrong " +
        "sign is the one error a trial balance cannot absorb.",
    };
  }

  const negativesUnder = (style: NegativeStyleKey) =>
    (readings.get(style) ?? []).filter((v) => v.startsWith("-")).length;

  /** ⭐ One reading and no others. The values settled it; stop. */
  if (candidates.length === 1) {
    const style = candidates[0]!;
    const negatives = negativesUnder(style);
    return {
      style,
      settledBy: "values",
      candidates,
      sampled: sample.length,
      negatives,
      why:
        `Negatives in this column are written with ${NEGATIVE_STYLE_LABELS[style]}, which is the ` +
        `only convention that explains every value in it. ${negatives} of ${sample.length} ` +
        `sampled value${negatives === 1 ? " is" : "s are"} negative.`,
      caution: null,
    };
  }

  /**
   * Several conventions explain the sample. By the property above they
   * read it to the same numbers, so nothing here is at risk — the
   * question is which convention applies to the rows beyond the sample.
   */
  const prior = priors.find((p) => candidates.includes(p));
  const style = prior ?? candidates[0]!;
  const negatives = negativesUnder(style);
  const others = candidates.filter((c) => c !== style);

  if (prior) {
    return {
      style,
      settledBy: "profile-prior",
      candidates,
      sampled: sample.length,
      negatives,
      why:
        `Nothing in the first ${sample.length} value${sample.length === 1 ? "" : "s"} of this ` +
        `column says how it writes a negative — ` +
        `${candidates.map((c) => NEGATIVE_STYLE_LABELS[c]).join(", ")} all read them the same ` +
        `way. It has been read as ${NEGATIVE_STYLE_LABELS[style]}, because that is what the ` +
        `source system this file was recognised as writes.`,
      caution:
        `That choice decides how a row further down the file is read. If this column turns out ` +
        `to hold ${others.map((c) => NEGATIVE_STYLE_LABELS[c]).join(" or ")} lower down, those ` +
        `rows will be reported as failures rather than read wrongly — check the failed-row ` +
        `report before deciding the file is fine.`,
    };
  }

  return {
    style,
    settledBy: negatives > 0 ? "values" : "no-negatives",
    candidates,
    sampled: sample.length,
    negatives,
    why:
      negatives === 0
        ? `No value in the first ${sample.length} of this column is negative, so how this file ` +
          `marks one did not have to be decided.`
        : `Negatives in this column are written with ${NEGATIVE_STYLE_LABELS[style]}. ` +
          `${negatives} of ${sample.length} sampled values are negative, and every other ` +
          `convention Ordence knows reads this column to the same numbers.`,
    caution:
      negatives === 0
        ? `Only the first ${sample.length} rows were looked at. If an amount lower down is ` +
          `written as ${others.map((c) => NEGATIVE_STYLE_LABELS[c]).join(" or ")}, it will be ` +
          `reported as a failed row rather than read with the wrong sign.`
        : null,
  };
}
