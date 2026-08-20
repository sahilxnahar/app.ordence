/**
 * Ordence — ⭐⭐⭐ A DROPPED AUTOMATION EVENT NOW LEAVES A TRACE
 * Version: v1.82.0-alpha · Track D, wave 15
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THE BRIEF SAID, AND WHAT IS ACTUALLY TRUE
 * ══════════════════════════════════════════════════════════════════════
 * Track D's brief lists "`tryEmitAutomationEvent` discards its failure
 * reasons" as one of four failures-recorded-as-successes.
 *
 * ⚠️ THE FUNCTION DOES NOT DISCARD ANYTHING. It has returned
 * `{ emitted, reason }` since v1.19.0 and its header argues for it. The
 * brief is wrong about the function and right about the outcome, because
 * of what happens one frame up the stack: three of its four call sites
 * `await` it and throw the result away.
 *
 *     server/actions/purchase-orders.ts:185   const emitted = await …   ← used
 *     server/actions/purchase-orders.ts:245   await …                   ← discarded
 *     server/actions/purchase-orders.ts:519   await …                   ← discarded
 *     server/actions/purchase-orders.ts:699   await …                   ← discarded
 *
 * TypeScript cannot object to an ignored return value, so "it returns the
 * reason" was a guarantee nothing enforced. The whole queue could be
 * refusing every insert and three of the four flows would report success.
 *
 * ⭐ SO THE FIX MOVED THE EVIDENCE INTO THE FUNCTION THAT KNOWS. The return
 * value stays — a caller that looks should still be able to put the reason
 * in its audit row — and a caller that does not look now leaves an
 * `automation.event_dropped` row behind it regardless.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ INDUCED, NOT MOCKED
 * ══════════════════════════════════════════════════════════════════════
 * `REVOKE INSERT ON automation_events FROM ordence_app` against the
 * throwaway PostgreSQL 16, restored in a `finally`. The insert genuinely
 * fails inside the caller's own transaction, which is the only way to test
 * the property that matters most here: that the failure does NOT take the
 * caller's business record down with it.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { asSuperuser } from "../setup";

process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

let tenantId: string;

async function withEventsUnwritable<T>(body: () => Promise<T>): Promise<T> {
  await asSuperuser((c) =>
    c.query(`REVOKE INSERT ON automation_events FROM ordence_app`),
  );
  try {
    return await body();
  } finally {
    await asSuperuser((c) =>
      c.query(`GRANT INSERT ON automation_events TO ordence_app`),
    );
  }
}

async function mark(): Promise<Date> {
  const r = await asSuperuser((c) => c.query(`SELECT now() AS t`));
  return (r.rows[0] as { t: Date }).t;
}

function args(recordId: string) {
  return {
    tenantId,
    trigger: "record_updated" as const,
    recordType: "purchase_order",
    recordId,
    changedFields: ["status", "approved_at"],
    payload: { probe: "track-d" },
    now: new Date(),
  };
}

beforeAll(async () => {
  tenantId = randomUUID();
  await asSuperuser((c) =>
    c.query(
      `INSERT INTO tenants (id, clerk_org_id, slug, name, status, plan_tier)
       VALUES ($1,$2,$3,$4,'active','advanced')`,
      [tenantId, `org_${tenantId}`, `ae-${tenantId.slice(0, 8)}`, "Automation Emit"],
    ),
  );
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    await c.query(`GRANT INSERT ON automation_events TO ordence_app`);
    await c.query(`DELETE FROM automation_events WHERE tenant_id = $1`, [tenantId]);
    /* The tenant row stays — see security-event-tenant-scope.test.ts. */
  });
});

/* ================================================================== */

