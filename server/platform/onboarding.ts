import "server-only";

/**
 * Ordence — ⭐⭐⭐ ONBOARDING PROGRESS, READ ACROSS EVERY WORKSPACE
 * Version: v1.52.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE GAP THIS CLOSES
 * ══════════════════════════════════════════════════════════════════════
 * A workspace stuck on step 3 for nine days is churn that has not
 * happened yet. Today nothing surfaces it: the directory sorts by
 * creation, the health screen only raises rules about workspaces that are
 * USING the product, and a customer who never finished setup never
 * generates the activity those rules are watching. They are invisible in
 * exactly the window where a phone call still works.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT "LAST PROGRESS" IS, AND WHY IT IS NOT `tenants.updated_at`
 * ══════════════════════════════════════════════════════════════════════
 * `updated_at` is bumped by anything that touches the row — a plan
 * change, a flag, a rename, an operator on this very console. Ageing off
 * it means our own suspension write resets the customer's stall clock to
 * zero, and the nine-day workspace drops off the list because WE touched
 * it. That is the bug that would make this screen worse than nothing.
 *
 * ⭐ SO PROGRESS IS READ FROM THE AUDIT TRAIL. Every step in
 * `server/actions/onboarding.ts` writes an audit row whose reason begins
 * "Onboarding wizard —". The latest such row is the last thing the
 * CUSTOMER did. Where there is none, the workspace has completed nothing
 * and the clock runs from creation, which is the honest reading.
 *
 * ⚠️ RLS: every query here crosses the tenant boundary on purpose and
 * therefore goes through `withPlatformScope()` with a written reason, the
 * same rule as `tenants.ts`. `audit_logs` and `users` both carry the
 * platform READ clause; nothing here reads a customer-content table.
 */

import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { withPlatformScope } from "@/db";
import { tenants } from "@/db/schema";
import {
  ONBOARDING_COMPLETED_AT_KEY,
  currentStepNumber,
  daysSince,
  byStalledFirst,
  type OnboardingProgressRow,
} from "@/lib/platform/onboarding-progress";
import type { PlatformResult } from "@/lib/platform/schemas";
import { requireCapability, recordPlatformAudit } from "./guard";

/* ------------------------------------------------------------------ */
/* DERIVED COLUMNS                                                     */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE LAST STEP THE CUSTOMER COMPLETED.
 *
 * A correlated scalar subquery, for the reason spelled out at length in
 * `tenants.ts`: joining a one-to-many and grouping inflates every other
 * aggregate on the row. This one returns exactly one timestamp or NULL.
 *
 * ⚠️ MATCHED ON THE REASON PREFIX, which is written by the four actions
 * in `server/actions/onboarding.ts` and by nothing else. Matching on
 * `resource_type = 'tenant'` alone would also catch renames and plan
 * changes and would make every workspace look busy.
 */
const lastOnboardingStepAtSql = sql<Date | null>`(
  SELECT max(al.created_at) FROM audit_logs al
   WHERE al.tenant_id = ${tenants.id}
     AND al.resource_type = 'tenant'
     AND al.reason LIKE 'Onboarding wizard%'
)`;

/**
 * Who to ring.
 *
 * ⚠️ THE OWNER IF THERE IS ONE, OTHERWISE THE FIRST PERSON THROUGH THE
 * DOOR. A half-provisioned workspace often has one `invited` row and no
 * owner role yet; falling back to the earliest user is what makes the
 * contact column non-empty for exactly the workspaces most likely to be
 * stuck. Ordered by creation so the answer is stable between renders.
 *
 * ⚠️ THIS IS THE ONLY PERSONAL DATA ON THE SCREEN and it is deliberate:
 * a rescue list with no phone number is a list of regrets. It is one
 * email address and a status, never a contact record, a deal or a
 * document — the line `lib/platform/search-scopes.ts` draws.
 */
const contactPickSql = sql`(
  SELECT u.id FROM users u
   WHERE u.tenant_id = ${tenants.id}
     AND u.deleted_at IS NULL
   ORDER BY (u.role = 'tenant_owner') DESC, u.created_at ASC
   LIMIT 1
)`;

