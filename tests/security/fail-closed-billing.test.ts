/**
 * Ordence — ⭐⭐⭐ THE BILLING GATE, PROVEN BY BREAKING THE DATABASE
 * Version: v1.82.0-alpha · Track D, wave 15
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS FILE EXISTS SEPARATELY FROM `billing-gate.test.ts`
 * ══════════════════════════════════════════════════════════════════════
 * That suite proves the gate's DECISIONS against real subscription rows.
 * This one proves its behaviour when the query it depends on FAILS, which
 * is a different property and was previously asserted the other way round:
 *
 *     it("⚠️ FAILS OPEN on a malformed tenant id rather than locking the
 *         workspace", … expect(decision.canWrite).toBe(true))
 *
 * ⚠️ THE FAILURE IS INDUCED, NOT MOCKED. Track D's brief is explicit:
 * "Make the database genuinely unreachable in the throwaway Postgres and
 * show the billing gate refuses. Do not assert it from reading the code;
 * that is how all four got here."
 *
 * So the mechanism is `REVOKE SELECT ON subscriptions FROM ordence_app`,
 * executed as the superuser against the throwaway PostgreSQL 16, with the
 * grant restored in a `finally`. That makes the exact query inside
 * `getAccessDecisionForTenant()` throw a real `permission denied for table
 * subscriptions`, from the real driver, on the real connection — nothing
 * is stubbed and no module is mocked, so a refactor that moved the query
 * somewhere else would still be tested by this file.
 *
 * ⚠️ THE REVOKE ONLY BITES BECAUSE THE TEST ROLE IS `ordence_app`, WHICH
 * IS NOT THE TABLE OWNER. In production the application connects as
 * `neondb_owner`, which owns the tables and is exempt from GRANT — so this
 * mechanism reproduces the FAULT faithfully while being a fault production
 * could not have for that reason. What is under test is the code's
 * response to a throwing query, and any throwing query produces it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ EVERY ASSERTION BELOW HAS A POSITIVE CONTROL BESIDE IT
 * ══════════════════════════════════════════════════════════════════════
 * A test that says "writes are refused" is worth nothing unless the same
 * call, with the grant restored, permits them — otherwise it would pass on
 * a gate that refuses everything always. Each `describe` re-runs the same
 * function on both sides of the revoke.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { asSuperuser } from "../setup";

process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

type Fx = { healthy: string; planId: string; contactId: string };
let fx: Fx;

const days = (n: number) => new Date(Date.now() + n * 86_400_000);

/**
 * Run `body` with `ordence_app` unable to read `subscriptions`.
 *
 * ⚠️ THE RESTORE IS IN A `finally` AND IS NOT OPTIONAL. Leaving the grant
 * revoked would fail every later file in the suite with a message about
 * privileges, a long way from the test that broke it.
 */
async function withSubscriptionsUnreadable<T>(body: () => Promise<T>): Promise<T> {
  await asSuperuser((c) => c.query(`REVOKE SELECT ON subscriptions FROM ordence_app`));
  try {
    return await body();
  } finally {
    await asSuperuser((c) => c.query(`GRANT SELECT ON subscriptions TO ordence_app`));
  }
}

beforeAll(async () => {
  const healthy = randomUUID();
  const planId = randomUUID();
  const contactId = randomUUID();

  await asSuperuser(async (c) => {
    await c.query(
      `INSERT INTO tenants (id, clerk_org_id, slug, name, status, plan_tier)
       VALUES ($1,$2,$3,$4,'active','advanced')`,
      [healthy, `org_${healthy}`, `fc-${healthy.slice(0, 8)}`, "Fail Closed — Healthy"],
    );
    await c.query(
      `INSERT INTO plans (id, code, name, tier, interval, amount_minor)
       VALUES ($1,$2,$3,'advanced','monthly',499900) ON CONFLICT DO NOTHING`,
      [planId, `fc_plan_${planId.slice(0, 8)}`, "Fail Closed Plan"],
    );
    await c.query(
      `INSERT INTO subscriptions
         (id, tenant_id, plan_id, status, failed_payment_count,
          current_period_start, current_period_end, unit_amount_minor, interval)
       VALUES ($1,$2,$3,'active',0,$4,$5,499900,'monthly')`,
      [randomUUID(), healthy, planId, days(-10), days(20)],
    );
    await c.query(
      `INSERT INTO contacts (id, tenant_id, first_name, last_name, email)
       VALUES ($1,$2,'Read','During Outage','fc-read@example.test')`,
      [contactId, healthy],
    );
  });

  fx = { healthy, planId, contactId };
});

