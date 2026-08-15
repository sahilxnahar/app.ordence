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

import { and, desc, eq, isNull, inArray, sql, ne } from "drizzle-orm";
import { z } from "zod";
import { withPlatformScope, withTenant } from "@/db";
import { tenants, users, documents, subscriptions, plans, grantsAccess, auditLogs } from "@/db/schema";
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
import {
  CONFIG_KEYS,
  CONFIG_OVERRIDE_PREFIX,
  configDefinition,
  configKeyFromFlagKey,
  configOverrideKeyFor,
  diffConfigChange,
  formatConfigValue,
  isConfigKey,
  parseConfigValue,
  resolveConfig,
  type ConfigDiff,
  type ConfigKey,
  type ConfigResolution,
  type ConfigVersion,
  type TenantOverrideInput,
} from "@/lib/platform/config-chain";
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
  /**
   * ⭐ Every configuration key, resolved global → plan → override.
   * Carried on this read so the plan form can say where its numbers came
   * from without a second round trip.
   */
  configResolutions: readonly ConfigResolution[];
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

      /*
       * ⚠️ ONE READ FOR BOTH NAMESPACES — v1.43.0. This used to filter
       * on `entitlement:%` in SQL. It now takes every row for the
       * workspace and partitions in TypeScript, because Batch 47 added a
       * `config:` namespace to the same table and two LIKE queries over
       * the same index for the same page is a second round trip bought
       * for nothing. The partition is by prefix, in one place, so a row
       * can never be counted as both.
       */
      const flagRows = await tx
        .select()
        .from(platformTenantFlags)
        .where(eq(platformTenantFlags.tenantId, tenantId));

      const overrideRows = flagRows.filter((r) =>
        r.flagKey.startsWith(ENTITLEMENT_OVERRIDE_PREFIX),
      );
      const configRows = flagRows.filter((r) => r.flagKey.startsWith(CONFIG_OVERRIDE_PREFIX));

      return { tenant, subscription, seatRow, storageRow, overrideRows, configRows };
    },
  );

  if (!snapshot) return { ok: false, error: "Workspace not found." };

  const { tenant, subscription, seatRow, storageRow, overrideRows, configRows } = snapshot;
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

  /*
   * ⭐ THE CHAIN, RESOLVED ON THE SAME PASS — BATCH 47.
   *
   * ⚠️ AGAINST `governingTier`, NOT `tenants.plan_tier`. The header of
   * this file explains why the subscription is the authority where there
   * is one; a chain that resolved plan-level defaults from the cached
   * column would quote a ceiling the customer is not actually on.
   *
   * ⚠️ EXPIRY IS DELIBERATELY NOT APPLIED HERE, unlike the entitlement
   * overrides above. See `setConfigOverride`: a config override never
   * gets an expiry, because a storage ceiling that silently collapses at
   * midnight is a support ticket nobody can trace.
   */
  const configOverrides: Partial<Record<ConfigKey, TenantOverrideInput>> = {};
  for (const row of configRows) {
    const key = configKeyFromFlagKey(row.flagKey);
    if (!key) continue;
    configOverrides[key] = {
      present: true,
      raw: (row.value as { value?: unknown } | null)?.value,
      reason: row.reason,
      setByEmail: row.setByEmail,
      setAt: row.updatedAt.toISOString(),
    };
  }

  const configResolutions = CONFIG_KEYS.map((key) =>
    resolveConfig({
      key,
      planTier: governingTier,
      override: configOverrides[key] ?? { present: false },
    }),
  );

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
      configResolutions,
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
/* G · THE CONFIGURATION CHAIN — READ                                  */
/* ------------------------------------------------------------------ */

