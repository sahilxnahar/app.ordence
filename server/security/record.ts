import "server-only";

/**
 * Ordence — Security Event Recorder
 * Version: v0.12.0-alpha (Phase 20)
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT `server/audit.ts`
 * ══════════════════════════════════════════════════════════════════════
 * `writeAudit()` is built around `requireTenantContext()`: it reads the Clerk
 * session to learn who the actor is. Almost nothing in this file has a
 * session. A forged webhook signature, a garbage portal token and a
 * middleware rate-limit trip all happen with no principal at all, and calling
 * `requireTenantContext()` on those paths would THROW — turning the act of
 * reporting an attack into a 500 on the attacked route.
 *
 * The split is the same one `server/billing/audit-billing.ts` made for
 * webhooks, for the same reason, and this file follows its shape.
 *
 * ══════════════════════════════════════════════════════════════════════
 * TWO WRITERS, AND THE DIFFERENCE IS DELIBERATE
 * ══════════════════════════════════════════════════════════════════════
 *
 *   recordSecurityEvent(input)        — standalone, BEST EFFORT, never throws.
 *   recordSecurityEventTx(tx, input)  — joins your transaction, DOES throw.
 *
 * The reason there are two rather than one with a flag:
 *
 * A standalone security event is telemetry ABOUT a request that has already
 * been decided. The 429 has been chosen; writing the row is bookkeeping.
 * Throwing there would mean a database hiccup converts a correctly-refused
 * request into a 500, and — worse — an attacker who can make our database
 * slow could make every rate-limited request return 500 instead of 429,
 * which is a more useful oracle than the 429 was.
 *
 * A transactional security event is different: it is being written ALONGSIDE
 * a state change, and if the state change rolls back, a row saying it
 * happened is a lie. So that one propagates its error and takes the
 * transaction down with it, exactly as `recordSystemAudit()` does for money
 * movements. Use it whenever the event and a mutation must agree.
 *
 * ⚠️ "Never throws" is NOT "fails silently". Every failure prints to stderr
 * with the event type, and a CRITICAL event that fails to persist also
 * invokes the escalation hook (`onSecurityRecordFailure`) so the alerting
 * path can fire even when the storage path is broken. A security pipeline
 * whose only failure symptom is an empty table is not a pipeline.
 */

import { headers } from "next/headers";
/**
 * ⚠️ `db` IS IMPORTED LAZILY, INSIDE THE FUNCTION THAT USES IT.
 *
 * `db/index.ts` builds a Neon client at MODULE LOAD, which reads and
 * validates the environment. A static import here would mean that merely
 * IMPORTING this module can throw — and this module is imported by the
 * webhook routes, the upload route and the portal, i.e. exactly the
 * surfaces it exists to protect.
 *
 * The failure mode that produced this change: adding the security
 * recorder to `app/api/upload/route.ts` made nineteen previously-passing
 * authorisation tests fail, because pulling in the recorder pulled in the
 * database client, which parsed the environment, which threw. In
 * production the same shape would be an unconfigured variable turning a
 * 401 into a 500 on a route whose whole job is to refuse cleanly.
 *
 * A monitoring component must never be able to break the thing it
 * monitors. Deferring the import to call time keeps that true.
 */
import { securityEvents } from "@/db/schema/secops";
import {
  resolveSeverity,
  sanitiseDetail,
  type SecurityEventInput,
  type SecurityEventType,
  type SecuritySeverity,
} from "@/lib/security/events";
import { ipPrefix } from "@/lib/security/rate-limit";
import type { withTenant } from "@/db";

/**
 * The same handle type `server/billing/audit-billing.ts` uses — derived from
 * `withTenant` rather than named, so it cannot drift from the real one.
 */
type TransactionHandle = Parameters<Parameters<typeof withTenant>[1]>[0];

/* ------------------------------------------------------------------ */
/* REQUEST FACTS                                                       */
/* ------------------------------------------------------------------ */

type RequestFacts = {
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
  country: string | null;
};

const EMPTY_FACTS: RequestFacts = {
  ipAddress: null,
  userAgent: null,
  requestId: null,
  country: null,
};

/**
 * Pull forensic detail from the incoming request.
 *
 * `x-forwarded-for` is client-controllable in general. On Vercel the edge
 * network overwrites it, so the first entry is trustworthy in production —
 * but this value is recorded as EVIDENCE and used for GROUPING, never for an
 * authorization decision. That distinction is what makes it safe to store a
 * header an attacker can set.
 */
