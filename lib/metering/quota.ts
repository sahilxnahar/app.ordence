/**
 * Ordence — Usage Metrics & Quota Arithmetic
 * Version: v0.14.0-alpha (Phase 15)
 *
 * Pure and isomorphic. The usage page, the upload dialog, the server
 * recorder and Phase 16's overage invoicer all need the same answer, and a
 * second implementation anywhere is how "the dashboard said we had 200 MB
 * free" happens on the same afternoon an upload is refused.
 *
 * ══════════════════════════════════════════════════════════════════════
 * EVERY QUANTITY HERE IS `bigint`. THERE IS NO `number` THAT MEANS A SIZE.
 * ══════════════════════════════════════════════════════════════════════
 * Same discipline as `lib/billing/money.ts`, for a closely related reason.
 * A byte count is not "big enough to worry about" in the abstract — it is
 * big enough to break IEEE 754 in practice. `Number.MAX_SAFE_INTEGER` is
 * 9,007,199,254,740,991 bytes ≈ 8 PiB, which sounds unreachable until you
 * notice that the natural intermediate value in an overage calculation is
 * `bytes × price_in_paise`, and that overflows at a few terabytes.
 *
 * More immediately: a float byte count that loses its low bits produces a
 * storage figure that disagrees with `SUM(size_bytes)` by a handful of
 * bytes, which is exactly the kind of discrepancy nobody can explain and
 * everybody has to investigate.
 *
 * The only place a byte count becomes a `number` in this file is
 * `formatBytes`, which turns it into pixels — and it does the rounding in
 * bigint first.
 *
 * ══════════════════════════════════════════════════════════════════════
 * TWO KINDS OF METRIC, AND THE DIFFERENCE IS NOT COSMETIC
 * ══════════════════════════════════════════════════════════════════════
 *
 *   CUMULATIVE  emails sent, API calls, portal links created.
 *               Monotonically increasing WITHIN a billing period, reset to
 *               zero by the next period. "How many did you do this month."
 *
 *   LEVEL       bytes stored.
 *               Goes UP on upload and DOWN on delete. It is a reading, not
 *               a tally. It does not reset at a period boundary — deleting
 *               nothing on the 1st does not free a gigabyte.
 *
 * Conflating the two is the single most damaging mistake available in this
 * phase, and it is an easy one to make because both are "a number that
 * goes up". If storage were metered cumulatively, a customer who uploads a
 * 500 MB file, deletes it, and uploads it again would be recorded as using
 * 1 GB. Repeat over a year of ordinary housekeeping and a tidy, diligent
 * customer is locked out of an account containing 40 MB of live documents,
 * with a support ticket we cannot answer without a manual recount.
 *
 * So the kind is declared per metric, it is carried into the schema as two
 * separate tables, and `tests/security/metering-isolation.test.ts` asserts
 * the SQL and this file still agree about which metric is which.
 *
 * ══════════════════════════════════════════════════════════════════════
 * QUOTAS ARE ADVISORY BEFORE THEY ARE BLOCKING
 * ══════════════════════════════════════════════════════════════════════
 * This follows Phase 14's ladder (`lib/billing/access-state.ts`) rather
 * than inventing a second one: notice → warning → refuse, and the refusal
 * is always the narrowest thing that works. Specifically:
 *
 *   • Nothing here ever makes existing data unreachable. Being over a
 *     storage quota blocks the NEXT upload; it never hides a document, and
 *     it never blocks a DELETE — deleting is the remedy, and a system that
 *     blocks the remedy is a trap.
 *   • Nothing here ever blocks an export or a read. Same reasoning as
 *     `permitsExport` in Phase 14: withholding someone's data over a
 *     commercial dispute is a DPDP problem, not a collections strategy.
 *   • A metric with no plan column is MEASURED, NOT CAPPED. It is recorded
 *     for Phase 16 and for support, and it refuses nothing.
 */

/* ------------------------------------------------------------------ */
/* THE METRICS                                                         */
/* ------------------------------------------------------------------ */

/**
 * ⭐ This array is the source of the Postgres enum in
 * `db/schema/metering.ts`. It is imported there rather than retyped, for
 * the reason Phase 20 gives for `SECURITY_EVENT_TYPES`: a hand-copied list
 * drifts the first time someone adds a member to one and not the other,
 * and the symptom is an INSERT failing at runtime inside the code path
 * that records usage — i.e. in the metering, where a failure is swallowed
 * by design and therefore invisible.
 *
 * Order is not significant, but do not RENUMBER or rename: these strings
 * are stored in a column.
 */
