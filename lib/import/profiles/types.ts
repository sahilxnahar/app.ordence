/**
 * Ordence — ⭐⭐⭐ A SOURCE PROFILE IS DATA ABOUT A SYSTEM, NOT A PARSER FOR IT
 * Version: v1.84.1-alpha · Phase 9
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE FILE THIS ONE EXISTS INSTEAD OF
 * ══════════════════════════════════════════════════════════════════════
 * The version written under pressure is `importFromZoho(file)`. It ships
 * in a day and it is correct on the two exports it was written against.
 * The second adapter is a copy of the first with the field names changed,
 * so the CSV reader is now duplicated and the two copies have already
 * drifted on quoting. The third is a rewrite, because by then nobody can
 * say which of the two readers is the real one.
 *
 * `lib/import/types.ts` makes this argument at length about ENTITIES and
 * reaches the same answer: the thing that varies is DECLARED, and one
 * engine reads the declaration. This file is that argument applied to
 * source systems.
 *
 * ⭐ SO A PROFILE HAS NO BEHAVIOUR. It is a record of five facts about
 * one accounting package:
 *
 *   ① the header spellings it writes
 *   ② the date format it writes
 *   ③ how it represents a negative amount
 *   ④ what it calls its files
 *   ⑤ which of its exports corresponds to which Ordence entity
 *
 * Everything that RUNS lives in `dates.ts`, `amounts.ts` and `detect.ts`,
 * is generic over every profile, and gets no larger when the eighth
 * system is added. If a profile ever needs code of its own, that is a
 * finding to report — see `PATCH-REQUEST-PHASE-9.md` — and not a licence
 * to write it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 AND A PROFILE MAY NOT OVERRULE `lib/import/shapes.ts`
 * ══════════════════════════════════════════════════════════════════════
 * `shapes.ts` scores evidence from the VALUES, and it exists because a
 * column HEADED "GSTIN" that turns out to hold PANs is a real and common
 * file. A profile is a claim about what a system USUALLY writes; the
 * values in front of us are a fact about what this file ACTUALLY holds.
 *
 * The rule is enforced structurally rather than by intention:
 *
 *   • nothing here returns a field assignment. `detect.ts` returns an
 *     identification and a set of PRIORS.
 *   • every prior is resolved by testing it against the file's own
 *     values (`resolveDateFormat`, `resolveNegativeStyle`), and the
 *     result carries `settledBy`, which says whether the VALUES decided
 *     or whether the profile was merely assumed.
 *   • header priors are handed out through `priors.ts`, which documents
 *     the score band they must occupy — strictly below
 *     `SCORE.DECISIVE_SHAPE`. ⚠️ They must NOT be merged into
 *     `ImportColumn.aliases`; `PATCH-REQUEST-PHASE-9.md` §1 measures what
 *     happens if they are, because `SCORE.ALIAS` is 0.95 and
 *     `SCORE.DECISIVE_SHAPE` is 0.90.
 *
 * ⚠️ PURE, AND NO NETWORK. Every module in this directory runs in the
 * browser preview and in a test. No database import — rule 7.
 */

/* ------------------------------------------------------------------ */
/* ① HOW THIS PROFILE CAME TO BE WRITTEN                              */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE MEMBER THAT MAKES "SUPPORTED" A CLAIM RATHER THAN A WORD
 * ══════════════════════════════════════════════════════════════════════
 * "Zoho supported" is a sentence a customer reads as "my Zoho export will
 * work". "Zoho profile written from published documentation, not
 * validated against a real export" is a sentence they can act on: they
 * know to check the first file rather than the four-hundredth row.
 *
 * ⭐ SO THE QUALIFIER IS A REQUIRED MEMBER AND IT REACHES THE SCREEN.
 * `describeProfileDetection` puts `notValidated` into the notes the
 * wizard already renders, so it cannot be dropped by whoever writes the
 * marketing page — the same reason `ImportContract.because` is required
 * rather than optional.
 *
 * ⚠️ AND `real-export` IS DELIBERATELY HARD TO CLAIM. It means somebody
 * put a file that came out of that system through `readSource` and looked
 * at the rows. A fixture generated to match this profile proves that the
 * profile agrees with itself, which is the definition of verified by a
 * floor.
 */
export type ProfileValidation =
  | {
      readonly against: "real-export";
      /** Which file, and where the reader can find the evidence. */
      readonly evidence: string;
    }
  | {
      readonly against: "independent-fixture";
      /**
       * A fixture that was NOT written to match this profile — it
       * predates it, or it was written from the system's own output.
       */
      readonly evidence: string;
      readonly notValidated: string;
    }
  | {
      readonly against: "published-documentation";
      readonly evidence: string;
      /** 🔴 The sentence that must appear next to the word "supported". */
      readonly notValidated: string;
    };

