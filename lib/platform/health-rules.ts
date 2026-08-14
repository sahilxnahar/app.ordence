/**
 * Ordence — ⭐⭐⭐ THE HEALTH SIGNALS THAT HAVE TO SURVIVE A REFRESH
 * Version: v1.22.0-alpha
 *
 * Pure. No database, no network, no clock. `now` is always an argument.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A CORRECTION TO MY OWN STATUS DOCUMENT, MADE WHILE BUILDING THIS
 * ══════════════════════════════════════════════════════════════════════
 * Doc 84 said Ordence had no tenant health signal. That was wrong.
 * `lib/platform/health.ts` holds `evaluateHealth`, it produces a score
 * and named signals, and `server/platform/tenants.ts` calls it in two
 * places: the directory list and the tenant detail page. It already
 * catches dormancy, a workspace nobody has ever signed into, failed
 * payments, trial expiry and seat or storage pressure.
 *
 * ⚠️ I ALSO OVERWROTE THAT FILE ON MY FIRST ATTEMPT AT THIS SESSION,
 * because I assumed it did not exist. `tsc` caught it in six lines. This
 * file is named `health-rules.ts` so the two can never be confused
 * again.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ SO WHAT IS ACTUALLY MISSING, PRECISELY
 * ══════════════════════════════════════════════════════════════════════
 * TWO THINGS, AND NEITHER IS ANOTHER SCORE.
 *
 * ① PERSISTENCE. `evaluateHealth` is a snapshot recomputed on every page
 *    load. Nothing remembers that a problem was seen, nobody has to
 *    close it, and there is no way to tell "we know, we are on it" from
 *    "nobody has looked". An alert that disappears when the underlying
 *    number moves is an alert nobody is accountable for.
 *
 * ② THE SIGNALS A SNAPSHOT STRUCTURALLY CANNOT SEE. `evaluateHealth`
 *    receives one moment. It cannot compare this fortnight to the last
 *    one, it cannot compare a workspace's error rate to its own normal,
 *    and it cannot notice that an integration stopped bringing things
 *    in. All three need history, and history is not in its input.
 *
 * 🔴 SO THIS FILE ADDS EXACTLY THREE RULES AND WRAPS THE EXISTING ONES
 * RATHER THAN RESTATING THEM. Two engines evaluating overlapping rules
 * is the two-sources-of-truth failure that half this codebase's comments
 * are about, and I am not going to introduce it here.
 */

import type { HealthSignal, HealthVerdict } from "./health";

export type Severity = "high" | "medium" | "low";

export type TrendRuleKey =
  | "engagement_collapse"
  | "error_spike"
  | "integration_dark";

/**
 * ⚠️ ORDENCE'S OPENING NUMBERS, NOT LAWS. Each is a judgement about how
 * much change is normal, and a business with weekly usage needs
 * different numbers from one with daily usage. When somebody asks, these
 * become columns on the tenant rather than a bigger `if`.
 */
export const TREND_THRESHOLDS = Object.freeze({
  /** ⚠️ Below this the prior period is too small to mean anything. */
  collapseMinimumPriorUsers: 3,
  collapseDropFraction: 0.4,
  /** 🔴 A multiple of the tenant's OWN baseline, never a fixed rate. */
  errorSpikeMultiple: 3,
  /** Stops three requests in a quiet workspace producing an alert. */
  errorSpikeFloor: 0.005,
  integrationDarkHours: 48,
});

export interface TrendSignals {
  readonly tenantName: string;
  readonly activeUsersLast7: number;
  readonly activeUsersPrior7: number;
  readonly errorRate7d: number;
  /** The workspace's own trailing normal. */
  readonly errorRateBaseline: number;
  readonly connectionsWithNoSyncHours: readonly {
    readonly name: string;
    readonly hours: number;
  }[];
}

export interface HealthEvent {
  readonly ruleKey: string;
  readonly severity: Severity;
  readonly headline: string;
  /** ⭐ What to do. An alert with no next step is noise with a colour. */
  readonly whatToDo: string;
  readonly evidence: Record<string, unknown>;
}

/**
 * ⭐ THE THREE RULES THAT NEED HISTORY.
 */
