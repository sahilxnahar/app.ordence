import "server-only";

/**
 * Ordence — Support Impersonation
 * Version: v0.14.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE MOST DANGEROUS CODE IN THE PRODUCT
 * ══════════════════════════════════════════════════════════════════════
 * Everything else in this platform is built so that one customer's data
 * cannot reach another. This file deliberately hands one of our staff a
 * seat inside a customer's workspace. The policy — consent model, session
 * lengths, and the list of things an impersonator may never do — lives in
 * `lib/platform/impersonation-policy.ts` with the full argument. This file
 * enforces it.
 *
 * Seven properties, each with the failure it prevents. Properties 6 and 7
 * were added in Batch 28, and properties 1 and 4 changed there.
 *
 *   1. TIME-LIMITED, AND THE CLOCK IS THE AUTHORITY.
 *      Liveness is `now() < LEAST(expires_at, started_at + 30 minutes)
 *      AND ended_at IS NULL`, evaluated on EVERY use. Nothing depends on
 *      a background job, because a sweeper that stops running must not
 *      silently extend everyone's access — and nothing depends on a
 *      value the client sent, because a paused tab and a hand-crafted
 *      POST are the same thing to a server that does not consult them.
 *
 *      ⚠️ THE CAP IS APPLIED TO THE STORED ROW, not only to new sessions.
 *      `expires_at` is frozen by the tamper trigger, so a session started
 *      when the limit was sixty minutes cannot be rewritten; it is
 *      re-decided from `started_at`, which is frozen too.
 *
 *   2. ATTRIBUTABLE TO THE REAL HUMAN, AND FLAGGED AS IMPERSONATED.
 *      Every audit row written during a session carries the operator's
 *      real Clerk id and email in the actor columns AND the session id in
 *      `audit_logs.impersonation_id`. Both, not either: the actor answers
 *      "who", the flag answers "were they wearing somebody else's face".
 *      An audit trail that records only the customer's user is a trail
 *      that blames the customer for our actions.
 *
 *   3. VISUALLY UNMISTAKABLE.
 *      `getActiveImpersonation()` drives a banner that cannot be
 *      dismissed. The failure it prevents is not subtle — it is an
 *      engineer with two tabs open typing into the wrong one.
 *
 *   4. READ-ONLY BY DEFAULT; CONSENT BUYS THE OPTION, NOT THE ACCESS.
 *      ⭐ Every session — consented or not — starts read-only. The
 *      `scope` column records what the customer PERMITTED and is a
 *      ceiling; taking write access is a separate act that names what is
 *      about to change and is written to the action register. The
 *      register row IS the grant, so there is no way to hold write
 *      access without a record of having taken it.
 *
 *      Break-glass, for when the customer cannot be reached, has a
 *      read-only ceiling and can never be lifted at all.
 *
 *   5. BOUND TO THE SESSION THAT STARTED IT.
 *      The originating IP and user-agent are recorded and re-checked. A
 *      lifted cookie replayed from elsewhere TERMINATES the session
 *      rather than merely logging a note about it.
 *
 *   6. ⭐ VISIBLE TO THE CUSTOMER WHILE IT IS HAPPENING, NOT AFTERWARDS.
 *      Every user of the workspace sees an undismissable banner naming
 *      the operator, their reason, what they can change and how long is
 *      left — polled, so it appears within seconds of the session
 *      starting and disappears within seconds of it ending. The email to
 *      the owners still goes out; it is a second channel, not the only
 *      one. See `server/platform/tenant-support-access.ts`.
 *
 *   7. ⭐ EVERY ENDING IS RECORDED, INCLUDING THE ONE WITH NOBODY IN THE
 *      ROOM. `endSession()` writes which of the ways it ended into the
 *      customer's own audit log — expiry, the operator leaving, the
 *      workspace ejecting us, or a platform owner terminating it.
 */

import { and, eq, isNull, desc, sql, gt, or } from "drizzle-orm";
import { headers } from "next/headers";
import { withPlatformScope, withTenant } from "@/db";
import { tenants, users } from "@/db/schema";
import {
  platformActionLog,
  platformImpersonationSessions,
  platformStaff,
  tenantSupportConsents,
  type ImpersonationMode,
  type ImpersonationScope,
} from "@/db/schema/platform";
import { breakGlassReasonProblem } from "@/lib/platform/break-glass";
import { breakGlassDebtBlock } from "./break-glass";
import {
  cappedExpiry,
  effectiveScope,
  expiryFor,
  isSessionLive,
  minutesRemaining,
  resolveScope,
  scopeLiftProblem,
  evaluateOperation,
  bannerText,
  END_REASON_LABELS,
  HARD_CAP_MINUTES,
  MODE_LABELS,
  MAX_CONCURRENT_SESSIONS_PER_OPERATOR,
  SCOPE_LIFT_RESOURCE,
  type ImpersonationEndReasonKey,
} from "@/lib/platform/impersonation-policy";
import { assertMaintenanceAllows } from "./maintenance";
import {
  liftImpersonationScopeSchema,
  startImpersonationSchema,
  stopImpersonationSchema,
  type PlatformResult,
} from "@/lib/platform/schemas";
import { sendEmail } from "@/lib/email/resend";
import { esc } from "@/lib/email/templates";
import { recordSecurityEvent } from "@/server/security/record";
import {
  requireCapability,
  requirePlatformAdmin,
  recordPlatformAudit,
  type PlatformAuditActor,
  type PlatformOperator,
} from "./guard";

/* ------------------------------------------------------------------ */
/* ⭐⭐⭐ THE SCOPE LIFT LIVES IN THE ACTION REGISTER                   */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THE REGISTER IS THE AUTHORITY AND NOT A COLUMN
 * ══════════════════════════════════════════════════════════════════════
 * The obvious design is `UPDATE platform_impersonation_sessions SET scope
 * = 'read_write'`. The database refuses it: `scope` is in the frozen list
 * of `prevent_impersonation_tamper()`, alongside who, which workspace,
 * under what authority and until when.
 *
 * ⭐ AND THAT REFUSAL IS RIGHT, so this design agrees with it instead of
 * asking for an exception. Three properties fall out of it:
 *
 *   1. THE GRANT AND THE RECORD OF THE GRANT ARE THE SAME OBJECT. There
 *      is no way to hold write access without a register row saying who
 *      took it and why, because the register row IS the access. A
 *      mutable column plus a best-effort audit write can disagree; this
 *      cannot.
 *
 *   2. IT FAILS CLOSED. `recordPlatformAudit()` never throws — a failed
 *      write returns silently. If the register write is lost, the lift
 *      simply did not happen and the session stays read-only. The lift
 *      is re-read and confirmed before the operator is told it worked.
 *
 *   3. IT CANNOT BE UN-RECORDED. `platform_action_log` is append-only and
 *      DELETE is revoked from the application role, so an operator cannot
 *      erase the fact that they took write access — which is exactly the
 *      row somebody under investigation would most like to remove.
 *
 * ⚠️ THE COST IS ONE INDEXED READ per impersonated request, folded into
 * the round trip `getActiveImpersonation()` already makes. Ordinary
 * customer traffic never reaches it.
 *
 * The `resource_type` itself lives in `lib/platform/impersonation-policy.ts`
 * as `SCOPE_LIFT_RESOURCE`, because three modules need the same string.
 */

