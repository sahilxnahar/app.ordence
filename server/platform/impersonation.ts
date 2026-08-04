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
 * Five properties, each with the failure it prevents:
 *
 *   1. TIME-LIMITED, AND THE CLOCK IS THE AUTHORITY.
 *      Liveness is `now() < expires_at AND ended_at IS NULL`, evaluated
 *      on EVERY use. Nothing depends on a background job, because a
 *      sweeper that stops running must not silently extend everyone's
 *      access.
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
 *   4. CONSENTED, WITH A NARROWER ESCAPE HATCH.
 *      Consent buys read-write. Break-glass, for when the customer cannot
 *      be reached, buys READ-ONLY and nothing else.
 *
 *   5. BOUND TO THE SESSION THAT STARTED IT.
 *      The originating IP and user-agent are recorded and re-checked. A
 *      lifted cookie replayed from elsewhere TERMINATES the session
 *      rather than merely logging a note about it.
 */

import { and, eq, isNull, desc, sql, gt, or } from "drizzle-orm";
import { headers } from "next/headers";
import { withPlatformScope, withTenant } from "@/db";
import { tenants, users } from "@/db/schema";
import {
  platformImpersonationSessions,
  tenantSupportConsents,
  type ImpersonationMode,
  type ImpersonationScope,
} from "@/db/schema/platform";
import {
  expiryFor,
  isSessionLive,
  minutesRemaining,
  resolveScope,
  evaluateOperation,
  bannerText,
  MODE_LABELS,
  MAX_CONCURRENT_SESSIONS_PER_OPERATOR,
} from "@/lib/platform/impersonation-policy";
import {
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
  type PlatformOperator,
} from "./guard";

/* ------------------------------------------------------------------ */
/* THE ACTIVE SESSION                                                  */
/* ------------------------------------------------------------------ */

export type ActiveImpersonation = {
  sessionId: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  mode: ImpersonationMode;
  scope: ImpersonationScope;
  startedAt: Date;
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
    async (db) =>
      db
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
            gt(platformImpersonationSessions.expiresAt, now),
          ),
        )
        .orderBy(desc(platformImpersonationSessions.startedAt))
        .limit(1)
        .then((rows) => rows[0] ?? null),
  );

  if (!row) return null;

  const session = row.session;

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

  const minutesLeft = minutesRemaining(
    { expiresAt: session.expiresAt, endedAt: session.endedAt },
    now,
  );

  return {
    sessionId: session.id,
    tenantId: session.tenantId,
    tenantSlug: session.tenantSlug,
    tenantName: row.tenantName,
    mode: session.mode,
    scope: session.scope,
    startedAt: session.startedAt,
    expiresAt: session.expiresAt,
    minutesLeft,
    banner: bannerText({
      tenantName: row.tenantName,
      mode: session.mode,
      scope: session.scope,
      minutesLeft,
    }),
    actorEmail: session.actorEmail,
  };
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

  // Break-glass is a different capability from consented impersonation,
  // and `support` grade does not hold it. Checked BEFORE anything else,
  // so a support engineer probing the break-glass path never reaches the
  // consent lookup.
  const operator = await requireCapability(
    mode === "break_glass" ? "impersonate:breakglass" : "impersonate:consented",
  );

  const now = new Date();
  const facts = await currentRequestFacts();

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
      detail: { operator: operator.email, justification },
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
  });

  if (!session) {
    // Either it was not theirs or it was already closed. Same message for
    // both — a console that says "that session belongs to someone else"
    // confirms the session exists.
    return { ok: false, error: "No session to end." };
  }

  await recordPlatformAudit({
    operator,
    tenantId: session.tenantId,
    action: "impersonate",
    resourceType: "impersonation_session",
    resourceId: session.id,
    impersonationId: session.id,
    severity: "notice",
    reason: "Impersonation session ended by the operator.",
    newValue: { endedAt: new Date().toISOString(), endedReason: "operator_ended" },
  });

  return { ok: true, data: undefined };
}

/**
 * Close a session.
 *
 * ⚠️ THE ONLY WRITE THIS TABLE ACCEPTS AFTER INSERT, and the database
 * enforces that independently: the trigger in Section 3 of
 * `0014_phase17_platform.sql` refuses any UPDATE that changes another
 * column, refuses re-closing an already-closed row, and refuses DELETE
 * outright. This function is the application-side half of the same rule —
 * it exists to give a good error, not to be the thing that is true.
 */
async function endSession(
  sessionId: string,
  reason:
    | "operator_ended"
    | "expired"
    | "revoked_by_tenant"
    | "revoked_by_platform"
    | "session_binding_failed",
  options: { onlyActorClerkId?: string } = {},
): Promise<{ id: string; tenantId: string } | null> {
  return withPlatformScope(
    `Platform console: close impersonation session ${sessionId} (${reason})`,
    async (db) => {
      const conditions = [
        eq(platformImpersonationSessions.id, sessionId),
        isNull(platformImpersonationSessions.endedAt),
      ];
      if (options.onlyActorClerkId) {
        conditions.push(
          eq(platformImpersonationSessions.actorClerkId, options.onlyActorClerkId),
        );
      }

      const rows = await db
        .update(platformImpersonationSessions)
        .set({ endedAt: new Date(), endedReason: reason })
        .where(and(...conditions))
        .returning({
          id: platformImpersonationSessions.id,
          tenantId: platformImpersonationSessions.tenantId,
        });

      return rows[0] ?? null;
    },
  );
}

/**
 * Tidy sessions whose `expires_at` has passed.
 *
 * ⚠️ THIS DOES NOT EXPIRE ANYTHING. Those sessions are ALREADY over —
 * `isSessionLive()` has been returning false since the moment the clock
 * passed `expires_at`. All this does is write down why, so the console
 * shows "expired" rather than an open row that is not open. If it never
 * runs, nothing is less safe; the history is just untidy.
 */
export async function sweepExpiredImpersonations(): Promise<number> {
  const now = new Date();
  const closed = await withPlatformScope(
    "Platform maintenance: mark expired impersonation sessions as ended",
    async (db) =>
      db
        .update(platformImpersonationSessions)
        .set({ endedAt: now, endedReason: "expired" })
        .where(
          and(
            isNull(platformImpersonationSessions.endedAt),
            sql`${platformImpersonationSessions.expiresAt} <= ${now}`,
          ),
        )
        .returning({ id: platformImpersonationSessions.id }),
  );
  return closed.length;
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
        ? `<p>This was <strong>emergency access without your prior consent</strong>. ` +
          `It is read-only: nothing in your workspace can be changed. If you did not ` +
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