export function assessTrends(
  s: TrendSignals,
  now: Date,
): readonly HealthEvent[] {
  void now;
  const out: HealthEvent[] = [];

  // ① Engagement collapse.
  //
  // ⚠️ THE PRIOR PERIOD MUST BE NON-TRIVIAL. A workspace that went from
  // two active people to one has "dropped 50%" and has done nothing
  // interesting. Reporting that teaches operators to ignore the rule,
  // and then it is not there on the day it matters.
  if (s.activeUsersPrior7 >= TREND_THRESHOLDS.collapseMinimumPriorUsers) {
    const drop =
      (s.activeUsersPrior7 - s.activeUsersLast7) / s.activeUsersPrior7;
    if (drop >= TREND_THRESHOLDS.collapseDropFraction) {
      out.push({
        ruleKey: "engagement_collapse",
        severity: "high",
        headline: `${s.tenantName} has gone from ${s.activeUsersPrior7} active people to ${s.activeUsersLast7} in a fortnight.`,
        whatToDo:
          "Find out what changed. A drop this size is usually one person leaving, one workflow breaking, or a competitor being trialled, and all three are still reversible this week.",
        evidence: {
          before: s.activeUsersPrior7,
          after: s.activeUsersLast7,
          dropPercent: Math.round(drop * 100),
        },
      });
    }
  }

  // ② Error spike, against their own normal.
  //
  // 🔴 A PLATFORM-WIDE THRESHOLD SEES NEITHER END OF THIS. A busy
  // workspace sitting at 2% errors may be entirely healthy; a quiet one
  // that moves from 0.1% to 1% is broken. Only the comparison to itself
  // distinguishes them.
  if (
    s.errorRate7d >= TREND_THRESHOLDS.errorSpikeFloor &&
    s.errorRateBaseline > 0 &&
    s.errorRate7d >= s.errorRateBaseline * TREND_THRESHOLDS.errorSpikeMultiple
  ) {
    const multiple = s.errorRate7d / s.errorRateBaseline;
    out.push({
      ruleKey: "error_spike",
      severity: "medium",
      headline: `Errors at ${s.tenantName} are ${multiple.toFixed(1)} times their own normal rate.`,
      whatToDo:
        "Something is broken for this workspace specifically rather than for the platform. Look before they report it.",
      evidence: {
        rate: s.errorRate7d,
        baseline: s.errorRateBaseline,
        multiple: Number(multiple.toFixed(2)),
      },
    });
  }

  // ③ An integration that has gone silent.
  //
  // ⚠️ THE CUSTOMER USUALLY HAS NOT NOTICED. Leads stopping is
  // indistinguishable from a quiet week from where they are sitting,
  // which is the entire argument the connections screen already makes.
  const dark = s.connectionsWithNoSyncHours.filter(
    (c) => c.hours >= TREND_THRESHOLDS.integrationDarkHours,
  );
  if (dark.length > 0) {
    const worst = [...dark].sort((a, b) => b.hours - a.hours)[0]!;
    out.push({
      ruleKey: "integration_dark",
      severity: "medium",
      headline: `${worst.name} at ${s.tenantName} has brought nothing in for ${Math.floor(worst.hours)} hours.`,
      whatToDo:
        "A revoked key is the usual cause. From their side this looks like a quiet week, so they will not report it.",
      evidence: { connections: dark },
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* PROMOTING A SNAPSHOT SIGNAL INTO SOMETHING SOMEBODY MUST CLOSE      */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ WHICH OF `evaluateHealth`'s SIGNALS DESERVE TO PERSIST.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 NOT ALL OF THEM, AND THAT IS THE DESIGN
 * ══════════════════════════════════════════════════════════════════════
 * `seat_pressure` is a sales opportunity that resolves itself when they
 * buy more or stop growing. Turning it into an event somebody has to
 * close with a written note would bury the two that matter under a pile
 * of paperwork about workspaces doing well.
 *
 * ⚠️ THE TEST FOR PROMOTION IS NOT SEVERITY. It is whether a PERSON has
 * to do something that the numbers will not do by themselves. A failed
 * payment needs a phone call. A workspace nobody ever signed into needs
 * a phone call. Storage at 91% needs nothing until it is 100%.
 */
export const PERSISTENT_SIGNALS: Readonly<Record<string, Severity>> =
  Object.freeze({
    never_used: "high",
    dormant: "high",
    unpaid: "high",
    past_due: "high",
    cancelled: "high",
    trial_over: "medium",
    // ⚠️ Deliberately absent: seat_pressure, storage_pressure,
    // trial_ending, failed_payments, no_subscription, suspended.
    // Each is either self-resolving, already covered by a louder signal,
    // or a decision somebody made on purpose.
  });

export function shouldPersist(signal: HealthSignal): Severity | null {
  return PERSISTENT_SIGNALS[signal.key] ?? null;
}

/**
 * ⭐ EVERYTHING THAT SHOULD BECOME AN OPEN EVENT, FROM BOTH ENGINES.
 *
 * ⚠️ The snapshot verdict comes from `evaluateHealth` unchanged. This
 * does not recompute any of its rules; it decides which of its
 * conclusions need a human to close them.
 */
export function eventsFor(args: {
  readonly verdict: HealthVerdict;
  readonly trends: TrendSignals;
  readonly now: Date;
}): readonly HealthEvent[] {
  const fromSnapshot: HealthEvent[] = [];

  for (const signal of args.verdict.signals) {
    const severity = shouldPersist(signal);
    if (severity === null) continue;
    fromSnapshot.push({
      ruleKey: signal.key,
      severity,
      headline: `${args.trends.tenantName}: ${signal.label}`,
      whatToDo: ADVICE[signal.key] ?? "Look at this workspace.",
      evidence: { source: "evaluateHealth", label: signal.label },
    });
  }

  return [...fromSnapshot, ...assessTrends(args.trends, args.now)];
}

/**
 * ⚠️ ONE SENTENCE PER RULE, AND IT NAMES THE ACTION RATHER THAN THE
 * PROBLEM. "Dormant" is a state; "ring them this week" is a decision.
 */
const ADVICE: Readonly<Record<string, string>> = Object.freeze({
  never_used:
    "Ring them this week. They paid, nobody ever signed in, and this is the only churn signal that is still cheap to reverse.",
  dormant:
    "A paying workspace with no activity for three weeks is paying for nothing, and will notice at renewal rather than before it.",
  unpaid:
    "Dunning has run out. This is now a conversation rather than a retry.",
  past_due:
    "Usually an expired card rather than a decision. Ask before the dunning sequence sours it.",
  cancelled:
    "They have decided. Worth one call to find out what would have changed it, while they still remember.",
  trial_over:
    "The trial has ended and they have not converted. The window where they still remember why they signed up is measured in days.",
});
