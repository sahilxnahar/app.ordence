/**
 * Ordence — The Tenant Session Policy
 * Version: v1.36.0-alpha (Batch 136)
 * Runtime: ANY. Pure, no I/O, no `server-only`, no database, no Clerk import.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS FILE EXISTS TO REPAIR: TWO SETTINGS THAT MEANT NOTHING
 * ══════════════════════════════════════════════════════════════════════
 * `tenants.settings.requireMfa` and `tenants.settings.sessionIdleMinutes`
 * were validated (`server/actions/settings.ts`), defaulted (the Clerk
 * webhook), typed (`db/schema/core.ts`), rendered as a switch and a number
 * field, read back into that form — and READ BY NO GATE ANYWHERE. A tenant
 * admin ticked "require MFA", the form saved, the page showed it enabled,
 * and every request carried on exactly as before.
 *
 * ⚠️ THAT IS WORSE THAN THE FEATURE BEING ABSENT. An absent control is a
 * gap the customer can see and plan around. A control that reports itself
 * ON while enforcing nothing is a claim we make about other people's
 * payroll and GST filings that is not true. Same defect class as the three
 * approval policies of Batch 43.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE DECISION LIVES HERE AND NOT IN `middleware.ts`
 * ══════════════════════════════════════════════════════════════════════
 * Middleware runs in the Edge Runtime, which means no database driver, no
 * Node APIs and no way to write a test that does not stand up a request.
 * Every judgement in this file is therefore a function of values passed
 * in — the tenant's policy, Clerk's signed claims and a `now` the CALLER
 * supplies — so the refusals can be proved on a laptop with no Postgres,
 * no Clerk and no browser. The middleware and the CRM layout both call it
 * and can only agree, because there is one implementation to agree with.
 */

/* ------------------------------------------------------------------ */
/* THE POLICY, READ OUT OF A JSONB BLOB NOBODY VALIDATES ON READ        */
/* ------------------------------------------------------------------ */

/** Matches the bounds `server/actions/settings.ts` enforces on write. */
export const MIN_IDLE_MINUTES = 5;
export const MAX_IDLE_MINUTES = 1440;
/** Matches the value the Clerk webhook writes into every new tenant. */
export const DEFAULT_IDLE_MINUTES = 60;

export type TenantSessionPolicy = {
  requireMfa: boolean;
  idleMinutes: number;
};

/**
 * Read the two settings out of `tenants.settings` (or out of a session
 * claim carrying the same object).
 *
 * ⚠️ THE WRITE PATH'S ZOD SCHEMA IS NOT A GUARANTEE ON THE READ PATH.
 * `settings` is JSONB: rows predate the validator, a support script can
 * write it, and a restored backup can carry anything. So every field is
 * re-derived defensively here rather than trusted because a form once
 * checked it.
 *
 * ⚠️ AND THE DEFAULTS FAIL IN THE SAFE DIRECTION FOR EACH SETTING
 * SEPARATELY. Missing `requireMfa` means FALSE, because inventing a
 * second-factor requirement for a workspace that never asked for one
 * locks out a customer who has done nothing wrong. Missing or nonsense
 * `sessionIdleMinutes` means the 60 the webhook writes, not "unbounded" —
 * an unreadable number must not silently become no limit at all.
 */
export function readSessionPolicy(settings: unknown): TenantSessionPolicy {
  const bag = (settings ?? {}) as { requireMfa?: unknown; sessionIdleMinutes?: unknown };
  const raw = bag.sessionIdleMinutes;
  const parsed = typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : NaN;
  const idleMinutes = Number.isNaN(parsed)
    ? DEFAULT_IDLE_MINUTES
    : Math.min(MAX_IDLE_MINUTES, Math.max(MIN_IDLE_MINUTES, parsed));

  return { requireMfa: bag.requireMfa === true, idleMinutes };
}

/* ------------------------------------------------------------------ */
/* WHAT CLERK ACTUALLY TELLS US, AND WHAT IT DOES NOT                  */
/* ------------------------------------------------------------------ */

/**
 * ⭐ `fva` — FACTOR VERIFICATION AGE. Clerk's own claim, not ours.
 *
 * Clerk emits it as `[firstFactorAgeMinutes, secondFactorAgeMinutes]`,
 * where `-1` means "that factor was never verified on this session". It is
 * signed inside the session JWT, so a client can neither add it nor move
 * it — which is the entire reason both decisions below are built on it
 * rather than on anything the browser could hand us.
 *
 * ⚠️ THE SHAPE IS READ EXACTLY AS `server/platform/guard.ts` READS IT.
 * That file has depended on this claim since Phase 17; a second spelling
 * of "how do we ask Clerk about factors" is a second thing to be wrong.
 *
 * ⚠️ `measured: false` IS NOT `secondFactor: none`. If the deployment's
 * Clerk JWT template omits `fva`, we know NOTHING about factors — and the
 * two states are kept distinguishable here precisely so that each caller
 * can decide which way to fail rather than inheriting a `catch {}`.
 */