export const USAGE_METRICS = [
  "storage_bytes",
  "emails_sent",
  "api_calls",
  "portal_links_created",
] as const;

export type UsageMetric = (typeof USAGE_METRICS)[number];

/** `level` = a reading that moves both ways. `cumulative` = a tally. */
export type MetricKind = "level" | "cumulative";

export type MetricUnit = "bytes" | "count";

/**
 * Which column on `plans` holds this metric's limit.
 *
 * ⚠️ These three columns ALREADY EXIST (Phase 11, `db/schema/billing.ts`).
 * Phase 15 reads them and adds nothing. A second copy of a quota is a
 * second place for it to be wrong, and the one the customer is enforced
 * against would not necessarily be the one the pricing page renders.
 */
export type PlanLimitField = "storageLimitMb" | "emailsPerMonth" | "apiCallsPerMonth";

export type MetricDefinition = {
  key: UsageMetric;
  kind: MetricKind;
  unit: MetricUnit;
  /** Column on `plans`, or null when the metric is measured but not capped. */
  planLimitField: PlanLimitField | null;
  /** Multiplier applied to `planLimitField` to reach the stored unit. */
  limitMultiplier: bigint;
  /** Short label for a UI row. */
  label: string;
  /** What one unit is, singular. Used to build sentences. */
  noun: string;
  /**
   * The point at which consumption is actually REFUSED, in basis points of
   * the quota — 10000 = at the limit, 15000 = at 150% of it, null = never.
   *
   * See "WHY THE THREE METRICS BLOCK AT DIFFERENT POINTS" below. This is a
   * commercial decision with a support consequence, so it is a value in a
   * table rather than an `if` somewhere in a request handler.
   */
  hardBlockBps: number | null;
  /** What the customer should do when they are over. Shown verbatim. */
  remedy: string;
};

/**
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE THREE METRICS BLOCK AT DIFFERENT POINTS
 * ══════════════════════════════════════════════════════════════════════
 *
 * STORAGE — blocks at exactly 100%, for NEW UPLOADS only.
 *   Storage is the one metric whose cost to us is unbounded and permanent:
 *   an un-refused upload is a bill we pay every month thereafter, whether
 *   or not the customer ever pays us again. It is also the one metric with
 *   an immediate, self-service remedy that costs the customer nothing —
 *   delete something. So it refuses at the limit, refuses ONLY the upload,
 *   and says how to fix it.
 *
 * EMAILS — blocks at 150%, not at 100%.
 *   Outbound email in this product is transactional: a contract sent for
 *   signature, a portal link, a ledger alert. Refusing the 501st email on
 *   a 500-email plan does not inconvenience the customer, it breaks a
 *   workflow involving a THIRD PARTY who is waiting for a document and has
 *   no idea a quota exists. The 50% headroom is enough that a normal month
 *   with a busy week never trips it, while a runaway loop still stops
 *   before it becomes a deliverability incident on our sending domain.
 *
 * API CALLS — never blocks in Phase 15.
 *   This is the metric Phase 16 turns into metered overage. Blocking it
 *   would pre-empt that pricing decision with an engineering one, and an
 *   API that starts returning 429 at an unannounced threshold is worse for
 *   an integrator than a line on an invoice. Measured, warned about,
 *   never refused.
 *
 * PORTAL LINKS — measured, not capped.
 *   `plans` has no column for it. Inventing one here would duplicate a
 *   commercial decision nobody has made yet.
 */
