/**
 * Ordence — Super Admin Console: The Properties That Must Hold
 * Version: v0.29.0-alpha (Phase 29)
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS FOR
 * ══════════════════════════════════════════════════════════════════════
 * Phase 29 finished the console: the tenant register with revenue and
 * health, the tenant detail with usage, invoices and security events, the
 * impersonation session register, the action register, and the ability
 * for an owner to end somebody else's session.
 *
 * Every one of those is a screen that reads across the tenant boundary,
 * so every one of them is a place where the boundary could quietly stop
 * holding. The five assertions the phase brief demands are the five whose
 * failure has NO OTHER SYMPTOM — nothing breaks, no page errors, and the
 * first sign of trouble is the day somebody needs the evidence:
 *
 *   1. A TENANT USER CANNOT REACH THE PLATFORM TABLES.
 *   2. THE PLATFORM SCOPE DOES NOT EXPOSE CUSTOMER CONTENT.
 *   3. AN IMPERSONATION SESSION WITHOUT CONSENT IS REFUSED.
 *   4. AN EXPIRED SESSION IS REFUSED.
 *   5. THE ACTION LOG IS APPEND-ONLY.
 *
 * ⚠️ EVERY ISOLATION ASSERTION RUNS AS `ordence_app`, NEVER AS `postgres`.
 * A superuser bypasses RLS entirely, so a suite connected as one would
 * pass with every policy dropped.
 *
 * ⚠️ THE DELIBERATE EXCEPTION, STATED SO IT IS NOT MISTAKEN FOR THE
 * MISTAKE IT RESEMBLES. The tamper assertions DO run as `asSuperuser`,
 * because they test TRIGGERS rather than policies. PostgreSQL exempts a
 * superuser from RLS; it does NOT exempt one from triggers. So for a
 * tamper guard, running as the owner proves something STRICTLY STRONGER
 * — "not even the database owner can rewrite this" rather than "the app
 * role happens to lack the privilege". Both layers are asserted, and each
 * assertion says which layer it is proving.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { asTenant, asPlatform, asSuperuser, expectError, testPool } from "../setup";

/* ------------------------------------------------------------------ */
/* HELPERS                                                             */
/* ------------------------------------------------------------------ */

/**
 * Assert a statement was refused BY THE GUARD UNDER TEST, not by a
 * missing GRANT.
 *
 * A missing privilege raises SQLSTATE 42501 — which is exactly what the
 * tamper triggers raise on purpose. Without this distinction, a test
 * whose role simply had no rights on the table passes for entirely the
 * wrong reason and proves nothing at all.
 */
async function expectGuard(
  fn: () => Promise<unknown>,
  messagePattern: RegExp,
): Promise<void> {
  const error = await expectError(fn);
  expect(error, "expected the statement to be refused, but it succeeded").not.toBeNull();
  expect(
    error!.message,
    `the statement failed with a PRIVILEGE error rather than the guard under ` +
      `test — the role is missing a GRANT and this test proves nothing: ${error!.message}`,
  ).not.toMatch(/permission denied for (table|relation)/i);
  expect(error!.message).toMatch(messagePattern);
}

type Fixtures = {
  tenantA: string;
  tenantB: string;
  slugA: string;
  slugB: string;
  ownerA: string;
  ownerEmailA: string;
  staffId: string;
  staffClerkId: string;
  staffEmail: string;
  consentA: string;
  liveSession: string;
  expiredSession: string;
  breakGlassSession: string;
  contactA: string;
  actionLogId: string;
  auditRowId: string;
};

let fx: Fixtures;

