import "server-only";

/**
 * Ordence — The Platform Register: Actions & Impersonation Sessions
 * Version: v0.29.0-alpha (Phase 29)
 *
 * ══════════════════════════════════════════════════════════════════════
 * "WHO DID WHAT TO WHICH CUSTOMER" — AND WHY IT TAKES TWO QUERIES
 * ══════════════════════════════════════════════════════════════════════
 * Phase 17 established a rule that this file has to live with rather than
 * work around:
 *
 *     has a tenant it belongs to  →  audit_logs           (the CUSTOMER sees it)
 *     belongs to no tenant        →  platform_action_log  (platform only)
 *
 * It is not a preference. The Phase 1 policy on `audit_logs` is
 * `WITH CHECK (tenant_id = app_current_tenant_id())`, so a NULL-tenant
 * insert evaluates `NULL = NULL` → NULL → not true and is REFUSED by the
 * database. A cross-tenant search genuinely cannot be written there.
 *
 * The consequence for this screen is real and is stated in the UI rather
 * than hidden: the register below shows the tenant-LESS half in full, and
 * the tenant-attributed half is read per workspace, in that workspace's
 * own context, by `getTenantInsights()`. Nothing is written to both, so
 * nothing is counted twice.
 *
 * ⭐ THE THIRD SOURCE, WHICH IS CROSS-TENANT BY NATURE:
 * `platform_impersonation_sessions`. It is a platform table, so it is
 * readable across every workspace from the platform scope, and it is the
 * one place that answers "was anyone inside a customer's workspace last
 * Tuesday" without a per-tenant loop. That is exactly why Phase 17 made
 * it a single append-only table rather than a session plus an event log.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHO MAY READ THE REGISTER
 * ══════════════════════════════════════════════════════════════════════
 * Any platform staff, at any grade — not only owners.
 *
 * The argument: an audit log that only its own subject can read is not an
 * audit log, it is a receipt. Peer visibility is the cheapest deterrent
 * available and it costs nothing to give, because the contents are OUR
 * OWN STAFF'S ACTIONS — masked search terms, justifications and resource
 * types. There is no customer content in this table by construction (see
 * `maskSearchTerm()` and the warning on `platform_action_log.metadata`).
 *
 * ⚠️ The "recent activity" panel on the search page deliberately shows a
 * NON-OWNER only their own rows. That is a different thing on purpose —
 * it exists so an operator sees their own trail and notices when it is
 * wrong. This screen is the register. Both are honest; neither is the
 * other's contradiction.
 */

import { and, desc, eq, gte, ilike, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { withPlatformScope } from "@/db";
import { tenants } from "@/db/schema";
import {
  platformActionLog,
  platformImpersonationSessions,
} from "@/db/schema/platform";
import {
  cappedExpiry,
  endReasonLabel,
  isSessionLive,
  minutesRemaining,
  HARD_CAP_MINUTES,
  SCOPE_LIFT_RESOURCE,
} from "@/lib/platform/impersonation-policy";
import type { PlatformResult } from "@/lib/platform/schemas";
import { requireCapability, recordPlatformAudit } from "./guard";
import { recordSecurityEvent } from "@/server/security/record";

/**
 * ⚠️ THE HARD CAP IN SQL, so `live` in the register means the same thing
 * as `live` in the gate. Duplicated from `impersonation.ts` rather than
 * imported from `server/platform/impersonation.ts`, because importing it
 * would make this module depend on the one that pulls in Clerk and the
 * mail provider for the sake of one expression. The expression is one
 * line, both copies read `HARD_CAP_MINUTES` from the same pure module, and
 * a test asserts the two agree.
 *
 * `least()` — never `greatest()`. It can only ever shorten a session.
 */
function cappedExpirySql() {
  return sql`least(${platformImpersonationSessions.expiresAt}, ${platformImpersonationSessions.startedAt} + make_interval(mins => ${HARD_CAP_MINUTES}))`;
}

/* ------------------------------------------------------------------ */
/* THE ACTION REGISTER                                                 */
/* ------------------------------------------------------------------ */

export type PlatformActionRow = {
  id: string;
  actorEmail: string;
  actorGrade: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  justification: string;
  severity: string;
  resultCount: number | null;
  ipAddress: string | null;
  createdAt: string;
  /** True when this row is the reading operator's own action. */
  isYou: boolean;
};

const SEVERITIES = ["all", "info", "notice", "warning", "critical"] as const;

const actionLogFilterSchema = z.object({
  /** Matched as a PREFIX on the actor's email. Never a `%contains%`. */
  actor: z.string().trim().max(320).optional(),
  action: z.string().trim().max(60).optional(),
  severity: z.enum(SEVERITIES).default("all"),
  /** Ninety days is the retention question, not a UI question. */
  days: z.number().int().min(1).max(90).default(7),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).max(10_000).default(0),
});

