/**
 * Ordence — 🔴🔴 THE CEILING ON MONEY LEAVING THE BUSINESS
 * Version: v1.48.0-alpha (Batch 48)
 *
 * Pure. No database, no clock, no Clerk import. `now`, the ledger total
 * and the factor evidence are all ARGUMENTS, so every refusal below can
 * be proved on a laptop with no Postgres and no browser — which is the
 * only way a boundary test can be trusted to still be testing the
 * boundary a year from now.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THERE IS NO "REFUND" IN THIS PRODUCT. THERE IS A CREDIT NOTE.
 * ══════════════════════════════════════════════════════════════════════
 * Nothing in this repository issues a refund: `refund` appears as a
 * booking-cancellation ledger line, a Stripe webhook we receive, and a
 * disbursement in the legal module. The one place a person at a keyboard
 * reduces what a customer owes us is `issueCreditNote` — Section 34(1),
 * `sales_credit_notes`, posted to the ledger by `postSalesCreditNote`.
 * So this file caps THAT, and invents no refund domain to have something
 * to cap.
 *
 * ⚠️ AND IT CAPS ISSUING, NOT RAISING. A draft credit note is a working
 * paper: `lib/invoicing/credit-note.ts` says so, the numbering series
 * says so, and discarding one costs nothing. Issuing is the irreversible
 * step — the number is allocated, the reversal is posted, output tax is
 * reduced, and the customer is holding their copy. Capping the draft
 * would refuse a person while they were still thinking; capping the
 * issue refuses the money.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHAT THIS REUSES, RATHER THAN REBUILDING
 * ══════════════════════════════════════════════════════════════════════
 *   • THE CAP ITSELF is an `approval_limits` row — the table Phase 48
 *     built for exactly this shape of question, whose `scope` column is
 *     a `varchar` precisely so "a new scope is a row rather than a type
 *     migration". Two new scopes, `credit_note` and `credit_note_daily`,
 *     are added to `lib/validators/credit.ts` and to nothing else. There
 *     is no new table and no migration in this batch.
 *   • THE APPROVAL ROUTE is the draft that already exists. An over-cap
 *     credit note is refused at issue and STAYS A DRAFT, sitting on
 *     `/credit-notes` with the name of whoever raised it. Somebody whose
 *     role carries a higher limit issues it, and that person's own cap is
 *     measured by this same function on their request. A parallel
 *     "refund request" table would be a second queue holding the same
 *     rows and drifting from them.
 *   • STEP-UP is `FactorEvidence` from `lib/security/session-policy.ts`
 *     (Batch 136) — Clerk's signed `fva` claim, read once, in one place.
 *     "Recently authenticated" must have exactly one meaning in this
 *     codebase; a second notion of it is a second thing to be wrong.
 */

import { formatMoneyPlain } from "@/lib/billing/money";
import type { FactorEvidence } from "@/lib/security/session-policy";

/* ------------------------------------------------------------------ */
/* THE SCOPES                                                          */
/* ------------------------------------------------------------------ */

/** Per credit note, for the role of the person issuing it. */
export const CREDIT_NOTE_SCOPE = "credit_note";
/** Everything that person issues in one Indian civil day, added up. */
export const CREDIT_NOTE_DAILY_SCOPE = "credit_note_daily";

