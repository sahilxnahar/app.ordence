import "server-only";

/**
 * Ordence — Audited Cross-Tenant Search
 * Version: v0.14.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * A SEARCH BOX THAT SPANS EVERY CUSTOMER IS A DATA-PROTECTION SURFACE
 * ══════════════════════════════════════════════════════════════════════
 * It is also the single most useful thing in a support console, which is
 * why it needs the most restraint. The line — platform records yes,
 * customer content never — is argued in full in
 * `lib/platform/search-scopes.ts`. This file is the enforcement, and it
 * enforces the line STRUCTURALLY rather than by policy:
 *
 *   • There is no query builder here. Each scope is a hand-written query
 *     over a hand-written column list. You cannot search a table that
 *     nobody wrote a function for, and adding one is a visible diff in
 *     this file rather than a parameter somebody passes.
 *
 *   • Every search writes its row BEFORE the results are returned. If the
 *     audit write fails, the search fails. That is the opposite of the
 *     rule everywhere else in this codebase — `writeAudit()` never throws
 *     precisely so an audit problem cannot break a user's work — and the
 *     inversion is deliberate: for a cross-tenant read, an unrecorded
 *     access is not an acceptable outcome. Better a support engineer sees
 *     an error than that we lose the record of what they looked at.
 *
 *   • Results are capped and NOT paginated. Fifty rows at a time,
 *     repeated, is the customer directory.
 *
 *   • Every search costs budget. Two hundred an hour is not a support
 *     pattern, it is a scrape.
 */

import { and, eq, or, ilike, isNull, sql, gte, desc } from "drizzle-orm";
import { withPlatformScope } from "@/db";
import { tenants, users } from "@/db/schema";
import { subscriptions, invoices } from "@/db/schema/billing";
import { documents } from "@/db/schema/storage";
import { platformActionLog } from "@/db/schema/platform";
import {
  SCOPE_DEFINITIONS,
  validateQuery,
  maskSearchTerm,
  MAX_RESULTS,
  SEARCH_BUDGET_PER_HOUR,
  type SearchScope,
} from "@/lib/platform/search-scopes";
import { platformSearchSchema, type PlatformResult } from "@/lib/platform/schemas";
import { requireCapability, type PlatformOperator } from "./guard";

/* ------------------------------------------------------------------ */
/* RESULT SHAPE                                                        */
/* ------------------------------------------------------------------ */

/**
 * One flat shape for every scope.
 *
 * ⚠️ NOTE WHAT IT CANNOT CARRY: there is no `content`, no `body`, no
 * `fields` bag. A result is an identifier, a tenant, a label made of
 * platform metadata and a few timestamps. The type is the second line of
 * defence after the queries themselves — a future contributor who wants
 * to return a contact's notes has to change this type first, in a diff
 * that says so.
 */
export type SearchResult = {
  scope: SearchScope;
  id: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  /** Short primary label. Platform metadata only. */
  label: string;
  /** Secondary line. Status, plan, dates — never customer content. */
  detail: string;
  occurredAt: string | null;
};

export type SearchOutcome = {
  results: SearchResult[];
  truncated: boolean;
  scopeNote: string;
  budgetRemaining: number;
};

/* ------------------------------------------------------------------ */
/* THE ENTRY POINT                                                     */
/* ------------------------------------------------------------------ */