const DEFINITIONS: Readonly<Record<UsageMetric, MetricDefinition>> = Object.freeze({
  storage_bytes: {
    key: "storage_bytes",
    kind: "level",
    unit: "bytes",
    planLimitField: "storageLimitMb",
    // Megabytes on the plan, BYTES in the counter. 1 MB = 1,048,576 bytes
    // (MiB), matching how every file manager the customer owns reports the
    // size of the file they just uploaded. Using 1,000,000 would make our
    // number smaller than theirs and the difference is 4.8% at a gigabyte.
    limitMultiplier: 1_048_576n,
    label: "Storage",
    noun: "byte",
    hardBlockBps: 10_000,
    remedy:
      "Delete documents you no longer need, or move to a plan with more storage. " +
      "Deleting always works, even when you are over — nothing you have uploaded " +
      "is hidden or removed by us.",
  },
  emails_sent: {
    key: "emails_sent",
    kind: "cumulative",
    unit: "count",
    planLimitField: "emailsPerMonth",
    limitMultiplier: 1n,
    label: "Emails sent",
    noun: "email",
    hardBlockBps: 15_000,
    remedy:
      "Your allowance resets at the start of your next billing period. " +
      "Upgrading raises it immediately.",
  },
  api_calls: {
    key: "api_calls",
    kind: "cumulative",
    unit: "count",
    planLimitField: "apiCallsPerMonth",
    limitMultiplier: 1n,
    label: "API calls",
    noun: "API call",
    hardBlockBps: null,
    remedy:
      "Nothing is blocked. Calls above your allowance are listed on your next " +
      "invoice — check the usage page before the period ends if that matters to you.",
  },
  portal_links_created: {
    key: "portal_links_created",
    kind: "cumulative",
    unit: "count",
    planLimitField: null,
    limitMultiplier: 1n,
    label: "Portal links created",
    noun: "portal link",
    hardBlockBps: null,
    remedy: "Portal links are not limited on any plan.",
  },
});

export function metricDefinition(metric: UsageMetric): MetricDefinition {
  const definition = DEFINITIONS[metric];
  if (!definition) {
    // Reachable only if a value was read back from a column that has since
    // gained a member this build does not know about. Loud beats silent:
    // a metric that falls through to "unlimited" would quietly disable a
    // quota.
    throw new Error(`Unknown usage metric "${metric}".`);
  }
  return definition;
}

export function isUsageMetric(value: string): value is UsageMetric {
  return (USAGE_METRICS as readonly string[]).includes(value);
}

/** Metrics stored as a per-period tally (`usage_counters`). */
export const CUMULATIVE_METRICS: readonly UsageMetric[] = USAGE_METRICS.filter(
  (m) => DEFINITIONS[m].kind === "cumulative",
);

/** Metrics stored as a current reading (`usage_levels`). */
export const LEVEL_METRICS: readonly UsageMetric[] = USAGE_METRICS.filter(
  (m) => DEFINITIONS[m].kind === "level",
);

export function isCumulativeMetric(metric: UsageMetric): boolean {
  return metricDefinition(metric).kind === "cumulative";
}

export function isLevelMetric(metric: UsageMetric): boolean {
  return metricDefinition(metric).kind === "level";
}

/* ------------------------------------------------------------------ */
/* LIMITS                                                              */
/* ------------------------------------------------------------------ */

/**
 * The three quota columns from `plans`, and nothing else.
 *
 * Typed structurally rather than as `Plan` so the pricing page can pass a
 * literal and a test can pass a fixture, without either of them dragging
 * in a Drizzle row type.
 */
export type PlanQuotaLimits = {
  storageLimitMb: number;
  emailsPerMonth: number;
  apiCallsPerMonth: number;
};

/**
 * The limit for a metric in that metric's own stored unit.
 *
 * Returns `null` for a metric with no plan column — which means UNLIMITED,
 * not zero. Getting that backwards would cap an uncapped metric at nothing
 * and refuse every portal link on every plan.
 *
 * A NEGATIVE plan column is a catalogue error, not a licence to be
 * generous: it clamps to zero and the caller sees "over quota", which is
 * loud, rather than a nonsensical negative allowance, which is not.
 */
export function limitForMetric(
  metric: UsageMetric,
  limits: PlanQuotaLimits,
): bigint | null {
  const definition = metricDefinition(metric);
  if (!definition.planLimitField) return null;

  const raw = limits[definition.planLimitField];
  if (!Number.isFinite(raw)) return null;

  const whole = BigInt(Math.max(0, Math.trunc(raw)));
  return whole * definition.limitMultiplier;
}

/* ------------------------------------------------------------------ */
/* THRESHOLDS                                                          */
/* ------------------------------------------------------------------ */

