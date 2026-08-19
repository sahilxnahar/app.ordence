/**
 * Ordence — Telemetry Isolation & Integrity
 * Version: v0.12.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * PHASE 19 MANDATORY VERIFICATION
 * ══════════════════════════════════════════════════════════════════════
 * The telemetry ingest endpoint is PUBLIC and effectively unauthenticated
 * — Web Vitals fire before a session exists, and the crash that matters
 * most is the one in the auth bootstrap. That means anonymous rows land
 * in these tables, and the database is the only thing keeping them apart
 * from tenant data.
 *
 * Five guarantees are asserted here, against a REAL PostgreSQL:
 *
 *   1. A tenant cannot READ another tenant's error or vital events.
 *   2. A tenant cannot WRITE an event attributed to another tenant.
 *      (The write-side leak a USING-only policy would permit.)
 *   3. The NULL-tenant rows behave exactly like `payment_events`:
 *      visible ONLY from platform scope, invisible to every tenant.
 *   4. An error event, once written, cannot be altered or deleted.
 *   5. `telemetry_daily` does not launder a cross-tenant read through a
 *      view. This is the one a reviewer is most likely to miss.
 *
 * ⚠️ EVERY ASSERTION RUNS AS `ordence_app`, NOT AS `postgres`. A superuser
 * bypasses RLS entirely, so a suite connected as one would pass with
 * every policy dropped. `asSuperuser` appears only in fixture setup and
 * teardown; if it ever appears inside an assertion, that assertion is
 * worthless.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { asTenant, withoutTenant, asSuperuser, expectError , asPlatform } from "../setup";

type Fixtures = {
  tenantA: string;
  tenantB: string;
  errorA: string;
  errorB: string;
  errorOrphan: string;
  vitalA: string;
  vitalB: string;
  vitalOrphan: string;
};

let fx: Fixtures;

/**
 * Tenant B's fingerprint is deliberately unmistakable. If it ever appears
 * in a result set belonging to A, the failure message says so directly
 * rather than reporting an unhelpful row count mismatch.
 */
const FP_A = "aaaa0000aaaa0000";
const FP_B = "bbbb1111bbbb1111";
const FP_ORPHAN = "cccc2222cccc2222";

/**
 * Assert a statement was refused BY THE GUARD UNDER TEST and not by a
 * missing GRANT.
 *
 * The distinction cost real time in Phase 9: a missing privilege raises
 * SQLSTATE 42501, which is exactly what the append-only trigger raises. A
 * test whose role simply had no rights on the table passed for entirely
 * the wrong reason and proved nothing.
 */
async function expectGuard(
  fn: () => Promise<unknown>,
  messagePattern: RegExp,
): Promise<void> {
  const error = await expectError(fn);

  expect(error, "expected the statement to be refused, but it succeeded").not.toBeNull();

  expect(
    error!.message,
    `the statement failed with a PRIVILEGE error, not the expected guard — ` +
      `the test role is missing a GRANT and this test proves nothing: ${error!.message}`,
  ).not.toMatch(/permission denied for (table|relation)/i);

  expect(error!.message).toMatch(messagePattern);
}

