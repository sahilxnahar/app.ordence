/**
 * Ordence — ⭐ WORKSPACE CONFIGURATION, AS DATA RATHER THAN A DEPLOY
 * Version: v0.53.0 · Sections C, D and E of the client-onboarding architecture
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE THING THIS EXISTS TO KILL
 * ══════════════════════════════════════════════════════════════════════
 * Turning a feature on for one customer used to be a code change. Not a
 * configuration change with a code path — an actual edit, to an actual
 * file, followed by a release. The costs of that are not obvious until
 * you count them:
 *
 *   • the customer waits for whenever the next deploy happens;
 *   • the change is invisible to everyone not reading the diff, so
 *     "why can Acme see Trust Accounting?" is answered by `git log`;
 *   • it never expires, because a line of code has no `expires_at`;
 *   • and nobody can undo it at 03:00 without a second deploy.
 *
 * The mechanism to replace it already existed and was half-wired:
 * `platform_tenant_flags` under the `entitlement:` prefix, read by
 * `getEntitlementContext()` and honoured by `evaluateFeature()` BEFORE
 * the tier is consulted. What was missing was the screen. This file is
 * the pure half of that screen — the model it renders and the schemas
 * it posts — kept free of `server-only` so the console UI, the server
 * writes and the tests all read one copy.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE LOAD-BEARING DISTINCTION: DEFAULT vs OVERRIDE
 * ══════════════════════════════════════════════════════════════════════
 * A switch that shows only ON or OFF cannot answer the question the
 * console exists for. "Can this customer see Trust Accounting?" has FOUR
 * distinct answers and they demand different responses from an operator:
 *
 *   included_by_plan     their tier includes it. Nothing was decided
 *                        about them specifically. Turning it off is a
 *                        withdrawal of something they are PAYING for.
 *   not_in_plan          their tier does not. Turning it on is a
 *                        discount somebody has to be willing to sign.
 *   granted_by_override  a named human turned it on above the plan, on
 *                        a date, with a reason, and it expires.
 *   revoked_by_override  a named human turned it off despite the plan.
 *                        ⚠️ The customer is paying for this. Any message
 *                        offering them an upgrade is wrong.
 *
 * Collapsing those to a boolean is what makes "why can this customer see
 * that" unanswerable, and it is exactly what a plain toggle does.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ ONE FEATURE KEY CAN BE SEVERAL MENU ITEMS
 * ══════════════════════════════════════════════════════════════════════
 * `contacts`, `guests`, `patients` and `consumers` are FOUR modules in
 * the registry and ONE feature key (`crm.contacts`) — deliberately, so a
 * hospital cannot lose Patients while keeping Contacts. The consequence
 * for this screen is unavoidable and must be shown rather than
 * discovered: switching "Guests" off switches Patients, Consumers and
 * Contacts off too. `sharedWith` below carries that fact to the UI.
 */

import { z } from "zod";
import {
  FEATURE_CATALOG,
  TIER_RANK,
  TIER_LABELS,
  effectiveTier,
  isFeatureKey,
  type FeatureKey,
} from "@/lib/entitlements/features";
import { groupedModules, type ModuleDescriptor } from "@/lib/modules/registry";
import { filterNavigationByEntitlement } from "@/lib/modules/nav";
import {
  INDUSTRY_TEMPLATES,
  INDUSTRY_KEYS,
  filterNavigationByRole,
  type IndustryKey,
  type IndustryTemplate,
} from "@/lib/industry-templates";
import type { PlanTier } from "@/db/schema/core";

/* ------------------------------------------------------------------ */
/* THE RESULT ENVELOPE                                                 */
/* ------------------------------------------------------------------ */

/**
 * Structurally `PlatformResult<T>` plus one field.
 *
 * `needsStepUp` exists because `requireCapability()` THROWS
 * `PlatformAccessError("step_up_required")` for everything on the
 * step-up list, and a thrown error inside a server action reaches the
 * browser as a redacted digest — the operator sees "an error occurred"
 * and has no idea they simply need to re-confirm. The server layer
 * catches that one case and turns it into a flag the form can act on.
 */
