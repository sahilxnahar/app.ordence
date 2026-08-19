/**
 * Ordence — ⭐⭐⭐ BATCH 135: PREFERENCES THE SERVER CAN READ
 * Version: v1.53.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE TWO TESTS THIS FILE EXISTS FOR
 * ══════════════════════════════════════════════════════════════════════
 * ① `users.preferences` IS USER-CONTROLLED JSONB READ ON A MAIL SEND
 *    PATH. If parsing it could throw, one hand-edited or stale row would
 *    not merely mis-deliver that user's mail — it would abort the
 *    recipient list and lose the notification for everybody else in the
 *    workspace. So malformed and unknown input must resolve to safe
 *    defaults, never raise.
 *
 * ② THE SAVE ACTION MUST NOT WRITE ANOTHER USER'S ROW. Switching off a
 *    colleague's alerts is a silent attack: the victim's only symptom is
 *    mail that stops arriving, and nobody reports mail that does not
 *    arrive.
 *
 * ⚠️ ASSERTIONS ARE ABOUT PROPERTIES, NOT STRINGS. Nothing here pins an
 * exact sentence, href, path or literal count. The category catalogue is
 * read from the module rather than restated, so adding a category does
 * not break a test that has no opinion about how many there are.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/* ================================================================== */
/* THE FAKE DATABASE                                                   */
/* ================================================================== */

/**
 * Records every `where(...)` argument and every `set(...)` payload, so a
 * test can ask WHAT WAS ASKED rather than trusting a fake to evaluate a
 * drizzle condition tree it does not understand. Reading the question is
 * the stronger assertion anyway: it fails if the code pins the wrong id,
 * even when the fake would have returned the same rows either way.
 */
/**
 * ⚠️ EVERYTHING THE `vi.mock` FACTORIES TOUCH LIVES INSIDE `vi.hoisted`.
 * `vi.mock` is hoisted above the imports, so a factory that closes over
 * an ordinary top-level `const` reads it in the temporal dead zone and
 * the suite fails to collect at all — which looks like a broken test
 * rather than a broken mock.
 */
const h = vi.hoisted(() => {
  const state = {
    wheres: [] as unknown[],
    sets: [] as Record<string, unknown>[],
    updateCalls: 0,
    storedPreferences: undefined as unknown,
  };

  class FakeSelect {
    from() {
      return this;
    }
    where(...args: unknown[]) {
      state.wheres.push(args);
      return this;
    }
    limit() {
      return Promise.resolve([{ preferences: state.storedPreferences }]);
    }
  }

  class FakeUpdate {
    set(values: Record<string, unknown>) {
      state.sets.push(values);
      return this;
    }
    where(...args: unknown[]) {
      state.wheres.push(args);
      return this;
    }
    returning() {
      const last = state.sets[state.sets.length - 1];
      return Promise.resolve([{ preferences: last?.["preferences"] }]);
    }
  }

  const tx = {
    select: () => new FakeSelect(),
    update: () => {
      state.updateCalls += 1;
      return new FakeUpdate();
    },
  };

  /** The session identity. Nothing the caller sends may replace it. */
  const SESSION_USER_ID = "11111111-1111-1111-1111-111111111111";
  const SESSION_TENANT_ID = "22222222-2222-2222-2222-222222222222";

  return { state, tx, SESSION_USER_ID, SESSION_TENANT_ID };
});

const state = h.state;
const SESSION_USER_ID = h.SESSION_USER_ID;
const SESSION_TENANT_ID = h.SESSION_TENANT_ID;
const VICTIM_USER_ID = "99999999-9999-9999-9999-999999999999";
const FORGED_TENANT_ID = "33333333-3333-3333-3333-333333333333";

/** Pull every string literal out of a drizzle condition tree. */
function literalsIn(value: unknown, seen: Set<unknown> = new Set(), depth = 0): string[] {
  if (depth > 30 || value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) return value.flatMap((v) => literalsIn(v, seen, depth + 1));
  return Object.values(value as Record<string, unknown>).flatMap((v) =>
    literalsIn(v, seen, depth + 1),
  );
}

vi.mock("@/db", () => ({
  db: h.tx,
  withTenant: (_tenantId: string, cb: (t: typeof h.tx) => unknown) => cb(h.tx),
}));

