/**
 * Ordence — ⭐⭐⭐ THE JUSTIFICATION THAT USED TO BE THROWN AWAY
 * Version: v1.82.0-alpha · Track D, wave 15
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE DEFECT
 * ══════════════════════════════════════════════════════════════════════
 * `withPlatformScope(reason, cb)` — the one function in this codebase that
 * reads across tenant boundaries — validates that `reason` is at least ten
 * characters and then does this with it:
 *
 *     if (process.env.NODE_ENV !== "production") {
 *       console.warn(`[PLATFORM SCOPE] Reading across tenants: ${reason}`);
 *     }
 *
 * In production the justification is discarded. Ninety-four files call it.
 * "Who at Ordence read my data, and why?" has never been answerable, and
 * the `why` is the half that matters.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE PROVES
 * ══════════════════════════════════════════════════════════════════════
 *   1. The validator refuses what a ten-character floor accepts.
 *   2. HOW MANY of the existing call sites' reasons are labels rather than
 *      justifications — measured by extracting them from the source, not
 *      assumed. Fifteen are. The number is pinned so it cannot creep.
 *   3. A raise lands a queryable row whose `reason` IS the justification.
 *   4. A break-glass grant expires, and the expiry is checked on USE and
 *      not only when the grant was opened.
 *   5. `withJustifiedPlatformScope` really does raise scope — proved by
 *      reading a row that a tenant-scoped read could not see.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { asSuperuser } from "../setup";

import {
  validateJustification,
  MIN_JUSTIFICATION_CHARS,
  openBreakGlass,
  withBreakGlass,
  closeBreakGlass,
  isBreakGlassLive,
  PlatformScopeRefused,
  BREAK_GLASS_MAX_TTL_MS,
  recordPlatformScopeRaise,
  recentPlatformScopeRaises,
  __resetPlatformScopeJournal,
  __resetBreakGlass,
  withJustifiedPlatformScope,
} from "@/lib/security/platform-scope";

process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const ROOT = process.cwd();

/**
 * Does the POSTGRES enum carry this label yet?
 *
 * ⚠️ ASKED, NOT ASSUMED. `ALTER TYPE security_event_type ADD VALUE` needs a
 * numbered migration Track D does not hold, so this file has to be correct
 * on both sides of it — see `PATCH-REQUEST-D.md` item 1.
 */
async function enumHas(label: string): Promise<boolean> {
  const rows = await asSuperuser((c) =>
    c.query(
      `SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'security_event_type' AND e.enumlabel = $1`,
      [label],
    ),
  );
  return (rows.rowCount ?? 0) > 0;
}