/**
 * ⚠️ THE HARD CAP, EXPRESSED IN SQL, so a query can filter on it without
 * dragging every open row into JavaScript first.
 *
 * `least()` — never `greatest()`. This can only shorten a session. See
 * `cappedExpiry()` in the policy module for the argument.
 */
function cappedExpirySql() {
  return sql`least(${platformImpersonationSessions.expiresAt}, ${platformImpersonationSessions.startedAt} + make_interval(mins => ${HARD_CAP_MINUTES}))`;
}

/* ------------------------------------------------------------------ */
/* THE ACTIVE SESSION                                                  */
/* ------------------------------------------------------------------ */

export type ActiveImpersonation = {
  sessionId: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  mode: ImpersonationMode;
  /**
   * 🔴 THE EFFECTIVE SCOPE — what this session may do RIGHT NOW.
   *
   * ⚠️ NOT the `scope` column. It is `read_only` for every session that
   * has not been deliberately lifted, whatever the customer's consent
   * permitted. The name is kept because everything downstream — the
   * tenant context, the role ceiling, `assertImpersonationAllows()` —
   * already reads this field, and those are precisely the places that
   * must see the effective answer rather than the permitted one.
   */
  scope: ImpersonationScope;
  /** The frozen column: the MOST this session could ever be lifted to. */
  grantedScope: ImpersonationScope;
  /** When write access was taken, or null. Read from the action register. */
  scopeLiftedAt: Date | null;
  /** The sentence the operator gave when taking write access. */
  scopeLiftReason: string | null;
  /** The reason the session was started. Shown in both banners. */
  justification: string;
  startedAt: Date;
  /** ⚠️ THE CAPPED expiry — the earlier of the stored one and start + 30m. */
  expiresAt: Date;
  minutesLeft: number;
  banner: string;
  actorEmail: string;
};

/**
 * The operator's live session, if any.
 *
 * ⚠️ NOT STORED IN A COOKIE. Deliberately. A cookie carrying "you are
 * currently impersonating Acme" is a credential: steal it, replay it, and
 * you are inside Acme. Keeping the state in the database and looking it
 * up by the operator's Clerk id means the only credential in play is the
 * Clerk session itself, which already has revocation, expiry and device
 * management built around it.
 *
 * It also means REVOCATION IS IMMEDIATE. Ending a session is one UPDATE;
 * there is no client-held token that keeps working until it expires.
 */
export async function getActiveImpersonation(
  operator?: PlatformOperator,
): Promise<ActiveImpersonation | null> {
  const op = operator ?? (await requirePlatformAdmin());
  const now = new Date();

  const row = await withPlatformScope(
    "Platform console: resolve the operator's live impersonation session for the banner",
    async (tx) => {
      const [found] = await tx
        .select({
          session: platformImpersonationSessions,
          tenantName: tenants.name,
        })
        .from(platformImpersonationSessions)
        .innerJoin(tenants, eq(tenants.id, platformImpersonationSessions.tenantId))
        .where(
          and(
            eq(platformImpersonationSessions.actorClerkId, op.clerkUserId),
            isNull(platformImpersonationSessions.endedAt),
            // ⚠️ A CHEAP INDEX-FRIENDLY PREFILTER, NOT THE ANSWER. The
            // authoritative liveness test is `isSessionLive()` below,
            // which applies the thirty-minute cap. This predicate only
            // avoids dragging every historical row into memory.
            gt(platformImpersonationSessions.expiresAt, now),
          ),
        )
        .orderBy(desc(platformImpersonationSessions.startedAt))
        .limit(1);

      if (!found) return null;

      /* ---- ⭐ THE SCOPE LIFT, FROM THE REGISTER ------------------- */
      //
      // Read in the SAME transaction as the session, so the banner and
      // the write gate can never be told two different stories about one
      // request. `limit(1)` on the newest: a lift is a one-way act and a
      // second one is refused, but reading the newest is the honest
      // answer either way.
      const [lift] = await tx
        .select({
          createdAt: platformActionLog.createdAt,
          justification: platformActionLog.justification,
        })
        .from(platformActionLog)
        .where(
          and(
            eq(platformActionLog.resourceType, SCOPE_LIFT_RESOURCE),
            eq(platformActionLog.resourceId, found.session.id),
          ),
        )
        .orderBy(desc(platformActionLog.createdAt))
        .limit(1);

      return { ...found, lift: lift ?? null };
    },
  );

  if (!row) return null;

  const session = row.session;

  /* ---- ⭐ THE THIRTY-MINUTE HARD CAP, RE-DECIDED HERE ------------- */
  //
  // 🔴 EVERY SERVER REQUEST RE-COMPUTES THIS FROM `started_at`, a column
  // the database refuses to let anybody change. Nothing here reads a
  // deadline, a countdown or a "minutes left" value that arrived from a
  // browser — a paused tab, a clock skewed by an hour and a hand-crafted
  // POST are all the same thing to this check, which is that they are
  // not consulted.
  //
  // ⚠️ THE ROW IS LEFT OPEN. Closing it needs a write, and a read path
  // that writes turns every page load into a transaction. `ended_at`
  // stays NULL until the sweep tidies it, and NOTHING anywhere treats a
  // NULL `ended_at` as evidence of life.
  if (!isSessionLive(session, now)) return null;

  /* ---- Session binding ------------------------------------------ */
  //
  // A mismatch is not a warning, it is a termination. The honest reading
  // of "this session started from 203.0.113.4 and is now being used from
  // 198.51.100.9" is that one of the two is not the operator, and there
  // is no safe way to guess which.
  //
  // The user-agent is compared too, but a change in it alone does NOT
  // terminate — browsers rewrite it on update, and locking an operator
  // out mid-incident because Chrome patched itself is a real cost for a
  // very weak signal. IP is the binding; UA is recorded evidence.
  const facts = await currentRequestFacts();
  if (session.ipAddress && facts.ipAddress && session.ipAddress !== facts.ipAddress) {
    await endSession(session.id, "session_binding_failed");
    await recordSecurityEvent({
      type: "auth.session_anomaly",
      severity: "critical",
      source: "platform-impersonation",
      tenantId: session.tenantId,
      subjectType: "impersonation_session",
      subjectId: session.id,
      ipAddress: facts.ipAddress,
      userAgent: facts.userAgent,
      reason:
        "Impersonation session used from a different IP than it was started from. " +
        "Session terminated.",
      detail: { startedFrom: session.ipAddress, usedFrom: facts.ipAddress },
    });
    return null;
  }

  const minutesLeft = minutesRemaining(session, now);

  // ⭐ THE ONE LINE THAT MAKES READ-ONLY THE DEFAULT. Everything that
  // decides whether a write may proceed reads the value this produces.
  const scope = effectiveScope({
    ceiling: session.scope,
    lifted: row.lift !== null,
  });

  return {
    sessionId: session.id,
    tenantId: session.tenantId,
    tenantSlug: session.tenantSlug,
    tenantName: row.tenantName,
    mode: session.mode,
    scope,
    grantedScope: session.scope,
    scopeLiftedAt: row.lift?.createdAt ?? null,
    scopeLiftReason: row.lift?.justification ?? null,
    justification: session.justification,
    startedAt: session.startedAt,
    expiresAt: cappedExpiry(session),
    minutesLeft,
    banner: bannerText({
      tenantName: row.tenantName,
      mode: session.mode,
      scope,
      minutesLeft,
    }),
    actorEmail: session.actorEmail,
  };
}