beforeAll(async () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const slugA = `p29-a-${tenantA.slice(0, 8)}`;
  const slugB = `p29-b-${tenantB.slice(0, 8)}`;
  const ownerA = randomUUID();
  const ownerEmailA = `owner-${ownerA.slice(0, 8)}@example.com`;
  const staffId = randomUUID();
  const staffClerkId = `clerk_p29_${staffId}`;
  const staffEmail = `p29-${staffId.slice(0, 8)}@ordence.example`;
  const consentA = randomUUID();
  const liveSession = randomUUID();
  const expiredSession = randomUUID();
  const breakGlassSession = randomUUID();
  const contactA = randomUUID();
  const actionLogId = randomUUID();
  const auditRowId = randomUUID();

  await asSuperuser(async (c) => {
    for (const [id, slug, name] of [
      [tenantA, slugA, "Phase29 Tenant A"],
      [tenantB, slugB, "Phase29 Tenant B"],
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
      [ownerA, tenantA, `usr_${ownerA}`, ownerEmailA],
    );

    // A customer record — so "the console cannot read customer content"
    // is a statement about something that actually exists.
    await c.query(
      `INSERT INTO contacts (id, tenant_id, first_name, last_name, email)
       VALUES ($1,$2,'Anjali','Rao',$3)`,
      [contactA, tenantA, `anjali-${contactA.slice(0, 8)}@acme.example`],
    );

    await c.query(
      `INSERT INTO platform_staff (id, clerk_user_id, email, grade, status, expires_at)
       VALUES ($1,$2,$3,'owner','active', now() + interval '30 days')`,
      [staffId, staffClerkId, staffEmail],
    );

    await c.query(
      `INSERT INTO tenant_support_consents
         (id, tenant_id, mode, scope, granted_by_user_id, granted_by_email,
          granted_by_role, expires_at)
       VALUES ($1,$2,'standing','read_write',$3,$4,'tenant_owner',
               now() + interval '90 days')`,
      [consentA, tenantA, ownerA, ownerEmailA],
    );

    // Live: started now, expires in an hour, never closed.
    await c.query(
      `INSERT INTO platform_impersonation_sessions
         (id, tenant_id, tenant_slug, staff_id, actor_clerk_id, actor_email,
          mode, scope, consent_id, justification, started_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,'standing_consent','read_write',$7,
               'ZD-9001 customer reports their July invoice will not open',
               now(), now() + interval '60 minutes')`,
      [liveSession, tenantA, slugA, staffId, staffClerkId, staffEmail, consentA],
    );

    // Expired: the window closed two hours ago and NOTHING TIDIED IT.
    // `ended_at` is still NULL on purpose — that is the state the sweeper
    // would have cleaned, and the state where a naive liveness check
    // ("ended_at IS NULL") reports an intruder who left long ago.
    await c.query(
      `INSERT INTO platform_impersonation_sessions
         (id, tenant_id, tenant_slug, staff_id, actor_clerk_id, actor_email,
          mode, scope, consent_id, justification, started_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,'standing_consent','read_write',$7,
               'ZD-8800 diagnosing a stuck import for the customer',
               now() - interval '3 hours', now() - interval '2 hours')`,
      [expiredSession, tenantA, slugA, staffId, staffClerkId, staffEmail, consentA],
    );

    // Break-glass against the OTHER tenant, which has no consent at all.
    await c.query(
      `INSERT INTO platform_impersonation_sessions
         (id, tenant_id, tenant_slug, staff_id, actor_clerk_id, actor_email,
          mode, scope, consent_id, justification, started_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,'break_glass','read_only',NULL,
               'SEV-1 nobody at the customer is reachable and billing is down',
               now(), now() + interval '15 minutes')`,
      [breakGlassSession, tenantB, slugB, staffId, staffClerkId, staffEmail],
    );

    await c.query(
      `INSERT INTO platform_action_log
         (id, actor_clerk_id, actor_email, actor_grade, action, resource_type,
          justification, result_count, severity)
       VALUES ($1,$2,$3,'owner','search','search:workspace_users',
               'ZD-9001 locating the workspace for a reported address', 1, 'notice')`,
      [actionLogId, staffClerkId, staffEmail],
    );

    // A tenant-attributed platform action — the row the console's
    // "platform activity" panel reads back from the CUSTOMER'S own log.
    await c.query(
      `INSERT INTO audit_logs
         (id, tenant_id, actor_clerk_id, actor_email, actor_role, action,
          resource_type, resource_id, reason, severity, metadata)
       VALUES ($1,$2,$3,$4,'platform_owner','read','tenant',$5,
               'Platform staff opened this workspace in the support console.',
               'notice', '{"source":"platform_console"}'::jsonb)`,
      [auditRowId, tenantA, staffClerkId, staffEmail, tenantA],
    );
  });

  fx = {
    tenantA,
    tenantB,
    slugA,
    slugB,
    ownerA,
    ownerEmailA,
    staffId,
    staffClerkId,
    staffEmail,
    consentA,
    liveSession,
    expiredSession,
    breakGlassSession,
    contactA,
    actionLogId,
    auditRowId,
  };
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    // The tamper triggers refuse DELETE even to the database owner, so
    // teardown has to disable them explicitly. That this is NECESSARY is
    // itself a small proof that the guards are doing their job.
    await c.query("ALTER TABLE platform_impersonation_sessions DISABLE TRIGGER USER");
    await c.query("ALTER TABLE platform_action_log DISABLE TRIGGER USER");
    await c.query("ALTER TABLE tenant_support_consents DISABLE TRIGGER USER");
    await c.query("ALTER TABLE audit_logs DISABLE TRIGGER USER");
    try {
      await c.query(
        "DELETE FROM platform_impersonation_sessions WHERE tenant_id = ANY($1)",
        [[fx.tenantA, fx.tenantB]],
      );
      await c.query("DELETE FROM platform_action_log WHERE actor_clerk_id = $1", [
        fx.staffClerkId,
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
/* 1. A TENANT USER CANNOT REACH THE PLATFORM TABLES                   */
/* ================================================================== */

describe("1. a tenant user cannot reach the platform tables", () => {
  it("⭐ sees ZERO rows in platform_staff — the map of who can cross the boundary", async () => {
    // A tenant administrator reading this table learns our internal
    // access model and the address of everybody worth phishing.
    const rows = await asTenant(fx.tenantA, (c) =>
      c.query("SELECT id, email, grade FROM platform_staff"),
    );
    expect(rows.rowCount).toBe(0);
  });

  it("⭐ sees ZERO rows in the platform action register", async () => {
    // This register holds "an operator searched every workspace for an
    // email address". It is about our staff and is not the customer's to
    // read — and, more sharply, a tenant that could read it would learn
    // which other workspaces are being investigated.
    const rows = await asTenant(fx.tenantA, (c) =>
      c.query("SELECT id FROM platform_action_log"),
    );
    expect(rows.rowCount).toBe(0);
  });

  it("cannot WRITE its own row into the platform action register", async () => {
    // The register is evidence about us. A tenant able to insert into it
    // could manufacture a record of platform activity that never
    // happened — or bury a real one under noise.
    await expectGuard(
      () =>
        asTenant(fx.tenantA, (c) =>
          c.query(
            `INSERT INTO platform_action_log
               (actor_clerk_id, actor_email, actor_grade, action, resource_type, justification)
             VALUES ('forged','attacker@example.com','owner','search','tenants',
                     'a fabricated entry written by a tenant session')`,
          ),
        ),
      /row-level security|violates row-level security policy/i,
    );
  });

  it("cannot grant itself a platform staff record", async () => {
    // The two-key model says a database compromise alone is not enough.
    // This is the database half of it: a tenant session cannot even write
    // the key that lives in the database.
    await expectGuard(
      () =>
        asTenant(fx.tenantA, (c) =>
          c.query(
            `INSERT INTO platform_staff (clerk_user_id, email, grade, status)
             VALUES ('clerk_self_promoted','attacker@example.com','owner','active')`,
          ),
        ),
      /row-level security/i,
    );
  });

  it("⭐ sees its OWN impersonation sessions and never another workspace's", async () => {
    // The asymmetry is deliberate: a customer is entitled to see who from
    // the platform entered THEIR workspace — that is the panel that wins
    // enterprise security reviews — and entitled to nothing about anyone
    // else's.
    const own = await asTenant(fx.tenantA, (c) =>
      c.query("SELECT id FROM platform_impersonation_sessions"),
    );
    const ids = own.rows.map((r: { id: string }) => r.id);
    expect(ids).toContain(fx.liveSession);
    expect(ids).not.toContain(fx.breakGlassSession);

    const other = await asTenant(fx.tenantB, (c) =>
      c.query("SELECT id FROM platform_impersonation_sessions WHERE id = $1", [
        fx.liveSession,
      ]),
    );
    expect(other.rowCount).toBe(0);
  });

  it("⭐ cannot switch on a feature flag for itself", async () => {
    // Flags are ours, not theirs: a tenant that can write this table can
    // grant itself whatever a flag unlocks — including, one day, a paid
    // capability. Reads are permitted (the app has to render); writes are
    // refused by the WITH CHECK clause.
    await expectGuard(
      () =>
        asTenant(fx.tenantA, (c) =>
          c.query(
            `INSERT INTO platform_tenant_flags (tenant_id, flag_key, enabled, reason)
             VALUES ($1,'beta_features',true,'turned on by the tenant itself')`,
            [fx.tenantA],
          ),
        ),
      /row-level security/i,
    );
  });

  it("⭐ cannot write itself a support consent from ANOTHER workspace's session", async () => {
    // Consent belongs to the workspace it is about. Tenant B writing a
    // consent row for tenant A would be one customer authorising access
    // to another.
    await expectGuard(
      () =>
        asTenant(fx.tenantB, (c) =>
          c.query(
            `INSERT INTO tenant_support_consents (tenant_id, mode, scope, expires_at)
             VALUES ($1,'standing','read_write', now() + interval '90 days')`,
            [fx.tenantA],
          ),
        ),
      /row-level security/i,
    );
  });
});

/* ================================================================== */
/* 2. THE PLATFORM SCOPE DOES NOT EXPOSE CUSTOMER CONTENT              */
/* ================================================================== */

describe("2. the platform scope reads relationships, never content", () => {
  it("⭐ reads ZERO rows from contacts — with a contact sitting right there", async () => {
    // The single most important assertion in the console's data-protection
    // story. Not "the query does not ask for it" — the DATABASE refuses,
    // at any grade, through any bug in the TypeScript.
    const present = await asSuperuser((c) =>
      c.query("SELECT id FROM contacts WHERE id = $1", [fx.contactA]),
    );
    expect(present.rowCount, "fixture missing — this test would pass vacuously").toBe(1);

    const seen = await asPlatform((c) =>
      c.query("SELECT id FROM contacts WHERE id = $1", [fx.contactA]),
    );
    expect(seen.rowCount).toBe(0);
  });

  it("reads ZERO rows from every other customer-content table", async () => {
    for (const table of [
      "companies",
      "deals",
      "custom_object_records",
      "contracts",
      "contract_versions",
      "journal_entries",
      "transactions",
    ]) {
      const rows = await asPlatform((c) => c.query(`SELECT 1 FROM ${table} LIMIT 1`));
      expect(rows.rowCount, `${table} became readable from the platform scope`).toBe(0);
    }
  });

  it("CAN read the commercial relationship — otherwise the console is blank", async () => {
    // The mirror of the assertion above, and it matters just as much: a
    // console that reads nothing fails closed and is also useless, and a
    // useless console is one people replace with a database client.
    const tenants = await asPlatform((c) =>
      c.query("SELECT id, slug, plan_tier, status FROM tenants WHERE id = $1", [fx.tenantA]),
    );
    expect(tenants.rowCount).toBe(1);

    const users = await asPlatform((c) =>
      c.query("SELECT id, email, role FROM users WHERE tenant_id = $1", [fx.tenantA]),
    );
    expect(users.rowCount).toBe(1);
  });

  it("⭐ CANNOT WRITE a customer's user record, only read it", async () => {
    // Roles and status outlive any session. The platform clause is on the
    // read policy of `users` and on neither write policy, which is the
    // database's copy of the impersonation deny-list rule.
    await expectGuard(
      () =>
        asPlatform((c) =>
          c.query("UPDATE users SET role = 'tenant_owner' WHERE id = $1", [fx.ownerA]),
        ),
      /row-level security/i,
    );
  });

  it("⭐ PHASE 29 DID NOT WIDEN THE SCOPE: usage, security events and audit logs stay per-tenant", async () => {
    // The tenant detail page grew three panels that read these tables.
    // The shortcut would have been to add the platform marker to their
    // policies; it was refused, because that turns "read one workspace I
    // deliberately opened" into "read every workspace at once".
    //
    // These reads therefore return ZERO from the platform scope, and the
    // console reads them inside `withTenant()` instead — asserted below.
    const auditFromPlatform = await asPlatform((c) =>
      c.query("SELECT id FROM audit_logs WHERE id = $1", [fx.auditRowId]),
    );
    expect(auditFromPlatform.rowCount).toBe(0);

    const auditFromTenant = await asTenant(fx.tenantA, (c) =>
      c.query("SELECT id FROM audit_logs WHERE id = $1", [fx.auditRowId]),
    );
    expect(auditFromTenant.rowCount).toBe(1);

    for (const table of ["usage_counters", "usage_levels", "security_events"]) {
      const rows = await asPlatform((c) =>
        c.query(`SELECT 1 FROM ${table} WHERE tenant_id = $1 LIMIT 1`, [fx.tenantA]),
      );
      expect(
        rows.rowCount,
        `${table} acquired the platform marker — Phase 29 refused that trade`,
      ).toBe(0);
    }
  });

  it("⭐ the customer can read the platform's actions against them, in their own log", async () => {
    // "Everything we do TO a tenant is something they can see us doing"
    // is only true if the row is in a table their own session can read.
    // Asserted from the tenant's context, which is where their audit page
    // reads from.
    const rows = await asTenant(fx.tenantA, (c) =>
      c.query(
        `SELECT actor_email, reason FROM audit_logs
          WHERE tenant_id = $1 AND metadata ->> 'source' = 'platform_console'`,
        [fx.tenantA],
      ),
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].actor_email).toBe(fx.staffEmail);

    // And the other customer sees nothing of it.
    const neighbour = await asTenant(fx.tenantB, (c) =>
      c.query("SELECT id FROM audit_logs WHERE id = $1", [fx.auditRowId]),
    );
    expect(neighbour.rowCount).toBe(0);
  });
});

/* ================================================================== */
/* 3. AN IMPERSONATION SESSION WITHOUT CONSENT IS REFUSED              */
/* ================================================================== */

describe("3. a session without consent is refused", () => {
  it("⭐ a consented session with no consent row is refused by the DATABASE", async () => {
    // Not by a TypeScript branch — by `consented_session_has_consent`. A
    // session claiming the customer agreed, pointing at nothing, is a
    // claim nobody can check.
    await expectGuard(
      () =>
        asPlatform((c) =>
          c.query(
            `INSERT INTO platform_impersonation_sessions
               (tenant_id, tenant_slug, staff_id, actor_clerk_id, actor_email,
                mode, scope, consent_id, justification, expires_at)
             VALUES ($1,$2,$3,$4,$5,'standing_consent','read_write',NULL,
                     'no consent row exists for this workspace at all',
                     now() + interval '30 minutes')`,
            [fx.tenantB, fx.slugB, fx.staffId, fx.staffClerkId, fx.staffEmail],
          ),
        ),
      /consented_session_has_consent|violates check constraint/i,
    );
  });

  it("⭐ break-glass CANNOT be read-write, whatever the application says", async () => {
    // The load-bearing rule of the whole consent model: access obtained
    // WITHOUT the customer's agreement may look and may not touch. A bug
    // in `resolveScope()` cannot widen it.
    await expectGuard(
      () =>
        asPlatform((c) =>
          c.query(
            `INSERT INTO platform_impersonation_sessions
               (tenant_id, tenant_slug, staff_id, actor_clerk_id, actor_email,
                mode, scope, justification, expires_at)
             VALUES ($1,$2,$3,$4,$5,'break_glass','read_write',
                     'SEV-1 and I would like to be able to change things',
                     now() + interval '15 minutes')`,
            [fx.tenantB, fx.slugB, fx.staffId, fx.staffClerkId, fx.staffEmail],
          ),
        ),
      /breakglass_is_read_only|violates check constraint/i,
    );
  });

  it("⭐ THE PLATFORM CANNOT MANUFACTURE THE CONSENT IT THEN LEANS ON", async () => {
    // If this ever passes, the console can write itself permission and
    // every consented session in the system rests on nothing. This is the
    // assertion that makes the word "consent" mean something.
    await expectGuard(
      () =>
        asPlatform((c) =>
          c.query(
            `INSERT INTO tenant_support_consents
               (tenant_id, mode, scope, granted_by_email, expires_at)
             VALUES ($1,'standing','read_write','support@ordence.example',
                     now() + interval '90 days')`,
            [fx.tenantB],
          ),
        ),
      /row-level security/i,
    );
  });

  it("the platform CAN read consent — it has to, to check it", async () => {
    const rows = await asPlatform((c) =>
      c.query(
        "SELECT id, scope, expires_at, revoked_at FROM tenant_support_consents WHERE id = $1",
        [fx.consentA],
      ),
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].scope).toBe("read_write");
  });

  it("a session cannot outlive the sixty-minute ceiling", async () => {
    // The constant in `lib/platform/impersonation-policy.ts` can be
    // edited in one line. This cannot be edited without a migration and a
    // review, which is the difference between a limit and a preference.
    await expectGuard(
      () =>
        asPlatform((c) =>
          c.query(
            `INSERT INTO platform_impersonation_sessions
               (tenant_id, tenant_slug, staff_id, actor_clerk_id, actor_email,
                mode, scope, consent_id, justification, started_at, expires_at)
             VALUES ($1,$2,$3,$4,$5,'standing_consent','read_write',$6,
                     'a nine hour window would be very convenient for me',
                     now(), now() + interval '9 hours')`,
            [fx.tenantA, fx.slugA, fx.staffId, fx.staffClerkId, fx.staffEmail, fx.consentA],
          ),
        ),
      /impersonation_max_duration|violates check constraint/i,
    );
  });

  it("a justification of 'fix' is refused", async () => {
    await expectGuard(
      () =>
        asPlatform((c) =>
          c.query(
            `INSERT INTO platform_impersonation_sessions
               (tenant_id, tenant_slug, staff_id, actor_clerk_id, actor_email,
                mode, scope, consent_id, justification, expires_at)
             VALUES ($1,$2,$3,$4,$5,'standing_consent','read_write',$6,'fix',
                     now() + interval '30 minutes')`,
            [fx.tenantA, fx.slugA, fx.staffId, fx.staffClerkId, fx.staffEmail, fx.consentA],
          ),
        ),
      /impersonation_justification_length|violates check constraint/i,
    );
  });
});

/* ================================================================== */
/* 4. AN EXPIRED SESSION IS REFUSED                                    */
/* ================================================================== */

describe("4. an expired session is refused", () => {
  /**
   * The liveness predicate, written exactly as every read path in the
   * console writes it. If this test and the application ever disagree,
   * one of them is letting somebody stay inside a customer's workspace.
   */
  const LIVE = `ended_at IS NULL AND expires_at > now()`;

  it("⭐ the expired session is NOT live, even though nothing closed it", async () => {
    // `ended_at` is still NULL on this fixture — the sweeper has not run.
    // The row LOOKS open and is not. Anything that treated `ended_at` as
    // the authority would hand the operator another hour.
    const untidied = await asPlatform((c) =>
      c.query("SELECT ended_at, expires_at FROM platform_impersonation_sessions WHERE id = $1", [
        fx.expiredSession,
      ]),
    );
    expect(untidied.rows[0].ended_at).toBeNull();

    const live = await asPlatform((c) =>
      c.query(
        `SELECT id FROM platform_impersonation_sessions WHERE id = $1 AND ${LIVE}`,
        [fx.expiredSession],
      ),
    );
    expect(live.rowCount, "an expired session was reported as live").toBe(0);
  });

  it("the live session IS live, so the predicate is not simply refusing everything", async () => {
    // A liveness check that returns nothing for every input would pass the
    // assertion above and be catastrophic in the other direction.
    const live = await asPlatform((c) =>
      c.query(
        `SELECT id FROM platform_impersonation_sessions WHERE id = $1 AND ${LIVE}`,
        [fx.liveSession],
      ),
    );
    expect(live.rowCount).toBe(1);
  });

  it("⭐ a closed session cannot be re-opened by clearing the end time", async () => {
    // The obvious way to extend access: close it, then un-close it.
    await asSuperuser((c) =>
      c.query(
        `UPDATE platform_impersonation_sessions
            SET ended_at = now(), ended_reason = 'operator_ended'
          WHERE id = $1`,
        [fx.liveSession],
      ),
    );

    await expectGuard(
      () =>
        asSuperuser((c) =>
          c.query(
            `UPDATE platform_impersonation_sessions
                SET ended_at = NULL, ended_reason = NULL WHERE id = $1`,
            [fx.liveSession],
          ),
        ),
      /already closed|cannot be changed/i,
    );

    // ...and it cannot be re-closed with a nicer reason either.
    await expectGuard(
      () =>
        asSuperuser((c) =>
          c.query(
            `UPDATE platform_impersonation_sessions
                SET ended_reason = 'revoked_by_tenant' WHERE id = $1`,
            [fx.liveSession],
          ),
        ),
      /already closed|cannot be changed/i,
    );
  });

  it("⭐ an expiry cannot be extended — not by the app role, not by the owner", async () => {
    // The rewrite that turns a fifteen-minute break-glass into an hour.
    // Asserted at BOTH layers: the trigger (owner) and RLS plus the
    // trigger (application role).
    await expectGuard(
      () =>
        asSuperuser((c) =>
          c.query(
            `UPDATE platform_impersonation_sessions
                SET expires_at = now() + interval '10 hours' WHERE id = $1`,
            [fx.expiredSession],
          ),
        ),
      /immutable|Only ended_at/i,
    );

    await expectGuard(
      () =>
        asPlatform((c) =>
          c.query(
            `UPDATE platform_impersonation_sessions
                SET expires_at = now() + interval '10 hours' WHERE id = $1`,
            [fx.expiredSession],
          ),
        ),
      /immutable|Only ended_at/i,
    );
  });

  it("⭐ a break-glass session cannot be relabelled as consented after the fact", async () => {
    // The laundering rewrite: "we had permission all along".
    await expectGuard(
      () =>
        asSuperuser((c) =>
          c.query(
            `UPDATE platform_impersonation_sessions
                SET mode = 'standing_consent' WHERE id = $1`,
            [fx.breakGlassSession],
          ),
        ),
      /immutable|Only ended_at/i,
    );
  });

  it("a justification cannot be rewritten after the customer complains", async () => {
    await expectGuard(
      () =>
        asSuperuser((c) =>
          c.query(
            `UPDATE platform_impersonation_sessions
                SET justification = 'a much better sounding reason' WHERE id = $1`,
            [fx.expiredSession],
          ),
        ),
      /immutable|Only ended_at/i,
    );
  });

  it("⭐ evidence cannot be DELETED — the app role has no privilege, and the owner has a trigger", async () => {
    const grant = await asSuperuser((c) =>
      c.query(
        "SELECT has_table_privilege('ordence_app','platform_impersonation_sessions','DELETE') AS can",
      ),
    );
    expect(grant.rows[0].can, "the application role can delete its own access evidence").toBe(
      false,
    );

    await expectGuard(
      () =>
        asSuperuser((c) =>
          c.query("DELETE FROM platform_impersonation_sessions WHERE id = $1", [
            fx.expiredSession,
          ]),
        ),
      /evidence and cannot be deleted/i,
    );
  });

  it("the one-way close DOES work — otherwise a session could never be ended early", async () => {
    // Phase 29 added "end somebody else's session" for the stolen-laptop
    // case. If the freeze trigger were too strict, that control would not
    // exist and an operator would have to wait out the clock.
    const closed = await asPlatform((c) =>
      c.query(
        `UPDATE platform_impersonation_sessions
            SET ended_at = now(), ended_reason = 'revoked_by_platform'
          WHERE id = $1 AND ended_at IS NULL
        RETURNING id, ended_reason`,
        [fx.breakGlassSession],
      ),
    );
    expect(closed.rowCount).toBe(1);
    expect(closed.rows[0].ended_reason).toBe("revoked_by_platform");
  });
});

/* ================================================================== */
/* 5. THE ACTION LOG IS APPEND-ONLY                                    */
/* ================================================================== */

describe("5. the action register is append-only", () => {
  it("⭐ a row cannot be DELETED by the application role — no privilege at all", async () => {
    const grant = await asSuperuser((c) =>
      c.query("SELECT has_table_privilege('ordence_app','platform_action_log','DELETE') AS can"),
    );
    expect(grant.rows[0].can, "an 'erase what I looked at' privilege exists").toBe(false);
  });

  it("⭐ a row cannot be DELETED by the database owner either — the trigger refuses", async () => {
    // Two layers on purpose. A trigger dropped by `drizzle-kit push` is a
    // silent failure, and a GRANT restored by a hurried "GRANT ALL" is
    // another; either alone would leave the register erasable.
    await expectGuard(
      () =>
        asSuperuser((c) =>
          c.query("DELETE FROM platform_action_log WHERE id = $1", [fx.actionLogId]),
        ),
      /append-only|cannot be deleted/i,
    );
  });

  it("⭐ a row cannot be EDITED — a justification is what it was when it was written", async () => {
    await expectGuard(
      () =>
        asSuperuser((c) =>
          c.query(
            "UPDATE platform_action_log SET justification = 'a tidier reason' WHERE id = $1",
            [fx.actionLogId],
          ),
        ),
      /append-only|cannot be (modified|updated|changed)/i,
    );
  });

  it("the result count cannot be quietly reduced", async () => {
    // "I only saw two rows" is a claim the register is supposed to settle.
    await expectGuard(
      () =>
        asSuperuser((c) =>
          c.query("UPDATE platform_action_log SET result_count = 0 WHERE id = $1", [
            fx.actionLogId,
          ]),
        ),
      /append-only|cannot be (modified|updated|changed)/i,
    );
  });

  it("⭐ a cross-tenant action cannot be logged without a written reason", async () => {
    // Phase 29 moved this floor from TypeScript into the database. "debug"
    // is not a justification and neither is "".
    await expectGuard(
      () =>
        asPlatform((c) =>
          c.query(
            `INSERT INTO platform_action_log
               (actor_clerk_id, actor_email, actor_grade, action, resource_type, justification)
             VALUES ($1,$2,'owner','search','tenants','debug')`,
            [fx.staffClerkId, fx.staffEmail],
          ),
        ),
      /platform_action_justification_length|violates check constraint/i,
    );
  });

  it("INSERT still works — an append-only table that cannot append is just broken", async () => {
    const inserted = await asPlatform((c) =>
      c.query(
        `INSERT INTO platform_action_log
           (actor_clerk_id, actor_email, actor_grade, action, resource_type, justification)
         VALUES ($1,$2,'owner','read','platform_action_log',
                 'ZD-9001 reviewing the register during the Phase 29 suite')
         RETURNING id`,
        [fx.staffClerkId, fx.staffEmail],
      ),
    );
    expect(inserted.rowCount).toBe(1);
  });

  it("⭐ the register is readable by the console — an empty register reads as 'nothing happened'", async () => {
    // The mirror of every refusal above. A REVOKE that went one step too
    // far makes the action register render empty, which looks exactly
    // like a quiet week.
    const rows = await asPlatform((c) =>
      c.query("SELECT id, action, justification FROM platform_action_log WHERE id = $1", [
        fx.actionLogId,
      ]),
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].justification).toMatch(/ZD-9001/);
  });
});

/* ================================================================== */
/* 6. THE CONSOLE'S OWN QUERIES BEHAVE                                 */
/* ================================================================== */

describe("6. the register queries Phase 29 added", () => {
  it("the impersonation register spans tenants from the platform scope", async () => {
    // The one screen that answers "was anyone inside a customer last
    // Tuesday" without a per-tenant loop. It works because the sessions
    // table is a PLATFORM table, not because the scope was widened.
    const rows = await asPlatform((c) =>
      c.query(
        `SELECT id, tenant_slug FROM platform_impersonation_sessions
          WHERE tenant_id = ANY($1) ORDER BY started_at DESC`,
        [[fx.tenantA, fx.tenantB]],
      ),
    );
    const ids = rows.rows.map((r: { id: string }) => r.id);
    expect(ids).toContain(fx.liveSession);
    expect(ids).toContain(fx.breakGlassSession);
  });

  it("⭐ committed MRR counts contracted subscriptions and not trials", async () => {
    // The arithmetic the directory sorts on, asserted on real rows:
    // `active` and `past_due` count, a trial does not, and an annual plan
    // contributes one twelfth per month.
    //
    // ⚠️ The expression is restated here rather than imported — the
    // console's copy lives in a `server-only` module that cannot be
    // loaded in this environment. Treat the two as a PAIR: a change to
    // `mrrMinorSql` in server/platform/tenants.ts belongs with a change
    // here.
    const planId = randomUUID();
    const subMonthly = randomUUID();
    const subTrial = randomUUID();
    const subAnnual = randomUUID();
    // A third workspace for the trial: `subscriptions_one_live_per_tenant`
    // permits exactly one live subscription per tenant, which is itself a
    // guarantee worth knowing about — a customer cannot be billed twice.
    const tenantTrial = randomUUID();

    await asSuperuser(async (c) => {
      await c.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
         VALUES ($1,$2,$3,'Phase29 Trial Tenant','active')`,
        [tenantTrial, `org_${tenantTrial}`, `p29-t-${tenantTrial.slice(0, 8)}`],
      );
      await c.query(
        `INSERT INTO plans (id, code, name, tier, interval, amount_minor,
                            included_seats, per_seat_amount_minor, storage_limit_mb)
         VALUES ($1,$2,'Phase29 Plan','advanced','monthly',100000,5,20000,1024)`,
        [planId, `p29-${planId.slice(0, 8)}`],
      );
      await c.query(
        `INSERT INTO subscriptions
           (id, tenant_id, plan_id, status, unit_amount_minor, per_seat_amount_minor,
            interval, seats_purchased, current_period_end)
         VALUES ($1,$2,$3,'active',100000,10000,'monthly',3, now() + interval '30 days')`,
        [subMonthly, fx.tenantA, planId],
      );
      await c.query(
        `INSERT INTO subscriptions
           (id, tenant_id, plan_id, status, unit_amount_minor, per_seat_amount_minor,
            interval, seats_purchased, current_period_end)
         VALUES ($1,$2,$3,'trialing',900000,0,'monthly',3, now() + interval '14 days')`,
        [subTrial, tenantTrial, planId],
      );
      await c.query(
        `INSERT INTO subscriptions
           (id, tenant_id, plan_id, status, unit_amount_minor, per_seat_amount_minor,
            interval, seats_purchased, current_period_end)
         VALUES ($1,$2,$3,'past_due',1200000,0,'annual',1, now() + interval '300 days')`,
        [subAnnual, fx.tenantB, planId],
      );
    });

    try {
      const mrr = async (tenantId: string) => {
        const rows = await asPlatform((c) =>
          c.query(
            `SELECT coalesce(sum(
               CASE s.interval
                 WHEN 'monthly'   THEN (s.unit_amount_minor + s.per_seat_amount_minor * s.seats_purchased)
                 WHEN 'quarterly' THEN (s.unit_amount_minor + s.per_seat_amount_minor * s.seats_purchased) / 3
                 WHEN 'annual'    THEN (s.unit_amount_minor + s.per_seat_amount_minor * s.seats_purchased) / 12
                 ELSE 0
               END), 0)::text AS mrr
               FROM subscriptions s
              WHERE s.tenant_id = $1 AND s.deleted_at IS NULL
                AND s.status IN ('active','past_due')`,
            [tenantId],
          ),
        );
        return rows.rows[0].mrr as string;
      };

      // 100000 base + 10000 × 3 seats = 130000.
      expect(await mrr(fx.tenantA)).toBe("130000");

      // 1200000 a year, past due — still contracted revenue, so it counts,
      // divided by twelve.
      expect(await mrr(fx.tenantB)).toBe("100000");

      // ⭐ A 900000 trial contributes NOTHING. A trial has not agreed to
      // pay anything, and counting it is how a trial-heavy month reads as
      // growth right up until the trials end.
      expect(await mrr(tenantTrial)).toBe("0");
    } finally {
      await asSuperuser(async (c) => {
        await c.query("DELETE FROM subscriptions WHERE id = ANY($1)", [
          [subMonthly, subTrial, subAnnual],
        ]);
        await c.query("DELETE FROM plans WHERE id = $1", [planId]);
        await c.query("DELETE FROM tenants WHERE id = $1", [tenantTrial]);
      });
    }
  });

  it("⭐ seats-in-use excludes our own staff sitting in a customer's workspace", async () => {
    // The directory's seat column mirrors `lib/billing/seats.ts`: a
    // platform_super_admin inside a customer's workspace does not consume
    // a seat the customer paid for, and a guest never did. Counting them
    // would show a customer at their limit and prompt a support engineer
    // to tell them to buy more.
    const staffUser = randomUUID();
    const guestUser = randomUUID();
    await asSuperuser(async (c) => {
      await c.query(
        `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, status)
         VALUES ($1,$2,$3,$4,'platform_super_admin','active')`,
        [staffUser, fx.tenantA, `usr_${staffUser}`, `staff-${staffUser.slice(0, 8)}@ordence.example`],
      );
      await c.query(
        `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, status)
         VALUES ($1,$2,$3,$4,'guest','active')`,
        [guestUser, fx.tenantA, `usr_${guestUser}`, `guest-${guestUser.slice(0, 8)}@example.com`],
      );
    });

    try {
      const rows = await asPlatform((c) =>
        c.query(
          `SELECT count(*)::int AS seats FROM users u
            WHERE u.tenant_id = $1 AND u.deleted_at IS NULL AND u.status = 'active'
              AND u.role NOT IN ('platform_super_admin','guest')`,
          [fx.tenantA],
        ),
      );
      expect(rows.rows[0].seats).toBe(1);
    } finally {
      await asSuperuser((c) =>
        c.query("DELETE FROM users WHERE id = ANY($1)", [[staffUser, guestUser]]),
      );
    }
  });

  it("the Phase 29 indexes exist, so the registers do not scan", async () => {
    const rows = await asSuperuser((c) =>
      c.query(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname = 'public' AND indexname = ANY($1)`,
        [
          [
            "platform_action_log_created_idx",
            "platform_action_log_severity_created_idx",
            "impersonation_started_idx",
            "security_events_tenant_occurred_idx",
            "audit_logs_platform_source_idx",
          ],
        ],
      ),
    );
    expect(rows.rowCount, "run SQL-FILES/0022_phase29_admin_console.sql").toBe(5);
  });

  it("the pool is the non-superuser application role — otherwise nothing above proves anything", async () => {
    // The cheapest way for this whole file to become decorative is for
    // someone to point `TEST_DATABASE_URL` at a superuser.
    const client = await testPool.connect();
    try {
      const who = await client.query(
        "SELECT current_user AS role, usesuper AS is_super FROM pg_user WHERE usename = current_user",
      );
      expect(who.rows[0].is_super, "the test role is a superuser and bypasses RLS").toBe(false);
    } finally {
      client.release();
    }
  });
});
