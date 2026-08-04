/**
 * Ordence — Is An Impersonated Action Actually Attributable?
 * Version: v0.31.0-alpha (Phase 31)
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE GAP THIS FILE CLOSES
 * ══════════════════════════════════════════════════════════════════════
 * Phase 29 shipped the entire impersonation apparatus: consent, session
 * creation, expiry, the undismissable banner, the customer notification,
 * the append-only evidence record, and a database trigger that refuses
 * DELETE while a session is set. `tests/security/platform-isolation.test.ts`
 * proves every one of those AT THE DATABASE LEVEL, by writing the rows by
 * hand.
 *
 * What nothing proved is that the APPLICATION ever writes those rows.
 *
 * That is the same shape of gap that hid an empty audit trail for
 * fourteen phases — see the header of `audit-write-path.test.ts`. The
 * suite proved `audit_logs` was immutable while nothing was writing to
 * it. Here it proved `impersonation_id` could not be tampered with while
 * `writeAudit()` never set it, because `TenantContext` did not carry it,
 * because `requireTenantContext()` refused platform operators outright.
 *
 * ⚠️ AN IMPERSONATION SESSION THAT IS NOT ATTRIBUTABLE IS WORSE THAN NO
 * SESSION AT ALL. It produces a workspace where our staff member's
 * actions are recorded — with a name, a time and an IP — and are
 * indistinguishable from the customer's own employees' actions. Every
 * control around it (consent, expiry, the banner, the email) exists to
 * make the record trustworthy. If the record does not carry the flag,
 * all of them are theatre and the customer cannot tell.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS FILE MOCKS, WHEN THE REST OF THE SUITE DOES NOT
 * ══════════════════════════════════════════════════════════════════════
 * Everything else here talks to a real PostgreSQL as a real non-superuser
 * role, because the claims are about the DATABASE. The claim here is
 * about a BRANCH IN TYPESCRIPT: does `writeAudit()` put the session id in
 * the row it builds? A database cannot answer that — it only ever sees
 * the row that was built.
 *
 * So section 1 mocks `@/db` and inspects the values `writeAudit()`
 * constructs, and then section 2 takes those exact values and INSERTs
 * them into the real `audit_logs` as the real application role. Neither
 * half is sufficient: the first proves the code intends the right thing,
 * the second proves the database accepts and preserves it.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { asTenant, asSuperuser, expectError } from "../setup";

/* ------------------------------------------------------------------ */
/* MOCKS — see the header for why                                      */
/* ------------------------------------------------------------------ */

/**
 * Captured `withTenant()` calls: the tenant, the options, and every row
 * the callback tried to insert.
 */
type Capture = {
  tenantId: string;
  options: { impersonationId?: string | null } | undefined;
  inserted: Record<string, unknown>[];
};

const captured: Capture[] = [];

/** Every `withPlatformScope()` the code under test opened, with its reason. */
const platformScoped: { reason: string; inserted: Record<string, unknown>[] }[] = [];

vi.mock("@/db", () => {
  /**
   * ⚠️ A FAKE TRANSACTION, NOT A FAKE DATABASE. It records the values
   * handed to `.insert(table).values(...)` and does nothing else. The
   * moment this starts pretending to have query semantics, a test can
   * pass against the pretence rather than against PostgreSQL — which is
   * exactly what section 2 exists to prevent.
   */
  function fakeTx(sink: Record<string, unknown>[]) {
    return {
      insert() {
        return {
          async values(row: Record<string, unknown>) {
            sink.push(row);
          },
        };
      },
      /**
       * Present so the REFUSAL path runs to completion rather than
       * falling into its own best-effort catch. A gate whose recording
       * throws still refuses — but a test that never exercised the
       * recording would not notice the day it stopped counting.
       */
      update() {
        return {
          set(values: Record<string, unknown>) {
            return {
              async where() {
                sink.push({ __update: values });
              },
            };
          },
        };
      },
      async execute() {
        return { rows: [] };
      },
    };
  }

  return {
    db: {
      async insert() {
        return { async values() {} };
      },
    },
    schema: {},
    async withTenant(
      tenantId: string,
      callback: (tx: unknown) => Promise<unknown>,
      options?: { impersonationId?: string | null },
    ) {
      const inserted: Record<string, unknown>[] = [];
      captured.push({ tenantId, options, inserted });
      return callback(fakeTx(inserted));
    },
    async withPlatformScope(_reason: string, callback: (tx: unknown) => Promise<unknown>) {
      const inserted: Record<string, unknown>[] = [];
      platformScoped.push({ reason: _reason, inserted });
      return callback(fakeTx(inserted));
    },
  };
});