/* ------------------------------------------------------------------ */
/* ⭐⭐⭐ TAKING WRITE ACCESS — A SEPARATE, DELIBERATE ACT              */
/* ------------------------------------------------------------------ */

/**
 * Lift a live session from read-only to read-write.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS IS NOT A TOGGLE AND IT IS NOT REVERSIBLE
 * ══════════════════════════════════════════════════════════════════════
 * There is no "drop back to read-only" counterpart, and the omission is
 * deliberate: un-lifting would let an operator write, then hide the fact
 * that they could, leaving a register that says "read-write" for a window
 * nobody can bound. If they no longer need write access, the session ends
 * — which takes one click and costs at most the remainder of half an hour.
 *
 * FOUR REFUSALS, IN THIS ORDER, AND EACH ONE IS DIFFERENT:
 *
 *   1. THE PURE POLICY (`scopeLiftProblem`) — break-glass can never be
 *      lifted, a read-only consent can never be exceeded, a lifted
 *      session cannot be lifted twice, and "fix" is not a reason.
 *   2. THE CONSENT, RE-READ NOW — a consent revoked five minutes ago must
 *      not authorise anything, and the only way to be certain of that is
 *      to read it at the moment of the act rather than trust the copy
 *      taken when the session started.
 *   3. THE REGISTER ACCEPTED IT — the lift is not granted until it is
 *      READABLE. See `SCOPE_LIFT_RESOURCE`.
 *   4. The customer is told, in their own audit log, in the same breath.
 */
export async function liftImpersonationScope(
  input: unknown,
): Promise<PlatformResult<{ scope: ImpersonationScope }>> {
  const parsed = liftImpersonationScopeSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the form.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { sessionId, reason } = parsed.data;

  // ⚠️ THE SAME CAPABILITY THAT STARTED THE SESSION, deliberately. The
  // authority to be inside a consented workspace and the authority to
  // use the write access the customer already granted are the same
  // authority; a second capability would imply the customer's grant
  // needs our grade's permission as well, which inverts who is deciding.
  const operator = await requireCapability("impersonate:consented");

  const active = await getActiveImpersonation(operator);
  if (!active || active.sessionId !== sessionId) {
    // Same sentence for "not yours", "already closed" and "never
    // existed": the difference between them is a map of which session
    // ids are real.
    return { ok: false, error: "No live session of yours to change." };
  }

  const problem = scopeLiftProblem({
    mode: active.mode,
    ceiling: active.grantedScope,
    alreadyLifted: active.scopeLiftedAt !== null,
    reason,
  });
  if (problem) return { ok: false, error: problem, fieldErrors: { reason: [problem] } };

  /* ---- 2. THE CONSENT, AS IT IS RIGHT NOW ------------------------ */
  const now = new Date();
  const consentStillGood = await withPlatformScope(
    `Platform console: re-read tenant support consent before taking write access in session ${sessionId}`,
    async (tx) => {
      const [consent] = await tx
        .select({ scope: tenantSupportConsents.scope })
        .from(tenantSupportConsents)
        .where(
          and(
            eq(tenantSupportConsents.tenantId, active.tenantId),
            isNull(tenantSupportConsents.revokedAt),
            gt(tenantSupportConsents.expiresAt, now),
          ),
        )
        .orderBy(desc(tenantSupportConsents.grantedAt))
        .limit(1);
      return consent?.scope === "read_write";
    },
  );

  if (!consentStillGood) {
    return {
      ok: false,
      error:
        "This workspace's support access no longer permits changes — it was revoked, " +
        "narrowed or has expired since this session started. The session stays read-only.",
    };
  }

  /* ---- 3. THE REGISTER IS THE GRANT ------------------------------ */
  await recordPlatformAudit({
    operator,
    // ⚠️ NULL ON PURPOSE. This row goes to `platform_action_log`, which
    // is the register the write gate reads on every request. The
    // customer's copy is the next call.
    tenantId: null,
    action: "impersonate",
    resourceType: SCOPE_LIFT_RESOURCE,
    resourceId: sessionId,
    severity: "warning",
    reason,
    metadata: {
      tenantId: active.tenantId,
      tenantSlug: active.tenantSlug,
      mode: active.mode,
      grantedScope: active.grantedScope,
    },
  });

  // ⭐ READ BACK BEFORE SAYING YES. `recordPlatformAudit()` never throws,
  // so "it returned" is not evidence that anything was written — and a
  // console that reports write access an operator does not have is worse
  // than one that refuses.
  const confirmed = await withPlatformScope(
    `Platform console: confirm the scope lift for session ${sessionId} reached the register`,
    async (tx) => {
      const [row] = await tx
        .select({ id: platformActionLog.id })
        .from(platformActionLog)
        .where(
          and(
            eq(platformActionLog.resourceType, SCOPE_LIFT_RESOURCE),
            eq(platformActionLog.resourceId, sessionId),
          ),
        )
        .limit(1);
      return row != null;
    },
  );

  if (!confirmed) {
    return {
      ok: false,
      error:
        "The action register did not accept the record of this change, so write " +
        "access was not granted. The session is still read-only. Report this.",
    };
  }

  /* ---- 4. THE CUSTOMER'S OWN LOG --------------------------------- */
  await recordPlatformAudit({
    operator,
    tenantId: active.tenantId,
    action: "impersonate",
    resourceType: SCOPE_LIFT_RESOURCE,
    resourceId: sessionId,
    impersonationId: sessionId,
    severity: "warning",
    reason,
    oldValue: { scope: "read_only" },
    newValue: { scope: "read_write" },
    metadata: { modeLabel: MODE_LABELS[active.mode] },
  });

  return { ok: true, data: { scope: "read_write" } };
}

/* ------------------------------------------------------------------ */
/* START                                                               */
/* ------------------------------------------------------------------ */