export type ConfigResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: string;
      fieldErrors?: Record<string, string[]>;
      needsStepUp?: boolean;
    };

/* ------------------------------------------------------------------ */
/* C · THE MODULE MATRIX                                               */
/* ------------------------------------------------------------------ */

export type ModuleEntitlementState =
  /** The plan includes it and nobody has interfered. */
  | "included_by_plan"
  /** The plan does not include it and nobody has interfered. */
  | "not_in_plan"
  /** ⭐ Switched ON above the plan by platform staff. Expires. */
  | "granted_by_override"
  /** ⭐ Switched OFF despite the plan by platform staff. */
  | "revoked_by_override"
  /**
   * `feature: null` in the registry — part of what a workspace IS, not
   * something sold. Rendered without a control, because a control that
   * does nothing is worse than no control.
   */
  | "always_on";

export type ModuleRow = {
  navId: string;
  label: string;
  description: string;
  href: string;
  /** `null` for the always-on modules. */
  feature: FeatureKey | null;
  featureLabel: string | null;
  /** Cheapest tier that includes it, for the "grant is a discount" warning. */
  requiredTier: PlanTier | null;
  state: ModuleEntitlementState;
  /** What the customer can reach right now, after the override. */
  effective: boolean;
  /** What the plan alone would give them. The other half of the answer. */
  planDefault: boolean;
  /** Set only when an override row exists. */
  override: {
    enabled: boolean;
    reason: string | null;
    expiresAt: string | null;
    setByEmail: string | null;
  } | null;
  /**
   * ⚠️ OTHER MENU ITEMS THAT MOVE WITH THIS ONE. Empty for most modules;
   * non-empty means this switch is not about one menu item.
   */
  sharedWith: string[];
};

export type ModuleGroupRows = {
  group: string;
  label: string;
  modules: ModuleRow[];
};

export type ModuleMatrix = {
  planTier: PlanTier;
  /** After the trial and lapse rules. What the gate actually compares. */
  effectiveTier: PlanTier;
  subscriptionGrantsAccess: boolean;
  groups: ModuleGroupRows[];
  /** Counts for the summary line. Overrides are the number that matters. */
  totals: { visible: number; hidden: number; granted: number; revoked: number };
};

/**
 * Build the whole switchboard.
 *
 * ⚠️ THE ORDER OF THE TWO QUESTIONS IS THE SAME AS `evaluateFeature()`:
 * override first, tier second. If this file asked them in the other
 * order it would render a screen that disagrees with the gate — the
 * operator would toggle something, see no change, and reach for a
 * database client. One evaluation order, stated in both places.
 */
export function buildModuleMatrix(args: {
  planTier: PlanTier;
  subscriptionGrantsAccess: boolean;
  /** Feature key → enabled, from `entitlement:`-prefixed flag rows. */
  overrides: Readonly<
    Record<
      string,
      { enabled: boolean; reason: string | null; expiresAt: string | null; setByEmail: string | null }
    >
  >;
}): ModuleMatrix {
  const tier = effectiveTier({
    planTier: args.planTier,
    subscriptionGrantsAccess: args.subscriptionGrantsAccess,
  });

  // Built once, so `sharedWith` is a lookup rather than a nested scan.
  const byFeature = new Map<string, string[]>();
  for (const g of groupedModules()) {
    for (const m of g.modules) {
      if (!m.feature) continue;
      const list = byFeature.get(m.feature) ?? [];
      list.push(m.label);
      byFeature.set(m.feature, list);
    }
  }

  const totals = { visible: 0, hidden: 0, granted: 0, revoked: 0 };

  const groups = groupedModules().map((g) => ({
    group: g.group,
    label: g.label,
    modules: g.modules.map((mod) => {
      const row = describeModule(mod, tier, args.overrides, byFeature);
      if (row.effective) totals.visible += 1;
      else totals.hidden += 1;
      if (row.state === "granted_by_override") totals.granted += 1;
      if (row.state === "revoked_by_override") totals.revoked += 1;
      return row;
    }),
  }));

  return {
    planTier: args.planTier,
    effectiveTier: tier,
    subscriptionGrantsAccess: args.subscriptionGrantsAccess,
    groups,
    totals,
  };
}

