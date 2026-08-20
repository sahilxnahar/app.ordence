import "server-only";

/**
 * Ordence — ⭐⭐⭐ THE EVIDENCE WRITER FOR CONTROLS THAT FAILED
 * Version: v1.82.0-alpha · Track D, wave 15
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS IS FOR, IN ONE SENTENCE
 * ══════════════════════════════════════════════════════════════════════
 * Wave 15 found four places where a FAILURE was recorded as a SUCCESS. The
 * fixes make each of them refuse instead of proceed. This file is what stops
 * the refusal itself from being silent — because a gate that starts refusing
 * with no row anywhere is only half a fix, and the half that is missing is
 * the half an operator needs at 03:00 to know why every customer's writes
 * began failing at once.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS IS NOT JUST A CALL TO `recordSecurityEvent()`
 * ══════════════════════════════════════════════════════════════════════
 * Two reasons, and both are about not fooling ourselves.
 *
 * ① THE FOUR NEW EVENT TYPES DO NOT EXIST IN THE DATABASE YET.
 *
 *   `security_events.event_type` is a Postgres ENUM derived from
 *   `SECURITY_EVENT_TYPES` in `lib/security/events.ts`. Adding a member to
 *   that constant changes the TypeScript union and the Drizzle schema
 *   immediately, and changes the DATABASE not at all — the enum needs
 *   `ALTER TYPE … ADD VALUE`, which needs a numbered migration, which Track D
 *   does not hold a number for (see `PATCH-REQUEST-D.md`).
 *
 *   The tempting thing to do about that is nothing: ship the code, wait for
 *   the migration, assume it lands. That would produce exactly this
 *   repository's signature defect — every one of these writes would fail
 *   with `invalid input value for enum security_event_type`, and because
 *   `recordSecurityEvent()` is best-effort by design, every one would fail
 *   SILENTLY. The four fixes would ship, the four events would be declared,
 *   and the evidence table would stay empty. Green, and empty.
 *
 *   So this writer DEGRADES rather than assumes: it tries the precise type,
 *   and if the database refuses it, rewrites the same facts as
 *   `anomaly.detected` with `detail.intended_type` naming what it should
 *   have been. The evidence survives before the migration and improves after
 *   it, and `intended_type` is a one-line query for whoever back-fills.
 *
 * ② A FAILURE TO RECORD A FAILURE MUST NOT BE THE THIRD SILENT FAILURE.
 *
 *   If both attempts fail, this returns `written: false` and says so to its
 *   caller, loudly, on stderr, with the facts inline. Callers are written to
 *   surface that rather than ignore it. `EvidenceOutcome` exists so that
 *   ignoring it takes an explicit `void`, not an absent-minded `await`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 ③ AND THE ONE THAT WAS NOT EXPECTED: A SECURITY EVENT CARRYING A
 * TENANT ID CANNOT BE WRITTEN BY THE UNSCOPED CLIENT. AT ALL. EVER.
 * ══════════════════════════════════════════════════════════════════════
 * `recordSecurityEvent()` writes with the module-level `db` client, which
 * opens no transaction and therefore sets no `app.current_tenant_id`. The
 * policy on `security_events` is:
 *
 *     WITH CHECK ( tenant_id = app_current_tenant_id()
 *               OR (tenant_id IS NULL AND app_current_tenant_id() IS NULL)
 *               OR app_platform_scope() )
 *
 * With no session variable set, `app_current_tenant_id()` is NULL, so the
 * first clause is NULL (never TRUE), the second fails on `tenant_id IS
 * NULL`, and the third is false. The INSERT is refused.
 *
 * Measured against PostgreSQL 16, as `ordence_app`:
 *
 *     INSERT … (tenant_id, …) VALUES ('1111…', 'anomaly.detected', …);
 *       ERROR:  new row violates row-level security policy for table "security_events"
 *     INSERT … (tenant_id, …) VALUES (NULL,     'anomaly.detected', …);
 *       INSERT 0 1
 *
 * ⚠️ AND `security_events` HAS `relforcerowsecurity = t`, so this is NOT
 * a grant problem that production's table-owning role escapes. It applies
 * to `neondb_owner` exactly as it applies to `ordence_app`.
 *
 * ⚠️ WHICH MEANS SEVEN EXISTING CALL SITES HAVE NEVER WRITTEN A ROW —
 * every one that passes a real tenant id. They are listed in
 * `TRACK-REPORT.md` §4. `recordSecurityEvent()` catches the refusal,
 * prints `[SECURITY EVENT WRITE FAILED]` and returns `false`, and every
 * one of those callers discards the return value.
 *
 * ⭐ SO THIS WRITER PICKS ITS SCOPE, RATHER THAN ASSUMING ONE. When a
 * tenant id is present it writes through `withTenant()` +
 * `recordSecurityEventTx()`, inside a transaction where
 * `app_current_tenant_id()` is set and the policy passes. Only if that
 * fails — the tenant is gone, the database is unreachable, the id is
 * malformed — does it fall back to an unscoped row with `tenant_id` NULL
 * and the id preserved in `detail.tenant_id`, which is worse attribution
 * and is a row that exists.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ `noCoalesce: true` ON EVERY WRITE, AND IT IS LOAD-BEARING
 * ══════════════════════════════════════════════════════════════════════
 * `recordSecurityEvent()` returns `false` for two different reasons: the
 * write failed, or the event was suppressed by burst coalescing. Those are
 * indistinguishable to the caller — which would make the fallback path fire
 * on a coalesced event and write a duplicate through the fallback type.
 * With coalescing off, `false` means one thing only, and the fallback
 * decision is sound.
 *
 * It is also correct on the merits. These four events are rare by
 * construction and each one is the answer to a question somebody is asking
 * during an incident. Deduplicating them to save rows would drop precisely
 * the second, third and fourth data points that show whether the problem is
 * spreading.
 */

