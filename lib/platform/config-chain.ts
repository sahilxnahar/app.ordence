/**
 * Ordence — ⭐⭐⭐ THE CONFIGURATION CHAIN
 * Version: v1.46.0-alpha (Batch 47)
 *
 * Pure. No database, no clock, no I/O. Everything is an argument, so the
 * server and the screen resolve a value the same way and cannot disagree
 * about what a customer's setting actually is.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS EXISTS: THREE CONTROLS THAT LOOKED REAL AND WERE NOT
 * ══════════════════════════════════════════════════════════════════════
 * Ordence had three settings whose only home was the moment somebody
 * typed them:
 *
 *   ① THE STORAGE LIMIT. A number written straight into
 *     `tenants.storage_limit_mb`, with no record of whether it was the
 *     plan's number, a promise made in a sales call, or a typo. Six
 *     months later nobody can say which, so nobody dares change it.
 *
 *   ② THE CUSTOMER-FACING SUSPENSION MESSAGE. Collected by
 *     `suspendTenantSchema`, carried through two function calls, and
 *     dropped into an audit metadata blob. Nothing could read it back;
 *     it existed only as evidence that somebody had typed something.
 *
 *   ③ THE APPROVALS POLICY LIST. Six frozen objects rendered as prose.
 *     Nothing about a workspace could change any of it, so the screen
 *     was a poster rather than a control.
 *
 * ⚠️ THE COMMON FAULT IS NOT "NO UI". It is that a value had no
 * PROVENANCE. "Where does 8192 come from?" had no answer, so every
 * change was a guess and every review was archaeology.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE CHAIN, AND WHY THERE ARE EXACTLY THREE LAYERS
 * ══════════════════════════════════════════════════════════════════════
 *   GLOBAL DEFAULT → PLAN LEVEL → TENANT OVERRIDE → EFFECTIVE VALUE
 *
 *   GLOBAL is a code constant. It is the answer for a workspace nobody
 *   has ever thought about, and it ships in a reviewed diff.
 *
 *   PLAN is the commercial answer: what the price list promises this
 *   tier. Also a code constant, for the same reason — it is part of the
 *   product, not of one customer's relationship.
 *
 *   TENANT is the only layer that is DATA, because it is the only layer
 *   that is about one customer. It carries an actor, a reason and a
 *   timestamp, and its absence is meaningful: absence means "the plan
 *   decides", which is the one value that keeps being right after the
 *   customer upgrades.
 *
 * 🔴 THERE IS NO FOURTH LAYER, AND ADDING ONE IS A BIGGER DECISION THAN
 * IT LOOKS. Every layer doubles the number of "why is it that value?"
 * answers a support engineer has to hold in their head at 03:00.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AN OVERRIDE THAT NO LONGER PARSES IS IGNORED, LOUDLY
 * ══════════════════════════════════════════════════════════════════════
 * The tenant layer is jsonb written by an older build. If it holds
 * `"eight thousand"` where an integer is required, resolving it as zero
 * would be a confident wrong answer and throwing would take the console
 * down for the workspace that needs looking at. So the override is
 * skipped, the plan layer wins, and `invalidOverride` says exactly what
 * was found — see `resolveConfig`.
 */

import type { PlanTier } from "@/db/schema/core";

/* ------------------------------------------------------------------ */
/* SHAPES                                                              */
/* ------------------------------------------------------------------ */

/**
 * Deliberately narrow. Every key here is either a number a limit is
 * measured in or a sentence shown to a person.
 *
 * ⚠️ NO BOOLEANS AND NO OBJECTS. A boolean belongs in
 * `lib/platform/flags-catalog.ts`, which already has an expiry rule and
 * a "does this grant a paid capability" flag that this file does not;
 * an object belongs in a table. Widening this union is how a config
 * chain becomes a second, worse flag system.
 */
export type ConfigType = "integer" | "text";
export type ConfigValue = number | string;

export type ConfigLayer = "global" | "plan" | "tenant";

export const CONFIG_LAYER_LABELS: Readonly<Record<ConfigLayer, string>> = Object.freeze({
  global: "Global default",
  plan: "Plan level",
  tenant: "Workspace override",
});