/* ------------------------------------------------------------------ */
/* 🔴 WHAT AN UNSET CAP MEANS                                           */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 UNSET IS **NOT** UNLIMITED. UNSET IS THESE NUMBERS.
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS IS THE ONE PLACE THIS FILE DEPARTS FROM `approval_limits`'
 * OWN CONVENTION, AND IT IS DELIBERATE. That table's header says a
 * missing row means "no authority" and a NULL `maxValueMinor` means
 * "unlimited for this scope". The first half is unusable here: it would
 * mean no workspace could issue any credit note until an admin found a
 * settings screen, which turns a security control into an outage on the
 * day it ships, and the fastest way past an outage is for somebody to
 * set every limit to NULL and never look again.
 *
 * So a missing row falls back to a FIGURE, not to infinity. The figures
 * below are deliberately generous enough that ordinary Indian SME
 * correction work — a returned carton, a rate revision on a small
 * invoice — passes untouched on day one, and deliberately small enough
 * that emptying a receivables ledger through a phished account cannot.
 * A workspace that genuinely credits lakhs routinely sets a row and says
 * so out loud, which is the entire point: the number becomes a decision
 * somebody made rather than an absence nobody noticed.
 *
 * ⭐ AN EXPLICIT ROW WITH `maxValueMinor = NULL` STILL MEANS UNLIMITED.
 * That is a sentence a human typed into a form for a named role, not a
 * gap. Honouring it keeps one meaning for NULL across the whole table
 * while refusing to let the ABSENCE of a row mean the same thing.
 */
export const DEFAULT_PER_NOTE_CAP_MINOR = 5_000_000n; // ₹50,000.00
export const DEFAULT_DAILY_CAP_MINOR = 20_000_000n; // ₹2,00,000.00

/**
 * ⭐ ABOVE THIS, PROVE IT IS STILL YOU — NOT "YOU SIGNED IN THIS MORNING".
 *
 * ⚠️ THE THRESHOLD IS LOWER THAN THE CAP, ON PURPOSE. The cap answers
 * "may this person do this at all"; step-up answers "is this person
 * still at the keyboard". A stolen session is inside the cap by
 * definition — the attacker uses an account that was allowed to do this
 * — so a step-up that only fired at the cap would never fire on the
 * attack it exists for.
 */
export const STEP_UP_ABOVE_MINOR = 1_000_000n; // ₹10,000.00
/** Minutes. The same shape as `STEP_UP_MAX_AGE_MINUTES` in the platform guard. */
export const STEP_UP_MAX_AGE_MINUTES = 15;

/**
 * The cap in force for one scope.
 *
 * `null` = explicitly unlimited (a row exists and its value is NULL).
 * Never returns `null` for a missing row — see the block above.
 */
export function resolveCapMinor(
  row: { maxValueMinor: bigint | null } | null | undefined,
  fallbackMinor: bigint,
): { capMinor: bigint | null; capIsDefault: boolean } {
  if (row === null || row === undefined) return { capMinor: fallbackMinor, capIsDefault: true };
  return { capMinor: row.maxValueMinor, capIsDefault: false };
}

/* ------------------------------------------------------------------ */
/* STEP-UP, MEASURED FROM CLERK'S SIGNED CLAIM AND NOTHING ELSE        */
/* ------------------------------------------------------------------ */

/**
 * Was a factor verified on this session within the last `maxAgeMinutes`?
 *
 * ⚠️ EITHER FACTOR COUNTS, AND THE YOUNGER ONE WINS. Re-entering a
 * password is a re-authentication; so is an OTP. Demanding specifically
 * a SECOND factor here would refuse every workspace that has not turned
 * MFA on — a question `evaluateSession()` already owns and answers, and
 * answering it twice in two places is how the two answers come to
 * disagree.
 *
 * 🔴 `measured: false` IS A REFUSAL, NOT A PASS. If the deployment's
 * Clerk JWT template omits `fva` we know NOTHING about factor age, and
 * "we could not check" must never be indistinguishable from "we checked
 * and it was fine" — that is the exact defect Batches 43 and 136 were
 * spent removing. The cost is real and accepted: a workspace whose token
 * lacks the claim cannot issue a credit note above the step-up threshold
 * until an administrator publishes it, and `stepUpRefusal()` below says
 * so in those words rather than reporting a generic failure.
 */
export function stepUpFresh(factors: FactorEvidence, maxAgeMinutes: number): boolean {
  if (!factors.measured) return false;
  const ages = [factors.firstFactorMinutes, factors.secondFactorMinutes].filter(
    (m): m is number => m !== null,
  );
  if (ages.length === 0) return false;
  return Math.min(...ages) <= maxAgeMinutes;
}