export const PROFILE_VALIDATION_KINDS = [
  "real-export",
  "independent-fixture",
  "published-documentation",
] as const;

/* ------------------------------------------------------------------ */
/* ② WHERE ONE OF ITS EXPORTS GOES                                    */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 BUILT, OFFERED, UNREACHABLE — THE HAZARD THIS TYPE REFUSES
 * ══════════════════════════════════════════════════════════════════════
 * `lib/import/contract/worked-example.ts` keeps a complete `contacts`
 * entity OUT of `ALL_IMPORT_ENTITIES` on purpose, because the write path
 * dispatches with `if` chains and an unhandled destination compiles
 * cleanly and falls through at runtime. Registering it would put it in
 * the customer's picker and let them upload a file that goes nowhere.
 *
 * A profile is the same hazard one level up. Six of the seven systems
 * here export invoices, bills and stock; the entities for those are
 * phases 5 to 8 and are not written. A profile that named
 * `sales-invoices` as a destination would describe a route that does not
 * exist, and the first thing built on top of these profiles — a wizard
 * that lists "what we can take from your Zoho export" — would offer it.
 *
 * ⭐ SO A DESTINATION IS A DISCRIMINATED UNION AND `not-yet-importable`
 * IS A FIRST-CLASS ANSWER. `lib/import/profiles/check.ts` refuses an
 * `entity` destination whose key is not in `ALL_IMPORT_ENTITIES`, and
 * refuses a `not-yet-importable` destination that names a key which IS —
 * because that is what this member looks like after the phase that built
 * it forgot to come back.
 */
export type ProfileDestination =
  | {
      readonly kind: "entity";
      /** A key in `ALL_IMPORT_ENTITIES`. Checked, not assumed. */
      readonly entity: string;
    }
  | {
      readonly kind: "not-yet-importable";
      /**
       * What it WOULD be. A string, deliberately — this is a plan, and a
       * plan that typechecks against a registry it is not in would have
       * to be added to that registry to compile.
       */
      readonly plannedEntity: string;
      /** Shown to the customer. "Ordence cannot take this yet because…" */
      readonly because: string;
    };

/* ------------------------------------------------------------------ */
/* ③ A HEADER SPELLING                                                */
/* ------------------------------------------------------------------ */

/**
 * One column heading this system writes, and the Ordence field it is a
 * spelling OF.
 *
 * ⚠️ `spelling` IS THE HEADING AS THE SYSTEM WRITES IT, punctuation and
 * all. `lib/import/mapping.ts` normalises aggressively — `Company Name`,
 * `company_name` and `COMPANY NAME` already collapse to one string — so
 * recording three casings of the same words would be three copies of one
 * fact. What belongs here is a genuinely different WORD: `Party Name`,
 * `Display Name`, `Account Name`.
 *
 * ⚠️ AND `field` IS CHECKED. `check.ts` refuses a field that the
 * destination entity does not have, which is what a rename on the entity
 * side looks like from here.
 */
export type ProfileHeader = {
  readonly spelling: string;
  readonly field: string;
};

/* ------------------------------------------------------------------ */
/* ④ ONE EXPORT THE SYSTEM PRODUCES                                   */
/* ------------------------------------------------------------------ */

export type ProfileExport = {
  /** Stable within the profile. Used in messages and in the run record. */
  readonly id: string;
  /** What the customer's screen in THAT system calls it. */
  readonly title: string;
  readonly destination: ProfileDestination;
  /**
   * ⭐⭐ THE HEADERS THAT IDENTIFY THIS EXPORT AND NOTHING ELSE.
   *
   * ⚠️ NOT "the headers it has" — the headers that, present TOGETHER,
   * are not a coincidence. `Name` is in every export ever written and is
   * evidence of nothing; `Display Name` + `Company Name` + `GST Treatment`
   * together are a Zoho Books contacts export.
   *
   * 🔴 AT LEAST TWO, ENFORCED BY `check.ts`. A one-header signature is a
   * profile that fires on any file containing that word, which is worse
   * than no profile at all: it produces a confident wrong prior instead
   * of an honest absent one.
   */
  readonly signature: readonly string[];
  readonly headers: readonly ProfileHeader[];
  /** Lower-case fragments of the file name this export usually arrives as. */
  readonly fileNameHints: readonly string[];
  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THE FIELDS THE DESTINATION REQUIRES THAT THIS EXPORT DOES NOT
   *    HAVE A COLUMN FOR
   * ══════════════════════════════════════════════════════════════════
   * ⭐ THE MEMBER THAT STOPS "SUPPORTED" FROM MEANING "WILL WORK".
   *
   * A Tally trial balance has `Particulars`, `Debit` and `Credit`. It has
   * no account code and no as-at date, because both live in the report's
   * TITLE rather than in a column. `opening-trial-balance` requires both.
   * So a profile that claimed to map that export would be describing a
   * route that fails on the first row of every real file, and the
   * customer would find out after uploading rather than before.
   *
   * ⚠️ IT IS DECLARED HERE AND PROVED BY `check.ts`, WHICH REFUSES A LIST
   * THAT IS NOT EXACTLY WHAT IT COMPUTES from `ALL_IMPORT_ENTITIES`. Both
   * directions are refused, and the second one is the one that matters:
   * an entity that later gains a required column makes every profile's
   * list wrong, and a member that only had to be a SUBSET would go on
   * reading as complete. `check.ts` is `lib/import/contract/check.ts`'s
   * discipline applied one layer out.
   *
   * ⚠️ MUST BE EMPTY FOR A `not-yet-importable` DESTINATION — there is no
   * entity to compute it against, and a non-empty list there would be a
   * claim about a registry the key is not in.
   */
  readonly missingRequired: readonly string[];
};