// `writeAudit()` reads forensic headers. Outside a request there are
// none; the real implementation already tolerates that, and mocking it
// keeps `next/headers` (which needs a request store) out of the way.
vi.mock("next/headers", () => ({
  async headers() {
    return { get: () => null };
  },
}));

// Imported by `server/audit.ts` for `requirePermission`, which these
// tests do not exercise. Mocked so `@clerk/nextjs/server` never loads.
vi.mock("@/server/tenant-context", () => ({
  async requireTenantContext() {
    throw new Error(
      "requireTenantContext() is not exercised here — these tests build the " +
        "context themselves, which is the point: the claim is about what " +
        "writeAudit() does with a context, not about how one is resolved.",
    );
  },
  TenantAccessError: class TenantAccessError extends Error {},
}));

/* ------------------------------------------------------------------ */
/* ENVIRONMENT                                                         */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ SET BEFORE ANY DYNAMIC IMPORT, AND NOT IN `.env.test`.
 *
 * `lib/env.ts` parses `clientEnv` at MODULE LOAD, so importing anything
 * that transitively reaches it — `@/db`, `server/platform/guard.ts` —
 * throws unless these exist. They are placeholders and nothing connects
 * with them: `neon()` does not dial on construction, and every test here
 * either mocks the database or talks to it through `tests/setup.ts`.
 *
 * They are set HERE rather than added to `.env.test` on purpose. A real
 * `DATABASE_URL` in that file is the exact mistake the setup guard exists
 * to catch — see its header. Keeping the placeholder local to the one
 * file that needs it means the guard's rule stays absolute.
 */
process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
process.env.NEXT_PUBLIC_ROOT_DOMAIN ??= "localhost:3000";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??= "pk_test_placeholder";
process.env.CLERK_SECRET_KEY ??= "sk_test_placeholder";
process.env.DATABASE_URL ??= "postgresql://placeholder@127.0.0.1:5432/placeholder";

/* ------------------------------------------------------------------ */
/* FIXTURES                                                            */
/* ------------------------------------------------------------------ */

let tenantA: string;
let userA: string;
let staffId: string;
let sessionId: string;
let consentId: string;
let contactA: string;

const clerkOperator = `clerk_op_${randomUUID().slice(0, 8)}`;
const operatorEmail = `operator-${randomUUID().slice(0, 8)}@ordence.example`;

