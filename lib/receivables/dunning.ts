/**
 * Ordence — ⭐⭐ The Dunning Ladder
 * Version: v0.38.0-alpha
 *
 * Pure and isomorphic. No `@/db` import.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ FOUR RUNGS, ONE ORDER, AND NO RUNG MAY BE SKIPPED
 * ══════════════════════════════════════════════════════════════════════
 *     reminder → first notice → final notice → cancellation warning
 *
 * The escalation is not a workflow nicety. It is the sequence a developer
 * has to be able to produce when they terminate an allotment and forfeit
 * a buyer's money, and it is the first thing the buyer's advocate asks
 * for. A cancellation warning to somebody who never received a first
 * notice hands them a complete answer — and the developer's own system is
 * the evidence against them, because `dunning_events` is exactly the
 * table that gets printed.
 *
 * ⚠️ THE WAYS A RUNG GETS SKIPPED ARE ALL ORDINARY, WHICH IS WHY THE RULE
 * IS ENFORCED IN THREE PLACES RATHER THAN ONE:
 *
 *   • A sweep runs for the first time against a demand already 70 days
 *     overdue. Every threshold is in the past, so the obvious
 *     implementation picks the highest — and sends a final notice as the
 *     buyer's first ever letter.
 *   • A migration imports letters somebody sent by hand from a
 *     spreadsheet that only recorded the serious ones.
 *   • Somebody "escalates" from the UI on an account chased under a
 *     previous system.
 *
 * This module refuses all three. `SQL-FILES/0027_phase38_receivables.sql`
 * §6 refuses them again at the database, because the migration does not
 * come through here.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND THE LAST RUNG IS NEVER AUTOMATIC
 * ══════════════════════════════════════════════════════════════════════
 * Everything up to a final notice can be swept by a scheduled job.
 * Threatening to terminate somebody's allotment and forfeit what they
 * have paid may not be, ever. `nextSweepAction` will never return
 * `cancellation_warning` as something to send; it returns it as something
 * to PUT IN FRONT OF A HUMAN, and `canEscalate` refuses it without a
 * named authoriser and a reason.
 */

import type { DemandStatus, DunningStage } from "@/db/schema/receivables";
import { addDays, daysBetween, toCivilDay } from "./interest";
import { daysOverdue } from "./ageing";

/* ------------------------------------------------------------------ */
/* THE LADDER                                                          */
/* ------------------------------------------------------------------ */

export const DUNNING_LADDER = Object.freeze([
  "reminder",
  "first_notice",
  "final_notice",
  "cancellation_warning",
] as const);

export const DUNNING_STAGE_LABELS: Readonly<Record<DunningStage, string>> =
  Object.freeze({
    reminder: "Payment reminder",
    first_notice: "First notice",
    final_notice: "Final notice",
    cancellation_warning: "Cancellation warning",
  });

/**
 * ⭐ THE RUNG NUMBER IS THE COMPARISON, NOT THE ENUM LABEL.
 *
 * `dunning_events.rung` stores it and a CHECK keeps the two in step.
 * Comparing enum labels by name — or by their position in a `pgEnum`
 * array — is how a reordered enum silently reorders a legal process, and
 * the reorder looks like a tidy-up in a diff.
 */
export function rungOf(stage: DunningStage): number {
  return DUNNING_LADDER.indexOf(stage) + 1;
}

export function stageForRung(rung: number): DunningStage | null {
  return DUNNING_LADDER[rung - 1] ?? null;
}

/** The rung that comes after this one. Null at the top of the ladder. */
export function nextStage(current: DunningStage | null): DunningStage | null {
  if (current === null) return "reminder";
  return DUNNING_LADDER[rungOf(current)] ?? null;
}

/** True for the one rung that may never be sent by a machine. */
export function requiresHumanAuthorisation(stage: DunningStage): boolean {
  return stage === "cancellation_warning";
}

/* ------------------------------------------------------------------ */
/* POLICY                                                              */
/* ------------------------------------------------------------------ */

export type DunningLadderPolicy = {
  reminderAfterDays: number;
  firstNoticeAfterDays: number;
  finalNoticeAfterDays: number;
  cancellationWarningAfterDays: number;
  /** ⚠️ The floor between two rungs whatever the thresholds say. */
  minGapDays: number;
  /** Send a courtesy reminder this many days BEFORE the due date. 0 = off. */
  preDueReminderDays?: number;
};