const contactEmailSql = sql<string | null>`(SELECT u.email FROM users u WHERE u.id = ${contactPickSql})`;
const contactNameSql = sql<string | null>`(
  SELECT nullif(trim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')), '')
    FROM users u WHERE u.id = ${contactPickSql}
)`;
const contactStatusSql = sql<string | null>`(SELECT u.status::text FROM users u WHERE u.id = ${contactPickSql})`;

/* ------------------------------------------------------------------ */
/* LIST                                                                */
/* ------------------------------------------------------------------ */

/**
 * Every workspace that has not finished the wizard, stalled first.
 *
 * ⚠️ NOT PAGED, AND THAT IS A CHOICE WITH A CEILING. Unfinished
 * onboardings are a small, self-draining population — a workspace leaves
 * this list forever the moment it finishes. `limit(500)` is a guard
 * against a bad week, not a pager, and the screen says so if it bites.
 * Paging would also break the one thing the screen is for: the whole
 * point is that the worst row is visible without touching a control.
 *
 * ⚠️ ARCHIVED AND PENDING-DELETION WORKSPACES ARE EXCLUDED. They have
 * never finished onboarding and never will; leaving them in means the
 * oldest rows on a stalled-first list are all workspaces nobody can
 * rescue, which is precisely how a triage screen stops being read.
 *
 * ⭐ ONE `now` FOR THE WHOLE PAGE. Ages are computed here, against a
 * single instant, so the badge, the sort and every row agree.
 */
export async function listOnboardingProgress(): Promise<
  PlatformResult<{ rows: OnboardingProgressRow[]; truncated: boolean; asOf: string }>
> {
  await requireCapability("tenants:list");
  const now = new Date();
  const LIMIT = 500;

  return withPlatformScope(
    "Platform console: list workspaces that have not finished onboarding, with the age of their last completed step",
    async (db) => {
      const rows = await db
        .select({
          id: tenants.id,
          slug: tenants.slug,
          name: tenants.name,
          status: tenants.status,
          planTier: tenants.planTier,
          settings: tenants.settings,
          createdAt: tenants.createdAt,
          trialEndsAt: tenants.trialEndsAt,
          lastStepAt: lastOnboardingStepAtSql,
          contactEmail: contactEmailSql,
          contactName: contactNameSql,
          contactStatus: contactStatusSql,
        })
        .from(tenants)
        .where(
          and(
            isNull(tenants.deletedAt),
            ne(tenants.status, "archived"),
            ne(tenants.status, "pending_deletion"),
            // ⚠️ The completion marker, not the step counter.
            // `completeOnboarding()` sets `onboardingStep` back to NULL as
            // it finishes, so "step is null" is true both for a finished
            // workspace and for one that has never begun.
            // ⚠️ The key is `ONBOARDING_COMPLETED_AT_KEY`, not a literal, so
            // this SQL and `hasCompletedOnboarding()` (which the cohort
            // screen reads) name the same field by construction. `::text`
            // is not decoration: a bare bind parameter next to `->>` is
            // ambiguous between the text and the integer operator.
            sql`(${tenants.settings} ->> ${ONBOARDING_COMPLETED_AT_KEY}::text) IS NULL`,
          ),
        )
        // A second, unique key so the order is TOTAL even before the
        // in-memory sort below.
        .orderBy(sql`${tenants.createdAt} ASC`, sql`${tenants.id} ASC`)
        .limit(LIMIT + 1);

      const truncated = rows.length > LIMIT;
      const page = truncated ? rows.slice(0, LIMIT) : rows;

      const mapped: OnboardingProgressRow[] = page.map((r) => {
        const settings = (r.settings ?? {}) as { onboardingStep?: number | null };
        const createdAtIso = (r.createdAt as Date).toISOString();
        const lastStepIso = r.lastStepAt ? new Date(r.lastStepAt).toISOString() : null;
        const lastProgressAt = lastStepIso ?? createdAtIso;

        return {
          tenantId: r.id,
          slug: r.slug,
          name: r.name,
          status: r.status,
          planTier: r.planTier,
          currentStep: currentStepNumber(settings.onboardingStep ?? null),
          lastProgressAt,
          neverStarted: lastStepIso === null,
          daysSinceProgress: daysSince(lastProgressAt, now),
          createdAt: createdAtIso,
          trialEndsAt: r.trialEndsAt ? (r.trialEndsAt as Date).toISOString() : null,
          contactEmail: r.contactEmail ?? null,
          contactName: r.contactName ?? null,
          contactStatus: r.contactStatus ?? null,
        };
      });

      mapped.sort(byStalledFirst);

      return { ok: true as const, data: { rows: mapped, truncated, asOf: now.toISOString() } };
    },
  );
}

