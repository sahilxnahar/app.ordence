/**
 * Ordence — Tenant Health & Console Display Helpers
 * Version: v0.14.0-alpha
 *
 * Pure and isomorphic. The tenant list, the detail page and the tests all
 * read the same scoring, because a health badge that means one thing on
 * the list and another on the detail page is worse than no badge.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT "HEALTH" IS FOR, AND WHAT IT DELIBERATELY IS NOT
 * ══════════════════════════════════════════════════════════════════════
 * This exists so a platform operator scanning two hundred rows can find
 * the four that need attention TODAY. It is triage, not analytics.
 *
 * So it is built from signals we already hold as the controller of the
 * commercial relationship — plan, billing state, seat and storage
 * pressure, last activity — and from NOTHING about the customer's own
 * records. A "health score" that counted how many contacts a workspace
 * holds would be a per-tenant business-intelligence feed built out of
 * data we are a processor for, assembled by the same console this phase
 * is trying to keep narrow.
 *
 * ⚠️ The score is ADVISORY. Nothing acts on it automatically. A number
 * that suspends accounts is a number somebody will regret; suspension is
 * a decision a named human makes with a written reason.
 */

import type { PlanTier } from "@/db/schema/core";

/* ------------------------------------------------------------------ */
/* THE SIGNALS                                                         */
/* ------------------------------------------------------------------ */

export type HealthInput = {
  tenantStatus: string;
  planTier: PlanTier;
  subscriptionStatus: string | null;
  trialEndsAt: Date | null;
  /** Seats occupied vs purchased. */
  seatsInUse: number;
  seatLimit: number;
  storageUsedMb: number;
  storageLimitMb: number;
  /** Most recent `users.last_seen_at` in the workspace. */
  lastActivityAt: Date | null;
  /** Unresolved failed payments on the live subscription. */
  failedPaymentCount: number;
  now: Date;
};

export const HEALTH_LEVELS = ["healthy", "watch", "at_risk", "suspended"] as const;
export type HealthLevel = (typeof HEALTH_LEVELS)[number];

export type HealthSignal = {
  key: string;
  label: string;
  severity: "info" | "watch" | "risk";
};

export type HealthVerdict = {
  level: HealthLevel;
  /** 0–100. Higher is better. Advisory only. */
  score: number;
  signals: HealthSignal[];
  headline: string;
};

/** Days with no sign-in from anybody before a workspace looks abandoned. */
const DORMANT_DAYS = 21;

/** Fraction of a limit at which pressure is worth flagging. */
const PRESSURE_THRESHOLD = 0.9;

function daysBetween(from: Date, to: Date): number {
  return Math.ceil((to.getTime() - from.getTime()) / 86_400_000);
}

/**
 * Score a workspace.
 *
 * ⚠️ ORDER MATTERS, and it mirrors `evaluateAccess()` in
 * `lib/billing/access-state.ts` on purpose: administrative suspension is
 * checked FIRST and outranks everything. A suspended tenant whose card is
 * perfectly healthy is still suspended, and a console that showed it as
 * "healthy" would send an operator looking for a problem that is not
 * there — or, worse, reassure them that a workspace they just locked is
 * fine.
 */