function describeModule(
  mod: ModuleDescriptor,
  tier: PlanTier,
  overrides: Readonly<
    Record<
      string,
      { enabled: boolean; reason: string | null; expiresAt: string | null; setByEmail: string | null }
    >
  >,
  byFeature: Map<string, string[]>,
): ModuleRow {
  if (!mod.feature) {
    return {
      navId: mod.navId,
      label: mod.label,
      description: mod.description,
      href: mod.href,
      feature: null,
      featureLabel: null,
      requiredTier: null,
      state: "always_on",
      effective: true,
      planDefault: true,
      override: null,
      sharedWith: [],
    };
  }

  const definition = FEATURE_CATALOG[mod.feature];
  const planDefault = TIER_RANK[tier] >= TIER_RANK[definition.minTier];
  const override = overrides[mod.feature] ?? null;

  const state: ModuleEntitlementState = override
    ? override.enabled
      ? "granted_by_override"
      : "revoked_by_override"
    : planDefault
      ? "included_by_plan"
      : "not_in_plan";

  return {
    navId: mod.navId,
    label: mod.label,
    description: mod.description,
    href: mod.href,
    feature: mod.feature,
    featureLabel: definition.label,
    requiredTier: definition.minTier,
    state,
    effective: override ? override.enabled : planDefault,
    planDefault,
    override,
    sharedWith: (byFeature.get(mod.feature) ?? []).filter((l) => l !== mod.label),
  };
}

/** Words for a state, used in the console and in the audit metadata. */
export const MODULE_STATE_LABELS: Readonly<Record<ModuleEntitlementState, string>> =
  Object.freeze({
    included_by_plan: "Included in the plan",
    not_in_plan: "Not in the plan",
    granted_by_override: "Switched ON above the plan",
    revoked_by_override: "Switched OFF despite the plan",
    always_on: "Always available",
  });

/**
 * ⭐ GRANTING ABOVE THE PLAN NEEDS AN END DATE. REVOKING DOES NOT.
 *
 * Restated here (it also lives in `lib/entitlements/overrides.ts`)
 * because this is the copy the FORM uses to decide whether the date
 * field is required, and a form whose rule is inferred separately from
 * the server's rule is a form that eventually disagrees with it.
 */
export function grantRequiresExpiry(row: Pick<ModuleRow, "planDefault">): boolean {
  return !row.planDefault;
}

/* ------------------------------------------------------------------ */
/* D · PLAN AND LIMITS                                                 */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ HARDCODED RATHER THAN `planTierEnum.enumValues`.
 *
 * This module is imported by client components. Pulling the runtime
 * value out of `db/schema/core` would drag Drizzle's table definitions —
 * and the whole schema graph behind them — into the browser bundle.
 * `lib/platform/schemas.ts` hardcodes the same list for the same reason.
 * The `satisfies` keeps it honest: a new tier in the enum that is not
 * added here fails the type check rather than silently disappearing from
 * the dropdown.
 */
export const CONFIGURABLE_PLAN_TIERS = [
  "trial",
  "basic",
  "advanced",
  "ai",
  "enterprise",
] as const satisfies readonly PlanTier[];

export type LimitPressure = {
  used: number;
  limit: number;
  /** 0–1, capped at 1 for the bar. `null` when the limit is zero. */
  fraction: number | null;
  /** ⚠️ True when the proposed limit is BELOW what is already consumed. */
  overCommitted: boolean;
};

export function measureLimit(used: number, limit: number): LimitPressure {
  return {
    used,
    limit,
    fraction: limit > 0 ? Math.min(1, used / limit) : null,
    overCommitted: used > limit,
  };
}

