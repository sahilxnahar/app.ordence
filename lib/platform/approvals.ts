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

/* ================================================================== */
/* ⭐⭐⭐ LISTED IS NOT ENFORCED                                        */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE LIST ABOVE DESCRIBES WHAT SHOULD BE HELD. UNTIL v1.32.0 THE
 *      APPROVALS SCREEN PRESENTED IT AS WHAT IS HELD.
 * ══════════════════════════════════════════════════════════════════════
 * `app/platform/approvals/page.tsx` mapped over `APPROVAL_POLICIES` and
 * printed all six under "What is held, and why". One was held. The other
 * five were rows nothing enforced: the actions they name still executed
 * the moment somebody clicked them.
 *
 * ⚠️ THAT IS WORSE THAN HAVING NO SCREEN, AND THE REASON IS NOT
 * PEDANTIC. A missing control produces a question — "so what stops
 * somebody terminating a workspace by accident?" — and questions get
 * answered. A dead control answers it first, wrongly, and it is never
 * asked again. An audit reads the same screen and records the gap as
 * covered, which is how a gap survives a review.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ ENFORCED MEANS BOTH HALVES OF THE ROUND TRIP EXIST
 * ══════════════════════════════════════════════════════════════════════
 *   ① A REQUEST PATH — something an operator can actually reach that
 *      calls `queueForApproval` INSTEAD OF doing the thing. Without it
 *      the policy is a row nobody can create, and the dangerous action
 *      keeps its old immediate door. This is the state that reads most
 *      like enforcement from outside, because the queue exists, the
 *      screen exists, and nothing ever appears in it.
 *
 *   ② AN EXECUTOR — a registration in the server's map, so an approved
 *      row becomes the same function call it would have been. Without it
 *      a request can be raised and approved and then refuses to run,
 *      which is the most confusing possible ordering of events.
 *
 * ⚠️ ① IS DECLARED HERE AND ② IS OBSERVED AT RUNTIME, and the asymmetry
 * is forced rather than chosen. A registry can be read; a function that
 * has never been called cannot be distinguished from one that does not
 * exist, and waiting for the first request before admitting a path
 * exists would report every policy as unenforceable on a cold boot.
 *
 * 🔴 SO THE DECLARATION IS PINNED BY A TEST. `tests/ui/approval-
 * policies.test.ts` compares these keys against the actual `kind:`
 * literals in `server/platform/control-actions.ts` in BOTH directions.
 * Adding a request path without listing it here fails; listing one that
 * does not exist fails. That is what stops this table becoming the next
 * hand-maintained list that quietly goes stale.
 */
export const REQUEST_PATHS: Readonly<Partial<Record<ApprovalKind, string>>> =
  Object.freeze({
    "tenant.suspend":
      "requestSuspend() in server/platform/control-actions.ts, reached from the Suspend dialog on a tenant's page.",
    "tenant.terminate":
      "requestTermination() in server/platform/control-actions.ts, reached from the termination panel on a tenant's page. Approving SCHEDULES a deletion and locks the workspace read-only; it does not delete.",

    /*
     * ══════════════════════════════════════════════════════════════════
     * ⭐⭐⭐ THE THREE WIRED IN v1.58.0, AND WHY THEY DO NOT LOOK LIKE
     *        THE FIRST TWO
     * ══════════════════════════════════════════════════════════════════
     * `tenant.suspend` and `tenant.terminate` are raised by a WRAPPER: a
     * dedicated `requestX()` in `control-actions.ts` that queues instead
     * of acting, with the real function unexported so the wrapper is the
     * only door.
     *
     * 🔴 THAT SHAPE DOES NOT WORK FOR THESE THREE, AND SHIPPING IT
     * ANYWAY WOULD HAVE PRODUCED A THIRD DECORATIVE CONTROL. Each of
     * them has MORE THAN ONE existing door:
     *
     *   · an entitlement override is written by `setTenantFlag` (the flag
     *     panel, `applyEntitlementChange`, `revertEntitlementChange`) AND
     *     by `setModuleEntitlement` (the module switchboard);
     *   · a plan change is written by `setPlanAndLimits`, which is also
     *     the only place `limits.storage_mb` is reconciled;
     *   · a grade is written by `grantPlatformStaff`, which is also the
     *     renewal path.
     *
     * A wrapper in front of one door leaves the others open, and
     * `BLOCKED_BECAUSE` said so itself: "a control with an open door next
     * to it is decoration".
     *
     * ⭐ SO THE HOLD IS INSIDE THE WRITING FUNCTION, IN THE SAME
     * TRANSACTION AS THE WRITE IT GOVERNS. The function reads the facts
     * that decide whether the policy applies (is this workspace paying,
     * is this really a tier change, is this really an elevation) from the
     * same transaction it would have written in, and returns without
     * writing. There is no door to leave open, because the gate is the
     * floor rather than the door.
     */
    "entitlement.override_paid":
      "setTenantFlag() in server/platform/flags.ts and setModuleEntitlement() in server/platform/configuration.ts. Both hold the write inside their own transaction when the workspace is a PAYING one and the key is an entitlement, and queue it instead. Trial and unpaid workspaces are untouched — see APPROVAL_POLICIES' note on what is deliberately absent.",
    "staff.elevate":
      "grantPlatformStaff() in server/platform/staff.ts, which holds the write inside its own transaction when the requested grade is above the grade that account holds today. A renewal at the same grade and a downgrade are not elevations and are not held.",
    "tenant.plan_change":
      "setPlanAndLimits() in server/platform/configuration.ts, which holds the write inside its own transaction when the tier actually changes. Seat and storage edits at the same tier do not change the invoice and are not held.",
  });