export async function startImpersonation(
  input: unknown,
): Promise<PlatformResult<{ sessionId: string; expiresAt: string; scope: string }>> {
  const parsed = startImpersonationSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the form.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { tenantId, mode, justification, subjectUserId, confirmSlug } = parsed.data;
  const breakGlassReason = parsed.data.breakGlassReason ?? "";

  // Break-glass is a different capability from consented impersonation,
  // and `support` grade does not hold it. Checked BEFORE anything else,
  // so a support engineer probing the break-glass path never reaches the
  // consent lookup.
  const operator = await requireCapability(
    mode === "break_glass" ? "impersonate:breakglass" : "impersonate:consented",
  );

  const now = new Date();
  const facts = await currentRequestFacts();

  /* ---- ⭐⭐⭐ THE BREAK-GLASS PROCEDURE -------------------------- */
  //
  // 🔴 BOTH CHECKS RUN BEFORE ANYTHING IS READ OR WRITTEN, and both are
  // pure verdicts computed in `lib/platform/break-glass.ts`.
  //
  // ⚠️ THE ORDER MATTERS. The debt is checked FIRST, because an operator
  // who is blocked should be told that before they spend two minutes
  // writing a reason that will be thrown away.
  if (mode === "break_glass") {
    const blocked = await breakGlassDebtBlock(operator.staff.id, now);
    if (blocked) return { ok: false, error: blocked };

    const reasonProblem = breakGlassReasonProblem(breakGlassReason, justification);
    if (reasonProblem) {
      return {
        ok: false,
        error: reasonProblem,
        fieldErrors: { breakGlassReason: [reasonProblem] },
      };
    }
  }

  /* ---- One live session per operator ---------------------------- */
  const existing = await getActiveImpersonation(operator);
  if (existing) {
    return {
      ok: false,
      error:
        `You are already impersonating ${existing.tenantName}. End that session ` +
        `first — ${MAX_CONCURRENT_SESSIONS_PER_OPERATOR} at a time, so the banner ` +
        `in front of you always describes the workspace you are typing into.`,
    };
  }

  // The callback's return type is written out rather than inferred. With
  // several `return { error: ... }` branches and one success branch,
  // TypeScript collapses the inferred union into a single object with
  // every property optional — and `prepared.expiresAt` becomes possibly
  // undefined AFTER a check that was supposed to have ruled that out.
  // An explicit discriminated union restores the narrowing.
  type Prepared =
    | { error: string; session?: undefined }
    | {
        error?: undefined;
        session: {
          sessionId: string;
          expiresAt: Date;
          scope: ImpersonationScope;
          tenantName: string;
          tenantSlug: string;
        };
      };

  const prepared = await withPlatformScope(
    `Platform console: start ${mode} impersonation of tenant ${tenantId} — ` +
      justification.slice(0, 80),
    async (db): Promise<Prepared> => {
      const [tenant] = await db
        .select()
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      if (!tenant) return { error: "Workspace not found." } as const;
      if (tenant.slug !== confirmSlug.trim()) {
        return { error: "That is not this workspace's address." } as const;
      }
      if (tenant.deletedAt) {
        return { error: "This workspace has been deleted." } as const;
      }

      /* ---- Consent ---------------------------------------------- */
      //
      // The consent row is looked up FRESH, at start time, and its
      // expiry and revocation are both honoured. A consent granted six
      // months ago and revoked yesterday must not authorise anything,
      // and the only way to be sure of that is to read it now rather
      // than trust a flag cached anywhere.
      const [consent] =
        mode === "break_glass"
          ? []
          : await db
              .select()
              .from(tenantSupportConsents)
              .where(
                and(
                  eq(tenantSupportConsents.tenantId, tenantId),
                  eq(
                    tenantSupportConsents.mode,
                    mode === "standing_consent" ? "standing" : "incident",
                  ),
                  isNull(tenantSupportConsents.revokedAt),
                  gt(tenantSupportConsents.expiresAt, now),
                ),
              )
              .orderBy(desc(tenantSupportConsents.grantedAt))
              .limit(1);

      if (mode !== "break_glass" && !consent) {
        return {
          error:
            "This workspace has not given support access. Ask them to turn it on in " +
            "Settings, or use break-glass — which is read-only and notifies them.",
        } as const;
      }

      /* ---- Break-glass must be a LAST resort, not a shortcut ---- */
      //
      // ⭐ If usable consent exists, break-glass is REFUSED. Without this
      // check an operator could choose break-glass to skip the consent
      // lookup entirely, and the mode that exists for emergencies would
      // quietly become the default path — with the tenant notified for
      // every routine ticket until they stopped reading the emails.
      if (mode === "break_glass") {
        const [usable] = await db
          .select({ id: tenantSupportConsents.id })
          .from(tenantSupportConsents)
          .where(
            and(
              eq(tenantSupportConsents.tenantId, tenantId),
              isNull(tenantSupportConsents.revokedAt),
              gt(tenantSupportConsents.expiresAt, now),
            ),
          )
          .limit(1);

        if (usable) {
          return {
            error:
              "This workspace has already granted support access. Use it — " +
              "break-glass is only for when consent does not exist.",
          } as const;
        }
      }

      const scope = resolveScope(mode, consent?.scope ?? null);
      const expiresAt = expiryFor(mode, now);

      const [session] = await db
        .insert(platformImpersonationSessions)
        .values({
          tenantId,
          tenantSlug: tenant.slug,
          staffId: operator.staff.id,
          actorClerkId: operator.clerkUserId,
          actorEmail: operator.email,
          mode,
          scope,
          consentId: consent?.id ?? null,
          justification,
          // ⚠️ NULL FOR CONSENTED MODES, and the CHECK constraint in 0074
          // only demands it for break-glass. Writing an empty string here
          // would satisfy nothing and would make "no reason given"
          // indistinguishable from "not applicable".
          breakGlassReason: mode === "break_glass" ? breakGlassReason.trim() : null,
          subjectUserId: subjectUserId ?? null,
          startedAt: now,
          expiresAt,
          ipAddress: facts.ipAddress,
          userAgent: facts.userAgent,
        })
        .returning({
          id: platformImpersonationSessions.id,
          expiresAt: platformImpersonationSessions.expiresAt,
        });

      if (!session) return { error: "Could not start the session." } as const;

      return {
        session: {
          sessionId: session.id,
          expiresAt: session.expiresAt,
          scope,
          tenantName: tenant.name,
          tenantSlug: tenant.slug,
        },
      };
    },
  );

  if (prepared.error !== undefined) return { ok: false, error: prepared.error };
  const started = prepared.session;

  /* ---- The customer's own audit log ----------------------------- */
  //
  // Written with the tenant id, so it appears in THEIR audit view. A
  // customer discovering months later that we were inside their
  // workspace and that they had no way of seeing it is the single
  // fastest way to lose an enterprise account.
  await recordPlatformAudit({
    operator,
    tenantId,
    action: "impersonate",
    resourceType: "impersonation_session",
    resourceId: started.sessionId,
    impersonationId: started.sessionId,
    severity: mode === "break_glass" ? "critical" : "warning",
    reason: justification,
    newValue: {
      mode,
      scope: started.scope,
      expiresAt: started.expiresAt.toISOString(),
    },
    metadata: { modeLabel: MODE_LABELS[mode], breakGlass: mode === "break_glass" },
  });

  /* ---- Tell the customer, out of band --------------------------- */
  //
  // Notification is not a nicety here — for break-glass it is the ONLY
  // thing standing in for consent. It is deliberately out-of-band
  // (email, to the workspace owners) because an in-product notice is
  // something the impersonator could see and dismiss.
  await notifyTenant(tenantId, {
    tenantName: started.tenantName,
    operatorEmail: operator.email,
    mode,
    scope: started.scope,
    justification,
    expiresAt: started.expiresAt,
    sessionId: started.sessionId,
    breakGlassReason: mode === "break_glass" ? breakGlassReason.trim() : null,
  });

  if (mode === "break_glass") {
    await recordSecurityEvent({
      type: "tenant.cross_access_attempt",
      severity: "critical",
      source: "platform-impersonation",
      tenantId,
      subjectType: "impersonation_session",
      subjectId: started.sessionId,
      ipAddress: facts.ipAddress,
      userAgent: facts.userAgent,
      reason: "BREAK-GLASS impersonation started with no tenant consent (read-only).",
      detail: { operator: operator.email, justification, breakGlassReason: breakGlassReason.trim() },
    });

    // ⭐⭐ THE OWNERS OF THE PLATFORM ARE TOLD TOO, IMMEDIATELY.
    //
    // ⚠️ The customer already gets an email. Nobody on our side did,
    // which meant the only way to learn that an engineer had opened a
    // workspace without permission was to go and look at a screen. A
    // control everyone has to remember to check is a control nobody
    // checks. Best-effort, for the same reason the customer's email is:
    // a mail outage must not keep an engineer out of a broken workspace.
    await alertPlatformOwners({
      operatorEmail: operator.email,
      tenantName: started.tenantName,
      reason: breakGlassReason.trim(),
      justification,
      sessionId: started.sessionId,
      expiresAt: started.expiresAt,
    });
  }

  return {
    ok: true,
    data: {
      sessionId: started.sessionId,
      expiresAt: started.expiresAt.toISOString(),
      scope: started.scope,
    },
  };
}