export type PlatformActionLogFilter = z.input<typeof actionLogFilterSchema>;

/**
 * The tenant-less half of the platform audit trail.
 *
 * ⚠️ AUDITING THE READING OF AN AUDIT LOG — THE LINE THIS DRAWS.
 * Opening the register unfiltered is NOT recorded, for the same reason
 * the tenant directory is not: a row written every time somebody glances
 * at a dashboard buries the accesses that matter under the ones that do
 * not, and a log nobody can read without triggering an alarm is a log
 * nobody reads.
 *
 * Narrowing it to ONE NAMED OPERATOR is recorded, because that is not
 * browsing, it is an investigation into a colleague — and the person
 * being investigated is entitled to the same trail everybody else gets.
 */
export async function listPlatformActions(
  input: unknown,
): Promise<
  PlatformResult<{ rows: PlatformActionRow[]; total: number; limit: number; offset: number }>
> {
  const operator = await requireCapability("staff:read");
  const parsed = actionLogFilterSchema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, error: "Invalid filters." };
  const f = parsed.data;

  const since = new Date(Date.now() - f.days * 86_400_000);
  const conditions: SQL[] = [gte(platformActionLog.createdAt, since)];

  if (f.actor && f.actor.length >= 2) {
    conditions.push(ilike(platformActionLog.actorEmail, `${f.actor}%`));
  }
  if (f.action && f.action.length > 0) {
    conditions.push(eq(platformActionLog.action, f.action));
  }
  if (f.severity !== "all") {
    conditions.push(eq(platformActionLog.severity, f.severity));
  }

  const where = and(...conditions);

  const result = await withPlatformScope(
    "Platform console: read the cross-tenant platform action register",
    async (db) => {
      const [{ count = 0 } = { count: 0 }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(platformActionLog)
        .where(where);

      const rows = await db
        .select()
        .from(platformActionLog)
        .where(where)
        .orderBy(desc(platformActionLog.createdAt), desc(platformActionLog.id))
        .limit(f.limit)
        .offset(f.offset);

      return { count, rows };
    },
  );

  if (f.actor && f.actor.length >= 2) {
    await recordPlatformAudit({
      operator,
      tenantId: null,
      action: "read",
      resourceType: "platform_action_log",
      resourceId: null,
      severity: "notice",
      reason:
        "Platform staff searched the action register for one named operator. " +
        "Narrowing the register to a person is an investigation and is recorded.",
      metadata: {
        // The actor filter is an OUR-STAFF email, not a customer's, so it
        // is safe to record verbatim — unlike a search term, which is
        // masked. See `maskSearchTerm()` for the distinction.
        actorFilter: f.actor,
        resultCount: result.rows.length,
      },
    });
  }

  return {
    ok: true,
    data: {
      rows: result.rows.map((r) => ({
        id: r.id,
        actorEmail: r.actorEmail,
        actorGrade: r.actorGrade,
        action: r.action,
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        justification: r.justification,
        severity: r.severity,
        resultCount: r.resultCount,
        ipAddress: r.ipAddress,
        createdAt: r.createdAt.toISOString(),
        isYou: r.actorClerkId === operator.clerkUserId,
      })),
      total: result.count,
      limit: f.limit,
      offset: f.offset,
    },
  };
}

/**
 * The distinct actions present in the register, for the filter control.
 *
 * A free-text "action" box invites typos that silently return nothing;
 * a list built from the data cannot go stale against it.
 */