/**
 * ⭐ WHY EACH UNENFORCED POLICY IS UNENFORCED, IN THE WORDS AN OPERATOR
 * AND AN AUDITOR BOTH NEED.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THESE ARE PRECONDITIONS, NOT APOLOGIES. "This policy will apply
 * once X exists" is a sentence somebody can plan around and chase.
 * "Coming soon" is not, and an unexplained gap gets read as an oversight
 * that somebody then helpfully papers over.
 * ══════════════════════════════════════════════════════════════════════
 *
 * 🔴 NONE OF IT IS PRINTED WHEN THE GAP IS GONE. `enforcementReport`
 * blanks the text the moment both halves exist, because a caveat that
 * outlives its own fix is how a screen starts lying in the other
 * direction.
 *
 * ⚠️ THE HONEST ANSWER FOR TWO OF THESE IS "IT CANNOT BE WIRED", NOT
 * "IT HAS NOT BEEN WIRED YET", and the two are recorded differently on
 * purpose — one is a backlog item, the other is a design constraint that
 * a future attempt needs to know about before it starts.
 */
export const BLOCKED_BECAUSE: Readonly<Record<ApprovalKind, string>> = Object.freeze({
  /**
   * Enforced. Present so the record stays exhaustive: `Record<ApprovalKind,
   * string>` means a seventh policy cannot be added without somebody
   * being made to write this sentence for it.
   */
  "tenant.suspend": "",

  /**
   * ⭐ ENFORCED SINCE v1.58.0. Blanked by `enforcementReport` while both
   * halves exist; retained because the diagnosis is the useful part.
   *
   * ⚠️ IT WAS THE MOST MISLEADING OF THE FIVE, because half of it was
   * built. An executor was registered, so a queued row of this kind
   * would have run correctly — there was simply no way to create one,
   * and the two live doors (the flag panel and the module switchboard)
   * both wrote immediately.
   */
  "entitlement.override_paid":
    "Was half-built, and the built half was the wrong half: the executor was " +
    "registered and worked, but nothing raised the request — setTenantFlag and " +
    "setModuleEntitlement both wrote immediately, so an override on a paying " +
    "customer took effect the instant it was clicked. This policy will apply " +
    "wherever an entitlement key is written for a workspace that is actually " +
    "paying; both writers now hold it in their own transaction.",

  /**
   * ⭐ ENFORCED SINCE v1.33.0, AND IT ARRIVED THE RIGHT WAY ROUND.
   *
   * ⚠️ FOR MOST OF THIS FILE'S LIFE THE HONEST TEXT HERE WAS "nothing in
   * this build terminates a workspace" — there was no delete path, no
   * archive path and no scheduled-deletion path, so there was no call
   * site for an approval to sit in front of. `lib/platform/roles.ts`
   * made the same observation from the other direction, which is why
   * provisioning is a step-up capability: a workspace minted by mistake
   * could not be un-minted.
   *
   * 🔴 THE MISTAKE WORTH AVOIDING WAS BUILDING TERMINATION FIRST AND
   * WIRING THE APPROVAL AFTERWARDS, and it was avoided: the request
   * path, the executor and the queue arrived in the same change. The
   * sentence is retained rather than deleted because the next unwired
   * policy on this list is in exactly the position this one was in.
   */
  "tenant.terminate":
    "Termination has to exist before an approval can hold it. This policy will " +
    "apply the moment a request path and an executor both exist — and building " +
    "termination without wiring them in the same change would be the mistake.",

  /**
   * ⚠️ THIS ONE IS A DESIGN CONSTRAINT AND NOT A BACKLOG ITEM. Anybody
   * who later tries to wire it needs to read this before they start, or
   * they will ship a queue that hands the customer's data to the wrong
   * engineer.
   */
  "impersonate.break_glass":
    "It cannot go through this queue as the queue is built, and wiring it anyway " +
    "would be worse than leaving it out. An executor runs inside the APPROVER's " +
    "request, and startImpersonation binds the session it creates to whoever is " +
    "calling — staff id, Clerk id, email, and the live banner. Approving a queued " +
    "break-glass would open the customer's workspace for the approver rather than " +
    "for the engineer who needs it, and would name the wrong person in the email " +
    "the customer receives. It keeps its own controls instead: owner grade, a " +
    "written reason, a refusal if usable consent exists, an out-of-band email to " +
    "the customer, an alert to the platform owners, and a post-incident write-up " +
    "that blocks the next one.",

  /**
   * ⭐ ENFORCED SINCE v1.58.0, and note HOW the open-door problem was
   * solved rather than worked around: the hold moved into
   * `grantPlatformStaff` itself, so it does not matter how many wrappers
   * or screens reach it.
   */
  "staff.elevate":
    "A queue in front of grantPlatformStaffAction would have sat beside " +
    "grantPlatformStaff, which other callers still reach — and a control with an " +
    "open door next to it is decoration. This policy will apply inside " +
    "grantPlatformStaff itself, on any write that raises an account's grade. It " +
    "was never unguarded meanwhile: owner grade, a fresh step-up, a deploy-time " +
    "allowlist entry, a mandatory expiry, and a refusal to grant or renew your " +
    "own access.",

  /**
   * ⭐ ENFORCED SINCE v1.58.0, in `setPlanAndLimits` rather than in front
   * of it, for the same reason as the two above.
   */
  "tenant.plan_change":
    "Same shape as the one above. setPlanAndLimits is the enforcement point and " +
    "setPlanAndLimitsAction reached it directly, so a request path added on its " +
    "own would have left the immediate route running alongside the queue. This " +
    "policy will apply inside setPlanAndLimits, on any write that moves the tier; " +
    "seat and storage edits at the same tier do not change the invoice and are " +
    "not held.",
});

