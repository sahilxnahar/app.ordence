/**
 * Ordence — The Grace Ladder, and the Things It May Never Reach
 * Version: v1.52.0-alpha (Batch 55)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A FAILED CARD ON THE 5th MUST NOT COST SOMEBODY THEIR 7th.
 * ══════════════════════════════════════════════════════════════════════
 * An Indian SMB running payroll on this system has a statutory deadline
 * that does not move because a bank declined a recurring mandate. PF and
 * ESI are due by the 15th, TDS by the 7th of the following month, and the
 * penalty for missing them lands on the customer, not on us.
 *
 * A billing system that hard-stops writes takes a commercial dispute —
 * which is recoverable — and converts it into a compliance failure, which
 * is not. The customer's accountant will tell every other client they have
 * about it, and they will be right to.
 *
 * ══════════════════════════════════════════════════════════════════════
 * SO THE LADDER DEGRADES IN THIS ORDER, AND NEVER SKIPS A RUNG
 * ══════════════════════════════════════════════════════════════════════
 *   1. WARN IN-PRODUCT       — a banner, nothing refused.
 *   2. BLOCK NEW CONSUMPTION — no new seats, no new uploads. Existing
 *                              work continues. This is the rung that
 *                              actually protects our cost base, and it is
 *                              reached long before anything else.
 *   3. BLOCK NON-ESSENTIAL   — the features nobody's deadline depends on.
 *   4. (never) BLOCK READS   — reading your own data is not a lever.
 *   5. (never) BLOCK EXPORT  — see `permitsExport`. Holding a customer's
 *                              books hostage over an invoice is a DPDP
 *                              problem, not a collections strategy.
 *   6. (never) BLOCK STATUTORY WORK ALREADY IN FLIGHT — payroll, TDS,
 *                              GST returns, PF/ESI. See below.
 *
 * `lib/billing/access-state.ts` implements rungs 1–3 as `AccessLevel`.
 * This file owns the TIMING (how long each rung lasts) and the FLOOR (what
 * the ladder may never reach), because those two are product decisions
 * that a support engineer must be able to change without a code review.
 */

/* ------------------------------------------------------------------ */
/* TIMING — CONFIGURATION WITH A STATED DEFAULT, NOT A CONSTANT        */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ WHY THIS IS CONFIGURATION AND NOT A `const`.
 *
 * A grace window is a commercial promise. It gets renegotiated — for an
 * enterprise contract, for a region where mandate failures are common, for
 * the fortnight after a payment provider outage that was our fault. Every
 * one of those is a support conversation, and none of them should require
 * a deploy.
 *
 * ⭐ The DEFAULT is stated here, in the code, as the answer when nothing
 * is configured — not hidden in an env file that a new environment will
 * forget to set. An unset variable produces the documented behaviour, not
 * zero days of grace, which is the failure mode this shape exists to
 * prevent.
 */
export type GracePolicy = {
  /** Days before a trial ends that the product starts saying so. */
  trialNoticeDays: number;
  /** Days AFTER a trial ends during which writes still work. */
  trialGraceDays: number;
  /**
   * Days after a subscription goes `unpaid` before writes are restricted.
   * Longer than the trial window on purpose: a paying customer whose card
   * failed has already demonstrated intent, and card re-issue in India
   * routinely takes a week.
   */
  dunningGraceDays: number;
};

/**
 * 🔴 THE STATED DEFAULTS. Change these and you have changed a promise.
 *
 * 3 trial days: a trial that stops at midnight on day 14 catches people
 * mid-evaluation — often the ones about to buy.
 *
 * 7 dunning days: covers a failed mandate, a weekend, and the two working
 * days a bank takes to reissue. Anything shorter punishes the customer for
 * their bank's calendar.
 */
export const GRACE_DEFAULTS: Readonly<GracePolicy> = Object.freeze({
  trialNoticeDays: 5,
  trialGraceDays: 3,
  dunningGraceDays: 7,
});

/**
 * Upper bounds, so a typo cannot become an indefinite free tier.
 *
 * ⚠️ A misconfigured value CLAMPS rather than throwing. Refusing to boot
 * over a bad grace setting would take the whole product down to protect
 * revenue, which is the wrong trade in both directions.
 */
const MAX_DAYS: Readonly<GracePolicy> = Object.freeze({
  trialNoticeDays: 30,
  trialGraceDays: 30,
  dunningGraceDays: 60,
});

