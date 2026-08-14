/**
 * Ordence — ⭐⭐⭐ WHAT NEEDS A SECOND PAIR OF EYES
 * Version: v1.22.0-alpha
 *
 * Pure. No database, no network, no clock. `now` is always an argument.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE LOG RECORDS. IT DOES NOT STOP.
 * ══════════════════════════════════════════════════════════════════════
 * `platform_action_log` has captured every suspension, override and
 * impersonation since the console was built, with the operator and the
 * reason. None of it prevents anything.
 *
 * ⚠️ THE FAILURE IS NOT MALICE. It is a Tuesday afternoon, two tabs
 * open, the wrong workspace in the search box, and a live customer
 * suspended. The log captures that perfectly and forty-three people
 * still cannot work.
 *
 * 🔴 AND THE RECOVERY IS NOT SYMMETRIC. Un-suspending is one click.
 * Explaining twenty minutes of downtime to the customer is a
 * relationship, and no log helps with that conversation.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE LIST IS SHORT ON PURPOSE, AND THAT IS THE HARD PART
 * ══════════════════════════════════════════════════════════════════════
 * A queue that fires on routine work is a queue people learn to
 * rubber-stamp, and a rubber-stamped approval is worse than no approval
 * because it looks like a control in an audit. Every entry below had to
 * earn its place by being irreversible, expensive, or invisible.
 */

/** Mirrors `lib/platform/roles.ts`. */
export type PlatformGrade = "support" | "engineer" | "owner";

export type ApprovalKind =
  /** Locks a live business out of their ERP. */
  | "tenant.suspend"
  /** Irreversible. */
  | "tenant.terminate"
  /** Silently changes what a paying customer bought. */
  | "entitlement.override_paid"
  /** Access to a customer's data without their consent. */
  | "impersonate.break_glass"
  /** Creates another operator who can do all of this. */
  | "staff.elevate"
  /** Changes what they are billed. */
  | "tenant.plan_change";

export interface ApprovalPolicy {
  readonly kind: ApprovalKind;
  readonly label: string;
  /** The grade that may approve. Never the grade that may request. */
  readonly approverGrade: PlatformGrade;
  /** Why this one is on the list, in one sentence, for the screen. */
  readonly because: string;
  readonly expiryHours: number;
}

/**
 * 🔴 SIX. NOT SIXTEEN.
 *
 * ⚠️ NOTE WHAT IS DELIBERATELY ABSENT: provisioning, consented
 * read-only impersonation, and entitlement overrides on TRIAL
 * workspaces. All three are routine, all three are reversible, and
 * routing them through a queue would teach the operator to approve
 * without reading. The queue's value is entirely in how rarely it
 * appears.
 */
export const APPROVAL_POLICIES: readonly ApprovalPolicy[] = Object.freeze([
  Object.freeze({
    kind: "tenant.suspend",
    label: "Suspend a workspace",
    approverGrade: "owner",
    because:
      "Every person at that company stops working the moment this executes, and they find out by being locked out rather than by being told.",
    expiryHours: 4,
  }),
  Object.freeze({
    kind: "tenant.terminate",
    label: "Terminate a workspace",
    approverGrade: "owner",
    because: "There is no undo. Everything after this is a restore from backup.",
    expiryHours: 24,
  }),
  Object.freeze({
    kind: "entitlement.override_paid",
    label: "Change what a paying customer can use",
    approverGrade: "owner",
    because:
      "They are paying for a specific set of things. Changing it without them asking is either a mistake or a discount nobody recorded.",
    expiryHours: 4,
  }),
  Object.freeze({
    kind: "impersonate.break_glass",
    label: "Read a workspace without consent",
    approverGrade: "owner",
    because:
      "Every other route into a customer's data requires their permission. This is the one that does not, which is exactly why it needs somebody else's.",
    expiryHours: 1,
  }),
  Object.freeze({
    kind: "staff.elevate",
    label: "Raise an operator's grade",
    approverGrade: "owner",
    because:
      "It creates another person who can do everything on this list, and it is the quietest way for the blast radius to grow.",
    expiryHours: 24,
  }),
  Object.freeze({
    kind: "tenant.plan_change",
    label: "Change a workspace's plan",
    approverGrade: "owner",
    because: "It changes the invoice, and the customer sees it before we do.",
    expiryHours: 4,
  }),
]);

export const POLICY_BY_KIND: Readonly<Record<string, ApprovalPolicy>> =
  Object.freeze(Object.fromEntries(APPROVAL_POLICIES.map((p) => [p.kind, p])));

export function needsApproval(kind: string): boolean {
  return kind in POLICY_BY_KIND;
}

