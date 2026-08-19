/**
 * Ordence — Platform Console Isolation & Evidence Integrity
 * Version: v0.14.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * PHASES 17 & 18 MANDATORY VERIFICATION
 * ══════════════════════════════════════════════════════════════════════
 * This is the one subsystem in the product that deliberately crosses the
 * tenant boundary. Everything asserted here is a property that, if it
 * silently stopped holding, would produce NO visible symptom until the
 * day somebody needed the evidence and found it had been edited.
 *
 * Five families of assertion:
 *
 *   1. A TENANT CANNOT SEE THE MACHINERY. Not the staff list, not the
 *      cross-tenant access log, not another workspace's sessions.
 *
 *   2. ⭐ THE PLATFORM CANNOT MANUFACTURE CONSENT. The platform-scoped
 *      connection can READ `tenant_support_consents` and is physically
 *      incapable of INSERTing into it. If this ever fails, "the customer
 *      agreed" becomes a claim we can write ourselves, and the entire
 *      consent model is theatre.
 *
 *   3. THE IMPERSONATION RECORD IS EVIDENCE. It cannot be deleted, its
 *      expiry cannot be extended, its justification cannot be rewritten,
 *      its mode cannot be laundered from break-glass to consented, and a
 *      closed session cannot be re-opened.
 *
 *   4. BREAK-GLASS IS READ-ONLY AND SESSIONS ARE SHORT — enforced by
 *      CHECK constraints, not only by TypeScript.
 *
 *   5. SUSPENSION DESTROYS NOTHING, and impersonation cannot delete.
 *
 * ⚠️ EVERY ISOLATION ASSERTION RUNS AS `ordence_app`, NOT AS `postgres`. A
 * superuser bypasses RLS entirely, so a suite connected as one would pass
 * with every policy dropped.
 *
 * ⚠️ THE ONE DELIBERATE EXCEPTION, STATED SO IT IS NOT MISTAKEN FOR THE
 * MISTAKE IT RESEMBLES. Four assertions below DO use `asSuperuser`, and
 * they are the ones testing TRIGGERS rather than policies. PostgreSQL
 * exempts superusers from RLS; it does NOT exempt them from triggers. So
 * for a tamper guard, running as the owner asserts something STRICTLY
 * STRONGER than running as `ordence_app` would — "not even the database
 * owner can delete this evidence", rather than "the app role happens not
 * to hold the privilege". Both layers are asserted separately, and each
 * one is labelled with which layer it is proving.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { asTenant, withoutTenant, asSuperuser, expectError, testPool } from "../setup";

type Fixtures = {
  tenantA: string;
  tenantB: string;
  slugA: string;
  slugB: string;
  userA: string;
  staffId: string;
  consentA: string;
  sessionA: string;
  contactA: string;
};

let fx: Fixtures;

/**
 * Assert a statement was refused BY THE GUARD UNDER TEST, not by a
 * missing GRANT.
 *
 * This distinction cost real time in Phase 9: a missing privilege raises
 * SQLSTATE 42501, which is exactly what our tamper triggers raise. A test
 * whose role simply had no rights on the table passed for entirely the
 * wrong reason and proved nothing at all.
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

/**
 * Run as the PLATFORM, the way `withPlatformScope()` will once INTEGRATION
 * step 1 lands: as the ordinary `ordence_app` role, in a transaction, with
 * `app.platform_scope` pinned transaction-locally.
 *
 * ⚠️ THIS IS NOT `asSuperuser`. It is the same non-superuser role every
 * other assertion uses, so the policies are fully in force — the marker
 * grants exactly what Section 6 of 0014 says it grants and nothing more.
 * That is what makes the "can read tenants, cannot read contacts" pair of
 * assertions below meaningful rather than decorative.
 */
