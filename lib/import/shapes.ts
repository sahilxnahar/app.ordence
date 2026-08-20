/**
 * Ordence — ⭐⭐ WHAT A COLUMN OF VALUES LOOKS LIKE
 * Version: v1.74.0-alpha · Wave 6
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY EVIDENCE FROM THE VALUES, AND NOT ONLY FROM THE HEADER
 * ══════════════════════════════════════════════════════════════════════
 * Header matching handles `Company Name`, `company_name` and `COMPANYNAME`
 * because they all normalise to the same string. It does NOT handle the
 * files customers actually export out of twenty-year-old systems:
 *
 *     `F1  F2  F3  F4  F5`
 *     `Column1  Column2  Column3`
 *     `पार्टी का नाम   जीएसटीआईएन`
 *     `Cust_Nm  Cust_GST_No  Ph1  Ph2`
 *
 * Nothing in the first three tells a matcher anything at all. But a
 * column whose every value matches `^\\d{2}[A-Z]{5}\\d{4}[A-Z][A-Z\\d]Z[A-Z\\d]$`
 * is a GSTIN whatever it is called, and it is a GSTIN with far more
 * certainty than a column HEADED "GSTIN" that turns out to hold PANs.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND THIS IS WHAT MAKES AN AI PROPOSAL CHECKABLE RATHER THAN TRUSTED
 * ══════════════════════════════════════════════════════════════════════
 * A language model reading twenty headers will produce a confident
 * mapping for all twenty, including the ones it guessed. These detectors
 * are the independent evidence its guesses are scored against in
 * `lib/import/proposal.ts` — a model saying `F3` is the GSTIN when
 * every value in F3 is an email address does not get to be right.
 *
 * ⚠️ PURE, AND NO NETWORK. Runs in the browser preview and in a test.
 */

export type ValueShape =
  | "gstin"
  | "pan"
  | "email"
  | "phone_in"
  | "ifsc"
  | "pincode_in"
  | "hsn"
  | "iso_date"
  | "civil_date"
  | "money"
  | "integer"
  | "boolean"
  | "url"
  | "blank";

/**
 * 🔴 GSTIN: 2 state digits, a PAN, an entity number, a `Z`, a checksum.
 * The `Z` in position 14 is fixed by the format and is the cheapest thing
 * that separates a GSTIN from any other 15-character code.
 */
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;
const PAN = /^[A-Z]{5}\d{4}[A-Z]$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** ⚠️ Indian mobile/landline, with or without +91, spaces or dashes. */
const PHONE_IN = /^(?:\+?91[\s-]?)?[0-9][\s-]?(?:\d[\s-]?){8,11}$/;
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const PINCODE_IN = /^[1-9]\d{5}$/;
/** HSN/SAC is 4, 6 or 8 digits. */
const HSN = /^\d{4}(\d{2}(\d{2})?)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/;
/** `19/08/2026`, `19-08-2026`, `19.08.2026`. */
const CIVIL_DATE = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/;
/**
 * ⭐ `1-Apr-2026`, `15 Dec 25`. Tally, Busy and Xero all write it, and it is
 * what the two systems most Ordence customers are leaving put in their date
 * columns.
 *
 * 🔴 WITHOUT THIS, SUCH A COLUMN HAS NO DOMINANT SHAPE AT ALL. `evidenceFor`
 * reported `shape: null`, `SHAPE_SUGGESTS` contributed nothing, and
 * `proposeMapping` never got value evidence for the date column of a Tally
 * file. Found by Phase 9 gating its date resolver on
 * `evidence.shape === "civil_date"` and watching it never fire.
 *
 * ⚠️ IT MAPS TO `civil_date`, THE SAME SHAPE, so `SHAPE_SUGGESTS` needs no
 * change , this is a spelling of a thing that already exists, not a new
 * kind of thing.
 */
