"use server";

/**
 * Ordence — Dashboard Analytics
 * Version: v0.10.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THESE READS GO THROUGH `withTenant()` AND NOT THE PLAIN CLIENT
 * ══════════════════════════════════════════════════════════════════════
 * Everywhere else in this codebase, reads use the shared `db` client with
 * an explicit `WHERE tenant_id = ...` predicate, and RLS is the second
 * layer underneath.
 *
 * That works because those queries name a table and a tenant column. An
 * AGGREGATE is different: `sum(amount)` over a view has no visible row to
 * inspect afterwards. If the tenant filter were wrong, the result is not a
 * wrong ROW you might notice — it is a wrong NUMBER that looks entirely
 * plausible. A dashboard showing ₹4.2 crore instead of ₹1.1 crore does not
 * announce itself.
 *
 * So aggregates run inside `withTenant()`, where `app.current_tenant_id` is
 * pinned for the transaction and the views' `security_invoker` setting
 * makes the caller's RLS apply to every underlying table. The explicit
 * `WHERE tenant_id` predicate is ALSO kept, as it is everywhere else. Two
 * independent layers, either sufficient alone.
 *
 * ══════════════════════════════════════════════════════════════════════
 * EVERY MONETARY VALUE CROSSES AS A STRING
 * ══════════════════════════════════════════════════════════════════════
 * PostgreSQL NUMERIC arrives as a string and stays one. It is converted to
 * a JavaScript number in exactly one place — the chart components, where a
 * pixel height is needed and a float is the only option a charting library
 * accepts.
 *
 * That conversion is a lossy boundary and it is drawn deliberately at the
 * point where the value stops being money and starts being geometry. Totals
 * displayed as text are formatted from the string, never from the float, so
 * what the user reads is exact even when what they see is approximate.
 */

import { z } from "zod";
import { and, eq, desc, gte, sql, isNull } from "drizzle-orm";
import { withTenant } from "@/db";
import {
  vAssetPortfolio,
  vLedgerDaily,
  vContractPipeline,
  auditLogs,
  users,
  complianceTasks,
  complianceLicences,
  demandNotices,
  tenantPatterns,
  notifications,
} from "@/db/schema";
import { requireTenantContext, TenantAccessError } from "@/server/tenant-context";
import type { ActionResult } from "@/lib/validators/crm";

function fail(error: string): ActionResult<never> {
  return { ok: false, error };
}

function toActionError(err: unknown): ActionResult<never> {
  if (err instanceof TenantAccessError) return fail(err.message);
  if (err instanceof z.ZodError) return fail("Validation failed.");
  console.error("[analytics]", err);
  return fail("Could not load the dashboard data.");
}

/* ------------------------------------------------------------------ */
/* ASSET PORTFOLIO                                                     */
/* ------------------------------------------------------------------ */

export type AssetPortfolioSlice = {
  status: string;
  assetCount: number;
  /** Decimal string. Never a float. */
  totalValue: string;
};

export type AssetPortfolioSummary = {
  slices: AssetPortfolioSlice[];
  totalAssets: number;
  totalValue: string;
  byType: Array<{ assetType: string; assetCount: number; totalValue: string }>;
};