afterAll(async () => {
  if (!fx) return;
  await asSuperuser(async (c) => {
    // Belt and braces: if a test aborted mid-revoke, put the grant back.
    await c.query(`GRANT SELECT ON subscriptions TO ordence_app`);
    /*
     * ⚠️ `security_events` IS NOT CLEANED UP AND CANNOT BE. An append-only
     * trigger (`prevent_security_event_delete`) refuses DELETE even for the
     * superuser — which is correct, and is why the assertions below use a
     * timestamp watermark instead of "the table is empty".
     *
     * 🔴 AND THE TENANT ROW IS DELIBERATELY LEFT BEHIND TOO, because it
     * CANNOT BE DELETED. `security_events.tenant_id` is declared
     * `ON DELETE SET NULL` — the schema comment says this "demotes the row
     * to platform-scoped and keeps it" — but the cascade issues an UPDATE,
     * and `prevent_security_event_mutation` refuses every UPDATE on the
     * table, for every role including the superuser:
     *
     *   DELETE FROM tenants WHERE id = …
     *     ERROR: security_events is append-only. UPDATE is not permitted …
     *     CONTEXT: SQL statement "UPDATE ONLY "public"."security_events"
     *              SET "tenant_id" = NULL WHERE $1 = "tenant_id""
     *
     * So a tenant that has ever generated one security event is
     * undeletable. That is two correct controls disagreeing, it is written
     * up in `TRACK-REPORT.md` §4, and it is NOT worked around here — a test
     * that quietly deleted the evidence to tidy up would be defeating the
     * append-only guarantee it depends on everywhere else.
     */
    await c.query(`DELETE FROM subscriptions WHERE tenant_id = $1`, [fx.healthy]);
    await c.query(`DELETE FROM contacts WHERE tenant_id = $1`, [fx.healthy]);
    await c.query(`DELETE FROM plans WHERE id = $1`, [fx.planId]);
  });
});

/* ================================================================== */
/* 1. THE REVERSAL                                                     */
/* ================================================================== */

describe("⭐ a workspace whose standing cannot be resolved is READ-ONLY, not unlimited", () => {
  it("positive control: with the grant in place, the same tenant may write", async () => {
    const { getAccessDecisionForTenant } = await import("@/server/billing/access");
    const decision = await getAccessDecisionForTenant(fx.healthy);

    expect(decision.canWrite).toBe(true);
    expect(decision.standing).toBe("resolved");
    expect(decision.level).toBe("full");
  });

  it("🔴 with SELECT revoked, the SAME call refuses writes", async () => {
    const { getAccessDecisionForTenant } = await import("@/server/billing/access");

    const decision = await withSubscriptionsUnreadable(() =>
      getAccessDecisionForTenant(fx.healthy),
    );

    /*
     * 🔴 THIS IS THE LINE THAT USED TO READ `toBe(true)`. Under the old
     * behaviour a revoked grant produced `level: "full"` for every tenant
     * in the system, because `evaluateAccess({subscriptionStatus: null,
     * planTier: <whatever the tenant row said>})` returns healthy.
     */
    expect(decision.canWrite).toBe(false);
    expect(decision.standing).toBe("unresolved");
    expect(decision.level).toBe("restricted");
  });

  it("⭐ and it is READ-ONLY, not locked — the half that makes it survivable", async () => {
    const { getAccessDecisionForTenant } = await import("@/server/billing/access");

    const decision = await withSubscriptionsUnreadable(() =>
      getAccessDecisionForTenant(fx.healthy),
    );

    // Reading is the thing a customer loses in the bad version of this fix.
    expect(decision.canRead).toBe(true);
    // And the right to a copy of your own data does not lapse over our outage.
    expect(decision.canExport).toBe(true);
  });

  it("says it is OUR fault, not the customer's", async () => {
    const { getAccessDecisionForTenant } = await import("@/server/billing/access");

    const decision = await withSubscriptionsUnreadable(() =>
      getAccessDecisionForTenant(fx.healthy),
    );

    /*
     * ⚠️ THE WORDING IS PART OF THE FIX. A paying customer suddenly put in
     * read-only who is told "restore full access" reads it as "your payment
     * failed" and rings support, or worse, pays twice.
     */
    expect(decision.headline).toMatch(/could not confirm/i);
    expect(decision.detail).toMatch(/fault on our side/i);
  });

  it("recovers the moment the grant is restored — so the refusal was the revoke, not a latch", async () => {
    const { getAccessDecisionForTenant } = await import("@/server/billing/access");

    await withSubscriptionsUnreadable(() => getAccessDecisionForTenant(fx.healthy));
    const after = await getAccessDecisionForTenant(fx.healthy);

    expect(after.canWrite).toBe(true);
    expect(after.standing).toBe("resolved");
  });
});