export async function listPlatformActionKinds(): Promise<string[]> {
  await requireCapability("staff:read");
  const rows = await withPlatformScope(
    "Platform console: list the distinct action kinds present in the register",
    async (db) =>
      db
        .selectDistinct({ action: platformActionLog.action })
        .from(platformActionLog)
        .orderBy(platformActionLog.action)
        .limit(50),
  );
  return rows.map((r) => r.action);
}

/* ------------------------------------------------------------------ */
/* THE IMPERSONATION REGISTER                                          */
/* ------------------------------------------------------------------ */

export type ImpersonationSessionRow = {
  id: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string | null;
  actorEmail: string;
  mode: string;
  /** The frozen ceiling — the most the customer's consent permitted. */
  scope: string;
  /**
   * ⭐ WHETHER WRITE ACCESS WAS ACTUALLY TAKEN — Batch 28.
   *
   * ⚠️ NOT THE SAME QUESTION AS `scope`. A session whose consent
   * permitted changes but where nobody ever lifted it never had write
   * access at all, and a register that showed only the ceiling would
   * report every consented session as if we had been changing things.
   */
  writeAccessTaken: boolean;
  justification: string;
  startedAt: string;
  /** ⚠️ THE CAPPED expiry — start + 30 minutes, or sooner. */
  expiresAt: string;
  endedAt: string | null;
  endedReason: string | null;
  /** The end reason in WORDS. Never a colour, never a bare enum value. */
  endedReasonLabel: string;
  /** Computed from the CLOCK, never from `ended_at`. */
  live: boolean;
  minutesLeft: number;
  consentId: string | null;
  tenantNotifiedAt: string | null;
  actionCount: number;
  blockedActionCount: number;
  ipAddress: string | null;
};

const sessionFilterSchema = z.object({
  liveOnly: z.boolean().default(false),
  tenantId: z.string().uuid().optional(),
  actor: z.string().trim().max(320).optional(),
  days: z.number().int().min(1).max(90).default(30),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).max(10_000).default(0),
});

export type ImpersonationFilter = z.input<typeof sessionFilterSchema>;

/**
 * Every impersonation, across every workspace.
 *
 * ⚠️ `live` IS COMPUTED FROM `expires_at`, in SQL, at read time. A row
 * whose `ended_at` is still NULL an hour after it expired is CLOSED — the
 * sweeper simply has not tidied it. Reading `ended_at IS NULL` as "live"
 * would mean a failed background job silently reports every past session
 * as still running, and an operator would go looking for an intruder who
 * left forty minutes ago.
 */
export async function listImpersonationSessions(
  input: unknown,
): Promise<
  PlatformResult<{
    rows: ImpersonationSessionRow[];
    total: number;
    liveCount: number;
    limit: number;
    offset: number;
  }>
