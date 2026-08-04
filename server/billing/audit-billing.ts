/**
 * Ordence — Transaction-Aware Audit Writer for Billing
 * Version: v0.11.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY BILLING CANNOT USE `server/audit.ts`
 * ══════════════════════════════════════════════════════════════════════
 * The Phase 5 audit helper is built around `requireTenantContext()` — it
 * reads the Clerk session to learn who the actor is, and it writes on the
 * shared `db` client.
 *
 * Neither holds for a webhook. There is no session (the caller is
 * Razorpay), and the write MUST join the reconciliation transaction —
 * because an audit row that survives a rolled-back reconciliation is a
 * record of something that did not happen, which is worse than no record.
 *
 * So this is a narrow second writer that takes the transaction handle
 * explicitly and describes the actor as the system. It writes to the SAME
 * `audit_logs` table — deliberately. An audit trail split across two
 * tables cannot prove anything, because you would have to trust that both
 * were complete.
 */

import "server-only";

import { auditLogs } from "@/db/schema";
import type { withTenant } from "@/db";

type TransactionHandle = Parameters<Parameters<typeof withTenant>[1]>[0];

export type SystemAuditEntry = {
  tenantId: string;
  action:
    | "create"
    | "update"
    | "delete"
    | "config_change"
    | "security_event"
    | "export";
  resourceType: string;
  resourceId?: string | null;
  oldValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  reason?: string;
  severity?: "info" | "notice" | "warning" | "critical";
};

/**
 * Write an audit row inside an existing transaction, attributed to the
 * system rather than to a user.
 *
 * ⚠️ NEVER SWALLOWS ITS ERROR. If this throws, the surrounding
 * reconciliation transaction rolls back and the provider retries. That is
 * the correct behaviour and it is a deliberate departure from the usual
 * "audit failures must not break the request" rule: for a money movement,
 * an unrecorded change is not an acceptable outcome. Better to retry the
 * webhook than to alter a subscription with no trace of why.
 */
export async function recordSystemAudit(
  tx: TransactionHandle,
  entry: SystemAuditEntry,
): Promise<void> {
  await tx.insert(auditLogs).values({
    tenantId: entry.tenantId,

    // No human actor. Left explicitly null rather than filled with a
    // service-account uuid, so a reviewer can distinguish "the system did
    // this" from "someone used a shared account".
    actorUserId: null,
    actorClerkId: null,
    actorEmail: null,
    actorRole: "system",

    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId ?? null,
    oldValue: entry.oldValue ?? null,
    newValue: entry.newValue ?? null,

    metadata: {
      ...(entry.metadata ?? {}),
      source: "billing_webhook",
    },

    reason: entry.reason ?? null,
    severity: entry.severity ?? "info",
  });
}

/**
 * Attribute a billing change to a real user (self-serve upgrade, a
 * manual payment recorded by finance) inside a transaction.
 *
 * Separate from `recordSystemAudit` so the two cannot be confused at a
 * call site. "The system renewed this" and "Priya changed this plan" are
 * different claims and must not share a code path where an omitted
 * argument silently turns one into the other.
 */
export async function recordUserBillingAudit(
  tx: TransactionHandle,
  entry: SystemAuditEntry & {
    actorUserId: string;
    actorClerkId: string | null;
    actorEmail: string | null;
    actorRole: string;
  },
): Promise<void> {
  await tx.insert(auditLogs).values({
    tenantId: entry.tenantId,
    actorUserId: entry.actorUserId,
    actorClerkId: entry.actorClerkId,
    actorEmail: entry.actorEmail,
    actorRole: entry.actorRole,

    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId ?? null,
    oldValue: entry.oldValue ?? null,
    newValue: entry.newValue ?? null,

    metadata: {
      ...(entry.metadata ?? {}),
      source: "billing_action",
    },

    reason: entry.reason ?? null,
    severity: entry.severity ?? "info",
  });
}