export type FactorEvidence = {
  /** Was a well-formed, Clerk-signed `fva` claim present? */
  measured: boolean;
  /** Minutes since the password/OTP step. `null` = never, or not measured. */
  firstFactorMinutes: number | null;
  /** Minutes since the SECOND factor. `null` = never, or not measured. */
  secondFactorMinutes: number | null;
};

export const NO_FACTOR_EVIDENCE: FactorEvidence = Object.freeze({
  measured: false,
  firstFactorMinutes: null,
  secondFactorMinutes: null,
});

export function readFactorEvidence(sessionClaims: unknown): FactorEvidence {
  const fva = (sessionClaims as { fva?: unknown } | null | undefined)?.fva;
  if (!Array.isArray(fva)) return NO_FACTOR_EVIDENCE;

  const age = (slot: unknown): number | null =>
    typeof slot === "number" && Number.isFinite(slot) && slot >= 0 ? slot : null;

  return {
    measured: true,
    firstFactorMinutes: age(fva[0]),
    secondFactorMinutes: age(fva[1]),
  };
}

/** Does this session demonstrably stand on a second factor? */
export function hasSecondFactor(factors: FactorEvidence): boolean {
  return factors.measured && factors.secondFactorMinutes !== null;
}

/* ------------------------------------------------------------------ */
/* THE PATHS THAT MUST STAY REACHABLE WHILE REFUSED                     */
/* ------------------------------------------------------------------ */

/** Where a user without a second factor is sent to acquire one. */
export const MFA_ENROLMENT_PATH = "/account/security";

/** Where an idle-expired session is sent to be ENDED, not merely refused. */
export const IDLE_SIGN_OUT_PATH = "/session-expired";

/**
 * 🔴 A GATE THAT ALSO BLOCKS THE CURE IS A LOCKED DOOR, NOT A CONTROL.
 *
 * Each entry is named, with the reason it is here. There is no wildcard
 * and no "anything under /account", because "it was exempt because of
 * where somebody put the file" is not a decision anyone made.
 *
 *   • `/account/security`  — the enrolment page itself. Refusing it would
 *     mean "you may not enter without a second factor, and you may not
 *     obtain one", which is every user of the tenant locked out forever
 *     the moment an admin ticks the box.
 *   • `/session-expired`   — the page that SIGNS THE USER OUT. Refusing it
 *     would bounce an idle session between the gate and its own remedy.
 *   • `/onboarding`        — the middleware already sends org-less sessions
 *     here; a second gate would fight the first for the same request.
 *   • `/access-denied`     — a terminal refusal page. Refusing a refusal
 *     produces a redirect loop and hides the original reason.
 *   • `/api/internal/host-moved` — the released-hostname resolver, which is
 *     the terminus of two other middleware exits and renders nothing.
 *
 * ⚠️ SIGNING OUT IS NOT ON THIS LIST BECAUSE IT DOES NOT NEED TO BE.
 * Clerk's sign-out is a client call to Clerk's own API followed by a
 * navigation to `/`, which `isPublicRoute` in `middleware.ts` forwards
 * before this policy is ever consulted. The one hazard — Clerk refreshing
 * the CURRENT route on its way out — lands on `/session-expired` for the
 * idle case, which is exempt above. Nobody can be gated into a session
 * they cannot leave.
 */
export const SESSION_POLICY_EXEMPT_PATHS: readonly string[] = Object.freeze([
  MFA_ENROLMENT_PATH,
  IDLE_SIGN_OUT_PATH,
  "/onboarding",
  "/access-denied",
  "/api/internal/host-moved",
]);

export function isSessionPolicyExempt(path: string): boolean {
  return SESSION_POLICY_EXEMPT_PATHS.some(
    (exempt) => path === exempt || path.startsWith(`${exempt}/`),
  );
}

/* ------------------------------------------------------------------ */
/* IDLE — THE CLOCK IS THE SERVER'S, AND IT ONLY EVER SHORTENS          */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE SAME MECHANISM AS BATCH 28'S IMPERSONATION CAP, ON PURPOSE.
 *
 * `lib/platform/impersonation-policy.ts` settled this argument once:
 * liveness is COMPUTED from a timestamp the server owns and a `now` the
 * SERVER passes in, and where two candidate ends exist the EARLIER wins —
 * `cappedExpiry()` can only ever shorten a session, never extend one.
 * This function is that rule applied to the tenant's own idle limit, and
 * it is deliberately not a second, differently-shaped clock that could
 * one day disagree with the first.
 *
 * 🔴 NOTHING THE CLIENT SENDS REACHES THIS FUNCTION. `lastVerifiedAtMs` is
 * derived from Clerk's signed `fva` claim; `nowMs` is `Date.now()` on the
 * server. A paused tab, a device clock dragged backwards, a fabricated
 * header or a replayed body cannot move either one, because neither one
 * is transported. That is the whole difference between an idle timeout
 * and a suggestion.
 */