export function evaluateHealth(input: HealthInput): HealthVerdict {
  const signals: HealthSignal[] = [];

  if (input.tenantStatus === "suspended" || input.tenantStatus === "pending_deletion") {
    return {
      level: "suspended",
      score: 0,
      signals: [
        {
          key: "suspended",
          label:
            input.tenantStatus === "suspended"
              ? "Administratively suspended"
              : "Pending deletion",
          severity: "risk",
        },
      ],
      headline: "Locked by an administrator. Data is intact and still exportable.",
    };
  }

  let score = 100;

  /* ---- Billing ------------------------------------------------- */
  if (input.subscriptionStatus === "unpaid") {
    score -= 40;
    signals.push({ key: "unpaid", label: "Dunning exhausted", severity: "risk" });
  } else if (input.subscriptionStatus === "past_due") {
    score -= 20;
    signals.push({ key: "past_due", label: "Payment failing", severity: "watch" });
  } else if (input.subscriptionStatus === "cancelled") {
    score -= 30;
    signals.push({ key: "cancelled", label: "Cancelled", severity: "risk" });
  } else if (!input.subscriptionStatus) {
    score -= 10;
    signals.push({ key: "no_subscription", label: "No subscription", severity: "watch" });
  }

  if (input.failedPaymentCount > 0) {
    signals.push({
      key: "failed_payments",
      label: `${input.failedPaymentCount} failed payment${
        input.failedPaymentCount === 1 ? "" : "s"
      }`,
      severity: "watch",
    });
  }

  /* ---- Trial --------------------------------------------------- */
  if (input.subscriptionStatus === "trialing" && input.trialEndsAt) {
    const daysLeft = daysBetween(input.now, input.trialEndsAt);
    if (daysLeft <= 0) {
      score -= 25;
      signals.push({ key: "trial_over", label: "Trial has ended", severity: "risk" });
    } else if (daysLeft <= 5) {
      score -= 10;
      signals.push({
        key: "trial_ending",
        label: `Trial ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
        severity: "watch",
      });
    }
  }

  /* ---- Capacity pressure --------------------------------------- */
  // Pressure is a SALES signal, not a fault. It costs a small amount of
  // score so the row surfaces, and it is labelled as opportunity.
  if (input.seatLimit > 0 && input.seatsInUse / input.seatLimit >= PRESSURE_THRESHOLD) {
    score -= 5;
    signals.push({
      key: "seat_pressure",
      label: `${input.seatsInUse}/${input.seatLimit} seats used`,
      severity: "info",
    });
  }
  if (
    input.storageLimitMb > 0 &&
    input.storageUsedMb / input.storageLimitMb >= PRESSURE_THRESHOLD
  ) {
    score -= 5;
    signals.push({
      key: "storage_pressure",
      label: `${Math.round((input.storageUsedMb / input.storageLimitMb) * 100)}% of storage`,
      severity: "info",
    });
  }

  /* ---- Dormancy ------------------------------------------------ */
  if (!input.lastActivityAt) {
    // ⚠️ WEIGHTED ABOVE `dormant`, AND ABOVE THE `healthy` THRESHOLD ON
    // ITS OWN. A workspace nobody has EVER signed into is not a healthy
    // workspace with a quiet week — it is an onboarding that failed, and
    // it is the highest-value thing in this list for somebody to act on.
    // At −20 it scored 80 and rendered as "Healthy", which is exactly the
    // row an operator would then never look at.
    score -= 25;
    signals.push({ key: "never_used", label: "Nobody has signed in", severity: "risk" });
  } else {
    const idleDays = daysBetween(input.lastActivityAt, input.now);
    if (idleDays >= DORMANT_DAYS) {
      score -= 20;
      signals.push({
        key: "dormant",
        label: `No activity for ${idleDays} days`,
        severity: "risk",
      });
    }
  }

  const bounded = Math.max(0, Math.min(100, score));
  const level: HealthLevel = bounded >= 80 ? "healthy" : bounded >= 55 ? "watch" : "at_risk";

  return {
    level,
    score: bounded,
    signals,
    headline: signals.length === 0 ? "Nothing needs attention." : signals[0]!.label,
  };
}

/* ------------------------------------------------------------------ */
/* DISPLAY                                                             */
/* ------------------------------------------------------------------ */

export const HEALTH_LABELS: Readonly<Record<HealthLevel, string>> = Object.freeze({
  healthy: "Healthy",
  watch: "Watch",
  at_risk: "At risk",
  suspended: "Suspended",
});

/** Badge variant from `components/ui/badge`. Kept here so list and detail agree. */
export function healthBadgeVariant(
  level: HealthLevel,
): "default" | "secondary" | "destructive" | "outline" {
  switch (level) {
    case "healthy":
      return "secondary";
    case "watch":
      return "outline";
    case "at_risk":
    case "suspended":
      return "destructive";
  }
}

/** "3 days ago" / "in 2 hours" — no dependency, no locale surprises. */
export function relativeTime(value: Date | null, now: Date): string {
  if (!value) return "never";
  const deltaMs = value.getTime() - now.getTime();
  const future = deltaMs > 0;
  const abs = Math.abs(deltaMs);

  const units: Array<[string, number]> = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];

  for (const [name, ms] of units) {
    if (abs >= ms) {
      const n = Math.floor(abs / ms);
      return future ? `in ${n} ${name}${n === 1 ? "" : "s"}` : `${n} ${name}${n === 1 ? "" : "s"} ago`;
    }
  }
  return future ? "in a moment" : "just now";
}

/**
 * Storage is stored in MB; humans read GB above a point.
 * Rounded DOWN so a console never overstates how much room is left.
 */
export function formatStorage(megabytes: number): string {
  if (megabytes < 1024) return `${Math.floor(megabytes)} MB`;
  return `${(Math.floor((megabytes / 1024) * 10) / 10).toFixed(1)} GB`;
}