/* ------------------------------------------------------------------ */
/* THE VERDICT                                                         */
/* ------------------------------------------------------------------ */

export type CreditNoteCapOutcome =
  | "allow"
  | "over_note_cap"
  | "over_daily_cap"
  | "step_up_required";

export type CreditNoteCapVerdict = {
  outcome: CreditNoteCapOutcome;
  /**
   * ⭐ EVERY STATE CARRIES A WORD. One in twelve Indian men is
   * colour-blind; a refusal rendered only as a red badge is a refusal
   * that person cannot read, and this one has to be acted on.
   */
  word: "ALLOWED" | "OVER THE PER-NOTE LIMIT" | "OVER TODAY'S LIMIT" | "RE-AUTHENTICATION NEEDED";
  /** Written for the person who was refused, naming the way forward. */
  reason: string;
  /** The cap that was applied. `null` when explicitly unlimited. */
  capMinor: bigint | null;
  /** ⚠️ Zero unless a cap was breached. Never negative. */
  overByMinor: bigint;
  /** True when no `approval_limits` row existed and the fallback applied. */
  capIsDefault: boolean;
};

const REMEDY =
  "The credit note stays a draft — nothing has been issued and no number has been " +
  "allocated. Someone whose role carries a higher credit-note limit can open it and " +
  "issue it, or an administrator can raise the limit in Settings → Credit control.";

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE DECISION. THE CALLER RUNS IT INSIDE THE WRITE TRANSACTION.
 * ══════════════════════════════════════════════════════════════════════
 * This function decides; `server/sales/refund-cap.ts` throws inside the
 * same transaction that would write the credit note. A screen that hides
 * the Issue button is a mistake guard — it protects the person who did
 * not mean to. It does nothing at all to a `curl`, a stale tab, or a
 * script holding a stolen session cookie, and those are the three cases
 * this batch exists for.
 *
 * 🔴 EVERY COMPARISON IS `bigint` PAISE. No `Number`, no `Math.round`, no
 * float anywhere on this path. `Math.round(Number("1.005") * 100)` is
 * 100, not 101, and `BigInt(30.5)` throws — a cap computed in floating
 * point is wrong at the boundary, which is the only place a cap matters.
 *
 * ⚠️ AT THE CAP IS ALLOWED; ONE PAISA OVER IS NOT. `>` and not `>=`. A
 * limit of ₹50,000 that refuses ₹50,000 is a limit of ₹49,999.99, and
 * the person who set it will never be told which one they got.
 *
 * ⚠️ CAPS ARE TESTED BEFORE STEP-UP, AND THAT ORDER IS THE KIND ONE.
 * Sending somebody to re-authenticate and refusing them the moment they
 * come back teaches them the security prompt is noise. If the answer is
 * "not you, not today", say it first.
 */
