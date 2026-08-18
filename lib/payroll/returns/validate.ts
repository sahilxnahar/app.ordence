/**
 * Ordence — ⭐⭐⭐ THE SHARED VALIDATOR FOR STATUTORY RETURN FILES
 * Version: v1.52.0-alpha · Batch 78
 *
 * Pure. `bigint` paise. No I/O.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE RULE THIS WHOLE MODULE EXISTS TO ENFORCE
 * ══════════════════════════════════════════════════════════════════════
 * A MALFORMED FILE IS REJECTED BY THE PORTAL, WHICH IS ANNOYING.
 * A WELL-FORMED FILE WITH WRONG NUMBERS IS ACCEPTED, WHICH IS DANGEROUS.
 *
 * The first costs an afternoon. The second becomes the employer's filed
 * position, is discovered by an inspector or by the employee whose
 * pension record is short, and is undone only by a revised return and
 * interest — for PF, 12% a year plus damages of up to 25% a year under
 * s.14B, and the employee-share portion is treated as a breach of trust
 * rather than a late payment.
 *
 * ⭐ SO THE SEVERITY LADDER HAS EXACTLY TWO RUNGS AND THE TOP ONE STOPS
 * THE FILE. There is no "error, but we emitted it anyway". A finding is
 * `blocking` when the resulting file would be WRONG rather than merely
 * ugly, and a blocking finding produces a refusal that NAMES THE PERSON.
 *
 * ⚠️ A FILE THAT WAS NOT PRODUCED, WITH A NAMED REASON, IS A GOOD
 * OUTCOME. A file produced with a blank UAN is not. The refusal type
 * below is a first-class result and not an exception, for the same
 * reason `RegisterRefusal` is in `lib/registers/document.ts`: an
 * exception loses the evidence on the way up.
 */

/* ------------------------------------------------------------------ */
/* FINDINGS                                                            */
/* ------------------------------------------------------------------ */

/**
 * 🔴 `blocking` MEANS NO FILE. Not "a file with a warning banner".
 * ⚠️ `warning` MEANS THE FILE IS EMITTED AND THE OPERATOR IS TOLD
 *    something they could not otherwise have known — almost always that
 *    a value was rounded, and in which direction.
 */
export type ReturnFindingSeverity = "blocking" | "warning";

export type ReturnFindingCode =
  /* --- identity, and every one of these blocks --------------------- */
  | "uan_missing"
  | "uan_malformed"
  | "uan_duplicated"
  | "member_name_missing"
  | "ip_number_missing"
  | "ip_number_malformed"
  | "ip_number_duplicated"
  /* --- arithmetic that cannot be true ------------------------------ */
  | "negative_amount"
  | "epf_wages_exceed_gross"
  | "eps_wages_exceed_epf_wages"
  | "contribution_without_wages"
  | "paise_would_be_lost"
  | "days_exceed_month"
  /* --- the ones that are silently wrong ---------------------------- */
  | "ncp_rounded"
  | "ncp_lost_to_rounding"
  | "days_rounded"
  | "esi_dropped_mid_period"
  | "esi_contribution_disagrees_with_wage"
  | "esi_zero_days_without_reason"
  /* --- configuration ----------------------------------------------- */
  | "layout_not_confirmed"
  | "rules_missing"
  | "pt_state_not_configured"
  | "pt_frequency_unknown"
  | "no_rows";

export interface ReturnFinding {
  readonly code: ReturnFindingCode;
  readonly severity: ReturnFindingSeverity;
  /**
   * ⭐ WHO. "Record 47" is what the portal says and is useless; this
   * says "Anita Rao (EMP-0042)". The whole point of validating before
   * emitting is that we still know the person's name.
   */
  readonly subject: string;
  readonly message: string;
}

export function blocking(
  code: ReturnFindingCode,
  subject: string,
  message: string,
): ReturnFinding {
  return { code, severity: "blocking", subject, message };
}