export async function platformSearch(
  input: unknown,
): Promise<PlatformResult<SearchOutcome>> {
  const operator = await requireCapability("search:directory");

  const parsed = platformSearchSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the search form.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { scope, query, justification } = parsed.data;

  const verdict = validateQuery(query, scope);
  if (!verdict.ok) return { ok: false, error: verdict.error };

  /* ---- Budget ---------------------------------------------------- */
  const used = await countRecentSearches(operator.clerkUserId);
  if (used >= SEARCH_BUDGET_PER_HOUR) {
    // Refused AND recorded. A scrape that simply stops with no trace is
    // a scrape nobody investigates.
    await writeSearchRecord(operator, {
      scope,
      term: verdict.normalised,
      justification,
      resultCount: 0,
      refused: "budget_exhausted",
    });
    return {
      ok: false,
      error:
        `You have run ${used} cross-tenant searches in the last hour, which is the ` +
        `limit. This is recorded. If you genuinely need more, that is a conversation, ` +
        `not a retry.`,
    };
  }

  /* ---- The read -------------------------------------------------- */
  const results = await withPlatformScope(
    `Platform console: ${scope} search — ${justification.slice(0, 120)}`,
    async (db) => runScope(db, scope, verdict.normalised),
  );

  /* ---- Record BEFORE returning ----------------------------------- */
  //
  // ⚠️ THIS THROWS ON FAILURE, ON PURPOSE. See the header.
  await writeSearchRecord(operator, {
    scope,
    term: verdict.normalised,
    justification,
    resultCount: results.length,
    refused: null,
  });

  return {
    ok: true,
    data: {
      results,
      truncated: results.length >= MAX_RESULTS,
      scopeNote: SCOPE_DEFINITIONS[scope].returns,
      budgetRemaining: Math.max(0, SEARCH_BUDGET_PER_HOUR - used - 1),
    },
  };
}

/* ------------------------------------------------------------------ */
/* THE SCOPES — one hand-written query each                            */
/* ------------------------------------------------------------------ */

type Db = Parameters<Parameters<typeof withPlatformScope>[1]>[0];

async function runScope(
  db: Db,
  scope: SearchScope,
  term: string,
): Promise<SearchResult[]> {
  switch (scope) {
    case "tenants":
      return searchTenants(db, term);
    case "workspace_users":
      return searchWorkspaceUsers(db, term);
    case "invoices":
      return searchInvoices(db, term);
    case "subscriptions":
      return searchSubscriptions(db, term);
    case "documents_by_id":
      return searchDocumentById(db, term);
  }
}

async function searchTenants(db: Db, term: string): Promise<SearchResult[]> {
  const rows = await db
    .select({
      id: tenants.id,
      slug: tenants.slug,
      name: tenants.name,
      status: tenants.status,
      planTier: tenants.planTier,
      createdAt: tenants.createdAt,
    })
    .from(tenants)
    .where(
      and(
        isNull(tenants.deletedAt),
        or(
          // Prefix only. `%term%` on a tenant name is harmless in
          // isolation and a bad habit to normalise next to the same
          // pattern on an email column.
          ilike(tenants.name, `${term}%`),
          ilike(tenants.slug, `${term}%`),
          ilike(tenants.customDomain, `${term}%`),
        ),
      ),
    )
    .limit(MAX_RESULTS);

  return rows.map((r) => ({
    scope: "tenants" as const,
    id: r.id,
    tenantId: r.id,
    tenantSlug: r.slug,
    tenantName: r.name,
    label: r.name,
    detail: `${r.planTier} · ${r.status}`,
    occurredAt: r.createdAt.toISOString(),
  }));
}

/**
 * Find which workspace a person belongs to.
 *
 * This is the single most-used support query in any multi-tenant product
 * ("a customer emailed from priya@acme.com — where are they?") and it is
 * also the one that returns personal data, so it is the most constrained:
 * EXACT-PREFIX on the email only, never a substring, and never a name
 * search. A substring match on `users.email` turns the letter "a" into a
 * list of everybody we have.
 */
async function searchWorkspaceUsers(db: Db, term: string): Promise<SearchResult[]> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      role: users.role,
      status: users.status,
      lastSeenAt: users.lastSeenAt,
      tenantId: tenants.id,
      tenantSlug: tenants.slug,
      tenantName: tenants.name,
    })
    .from(users)
    .innerJoin(tenants, eq(tenants.id, users.tenantId))
    .where(and(isNull(users.deletedAt), ilike(users.email, `${term}%`)))
    .limit(MAX_RESULTS);

  return rows.map((r) => ({
    scope: "workspace_users" as const,
    id: r.id,
    tenantId: r.tenantId,
    tenantSlug: r.tenantSlug,
    tenantName: r.tenantName,
    label: r.email,
    detail: `${r.role} · ${r.status}`,
    occurredAt: r.lastSeenAt?.toISOString() ?? null,
  }));
}

