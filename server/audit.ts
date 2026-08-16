import "server-only";

/**
 * Ordence — Audit & Authorization Enforcement
 * Version: v0.5.0-alpha
 *
 * ONE PATH FOR BOTH CONCERNS.
 *
 * `checkPermission()` does two things that must never be separated: it decides
 * whether an action is allowed, and — when it is not — it records the denial.
 * Splitting them would mean every call site has to remember to log, and some
 * would not. Attempted-but-blocked actions are precisely the events a security
 * review needs; losing them is worse than losing successful ones.
 *
 * The audit table is `audit_logs` (Phase 1), already append-only at the database
 * level and already under RLS. Phase 5 adds `metadata` and `severity` to it
 * rather than creating a second table — an audit trail split across two tables
 * cannot prove anything, because you would have to trust that both were complete.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ AND SINCE v1.38.0, TAMPER-EVIDENT — SQL-FILES/0081_audit_hash_chain.sql
 * ══════════════════════════════════════════════════════════════════════
 * "Append-only at the database level" was always a statement about the
 * APPLICATION. The trigger and the RLS policy both live inside Postgres,
 * so both are available to anybody who reaches Postgres with owner
 * rights: disable the trigger, edit the row, re-enable it, three
 * statements and no trace anywhere.
 *
 * Every row this file writes now carries a per-tenant hash chain, so
 * that edit is DETECTABLE. The full design — why the chain covers the
 * previous row's hash rather than just the row, why it is per tenant,
 * what happens under concurrency, why nothing is backfilled, and the
 * long list of what it deliberately does NOT prove — is in
 * `lib/audit/chain.ts`. What belongs HERE is the writer and the
 * degradation rule, below.
 */

import { headers } from "next/headers";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db, withTenant } from "@/db";
import { auditLogs, permissionDenials } from "@/db/schema";
import {
  chainScopeFor,
  nextChainLink,
  type AuditChainHead,
  type AuditChainLink,
} from "@/lib/audit/chain";
import { DANGEROUS_PERMISSIONS, type PermissionKey } from "@/db/schema/auth";
import {
  evaluatePermission,
  PermissionDeniedError,
  isPermissionKey,
  type PermissionDecision,
} from "@/lib/permissions";
import { requireTenantContext, type TenantContext } from "@/server/tenant-context";

/* ------------------------------------------------------------------ */
/* AUDIT ACTIONS                                                       */
/* ------------------------------------------------------------------ */

export type AuditAction =
  | "create" | "read" | "update" | "delete"
  | "login" | "logout" | "login_failed"
  | "permission_change" | "role_change"
  | "export" | "impersonate" | "config_change" | "security_event";

export type AuditSeverity = "info" | "notice" | "warning" | "critical";

export type AuditEntry = {
  action: AuditAction;
  resourceType: string;
  resourceId?: string | null;
  oldValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
  /** Circumstance of the event — period id, contract version, amounts, etc. */
  metadata?: Record<string, unknown>;
  reason?: string;
  severity?: AuditSeverity;
};

/* ------------------------------------------------------------------ */
/* REQUEST CONTEXT                                                     */
/* ------------------------------------------------------------------ */

type RequestFacts = {
  ipAddress: string | null;
  userAgent: string | null;
  country: string | null;
  requestId: string | null;
};

/**
 * Extract forensic detail from the request.
 *
 * `x-forwarded-for` is client-controllable in general, but on Vercel the edge
 * network overwrites it, so the first entry is trustworthy here. It is recorded
 * as evidence, never used for an authorization decision.
 */
async function getRequestFacts(): Promise<RequestFacts> {
  try {
    const h = await headers();
    const forwarded = h.get("x-forwarded-for");
    return {
      ipAddress: forwarded?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? null,
      userAgent: h.get("user-agent")?.slice(0, 500) ?? null,
      country: h.get("x-vercel-ip-country") ?? null,
      requestId: h.get("x-request-id") ?? null,
    };
  } catch {
    // No request context (background job) — not an error, just no forensics.
    return { ipAddress: null, userAgent: null, country: null, requestId: null };
  }
}

/* ------------------------------------------------------------------ */
/* THE CHAINED APPEND                                                  */
/* ------------------------------------------------------------------ */