/**
 * What a tier change does to the menu, without touching anything.
 *
 * Returns MODULE labels rather than feature keys: an operator on the
 * phone to a customer needs "they lose Trust Accounting and Dynamic
 * Pricing", not "they lose `accounting.trust`".
 */
export function previewTierChange(
  from: PlanTier,
  to: PlanTier,
  args: { subscriptionGrantsAccess: boolean },
): { gained: string[]; lost: string[]; sameTier: boolean } {
  const fromTier = effectiveTier({ planTier: from, ...args });
  const toTier = effectiveTier({ planTier: to, ...args });
  if (TIER_RANK[fromTier] === TIER_RANK[toTier]) {
    return { gained: [], lost: [], sameTier: true };
  }

  const gained: string[] = [];
  const lost: string[] = [];
  for (const g of groupedModules()) {
    for (const mod of g.modules) {
      if (!mod.feature) continue;
      const min = FEATURE_CATALOG[mod.feature].minTier;
      const had = TIER_RANK[fromTier] >= TIER_RANK[min];
      const has = TIER_RANK[toTier] >= TIER_RANK[min];
      if (!had && has) gained.push(mod.label);
      if (had && !has) lost.push(mod.label);
    }
  }
  return { gained, lost, sameTier: false };
}

export function tierLabel(tier: PlanTier): string {
  return TIER_LABELS[tier];
}

/* ------------------------------------------------------------------ */
/* E · INDUSTRY ASSIGNMENT                                             */
/* ------------------------------------------------------------------ */

export type TerminologyChange = {
  key: string;
  from: string | null;
  to: string | null;
};

export type IndustryPreview = {
  fromKey: IndustryKey;
  fromLabel: string;
  toKey: IndustryKey;
  toLabel: string;
  unchanged: boolean;
  /** Menu entries the customer does not have today and will have after. */
  appearing: Array<{ navId: string; label: string; note: string | null }>;
  /** Menu entries they use today and will not find tomorrow. */
  disappearing: Array<{ navId: string; label: string }>;
  /**
   * ⚠️ THE RENAMES. "Contacts" → "Guests" → "Patients" is the change
   * customers notice first and complain about loudest, because every
   * piece of training material they wrote is suddenly wrong.
   */
  terminology: TerminologyChange[];
  /** Dashboard tiles, which also come from the template. */
  dashboardAdded: string[];
  dashboardRemoved: string[];
};

/**
 * ⚠️ COMPUTED AT `tenant_owner`, AND THAT IS A DELIBERATE OVERSTATEMENT.
 *
 * Navigation is filtered by ROLE and then by ENTITLEMENT. Role depends on
 * who is looking, so there is no single true answer for "the workspace".
 * The owner's view is the SUPERSET — everything anybody in that workspace
 * could see. Previewing the widest view means an operator is never
 * surprised by an item they did not know would appear; the opposite error
 * (previewing a narrow role and missing an item) is the one that produces
 * an angry customer.
 */
const PREVIEW_ROLE = "tenant_owner";

function visibleItems(
  template: IndustryTemplate,
  allowed: Readonly<Record<string, boolean>>,
): Map<string, string> {
  const sections = filterNavigationByEntitlement(
    filterNavigationByRole(template.navigation, PREVIEW_ROLE),
    allowed,
  );
  const map = new Map<string, string>();
  for (const section of sections) {
    for (const item of section.items) map.set(item.id, item.label);
  }
  return map;
}

/**
 * What changes if this workspace is moved to another industry.
 *
 * `allowed` is the workspace's REAL entitlement map, so the preview shows
 * what THIS customer will see rather than what the template contains. An
 * industry preview built from the template alone would promise a Basic
 * customer six screens their plan does not include, and the operator
 * would repeat that promise on the phone.
 */