export async function getAssetPortfolio(): Promise<ActionResult<AssetPortfolioSummary>> {
  try {
    const ctx = await requireTenantContext();

    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select()
        .from(vAssetPortfolio)
        .where(eq(vAssetPortfolio.tenantId, ctx.tenant.id)),
    );

    // Roll (type, status) rows up two ways. Done in TypeScript rather than
    // as two more views: the row count here is at most a few dozen, and a
    // second round trip would cost more than the loop.
    const byStatus = new Map<string, { count: number; value: bigint }>();
    const byType = new Map<string, { count: number; value: bigint }>();

    let totalAssets = 0;
    let totalPaise = 0n;

    for (const row of rows) {
      // Summed in BigInt paise, never in floating point. Adding a few
      // hundred rupee values as floats drifts, and a dashboard total that
      // disagrees with the ledger by ₹0.03 undermines confidence in both.
      const paise = decimalToPaise(row.totalValue);

      const s = byStatus.get(row.status) ?? { count: 0, value: 0n };
      s.count += row.assetCount;
      s.value += paise;
      byStatus.set(row.status, s);

      const t = byType.get(row.assetType) ?? { count: 0, value: 0n };
      t.count += row.assetCount;
      t.value += paise;
      byType.set(row.assetType, t);

      totalAssets += row.assetCount;
      totalPaise += paise;
    }

    return {
      ok: true,
      data: {
        slices: [...byStatus.entries()]
          .map(([status, v]) => ({
            status,
            assetCount: v.count,
            totalValue: paiseToDecimal(v.value),
          }))
          .sort((a, b) => b.assetCount - a.assetCount),
        byType: [...byType.entries()]
          .map(([assetType, v]) => ({
            assetType,
            assetCount: v.count,
            totalValue: paiseToDecimal(v.value),
          }))
          .sort((a, b) => b.assetCount - a.assetCount),
        totalAssets,
        totalValue: paiseToDecimal(totalPaise),
      },
    };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* LEDGER — 30 DAY TRAILING                                            */
/* ------------------------------------------------------------------ */

export type LedgerDayPoint = {
  day: string;
  debits: string;
  credits: string;
  netMovement: string;
  transactionCount: number;
};

export type LedgerTrailingSummary = {
  days: LedgerDayPoint[];
  totalDebits: string;
  totalCredits: string;
  /** True when the 30-day window balances. */
  isBalanced: boolean;
  difference: string;
  activeDays: number;
  transactionCount: number;
};

export async function getLedgerTrailing30(): Promise<ActionResult<LedgerTrailingSummary>> {
  try {
    const ctx = await requireTenantContext();

    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select()
        .from(vLedgerDaily)
        .where(eq(vLedgerDaily.tenantId, ctx.tenant.id))
        .orderBy(vLedgerDaily.day),
    );

    let debitPaise = 0n;
    let creditPaise = 0n;
    let activeDays = 0;
    let transactionCount = 0;

    const days: LedgerDayPoint[] = rows.map((row) => {
      const d = decimalToPaise(row.debits);
      const c = decimalToPaise(row.credits);

      debitPaise += d;
      creditPaise += c;
      if (row.transactionCount > 0) activeDays++;
      transactionCount += row.transactionCount;

      return {
        day: String(row.day),
        debits: row.debits,
        credits: row.credits,
        netMovement: row.netMovement,
        transactionCount: row.transactionCount,
      };
    });

    const diff = debitPaise - creditPaise;

    return {
      ok: true,
      data: {
        days,
        totalDebits: paiseToDecimal(debitPaise),
        totalCredits: paiseToDecimal(creditPaise),
        // Exact BigInt comparison. `Math.abs(a - b) < 0.01` on floats is
        // the usual shortcut and it hides a genuine one-paisa imbalance,
        // which is exactly the thing worth surfacing.
        isBalanced: diff === 0n,
        difference: paiseToDecimal(diff < 0n ? -diff : diff),
        activeDays,
        transactionCount,
      },
    };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* CONTRACT PIPELINE                                                   */
/* ------------------------------------------------------------------ */

export type ContractPipelineStage = {
  status: string;
  contractCount: number;
  totalValue: string;
};

export type ContractPipelineSummary = {
  stages: ContractPipelineStage[];
  totalContracts: number;
  totalValue: string;
  signedCount: number;
  onHoldCount: number;
  expiringSoonCount: number;
};

export async function getContractPipeline(): Promise<
  ActionResult<ContractPipelineSummary>
> {
  try {
    const ctx = await requireTenantContext();

    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select()
        .from(vContractPipeline)
        .where(eq(vContractPipeline.tenantId, ctx.tenant.id)),
    );

    let totalContracts = 0;
    let totalPaise = 0n;
    let signedCount = 0;
    let onHoldCount = 0;
    let expiringSoonCount = 0;

    const stages: ContractPipelineStage[] = rows.map((row) => {
      totalContracts += row.contractCount;
      totalPaise += decimalToPaise(row.totalValue);
      signedCount += row.signedCount;
      onHoldCount += row.onHoldCount;
      expiringSoonCount += row.expiringSoonCount;

      return {
        status: row.status,
        contractCount: row.contractCount,
        totalValue: row.totalValue,
      };
    });

    return {
      ok: true,
      data: {
        stages: stages.sort((a, b) => b.contractCount - a.contractCount),
        totalContracts,
        totalValue: paiseToDecimal(totalPaise),
        signedCount,
        onHoldCount,
        expiringSoonCount,
      },
    };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* RECENT ACTIVITY                                                     */
/* ------------------------------------------------------------------ */

export type ActivityItem = {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  severity: string;
  createdAt: string;
  actorName: string;
  actorEmail: string | null;
  /** True when the actor was an external portal visitor, not a team member. */
  isExternal: boolean;
  summary: string | null;
};

/**
 * The last 24 hours of audit activity.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE AUDIT LOG IS NOT PUBLIC INFORMATION
 * ══════════════════════════════════════════════════════════════════════
 * It records who did what, including permission denials and failed
 * attempts. Read together it is a map of a workspace's internal structure,
 * so it requires `audit:read` rather than being visible to anyone with a
 * dashboard.
 *
 * The `metadata` column is deliberately NOT returned wholesale. It can
 * contain recipient email addresses, token prefixes and previous field
 * values; a single derived sentence goes to the browser instead.
 */
export async function getRecentActivity(
  limit = 50,
): Promise<ActionResult<ActivityItem[]>> {
  const { requirePermission } = await import("@/server/audit");

  try {
    const ctx = await requirePermission("audit:read");
    const capped = Math.min(Math.max(1, limit), 200);

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select({
          id: auditLogs.id,
          action: auditLogs.action,
          resourceType: auditLogs.resourceType,
          resourceId: auditLogs.resourceId,
          severity: auditLogs.severity,
          createdAt: auditLogs.createdAt,
          actorEmail: auditLogs.actorEmail,
          actorRole: auditLogs.actorRole,
          actorFirstName: users.firstName,
          actorLastName: users.lastName,
          metadata: auditLogs.metadata,
        })
        .from(auditLogs)
        .leftJoin(
          users,
          and(eq(users.id, auditLogs.actorUserId), eq(users.tenantId, ctx.tenant.id)),
        )
        .where(
          and(eq(auditLogs.tenantId, ctx.tenant.id), gte(auditLogs.createdAt, since)),
        )
        .orderBy(desc(auditLogs.createdAt))
        .limit(capped),
    );

    return {
      ok: true,
      data: rows.map((row) => {
        const isExternal = row.actorRole === "external_portal";

        const name =
          [row.actorFirstName, row.actorLastName].filter(Boolean).join(" ").trim() ||
          row.actorEmail ||
          (isExternal ? "External client" : "System");

        return {
          id: row.id,
          action: row.action,
          resourceType: row.resourceType,
          resourceId: row.resourceId,
          severity: row.severity,
          createdAt: new Date(row.createdAt).toISOString(),
          actorName: name,
          actorEmail: row.actorEmail,
          isExternal,
          summary: summariseEvent(row.metadata as Record<string, unknown> | null),
        };
      }),
    };
  } catch (err) {
    return toActionError(err);
  }
}

/**
 * Turn a metadata blob into one safe sentence.
 *
 * Only the `event` key is read, and only known events produce text. A
 * pass-through of arbitrary metadata would put recipient addresses, token
 * prefixes and previous field values into the browser, which is precisely
 * what the column should not be used for on a shared dashboard.
 */
function summariseEvent(metadata: Record<string, unknown> | null): string | null {
  if (!metadata || typeof metadata !== "object") return null;

  const event = typeof metadata.event === "string" ? metadata.event : null;
  if (!event) return null;

  const KNOWN: Record<string, string> = {
    document_uploaded: "Uploaded a document",
    document_deleted: "Deleted a document",
    contract_sent_to_client: "Sent a contract to the client",
    contract_send_failed: "A contract email failed to send",
    contract_signed_externally: "A client signed a contract",
    portal_link_created: "Created a client portal link",
    portal_link_revoked: "Revoked a client portal link",
    portal_links_bulk_revoked: "Revoked all client links for a record",
    portal_first_opened: "A client opened a portal link",
    portal_document_downloaded: "A client downloaded a document",
    signature_attempted_on_view_only_link: "Blocked a signing attempt on a view-only link",
    role_changed: "Changed a team member's role",
    user_suspended: "Suspended a team member",
    user_reinstated: "Reinstated a team member",
    general_settings_updated: "Updated workspace settings",
    financial_settings_updated: "Updated financial settings",
  };

  return KNOWN[event] ?? null;
}

/* ------------------------------------------------------------------ */
/* EXACT DECIMAL ARITHMETIC                                            */
/* ------------------------------------------------------------------ */

/**
 * Decimal string → BigInt paise.
 *
 * Tolerant by design: this consumes database output, which may arrive as
 * "0", "1000", "1000.5" or "1000.50" depending on the aggregate. An
 * unparseable value becomes 0 rather than NaN — a dashboard that renders a
 * zero is recoverable, one that renders "NaN" across every tile is not.
 */
function decimalToPaise(value: string | null | undefined): bigint {
  if (!value) return 0n;

  const trimmed = String(value).trim();
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;

  if (!/^\d+(\.\d*)?$/.test(unsigned)) return 0n;

  const [whole = "0", fraction = ""] = unsigned.split(".");
  const paise = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));

  return negative ? -paise : paise;
}