/**
 * The columns of `audit_logs` that go into `content_hash`.
 *
 * ⚠️ ANY COLUMN NOT IN THIS SHAPE IS OUTSIDE THE CHAIN AND CAN BE
 * REWRITTEN WITHOUT DETECTION. That is a real hole and it is named
 * rather than hidden: `id` and `created_at` are the two deliberate
 * omissions on the row itself — `id` because it is a surrogate that
 * proves nothing about the event, and `created_at` because it is
 * INCLUDED (see below) precisely so a backdated row is caught.
 *
 * 🔴 IF YOU ADD A COLUMN TO `audit_logs`, ADD IT HERE. A new column that
 * carries meaning and is not hashed is a place to put the thing you
 * later want to change quietly. The 0081 header says the same, because
 * the person adding a column reads the schema, not this file.
 */
type AuditRowContent = Record<string, unknown>;

/**
 * How many times a chain append retries against a genuine race on the
 * head before degrading to an unchained (flagged) row. Exported because
 * `server/platform/guard.ts`'s `recordPlatformAudit()` appends to the
 * SAME chains (`audit_logs` per tenant, one `platform_action_log` chain)
 * and a writer that retries against a different window than the unique
 * index enforces would fork chains under load. ONE constant, both
 * writers.
 */
export const MAX_CHAIN_ATTEMPTS = 4;

/**
 * Append one row to a tenant's audit chain.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ CONCURRENCY: OPTIMISTIC, NOT LOCKED. WHAT THAT BUYS AND COSTS.
 * ══════════════════════════════════════════════════════════════════════
 * Read the head, compute `seq = head + 1` and `prev_hash = head.rowHash`,
 * INSERT. Two writes racing in one tenant both read the same head and
 * both try the same sequence number; the partial UNIQUE index from 0081
 * gives the loser `23505` and this function retries against the new
 * head. Nothing is locked, and nothing is held across the hashing.
 *
 * The alternative was `pg_advisory_xact_lock(tenant)`, which serialises
 * audit writes per tenant. It is simpler to reason about, and it makes
 * the audit write a thing that can BLOCK — on a request path, a blocked
 * audit write is a blocked request, and the queue forms exactly when the
 * workspace is busiest, which is exactly when the audit trail matters
 * most. Retrying costs a round trip in a race; blocking costs the
 * request.
 *
 * 🔴 WHAT THIS GUARANTEES: within one tenant, `chain_seq` is dense and
 * total, and each row's `prev_hash` is the `row_hash` of the row before
 * it. No two rows can occupy one position.
 *
 * 🔴 WHAT IT DOES NOT: `chain_seq` IS AN APPEND ORDER, NOT A CLOCK.
 * Under a race the writer that reached the index first gets the lower
 * number even if its event happened microseconds later. Anything that
 * needs real ordering must read `created_at` and accept its resolution.
 * And no ordering here says anything about an action that was never
 * audited at all — see the note in `lib/audit/chain.ts`.
 *
 * ⚠️ EACH ATTEMPT IS ITS OWN TRANSACTION, because it must be: a 23505
 * aborts the transaction it happened in, so a retry inside the same one
 * would fail with `current transaction is aborted`. That is also why the
 * retry re-READS the head rather than incrementing the number it had —
 * the row that beat us may not be the only one that landed.
 *
 * Returns the row it wrote, or null if it exhausted its attempts.
 */
async function appendChainedAuditRow(
  tenantId: string,
  content: AuditRowContent,
  impersonationId: string | null,
): Promise<AuditChainLink | null> {
  const scope = chainScopeFor(tenantId);

  for (let attempt = 1; attempt <= MAX_CHAIN_ATTEMPTS; attempt++) {
    try {
      return await withTenant(
        tenantId,
        async (tx) => {
          /**
           * ⭐ THE HEAD READ IS TENANT-SCOPED BY RLS, NOT BY THIS `WHERE`.
           * `audit_logs_tenant_isolation` already restricts it; the
           * predicate is here so the intent is readable and so the
           * partial index is used. It is also the sentence that explains
           * why the chain CANNOT be global: a global chain would need
           * this read to return another tenant's row, and the policy
           * refuses. See constraint 2 in `lib/audit/chain.ts`.
           */
          const [row] = await tx
            .select({ chainSeq: auditLogs.chainSeq, rowHash: auditLogs.rowHash })
            .from(auditLogs)
            .where(and(eq(auditLogs.tenantId, tenantId), isNotNull(auditLogs.chainSeq)))
            .orderBy(desc(auditLogs.chainSeq))
            .limit(1);

          const head: AuditChainHead =
            row?.chainSeq != null && row.rowHash != null
              ? { chainSeq: row.chainSeq, rowHash: row.rowHash }
              : null;

          const link = nextChainLink({ scope, head, content });

          await tx.insert(auditLogs).values({
            ...(content as typeof auditLogs.$inferInsert),
            chainSeq: link.chainSeq,
            prevHash: link.prevHash,
            contentHash: link.contentHash,
            rowHash: link.rowHash,
          });

          return link;
        },
        { impersonationId },
      );
    } catch (err) {
      if (!isChainRace(err) || attempt === MAX_CHAIN_ATTEMPTS) throw err;
      // Lost the race. Fall through and re-read the head.
    }
  }

  return null;
}