beforeAll(async () => {
  tenantA = randomUUID();
  userA = randomUUID();
  staffId = randomUUID();
  sessionId = randomUUID();
  consentId = randomUUID();
  contactA = randomUUID();

  await asSuperuser(async (c) => {
    await c.query(
      `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
       VALUES ($1,$2,$3,'Wiring Tenant A','active')`,
      [tenantA, `org_${tenantA}`, `wire-${tenantA.slice(0, 8)}`],
    );

    await c.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, status)
       VALUES ($1,$2,$3,$4,'tenant_owner','active')`,
      [userA, tenantA, `usr_${userA}`, `owner-${userA.slice(0, 8)}@acme.example`],
    );

    await c.query(
      `INSERT INTO contacts (id, tenant_id, first_name, last_name)
       VALUES ($1,$2,'Meera','Iyer')`,
      [contactA, tenantA],
    );

    await c.query(
      `INSERT INTO platform_staff (id, clerk_user_id, email, grade, status, expires_at)
       VALUES ($1,$2,$3,'engineer','active', now() + interval '30 days')`,
      [staffId, clerkOperator, operatorEmail],
    );

    await c.query(
      `INSERT INTO tenant_support_consents
         (id, tenant_id, mode, scope, granted_by_user_id, granted_by_email,
          granted_by_role, expires_at)
       VALUES ($1,$2,'incident','read_write',$3,'owner@acme.example','tenant_owner',
               now() + interval '60 minutes')`,
      [consentId, tenantA, userA],
    );

    await c.query(
      `INSERT INTO platform_impersonation_sessions
         (id, tenant_id, tenant_slug, staff_id, actor_clerk_id, actor_email,
          mode, scope, consent_id, justification, started_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,'incident_consent','read_write',$7,
               'ZD-7712 the customer cannot open their July invoice',
               now(), now() + interval '60 minutes')`,
      [
        sessionId,
        tenantA,
        `wire-${tenantA.slice(0, 8)}`,
        staffId,
        clerkOperator,
        operatorEmail,
        consentId,
      ],
    );
  });
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    await c.query("ALTER TABLE platform_impersonation_sessions DISABLE TRIGGER USER");
    await c.query("ALTER TABLE tenant_support_consents DISABLE TRIGGER USER");
    await c.query("ALTER TABLE audit_logs DISABLE TRIGGER USER");
    try {
      await c.query("DELETE FROM audit_logs WHERE tenant_id = $1", [tenantA]);
      await c.query("DELETE FROM platform_impersonation_sessions WHERE tenant_id = $1", [
        tenantA,
      ]);
      await c.query("DELETE FROM tenant_support_consents WHERE tenant_id = $1", [tenantA]);
      await c.query("DELETE FROM contacts WHERE tenant_id = $1", [tenantA]);
      await c.query("DELETE FROM users WHERE tenant_id = $1", [tenantA]);
      await c.query("DELETE FROM platform_staff WHERE id = $1", [staffId]);
      await c.query("DELETE FROM tenants WHERE id = $1", [tenantA]);
    } finally {
      await c.query("ALTER TABLE platform_impersonation_sessions ENABLE TRIGGER USER");
      await c.query("ALTER TABLE tenant_support_consents ENABLE TRIGGER USER");
      await c.query("ALTER TABLE audit_logs ENABLE TRIGGER USER");
    }

    // The teardown disabled tamper guards. Prove they came back on, or
    // every later run in this database is testing nothing.
    for (const table of [
      "audit_logs",
      "platform_impersonation_sessions",
      "tenant_support_consents",
    ]) {
      const { rows } = await c.query(
        `SELECT tgenabled FROM pg_trigger
          WHERE tgrelid = $1::regclass AND NOT tgisinternal`,
        [table],
      );
      for (const row of rows) expect(row.tgenabled, `${table} trigger left disabled`).toBe("O");
    }
  });
});

/** The context shape `requireTenantContext()` now returns. */
function contextFor(impersonationId: string | null) {
  return {
    tenant: { id: tenantA } as never,
    user: {
      id: userA,
      email: "owner@acme.example",
    } as never,
    role: "tenant_owner" as never,
    // ⭐ The REAL human when impersonating — never the customer's user.
    clerkUserId: impersonationId ? clerkOperator : `usr_${userA}`,
    impersonationId,
  };
}

/* ================================================================== */
/* 1. THE STAMP — WHAT `writeAudit()` ACTUALLY BUILDS                  */
/* ================================================================== */

describe("1. an action's audit row carries the session it was taken under", () => {
  it("⭐⭐ an action taken DURING an impersonation session is stamped with the session id", async () => {
    captured.length = 0;
    const { writeAudit } = await import("@/server/audit");

    await writeAudit(contextFor(sessionId), {
      action: "update",
      resourceType: "contact",
      resourceId: contactA,
      reason: "ZD-7712 corrected the billing email at the customer's request",
      severity: "warning",
    });

    expect(captured, "writeAudit() opened no tenant transaction").toHaveLength(1);
    const row = captured[0]!.inserted[0]!;

    // THE ASSERTION THE WHOLE PHASE TURNS ON.
    expect(
      row.impersonationId,
      "the audit row does not name the impersonation session — this action is " +
        "indistinguishable from one the customer took themselves",
    ).toBe(sessionId);

    // …and it still names the REAL human, not the customer's user.
    // Attribution and the flag are two separate claims and both must hold.
    expect(row.actorClerkId).toBe(clerkOperator);
    expect(row.tenantId).toBe(tenantA);
  });

  it("⭐⭐ an action taken OUTSIDE a session is NOT stamped", async () => {
    /*
      The other half, and the one that is easy to get wrong in the
      direction nobody notices. A stamp that is always present is a
      column that distinguishes nothing — every row would read as
      impersonated, the console's "platform activity" panel would list
      the customer's own work, and the flag would become noise a
      reviewer learns to ignore.
    */
    captured.length = 0;
    const { writeAudit } = await import("@/server/audit");

    await writeAudit(contextFor(null), {
      action: "update",
      resourceType: "contact",
      resourceId: contactA,
      reason: "The customer's own administrator edited this record",
    });

    expect(captured).toHaveLength(1);
    const row = captured[0]!.inserted[0]!;

    expect(
      row.impersonationId,
      "an ordinary customer action was flagged as impersonated",
    ).toBeNull();
    expect(row.actorClerkId).toBe(`usr_${userA}`);
  });

  it("a caller that predates the field is treated as NOT impersonating", async () => {
    // Several actions pass a narrowed `Pick<>` of the context. NULL is
    // the honest value for those: they are ordinary tenant work, and
    // guessing "probably impersonated" would poison the flag.
    captured.length = 0;
    const { writeAudit } = await import("@/server/audit");

    const legacy = contextFor(null) as Record<string, unknown>;
    delete legacy.impersonationId;

    await writeAudit(legacy as never, { action: "create", resourceType: "contact" });

    expect(captured[0]!.inserted[0]!.impersonationId).toBeNull();
  });
});

/* ================================================================== */
/* 2. THE DATABASE GUARD IS ARMED BY THE SAME VALUE                    */
/* ================================================================== */

describe("2. the transaction itself carries the session", () => {
  it("⭐ `withTenant()` is given the impersonation id, which arms the DELETE guard", async () => {
    /*
      `SQL-FILES/0014_phase17_platform.sql` installs
      `refuse_delete_under_impersonation()` on nineteen tables and reads
      `app.impersonation_id`. That trigger was installed, correct, and
      INERT for two phases, because nothing in the application ever set
      the setting. This is the assertion that it is set.
    */
    captured.length = 0;
    const { writeAudit } = await import("@/server/audit");

    await writeAudit(contextFor(sessionId), { action: "update", resourceType: "contact" });

    expect(captured[0]!.options?.impersonationId).toBe(sessionId);
  });

  it("an ordinary write does NOT set the marker — the guard must stay inert", async () => {
    // A guard that fired for ordinary traffic would make the product
    // unable to delete anything, for everyone, with no message anywhere
    // explaining why.
    captured.length = 0;
    const { writeAudit } = await import("@/server/audit");

    await writeAudit(contextFor(null), { action: "update", resourceType: "contact" });

    expect(captured[0]!.options?.impersonationId ?? null).toBeNull();
  });

  it("⭐ a malformed impersonation id is refused BEFORE it reaches the trigger", async () => {
    /*
      `app_current_impersonation_id()` casts the setting to `uuid`. A
      malformed value there does not fail at `set_config` — it fails
      inside a BEFORE DELETE trigger, on whichever of the nineteen
      guarded tables the request happened to touch, with
      `invalid input syntax for type uuid`. That error names the
      trigger and not the caller, at 03:00, during an incident.

      This uses the REAL `db/index.ts`, on the placeholder environment
      set at the top of this file. Nothing connects: the guard throws
      before any pool is opened.
    */
    const real = await vi.importActual<typeof import("@/db")>("@/db");

    const bad = await expectError(() =>
      real.withTenant(tenantA, async () => null, { impersonationId: "not-a-uuid" }),
    );
    expect(bad).not.toBeNull();
    expect(bad!.message).toMatch(/malformed impersonation id/i);

    // And the pre-existing tenant guard is untouched by the new option.
    const badTenant = await expectError(() =>
      real.withTenant("not-a-uuid", async () => null, { impersonationId: sessionId }),
    );
    expect(badTenant!.message).toMatch(/malformed tenant id/i);
  });
});

/* ================================================================== */
/* 3. THE ROW THE APPLICATION BUILDS IS ONE POSTGRES ACCEPTS           */
/* ================================================================== */

describe("3. the stamped row survives contact with the real database", () => {
  it("⭐ writes as the ORDINARY app role, under RLS, and reads the flag back", async () => {
    /*
      Section 1 proved the code intends to stamp the row. This proves
      the intent is realisable: the same values, inserted by the same
      non-superuser role the application connects as, through the same
      FORCE-RLS policy, land with the flag intact.

      Without this, section 1 could pass forever against a column that
      the database rejects.
    */
    captured.length = 0;
    const { writeAudit } = await import("@/server/audit");

    await writeAudit(contextFor(sessionId), {
      action: "update",
      resourceType: "contact",
      resourceId: contactA,
      reason: "ZD-7712 corrected the billing email at the customer's request",
      severity: "warning",
    });

    const built = captured[0]!.inserted[0]! as Record<string, string | null>;
    const auditId = randomUUID();

    await asTenant(tenantA, (c) =>
      c.query(
        `INSERT INTO audit_logs
           (id, tenant_id, actor_user_id, actor_clerk_id, actor_email, actor_role,
            action, resource_type, resource_id, impersonation_id, reason, severity)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          auditId,
          built.tenantId,
          built.actorUserId,
          built.actorClerkId,
          built.actorEmail,
          built.actorRole,
          built.action,
          built.resourceType,
          built.resourceId,
          built.impersonationId,
          built.reason,
          built.severity,
        ],
      ),
    );

    const { rows } = await asTenant(tenantA, (c) =>
      c.query(
        `SELECT impersonation_id, actor_clerk_id, actor_email
           FROM audit_logs WHERE id = $1`,
        [auditId],
      ),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].impersonation_id).toBe(sessionId);
    // ⭐ The customer reads this row in THEIR OWN audit log, and it names
    // our staff member rather than one of their own people.
    expect(rows[0].actor_email).toBe("owner@acme.example");
    expect(rows[0].actor_clerk_id).toBe(clerkOperator);
  });

  it("⭐ the flag cannot be removed afterwards, not even by the database owner", async () => {
    /*
      A flag that the flagged party can clear is not evidence. The
      append-only trigger on `audit_logs` refuses UPDATE to everyone,
      including the role that owns the table — which is a strictly
      stronger claim than "the app role lacks the privilege", because a
      superuser is exempt from RLS and is NOT exempt from triggers.
    */
    const auditId = randomUUID();
    await asTenant(tenantA, (c) =>
      c.query(
        `INSERT INTO audit_logs
           (id, tenant_id, action, resource_type, impersonation_id)
         VALUES ($1,$2,'update','contact',$3)`,
        [auditId, tenantA, sessionId],
      ),
    );

    const error = await expectError(() =>
      asSuperuser((c) =>
        c.query("UPDATE audit_logs SET impersonation_id = NULL WHERE id = $1", [auditId]),
      ),
    );

    expect(error, "the impersonation flag was erased").not.toBeNull();
    expect(error!.message).toMatch(/append-only|immutable/i);
  });

  it("⭐ the stamped id reconciles to a real session record", async () => {
    /*
      ⚠️ `audit_logs.impersonation_id` HAS NO FOREIGN KEY, AND THAT IS
      DELIBERATE RATHER THAN MISSING. `platform_impersonation_sessions`
      is a PLATFORM table; `audit_logs` is a TENANT table. A foreign key
      between them would be checked by the system, which ignores
      row-level security — so a tenant could confirm or deny the
      existence of a platform session id by watching an insert succeed
      or fail. That is an oracle on our internal records, offered to
      every customer, in exchange for a referential guarantee.

      What matters instead is that the value RECONCILES: the id in the
      customer's own audit row names a real session, and the session
      names the same tenant. That join is what an auditor performs, and
      it is done under platform scope, by us — not by the customer.
    */
    const auditId = randomUUID();
    await asTenant(tenantA, (c) =>
      c.query(
        `INSERT INTO audit_logs
           (id, tenant_id, action, resource_type, impersonation_id)
         VALUES ($1,$2,'update','contact',$3)`,
        [auditId, tenantA, sessionId],
      ),
    );

    const { rows } = await asSuperuser((c) =>
      c.query(
        `SELECT s.id, s.tenant_id, s.actor_email, s.mode, s.scope
           FROM audit_logs a
           JOIN platform_impersonation_sessions s ON s.id = a.impersonation_id
          WHERE a.id = $1`,
        [auditId],
      ),
    );

    expect(rows, "the audit row's session id matches no session").toHaveLength(1);
    expect(rows[0].tenant_id).toBe(tenantA);
    expect(rows[0].actor_email).toBe(operatorEmail);
    expect(rows[0].scope).toBe("read_write");
  });
});