/* ================================================================== */
/* 2. WHAT STILL WORKS WHILE THE GATE CANNOT DECIDE                    */
/* ================================================================== */

describe("⭐ the exemptions survive the refusal — otherwise this is a trap", () => {
  it("🔴 refuses an ordinary write", async () => {
    const { requireAccessForTenant, AccessRestrictedError } = await import(
      "@/server/billing/access"
    );

    await withSubscriptionsUnreadable(async () => {
      await expect(
        requireAccessForTenant(fx.healthy, "contacts:create"),
      ).rejects.toBeInstanceOf(AccessRestrictedError);
    });
  });

  it("⭐ NEVER blocks paying us — a paywall you cannot pay through is a wall", async () => {
    const { requireAccessForTenant } = await import("@/server/billing/access");

    await withSubscriptionsUnreadable(async () => {
      await expect(
        requireAccessForTenant(fx.healthy, "billing:update_payment_method"),
      ).resolves.toBeDefined();
      await expect(
        requireAccessForTenant(fx.healthy, "payment:create"),
      ).resolves.toBeDefined();
    });
  });

  it("⭐ NEVER blocks export", async () => {
    const { requireAccessForTenant } = await import("@/server/billing/access");

    await withSubscriptionsUnreadable(async () => {
      await expect(
        requireAccessForTenant(fx.healthy, "export:contacts"),
      ).resolves.toBeDefined();
    });
  });

  it("⭐ NEVER blocks statutory work — a filing deadline does not move for our outage", async () => {
    const { requireAccessForTenant } = await import("@/server/billing/access");

    await withSubscriptionsUnreadable(async () => {
      for (const operation of [
        "payroll:run",
        "tds:file_return",
        "gst:file_gstr1",
        "compliance:file",
      ]) {
        await expect(
          requireAccessForTenant(fx.healthy, operation),
        ).resolves.toBeDefined();
      }
    });
  });

  it("a tenant-scoped SELECT still returns rows while writes are refused", async () => {
    /*
     * ⚠️ ASSERTED AGAINST THE DATABASE, NOT AGAINST `decision.canRead`. The
     * flag saying reads are permitted and reads actually working are two
     * different claims, and only the second one is what a customer
     * experiences.
     */
    const { withTenant } = await import("@/db");
    const { sql } = await import("drizzle-orm");

    const rows = await withSubscriptionsUnreadable(() =>
      withTenant(fx.healthy, (tx) =>
        tx.execute(sql`SELECT id FROM contacts WHERE tenant_id = ${fx.healthy}`),
      ),
    );

    expect(Array.isArray(rows.rows) ? rows.rows.length : 0).toBeGreaterThan(0);
  });
});

/* ================================================================== */
/* 3. A MALFORMED TENANT ID                                            */
/* ================================================================== */

