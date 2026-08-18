/**
 * Ordence — The Impersonation Policy
 * Version: v0.14.0-alpha
 *
 * Pure. The banner, the server gate, the SQL trigger's companion checks
 * and the tests all read this. It is the single hardest set of trade-offs
 * in the phase, so the reasoning is written down rather than encoded and
 * forgotten.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 1. THE CONSENT PROBLEM, STATED HONESTLY
 * ══════════════════════════════════════════════════════════════════════
 * The rule everybody agrees with — "never enter a customer's workspace
 * without their permission" — collides with the situation that actually
 * generates the need: something is broken, it is 03:00 in their timezone,
 * and nobody at the customer will answer for nine hours.
 *
 * Three models were considered.
 *
 *   (a) PER-INCIDENT CONSENT ONLY. The purest. Also the one that fails
 *       exactly when support matters most, and — this is the part that
 *       matters — it does not actually prevent access. It moves it. An
 *       engineer who cannot get into the console at 03:00 opens a
 *       database client instead, where there is no banner, no expiry, no
 *       forbidden-action list and no audit row naming them. A control
 *       that people must route around during incidents is a control that
 *       makes the system LESS observable, not more.
 *
 *   (b) STANDING CONSENT ONLY, signed once at contract time. Operationally
 *       painless and quietly the worst option: a checkbox agreed to in
 *       2024 by an employee who has since left becomes permanent,
 *       unreviewed access to everything. It is consent in name only.
 *
 *   (c) ⭐ BOTH, PLUS A NARROWER BREAK-GLASS. ← chosen.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE ARGUMENT FOR (c), IN ONE SENTENCE
 * ══════════════════════════════════════════════════════════════════════
 * The customer's INABILITY TO ANSWER should REDUCE what we may do, not
 * increase it.
 *
 * Everywhere else, "we could not reach anyone" is used as a reason to
 * grant more latitude. That is backwards. Consent is what converts a look
 * into an agreed look; without it, the only defensible position is that
 * we may DIAGNOSE and may not CHANGE. So:
 *
 *   standing_consent   → read_write, 60 min. Recorded once by a tenant
 *                        OWNER, expires in 90 days, revocable instantly
 *                        by the customer, visible in their own settings.
 *   incident_consent   → read_write, 60 min. Approved by a tenant admin
 *                        or owner for one incident; the approval itself
 *                        expires in 60 minutes if unused.
 *   break_glass        → READ-ONLY, 15 min. No consent exists. Requires
 *                        a written justification, an `engineer` grade or
 *                        above, immediate notification to the tenant's
 *                        owners, and a `critical` audit row.
 *
 * Break-glass therefore buys you the ability to LOOK, urgently, with your
 * name on it and the customer told within seconds. It never buys the
 * ability to change anything. Every change still needs a human at the
 * customer to have said yes — which is the property that made the rule
 * worth having in the first place.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 2. WHAT IS FORBIDDEN EVEN WITH FULL CONSENT
 * ══════════════════════════════════════════════════════════════════════
 * Consent is not a blank cheque; a customer agreeing that support may
 * "look at the workspace to fix the invoice bug" has not agreed to any of
 * the following. The test applied to build this list was:
 *
 *   • Can the customer UNDO it themselves? If not, forbid it.
 *   • Does it OUTLIVE the session? If so, forbid it.
 *   • Would they be surprised and angry to discover it? If so, forbid it.
 *
 * See `FORBIDDEN_UNDER_IMPERSONATION` below for the list and the
 * per-entry reason. The single most important entry is role and invite
 * management: an impersonator who can mint a `tenant_owner` or invite an
 * account they control has converted a 60-minute window into permanent
 * access, and nothing about the expiry mechanism would notice.
 */

import type { ImpersonationMode, ImpersonationScope } from "@/db/schema/platform";

/* ------------------------------------------------------------------ */
/* DURATIONS                                                           */
/* ------------------------------------------------------------------ */