/**
 * ⚠️ WRITTEN OUT AS A UNION RATHER THAN DERIVED FROM THE CATALOGUE with
 * `keyof typeof`. Deriving it is tidier and produces a circular type —
 * the catalogue is annotated with `ConfigDefinition`, which names
 * `ConfigKey`, which would be read back off the catalogue. Spelling the
 * four keys out costs one line per key and makes the union readable
 * without opening the object below.
 */
export type ConfigKey =
  | "limits.storage_mb"
  | "suspension.customer_message"
  | "offboarding.cancel_window_hours"
  | "offboarding.retention_days";

export type ConfigDefinition = {
  readonly key: ConfigKey;
  readonly type: ConfigType;
  readonly label: string;
  /** What goes wrong when this is wrong. Rendered on the screen. */
  readonly description: string;
  /** Appended when the value is formatted. `null` for text. */
  readonly unit: string | null;
  readonly globalDefault: ConfigValue;
  /**
   * ⚠️ SPARSE ON PURPOSE. A tier that is absent inherits the global
   * default rather than repeating it, so changing the global number
   * actually moves every tier that never disagreed with it.
   */
  readonly planDefaults: Partial<Readonly<Record<PlanTier, ConfigValue>>>;
  readonly min?: number;
  readonly max?: number;
  readonly maxLength?: number;
  /**
   * ⭐ WHO ACTUALLY READS THE EFFECTIVE VALUE, BY NAME.
   *
   * 🔴 THIS FIELD IS THE ANTI-DECORATION DEVICE. A config key nothing
   * consumes is exactly the fault this file was written to fix, so the
   * catalogue is forced to name its readers and the screen prints them.
   * An empty list renders as "nothing reads this yet", which is a bug
   * report on a screen rather than a lie.
   */
  readonly consumers: readonly string[];
};

/* ------------------------------------------------------------------ */
/* THE CATALOGUE                                                       */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ FOUR KEYS. NOT FORTY.
 *
 * Same argument as `APPROVAL_POLICIES`: a catalogue that grows to cover
 * every constant in the codebase is a catalogue nobody reads, and the
 * chain's value is entirely in being short enough to hold in your head.
 * Every key below is read by a named caller today.
 */
export const CONFIG_CATALOG: Readonly<Record<ConfigKey, ConfigDefinition>> = Object.freeze({
  "limits.storage_mb": Object.freeze({
    key: "limits.storage_mb",
    type: "integer",
    label: "Storage ceiling",
    description:
      "The number of megabytes this workspace may keep. Crossing it blocks new uploads and deletes nothing.",
    unit: " MB",
    globalDefault: 512,
    // The price list, as data. `trial` deliberately matches `basic`: a
    // trial that is smaller than the plan it is selling produces a
    // "it stopped working when we started paying attention" call.
    planDefaults: {
      trial: 2048,
      basic: 2048,
      advanced: 10240,
      ai: 25600,
      enterprise: 102400,
    },
    min: 100,
    max: 10_485_760,
    consumers: [
      "server/platform/configuration.ts · setPlanAndLimits writes the effective value into tenants.storage_limit_mb, which is what the upload path enforces",
    ],
  }),

  "suspension.customer_message": Object.freeze({
    key: "suspension.customer_message",
    type: "text",
    label: "Customer-facing suspension message",
    description:
      "What this workspace's users are told when they are locked out. The internal reason is never shown to them.",
    unit: null,
    globalDefault:
      "Access has been suspended by an administrator. You can still download a copy of your data. Please contact support to discuss it.",
    // An enterprise customer has a named person to call, and telling
    // them to "contact support" when they have an account manager reads
    // as being dropped.
    planDefaults: {
      enterprise:
        "Access to this workspace has been suspended. Your account manager has been notified and will contact you. You can still download a copy of your data.",
    },
    maxLength: 500,
    consumers: [
      "server/platform/tenants.ts · suspendTenant records the effective message on the suspension, and getTenantDetail shows it back",
      "⚠️ NOT the customer's own lockout banner yet — that renders evaluateAccess()'s fixed sentence in lib/billing/access-state.ts, which this batch does not own. See the note on the screen.",
    ],
  }),

  "offboarding.cancel_window_hours": Object.freeze({
    key: "offboarding.cancel_window_hours",
    type: "integer",
    label: "Termination cancel window",
    description:
      "How long after a second approver signs off a termination stays cancellable before it is due to run. This is the window that makes a triple-confirmed deletion survivable.",
    unit: " hours",
    globalDefault: 24,
    // A larger customer has more people who might notice, and more of
    // them are asleep when the request is approved.
    planDefaults: { enterprise: 72 },
    min: 1,
    max: 720,
    consumers: [
      "server/platform/tenants.ts · scheduleTenantTermination computes the scheduled moment from it and freezes it onto the record",
      "components/platform/offboarding-panel.tsx · the countdown and the cancel deadline",
    ],
  }),

  "offboarding.retention_days": Object.freeze({
    key: "offboarding.retention_days",
    type: "integer",
    label: "Post-termination retention",
    description:
      "How long the records are kept after the scheduled moment before deletion is due. The countdown a departing customer is quoted.",
    unit: " days",
    globalDefault: 30,
    planDefaults: { enterprise: 90 },
    min: 1,
    max: 3650,
    consumers: [
      "server/platform/tenants.ts · scheduleTenantTermination computes the retention deadline from it",
    ],
  }),
});