/* ------------------------------------------------------------------ */
/* STOP                                                                */
/* ------------------------------------------------------------------ */

export async function stopImpersonation(input: unknown): Promise<PlatformResult<void>> {
  const operator = await requirePlatformAdmin();
  const parsed = stopImpersonationSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid session." };

  const session = await endSession(parsed.data.sessionId, "operator_ended", {
    onlyActorClerkId: operator.clerkUserId,
    endedBy: operator,
  });

  if (!session) {
    // Either it was not theirs or it was already closed. Same message for
    // both — a console that says "that session belongs to someone else"
    // confirms the session exists.
    return { ok: false, error: "No session to end." };
  }

  return { ok: true, data: undefined };
}

/** The row `endSession()` needs in order to write the register entry. */
type ClosedSession = {
  id: string;
  tenantId: string;
  tenantSlug: string;
  actorClerkId: string;
  actorEmail: string;
};

/**
 * Close a session.
 *
 * ⚠️ THE ONLY WRITE THIS TABLE ACCEPTS AFTER INSERT, and the database
 * enforces that independently: the trigger in Section 3 of
 * `0014_phase17_platform.sql` refuses any UPDATE that changes another
 * column, refuses re-closing an already-closed row, and refuses DELETE
 * outright. This function is the application-side half of the same rule —
 * it exists to give a good error, not to be the thing that is true.
 *
 * ⭐ IT IS ALSO THE ONE PLACE THAT WRITES "THIS SESSION ENDED, AND HERE
 * IS WHICH OF THE FOUR WAYS IT WAS" — Batch 28.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE RECORDING USED TO LIVE IN THE CALLERS, AND ONE OF THEM HAD NONE
 * ══════════════════════════════════════════════════════════════════════
 * `stopImpersonation()` wrote an audit row afterwards. The expiry sweep
 * did not — so the ONE ending that happens with nobody in the room was
 * the one ending nobody could see in the register. That is backwards:
 * an operator who ends their own session is announcing it; a session that
 * ran out is the case a reviewer has to reconstruct.
 *
 * Putting the write here means every path gets it, including the one
 * somebody adds next year, and nobody has to remember.
 */
async function endSession(
  sessionId: string,
  reason: ImpersonationEndReasonKey,
  options: {
    onlyActorClerkId?: string;
    /**
     * ⚠️ SCOPES THE UPDATE TO ONE WORKSPACE. Used by the tenant-owner
     * path, where the caller has proved they administer THIS workspace
     * and nothing else. Without it, an owner holding a session id from
     * anywhere could close a session in somebody else's workspace.
     */
    onlyTenantId?: string;
    /** Who did it. Omitted for the clock, which is attributed as system. */
    endedBy?: PlatformAuditActor;
    /** Free text folded into the register entry — e.g. the owner's reason. */
    note?: string;
  } = {},
): Promise<ClosedSession | null> {
  const closed = await withPlatformScope(
    `Platform console: close impersonation session ${sessionId} (${reason})`,
    async (tx) => {
      const conditions = [
        eq(platformImpersonationSessions.id, sessionId),
        isNull(platformImpersonationSessions.endedAt),
      ];
      if (options.onlyActorClerkId) {
        conditions.push(
          eq(platformImpersonationSessions.actorClerkId, options.onlyActorClerkId),
        );
      }
      if (options.onlyTenantId) {
        conditions.push(eq(platformImpersonationSessions.tenantId, options.onlyTenantId));
      }

      const rows = await tx
        .update(platformImpersonationSessions)
        .set({ endedAt: new Date(), endedReason: reason })
        .where(and(...conditions))
        .returning({
          id: platformImpersonationSessions.id,
          tenantId: platformImpersonationSessions.tenantId,
          tenantSlug: platformImpersonationSessions.tenantSlug,
          actorClerkId: platformImpersonationSessions.actorClerkId,
          actorEmail: platformImpersonationSessions.actorEmail,
        });

      return rows[0] ?? null;
    },
  );

  if (!closed) return null;
  await recordSessionEnd(closed, reason, options.endedBy, options.note);
  return closed;
}

/**
 * ⭐ WHICH OF THE WAYS IT ENDED, IN THE CUSTOMER'S OWN AUDIT LOG.
 *
 * ⚠️ TENANT-ATTRIBUTED, so the workspace whose data was read can see that
 * the access stopped and how — not only that it started. "Somebody was in
 * your workspace" with no matching "and they left" is the shape of record
 * that makes a customer assume the worst, correctly.
 *
 * ⚠️ THE EXPIRY CASE HAS NO HUMAN, and is attributed to `system` with the
 * operator's own address in the row. Attributing it TO the operator would
 * claim they took an action they did not take; attributing it to nobody
 * at all would lose which session it concerns.
 */