/**
 * ⚠️ THE NARROWEST POSSIBLE TEST FOR "SOMEBODY ELSE TOOK THAT POSITION".
 *
 * Retrying on any error would retry a malformed row four times and take
 * four times as long to lose it. `23505` alone is still too broad —
 * `audit_logs` has a primary key, and a uuid collision retried is a uuid
 * collision retried — so the constraint name has to match too. The two
 * names come straight from 0081 section 3.
 */
export function isChainRace(err: unknown): boolean {
  const e = err as { code?: unknown; constraint?: unknown; message?: unknown };
  const code = typeof e?.code === "string" ? e.code : "";
  const text = `${typeof e?.constraint === "string" ? e.constraint : ""} ${
    typeof e?.message === "string" ? e.message : ""
  }`;
  return (
    (code === "23505" || text.includes("duplicate key")) &&
    (text.includes("audit_logs_chain_tenant_seq_uq") ||
      text.includes("audit_logs_chain_platform_seq_uq"))
  );
}

/**
 * The degraded write: the same row, with no chain columns at all.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 CONSTRAINT 5 — HASHING FAILURE IS **NOT** FATAL, AND HERE IS WHY
 * ══════════════════════════════════════════════════════════════════════
 * The tempting rule is "if it cannot be chained, refuse the write" —
 * better no evidence than untrustworthy evidence. It is wrong here, for
 * a reason specific to what this function is:
 *
 *   ⭐ THE AUDIT WRITE DESCRIBES AN OPERATION THAT ALREADY HAPPENED. By
 *   the time `writeAudit()` runs, the invoice is posted and the
 *   permission is granted. Refusing to record it does not undo it; it
 *   produces a system where the act took place and NOTHING SAYS SO.
 *   Compare the two failures honestly:
 *
 *     row written, unchained → the event is in the trail, flagged as
 *                              not attested, and the verifier reports
 *                              exactly how many such rows exist and
 *                              when they were written.
 *     row not written        → the event is nowhere. No flag, no count,
 *                              nothing to notice.
 *
 *   The first is strictly more information than the second, and the
 *   second is indistinguishable from the action never happening — which
 *   is the state an attacker WANTS. A rule that discards audit rows when
 *   the chain is under stress hands them a denial-of-audit: make the
 *   chain fail and the record disappears.
 *
 * ⚠️ THIS IS THE SAME REASONING THE TELEMETRY WRITERS USE, AND IT IS NOT
 * THE SAME CONCLUSION. `app/api/telemetry/route.ts`, `lib/telemetry/
 * report.ts` and `server/security/record.ts` swallow 42501 silently
 * because telemetry must never break the request it describes — and 0079
 * found they had been silently discarding every attributed row for
 * months, because a swallowed failure that logs nothing is a failure
 * nobody learns about. So this path swallows the WRITE failure and
 * SHOUTS about it: a distinct `[AUDIT CHAIN DEGRADED]` line, a NULL
 * chain the verifier counts, and a `writeAudit` catch that already logs
 * loudly. The lesson from 0079 is not "never swallow" — it is "never
 * swallow quietly".
 *
 * 🔴 AND THE HOLE THIS LEAVES, SAID PLAINLY: an attacker who can force
 * sustained contention or repeated failures on one tenant's chain can
 * cause rows to be written unchained, and unchained rows are not
 * attested. They cannot make rows VANISH, and they cannot make the
 * degradation invisible — section 2 of VERIFY-0081 counts unchained rows
 * per tenant and timestamps the most recent one, so a burst of them is
 * itself the signal. That is the trade, and it is deliberate.
 */