let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  tenantA = randomUUID();
  tenantB = randomUUID();
  await asSuperuser(async (c) => {
    for (const [id, name] of [
      [tenantA, "Scope A"],
      [tenantB, "Scope B"],
    ] as const) {
      await c.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name, status, plan_tier)
         VALUES ($1,$2,$3,$4,'active','advanced')`,
        [id, `org_${id}`, `ps-${id.slice(0, 8)}`, name],
      );
    }
  });
});

afterAll(async () => {
  /*
   * ⚠️ THE TENANT ROWS ARE DELIBERATELY LEFT BEHIND. `tenantA` acquires a
   * `security_events` row during the tests below, and `security_events` is
   * append-only: the `ON DELETE SET NULL` cascade issues an UPDATE, which
   * `prevent_security_event_mutation` refuses for every role including the
   * superuser. A tenant that has generated one security event cannot be
   * deleted at all — a finding in its own right, written up in
   * `TRACK-REPORT.md` §4 and NOT worked around here, because working around
   * it would mean defeating the append-only guarantee this suite depends on.
   */
});

/* ================================================================== */
/* 1. THE VALIDATOR                                                    */
/* ================================================================== */

describe("⭐ a justification has to be a sentence, not ten characters", () => {
  it("🔴 refuses everything the old ten-character floor accepted", () => {
    /*
     * ⚠️ EVERY ONE OF THESE PASSES `reason.length >= 10`. That check is the
     * `count(*) >= 10` gate in miniature: a floor on a free-text field is a
     * non-empty check wearing a number.
     */
    for (const bad of [
      "debugging1",
      "aaaaaaaaaa",
      "0123456789",
      "scope scope scope scope",
      "test test test test test",
      "..........",
    ]) {
      const verdict = validateJustification(bad);
      expect(verdict.ok, `"${bad}" should be refused`).toBe(false);
    }
  });

  it("refuses empty, non-string and short input", () => {
    expect(validateJustification("").ok).toBe(false);
    expect(validateJustification("   ").ok).toBe(false);
    expect(validateJustification(undefined).ok).toBe(false);
    expect(validateJustification(null).ok).toBe(false);
    expect(validateJustification(42).ok).toBe(false);
    expect(validateJustification("a".repeat(MIN_JUSTIFICATION_CHARS - 1)).ok).toBe(false);
  });

  it("⭐ accepts a real one, and normalises whitespace", () => {
    const verdict = validateJustification(
      "  Resolving   a Razorpay webhook to the workspace that owns subscription sub_9912.  ",
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.normalised).toBe(
        "Resolving a Razorpay webhook to the workspace that owns subscription sub_9912.",
      );
    }
  });

  it("does not refuse a real sentence that merely CONTAINS a placeholder word", () => {
    /*
     * ⚠️ THE PLACEHOLDER LIST MATCHES WHOLE WORDS AND ONLY REFUSES WHEN
     * EVERY word is one. A substring match would refuse "investigating the
     * contest export failure", and a validator that refuses real work
     * teaches people to write around it.
     */
    expect(
      validateJustification("Investigating why the contest export failed for one tenant.")
        .ok,
    ).toBe(true);
  });

  it("🔴 THE MEASUREMENT: how many existing call-site reasons are labels rather than justifications", () => {
    /*
     * ⚠️ EXTRACTED FROM THE SOURCE, NOT LISTED BY HAND. A hand-copied list
     * would drift the first time somebody adds a call site, and the drift
     * would be invisible — the test would keep passing on strings that are
     * no longer in the product.
     *
     * ⭐ THE FIRST DRAFT OF THIS TEST ASSERTED THAT ALL OF THEM PASS, AND
     * IT WENT RED, WHICH IS THE MOST USEFUL THING IT DID. Fifteen of the
     * existing reasons are LABELS, not justifications:
     *
     *     "Platform console: incidents"
     *     "Platform console: operator count"
     *     "Platform console: tenant label"
     *     …
     *
     * None of those answers "why is somebody reading across tenants?" — they
     * answer "which screen is this?", which `source` already carries.
     *
     * ⚠️ THE TEMPTING FIX WAS TO LOWER `MIN_JUSTIFICATION_WORDS` UNTIL THEY
     * PASSED. That is the same move as pasting a new fingerprint into a
     * drift test: it makes the build green and records nothing. So the
     * threshold stayed and the NUMBER is pinned instead — if it rises,
     * somebody has added another label; if it falls, somebody has improved
     * one, and either way the diff says which.
     *
     * ⚠️ AND THE RECORDER STILL ACCEPTS THEM ALL. `recordPlatformScopeRaise`
     * does not refuse — see its own test below — so landing the six-line
     * `db/index.ts` patch cannot break a single existing call site. Only
     * `withJustifiedPlatformScope`, which no existing code uses, refuses.
     */
    const files = execSync(
      `grep -rl "withPlatformScope(" --include=*.ts --include=*.tsx lib server app db || true`,
      { cwd: ROOT, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);

    const reasons: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(ROOT, file), "utf8");
      for (const m of text.matchAll(/withPlatformScope\(\s*\n?\s*"([^"]{10,})"/g)) {
        const captured = m[1];
        if (captured) reasons.push(captured);
      }
    }

    // If this ever reads zero the extraction has broken, not the validator.
    expect(reasons.length).toBeGreaterThan(20);

    const refused = reasons.filter((r) => !validateJustification(r).ok);

    /*
     * ⚠️ PINNED AS A NUMBER, WITH THE LIST IN THE MESSAGE. A bare
     * `toBeLessThan` would let this rot upwards one label at a time.
     */
    expect(
      refused.length,
      `label-shaped reasons: ${refused.join(" | ")}`,
    ).toBe(15);

    /* Every refusal is a label, not a false positive on a real sentence. */
    for (const r of refused) {
      const after = r.includes(": ") ? r.slice(r.indexOf(": ") + 2) : r;
      expect(after.split(" ").length).toBeLessThan(4);
    }
  });
});

/* ================================================================== */
/* 2. THE RECORD                                                       */
/* ================================================================== */

describe("⭐ the justification is stored, non-empty and queryable", () => {
  it("lands a row whose reason IS the justification", async () => {
    const mark = await asSuperuser((c) => c.query(`SELECT now() AS t`));
    const since = (mark.rows[0] as { t: Date }).t;

    const justification =
      "Resolving a Razorpay webhook to the workspace that owns subscription sub_9912.";

    const outcome = await recordPlatformScopeRaise({
      justification,
      source: "tests/security/platform-scope-justification",
      operatorId: "user_probe_trackd",
      tenantId: tenantA,
    });

    expect(outcome?.written).toBe(true);

    const rows = await asSuperuser((c) =>
      c.query(
        `SELECT reason, detail, subject_id, tenant_id, severity
           FROM security_events
          WHERE occurred_at >= $1
            AND source = 'tests/security/platform-scope-justification'`,
        [since],
      ),
    );

    expect(rows.rowCount ?? 0).toBe(1);
    const row = rows.rows[0] as {
      reason: string;
      detail: Record<string, unknown>;
      subject_id: string;
      tenant_id: string | null;
      severity: string;
    };

    /* 🔴 THE FIELD THAT USED TO BE DISCARDED. */
    expect(row.reason).toBe(justification);
    expect(row.subject_id).toBe("user_probe_trackd");
    expect(row.tenant_id).toBe(tenantA);
    expect(row.detail["justification_valid"]).toBe(true);
    expect(row.detail["kind"]).toBe("routine");

    /*
     * ⚠️ `info` ONLY ONCE THE POSTGRES ENUM CARRIES `platform.scope_raised`.
     *
     * 🔴 A LIMITATION OF THE FALLBACK, RECORDED RATHER THAN HIDDEN. Before
     * the migration lands, the row is written as `anomaly.detected`, whose
     * DEFAULT_SEVERITY is `warning`; `resolveSeverity()` takes the HIGHER of
     * the requested and default severities on purpose ("a caller can
     * escalate, a caller cannot quietly demote"). So a routine raise is
     * INFLATED to `warning` until integration applies the migration in
     * PATCH-REQUEST-D.md item 1. That is noisy in the right direction, and
     * it is asserted both ways so the noise disappears provably when the
     * enum gains the value.
     */
    expect(row.severity).toBe(
      (await enumHas("platform.scope_raised")) ? "info" : "warning",
    );
  });

  it("records an INVALID justification as invalid rather than refusing it", async () => {
    /*
     * ⚠️ THE RECORDER DOES NOT REFUSE, AND THAT IS DELIBERATE. It is the
     * function the six-line `db/index.ts` patch calls, so refusing here
     * would break 94 call sites at once — and the ones that would break are
     * the platform tooling used during an incident. The refusal belongs in
     * the wrappers, on new code, where it costs nothing.
     */
    const mark = await asSuperuser((c) => c.query(`SELECT now() AS t`));
    const since = (mark.rows[0] as { t: Date }).t;

    await recordPlatformScopeRaise({
      justification: "debugging1",
      source: "tests/security/platform-scope-invalid",
    });

    const rows = await asSuperuser((c) =>
      c.query(
        `SELECT reason, detail, severity FROM security_events
          WHERE occurred_at >= $1 AND source = 'tests/security/platform-scope-invalid'`,
        [since],
      ),
    );

    expect(rows.rowCount ?? 0).toBe(1);
    const row = rows.rows[0] as {
      reason: string;
      detail: Record<string, unknown>;
      severity: string;
    };
    expect(row.reason).toBe("debugging1");
    expect(row.detail["justification_valid"]).toBe(false);
    /*
     * ⚠️ `too_short`, NOT `no_substance`. "debugging1" is ten characters and
     * the length floor is checked first — which is the point: the OLD gate
     * accepted this exact string.
     */
    expect(row.detail["justification_problem"]).toBe("too_short");
    /* Escalated, because a raise nobody justified is worth a look. */
    expect(row.severity).toBe("warning");
  });

  it("keeps an in-process journal for the console, newest first", async () => {
    __resetPlatformScopeJournal();

    await recordPlatformScopeRaise({
      justification: "First raise: checking the subscription that a webhook named.",
      source: "tests/journal/one",
    });
    await recordPlatformScopeRaise({
      justification: "Second raise: locating the lockout row an administrator asked about.",
      source: "tests/journal/two",
    });

    const journal = recentPlatformScopeRaises();
    expect(journal).toHaveLength(2);
    expect(journal[0]?.source).toBe("tests/journal/two");
    expect(journal[1]?.source).toBe("tests/journal/one");
  });
});

/* ================================================================== */
/* 3. BREAK GLASS                                                      */
/* ================================================================== */

describe("⭐ break glass expires, and the expiry is checked on USE", () => {
  it("refuses to open on a placeholder justification", () => {
    expect(() =>
      openBreakGlass({ justification: "debugging1", operatorId: "user_x" }),
    ).toThrow(PlatformScopeRefused);
  });

  it("clamps an over-long TTL rather than throwing", () => {
    __resetBreakGlass();
    const now = 1_700_000_000_000;
    const grant = openBreakGlass({
      justification: "Incident 412: reading the payment events for every affected tenant.",
      operatorId: "user_x",
      ttlMs: 8 * 60 * 60_000,
      now,
    });

    /*
     * ⚠️ CLAMPED, NOT REFUSED. Throwing would make an operator retry with a
     * smaller number during an incident; the clamp is visible in the grant's
     * own expiry, so nothing is hidden.
     */
    expect(grant.expiresAtMs).toBe(now + BREAK_GLASS_MAX_TTL_MS);
  });

  it("🔴 refuses a grant that has expired, on use", async () => {
    __resetBreakGlass();
    const now = 1_700_000_000_000;
    const grant = openBreakGlass({
      justification: "Incident 412: reading the payment events for every affected tenant.",
      operatorId: "user_x",
      ttlMs: 60_000,
      now,
    });

    expect(isBreakGlassLive(grant.id, now + 30_000)).toBe(true);
    expect(isBreakGlassLive(grant.id, now + 61_000)).toBe(false);

    await expect(
      withBreakGlass(
        { grantId: grant.id, source: "tests/breakglass", now: now + 61_000 },
        async () => undefined,
      ),
    ).rejects.toMatchObject({ problem: "grant_expired" });
  });

  it("refuses a grant id it has never seen", async () => {
    __resetBreakGlass();
    await expect(
      withBreakGlass({ grantId: "bg_nope", source: "tests/breakglass" }, async () => undefined),
    ).rejects.toMatchObject({ problem: "grant_unknown" });
  });

  it("an expired grant is deleted, so a clock change cannot revive it", async () => {
    __resetBreakGlass();
    const now = 1_700_000_000_000;
    const grant = openBreakGlass({
      justification: "Incident 412: reading the payment events for every affected tenant.",
      operatorId: "user_x",
      ttlMs: 60_000,
      now,
    });

    await withBreakGlass(
      { grantId: grant.id, source: "tests/breakglass", now: now + 61_000 },
      async () => undefined,
    ).catch(() => undefined);

    // Even "back in time", it is gone rather than merely stale.
    expect(isBreakGlassLive(grant.id, now + 1_000)).toBe(false);
    expect(closeBreakGlass(grant.id)).toBe(false);
  });
});

/* ================================================================== */
/* 4. IT REALLY RAISES SCOPE                                           */
/* ================================================================== */

describe("⭐ withJustifiedPlatformScope actually reads across tenants", () => {
  it("sees both tenants, where a tenant-scoped read sees one", async () => {
    const { withTenant } = await import("@/db");
    const { sql } = await import("drizzle-orm");

    const scoped = await withTenant(tenantA, (tx) =>
      tx.execute(
        sql`SELECT id FROM tenants WHERE id IN (${tenantA}, ${tenantB})`,
      ),
    );
    expect(scoped.rows.length).toBe(1);

    const raised = await withJustifiedPlatformScope(
      {
        justification:
          "Confirming that a raised scope genuinely widens the view, for the wave 15 proof.",
        source: "tests/security/platform-scope-raise",
        operatorId: "user_probe_trackd",
      },
      (tx) =>
        tx.execute(sql`SELECT id FROM tenants WHERE id IN (${tenantA}, ${tenantB})`),
    );

    /*
     * 🔴 2 vs 1 IS THE PROOF. Asserting only that the wrapper returned would
     * pass on a wrapper that quietly did a tenant-scoped read.
     */
    expect(raised.rows.length).toBe(2);
  });

  it("🔴 refuses a bad justification BEFORE opening a transaction", async () => {
    await expect(
      withJustifiedPlatformScope(
        { justification: "debugging1", source: "tests/security/platform-scope-raise" },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(PlatformScopeRefused);
  });
});