export function assessCreditNoteCap(args: {
  /** 🔴 The whole document, tax included — what actually leaves. */
  noteTotalMinor: bigint;
  /**
   * 🔴 SUMMED FROM THE ISSUED ROWS INSIDE THE TRANSACTION, never read
   * from a counter column. A counter drifts on every rolled-back
   * transaction, every restored backup and every hand-written UPDATE,
   * and it drifts silently in the direction of letting more money out.
   */
  issuedTodayMinor: bigint;
  perNoteCapMinor: bigint | null;
  perNoteCapIsDefault: boolean;
  dailyCapMinor: bigint | null;
  /**
   * ⚠️ TRACKED SEPARATELY FROM THE PER-NOTE FLAG. A workspace commonly
   * sets one and forgets the other, and the sentence "which is the limit
   * that applies until this workspace sets its own" is a lie if it is
   * printed about a figure an admin typed.
   */
  dailyCapIsDefault: boolean;
  factors: FactorEvidence;
  stepUpAboveMinor?: bigint;
  stepUpMaxAgeMinutes?: number;
}): CreditNoteCapVerdict {
  const stepUpAbove = args.stepUpAboveMinor ?? STEP_UP_ABOVE_MINOR;
  const stepUpAge = args.stepUpMaxAgeMinutes ?? STEP_UP_MAX_AGE_MINUTES;
  const base = { capMinor: args.perNoteCapMinor, capIsDefault: args.perNoteCapIsDefault };

  /* ── PER TRANSACTION ──────────────────────────────────────────── */
  if (args.perNoteCapMinor !== null && args.noteTotalMinor > args.perNoteCapMinor) {
    return {
      ...base,
      outcome: "over_note_cap",
      word: "OVER THE PER-NOTE LIMIT",
      overByMinor: args.noteTotalMinor - args.perNoteCapMinor,
      reason:
        `This credit note is ${formatMoneyPlain(args.noteTotalMinor)}. Your role may issue ` +
        `up to ${formatMoneyPlain(args.perNoteCapMinor)} on one credit note` +
        `${args.perNoteCapIsDefault ? ", which is the limit that applies until this workspace sets its own" : ""}. ` +
        REMEDY,
    };
  }

  /* ── PER DAY, PER USER ────────────────────────────────────────── */
  //
  // ⚠️ THE NOTE IN HAND IS COUNTED IN THE TOTAL, not compared against
  // the remainder afterwards. Ten notes just under the per-note cap are
  // each individually fine; the daily cap exists because together they
  // are not, and it only works if the tenth is measured with the nine.
  if (args.dailyCapMinor !== null) {
    const runningMinor = args.issuedTodayMinor + args.noteTotalMinor;
    if (runningMinor > args.dailyCapMinor) {
      return {
        capMinor: args.dailyCapMinor,
        capIsDefault: args.dailyCapIsDefault,
        outcome: "over_daily_cap",
        word: "OVER TODAY'S LIMIT",
        overByMinor: runningMinor - args.dailyCapMinor,
        reason:
          `You have already issued ${formatMoneyPlain(args.issuedTodayMinor)} in credit notes ` +
          `today. This one would take the day to ${formatMoneyPlain(runningMinor)}, past the ` +
          `${formatMoneyPlain(args.dailyCapMinor)} your role may issue in a day. ` +
          REMEDY,
      };
    }
  }

  /* ── STILL YOU? ───────────────────────────────────────────────── */
  if (args.noteTotalMinor > stepUpAbove && !stepUpFresh(args.factors, stepUpAge)) {
    return {
      ...base,
      outcome: "step_up_required",
      word: "RE-AUTHENTICATION NEEDED",
      overByMinor: 0n,
      reason: stepUpRefusal(args.noteTotalMinor, args.factors, stepUpAge),
    };
  }

  return {
    ...base,
    outcome: "allow",
    word: "ALLOWED",
    overByMinor: 0n,
    reason: "Within this role's credit-note limits, on a freshly verified session.",
  };
}

/**
 * ⚠️ THE TWO WAYS TO FAIL STEP-UP ARE KEPT APART IN THE SENTENCE.
 * "Your sign-in is too old" is fixed by the person, in ten seconds.
 * "This deployment publishes no factor claim" is fixed by an
 * administrator editing a Clerk JWT template, and nothing the person at
 * the keyboard does will help. One message for both would send every
 * user of a misconfigured workspace round the sign-in loop forever.
 */
export function stepUpRefusal(
  noteTotalMinor: bigint,
  factors: FactorEvidence,
  maxAgeMinutes: number,
): string {
  const size = `A credit note of ${formatMoneyPlain(noteTotalMinor)} has to be confirmed by the person issuing it.`;
  if (!factors.measured) {
    return (
      `${size} This session cannot be re-verified: the Clerk session token carries no ` +
      `factor-verification claim, so we cannot tell how long ago you signed in. Ask an ` +
      `administrator to publish the \`fva\` claim on the session token. The credit note ` +
      `stays a draft until then.`
    );
  }
  return (
    `${size} Sign in again — within the last ${maxAgeMinutes} minutes — and issue it. ` +
    `The credit note stays a draft in the meantime; nothing has been lost.`
  );
}