async function appendUnchainedAuditRow(
  tenantId: string,
  content: AuditRowContent,
  impersonationId: string | null,
  cause: unknown,
): Promise<void> {
  console.error("[AUDIT CHAIN DEGRADED]", {
    tenantId,
    action: content.action,
    resourceType: content.resourceType,
    note:
      "Row written OUTSIDE the hash chain. It is in the trail but not attested. " +
      "VERIFY-0081 section 2 counts these per tenant.",
    error: cause instanceof Error ? cause.message : String(cause),
  });

  await withTenant(
    tenantId,
    async (tx) => {
      // ⚠️ NO CHAIN COLUMNS AT ALL, not "some of them". The 0081
      // all-or-nothing CHECK refuses a half-hashed row, because a
      // half-hashed row is unfalsifiable: it lets somebody blank a hash
      // and claim the row predates the chain.
      await tx.insert(auditLogs).values(content as typeof auditLogs.$inferInsert);
    },
    { impersonationId },
  );
}

/* ------------------------------------------------------------------ */
/* AUDIT WRITER                                                        */
/* ------------------------------------------------------------------ */

/**
 * Write an audit record.
 *
 * NEVER THROWS. An audit failure must not roll back the user's work — but it is
 * logged loudly to stderr so a broken audit pipeline is visible in monitoring
 * rather than silently swallowing history.
 */