/* ================================================================== */
/* ⭐⭐⭐ WHAT EACH POLICY ACTUALLY GOVERNS                            */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 REQUESTS ALREADY IN FLIGHT WHEN A POLICY IS SWITCHED ON
 * ══════════════════════════════════════════════════════════════════════
 * These policies are constants compiled into the build, so "switched on"
 * means "deployed". The question is still real, because a deploy lands
 * while work is half done: an operator has the plan editor open, a
 * customer is on the phone, and the tier change they are three seconds
 * from saving is now held.
 *
 * ⭐ THE CHOICE HERE IS: ENFORCEMENT IS DECIDED AT THE MOMENT OF THE
 * WRITE, NEVER AT THE MOMENT THE WORK STARTED. There is no grace period,
 * no "requests begun before the deploy still go straight through", and no
 * flag that exempts an in-flight edit.
 *
 * ⚠️ THE ALTERNATIVE WAS CONSIDERED AND IS WORSE, in the specific way
 * this whole batch is about. A non-retroactive control is OFF for an
 * unbounded window — nobody can say when the last pre-deploy form was
 * submitted, so nobody can say when the control started being true, and
 * "it is enforced" becomes a claim with no date attached. That is the
 * decorative-control failure wearing a different hat.
 *
 * 🔴 THE COST IS PAID AND NAMED: work legitimately begun can be
 * stranded. It is stranded SAFELY — the operator is told, in the same
 * response, that nothing happened and that a request is waiting, with
 * their own typed reason carried into it. Nothing is lost except the
 * click, and the refusal is written to the action register with the
 * policy that caused it, so a burst of them straight after a deploy is
 * visible rather than mysterious.
 *
 * ⚠️ THE ONE THING THAT IS NOT RETROACTIVE IS AN ALREADY-APPROVED ROW.
 * A queue row approved under the rules of the build that approved it is
 * replayed as approved; see `replayVerdict` below for what is re-checked
 * at the moment it runs. Re-litigating a decision a human already made
 * would mean an approval could silently stop meaning anything.
 */