export type ConfigChainView = {
  tenantId: string;
  slug: string;
  name: string;
  planTier: PlanTier;
  /** ⚠️ True when the tier the chain resolves against is the subscription's. */
  subscriptionIsAuthority: boolean;
  resolutions: readonly ConfigResolution[];
  /**
   * 🔴 THE ONE PLACE THE CHAIN CAN DISAGREE WITH REALITY.
   *
   * `limits.storage_mb` is enforced from `tenants.storage_limit_mb`,
   * because that is the column the upload path reads. Every workspace
   * that existed before this batch has a column value and NO override
   * row, so the chain would resolve to the plan's number while the
   * product enforces the column's. Saying "they agree" would be a lie
   * an operator only discovers when a customer hits a ceiling nobody
   * could see. So the disagreement is carried to the screen, and the
   * first save through the plan form reconciles it.
   */
  storageColumnMb: number;
  storageColumnDisagrees: boolean;
};

export async function getConfigChain(
  tenantId: string,
): Promise<ConfigResult<ConfigChainView>> {
  // ⚠️ The guard is `getWorkspaceConfiguration`'s — `tenants:read` — and
  // it runs before anything below. The tier is taken from there too so
  // the chain resolves against the SAME governing tier the module matrix
  // does; two answers to "what plan are they on" on one screen is how a
  // support call becomes an argument about which panel is right.
  const current = await getWorkspaceConfiguration(tenantId);
  if (!current.ok) return current;

  const resolutions = current.data.configResolutions;
  const storage = resolutions.find((r) => r.key === "limits.storage_mb");

  return {
    ok: true,
    data: {
      tenantId,
      slug: current.data.slug,
      name: current.data.name,
      planTier: current.data.planTier,
      subscriptionIsAuthority: current.data.subscriptionIsAuthority,
      resolutions,
      storageColumnMb: current.data.storageLimitMb,
      storageColumnDisagrees: storage?.effective !== current.data.storageLimitMb,
    },
  };
}

/**
 * ⚠️ DEFINED HERE RATHER THAN IN `lib/platform/schemas.ts` because the
 * shape belongs to the two functions below and nothing else posts it.
 * The catalogue it validates against is in
 * `lib/platform/config-chain.ts`, so a key removed from the catalogue
 * stops validating here on the same deploy.
 */
const configOverrideSchema = z.object({
  tenantId: z.string().uuid(),
  key: z.string().refine(isConfigKey, "Unknown setting."),
  mode: z.enum(["set", "clear"]),
  /** Absent for `clear`. Validated against the key's own type. */
  value: z.string().max(2000).optional(),
  reason: z
    .string()
    .trim()
    .min(
      20,
      "Describe why, in at least 20 characters — this is written to the customer's own audit log.",
    )
    .max(1000),
});

/**
 * ⭐⭐⭐ THE DIFF PREVIEW, ON THE SERVER.
 *
 * ⚠️ THE SCREEN COMPUTES THE SAME SENTENCE FROM THE SAME PURE FUNCTION,
 * AND THIS ONE STILL EXISTS. Not because the client might lie — it can
 * lie about anything and `setConfigOverride` re-resolves regardless —
 * but because the client's copy of the plan tier and the current
 * override is as old as the page. An operator who spent four minutes
 * writing a reason is previewing against a workspace that may have been
 * upgraded in the meantime.
 */
export async function previewConfigOverride(
  input: unknown,
): Promise<ConfigResult<ConfigDiff>> {
  await requireCapability("tenants:read");

  const parsed = configOverrideSchema
    .omit({ reason: true })
    .safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the form.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const chain = await getConfigChain(parsed.data.tenantId);
  if (!chain.ok) return chain;

  return buildDiff(chain.data, parsed.data.key as ConfigKey, parsed.data.mode, parsed.data.value);
}