beforeAll(async () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const errorA = randomUUID();
  const errorB = randomUUID();
  const errorOrphan = randomUUID();
  const vitalA = randomUUID();
  const vitalB = randomUUID();
  const vitalOrphan = randomUUID();

  await asSuperuser(async (c) => {
    for (const [id, name] of [
      [tenantA, "Telemetry Tenant A"],
      [tenantB, "Telemetry Tenant B"],
    ] as const) {
      await c.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
         VALUES ($1,$2,$3,$4,'active')`,
        [id, `org_${id}`, `tel-${id.slice(0, 8)}`, name],
      );
    }

    for (const [id, tenant, fingerprint, message] of [
      [errorA, tenantA, FP_A, "tenant A boom"],
      [errorB, tenantB, FP_B, "tenant B boom"],
      // The unattributed row — what a pre-auth page view or a crash in
      // the auth bootstrap itself produces.
      [errorOrphan, null, FP_ORPHAN, "anonymous boom"],
    ] as const) {
      await c.query(
        `INSERT INTO error_events
           (id, tenant_id, fingerprint, message, severity, route_pattern, source)
         VALUES ($1,$2,$3,$4,'error','/contacts/:id','server')`,
        [id, tenant, fingerprint, message],
      );
    }

    for (const [id, tenant, value] of [
      [vitalA, tenantA, 1111],
      [vitalB, tenantB, 2222],
      [vitalOrphan, null, 3333],
    ] as const) {
      await c.query(
        `INSERT INTO web_vital_events
           (id, tenant_id, metric, value, rating, route_pattern)
         VALUES ($1,$2,'LCP',$3,'good','/dashboard')`,
        [id, tenant, value],
      );
    }
  });

  fx = { tenantA, tenantB, errorA, errorB, errorOrphan, vitalA, vitalB, vitalOrphan };
});

afterAll(async () => {
  if (!fx) return;
  await asSuperuser(async (c) => {
    await c.query("DELETE FROM web_vital_events WHERE id = ANY($1)", [
      [fx.vitalA, fx.vitalB, fx.vitalOrphan],
    ]);
    // The append-only trigger blocks DELETE even for the owner, so the
    // sweep flag must be set — the same escape hatch the retention
    // function uses. If this ever stops working, Section 2 of the
    // migration has been weakened.
    await c.query("SELECT set_config('app.telemetry_retention_sweep', 'on', false)");
    await c.query("DELETE FROM error_events WHERE id = ANY($1)", [
      [fx.errorA, fx.errorB, fx.errorOrphan],
    ]);
    await c.query("SELECT set_config('app.telemetry_retention_sweep', 'off', false)");
    await c.query("DELETE FROM tenants WHERE id = ANY($1)", [[fx.tenantA, fx.tenantB]]);
  });
});

/* ================================================================== */
/* 1. READ ISOLATION                                                   */
/* ================================================================== */

describe("error_events — read isolation", () => {
  it("a tenant sees only its own error events", async () => {
    const rows = await asTenant(fx.tenantA, async (c) => {
      const r = await c.query("SELECT id, tenant_id, fingerprint FROM error_events");
      return r.rows as { id: string; tenant_id: string | null; fingerprint: string }[];
    });

    expect(rows.every((r) => r.tenant_id === fx.tenantA)).toBe(true);
    expect(rows.map((r) => r.fingerprint)).not.toContain(FP_B);
  });

  it("a tenant cannot reach another tenant's event even by primary key", async () => {
    // The direct-object-reference check. Knowing the uuid must not help.
    const rows = await asTenant(fx.tenantA, async (c) => {
      const r = await c.query("SELECT id FROM error_events WHERE id = $1", [fx.errorB]);
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("a tenant cannot count another tenant's events", async () => {
    // An aggregate is a classic side channel: a policy that filters SELECT
    // but is bypassed by count() would leak volume, which for an error
    // dashboard leaks "our competitor is having an outage".
    const count = await asTenant(fx.tenantA, async (c) => {
      const r = await c.query("SELECT count(*)::int AS n FROM error_events");
      return (r.rows[0] as { n: number }).n;
    });
    expect(count).toBe(1);
  });
});

describe("web_vital_events — read isolation", () => {
  it("a tenant sees only its own measurements", async () => {
    const rows = await asTenant(fx.tenantB, async (c) => {
      const r = await c.query("SELECT id, tenant_id, value FROM web_vital_events");
      return r.rows as { tenant_id: string | null; value: string }[];
    });

    expect(rows.every((r) => r.tenant_id === fx.tenantB)).toBe(true);
    expect(rows.map((r) => Number(r.value))).not.toContain(1111);
  });
});

/* ================================================================== */
/* 2. WRITE ISOLATION — THE LEAK A `USING`-ONLY POLICY PERMITS         */
/* ================================================================== */

describe("write-side isolation", () => {
  it("⭐ a tenant CANNOT insert an error event attributed to another tenant", async () => {
    // Without WITH CHECK this INSERT succeeds silently. The row then never
    // appears in the attacker's own reads — so nothing looks wrong on
    // their side — while it sits in the victim's error dashboard, ready to
    // page their engineers once alerting exists.
    await expectGuard(
      () =>
        asTenant(fx.tenantA, (c) =>
          c.query(
            `INSERT INTO error_events (tenant_id, fingerprint, message)
             VALUES ($1, $2, 'forged')`,
            [fx.tenantB, "dddd3333dddd3333"],
          ),
        ),
      /row-level security/i,
    );
  });

  it("⭐ a tenant CANNOT insert a vital event attributed to another tenant", async () => {
    await expectGuard(
      () =>
        asTenant(fx.tenantA, (c) =>
          c.query(
            `INSERT INTO web_vital_events (tenant_id, metric, value, rating, route_pattern)
             VALUES ($1,'LCP',9999,'poor','/dashboard')`,
            [fx.tenantB],
          ),
        ),
      /row-level security/i,
    );
  });

  it("a tenant cannot insert an UNATTRIBUTED row either", async () => {
    // A NULL row is invisible to the tenant that wrote it, so this is not
    // a leak — but permitting it inside a tenant session would mean a bug
    // in the ingest path could silently orphan every event a paying
    // customer generates, and nobody would notice until a dashboard was
    // permanently empty.
    await expectGuard(
      () =>
        asTenant(fx.tenantA, (c) =>
          c.query(
            `INSERT INTO error_events (tenant_id, fingerprint, message)
             VALUES (NULL, 'eeee4444eeee4444', 'orphan from tenant session')`,
          ),
        ),
      /row-level security/i,
    );
  });
});

/* ================================================================== */
/* 3. THE NULL-TENANT POLICY, MIRRORING `payment_events`               */
/* ================================================================== */

describe("null-tenant rows behave exactly like payment_events", () => {
  it("a tenant session NEVER sees an unattributed row", async () => {
    // The ingest endpoint is public: anyone on the internet can create
    // these. If a tenant could read them, an attacker could plant text
    // into a customer's error dashboard.
    const rows = await asTenant(fx.tenantA, async (c) => {
      const r = await c.query("SELECT id FROM error_events WHERE tenant_id IS NULL");
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("platform scope sees the unattributed rows", async () => {
    const fingerprints = await asPlatform(async (c) => {
      const r = await c.query("SELECT fingerprint FROM error_events");
      return (r.rows as { fingerprint: string }[]).map((x) => x.fingerprint);
    });
    expect(fingerprints).toContain(FP_ORPHAN);
  });

  it("⭐ platform scope sees attributed rows TOO — and that is 0079, not a leak", async () => {
    // ══════════════════════════════════════════════════════════════════
    // ⚠️ THIS TEST USED TO ASSERT THE OPPOSITE. It read:
    //
    //     expect(rows.every((r) => r.tenant_id === null)).toBe(true);
    //
    // and it was right when it was written, and wrong from 0079 onwards.
    //
    // 0079_rls_opt_in_and_telemetry.sql found that `error_events`,
    // `web_vital_events` and `security_events` had been DISCARDING every
    // row that names a tenant. The writers run under `withPlatformScope`,
    // where the session tenant is null, and stamp a real tenant id on the
    // row when the caller is signed in. Null session tenant plus non-null
    // row tenant satisfied neither branch of the old policy, so Postgres
    // raised 42501, and all three call sites caught it and moved on , by
    // design, because telemetry must never break the request it describes.
    //
    // So those tables held anonymous pre-auth rows and nothing else. Every
    // error from a signed-in user and every security event attributed to a
    // workspace went on the floor, silently, for the life of the product.
    //
    // 0079 added `OR app_platform_scope()` to both halves. These rows are
    // the PLATFORM'S observations ABOUT a workspace , the workspace is the
    // subject, not the author , so the platform branch is the honest fix.
    //
    // ══════════════════════════════════════════════════════════════════
    // ⭐ WHAT KEEPS THAT FROM BEING A SUPER-ADMIN BACKDOOR
    // ══════════════════════════════════════════════════════════════════
    // Not the policy. `app_platform_scope()` is false unless something
    // deliberately set `app.platform_scope`, which only `withPlatformScope`
    // does and only with a stated reason. The properties that matter are
    // therefore the three asserted below and, above all, the fail-closed
    // default in the next test: NO context sees ZERO rows, not all of them.
    const platformRows = await asPlatform(async (c) => {
      const r = await c.query("SELECT tenant_id FROM error_events");
      return r.rows as { tenant_id: string | null }[];
    });

    // (1) It still sees the unattributed rows.
    expect(platformRows.some((r) => r.tenant_id === null)).toBe(true);

    // (2) It ALSO sees attributed ones. If this ever goes back to false,
    //     0079 has been reverted and telemetry is silently on the floor
    //     again , which is invisible from the application, because every
    //     writer swallows the 42501.
    expect(platformRows.some((r) => r.tenant_id !== null)).toBe(true);

    // (3) A TENANT session is unaffected: it still sees only its own.
    const tenantRows = await asTenant(fx.tenantA, async (c) => {
      const r = await c.query("SELECT tenant_id FROM error_events");
      return r.rows as { tenant_id: string | null }[];
    });
    expect(tenantRows.length).toBeGreaterThan(0);
    expect(tenantRows.every((r) => r.tenant_id === fx.tenantA)).toBe(true);
  });

  it("the same holds for web_vital_events", async () => {
    const tenantView = await asTenant(fx.tenantA, async (c) => {
      const r = await c.query("SELECT id FROM web_vital_events WHERE tenant_id IS NULL");
      return r.rows;
    });
    expect(tenantView).toHaveLength(0);

    // ⚠️ `withoutTenant` is NOT platform scope. It is a session with no
    // tenant and no platform flag, which is the fail-closed case: it may
    // see the unattributed rows and nothing else. Contrast the test above,
    // which uses `asPlatform`. The distinction is the whole control, and
    // this test previously conflated the two by asserting the same thing
    // of both.
    const noContextView = await withoutTenant(async (c) => {
      const r = await c.query("SELECT tenant_id FROM web_vital_events");
      return r.rows as { tenant_id: string | null }[];
    });
    expect(noContextView.every((r) => r.tenant_id === null)).toBe(true);
  });

  it("no context means ZERO rows, never ALL rows — the fail-closed default", async () => {
    const count = await withoutTenant(async (c) => {
      const r = await c.query(
        "SELECT count(*)::int AS n FROM error_events WHERE tenant_id IS NOT NULL",
      );
      return (r.rows[0] as { n: number }).n;
    });
    expect(count).toBe(0);
  });
});

/* ================================================================== */
/* 4. ERROR EVENTS ARE APPEND-ONLY                                     */
/* ================================================================== */

describe("error_events is append-only", () => {
  /**
   * ⚠️ THESE TWO USE `expectError`, NOT `expectGuard`, AND THAT IS THE
   * POINT.
   *
   * `expectGuard` exists to catch a test that passes because the role has
   * no GRANT. Here the missing GRANT IS the guarantee: Section 5 of the
   * migration revokes UPDATE and DELETE on `error_events` from
   * `ordence_app` outright, so the application role is refused at the
   * PRIVILEGE layer and never reaches the trigger at all. Insisting on
   * the trigger's message here would mean the test only passes if the
   * OUTER of two defences has been removed.
   *
   * The trigger itself — the layer that still holds if someone runs
   * `GRANT ALL` during an incident — is asserted separately below, as the
   * table owner, which is the only role that can get past the grants.
   */
  it("a tenant cannot UPDATE its own error event", async () => {
    // An error report is only worth anything if it is the same tomorrow as
    // it was today. Once a row can be edited, "we fixed it" and "somebody
    // edited the evidence" become indistinguishable.
    const error = await expectError(() =>
      asTenant(fx.tenantA, (c) =>
        c.query("UPDATE error_events SET message = 'rewritten' WHERE id = $1", [fx.errorA]),
      ),
    );
    expect(error, "the UPDATE succeeded — error evidence is mutable").not.toBeNull();
    expect(error!.message).toMatch(/append-only|permission denied/i);

    // And the row is genuinely unchanged, not merely reported as refused.
    const message = await asTenant(fx.tenantA, async (c) => {
      const r = await c.query("SELECT message FROM error_events WHERE id = $1", [fx.errorA]);
      return (r.rows[0] as { message: string } | undefined)?.message;
    });
    expect(message).toBe("tenant A boom");
  });

  it("a tenant cannot DELETE its own error event", async () => {
    const error = await expectError(() =>
      asTenant(fx.tenantA, (c) =>
        c.query("DELETE FROM error_events WHERE id = $1", [fx.errorA]),
      ),
    );
    expect(error, "the DELETE succeeded — error evidence is removable").not.toBeNull();
    expect(error!.message).toMatch(/append-only|permission denied/i);
  });

  it("even the table OWNER is refused without the retention flag", async () => {
    // FORCE ROW LEVEL SECURITY plus a trigger. If the owner could edit
    // freely, the append-only guarantee would hold only for the roles that
    // were never going to try.
    const error = await expectError(() =>
      asSuperuser((c) =>
        c.query("UPDATE error_events SET message = 'rewritten' WHERE id = $1", [fx.errorA]),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/append-only/i);
  });
});

/* ================================================================== */
/* 5. THE VIEW MUST NOT LAUNDER A CROSS-TENANT READ                    */
/* ================================================================== */

describe("telemetry_daily", () => {
  it("⭐ does not return another tenant's aggregates", async () => {
    // A view runs with its OWNER's privileges unless created with
    // `security_invoker = true`. Without that option this "harmless
    // dashboard" hands every tenant a summary of every other tenant's
    // errors — and no test on the base tables would catch it.
    const rows = await asTenant(fx.tenantA, async (c) => {
      const r = await c.query("SELECT tenant_id, error_count FROM telemetry_daily");
      return r.rows as { tenant_id: string | null; error_count: string }[];
    });

    expect(rows.every((r) => r.tenant_id === fx.tenantA)).toBe(true);
  });

  it("is registered as security_invoker in the catalogue", async () => {
    // Asserting the OPTION as well as the behaviour: a future
    // `CREATE OR REPLACE VIEW` that forgets it would otherwise only be
    // caught if this fixture happened to have cross-tenant data.
    const ok = await asSuperuser(async (c) => {
      const r = await c.query(
        `SELECT c.reloptions @> ARRAY['security_invoker=true'] AS ok
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = 'telemetry_daily'`,
      );
      return (r.rows[0] as { ok: boolean } | undefined)?.ok ?? false;
    });
    expect(ok, "telemetry_daily must be created WITH (security_invoker = true)").toBe(true);
  });
});

/* ================================================================== */
/* 6. THE PII GUARDS ARE ENFORCED BY THE DATABASE, NOT ONLY THE APP    */
/* ================================================================== */

describe("PII guard constraints", () => {
  it("refuses a route_pattern that is actually a URL with a query string", async () => {
    // The scrubber is the first line. This is the one that still holds
    // when a future caller forgets to run it — a raw URL in a CRM is a
    // record id, and a record id is a pointer to a named human.
    await expectGuard(
      () =>
        asTenant(fx.tenantA, (c) =>
          c.query(
            `INSERT INTO error_events (tenant_id, fingerprint, message, route_pattern)
             VALUES ($1,'ffff5555ffff5555','x','/search?q=priya@acme.co')`,
            [fx.tenantA],
          ),
        ),
      /route_is_pattern|check constraint/i,
    );
  });

  it("refuses an absolute URL as a route_pattern on vitals", async () => {
    await expectGuard(
      () =>
        asTenant(fx.tenantA, (c) =>
          c.query(
            `INSERT INTO web_vital_events (tenant_id, metric, value, rating, route_pattern)
             VALUES ($1,'LCP',100,'good','https://app.test/contacts/42')`,
            [fx.tenantA],
          ),
        ),
      /route_is_pattern|check constraint/i,
    );
  });

  it("refuses a fingerprint that did not come from fingerprintError()", async () => {
    // A forged POST could otherwise supply an arbitrary grouping key and
    // mint unbounded labels — the cardinality attack, in the one column
    // that is meant to be the cardinality bound.
    await expectGuard(
      () =>
        asTenant(fx.tenantA, (c) =>
          c.query(
            `INSERT INTO error_events (tenant_id, fingerprint, message)
             VALUES ($1, 'not-a-valid-fingerprint-at-all', 'x')`,
            [fx.tenantA],
          ),
        ),
      /fingerprint_shape|check constraint|value too long/i,
    );
  });

  it("refuses an absurd metric value that would poison every percentile", async () => {
    await expectGuard(
      () =>
        asTenant(fx.tenantA, (c) =>
          c.query(
            `INSERT INTO web_vital_events (tenant_id, metric, value, rating, route_pattern)
             VALUES ($1,'LCP',-5,'good','/dashboard')`,
            [fx.tenantA],
          ),
        ),
      /value_sane|check constraint/i,
    );
  });
});