export const CONFIG_KEYS = Object.freeze(Object.keys(CONFIG_CATALOG)) as readonly ConfigKey[];

export function isConfigKey(value: unknown): value is ConfigKey {
  return typeof value === "string" && value in CONFIG_CATALOG;
}

export function configDefinition(key: ConfigKey): ConfigDefinition {
  return CONFIG_CATALOG[key];
}

/* ------------------------------------------------------------------ */
/* WHERE THE TENANT LAYER IS STORED                                    */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ A THIRD NAMESPACE IN `platform_tenant_flags`, AND THE SEPARATION IS
 * THE WHOLE POINT.
 *
 * `lib/entitlements/overrides.ts` already keeps `entitlement:` apart
 * from the flag catalogue so a beta flag can never collide with a
 * feature key and become a free upgrade nobody invoices. `config:` is
 * the same argument one more time: a configuration value is not a
 * capability, and a key that could be read as either is a key somebody
 * eventually reads as the wrong one.
 *
 * Three namespaces, three writers, one table, one RLS policy.
 */
export const CONFIG_OVERRIDE_PREFIX = "config:";

export function configOverrideKeyFor(key: ConfigKey): string {
  return `${CONFIG_OVERRIDE_PREFIX}${key}`;
}

/** `config:limits.storage_mb` → `limits.storage_mb`, or null. */
export function configKeyFromFlagKey(flagKey: string): ConfigKey | null {
  if (!flagKey.startsWith(CONFIG_OVERRIDE_PREFIX)) return null;
  const bare = flagKey.slice(CONFIG_OVERRIDE_PREFIX.length);
  return isConfigKey(bare) ? bare : null;
}

/* ------------------------------------------------------------------ */
/* PARSING                                                             */
/* ------------------------------------------------------------------ */

export type ParseOutcome =
  | { ok: true; value: ConfigValue }
  | { ok: false; error: string };

/**
 * Turn whatever is in the jsonb column — or whatever a form posted —
 * into a typed value, or say why not.
 *
 * ⚠️ `"8000"` IS ACCEPTED FOR AN INTEGER AND `8000.5` IS NOT. A form
 * posts strings and refusing them would make every save a type puzzle;
 * a fractional megabyte ceiling is a mistake and silently flooring it
 * would hide the mistake rather than the fraction.
 */
export function parseConfigValue(key: ConfigKey, raw: unknown): ParseOutcome {
  const def = configDefinition(key);

  if (def.type === "integer") {
    const candidate =
      typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
    if (!Number.isFinite(candidate)) {
      return { ok: false, error: `${def.label} must be a number.` };
    }
    if (!Number.isInteger(candidate)) {
      return { ok: false, error: `${def.label} must be a whole number.` };
    }
    if (def.min !== undefined && candidate < def.min) {
      return { ok: false, error: `${def.label} cannot be below ${def.min}.` };
    }
    if (def.max !== undefined && candidate > def.max) {
      return { ok: false, error: `${def.label} cannot be above ${def.max}.` };
    }
    return { ok: true, value: candidate };
  }

  if (typeof raw !== "string") {
    return { ok: false, error: `${def.label} must be text.` };
  }
  const text = raw.trim();
  if (text.length === 0) {
    // ⚠️ EMPTY IS NOT A VALUE, IT IS A REQUEST TO CLEAR — and clearing
    // is a different operation with a different audit row. Accepting an
    // empty string here would write "" over the plan's sentence and
    // show a suspended customer a blank explanation.
    return {
      ok: false,
      error: `${def.label} cannot be empty. Clear the override instead — that is what makes the plan decide again.`,
    };
  }
  if (def.maxLength !== undefined && text.length > def.maxLength) {
    return {
      ok: false,
      error: `${def.label} must be ${def.maxLength} characters or fewer.`,
    };
  }
  return { ok: true, value: text };
}

