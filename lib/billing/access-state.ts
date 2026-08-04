/**
 * Ordence — Access Restriction & Dunning State
 * Version: v0.14.0-alpha
 *
 * Pure and isomorphic. The banner, the paywall, the middleware and the
 * server gate all read this, and a second implementation anywhere is how
 * "the banner said we were fine" happens.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE PRINCIPLE THIS WHOLE FILE ENCODES
 * ══════════════════════════════════════════════════════════════════════
 * **Never lock out a customer who is trying to pay you.**
 *
 * The overwhelmingly common cause of a failed subscription payment is an
 * expired card. Not fraud, not a decision to leave — a sixteen-digit
 * number that reached its printed expiry date while somebody was busy.
 *
 * A system that cuts access on the first failure converts a renewal that
 * was always going to happen into a churn event, plus an angry support
 * ticket, plus a refund request for the days they could not work. The
 * cost of waiting a week is a week of service you were owed for anyway.
 * The cost of cutting early is the customer.
 *
 * So the ladder below is deliberately slow at the top and only ever
 * reaches the bottom rung after the payment provider itself has given up
 * retrying.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE LADDER
 * ══════════════════════════════════════════════════════════════════════
 *
 *   full         Everything works. No banner.
 *
 *   notice       A quiet, dismissible line. Trial ending soon, or a first
 *                payment failure. NOTHING is restricted.
 *
 *   warning      A persistent, non-dismissible banner. Dunning is under
 *                way and the grace window is running out. NOTHING is
 *                restricted — this is still purely informational.
 *
 *   restricted   READ-ONLY. Every record remains visible and exportable.
 *                Writes are refused with an explanation. Reached only
 *                after the grace window closes on an `unpaid`
 *                subscription — i.e. after four failed attempts spread
 *                over roughly two weeks, plus seven more days.
 *
 *   locked       Sign-in only, to reach billing and export. Reached only
 *                by explicit administrative suspension, never by dunning.
 *
 * ⚠️ There is NO rung that deletes anything, and no rung that hides a
 * customer's own data from them. Even `locked` preserves export, because
 * holding someone's records hostage over an unpaid invoice is both wrong
 * and, under DPDP, probably unlawful.
 */

import type { SubscriptionStatus } from "@/db/schema/billing";
import type { PlanTier } from "@/db/schema/core";

/* ------------------------------------------------------------------ */
/* THE LEVELS                                                          */
/* ------------------------------------------------------------------ */

export const ACCESS_LEVELS = [
  "full",
  "notice",
  "warning",
  "restricted",
  "locked",
] as const;

export type AccessLevel = (typeof ACCESS_LEVELS)[number];

/** Ordering, so "at least as restrictive as" is expressible. */
export const ACCESS_RANK: Readonly<Record<AccessLevel, number>> = Object.freeze({
  full: 0,
  notice: 1,
  warning: 2,
  restricted: 3,
  locked: 4,
});

/** Levels at which the workspace may still WRITE. */
export function permitsWrites(level: AccessLevel): boolean {
  return ACCESS_RANK[level] < ACCESS_RANK.restricted;
}

/** Levels at which the workspace may still READ its own data. */
export function permitsReads(level: AccessLevel): boolean {
  // Every level except `locked` permits reading. `locked` permits
  // sign-in, billing and export — see `permitsExport`.
  return level !== "locked";
}

/**
 * Export is permitted at EVERY level, including `locked`.
 *
 * This is not generosity. Retaining someone's data while denying them a
 * copy of it is a data-protection problem, not a collections strategy —
 * under DPDP the right of access does not lapse because an invoice is
 * outstanding. It is also, practically, the thing that stops a billing
 * dispute becoming a regulatory one.
 */
export function permitsExport(_level: AccessLevel): boolean {
  return true;
}

/**
 * Billing is reachable at every level too — obviously. A paywall you
 * cannot pay through is just a wall.
 */
export function permitsBilling(_level: AccessLevel): boolean {
  return true;
}

