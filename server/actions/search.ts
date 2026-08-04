"use server";

/**
 * Ordence — Tenant-Isolated Global Search
 * Version: v0.3.0-alpha
 *
 * THE ABSOLUTE REQUIREMENT:
 * Tenant filtering happens BEFORE any text matching. Not alongside it — before it.
 *
 * Each of the four sub-queries is built as:
 *     WHERE tenant_id = $sessionTenantId    ← hard filter, always first
 *       AND deleted_at IS NULL
 *       AND (<text match>)                  ← only then
 *
 * Because the tenant predicate is `AND`-ed at the top level and the text clause is
 * fully parenthesised, no crafted search string can widen the result set beyond
 * the caller's own tenant. Even an `OR 1=1` payload stays inside the parentheses
 * — and Drizzle parameterises it as a literal string anyway, so it is matched as
 * text, not executed.
 *
 * Row-Level Security is the second, independent layer underneath this.
 *
 * WHY ILIKE, NOT tsvector (for now):
 *   Postgres full-text search needs a `tsvector` column plus a GIN index per table
 *   and a trigger to keep them current. That is real storage — and Neon's free tier
 *   is 0.5 GB. At the scale a Hobby-tier deployment actually serves (thousands of
 *   rows, not millions), a trigram-free ILIKE with a leading tenant filter is fast
 *   because the tenant index already eliminates almost every row.
 *   The upgrade path is documented at the bottom of this file.
 */

import { z } from "zod";
import { and, eq, isNull, or, ilike, desc, sql } from "drizzle-orm";
import { db } from "@/db";
import { contacts, companies, deals, assets } from "@/db/schema";
import { requireTenantContext, TenantAccessError } from "@/server/tenant-context";
import { checkRateLimit, tenantRateLimitKey } from "@/lib/security/rate-limit";
import { recordRateLimitTrip } from "@/server/security/record";
import type { ActionResult } from "@/lib/validators/crm";

/* ------------------------------------------------------------------ */
/* VALIDATION                                                          */
/* ------------------------------------------------------------------ */