describe("⭐ tryEmitAutomationEvent under a real insert failure", () => {
  it("positive control: with the grant, the event is queued and reports emitted", async () => {
    const { tryEmitAutomationEvent } = await import("@/server/automation/emit");
    const { withTenant } = await import("@/db");
    const recordId = randomUUID();

    const result = await withTenant(tenantId, (tx) =>
      tryEmitAutomationEvent({ ...args(recordId), tx }),
    );

    expect(result.emitted).toBe(true);
    expect(result.reason).toBeNull();

    const rows = await asSuperuser((c) =>
      c.query(`SELECT 1 FROM automation_events WHERE record_id = $1`, [recordId]),
    );
    expect(rows.rowCount ?? 0).toBe(1);
  });

  it("🔴 with INSERT revoked, it reports emitted: false and a reason", async () => {
    const { tryEmitAutomationEvent } = await import("@/server/automation/emit");
    const { withTenant } = await import("@/db");
    const recordId = randomUUID();

    const result = await withEventsUnwritable(() =>
      withTenant(tenantId, (tx) => tryEmitAutomationEvent({ ...args(recordId), tx })),
    );

    expect(result.emitted).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(result.reason ?? "").toMatch(/permission denied|automation_events/i);
  });

  it("⭐ AND THE CALLER'S OWN WRITE STILL COMMITS — the savepoint doing its job", async () => {
    /*
     * 🔴 THE PROPERTY THIS FUNCTION EXISTS FOR, AND IT HAD NEVER BEEN
     * TESTED AGAINST A REAL FAILURE. In PostgreSQL a failed statement
     * poisons the whole transaction: every later statement returns "current
     * transaction is aborted". Without `ROLLBACK TO SAVEPOINT`, a refused
     * queue insert would take the invoice down with it — which is exactly
     * the trade `tryEmitAutomationEvent` was written to prevent, asserted
     * here by writing a real row after the failure and reading it back.
     */
    const { tryEmitAutomationEvent } = await import("@/server/automation/emit");
    const { withTenant } = await import("@/db");
    const { sql } = await import("drizzle-orm");
    const recordId = randomUUID();
    const contactId = randomUUID();

    const result = await withEventsUnwritable(() =>
      withTenant(tenantId, async (tx) => {
        const emitted = await tryEmitAutomationEvent({ ...args(recordId), tx });

        // The "business record" — written AFTER the failed emit, same txn.
        await tx.execute(sql`
          INSERT INTO contacts (id, tenant_id, first_name, last_name, email)
          VALUES (${contactId}, ${tenantId}, 'Savepoint', 'Survived', ${`sp-${contactId}@example.test`})
        `);

        return emitted;
      }),
    );

    expect(result.emitted).toBe(false);

    const rows = await asSuperuser((c) =>
      c.query(`SELECT 1 FROM contacts WHERE id = $1`, [contactId]),
    );
    expect(rows.rowCount ?? 0).toBe(1);

    await asSuperuser((c) => c.query(`DELETE FROM contacts WHERE id = $1`, [contactId]));
  });

  it("⭐ a discarding caller still leaves evidence — the actual fix", async () => {
    const { tryEmitAutomationEvent } = await import("@/server/automation/emit");
    const { withTenant } = await import("@/db");
    const recordId = randomUUID();
    const since = await mark();

    await withEventsUnwritable(async () => {
      /*
       * ⚠️ THE RETURN VALUE IS DELIBERATELY THROWN AWAY HERE, exactly as
       * three of the four production call sites do. If the evidence
       * depended on the caller looking, this test would find nothing.
       */
      await withTenant(tenantId, async (tx) => {
        await tryEmitAutomationEvent({ ...args(recordId), tx });
      });
    });

    const rows = await asSuperuser((c) =>
      c.query(
        `SELECT event_type, severity, source, reason, detail, tenant_id
           FROM security_events
          WHERE occurred_at >= $1 AND subject_id = $2
          ORDER BY occurred_at DESC`,
        [since, recordId],
      ),
    );

    expect(rows.rowCount ?? 0).toBeGreaterThan(0);

    const row = rows.rows[0] as {
      event_type: string;
      severity: string;
      source: string;
      reason: string | null;
      detail: Record<string, unknown> | null;
      tenant_id: string | null;
    };

    if (row.event_type !== "automation.event_dropped") {
      expect(row.event_type).toBe("anomaly.detected");
      expect(row.detail?.["intended_type"]).toBe("automation.event_dropped");
    }

    expect(row.severity).toBe("warning");
    expect(row.source).toContain("server/automation/emit");
    expect(row.reason ?? "").toMatch(/not queued/i);
    // Attributed, via the tenant-scoped write path.
    expect(row.tenant_id).toBe(tenantId);
    expect(row.detail?.["trigger"]).toBe("record_updated");
  });

  it("🔴 the control: a SUCCESSFUL emit records no event at all", async () => {
    const { tryEmitAutomationEvent } = await import("@/server/automation/emit");
    const { withTenant } = await import("@/db");
    const recordId = randomUUID();
    const since = await mark();

    await withTenant(tenantId, (tx) =>
      tryEmitAutomationEvent({ ...args(recordId), tx }),
    );

    const rows = await asSuperuser((c) =>
      c.query(
        `SELECT 1 FROM security_events WHERE occurred_at >= $1 AND subject_id = $2`,
        [since, recordId],
      ),
    );

    expect(rows.rowCount ?? 0).toBe(0);
  });
});
