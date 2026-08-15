/**
 * Ordence — Tenant Feature Flag Catalogue
 * Version: v0.14.0-alpha
 *
 * Pure. The console renders from this and the server validates against
 * it, so an operator cannot invent a flag key by typing one into a form.
 *
 * ══════════════════════════════════════════════════════════════════════
 * A CLOSED SET, NOT FREE TEXT — AND WHY THAT MATTERS MORE THAN IT LOOKS
 * ══════════════════════════════════════════════════════════════════════
 * The tempting design is `flag_key text` with no catalogue: fastest to
 * ship, and every flag anyone ever needs works immediately. What it
 * actually produces is `newBilling`, `new_billing` and `new-billing` all
 * live in the same table, two of them on different customers, and no
 * reliable way to answer "which workspaces have the new billing flow?" —
 * which is the only question the table exists to answer.
 *
 * Worse: a typo'd key is a flag that reads as OFF forever. The customer
 * was told it was enabled. Nobody finds out until they complain.
 *
 * ══════════════════════════════════════════════════════════════════════
 * FLAGS ARE NOT ENTITLEMENTS. THE BOUNDARY IS ENFORCED HERE.
 * ══════════════════════════════════════════════════════════════════════
 * `lib/entitlements/features.ts` decides what a PLAN includes. This file
 * decides what is SWITCHED ON for one workspace right now. If a flag
 * could permanently grant a paid feature, the price list would quietly
 * move into a table with no invoice attached to it.
 *
 * So every flag declares `grantsPaidCapability`. When that is true the
 * console REQUIRES an expiry date — an early-access grant is a trial with
 * an end, not a discount nobody signed off.
 */

export type FlagDefinition = {
  label: string;
  description: string;
  /**
   * True when turning this on gives the workspace something a plan would
   * otherwise charge for. Forces an expiry.
   */
  grantsPaidCapability: boolean;
  /**
   * True when the flag REMOVES capability (a kill switch). These are
   * exempt from the expiry requirement — a switch turned off because it
   * is breaking a customer should stay off until somebody fixes it.
   */
  isKillSwitch: boolean;
};

export const FLAG_CATALOG = {
  "beta.ai_assistant": {
    label: "AI assistant (beta)",
    description: "Early access to the assistant panel before it ships on the AI tier.",
    grantsPaidCapability: true,
    isKillSwitch: false,
  },
  "beta.custom_objects_v2": {
    label: "Custom objects v2 (beta)",
    description: "The rebuilt dynamic object engine for this workspace only.",
    grantsPaidCapability: true,
    isKillSwitch: false,
  },
  "beta.advanced_reporting": {
    label: "Advanced reporting (beta)",
    description: "Pre-release analytics views.",
    grantsPaidCapability: true,
    isKillSwitch: false,
  },
  "limits.seat_override": {
    label: "Seat limit override",
    description:
      "Temporarily lift the seat ceiling while a contract is being signed. Value: { seats: number }.",
    grantsPaidCapability: true,
    isKillSwitch: false,
  },
  "killswitch.telemetry": {
    label: "Disable telemetry",
    description: "Stop client telemetry for a workspace that has asked us to.",
    grantsPaidCapability: false,
    isKillSwitch: true,
  },
  "killswitch.email_notifications": {
    label: "Disable outbound email",
    description:
      "Stop all transactional email to this workspace — used when a mail loop is hitting a customer.",
    grantsPaidCapability: false,
    isKillSwitch: true,
  },
  "support.verbose_errors": {
    label: "Verbose errors",
    description:
      "Show full error detail in this workspace's UI while a bug is being reproduced.",
    grantsPaidCapability: false,
    isKillSwitch: false,
  },
} as const satisfies Record<string, FlagDefinition>;

export type FlagKey = keyof typeof FLAG_CATALOG;

export const FLAG_KEYS = Object.keys(FLAG_CATALOG) as FlagKey[];

/* ------------------------------------------------------------------ */
/* ⭐ THE ENTITLEMENT NAMESPACE                                         */
/* ------------------------------------------------------------------ */