async function asPlatform<T>(
  fn: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await testPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.platform_scope', 'on', true)");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const HOUR = 3_600_000;

beforeAll(async () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const slugA = `plat-a-${tenantA.slice(0, 8)}`;
  const slugB = `plat-b-${tenantB.slice(0, 8)}`;
  const userA = randomUUID();
  const staffId = randomUUID();
  const consentA = randomUUID();
  const sessionA = randomUUID();
  const contactA = randomUUID();

  await asSuperuser(async (c) => {
    for (const [id, slug, name] of [
      [tenantA, slugA, "Platform Tenant A"],
      [tenantB, slugB, "Platform Tenant B"],
    ] as const) {
      await c.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
         VALUES ($1,$2,$3,$4,'active')`,
        [id, `org_${id}`, slug, name],
      );
    }

    await c.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, status)
       VALUES ($1,$2,$3,$4,'tenant_owner','active')`,
      [userA, tenantA, `usr_${userA}`, `owner-${userA.slice(0, 8)}@example.com`],
    );

    // A customer record, so "suspension destroys nothing" has something
    // concrete to be true about.
    await c.query(
      `INSERT INTO contacts (id, tenant_id, first_name, last_name, email)
       VALUES ($1,$2,'Priya','Menon',$3)`,
      [contactA, tenantA, `priya-${contactA.slice(0, 8)}@acme.example`],
    );

    await c.query(
      `INSERT INTO platform_staff (id, clerk_user_id, email, grade, status, expires_at)
       VALUES ($1,$2,$3,'engineer','active', now() + interval '30 days')`,
      [staffId, `clerk_staff_${staffId}`, `staff-${staffId.slice(0, 8)}@ordence.example`],
    );

    await c.query(
      `INSERT INTO tenant_support_consents
         (id, tenant_id, mode, scope, granted_by_user_id, granted_by_email,
          granted_by_role, expires_at)
       VALUES ($1,$2,'standing','read_write',$3,$4,'tenant_owner', now() + interval '90 days')`,
      [consentA, tenantA, userA, `owner-${userA.slice(0, 8)}@example.com`],
    );

    await c.query(
      `INSERT INTO platform_impersonation_sessions
         (id, tenant_id, tenant_slug, staff_id, actor_clerk_id, actor_email,
          mode, scope, consent_id, justification, started_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,'standing_consent','read_write',$7,
               'ZD-4471 customer cannot open their July invoice', now(),
               now() + interval '60 minutes')`,
      [
        sessionA,
        tenantA,
        slugA,
        staffId,
        `clerk_staff_${staffId}`,
        `staff-${staffId.slice(0, 8)}@ordence.example`,
        consentA,
      ],
    );

    await c.query(
      `INSERT INTO platform_action_log
         (actor_clerk_id, actor_email, actor_grade, action, resource_type,
          justification, result_count)
       VALUES ($1,$2,'engineer','search','search:workspace_users',
               'ZD-4471 locating the workspace for a reported email', 1)`,
      [`clerk_staff_${staffId}`, `staff-${staffId.slice(0, 8)}@ordence.example`],
    );
  });

  fx = { tenantA, tenantB, slugA, slugB, userA, staffId, consentA, sessionA, contactA };
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    // Triggers refuse DELETE on the evidence tables even for the owner, so
    // teardown disables them explicitly. That this is NECESSARY is itself
    // a small proof that Section 2 and Section 3 are doing their job.
    await c.query("ALTER TABLE platform_impersonation_sessions DISABLE TRIGGER USER");
    await c.query("ALTER TABLE platform_action_log DISABLE TRIGGER USER");
    await c.query("ALTER TABLE tenant_support_consents DISABLE TRIGGER USER");
    // `audit_logs` has been append-only since Phase 1, so even the owner
    // cannot remove the rows this suite wrote. Disabled for teardown only.
    await c.query("ALTER TABLE audit_logs DISABLE TRIGGER USER");
    try {
      await c.query("DELETE FROM platform_impersonation_sessions WHERE tenant_id = ANY($1)", [
        [fx.tenantA, fx.tenantB],
      ]);
      await c.query("DELETE FROM platform_action_log WHERE actor_clerk_id = $1", [
        `clerk_staff_${fx.staffId}`,
      ]);
      await c.query("DELETE FROM tenant_support_consents WHERE tenant_id = ANY($1)", [
        [fx.tenantA, fx.tenantB],
      ]);
      await c.query("DELETE FROM platform_tenant_flags WHERE tenant_id = ANY($1)", [
        [fx.tenantA, fx.tenantB],
      ]);
      await c.query("DELETE FROM audit_logs WHERE tenant_id = ANY($1)", [
        [fx.tenantA, fx.tenantB],
      ]);
      await c.query("DELETE FROM contacts WHERE tenant_id = ANY($1)", [
        [fx.tenantA, fx.tenantB],
      ]);
      await c.query("DELETE FROM users WHERE tenant_id = ANY($1)", [
        [fx.tenantA, fx.tenantB],
      ]);
      await c.query("DELETE FROM platform_staff WHERE id = $1", [fx.staffId]);
      await c.query("DELETE FROM tenants WHERE id = ANY($1)", [[fx.tenantA, fx.tenantB]]);
    } finally {
      await c.query("ALTER TABLE platform_impersonation_sessions ENABLE TRIGGER USER");
      await c.query("ALTER TABLE platform_action_log ENABLE TRIGGER USER");
      await c.query("ALTER TABLE tenant_support_consents ENABLE TRIGGER USER");
      await c.query("ALTER TABLE audit_logs ENABLE TRIGGER USER");
    }
  });
});

/* ================================================================== */
/* 1. A TENANT CANNOT SEE THE MACHINERY                                */
/* ================================================================== */