async function getRequestFacts(): Promise<RequestFacts> {
  try {
    const h = await headers();
    return {
      ipAddress: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? null,
      userAgent: h.get("user-agent")?.slice(0, 500) ?? null,
      requestId: h.get("x-request-id") ?? null,
      country: h.get("x-vercel-ip-country")?.slice(0, 2) ?? null,
    };
  } catch {
    // No request scope — a cron job or a detector run. Not an error.
    return EMPTY_FACTS;
  }
}

/* ------------------------------------------------------------------ */
/* BURST COALESCING                                                    */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * THE PROBLEM: OUR OWN LOGGING IS A DENIAL-OF-SERVICE VECTOR
 * ══════════════════════════════════════════════════════════════════════
 * A scraper that trips the search limit does so on every request — thousands
 * per minute. One INSERT per trip means the attacker controls the write rate
 * of an APPEND-ONLY table that has no deletion path from the application.
 * They fill the disk, they slow every other query, and the resulting rows
 * are 10,000 copies of one fact.
 *
 * So identical events inside a short window are coalesced: the first one
 * writes, the rest increment a counter, and when the window closes the next
 * write carries `occurrence_count`. One legible row instead of ten thousand
 * identical ones, and the count is the number a reviewer actually wants.
 *
 * ⚠️ PER PROCESS, like the limiter's memory fallback. Across a hundred
 * serverless instances there may be a hundred rows per window rather than
 * one. That is fine — a hundred rows is legible, ten thousand is not — but
 * it means `occurrence_count` is a LOWER BOUND on what happened, and any
 * dashboard reading it must say so.
 *
 * ⚠️ NEVER APPLIED TO CRITICAL EVENTS. A forged webhook signature or a
 * cross-tenant access attempt is written every single time. Suppressing the
 * second occurrence of something that severe to save a row is a trade nobody
 * would accept if asked out loud.
 */
const COALESCE_WINDOW_MS = 10_000;
const COALESCE_MAX_KEYS = 2_000;

type CoalesceEntry = { windowStart: number; suppressed: number };

const coalesceState = new Map<string, CoalesceEntry>();

function coalesceKey(input: SecurityEventInput, prefix: string | null): string {
  return [
    input.type,
    input.tenantId ?? "-",
    input.source,
    input.subjectType ?? "-",
    input.subjectId ?? "-",
    prefix ?? "-",
  ].join("|");
}

/**
 * Decide whether to write, and with what count.
 * Returns null when the event should be suppressed.
 */
function coalesce(
  key: string,
  severity: SecuritySeverity,
  nowMs: number,
): { occurrenceCount: number } | null {
  // Critical events bypass coalescing entirely. See the note above.
  if (severity === "critical") return { occurrenceCount: 1 };

  const entry = coalesceState.get(key);

  if (!entry || nowMs - entry.windowStart >= COALESCE_WINDOW_MS) {
    const suppressed = entry && nowMs - entry.windowStart < COALESCE_WINDOW_MS * 2
      ? entry.suppressed
      : 0;
    coalesceState.set(key, { windowStart: nowMs, suppressed: 0 });

    if (coalesceState.size > COALESCE_MAX_KEYS) {
      // Bounded, for the same reason the limiter's map is bounded: an
      // attacker rotating IPs must not be able to grow this without limit.
      const evict = Math.ceil(COALESCE_MAX_KEYS * 0.1);
      let n = 0;
      for (const k of coalesceState.keys()) {
        if (n >= evict) break;
        coalesceState.delete(k);
        n += 1;
      }
    }

    return { occurrenceCount: 1 + suppressed };
  }

  entry.suppressed += 1;
  return null;
}

/* ------------------------------------------------------------------ */
/* ESCALATION HOOK                                                     */
/* ------------------------------------------------------------------ */

type RecordFailureListener = (info: {
  type: SecurityEventType;
  severity: SecuritySeverity;
  error: string;
}) => void;

let failureListener: RecordFailureListener | null = null;

/**
 * Register a callback fired when a security event FAILS to persist.
 *
 * Exists because the failure mode this module must not have is "the database
 * is unreachable during an intrusion, so nothing is recorded and nothing is
 * alerted either". The hook lets an operator wire a path that does not depend
 * on Postgres — a webhook to Slack, a log drain — without this file taking a
 * dependency on any of them.
 */
export function onSecurityRecordFailure(listener: RecordFailureListener | null): void {
  failureListener = listener;
}

/* ------------------------------------------------------------------ */
/* ROW CONSTRUCTION                                                    */
/* ------------------------------------------------------------------ */

type BuiltRow = typeof securityEvents.$inferInsert;

