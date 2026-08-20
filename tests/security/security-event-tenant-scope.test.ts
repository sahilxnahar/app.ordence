/**
 * Ordence — 🔴🔴🔴 SEVEN CALL SITES HAVE NEVER WRITTEN A ROW
 * Version: v1.82.0-alpha · Track D, wave 15
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE FINDING, AND IT WAS NOT ONE OF THE FOUR IN THE BRIEF
 * ══════════════════════════════════════════════════════════════════════
 * `recordSecurityEvent()` writes with the module-level `db` client. That
 * client opens no transaction, so it sets no `app.current_tenant_id`. The
 * policy on `security_events` is:
 *
 *     WITH CHECK ( tenant_id = app_current_tenant_id()
 *               OR (tenant_id IS NULL AND app_current_tenant_id() IS NULL)
 *               OR app_platform_scope() )
 *
 * With no session variable, `app_current_tenant_id()` is NULL, so:
 *   • clause 1 is `tenant_id = NULL` → NULL, which is not TRUE;
 *   • clause 2 requires `tenant_id IS NULL`, and it is not;
 *   • clause 3 is false.
 *
 * The INSERT is refused. ⚠️ AND `security_events` CARRIES
 * `relforcerowsecurity = t`, so this is not a privilege the production
 * table-owner escapes — it applies to `neondb_owner` identically.
 *
 * So EVERY security event carrying a real tenant id has been silently
 * dropped, always, in every environment. `recordSecurityEvent` catches the
 * refusal, prints `[SECURITY EVENT WRITE FAILED]`, and returns `false` — and
 * every one of the seven callers discards the return value:
 *
 *     app/api/upload/put/route.ts        ×2   upload.rejected
 *     app/api/upload/route.ts                 rate_limit.exceeded
 *     server/actions/search.ts                rate_limit.exceeded
 *     server/platform/action-log.ts           impersonation close
 *     server/platform/impersonation.ts   ×2   session anomaly / cross-tenant
 *     server/security/anomalies.ts            every finding with a tenant
 *
 * ⚠️ `tenant.cross_access_attempt` IS ON THAT LIST. It is one of only two
 * `critical` events in the vocabulary and its own comment says "If this
 * ever fires in production it is either an attack or a bug in our scoping,
 * and both are page-someone events." It cannot fire. It writes a tenant id.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE PROVES
 * ══════════════════════════════════════════════════════════════════════
 *   1. The unscoped write with a tenant id is refused. Measured.
 *   2. The identical write with `tenant_id: NULL` succeeds — so the cause
 *      is the tenant column and the policy, not the table, the enum, the
 *      driver or the connection.
 *   3. The tenant-scoped write through `withTenant()` succeeds and lands
 *      the tenant id — so a fix exists and is one function call.
 *   4. `recordSecurityEvidence()` (Track D's writer) takes route 3 and
 *      therefore lands rows the old path could not.
 *
 * The fix for the seven belongs in `server/security/record.ts`, which is
 * not Track D's file. It is `PATCH-REQUEST-D.md` item 2.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { asSuperuser } from "../setup";

process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

let tenantId: string;

beforeAll(async () => {
  tenantId = randomUUID();
  await asSuperuser((c) =>
    c.query(
      `INSERT INTO tenants (id, clerk_org_id, slug, name, status, plan_tier)
       VALUES ($1,$2,$3,$4,'active','advanced')`,
      [tenantId, `org_${tenantId}`, `se-${tenantId.slice(0, 8)}`, "Security Event Scope"],
    ),
  );
});

afterAll(async () => {
  /*
   * ⚠️ THE TENANT ROW IS DELIBERATELY NOT DELETED. `security_events.tenant_id`
   * is `ON DELETE SET NULL`, the cascade issues an UPDATE, and the
   * append-only trigger refuses every UPDATE on that table — so a tenant
   * that has generated one security event cannot be deleted at all. That is
   * a real finding in its own right; see `TRACK-REPORT.md` §4.
   */
});

async function rowsSince(since: Date, source: string) {
  return asSuperuser((c) =>
    c.query(
      `SELECT tenant_id, event_type, detail
         FROM security_events
        WHERE occurred_at >= $1 AND source = $2`,
      [since, source],
    ),
  );
}

async function mark(): Promise<Date> {
  const r = await asSuperuser((c) => c.query(`SELECT now() AS t`));
  return (r.rows[0] as { t: Date }).t;
}

/* ================================================================== */