/* ------------------------------------------------------------------ */
/* TIMING                                                              */
/* ------------------------------------------------------------------ */

/** Days before a trial ends that we start saying so. */
export const TRIAL_NOTICE_DAYS = 5;

/**
 * Days after a trial ends before writes are restricted.
 *
 * A trial that hard-stops at midnight on day 14 catches people
 * mid-evaluation, often the very people who were about to buy. Three days
 * of read-write grace costs nothing and removes a bad first impression.
 */
export const TRIAL_GRACE_DAYS = 3;

/* ------------------------------------------------------------------ */
/* THE INPUT                                                           */
/* ------------------------------------------------------------------ */

export type AccessInput = {
  subscriptionStatus: SubscriptionStatus | null;
  planTier: PlanTier;
  /** `tenants.status` — administrative, separate from billing. */
  tenantStatus: string;
  trialEndsAt: Date | null;
  graceEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  failedPaymentCount: number;
  cancelAtPeriodEnd: boolean;
  /** Injected so the decision is deterministic and testable. */
  now: Date;
};

export type AccessDecision = {
  level: AccessLevel;
  canWrite: boolean;
  canRead: boolean;
  canExport: boolean;
  /** Short line for a banner. Null when nothing needs saying. */
  headline: string | null;
  /** The fuller explanation. */
  detail: string | null;
  /** What the customer should do. Null when there is nothing to do. */
  callToAction: { label: string; href: string } | null;
  /** Machine-readable, for logs and tests. */
  reason:
    | "healthy"
    | "trial_ending"
    | "trial_expired"
    | "payment_failed"
    | "grace_expiring"
    | "unpaid_grace_expired"
    | "cancelled_ending"
    | "expired"
    | "tenant_suspended"
    | "no_subscription";
  /** Days remaining before the next rung, when one is running. */
  daysRemaining: number | null;
};

/* ------------------------------------------------------------------ */
/* THE DECISION                                                        */
/* ------------------------------------------------------------------ */

const BILLING_HREF = "/settings/billing";

function daysBetween(from: Date, to: Date): number {
  return Math.ceil((to.getTime() - from.getTime()) / 86_400_000);
}

/**
 * Work out what a workspace may currently do.
 *
 * ⚠️ ORDER MATTERS. Administrative suspension is checked FIRST, because
 * it must not be overridable by a healthy billing state — a workspace
 * suspended for abuse whose card also happens to be valid must stay
 * suspended.
 */