describe("the console is invisible to tenants", () => {
  it("⭐ a tenant session sees ZERO rows in platform_staff", async () => {
    // The staff table is the map of who can cross the boundary. A tenant
    // admin reading it learns our internal access model and the names of
    // everyone worth phishing.
    const rows = await asTenant(fx.tenantA, async (c) =>
      c.query("SELECT id FROM platform_staff"),
    );
    expect(rows.rowCount).toBe(0);
  });

  it("⭐ a tenant session sees ZERO rows in the cross-tenant access log", async () => {
    const rows = await asTenant(fx.tenantA, async (c) =>
      c.query("SELECT id FROM platform_action_log"),
    );
    expect(rows.rowCount).toBe(0);
  });

  it("a tenant cannot INSERT itself into platform_staff", async () => {
    // The single most valuable write in the database. RLS refuses it
    // before any application code is involved.
    const error = await expectError(() =>
      asTenant(fx.tenantA, async (c) =>
        c.query(
          `INSERT INTO platform_staff (clerk_user_id, email, grade, status)
           VALUES ($1,$2,'owner','active')`,
          [`clerk_evil_${randomUUID()}`, "attacker@example.com"],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/row-level security/i);
  });

  it("⭐ a tenant CAN see impersonations of its OWN workspace", async () => {
    // Deliberate transparency: a customer is entitled to know who entered
    // their workspace, when, and why. It costs one OR clause and it is the
    // best answer available to an enterprise security review.
    const rows = await asTenant(fx.tenantA, async (c) =>
      c.query("SELECT id, actor_email, justification FROM platform_impersonation_sessions"),
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].justification).toMatch(/ZD-4471/);
  });

  it("⭐ a tenant CANNOT see impersonations of ANOTHER workspace", async () => {
    const rows = await asTenant(fx.tenantB, async (c) =>
      c.query("SELECT id FROM platform_impersonation_sessions"),
    );
    expect(rows.rowCount).toBe(0);
  });

  it("a tenant cannot forge an impersonation record for itself", async () => {
    // The WITH CHECK is `app_current_tenant_id() IS NULL`, so a tenant
    // session cannot write this table at all — including a row that would
    // manufacture evidence of access that never happened.
    const error = await expectError(() =>
      asTenant(fx.tenantA, async (c) =>
        c.query(
          `INSERT INTO platform_impersonation_sessions
             (tenant_id, tenant_slug, staff_id, actor_clerk_id, actor_email,
              mode, scope, justification, expires_at, break_glass_reason)
           VALUES ($1,$2,$3,'clerk_forged','forged@example.com','break_glass',
                   'read_only','forged evidence of an access event',
                   now() + interval '10 minutes',
                   'forged evidence of an access event that never happened')`,
          [fx.tenantA, fx.slugA, fx.staffId],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/row-level security/i);
  });
});

/* ================================================================== */
/* 2. THE PLATFORM CANNOT MANUFACTURE CONSENT                          */
/* ================================================================== */

describe("consent can only be given by the customer", () => {
  it("⭐⭐ the platform-scoped connection CANNOT insert a consent row", async () => {
    // THE most important assertion in this file. `withoutTenant()` is
    // exactly what `withPlatformScope()` uses — no tenant context. If this
    // insert ever succeeds, platform staff can write "they agreed" for any
    // workspace, and every other control in this phase is decorative.
    const error = await expectError(() =>
      withoutTenant(async (c) =>
        c.query(
          `INSERT INTO tenant_support_consents
             (tenant_id, mode, scope, granted_by_email, expires_at)
           VALUES ($1,'standing','read_write','platform-staff@ordence.example',
                   now() + interval '90 days')`,
          [fx.tenantB],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/row-level security/i);
  });

  it("the platform-scoped connection CAN read consent (it must, to honour it)", async () => {
    const rows = await withoutTenant(async (c) =>
      c.query("SELECT id, scope FROM tenant_support_consents WHERE tenant_id = $1", [
        fx.tenantA,
      ]),
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].scope).toBe("read_write");
  });

  it("a tenant CAN record its own consent", async () => {
    const created = await asTenant(fx.tenantB, async (c) =>
      c.query(
        `INSERT INTO tenant_support_consents
           (tenant_id, mode, scope, granted_by_email, expires_at)
         VALUES ($1,'incident','read_only','owner-b@example.com',
                 now() + interval '1 hour')
         RETURNING id`,
        [fx.tenantB],
      ),
    );
    expect(created.rowCount).toBe(1);
  });

  it("a tenant cannot record consent ON BEHALF OF another tenant", async () => {
    const error = await expectError(() =>
      asTenant(fx.tenantB, async (c) =>
        c.query(
          `INSERT INTO tenant_support_consents
             (tenant_id, mode, scope, granted_by_email, expires_at)
           VALUES ($1,'standing','read_write','owner-b@example.com',
                   now() + interval '90 days')`,
          [fx.tenantA],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/row-level security/i);
  });

  it("consent cannot be deleted — the app role has no DELETE privilege", async () => {
    // First layer: the GRANT was never made. `expectGuard` is deliberately
    // NOT used here — a privilege error is exactly what we want, and
    // expectGuard exists to reject that answer.
    const error = await expectError(() =>
      asTenant(fx.tenantA, async (c) =>
        c.query("DELETE FROM tenant_support_consents WHERE id = $1", [fx.consentA]),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/permission denied/i);
  });

  it("⭐ consent cannot be deleted even by a role that HAS the privilege", async () => {
    // Second layer, and the one that matters. `asSuperuser` inside an
    // assertion is normally worthless because a superuser bypasses RLS —
    // but a superuser DOES NOT bypass TRIGGERS, and a trigger is what is
    // under test here. This is the strongest form of the claim: not even
    // the database owner can quietly remove a consent record.
    await expectGuard(
      () =>
        asSuperuser(async (c) =>
          c.query("DELETE FROM tenant_support_consents WHERE id = $1", [fx.consentA]),
        ),
      /cannot be deleted/i,
    );
  });

  it("⭐ a revoked consent cannot be un-revoked", async () => {
    // Otherwise "they withdrew it" is reversible by whoever the withdrawal
    // inconvenienced.
    const consentId = randomUUID();
    await asSuperuser(async (c) => {
      await c.query(
        `INSERT INTO tenant_support_consents
           (id, tenant_id, mode, scope, granted_by_email, expires_at, revoked_at)
         VALUES ($1,$2,'standing','read_only','owner@example.com',
                 now() + interval '90 days', now())`,
        [consentId, fx.tenantA],
      );
    });

    await expectGuard(
      () =>
        asTenant(fx.tenantA, async (c) =>
          c.query("UPDATE tenant_support_consents SET revoked_at = NULL WHERE id = $1", [
            consentId,
          ]),
        ),
      /cannot be un-revoked/i,
    );
  });

  it("what was consented to cannot be rewritten after the fact", async () => {
    await expectGuard(
      () =>
        asTenant(fx.tenantA, async (c) =>
          // The fixture consent is `read_write`; narrowing it to `read_only`
          // is a REAL change, so the trigger actually has something to
          // refuse. Setting it to the value it already holds would be a
          // no-op — `IS DISTINCT FROM` sees no change and nothing fires,
          // which is a test that passes by doing nothing.
          c.query("UPDATE tenant_support_consents SET scope = 'read_only' WHERE id = $1", [
            fx.consentA,
          ]),
        ),
      /cannot be changed after the fact/i,
    );
  });
});

/* ================================================================== */
/* 3. THE IMPERSONATION RECORD IS EVIDENCE                             */
/* ================================================================== */

describe("impersonation evidence cannot be tampered with", () => {
  it("⭐ the application role has no DELETE privilege on the record", async () => {
    const error = await expectError(() =>
      withoutTenant(async (c) =>
        c.query("DELETE FROM platform_impersonation_sessions WHERE id = $1", [fx.sessionA]),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/permission denied/i);
  });

  it("⭐⭐ the record cannot be DELETED even by a role that HAS the privilege", async () => {
    // `asSuperuser` in an assertion is normally meaningless — a superuser
    // bypasses RLS entirely. It is NOT meaningless here: PostgreSQL does
    // not exempt superusers from triggers. So this asserts the strongest
    // available form of the property — the impersonation record cannot be
    // removed by anyone holding a database connection, including whoever
    // owns the database.
    await expectGuard(
      () =>
        asSuperuser(async (c) =>
          c.query("DELETE FROM platform_impersonation_sessions WHERE id = $1", [
            fx.sessionA,
          ]),
        ),
      /evidence and cannot be deleted/i,
    );
  });

  it("⭐ `expires_at` cannot be extended", async () => {
    // The rewrite that turns a 15-minute break-glass into an hour, or an
    // hour into a day, with no other trace.
    await expectGuard(
      () =>
        withoutTenant(async (c) =>
          c.query(
            `UPDATE platform_impersonation_sessions
             SET expires_at = now() + interval '10 hours' WHERE id = $1`,
            [fx.sessionA],
          ),
        ),
      /immutable/i,
    );
  });

  it("⭐ the justification cannot be rewritten", async () => {
    await expectGuard(
      () =>
        withoutTenant(async (c) =>
          c.query(
            `UPDATE platform_impersonation_sessions
             SET justification = 'a better sounding reason invented later'
             WHERE id = $1`,
            [fx.sessionA],
          ),
        ),
      /immutable/i,
    );
  });

  it("⭐ `mode` cannot be laundered from break-glass to consented", async () => {
    await expectGuard(
      () =>
        withoutTenant(async (c) =>
          c.query(
            `UPDATE platform_impersonation_sessions SET mode = 'incident_consent'
             WHERE id = $1`,
            [fx.sessionA],
          ),
        ),
      /immutable/i,
    );
  });

  it("the record cannot be moved to another tenant", async () => {
    await expectGuard(
      () =>
        withoutTenant(async (c) =>
          c.query("UPDATE platform_impersonation_sessions SET tenant_id = $1 WHERE id = $2", [
            fx.tenantB,
            fx.sessionA,
          ]),
        ),
      /immutable/i,
    );
  });

  it("the real human cannot be replaced with somebody else", async () => {
    await expectGuard(
      () =>
        withoutTenant(async (c) =>
          c.query(
            `UPDATE platform_impersonation_sessions SET actor_email = 'someone.else@ordence.example'
             WHERE id = $1`,
            [fx.sessionA],
          ),
        ),
      /immutable/i,
    );
  });

  it("closing a session ONCE is permitted — the one legal transition", async () => {
    const sessionId = await createSession({ mode: "standing_consent", scope: "read_write" });
    // Closing is a platform write, so it needs the platform-scope
    // marker — the policy's WITH CHECK is `app_platform_scope()`
    // (0079), not a blanket `IS NULL` any more.
    const result = await asPlatform(async (c) =>
      c.query(
        `UPDATE platform_impersonation_sessions
         SET ended_at = now(), ended_reason = 'operator_ended'
         WHERE id = $1 AND ended_at IS NULL`,
        [sessionId],
      ),
    );
    expect(result.rowCount).toBe(1);
  });

  it("⭐ a CLOSED session cannot be re-opened or re-closed", async () => {
    const sessionId = await createSession({ mode: "standing_consent", scope: "read_write" });
    await asPlatform(async (c) =>
      c.query(
        `UPDATE platform_impersonation_sessions
         SET ended_at = now(), ended_reason = 'operator_ended' WHERE id = $1`,
        [sessionId],
      ),
    );

    await expectGuard(
      () =>
        asPlatform(async (c) =>
          c.query("UPDATE platform_impersonation_sessions SET ended_at = NULL WHERE id = $1", [
            sessionId,
          ]),
        ),
      /already closed/i,
    );
  });

  it("the application role holds NO DELETE privilege on either evidence table", async () => {
    // Belt and braces alongside the triggers. If a trigger were ever
    // dropped by `drizzle-kit push`, this still refuses.
    const rows = await withoutTenant(async (c) =>
      c.query(
        `SELECT has_table_privilege('ordence_app','platform_impersonation_sessions','DELETE') AS s,
                has_table_privilege('ordence_app','platform_action_log','DELETE') AS l`,
      ),
    );
    expect(rows.rows[0].s).toBe(false);
    expect(rows.rows[0].l).toBe(false);
  });
});

/* ================================================================== */
/* 4. THE POLICY IS IN THE DATABASE, NOT ONLY IN TYPESCRIPT            */
/* ================================================================== */

describe("session constraints are enforced by the engine", () => {
  it("⭐ a break-glass session CANNOT be read-write", async () => {
    // The load-bearing rule of the consent model: access obtained without
    // the customer's agreement may look and may not touch. A bug in
    // `resolveScope()` cannot widen it.
    const error = await expectError(() =>
      // The INSERT must cross RLS, so it goes through the platform-scope
      // marker (`WITH CHECK app_platform_scope()`); the constraint then
      // catches the read-write break-glass combination the marker permits.
      asPlatform(async (c) =>
        c.query(
          `INSERT INTO platform_impersonation_sessions
             (tenant_id, tenant_slug, staff_id, actor_clerk_id, actor_email,
              mode, scope, justification, expires_at, break_glass_reason)
           VALUES ($1,$2,$3,'clerk_x','x@ordence.example','break_glass','read_write',
                   'emergency access to a workspace that is on fire',
                   now() + interval '15 minutes',
                   'emergency access to a workspace that is on fire')`,
          [fx.tenantA, fx.slugA, fx.staffId],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/breakglass_is_read_only/);
  });

  it("⭐ a session longer than the 60-minute ceiling is refused", async () => {
    const error = await expectError(() =>
      asPlatform(async (c) =>
        c.query(
          `INSERT INTO platform_impersonation_sessions
             (tenant_id, tenant_slug, staff_id, actor_clerk_id, actor_email,
              mode, scope, consent_id, justification, expires_at)
           VALUES ($1,$2,$3,'clerk_x','x@ordence.example','standing_consent','read_write',
                   $4,'a session that quietly lasts the whole working day',
                   now() + interval '9 hours')`,
          [fx.tenantA, fx.slugA, fx.staffId, fx.consentA],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/impersonation_max_duration/);
  });

  it('a justification of "fix" is refused', async () => {
    const error = await expectError(() =>
      asPlatform(async (c) =>
        c.query(
          `INSERT INTO platform_impersonation_sessions
             (tenant_id, tenant_slug, staff_id, actor_clerk_id, actor_email,
              mode, scope, consent_id, justification, expires_at)
           VALUES ($1,$2,$3,'clerk_x','x@ordence.example','standing_consent','read_write',
                   $4,'fix', now() + interval '30 minutes')`,
          [fx.tenantA, fx.slugA, fx.staffId, fx.consentA],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/impersonation_justification_length/);
  });

  it("a consented session must point at a consent row", async () => {
    const error = await expectError(() =>
      asPlatform(async (c) =>
        c.query(
          `INSERT INTO platform_impersonation_sessions
             (tenant_id, tenant_slug, staff_id, actor_clerk_id, actor_email,
              mode, scope, justification, expires_at)
           VALUES ($1,$2,$3,'clerk_x','x@ordence.example','standing_consent','read_write',
                   'claiming consent that does not exist anywhere',
                   now() + interval '30 minutes')`,
          [fx.tenantA, fx.slugA, fx.staffId],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/consented_session_has_consent/);
  });

  it("⭐ an EXPIRED session is not live, whatever any sweeper did or did not do", async () => {
    // Liveness is `now() < expires_at AND ended_at IS NULL`, evaluated on
    // every use. This row has an `ended_at` of NULL — it was never tidied —
    // and it must STILL not count as live.
    const sessionId = randomUUID();
    await asSuperuser(async (c) => {
      await c.query(
        `INSERT INTO platform_impersonation_sessions
           (id, tenant_id, tenant_slug, staff_id, actor_clerk_id, actor_email,
            mode, scope, consent_id, justification, started_at, expires_at)
         VALUES ($1,$2,$3,$4,'clerk_x','x@ordence.example','standing_consent','read_write',
                 $5,'a session nobody remembered to close afterwards',
                 now() - interval '3 hours', now() - interval '2 hours')`,
        [sessionId, fx.tenantA, fx.slugA, fx.staffId, fx.consentA],
      );
    });

    const live = await withoutTenant(async (c) =>
      c.query(
        `SELECT id FROM platform_impersonation_sessions
         WHERE id = $1 AND ended_at IS NULL AND expires_at > now()`,
        [sessionId],
      ),
    );
    expect(live.rowCount).toBe(0);

    // …and the untidied row is still there, still countable as history.
    const exists = await withoutTenant(async (c) =>
      c.query("SELECT ended_at FROM platform_impersonation_sessions WHERE id = $1", [
        sessionId,
      ]),
    );
    expect(exists.rowCount).toBe(1);
    expect(exists.rows[0].ended_at).toBeNull();
  });
});

/* ================================================================== */
/* 5. THE CROSS-TENANT ACCESS LOG IS APPEND-ONLY                       */
/* ================================================================== */

describe("the cross-tenant access log", () => {
  it("the application role holds neither UPDATE nor DELETE on it", async () => {
    const rows = await withoutTenant(async (c) =>
      c.query(
        `SELECT has_table_privilege('ordence_app','platform_action_log','UPDATE') AS u,
                has_table_privilege('ordence_app','platform_action_log','DELETE') AS d`,
      ),
    );
    expect(rows.rows[0].u).toBe(false);
    expect(rows.rows[0].d).toBe(false);
  });

  it("⭐ cannot be UPDATEd even by a role that HAS the privilege", async () => {
    // Superuser, deliberately — triggers are not bypassed by superusers.
    await expectGuard(
      () =>
        asSuperuser(async (c) =>
          c.query(
            "UPDATE platform_action_log SET justification = 'something more flattering'",
          ),
        ),
      /append-only/i,
    );
  });

  it("⭐ cannot be DELETEd even by a role that HAS the privilege", async () => {
    await expectGuard(
      () => asSuperuser(async (c) => c.query("DELETE FROM platform_action_log")),
      /append-only/i,
    );
  });
});

/* ================================================================== */
/* 6. ATTRIBUTION — THE REAL HUMAN, AND THE FLAG                       */
/* ================================================================== */

describe("impersonated actions are attributable", () => {
  it("⭐ an action taken under impersonation names the REAL human AND is flagged", async () => {
    // The failure this prevents: an audit trail that records only the
    // customer's own user, so the customer is blamed for our actions.
    const auditId = randomUUID();
    await asTenant(fx.tenantA, async (c) => {
      await c.query(
        `INSERT INTO audit_logs
           (id, tenant_id, actor_clerk_id, actor_email, actor_role, action,
            resource_type, resource_id, impersonation_id, reason, severity)
         VALUES ($1,$2,$3,$4,'platform_engineer','update','contact',$5,$6,
                 'ZD-4471 corrected the billing email at the customer''s request',
                 'warning')`,
        [
          auditId,
          fx.tenantA,
          `clerk_staff_${fx.staffId}`,
          `staff-${fx.staffId.slice(0, 8)}@ordence.example`,
          fx.contactA,
          fx.sessionA,
        ],
      );
    });

    const rows = await asTenant(fx.tenantA, async (c) =>
      c.query(
        "SELECT actor_clerk_id, actor_email, impersonation_id FROM audit_logs WHERE id = $1",
        [auditId],
      ),
    );

    expect(rows.rowCount).toBe(1);
    // The real human, not the customer's user.
    expect(rows.rows[0].actor_clerk_id).toBe(`clerk_staff_${fx.staffId}`);
    expect(rows.rows[0].actor_email).toMatch(/@ordence\.example$/);
    // AND flagged, so a reviewer can tell the two apart.
    expect(rows.rows[0].impersonation_id).toBe(fx.sessionA);
  });

  it("⭐ the customer can see that row in their OWN audit log", async () => {
    const rows = await asTenant(fx.tenantA, async (c) =>
      c.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND impersonation_id IS NOT NULL",
        [fx.tenantA],
      ),
    );
    expect(rows.rows[0].n).toBeGreaterThan(0);
  });

  it("another tenant cannot see it", async () => {
    const rows = await asTenant(fx.tenantB, async (c) =>
      c.query("SELECT count(*)::int AS n FROM audit_logs WHERE impersonation_id IS NOT NULL"),
    );
    expect(rows.rows[0].n).toBe(0);
  });
});

/* ================================================================== */
/* 7. SUSPENSION DESTROYS NOTHING                                      */
/* ================================================================== */

describe("suspension", () => {
  it("⭐ suspending a workspace does not delete a single row", async () => {
    const before = await asTenant(fx.tenantA, async (c) =>
      c.query("SELECT count(*)::int AS n FROM contacts WHERE deleted_at IS NULL"),
    );

    const suspended = await asPlatform(async (c) =>
      c.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [fx.tenantA]),
    );
    expect(suspended.rowCount, "the platform scope could not write tenants").toBe(1);

    const after = await asTenant(fx.tenantA, async (c) =>
      c.query("SELECT count(*)::int AS n FROM contacts WHERE deleted_at IS NULL"),
    );

    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(after.rows[0].n).toBeGreaterThan(0);
  });

  it("⭐ the customer's records are still READABLE while suspended — export must work", async () => {
    // `evaluateAccess()` maps `suspended` to `locked`, and `locked` still
    // permits export. Holding someone's records hostage over a billing
    // dispute is both wrong and, under DPDP, probably unlawful — so the
    // rows must remain reachable at the database level too.
    const rows = await asTenant(fx.tenantA, async (c) =>
      c.query("SELECT first_name, email FROM contacts WHERE id = $1", [fx.contactA]),
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].first_name).toBe("Priya");
  });

  it("reactivation restores the workspace exactly", async () => {
    await asPlatform(async (c) =>
      c.query("UPDATE tenants SET status = 'active' WHERE id = $1", [fx.tenantA]),
    );
    const rows = await asPlatform(async (c) =>
      c.query("SELECT status FROM tenants WHERE id = $1", [fx.tenantA]),
    );
    expect(rows.rows[0].status).toBe("active");
  });
});

/* ================================================================== */
/* 8. THE IMPERSONATION DELETE GUARD                                   */
/* ================================================================== */

describe("nothing can be deleted while impersonating", () => {
  it("⭐ a DELETE inside an impersonation context is refused by the DATABASE", async () => {
    // This is the one forbidden operation that does not depend on anybody
    // remembering to call the TypeScript gate. Deletion is also the only
    // one the customer cannot detect afterwards — a deleted contact leaves
    // no trace in their UI.
    await expectGuard(
      () =>
        asTenant(fx.tenantA, async (c) => {
          await c.query("SELECT set_config('app.impersonation_id', $1, true)", [
            fx.sessionA,
          ]);
          return c.query("DELETE FROM contacts WHERE id = $1", [fx.contactA]);
        }),
      /not permitted while impersonating/i,
    );

    // …and the record is still there.
    const rows = await asTenant(fx.tenantA, async (c) =>
      c.query("SELECT id FROM contacts WHERE id = $1", [fx.contactA]),
    );
    expect(rows.rowCount).toBe(1);
  });

  it("the guard is INERT when nobody is impersonating", async () => {
    // A guard that blocked ordinary deletes would take the product down.
    const throwaway = randomUUID();
    await asTenant(fx.tenantA, async (c) => {
      await c.query(
        "INSERT INTO contacts (id, tenant_id, first_name) VALUES ($1,$2,'Temp')",
        [throwaway, fx.tenantA],
      );
    });

    const result = await asTenant(fx.tenantA, async (c) =>
      c.query("DELETE FROM contacts WHERE id = $1", [throwaway]),
    );
    expect(result.rowCount).toBe(1);
  });

  it("the guard also protects billing and role tables", async () => {
    await expectGuard(
      () =>
        asTenant(fx.tenantA, async (c) => {
          await c.query("SELECT set_config('app.impersonation_id', $1, true)", [
            fx.sessionA,
          ]);
          return c.query("DELETE FROM users WHERE id = $1", [fx.userA]);
        }),
      /not permitted while impersonating/i,
    );
  });
});

/* ================================================================== */
/* 9. CROSS-TENANT READS NEED PLATFORM SCOPE                           */
/* ================================================================== */

describe("cross-tenant reads", () => {
  it("⭐ a tenant session cannot read another tenant's row, even by id", async () => {
    const rows = await asTenant(fx.tenantA, async (c) =>
      c.query("SELECT id, name FROM tenants WHERE id = $1", [fx.tenantB]),
    );
    expect(rows.rowCount).toBe(0);
  });

  it("a tenant session cannot read another tenant's flags", async () => {
    await asSuperuser(async (c) => {
      await c.query(
        `INSERT INTO platform_tenant_flags (tenant_id, flag_key, enabled, reason)
         VALUES ($1,'beta.ai_assistant',true,'early access while contract is signed')`,
        [fx.tenantB],
      );
    });

    const rows = await asTenant(fx.tenantA, async (c) =>
      c.query("SELECT id FROM platform_tenant_flags"),
    );
    expect(rows.rowCount).toBe(0);
  });

  it("⭐ a tenant CAN read its own flags but cannot write them", async () => {
    // The app has to read them to render. Writing is platform-only, so a
    // workspace cannot switch on a paid capability for itself.
    const readable = await asTenant(fx.tenantB, async (c) =>
      c.query("SELECT flag_key, enabled FROM platform_tenant_flags"),
    );
    expect(readable.rowCount).toBe(1);
    expect(readable.rows[0].enabled).toBe(true);

    const error = await expectError(() =>
      asTenant(fx.tenantB, async (c) =>
        c.query(
          `INSERT INTO platform_tenant_flags (tenant_id, flag_key, enabled, reason)
           VALUES ($1,'beta.advanced_reporting',true,'granting this to myself')`,
          [fx.tenantB],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/row-level security/i);
  });

  it("⭐ WITHOUT the platform marker, a context-less connection reads NOTHING", async () => {
    // The property db/index.ts calls out as load-bearing: "no context means
    // zero rows, never all rows". Adding a platform read scope must not
    // weaken it, so this asserts the OLD behaviour is unchanged.
    //
    // ⚠️ This is also the bug this phase found: `withPlatformScope()` as
    // currently written produces exactly this connection, which is why it
    // has never actually been able to read anything. See Section 6 of
    // 0014 and INTEGRATION step 1.
    const rows = await withoutTenant(async (c) =>
      c.query("SELECT id FROM tenants WHERE id = ANY($1)", [[fx.tenantA, fx.tenantB]]),
    );
    expect(rows.rowCount).toBe(0);
  });

  it("⭐ WITH the platform marker, it can read across tenants — that is the point", async () => {
    // The escape hatch has to work, or the console cannot exist. What makes
    // it acceptable is that reaching it in application code requires
    // `withPlatformScope()` with a written justification, and every use is
    // recorded in the append-only log asserted above.
    const rows = await asPlatform(async (c) =>
      c.query("SELECT id FROM tenants WHERE id = ANY($1)", [[fx.tenantA, fx.tenantB]]),
    );
    expect(rows.rowCount).toBe(2);
  });

  it("⭐⭐ the platform CANNOT read customer content, even with the marker set", async () => {
    // THE LINE, ASSERTED. Platform staff may see the commercial
    // relationship — who the workspace is, what they pay, who their users
    // are. They may not see the workspace's own records, because those
    // describe third parties who never had a relationship with us and for
    // whom we are a processor, not a controller.
    //
    // There is no grade, no capability and no TypeScript bug that changes
    // this: `contacts` simply has no platform clause in its policy.
    const contacts = await asPlatform(async (c) =>
      c.query("SELECT id FROM contacts WHERE tenant_id = $1", [fx.tenantA]),
    );
    expect(contacts.rowCount).toBe(0);

    // …while the same connection sees the workspace itself, and its users.
    const tenant = await asPlatform(async (c) =>
      c.query("SELECT id FROM tenants WHERE id = $1", [fx.tenantA]),
    );
    expect(tenant.rowCount).toBe(1);

    const users = await asPlatform(async (c) =>
      c.query("SELECT id FROM users WHERE tenant_id = $1", [fx.tenantA]),
    );
    expect(users.rowCount).toBe(1);
  });

  it("⭐ the platform can READ a customer's users but cannot WRITE them", async () => {
    // Role and status changes outlive any support session. The
    // impersonation deny-list forbids them in TypeScript; this is the
    // database's copy of the same rule, and it applies to the console
    // itself, not only to impersonation.
    const error = await expectError(() =>
      asPlatform(async (c) =>
        c.query("UPDATE users SET role = 'tenant_owner' WHERE id = $1", [fx.userA]),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/row-level security/i);
  });
});

/* ------------------------------------------------------------------ */
/* HELPERS                                                             */
/* ------------------------------------------------------------------ */

/**
 * Create a live session. Uses the ADMIN connection deliberately — this is
 * fixture setup, not an assertion, and the row it creates is what the
 * assertions then try (and fail) to tamper with.
 */
async function createSession(opts: {
  mode: "standing_consent" | "incident_consent" | "break_glass";
  scope: "read_only" | "read_write";
}): Promise<string> {
  const id = randomUUID();
  await asSuperuser(async (c) => {
    await c.query(
      `INSERT INTO platform_impersonation_sessions
         (id, tenant_id, tenant_slug, staff_id, actor_clerk_id, actor_email,
          mode, scope, consent_id, justification, started_at, expires_at)
       VALUES ($1,$2,$3,$4,'clerk_x','x@ordence.example',$5,$6,$7,
               'ZD-9001 reproducing a reported defect in the invoice view',
               now(), now() + interval '30 minutes')`,
      [
        id,
        fx.tenantA,
        fx.slugA,
        fx.staffId,
        opts.mode,
        opts.scope,
        opts.mode === "break_glass" ? null : fx.consentA,
      ],
    );
  });
  return id;
}

export { HOUR };
