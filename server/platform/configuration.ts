import "server-only";

/**
 * Ordence — ⭐ WORKSPACE CONFIGURATION, SERVER SIDE
 * Version: v0.53.0 · Sections C, D and E
 *
 * ══════════════════════════════════════════════════════════════════════
 * THREE WRITES. ALL OF THEM ARE THINGS THAT USED TO BE A DEPLOY.
 * ══════════════════════════════════════════════════════════════════════
 *   `setModuleEntitlement` — one module, one workspace, above or below
 *                            the plan. Writes `entitlement:<feature>`
 *                            into `platform_tenant_flags`.
 *   `setPlanAndLimits`     — plan tier, seat ceiling, storage ceiling.
 *   `setTenantIndustry`    — which vertical template drives the menu.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS FILE DOES NOT CALL `setTenantFlag()`
 * ══════════════════════════════════════════════════════════════════════
 * It looks like it should — an entitlement override IS a row in
 * `platform_tenant_flags`. But `setTenantFlag()` validates `flagKey`
 * against `FLAG_CATALOG`, and `entitlement:sales.orders` is deliberately
 * NOT in that catalogue: `lib/entitlements/overrides.ts` keeps the two
 * namespaces apart precisely so a beta flag can never collide with a
 * feature key and become a free upgrade nobody invoices.
 *
 * So this file writes the same table under the other namespace, with its
 * own validation (`isFeatureKey`), its own expiry rule
 * (`overrideRequiresExpiry`) and its own audit resource type. Two
 * namespaces, two writers, one table, one RLS policy.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE MOST IMPORTANT CAVEAT IN THIS FILE — READ BEFORE TRUSTING D
 * ══════════════════════════════════════════════════════════════════════
 * `tenants.plan_tier` is a DENORMALISED CACHE. `getEntitlementContext()`
 * reads the SUBSCRIPTION first and only falls back to this column when
 * there is no subscription row. So for a workspace that is actually
 * being billed, changing the tier here changes what the console and the
 * invoice preview say and DOES NOT change what the customer can reach.
 *
 * That is not a bug to fix in this file — the subscription is correctly
 * the authority, and re-pricing a customer is a billing operation, not a
 * console toggle. It is a fact the screen has to state out loud, because
 * an operator who changes the tier, watches nothing happen for the
 * customer, and concludes the console is broken will go and do something
 * far worse in a database client. `subscriptionIsAuthority` below is
 * carried to the UI for exactly that sentence.
 */

import { and, eq, isNull, inArray, sql, ne } from "drizzle-orm";
import { withPlatformScope } from "@/db";
import { tenants, users, documents, subscriptions, plans, grantsAccess } from "@/db/schema";
import { platformTenantFlags } from "@/db/schema/platform";
import {
  ENTITLEMENT_OVERRIDE_PREFIX,
  overrideKeyFor,
  overrideRequiresExpiry,
} from "@/lib/entitlements/overrides";
import {
  FEATURE_CATALOG,
  TIER_RANK,
  effectiveTier,
  isFeatureKey,
  type FeatureKey,
} from "@/lib/entitlements/features";
import {
  buildModuleMatrix,
  measureLimit,
  previewIndustryChange,
  setIndustrySchema,
  setModuleEntitlementSchema,
  setPlanAndLimitsSchema,
  MODULE_STATE_LABELS,
  type ConfigResult,
  type LimitPressure,
  type ModuleMatrix,
} from "@/lib/platform/configuration";
import {
  resolveIndustryTemplate,
  isIndustryKey,
  type IndustryKey,
} from "@/lib/industry-templates";
import { requireCapability, recordPlatformAudit, PlatformAccessError } from "./guard";
import type { PlanTier } from "@/db/schema/core";
import type { PlatformOperator } from "./guard";