export function idleDeadlineMs(input: {
  lastVerifiedAtMs: number;
  idleMinutes: number;
  /** Clerk's own session expiry, when known. */
  sessionExpiresAtMs?: number | null;
}): number {
  const own = input.lastVerifiedAtMs + input.idleMinutes * 60_000;
  const clerk = input.sessionExpiresAtMs;
  if (typeof clerk !== "number" || !Number.isFinite(clerk)) return own;
  // ⚠️ THE EARLIER, NEVER THE LATER — see above.
  return clerk < own ? clerk : own;
}

/* ------------------------------------------------------------------ */
/* THE VERDICT                                                          */
/* ------------------------------------------------------------------ */

export type SessionOutcome = "allow" | "mfa_required" | "idle_expired";

export type SessionVerdict = {
  outcome: SessionOutcome;
  /**
   * ⭐ EVERY STATE CARRIES A WORD. One in twelve Indian men is colour-blind
   * and this verdict is surfaced in a response header and on a page; a
   * coloured badge alone would be unreadable to them, and a refusal you
   * cannot read is a refusal you cannot act on.
   */
  word: "ALLOWED" | "MFA REQUIRED" | "SESSION EXPIRED";
  /** Shown to the person and written to the diagnostic header. */
  reason: string;
  /**
   * ⚠️ TRUE WHEN THE IDLE LIMIT COULD NOT BE MEASURED. Not the same as
   * "within the limit". See `evaluateSession` for why this degrades
   * visibly instead of failing closed.
   */
  idleUnenforceable: boolean;
  /** Where to send a browser. `null` when allowed. */
  redirectTo: string | null;
};

const ALLOWED: SessionVerdict = Object.freeze({
  outcome: "allow",
  word: "ALLOWED",
  reason: "Within the workspace's session policy.",
  idleUnenforceable: false,
  redirectTo: null,
});

/**
 * May this authenticated request proceed under the workspace's policy?
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 EVALUATED PER REQUEST — AN OPEN SESSION IS **NOT** GRANDFATHERED
 * ══════════════════════════════════════════════════════════════════════
 * A session already open when an admin ticks "require MFA" is refused on
 * its VERY NEXT REQUEST. Nothing about the policy is captured at sign-in,
 * so there is no cohort of pre-existing sessions running under the old
 * rules.
 *
 * The alternative — grandfather live sessions and apply the rule at the
 * next sign-in — was rejected for one reason: the moment an admin turns
 * this on is usually the moment they have a suspicion. A control that
 * exempts exactly the sessions that are already open exempts the intruder
 * and inconveniences only the honest users, who sign in again tomorrow
 * anyway. The cost is real and accepted: colleagues mid-form are bounced
 * to enrol a factor, so the settings copy says the change takes effect
 * immediately for everyone.
 *
 * ⚠️ IDLE IS TESTED BEFORE MFA. A session past its idle limit ought to be
 * dead; sending its holder to enrol a second factor would attach a new,
 * long-lived credential to a session we have just decided is stale.
 */