export function evaluateAccess(input: AccessInput): AccessDecision {
  const { now } = input;

  /* ---- 1. Administrative suspension outranks everything --------- */
  if (input.tenantStatus === "suspended" || input.tenantStatus === "pending_deletion") {
    return {
      level: "locked",
      canWrite: false,
      canRead: false,
      canExport: true,
      headline: "This workspace is suspended",
      detail:
        "Access has been suspended by an administrator. You can still download " +
        "a copy of your data. Please contact support to discuss it.",
      callToAction: { label: "Contact support", href: "/settings/billing" },
      reason: "tenant_suspended",
      daysRemaining: null,
    };
  }

  /* ---- 2. No subscription at all -------------------------------- */
  if (!input.subscriptionStatus) {
    // Mid-signup, or a workspace created before billing existed. Never
    // restrict — this is not a payment failure, it is an absence.
    return healthy();
  }

  /* ---- 3. Trial ------------------------------------------------- */
  if (input.subscriptionStatus === "trialing") {
    if (!input.trialEndsAt) return healthy();

    const daysLeft = daysBetween(now, input.trialEndsAt);

    if (daysLeft > TRIAL_NOTICE_DAYS) return healthy();

    if (daysLeft > 0) {
      return {
        level: "notice",
        canWrite: true,
        canRead: true,
        canExport: true,
        headline: `Your trial ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
        detail:
          "Choose a plan to keep everything you have set up. Nothing is " +
          "deleted when a trial ends — your data stays exactly as it is.",
        callToAction: { label: "Choose a plan", href: BILLING_HREF },
        reason: "trial_ending",
        daysRemaining: daysLeft,
      };
    }

    // Trial has ended. Grace before writes stop.
    const daysSinceEnd = -daysLeft;
    if (daysSinceEnd < TRIAL_GRACE_DAYS) {
      return {
        level: "warning",
        canWrite: true,
        canRead: true,
        canExport: true,
        headline: "Your trial has ended",
        detail:
          `You have ${TRIAL_GRACE_DAYS - daysSinceEnd} more day` +
          `${TRIAL_GRACE_DAYS - daysSinceEnd === 1 ? "" : "s"} of full access. ` +
          "After that the workspace becomes read-only until you choose a plan. " +
          "Nothing is deleted.",
        callToAction: { label: "Choose a plan", href: BILLING_HREF },
        reason: "trial_expired",
        daysRemaining: TRIAL_GRACE_DAYS - daysSinceEnd,
      };
    }

    return readOnly(
      "Your trial has ended",
      "Your workspace is read-only. Everything you entered is still here and " +
        "can be downloaded at any time. Choosing a plan restores full access " +
        "immediately — nothing needs to be set up again.",
      "trial_expired",
    );
  }

  /* ---- 4. Active ------------------------------------------------ */
  if (input.subscriptionStatus === "active") {
    if (input.cancelAtPeriodEnd && input.currentPeriodEnd) {
      const daysLeft = daysBetween(now, input.currentPeriodEnd);
      return {
        level: "notice",
        canWrite: true,
        canRead: true,
        canExport: true,
        headline: `Your subscription ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
        detail:
          "You cancelled, so billing will not renew. You keep full access " +
          "until the end of the period you have already paid for.",
        callToAction: { label: "Resume subscription", href: BILLING_HREF },
        reason: "cancelled_ending",
        daysRemaining: daysLeft,
      };
    }
    return healthy();
  }

  /* ---- 5. past_due — dunning, but NOTHING is restricted --------- */
  if (input.subscriptionStatus === "past_due") {
    const daysLeft = input.graceEndsAt ? daysBetween(now, input.graceEndsAt) : null;

    /**
     * ⚠️ `past_due` NEVER restricts. Not on the first failure, not on the
     * third. The provider is still retrying the charge; cutting access
     * while they are actively collecting is the worst of both worlds —
     * we lose the customer AND we get paid.
     */
    if (daysLeft !== null && daysLeft <= 2) {
      return {
        level: "warning",
        canWrite: true,
        canRead: true,
        canExport: true,
        headline: "We still cannot take your payment",
        detail:
          `Your workspace becomes read-only in ${Math.max(daysLeft, 0)} day` +
          `${Math.max(daysLeft, 0) === 1 ? "" : "s"} unless the payment goes ` +
          "through. Updating your card usually fixes it in a minute.",
        callToAction: { label: "Update payment details", href: BILLING_HREF },
        reason: "grace_expiring",
        daysRemaining: Math.max(daysLeft, 0),
      };
    }

    return {
      level: "notice",
      canWrite: true,
      canRead: true,
      canExport: true,
      headline: "Your last payment did not go through",
      detail:
        "We will try again automatically. This is usually an expired card. " +
        "Nothing has changed about your access.",
      callToAction: { label: "Update payment details", href: BILLING_HREF },
      reason: "payment_failed",
      daysRemaining: daysLeft,
    };
  }

  /* ---- 6. unpaid — dunning exhausted ---------------------------- */
  if (input.subscriptionStatus === "unpaid") {
    /**
     * Even here, the grace window is honoured. `unpaid` is set after the
     * fourth failed attempt; `graceEndsAt` runs seven days from that.
     * So the earliest possible restriction is roughly three weeks after
     * the first failure — by which point the provider has stopped
     * retrying and several emails have gone unanswered.
     */
    if (input.graceEndsAt && input.graceEndsAt.getTime() > now.getTime()) {
      const daysLeft = daysBetween(now, input.graceEndsAt);
      return {
        level: "warning",
        canWrite: true,
        canRead: true,
        canExport: true,
        headline: "We were unable to collect payment",
        detail:
          `After several attempts we still cannot take payment. Your ` +
          `workspace becomes read-only in ${daysLeft} day` +
          `${daysLeft === 1 ? "" : "s"}. Nothing will be deleted.`,
        callToAction: { label: "Update payment details", href: BILLING_HREF },
        reason: "grace_expiring",
        daysRemaining: daysLeft,
      };
    }

    return readOnly(
      "Your workspace is read-only",
      "We were unable to collect payment after several attempts. Everything " +
        "you have entered is still here and can be downloaded at any time. " +
        "Updating your payment details restores full access immediately.",
      "unpaid_grace_expired",
    );
  }

  /* ---- 7. paused ------------------------------------------------ */
  if (input.subscriptionStatus === "paused") {
    return readOnly(
      "Your subscription is paused",
      "Your workspace is read-only while billing is paused. Nothing has been " +
        "deleted. Contact us to resume.",
      "expired",
    );
  }

  /* ---- 8. cancelled / expired ----------------------------------- */
  if (input.subscriptionStatus === "cancelled") {
    // Cancelled but possibly still inside the paid period.
    if (input.currentPeriodEnd && input.currentPeriodEnd.getTime() > now.getTime()) {
      const daysLeft = daysBetween(now, input.currentPeriodEnd);
      return {
        level: "notice",
        canWrite: true,
        canRead: true,
        canExport: true,
        headline: `Your subscription ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
        detail:
          "You keep full access until the end of the period you have paid for.",
        callToAction: { label: "Resume subscription", href: BILLING_HREF },
        reason: "cancelled_ending",
        daysRemaining: daysLeft,
      };
    }
  }

  return readOnly(
    "Your subscription has ended",
    "Your workspace is read-only. Everything you entered is still here and " +
      "can be downloaded at any time. Starting a new plan restores full " +
      "access immediately.",
    "expired",
  );
}

/* ------------------------------------------------------------------ */
/* SHAPES                                                              */
/* ------------------------------------------------------------------ */

function healthy(): AccessDecision {
  return {
    level: "full",
    canWrite: true,
    canRead: true,
    canExport: true,
    headline: null,
    detail: null,
    callToAction: null,
    reason: "healthy",
    daysRemaining: null,
  };
}

function readOnly(
  headline: string,
  detail: string,
  reason: AccessDecision["reason"],
): AccessDecision {
  return {
    level: "restricted",
    canWrite: false,
    canRead: true,
    canExport: true,
    headline,
    detail,
    callToAction: { label: "Restore full access", href: BILLING_HREF },
    reason,
    daysRemaining: null,
  };
}

/* ------------------------------------------------------------------ */
/* WRITE EXEMPTIONS                                                    */
/* ------------------------------------------------------------------ */

/**
 * Writes that must ALWAYS be permitted, even at `restricted`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY A PAYWALL NEEDS EXEMPTIONS AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * A naive read-only mode blocks every mutation — including the mutation
 * that takes the customer's money. The workspace becomes a trap: they
 * want to pay, the payment form is a write, the write is blocked, and the
 * only route out is a support ticket.
 *
 * These are the writes that must survive:
 *   • anything under billing — starting, changing or paying for a plan;
 *   • updating a payment method;
 *   • exporting data;
 *   • signing out, and session bookkeeping.
 *
 * Each is a prefix match on the server action's namespace, checked in
 * `server/billing/access.ts`.
 */
export const ALWAYS_PERMITTED_WRITE_PREFIXES = [
  "billing:",
  "payment:",
  "export:",
  "session:",
  "support:",
] as const;

export function isExemptWrite(operation: string): boolean {
  return ALWAYS_PERMITTED_WRITE_PREFIXES.some((prefix) => operation.startsWith(prefix));
}