/* ------------------------------------------------------------------ */
/* ⑤ THE PROFILE                                                       */
/* ------------------------------------------------------------------ */

export type SourceProfile = {
  readonly key: string;
  readonly label: string;
  readonly vendor: string;
  /** 🔴 Required. See `ProfileValidation`. */
  readonly validation: ProfileValidation;
  /**
   * ⭐ ORDERED, MOST LIKELY FIRST, AND NEVER AUTHORITATIVE. These are the
   * candidate formats `resolveDateFormat` tries BEFORE the rest — the
   * order changes which format wins a tie, and a tie is precisely the
   * case where the answer has to be reported as assumed rather than
   * settled.
   */
  readonly dateFormats: readonly CivilDateFormatKey[];
  readonly negativeStyles: readonly NegativeStyleKey[];
  readonly exports: readonly ProfileExport[];
  readonly fileNameHints: readonly string[];
  /** Sentences worth showing. Each one has to be about THIS system. */
  readonly notes: readonly string[];
  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THE FALLBACK — "a spreadsheet, and nothing said which system"
   * ══════════════════════════════════════════════════════════════════
   * Exactly one profile carries this, and it is a different KIND of
   * thing from the other six: it has no signature, no header spellings
   * and no format priors, because it is the answer when no evidence was
   * found rather than a claim about a system.
   *
   * ⚠️ IT IS A MEMBER RATHER THAN AN ENTRY ON AN EXEMPTION LIST IN
   * `check.ts`. The rules that follow from it — a fallback may not carry
   * priors, and a non-fallback must have at least one export — are then
   * checkable statements about the data instead of a name somebody
   * remembered to add to a list. This project's grandfather lists only
   * ever grow; a structural distinction cannot.
   *
   * ⭐ AND IT IS NOT `null`. "Ordence looked and recognised nothing" and
   * "nothing ever looked" are different facts, and only the first one
   * means the file is genuinely unlike the six systems we know.
   */
  readonly fallback: boolean;
};

/* ------------------------------------------------------------------ */
/* THE TWO VOCABULARIES THE PROFILES DRAW ON                           */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ DECLARED HERE RATHER THAN IN `dates.ts` SO THAT `types.ts` HAS NO
 * IMPORTS. A data file that has to import an engine to describe itself is
 * one refactor away from being an engine.
 */
export type CivilDateFormatKey =
  /** `2026-04-01`. The only one `coerceCivilDay` accepts unaided. */
  | "iso"
  /** `01/04/2026` — day first. */
  | "dmy-slash"
  /** `04/01/2026` — month first. Same eight characters, other day. */
  | "mdy-slash"
  | "dmy-dash"
  | "mdy-dash"
  /** `01.04.2026`, which German-influenced exports and Marg both write. */
  | "dmy-dot"
  /** `1-Apr-2026`. Tally's own display format and Busy's default. */
  | "d-mon-yyyy"
  /** `1-Apr-26`. 🔴 The century is a guess — see `dates.ts`. */
  | "d-mon-yy"
  /** `20260401`. What Tally writes inside its XML. */
  | "yyyymmdd";

export type NegativeStyleKey =
  /** `-1234.00`. */
  | "leading-minus"
  /** `1234.00-`. Written by several older ERPs and by SAP exports. */
  | "trailing-minus"
  /** `(1,234.00)`. Accounting convention, and the one Excel formats to. */
  | "parentheses"
  /** `1234.00 Cr`. A credit, which in a balance column is a negative. */
  | "cr-suffix"
  /** `1234.00 Dr` / `1234.00 Cr` — both markers present. */
  | "dr-cr-suffix";