/**
 * 🔴 THE HARD CAP — Batch 28. THIRTY MINUTES, FOR EVERY MODE, ALWAYS.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS IS A CEILING ON THE STORED ROW, NOT ONLY ON NEW SESSIONS
 * ══════════════════════════════════════════════════════════════════════
 * `expires_at` is written once at INSERT and frozen by the tamper trigger,
 * so lowering `SESSION_MINUTES` alone would leave every session started
 * before this change running for its original sixty minutes. There is no
 * migration that can fix that — the column cannot be updated, by design.
 *
 * ⭐ SO LIVENESS IS COMPUTED, NOT READ. `cappedExpiry()` takes the LOWER
 * of the stored `expires_at` and `started_at + 30 minutes`, and every
 * liveness question in the product goes through it. A sixty-minute row
 * written last month is over at minute thirty whatever its own column
 * says, and nothing had to be rewritten to make that true.
 *
 * ⚠️ `started_at` IS ALSO FROZEN by the same trigger, which is what makes
 * it safe to derive from. The one number an operator could otherwise move
 * to buy themselves more time is the one number the database refuses to
 * let anybody move.
 */
export const HARD_CAP_MINUTES = 30;

/**
 * Session length per mode, in minutes.
 *
 * Short by design. The cost of a session that expires mid-diagnosis is
 * one click; the cost of a session that quietly stays open is an operator
 * who is inside a customer's workspace at 18:00 having forgotten they
 * started at 09:00 — with every action they take from then on wrongly
 * attributed to the customer's own user in that customer's own audit log.
 *
 * ⚠️ SIXTY WAS TOO LONG AND THE ARGUMENT FOR IT WAS COMFORT. An hour is
 * long enough for an operator to start a session, get pulled into
 * something else, and come back to a workspace they have stopped thinking
 * about. Half an hour is long enough to diagnose anything and short
 * enough that nobody forgets they are in it.
 */
export const SESSION_MINUTES: Readonly<Record<ImpersonationMode, number>> = Object.freeze({
  standing_consent: HARD_CAP_MINUTES,
  incident_consent: HARD_CAP_MINUTES,
  break_glass: 15,
});

/** Hard ceiling. Nothing may request more, whatever it passes in. */
export const MAX_SESSION_MINUTES = HARD_CAP_MINUTES;

/** How long a standing consent lasts before the customer is re-asked. */
export const STANDING_CONSENT_DAYS = 90;

/** How long an unused incident approval remains usable. */
export const INCIDENT_CONSENT_MINUTES = 60;

/**
 * One live session per operator, and one per tenant.
 *
 * Two concurrent sessions for the same operator mean the banner in front
 * of them describes only one of them, which is the precise condition
 * under which somebody types into the wrong workspace.
 */
export const MAX_CONCURRENT_SESSIONS_PER_OPERATOR = 1;

/** Minimum characters in a justification. "fix" is not a justification. */
export const MIN_JUSTIFICATION_LENGTH = 20;

/* ------------------------------------------------------------------ */
/* SCOPE PER MODE                                                      */
/* ------------------------------------------------------------------ */

/**
 * The scope a mode is CAPABLE of. The consent row may narrow it further
 * (a customer may grant standing consent as read-only), never widen it.
 */
export const MAX_SCOPE: Readonly<Record<ImpersonationMode, ImpersonationScope>> =
  Object.freeze({
    standing_consent: "read_write",
    incident_consent: "read_write",
    // ⭐ The load-bearing line of the whole consent model.
    break_glass: "read_only",
  });

export function resolveScope(
  mode: ImpersonationMode,
  consentScope: ImpersonationScope | null,
): ImpersonationScope {
  const ceiling = MAX_SCOPE[mode];
  if (ceiling === "read_only") return "read_only";
  // No consent row (break-glass is already handled above) → read-only.
  if (!consentScope) return "read_only";
  return consentScope === "read_write" ? "read_write" : "read_only";
}

export function sessionMinutes(mode: ImpersonationMode): number {
  return Math.min(SESSION_MINUTES[mode], MAX_SESSION_MINUTES);
}

export function expiryFor(mode: ImpersonationMode, startedAt: Date): Date {
  return new Date(startedAt.getTime() + sessionMinutes(mode) * 60_000);
}

/* ------------------------------------------------------------------ */
/* LIVENESS                                                            */
/* ------------------------------------------------------------------ */

export type SessionLike = {
  /**
   * ⭐ THE STORED START, AND THE ONLY INPUT THE CAP TRUSTS — Batch 28.
   *
   * ⚠️ OPTIONAL, and the omission means "cap unknown, use the stored
   * expiry". Every DB row has it; the pure helpers are also called with
   * hand-built literals in tests and in the policy's own reasoning, and
   * demanding it there would have bought nothing.
   */
  startedAt?: Date;
  expiresAt: Date;
  endedAt: Date | null;
};