/* ------------------------------------------------------------------ */
/* MARK FOR A CALL                                                     */
/* ------------------------------------------------------------------ */

const markForCallSchema = z.object({
  tenantId: z.string().uuid(),
  /**
   * ⚠️ REQUIRED AND SHORT-MINIMUM. "Marked for a call" with no sentence
   * is a row nobody can act on and a queue that grows until it is
   * ignored. Twelve characters is enough to force a reason and not
   * enough to be a form.
   */
  note: z.string().trim().min(12).max(500),
});

/**
 * ⭐ THE ONE CONTROL ON THIS SCREEN THAT REALLY DOES SOMETHING.
 *
 * It does not send anything to the customer and does not pretend to. It
 * writes an entry into the action register saying that a named operator
 * decided this workspace needs a human, on a given day, at a given step,
 * with a reason — which is the artefact a colleague picking up the list
 * tomorrow actually needs, and the artefact that makes "we tried" checkable.
 *
 * ⚠️ CAPABILITY IS `tenants:read`, NOT A NEW ONE. This write changes
 * nothing a customer can observe: no plan, no flag, no access, no
 * message. It records an intention. Minting a new capability for it would
 * mean editing the grade matrix so that the support engineer who is
 * looking at the list cannot act on it, which is the opposite of the
 * point. Every operator who can see a workspace's detail can say it needs
 * a call.
 *
 * 🔴 THE REGISTER WRITE ITSELF GOES THROUGH `recordPlatformAudit`, which
 * routes a tenant-attributed row into `audit_logs` under `withTenant()`.
 * That is not a way around the platform-scope rule — it is the rule:
 * `audit_logs`' RLS `WITH CHECK` refuses a row written on the platform
 * connection (see the header of `guard.ts`). The cross-tenant READ that
 * proves the workspace exists is the part that legitimately crosses the
 * boundary, and it is inside `withPlatformScope` with a written reason.
 */
export async function markOnboardingForCall(
  input: unknown,
): Promise<PlatformResult<{ tenantName: string }>> {
  const operator = await requireCapability("tenants:read");
  const parsed = markForCallSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Write a sentence saying what the call is about — at least a dozen characters.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { tenantId, note } = parsed.data;

  const found = await withPlatformScope(
    "Platform console: confirm a workspace exists and read its step before flagging it for an onboarding rescue call",
    async (db) => {
      const [row] = await db
        .select({
          name: tenants.name,
          slug: tenants.slug,
          settings: tenants.settings,
          createdAt: tenants.createdAt,
          lastStepAt: lastOnboardingStepAtSql,
          contactEmail: contactEmailSql,
        })
        .from(tenants)
        .where(and(eq(tenants.id, tenantId), isNull(tenants.deletedAt)))
        .limit(1);
      return row ?? null;
    },
  );

  if (!found) {
    return { ok: false, error: "That workspace no longer exists." };
  }

  const settings = (found.settings ?? {}) as { onboardingStep?: number | null };
  const step = currentStepNumber(settings.onboardingStep ?? null);
  const lastProgressAt = found.lastStepAt
    ? new Date(found.lastStepAt).toISOString()
    : (found.createdAt as Date).toISOString();
  // ⭐ THE SAME AGEING FUNCTION THE LIST USES. The number written into the
  // register is the number the operator was looking at when they clicked.
  const days = daysSince(lastProgressAt, new Date());

  await recordPlatformAudit({
    operator,
    tenantId,
    action: "update",
    resourceType: "tenant_onboarding",
    resourceId: tenantId,
    severity: "notice",
    newValue: {
      markedForCall: true,
      onboardingStep: step,
      daysSinceProgress: days,
      contactEmail: found.contactEmail ?? null,
    },
    reason: `Onboarding rescue: marked for a call on step ${step} after ${days} day(s) without progress — ${note}`,
    metadata: { slug: found.slug, source: "onboarding_progress" },
  });

  return { ok: true, data: { tenantName: found.name } };
}