async function recordSessionEnd(
  session: ClosedSession,
  reason: ImpersonationEndReasonKey,
  endedBy?: PlatformAuditActor,
  note?: string,
): Promise<void> {
  const actor: PlatformAuditActor = endedBy ?? {
    clerkUserId: session.actorClerkId,
    email: session.actorEmail,
    grade: "system",
    ipAddress: null,
    userAgent: null,
    requestId: null,
  };

  await recordPlatformAudit({
    operator: actor,
    tenantId: session.tenantId,
    action: "impersonate",
    resourceType: "impersonation_session",
    resourceId: session.id,
    impersonationId: session.id,
    // A session terminated because it was used from another address is
    // an incident; the other three are ordinary endings.
    severity: reason === "session_binding_failed" ? "critical" : "notice",
    reason: note
      ? `${END_REASON_LABELS[reason]}. ${note}`
      : `${END_REASON_LABELS[reason]}.`,
    newValue: { endedAt: new Date().toISOString(), endedReason: reason },
    metadata: {
      endedReason: reason,
      // ⭐ THE WORD, not only the enum value. A register read by a person
      // six months from now should not require the reader to know that
      // `revoked_by_tenant` means the customer did it themselves.
      endedReasonLabel: END_REASON_LABELS[reason],
      sessionOperator: session.actorEmail,
      endedByOperator: endedBy?.email ?? null,
    },
  });
}

/**
 * Tidy sessions whose clock has run out.
 *
 * ⚠️ THIS DOES NOT EXPIRE ANYTHING. Those sessions are ALREADY over —
 * `isSessionLive()` has been returning false since the moment the clock
 * passed the capped expiry. All this does is write down why, so the
 * console shows "expired" rather than an open row that is not open. If it
 * never runs, nothing is less safe; the history is just untidy.
 *
 * ⚠️ THE PREDICATE USES THE CAPPED EXPIRY, so a row written before the
 * thirty-minute cap existed — with its own sixty-minute `expires_at` —
 * is tidied at minute thirty, which is when it actually stopped working.
 * A sweep that disagreed with the liveness test would leave rows the
 * console calls open and the gate calls closed.
 */
export async function sweepExpiredImpersonations(): Promise<number> {
  const now = new Date();
  const closed = await withPlatformScope(
    "Platform maintenance: mark expired impersonation sessions as ended",
    async (tx) =>
      tx
        .update(platformImpersonationSessions)
        .set({ endedAt: now, endedReason: "expired" })
        .where(
          and(
            isNull(platformImpersonationSessions.endedAt),
            sql`${cappedExpirySql()} <= ${now}`,
          ),
        )
        .returning({
          id: platformImpersonationSessions.id,
          tenantId: platformImpersonationSessions.tenantId,
          tenantSlug: platformImpersonationSessions.tenantSlug,
          actorClerkId: platformImpersonationSessions.actorClerkId,
          actorEmail: platformImpersonationSessions.actorEmail,
        }),
  );

  // ⚠️ Sequential, and deliberately not `Promise.all`. Each of these
  // writes a hash-chained audit row into one tenant's log, and the chain
  // head is read-then-written — concurrent writers to the same tenant
  // collide and degrade to unchained rows. A sweep is not on anybody's
  // critical path; correctness of the chain is worth the seconds.
  for (const session of closed) {
    await recordSessionEnd(session, "expired");
  }

  return closed.length;
}

/**
 * ⭐ END A SESSION BECAUSE THE WORKSPACE ASKED — Batch 28.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 SHOULD THE CUSTOMER BE ABLE TO KICK OUR ENGINEER OUT MID-INCIDENT?
 * ══════════════════════════════════════════════════════════════════════
 * The honest answer is that this control is right for trust and wrong for
 * the one situation it will most often be used in, and both halves are
 * true at once. The reasoning is written here rather than left implicit,
 * because whoever reads this next deserves the argument and not just the
 * verdict.
 *
 * THE CASE AGAINST: the realistic sequence is that something is broken,
 * the customer has escalated, an engineer is inside diagnosing it, and
 * somebody at the customer sees an alarming red bar and presses the
 * button. Access ends mid-transaction. The engineer has to ask for it
 * back, on a call, while the outage continues. We have handed the
 * customer a control whose most likely use makes their own incident
 * longer, and we did it while they were stressed.
 *
 * THE CASE FOR, WHICH WINS:
 *
 *   1. ⭐ CONSENT THAT CANNOT BE WITHDRAWN IS NOT CONSENT. The entire
 *      model in `impersonation-policy.ts` rests on the customer having
 *      said yes. A yes that cannot be turned back into a no is a
 *      formality we collect once and then rely on forever. Every other
 *      control here — the expiry, the deny-list, the read-only default —
 *      is downstream of the customer's agreement actually meaning
 *      something.
 *
 *   2. ⚠️ THE ALTERNATIVE IS NOT "THE ENGINEER STAYS IN". It is "the
 *      customer telephones somebody and waits". During the exact
 *      incident this is supposed to protect, that is worse for them and
 *      no better for us, and it converts a two-second action into a
 *      support ticket about a support ticket.
 *
 *   3. THE COST IS BOUNDED AND SMALL. A session is at most thirty
 *      minutes. Losing one costs the engineer the time to ask for
 *      another — awkward, not dangerous. Compare that to what the
 *      absence of this button costs: a customer who discovers that the
 *      "revoke access" wording in their settings did not, in the moment
 *      they wanted it, revoke access.
 *
 *   4. IT IS RECORDED AS THEIRS. `revoked_by_tenant` is a distinct
 *      ending, in their own audit log, with their reason attached. If a
 *      customer routinely ejects engineers mid-incident, that is a
 *      conversation to have with them — and it is a conversation this
 *      record makes possible rather than one it prevents.
 *
 * ⚠️ WHAT THIS IS NOT: a way to hide anything. The session row is
 * evidence and is untouched apart from the one-way close, the actions
 * already taken remain in the log, and ending access does not un-read
 * what was read.
 *
 * ⚠️ AND IT DOES NOT REVOKE THE CONSENT ITSELF. Ending this session is a
 * smaller act than withdrawing standing consent, and conflating them
 * would mean a customer who wanted the engineer to step out for five
 * minutes has to re-grant access from scratch. Withdrawing consent is a
 * separate control in their settings, which is where a durable decision
 * belongs.
 */
export async function endSessionForTenantOwner(args: {
  sessionId: string;
  /** Proved by the caller's own tenant context. Never taken from input. */
  tenantId: string;
  /** Who at the customer did it, for the register. */
  actorEmail: string;
  reason: string;
}): Promise<ClosedSession | null> {
  return endSession(args.sessionId, "revoked_by_tenant", {
    onlyTenantId: args.tenantId,
    endedBy: {
      // ⚠️ NULL CLERK ID ON PURPOSE. The person who did this is a
      // CUSTOMER'S user, not platform staff, and writing their Clerk id
      // into a column whose whole meaning is "which of our staff" would
      // make a customer look like an operator in every later query.
      clerkUserId: null,
      email: args.actorEmail,
      grade: "system",
      ipAddress: null,
      userAgent: null,
      requestId: null,
    },
    note: `Ended by ${args.actorEmail} at the workspace: ${args.reason}`,
  });
}