/* ------------------------------------------------------------------ */
/* THE SELF-APPROVAL RULE                                              */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ FIFTEEN MINUTES, AND THE REASONING MATTERS MORE THAN THE NUMBER.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ ORDENCE HAS ONE OPERATOR. A QUEUE THAT CANNOT BE CLEARED IS A
 * QUEUE THAT GETS DISABLED.
 * ══════════════════════════════════════════════════════════════════════
 * The textbook answer is that a request must be approved by somebody
 * else, full stop. Applied to a single-founder platform that rule
 * blocks the only person who can unblock it, at midnight, during the
 * incident it was meant to protect against. The predictable response is
 * to comment out the whole mechanism, and then there is no control at
 * all rather than a slightly weak one.
 *
 * 🔴 SO SELF-APPROVAL IS ALLOWED AND COSTS FIFTEEN MINUTES. The wait is
 * the entire control: the decision gets made twice, by the same person,
 * in two different moods. That is genuinely weaker than a second pair of
 * eyes and genuinely stronger than nothing, and pretending otherwise on
 * the screen would be the real failure.
 *
 * ⭐ It is flagged in the row and in the log, so an auditor can count
 * them, and it disappears the day a second operator exists.
 */
export const SELF_APPROVAL_WAIT_MINUTES = 15;

export type ApprovalVerdict =
  | { allowed: true; selfApproved: boolean; note: string | null }
  | { allowed: false; reason: string };

export function mayApprove(args: {
  readonly kind: string;
  readonly requestedBy: string;
  readonly requestedAt: Date;
  readonly approverId: string;
  readonly approverGrade: PlatformGrade;
  readonly status: string;
  readonly expiresAt: Date;
  readonly now: Date;
  /** ⚠️ True once a second operator exists. Closes the hatch. */
  readonly soleOperator: boolean;
}): ApprovalVerdict {
  const policy = POLICY_BY_KIND[args.kind];
  if (!policy) {
    return { allowed: false, reason: "This action does not go through the queue." };
  }

  if (args.status !== "pending") {
    return {
      allowed: false,
      reason: `This request has already been ${args.status}. Approving it again would run it twice.`,
    };
  }

  // ⚠️ EXPIRY IS CHECKED BEFORE GRADE, so a stale request tells the
  // operator it is stale rather than telling them they lack permission.
  if (args.now.getTime() > args.expiresAt.getTime()) {
    return {
      allowed: false,
      reason:
        "This request has expired. Whatever was true when it was raised may not be true now, so it has to be made again rather than approved late.",
    };
  }

  if (!gradeAtLeast(args.approverGrade, policy.approverGrade)) {
    return {
      allowed: false,
      reason: `This needs ${policy.approverGrade} grade to approve. ${policy.because}`,
    };
  }

  const isSelf = args.approverId === args.requestedBy;
  if (!isSelf) return { allowed: true, selfApproved: false, note: null };

  if (!args.soleOperator) {
    // 🔴 THE HATCH CLOSES THE MOMENT THERE IS SOMEBODY ELSE TO ASK.
    return {
      allowed: false,
      reason:
        "You raised this request, and there is another operator who can approve it. Self-approval is only available while you are the only one.",
    };
  }

  const waitedMinutes =
    (args.now.getTime() - args.requestedAt.getTime()) / 60_000;

  if (waitedMinutes < SELF_APPROVAL_WAIT_MINUTES) {
    const left = Math.ceil(SELF_APPROVAL_WAIT_MINUTES - waitedMinutes);
    return {
      allowed: false,
      reason: `You raised this ${Math.floor(waitedMinutes)} minute${Math.floor(waitedMinutes) === 1 ? "" : "s"} ago. Self-approval needs ${SELF_APPROVAL_WAIT_MINUTES}, so there are ${left} to go. The wait is the control: it makes you decide twice.`,
    };
  }

  return {
    allowed: true,
    selfApproved: true,
    note: "Approved by the operator who requested it, after the waiting period. Recorded as a self-approval.",
  };
}

const GRADE_RANK: Readonly<Record<PlatformGrade, number>> = Object.freeze({
  support: 0,
  engineer: 1,
  owner: 2,
});

export function gradeAtLeast(have: PlatformGrade, need: PlatformGrade): boolean {
  return GRADE_RANK[have] >= GRADE_RANK[need];
}

/**
 * ⚠️ JUSTIFICATION LENGTH IS CHECKED HERE AND IN THE DATABASE. Twenty
 * characters is not arbitrary: it is roughly the shortest sentence that
 * carries a reason rather than a word. "fix" and "asked" both fail,
 * "customer asked us to pause billing" passes, and that is the line.
 */
export const MIN_JUSTIFICATION = 20;

export function justificationProblem(text: string): string | null {
  const t = text.trim();
  if (t.length === 0) return "A reason is required.";
  if (t.length < MIN_JUSTIFICATION) {
    return `A reason of at least ${MIN_JUSTIFICATION} characters is required. This will be read months from now by somebody who was not here, and "${t}" will not help them.`;
  }
  return null;
}

export function expiryFor(kind: string, now: Date): Date {
  const hours = POLICY_BY_KIND[kind]?.expiryHours ?? 4;
  return new Date(now.getTime() + hours * 3_600_000);
}