vi.mock("@/server/audit", () => ({
  requirePermission: vi.fn(async () => ({
    tenant: { id: h.SESSION_TENANT_ID },
    user: { id: h.SESSION_USER_ID },
  })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  NOTIFICATION_CATEGORIES,
  defaultNotificationPreferences,
  mergeNotificationPreferences,
  parseNotificationPreferences,
  shouldEmailNotification,
} from "@/lib/notifications/preferences";
import { saveNotificationPreferences } from "@/server/actions/notification-preferences";

const FIRST_CATEGORY = NOTIFICATION_CATEGORIES[0]!.key;

beforeEach(() => {
  state.wheres = [];
  state.sets = [];
  state.updateCalls = 0;
  state.storedPreferences = {};
});

/* ================================================================== */
/* ① MALFORMED AND UNKNOWN JSONB                                       */
/* ================================================================== */

describe("parseNotificationPreferences is total", () => {
  /**
   * 🔴 LOAD-BEARING. Every one of these is a value that could really be
   * in the column: a NULL row, a legacy array, a double-encoded string,
   * a shape from a release that spelled the keys differently. None may
   * throw, and each must produce a preference set the sender can use.
   */
  const junk: unknown[] = [
    null,
    undefined,
    "",
    "not json at all",
    "{",
    '"a bare json string"',
    42,
    true,
    [],
    [{ emailEnabled: false }],
    {},
    { notifications: null },
    { notifications: "nonsense" },
    { notifications: [] },
    { emailEnabled: "yes", minSeverity: "urgent", categories: "all" },
    { notifications: { categories: { [FIRST_CATEGORY]: "off" } } },
    { notifications: { minSeverity: 7, emailEnabled: 0, categories: [1, 2, 3] } },
    { notifications: { unknownFamily: { deeply: { nested: true } } } },
  ];

  it.each(junk.map((v, i) => [i, v] as const))(
    "resolves case %i to the defaults without throwing",
    (_i, value) => {
      const parsed = parseNotificationPreferences(value);
      expect(parsed).toEqual(defaultNotificationPreferences());
    },
  );

  it("never carries an unknown key into the parsed category map", () => {
    const parsed = parseNotificationPreferences({
      notifications: {
        categories: {
          [FIRST_CATEGORY]: false,
          "__proto__pollution": true,
          "a-category-that-does-not-exist": false,
        },
      },
    });

    const known = new Set(NOTIFICATION_CATEGORIES.map((c) => c.key));
    for (const key of Object.keys(parsed.categories)) expect(known.has(key as never)).toBe(true);
    // The one key it DID recognise still took effect.
    expect(parsed.categories[FIRST_CATEGORY]).toBe(false);
  });

  it("keeps the values it can read when only some of them are junk", () => {
    const parsed = parseNotificationPreferences({
      notifications: { emailEnabled: false, minSeverity: "not-a-severity" },
    });
    expect(parsed.emailEnabled).toBe(false);
    expect(parsed.minSeverity).toBe(defaultNotificationPreferences().minSeverity);
  });

  it("merging preserves preference families it has never heard of", () => {
    const merged = mergeNotificationPreferences(
      { someFutureFamily: { density: "compact" } },
      defaultNotificationPreferences(),
    );
    expect(merged["someFutureFamily"]).toEqual({ density: "compact" });
  });
});

/* ================================================================== */
/* THE SEND DECISION                                                   */
/* ================================================================== */

describe("shouldEmailNotification", () => {
  it("delivers by default, because silence is the dangerous failure", () => {
    const prefs = parseNotificationPreferences(null);
    expect(shouldEmailNotification(prefs, { category: FIRST_CATEGORY, severity: "critical" })).toBe(
      true,
    );
  });

  it("honours a switched-off category", () => {
    const prefs = parseNotificationPreferences({
      notifications: { categories: { [FIRST_CATEGORY]: false } },
    });
    expect(shouldEmailNotification(prefs, { category: FIRST_CATEGORY, severity: "critical" })).toBe(
      false,
    );
  });

  it("honours email delivery being off regardless of severity", () => {
    const prefs = parseNotificationPreferences({
      notifications: { emailEnabled: false, minSeverity: "info" },
    });
    expect(shouldEmailNotification(prefs, { category: FIRST_CATEGORY, severity: "critical" })).toBe(
      false,
    );
  });

  it("treats minimum severity as a floor, not an exact match", () => {
    const prefs = parseNotificationPreferences({ notifications: { minSeverity: "warning" } });
    expect(shouldEmailNotification(prefs, { category: FIRST_CATEGORY, severity: "critical" })).toBe(
      true,
    );
    expect(shouldEmailNotification(prefs, { category: FIRST_CATEGORY, severity: "info" })).toBe(
      false,
    );
  });

  it("delivers a category nobody could have opted out of", () => {
    const prefs = parseNotificationPreferences({
      notifications: { categories: { [FIRST_CATEGORY]: false } },
    });
    expect(
      shouldEmailNotification(prefs, { category: "a-brand-new-worker", severity: "critical" }),
    ).toBe(true);
  });
});

/* ================================================================== */
/* ② THE SAVE ACTION WRITES ONLY THE CALLER'S OWN ROW                  */
/* ================================================================== */

describe("saveNotificationPreferences ownership", () => {
  /**
   * 🔴 LOAD-BEARING. The payload names a victim in every way a caller
   * could try: `userId`, `id`, `tenantId`. The property asserted is that
   * NONE of those strings reaches the statement — not that the action
   * returned an error, because the correct behaviour is to succeed for
   * the CALLER while ignoring the smuggled id entirely.
   */
  it("ignores a user id smuggled into the payload and pins the session's own id", async () => {
    const result = await saveNotificationPreferences({
      emailEnabled: false,
      minSeverity: "info",
      categories: { [FIRST_CATEGORY]: false },
      // Fields the action's type does not have, sent anyway — as an
      // attacker would, since the wire format is JSON, not TypeScript.
      userId: VICTIM_USER_ID,
      id: VICTIM_USER_ID,
      tenantId: FORGED_TENANT_ID,
    } as never);

    expect(result.ok).toBe(true);

    const asked = state.wheres.flatMap((w) => literalsIn(w));
    expect(asked).toContain(SESSION_USER_ID);
    expect(asked).toContain(SESSION_TENANT_ID);
    expect(asked).not.toContain(VICTIM_USER_ID);
    expect(asked).not.toContain(FORGED_TENANT_ID);
  });

  it("never writes an id column, so no payload can retarget the row", async () => {
    await saveNotificationPreferences({
      emailEnabled: true,
      minSeverity: "warning",
      categories: {},
    });

    expect(state.updateCalls).toBe(1);
    for (const values of state.sets) {
      expect(Object.keys(values)).not.toContain("id");
      expect(Object.keys(values)).not.toContain("userId");
      expect(Object.keys(values)).not.toContain("tenantId");
    }
  });

  it("rejects a category key that is not in the catalogue rather than storing it", async () => {
    const result = await saveNotificationPreferences({
      emailEnabled: true,
      minSeverity: "warning",
      categories: { "not-a-real-category": false },
    } as never);

    expect(result.ok).toBe(false);
    expect(state.updateCalls).toBe(0);
  });

  it("stores a value the sender's own parser reads back as the same decision", async () => {
    const result = await saveNotificationPreferences({
      emailEnabled: true,
      minSeverity: "critical",
      categories: { [FIRST_CATEGORY]: false },
    });

    expect(result.ok).toBe(true);
    const written = state.sets[0]?.["preferences"];
    const roundTripped = parseNotificationPreferences(written);
    expect(
      shouldEmailNotification(roundTripped, { category: FIRST_CATEGORY, severity: "critical" }),
    ).toBe(false);
    expect(
      shouldEmailNotification(roundTripped, {
        category: NOTIFICATION_CATEGORIES[1]!.key,
        severity: "warning",
      }),
    ).toBe(false);
  });
});

/* ================================================================== */
/* NO BROWSER STORAGE ANYWHERE ON THIS PATH                            */
/* ================================================================== */

describe("the browser store is gone", () => {
  /**
   * ⚠️ THE ABSENCE CLAIM IS THE WHOLE BATCH. A leftover fallback would
   * restore the old behaviour for exactly the users whose save failed —
   * the ones least able to notice.
   */
  it("is not referenced by the settings screen or the preference module", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(__dirname, "..", "..");
    const codeOnly = (s: string) =>
      s
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
        .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

    for (const file of [
      "app/(crm)/settings/notifications/notifications-settings-client.tsx",
      "app/(crm)/settings/notifications/page.tsx",
      "lib/notifications/preferences.ts",
      "server/actions/notification-preferences.ts",
    ]) {
      const code = codeOnly(readFileSync(join(root, file), "utf8"));
      expect(code).not.toMatch(/localStorage|sessionStorage/);
    }
  });
});
