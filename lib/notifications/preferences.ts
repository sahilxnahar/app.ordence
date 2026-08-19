/**
 * Ordence — Notification preferences: ONE definition, read by both sides
 * Version: v1.53.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS FILE IS PURE, AND WHY THAT IS THE WHOLE POINT
 * ══════════════════════════════════════════════════════════════════════
 * Before this, the settings screen owned the category list, the default
 * values and the severity ordering — in a `"use client"` file, in
 * `localStorage`. The mail sender owned none of it and could not have
 * read it if it did.
 *
 * Two readers with two copies of a rule is the shape where a preference
 * silently stops being honoured: somebody adds a category to the form,
 * nobody adds it to the sender, and the switch works visually forever.
 *
 * So the form and `server/notifications/create.ts` import the SAME
 * module. No `server-only`, no I/O, no database types — it has to be
 * importable from a client component and from a background worker
 * alike.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ EVERY FUNCTION HERE IS TOTAL. NOTHING THROWS.
 * ══════════════════════════════════════════════════════════════════════
 * `users.preferences` is USER-CONTROLLED JSONB and it is read ON THE
 * SEND PATH. If parsing could throw, a single malformed row — a stale
 * shape from an older release, a hand-edited column, a half-written
 * value — would not merely mis-deliver that user's mail. It would
 * reject the whole `Promise.allSettled` batch's construction and take
 * out the notification for every other recipient in the workspace.
 *
 * ⭐ THE RULE APPLIED THROUGHOUT: an unreadable value is not an error,
 *    it is an ABSENT value, and an absent value takes the default. A
 *    preference system that fails closed on junk stops delivering
 *    critical alerts; one that fails to the default keeps delivering
 *    them. The user's explicit choices are honoured where they parse
 *    and only where they parse.
 */

/* ------------------------------------------------------------------ */
/* CATEGORIES                                                          */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THESE KEYS ARE THE ONES `createNotification()` IS CALLED WITH.
 * The label and description are here rather than in the form because
 * the sender needs the KEY SET and the form needs the prose, and a
 * split would let the two drift — which is the defect this batch is
 * about, in miniature.
 */
export const NOTIFICATION_CATEGORIES = [
  { key: "compliance", label: "Compliance", description: "GST deadlines, licence expirations, overdue tasks" },
  { key: "finance", label: "Finance", description: "Receivables aging, reconciliation drift, payment events" },
  { key: "gst", label: "GST", description: "GSTR-2B reconciliation, ITC at risk, filing reminders" },
  { key: "receivables", label: "Receivables", description: "Overdue demands, collections, dunning events" },
  { key: "inventory", label: "Inventory", description: "Low stock alerts, reorder triggers" },
  { key: "field_ops", label: "Field operations", description: "Site labour anomalies, repeat visits" },
  { key: "system", label: "System", description: "Platform events, user changes, security alerts" },
] as const;

export type NotificationCategoryKey = (typeof NOTIFICATION_CATEGORIES)[number]["key"];

const CATEGORY_KEYS: readonly string[] = NOTIFICATION_CATEGORIES.map((c) => c.key);

/* ------------------------------------------------------------------ */
/* SEVERITY                                                            */
/* ------------------------------------------------------------------ */

export const NOTIFICATION_SEVERITIES = [
  { key: "critical", label: "Critical only", description: "Only receive critical alerts" },
  { key: "warning", label: "Critical and warnings", description: "Receive critical and warning alerts" },
  { key: "info", label: "Everything", description: "Receive all notifications including info" },
] as const;

export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number]["key"];

/**
 * ⚠️ RANK, NOT ARRAY POSITION. `minSeverity` is a FLOOR: choosing
 * "warning" means warning AND critical. Comparing list indexes would
 * invert that the first time somebody reorders the list for the UI.
 */
const SEVERITY_RANK: Record<NotificationSeverity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

function isSeverity(value: unknown): value is NotificationSeverity {
  return value === "critical" || value === "warning" || value === "info";
}

/* ------------------------------------------------------------------ */
/* THE SHAPE                                                           */
/* ------------------------------------------------------------------ */

export type NotificationPreferences = {
  /** Email delivery in addition to the in-app bell. */
  emailEnabled: boolean;
  /** Floor: notifications below this severity are not delivered by email. */
  minSeverity: NotificationSeverity;
  /**
   * ⚠️ EVERY known key is always present after parsing. The sender never
   * has to distinguish "off" from "absent", which is precisely the
   * distinction a `Record<string, boolean | undefined>` invites somebody
   * to get backwards under `noUncheckedIndexedAccess`.
   */
  categories: Record<NotificationCategoryKey, boolean>;
};

/**
 * ⭐ DEFAULTS ARE DELIBERATELY PERMISSIVE, AND THIS IS A SAFETY CHOICE.
 * A user who has never opened the settings screen must still receive the
 * GST deadline and the overdue-payment alert. Silence is the dangerous
 * default in a compliance product: the user cannot notice mail that
 * never arrives.
 *
 * `warning` rather than `info` for the floor because it mirrors what the
 * sender already does — `createNotification()` only emails critical and
 * warning — so the shipped default changes nobody's mail volume on the
 * day this lands.
 */
