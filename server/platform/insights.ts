import "server-only";

/**
 * Ordence — Tenant Insights For The Support Console
 * Version: v0.29.0-alpha (Phase 29)
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE FOUR PANELS A SUPPORT CALL ACTUALLY NEEDS, AND WHERE EACH IS READ
 * ══════════════════════════════════════════════════════════════════════
 * "Why is my bill higher this month?", "did somebody try to break into
 * our account?", "when did we last actually use this?" — three questions
 * that arrive on every other ticket and that, before this file existed,
 * could only be answered with a database console. That is the whole
 * justification for Phase 29: a support tool that cannot answer them is
 * a support tool people route around.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ READ THIS BEFORE ADDING A PANEL. IT IS THE RULE THAT KEEPS THE LINE.
 * ══════════════════════════════════════════════════════════════════════
 * `withPlatformScope()` is DELIBERATELY NARROW. Section 6 of
 * `0014_phase17_platform.sql` grants the platform marker on exactly five
 * tenant-scoped tables — `tenants`, `users`, `subscriptions`, `invoices`,
 * `documents` — plus the five platform tables. Nothing in this file
 * widens that, and nothing in a future phase should either: Check 14 of
 * that file fails loudly if a customer-content table ever acquires the
 * clause.
 *
 * So the panels below are read in one of TWO ways, and which one is not
 * a matter of convenience:
 *
 *   A. UNDER `withPlatformScope()` — invoices and consent records. Both
 *      are inside the granted set. Both are data we are the CONTROLLER
 *      of: we issued the invoice, and the consent row is a statement made
 *      to us.
 *
 *   B. UNDER `withTenant()`, IN THE CUSTOMER'S OWN RLS CONTEXT — usage
 *      counters, security events and the platform's own audit trail for
 *      this tenant. These tables are NOT in the platform read scope and
 *      are not being added to it; the read happens inside the tenant's
 *      own policy, exactly as `readPreviousStatus()` in `tenants.ts`
 *      already reads `audit_logs`.
 *
 * ⭐ AND THE THIRD CATEGORY, WHICH THIS FILE REFUSES TO READ AT ALL:
 * customer CONTENT — contacts, companies, deals, documents by name,
 * contract text, journal narrations. There is no query for it here, the
 * result types cannot carry it, and the database would refuse it anyway.
 * If a screen genuinely needs a customer's record, the answer is an
 * impersonation session: consented, expiring, bannered and audited. That
 * is not a workaround for the missing panel, it IS the design.
 *
 * ⚠️ WHY SECURITY EVENTS ARE COLUMN-SELECTED RATHER THAN `SELECT *`
 * `security_events.detail` is a free JSONB bag written by a dozen call
 * sites. Today it holds rate-limit policies and IP prefixes; nothing
 * stops a future call site putting a request body in it. A support
 * console that renders it would silently become a viewer for whatever
 * anybody ever decides to log. So the query lists its columns, and
 * `detail` is not among them.
 */

import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { withPlatformScope, withTenant } from "@/db";
import { auditLogs, users } from "@/db/schema";
import { invoices } from "@/db/schema/billing";
import { usageCounters, usageLevels } from "@/db/schema/metering";
import { securityEvents } from "@/db/schema/secops";
import { tenantSupportConsents } from "@/db/schema/platform";
import type { PlatformResult } from "@/lib/platform/schemas";
import { requireCapability, recordPlatformAudit } from "./guard";

/* ------------------------------------------------------------------ */
/* SHAPES — none of these can carry customer content                   */
/* ------------------------------------------------------------------ */

export type UsagePoint = {
  metric: string;
  periodStart: string;
  periodEnd: string;
  /** Minor-unit-free counter. A string because it is a Postgres bigint. */
  value: string;
};

export type UsageLevelRow = {
  metric: string;
  currentValue: string;
  peakValue: string;
  lastEventAt: string;
  lastReconciledAt: string | null;
};

export type InvoiceRow = {
  id: string;
  number: string;
  status: string;
  currency: string;
  totalMinor: string;
  amountPaidMinor: string;
  periodStart: string | null;
  periodEnd: string | null;
  issuedAt: string | null;
  dueAt: string | null;
  paidAt: string | null;
};

export type SecurityEventRow = {
  id: string;
  eventType: string;
  severity: string;
  source: string;
  route: string | null;
  /** The /24 or /48, never the full address. */
  ipPrefix: string | null;
  occurrenceCount: number;
  reason: string | null;
  occurredAt: string;
};