export function previewIndustryChange(args: {
  from: IndustryKey;
  to: IndustryKey;
  allowed: Readonly<Record<string, boolean>>;
}): IndustryPreview {
  const fromTemplate = INDUSTRY_TEMPLATES[args.from];
  const toTemplate = INDUSTRY_TEMPLATES[args.to];

  const before = visibleItems(fromTemplate, args.allowed);
  const after = visibleItems(toTemplate, args.allowed);

  /*
   * ⚠️ The "note" answers a question that otherwise arrives as a support
   * ticket a week later: the item is IN the new template, but the plan
   * does not include its feature, so it will not actually appear. Saying
   * so here is the difference between a preview and a guess.
   */
  const appearing: IndustryPreview["appearing"] = [];
  for (const [navId, label] of after) {
    if (before.has(navId)) continue;
    appearing.push({ navId, label, note: null });
  }

  /*
   * Items the new template names but the plan hides — listed separately
   * so nobody promises them.
   *
   * ⚠️ COMPARED AGAINST EVERYTHING THE OLD TEMPLATE NAMED, NOT AGAINST
   * WHAT WAS VISIBLE. This was wrong, and wrong in a way that made the
   * preview actively misleading.
   *
   * `before` holds only the items the workspace can SEE today. An item
   * that is in both templates but hidden by the plan in both is not in
   * `before` — so it was reported as "appearing", every time, on a change
   * that does not touch it. Two symptoms followed:
   *
   *   · previewing an industry against itself listed thirteen items as
   *     appearing, on a change that alters nothing at all;
   *   · on a real change, a workspace with a narrow plan saw a long list
   *     of items "appearing" that were already there and already hidden.
   *
   * An operator reading that list is being told the customer's navigation
   * is about to grow when it is not — and the fix is to compare like with
   * like: what the OLD template named, visible or not, against what the
   * NEW one names.
   */
  const namedBy = (template: IndustryTemplate): Map<string, string> => {
    const map = new Map<string, string>();
    for (const section of filterNavigationByRole(template.navigation, PREVIEW_ROLE)) {
      for (const item of section.items) map.set(item.id, item.label);
    }
    return map;
  };

  const namedBefore = namedBy(fromTemplate);
  const hiddenByPlan = new Map<string, string>();
  for (const [navId, label] of namedBy(toTemplate)) {
    if (after.has(navId)) continue;
    hiddenByPlan.set(navId, label);
  }
  for (const [navId, label] of hiddenByPlan) {
    // Already named by the old template — nothing is appearing, whether
    // or not the plan lets it through.
    if (namedBefore.has(navId)) continue;
    appearing.push({
      navId,
      label,
      note: "in the template, but the plan does not include it — it stays hidden",
    });
  }

  const disappearing = [...before.entries()]
    .filter(([navId]) => !after.has(navId))
    .map(([navId, label]) => ({ navId, label }));

  /* ---- The renames --------------------------------------------- */
  const keys = new Set([
    ...Object.keys(fromTemplate.terminology),
    ...Object.keys(toTemplate.terminology),
  ]);
  const terminology: TerminologyChange[] = [];
  for (const key of [...keys].sort()) {
    const from = fromTemplate.terminology[key] ?? null;
    const to = toTemplate.terminology[key] ?? null;
    if (from !== to) terminology.push({ key, from, to });
  }

  const fromWidgets = new Map(fromTemplate.dashboard.map((w) => [w.id, w.title]));
  const toWidgets = new Map(toTemplate.dashboard.map((w) => [w.id, w.title]));

  return {
    fromKey: args.from,
    fromLabel: fromTemplate.label,
    toKey: args.to,
    toLabel: toTemplate.label,
    unchanged: args.from === args.to,
    appearing,
    disappearing,
    terminology,
    dashboardAdded: [...toWidgets.entries()]
      .filter(([id]) => !fromWidgets.has(id))
      .map(([, title]) => title),
    dashboardRemoved: [...fromWidgets.entries()]
      .filter(([id]) => !toWidgets.has(id))
      .map(([, title]) => title),
  };
}