/** Exact invoice number. A customer quoting one is the only use case. */
async function searchInvoices(db: Db, term: string): Promise<SearchResult[]> {
  const rows = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      status: invoices.status,
      totalMinor: invoices.totalMinor,
      currency: invoices.currency,
      issuedAt: invoices.issuedAt,
      tenantId: tenants.id,
      tenantSlug: tenants.slug,
      tenantName: tenants.name,
    })
    .from(invoices)
    .innerJoin(tenants, eq(tenants.id, invoices.tenantId))
    .where(eq(invoices.invoiceNumber, term))
    .limit(MAX_RESULTS);

  return rows.map((r) => ({
    scope: "invoices" as const,
    id: r.id,
    tenantId: r.tenantId,
    tenantSlug: r.tenantSlug,
    tenantName: r.tenantName,
    label: r.invoiceNumber,
    detail: `${r.status} · ${r.currency} ${(Number(r.totalMinor) / 100).toFixed(2)}`,
    occurredAt: r.issuedAt?.toISOString() ?? null,
  }));
}

/** Exact provider reference — what a payment provider's dashboard shows. */
async function searchSubscriptions(db: Db, term: string): Promise<SearchResult[]> {
  const rows = await db
    .select({
      id: subscriptions.id,
      providerSubscriptionId: subscriptions.providerSubscriptionId,
      providerCustomerId: subscriptions.providerCustomerId,
      status: subscriptions.status,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      tenantId: tenants.id,
      tenantSlug: tenants.slug,
      tenantName: tenants.name,
    })
    .from(subscriptions)
    .innerJoin(tenants, eq(tenants.id, subscriptions.tenantId))
    .where(
      or(
        eq(subscriptions.providerSubscriptionId, term),
        eq(subscriptions.providerCustomerId, term),
      ),
    )
    .limit(MAX_RESULTS);

  return rows.map((r) => ({
    scope: "subscriptions" as const,
    id: r.id,
    tenantId: r.tenantId,
    tenantSlug: r.tenantSlug,
    tenantName: r.tenantName,
    label: r.providerSubscriptionId ?? r.id,
    detail: r.status,
    occurredAt: r.currentPeriodEnd.toISOString(),
  }));
}

/**
 * ⭐ THE MOST CAREFULLY BOUNDED QUERY IN THE FILE.
 *
 * A customer writes "document 8f2c… will not download". To help, support
 * needs to know the row exists, whose it is, how big it is and whether it
 * was deleted. They do NOT need the filename — filenames are customer
 * content and are frequently the most sensitive field on the row
 * ("Redundancy list final.xlsx" tells you everything without opening it).
 *
 * So: exact id only, no filename, no mime type, no description. If the
 * exact id is unknown there is no way to browse toward it.
 */
async function searchDocumentById(db: Db, term: string): Promise<SearchResult[]> {
  if (!isUuid(term)) return [];

  const rows = await db
    .select({
      id: documents.id,
      sizeBytes: documents.sizeBytes,
      createdAt: documents.createdAt,
      deletedAt: documents.deletedAt,
      tenantId: tenants.id,
      tenantSlug: tenants.slug,
      tenantName: tenants.name,
    })
    .from(documents)
    .innerJoin(tenants, eq(tenants.id, documents.tenantId))
    .where(eq(documents.id, term))
    .limit(1);

  return rows.map((r) => ({
    scope: "documents_by_id" as const,
    id: r.id,
    tenantId: r.tenantId,
    tenantSlug: r.tenantSlug,
    tenantName: r.tenantName,
    // Deliberately the id, not the name.
    label: r.id,
    detail: `${Math.round(r.sizeBytes / 1024)} KB · ${
      r.deletedAt ? "deleted" : "present"
    }`,
    occurredAt: r.createdAt.toISOString(),
  }));
}

