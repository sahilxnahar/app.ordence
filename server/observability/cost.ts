import "server-only";

/**
 * Ordence — Per-tenant cost telemetry
 * Version: v1.82.0-alpha (Wave 14 · Track B)
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS IS THE SHORTEST PATH TO REVENUE IN THE OBSERVABILITY PLAN
 * ══════════════════════════════════════════════════════════════════════
 * Ordence bills on usage. Usage you cannot see is usage you cannot bill,
 * cannot cap, and cannot argue about when a customer disputes an invoice.
 * Three of the four dimensions below are already recorded by the product
 * and were, until this file, readable only one workspace at a time from
 * the billing page — so "which workspaces cost us the most" had no answer
 * and neither did "is anybody about to cost us a lot".
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WAVE 17 — THIS FILE'S FIRST VERSION READ NOTHING, ALWAYS
 * ══════════════════════════════════════════════════════════════════════
 * Wave 14 shipped this as a single platform-scoped query with full outer
 * joins over `usage_counters`, `usage_levels`, `ai_usage` and
 * `request_outcomes`. It was reviewed, it type-checked, and — measured
 * against a real PostgreSQL as a NOBYPASSRLS role, with rows in every
 * table — three of its four sources returned ZERO ROWS:
 *
 *     BEGIN; SELECT set_config('app.platform_scope','on',true);
 *       usage_counters   → 0   (5 rows exist)
 *       usage_levels     → 0   (2 rows exist)
 *       ai_usage         → 0   (1 row exists)
 *       request_outcomes → 2   (2 rows exist)
 *
 * All three refusing policies are `USING (tenant_id =
 * app_current_tenant_id())` with no platform branch. Under platform scope
 * `app_current_tenant_id()` is NULL, so the predicate is NULL, so no row
 * matches. **No error. No warning. A cost page of zeros that reads as a
 * quiet month.** It is the same shape Track D found in
 * `recordSecurityEvent()` and the same shape this whole track exists to
 * remove, committed by the track.
 *
 * ⚠️ AND THE OBVIOUS FIX IS FORBIDDEN, WHICH IS THE INTERESTING PART.
 * `usage_counters` and `usage_levels` are on `PLATFORM_READ_REFUSED` in
 * `scripts/check-rls-coverage.mjs`, refused by 0022 with the reason "one
 * query would read every customer's metered usage". Adding a platform
 * branch would reverse a recorded data-protection decision to make an
 * operator page convenient.
 *
 * ⭐ SO THE READ IS PER-TENANT, INSIDE EACH WORKSPACE'S OWN SCOPE. No
 * policy is changed, nothing is widened, and the numbers are real. The
 * cost is one transaction per workspace, which is why the page is capped
 * and says so rather than quietly truncating.
 *
 * ⚠️ AND WHERE A DIMENSION STILL CANNOT BE READ, IT IS `null` AND NOT `0`.
 * Zero is a measurement. "The policy does not permit this read" is not.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT IS NOT MEASURED, SAID OUT LOUD RATHER THAN APPROXIMATED
 * ══════════════════════════════════════════════════════════════════════
 * DATABASE TIME PER TENANT IS NOT RECORDED ANYWHERE IN THIS PRODUCT, and
 * this file does not invent it.
 *
 * The tempting approximation is `request_outcomes.duration_ms_sum`, which
 * IS measured — but that is wall-clock time for the whole request:
 * Clerk's round trip, the render, the network. Reporting it in a column
 * headed "database time" would produce a number that is plausible, wrong,
 * and impossible to notice is wrong, because nothing else measures the
 * same thing to disagree with it. On a Neon plan billed by compute-second
 * that number would eventually be used to decide something.
 *
 * So `databaseMs` is reported as `null` with a reason, and the request
 * time is reported under its own name. Measuring the real thing needs a
 * Drizzle query hook in `db/index.ts`, which Track B does not own — the
 * code is in PATCH-REQUEST-B.md.
 *
 * ⚠️ AND AI TOKENS ARE COUNTED, NOT PRICED. `ai_usage` records tokens by
 * provider and model; turning tokens into rupees needs a per-model price
 * list with a date on it, and a stale price list is a wrong invoice
 * rather than a missing one. Tokens are the fact; pricing is a decision
 * somebody has to own.
 */