describe("a caller that cannot name a valid tenant is refused", () => {
  it("🔴 REVERSES the previous assertion, deliberately", async () => {
    /*
     * The old test read:
     *   "⚠️ FAILS OPEN on a malformed tenant id rather than locking the
     *    workspace … This is the one place in the codebase where failing
     *    open is correct, and it is asserted so nobody hardens it later."
     *
     * It was hardened later. `withTenant()` throws on a non-UUID, so the
     * old behaviour answered "full access" to a caller that could not name
     * a workspace at all — which is not a workspace losing access, because
     * there is no workspace.
     */
    const { getAccessDecisionForTenant } = await import("@/server/billing/access");
    const decision = await getAccessDecisionForTenant("not-a-uuid");

    expect(decision.canWrite).toBe(false);
    expect(decision.standing).toBe("unresolved");
    expect(decision.canRead).toBe(true);
  });
});

/* ================================================================== */
/* 4. THE REFUSAL IS NOT SILENT                                        */
/* ================================================================== */

describe("⭐ a refusal leaves evidence — the half a fail-closed gate usually forgets", () => {
  it("writes a security event naming the tenant and the cause", async () => {
    const { getAccessDecisionForTenant } = await import("@/server/billing/access");

    /*
     * ⚠️ A WATERMARK, NOT A TRUNCATE. `security_events` carries an
     * append-only trigger that refuses DELETE to every role including the
     * superuser, so "clear the table then look" is not available — which is
     * the table behaving exactly as security evidence should.
     */
    const mark = await asSuperuser((c) => c.query(`SELECT now() AS t`));
    const since = (mark.rows[0] as { t: Date }).t;

    await withSubscriptionsUnreadable(() => getAccessDecisionForTenant(fx.healthy));

    const rows = await asSuperuser((c) =>
      c.query(
        `SELECT event_type, severity, source, reason, detail
           FROM security_events
          WHERE tenant_id = $1 AND occurred_at >= $2
          ORDER BY occurred_at DESC`,
        [fx.healthy, since],
      ),
    );

    expect(rows.rowCount ?? 0).toBeGreaterThan(0);

    const row = rows.rows[0] as {
      event_type: string;
      severity: string;
      source: string;
      reason: string | null;
      detail: Record<string, unknown> | null;
    };

    /*
     * ⚠️ EITHER SHAPE IS CORRECT AND THE TEST ACCEPTS BOTH ON PURPOSE.
     * `billing.standing_unresolved` is a new member of the TypeScript union
     * and of the Drizzle enum, and the Postgres enum only gains it when the
     * migration Track D has no number for is applied. Until then the writer
     * degrades to `anomaly.detected` carrying `detail.intended_type`.
     *
     * Asserting only the post-migration shape would make this file fail on
     * every machine until integration lands the number. Asserting only the
     * pre-migration shape would make it fail forever afterwards. Asserting
     * the DISJUNCTION, and asserting that `intended_type` is present exactly
     * when the fallback was used, pins the behaviour in both worlds.
     */
    if (row.event_type === "billing.standing_unresolved") {
      expect(row.detail?.["intended_type"]).toBeUndefined();
    } else {
      expect(row.event_type).toBe("anomaly.detected");
      expect(row.detail?.["intended_type"]).toBe("billing.standing_unresolved");
    }

    expect(row.severity).toBe("warning");
    expect(row.source).toContain("server/billing/access");
    expect(row.reason ?? "").toMatch(/read-only rather than granted full access/i);
  });

  it("🔴 and without the fix there would be no row at all — the control", async () => {
    /*
     * The disproof. A healthy resolution must NOT write one of these, so a
     * row's presence above is caused by the induced failure and not by the
     * gate writing an event on every call.
     */
    const { getAccessDecisionForTenant } = await import("@/server/billing/access");

    const mark = await asSuperuser((c) => c.query(`SELECT now() AS t`));
    const since = (mark.rows[0] as { t: Date }).t;

    await getAccessDecisionForTenant(fx.healthy);

    const rows = await asSuperuser((c) =>
      c.query(
        `SELECT 1 FROM security_events WHERE tenant_id = $1 AND occurred_at >= $2`,
        [fx.healthy, since],
      ),
    );

    expect(rows.rowCount ?? 0).toBe(0);
  });
});
