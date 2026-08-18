/**
 * Ordence — ⭐⭐⭐ BATCH 130: THE MONTHLY ACCESS REVIEW
 * Version: v1.52.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE TEST THIS FILE EXISTS FOR
 * ══════════════════════════════════════════════════════════════════════
 * The bulk revoke takes its ids from `?ar_sel=` — the browser's address
 * bar. Everything else here is supporting material for one question: does
 * the server RE-AUTHORISE every id, or does it trust the list?
 *
 * The way that fails in production is not a crash. It is a batch of
 * fifteen legitimate ids with one forged one hidden among them, quietly
 * revoking a row the operator never saw and could not have selected. So
 * the forged id is driven through the real function, and the assertion is
 * about a PROPERTY: NOTHING IS WRITTEN. Not "the error message says X",
 * not "one update ran instead of two" — zero writes, because the promise
 * this screen makes is all-or-nothing.
 *
 * ⚠️ ASSERTIONS ARE ABOUT PROPERTIES, NOT STRINGS. No test here pins an
 * exact sentence, href, path or row count: those change for good reasons
 * and a test that breaks when the wording improves teaches people to
 * delete tests.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Comments must not be able to satisfy an absence claim. */
const codeOnly = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

/* ================================================================== */
/* THE FAKE DATABASE                                                   */
/* ================================================================== */

type Rows = unknown[];

/**
 * A chainable stand-in for the drizzle query builder. It answers by
 * TABLE, so the module under test picks its own rows the same way it
 * would in production — and every `update()` is recorded, because the
 * central claim of this file is about writes that must NOT happen.
 */
const state = {
  byTable: new Map<unknown, Rows>(),
  /** Successive answers for repeated reads of one table, consumed in order. */
  queue: new Map<unknown, Rows[]>(),
  updates: [] as unknown[],
  /** Every `where(...)` argument, so a test can inspect what was asked. */
  wheres: [] as { table: unknown; args: unknown[] }[],
};

/**
 * Pull every literal out of a drizzle condition tree.
 *
 * ⚠️ Used to assert that the owner-floor query excludes the WHOLE batch.
 * The fake database cannot evaluate `NOT IN`, so the test reads the
 * question rather than the answer — which is the stronger assertion
 * anyway: it fails if the code asks about one id instead of all of them.
 */
