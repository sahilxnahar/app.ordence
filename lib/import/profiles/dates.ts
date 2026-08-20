/**
 * Ordence — ⭐⭐⭐ WHICH DATE FORMAT THIS COLUMN IS IN, AND WHO DECIDED
 * Version: v1.84.1-alpha · Phase 9
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `coerceCivilDay` REFUSES TO GUESS, AND IT IS RIGHT TO
 * ══════════════════════════════════════════════════════════════════════
 * `lib/import/values.ts` accepts `YYYY-MM-DD` and nothing else, and says
 * why: `01/02/2026` is 2 January in India and 1 February in the United
 * States, both readings are valid, nothing in the file says which was
 * meant, and in this product the consequence is not cosmetic —
 * `gst_parties.effective_from` decides whether a supply was B2B or B2C.
 *
 * ⚠️ THIS MODULE DOES NOT RELAX THAT RULE. It supplies the missing
 * sentence — "this column is in day-first order, and here is what
 * established that" — so the value handed to `coerceCivilDay` is already
 * ISO and the refusal never has to fire. Nothing here is reached by a
 * cell that is already ISO.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ AND THE PROFILE DOES NOT GET TO BE THE SENTENCE
 * ══════════════════════════════════════════════════════════════════════
 * This is the date half of the rule the whole phase is under: A PROFILE
 * RAISES A PRIOR, THE VALUES SETTLE IT.
 *
 *   `13/02/2026`  🔴 SETTLED BY THE VALUES. There is no thirteenth
 *                 month, so the column is day-first whatever any profile
 *                 believes, and whatever a model proposed.
 *
 *   `01/02/2026`  ⚠️ NOT SETTLED. Two formats explain every value in the
 *                 column. The profile's order breaks the tie, the result
 *                 is marked `settledBy: "profile-prior"`, and the
 *                 sentence says it was assumed — because a customer who
 *                 is told "assumed day-first, nothing in this column
 *                 proves it" checks one cell, and a customer who is told
 *                 nothing finds out in a tax return.
 *
 * A profile whose prior contradicts the values loses outright: the prior
 * is only ever consulted among formats that already explain EVERY value.
 *
 * ⚠️ PURE. No `Date` arithmetic beyond a UTC round-trip, no `Intl`, no
 * locale lookup, no clock.
 */

import { EVIDENCE_SAMPLE_ROWS } from "../shapes";
import type { CivilDateFormatKey } from "./types";

export const CIVIL_DATE_FORMATS = [
  "iso",
  "dmy-slash",
  "mdy-slash",
  "dmy-dash",
  "mdy-dash",
  "dmy-dot",
  "d-mon-yyyy",
  "d-mon-yy",
  "yyyymmdd",
] as const;

export function isCivilDateFormatKey(value: unknown): value is CivilDateFormatKey {
  return (CIVIL_DATE_FORMATS as readonly string[]).includes(value as string);
}

/** How each format is described to a non-technical reader, with an example. */
export const CIVIL_DATE_FORMAT_LABELS: Readonly<Record<CivilDateFormatKey, string>> = Object.freeze({
  iso: "year-month-day (2026-04-01)",
  "dmy-slash": "day-first with slashes (01/04/2026)",
  "mdy-slash": "month-first with slashes (04/01/2026)",
  "dmy-dash": "day-first with dashes (01-04-2026)",
  "mdy-dash": "month-first with dashes (04-01-2026)",
  "dmy-dot": "day-first with dots (01.04.2026)",
  "d-mon-yyyy": "day, month name, four-digit year (1-Apr-2026)",
  "d-mon-yy": "day, month name, two-digit year (1-Apr-26)",
  yyyymmdd: "eight digits, year first (20260401)",
});

/**
 * ⚠️ ENGLISH ABBREVIATIONS ONLY, AND THAT IS A STATED LIMIT RATHER THAN
 * AN OVERSIGHT. Tally, Busy, Marg, Zoho, QuickBooks and Xero all write
 * English month names in their exports regardless of the interface
 * language. A Hindi or Gujarati month name is not read here; it falls out
 * as "no format explains this column", which is the honest answer and is
 * visible, rather than a silent mis-parse.
 */
const MONTHS: Readonly<Record<string, number>> = Object.freeze({
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
});

