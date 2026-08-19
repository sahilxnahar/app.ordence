/**
 * Ordence — ⭐⭐⭐ A REGISTER IS A POINT-IN-TIME DOCUMENT
 * Version: v1.50.0-alpha · Batch 76
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE PROBLEM NOBODY NOTICES UNTIL IT MATTERS
 * ══════════════════════════════════════════════════════════════════════
 * A register is printed, signed and produced to an inspector. Six months
 * later somebody regenerates "Wage register — April 2026" and gets
 * different figures, because a payroll run was cancelled and re-run, an
 * employee's name was corrected, an attendance day was regularised, or a
 * statutory rate was corrected under `correctStatutoryRate`.
 *
 * TWO DOCUMENTS, THE SAME TITLE, DIFFERENT CONTENTS, AND NOTHING ON
 * EITHER OF THEM SAYS SO. That is the worst possible failure mode for a
 * compliance artefact: the employer cannot prove which one they produced,
 * and an inspector holding the older one has caught them in what looks
 * like a fabrication.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ HOW THIS BATCH HANDLES IT — THREE THINGS, NO NEW TABLE
 * ══════════════════════════════════════════════════════════════════════
 * ① A STATED BASIS. Every document lists exactly what it was built from
 *    — the run numbers and their statuses, the date range, the number of
 *    employees considered. Two documents built from different bases are
 *    visibly different documents even before you compare the figures.
 *
 * ② A CONTENT DIGEST, PRINTED ON THE FACE. Sixteen hex characters over
 *    the canonical form of every column heading and every cell. Two
 *    prints that agree carry the same digest; two that differ cannot.
 *    An inspector holding a printout and an employer regenerating it can
 *    settle in five seconds whether it is the same document.
 *
 * ③ AN HONEST STATUS, WHICH IS THE PART THAT ACTUALLY PREVENTS THE
 *    PROBLEM RATHER THAN DETECTING IT:
 *
 *      final       — every fact behind it is frozen. A wage register
 *                    over approved or posted runs only. Regenerating it
 *                    reproduces it, because payslips are written once
 *                    and never recomputed.
 *      provisional — some fact behind it can still change. Printed in
 *                    those words, on the document, at the top.
 *      snapshot    — drawn from live mutable records (the employee
 *                    register is, always). It is a photograph of today
 *                    and says so.
 *
 * 🔴 A DRAFT OR COMPUTED PAYROLL RUN THEREFORE CANNOT PRODUCE A `final`
 * WAGE REGISTER. Its figures move when somebody hits recompute. It still
 * generates — refusing would push people to a spreadsheet — but it is
 * stamped PROVISIONAL and the reason names the runs that are not settled.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT I WANTED AND DID NOT BUILD
 * ══════════════════════════════════════════════════════════════════════
 * An `issued registers` table — kind, period, rule set, digest, the
 * rendered rows as jsonb, issued_at, issued_by — so a register that was
 * actually produced to somebody is recoverable byte-for-byte, and so the
 * product could say "this differs from the copy you issued on 14 May".
 * That is a schema change and this batch writes no SQL. Reported.
 *
 * Until it exists the digest is a comparison tool for a human holding
 * both copies, not a stored record. That is a real limitation and it is
 * printed on the document rather than left in a comment.
 */

import type { RegisterColumn, RegisterSpec } from "./spec";
import type { RegisterKind } from "./forms";

/**
 * ⭐ A CELL IS `string | null` AND `null` IS LOAD-BEARING.
 *
 * 🔴 `null` MEANS "NOT RECORDED" AND IS RENDERED AS A NAMED BLANK.
 * `"0"` and `"0.00"` mean the value is known and is nothing. Collapsing
 * the two is the single defect this whole module exists to prevent, so
 * the type keeps them apart all the way to the renderer.
 */
export type RegisterCell = string | null;

export interface RegisterRow {
  /** Stable within the document; used for React keys and for the digest. */
  readonly key: string;
  readonly cells: Readonly<Record<string, RegisterCell>>;
}

export type RegisterStatus = "final" | "provisional" | "snapshot";

/** A statutory column with nothing behind it, named on the document. */
export interface RegisterGap {
  readonly columnId: string;
  readonly label: string;
  readonly why: string;
}

export interface RegisterDocument {
  readonly kind: RegisterKind;
  readonly title: string;
  /** `null` when the chosen rule set carries no number for this register. */
  readonly formNumber: string | null;
  readonly ruleSetId: string;
  readonly ruleSetLabel: string;
  readonly citationLine: string;
  /** ⚠️ Whether the form numbering above is one we stand behind. */
  readonly formNumberIsEncoded: boolean;

  readonly periodFrom: string | null;
  readonly periodTo: string | null;
  /** Asia/Kolkata civil date. Never a `toISOString()` slice. */
  readonly generatedOn: string;

  readonly status: RegisterStatus;
  readonly statusReason: string;

  readonly columns: readonly RegisterColumn[];
  readonly rows: readonly RegisterRow[];

  /** Every statutory column left blank, with the reason. */
  readonly gaps: readonly RegisterGap[];
  /** Exactly what this was built from, in sentences. */
  readonly basis: readonly string[];
  /** Things the reader must know before relying on it. */
  readonly warnings: readonly string[];

  /** Sixteen hex characters over columns + rows. See `digest.ts`. */
  readonly digest: string;
}

/**
 * ⭐ THE REFUSAL IS A FIRST-CLASS RESULT, NOT AN ERROR.
 *
 * ⚠️ IT CARRIES EVIDENCE. "We cannot produce this" is a weaker statement
 * than "we cannot produce this, and here are the eleven employees who
 * had a non-statutory deduction last month totalling ₹1,42,000, none of
 * which we can attribute to a loan". The second one tells the employer
 * what they are actually exposed to.
 */
export interface RegisterRefusal {
  readonly kind: RegisterKind;
  readonly title: string;
  readonly reason: string;
  readonly gaps: readonly RegisterGap[];
  readonly evidence: readonly string[];
  readonly generatedOn: string;
}

export type RegisterOutcome =
  | { readonly generated: true; readonly document: RegisterDocument }
  | { readonly generated: false; readonly refusal: RegisterRefusal };

/** Every unsourced column of a spec, in document shape. */
export function gapsFrom(spec: RegisterSpec, extra: readonly RegisterColumn[] = []): RegisterGap[] {
  return [...spec.columns, ...extra]
    .filter((c) => c.sourcing.kind === "unsourced")
    .map((c) => ({
      columnId: c.id,
      label: c.label,
      why: c.sourcing.kind === "unsourced" ? c.sourcing.why : "",
    }));
}