/** BigInt paise → 2-decimal string. */
function paiseToDecimal(paise: bigint): string {
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  const whole = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}


/* ------------------------------------------------------------------ */
/* COMPLIANCE SUMMARY (v0.82.0-alpha)                                  */
/* ------------------------------------------------------------------ */

export type ComplianceSummary = {
  pendingCount: number;
  overdueCount: number;
  dueIn7Days: number;
  nextDeadline: string | null;
  expiringLicences: number;
};

export async function getComplianceSummary(): Promise<ActionResult<ComplianceSummary>> {
  try {
    const ctx = await requireTenantContext();
    const today = new Date().toISOString().slice(0, 10);
    const sevenAhead = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

    const result = await withTenant(ctx.tenant.id, async (tx) => {
      const pending = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(complianceTasks)
        .where(eq(complianceTasks.status, "pending"));

      const overdue = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(complianceTasks)
        .where(and(eq(complianceTasks.status, "pending"), sql`${complianceTasks.dueDate} < ${today}`));

      const dueSoon = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(complianceTasks)
        .where(and(
          eq(complianceTasks.status, "pending"),
          sql`${complianceTasks.dueDate} >= ${today}`,
          sql`${complianceTasks.dueDate} <= ${sevenAhead}`,
        ));

      const next = await tx
        .select({ dueDate: complianceTasks.dueDate, label: complianceTasks.periodLabel })
        .from(complianceTasks)
        .where(eq(complianceTasks.status, "pending"))
        .orderBy(sql`${complianceTasks.dueDate} ASC`)
        .limit(1);

      const expiring = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(complianceLicences)
        .where(and(
          sql`${complianceLicences.validUntil} IS NOT NULL`,
          sql`${complianceLicences.validUntil} <= ${sevenAhead}`,
        ));

      return {
        pendingCount: pending[0]?.count ?? 0,
        overdueCount: overdue[0]?.count ?? 0,
        dueIn7Days: dueSoon[0]?.count ?? 0,
        nextDeadline: next[0]?.dueDate ?? null,
        expiringLicences: expiring[0]?.count ?? 0,
      };
    });

    return { ok: true, data: result };
  } catch (err) {
    return toActionError(err);
  }
}