/** For the industry dropdown, without dragging the whole template in. */
export function industryOptions(): Array<{ key: IndustryKey; label: string }> {
  return INDUSTRY_KEYS.map((key) => ({
    key,
    label: INDUSTRY_TEMPLATES[key].label,
  }));
}

/* ------------------------------------------------------------------ */
/* F · OPERATIONAL TRIAGE                                              */
/* ------------------------------------------------------------------ */

/**
 * The four reasons a workspace needs a human today.
 *
 * ⚠️ DELIBERATELY NOT THE HEALTH SCORE. `evaluateHealth()` produces a
 * number for scanning a directory; this produces a REASON, because the
 * action differs completely: a trial ending is a sales call, a workspace
 * over its seat limit is an invoice conversation, silence is a churn
 * risk, and a suspension is a decision somebody already made and may have
 * forgotten to reverse.
 */
export const TROUBLE_KINDS = [
  "trial_ending",
  "over_limit",
  "no_activity",
  "suspended",
] as const;
export type TroubleKind = (typeof TROUBLE_KINDS)[number];

export const TROUBLE_LABELS: Readonly<Record<TroubleKind, string>> = Object.freeze({
  trial_ending: "Trial ending",
  over_limit: "Over a limit",
  no_activity: "No activity",
  suspended: "Suspended",
});

export type TroubleSignal = {
  kind: TroubleKind;
  detail: string;
  /** `act` means somebody should do something this week. */
  urgency: "act" | "watch";
};

/** Days of trial remaining below which somebody should be talking to them. */
export const TRIAL_WARNING_DAYS = 7;
/** Days of total silence before a workspace is treated as abandoned. */
export const SILENCE_DAYS = 21;

export function troubleSignals(input: {
  status: string;
  planTier: PlanTier;
  trialEndsAt: Date | null;
  seatsInUse: number;
  seatLimit: number;
  storageUsedMb: number;
  storageLimitMb: number;
  lastActivityAt: Date | null;
  createdAt: Date;
  now: Date;
}): TroubleSignal[] {
  const signals: TroubleSignal[] = [];

  if (input.status === "suspended" || input.status === "pending_deletion") {
    signals.push({
      kind: "suspended",
      detail:
        input.status === "suspended"
          ? "Locked by an administrator. Data intact and still exportable."
          : "Pending deletion.",
      urgency: "act",
    });
    // ⚠️ RETURN EARLY. A suspended workspace has no activity and may be
    // over every limit; listing those beside the suspension sends an
    // operator chasing symptoms of a decision somebody already made.
    return signals;
  }

  if (input.trialEndsAt) {
    const days = Math.ceil((input.trialEndsAt.getTime() - input.now.getTime()) / 86_400_000);
    if (days <= 0) {
      signals.push({
        kind: "trial_ending",
        detail: `Trial ended ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago and they are still on ${input.planTier}.`,
        urgency: "act",
      });
    } else if (days <= TRIAL_WARNING_DAYS) {
      signals.push({
        kind: "trial_ending",
        detail: `Trial ends in ${days} day${days === 1 ? "" : "s"}.`,
        urgency: "act",
      });
    }
  }

  if (input.seatsInUse > input.seatLimit) {
    signals.push({
      kind: "over_limit",
      detail: `${input.seatsInUse} people in a workspace sold ${input.seatLimit} seats.`,
      urgency: "act",
    });
  }
  if (input.storageUsedMb > input.storageLimitMb) {
    signals.push({
      kind: "over_limit",
      detail: `${input.storageUsedMb} MB stored against a ${input.storageLimitMb} MB limit.`,
      urgency: "act",
    });
  }

  /*
   * ⚠️ A WORKSPACE NOBODY HAS EVER SIGNED INTO IS NOT "DORMANT", IT IS AN
   * ABANDONED PROVISION — and it is a different conversation. Reporting
   * both as "no activity" hides the ones where onboarding never
   * completed, which are the ones that are still recoverable.
   */
  const reference = input.lastActivityAt ?? input.createdAt;
  const quietDays = Math.floor((input.now.getTime() - reference.getTime()) / 86_400_000);
  if (quietDays >= SILENCE_DAYS) {
    signals.push({
      kind: "no_activity",
      detail: input.lastActivityAt
        ? `Nobody has signed in for ${quietDays} days.`
        : `Created ${quietDays} days ago and nobody has ever signed in.`,
      urgency: input.lastActivityAt ? "watch" : "act",
    });
  }

  return signals;
}