/**
 * ⚠️ THE SAME SET `lib/billing/access-state.ts` TREATS AS LAPSED, listed
 * here rather than imported because this module has to stay free of
 * anything a jsdom test or a client bundle cannot load.
 */
export const LAPSED_SUBSCRIPTION_STATUSES: readonly string[] = Object.freeze([
  "unpaid",
  "past_due",
  "cancelled",
  "incomplete_expired",
  "expired",
  "incomplete",
]);

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 "PAYING" IS A bigint COMPARISON, NOT A TRUTHINESS TEST
 * ══════════════════════════════════════════════════════════════════════
 * Money in Ordence is bigint minor units end to end. The tempting
 * `Number(amount) > 0` is wrong twice: it re-introduces float at the
 * exact point a policy turns on or off, and it treats a missing
 * subscription and a zero-rupee one as the same thing when they are not.
 *
 * ⚠️ A ZERO-AMOUNT SUBSCRIPTION IS NOT A PAYING CUSTOMER. Internal
 * workspaces, permanent comps and demo tenants all carry one, and
 * holding an entitlement change on them would put routine work in a
 * queue — which is how a queue becomes a rubber stamp.
 *
 * ⚠️ NEITHER IS A TRIAL, and that is a decision `APPROVAL_POLICIES`
 * already recorded: overrides on trial workspaces are deliberately
 * absent from the list.
 */
export function isPayingWorkspace(args: {
  readonly planTier: string;
  readonly subscriptionStatus: string | null;
  readonly unitAmountMinor: bigint | null;
}): boolean {
  if (args.planTier === "trial") return false;
  if (args.subscriptionStatus === null) return false;
  if (args.subscriptionStatus === "trialing") return false;
  if (LAPSED_SUBSCRIPTION_STATUSES.includes(args.subscriptionStatus)) return false;
  if (args.unitAmountMinor === null) return false;
  // 🔴 bigint to bigint. Never Number(), never parseFloat, never × 100.
  return args.unitAmountMinor > 0n;
}

/**
 * ⭐ `entitlement:` AND NOTHING ELSE. `platform_tenant_flags` carries four
 * namespaces in one table (see `getTenantFlags`); holding a `beta.*`
 * toggle or a `config:` row would be a queue firing on routine work, and
 * holding a `lifecycle:` row would put the offboarding record behind the
 * control that offboarding already goes through.
 */
export function isEntitlementOverrideKey(flagKey: string): boolean {
  return flagKey.startsWith("entitlement:");
}

/**
 * ⚠️ HELD IN BOTH DIRECTIONS, DELIBERATELY, and this is the one place
 * this file departs from the "switching something off is never blocked"
 * rule that `setTenantFlag` and `setModuleEntitlement` both state.
 *
 * That rule exists for KILL SWITCHES: the moment you most need to turn
 * something off is the moment a form refusing you is most expensive. An
 * `entitlement:` key is not a kill switch — `flagDefinitionFor` says so
 * itself — it is what the customer bought. Taking a module away from a
 * paying customer is not an emergency stop, it is the same commercial
 * change as granting one, and the policy's own sentence covers both:
 * "changing it without them asking is either a mistake or a discount
 * nobody recorded".
 */
export function entitlementOverrideIsHeld(args: {
  readonly flagKey: string;
  readonly planTier: string;
  readonly subscriptionStatus: string | null;
  readonly unitAmountMinor: bigint | null;
}): boolean {
  return isEntitlementOverrideKey(args.flagKey) && isPayingWorkspace(args);
}