function buildDiff(
  chain: ConfigChainView,
  key: ConfigKey,
  mode: "set" | "clear",
  value: string | undefined,
): ConfigResult<ConfigDiff> {
  const before = chain.resolutions.find((r) => r.key === key);
  if (!before) return { ok: false, error: "Unknown setting." };

  // ⚠️ Found by name, not by position. The layer order is meaningful and
  // fixed, but reading it back by index couples this function to the
  // array's shape, and the one thing worse than a wrong diff is a diff
  // that silently compares the plan layer to itself.
  const tenantLayer = before.layers.find((l) => l.layer === "tenant");

  const beforeOverride: TenantOverrideInput = tenantLayer?.present
    ? {
        present: true,
        raw: tenantLayer.value,
        reason: tenantLayer.reason ?? null,
        setByEmail: tenantLayer.setByEmail ?? null,
        setAt: tenantLayer.setAt ?? null,
      }
    : { present: false };

  let afterOverride: TenantOverrideInput = { present: false };
  if (mode === "set") {
    const candidate = parseConfigValue(key, value ?? "");
    if (!candidate.ok) {
      return { ok: false, error: candidate.error, fieldErrors: { value: [candidate.error] } };
    }
    afterOverride = {
      present: true,
      raw: candidate.value,
      reason: null,
      setByEmail: null,
      setAt: null,
    };
  }

  return {
    ok: true,
    data: diffConfigChange({
      key,
      planTier: chain.planTier,
      // ⭐ THE NAME, NOT THE UUID. "Effective value for 3f2a-… changes"
      // is a sentence nobody can check against the customer they have on
      // the phone.
      tenantLabel: chain.name,
      before: beforeOverride,
      after: afterOverride,
    }),
  };
}

/* ------------------------------------------------------------------ */
/* G · THE CONFIGURATION CHAIN — WRITE                                 */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐⭐ THE ONE WRITE. TYPED, VERSIONED, WITH AN ACTOR.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT "VERSIONED" MEANS HERE, EXACTLY
 * ══════════════════════════════════════════════════════════════════════
 * The `platform_tenant_flags` row is the CURRENT version and carries the
 * actor who last set it (`set_by_email`, `updated_at`). The HISTORY is
 * the customer's own `audit_logs`: append-only, with `old_value`,
 * `new_value`, the actor's email and the reason, read back by
 * `listConfigVersions` below.
 *
 * 🔴 THERE IS NO SEPARATE VERSION TABLE, and that is the same decision
 * `guard.ts` argues for at length: a history split across two tables
 * cannot prove anything, because a reader has to trust both are
 * complete. It also means the customer can see their own configuration
 * history, which — for a value that decides what they are told when we
 * lock them out — they are entitled to.
 *
 * ⚠️ THE AUDIT ROW RECORDS THE EFFECTIVE VALUES, NOT THE RAW OVERRIDE.
 * "override removed" tells a reviewer nothing; "effective storage
 * ceiling went from 8192 MB to 2048 MB" tells them what the customer
 * felt.
 */