/**
 * Basis points, not a float — 8000 is 80%. Same rule as `taxRateBps`: a
 * percentage held as `0.8` reintroduces the rounding problem one
 * multiplication later, and these values are compared for equality at the
 * boundary in tests.
 *
 * 80% then 95% mirrors the seat ladder (`SEAT_WARNING_THRESHOLD`) and the
 * Phase 14 access ladder: an early quiet line, then a persistent one, then
 * — for the two metrics that block at all — a refusal.
 *
 * Why 80 and not 90: on a 500 MB plan, 90% leaves 50 MB, which is one
 * scanned agreement. There has to be enough runway to act.
 */
export const QUOTA_NOTICE_BPS = 8_000;
export const QUOTA_WARNING_BPS = 9_500;
export const QUOTA_FULL_BPS = 10_000;

/**
 * The quota ladder. Deliberately the same shape and the same vocabulary as
 * `AccessLevel` in Phase 14, minus the rungs that make data unreachable —
 * because no amount of overuse should ever produce those.
 */
export const QUOTA_LEVELS = ["ok", "notice", "warning", "exceeded"] as const;
export type QuotaLevel = (typeof QUOTA_LEVELS)[number];

export const QUOTA_RANK: Readonly<Record<QuotaLevel, number>> = Object.freeze({
  ok: 0,
  notice: 1,
  warning: 2,
  exceeded: 3,
});

/* ------------------------------------------------------------------ */
/* THE COMPARISON                                                      */
/* ------------------------------------------------------------------ */

export type QuotaState = {
  metric: UsageMetric;
  kind: MetricKind;
  unit: MetricUnit;
  used: bigint;
  /** null = unlimited. Zero is a real limit and is NOT null. */
  limit: bigint | null;
  /** limit - used, floored at zero. null when unlimited. */
  remaining: bigint | null;
  /** Basis points of the limit consumed. null when unlimited. */
  usedBps: number | null;
  level: QuotaLevel;
  /** Over the limit, but possibly still permitted — see `blocksAt`. */
  isOver: boolean;
  /** The point at which consumption is refused, in the stored unit. */
  blocksAt: bigint | null;
  /** True when further consumption of THIS metric is refused. */
  isBlocked: boolean;
};

/**
 * Consumption as basis points of a limit, in exact integer arithmetic.
 *
 * `Number(used) / Number(limit)` would be wrong twice over: it converts two
 * bigints to floats (losing precision above 2^53) and then produces a value
 * whose comparison against 0.8 depends on binary rounding. Multiplying
 * first and dividing in bigint gives a number that is exact, and only then
 * is it small enough to be a `number` safely — a percentage of a quota is
 * at most a few tens of thousands.
 */
export function usedBasisPoints(used: bigint, limit: bigint): number {
  if (limit <= 0n) {
    // A zero limit with any usage is infinitely over. Reporting 0 here
    // would make every threshold comparison below read as "fine", so a
    // plan misconfigured to zero would never warn and never block —
    // exactly the failure `computeSeatState` guards against with NaN.
    return used > 0n ? Number.MAX_SAFE_INTEGER : 0;
  }
  const bps = (used * 10_000n) / limit;
  // Cap before converting: a pathological ratio would otherwise become an
  // imprecise float, and the only thing the caller does with a number this
  // large is compare it against 10000.
  return bps > 100_000_000n ? 100_000_000 : Number(bps);
}

/** Where consumption is actually refused, in the metric's stored unit. */
export function blockThreshold(metric: UsageMetric, limit: bigint | null): bigint | null {
  const { hardBlockBps } = metricDefinition(metric);
  if (hardBlockBps === null || limit === null) return null;
  return (limit * BigInt(hardBlockBps)) / 10_000n;
}