const MONTH_NAME_DATE =
  /^\d{1,2}[-/ ](?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*[-/ ]\d{2,4}$/i;
/** ⚠️ Indian grouping, `1,23,456.78`, as well as the western one. */
const MONEY = /^-?(?:\d{1,3}(?:,\d{2,3})*|\d+)(?:\.\d{1,4})?$/;
const INTEGER = /^-?\d{1,15}$/;
const BOOLEAN = /^(?:true|false|yes|no|y|n|1|0)$/i;
const URL = /^https?:\/\/\S+$/i;

/**
 * ⚠️ ORDER MATTERS AND IT IS NOT ALPHABETICAL. Every GSTIN also matches
 * nothing else here, but every PINCODE also matches INTEGER and every
 * HSN also matches INTEGER, so the specific tests run first. Reversing
 * this makes every code column look like a number, which is exactly the
 * mistake a spreadsheet makes.
 */
const TESTS: readonly (readonly [ValueShape, RegExp])[] = [
  ["gstin", GSTIN],
  ["ifsc", IFSC],
  ["pan", PAN],
  ["email", EMAIL],
  ["url", URL],
  ["iso_date", ISO_DATE],
  ["civil_date", CIVIL_DATE],
  /* ⭐ After ISO_DATE and before INTEGER, for the reason this table already
   * gives: the specific tests run first or every code column looks like a
   * number. Same shape as the line above, a different spelling of it. */
  ["civil_date", MONTH_NAME_DATE],
  ["pincode_in", PINCODE_IN],
  ["hsn", HSN],
  ["phone_in", PHONE_IN],
  ["boolean", BOOLEAN],
  ["integer", INTEGER],
  ["money", MONEY],
];

export function shapeOf(value: string): ValueShape | null {
  const trimmed = value.trim();
  if (trimmed === "") return "blank";
  for (const [shape, pattern] of TESTS) {
    if (pattern.test(trimmed)) return shape;
  }
  return null;
}

export type ColumnEvidence = {
  /** How many non-blank values were looked at. */
  readonly sampled: number;
  readonly blanks: number;
  /**
   * ⭐ THE DOMINANT SHAPE AND ITS SHARE OF THE NON-BLANK VALUES.
   * `null` when nothing dominates — free text, or a column holding two
   * different things, which is itself worth knowing.
   */
  readonly shape: ValueShape | null;
  readonly share: number;
  /** Longest value seen. Used to warn about a `maxLength` before the run. */
  readonly longest: number;
  /** Distinct non-blank values, capped. A natural key wants this high. */
  readonly distinct: number;
};

/**
 * ⚠️ A SAMPLE, NOT THE WHOLE COLUMN. Fifty thousand rows × forty columns
 * is two million regex passes to draw a conclusion that two hundred rows
 * already support. The sample size is stated because a conclusion drawn
 * from a sample is a different claim from one drawn from everything, and
 * `lib/import/proposal.ts` caps its confidence accordingly.
 */
export const EVIDENCE_SAMPLE_ROWS = 200;

export function evidenceFor(values: readonly string[]): ColumnEvidence {
  const sample = values.slice(0, EVIDENCE_SAMPLE_ROWS);
  const counts = new Map<ValueShape, number>();
  const distinct = new Set<string>();
  let blanks = 0;
  let longest = 0;
  let nonBlank = 0;

  for (const value of sample) {
    const trimmed = value.trim();
    if (trimmed === "") {
      blanks += 1;
      continue;
    }
    nonBlank += 1;
    longest = Math.max(longest, trimmed.length);
    if (distinct.size < 1000) distinct.add(trimmed.toLowerCase());
    const shape = shapeOf(trimmed);
    if (shape && shape !== "blank") counts.set(shape, (counts.get(shape) ?? 0) + 1);
  }

  let shape: ValueShape | null = null;
  let best = 0;
  for (const [candidate, count] of counts) {
    if (count > best) {
      best = count;
      shape = candidate;
    }
  }

  /**
   * 🔴 A SHAPE IS ONLY CLAIMED WHEN IT IS OVERWHELMING. At 60% the column
   * is mixed and calling it a GSTIN column would send a proposal into
   * auto-commit on the strength of half the values. Below the threshold
   * the evidence is "no dominant shape", which is honest and useful.
   */
  const share = nonBlank === 0 ? 0 : best / nonBlank;
  return {
    sampled: sample.length,
    blanks,
    shape: share >= 0.9 ? shape : null,
    share,
    longest,
    distinct: distinct.size,
  };
}

/** ⭐ Which entity-column kinds a shape is evidence FOR. */
export const SHAPE_SUGGESTS: Readonly<Record<ValueShape, readonly string[]>> = Object.freeze({
  gstin: ["gstin"],
  pan: ["pan"],
  email: ["email"],
  phone_in: ["phone", "mobile"],
  ifsc: ["ifsc"],
  pincode_in: ["postalCode", "pincode"],
  hsn: ["hsn", "hsnCode", "sac"],
  iso_date: ["date"],
  civil_date: ["date"],
  money: ["money"],
  integer: ["integer"],
  boolean: ["boolean"],
  url: ["website", "url"],
  blank: [],
});