/**
 * 🔴 THE CENTURY PIVOT, WRITTEN DOWN BECAUSE IT IS A GUESS.
 *
 * `1-Apr-26` is 2026 in every accounting export anybody will upload, and
 * `1-Apr-98` is 1998. There is no evidence in two digits that says so —
 * this is a convention, it is the one every other system uses, and a
 * column read under it carries a caution rather than passing silently.
 */
const CENTURY_PIVOT = 69;

export type DateParse =
  | { readonly ok: true; readonly iso: string; readonly centuryAssumed: boolean }
  | { readonly ok: false; readonly message: string };

/**
 * ⚠️ A SHAPE CHECK IS NOT A CALENDAR CHECK — the same trap
 * `coerceCivilDay` names. `31/02/2026` matches every day-first pattern
 * here and is not a day. Every branch ends at `assemble`, which
 * round-trips through UTC and refuses what does not come back.
 */
function assemble(
  year: number,
  month: number,
  day: number,
  raw: string,
  centuryAssumed: boolean,
): DateParse {
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1000 || year > 9999) {
    return { ok: false, message: `"${raw}" is not a real date.` };
  }
  const pad = (n: number, width: number) => String(n).padStart(width, "0");
  const iso = `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
  const probe = new Date(`${iso}T00:00:00Z`);
  const roundTrips =
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() + 1 === month &&
    probe.getUTCDate() === day;
  if (!roundTrips) return { ok: false, message: `"${raw}" is not a real date.` };
  return { ok: true, iso, centuryAssumed };
}

const NUMERIC = {
  slash: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
  dash: /^(\d{1,2})-(\d{1,2})-(\d{4})$/,
  dot: /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/,
} as const;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const COMPACT_RE = /^(\d{4})(\d{2})(\d{2})$/;
const MON_RE = /^(\d{1,2})[-/ ]([A-Za-z]{3,4})[-/ ](\d{2}|\d{4})$/;

/**
 * ⭐ ONE FORMAT, ONE STRING, ONE ANSWER. Nothing here inspects a
 * neighbouring value: that is `resolveCivilDateFormat`'s job, and keeping
 * the two apart is what lets the resolver test a format by ASKING this
 * function about every value rather than by re-implementing it.
 */
export function applyCivilDateFormat(raw: string, format: CivilDateFormatKey): DateParse {
  const value = raw.trim();
  if (value === "") return { ok: false, message: "This cell is empty." };

  const refuse: DateParse = {
    ok: false,
    message: `"${value}" is not written as ${CIVIL_DATE_FORMAT_LABELS[format]}.`,
  };

  switch (format) {
    case "iso": {
      const m = ISO_RE.exec(value);
      if (!m) return refuse;
      return assemble(Number(m[1]), Number(m[2]), Number(m[3]), value, false);
    }
    case "yyyymmdd": {
      const m = COMPACT_RE.exec(value);
      if (!m) return refuse;
      return assemble(Number(m[1]), Number(m[2]), Number(m[3]), value, false);
    }
    case "dmy-slash":
    case "mdy-slash":
    case "dmy-dash":
    case "mdy-dash":
    case "dmy-dot": {
      const separator = format.endsWith("slash")
        ? NUMERIC.slash
        : format.endsWith("dash")
          ? NUMERIC.dash
          : NUMERIC.dot;
      const m = separator.exec(value);
      if (!m) return refuse;
      const first = Number(m[1]);
      const second = Number(m[2]);
      const year = Number(m[3]);
      const dayFirst = format.startsWith("dmy");
      return assemble(year, dayFirst ? second : first, dayFirst ? first : second, value, false);
    }
    case "d-mon-yyyy":
    case "d-mon-yy": {
      const m = MON_RE.exec(value);
      if (!m) return refuse;
      const wantsTwo = format === "d-mon-yy";
      const yearText = m[3] ?? "";
      if ((yearText.length === 2) !== wantsTwo) return refuse;
      const month = MONTHS[(m[2] ?? "").toLowerCase()];
      if (month === undefined) {
        return {
          ok: false,
          message:
            `"${value}" has a month name Ordence does not recognise. Month names are read in ` +
            `English (Jan, Feb, Mar …).`,
        };
      }
      const twoDigit = Number(yearText);
      const year = wantsTwo ? (twoDigit <= CENTURY_PIVOT ? 2000 + twoDigit : 1900 + twoDigit) : twoDigit;
      return assemble(year, month, Number(m[1]), value, wantsTwo);
    }
  }
}

/* ------------------------------------------------------------------ */
/* ⭐⭐⭐ THE RESOLVER                                                  */
/* ------------------------------------------------------------------ */

export type DateResolutionBasis =
  /** 🔴 Exactly one format explains every value. Nothing can overrule this. */
  | "values"
  /** ⚠️ Several do, and the profile's order broke the tie. Assumed. */
  | "profile-prior"
  /** Several do and no profile has an opinion. The customer must say. */
  | "unresolved"
  /** No format explains every value — mixed, or something else entirely. */
  | "unreadable"
  /** The column is empty. */
  | "no-values";

export type DateResolution = {
  readonly format: CivilDateFormatKey | null;
  readonly settledBy: DateResolutionBasis;
  /** Every format that explains EVERY sampled value, in canonical order. */
  readonly candidates: readonly CivilDateFormatKey[];
  readonly sampled: number;
  /** One sentence a non-technical person can read and check. */
  readonly why: string;
  /**
   * 🔴 SET WHENEVER THE ANSWER IS AN ASSUMPTION RATHER THAN A READING.
   * The wizard shows this next to the column; a run that commits with a
   * caution unread is the failure this member exists to make visible.
   */
  readonly caution: string | null;
};

/**
 * ⚠️ THE SAME SAMPLE SIZE AS `lib/import/shapes.ts`, IMPORTED RATHER THAN
 * RESTATED. Two modules drawing conclusions about the same column from
 * different numbers of rows would eventually disagree about the same
 * file, and the disagreement would be invisible.
 */
export function resolveCivilDateFormat(
  values: readonly string[],
  priors: readonly CivilDateFormatKey[] = [],
): DateResolution {
  const sample = values.slice(0, EVIDENCE_SAMPLE_ROWS).map((v) => v.trim()).filter((v) => v !== "");

  if (sample.length === 0) {
    return {
      format: null,
      settledBy: "no-values",
      candidates: [],
      sampled: 0,
      why: "This column has no values in it, so there is nothing to read a date format from.",
      caution: null,
    };
  }

  /**
   * ⭐ A FORMAT IS A CANDIDATE ONLY IF IT EXPLAINS EVERY VALUE. Not most.
   * A column that is 95% day-first and 5% something else is a column with
   * two things in it, and picking the majority silently converts the
   * other 5% into wrong dates rather than into failed rows.
   */
  const readings = new Map<CivilDateFormatKey, string[]>();
  const eliminatedBy = new Map<CivilDateFormatKey, string>();

  for (const format of CIVIL_DATE_FORMATS) {
    const out: string[] = [];
    let failed: string | null = null;
    for (const value of sample) {
      const parsed = applyCivilDateFormat(value, format);
      if (!parsed.ok) {
        failed = value;
        break;
      }
      out.push(parsed.iso);
    }
    if (failed === null) readings.set(format, out);
    else eliminatedBy.set(format, failed);
  }

  const candidates = [...readings.keys()];

  if (candidates.length === 0) {
    const seen = sample.slice(0, 3).map((v) => `"${v}"`).join(", ");
    return {
      format: null,
      settledBy: "unreadable",
      candidates: [],
      sampled: sample.length,
      why:
        `No single date format explains every value in this column. The first values are ` +
        `${seen}. A column holding two different date formats has to be fixed in the file — ` +
        `reading it under either one would silently convert the other.`,
      caution:
        "Ordence will not guess a date format for this column. Fix the file, or map this " +
        "column to nothing.",
    };
  }

  /**
   * ══════════════════════════════════════════════════════════════════
   * ⭐⭐ AMBIGUITY IS REPORTED ONLY WHEN THE READINGS DISAGREE ABOUT
   *     THIS FILE
   * ══════════════════════════════════════════════════════════════════
   * A column of `01/01/2026`, `02/02/2026`, `03/03/2026` is explained by
   * both day-first and month-first, and BOTH GIVE THE SAME DAYS. Raising
   * "this column is ambiguous" there would be true and useless: there is
   * no decision for the customer to make, and a caution that never means
   * anything is how the caution that does mean something gets clicked
   * past. Readings are therefore collapsed by what they PRODUCE over the
   * sample, and only a genuine disagreement about the customer's own
   * dates survives to be reported.
   */
  const distinct = new Map<string, CivilDateFormatKey[]>();
  for (const [format, out] of readings) {
    const fingerprint = out.join(" ");
    distinct.set(fingerprint, [...(distinct.get(fingerprint) ?? []), format]);
  }

  if (distinct.size === 1) {
    const format = candidates[0]!;
    const agreeing = candidates.filter((c) => c !== format);
    /**
     * ⭐ NAME THE VALUE THAT DID IT. "Day-first" is an assertion; "day-first,
     * because 13/02/2026 has no thirteenth month" is a sentence the customer
     * can check in ten seconds against their own file.
     */
    const rival = format.startsWith("dmy")
      ? (["mdy-slash", "mdy-dash"] as const).find((r) => eliminatedBy.has(r))
      : format.startsWith("mdy")
        ? (["dmy-slash", "dmy-dash"] as const).find((r) => eliminatedBy.has(r))
        : undefined;
    const decisive = rival ? eliminatedBy.get(rival) : undefined;
    return {
      format,
      settledBy: "values",
      candidates,
      sampled: sample.length,
      why:
        `This column is in ${CIVIL_DATE_FORMAT_LABELS[format]}. That was read from the values ` +
        `themselves` +
        (decisive
          ? `: "${decisive}" cannot be ${CIVIL_DATE_FORMAT_LABELS[rival!]}, so the other reading ` +
            `is impossible.`
          : agreeing.length > 0
            ? `, and every other reading Ordence knows gives the same days for this column.`
            : `, which nothing else explains.`) +
        ` ${sample.length} value${sample.length === 1 ? "" : "s"} were looked at.`,
      caution:
        format === "d-mon-yy"
          ? `Two-digit years are read as 20xx up to ${CENTURY_PIVOT} and 19xx above it, which is ` +
            `a convention rather than something the file says. Check any date before 1970.`
          : null,
    };
  }

  /**
   * ══════════════════════════════════════════════════════════════════
   * ⚠️ MORE THAN ONE FORMAT FITS. THE PROFILE BREAKS THE TIE AND THE
   * ANSWER IS LABELLED AS ASSUMED.
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THE PRIOR IS CONSULTED ONLY AMONG FORMATS THAT ALREADY EXPLAIN
   * EVERY VALUE. A profile claiming month-first for a column containing
   * `13/02/2026` never reaches this branch — `mdy-slash` was eliminated
   * above by that value. This is the whole subordination rule in one
   * line: the prior chooses between readings the data permits, and can
   * never introduce one the data forbids.
   */
  const prior = priors.find((p) => candidates.includes(p));
  const others = candidates.filter((c) => c !== prior);
  const example = sample.find((v) => /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(v)) ?? sample[0]!;

  if (!prior) {
    return {
      format: null,
      settledBy: "unresolved",
      candidates,
      sampled: sample.length,
      why:
        `This column could be ${candidates.map((c) => CIVIL_DATE_FORMAT_LABELS[c]).join(" or ")}. ` +
        `Every value fits both readings — "${example}" is a real date either way — and no source ` +
        `system was recognised, so nothing here can tell them apart.`,
      caution:
        `Say which order this column is in before committing. Reading ${example} the wrong way ` +
        `round moves it to a different month.`,
    };
  }

  return {
    format: prior,
    settledBy: "profile-prior",
    candidates,
    sampled: sample.length,
    why:
      `This column has been read as ${CIVIL_DATE_FORMAT_LABELS[prior]} because that is what the ` +
      `source system this file was recognised as writes.`,
    caution:
      `Nothing in this column proves that. "${example}" is also a real date read as ` +
      `${others.map((c) => CIVIL_DATE_FORMAT_LABELS[c]).join(" or ")}. Check one date against ` +
      `your own records before committing.` +
      (prior === "d-mon-yy"
        ? ` Two-digit years are read as 20xx up to ${CENTURY_PIVOT} and 19xx above it.`
        : ""),
  };
}