> {
  await requireCapability("tenants:read");

  /**
   * ⭐⭐ TIDY BEFORE READING — Batch 28, and it follows the precedent set
   * by `getOpenHealthEvents()`.
   *
   * ══════════════════════════════════════════════════════════════════
   * 🔴 `sweepExpiredImpersonations()` HAD NO CALLER
   * ══════════════════════════════════════════════════════════════════
   * It was written, correct, tested — and nothing anywhere invoked it,
   * which is the ninth complete engine in this codebase that nothing
   * reached. It did not matter while its only job was cosmetic: a
   * session is over when its clock says so whether or not a row records
   * it, and every liveness test in the product reads the clock.
   *
   * ⚠️ IT MATTERS NOW, because the sweep is what writes "this session
   * ended, and it ended by EXPIRY" into the register. Of the three ways
   * a session can end, expiry is the one with nobody in the room — so
   * it was the one ending a reviewer could not see afterwards.
   *
   * ⚠️ SWEPT ON READ RATHER THAN ON A SCHEDULE, for the reason the
   * health sweep gives: a cron would be tidier and would also mean this
   * screen is silently incomplete on the morning the scheduler is the
   * thing that broke — which is a morning somebody is looking at this
   * screen specifically. Each row is swept exactly once, ever, so the
   * cost of doing it here is bounded and does not recur.
   */
  const { sweepExpiredImpersonations } = await import("./impersonation");
  await sweepExpiredImpersonations().catch((err) => {
    // ⚠️ A FAILED TIDY MUST NOT BLANK THE REGISTER. The rows below are
    // the evidence; the sweep only annotates them.
    console.error("[platform] impersonation sweep failed during register read", err);
  });

  const parsed = sessionFilterSchema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, error: "Invalid filters." };
  const f = parsed.data;
  const now = new Date();
  const since = new Date(now.getTime() - f.days * 86_400_000);

  const conditions: SQL[] = [gte(platformImpersonationSessions.startedAt, since)];
  if (f.tenantId) {
    conditions.push(eq(platformImpersonationSessions.tenantId, f.tenantId));
  }
  if (f.actor && f.actor.length >= 2) {
    conditions.push(ilike(platformImpersonationSessions.actorEmail, `${f.actor}%`));
  }
  if (f.liveOnly) {
    conditions.push(isNull(platformImpersonationSessions.endedAt));
    conditions.push(sql`${cappedExpirySql()} > now()`);
  }

  const where = and(...conditions);

  return withPlatformScope(
    "Platform console: read the impersonation session register across tenants",
    async (db) => {
      const [{ count = 0 } = { count: 0 }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(platformImpersonationSessions)
        .where(where);

      // Counted over EVERYTHING, not over the filtered page: "is anyone
      // inside a customer right now" must not depend on which filter the
      // operator happens to have applied.
      const [{ live = 0 } = { live: 0 }] = await db
        .select({ live: sql<number>`count(*)::int` })
        .from(platformImpersonationSessions)
        .where(
          and(
            isNull(platformImpersonationSessions.endedAt),
            // ⚠️ THE CAPPED expiry, so this agrees with the gate. A count
            // that said "1 live" for a session no request would accept
            // would send somebody looking for an intruder who is not
            // there — and, far worse, would teach them the number lies.
            sql`${cappedExpirySql()} > now()`,
          ),
        );

      const rows = await db
        .select({
          session: platformImpersonationSessions,
          tenantName: tenants.name,
        })
        .from(platformImpersonationSessions)
        .leftJoin(tenants, eq(tenants.id, platformImpersonationSessions.tenantId))
        .where(where)
        .orderBy(
          desc(platformImpersonationSessions.startedAt),
          desc(platformImpersonationSessions.id),
        )
        .limit(f.limit)
        .offset(f.offset);

      /* ---- ⭐ WHICH OF THESE ACTUALLY TOOK WRITE ACCESS ----------- */
      //
      // ⚠️ ONE QUERY FOR THE WHOLE PAGE, not one per row. Fifty round
      // trips to render a table is how a register screen becomes a
      // screen nobody opens.
      const sessionIds = rows.map((r) => r.session.id);
      const lifted = new Set<string>();
      if (sessionIds.length > 0) {
        const liftRows = await db
          .select({ resourceId: platformActionLog.resourceId })
          .from(platformActionLog)
          .where(
            and(
              eq(platformActionLog.resourceType, SCOPE_LIFT_RESOURCE),
              inArray(platformActionLog.resourceId, sessionIds),
            ),
          );
        for (const r of liftRows) if (r.resourceId) lifted.add(r.resourceId);
      }

      return {
        ok: true as const,
        data: {
          rows: rows.map(({ session: s, tenantName }) => {
            const live = isSessionLive(s, now);
            return {
              id: s.id,
              tenantId: s.tenantId,
              tenantSlug: s.tenantSlug,
              tenantName,
              actorEmail: s.actorEmail,
              mode: s.mode,
              scope: s.scope,
              writeAccessTaken: lifted.has(s.id),
              justification: s.justification,
              startedAt: s.startedAt.toISOString(),
              expiresAt: cappedExpiry(s).toISOString(),
              endedAt: s.endedAt?.toISOString() ?? null,
              endedReason: s.endedReason,
              // ⚠️ `?? "expired"` AND NOT `?? "still open"`. A row that is
              // not live and has no recorded end is a session the clock
              // closed and the sweeper has not tidied. Reading the empty
              // column as "still open" is exactly the mistake the whole
              // "expires_at is the authority" rule exists to prevent.
              endedReasonLabel: live
                ? "Live now"
                : endReasonLabel(s.endedReason ?? "expired"),
              live,
              minutesLeft: minutesRemaining(s, now),
              consentId: s.consentId,
              tenantNotifiedAt: s.tenantNotifiedAt?.toISOString() ?? null,
              actionCount: s.actionCount,
              blockedActionCount: s.blockedActionCount,
              ipAddress: s.ipAddress,
            } satisfies ImpersonationSessionRow;
          }),
          total: count,
          liveCount: live,
          limit: f.limit,
          offset: f.offset,
        },
      };
    },
  );
}