import {
  type SecurityEventInput,
  type SecurityEventType,
  type SecuritySeverity,
} from "@/lib/security/events";

/**
 * The four types Track D added, as data.
 *
 * ⚠️ NOT A DECORATIVE LIST. `tests/security/evidence-fallback.test.ts`
 * asserts that every member is absent from the database enum OR present in
 * it, and that the writer behaves correctly in whichever state the database
 * is actually in. A list that drifted from the enum would make that test
 * assert something about types nobody emits.
 */
export const TRACK_D_EVENT_TYPES = [
  "billing.standing_unresolved",
  "platform.scope_raised",
  "security.evidence_write_failed",
  "automation.event_dropped",
] as const satisfies readonly SecurityEventType[];

export type TrackDEventType = (typeof TRACK_D_EVENT_TYPES)[number];

/**
 * Where an event goes when the database does not know its type yet.
 *
 * `anomaly.detected` and not, say, `auth.session_anomaly`: the boundary
 * documented at the top of `lib/security/events.ts` puts "our own inference
 * that something is not right, with no single request behind it" in the
 * anomaly bucket, and a control that could not decide is exactly that. The
 * `detail.intended_type` key is what keeps the row honest.
 */
export const EVIDENCE_FALLBACK_TYPE: SecurityEventType = "anomaly.detected";

export type EvidenceScope =
  /** Written inside `withTenant()`, so `tenant_id` is populated. */
  | "tenant"
  /** Written with the unscoped client and `tenant_id` NULL. */
  | "unscoped";

export type EvidenceOutcome = {
  /** Did a row land in `security_events`? */
  readonly written: boolean;
  /** Was it written under `anomaly.detected` because the enum lacked the real type? */
  readonly usedFallback: boolean;
  /** Which write path succeeded. Null when none did. */
  readonly scope: EvidenceScope | null;
  /** The type actually stored. */
  readonly storedAs: SecurityEventType | null;
  /** The type the caller asked for. */
  readonly intended: SecurityEventType;
};

const LOST: Omit<EvidenceOutcome, "intended"> = {
  written: false,
  usedFallback: false,
  scope: null,
  storedAs: null,
};

/**
 * One attempt, inside a tenant transaction.
 *
 * ⚠️ `recordSecurityEventTx` PROPAGATES its error by design — it is meant
 * to take a transaction down with it when the event and a mutation must
 * agree. Here there is no mutation to agree with, so the throw is caught
 * and turned into `false`. Letting it escape would convert an evidence
 * failure into a caller-visible exception, which is the one thing every
 * function in this chain exists to prevent.
 */
async function writeScoped(
  input: SecurityEventInput,
  tenantId: string,
): Promise<boolean> {
  try {
    const [{ withTenant }, { recordSecurityEventTx }] = await Promise.all([
      import("@/db"),
      import("@/server/security/record"),
    ]);

    await withTenant(tenantId, async (tx) => {
      await recordSecurityEventTx(tx, { ...input, tenantId });
    });
    return true;
  } catch {
    return false;
  }
}

/** One attempt, unscoped. `tenant_id` is forced NULL — see the header. */
async function writeUnscoped(input: SecurityEventInput): Promise<boolean> {
  try {
    const { recordSecurityEvent } = await import("@/server/security/record");
    return await recordSecurityEvent(
      {
        ...input,
        tenantId: null,
        detail: {
          ...(input.detail ?? {}),
          ...(input.tenantId ? { tenant_id: input.tenantId } : {}),
        },
      },
      { noCoalesce: true },
    );
  } catch {
    /*
     * `recordSecurityEvent` documents that it never throws. This catch is
     * here because "documents that it never throws" and "never throws" have
     * been different things in this repository before, and the cost of being
     * wrong here is that a fail-CLOSED gate turns into a 500 while it is
     * trying to explain itself.
     */
    return false;
  }
}