/**
 * ⭐ AN ELEVATION IS A RISE IN RANK, AND A FIRST GRANT IS A RISE FROM
 * NOTHING.
 *
 * ⚠️ THE THREE CASES ARE SEPARATED ON PURPOSE, because the interesting
 * one is the middle:
 *
 *   · `null → anything` is an elevation. Somebody who could do nothing
 *     to any customer can now do something to all of them.
 *   · `owner → owner` is a RENEWAL, not an elevation. Holding renewals
 *     would put a routine expiry-extension in the queue every quarter,
 *     and `grantPlatformStaff` already refuses to renew your OWN access,
 *     which is the abuse that matters.
 *   · `owner → support` is a DOWNGRADE. Reducing somebody's power must
 *     always be cheaper than increasing it, or the controls protect the
 *     wrong direction — the same asymmetry offboarding uses for cancel
 *     versus terminate.
 */
export function elevatesGrade(from: PlatformGrade | null, to: PlatformGrade): boolean {
  if (from === null) return true;
  return GRADE_RANK[to] > GRADE_RANK[from];
}

/**
 * ⚠️ THE TIER, NOT THE LIMITS. `setPlanAndLimits` writes three things and
 * only one of them changes the invoice. Seat and storage ceilings are the
 * configuration chain's business and are edited during ordinary support
 * work; holding them would teach the approver to approve without reading,
 * which is the failure `APPROVAL_POLICIES` opens by warning about.
 */
export function planChangeIsHeld(fromTier: string, toTier: string): boolean {
  return fromTier !== toTier;
}

/* ------------------------------------------------------------------ */
/* ⭐⭐⭐ THE FOUR-EYES RE-CHECK, AT THE MOMENT OF THE WRITE            */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE COMMONEST BROKEN FOUR-EYES IMPLEMENTATION CHECKS ROLE AND
 *      CALLS IT IDENTITY
 * ══════════════════════════════════════════════════════════════════════
 * "An owner approved it" is not the control. The control is that the
 * human who approved it is a DIFFERENT human from the one who asked, and
 * the two are indistinguishable on a platform where one person holds
 * both roles — which is every small platform, including this one. A test
 * written by whoever wrote that bug passes, because they instinctively
 * use two accounts.
 *
 * ⭐ SO IT IS COMPARED BY STAFF ID, TWICE. Once in `mayApprove`, at the
 * moment somebody presses Approve; and once HERE, inside the transaction
 * that performs the write, against the row as it stands at that instant.
 * Postgres backs it a third time with `CHECK (approver_id IS NULL OR
 * approver_id <> requested_by OR self_approved)`.
 *
 * ⚠️ `selfApproved` IS THE ONLY WAY approver == requester PASSES, and it
 * is not a bypass: it is set by `mayApprove` only when there was
 * genuinely nobody else at or above the policy's grade to ask AND
 * fifteen minutes had passed. It is recorded in the row and in the log
 * so it can be counted.
 */
export type ApprovalReplayRow = {
  readonly actionKind: string;
  readonly status: string;
  readonly targetId: string | null;
  readonly requestedBy: string;
  readonly approverId: string | null;
  readonly selfApproved: boolean;
  readonly executedAt: Date | null;
};

export type ReplayVerdict = { ok: true; selfApproved: boolean } | { ok: false; reason: string };

export function replayVerdict(args: {
  readonly row: ApprovalReplayRow | null;
  readonly kind: ApprovalKind;
  /** The thing being written to, or null for a policy with no tenant. */
  readonly targetId: string | null;
}): ReplayVerdict {
  const { row } = args;

  if (!row) {
    return {
      ok: false,
      reason:
        "This change says it was approved, and there is no such approval. Nothing has been written.",
    };
  }

  if (row.actionKind !== args.kind) {
    return {
      ok: false,
      reason: `That approval was for "${row.actionKind}", not for "${args.kind}". An approval is not a token that opens other doors.`,
    };
  }

  // ⚠️ THE TARGET IS PART OF THE APPROVAL. An approved plan change for
  // one workspace must not be replayable against another, which is the
  // whole value of freezing `targetLabel` at request time.
  if (args.targetId !== null && row.targetId !== args.targetId) {
    return {
      ok: false,
      reason:
        "That approval names a different workspace. Approving a change to one customer does not approve it for another.",
    };
  }

  if (row.status !== "approved") {
    return {
      ok: false,
      reason: `That request is ${row.status}, not approved. Nothing has been written.`,
    };
  }

  if (row.executedAt !== null) {
    return {
      ok: false,
      reason:
        "That approval has already been carried out. Running it twice would apply the same change again with one authorisation.",
    };
  }

  if (row.approverId === null) {
    return {
      ok: false,
      reason: "That request records no approver. Nothing has been written.",
    };
  }

  // 🔴🔴 IDENTITY. NOT ROLE. This is the line the whole control is.
  if (row.approverId === row.requestedBy && !row.selfApproved) {
    return {
      ok: false,
      reason:
        "The approver and the requester are the same person, and this was not recorded as a self-approval. Nothing has been written.",
    };
  }

  return { ok: true, selfApproved: row.selfApproved };
}