/* ------------------------------------------------------------------ */
/* STEP-UP, TURNED INTO SOMETHING A FORM CAN RENDER                    */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ EVERY WRITE IN THIS FILE IS ON THE STEP-UP LIST, AND A THROWN
 * `PlatformAccessError` REACHES THE BROWSER AS A REDACTED DIGEST.
 *
 * Next.js redacts server-action exceptions in production — which is
 * right, because the alternative leaks internals — but it means an
 * operator who simply needs to re-confirm their identity sees "an
 * unexpected error occurred" and has no idea what to do. So the one case
 * that has a REMEDY is caught and returned as data.
 *
 * ⚠️ Nothing else is caught. A capability denial must stay
 * indistinguishable from every other refusal (see the comment on
 * `PlatformAccessError`), so it keeps throwing.
 */
async function capabilityOrStepUp(
  capability: Parameters<typeof requireCapability>[0],
): Promise<
  { ok: true; operator: PlatformOperator } | { ok: false; result: ConfigResult<never> }
> {
  try {
    return { ok: true, operator: await requireCapability(capability) };
  } catch (error) {
    if (error instanceof PlatformAccessError && error.code === "step_up_required") {
      return {
        ok: false,
        result: {
          ok: false,
          error: "Confirm your identity before changing a customer's configuration.",
          needsStepUp: true,
        },
      };
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* READ                                                                */
/* ------------------------------------------------------------------ */

export type WorkspaceConfiguration = {
  tenantId: string;
  slug: string;
  name: string;
  status: string;
  planTier: PlanTier;
  seatLimit: number;
  storageLimitMb: number;
  seats: LimitPressure;
  storage: LimitPressure;
  trialEndsAt: string | null;
  subscriptionStatus: string | null;
  subscriptionGrantsAccess: boolean;
  /** ⚠️ True when the tier on this page is NOT what the gate consults. */
  subscriptionIsAuthority: boolean;
  industry: IndustryKey;
  industryLabel: string;
  /** ⚠️ True when `settings.industry` held something unrecognised. */
  industryWasUnrecognised: boolean;
  matrix: ModuleMatrix;
  /** Feature key → whether the workspace can reach it right now. */
  featureAllowed: Record<string, boolean>;
  /** Nav id → allowed. What `filterNavigationByEntitlement()` wants. */
  navAllowed: Record<string, boolean>;
};

/**
 * Everything the configuration screens need, in one pass.
 *
 * ⚠️ AUDITED AS A READ AGAINST THE CUSTOMER. Opening a workspace's
 * configuration is a deliberate act aimed at one customer and it belongs
 * in their own audit log, next to whatever change follows it. A change
 * with no preceding read looks like it came from nowhere.
 */
export async function getWorkspaceConfiguration(
  tenantId: string,
): Promise<ConfigResult<WorkspaceConfiguration>> {
  const operator = await requireCapability("tenants:read");

  const snapshot = await withPlatformScope(
    `Platform console: read workspace configuration for tenant ${tenantId}`,
    async (tx) => {
      const [tenant] = await tx
        .select({
          id: tenants.id,
          slug: tenants.slug,
          name: tenants.name,
          status: tenants.status,
          planTier: tenants.planTier,
          seatLimit: tenants.seatLimit,
          storageLimitMb: tenants.storageLimitMb,
          trialEndsAt: tenants.trialEndsAt,
          settings: tenants.settings,
        })
        .from(tenants)
        .where(and(eq(tenants.id, tenantId), isNull(tenants.deletedAt)))
        .limit(1);

      if (!tenant) return null;

      /*
       * ⚠️ THE SUBSCRIPTION IS READ THE SAME WAY `getEntitlementContext()`
       * READS IT — same status list, same "no row means treat as
       * granting". A console that resolved the tier by a slightly
       * different rule than the gate would show an operator a state the
       * customer is not in, which is the failure this whole screen exists
       * to prevent.
       */
      const [subscription] = await tx
        .select({ status: subscriptions.status, tier: plans.tier })
        .from(subscriptions)
        .innerJoin(plans, eq(plans.id, subscriptions.planId))
        .where(
          and(
            eq(subscriptions.tenantId, tenantId),
            isNull(subscriptions.deletedAt),
            sql`${subscriptions.status} IN ('trialing','active','past_due','unpaid','paused')`,
          ),
        )
        .limit(1);

      // Seats: active humans only. Platform staff sitting in a workspace
      // do not consume a seat (see lib/billing/seats.ts) and counting
      // them here would let our own presence push a customer over.
      const [seatRow] = await tx
        .select({ seats: sql<number>`count(*)::int` })
        .from(users)
        .where(
          and(
            eq(users.tenantId, tenantId),
            isNull(users.deletedAt),
            eq(users.status, "active"),
            ne(users.role, "platform_super_admin"),
            ne(users.role, "guest"),
          ),
        );

      const [storageRow] = await tx
        .select({ bytes: sql<string>`coalesce(sum(${documents.sizeBytes}), 0)::text` })
        .from(documents)
        .where(and(eq(documents.tenantId, tenantId), isNull(documents.deletedAt)));

      const overrideRows = await tx
        .select()
        .from(platformTenantFlags)
        .where(
          and(
            eq(platformTenantFlags.tenantId, tenantId),
            sql`${platformTenantFlags.flagKey} LIKE ${ENTITLEMENT_OVERRIDE_PREFIX + "%"}`,
          ),
        );

      return { tenant, subscription, seatRow, storageRow, overrideRows };
    },
  );

  if (!snapshot) return { ok: false, error: "Workspace not found." };

  const { tenant, subscription, seatRow, storageRow, overrideRows } = snapshot;
  const now = Date.now();

  /*
   * ⚠️ AN EXPIRED OVERRIDE IS NOT AN OVERRIDE — the same rule
   * `getEntitlementContext()` applies in SQL, applied here in TypeScript
   * because this screen must ALSO show the expired row (so an operator
   * can see the pilot that lapsed last Tuesday) while not counting it.
   */
  const overrides: Record<
    string,
    { enabled: boolean; reason: string | null; expiresAt: string | null; setByEmail: string | null }
  > = {};
  for (const row of overrideRows) {
    if (row.expiresAt && row.expiresAt.getTime() <= now) continue;
    overrides[row.flagKey.slice(ENTITLEMENT_OVERRIDE_PREFIX.length)] = {
      enabled: row.enabled,
      reason: row.reason,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      setByEmail: row.setByEmail,
    };
  }

  const subscriptionGrantsAccess = subscription ? grantsAccess(subscription.status) : true;
  // The subscription's tier wins where there is one — see the header.
  const governingTier: PlanTier = subscription?.tier ?? tenant.planTier;

  const matrix = buildModuleMatrix({
    planTier: governingTier,
    subscriptionGrantsAccess,
    overrides,
  });

  const tier = effectiveTier({ planTier: governingTier, subscriptionGrantsAccess });
  const featureAllowed: Record<string, boolean> = {};
  for (const key of Object.keys(FEATURE_CATALOG) as FeatureKey[]) {
    const override = overrides[key];
    featureAllowed[key] = override
      ? override.enabled
      : TIER_RANK[tier] >= TIER_RANK[FEATURE_CATALOG[key].minTier];
  }

  // `filterNavigationByEntitlement()` indexes by FEATURE key, so this is
  // the same map. Kept as a second name because the industry preview
  // reads it as "what the nav filter is allowed to keep" and conflating
  // the two names is how somebody eventually passes the wrong one.
  const navAllowed = featureAllowed;

  const rawIndustry = tenant.settings?.industry;
  const industryWasUnrecognised = rawIndustry !== undefined && !isIndustryKey(rawIndustry);
  const template = resolveIndustryTemplate(rawIndustry);

  await recordPlatformAudit({
    operator,
    tenantId,
    action: "read",
    resourceType: "tenant_configuration",
    resourceId: tenantId,
    severity: "info",
    reason: "Opened the workspace configuration screens in the platform console.",
    metadata: { overrides: Object.keys(overrides).length },
  });

  const seatsInUse = seatRow?.seats ?? 0;
  const storageUsedMb = Math.round(Number(storageRow?.bytes ?? "0") / 1_048_576);

  return {
    ok: true,
    data: {
      tenantId: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      status: tenant.status,
      planTier: governingTier,
      seatLimit: tenant.seatLimit,
      storageLimitMb: tenant.storageLimitMb,
      seats: measureLimit(seatsInUse, tenant.seatLimit),
      storage: measureLimit(storageUsedMb, tenant.storageLimitMb),
      trialEndsAt: tenant.trialEndsAt?.toISOString() ?? null,
      subscriptionStatus: subscription?.status ?? null,
      subscriptionGrantsAccess,
      subscriptionIsAuthority: Boolean(subscription),
      industry: template.key,
      industryLabel: template.label,
      industryWasUnrecognised,
      matrix,
      featureAllowed,
      navAllowed,
    },
  };
}

/* ------------------------------------------------------------------ */
/* C · WRITE — ONE MODULE, ONE WORKSPACE                               */
/* ------------------------------------------------------------------ */

export async function setModuleEntitlement(
  input: unknown,
): Promise<ConfigResult<{ feature: string; state: string }>> {
  const gate = await capabilityOrStepUp("entitlements:override");
  if (!gate.ok) return gate.result;
  const operator = gate.operator;

  const parsed = setModuleEntitlementSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the form.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { tenantId, feature, mode, reason, expiresAt } = parsed.data;

  // The schema already refined this; re-narrowing so the type is a
  // `FeatureKey` rather than a string at the catalogue lookup below.
  if (!isFeatureKey(feature)) return { ok: false, error: "Unknown feature key." };

  const expiry = expiresAt ? new Date(expiresAt) : null;
  if (expiry && expiry.getTime() <= Date.now()) {
    return {
      ok: false,
      error: "The end date is in the past.",
      fieldErrors: { expiresAt: ["The end date is in the past."] },
    };
  }

  const current = await getWorkspaceConfiguration(tenantId);
  if (!current.ok) return current;

  const definition = FEATURE_CATALOG[feature];
  const planDefault =
    TIER_RANK[
      effectiveTier({
        planTier: current.data.planTier,
        subscriptionGrantsAccess: current.data.subscriptionGrantsAccess,
      })
    ] >= TIER_RANK[definition.minTier];

  /*
   * ⭐ THE RULE THAT KEEPS THE PRICE LIST HONEST. A grant above the plan
   * with no end date is a discount nobody signed off, applied to one
   * customer, invisible in every revenue report, and remembered by nobody
   * after the salesperson who promised it leaves.
   *
   * ⚠️ Checked ONLY when granting. Revoking and clearing are never
   * blocked by a validation rule — the moment you most need to switch
   * something off is the moment a form refusing you is most expensive.
   */
  if (
    mode === "grant" &&
    overrideRequiresExpiry({ enabled: true, includedInPlan: planDefault }) &&
    !expiry
  ) {
    const message = `${definition.label} is not in the ${current.data.planTier} plan, so switching it on needs an end date.`;
    return { ok: false, error: message, fieldErrors: { expiresAt: [message] } };
  }

  const key = overrideKeyFor(feature);
  const previous = current.data.matrix.groups
    .flatMap((g) => g.modules)
    .find((m) => m.feature === feature);

  await withPlatformScope(
    `Platform console: ${mode} entitlement ${feature} on tenant ${tenantId} — ${reason.slice(0, 80)}`,
    async (tx) => {
      if (mode === "clear") {
        /*
         * ⭐ DELETE, NOT "SET TO THE PLAN'S CURRENT ANSWER".
         *
         * Writing `enabled = planDefault` would look identical today and
         * be wrong tomorrow: the row would keep asserting today's answer
         * after the customer upgrades, and the upgrade they paid for
         * would silently do nothing. Absence is the only value that means
         * "the plan decides".
         */
        await tx
          .delete(platformTenantFlags)
          .where(
            and(
              eq(platformTenantFlags.tenantId, tenantId),
              eq(platformTenantFlags.flagKey, key),
            ),
          );
        return;
      }

      await tx
        .insert(platformTenantFlags)
        .values({
          tenantId,
          flagKey: key,
          enabled: mode === "grant",
          value: {},
          reason,
          expiresAt: expiry,
          setByStaffId: operator.staff.id,
          setByEmail: operator.email,
        })
        .onConflictDoUpdate({
          target: [platformTenantFlags.tenantId, platformTenantFlags.flagKey],
          set: {
            enabled: mode === "grant",
            reason,
            expiresAt: expiry,
            setByStaffId: operator.staff.id,
            setByEmail: operator.email,
            updatedAt: new Date(),
          },
        });
    },
  );

  const nextState =
    mode === "clear"
      ? planDefault
        ? "included_by_plan"
        : "not_in_plan"
      : mode === "grant"
        ? "granted_by_override"
        : "revoked_by_override";

  /*
   * Into the CUSTOMER'S OWN audit log. A capability appearing or
   * disappearing in their workspace with no explanation anywhere they can
   * see is how a support win becomes a trust problem — and, for a revoke,
   * it is the only record that they did not lose it by accident.
   */
  await recordPlatformAudit({
    operator,
    tenantId,
    action: "config_change",
    resourceType: "tenant_entitlement_override",
    resourceId: feature,
    oldValue: {
      state: previous?.state ?? null,
      effective: previous?.effective ?? null,
    },
    newValue: {
      state: nextState,
      effective: mode === "clear" ? planDefault : mode === "grant",
      expiresAt: expiry?.toISOString() ?? null,
    },
    // ⚠️ `warning`, not `notice`, when the plan is being overridden in
    // either direction. Both are a fork of the pricing model for one
    // customer and both should stand out in a review six months later.
    severity: mode === "clear" ? "notice" : "warning",
    reason,
    metadata: {
      featureLabel: definition.label,
      requiredTier: definition.minTier,
      planIncludesIt: planDefault,
      // The modules that move with this key. See the header of
      // lib/platform/configuration.ts — one feature is often four menu
      // items, and a reviewer needs to know which ones changed.
      affectedModules: current.data.matrix.groups
        .flatMap((g) => g.modules)
        .filter((m) => m.feature === feature)
        .map((m) => m.label),
      newStateLabel:
        MODULE_STATE_LABELS[nextState as keyof typeof MODULE_STATE_LABELS] ?? nextState,
    },
  });

  return { ok: true, data: { feature, state: nextState } };
}

/* ------------------------------------------------------------------ */
/* D · WRITE — PLAN AND LIMITS                                         */
/* ------------------------------------------------------------------ */

export async function setPlanAndLimits(
  input: unknown,
): Promise<ConfigResult<{ planTier: PlanTier; seatLimit: number; storageLimitMb: number }>> {
  const gate = await capabilityOrStepUp("tenants:configure");
  if (!gate.ok) return gate.result;
  const operator = gate.operator;

  const parsed = setPlanAndLimitsSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the form.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { tenantId, planTier, seatLimit, storageLimitMb, acceptOverCommit, reason } =
    parsed.data;

  const current = await getWorkspaceConfiguration(tenantId);
  if (!current.ok) return current;

  /*
   * ⚠️ THE OVER-COMMIT CHECK IS SERVER SIDE TOO, AND NOT BECAUSE THE
   * CLIENT MIGHT BE MALICIOUS.
   *
   * It is because usage moves. An operator reads "8 of 10 seats", takes a
   * minute to write the reason, and in that minute the customer invites
   * three people. The form's copy of the usage is stale by the time it
   * posts; this one is not.
   */
  const overCommits: string[] = [];
  if (current.data.seats.used > seatLimit) {
    overCommits.push(
      `${current.data.seats.used} people already have seats — a limit of ${seatLimit} is below that.`,
    );
  }
  if (current.data.storage.used > storageLimitMb) {
    overCommits.push(
      `${current.data.storage.used} MB is already stored — a limit of ${storageLimitMb} MB is below that.`,
    );
  }
  if (overCommits.length > 0 && !acceptOverCommit) {
    return {
      ok: false,
      error: `${overCommits.join(" ")} Nothing is deleted by this, but the workspace will be blocked from adding more. Tick the acknowledgement to proceed.`,
      fieldErrors: { acceptOverCommit: overCommits },
    };
  }

  await withPlatformScope(
    `Platform console: set plan/limits on tenant ${tenantId} — ${reason.slice(0, 80)}`,
    async (tx) => {
      await tx
        .update(tenants)
        .set({ planTier, seatLimit, storageLimitMb, updatedAt: new Date() })
        .where(eq(tenants.id, tenantId));
    },
  );

  await recordPlatformAudit({
    operator,
    tenantId,
    action: "config_change",
    resourceType: "tenant_plan",
    resourceId: tenantId,
    oldValue: {
      planTier: current.data.planTier,
      seatLimit: current.data.seatLimit,
      storageLimitMb: current.data.storageLimitMb,
    },
    newValue: { planTier, seatLimit, storageLimitMb },
    severity: "warning",
    reason,
    metadata: {
      seatsInUse: current.data.seats.used,
      storageUsedMb: current.data.storage.used,
      overCommitted: overCommits,
      /*
       * ⚠️ RECORDED BECAUSE IT DECIDES WHETHER THIS CHANGED ANYTHING THE
       * CUSTOMER CAN FEEL. With a live subscription the gate consults the
       * subscription's tier, not this column — so a reviewer reading the
       * row later needs to know which of the two worlds it was written
       * in. See the header of this file.
       */
      subscriptionIsAuthority: current.data.subscriptionIsAuthority,
      subscriptionStatus: current.data.subscriptionStatus,
    },
  });

  return { ok: true, data: { planTier, seatLimit, storageLimitMb } };
}

/* ------------------------------------------------------------------ */
/* E · WRITE — INDUSTRY                                                */
/* ------------------------------------------------------------------ */

export async function setTenantIndustry(
  input: unknown,
): Promise<ConfigResult<{ industry: IndustryKey }>> {
  const gate = await capabilityOrStepUp("tenants:configure");
  if (!gate.ok) return gate.result;
  const operator = gate.operator;

  const parsed = setIndustrySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the form.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { tenantId, industry, confirmSlug, reason } = parsed.data;

  const current = await getWorkspaceConfiguration(tenantId);
  if (!current.ok) return current;

  if (current.data.slug !== confirmSlug.trim()) {
    return {
      ok: false,
      error: "That is not this workspace's address.",
      fieldErrors: { confirmSlug: ["That is not this workspace's address."] },
    };
  }

  // Recomputed here rather than trusted from the client: the preview the
  // operator read is what they APPROVED, but what gets recorded has to be
  // what is actually true at the moment of the write.
  const preview = previewIndustryChange({
    from: current.data.industry,
    to: industry,
    allowed: current.data.navAllowed,
  });

  if (preview.unchanged) {
    return { ok: false, error: "That is already this workspace's industry." };
  }

  await withPlatformScope(
    `Platform console: set industry ${industry} on tenant ${tenantId} — ${reason.slice(0, 80)}`,
    async (tx) => {
      /*
       * ⚠️ `settings || jsonb_build_object(...)`, NEVER `settings = {...}`.
       *
       * `db/schema/core.ts` says it in the column comment and it is worth
       * repeating at the one place that writes it from outside the
       * tenant: several forms across Phases 7 and 11 write to this single
       * jsonb column — timezone, currency, the billing profile, the MFA
       * requirement. A replace silently erases every one of them, and
       * nothing fails; the customer discovers it when their invoices come
       * out with no GSTIN.
       */
      await tx.execute(sql`
        UPDATE tenants
           SET settings   = settings || jsonb_build_object('industry', ${industry}::text),
               updated_at = now()
         WHERE id = ${tenantId}::uuid
      `);
    },
  );

  await recordPlatformAudit({
    operator,
    tenantId,
    action: "config_change",
    resourceType: "tenant_industry",
    resourceId: tenantId,
    oldValue: { industry: current.data.industry, label: current.data.industryLabel },
    newValue: { industry, label: preview.toLabel },
    /*
     * ⚠️ `critical`. This is the only action in the console that changes
     * what every person in a customer's workspace sees the next time they
     * load a page — the menu, the dashboard tiles and the word for their
     * customers all move at once. Nothing is deleted, but "my whole
     * system changed overnight" is the support call, and it must be
     * findable in one query.
     */
    severity: "critical",
    reason,
    metadata: {
      appearing: preview.appearing.map((i) => i.label),
      disappearing: preview.disappearing.map((i) => i.label),
      renamed: preview.terminology.map((t) => `${t.key}: ${t.from ?? "—"} → ${t.to ?? "—"}`),
      dashboardAdded: preview.dashboardAdded,
      dashboardRemoved: preview.dashboardRemoved,
      dataDeleted: false,
      reversible: true,
    },
  });

  return { ok: true, data: { industry } };
}

/* ------------------------------------------------------------------ */
/* F · THE TRIAGE BOARD'S READ                                         */
/* ------------------------------------------------------------------ */

export type TroubleRow = {
  id: string;
  slug: string;
  name: string;
  status: string;
  planTier: PlanTier;
  seatsInUse: number;
  seatLimit: number;
  storageUsedMb: number;
  storageLimitMb: number;
  trialEndsAt: string | null;
  lastActivityAt: string | null;
  createdAt: string;
};

/**
 * Raw operational facts for every non-archived workspace.
 *
 * ⚠️ NOT AUDITED PER-ROW, for the same reason the directory is not: this
 * is the screen an operator opens every morning, and a row per glance
 * buries the accesses that matter. The scoring happens in
 * `troubleSignals()` — pure, testable, and the same function the tenant
 * detail page could use.
 *
 * ⚠️ BOUNDED. Three queries, three `inArray` roll-ups, no per-tenant
 * loop: a console that issues one query per workspace stops working at
 * exactly the scale where you need it.
 */
export async function listWorkspacesNeedingAttention(
  limit = 500,
): Promise<ConfigResult<TroubleRow[]>> {
  await requireCapability("tenants:list");

  const rows = await withPlatformScope(
    "Platform console: read workspace operational signals for the attention board",
    async (tx) => {
      const base = await tx
        .select({
          id: tenants.id,
          slug: tenants.slug,
          name: tenants.name,
          status: tenants.status,
          planTier: tenants.planTier,
          seatLimit: tenants.seatLimit,
          storageLimitMb: tenants.storageLimitMb,
          trialEndsAt: tenants.trialEndsAt,
          createdAt: tenants.createdAt,
        })
        .from(tenants)
        .where(and(isNull(tenants.deletedAt), ne(tenants.status, "archived")))
        .limit(limit);

      if (base.length === 0) return [];
      const ids = base.map((t) => t.id);

      const seats = await tx
        .select({
          tenantId: users.tenantId,
          seats: sql<number>`count(*)::int`,
          lastSeen: sql<string | null>`max(${users.lastSeenAt})`,
        })
        .from(users)
        .where(
          and(
            inArray(users.tenantId, ids),
            isNull(users.deletedAt),
            eq(users.status, "active"),
            ne(users.role, "platform_super_admin"),
            ne(users.role, "guest"),
          ),
        )
        .groupBy(users.tenantId);

      const storage = await tx
        .select({
          tenantId: documents.tenantId,
          bytes: sql<string>`coalesce(sum(${documents.sizeBytes}), 0)::text`,
        })
        .from(documents)
        .where(and(inArray(documents.tenantId, ids), isNull(documents.deletedAt)))
        .groupBy(documents.tenantId);

      const seatsBy = new Map(seats.map((s) => [s.tenantId, s]));
      const storageBy = new Map(storage.map((s) => [s.tenantId, s.bytes]));

      return base.map<TroubleRow>((t) => ({
        id: t.id,
        slug: t.slug,
        name: t.name,
        status: t.status,
        planTier: t.planTier,
        seatsInUse: seatsBy.get(t.id)?.seats ?? 0,
        seatLimit: t.seatLimit,
        storageUsedMb: Math.round(Number(storageBy.get(t.id) ?? "0") / 1_048_576),
        storageLimitMb: t.storageLimitMb,
        trialEndsAt: t.trialEndsAt?.toISOString() ?? null,
        lastActivityAt: seatsBy.get(t.id)?.lastSeen
          ? new Date(seatsBy.get(t.id)!.lastSeen!).toISOString()
          : null,
        createdAt: t.createdAt.toISOString(),
      }));
    },
  );

  return { ok: true, data: rows };
}