const searchInputSchema = z.object({
  /** The raw query. Length-capped to bound the cost of a single search. */
  query: z.string().trim().min(1, "Enter something to search for.").max(200),
  /** Which entity types to include. Omitted = all. */
  types: z
    .array(z.enum(["contact", "company", "deal", "asset"]))
    .optional()
    .default(["contact", "company", "deal", "asset"]),
  /** Results per entity type. */
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export type SearchResultType = "contact" | "company" | "deal" | "asset";

export type SearchResult = {
  id: string;
  type: SearchResultType;
  title: string;
  subtitle: string | null;
  /** Extra context line, e.g. status or amount. */
  meta: string | null;
  href: string;
  /** Higher wins. Exact prefix matches rank above substring matches. */
  score: number;
};

export type SearchResponse = {
  query: string;
  results: SearchResult[];
  counts: Record<SearchResultType, number>;
  tookMs: number;
};

/* ------------------------------------------------------------------ */
/* SEARCH                                                              */
/* ------------------------------------------------------------------ */

export async function globalSearch(
  input: z.input<typeof searchInputSchema>,
): Promise<ActionResult<SearchResponse>> {
  const startedAt = Date.now();

  try {
    // ── STEP 1: tenant identity, from the session. Never from the caller. ──
    const ctx = await requireTenantContext();

    /* Rate limit (SEC-005). Search fans out across every entity type
     * a tenant owns, so it is the most expensive read in the product
     * and the easiest to run in a loop. Keyed by tenant AND user so
     * one enthusiastic user cannot exhaust their colleagues' budget. */
    const searchLimit = await checkRateLimit(
      "search",
      tenantRateLimitKey(ctx.tenant.id, ctx.user.id),
    );
    if (!searchLimit.allowed) {
      await recordRateLimitTrip({
        policy: "search",
        source: "actions/search",
        tenantId: ctx.tenant.id,
        actorUserId: ctx.user.id,
        degraded: searchLimit.degraded,
      });
      // A signed-in user gets a message they can act on; the opacity
      // rule applies to ANONYMOUS callers, not to our own customers.
      return {
    ok: false as const,
    error: "You are searching very quickly. Please wait a moment and try again.",
  };
    }
    const tenantId = ctx.tenant.id;

    const params = searchInputSchema.parse(input);

    // Drizzle binds this as a parameter — it is data, never SQL.
    const pattern = `%${escapeLikePattern(params.query)}%`;
    const prefix = `${escapeLikePattern(params.query)}%`;

    const wanted = new Set(params.types);
    const results: SearchResult[] = [];
    const counts: Record<SearchResultType, number> = {
      contact: 0,
      company: 0,
      deal: 0,
      asset: 0,
    };

    /* ---- Build the four queries, each tenant-filtered first -------- */
    const queries: Array<Promise<void>> = [];

    if (wanted.has("contact")) {
      queries.push(
        db
          .select({
            id: contacts.id,
            firstName: contacts.firstName,
            lastName: contacts.lastName,
            email: contacts.email,
            jobTitle: contacts.jobTitle,
          })
          .from(contacts)
          .where(
            and(
              // ── TENANT HARD FILTER — first predicate, always present ──
              eq(contacts.tenantId, tenantId),
              isNull(contacts.deletedAt),
              // ── text match, fully parenthesised inside the AND ──
              or(
                ilike(contacts.firstName, pattern),
                ilike(contacts.lastName, pattern),
                ilike(contacts.email, pattern),
                ilike(contacts.jobTitle, pattern),
              ),
            ),
          )
          .orderBy(desc(contacts.updatedAt))
          .limit(params.limit)
          .then((rows) => {
            counts.contact = rows.length;
            for (const r of rows) {
              const name = [r.firstName, r.lastName].filter(Boolean).join(" ");
              results.push({
                id: r.id,
                type: "contact",
                title: name || r.email || "Untitled contact",
                subtitle: r.jobTitle ?? r.email,
                meta: null,
                href: `/contacts/${r.id}`,
                score: scoreMatch(name, params.query),
              });
            }
          }),
      );
    }

    if (wanted.has("company")) {
      queries.push(
        db
          .select({
            id: companies.id,
            name: companies.name,
            domain: companies.domain,
            industry: companies.industry,
          })
          .from(companies)
          .where(
            and(
              eq(companies.tenantId, tenantId),
              isNull(companies.deletedAt),
              or(
                ilike(companies.name, pattern),
                ilike(companies.domain, pattern),
                ilike(companies.industry, pattern),
              ),
            ),
          )
          .orderBy(desc(companies.updatedAt))
          .limit(params.limit)
          .then((rows) => {
            counts.company = rows.length;
            for (const r of rows) {
              results.push({
                id: r.id,
                type: "company",
                title: r.name,
                subtitle: r.domain,
                meta: r.industry,
                href: `/companies/${r.id}`,
                score: scoreMatch(r.name, params.query),
              });
            }
          }),
      );
    }

    if (wanted.has("deal")) {
      queries.push(
        db
          .select({
            id: deals.id,
            title: deals.title,
            stage: deals.stage,
            amount: deals.amount,
            currency: deals.currency,
          })
          .from(deals)
          .where(
            and(
              eq(deals.tenantId, tenantId),
              isNull(deals.deletedAt),
              or(ilike(deals.title, pattern), ilike(deals.description, pattern)),
            ),
          )
          .orderBy(desc(deals.updatedAt))
          .limit(params.limit)
          .then((rows) => {
            counts.deal = rows.length;
            for (const r of rows) {
              results.push({
                id: r.id,
                type: "deal",
                title: r.title,
                subtitle: r.stage,
                meta: r.amount ? `${r.currency} ${Number(r.amount).toLocaleString("en-IN")}` : null,
                href: `/deals/${r.id}`,
                score: scoreMatch(r.title, params.query),
              });
            }
          }),
      );
    }

    if (wanted.has("asset")) {
      queries.push(
        db
          .select({
            id: assets.id,
            name: assets.name,
            code: assets.code,
            assetType: assets.assetType,
            status: assets.status,
            locality: assets.locality,
            city: assets.city,
          })
          .from(assets)
          .where(
            and(
              eq(assets.tenantId, tenantId),
              isNull(assets.deletedAt),
              or(
                ilike(assets.name, pattern),
                ilike(assets.code, pattern),
                ilike(assets.description, pattern),
                ilike(assets.locality, pattern),
                ilike(assets.city, pattern),
              ),
            ),
          )
          .orderBy(desc(assets.updatedAt))
          .limit(params.limit)
          .then((rows) => {
            counts.asset = rows.length;
            for (const r of rows) {
              results.push({
                id: r.id,
                type: "asset",
                title: r.name,
                subtitle: r.code ?? r.assetType,
                meta: [r.locality, r.city].filter(Boolean).join(", ") || r.status,
                href: `/assets/${r.id}`,
                score: scoreMatch(r.name, params.query, r.code ?? undefined),
              });
            }
          }),
      );
    }

    // Bounded fan-out: at most 4 concurrent queries, well inside Hobby limits.
    await Promise.all(queries);

    results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

    // `prefix` is used by scoreMatch's semantics; referenced here to keep the
    // pattern pair explicit for future tsvector migration.
    void prefix;

    return {
      ok: true,
      data: {
        query: params.query,
        results,
        counts,
        tookMs: Date.now() - startedAt,
      },
    };
  } catch (err) {
    if (err instanceof TenantAccessError) {
      return { ok: false, error: err.message };
    }
    if (err instanceof z.ZodError) {
      return {
        ok: false,
        error: "Validation failed.",
        fieldErrors: err.flatten().fieldErrors as Record<string, string[]>,
      };
    }
    console.error("[globalSearch]", err);
    return { ok: false, error: "Search failed. Please try again." };
  }
}

/* ------------------------------------------------------------------ */
/* TYPE-SCOPED SEARCH (for pickers)                                    */
/* ------------------------------------------------------------------ */

const quickSearchSchema = z.object({
  query: z.string().trim().max(200).default(""),
  type: z.enum(["contact", "company", "deal", "asset"]),
  limit: z.coerce.number().int().min(1).max(25).default(10),
});

/** Narrow search used by combobox pickers. Same tenant-first guarantee. */
export async function quickSearch(
  input: z.input<typeof quickSearchSchema>,
): Promise<ActionResult<SearchResult[]>> {
  try {
    const params = quickSearchSchema.parse(input);
    const result = await globalSearch({
      query: params.query || "%",
      types: [params.type],
      limit: params.limit,
    });
    if (!result.ok) return result;
    return { ok: true, data: result.data.results };
  } catch (err) {
    if (err instanceof TenantAccessError) return { ok: false, error: err.message };
    console.error("[quickSearch]", err);
    return { ok: false, error: "Search failed." };
  }
}

/* ------------------------------------------------------------------ */
/* HELPERS                                                             */
/* ------------------------------------------------------------------ */

/**
 * Neutralise LIKE wildcards in user input.
 *
 * Without this, a query of `%` matches every row — not a security hole (the
 * tenant filter still holds) but it defeats the point of searching and makes the
 * query scan far more rows than intended.
 */
function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Rank a match. Exact > prefix > word-boundary > substring.
 * Deliberately simple and synchronous — ranking runs on at most 200 rows.
 */
function scoreMatch(haystack: string | null, needle: string, altHaystack?: string): number {
  const target = (haystack ?? "").toLowerCase();
  const alt = (altHaystack ?? "").toLowerCase();
  const q = needle.toLowerCase();

  if (!q) return 0;
  if (target === q || alt === q) return 100;
  if (target.startsWith(q) || alt.startsWith(q)) return 80;
  if (new RegExp(`\\b${escapeRegExp(q)}`).test(target)) return 60;
  if (target.includes(q) || alt.includes(q)) return 40;
  return 10;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ============================================================================
 * UPGRADE PATH — moving to PostgreSQL full-text search
 * ============================================================================
 * ILIKE is the right call on Neon's free tier. Move to tsvector when you exceed
 * roughly 100,000 rows per tenant, or when users start expecting stemming
 * ("building" matching "buildings").
 *
 * Run this migration when that day comes — the tenant-first predicate is
 * preserved exactly:
 *
 *   ALTER TABLE assets ADD COLUMN search_vector tsvector
 *     GENERATED ALWAYS AS (
 *       setweight(to_tsvector('english', coalesce(name, '')),        'A') ||
 *       setweight(to_tsvector('english', coalesce(code, '')),        'A') ||
 *       setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
 *       setweight(to_tsvector('english', coalesce(locality, '')),    'C')
 *     ) STORED;
 *
 *   -- Composite index keeps the tenant filter leading.
 *   CREATE INDEX assets_tenant_search_idx ON assets
 *     USING gin (tenant_id, search_vector);
 *
 * Then swap the `or(ilike(...))` block for:
 *
 *   and(
 *     eq(assets.tenantId, tenantId),           // still first
 *     isNull(assets.deletedAt),
 *     sql`${assets.searchVector} @@ plainto_tsquery('english', ${params.query})`
 *   )
 *
 * Storage cost is roughly 20–30% of the indexed text, which is why it waits
 * until the free tier is no longer the constraint.
 * ========================================================================== */