function defaultCategories(): Record<NotificationCategoryKey, boolean> {
  const out = {} as Record<NotificationCategoryKey, boolean>;
  for (const category of NOTIFICATION_CATEGORIES) out[category.key] = true;
  return out;
}

export function defaultNotificationPreferences(): NotificationPreferences {
  return { emailEnabled: true, minSeverity: "warning", categories: defaultCategories() };
}

/** The key inside `users.preferences` that this family owns. */
export const NOTIFICATION_PREFERENCES_KEY = "notifications";

/* ------------------------------------------------------------------ */
/* PARSING                                                             */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    /*
     * ⚠️ A JSONB COLUMN CAN LEGITIMATELY HOLD A JSON STRING, and some
     * drivers hand back the whole column as text. Both are recoverable,
     * so both are tried once — and only once, so a pathological
     * `"\"\\\"...\""` cannot spin.
     */
    try {
      const reparsed: unknown = JSON.parse(value);
      return typeof reparsed === "object" && reparsed !== null && !Array.isArray(reparsed)
        ? (reparsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Resolve stored JSONB into a complete, valid preference set.
 *
 * ⚠️ ACCEPTS `unknown` ON PURPOSE. Callers pass a Drizzle jsonb column
 * whose static type is a promise the database does not keep. Typing the
 * parameter as the stored shape would move the lie one level up and
 * remove the reason this function exists.
 *
 * @param raw the whole `users.preferences` value, or its `notifications`
 *            sub-object, or null, or nonsense.
 */
export function parseNotificationPreferences(raw: unknown): NotificationPreferences {
  const defaults = defaultNotificationPreferences();

  const root = asRecord(raw);
  if (!root) return defaults;

  /*
   * ⭐ TOLERATES BOTH NESTINGS. Callers that already narrowed to the
   * `notifications` sub-object and callers that hand over the whole
   * column both get the right answer. The nested form wins when present,
   * because that is what this module writes.
   */
  const nested = asRecord(root[NOTIFICATION_PREFERENCES_KEY]);
  const source = nested ?? root;

  const emailEnabled =
    typeof source["emailEnabled"] === "boolean" ? source["emailEnabled"] : defaults.emailEnabled;

  const rawSeverity = source["minSeverity"];
  const minSeverity = isSeverity(rawSeverity) ? rawSeverity : defaults.minSeverity;

  /*
   * ⚠️ THE CATEGORY MAP IS REBUILT FROM THE KNOWN KEYS, NEVER COPIED.
   * Iterating the stored object would carry unknown keys straight into
   * the returned value, and an unknown key in a preference set is an
   * injection surface pointed at whatever reads it next. Unknown keys
   * are read, found to be unknown, and dropped. A key we know but whose
   * value is not a boolean is treated as never set.
   */
  const storedCategories = asRecord(source["categories"]);
  const categories = defaultCategories();
  if (storedCategories) {
    for (const key of CATEGORY_KEYS) {
      const value = storedCategories[key];
      if (typeof value === "boolean") categories[key as NotificationCategoryKey] = value;
    }
  }

  return { emailEnabled, minSeverity, categories };
}

/**
 * The value to persist under `users.preferences`.
 *
 * ⚠️ MERGES INTO THE EXISTING COLUMN rather than replacing it. The
 * column is shared with every future preference family; writing only
 * our own key means saving notifications cannot erase a setting this
 * release has never heard of. Same rule the workspace settings form
 * already follows for `tenants.settings`.
 */
export function mergeNotificationPreferences(
  existing: unknown,
  prefs: NotificationPreferences,
): Record<string, unknown> {
  const root = asRecord(existing) ?? {};
  return { ...root, [NOTIFICATION_PREFERENCES_KEY]: prefs };
}

/* ------------------------------------------------------------------ */
/* THE DECISION THE SENDER ASKS FOR                                    */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE FUNCTION THIS WHOLE BATCH EXISTS TO MAKE CALLABLE.
 *
 * Returns whether this user wants an EMAIL for this notification. It
 * deliberately says nothing about the in-app bell: the bell is the
 * record of what happened in the workspace and suppressing rows there
 * would lose information, whereas mail is a delivery choice.
 *
 * ⚠️ AN UNKNOWN CATEGORY DELIVERS. A worker that starts emitting
 * `category: "payroll"` before the form learns about it must not have
 * its alerts silently swallowed by a preference nobody could have set.
 * Unknown means "not opted out of".
 */
export function shouldEmailNotification(
  prefs: NotificationPreferences,
  notification: { category: string; severity: string },
): boolean {
  if (!prefs.emailEnabled) return false;

  const severity: NotificationSeverity = isSeverity(notification.severity)
    ? notification.severity
    : "critical";
  if (SEVERITY_RANK[severity] < SEVERITY_RANK[prefs.minSeverity]) return false;

  if (!CATEGORY_KEYS.includes(notification.category)) return true;
  return prefs.categories[notification.category as NotificationCategoryKey];
}