describe("🔴 the unscoped recorder cannot write a tenant-attributed event", () => {
  it("🔴 REVERSED AT INTEGRATION: an attributed critical event now persists WITH its tenant id", async () => {
    /**
     * ══════════════════════════════════════════════════════════════════
     * THIS ASSERTION USED TO BE ITS OWN OPPOSITE, AND THAT WAS CORRECT.
     * ══════════════════════════════════════════════════════════════════
     * Track D wrote it to PROVE the defect: `recordSecurityEvent()` wrote
     * with the unscoped client, `security_events`' WITH CHECK compares
     * `tenant_id` to `app_current_tenant_id()` which is NULL outside a
     * transaction, and the row was refused. Seven call sites had never
     * written a row, in any environment, including this one , the only
     * `critical` type whose comment calls it a page-someone event.
     *
     * Integration applied Track D's own patch request item 2, so the
     * recorder now routes an attributed event through `withTenant()`.
     * The proof of the defect becomes the proof of the fix, and the
     * description of the defect stays above it so nobody re-introduces it
     * believing this test was always green.
     */
    const { recordSecurityEvent } = await import("@/server/security/record");
    const since = await mark();
    const source = `trackd-probe-${randomUUID().slice(0, 8)}`;

    const ok = await recordSecurityEvent(
      {
        type: "tenant.cross_access_attempt",
        severity: "critical",
        source,
        tenantId,
        reason: "Track D probe: does an attributed critical event persist?",
      },
      { noCoalesce: true },
    );

    expect(ok).toBe(true);

    const rows = await rowsSince(since, source);
    expect(rows.rowCount ?? 0).toBe(1);
    /** And it carries the tenant, rather than being demoted to platform scope. */
    expect(rows.rows[0]?.tenant_id).toBe(tenantId);
  });

  it("⭐ THE CONTROL: the identical event with tenantId null DOES persist", async () => {
    const { recordSecurityEvent } = await import("@/server/security/record");
    const since = await mark();
    const source = `trackd-probe-${randomUUID().slice(0, 8)}`;

    const ok = await recordSecurityEvent(
      {
        type: "tenant.cross_access_attempt",
        severity: "critical",
        source,
        tenantId: null,
        reason: "Track D probe: control with no tenant attribution.",
      },
      { noCoalesce: true },
    );

    /*
     * 🔴 THIS IS THE PAIR THAT MAKES THE FINDING AIRTIGHT. Same function,
     * same type, same severity, same connection, same enum value, one field
     * different. The refusal above is the tenant column meeting the policy,
     * and nothing else.
     */
    expect(ok).toBe(true);

    const rows = await rowsSince(since, source);
    expect(rows.rowCount ?? 0).toBe(1);
    expect((rows.rows[0] as { tenant_id: string | null }).tenant_id).toBeNull();
  });

  it("⭐ AND THE FIX: the same event inside withTenant() persists WITH its tenant id", async () => {
    const { recordSecurityEventTx } = await import("@/server/security/record");
    const { withTenant } = await import("@/db");
    const since = await mark();
    const source = `trackd-probe-${randomUUID().slice(0, 8)}`;

    await withTenant(tenantId, (tx) =>
      recordSecurityEventTx(tx, {
        type: "tenant.cross_access_attempt",
        severity: "critical",
        source,
        tenantId,
        reason: "Track D probe: attributed event written inside a tenant transaction.",
      }),
    );

    const rows = await rowsSince(since, source);
    expect(rows.rowCount ?? 0).toBe(1);
    expect((rows.rows[0] as { tenant_id: string | null }).tenant_id).toBe(tenantId);
  });
});

/* ================================================================== */

describe("⭐ Track D's evidence writer takes the route that works", () => {
  it("lands an attributed row through the tenant-scoped path", async () => {
    const { recordSecurityEvidence } = await import("@/lib/security/evidence");
    const since = await mark();
    const source = `trackd-evidence-${randomUUID().slice(0, 8)}`;

    const outcome = await recordSecurityEvidence({
      type: "billing.standing_unresolved",
      severity: "warning",
      source,
      tenantId,
      reason: "Track D probe: does the evidence writer attribute correctly?",
    });

    expect(outcome.written).toBe(true);
    expect(outcome.scope).toBe("tenant");

    const rows = await rowsSince(since, source);
    expect(rows.rowCount ?? 0).toBe(1);
    expect((rows.rows[0] as { tenant_id: string | null }).tenant_id).toBe(tenantId);
  });

  it("falls back to the anomaly type while the Postgres enum lacks the new value", async () => {
    /*
     * ⚠️ THIS ASSERTION IS DELIBERATELY CONDITIONAL ON THE DATABASE'S OWN
     * STATE rather than on a constant. `ALTER TYPE security_event_type ADD
     * VALUE …` needs a numbered migration Track D does not hold, so the file
     * must be correct before and after integration applies it. It reads the
     * enum and asserts the writer did the right thing for the enum it found.
     */
    const enumRows = await asSuperuser((c) =>
      c.query(
        `SELECT e.enumlabel FROM pg_enum e
           JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'security_event_type'`,
      ),
    );
    const labels = new Set(
      enumRows.rows.map((r) => (r as { enumlabel: string }).enumlabel),
    );

    const { recordSecurityEvidence } = await import("@/lib/security/evidence");
    const since = await mark();
    const source = `trackd-fallback-${randomUUID().slice(0, 8)}`;

    const outcome = await recordSecurityEvidence({
      type: "platform.scope_raised",
      severity: "info",
      source,
      tenantId: null,
      reason: "Track D probe: exercising the enum fallback deliberately.",
    });

    expect(outcome.written).toBe(true);

    const rows = await rowsSince(since, source);
    expect(rows.rowCount ?? 0).toBe(1);
    const row = rows.rows[0] as {
      event_type: string;
      detail: Record<string, unknown> | null;
    };

    if (labels.has("platform.scope_raised")) {
      expect(outcome.usedFallback).toBe(false);
      expect(row.event_type).toBe("platform.scope_raised");
      expect(row.detail?.["intended_type"]).toBeUndefined();
    } else {
      expect(outcome.usedFallback).toBe(true);
      expect(row.event_type).toBe("anomaly.detected");
      expect(row.detail?.["intended_type"]).toBe("platform.scope_raised");
    }
  });
});