/* ------------------------------------------------------------------ */
/* TERMINATING SOMEBODY ELSE'S SESSION                                 */
/* ------------------------------------------------------------------ */

const revokeSessionSchema = z.object({
  sessionId: z.string().uuid("Invalid session."),
  reason: z
    .string()
    .trim()
    .min(15, "Say why, in at least 15 characters — this ends a colleague's access.")
    .max(1000),
});

/**
 * End another operator's live session.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS, AND WHY IT NEEDS THE `owner` GRADE
 * ══════════════════════════════════════════════════════════════════════
 * `stopImpersonation()` lets an operator end THEIR OWN session, which is
 * the ordinary case. The case this exists for is the ugly one: an
 * operator's laptop is stolen mid-session, or somebody starts a session
 * that should not have been started, and the only alternative is to wait
 * out the clock or open a database client. The second of those is how a
 * control gets routed around; the first is up to fifty-nine minutes of
 * somebody inside a customer's workspace.
 *
 * ⭐ IT REUSES `staff:manage` DELIBERATELY. The capability list in
 * `lib/platform/roles.ts` is a CLOSED, frozen matrix, and adding a key to
 * it is a change to a file this phase does not own. `staff:manage` is
 * owner-only, is on the step-up list, and means "administer the people
 * who hold platform access" — ending one of their sessions is squarely
 * inside that meaning. Support and engineer grades cannot do this, which
 * is correct: a phished support account must not be able to kick the
 * engineer who is investigating it.
 *
 * The session row itself is EVIDENCE and is barely touched: the one-way
 * close writes `ended_at` and `ended_reason` and nothing else, and the
 * database trigger refuses anything more.
 */
export async function revokeImpersonationSession(
  input: unknown,
): Promise<PlatformResult<void>> {
  const operator = await requireCapability("staff:manage");
  const parsed = revokeSessionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the form.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { sessionId, reason } = parsed.data;

  const closed = await withPlatformScope(
    `Platform console: terminate impersonation session ${sessionId} — ${reason.slice(0, 80)}`,
    async (db) => {
      const rows = await db
        .update(platformImpersonationSessions)
        .set({ endedAt: new Date(), endedReason: "revoked_by_platform" })
        .where(
          and(
            eq(platformImpersonationSessions.id, sessionId),
            isNull(platformImpersonationSessions.endedAt),
          ),
        )
        .returning({
          id: platformImpersonationSessions.id,
          tenantId: platformImpersonationSessions.tenantId,
          tenantSlug: platformImpersonationSessions.tenantSlug,
          actorEmail: platformImpersonationSessions.actorEmail,
        });

      return rows[0] ?? null;
    },
  );

  // Same message whether it never existed or was already closed. A
  // console that distinguishes them confirms which session ids are real.
  if (!closed) return { ok: false, error: "No live session to end." };

  await recordPlatformAudit({
    operator,
    tenantId: closed.tenantId,
    action: "impersonate",
    resourceType: "impersonation_session",
    resourceId: closed.id,
    impersonationId: closed.id,
    severity: "critical",
    reason,
    newValue: { endedReason: "revoked_by_platform" },
    metadata: { endedOperator: closed.actorEmail, endedBy: operator.email },
  });

  // A terminated session is a security event in its own right: either an
  // operator's credentials are in the wrong hands, or a colleague was
  // doing something that had to be stopped. Both belong in the stream
  // that gets watched.
  await recordSecurityEvent({
    type: "tenant.cross_access_attempt",
    severity: "critical",
    source: "platform-console",
    tenantId: closed.tenantId,
    subjectType: "impersonation_session",
    subjectId: closed.id,
    ipAddress: operator.ipAddress,
    userAgent: operator.userAgent,
    reason: "An impersonation session was terminated by platform staff.",
    detail: { endedOperator: closed.actorEmail, endedBy: operator.email, reason },
  });

  return { ok: true, data: undefined };
}