export function evaluateSession(input: {
  /**
   * ⚠️ OPTIONAL, AND OMITTING IT IS THE STRICTER READING. The middleware
   * knows the path and can honour the exemptions; a LAYOUT does not — a
   * React Server Component is not told the URL it is rendering. Omitting
   * the path therefore means "no exemption applies", which is safe
   * because the exempt pages deliberately live outside `app/(crm)` and so
   * never reach that caller at all.
   */
  path?: string;
  policy: TenantSessionPolicy;
  factors: FactorEvidence;
  /** 🔴 `Date.now()` ON THE SERVER. Never a value that crossed the wire. */
  nowMs: number;
  sessionExpiresAtMs?: number | null;
}): SessionVerdict {
  if (input.path !== undefined && isSessionPolicyExempt(input.path)) return ALLOWED;

  /* ── IDLE ──────────────────────────────────────────────────────────
   *
   * ⭐ WHAT WE MEASURE, STATED PLAINLY: minutes since Clerk last verified
   * a factor on this session. True idle time can never exceed that, so
   * this refuses no later than a perfect idle timer would — it errs
   * towards ending sessions early, which is the direction a security
   * control is allowed to err in. Measuring true "time since the last
   * request" would need per-session storage written on every request,
   * which the Edge Runtime cannot do without a round trip on every hit
   * and a fail-open/fail-closed decision on that round trip.
   *
   * ⚠️ WHEN `fva` IS ABSENT THE LIMIT IS UNENFORCEABLE, AND SAYS SO.
   * This one does NOT fail closed, and the asymmetry with MFA below is
   * deliberate: every tenant carries an idle limit by default, so failing
   * closed on a missing claim would refuse every request in the product
   * the day a Clerk JWT template is edited. Instead the caller publishes
   * `idleUnenforceable` — an unmeasured limit must never be indistinguish-
   * able from a satisfied one, which is the very fault this batch fixes.
   */
  if (input.factors.measured && input.factors.firstFactorMinutes !== null) {
    const lastVerifiedAtMs = input.nowMs - input.factors.firstFactorMinutes * 60_000;
    const deadline = idleDeadlineMs({
      lastVerifiedAtMs,
      idleMinutes: input.policy.idleMinutes,
      sessionExpiresAtMs: input.sessionExpiresAtMs,
    });
    if (input.nowMs >= deadline) {
      return {
        outcome: "idle_expired",
        word: "SESSION EXPIRED",
        reason:
          `This workspace ends sessions after ${input.policy.idleMinutes} minutes. ` +
          `Sign in again to carry on.`,
        idleUnenforceable: false,
        redirectTo: IDLE_SIGN_OUT_PATH,
      };
    }
  }

  /* ── SECOND FACTOR ─────────────────────────────────────────────────
   *
   * 🔴 FAILS CLOSED, AND THE MISSING-CLAIM CASE IS A REFUSAL. If the
   * workspace asked for MFA and we cannot PROVE a second factor — either
   * because there is none, or because `fva` is not in the JWT template —
   * the honest answer is "no". Allowing here would restore the exact
   * condition this batch exists to remove: a workspace being told MFA is
   * enforced while nothing checks it. The enrolment page stays reachable,
   * so a refusal is always actionable, and the sentence names what was
   * missing so an operator with a misconfigured Clerk template can tell
   * that case apart from a user who simply has no second factor.
   */
  if (input.policy.requireMfa && !hasSecondFactor(input.factors)) {
    return {
      outcome: "mfa_required",
      word: "MFA REQUIRED",
      reason: input.factors.measured
        ? "This workspace requires two-step verification. Add a second factor to continue."
        : "This workspace requires two-step verification and it cannot be verified for " +
          "this session. Add a second factor, and ask an administrator to check that the " +
          "Clerk session token includes the factor-verification claim.",
      idleUnenforceable: !input.factors.measured,
      redirectTo: MFA_ENROLMENT_PATH,
    };
  }

  const idleUnenforceable =
    !input.factors.measured || input.factors.firstFactorMinutes === null;
  return idleUnenforceable ? { ...ALLOWED, idleUnenforceable: true } : ALLOWED;
}

/* ------------------------------------------------------------------ */
/* HOW THE EDGE LEARNS THE POLICY                                       */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE CLAIM THE MIDDLEWARE READS, AND WHY IT IS A CLAIM AT ALL.
 *
 * The Edge Runtime cannot open a database connection — `pg`, Drizzle and
 * `@neondatabase/serverless` are all banned from that bundle, for the
 * reasons written above `rewriteToHostResolver` in `middleware.ts`. So
 * the middleware learns the workspace's policy the same way it learns
 * everything else about the caller: from the Clerk session token, which
 * is signed, already parsed on every request, and costs nothing extra.
 * The repository already depends on one custom claim of exactly this kind
 * (`metadata.platformAdmin`, which routes `/platform`).
 *
 * ⚠️ AND THE CLAIM MAY SIMPLY NOT BE THERE — publishing it is a Clerk JWT
 * template change, not a code change, and this batch does not own that
 * template. `null` therefore means "the edge does not know", NOT "no
 * policy": `app/(crm)/layout.tsx` re-evaluates the identical function
 * against `tenants.settings` — the database truth — in the Node runtime,
 * so the control holds today and merely gets earlier once the claim is
 * published. Two call sites, one function, no chance of drift.
 */
export function readPolicyFromClaims(sessionClaims: unknown): TenantSessionPolicy | null {
  const claims = sessionClaims as { tenantSecurity?: unknown } | null | undefined;
  const raw = claims?.tenantSecurity;
  if (raw === null || typeof raw !== "object") return null;
  return readSessionPolicy(raw);
}

/**
 * Clerk's session expiry, in epoch milliseconds, from the standard `exp`
 * claim (seconds). Read so that `idleDeadlineMs` can take the earlier of
 * Clerk's own end and the workspace's — the workspace may shorten a
 * session, never lengthen one past what Clerk itself signed.
 */
export function readSessionExpiryMs(sessionClaims: unknown): number | null {
  const exp = (sessionClaims as { exp?: unknown } | null | undefined)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
}