export const DEFAULT_DUNNING_POLICY: DunningLadderPolicy = Object.freeze({
  reminderAfterDays: 3,
  firstNoticeAfterDays: 15,
  finalNoticeAfterDays: 30,
  cancellationWarningAfterDays: 60,
  minGapDays: 7,
  preDueReminderDays: 0,
});

export function thresholdFor(
  stage: DunningStage,
  policy: DunningLadderPolicy,
): number {
  switch (stage) {
    case "reminder":
      return policy.reminderAfterDays;
    case "first_notice":
      return policy.firstNoticeAfterDays;
    case "final_notice":
      return policy.finalNoticeAfterDays;
    case "cancellation_warning":
      return policy.cancellationWarningAfterDays;
  }
}

export type PolicyProblem = { message: string; remedy: string };

/**
 * ⚠️ A LADDER WHOSE RUNGS ARE NOT IN ORDER DOES NOT ERROR — IT SENDS TWO
 * LETTERS THE SAME MORNING. Validated here so a form can refuse it, and
 * by a CHECK constraint so a script cannot.
 */
export function validateDunningPolicy(
  policy: DunningLadderPolicy,
): PolicyProblem | null {
  const days = [
    policy.reminderAfterDays,
    policy.firstNoticeAfterDays,
    policy.finalNoticeAfterDays,
    policy.cancellationWarningAfterDays,
  ];

  for (const value of days) {
    if (!Number.isInteger(value) || value < 0) {
      return {
        message: "Every step of the ladder must be a whole number of days.",
        remedy: "Use days past the due date — 3, 15, 30, 60.",
      };
    }
  }

  for (let i = 1; i < days.length; i += 1) {
    const previous = days[i - 1] ?? 0;
    const current = days[i] ?? 0;
    if (current <= previous) {
      return {
        message:
          `${DUNNING_STAGE_LABELS[DUNNING_LADDER[i] ?? "reminder"]} is set to fire at ` +
          `${current} days, which is not after ${DUNNING_STAGE_LABELS[DUNNING_LADDER[i - 1] ?? "reminder"]} ` +
          `at ${previous} days.`,
        remedy:
          "Each rung must come strictly after the one before it. Otherwise the " +
          "sweep sends both letters on the same morning, which reads to the buyer " +
          "as a machine and to the Authority as a developer who never gave them a " +
          "chance.",
      };
    }
  }

  if (!Number.isInteger(policy.minGapDays) || policy.minGapDays < 0) {
    return {
      message: "The minimum gap between letters must be a whole number of days.",
      remedy: "Seven days is the usual setting. Zero disables the floor.",
    };
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* ESCALATION                                                          */
/* ------------------------------------------------------------------ */

export type EscalationRefusalCode =
  | "not_issued"
  | "settled"
  | "cancelled"
  | "nothing_outstanding"
  | "skips_a_rung"
  | "already_sent"
  | "too_early"
  | "too_soon_after_last"
  | "needs_human";

export type EscalationVerdict =
  | {
      allowed: true;
      stage: DunningStage;
      rung: number;
      daysOverdue: number;
      requiresHumanAuthorisation: boolean;
      /** The sentence recorded beside the letter. */
      rationale: string;
    }
  | {
      allowed: false;
      code: EscalationRefusalCode;
      reason: string;
      remedy: string;
    };

export type EscalationRequest = {
  /** The highest rung already sent. Null when nothing has gone out. */
  currentStage: DunningStage | null;
  /** The rung being attempted. */
  to: DunningStage;
  demandStatus: DemandStatus;
  dueDate: string;
  asOf: string;
  outstandingMinor: bigint;
  /** Civil day the previous rung was sent. */
  lastSentOn?: string | null;
  policy: DunningLadderPolicy;
  /** ⭐ Required for `cancellation_warning`, refused without. */
  authorisedBy?: string | null;
  authorisedReason?: string | null;
};

/**
 * May this rung be sent, right now, on this demand?
 *
 * ⚠️ THE SAME FUNCTION RUNS IN THE UI AND ON THE SERVER. A button that
 * offers an escalation the server refuses is how somebody learns the rule
 * by hitting an error, and a rule learned that way is a rule people work
 * around.
 */
export function canEscalate(request: EscalationRequest): EscalationVerdict {
  const {
    currentStage,
    to,
    demandStatus,
    outstandingMinor,
    policy,
    authorisedBy,
    authorisedReason,
  } = request;

  const dueDate = toCivilDay(request.dueDate);
  const asOf = toCivilDay(request.asOf);
  const late = daysOverdue(dueDate, asOf);

  /* --- 1. Is there anything to chase? --------------------------- */
  if (demandStatus === "draft") {
    return {
      allowed: false,
      code: "not_issued",
      reason: "This demand has not been issued, so nothing has been served on the buyer.",
      remedy:
        "Issue the demand first. A chasing letter about a document the buyer " +
        "never received is the fastest way to lose the argument about whether " +
        "they were ever asked.",
    };
  }

  if (demandStatus === "cancelled" || demandStatus === "superseded") {
    return {
      allowed: false,
      code: "cancelled",
      reason:
        demandStatus === "cancelled"
          ? "This demand was cancelled."
          : "This demand was superseded by a corrected one.",
      remedy:
        demandStatus === "superseded"
          ? "Chase the demand that replaced it. Chasing a superseded document " +
            "quotes a figure the buyer was told to ignore."
          : "Nothing is owed under this demand.",
    };
  }

  if (demandStatus === "paid") {
    return {
      allowed: false,
      code: "settled",
      reason: "This demand has been paid in full.",
      remedy:
        "Nothing to chase. A reminder sent after payment is the single fastest " +
        "way to lose a buyer's trust in every figure you send them afterwards.",
    };
  }

  if (outstandingMinor <= 0n) {
    return {
      allowed: false,
      code: "nothing_outstanding",
      reason: "Nothing is outstanding on this demand.",
      remedy:
        "If interest is still owed, chase that on its own footing — the demand " +
        "itself is settled.",
    };
  }

  /* --- 2. ⭐⭐ THE LADDER. -------------------------------------- */
  const expected = nextStage(currentStage);

  if (currentStage !== null && rungOf(to) <= rungOf(currentStage)) {
    return {
      allowed: false,
      code: "already_sent",
      reason: `A ${DUNNING_STAGE_LABELS[to].toLowerCase()} has already been sent on this demand.`,
      remedy:
        expected === null
          ? "The ladder is at its top. The next step is a decision about the " +
            "allotment itself, not another letter."
          : `The next step is a ${DUNNING_STAGE_LABELS[expected].toLowerCase()}.`,
    };
  }

  if (expected !== to) {
    const missing = expected ? DUNNING_STAGE_LABELS[expected].toLowerCase() : "earlier notice";
    return {
      allowed: false,
      code: "skips_a_rung",
      reason:
        `A ${DUNNING_STAGE_LABELS[to].toLowerCase()} cannot be sent before a ${missing}. ` +
        `⚠️ The ladder is reminder → first notice → final notice → cancellation ` +
        `warning, and a buyer shown a later rung who never received an earlier one ` +
        `has a complete answer at the Authority — with this system's own record as ` +
        `the evidence against the developer.`,
      remedy:
        `Send the ${missing} first. If it was sent outside this system, record it ` +
        `here with its real date and channel; back-filling the history is the ` +
        `supported path.`,
    };
  }

  /* --- 3. Is it due yet? ---------------------------------------- */
  const threshold = thresholdFor(to, policy);
  if (late < threshold) {
    const dueOn = addDays(dueDate, threshold);
    return {
      allowed: false,
      code: "too_early",
      reason:
        `This demand is ${late < 0 ? "not yet due" : `${late} days overdue`}, and the ` +
        `policy sends a ${DUNNING_STAGE_LABELS[to].toLowerCase()} at ${threshold} days.`,
      remedy: `It becomes due on ${dueOn}. Send it early only by changing the policy, ` +
        `so the same rule applies to every buyer rather than to this one.`,
    };
  }

  /* --- 4. ⚠️ THE FLOOR BETWEEN LETTERS. ------------------------- */
  if (request.lastSentOn && policy.minGapDays > 0) {
    const gap = daysBetween(toCivilDay(request.lastSentOn), asOf);
    if (gap < policy.minGapDays) {
      return {
        allowed: false,
        code: "too_soon_after_last",
        reason:
          `The previous letter went out ${gap} day${gap === 1 ? "" : "s"} ago and the ` +
          `policy requires at least ${policy.minGapDays} between rungs.`,
        remedy:
          `Wait until ${addDays(toCivilDay(request.lastSentOn), policy.minGapDays)}. ` +
          `A demand raised late puts several thresholds in the past at once, and ` +
          `without this floor the whole ladder is climbed in a single sweep — the ` +
          `buyer receives a first notice and a final notice in the same minute.`,
      };
    }
  }

  /* --- 5. ⭐⭐ THE RUNG THAT NEEDS A HUMAN. --------------------- */
  if (requiresHumanAuthorisation(to)) {
    if (!authorisedBy || !authorisedReason || authorisedReason.trim() === "") {
      return {
        allowed: false,
        code: "needs_human",
        reason:
          "A cancellation warning has to be authorised by a named person, with a " +
          "reason.",
        remedy:
          "⚠️ This is the letter that precedes terminating the allotment and " +
          "forfeiting what the buyer has paid. It is deliberately outside the " +
          "automatic sweep: everything below it can be sent by a scheduled job, " +
          "and this one may not be, ever. \"The system sent it automatically\" is " +
          "not an answer anybody can give at a hearing.",
      };
    }
  }

  return {
    allowed: true,
    stage: to,
    rung: rungOf(to),
    daysOverdue: late,
    requiresHumanAuthorisation: requiresHumanAuthorisation(to),
    rationale:
      `${DUNNING_STAGE_LABELS[to]} sent at ${late} days past the due date of ${dueDate}, ` +
      `per a policy that sends it at ${threshold} days` +
      (requiresHumanAuthorisation(to) && authorisedBy
        ? `, authorised by ${authorisedBy}: ${authorisedReason}`
        : "") +
      ".",
  };
}

/* ------------------------------------------------------------------ */
/* THE SWEEP                                                           */
/* ------------------------------------------------------------------ */

export type SweepAction =
  | { kind: "none"; reason: string }
  | { kind: "send"; stage: DunningStage; rung: number; daysOverdue: number }
  /** ⭐ Never sent automatically. Raised for a person to decide. */
  | {
      kind: "needs_decision";
      stage: "cancellation_warning";
      rung: 4;
      daysOverdue: number;
      reason: string;
    };

/**
 * What the nightly sweep should do with one demand.
 *
 * ⚠️ IT RETURNS ONE RUNG AT MOST, AND ALWAYS THE NEXT ONE — never the
 * highest whose threshold has passed. A demand that surfaces already 70
 * days overdue gets a reminder tonight, a first notice after the minimum
 * gap, and so on. That is slower and it is the only version that produces
 * a defensible file.
 */
export function nextSweepAction(args: {
  currentStage: DunningStage | null;
  demandStatus: DemandStatus;
  dueDate: string;
  asOf: string;
  outstandingMinor: bigint;
  lastSentOn?: string | null;
  policy: DunningLadderPolicy;
}): SweepAction {
  const target = nextStage(args.currentStage);
  if (target === null) {
    return {
      kind: "none",
      reason:
        "The ladder is at its top. What happens next is a decision about the " +
        "allotment, not another letter.",
    };
  }

  const verdict = canEscalate({
    ...args,
    to: target,
    // ⭐ Deliberately withheld. The sweep has no authority to give, so
    // `canEscalate` refuses the top rung — and this function turns that
    // refusal into a decision for a person rather than swallowing it.
    authorisedBy: null,
    authorisedReason: null,
  });

  if (verdict.allowed) {
    return {
      kind: "send",
      stage: verdict.stage,
      rung: verdict.rung,
      daysOverdue: verdict.daysOverdue,
    };
  }

  if (verdict.code === "needs_human") {
    return {
      kind: "needs_decision",
      stage: "cancellation_warning",
      rung: 4,
      daysOverdue: daysOverdue(toCivilDay(args.dueDate), toCivilDay(args.asOf)),
      reason:
        "Every letter below a cancellation warning has been sent and the demand is " +
        "still outstanding. The next step forfeits money and needs a named person " +
        "behind it.",
    };
  }

  return { kind: "none", reason: verdict.reason };
}

/**
 * The civil day each rung becomes due for a demand. Drives the "what
 * happens next, and when" panel — a buyer asking "how long do I have?"
 * gets an answer instead of a shrug.
 */
export function ladderSchedule(
  dueDate: string,
  policy: DunningLadderPolicy,
): Array<{ stage: DunningStage; rung: number; dueOn: string; automatic: boolean }> {
  const due = toCivilDay(dueDate);
  return DUNNING_LADDER.map((stage) => ({
    stage,
    rung: rungOf(stage),
    dueOn: addDays(due, thresholdFor(stage, policy)),
    automatic: !requiresHumanAuthorisation(stage),
  }));
}