export async function setConfigOverride(
  input: unknown,
): Promise<ConfigResult<ConfigDiff>> {
  const gate = await capabilityOrStepUp("tenants:configure");
  if (!gate.ok) return gate.result;
  const operator = gate.operator;

  const parsed = configOverrideSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the form.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { tenantId, mode, reason } = parsed.data;
  const key = parsed.data.key as ConfigKey;

  const chain = await getConfigChain(tenantId);
  if (!chain.ok) return chain;

  // Recomputed from the state as it is NOW, not from whatever the form
  // was rendered against. The operator approved a sentence; what gets
  // written has to be what is actually true at the moment of the write.
  const diff = buildDiff(chain.data, key, mode, parsed.data.value);
  if (!diff.ok) return diff;

  const flagKey = configOverrideKeyFor(key);

  await withPlatformScope(
    `Platform console: ${mode} config ${key} on tenant ${tenantId} — ${reason.slice(0, 80)}`,
    async (tx) => {
      if (mode === "clear") {
        /*
         * ⭐ DELETE, NOT "WRITE THE PLAN'S CURRENT ANSWER". Identical
         * today, wrong tomorrow: a row asserting today's plan value
         * keeps asserting it after the customer upgrades, and the
         * upgrade they paid for silently does nothing. Absence is the
         * only value that means "the plan decides". Same argument as
         * `setModuleEntitlement`.
         */
        await tx
          .delete(platformTenantFlags)
          .where(
            and(
              eq(platformTenantFlags.tenantId, tenantId),
              eq(platformTenantFlags.flagKey, flagKey),
            ),
          );
        return;
      }

      await tx
        .insert(platformTenantFlags)
        .values({
          tenantId,
          flagKey,
          // ⚠️ `enabled` IS MEANINGLESS FOR A CONFIG ROW and is set true
          // so the row reads as live to anything scanning the table.
          // The VALUE is in `value`, and `false` here would look like a
          // switched-off setting rather than a stored number.
          enabled: true,
          value: { value: diff.data.to },
          reason,
          expiresAt: null,
          setByStaffId: operator.staff.id,
          setByEmail: operator.email,
        })
        .onConflictDoUpdate({
          target: [platformTenantFlags.tenantId, platformTenantFlags.flagKey],
          set: {
            enabled: true,
            value: { value: diff.data.to },
            reason,
            expiresAt: null,
            setByStaffId: operator.staff.id,
            setByEmail: operator.email,
            updatedAt: new Date(),
          },
        });
    },
  );

  /*
   * ⚠️ THE COLUMN AND THE CHAIN ARE RECONCILED IN THE SAME BREATH FOR
   * THE ONE KEY THAT HAS A COLUMN. `tenants.storage_limit_mb` is what
   * the upload path enforces; a chain that resolved to 8192 while the
   * product enforced 2048 would be a configuration screen that lies,
   * which is worse than not having one.
   */
  if (key === "limits.storage_mb" && typeof diff.data.to === "number") {
    const enforced = diff.data.to;
    await withPlatformScope(
      `Platform console: reconcile enforced storage ceiling for tenant ${tenantId}`,
      async (tx) => {
        await tx
          .update(tenants)
          .set({ storageLimitMb: enforced, updatedAt: new Date() })
          .where(eq(tenants.id, tenantId));
      },
    );
  }

  await recordPlatformAudit({
    operator,
    tenantId,
    action: "config_change",
    resourceType: "tenant_config_override",
    resourceId: key,
    oldValue: { effective: diff.data.from, layer: diff.data.fromLayer },
    newValue: { effective: diff.data.to, layer: diff.data.toLayer },
    // A configuration value that decides a ceiling or what a locked-out
    // customer is told is not routine, and `notice` would bury it under
    // every console read.
    severity: "warning",
    reason,
    metadata: {
      configKey: key,
      label: diff.data.label,
      mode,
      effectiveChanged: diff.data.changed,
      sentence: diff.data.sentence,
      provenanceNote: diff.data.note,
      planTier: chain.data.planTier,
    },
  });

  return { ok: true, data: diff.data };
}

/**
 * The history of one workspace's configuration, read back out of the
 * customer's OWN audit log.
 *
 * ⚠️ READ THROUGH `withTenant`, NOT THE PLATFORM CONNECTION. The
 * `audit_logs` policy is `tenant_id = app_current_tenant_id()`, so the
 * platform connection sees nothing there and has to ask as the tenant.
 * That is the policy working correctly rather than an obstacle to route
 * around — the same pattern `readPreviousStatus()` uses in `tenants.ts`.
 *
 * Fails SOFT: an unreadable history returns empty and says so through
 * the caller rather than taking the configuration screen down. The
 * screen labels it, because empty and unknown are not the same thing.
 */