/* ------------------------------------------------------------------ */
/* THE OPERATION GATE                                                  */
/* ------------------------------------------------------------------ */

export class ImpersonationForbiddenError extends Error {
  constructor(
    readonly operation: string,
    readonly rule: string,
    message: string,
  ) {
    super(message);
    this.name = "ImpersonationForbiddenError";
  }
}

/**
 * What a caller already knows about its own request.
 *
 * ⚠️ BOTH FIELDS ARE REQUIRED. `TenantContext` satisfies this shape
 * exactly, and it always populates them — `null` on the ordinary path,
 * the session id on the impersonated one. Making them optional would let
 * a caller pass any object at all and have the gate read the omission as
 * "not impersonating", which is the single wrong answer this function can
 * give.
 */
export type ImpersonationFacts = {
  impersonationId: string | null;
  impersonationScope: ImpersonationScope | null;
  tenant: { id: string };
};

/**
 * May this operation run right now?
 *
 * ⭐ THE CALL EVERY TENANT-SIDE MUTATION NEEDS.
 *
 * ══════════════════════════════════════════════════════════════════════
 * PASS THE CONTEXT. THE ARGUMENT IS NOT A MICRO-OPTIMISATION.
 * ══════════════════════════════════════════════════════════════════════
 *     await assertImpersonationAllows("delete:contact", ctx);
 *
 * Without `ctx` this function has to ASK who the caller is, and asking
 * means `getActiveImpersonation()` → `requirePlatformAdmin()` → a Clerk
 * backend fetch and a platform-scoped query. On a tenant action that is
 * two round trips on every delete, every close, every invite, performed
 * to establish a fact the request already knew — and a check expensive
 * enough to notice is a check somebody removes.
 *
 * `requireTenantContext()` resolved the session once, at the top of the
 * request. Handing that answer down costs nothing and cannot disagree
 * with itself.
 *
 * ⚠️ THE NO-ARGUMENT FORM STILL WORKS and still looks the session up, for
 * background paths that hold no tenant context. It is the slower and
 * strictly less certain of the two.
 *
 * Returns silently when nobody is impersonating, so it is safe to call
 * unconditionally at the top of any action.
 */
export async function assertImpersonationAllows(
  operation: string,
  facts?: ImpersonationFacts,
): Promise<void> {
  /*
   * ══════════════════════════════════════════════════════════════════
   * 🔴 MAINTENANCE MODE IS CHECKED HERE, FIRST, AND ON EVERY PATH.
   * ══════════════════════════════════════════════════════════════════
   * Batch 131 needed a place where writes are actually refused. This is
   * that place already: every tenant-side mutation in the codebase calls
   * this function, and the alternative — a second gate of its own — is a
   * second opinion about what counts as a write. Two opinions on that
   * question disagree eventually, and the way they disagree is that one
   * of them lets a save through during a window we told the customer was
   * frozen.
   *
   * ⚠️ BEFORE the `!facts.impersonationId` early return, deliberately.
   * Maintenance mode applies to ORDINARY USERS — it is the case that
   * matters — and an early return written for the impersonation question
   * would have skipped it for everybody who is not being impersonated,
   * which is everybody.
   *
   * ⚠️ It reads reads-vs-writes with the SAME `isWriteOperation` this
   * file's own policy uses, so an operation is never a write for one gate
   * and a read for the other.
   */
  await assertMaintenanceAllows(operation, facts?.tenant.id ?? null);

  /* --- The cheap path: the caller already knows ------------------- */
  if (facts) {
    // Not impersonating. `evaluateOperation(op, null)` would return
    // `allowed` anyway; returning here states why, and does it without
    // touching Clerk or the database.
    if (!facts.impersonationId) return;

    const verdict = evaluateOperation(operation, facts.impersonationScope);
    if (verdict.allowed) return;

    await recordBlockedOperation({
      sessionId: facts.impersonationId,
      tenantId: facts.tenant.id,
      operation,
      rule: verdict.rule,
      reason: verdict.reason,
    });

    throw new ImpersonationForbiddenError(
      operation,
      verdict.rule,
      verdict.reason ?? "This action is not permitted under impersonation.",
    );
  }

  /* --- The lookup path, for callers with no context --------------- */
  const active = await getActiveImpersonationQuiet();
  const verdict = evaluateOperation(operation, active?.scope ?? null);

  if (verdict.allowed) return;

  if (active) {
    await recordBlockedOperation({
      sessionId: active.sessionId,
      tenantId: active.tenantId,
      operation,
      rule: verdict.rule,
      reason: verdict.reason,
    });
  }

  throw new ImpersonationForbiddenError(
    operation,
    verdict.rule,
    verdict.reason ?? "This action is not permitted under impersonation.",
  );
}

/**
 * Count and record a refusal.
 *
 * ⚠️ THE COUNTER IS ON THE SESSION AND THE EVENT IS IN THE SECURITY
 * STREAM, deliberately in two places. The counter is what the console
 * shows next to a live session — "this operator has been refused eleven
 * times in nine minutes" is a sentence somebody should read while it is
 * still happening. The event is the durable record for afterwards.
 *
 * Best-effort: a refusal that could not be written down is still a
 * refusal, and failing to record it must not turn a blocked action into
 * an unhandled error that reads, to the operator, like a bug in the page
 * they were on.
 */