/* ================================================================== */
/* TYPES                                                               */
/* ================================================================== */

/**
 * ⚠️ EVERY METERED FIGURE IS `number | null`, AND THE NULL IS LOAD-BEARING.
 * `0` means "measured, and it was zero". `null` means "this read did not
 * happen" — the workspace was outside the cap, or its per-tenant read
 * failed. Collapsing the two is how a cost page reports a quiet month for a
 * workspace nobody looked at.
 */
export type TenantCost = {
  tenantId: string;
  /** Cumulative counter, current billing period. */
  apiCalls: number | null;
  emailsSent: number | null;
  portalLinksCreated: number | null;
  /** Level, i.e. what is held right now — not a tally. */
  storageBytes: number | null;
  aiPromptTokens: number | null;
  aiCompletionTokens: number | null;
  aiTotalTokens: number | null;
  /** Wall clock inside our own process. NOT database time. See the header. */
  requestMs: number;
  requests: number;
  /** 🔴 Always null today. The reason is in `unmeasured` below. */
  databaseMs: number | null;
};

export type CostReport = {
  generatedAt: Date;
  windowDays: number;
  tenants: TenantCost[];
  /** Dimensions that could not be measured, each with the reason. Never silent. */
  unmeasured: { dimension: string; reason: string }[];
  /** True when nothing could be read at all. */
  degraded: boolean;
  /** How many workspaces exist, and how many were metered. Never silently capped. */
  coverage: { workspaces: number; metered: number; failed: number; cap: number };
};

type Row = Record<string, unknown>;
import type { withPlatformScope } from "@/db";

/**
 * The transaction handle type, derived from `withPlatformScope` rather
 * than named, so it cannot drift from the real one. Same trick as
 * `server/metering/record.ts`, `server/security/record.ts` and
 * `server/billing/audit-billing.ts`.
 *
 * ⚠️ `import type`, SO THERE IS NO RUNTIME IMPORT OF `@/db`. That matters
 * here for the reason `server/metering/record.ts` states about its own:
 * `db/index.ts` validates the environment while constructing its client,
 * so a value import would mean merely importing this module can throw —
 * and these modules are imported from the surfaces they must never break.
 */
type TxLike = Parameters<Parameters<typeof withPlatformScope>[1]>[0];

function rowsOf(result: unknown): Row[] {
  const r = (result as { rows?: Row[] })?.rows;
  if (Array.isArray(r)) return r;
  return Array.isArray(result) ? (result as Row[]) : [];
}

function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/* ================================================================== */
/* THE READ                                                            */
/* ================================================================== */

/**
 * Per-tenant usage across every dimension the product records.
 *
 * ⚠️ ONE PLATFORM-SCOPED TRANSACTION. `usage_counters` and `usage_levels`
 * are on `check-rls-coverage.mjs`'s PLATFORM_READ_REFUSED list for tenant
 * sessions, which is exactly right — a workspace must not read another
 * workspace's bill — and is why this is an operator screen and not a
 * customer one.
 */