export function evaluateQuota(input: {
  metric: UsageMetric;
  used: bigint;
  limit: bigint | null;
}): QuotaState {
  const definition = metricDefinition(input.metric);

  // A negative reading is a bug upstream (a double-counted deletion), and
  // showing "-4 MB used" turns an internal drift into a customer-visible
  // one. Clamp for display; the reconciliation path fixes the stored value.
  const used = input.used < 0n ? 0n : input.used;
  const limit = input.limit;

  if (limit === null) {
    return {
      metric: definition.key,
      kind: definition.kind,
      unit: definition.unit,
      used,
      limit: null,
      remaining: null,
      usedBps: null,
      level: "ok",
      isOver: false,
      blocksAt: null,
      isBlocked: false,
    };
  }

  const bps = usedBasisPoints(used, limit);
  const remaining = limit > used ? limit - used : 0n;
  const blocksAt = blockThreshold(definition.key, limit);

  const level: QuotaLevel =
    bps >= QUOTA_FULL_BPS
      ? "exceeded"
      : bps >= QUOTA_WARNING_BPS
        ? "warning"
        : bps >= QUOTA_NOTICE_BPS
          ? "notice"
          : "ok";

  return {
    metric: definition.key,
    kind: definition.kind,
    unit: definition.unit,
    used,
    limit,
    remaining,
    usedBps: bps,
    level,
    isOver: used >= limit,
    blocksAt,
    isBlocked: blocksAt !== null && used >= blocksAt,
  };
}

/* ------------------------------------------------------------------ */
/* CAN WE CONSUME MORE?                                                */
/* ------------------------------------------------------------------ */

export type QuotaVerdict = {
  allowed: boolean;
  reason: "within" | "over_but_permitted" | "blocked" | "unlimited";
  state: QuotaState;
  /** Ready to show a customer. Never mentions permissions or seats. */
  message: string;
};

/**
 * Decide whether `amount` more of this metric may be consumed.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY BEING OVER IS NOT THE SAME AS BEING BLOCKED
 * ══════════════════════════════════════════════════════════════════════
 * `over_but_permitted` exists because the alternative is a system that
 * treats 100.0% as a cliff for every metric. That cliff is right for
 * storage — the cost is ongoing and the remedy is one click — and wrong
 * for everything else. An API integration that starts failing at midnight
 * on the 12th, with no prior notice beyond a banner nobody who wrote the
 * integration ever sees, is an outage we caused.
 *
 * So the verdict carries the distinction, and the caller decides whether
 * it is looking at a warning or a wall.
 */
export function canConsume(state: QuotaState, amount: bigint = 1n): QuotaVerdict {
  const definition = metricDefinition(state.metric);
  const wanted = amount < 0n ? 0n : amount;

  if (state.limit === null) {
    return {
      allowed: true,
      reason: "unlimited",
      state,
      message: `${definition.label} is not limited on your plan.`,
    };
  }

  const after = state.used + wanted;

  if (state.blocksAt !== null && after > state.blocksAt) {
    return {
      allowed: false,
      reason: "blocked",
      state,
      message:
        `You have used ${formatUsage(state.metric, state.used)} of your ` +
        `${formatUsage(state.metric, state.limit)} ${definition.label.toLowerCase()} allowance. ` +
        definition.remedy,
    };
  }

  if (after > state.limit) {
    return {
      allowed: true,
      reason: "over_but_permitted",
      state,
      message:
        `This takes you past your ${definition.label.toLowerCase()} allowance of ` +
        `${formatUsage(state.metric, state.limit)}. Nothing is blocked. ` +
        definition.remedy,
    };
  }

  return {
    allowed: true,
    reason: "within",
    state,
    message: `${formatUsage(state.metric, state.limit - after)} remaining.`,
  };
}

/* ------------------------------------------------------------------ */
/* HUMAN COPY                                                          */
/* ------------------------------------------------------------------ */

const BYTE_UNITS = [
  { suffix: "TB", scale: 1_099_511_627_776n },
  { suffix: "GB", scale: 1_073_741_824n },
  { suffix: "MB", scale: 1_048_576n },
  { suffix: "KB", scale: 1_024n },
] as const;

/**
 * Bytes → "1.4 GB".
 *
 * The rounding happens in bigint (`value × 10 / scale` gives tenths as an
 * exact integer) and only the final one or two digits become a `number`.
 * `Number(bytes) / 1073741824` would be fine today and wrong the first time
 * a tenant stores more than 8 PiB — but more importantly it is the habit
 * that puts a float in front of a figure someone is billed for.
 */
export function formatBytes(bytes: bigint): string {
  const negative = bytes < 0n;
  const abs = negative ? -bytes : bytes;
  const sign = negative ? "-" : "";

  for (const { suffix, scale } of BYTE_UNITS) {
    if (abs >= scale) {
      const tenths = (abs * 10n) / scale;
      const whole = tenths / 10n;
      const fraction = tenths % 10n;
      // Above 100 units the decimal is noise: "512.0 GB" reads worse than
      // "512 GB" and implies a precision the figure does not have.
      return whole >= 100n || fraction === 0n
        ? `${sign}${whole} ${suffix}`
        : `${sign}${whole}.${fraction} ${suffix}`;
    }
  }

  return `${sign}${abs} ${abs === 1n ? "byte" : "bytes"}`;
}