export function warn(code: ReturnFindingCode, subject: string, message: string): ReturnFinding {
  return { code, severity: "warning", subject, message };
}

export function hasBlocking(findings: readonly ReturnFinding[]): boolean {
  return findings.some((f) => f.severity === "blocking");
}

/* ------------------------------------------------------------------ */
/* THE OUTCOME                                                         */
/* ------------------------------------------------------------------ */

export type StatutoryReturnKind = "epfo_ecr" | "esic_monthly" | "professional_tax";

/**
 * ⭐ WHAT A PRODUCED FILE CARRIES BESIDES ITS TEXT.
 *
 * ⚠️ `confirmedAgainstPortal` TRAVELS WITH THE FILE. A caller that
 * renders the download button without it is showing a filing artefact
 * as if somebody had checked the layout. Nobody has.
 */
export interface StatutoryReturnFile {
  readonly kind: StatutoryReturnKind;
  readonly title: string;
  readonly fileName: string;
  /** The bytes, as text. Line endings are CRLF — see `joinLines`. */
  readonly text: string;
  readonly lineCount: number;

  readonly layoutId: string;
  readonly layoutVersion: string;
  readonly layoutSource: string;
  readonly confirmedAgainstPortal: boolean;

  readonly periodStart: string;
  readonly periodEnd: string;
  /** ⭐ From `lib/compliance/statutory-due.ts`. Never a second opinion. */
  readonly dueOn: string;
  readonly dueAuthority: string;
  readonly ifLate: string;

  /** Totals for reconciling against the challan, in paise. */
  readonly totals: Readonly<Record<string, bigint>>;
  /** Sentences. Exactly what this was built from. */
  readonly basis: readonly string[];
  /** ⚠️ Things the reader must know before uploading it. */
  readonly warnings: readonly string[];
  readonly findings: readonly ReturnFinding[];
}

export interface StatutoryReturnRefusal {
  readonly kind: StatutoryReturnKind;
  readonly title: string;
  /** One sentence an operator can act on. */
  readonly reason: string;
  /** 🔴 Every blocking finding, each naming its person. */
  readonly findings: readonly ReturnFinding[];
  readonly periodStart: string;
  readonly periodEnd: string;
}

export type StatutoryReturnOutcome =
  | { readonly generated: true; readonly file: StatutoryReturnFile }
  | { readonly generated: false; readonly refusal: StatutoryReturnRefusal };

export function refuse(args: {
  kind: StatutoryReturnKind;
  title: string;
  reason: string;
  findings: readonly ReturnFinding[];
  periodStart: string;
  periodEnd: string;
}): StatutoryReturnOutcome {
  return {
    generated: false,
    refusal: {
      kind: args.kind,
      title: args.title,
      reason: args.reason,
      findings: args.findings.filter((f) => f.severity === "blocking"),
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
    },
  };
}

/* ------------------------------------------------------------------ */
/* TEXT                                                                */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ CRLF, AND DELIBERATELY.
 *
 * 🔴 The EPFO and ESIC upload utilities are Windows tools of long
 * standing and several of them treat a bare LF file as a single very
 * long record. LF costs nothing to produce and produces a rejection that
 * reads as "invalid file" with no line number.
 */
export function joinLines(lines: readonly string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\r\n")}\r\n`;
}

/**
 * 🔴 A DELIMITED FILE WHOSE VALUES MAY CONTAIN THE DELIMITER IS NOT A
 * DELIMITED FILE. `#~#` will not appear in a name; a comma certainly
 * will ("Rao, Anita"), and a name with a comma silently shifts every
 * later column of an ESIC row by one.
 *
 * ⚠️ SO THIS REFUSES RATHER THAN ESCAPING. Escaping is a guess about
 * what the portal's parser does; refusing is a finding with a name on it.
 */
export function containsDelimiter(value: string, delimiter: string): boolean {
  return value.includes(delimiter);
}

/** ⚠️ Strips what a delimited file cannot carry: newlines and tabs. */
export function sanitiseText(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").trim();
}