export async function listConfigVersions(
  tenantId: string,
): Promise<ConfigResult<{ versions: ConfigVersion[]; readable: boolean }>> {
  await requireCapability("tenants:read");

  try {
    const rows = await withTenant(tenantId, async (tx) =>
      tx
        .select({
          resourceId: auditLogs.resourceId,
          oldValue: auditLogs.oldValue,
          newValue: auditLogs.newValue,
          actorEmail: auditLogs.actorEmail,
          createdAt: auditLogs.createdAt,
          reason: auditLogs.reason,
        })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.tenantId, tenantId),
            eq(auditLogs.resourceType, "tenant_config_override"),
          ),
        )
        .orderBy(desc(auditLogs.createdAt))
        .limit(50),
    );

    const versions: ConfigVersion[] = [];
    for (const row of rows) {
      const key = row.resourceId;
      if (!isConfigKey(key)) continue;
      const from = (row.oldValue as { effective?: unknown } | null)?.effective;
      const to = (row.newValue as { effective?: unknown } | null)?.effective;
      versions.push({
        key,
        at: row.createdAt.toISOString(),
        actorEmail: row.actorEmail,
        fromFormatted:
          typeof from === "number" || typeof from === "string"
            ? formatConfigValue(key, from)
            : null,
        toFormatted:
          typeof to === "number" || typeof to === "string" ? formatConfigValue(key, to) : null,
        reason: row.reason,
      });
    }

    return { ok: true, data: { versions, readable: true } };
  } catch (err) {
    console.error("[platform] configuration history could not be read", err);
    return { ok: true, data: { versions: [], readable: false } };
  }
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

  /*
   * ══════════════════════════════════════════════════════════════════
   * ⭐⭐⭐ THE STORAGE FIELD NOW WRITES THROUGH THE CHAIN — BATCH 47
   * ══════════════════════════════════════════════════════════════════
   * Until this batch the number typed here went straight into a column
   * and left no trace of WHERE IT CAME FROM. Six months later "why is
   * this workspace on 8192?" had three candidate answers — the plan, a
   * promise in a sales call, a typo — and no way to tell them apart, so
   * nobody dared move it.
   *
   * ⭐ SO THE TYPED NUMBER IS RESOLVED AGAINST THE PLAN IT IS BEING SET
   * ALONGSIDE. Equal to the plan's ceiling → the override is DELETED, so
   * the workspace follows the tier and a later upgrade actually lifts
   * it. Different → an override row is written with this operator's name
   * and this reason, and the chain can say which layer the number came
   * from.
   *
   * ⚠️ THE COLUMN IS STILL WRITTEN, IN THE SAME TRANSACTION. It is what
   * the upload path enforces; the chain describes it. Splitting them
   * across two statements is how they drift, so they do not.
   *
   * ⚠️ AND IT IS RESOLVED AGAINST THE *NEW* TIER, not the current one.
   * An operator moving basic → advanced and leaving the ceiling at the
   * advanced default is expressing "give them the plan's number", and
   * pinning an override there would freeze them out of the next change.
   */
  const storageDef = configDefinition("limits.storage_mb");
  const planStorage = storageDef.planDefaults[planTier] ?? storageDef.globalDefault;
  const storageIsPlanDefault = storageLimitMb === planStorage;
  const storageFlagKey = configOverrideKeyFor("limits.storage_mb");

  await withPlatformScope(
    `Platform console: set plan/limits on tenant ${tenantId} — ${reason.slice(0, 80)}`,
    async (tx) => {
      await tx
        .update(tenants)
        .set({ planTier, seatLimit, storageLimitMb, updatedAt: new Date() })
        .where(eq(tenants.id, tenantId));

      if (storageIsPlanDefault) {
        await tx
          .delete(platformTenantFlags)
          .where(
            and(
              eq(platformTenantFlags.tenantId, tenantId),
              eq(platformTenantFlags.flagKey, storageFlagKey),
            ),
          );
        return;
      }

      await tx
        .insert(platformTenantFlags)
        .values({
          tenantId,
          flagKey: storageFlagKey,
          enabled: true,
          value: { value: storageLimitMb },
          reason,
          expiresAt: null,
          setByStaffId: operator.staff.id,
          setByEmail: operator.email,
        })
        .onConflictDoUpdate({
          target: [platformTenantFlags.tenantId, platformTenantFlags.flagKey],
          set: {
            enabled: true,
            value: { value: storageLimitMb },
            reason,
            expiresAt: null,
            setByStaffId: operator.staff.id,
            setByEmail: operator.email,
            updatedAt: new Date(),
          },
        });
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
      /*
       * ⭐ WHICH LAYER THE STORAGE CEILING NOW COMES FROM. A reviewer
       * reading this row later can tell "they were given the advanced
       * plan's ceiling" from "somebody pinned this workspace to 8192",
       * which is exactly the question the old audit row could not
       * answer.
       */
      storageLayer: storageIsPlanDefault ? "plan" : "tenant",
      storagePlanDefaultMb: planStorage,
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