/* ------------------------------------------------------------------ */
/* RECEIVABLES SUMMARY (v0.82.0-alpha)                                 */
/* ------------------------------------------------------------------ */

export type ReceivablesSummary = {
  totalOverdue: number;
  totalOutstanding: number;
  overdueCount: number;
  oldestDays: number;
};

export async function getReceivablesSummary(): Promise<ActionResult<ReceivablesSummary>> {
  try {
    const ctx = await requireTenantContext();
    const today = new Date().toISOString().slice(0, 10);

    const result = await withTenant(ctx.tenant.id, async (tx) => {
      const overdue = await tx
        .select({
          count: sql<number>`count(*)::int`,
          total: sql<number>`coalesce(sum(${demandNotices.principalMinor}), 0)::float8`,
          oldestDays: sql<number>`coalesce(max(extract(epoch from (${today}::date - ${demandNotices.noticeDate}::date)) / 86400), 0)::int`,
        })
        .from(demandNotices)
        .where(and(
          sql`${demandNotices.principalMinor} > 0`,
          sql`coalesce(outstanding_minor, principal_minor) > 0`,
        ));

      const totalOutstanding = await tx
        .select({
          total: sql<number>`coalesce(sum(coalesce(outstanding_minor, principal_minor)), 0)::float8`,
        })
        .from(demandNotices)
        .where(sql`coalesce(outstanding_minor, principal_minor) > 0`);

      return {
        totalOverdue: Math.round(overdue[0]?.total ?? 0),
        totalOutstanding: Math.round(totalOutstanding[0]?.total ?? 0),
        overdueCount: overdue[0]?.count ?? 0,
        oldestDays: overdue[0]?.oldestDays ?? 0,
      };
    });

    return { ok: true, data: result };
  } catch (err) {
    return toActionError(err);
  }
}


