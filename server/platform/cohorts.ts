import "server-only";

/**
 * Ordence — ⭐⭐ JOIN-MONTH COHORTS, READ ACROSS EVERY WORKSPACE
 * Version: v1.52.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `import "server-only"` AND NOT `"use server"`
 * ══════════════════════════════════════════════════════════════════════
 * Nothing in here is a form action. `"use server"` would publish every
 * export as a network-reachable endpoint and put a capability guard one
 * hop from each of them for no benefit — this module is called by a
 * server component during render. `server-only` is the narrower and
 * therefore correct marker, matching `server/platform/onboarding.ts`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THE GROUPING IS NOT `GROUP BY date_trunc('month', created_at)`
 * ══════════════════════════════════════════════════════════════════════
 * Three reasons, in order of how much they cost when ignored:
 *
 *   1. "Completed onboarding" would have to be re-expressed in SQL, and
 *      that is the second definition `lib/platform/cohorts.ts` exists to
 *      refuse. Here the rows come back raw and ONE TypeScript predicate —
 *      `hasCompletedOnboarding` from batch 122 — decides.
 *   2. `date_trunc` in UTC cuts the month five and a half hours early for
 *      every Indian customer. The IST boundary lives in `cohortKey()`.
 *   3. The whole table is a few hundred rows of counters. This is not a
 *      volume problem; it is a correctness problem wearing one.
 *
 * ⚠️ RLS: this crosses every tenant boundary on purpose and therefore
 * goes through `withPlatformScope()` with a written reason, exactly like
 * `onboarding.ts`. Nothing here touches a customer-content table.
 */

import { isNull } from "drizzle-orm";
import { withPlatformScope } from "@/db";
import { tenants } from "@/db/schema";
import { buildCohorts, type CohortMember, type CohortRow } from "@/lib/platform/cohorts";
import type { PlatformResult } from "@/lib/platform/schemas";
import { requireCapability } from "./guard";

/**
 * ⚠️ A CEILING, AND IT IS REPORTED WHEN IT BITES. A cohort report built
 * from a silently truncated read is a report that says onboarding
 * improved when all that happened is that the oldest months fell off the
 * end. `truncated` reaches the screen.
 */
const LIMIT = 20_000;

export type CohortReport = {
  rows: CohortRow[];
  /** The denominator behind the whole table, not just one row. */
  totalWorkspaces: number;
  truncated: boolean;
  asOf: string;
};

export async function listWorkspaceCohorts(): Promise<PlatformResult<CohortReport>> {
  await requireCapability("tenants:list");

  return withPlatformScope(
    "Platform console: group every workspace by the month it was created and count how many " +
      "finished onboarding, how many are still active, and how long activation took.",
    async (db) => {
      const rows = await db
        .select({
          id: tenants.id,
          createdAt: tenants.createdAt,
          status: tenants.status,
          settings: tenants.settings,
        })
        .from(tenants)
        /*
         * ⚠️ DELETED WORKSPACES ARE EXCLUDED; ARCHIVED AND SUSPENDED ONES
         * ARE NOT. A cohort is "who joined in March" — a customer who
         * joined and later churned is the most important member of it,
         * and dropping them would make every old month look perfect.
         * Only a soft-deleted row, which no longer represents a customer
         * at all, leaves the denominator.
         */
        .where(isNull(tenants.deletedAt))
        .orderBy(tenants.createdAt)
        .limit(LIMIT + 1);

      const truncated = rows.length > LIMIT;
      const page = truncated ? rows.slice(0, LIMIT) : rows;

      const members: CohortMember[] = page.map((r) => ({
        tenantId: r.id,
        createdAt: (r.createdAt as Date).toISOString(),
        status: r.status,
        // Raw, on purpose. See `CohortMember` — the completion rule is
        // applied by one function, in one place, for every reader.
        settings: r.settings,
      }));

      return {
        ok: true as const,
        data: {
          rows: buildCohorts(members),
          totalWorkspaces: members.length,
          truncated,
          asOf: new Date().toISOString(),
        },
      };
    },
  );
}