export async function writeAudit(
  ctx: Pick<TenantContext, "tenant" | "user" | "role" | "clerkUserId"> &
    Partial<
      Pick<TenantContext, "impersonationId" | "operatorEmail" | "impersonationScope">
    >,
  entry: AuditEntry,
): Promise<void> {
  try {
    const facts = await getRequestFacts();

    /**
     * ══════════════════════════════════════════════════════════════
     * ⭐ THE IMPERSONATION STAMP — v0.31.0
     * ══════════════════════════════════════════════════════════════
     * `audit_logs.impersonation_id` has existed since Phase 17 and
     * nothing wrote it, because nothing upstream knew. Now
     * `requireTenantContext()` resolves a live session into the
     * context, so this is the line that makes the whole thing
     * attributable.
     *
     * ⚠️ IT IS THE FLAG, NOT THE ACTOR. The actor columns already
     * name the real human — `getImpersonatedTenantContext()` refuses
     * to run without a named subject precisely so those columns are
     * never the customer's own user. This column answers the second
     * question, which is the one a reviewer actually asks: "was this
     * OUR staff, acting inside their workspace?"
     *
     * Both, not either. Attribution without the flag records that
     * priya@ourcompany.com updated a contact — true, and
     * indistinguishable from priya having been a customer employee.
     * The flag without attribution records that somebody was
     * impersonating and not who. A session that is not attributable
     * is worse than no session at all, because it looks accountable.
     *
     * ⚠️ `?? null` RATHER THAN OMISSION. Some callers pass a narrowed
     * `Pick<>` that predates this field; those actions are ordinary
     * tenant work and NULL is the honest value for them.
     */
    const impersonationId = ctx.impersonationId ?? null;

    /**
     * ══════════════════════════════════════════════════════════════
     * ⭐ THE ACTOR IS THE HUMAN TYPING — v1.48.0
     * ══════════════════════════════════════════════════════════════
     * Under impersonation, `ctx.user` is the CUSTOMER's employee — the
     * face being reproduced — and `ctx.operatorEmail` is the real human
     * behind the keyboard, our staff member. Before this line the actor
     * columns named the customer's own user, so our engineer's work was
     * indistinguishable from the customer's work: attribution without
     * accountability. The defect named in the release notes.
     *
     * The rule: `actorEmail`/`actorRole` ALWAYS name the human who acted.
     * The customer identity is preserved in `metadata` so the customer
     * audit view can still say "your workspace was acted upon as
     * <customer user>". Both, not either — same doctrine as the
     * impersonation stamp above.
     *
     * ⚠️ THE CONTENT OBJECT BELOW IS THE ONE OBJECT THAT IS BOTH HASHED
     * AND INSERTED. These two fields are part of the digest; changing
     * what an actor column holds therefore CHANGES the chain for every
     * impersonated row going forward — which is what it should do, and
     * why the verifier will now report a discontinuity at the first
     * impersonated action after this deploy. That is correct behaviour:
     * the discontinuity IS the fix being visible in the chain.
     */
    const operatorEmail = ctx.operatorEmail ?? null;
    const isImpersonatedSession = impersonationId !== null;
    const actorEmail =
      isImpersonatedSession && operatorEmail ? operatorEmail : ctx.user.email;
    const actorRole =
      isImpersonatedSession && operatorEmail ? "platform_operator" : ctx.role;

    /**
     * ══════════════════════════════════════════════════════════════
     * ⚠️ `createdAt` IS SET HERE, NOT LEFT TO `DEFAULT now()`
     * ══════════════════════════════════════════════════════════════
     * It is one of the hashed fields, and the hash is computed in this
     * process. If the column were left to the database default, the
     * value hashed and the value stored would be different by the
     * round-trip time, and every single row would fail content
     * verification — a verifier that reports 100% tampering is a
     * verifier that gets switched off on day one.
     *
     * ⚠️ THE COST: the timestamp is now the APPLICATION's clock, not
     * the database's, so it inherits whatever skew the runtime has.
     * That is the honest trade for being able to attest it at all, and
     * it is worth saying that `created_at` was never a trustworthy
     * ordering — `chain_seq` is the order that can be proved.
     */
    const createdAt = new Date();

    /**
     * ══════════════════════════════════════════════════════════════
     * 🔴 THIS MUST RUN INSIDE `withTenant()`. IT DID NOT, UNTIL NOW.
     * ══════════════════════════════════════════════════════════════
     * `audit_logs` is under RLS with `ENABLE` + `FORCE` and a policy
     * whose WITH CHECK clause is `tenant_id = app_current_tenant_id()`.
     *
     * The plain `db` client carries NO tenant context, so
     * `app_current_tenant_id()` returns NULL, `tenant_id = NULL` is
     * never TRUE, and PostgreSQL rejects the INSERT:
     *
     *     ERROR: new row violates row-level security policy
     *            for table "audit_logs"
     *
     * The catch block below then swallowed it and logged to the
     * console — which on a serverless platform means it went into a
     * log nobody reads, once per audited action, forever.
     *
     * The result: EVERY AUDIT WRITE THROUGH THIS FUNCTION FAILED
     * SILENTLY, on any deployment where the application role is
     * subject to RLS. The table was empty. Nothing anywhere said so.
     *
     * It survived a security suite of 238 tests because those tests
     * insert audit rows as a SUPERUSER (which bypasses RLS entirely)
     * in order to then prove the append-only triggers work. They
     * proved the guard on a table nothing was writing to.
     *
     * Verified against PostgreSQL 16 on 31 July 2026:
     *     no tenant context   → RLS violation
     *     inside withTenant() → INSERT 0 1
     *
     * The fix is one wrapper. The lesson is that "the audit trail
     * works" was never actually tested end to end — only its
     * immutability was.
     */
    /**
     * ⭐ THE HASHED CONTENT AND THE INSERTED ROW ARE ONE OBJECT.
     *
     * Not two. The obvious shape — build the row, then build a separate
     * "what to hash" object from the same fields — is how a column comes
     * to be written but not hashed: somebody adds a field to the insert
     * and not to the digest, and the row is silently outside the
     * protection while looking exactly like every attested row.
     * `appendChainedAuditRow()` hashes this object and inserts THIS
     * object, so the two cannot drift.
     */
    const content = {
      tenantId: ctx.tenant.id,
      actorUserId: isImpersonatedSession ? null : ctx.user.id,
      actorClerkId: ctx.clerkUserId,
      actorEmail,
      actorRole,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ?? null,
      oldValue: entry.oldValue ?? null,
      newValue: entry.newValue ?? null,
      metadata: {
        /**
         * ⭐ THE REPRODUCED IDENTITY, IN METADATA — v1.48.0.
         *
         * ⚠️ WHY METADATA AND NOT TOP-LEVEL COLUMNS: `audit_logs` has no
         * `actor_was_reproduced_*` columns, and this release ships with NO
         * new SQL. The hashed content and the inserted row are the same
         * object — adding fields that the schema has no columns for would
         * break INSERT, and the schema change would have to wait for the
         * next SQL batch. JSONB metadata is fully hashed (it is part of
         * `content`), so nothing is unattested: the reproduced identity is
         * in the digest, queryable, and visible in the customer audit
         * view exactly where other circumstances live.
         */
        ...(entry.metadata ?? {}),
        actorWasReproducedUserId: isImpersonatedSession ? ctx.user.id : null,
        actorWasReproducedEmail: isImpersonatedSession ? ctx.user.email : null,
      },
      severity: entry.severity ?? "info",
      reason: entry.reason ?? null,
      impersonationId,
      ipAddress: facts.ipAddress,
      userAgent: facts.userAgent,
      country: facts.country,
      requestId: facts.requestId,
      createdAt,
    };

    // ⚠️ The impersonation marker is set on the audit transaction too. It
    // changes nothing here — the DELETE guard only refuses DELETEs and
    // this is an INSERT — but a transaction that writes the evidence of
    // an impersonated action should not be the one place in the request
    // where the session is invisible to the database.
    try {
      const link = await appendChainedAuditRow(ctx.tenant.id, content, impersonationId);
      if (link === null) {
        // Exhausted its retries against a genuinely hot chain. Degrade
        // rather than lose the row — see `appendUnchainedAuditRow()`.
        await appendUnchainedAuditRow(
          ctx.tenant.id,
          content,
          impersonationId,
          new Error(`Lost ${MAX_CHAIN_ATTEMPTS} races for the chain head.`),
        );
      }
    } catch (chainErr) {
      /**
       * 🔴 THE INNER CATCH IS THE POINT OF CONSTRAINT 5. Anything that
       * broke the chained path — the head read, the hash, a constraint,
       * a column that does not exist because 0081 has not been applied
       * — must not cost us the audit row. Falling back writes the same
       * content unchained and shouts about it.
       *
       * ⚠️ IF THE FALLBACK ALSO FAILS, the outer catch below logs
       * `[AUDIT WRITE FAILED]` and the operation still proceeds. That
       * is the pre-existing contract of this function and 0081 does not
       * change it: an audit failure must never roll back the user's
       * work.
       */
      await appendUnchainedAuditRow(ctx.tenant.id, content, impersonationId, chainErr);
    }
  } catch (err) {
    console.error("[AUDIT WRITE FAILED]", {
      tenantId: ctx.tenant.id,
      action: entry.action,
      resourceType: entry.resourceType,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Audit write for background jobs, where there is no logged-in user. */
export async function writeSystemAudit(
  tenantId: string,
  entry: AuditEntry & { actorLabel?: string },
): Promise<void> {
  try {
    /**
     * ⭐ THE SAME CHAIN, THE SAME TENANT, NOT A SEPARATE ONE.
     *
     * A background job's rows go into the workspace's one chain
     * alongside the interactive ones. A second chain per tenant for
     * "system" writes would be the same mistake as a second audit table:
     * you would have to trust that both were complete, and the ordering
     * between them would be unprovable — which is exactly the gap
     * somebody would use to slip a row in.
     *
     * Same RLS requirement as `writeAudit` above — see the block there.
     */
    const content = {
      tenantId,
      actorEmail: entry.actorLabel ?? "system",
      actorRole: "system",
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ?? null,
      oldValue: entry.oldValue ?? null,
      newValue: entry.newValue ?? null,
      metadata: entry.metadata ?? {},
      severity: entry.severity ?? "info",
      reason: entry.reason ?? null,
      // Hashed, so it must be ours rather than `DEFAULT now()` — the
      // reasoning is on `writeAudit`'s `createdAt`.
      createdAt: new Date(),
    };

    try {
      const link = await appendChainedAuditRow(tenantId, content, null);
      if (link === null) {
        await appendUnchainedAuditRow(
          tenantId,
          content,
          null,
          new Error(`Lost ${MAX_CHAIN_ATTEMPTS} races for the chain head.`),
        );
      }
    } catch (chainErr) {
      // Constraint 5 again: a background job's audit row is still an
      // audit row, and losing it is worse than not attesting it.
      await appendUnchainedAuditRow(tenantId, content, null, chainErr);
    }
  } catch (err) {
    console.error("[SYSTEM AUDIT WRITE FAILED]", err);
  }
}

/* ------------------------------------------------------------------ */
/* PERMISSION ENFORCEMENT                                              */
/* ------------------------------------------------------------------ */

/**
 * Check whether the current user may perform an action.
 *
 * Returns the decision without throwing — use when you want to branch, e.g. to
 * hide a button. Denials are still recorded.
 *
 * @example
 *   const { allowed } = await checkPermission("periods:close");
 */
export async function checkPermission(
  permission: PermissionKey,
  resource?: { type?: string; id?: string },
): Promise<PermissionDecision & { ctx: TenantContext }> {
  const ctx = await requireTenantContext();

  const decision = evaluatePermission(
    { role: ctx.role, overrides: ctx.user.permissionOverrides },
    permission,
  );

  if (!decision.allowed) {
    await recordDenial(ctx, decision, resource);
  }

  return { ...decision, ctx };
}

/**
 * Enforce a permission. Throws `PermissionDeniedError` if the user lacks it.
 *
 * This is the form to use at the top of a server action — it fails closed and
 * cannot be forgotten the way an `if` can.
 *
 * @example
 *   const ctx = await requirePermission("transactions:post");
 */
export async function requirePermission(
  permission: PermissionKey,
  resource?: { type?: string; id?: string },
): Promise<TenantContext> {
  const result = await checkPermission(permission, resource);
  if (!result.allowed) {
    throw new PermissionDeniedError(result);
  }
  return result.ctx;
}

/** Require every listed permission. */
export async function requireAllPermissions(
  permissions: readonly PermissionKey[],
  resource?: { type?: string; id?: string },
): Promise<TenantContext> {
  let ctx: TenantContext | null = null;
  for (const permission of permissions) {
    ctx = await requirePermission(permission, resource);
  }
  if (!ctx) throw new Error("requireAllPermissions() called with an empty list.");
  return ctx;
}

/** Record a failed permission check. Best-effort; never blocks the response. */
async function recordDenial(
  ctx: TenantContext,
  decision: PermissionDecision,
  resource?: { type?: string; id?: string },
): Promise<void> {
  try {
    const facts = await getRequestFacts();

    await withTenant(ctx.tenant.id, (tx) =>
      tx.insert(permissionDenials).values({
      tenantId: ctx.tenant.id,
      userId: ctx.user.id,
      clerkUserId: ctx.clerkUserId,
      actorRole: ctx.role,
      permission: String(decision.permission),
      resourceType: resource?.type ?? null,
      resourceId: resource?.id ?? null,
      wasDangerous: decision.isDangerous,
      ipAddress: facts.ipAddress,
      userAgent: facts.userAgent,
      requestId: facts.requestId,
      metadata: { reason: decision.reason },
      }),
    );

    // A blocked attempt at a dangerous permission also lands in the main audit
    // trail as a security event — that is the record a reviewer actually reads.
    if (decision.isDangerous) {
      await writeAudit(ctx, {
        action: "security_event",
        resourceType: resource?.type ?? "permission",
        resourceId: resource?.id ?? null,
        metadata: {
          permission: decision.permission,
          reason: decision.reason,
          role: ctx.role,
        },
        reason: `Blocked attempt at a privileged action: ${decision.permission}`,
        severity: "warning",
      });
    }
  } catch (err) {
    console.error("[DENIAL RECORD FAILED]", err);
  }
}

/* ------------------------------------------------------------------ */
/* AUDIT READS                                                         */
/* ------------------------------------------------------------------ */

export type AuditLogRow = {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  actorEmail: string | null;
  actorRole: string | null;
  severity: string;
  reason: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

/** Recent audit entries for this tenant. Requires `audit:read`. */
export async function getRecentAuditLogs(limit = 50): Promise<AuditLogRow[]> {
  // ⚠️ `eq` and `desc` used to be pulled in with a dynamic `import()`
  // here. They are module-level imports now because the chain writer
  // above needs them anyway, and a local binding that shadows a
  // module-level one of the same name is a trap for the next reader.
  const ctx = await requirePermission("audit:read");

  const rows = await withTenant(ctx.tenant.id, (tx) =>
    tx
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        resourceType: auditLogs.resourceType,
        resourceId: auditLogs.resourceId,
        actorEmail: auditLogs.actorEmail,
        actorRole: auditLogs.actorRole,
        severity: auditLogs.severity,
        reason: auditLogs.reason,
        metadata: auditLogs.metadata,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .where(eq(auditLogs.tenantId, ctx.tenant.id))
      .orderBy(desc(auditLogs.createdAt))
      .limit(Math.min(Math.max(1, limit), 200))
  );

  return rows as AuditLogRow[];
}

/** Helper for building metadata payloads without stray `undefined` values. */
export function auditMeta(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

export { DANGEROUS_PERMISSIONS, isPermissionKey };
export type { PermissionKey };