/* ------------------------------------------------------------------ */
/* AI INSIGHTS SUMMARY (v0.82.0-alpha)                                 */
/* ------------------------------------------------------------------ */

export type AIInsight = {
  patternType: string;
  patternKey: string;
  summary: string;
  occurrenceCount: number;
  lastSeen: string;
};

export type AIInsightsSummary = {
  insights: AIInsight[];
  totalPatterns: number;
};

export async function getAIInsights(): Promise<ActionResult<AIInsightsSummary>> {
  try {
    const ctx = await requireTenantContext();

    const { getTenantPatterns } = await import("@/lib/ai/patterns");
    const patterns = await getTenantPatterns(ctx.tenant.id);

    const insights: AIInsight[] = patterns.slice(0, 6).map((p) => ({
      patternType: p.patternType,
      patternKey: p.patternKey,
      summary: (p.patternData as { summary?: string }).summary ?? p.patternType,
      occurrenceCount: p.occurrenceCount,
      lastSeen: p.lastSeen.toISOString(),
    }));

    return {
      ok: true,
      data: {
        insights,
        totalPatterns: patterns.length,
      },
    };
  } catch (err) {
    return toActionError(err);
  }
}


/* ------------------------------------------------------------------ */
/* NOTIFICATIONS SUMMARY (v0.82.0-alpha)                               */
/* ------------------------------------------------------------------ */

export type NotificationSummary = {
  unreadCount: number;
  recent: Array<{
    id: string;
    title: string;
    severity: string;
    category: string;
    actionUrl: string | null;
    createdAt: string;
  }>;
};

export async function getNotificationsSummary(): Promise<ActionResult<NotificationSummary>> {
  try {
    const ctx = await requireTenantContext();

    const result = await withTenant(ctx.tenant.id, async (tx) => {
      const recent = await tx
        .select({
          id: notifications.id,
          title: notifications.title,
          severity: notifications.severity,
          category: notifications.category,
          actionUrl: notifications.actionUrl,
          createdAt: notifications.createdAt,
        })
        .from(notifications)
        .where(and(
          eq(notifications.tenantId, ctx.tenant.id),
          isNull(notifications.dismissedAt),
        ))
        .orderBy(desc(notifications.createdAt))
        .limit(5);

      const unread = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(notifications)
        .where(and(
          eq(notifications.tenantId, ctx.tenant.id),
          isNull(notifications.readAt),
          isNull(notifications.dismissedAt),
        ));

      return {
        unreadCount: unread[0]?.count ?? 0,
        recent: recent.map((r) => ({
          id: r.id,
          title: r.title,
          severity: r.severity,
          category: r.category,
          actionUrl: r.actionUrl,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    });

    return { ok: true, data: result };
  } catch (err) {
    return toActionError(err);
  }
}