export async function getCostReport(options?: {
  windowDays?: number;
  limit?: number;
}): Promise<CostReport> {
  const windowDays = Math.min(Math.max(Math.round(options?.windowDays ?? 30), 1), 90);
  /**
   * ⚠️ TEN BY DEFAULT, NOT TWENTY-FIVE. Each workspace costs one
   * transaction, and on a Neon Free plan the connection budget is the
   * tightest resource this deployment has. A page that opens fifty
   * transactions to render is a page that causes the incident it is being
   * opened to diagnose.
   */
  const cap = Math.min(Math.max(options?.limit ?? 10, 1), 50);
  const generatedAt = new Date();

  const unmeasured: { dimension: string; reason: string }[] = [
    {
      dimension: "database time per tenant",
      reason:
        "Nothing records it. `withTenant()` opens a transaction and returns; there is no " +
        "query hook and no timing. The available substitute — request wall-clock — is a " +
        "different quantity and is reported under its own name rather than relabelled. " +
        "PATCH-REQUEST-B.md carries the Drizzle logger that would measure it.",
    },
    {
      dimension: "storage bytes actually stored at the provider",
      reason:
        "`usage_levels.storage_bytes` is what the application believes it has stored, " +
        "reconciled from the documents table by reconcileStorageLevel(). It is not read " +
        "back from R2, so an orphaned object that no document row points at is invisible " +
        "here and is still on the bill.",
    },
  ];

  let workspaces = 0;
  let failed = 0;

  try {
    const { withPlatformScope, withTenant } = await import("@/db");
    const { sql } = await import("drizzle-orm");

    /* ================================================================ */
    /* PASS 1 — the workspace list and the figures RLS lets us see       */
    /* ================================================================ */
    /**
     * ⚠️ `tenants` AND `request_outcomes` ONLY. Both carry a platform read
     * branch by design — the first because every platform tool needs the
     * workspace list, the second because SQL 0133 was written for a
     * cross-tenant status surface. The three metered tables are NOT read
     * here; see the header.
     */
    const listed = await withPlatformScope(
      "observability cost telemetry: list workspaces and their request volume for the operator cost review",
      async (tx: TxLike) => {
        const total = rowsOf(
          await tx.execute(sql`SELECT count(*)::int AS n FROM tenants WHERE deleted_at IS NULL`),
        )[0];

        const rows = rowsOf(
          await tx.execute(sql`
            SELECT t.id AS tenant_id,
                   COALESCE(r.requests, 0)   AS requests,
                   COALESCE(r.request_ms, 0) AS request_ms
              FROM tenants t
              LEFT JOIN (
                SELECT tenant_id,
                       SUM(observations)    AS requests,
                       SUM(duration_ms_sum) AS request_ms
                  FROM request_outcomes
                 WHERE tenant_id IS NOT NULL
                   AND bucket_start >= now() - make_interval(days => ${windowDays})
                 GROUP BY tenant_id
              ) r ON r.tenant_id = t.id
             WHERE t.deleted_at IS NULL
             /*
               ⚠️ ORDERED BY REQUEST TIME, WHICH IS THE ONLY COST SIGNAL
               READABLE AT THIS POINT. Ordering by AI tokens — the dimension
               that actually runs away — is impossible before the per-tenant
               pass, so the list is re-sorted afterwards and the CAP is
               reported. A workspace outside the cap is not zero; it is
               unread, and the coverage figure says so.

               (Written without back-ticks on purpose: this comment lives
               inside a JS template literal, so a back-tick here ends the
               string and the rest of the query becomes code. It did,
               once.)
             */
             ORDER BY COALESCE(r.request_ms, 0) DESC, t.created_at DESC
             LIMIT ${cap}
          `),
        );

        return { total: num(total?.n), rows };
      },
    );

    workspaces = listed.total;

    /* ================================================================ */
    /* PASS 2 — the metered figures, one workspace at a time             */
    /* ================================================================ */
    /**
     * 🔴 `withTenant()`, NOT `withPlatformScope()`, AND THAT IS THE WHOLE
     * POINT OF THIS REWRITE. Inside a workspace's own scope the refusing
     * policies match, so the rows come back — without widening anything and
     * without a decision anybody has to review. It costs one transaction per
     * workspace, which is why `cap` exists and why `coverage` is reported.
     *
     * ⚠️ SEQUENTIAL, NOT `Promise.all`. Ten concurrent transactions on the
     * shared pool would spend ten of a very small connection budget at once,
     * on an operator page, during the incident it is being opened for.
     */
    const tenants: TenantCost[] = [];

    for (const row of listed.rows) {
      const tenantId = typeof row.tenant_id === "string" ? row.tenant_id : null;
      if (!tenantId) continue;

      const base: TenantCost = {
        tenantId,
        apiCalls: null,
        emailsSent: null,
        portalLinksCreated: null,
        storageBytes: null,
        aiPromptTokens: null,
        aiCompletionTokens: null,
        aiTotalTokens: null,
        requests: num(row.requests),
        requestMs: num(row.request_ms),
        databaseMs: null,
      };

      try {
        const metered = await withTenant(tenantId, async (tx) => {
          const r = await tx.execute(sql`
            WITH counters AS (
              SELECT COALESCE(SUM(value) FILTER (WHERE metric = 'api_calls'), 0)            AS api_calls,
                     COALESCE(SUM(value) FILTER (WHERE metric = 'emails_sent'), 0)          AS emails_sent,
                     COALESCE(SUM(value) FILTER (WHERE metric = 'portal_links_created'), 0) AS portal_links
                FROM usage_counters
               WHERE period_start >= now() - make_interval(days => ${windowDays})
            ),
            levels AS (
              SELECT COALESCE(MAX(current_value) FILTER (WHERE metric = 'storage_bytes'), 0) AS storage_bytes
                FROM usage_levels
            ),
            ai AS (
              SELECT COALESCE(SUM(prompt_tokens), 0)     AS prompt_tokens,
                     COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                     COALESCE(SUM(total_tokens), 0)      AS total_tokens
                FROM ai_usage
               WHERE occurred_at >= now() - make_interval(days => ${windowDays})
            )
            SELECT * FROM counters, levels, ai
          `);
          return rowsOf(r)[0] ?? null;
        });

        if (metered) {
          base.apiCalls = num(metered.api_calls);
          base.emailsSent = num(metered.emails_sent);
          base.portalLinksCreated = num(metered.portal_links);
          base.storageBytes = num(metered.storage_bytes);
          base.aiPromptTokens = num(metered.prompt_tokens);
          base.aiCompletionTokens = num(metered.completion_tokens);
          base.aiTotalTokens = num(metered.total_tokens);
        } else {
          failed++;
        }
      } catch {
        /*
         * ⚠️ ONE WORKSPACE'S READ FAILING MUST NOT EMPTY THE PAGE, and it
         * must not silently become zero either. The row stays, its metered
         * figures stay null, and `coverage.failed` counts it.
         */
        failed++;
      }

      tenants.push(base);
    }

    /**
     * ⚠️ SORTED HERE, NOT IN SQL. AI tokens are the one dimension with no
     * plan cap that can run away inside a single billing period, and they
     * are not readable until pass 2. A workspace whose read failed sorts
     * last rather than first: `null` is not a large number and must not be
     * treated as one.
     */
    tenants.sort((a, b) => (b.aiTotalTokens ?? -1) - (a.aiTotalTokens ?? -1));

    if (failed > 0) {
      unmeasured.push({
        dimension: `metered figures for ${failed} workspace(s)`,
        reason:
          "The per-tenant read failed for these workspaces. Their metered columns are null " +
          "rather than zero, so the page shows an absence rather than a quiet month.",
      });
    }

    if (workspaces > tenants.length) {
      unmeasured.push({
        dimension: `${workspaces - tenants.length} workspace(s) outside the cap`,
        reason:
          `Each workspace costs one transaction, so this page reads ${cap} of ${workspaces}, ` +
          "ordered by request time. The rest are unread, not free — raise the cap " +
          "deliberately rather than reading the total as complete.",
      });
    }

    /**
     * 🔴 A ZERO IN `apiCalls` FOR EVERY TENANT IS NOT A QUIET MONTH.
     * `recordApiCall` had no callers at all until wave 14, so every
     * historical row of that counter is absent rather than zero.
     */
    if (tenants.length > 0 && tenants.every((t) => t.apiCalls === 0)) {
      unmeasured.push({
        dimension: "api_calls before wave 14",
        reason:
          "Every workspace reports zero API calls. `recordApiCall()` existed from Phase 15 " +
          "with a plan limit and an overage rule and had NO CALLERS until wave 14, so a " +
          "zero here means 'never counted', not 'never called'. Counts become meaningful " +
          "only from the first deploy that wraps app/api/** handlers.",
      });
    }

    return {
      generatedAt,
      windowDays,
      tenants,
      unmeasured,
      degraded: false,
      coverage: { workspaces, metered: tenants.length - failed, failed, cap },
    };
  } catch {
    return {
      generatedAt,
      windowDays,
      tenants: [],
      unmeasured: [
        ...unmeasured,
        {
          dimension: "everything",
          reason:
            "The cost aggregate could not be read. Reported as unmeasured rather than as " +
            "an empty (i.e. free) month.",
        },
      ],
      degraded: true,
      coverage: { workspaces, metered: 0, failed, cap },
    };
  }
}