/**
 * Parse one configured value. Anything unparseable, negative or absurd
 * falls back to the stated default rather than to zero — a grace window
 * that silently became zero is indistinguishable, from the customer's
 * side, from a product that lied about having one.
 */
function resolveDays(
  raw: string | undefined,
  key: keyof GracePolicy,
): number {
  if (raw === undefined || raw.trim() === "") return GRACE_DEFAULTS[key];
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return GRACE_DEFAULTS[key];
  return Math.min(parsed, MAX_DAYS[key]);
}

/**
 * The policy in force.
 *
 * ⚠️ `NEXT_PUBLIC_` on purpose. The banner that tells a customer how many
 * days they have left renders on the client, and a client that computed a
 * different number from the server would be worse than no banner at all.
 * These are not secrets — the customer is entitled to know the window.
 *
 * Read through an explicit `process.env.X` member expression, never
 * `process.env[name]`: Next inlines the former at build time and cannot
 * inline the latter, which would make every value `undefined` in the
 * browser and quietly restore the hardcoded defaults on one side only.
 */
export function gracePolicy(): GracePolicy {
  return {
    trialNoticeDays: resolveDays(
      process.env.NEXT_PUBLIC_ORDENCE_TRIAL_NOTICE_DAYS,
      "trialNoticeDays",
    ),
    trialGraceDays: resolveDays(
      process.env.NEXT_PUBLIC_ORDENCE_TRIAL_GRACE_DAYS,
      "trialGraceDays",
    ),
    dunningGraceDays: resolveDays(
      process.env.NEXT_PUBLIC_ORDENCE_DUNNING_GRACE_DAYS,
      "dunningGraceDays",
    ),
  };
}

/** Exposed for the test that pins clamping behaviour without touching env. */
export function resolveGracePolicy(env: Partial<Record<string, string>>): GracePolicy {
  return {
    trialNoticeDays: resolveDays(env.NEXT_PUBLIC_ORDENCE_TRIAL_NOTICE_DAYS, "trialNoticeDays"),
    trialGraceDays: resolveDays(env.NEXT_PUBLIC_ORDENCE_TRIAL_GRACE_DAYS, "trialGraceDays"),
    dunningGraceDays: resolveDays(
      env.NEXT_PUBLIC_ORDENCE_DUNNING_GRACE_DAYS,
      "dunningGraceDays",
    ),
  };
}

/* ------------------------------------------------------------------ */
/* THE FLOOR — WHAT THE LADDER MAY NEVER REACH                         */
/* ------------------------------------------------------------------ */

/**
 * 🔴 STATUTORY WORK IS EXEMPT FROM DUNNING. ALL OF IT. AT EVERY RUNG.
 *
 * These prefixes name the writes that discharge a legal obligation with a
 * government deadline attached. They are exempt for a different reason
 * from `billing:` and `payment:` — those are exempt so the customer can
 * pay us, which is self-interested. These are exempt because the harm of
 * blocking them lands on a third party (an employee who is not paid, a
 * return that is filed late) who has no part in the billing dispute at
 * all, and because the penalty is statutory rather than commercial.
 *
 * ⚠️ ADDING A PREFIX HERE WIDENS A HOLE IN THE PAYWALL. Each one is
 * justified by a specific Indian filing deadline, and a prefix that cannot
 * name one does not belong here:
 *
 *   payroll:   — salary disbursal, and PF/ESI/PT that ride on it.
 *   tds:       — TDS deposit by the 7th; late deposit carries interest
 *                under s.201(1A) that the CUSTOMER pays.
 *   gst:       — GSTR-1/3B filing; a late return blocks the recipient's
 *                input credit, so the harm is to their customers too.
 *   compliance:— statutory registers and returns with fixed due dates.
 *
 * ⚠️ These exempt the WRITE, not the FEATURE. A workspace that never
 * bought the payroll module still cannot run payroll — an entitlement is
 * a different question from good standing, and merging them would let a
 * dunning exemption hand out a module nobody paid for.
 */
export const STATUTORY_WRITE_PREFIXES = [
  "payroll:",
  "tds:",
  "gst:",
  "compliance:",
] as const;

export function isStatutoryWrite(operation: string): boolean {
  return STATUTORY_WRITE_PREFIXES.some((prefix) => operation.startsWith(prefix));
}