/** The same facts, retyped as the fallback the database certainly knows. */
function asFallback(input: SecurityEventInput): SecurityEventInput {
  return {
    ...input,
    type: EVIDENCE_FALLBACK_TYPE,
    /*
     * ⚠️ THE SEVERITY IS CARRIED ACROSS EXPLICITLY. `resolveSeverity()`
     * takes the HIGHER of the requested value and the type's default, so a
     * `critical` event demoted into the `warning`-default anomaly bucket
     * keeps its `critical`. Losing it here would be the quietest possible
     * way to turn a page-someone event into a weekly-review one.
     */
    severity: severityFor(input),
    detail: {
      ...(input.detail ?? {}),
      intended_type: input.type,
      fallback_reason:
        "security_event_type enum does not yet carry this value, or the first write failed",
    },
  };
}

/**
 * Write one piece of Track D evidence.
 *
 * Never throws. Returns what actually happened, and the caller is expected to
 * do something with a `written: false` — at minimum not to claim the event
 * was recorded.
 *
 * ⚠️ THE ORDER IS BEST-ATTRIBUTION-FIRST, NOT CHEAPEST-FIRST. A row with the
 * right `tenant_id` and the right `event_type` is the one a SIEM rule and a
 * customer-facing access log can both use; every step down from there loses
 * something a reviewer wanted, and each is taken only because the step above
 * it failed.
 */
export async function recordSecurityEvidence(
  input: SecurityEventInput,
): Promise<EvidenceOutcome> {
  const intended = input.type;
  const tenantId = input.tenantId ?? null;

  if (tenantId) {
    if (await writeScoped(input, tenantId)) {
      return { written: true, usedFallback: false, scope: "tenant", storedAs: intended, intended };
    }
    if (await writeScoped(asFallback(input), tenantId)) {
      return {
        written: true,
        usedFallback: true,
        scope: "tenant",
        storedAs: EVIDENCE_FALLBACK_TYPE,
        intended,
      };
    }
  }

  if (await writeUnscoped(input)) {
    return {
      written: true,
      usedFallback: false,
      scope: "unscoped",
      storedAs: intended,
      intended,
    };
  }

  if (await writeUnscoped(asFallback(input))) {
    return {
      written: true,
      usedFallback: true,
      scope: "unscoped",
      storedAs: EVIDENCE_FALLBACK_TYPE,
      intended,
    };
  }

  /*
   * Every path failed. There is nowhere left to write, so this is the last
   * line of the trail. It is deliberately one structured line rather than a
   * throw: the caller is a security control mid-refusal, and turning its
   * refusal into an exception replaces a legible "no" with a 500.
   */
  console.error("[TRACK D — EVIDENCE LOST]", {
    intended,
    source: input.source,
    tenantId,
    reason: input.reason ?? null,
  });

  return { ...LOST, intended };
}

function severityFor(input: SecurityEventInput): SecuritySeverity {
  if (input.severity) return input.severity;
  // Mirrors DEFAULT_SEVERITY without importing the map, so that a type added
  // here and forgotten there cannot silently become `info` in the fallback.
  switch (input.type) {
    case "security.evidence_write_failed":
      return "critical";
    case "billing.standing_unresolved":
    case "automation.event_dropped":
      return "warning";
    case "platform.scope_raised":
      return "info";
    default:
      return "warning";
  }
}

/**
 * ⭐ THE ONE FOR WHEN THE EVIDENCE ITSELF DID NOT PERSIST.
 *
 * Used by `lib/security/lockout.ts` when a lockout counter fails to write.
 * It is deliberately a separate function rather than a `type:` argument,
 * because it must never recurse: if THIS write fails, the outcome is a
 * stderr line and nothing more. A retry loop between two failing writers is
 * how an incident becomes an outage.
 */
export async function recordEvidenceWriteFailure(args: {
  readonly source: string;
  readonly what: string;
  readonly tenantId?: string | null;
  readonly subjectType?: string | null;
  readonly subjectId?: string | null;
  readonly error: unknown;
}): Promise<EvidenceOutcome> {
  const message =
    args.error instanceof Error ? args.error.message : String(args.error ?? "unknown");

  return recordSecurityEvidence({
    type: "security.evidence_write_failed",
    severity: "critical",
    source: args.source,
    tenantId: args.tenantId ?? null,
    subjectType: args.subjectType ?? null,
    subjectId: args.subjectId ?? null,
    reason: `${args.what} could not be persisted`,
    detail: { what: args.what, error: message.slice(0, 300) },
  });
}