/**
 * ⭐ THE EFFECTIVE END OF A SESSION: the EARLIER of what the row says and
 * what the hard cap allows.
 *
 * ⚠️ NEVER THE LATER. This function can only ever shorten a session, so a
 * row written by a future bug — or by anything that reaches the table
 * outside the application — cannot buy itself extra minutes through it.
 */
export function cappedExpiry(session: SessionLike): Date {
  if (!session.startedAt) return session.expiresAt;
  const cap = new Date(session.startedAt.getTime() + HARD_CAP_MINUTES * 60_000);
  return cap.getTime() < session.expiresAt.getTime() ? cap : session.expiresAt;
}

/**
 * A session is live iff it has not been closed AND has not expired.
 *
 * ⚠️ `expiresAt` is the authority, NOT `endedAt`. If liveness depended on
 * a sweeper writing `ended_at`, a failed sweeper would silently extend
 * every open session in the system — the exact failure that "time-limited"
 * is supposed to rule out. The sweeper only tidies.
 *
 * ⚠️ AND THE AUTHORITY IS NOW THE CAPPED EXPIRY. `now` is supplied by the
 * caller, which on every server path is `new Date()` on the server. A
 * value that arrived from a browser must never reach this argument.
 */
export function isSessionLive(session: SessionLike, now: Date): boolean {
  if (session.endedAt !== null) return false;
  return cappedExpiry(session).getTime() > now.getTime();
}

export function minutesRemaining(session: SessionLike, now: Date): number {
  if (!isSessionLive(session, now)) return 0;
  return Math.max(0, Math.ceil((cappedExpiry(session).getTime() - now.getTime()) / 60_000));
}

/* ------------------------------------------------------------------ */
/* ⭐⭐⭐ READ-ONLY BY DEFAULT, AND LIFTING IT IS A SEPARATE ACT        */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE `scope` COLUMN IS A CEILING. IT IS NOT WHAT THE SESSION CAN DO.
 * ══════════════════════════════════════════════════════════════════════
 * Before Batch 28, a consent that said "read and write" produced a
 * session that WAS read-write from its first millisecond. That is the
 * wrong default, and the reason is not theoretical:
 *
 *   • The overwhelming majority of support sessions only ever READ. An
 *     engineer opens a workspace to see which invoice is wrong. Granting
 *     write for that is granting a capability nobody asked to use.
 *   • The customer's consent answers "may you change things IF you need
 *     to". It does not answer "are you about to". Treating the first as
 *     the second collapses a permission into an intention.
 *   • A mistyped keystroke in the wrong tab is the failure this whole
 *     subsystem exists for, and in a read-only session it is nothing.
 *
 * ⭐ SO: `resolveScope()` still computes what the CUSTOMER PERMITTED and
 * that is what is stored, frozen, as evidence. What the session may
 * actually DO starts at `read_only` for every mode, and only becomes
 * `read_write` when an operator performs a separate, reasoned act that is
 * written to the action register.
 *
 * ⚠️ THE STORED COLUMN COULD NOT HAVE CARRIED THE LIFT ANYWAY. `scope` is
 * in the frozen-columns list of `prevent_impersonation_tamper()` — an
 * UPDATE that changes it is refused by the database. That constraint is
 * correct and this design agrees with it rather than working around it:
 * the register is append-only too, so the lift is recorded in the one
 * kind of storage that cannot be quietly un-recorded.
 */
export function effectiveScope(input: {
  /** The frozen `scope` column: what the customer's consent permitted. */
  ceiling: ImpersonationScope;
  /** Has a lift been recorded in the action register for this session? */
  lifted: boolean;
}): ImpersonationScope {
  if (input.ceiling !== "read_write") return "read_only";
  return input.lifted ? "read_write" : "read_only";
}

/** Minimum characters in the reason given for taking write access. */
export const SCOPE_LIFT_MIN_REASON = 20;

/**
 * The `resource_type` a scope lift is filed under in the action register.
 *
 * ⚠️ IT LIVES IN THE PURE MODULE because three files need it and none of
 * them should have to import the one that pulls in Clerk and the mail
 * provider to get a string. `server/platform/impersonation.ts` writes it,
 * `server/platform/action-log.ts` reports on it, and
 * `server/platform/tenant-support-access.ts` reads the customer's own
 * copy of it. Three spellings of one string is three chances to have two
 * of them agree and one not.
 */