/**
 * Turn a caller's input into the row that will be written.
 *
 * Exported for tests: the redaction and severity-floor rules are the two
 * things most worth asserting, and asserting them through a live database
 * would test the database instead.
 */
export function buildSecurityEventRow(
  input: SecurityEventInput,
  facts: RequestFacts,
  occurrenceCount = 1,
): BuiltRow {
  const ip = input.ipAddress ?? facts.ipAddress;

  return {
    tenantId: input.tenantId ?? null,
    eventType: input.type,
    // `resolveSeverity` takes the HIGHER of default and requested — a call
    // site can escalate an alarm but never quietly demote one.
    severity: resolveSeverity(input.type, input.severity),
    source: input.source.slice(0, 120),
    subjectType: input.subjectType?.slice(0, 60) ?? null,
    subjectId: input.subjectId?.slice(0, 255) ?? null,
    actorUserId: input.actorUserId ?? null,
    ipAddress: ip?.slice(0, 45) ?? null,
    ipPrefix: ip ? ipPrefix(ip).slice(0, 60) : null,
    userAgent: input.userAgent ?? facts.userAgent,
    requestId: input.requestId ?? facts.requestId,
    route: input.route?.slice(0, 255) ?? null,
    country: facts.country,
    ratePolicy: typeof input.detail?.["policy"] === "string"
      ? String(input.detail["policy"]).slice(0, 30)
      : null,
    occurrenceCount,
    // ⭐ EVERY write goes through the redactor. Not "when the caller
    // remembers" — this table is append-only and is exported to a SIEM, so a
    // leaked credential written here can never be removed.
    detail: sanitiseDetail(input.detail),
    reason: input.reason ?? null,
    occurredAt: new Date(),
  };
}

/* ------------------------------------------------------------------ */
/* WRITER 1 — STANDALONE, BEST EFFORT                                  */
/* ------------------------------------------------------------------ */

export type RecordOptions = {
  /** Skip burst coalescing for this call. */
  noCoalesce?: boolean;
  /** Injected clock, tests only. */
  nowMs?: number;
};

/**
 * Record a security event outside any transaction.
 *
 * NEVER THROWS. Returns true if a row was written, false if it was
 * coalesced away or the write failed.
 *
 * @example
 *   await recordSecurityEvent({
 *     type: "rate_limit.exceeded",
 *     source: "api/search",
 *     tenantId: ctx.tenant.id,
 *     detail: { policy: "search" },
 *   });
 */
export async function recordSecurityEvent(
  input: SecurityEventInput,
  options: RecordOptions = {},
): Promise<boolean> {
  const severity = resolveSeverity(input.type, input.severity);

  try {
    const facts = await getRequestFacts();
    const ip = input.ipAddress ?? facts.ipAddress;
    const prefix = ip ? ipPrefix(ip) : null;

    let occurrenceCount = 1;
    if (!options.noCoalesce) {
      const decision = coalesce(
        coalesceKey(input, prefix),
        severity,
        options.nowMs ?? Date.now(),
      );
      if (!decision) return false;
      occurrenceCount = decision.occurrenceCount;
    }

    /*
     * ══════════════════════════════════════════════════════════════════
     * 🔴 A TENANT-ATTRIBUTED EVENT CANNOT BE WRITTEN BY THE UNSCOPED
     *    CLIENT, AND SEVEN CALL SITES HAD NEVER WRITTEN A ROW.
     * ══════════════════════════════════════════════════════════════════
     * `security_events`' WITH CHECK compares `tenant_id` against
     * `app_current_tenant_id()`, which is NULL outside a transaction. So
     * clause 1 is NULL, clause 2 fails on `tenant_id IS NULL`, clause 3 is
     * false, and the INSERT is REFUSED. `relforcerowsecurity` is true, so
     * production's table-owning role is not exempt either.
     *
     * Measured in wave 15 across every environment: upload rejections,
     * rate-limit breaches, search abuse, impersonation close, session
     * anomalies, every anomaly finding carrying a tenant , and
     * `tenant.cross_access_attempt`, one of two `critical` types, whose
     * own comment calls it a page-someone event. None of them could fire.
     *
     * ⚠️ THE FALLBACK IS NOT DEFENSIVE PADDING. If the scoped write fails
     * , tenant deleted, id malformed, database unreachable , the event
     * must still land with `tenant_id NULL` and the id preserved in
     * `detail`, because a security event lost is worse than a security
     * event filed in the wrong drawer. `lib/security/evidence.ts` uses
     * the same ordering.
     */
    const row = buildSecurityEventRow(input, facts, occurrenceCount);

    if (input.tenantId) {
      try {
        const { withTenant } = await import("@/db");
        await withTenant(input.tenantId, (tx) =>
          tx.insert(securityEvents).values(row),
        );
        return true;
      } catch (scopedErr) {
        /*
         * FAIL OPEN, and named as such so the gate can see the decision.
         * The scoped write failed , tenant deleted, id malformed, database
         * unreachable. Returning `false` here would be honest about this
         * write and would LOSE the event, and a security event lost is
         * worse than a security event filed in the wrong drawer. So it is
         * demoted to platform scope, the tenant id is preserved in
         * `detail` where it remains queryable, and the demotion is logged
         * loudly. `true` means "the evidence exists", not "it is perfect".
         */
        const { db } = await import("@/db");
        await db.insert(securityEvents).values({
          ...row,
          tenantId: null,
          detail: {
            ...(row.detail && typeof row.detail === "object" ? row.detail : {}),
            tenant_id_unwritable: input.tenantId,
            tenant_scope_error:
              scopedErr instanceof Error ? scopedErr.message : String(scopedErr),
          },
        });
        console.error("[SECURITY EVENT DEMOTED TO PLATFORM SCOPE]", {
          type: input.type,
          tenantId: input.tenantId,
          error: scopedErr instanceof Error ? scopedErr.message : String(scopedErr),
        });
        return true;
      }
    }

    const { db } = await import("@/db");
    await db.insert(securityEvents).values(row);

    return true;
  } catch (err) {
    const message = err instanceof Error
      ? (err.cause instanceof Error ? `${err.message} :: ${err.cause.message}` : err.message)
      : String(err);

    // Loud, structured, and it names the event that was lost — so the gap in
    // the table has a corresponding line in the log drain.
    console.error("[SECURITY EVENT WRITE FAILED]", {
      type: input.type,
      severity,
      source: input.source,
      tenantId: input.tenantId ?? null,
      error: message,
    });

    if (severity === "critical") {
      try {
        failureListener?.({ type: input.type, severity, error: message });
      } catch {
        /* a broken alert path must not become a second failure */
      }
    }

    return false;
  }
}