export type PolicyEnforcement = {
  readonly kind: ApprovalKind;
  readonly label: string;
  readonly because: string;
  readonly approverGrade: PlatformGrade;
  readonly expiryHours: number;
  /** ⭐ The ONLY field a screen may draw a "this is covered" badge from. */
  readonly enforced: boolean;
  readonly hasRequestPath: boolean;
  readonly hasExecutor: boolean;
  /** How a request of this kind is raised, or null if it cannot be. */
  readonly requestPath: string | null;
  /** Empty when enforced; the precondition otherwise. */
  readonly blockedBecause: string;
};

/**
 * ⚠️ THE REGISTERED KINDS ARE AN ARGUMENT, NOT AN IMPORT. This function
 * has to run in a jsdom test and in a React render as readily as on the
 * server, and reaching for the executor map would drag `@/db` into both.
 * Passing it in is also what lets a test prove the "executor present,
 * request path absent" case, which is the state that has actually been
 * shipping.
 */
export function enforcementReport(
  registeredKinds: readonly string[],
): readonly PolicyEnforcement[] {
  return APPROVAL_POLICIES.map((policy) => {
    const hasExecutor = registeredKinds.includes(policy.kind);
    const requestPath = REQUEST_PATHS[policy.kind] ?? null;
    const hasRequestPath = requestPath !== null;
    const enforced = hasExecutor && hasRequestPath;

    return {
      kind: policy.kind,
      label: policy.label,
      because: policy.because,
      approverGrade: policy.approverGrade,
      expiryHours: policy.expiryHours,
      enforced,
      hasRequestPath,
      hasExecutor,
      requestPath,
      // 🔴 BLANKED WHEN ENFORCED. See the note above `BLOCKED_BECAUSE`.
      blockedBecause: enforced ? "" : BLOCKED_BECAUSE[policy.kind],
    };
  });
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

/* ------------------------------------------------------------------ */
/* ⭐ THE REJECT VERDICT                                                */
/* ------------------------------------------------------------------ */

export type RejectVerdict =
  | { allowed: true; withdrawal: boolean }
  | { allowed: false; reason: string; withdrawal?: undefined };

/**
 * 🔴 REJECTING IS A DECISION ON A CONTROL, SO IT NEEDS THE SAME GRADE
 *    AS APPROVING.
 *
 * Until v1.31.0 the server's reject branch ran above `mayApprove` and
 * tested nothing: any grade could reject any request in any state. A
 * `support` account could clear an owner's queue during an incident,
 * and a row already `executed` could be rewritten to `rejected`,
 * destroying the record of who authorised what actually ran.
 *
 * ⚠️ WITHDRAWAL IS THE ONE EXCEPTION, and it is not a lower bar — it is
 * a different act. The person who raised a request may always pull it,
 * whatever their grade, because withdrawing your own unapproved request
 * takes nothing away from anybody. It is recorded as a withdrawal and
 * leaves `approver_id` NULL, so it never reads as a second operator
 * having considered and refused.
 */
export function mayReject(args: {
  readonly kind: string;
  readonly requestedBy: string;
  readonly approverId: string;
  readonly approverGrade: PlatformGrade;
  readonly status: string;
}): RejectVerdict {
  const policy = POLICY_BY_KIND[args.kind];
  if (!policy) {
    return { allowed: false, reason: "This action does not go through the queue." };
  }

  if (args.status !== "pending") {
    return {
      allowed: false,
      reason: `This request has already been ${args.status}. Rewriting a decided request would destroy the record of who decided it.`,
    };
  }

  if (args.approverId === args.requestedBy) {
    return { allowed: true, withdrawal: true };
  }

  if (!gradeAtLeast(args.approverGrade, policy.approverGrade)) {
    return {
      allowed: false,
      reason: `This needs ${policy.approverGrade} grade to decide either way. ${policy.because}`,
    };
  }

  return { allowed: true, withdrawal: false };
}

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