/**
 * A person inside the customer's workspace.
 *
 * ⚠️ IDENTITY AND ROLE, NOTHING THEY DID. "Which of our people has admin?"
 * is a question a customer expects us to be able to answer — we created
 * these rows to provision the workspace and we are the controller of
 * them. What they wrote is a different category entirely and is not here.
 */
export type TenantUserRow = {
  id: string;
  email: string;
  fullName: string | null;
  role: string;
  status: string;
  lastSeenAt: string | null;
  /** Our own staff sitting in the workspace; does not consume a paid seat. */
  isPlatformStaff: boolean;
};

export type ConsentRow = {
  id: string;
  mode: string;
  scope: string;
  grantedByEmail: string | null;
  grantedByRole: string | null;
  grantedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  reference: string | null;
  live: boolean;
};

export type PlatformActivityRow = {
  id: string;
  actorEmail: string | null;
  actorRole: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  reason: string | null;
  severity: string;
  /** Set when the action was taken from inside an impersonation session. */
  impersonationId: string | null;
  createdAt: string;
};

export type TenantInsights = {
  usage: UsagePoint[];
  levels: UsageLevelRow[];
  invoices: InvoiceRow[];
  users: TenantUserRow[];
  securityEvents: SecurityEventRow[];
  consents: ConsentRow[];
  activity: PlatformActivityRow[];
  /**
   * True when a panel could not be read. Shown to the operator rather
   * than swallowed: an empty security panel that means "there was an
   * error" and an empty one that means "nothing happened" are opposite
   * answers, and a console that cannot tell them apart is a console that
   * gets used to say "no, nothing happened".
   */
  degraded: string[];
};

/* ------------------------------------------------------------------ */
/* HOW FAR BACK                                                        */
/* ------------------------------------------------------------------ */

/** Six billing periods is enough to see a trend and not enough to be a report. */
const USAGE_PERIODS = 6;
const SECURITY_EVENT_DAYS = 30;
const MAX_ROWS = 50;

/* ------------------------------------------------------------------ */
/* THE ENTRY POINT                                                     */
/* ------------------------------------------------------------------ */

/**
 * Everything the tenant detail page shows below the fold.
 *
 * ⚠️ AUDITED, AND THE ROW GOES TO THE CUSTOMER. Opening a workspace is
 * already recorded by `getTenantDetail()`; this is a second, deeper read
 * — a customer's payment history and their security event stream — and
 * it gets its own row saying so. Everything we do to a tenant should be
 * something they can see us doing.
 *
 * ⚠️ EACH PANEL FAILS INDEPENDENTLY. One unreachable table must not blank
 * the whole page during the incident when somebody needs it; the failure
 * is reported in `degraded` instead of thrown.
 */
export async function getTenantInsights(
  tenantId: string,
): Promise<PlatformResult<TenantInsights>> {
  const operator = await requireCapability("tenants:read");
  const now = new Date();
  const degraded: string[] = [];

  const [billing, tenantSide] = await Promise.all([
    readBillingAndConsent(tenantId, now).catch((err) => {
      console.error("[platform] insights: billing/consent read failed", err);
      degraded.push("billing");
      return {
        invoices: [] as InvoiceRow[],
        consents: [] as ConsentRow[],
        users: [] as TenantUserRow[],
      };
    }),
    readTenantSide(tenantId, now).catch((err) => {
      console.error("[platform] insights: tenant-context read failed", err);
      degraded.push("usage-and-security");
      return {
        usage: [] as UsagePoint[],
        levels: [] as UsageLevelRow[],
        securityEvents: [] as SecurityEventRow[],
        activity: [] as PlatformActivityRow[],
      };
    }),
  ]);

  await recordPlatformAudit({
    operator,
    tenantId,
    action: "read",
    resourceType: "tenant_insights",
    resourceId: tenantId,
    severity: "notice",
    reason:
      "Platform staff read this workspace's usage history, invoices, people and " +
      "security events in the support console.",
    metadata: {
      panels: [
        "usage",
        "invoices",
        "people",
        "security_events",
        "consents",
        "platform_activity",
      ],
      degraded,
    },
  });

  return {
    ok: true,
    data: {
      ...billing,
      ...tenantSide,
      degraded,
    },
  };
}