export function formatConfigValue(key: ConfigKey, value: ConfigValue): string {
  const def = configDefinition(key);
  if (def.type === "integer") return `${value}${def.unit ?? ""}`;
  const text = String(value);
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

/* ------------------------------------------------------------------ */
/* RESOLUTION                                                          */
/* ------------------------------------------------------------------ */

/** What the database holds for one key on one workspace, or nothing. */
export type TenantOverrideInput =
  | { present: false }
  | {
      present: true;
      /** Straight out of jsonb. Untrusted, unparsed. */
      raw: unknown;
      reason: string | null;
      setByEmail: string | null;
      setAt: string | null;
    };

export type ResolvedLayer = {
  layer: ConfigLayer;
  label: string;
  /** False for a plan with no entry and for a workspace with no override. */
  present: boolean;
  value: ConfigValue | null;
  formatted: string | null;
  /** Only the tenant layer has these. */
  reason?: string | null;
  setByEmail?: string | null;
  setAt?: string | null;
};

export type ConfigResolution = {
  key: ConfigKey;
  definition: ConfigDefinition;
  planTier: PlanTier;
  layers: readonly ResolvedLayer[];
  effective: ConfigValue;
  effectiveFormatted: string;
  effectiveLayer: ConfigLayer;
  /**
   * ⚠️ NON-NULL MEANS A STORED OVERRIDE WAS SKIPPED. The effective value
   * below is the plan's or the global one; the row is still in the
   * table and still needs a human. Never silently swallowed.
   */
  invalidOverride: string | null;
};

/**
 * The whole point of the file: one function, three layers, in order.
 *
 * ⚠️ THE ORDER IS FIXED AND NOT CONFIGURABLE. "Which layer wins" being
 * itself configurable is how a precedence system becomes unexplainable.
 */
export function resolveConfig(args: {
  readonly key: ConfigKey;
  readonly planTier: PlanTier;
  readonly override: TenantOverrideInput;
}): ConfigResolution {
  const def = configDefinition(args.key);

  const globalValue = def.globalDefault;
  const planValue = def.planDefaults[args.planTier];

  let effective: ConfigValue = planValue ?? globalValue;
  let effectiveLayer: ConfigLayer = planValue === undefined ? "global" : "plan";

  let tenantValue: ConfigValue | null = null;
  let invalidOverride: string | null = null;

  if (args.override.present) {
    const parsed = parseConfigValue(args.key, args.override.raw);
    if (parsed.ok) {
      tenantValue = parsed.value;
      effective = parsed.value;
      effectiveLayer = "tenant";
    } else {
      invalidOverride = `A workspace override is stored for ${def.label} and it cannot be used: ${parsed.error} The ${effectiveLayer === "plan" ? "plan" : "global"} value is in force until somebody fixes or clears it.`;
    }
  }

  const layers: ResolvedLayer[] = [
    {
      layer: "global",
      label: CONFIG_LAYER_LABELS.global,
      present: true,
      value: globalValue,
      formatted: formatConfigValue(args.key, globalValue),
    },
    {
      layer: "plan",
      label: `${CONFIG_LAYER_LABELS.plan} (${args.planTier})`,
      present: planValue !== undefined,
      value: planValue ?? null,
      formatted: planValue === undefined ? null : formatConfigValue(args.key, planValue),
    },
    {
      layer: "tenant",
      label: CONFIG_LAYER_LABELS.tenant,
      present: tenantValue !== null,
      value: tenantValue,
      formatted: tenantValue === null ? null : formatConfigValue(args.key, tenantValue),
      reason: args.override.present ? args.override.reason : null,
      setByEmail: args.override.present ? args.override.setByEmail : null,
      setAt: args.override.present ? args.override.setAt : null,
    },
  ];

  return {
    key: args.key,
    definition: def,
    planTier: args.planTier,
    layers,
    effective,
    effectiveFormatted: formatConfigValue(args.key, effective),
    effectiveLayer,
    invalidOverride,
  };
}

/* ------------------------------------------------------------------ */
/* ⭐⭐⭐ THE DIFF PREVIEW                                                */
/* ------------------------------------------------------------------ */

export type ConfigDiff = {
  key: ConfigKey;
  label: string;
  changed: boolean;
  from: ConfigValue;
  fromFormatted: string;
  fromLayer: ConfigLayer;
  to: ConfigValue;
  toFormatted: string;
  toLayer: ConfigLayer;
  /** One sentence, written for a person, safe to read out on a call. */
  sentence: string;
  /** Set when the save would change provenance but not the number. */
  note: string | null;
};

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 "SAVE" IS NOT A PREVIEW. THIS IS.
 * ══════════════════════════════════════════════════════════════════════
 * The failure this replaces is specific and it is not hypothetical: an
 * operator sets an override to the same number the plan already gives,
 * sees no change, assumes the form is broken, and sets it to something
 * else to "make it take". The chain then carries a fork of the price
 * list for that customer forever, for no reason anybody recorded.
 *
 * ⭐ SO THE SENTENCE NAMES THE WORKSPACE AND BOTH VALUES: "effective
 * value for Acme changes from 2048 MB to 8192 MB". An operator who
 * cannot read that sentence back to a customer should not be saving.
 *
 * ⚠️ AND IT IS COMPUTED FROM THE SAME `resolveConfig` THE SERVER USES.
 * A preview with its own arithmetic is a preview that eventually lies.
 */
export function diffConfigChange(args: {
  readonly key: ConfigKey;
  readonly planTier: PlanTier;
  readonly tenantLabel: string;
  readonly before: TenantOverrideInput;
  readonly after: TenantOverrideInput;
}): ConfigDiff {
  const def = configDefinition(args.key);
  const before = resolveConfig({ key: args.key, planTier: args.planTier, override: args.before });
  const after = resolveConfig({ key: args.key, planTier: args.planTier, override: args.after });

  const changed = before.effective !== after.effective;

  const sentence = changed
    ? `Effective value for ${args.tenantLabel} changes from ${before.effectiveFormatted} to ${after.effectiveFormatted}.`
    : `Effective value for ${args.tenantLabel} stays ${after.effectiveFormatted}.`;

  /*
   * ⚠️ PROVENANCE CAN MOVE WITHOUT THE NUMBER MOVING, AND THAT IS NOT
   * NOTHING. An override pinned to today's plan value stops following
   * the plan: the customer upgrades, the tier's ceiling rises, and this
   * one workspace silently keeps the old number. That is the same
   * failure `setModuleEntitlement` deletes rather than writes a row for,
   * and it is worth a sentence rather than a silent save.
   */
  let note: string | null = null;
  if (!changed && before.effectiveLayer !== after.effectiveLayer) {
    note =
      after.effectiveLayer === "tenant"
        ? `The number does not move, but it stops following the ${args.planTier} plan. If the plan's ${def.label.toLowerCase()} changes later, this workspace will not follow it.`
        : `The number does not move, but the workspace override is removed, so it follows the ${args.planTier} plan again.`;
  }

  return {
    key: args.key,
    label: def.label,
    changed,
    from: before.effective,
    fromFormatted: before.effectiveFormatted,
    fromLayer: before.effectiveLayer,
    to: after.effective,
    toFormatted: after.effectiveFormatted,
    toLayer: after.effectiveLayer,
    sentence,
    note,
  };
}

/* ------------------------------------------------------------------ */
/* VERSIONS                                                            */
/* ------------------------------------------------------------------ */

/**
 * One recorded change, read back from the customer's own audit log.
 *
 * ⚠️ THERE IS NO `config_versions` TABLE AND THERE SHOULD NOT BE. The
 * same argument `guard.ts` makes about not splitting the audit trail:
 * a second history table is a second thing a reviewer has to trust is
 * complete. `audit_logs` is append-only, already carries the actor, the
 * old value, the new value and the reason, and is already visible to
 * the customer — which is exactly who else is entitled to this history.
 */
export type ConfigVersion = {
  key: ConfigKey;
  at: string;
  actorEmail: string | null;
  fromFormatted: string | null;
  toFormatted: string | null;
  reason: string | null;
};