/**
 * 🔴 WHY THIS EXISTS.
 *
 * `applyEntitlementChange` has always built a key of the shape
 * `entitlement:<featureKey>` and handed it to `setTenantFlag`. That
 * schema took `z.enum(FLAG_KEYS)`, which contains seven `beta.*`,
 * `limits.*`, `killswitch.*` and `support.*` keys and no entitlement,
 * so EVERY entitlement override and every revert returned "Check the
 * form." with no field to fix. The screen, the history table
 * (`platform_entitlement_history`), the verify-on-fresh-read and the
 * undo path were all unreachable.
 *
 * ⚠️ THE CATALOGUE STAYS CLOSED. An entitlement key is not an invented
 * flag: the feature key comes from the module registry, and this
 * namespace is the one place a key is allowed to be constructed rather
 * than enumerated.
 */
export const ENTITLEMENT_FLAG_PREFIX = "entitlement:" as const;

export type EntitlementFlagKey = `entitlement:${string}`;

/** Any key `platform_tenant_flags` accepts. */
export type TenantFlagKey = FlagKey | EntitlementFlagKey;

export function isEntitlementFlagKey(value: unknown): value is EntitlementFlagKey {
  return (
    typeof value === "string" &&
    value.startsWith(ENTITLEMENT_FLAG_PREFIX) &&
    /^entitlement:[a-z0-9][a-z0-9._-]{0,110}$/.test(value)
  );
}

export function isFlagKey(value: unknown): value is TenantFlagKey {
  if (typeof value !== "string") return false;
  return value in FLAG_CATALOG || isEntitlementFlagKey(value);
}

/**
 * The definition for any accepted key.
 *
 * ⚠️ AN ENTITLEMENT OVERRIDE GRANTS PAID CAPABILITY AND IS NOT FORCED
 * TO EXPIRE, which is the one place this differs from a `beta.*` flag.
 * The control on an entitlement is not a clock: every change writes a
 * row to `platform_entitlement_history` with a before, an after, a
 * named operator and a written reason, and the revert path is a NEW row
 * rather than a deletion. A deal that includes a module indefinitely is
 * a real thing to sell; a beta flag left on for a year is an accident.
 */
export function flagDefinitionFor(key: string): FlagDefinition | null {
  if (key in FLAG_CATALOG) return FLAG_CATALOG[key as FlagKey];
  if (isEntitlementFlagKey(key)) {
    const feature = key.slice(ENTITLEMENT_FLAG_PREFIX.length);
    return {
      label: `Entitlement override — ${feature}`,
      description:
        `Grants or removes the "${feature}" module for this workspace, ` +
        `independently of its plan. Recorded in the entitlement history.`,
      grantsPaidCapability: true,
      isKillSwitch: false,
    };
  }
  return null;
}

export function describeFlag(key: string): string {
  return flagDefinitionFor(key)?.label ?? key;
}

/**
 * Flags that grant paid capability MUST expire.
 *
 * Returns an error string rather than throwing so the form can show it
 * next to the field. The server re-checks — this is not a client-side
 * validation, it is a shared one.
 */
export function validateFlagExpiry(
  key: string,
  expiresAt: Date | null,
): string | null {
  const def = flagDefinitionFor(key);
  if (!def) return `Unknown flag "${key}".`;

  // ⚠️ THE PAST-DATE CHECK COMES FIRST, BEFORE THE KILL-SWITCH EXEMPTION.
  // An earlier version returned early for kill switches and therefore
  // accepted an expiry already in the past — which reads as "enabled"
  // in the form and as "off" everywhere that evaluates it, because
  // expiry is applied in the query. A kill switch that silently does
  // nothing is the worst possible kind: it is turned on during an
  // incident and quietly ignored.
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    return "The end date is in the past.";
  }

  // Kill switches are exempt from the REQUIREMENT to carry an expiry: a
  // switch turned off because it is breaking a customer should stay off
  // until somebody fixes the cause.
  if (def.isKillSwitch) return null;

  // ⚠️ So are entitlement overrides. See `flagDefinitionFor` — their
  // control is the history table and the revert path, not a clock.
  if (isEntitlementFlagKey(key)) return null;

  if (def.grantsPaidCapability && !expiresAt) {
    return "This flag grants a paid capability, so it needs an end date.";
  }
  return null;
}