/* ------------------------------------------------------------------ */
/* THE RECORD                                                          */
/* ------------------------------------------------------------------ */

/**
 * Write the search into `platform_action_log`.
 *
 * ⚠️ THROWS ON FAILURE. Unlike every other audit path in this codebase.
 * The justification is narrow and specific: this is a cross-tenant read
 * of customer-adjacent data, and the only thing that makes it acceptable
 * is that it is recorded. An unrecorded one is not a degraded outcome, it
 * is the outcome the whole design exists to prevent.
 */
async function writeSearchRecord(
  operator: PlatformOperator,
  entry: {
    scope: SearchScope;
    term: string;
    justification: string;
    resultCount: number;
    refused: string | null;
  },
): Promise<void> {
  await withPlatformScope(
    "Platform console: record a cross-tenant search in the platform action log",
    async (db) => {
      await db.insert(platformActionLog).values({
        actorClerkId: operator.clerkUserId,
        actorEmail: operator.email,
        actorGrade: operator.grade,
        action: entry.refused ? "search_refused" : "search",
        resourceType: `search:${entry.scope}`,
        resourceId: null,
        justification: entry.justification,
        metadata: {
          scope: entry.scope,
          // ⚠️ MASKED. The full term is never persisted — see
          // `maskSearchTerm()` for why a verbatim search log is itself a
          // customer directory.
          termMasked: maskSearchTerm(entry.term),
          termLength: entry.term.length,
          returnsPersonalData: SCOPE_DEFINITIONS[entry.scope].containsPersonalData,
          refused: entry.refused,
        },
        resultCount: entry.resultCount,
        severity: entry.refused ? "warning" : "notice",
        ipAddress: operator.ipAddress,
        userAgent: operator.userAgent,
        requestId: operator.requestId,
      });
    },
  );
}

/** How many searches this operator has run in the last hour. */
async function countRecentSearches(clerkUserId: string): Promise<number> {
  const since = new Date(Date.now() - 3_600_000);
  return withPlatformScope(
    "Platform console: count recent cross-tenant searches for the per-operator budget",
    async (db) => {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(platformActionLog)
        .where(
          and(
            eq(platformActionLog.actorClerkId, clerkUserId),
            eq(platformActionLog.action, "search"),
            gte(platformActionLog.createdAt, since),
          ),
        );
      return row?.count ?? 0;
    },
  );
}

/* ------------------------------------------------------------------ */
/* THE OPERATOR'S OWN TRAIL                                            */
/* ------------------------------------------------------------------ */

/**
 * What has this operator been looking at?
 *
 * Shown in the console to the operator themselves, and to any `owner`
 * grade. Making your own access log visible to you is not a courtesy —
 * it is the cheapest way to make the logging real. A log nobody ever
 * reads is a log nobody notices is broken.
 */
export async function getRecentPlatformActions(
  limit = 50,
): Promise<PlatformResult<Array<{
  id: string;
  actorEmail: string;
  action: string;
  resourceType: string;
  justification: string;
  resultCount: number | null;
  createdAt: string;
}>>> {
  const operator = await requireCapability("search:directory");

  const rows = await withPlatformScope(
    "Platform console: show the cross-tenant access log to the operator",
    async (db) =>
      db
        .select()
        .from(platformActionLog)
        .where(
          operator.grade === "owner"
            ? sql`true`
            : eq(platformActionLog.actorClerkId, operator.clerkUserId),
        )
        .orderBy(desc(platformActionLog.createdAt))
        .limit(Math.min(Math.max(1, limit), 200)),
  );

  return {
    ok: true,
    data: rows.map((r) => ({
      id: r.id,
      actorEmail: r.actorEmail,
      action: r.action,
      resourceType: r.resourceType,
      justification: r.justification,
      resultCount: r.resultCount,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
