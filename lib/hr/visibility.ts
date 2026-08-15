/**
 * Ordence — ⭐⭐⭐ WHO MAY READ WHICH APPRAISAL REVIEW
 * Version: v1.47.0-alpha · Batch 109
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 SELF, MANAGER AND SKIP-LEVEL ARE THREE DIFFERENT ACTS WITH THREE
 *      DIFFERENT READERSHIPS. ONE FIELD CALLED `comments` IS NOT ALL
 *      THREE.
 * ══════════════════════════════════════════════════════════════════════
 * The obvious build is one review row with a text box and a "who wrote
 * it" column. It type checks, it renders, and it publishes the
 * skip-level review to the manager it was written about — which is the
 * single thing a skip-level review must never do, because the whole
 * point of it is that it is a check ON the manager.
 *
 * ⭐ SO THE MATRIX IS A PURE FUNCTION, IT IS ONE FUNCTION, AND EVERY
 * READ PATH GOES THROUGH IT. A second copy of "can this person see
 * this" living in a component is the copy that gets it wrong.
 *
 * ⚠️ THIS IS NOT THE TENANT BOUNDARY AND IT IS NOT A PERMISSION CHECK.
 * RLS answers "is this row in your workspace" and answers it for every
 * colleague's row identically. A permission key answers "are you HR".
 * This answers the third question, the one neither of the others can:
 * "is this row about you, or about somebody in your line". It is
 * enforced in the WHERE clause of every read in
 * `server/actions/appraisals.ts`; this module is the rule those queries
 * are built from and the thing the tests assert against.
 */

import type { AppraisalReviewKind } from "@/db/schema/appraisals";

/**
 * The reader's relationship to ONE appraisal subject.
 *
 * ⚠️ MORE THAN ONE CAN BE TRUE AT ONCE and the order below is the
 * precedence. An HR administrator is also somebody's report; a manager
 * is a subject of their own appraisal. The relationships are computed
 * per subject, never per session.
 */
export type ViewerRelation = {
  /** The subject IS the reader. */
  isSubject: boolean;
  /** The reader is the subject's snapshotted reporting manager. */
  isManager: boolean;
  /** The reader is the snapshotted skip-level. */
  isSkipLevel: boolean;
  /**
   * 🔴 THE READER HOLDS THE HR KEY. A key, not a relationship — and it
   * is the one that has to be typed rather than inferred, because it is
   * the only path that crosses a reporting line.
   */
  isHr: boolean;
};

export const NO_RELATION: ViewerRelation = {
  isSubject: false,
  isManager: false,
  isSkipLevel: false,
  isHr: false,
};

/** Whether this reader may see the subject's row at all. */
export function canSeeSubject(rel: ViewerRelation): boolean {
  return rel.isSubject || rel.isManager || rel.isSkipLevel || rel.isHr;
}

/**
 * 🔴🔴 THE MATRIX.
 *
 *                        subject   manager   skip-level   HR
 *   self review            YES       YES        YES       YES
 *   manager review      after release YES       YES       YES
 *   skip-level review      NEVER     NEVER      YES       YES
 *
 * ⭐ ROW BY ROW, AND EVERY "NO" HAS A REASON:
 *
 * · SELF REVIEW — the subject wrote it, so hiding it from them is
 *   absurd. Their manager and skip-level read it because it is the
 *   input the whole cycle is built on.
 *
 * · MANAGER REVIEW — the subject sees it ONLY once the outcome has been
 *   released. ⚠️ NOT BECAUSE IT IS SECRET: because a manager who knows
 *   the subject is watching the text appear writes a blander review, and
 *   because an employee reading "needs improvement" at 11pm before
 *   anybody has spoken to them is the specific harm the release step
 *   exists to prevent. `releasedAt` is a separate column from
 *   `signedOffAt` for exactly this.
 *
 * · SKIP-LEVEL REVIEW — 🔴 NEVER VISIBLE TO THE MANAGER, AND NEVER TO
 *   THE SUBJECT. Showing it to the manager makes it a second manager
 *   review with extra steps and nobody writes an honest one again.
 *   Showing it to the subject makes it a channel for passing a message
 *   round their manager, which is not what it is for either.
 */
export function canReadReview(
  kind: AppraisalReviewKind,
  rel: ViewerRelation,
  args: { released: boolean },
): boolean {
  if (rel.isHr) return true;

  switch (kind) {
    case "self":
      return rel.isSubject || rel.isManager || rel.isSkipLevel;
    case "manager":
      if (rel.isManager || rel.isSkipLevel) return true;
      return rel.isSubject && args.released;
    case "skip_level":
      return rel.isSkipLevel;
    default:
      /**
       * ⚠️ FAILS CLOSED. A review kind added later and not considered
       * here is hidden from everybody until somebody decides, rather
       * than published to everybody because a switch fell through.
       */
      return false;
  }
}

/**
 * ⭐ WHO IS ALLOWED TO WRITE A REVIEW OF EACH KIND.
 *
 * 🔴 HR IS DELIBERATELY ABSENT FROM THIS ONE. An HR administrator may
 * read everything and may not WRITE somebody's self review, manager
 * review or skip-level review on their behalf. A review filed by
 * somebody who was not there, under a name that was, is a forgery with
 * a permission key attached — and it is the exact convenience an
 * "administrative override" would deliver.
 *
 * ⚠️ THE DATABASE AGREES INDEPENDENTLY. The
 * `appraisal_reviews_reviewer_matches_kind` trigger in 0085 refuses a
 * `manager` row whose reviewer is not the snapshotted manager, whatever
 * key the writer holds.
 */
export function canWriteReview(kind: AppraisalReviewKind, rel: ViewerRelation): boolean {
  switch (kind) {
    case "self":
      return rel.isSubject;
    case "manager":
      return rel.isManager;
    case "skip_level":
      return rel.isSkipLevel;
    default:
      return false;
  }
}

/**
 * ⚠️ WHAT A READER IS TOLD ABOUT A REVIEW THEY MAY NOT READ.
 *
 * 🔴 EXISTENCE, NEVER CONTENT — and saying nothing at all would be
 * worse. A manager whose skip-level review is invisible AND unmentioned
 * concludes the skip-level never happened and chases it; the subject
 * whose manager review is not yet released concludes their manager has
 * not written one and asks them, at the worst possible moment. The same
 * argument `payroll-self.ts` makes about `awaitingApproval`: a count is
 * not a figure anybody can plan around, and silence produces exactly the
 * anxious message the screen exists to prevent.
 */
export function describeWithheld(kind: AppraisalReviewKind, rel: ViewerRelation): string {
  if (kind === "manager" && rel.isSubject) {
    return "Your manager's review is written and will be shared with you when the outcome is released.";
  }
  if (kind === "skip_level") {
    return "A skip-level review exists. It is read by HR and by the skip-level manager only.";
  }
  return "Not visible to you.";
}