/* ================================================================== */
/* 4. THE OPERATION GATE READS THE SAME FACT                           */
/* ================================================================== */

describe("4. the forbidden list is evaluated from the request's own context", () => {
  it("⭐ a forbidden operation is refused during a session", async () => {
    const { assertImpersonationAllows, ImpersonationForbiddenError } = await import(
      "@/server/platform/impersonation"
    );
    platformScoped.length = 0;

    const error = await expectError(() =>
      assertImpersonationAllows("delete:contact", {
        impersonationId: sessionId,
        impersonationScope: "read_write",
        tenant: { id: tenantA },
      }),
    );

    expect(error, "a delete was permitted under impersonation").not.toBeNull();
    expect(error!.message).toMatch(/customer's evidence|not permitted/i);
    expect(ImpersonationForbiddenError).toBeTruthy();

    // ⭐ AND IT WAS COUNTED. The console shows this number next to a
    // live session — "refused eleven times in nine minutes" is a
    // sentence somebody should read while it is still happening, not
    // afterwards.
    const counted = platformScoped.some((call) =>
      call.inserted.some((row) => "__update" in row),
    );
    expect(counted, "the refusal was not counted against the session").toBe(true);
  });

  it("⭐ a read-only session is refused every write, not merely the listed ones", async () => {
    // `isWriteOperation` fails CLOSED: a verb it does not positively
    // recognise as a read counts as a write. So a capability added next
    // year is refused under break-glass until somebody classifies it.
    const { assertImpersonationAllows } = await import("@/server/platform/impersonation");

    const error = await expectError(() =>
      assertImpersonationAllows("leads:some_verb_invented_next_year", {
        impersonationId: sessionId,
        impersonationScope: "read_only",
        tenant: { id: tenantA },
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/read-only/i);
  });

  it("the SAME operation is permitted when nobody is impersonating", async () => {
    // The gate sits at the top of ordinary customer actions. If it
    // refused them, the product would not work at all.
    const { assertImpersonationAllows } = await import("@/server/platform/impersonation");

    await expect(
      assertImpersonationAllows("delete:contact", {
        impersonationId: null,
        impersonationScope: null,
        tenant: { id: tenantA },
      }),
    ).resolves.toBeUndefined();
  });

  it("a read is permitted inside a read-only session", async () => {
    const { assertImpersonationAllows } = await import("@/server/platform/impersonation");

    await expect(
      assertImpersonationAllows("leads:read", {
        impersonationId: sessionId,
        impersonationScope: "read_only",
        tenant: { id: tenantA },
      }),
    ).resolves.toBeUndefined();
  });

  it("⭐ an operator cannot grant themselves consent — the circularity gate", async () => {
    /*
      Before the tenant-context bridge landed, this was refused by an
      accident of plumbing: a platform operator had no tenant context,
      so `withTenant()` was unreachable and RLS refused the insert.
      Wiring the bridge removed that accident. If this ever passes, our
      staff can enter on a one-hour permission and write themselves a
      ninety-day one, and the audit trail will show the CUSTOMER
      granting it.
    */
    const { assertImpersonationAllows } = await import("@/server/platform/impersonation");

    const error = await expectError(() =>
      assertImpersonationAllows("support:consent", {
        impersonationId: sessionId,
        impersonationScope: "read_write",
        tenant: { id: tenantA },
      }),
    );

    expect(error, "an impersonator was allowed to write their own consent").not.toBeNull();
    expect(error!.message).toMatch(/circular/i);
  });
});