/** Counts with Indian grouping, matching the money formatter's locale. */
export function formatCount(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const grouped =
    abs <= BigInt(Number.MAX_SAFE_INTEGER)
      ? new Intl.NumberFormat("en-IN").format(Number(abs))
      : abs.toString();
  return `${negative ? "-" : ""}${grouped}`;
}

export function formatUsage(metric: UsageMetric, value: bigint): string {
  return metricDefinition(metric).unit === "bytes" ? formatBytes(value) : formatCount(value);
}

/**
 * The line shown beside a usage bar. `null` when there is nothing worth
 * saying — a quota at 12% does not need a sentence.
 */
export function describeQuota(state: QuotaState): string | null {
  const definition = metricDefinition(state.metric);

  if (state.limit === null || state.level === "ok") return null;

  const used = formatUsage(state.metric, state.used);
  const limit = formatUsage(state.metric, state.limit);

  if (state.level === "exceeded") {
    return state.isBlocked
      ? `${used} of ${limit} used — you are over your ${definition.label.toLowerCase()} ` +
          `allowance and new ${definition.noun}s are paused. ${definition.remedy}`
      : `${used} of ${limit} used — over your ${definition.label.toLowerCase()} ` +
          `allowance. Nothing is blocked. ${definition.remedy}`;
  }

  return (
    `${used} of ${limit} used (${Math.floor((state.usedBps ?? 0) / 100)}%). ` +
    `${formatUsage(state.metric, state.remaining ?? 0n)} left.`
  );
}

/** The worst rung across a set of metrics — what a global banner shows. */
export function worstQuotaLevel(states: readonly QuotaState[]): QuotaLevel {
  return states.reduce<QuotaLevel>(
    (worst, state) => (QUOTA_RANK[state.level] > QUOTA_RANK[worst] ? state.level : worst),
    "ok",
  );
}

/* ------------------------------------------------------------------ */
/* SERIALISATION                                                       */
/* ------------------------------------------------------------------ */

/**
 * `JSON.stringify` throws on a bigint, so a server action returning a
 * `QuotaState` crashes the moment it crosses the RSC boundary — the exact
 * problem `serializeAmount` solves for money in `lib/billing/money.ts`.
 *
 * Converted explicitly here rather than by patching `BigInt.prototype`,
 * for the same reason given there: a global prototype change alters
 * behaviour for every unrelated caller, including libraries.
 */
export type SerialisedQuotaState = Omit<QuotaState, "used" | "limit" | "remaining" | "blocksAt"> & {
  used: string;
  limit: string | null;
  remaining: string | null;
  blocksAt: string | null;
  /** Pre-rendered so the client never re-derives it and never disagrees. */
  usedLabel: string;
  limitLabel: string | null;
  message: string | null;
};

export function serialiseQuotaState(state: QuotaState): SerialisedQuotaState {
  return {
    ...state,
    used: state.used.toString(),
    limit: state.limit === null ? null : state.limit.toString(),
    remaining: state.remaining === null ? null : state.remaining.toString(),
    blocksAt: state.blocksAt === null ? null : state.blocksAt.toString(),
    usedLabel: formatUsage(state.metric, state.used),
    limitLabel: state.limit === null ? null : formatUsage(state.metric, state.limit),
    message: describeQuota(state),
  };
}

/**
 * Read a counter back out of a database row.
 *
 * `bigint` columns arrive as strings from `pg` and from some Drizzle driver
 * paths, and as bigints from others. Normalising here means no call site
 * has to know which. A `number` that is not a safe integer is REJECTED
 * rather than coerced — that value has already lost bits, and silently
 * accepting it would put the loss into a figure someone is billed for.
 */
export function toBigIntUsage(value: bigint | string | number | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Unsafe numeric usage value ${value} — counters must not arrive as floats.`);
    }
    return BigInt(value);
  }
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`Malformed usage value "${value}".`);
  }
  return BigInt(trimmed);
}