/* ------------------------------------------------------------------ */
/* SCHEMAS                                                             */
/* ------------------------------------------------------------------ */

/**
 * Same shape and the same minimums as `lib/platform/schemas.ts`. Kept
 * here rather than there so this whole feature is one file to read, and
 * because the reason text on these three actions lands somewhere the
 * customer can read it — which is a stronger requirement than "not
 * empty".
 */
const uuidField = z.string().uuid("Invalid identifier.");

const justification = (min: number, what: string) =>
  z
    .string()
    .trim()
    .min(min, `Describe why, in at least ${min} characters — this is written to ${what}.`)
    .max(1000, "Keep it under 1000 characters.");

export const setModuleEntitlementSchema = z.object({
  tenantId: uuidField,
  feature: z.string().refine(isFeatureKey, "Unknown feature key."),
  /**
   * ⭐ THREE STATES, NOT A BOOLEAN, AND `clear` IS THE IMPORTANT ONE.
   *
   * A console that can only grant and revoke can never put a workspace
   * BACK on the plan's default — the best it can do is set an override
   * that happens to agree with the plan today, which then silently
   * stops agreeing the moment the customer upgrades. `clear` deletes the
   * row, so the plan governs again.
   */
  mode: z.enum(["grant", "revoke", "clear"]),
  reason: justification(15, "the customer's own audit log"),
  /** Required when granting something the plan does not include. */
  expiresAt: z
    .string()
    .datetime({ message: "Use an ISO timestamp." })
    .optional()
    .nullable(),
});

export type SetModuleEntitlementInput = z.infer<typeof setModuleEntitlementSchema>;

export const setPlanAndLimitsSchema = z.object({
  tenantId: uuidField,
  planTier: z.enum(CONFIGURABLE_PLAN_TIERS),
  // Bounds match `provisionSchema`. A seat limit of zero would lock the
  // owner out of the workspace they are paying for.
  seatLimit: z.number().int().min(1, "At least one seat.").max(10_000),
  storageLimitMb: z.number().int().min(100, "At least 100 MB.").max(1_000_000),
  /**
   * ⚠️ NOT A VALIDATION THAT REFUSES — AN ACKNOWLEDGEMENT.
   *
   * Setting a limit below current usage is sometimes exactly right: a
   * customer downgrades, and the ceiling has to move before they can be
   * billed for the smaller plan. Refusing outright would mean the console
   * cannot express a legitimate commercial decision, so the operator
   * would do it in a database client with no audit row at all.
   *
   * So the form REQUIRES this to be ticked when the new limit is below
   * what is already consumed, and the reason lands in the customer's
   * audit log either way.
   */
  acceptOverCommit: z.boolean().default(false),
  reason: justification(20, "the customer's own audit log"),
});

export type SetPlanAndLimitsInput = z.infer<typeof setPlanAndLimitsSchema>;

export const setIndustrySchema = z.object({
  tenantId: uuidField,
  industry: z.enum(INDUSTRY_KEYS as [IndustryKey, ...IndustryKey[]]),
  /**
   * Typed by the operator. A MISTAKE guard, not a security control —
   * anyone can type a slug. It is here because this is the one action in
   * the console that silently rearranges every menu a customer's whole
   * staff uses, and the failure it prevents is doing that to the wrong
   * workspace.
   */
  confirmSlug: z.string().trim().min(1, "Type the workspace address to confirm."),
  reason: justification(20, "the customer's own audit log"),
});

export type SetIndustryInput = z.infer<typeof setIndustrySchema>;