/* ------------------------------------------------------------------ */
/* WRITER 2 — TRANSACTIONAL, PROPAGATES                                */
/* ------------------------------------------------------------------ */

/**
 * Record a security event inside an existing transaction.
 *
 * ⚠️ THROWS ON FAILURE, BY DESIGN. If this write fails the surrounding
 * transaction rolls back, and whatever state change it was recording is
 * undone. That is correct: the alternative is a system that quietly performs
 * a security-relevant mutation — revoking a portal link after abuse
 * detection, locking an account after a brute-force run — with no record of
 * why. "It happened and we don't know why" is the outcome that makes an
 * incident unresolvable.
 *
 * Never coalesced. A transactional event is paired with a state change, and
 * state changes are not duplicates of each other even when they look alike.
 */
export async function recordSecurityEventTx(
  tx: TransactionHandle,
  input: SecurityEventInput,
): Promise<void> {
  const facts = await getRequestFacts();
  await tx.insert(securityEvents).values(buildSecurityEventRow(input, facts, 1));
}

/* ------------------------------------------------------------------ */
/* CONVENIENCE — the two call shapes used most                         */
/* ------------------------------------------------------------------ */

/**
 * Record a rate-limit trip. Thin wrapper so the ~six call sites that need it
 * cannot disagree about the detail keys — a SIEM rule matching
 * `detail.policy` is worthless if half the callers name it `detail.limiter`.
 */
export async function recordRateLimitTrip(args: {
  policy: string;
  source: string;
  tenantId?: string | null;
  actorUserId?: string | null;
  ipAddress?: string | null;
  route?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  degraded?: boolean;
}): Promise<boolean> {
  return recordSecurityEvent({
    type: "rate_limit.exceeded",
    source: args.source,
    tenantId: args.tenantId ?? null,
    actorUserId: args.actorUserId ?? null,
    ipAddress: args.ipAddress ?? null,
    route: args.route ?? null,
    subjectType: args.subjectType ?? null,
    subjectId: args.subjectId ?? null,
    detail: {
      policy: args.policy,
      // Recorded because a trip observed on the degraded per-instance counter
      // means the real rate was HIGHER than the limit by an unknown multiple.
      degraded: args.degraded ?? false,
    },
    reason: `Rate limit policy "${args.policy}" exceeded.`,
  });
}

/** Clear coalescing state. Test-only; see the limiter's equivalent. */
export function __resetRecorderStateForTests(): void {
  coalesceState.clear();
  failureListener = null;
}