/* ------------------------------------------------------------------ */
/* A. UNDER THE PLATFORM SCOPE                                         */
/* ------------------------------------------------------------------ */

async function readBillingAndConsent(
  tenantId: string,
  now: Date,
): Promise<{ invoices: InvoiceRow[]; consents: ConsentRow[]; users: TenantUserRow[] }> {
  return withPlatformScope(
    `Platform console: read invoices, workspace people and support-consent history for tenant ${tenantId}`,
    async (db) => {
      const invoiceRows = await db
        .select({
          id: invoices.id,
          number: invoices.invoiceNumber,
          status: invoices.status,
          currency: invoices.currency,
          totalMinor: invoices.totalMinor,
          amountPaidMinor: invoices.amountPaidMinor,
          periodStart: invoices.periodStart,
          periodEnd: invoices.periodEnd,
          issuedAt: invoices.issuedAt,
          dueAt: invoices.dueAt,
          paidAt: invoices.paidAt,
        })
        .from(invoices)
        .where(eq(invoices.tenantId, tenantId))
        .orderBy(desc(invoices.createdAt))
        .limit(24);

      // ⚠️ READ ONLY, AND STRUCTURALLY SO. The platform connection can
      // SELECT this table and the RLS `WITH CHECK` refuses it an INSERT
      // — consent we could write ourselves would not be consent. See
      // Check 3 of 0014.
      const consentRows = await db
        .select()
        .from(tenantSupportConsents)
        .where(eq(tenantSupportConsents.tenantId, tenantId))
        .orderBy(desc(tenantSupportConsents.grantedAt))
        .limit(MAX_ROWS);

      // The workspace's people. `users` carries the platform READ clause
      // and no platform WRITE clause, so this can be listed and can never
      // be edited from here — role and status outlive any support call.
      const userRows = await db
        .select({
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          role: users.role,
          status: users.status,
          lastSeenAt: users.lastSeenAt,
        })
        .from(users)
        .where(and(eq(users.tenantId, tenantId), isNull(users.deletedAt)))
        .orderBy(users.email)
        .limit(200);

      return {
        users: userRows.map((u) => ({
          id: u.id,
          email: u.email,
          fullName:
            [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || null,
          role: u.role,
          status: u.status,
          lastSeenAt: u.lastSeenAt?.toISOString() ?? null,
          isPlatformStaff: u.role === "platform_super_admin",
        })),
        invoices: invoiceRows.map((i) => ({
          id: i.id,
          number: i.number,
          status: i.status,
          currency: i.currency,
          totalMinor: i.totalMinor.toString(),
          amountPaidMinor: i.amountPaidMinor.toString(),
          periodStart: i.periodStart?.toISOString() ?? null,
          periodEnd: i.periodEnd?.toISOString() ?? null,
          issuedAt: i.issuedAt?.toISOString() ?? null,
          dueAt: i.dueAt?.toISOString() ?? null,
          paidAt: i.paidAt?.toISOString() ?? null,
        })),
        consents: consentRows.map((c) => ({
          id: c.id,
          mode: c.mode,
          scope: c.scope,
          grantedByEmail: c.grantedByEmail,
          grantedByRole: c.grantedByRole,
          grantedAt: c.grantedAt.toISOString(),
          expiresAt: c.expiresAt.toISOString(),
          revokedAt: c.revokedAt?.toISOString() ?? null,
          reference: c.reference,
          // Liveness is the CLOCK plus the revocation, computed here and
          // never trusted from a cached flag — the same rule as session
          // liveness, for the same reason.
          live: c.revokedAt === null && c.expiresAt.getTime() > now.getTime(),
        })),
      };
    },
  );
}

/* ------------------------------------------------------------------ */
/* B. IN THE CUSTOMER'S OWN RLS CONTEXT                                */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THIS IS NOT A WAY AROUND THE NARROW PLATFORM SCOPE, AND THE
 * DIFFERENCE MATTERS.
 *
 * `withTenant()` pins ONE tenant id for the transaction. Every policy is
 * then a plain equality against that id, so this read can see exactly one
 * workspace — the one the operator deliberately opened, whose id is in
 * the URL and in the audit row written above. It cannot span tenants, it
 * cannot be widened by a bug in a WHERE clause, and it grants nothing
 * that a `SELECT` in the customer's own product would not.
 *
 * The alternative — adding `usage_counters`, `security_events` and
 * `audit_logs` to the platform marker in Section 6 — would let a single
 * query read all three across EVERY customer at once. That is a strictly
 * larger capability for the same feature, so it is refused.
 */
async function readTenantSide(
  tenantId: string,
  now: Date,
): Promise<{
  usage: UsagePoint[];
  levels: UsageLevelRow[];
  securityEvents: SecurityEventRow[];
  activity: PlatformActivityRow[];
}> {
  const since = new Date(now.getTime() - SECURITY_EVENT_DAYS * 86_400_000);

  return withTenant(tenantId, async (tx) => {
    const counters = await tx
      .select({
        metric: usageCounters.metric,
        periodStart: usageCounters.periodStart,
        periodEnd: usageCounters.periodEnd,
        value: usageCounters.value,
      })
      .from(usageCounters)
      .where(eq(usageCounters.tenantId, tenantId))
      .orderBy(desc(usageCounters.periodStart))
      // Four metrics × six periods. Bounded so a tenant with years of
      // history cannot turn a page render into a report.
      .limit(USAGE_PERIODS * 4);

    const levelRows = await tx
      .select({
        metric: usageLevels.metric,
        currentValue: usageLevels.currentValue,
        peakValue: usageLevels.peakValue,
        lastEventAt: usageLevels.lastEventAt,
        lastReconciledAt: usageLevels.lastReconciledAt,
      })
      .from(usageLevels)
      .where(eq(usageLevels.tenantId, tenantId));

    // Column list, not `select()`. See the header: `detail` is a free
    // JSONB bag and this console is not a viewer for it.
    const events = await tx
      .select({
        id: securityEvents.id,
        eventType: securityEvents.eventType,
        severity: securityEvents.severity,
        source: securityEvents.source,
        route: securityEvents.route,
        ipPrefix: securityEvents.ipPrefix,
        occurrenceCount: securityEvents.occurrenceCount,
        reason: securityEvents.reason,
        occurredAt: securityEvents.occurredAt,
      })
      .from(securityEvents)
      .where(
        and(eq(securityEvents.tenantId, tenantId), gte(securityEvents.occurredAt, since)),
      )
      .orderBy(desc(securityEvents.occurredAt))
      .limit(MAX_ROWS);

    /**
     * ⭐ WHAT THE PLATFORM HAS DONE TO THIS CUSTOMER, READ FROM THE
     * CUSTOMER'S OWN LOG.
     *
     * These rows are written by `recordPlatformAudit()` with the tenant's
     * id, precisely so the customer can see them too. Reading them back
     * from the same place the customer reads them is the point: there is
     * no private copy, and no way for the console's version of events to
     * differ from theirs.
     */
    const activity = await tx
      .select({
        id: auditLogs.id,
        actorEmail: auditLogs.actorEmail,
        actorRole: auditLogs.actorRole,
        action: auditLogs.action,
        resourceType: auditLogs.resourceType,
        resourceId: auditLogs.resourceId,
        reason: auditLogs.reason,
        severity: auditLogs.severity,
        impersonationId: auditLogs.impersonationId,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.tenantId, tenantId),
          sql`${auditLogs.metadata} ->> 'source' = 'platform_console'`,
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(MAX_ROWS);

    return {
      usage: counters.map((c) => ({
        metric: c.metric,
        periodStart: c.periodStart.toISOString(),
        periodEnd: c.periodEnd.toISOString(),
        value: c.value.toString(),
      })),
      levels: levelRows.map((l) => ({
        metric: l.metric,
        currentValue: l.currentValue.toString(),
        peakValue: l.peakValue.toString(),
        lastEventAt: l.lastEventAt.toISOString(),
        lastReconciledAt: l.lastReconciledAt?.toISOString() ?? null,
      })),
      securityEvents: events.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        severity: e.severity,
        source: e.source,
        route: e.route,
        ipPrefix: e.ipPrefix,
        occurrenceCount: e.occurrenceCount,
        reason: e.reason,
        occurredAt: e.occurredAt.toISOString(),
      })),
      activity: activity.map((a) => ({
        id: a.id,
        actorEmail: a.actorEmail,
        actorRole: a.actorRole,
        action: a.action,
        resourceType: a.resourceType,
        resourceId: a.resourceId,
        reason: a.reason,
        severity: a.severity,
        impersonationId: a.impersonationId,
        createdAt: a.createdAt.toISOString(),
      })),
    };
  });
}