export const SCOPE_LIFT_RESOURCE = "impersonation_scope_lift";

/**
 * May this session be lifted to read-write? Returns the refusal sentence,
 * or null to allow.
 *
 * ⚠️ PURE, AND THAT IS THE POINT. The refusal that keeps break-glass
 * read-only is the load-bearing line of the consent model, and a refusal
 * that can only be exercised by standing up Postgres is a refusal that
 * gets tested once and then trusted forever.
 */
export function scopeLiftProblem(input: {
  mode: ImpersonationMode;
  ceiling: ImpersonationScope;
  alreadyLifted: boolean;
  reason: string;
}): string | null {
  // ⭐ The one refusal that must never be negotiable. Break-glass exists
  // precisely because the customer could not be reached, and "we could
  // not reach anyone" must REDUCE what we may do, never increase it.
  if (input.mode === "break_glass") {
    return (
      "Break-glass is read-only and cannot be lifted. Nobody at this workspace " +
      "agreed to this session, so nothing in it may be changed. If a change is " +
      "genuinely needed, reach a human at the customer and start a consented session."
    );
  }
  if (input.ceiling !== "read_write") {
    return (
      "This workspace granted support access for reading only. Ask them to widen " +
      "the grant in their own settings — we cannot widen it for them."
    );
  }
  if (input.alreadyLifted) {
    return "This session already has write access.";
  }
  if (input.reason.trim().length < SCOPE_LIFT_MIN_REASON) {
    return (
      `Say what you are about to change, in at least ${SCOPE_LIFT_MIN_REASON} ` +
      `characters. This sentence goes into the customer's own audit log.`
    );
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* HOW A SESSION ENDED                                                 */
/* ------------------------------------------------------------------ */

/**
 * ⭐ EVERY END REASON CARRIES A WORD, NOT A COLOUR.
 *
 * The register shows ended sessions in a table where the temptation is a
 * coloured dot. One in twelve Indian men is colour-blind, and "how did
 * this session end" is precisely the question a reviewer is there to
 * answer — so the answer is in words and the colour is emphasis.
 *
 * ⚠️ KEYED ON THE DATABASE ENUM. A reason added to
 * `impersonation_end_reason` without an entry here is a `TypeScript`
 * error at the call site rather than a blank cell in the register.
 */
export const END_REASON_LABELS = Object.freeze({
  operator_ended: "Ended by the operator",
  expired: "Expired on its own clock",
  revoked_by_tenant: "Ended by the workspace owner",
  revoked_by_platform: "Ended by a platform owner",
  session_binding_failed: "Terminated — used from a different address",
}) satisfies Readonly<Record<string, string>>;

export type ImpersonationEndReasonKey = keyof typeof END_REASON_LABELS;

export function endReasonLabel(reason: string | null): string {
  if (!reason) return "Still open";
  return (
    (END_REASON_LABELS as Record<string, string | undefined>)[reason] ??
    // An unknown value is reported as unknown rather than rendered blank.
    // A blank cell reads as "nothing happened", which is the one thing it
    // definitely does not mean.
    `Ended (${reason})`
  );
}

/* ------------------------------------------------------------------ */
/* THE FORBIDDEN LIST                                                  */
/* ------------------------------------------------------------------ */

/**
 * Operation namespaces an impersonator may NEVER perform, in any mode,
 * with any consent, at any grade.
 *
 * Matched as a PREFIX on the operation name a call site declares — the
 * same convention as `ALWAYS_PERMITTED_WRITE_PREFIXES` in
 * `lib/billing/access-state.ts`, so there is one vocabulary rather than
 * two.
 */
export const FORBIDDEN_UNDER_IMPERSONATION: Readonly<Record<string, string>> =
  Object.freeze({
    // ── Outlives the session → permanent access ────────────────────
    "roles:": "Role changes would survive the session and grant permanent access.",
    "users:invite":
      "An invited account is a credential the operator keeps after the window closes.",
    "users:remove": "Removing a user is not reversible by the customer in-product.",
    "users:update":
      "Editing a user record includes role and status, which outlive the session.",
    "apikeys:": "An API key created here is a credential that outlives the session.",
    "portal:create":
      "A portal link is a bearer credential; issuing one exports access, silently.",
    "integrations:":
      "An integration grant is a standing credential handed to a third party.",

    // ── Cannot be undone by the customer ───────────────────────────
    "delete:": "Deletion destroys the customer's evidence of what we did.",
    "periods:close":
      "Closing an accounting period is an attestation only the customer may make.",
    "periods:reopen": "Reopening a closed period rewrites signed-off financial history.",

    // ── Money the customer never sanctioned ────────────────────────
    "billing:": "Billing changes move real money the customer did not agree to.",
    "payment:": "Payment instruments must never be touched by anyone but the customer.",
    "subscription:": "A plan change is a purchase decision, not a support action.",

    // ── Would turn support into an exfiltration channel ─────────────
    "export:":
      "Bulk export under impersonation is exfiltration wearing the customer's face.",

    // ── Would let the impersonator authorise themselves ────────────
    "support:consent":
      "An impersonator granting their own consent makes the consent model circular.",
    "settings:security":
      "MFA and session policy changes weaken the controls protecting the customer.",
  });

export const FORBIDDEN_PREFIXES = Object.keys(FORBIDDEN_UNDER_IMPERSONATION);

export type OperationVerdict = {
  allowed: boolean;
  /** Populated when refused — shown to the operator and written to audit. */
  reason: string | null;
  rule: "forbidden" | "read_only_scope" | "not_impersonating" | "allowed";
};

/**
 * May this operation run right now?
 *
 * @param operation  Namespaced operation, e.g. `"contacts:update"`.
 * @param scope      The active session's scope, or null when not impersonating.
 *
 * ⚠️ FAILS CLOSED ON WRITES IN READ-ONLY SCOPE. `isWriteOperation` treats
 * anything it does not positively recognise as a read as a WRITE, so a
 * new verb added next year is refused under break-glass until somebody
 * classifies it. The alternative default silently admits it.
 */
export function evaluateOperation(
  operation: string,
  scope: ImpersonationScope | null,
): OperationVerdict {
  if (scope === null) {
    return { allowed: true, reason: null, rule: "not_impersonating" };
  }

  const forbidden = FORBIDDEN_PREFIXES.find((prefix) => operation.startsWith(prefix));
  if (forbidden) {
    return {
      allowed: false,
      reason: FORBIDDEN_UNDER_IMPERSONATION[forbidden] ?? "Forbidden under impersonation.",
      rule: "forbidden",
    };
  }

  if (scope === "read_only" && isWriteOperation(operation)) {
    return {
      allowed: false,
      reason:
        "This session is read-only. Changing the customer's data requires their consent.",
      rule: "read_only_scope",
    };
  }

  return { allowed: true, reason: null, rule: "allowed" };
}

/** Verbs that are unambiguously reads. Everything else counts as a write. */
const READ_VERBS = ["read", "list", "view", "search", "get", "render", "preview"] as const;

export function isWriteOperation(operation: string): boolean {
  const verb = operation.includes(":") ? operation.slice(operation.indexOf(":") + 1) : "";
  return !READ_VERBS.some((r) => verb === r || verb.startsWith(`${r}_`));
}

/* ------------------------------------------------------------------ */
/* DISPLAY                                                             */
/* ------------------------------------------------------------------ */

export const MODE_LABELS: Readonly<Record<ImpersonationMode, string>> = Object.freeze({
  standing_consent: "Standing consent",
  incident_consent: "Incident consent",
  break_glass: "BREAK-GLASS — no consent",
});

export const SCOPE_LABELS: Readonly<Record<ImpersonationScope, string>> = Object.freeze({
  read_only: "Read only",
  read_write: "Read and write",
});

/**
 * The one line the operator must not be able to misread.
 *
 * The banner is a safety control, not decoration: the failure it prevents
 * is an engineer typing into a customer's workspace believing it is their
 * own admin view. So it always names the tenant, always states the scope,
 * and always shows the countdown.
 */
export function bannerText(input: {
  tenantName: string;
  mode: ImpersonationMode;
  scope: ImpersonationScope;
  minutesLeft: number;
}): string {
  return (
    `IMPERSONATING ${input.tenantName} — ${SCOPE_LABELS[input.scope]} — ` +
    `${MODE_LABELS[input.mode]} — ${input.minutesLeft} min left`
  );
}