function literalsIn(
  value: unknown,
  seen: Set<unknown> = new Set(),
  depth = 0,
): string[] {
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

class FakeQuery {
  private table: unknown = null;
  from(table: unknown) {
    this.table = table;
    return this;
  }
  leftJoin() {
    return this;
  }
  where(...args: unknown[]) {
    state.wheres.push({ table: this.table, args });
    return this;
  }
  orderBy() {
    return this;
  }
  limit() {
    return this;
  }
  offset() {
    return this;
  }
  then<T>(
    onFulfilled?: ((value: Rows) => T) | null,
    onRejected?: ((reason: unknown) => T) | null,
  ) {
    const queued = state.queue.get(this.table);
    const rows = queued && queued.length > 0 ? queued.shift()! : state.byTable.get(this.table) ?? [];
    return Promise.resolve(rows).then(onFulfilled ?? undefined, onRejected ?? undefined);
  }
}

const fakeDb = {
  select: () => new FakeQuery(),
  update: (table: unknown) => ({
    set: (values: unknown) => ({
      where: async () => {
        state.updates.push({ table, values });
      },
    }),
  }),
};

vi.mock("@/db", () => ({
  db: {},
  withTenant: vi.fn(),
  schema: {},
  withPlatformScope: vi.fn(
    async (_reason: string, cb: (db: unknown) => Promise<unknown>) => cb(fakeDb),
  ),
}));

vi.mock("@/lib/env", () => ({
  getServerEnv: () => ({ PLATFORM_ADMIN_EMAILS: "owner-a@ordence.in, owner-b@ordence.in" }),
}));

const audits: unknown[] = [];
const operator = {
  clerkUserId: "user_1",
  email: "owner-a@ordence.in",
  grade: "owner" as const,
  ipAddress: null,
  userAgent: null,
  requestId: null,
  staff: { id: "11111111-1111-4111-8111-111111111111" },
  capabilities: ["staff:read", "staff:manage"],
};

vi.mock("@/server/platform/guard", () => ({
  requireCapability: vi.fn(async () => operator),
  requirePlatformAdmin: vi.fn(async () => operator),
  getPlatformOperator: vi.fn(async () => operator),
  recordPlatformAudit: vi.fn(async (entry: unknown) => {
    audits.push(entry);
  }),
  PlatformAccessError: class extends Error {},
}));

import { platformStaff, platformImpersonationSessions } from "@/db/schema/platform";
import {
  ACCESS_REVIEW_RESOURCE,
  accessReviewItemId,
  latestReviewByItem,
  parseAccessReviewItemId,
  previousCalendarMonthIST,
  reasonProblem,
  resolveReviewPeriod,
  sortForReview,
  type AccessReviewRow,
} from "@/lib/platform/access-review";
import { bulkRevokeAccess } from "@/server/platform/access-review";

const REAL_SESSION = "22222222-2222-4222-8222-222222222222";
const REAL_GRANT = "33333333-3333-4333-8333-333333333333";
/** Never inserted into the fake database. This is the forgery. */
const FORGED = "99999999-9999-4999-8999-999999999999";

function liveSession(id: string) {
  const startedAt = new Date(Date.now() - 5 * 60_000);
  return {
    id,
    tenantId: "44444444-4444-4444-8444-444444444444",
    tenantSlug: "acme-constructions",
    actorEmail: "support@ordence.in",
    startedAt,
    expiresAt: new Date(startedAt.getTime() + 20 * 60_000),
    endedAt: null,
  };
}

function activeGrant(id: string, grade: "support" | "owner", email: string) {
  return {
    id,
    email,
    grade,
    status: "active",
    revokedAt: null,
    expiresAt: null,
    grantedAt: new Date(Date.now() - 86_400_000),
    grantReason: "Joined the support rota for the Karnataka contracting cohort.",
  };
}

beforeEach(() => {
  state.byTable.clear();
  state.queue.clear();
  state.wheres.length = 0;
  state.updates.length = 0;
  audits.length = 0;
});

const REASON = "Quarterly access review for the auditors — these are no longer needed.";

/* ================================================================== */
/* 🔴 ① THE FORGED ID                                                  */
/* ================================================================== */

describe("bulk revoke re-authorises every id server-side", () => {
  it("refuses the WHOLE batch when one id names a row the server cannot re-fetch", async () => {
    state.byTable.set(platformStaff, [activeGrant(REAL_GRANT, "support", "sup@ordence.in")]);
    state.byTable.set(platformImpersonationSessions, [liveSession(REAL_SESSION)]);

    const result = await bulkRevokeAccess({
      itemIds: [
        accessReviewItemId("grant", REAL_GRANT),
        accessReviewItemId("session", REAL_SESSION),
        // The operator may not touch this one. They never saw it on
        // screen; they typed it, or somebody sent them a link.
        accessReviewItemId("session", FORGED),
      ],
      reason: REASON,
    });

    expect(result.ok).toBe(false);
    // ⭐ THE PROPERTY: not one write, not a partial batch, nothing.
    expect(state.updates).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it("refuses a batch containing an id that is not of a shape this screen issues", async () => {
    state.byTable.set(platformStaff, [activeGrant(REAL_GRANT, "support", "sup@ordence.in")]);

    for (const junk of [REAL_GRANT, "grant:not-a-uuid", "tenant:" + REAL_GRANT, ""]) {
      const result = await bulkRevokeAccess({
        itemIds: [accessReviewItemId("grant", REAL_GRANT), junk],
        reason: REASON,
      });
      expect(result.ok).toBe(false);
      expect(state.updates).toHaveLength(0);
    }
  });

  it("refuses the whole batch when one row is no longer in a state it can act on", async () => {
    const ended = liveSession(REAL_SESSION);
    ended.endedAt = new Date();
    state.byTable.set(platformStaff, [activeGrant(REAL_GRANT, "support", "sup@ordence.in")]);
    state.byTable.set(platformImpersonationSessions, [ended]);

    const result = await bulkRevokeAccess({
      itemIds: [
        accessReviewItemId("grant", REAL_GRANT),
        accessReviewItemId("session", REAL_SESSION),
      ],
      reason: REASON,
    });

    expect(result.ok).toBe(false);
    expect(state.updates).toHaveLength(0);
  });

  it("writes every row of a batch it does accept, and audits each one", async () => {
    state.byTable.set(platformStaff, [activeGrant(REAL_GRANT, "support", "sup@ordence.in")]);
    state.byTable.set(platformImpersonationSessions, [liveSession(REAL_SESSION)]);

    const result = await bulkRevokeAccess({
      itemIds: [
        accessReviewItemId("grant", REAL_GRANT),
        accessReviewItemId("session", REAL_SESSION),
      ],
      reason: REASON,
    });

    expect(result.ok).toBe(true);
    // One write per item, and an audit row per item — never one summary
    // row that hides an individual's name inside a JSON array.
    expect(state.updates).toHaveLength(2);
    expect(audits).toHaveLength(2);
  });

  it("will not let a batch revoke the last owners who can still sign in", async () => {
    // Both owners are on the allowlist, so revoking either ALONE is fine
    // — and revoking BOTH in one batch must not be, which is the failure
    // a per-row check cannot see: each sees the other as the survivor.
    const ownerA = activeGrant(REAL_GRANT, "owner", "owner-a@ordence.in");
    const ownerB = activeGrant(FORGED, "owner", "owner-b@ordence.in");
    // First read re-fetches the batch; the second is the owner floor,
    // which on a real database excludes everything being revoked and so
    // finds nobody left.
    state.queue.set(platformStaff, [[ownerA, ownerB], []]);

    const result = await bulkRevokeAccess({
      itemIds: [accessReviewItemId("grant", REAL_GRANT), accessReviewItemId("grant", FORGED)],
      reason: REASON,
    });

    expect(result.ok).toBe(false);
    expect(state.updates).toHaveLength(0);
  });

  it("asks the owner floor about the WHOLE batch, not one row at a time", async () => {
    const ownerA = activeGrant(REAL_GRANT, "owner", "owner-a@ordence.in");
    const ownerB = activeGrant(FORGED, "owner", "owner-b@ordence.in");
    state.queue.set(platformStaff, [
      [ownerA, ownerB],
      [{ id: "55555555-5555-4555-8555-555555555555", email: "owner-b@ordence.in" }],
    ]);

    await bulkRevokeAccess({
      itemIds: [accessReviewItemId("grant", REAL_GRANT), accessReviewItemId("grant", FORGED)],
      reason: REASON,
    });

    const floorQuery = state.wheres.filter((w) => w.table === platformStaff).at(-1);
    const asked = literalsIn(floorQuery?.args);
    // ⭐ THE PROPERTY: every id in the batch appears in the exclusion.
    // A per-row check would name only one, permit the revoke, and lock
    // the console for everybody.
    expect(asked).toContain(REAL_GRANT);
    expect(asked).toContain(FORGED);
  });

  it("refuses an empty selection and a reason too short to explain anything", async () => {
    expect((await bulkRevokeAccess({ itemIds: [], reason: REASON })).ok).toBe(false);
    expect(
      (await bulkRevokeAccess({ itemIds: [accessReviewItemId("grant", REAL_GRANT)], reason: "no" }))
        .ok,
    ).toBe(false);
    expect(state.updates).toHaveLength(0);
  });
});

/* ================================================================== */
/* ② THE FINDING IS THE GRANT NOBODY JUSTIFIED                         */
/* ================================================================== */

function row(over: Partial<AccessReviewRow>): AccessReviewRow {
  return {
    itemId: accessReviewItemId("grant", REAL_GRANT),
    kind: "grant",
    kindLabel: "Standing grant",
    who: "a@ordence.in",
    whoGrade: "Support",
    workspace: "Every workspace",
    workspaceId: null,
    startedAt: "2026-07-10T00:00:00.000Z",
    endsAt: null,
    minutes: null,
    reason: "A perfectly adequate written justification for this access.",
    active: false,
    stateWord: "Active",
    reviewedAt: null,
    reviewedBy: null,
    ...over,
  };
}

describe("unjustified access is the finding, not a gap in the UI", () => {
  it("treats a blank, whitespace-only or absent reason as the same problem", () => {
    for (const value of [null, "", "   ", undefined]) {
      expect(reasonProblem(value)).toBe("missing");
    }
  });

  it("floats access with no stated reason above everything else", () => {
    const sorted = sortForReview([
      row({ itemId: "grant:a", active: true }),
      row({ itemId: "grant:b", reason: null }),
      row({ itemId: "grant:c", reason: "too short" }),
    ]);
    const first = sorted[0];
    const second = sorted[1];
    expect(first?.itemId).toBe("grant:b");
    // A thin reason still outranks a fully justified live session.
    expect(second?.itemId).toBe("grant:c");
  });

  it("names the problem in words rather than leaving it to a colour", async () => {
    const lib = await import("@/lib/platform/access-review");
    for (const word of Object.values(lib.REASON_PROBLEM_WORDS)) {
      expect(word.trim().length).toBeGreaterThan(3);
      expect(/[a-z]/i.test(word)).toBe(true);
    }
  });
});

/* ================================================================== */
/* ③ THE PERIOD IS A CALENDAR MONTH, IN INDIAN CIVIL TIME              */
/* ================================================================== */

describe("the default period is the last complete calendar month", () => {
  it("covers a whole month and nothing of its neighbours", () => {
    const period = previousCalendarMonthIST(new Date("2026-08-17T09:00:00.000Z"));
    // A property, not a date literal: the window is at least 28 days and
    // at most 31, and its end is where the next month's window begins.
    const days = (period.to.getTime() - period.from.getTime()) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(28);
    expect(days).toBeLessThanOrEqual(31);

    const next = resolveReviewPeriod(
      previousCalendarMonthIST(new Date(period.to.getTime() + 86_400_000 * 40)).key,
      new Date("2026-08-17T09:00:00.000Z"),
    );
    expect(next.from.getTime()).toBeGreaterThanOrEqual(period.from.getTime());
  });

  it("cuts the month at midnight IST, not at midnight UTC", () => {
    const period = previousCalendarMonthIST(new Date("2026-08-17T09:00:00.000Z"));
    // 00:00 IST is 18:30 the previous UTC day. Asserting the offset in
    // minutes rather than a formatted string keeps this about the rule.
    expect(period.from.getUTCMinutes()).toBe(30);
    expect(period.from.getUTCHours()).toBe(18);
    expect(period.to.getUTCMinutes()).toBe(30);
  });

  it("falls back to the default period rather than erroring on a mistyped month", () => {
    const now = new Date("2026-08-17T09:00:00.000Z");
    const fallback = previousCalendarMonthIST(now);
    for (const junk of ["", "nonsense", "2026-13", "0000-01", "2026-1"]) {
      expect(resolveReviewPeriod(junk, now).key).toBe(fallback.key);
    }
  });

  it("never rolls a January review into month zero of the same year", () => {
    const period = previousCalendarMonthIST(new Date("2026-01-05T09:00:00.000Z"));
    expect(period.key.startsWith("2025-")).toBe(true);
    expect(period.label.includes("2025")).toBe(true);
  });
});

/* ================================================================== */
/* ④ "REVIEWED" IS DERIVED FROM THE REGISTER, AND SAYS WHAT THAT COSTS */
/* ================================================================== */

describe("reviewed state is read back out of the action register", () => {
  it("takes the LATEST mark when the same row was reviewed twice", () => {
    const item = accessReviewItemId("grant", REAL_GRANT);
    const latest = latestReviewByItem([
      { itemId: item, reviewedAt: "2026-08-01T10:00:00.000Z", reviewedBy: "first@ordence.in" },
      { itemId: item, reviewedAt: "2026-08-09T10:00:00.000Z", reviewedBy: "second@ordence.in" },
    ]);
    expect(latest.get(item)?.reviewedBy).toBe("second@ordence.in");
    // ⚠️ One entry per ITEM, not per mark — there is no unique constraint
    // behind this, so the fold is the only thing preventing duplicates.
    expect(latest.size).toBe(1);
  });

  it("files the mark under its own resource type so it can be read back", () => {
    const engine = codeOnly(read("server/platform/access-review.ts"));
    expect(engine).toContain("ACCESS_REVIEW_RESOURCE");
    expect(ACCESS_REVIEW_RESOURCE.length).toBeGreaterThan(0);
    // 🔴 A tenant-attributed audit row is routed into that tenant's own
    // audit_logs, where this console cannot read it back. Every review
    // mark must therefore be tenant-less.
    const markFn = engine.slice(engine.indexOf("export async function markAccessReviewed"));
    expect(markFn).toContain("tenantId: null");
    expect(markFn).not.toContain("tenantId: s.tenantId");
  });

  it("says out loud, in the source, that this state is log-derived and what it costs", () => {
    const lib = read("lib/platform/access-review.ts");
    const page = read("app/platform/access-review/page.tsx");
    for (const text of [lib, page]) {
      expect(/unique constraint/i.test(text)).toBe(true);
      expect(/latest/i.test(text)).toBe(true);
    }
  });
});

/* ================================================================== */
/* ⑤ THE WIRING                                                        */
/* ================================================================== */

describe("the screen is reachable and obeys the console's rules", () => {
  it("ships a page, a client table and an engine", () => {
    for (const p of [
      "app/platform/access-review/page.tsx",
      "components/platform/access-review-console.tsx",
      "server/platform/access-review.ts",
      "lib/platform/access-review.ts",
    ]) {
      expect(existsSync(join(ROOT, p))).toBe(true);
    }
  });

  it("is in the console nav, so it is not a URL somebody has to know", () => {
    const nav = read("lib/platform/console-paths.ts");
    expect(nav).toContain("/platform/access-review");
  });

  it("keeps the server-only href helper out of the client component", () => {
    const panel = codeOnly(read("components/platform/access-review-console.tsx"));
    expect(panel).toContain('"use client"');
    expect(panel).toContain("@/lib/platform/console-paths");
    expect(panel).not.toContain("console-href");
    // isConsoleHost cannot be decided in the browser; it is a prop.
    expect(panel).toContain("isConsoleHost");
  });

  it("does not re-implement the table's keyboard handling", () => {
    const panel = codeOnly(read("components/platform/access-review-console.tsx"));
    expect(panel).not.toContain("onKeyDown");
    expect(panel).not.toContain("keydown");
  });

  it("adds no SQL and no migration", () => {
    const engine = read("server/platform/access-review.ts");
    expect(/create\s+table/i.test(engine)).toBe(false);
    expect(existsSync(join(ROOT, "SQL-FILES", "access_review.sql"))).toBe(false);
  });

  it("uses no browser storage for the review state", () => {
    for (const p of [
      "components/platform/access-review-console.tsx",
      "app/platform/access-review/page.tsx",
    ]) {
      const text = codeOnly(read(p));
      expect(text).not.toContain("localStorage");
      expect(text).not.toContain("sessionStorage");
    }
  });

  it("states the untrusted-ids rule at the point of use, not only in a report", () => {
    const engine = read("server/platform/access-review.ts");
    const panel = read("components/platform/access-review-console.tsx");
    const page = read("app/platform/access-review/page.tsx");
    for (const text of [engine, panel, page]) {
      expect(/query string|address bar|ar_sel/i.test(text)).toBe(true);
    }
  });

  it("guards the writes on the capability that already guards one row", () => {
    const engine = codeOnly(read("server/platform/access-review.ts"));
    const revoke = engine.slice(engine.indexOf("export async function bulkRevokeAccess"));
    expect(revoke).toContain('requireCapability("staff:manage")');
  });
});

/* ================================================================== */
/* ⑥ THE ID FORMAT                                                     */
/* ================================================================== */

describe("item ids name a kind and a uuid, and nothing else parses", () => {
  it("round-trips what it issues", () => {
    for (const kind of ["grant", "session"] as const) {
      const parsed = parseAccessReviewItemId(accessReviewItemId(kind, REAL_GRANT));
      expect(parsed?.kind).toBe(kind);
      expect(parsed?.id).toBe(REAL_GRANT);
    }
  });

  it("rejects anything that could reach a uuid column as junk", () => {
    for (const junk of [
      REAL_GRANT,
      "grant:",
      ":" + REAL_GRANT,
      "grant:1; DROP TABLE platform_staff",
      "tenant:" + REAL_GRANT,
      "grant:00000000-0000-0000-0000-000000000000",
    ]) {
      expect(parseAccessReviewItemId(junk)).toBeNull();
    }
  });
});