async function recordBlockedOperation(input: {
  sessionId: string;
  tenantId: string;
  operation: string;
  rule: string;
  reason: string | null;
}): Promise<void> {
  try {
    await withPlatformScope(
      "Platform console: count an action blocked by the impersonation policy",
      async (db) => {
        await db
          .update(platformImpersonationSessions)
          .set({
            blockedActionCount: sql`${platformImpersonationSessions.blockedActionCount} + 1`,
          })
          .where(eq(platformImpersonationSessions.id, input.sessionId));
      },
    );

    await recordSecurityEvent({
      type: "tenant.cross_access_attempt",
      severity: "warning",
      source: "platform-impersonation",
      tenantId: input.tenantId,
      subjectType: "impersonation_session",
      subjectId: input.sessionId,
      reason: `Blocked under impersonation: ${input.operation}`,
      detail: { operation: input.operation, rule: input.rule, reason: input.reason },
    });
  } catch (err) {
    console.error("[IMPERSONATION BLOCK RECORD FAILED]", {
      sessionId: input.sessionId,
      operation: input.operation,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Non-throwing lookup, for call sites that must not fail on a non-operator. */
async function getActiveImpersonationQuiet(): Promise<ActiveImpersonation | null> {
  try {
    return await getActiveImpersonation();
  } catch {
    // Not platform staff at all — the overwhelmingly common case for
    // every ordinary tenant request. Not an error.
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* NOTIFICATION                                                        */
/* ------------------------------------------------------------------ */

/**
 * Email the workspace's owners and admins that somebody entered.
 *
 * Best-effort by design: a failing mail provider must not prevent an
 * engineer from reaching a broken workspace during an incident. But the
 * FAILURE is recorded — `tenant_notified_at` stays NULL, and the console
 * shows a session whose customer was never told, which is exactly the
 * thing a review should be able to find.
 */
async function notifyTenant(
  tenantId: string,
  details: {
    tenantName: string;
    operatorEmail: string;
    mode: ImpersonationMode;
    scope: ImpersonationScope;
    justification: string;
    expiresAt: Date;
    sessionId: string;
    /** ⭐ Break-glass only. Written FOR this email, not for the log. */
    breakGlassReason?: string | null;
  },
): Promise<void> {
  try {
    // Recipients are read in the TENANT'S context. Nothing about the
    // notification needs a cross-tenant read, so it does not get one.
    const recipients = await withTenant(tenantId, async (tx) =>
      tx
        .select({ email: users.email })
        .from(users)
        .where(
          and(
            isNull(users.deletedAt),
            eq(users.status, "active"),
            or(eq(users.role, "tenant_owner"), eq(users.role, "tenant_admin")),
          ),
        )
        .limit(10),
    );

    if (recipients.length === 0) return;

    const breakGlass = details.mode === "break_glass";
    const subject = breakGlass
      ? `Urgent support access to ${details.tenantName}`
      : `Support access to ${details.tenantName} has started`;

    const body =
      `<p>${esc(details.operatorEmail)} from Ordence support has opened your ` +
      `workspace <strong>${esc(details.tenantName)}</strong>.</p>` +
      `<p><strong>Access level:</strong> ${esc(
        details.scope === "read_only" ? "Read only" : "Read and write",
      )}<br/>` +
      `<strong>Authorised by:</strong> ${esc(MODE_LABELS[details.mode])}<br/>` +
      `<strong>Ends automatically:</strong> ${esc(details.expiresAt.toISOString())}<br/>` +
      `<strong>Reason given:</strong> ${esc(details.justification)}</p>` +
      (breakGlass
        ? // ⭐ THE REASON, VERBATIM, ABOVE THE FOLD. The whole argument for
          // a separate 50-character field is that this paragraph exists and
          // that a customer reads it. Printing the internal justification
          // here instead would show them a ticket number.
          `<p><strong>Why we could not wait for your permission:</strong><br/>${esc(
            details.breakGlassReason ?? "No reason was recorded, which is itself a fault on our side.",
          )}</p>` +
          `<p>This was <strong>emergency access without your prior consent</strong>. ` +
          `It is read-only: nothing in your workspace can be changed, and it ends ` +
          `automatically after fifteen minutes. If you did not ` +
          `expect this, reply to this email immediately.</p>`
        : `<p>You can revoke support access at any time in Settings.</p>`);

    const result = await sendEmail({
      to: recipients.map((r) => r.email),
      subject,
      html: body,
      text: body.replace(/<[^>]+>/g, " "),
      idempotencyKey: `impersonation-${details.sessionId}`,
      logContext: { tenantId, sessionId: details.sessionId },
    });

    if (result.ok) {
      await withPlatformScope(
        "Platform console: record that the tenant was notified of impersonation",
        async (db) => {
          await db
            .update(platformImpersonationSessions)
            .set({ tenantNotifiedAt: new Date() })
            .where(eq(platformImpersonationSessions.id, details.sessionId));
        },
      );
    }
  } catch (err) {
    console.error("[platform] impersonation notification failed", err);
  }
}

/**
 * ⭐⭐ TELL OUR OWN OWNERS, WITHIN SECONDS.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS IS NOT A DASHBOARD CARD
 * ══════════════════════════════════════════════════════════════════════
 * A card on the observatory is seen by somebody who was already looking
 * at the observatory. The event this exists for happens at eleven at
 * night, and the person who most needs to know is not looking at a
 * screen. So it is a push, out of band, to every owner-grade operator.
 *
 * 🔴 IT IS NOT SENT TO THE OPERATOR WHO DID IT. Their own copy tells
 * them nothing they do not know and makes the alert look routine in
 * everybody's inbox including theirs.
 */
async function alertPlatformOwners(details: {
  operatorEmail: string;
  tenantName: string;
  reason: string;
  justification: string;
  sessionId: string;
  expiresAt: Date;
}): Promise<void> {
  try {
    const owners = await withPlatformScope(
      "Platform console: owner alert recipients for break-glass",
      async (db) =>
        db
          .select({ email: platformStaff.email })
          .from(platformStaff)
          .where(
            and(
              eq(platformStaff.grade, "owner"),
              eq(platformStaff.status, "active"),
              isNull(platformStaff.revokedAt),
            ),
          )
          .limit(20),
    );

    const to = owners
      .map((o) => o.email)
      .filter((e) => e.toLowerCase() !== details.operatorEmail.toLowerCase());

    if (to.length === 0) return;

    const body =
      `<p><strong>Break-glass access has been used.</strong></p>` +
      `<p><strong>Operator:</strong> ${esc(details.operatorEmail)}<br/>` +
      `<strong>Workspace:</strong> ${esc(details.tenantName)}<br/>` +
      `<strong>Ends:</strong> ${esc(details.expiresAt.toISOString())}</p>` +
      `<p><strong>Reason given to the customer:</strong><br/>${esc(details.reason)}</p>` +
      `<p><strong>Internal justification:</strong><br/>${esc(details.justification)}</p>` +
      `<p>The workspace owners have been emailed. The session is read-only and ` +
      `expires on its own. A write-up is due within 24 hours, and until it is ` +
      `written this operator cannot break glass again.</p>`;

    await sendEmail({
      to,
      subject: `BREAK-GLASS: ${details.operatorEmail} opened ${details.tenantName}`,
      html: body,
      text: body.replace(/<[^>]+>/g, " "),
      idempotencyKey: `breakglass-owner-${details.sessionId}`,
      logContext: { sessionId: details.sessionId },
    });
  } catch (err) {
    // ⚠️ SWALLOWED ON PURPOSE, AND THE SECURITY EVENT ABOVE IS ALREADY
    // WRITTEN. An engineer must not be kept out of a broken workspace by
    // our mail provider.
    console.error("[platform] break-glass owner alert failed", err);
  }
}

/* ------------------------------------------------------------------ */
/* HELPERS                                                             */
/* ------------------------------------------------------------------ */

async function currentRequestFacts(): Promise<{
  ipAddress: string | null;
  userAgent: string | null;
}> {
  try {
    const h = await headers();
    const forwarded = h.get("x-forwarded-for");
    return {
      ipAddress: forwarded?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? null,
      userAgent: h.get("user-agent")?.slice(0, 500) ?? null,
    };
  } catch {
    return { ipAddress: null, userAgent: null };
  }
}

export { isSessionLive };
