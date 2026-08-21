/**
 * Ordence — 🔴🔴🔴 THE PREVIEW'S NUMBER IS THE NUMBER THAT LANDS
 * Version: v1.84.1-alpha · Phase 3
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE PROVES, AND WHAT IT DELIBERATELY DOES NOT
 * ══════════════════════════════════════════════════════════════════════
 * NOT that the dry run ran. That is what every import test in every
 * product proves, and it is compatible with a preview that says "412 will
 * be created" over a commit that creates 380.
 *
 * ⭐ IT PROVES TWO THINGS, BY EXECUTION, AGAINST A REAL POSTGRES:
 *
 *   ① THE PREVIEW MOVED NOTHING. Every tenant-scoped table in the
 *      database is counted before the preview and after it — three
 *      hundred and six of them, plus `import_row_provenance` — and the
 *      difference must be empty. Not the entity's own table: EVERY table,
 *      because the write worth catching is the one nobody declared.
 *
 *   ② THE COMMIT DID EXACTLY WHAT THE PREVIEW SAID. Not the same totals
 *      — the same OUTCOME FOR THE SAME RECORD NUMBER. A run that turns
 *      row 4 from `create` into `skip` and row 9 from `skip` into
 *      `create` has identical totals and is a different import.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT IS MOCKED, AND THE LIST IS SHORT ON PURPOSE
 * ══════════════════════════════════════════════════════════════════════
 * Only the IDENTITY AND AUTHORISATION surface — `requireTenantContext`,
 * `requirePermission`, `requireAccess`, `requireFeature`, `writeAudit`
 * and `next/cache`. Those need a Clerk session a test process does not
 * have, and none of them is under test.
 *
 * ⭐ `@/db` IS NOT MOCKED, `lib/import/` IS NOT MOCKED, AND NEITHER IS
 * `server/actions/import.ts`. The functions called below are the exact
 * ones the browser calls. Every `withTenant()`, every INSERT, every
 * trigger, every unique index and every RLS policy is the real one, as
 * the real `ordence_app` role — NOSUPERUSER, NOBYPASSRLS — which is what
 * makes the row counts mean the tenant's rows rather than everybody's.
 *
 * 🔴 AND THE HARNESS PROVES ITSELF FIRST (§0). A footprint that cannot
 * see a write it was shown would report "the dry run moved nothing" about
 * a dry run that moved everything. That is the shape of defect this
 * repository has found more than thirty times, four of them in the
 * checkers written to catch it, so the checker is induced to fail before
 * it is believed.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { asSuperuser } from "../setup";

process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

/* ================================================================== */
/* MOCKS — identity and authorisation only                             */
/* ================================================================== */

const h = vi.hoisted(() => ({
  ctx: null as unknown as {
    tenant: Record<string, unknown>;
    user: Record<string, unknown>;
    clerkUserId: string;
    clerkOrgId: string;
    role: string;
    requestId: string;
    impersonationId: null;
    impersonationScope: null;
    operatorEmail: null;
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: () => undefined,
  revalidateTag: () => undefined,
  unstable_cache: (fn: unknown) => fn,
}));

vi.mock("@/server/tenant-context", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    requireTenantContext: async () => h.ctx,
    requireRole: async () => h.ctx,
    getTenantContext: async () => h.ctx,
  };
});

vi.mock("@/server/audit", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    requirePermission: async () => h.ctx,
    requireAllPermissions: async () => h.ctx,
    checkPermission: async () => ({ allowed: true, ctx: h.ctx }),
    /*
     * ⚠️ STUBBED, AND IT CHANGES WHAT THIS FILE MEASURES — so it is said
     * out loud. `writeAudit` appends to a hash chain in `audit_logs`,
     * which carries a `tenant_id` and would therefore appear in the
     * footprint as a table the COMMIT moved. That is true and it is not
     * what is under test; the preview does not call it either way, so
     * claim ① is unaffected, and claim ② is about report rows.
     */
    writeAudit: async () => undefined,
  };
});

vi.mock("@/server/billing/access", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    requireAccess: async () => ({
      level: "full",
      canWrite: true,
      canRead: true,
      canExport: true,
      headline: null,
      detail: null,
      callToAction: null,
      reason: "healthy",
      daysRemaining: null,
      standing: "resolved",
    }),
  };
});

vi.mock("@/server/entitlements", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    requireFeature: async () => ({ allowed: true, feature: "test", reason: "included" }),
    checkFeature: async () => ({ allowed: true, feature: "test", reason: "included" }),
  };
});

/* ================================================================== */
/* FIXTURES                                                            */
/* ================================================================== */

const RUN = randomUUID().slice(0, 8);

let tenantId: string;
/** Every tenant-scoped table plus the provenance sidecar. Read once. */
let everyDestination: readonly string[];

/** Account codes that DO exist, for the trial balance lookups. */
const CODE_DEBIT = `P3-DR-${RUN}`;
const CODE_CREDIT = `P3-CR-${RUN}`;
/** A code that deliberately does not. */
const CODE_ABSENT = `P3-NOPE-${RUN}`;

/** A company that DOES exist, for the invoice lookups. */
const CUSTOMER_PRESENT = `Phase Three Customer ${RUN}`;
const CUSTOMER_ABSENT = `Nobody At All ${RUN}`;

beforeAll(async () => {
  tenantId = randomUUID();

  const ids = await asSuperuser(async (c) => {
    await c.query(
      `INSERT INTO tenants (id, clerk_org_id, slug, name, status, plan_tier)
       VALUES ($1,$2,$3,$4,'active','enterprise')`,
      [tenantId, `org_p3_${RUN}`, `p3-${RUN}`, "Phase 3 Dry Run"],
    );

    const u = await c.query(
      `INSERT INTO users (tenant_id, clerk_user_id, email, role, status)
       VALUES ($1,$2,$3,'tenant_owner','active') RETURNING id`,
      [tenantId, `user_p3_${RUN}`, `p3-${RUN}@example.test`],
    );

    await c.query(
      `INSERT INTO ledgers (tenant_id, name, code, type, account_type, is_active)
       VALUES ($1,'Opening Bank',$2,'operating','asset',true),
              ($1,'Opening Capital',$3,'operating','equity',true)`,
      [tenantId, CODE_DEBIT, CODE_CREDIT],
    );

    await c.query(`INSERT INTO companies (tenant_id, name) VALUES ($1,$2)`, [
      tenantId,
      CUSTOMER_PRESENT,
    ]);

    return { user: u.rows[0].id as string };
  });

  const rows = await asSuperuser(async (c) => {
    const t = await c.query(`SELECT * FROM tenants WHERE id = $1`, [tenantId]);
    const u = await c.query(`SELECT * FROM users WHERE id = $1`, [ids.user]);
    return { tenant: t.rows[0], user: u.rows[0] };
  });

  h.ctx = {
    tenant: camelise(rows.tenant),
    user: camelise(rows.user),
    clerkUserId: `user_p3_${RUN}`,
    clerkOrgId: `org_p3_${RUN}`,
    role: "tenant_owner",
    requestId: `req_p3_${RUN}`,
    impersonationId: null,
    impersonationScope: null,
    operatorEmail: null,
  };

  const { everyTenantScopedDestination } = await import("@/server/import/dryrun");
  everyDestination = await everyTenantScopedDestination(tenantId);
});

/**
 * ⚠️ THE DATABASE'S OWN SENTENCE, NOT DRIZZLE'S WRAPPER — AND THIS
 * HELPER EXISTS BECAUSE THE OBVIOUS VERSION PRODUCED A FALSE PASS.
 *
 * Drizzle throws `Failed query: INSERT INTO import_row_provenance (…,
 * run_id, …) VALUES …`, and `.rejects.toThrow(/run_id/)` matched THE
 * QUERY TEXT rather than the constraint. It would have gone on matching
 * with the NOT NULL removed. Every assertion below now reads the message
 * the driver put on `cause`, so it can only match the refusal.
 */
async function expectRefusal(work: Promise<unknown>, pattern: RegExp): Promise<void> {
  let message: string | null = null;
  try {
    await work;
  } catch (err) {
    for (let cause: unknown = err, depth = 0; cause && depth < 5; depth += 1) {
      const candidate = cause as { code?: unknown; message?: unknown; cause?: unknown };
      if (typeof candidate.code === "string" && typeof candidate.message === "string") {
        message = candidate.message;
        break;
      }
      cause = candidate.cause;
    }
    if (message === null) throw err;
  }
  expect(message, "the statement was ACCEPTED — the guard did not fire").not.toBeNull();
  expect(message).toMatch(pattern);
}

/**
 * A real `import_runs` row, because `import_row_provenance.run_id` carries a
 * foreign key to it. A fixture that faked the id would prove the CHECK
 * constraints and skip the reference that makes a reversal possible.
 */
async function makeRun(): Promise<string> {
  const result = await asSuperuser((c) =>
    c.query(
      `INSERT INTO import_runs
         (tenant_id, started_by, entity_key, source_format, duplicate_mode, expected_rows)
       VALUES ($1,$2,'companies','csv','skip',1) RETURNING id`,
      [tenantId, String(h.ctx.user.id)],
    ),
  );
  return result.rows[0].id as string;
}

/**
 * ⚠️ ONE TRANSACTION, AND THAT IS THE POINT. 0205's `same_transaction`
 * trigger reads the destination row's `xmin` and refuses provenance for a
 * row this transaction did not write — so a helper that inserted the
 * company first and the provenance afterwards would be refused, correctly.
 */
async function writeCompanyWithProvenance(
  runId: string | null,
  over: { cardinality?: string; inputRowNumber?: number | null } = {},
): Promise<string> {
  const { withTenant } = await import("@/db");
  const { sql } = await import("drizzle-orm");
  return withTenant(tenantId, async (tx) => {
    const company = await tx.execute(sql`
      INSERT INTO companies (tenant_id, name)
      VALUES (${tenantId}, ${"Provenance Fixture " + randomUUID().slice(0, 8)})
      RETURNING id
    `);
    const companyId = (company.rows[0] as { id: string }).id;
    await tx.execute(sql`
      INSERT INTO import_row_provenance
        (tenant_id, run_id, entity_key, input_row_number, cardinality,
         target_table, target_id, operation, reversal_kind, written_xid)
      VALUES (${tenantId}, ${runId}, 'companies',
              ${over.inputRowNumber === undefined ? 1 : over.inputRowNumber},
              ${over.cardinality ?? "one-to-one"},
              'companies', ${companyId}, 'insert', 'delete', 0)
    `);
    return companyId;
  });
}

function camelise(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
  }
  return out;
}

/* ================================================================== */
/* THE RUNNER — the SHIPPING actions, and nothing else                 */
/* ================================================================== */

/**
 * 🔴 `previewImport` AND `commitImport`, IMPORTED FROM THE MODULE THE
 * BROWSER POSTS TO. Not `runImport`, which is private; not a copy of its
 * logic; not a re-implementation that "does the same thing". The only
 * difference between the two branches below is which of the two exported
 * functions is called, which is the only difference the product has.
 */
async function runnerFor(
  entity: string,
  csvText: string,
  duplicateMode: "skip" | "update" | "fail" = "skip",
) {
  const { previewImport, commitImport } = await import("@/server/actions/import");
  return async (mode: "preview" | "commit") => {
    const result =
      mode === "preview"
        ? await previewImport({ entity, csvText, duplicateMode })
        : await commitImport({ entity, csvText, duplicateMode });
    if (!result.ok) {
      throw new Error(`[${mode}] the action refused outright: ${result.error}`);
    }
    return result.data;
  };
}

async function verify(
  entity: string,
  csvText: string,
  duplicateMode: "skip" | "update" | "fail" = "skip",
) {
  const { verifyDryRun } = await import("@/server/import/dryrun");
  const { ALL_IMPORT_ENTITIES } = await import("@/lib/import/entities");
  return verifyDryRun({
    tenantId,
    entity: ALL_IMPORT_ENTITIES[entity as keyof typeof ALL_IMPORT_ENTITIES],
    destinations: everyDestination,
    run: await runnerFor(entity, csvText, duplicateMode),
  });
}

/* ================================================================== */
/* 0. THE HARNESS PROVES ITSELF BEFORE IT IS BELIEVED                  */
/* ================================================================== */

describe("§0 the measurement is induced to fail before it is trusted", () => {
  it("counts the tenant's rows and not everybody's — the role has no BYPASSRLS", async () => {
    const roles = await asSuperuser((c) =>
      c.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'ordence_app'`),
    );
    expect(roles.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
  });

  it("SEES a write: one row inserted behind its back shows up as drift", async () => {
    const { measureFootprint, footprintDelta } = await import("@/server/import/dryrun");

    const before = await measureFootprint(tenantId, ["companies"]);
    await asSuperuser((c) =>
      c.query(`INSERT INTO companies (tenant_id, name) VALUES ($1,$2)`, [
        tenantId,
        `Induced Drift ${randomUUID()}`,
      ]),
    );
    const after = await measureFootprint(tenantId, ["companies"]);

    const moved = footprintDelta(before, after);
    expect(moved).toEqual([
      { destination: "companies", before: before.counts.get("companies"), after: after.counts.get("companies"), moved: 1 },
    ]);
  });

  it("REFUSES a destination that does not exist, by name", async () => {
    const { measureFootprint } = await import("@/server/import/dryrun");
    await expect(
      measureFootprint(tenantId, ["companies", "no_such_table_at_all"]),
    ).rejects.toThrow(/no such table\(s\).*no_such_table_at_all/s);
  });

  it("REFUSES an empty destination list — an empty footprint equals an empty footprint", async () => {
    const { measureFootprint } = await import("@/server/import/dryrun");
    await expect(measureFootprint(tenantId, [])).rejects.toThrow(
      /asked to count nothing/,
    );
  });

  it("REFUSES a caller that bypasses row-level security", async () => {
    /*
     * 🔴 THE `postgres` SUPERUSER SEES EVERY TENANT. A footprint taken as
     * this role would answer about the whole database, so a write into the
     * workspace under test would be lost among everybody else's rows —
     * *"a query measurer that measured as a superuser under a header
     * saying NOBYPASSRLS"*, which this repository has already shipped once.
     */
    await expect(
      asSuperuser((c) =>
        c.query(`SELECT * FROM import_destination_row_count(ARRAY['companies'])`),
      ),
    ).rejects.toThrow(/superuser or carries BYPASSRLS/);
  });

  it("REFUSES a call with no tenant scope — where every count would be 0", async () => {
    /*
     * 🔴 THE ONE THAT MAKES THE PROOF PASS VACUOUSLY. Under FORCE ROW
     * LEVEL SECURITY and no `app.current_tenant_id`, `count(*)` is 0 on a
     * table of a million rows: before = 0, after = 0, "nothing moved".
     */
    const { withoutTenant } = await import("../setup");
    await expect(
      withoutTenant((c) =>
        c.query(`SELECT * FROM import_destination_row_count(ARRAY['companies'])`),
      ),
    ).rejects.toThrow(/no tenant scope/);
  });

  it("catches drift that leaves the TOTALS identical", async () => {
    const { compareRuns } = await import("@/server/import/dryrun");

    const base = {
      mode: "preview" as const,
      entityKey: "companies",
      entityLabel: "Companies",
      noun: { one: "company", many: "companies" },
      duplicateMode: "skip" as const,
      totalRows: 2,
      headers: [],
      assignments: [],
      unrecognisedHeaders: [],
      successSampleShown: 2,
      failedRowsCsv: null,
      fatal: null,
    };

    const preview = {
      ...base,
      counts: { create: 1, update: 0, skip: 1, error: 0 },
      rows: [
        { recordNumber: 2, disposition: "create" as const, label: "a", matchedOn: null, errors: [] },
        { recordNumber: 3, disposition: "skip" as const, label: "b", matchedOn: null, errors: [] },
      ],
    };
    const commit = {
      ...base,
      mode: "commit" as const,
      counts: { create: 1, update: 0, skip: 1, error: 0 },
      rows: [
        { recordNumber: 2, disposition: "skip" as const, label: "a", matchedOn: null, errors: [] },
        { recordNumber: 3, disposition: "create" as const, label: "b", matchedOn: null, errors: [] },
      ],
    };

    const comparison = compareRuns(preview, commit);
    expect(comparison.countDrift).toEqual([]);
    expect(comparison.drift.map((d) => d.recordNumber)).toEqual([2, 3]);
  });

  it("keeps `create → error` apart from drift, because a preview cannot foresee it", async () => {
    const { compareRuns } = await import("@/server/import/dryrun");
    const base = {
      entityKey: "companies",
      entityLabel: "Companies",
      noun: { one: "company", many: "companies" },
      duplicateMode: "skip" as const,
      totalRows: 1,
      headers: [],
      assignments: [],
      unrecognisedHeaders: [],
      successSampleShown: 1,
      failedRowsCsv: null,
      fatal: null,
    };
    const comparison = compareRuns(
      {
        ...base,
        mode: "preview",
        counts: { create: 1, update: 0, skip: 0, error: 0 },
        rows: [{ recordNumber: 2, disposition: "create", label: "a", matchedOn: null, errors: [] }],
      },
      {
        ...base,
        mode: "commit",
        counts: { create: 0, update: 0, skip: 0, error: 1 },
        rows: [
          {
            recordNumber: 2,
            disposition: "error",
            label: "a",
            matchedOn: null,
            errors: [{ column: null, message: "the database refused it" }],
          },
        ],
      },
    );
    expect(comparison.drift).toEqual([]);
    expect(comparison.writeResidue).toHaveLength(1);
    expect(comparison.countDrift).toHaveLength(2);
  });
});

/* ================================================================== */
/* 0b. THE SIDECAR'S TEETH — SQL 0215, EXECUTED                        */
/* ================================================================== */

describe("§0b `a dry run touches nothing` is also enforced by the database", () => {
  /**
   * 🔴 THE POINT OF THIS SECTION. Every other test in this file proves the
   * preview does not write. These prove it COULD not, which is a different
   * and stronger claim: they survive a refactor of `server/actions/import.ts`
   * that this suite would otherwise have to be re-run to catch.
   *
   * ══════════════════════════════════════════════════════════════════════
   * ⭐ REWRITTEN AT WAVE 4 INTEGRATION — SAME RULES, THE TABLE THAT SHIPPED
   * ══════════════════════════════════════════════════════════════════════
   * Phase 2 and Phase 3 each wrote `import_row_provenance` without seeing
   * the other. These tests were written against Phase 3's version, with
   * `record_number`, `source_name` and no reversal columns. The version
   * that ships is Phase 2's (0205) — because that is the shape
   * `db/schema/import-runs.ts` declares and `server/import/reversal.ts`
   * writes, and nothing in TypeScript ever read the other one.
   *
   * ⚠️ EVERY RULE THESE TESTS ASSERTED STILL HOLDS. Only the column names
   * and the enforcing object changed:
   *   · run_id NOT NULL              → still a NOT NULL column
   *   · destination must exist       → 0205's `same_transaction` trigger,
   *                                     which also refuses a denied table,
   *                                     a table with no tenant_id, and a
   *                                     target row this transaction did
   *                                     not write
   *   · whole-file ⇒ no row number   → CHECK
   *                                     `import_row_provenance_row_number_present`
   *                                     on `input_row_number`
   *   · evidence cannot be rewritten → 0205's `immutable` trigger
   *
   * ⚠️ AND ONE TEST IS ADDED, NOT TRANSLATED. Phase 3's file refused EVERY
   * update. `server/import/reversal.ts:444` records a reversal by updating
   * this row, so that rule would have broken every undo in the product.
   * The last test below pins the distinction: evidence is frozen, the
   * reversal fields are not.
   */

  /** 0205's shape. `written_xid` is NOT NULL and the trigger overwrites it. */
  const insertProvenance = async (over: {
    runId: string | null;
    targetTable: string;
    targetId: string;
    cardinality?: string;
    inputRowNumber?: number | null;
  }) => {
    const { withTenant } = await import("@/db");
    const { sql } = await import("drizzle-orm");
    return withTenant(tenantId, (tx) =>
      tx.execute(sql`
        INSERT INTO import_row_provenance
          (tenant_id, run_id, entity_key, input_row_number, cardinality,
           target_table, target_id, operation, reversal_kind, written_xid)
        VALUES (${tenantId}, ${over.runId}, 'companies',
                ${over.inputRowNumber === undefined ? 1 : over.inputRowNumber},
                ${over.cardinality ?? "one-to-one"},
                ${over.targetTable}, ${over.targetId}, 'insert', 'delete', 0)
      `),
    );
  };

  /**
   * ⚠️ THE TARGET ROW IS WRITTEN FOR REAL, IN THE SAME TRANSACTION, AND
   * THAT IS NOT FIXTURE FUSS. A BEFORE INSERT trigger runs before NOT NULL
   * and CHECK are evaluated, so `same_transaction` refuses an invented
   * target id first and the constraint under test never gets a turn. An
   * earlier version of this test passed a `gen_random_uuid()` and asserted
   * on the wrong refusal.
   */
  it("REFUSES provenance with no run — and a preview has no run", async () => {
    await expectRefusal(
      writeCompanyWithProvenance(null),
      /null value in column "run_id"/,
    );
  });

  it("REFUSES a destination table that does not exist", async () => {
    const runId = await makeRun();
    await expectRefusal(
      insertProvenance({
        runId,
        targetTable: "not_a_table",
        targetId: randomUUID(),
      }),
      /can never be reversed and never be reconciled/,
    );
  });

  it("REFUSES a destination that is not an import destination at all", async () => {
    const runId = await makeRun();
    await expectRefusal(
      insertProvenance({ runId, targetTable: "users", targetId: randomUUID() }),
      /not an import destination/,
    );
  });

  it("REFUSES a whole-file row that names a record number, and one that omits it when it should not", async () => {
    const runId = await makeRun();
    await expectRefusal(
      writeCompanyWithProvenance(runId, { cardinality: "whole-file", inputRowNumber: 2 }),
      /import_row_provenance_row_number_present/,
    );
    await expectRefusal(
      writeCompanyWithProvenance(runId, { cardinality: "one-to-one", inputRowNumber: null }),
      /import_row_provenance_row_number_present/,
    );
    /* ⭐ AND THE POSITIVE CASE, so this is a rule and not a locked door. */
    await expect(
      writeCompanyWithProvenance(runId, { cardinality: "whole-file", inputRowNumber: null }),
    ).resolves.toBeDefined();
  });

  it("REFUSES an UPDATE to the evidence — provenance is what a reversal reads to decide what to delete", async () => {
    const { withTenant } = await import("@/db");
    const { sql } = await import("drizzle-orm");
    const runId = await makeRun();
    const companyId = await writeCompanyWithProvenance(runId);

    await expectRefusal(
      withTenant(tenantId, (tx) =>
        tx.execute(sql`
          UPDATE import_row_provenance
             SET target_table = 'leads'
           WHERE tenant_id = ${tenantId} AND target_id = ${companyId}
        `),
      ),
      /cannot be rewritten/,
    );
  });

  /**
   * ⭐ THE OTHER HALF OF THE SAME RULE, AND THE TEST THAT WOULD HAVE CAUGHT
   * THE SUPERSEDED FILE. Phase 3's blanket trigger refused this write, so
   * the first customer to undo an import would have been told the table is
   * append-only and their rows would have stayed imported.
   */
  it("PERMITS the reversal fields — this is the write that records an undo", async () => {
    const { withTenant } = await import("@/db");
    const { sql } = await import("drizzle-orm");
    const runId = await makeRun();
    const companyId = await writeCompanyWithProvenance(runId);

    await expect(
      withTenant(tenantId, (tx) =>
        tx.execute(sql`
          UPDATE import_row_provenance
             SET reversed_at = now(), reversal_id = gen_random_uuid()
           WHERE tenant_id = ${tenantId} AND target_id = ${companyId}
        `),
      ),
    ).resolves.toBeDefined();
  });
});

/* ================================================================== */
/* 1. THE POSITIVE CONTROL                                             */
/* ================================================================== */

describe("§1 a clean file — the control that shows the harness can see a commit", () => {
  it("preview moves nothing; commit creates exactly what the preview promised", async () => {
    const csv =
      "Name,Domain,Employees\n" +
      Array.from({ length: 5 }, (_, i) => `Control Co ${RUN} ${i},ctl${i}-${RUN}.example.com,${10 + i}`).join("\n");

    const verdict = await verify("companies", csv);

    expect(verdict.problems).toEqual([]);
    expect(verdict.previewMoved).toEqual([]);
    expect(verdict.exact).toBe(true);
    expect(verdict.preview.counts).toEqual({ create: 5, update: 0, skip: 0, error: 0 });
    expect(verdict.commit.counts).toEqual(verdict.preview.counts);

    /*
     * 🔴 AND THE COMMIT MUST HAVE BEEN VISIBLE. Without this the whole
     * suite is compatible with a measurement that sees nothing at all —
     * every "the preview moved nothing" would pass on a broken counter.
     */
    const companies = verdict.commitMoved.find((d) => d.destination === "companies");
    expect(companies?.moved).toBe(5);
  });
});

/* ================================================================== */
/* 2. UNRESOLVABLE LOOKUPS                                             */
/* ================================================================== */

describe("§2 unresolvable lookups become reported errors in BOTH runs", () => {
  it("an invoice naming a customer nobody has: same error, same row, no write", async () => {
    const csv =
      "Customer,Invoice number,Invoice date,Amount outstanding\n" +
      `${CUSTOMER_PRESENT},P3-INV-A-${RUN},2026-01-15,15000.00\n` +
      `${CUSTOMER_ABSENT},P3-INV-B-${RUN},2026-01-16,22000.00\n` +
      `${CUSTOMER_PRESENT},P3-INV-C-${RUN},2026-01-17,3000.50`;

    const verdict = await verify("opening-customer-invoices", csv);

    expect(verdict.problems).toEqual([]);
    expect(verdict.previewMoved).toEqual([]);
    expect(verdict.exact).toBe(true);
    expect(verdict.preview.counts).toEqual({ create: 2, update: 0, skip: 0, error: 1 });
    expect(verdict.commit.counts).toEqual(verdict.preview.counts);

    /* ⭐ AND THE SENTENCE IS THE ENTITY'S OWN, IN THE PREVIEW. */
    const failed = verdict.preview.rows.find((r) => r.disposition === "error");
    expect(failed?.errors[0]?.message).toContain(`There is no company called "${CUSTOMER_ABSENT}"`);

    const invoices = verdict.commitMoved.find((d) => d.destination === "sales_invoices");
    expect(invoices?.moved).toBe(2);
  });
});

/* ================================================================== */
/* 3. DUPLICATE NATURAL KEYS WITHIN ONE FILE                           */
/* ================================================================== */

describe("§3 two rows with the same natural key: the second is refused, identically", () => {
  it("names the row it collides with, in the preview, and writes one", async () => {
    const domain = `dupe-${RUN}.example.com`;
    const csv =
      "Name,Domain\n" +
      `First Spelling ${RUN},${domain}\n` +
      `Second Spelling ${RUN},${domain}\n` +
      `Unrelated ${RUN},other-${RUN}.example.com`;

    const verdict = await verify("companies", csv);

    expect(verdict.problems).toEqual([]);
    expect(verdict.previewMoved).toEqual([]);
    expect(verdict.exact).toBe(true);
    expect(verdict.preview.counts).toEqual({ create: 2, update: 0, skip: 0, error: 1 });

    const failed = verdict.preview.rows.find((r) => r.disposition === "error");
    expect(failed?.recordNumber).toBe(3);
    expect(failed?.errors[0]?.message).toContain("This is the same company as row 2");

    const companies = verdict.commitMoved.find((d) => d.destination === "companies");
    expect(companies?.moved).toBe(2);
  });
});

/* ================================================================== */
/* 4. A FILE WHOSE ENTITY WAS MIS-DETECTED                             */
/* ================================================================== */

describe("§4 a file loaded as the wrong entity", () => {
  it("is refused whole, with the same sentence, and moves nothing in either run", async () => {
    /*
     * ⭐ THE FILE IS A COMPANY LIST AND IT IS OFFERED AS GST PARTIES —
     * exactly the mistake `server/import/discovery.ts` exists to prevent,
     * and exactly what a customer does today with `Master1.csv`.
     */
    const csv =
      "Name,Domain\n" +
      `Misdetected Co ${RUN},mis-${RUN}.example.com\n` +
      `Misdetected Two ${RUN},mis2-${RUN}.example.com`;

    const verdict = await verify("gst-parties", csv);

    expect(verdict.problems).toEqual([]);
    expect(verdict.previewMoved).toEqual([]);
    expect(verdict.commitMoved).toEqual([]);
    expect(verdict.exact).toBe(true);
    expect(verdict.preview.fatal).toBeTruthy();
    expect(verdict.preview.fatal).toBe(verdict.commit.fatal);
    expect(verdict.preview.counts).toEqual({ create: 0, update: 0, skip: 0, error: 0 });
  });

  it("and discovery would have said `companies` about the same bytes", async () => {
    const { discoverFolder } = await import("@/server/import/discovery");
    const { ALL_IMPORT_ENTITIES } = await import("@/lib/import/entities");
    const { parseCsv } = await import("@/lib/import/csv");

    const csv =
      "Name,Website,Employees,Phone,Pincode\n" +
      Array.from(
        { length: 20 },
        (_, i) =>
          `Misdetected Co ${i},https://mis${i}.example.com,${10 + i},+91 98${String(76543210 + i)},4110${i % 10}1`,
      ).join("\n");

    const parsed = parseCsv(csv);
    if (!parsed.ok) throw new Error(parsed.error);

    const discovery = discoverFolder(
      [{ name: "Master1.csv", records: parsed.records }],
      ALL_IMPORT_ENTITIES,
    );
    expect(discovery.files[0]?.chosen).toBe("companies");
  });
});

/* ================================================================== */
/* 5. AN ATOMIC ENTITY THAT FAILS ITS FILE RULE                        */
/* ================================================================== */

describe("§5 an atomic entity", () => {
  it("refuses an unbalanced trial balance identically in both runs, writing nothing", async () => {
    const csv =
      "Account code,Account name,As at,Debit,Credit\n" +
      `${CODE_DEBIT},Opening Bank,2026-03-31,100000.00,\n` +
      `${CODE_CREDIT},Opening Capital,2026-03-31,,90000.00`;

    const verdict = await verify("opening-trial-balance", csv, "fail");

    expect(verdict.problems).toEqual([]);
    expect(verdict.previewMoved).toEqual([]);
    expect(verdict.commitMoved).toEqual([]);
    expect(verdict.exact).toBe(true);
    expect(verdict.preview.fatal).toBe(verdict.commit.fatal);
    expect(verdict.preview.fatal).toMatch(/does not balance|10,000|difference/i);
  });

  it("refuses the WHOLE file when one row is unreadable, and still hands back every row", async () => {
    /*
     * ⚠️ THE REFUSAL IS ROW ERRORS AND NOT A `fatal`, on purpose: a fatal
     * empties `rows` and takes the failed-rows CSV with it, and that
     * download is the whole mechanism by which the customer finds the one
     * line that was wrong.
     */
    const csv =
      "Account code,Account name,As at,Debit,Credit\n" +
      `${CODE_DEBIT},Opening Bank,2026-03-31,100000.00,\n` +
      `${CODE_CREDIT},Opening Capital,2026-03-31,,not a number`;

    const verdict = await verify("opening-trial-balance", csv, "fail");

    expect(verdict.problems).toEqual([]);
    expect(verdict.previewMoved).toEqual([]);
    expect(verdict.commitMoved).toEqual([]);
    expect(verdict.exact).toBe(true);
    expect(verdict.preview.fatal).toBeNull();
    expect(verdict.preview.counts.create).toBe(0);
    expect(verdict.preview.counts.error).toBe(2);
    expect(verdict.preview.failedRowsCsv).toBeTruthy();
    expect(verdict.commit.counts).toEqual(verdict.preview.counts);
  });

  it("posts the whole file as ONE document when it balances — and says so in both runs", async () => {
    const csv =
      "Account code,Account name,As at,Debit,Credit\n" +
      `${CODE_DEBIT},Opening Bank,2026-03-31,100000.00,\n` +
      `${CODE_CREDIT},Opening Capital,2026-03-31,,100000.00`;

    const verdict = await verify("opening-trial-balance", csv, "fail");

    expect(verdict.problems).toEqual([]);
    expect(verdict.previewMoved).toEqual([]);
    expect(verdict.exact).toBe(true);
    expect(verdict.preview.counts).toEqual({ create: 2, update: 0, skip: 0, error: 0 });

    /*
     * ⭐⭐ TWO REPORT ROWS, ONE `transactions` ROW, TWO `journal_entries`
     * ROWS. That is what `cardinality: "whole-file"` means, and it is why
     * a reconciliation that expected one output per input row would
     * report a missing row on a perfectly correct import.
     */
    const transactions = verdict.commitMoved.find((d) => d.destination === "transactions");
    const journal = verdict.commitMoved.find((d) => d.destination === "journal_entries");
    expect(transactions?.moved).toBe(1);
    expect(journal?.moved).toBe(2);
  });
});

/* ================================================================== */
/* 6. THE ROW CEILING                                                  */
/* ================================================================== */

describe("§6 a run that hits the row ceiling", () => {
  it("is refused before a row is read, identically, in both runs", async () => {
    const { MAX_IMPORT_ROWS } = await import("@/lib/import/plan");
    const csv =
      "Name,Domain\n" +
      Array.from(
        { length: MAX_IMPORT_ROWS + 1 },
        (_, i) => `Ceiling Co ${i},ceil${i}-${RUN}.example.com`,
      ).join("\n");

    const verdict = await verify("companies", csv);

    expect(verdict.problems).toEqual([]);
    expect(verdict.previewMoved).toEqual([]);
    expect(verdict.commitMoved).toEqual([]);
    expect(verdict.exact).toBe(true);
    expect(verdict.preview.fatal).toContain(String(MAX_IMPORT_ROWS + 1));
    expect(verdict.preview.fatal).toBe(verdict.commit.fatal);
  });
});

/* ================================================================== */
/* 7. WHAT THE CORPUS FOUND                                            */
/* ================================================================== */

describe("§7 the two findings this corpus produced, recorded as tests so they cannot fade", () => {
  /**
   * 🔴 FINDING 1 — `opening-trial-balance` DECLARES ONE DESTINATION AND
   *    WRITES TWO.
   *
   * `contract.provenance.targets` is `["transactions"]`. `writeOpeningTrialBalance`
   * inserts into `transactions` AND `journal_entries`. Provenance decides
   * what a reversal can undo: a reversal reading only the declared target
   * would find the transaction and leave every journal leg behind.
   */
  /**
   * ⭐ THIS FINDING WAS REAL, AND IT HAS SINCE BEEN FIXED. The test is kept
   * and inverted rather than deleted, which is what "recorded so they
   * cannot fade" has to mean once a finding is closed: it now asserts the
   * fix, so a regression re-opens the original defect as a failure.
   *
   * ══════════════════════════════════════════════════════════════════════
   * ⚠️ AND IT HAD NEVER ONCE RUN — WAVE 4 INTEGRATION
   * ══════════════════════════════════════════════════════════════════════
   * `verifyDryRun` calls `import_destination_row_count()`, which SQL 0216
   * creates, and 0216 was one of the fourteen files held back from
   * production. So this whole section could only ever fail with "function
   * does not exist". Its expectation was written by reading the code, not
   * by running it. The first real run said something different: the
   * contract now declares `journal_entries`, and the undeclared
   * destination reported instead was `change_log` — which is not a
   * destination at all, and is now filtered by `NEVER_A_DESTINATION` in
   * `server/import/dryrun.ts`.
   *
   * 🔴 THE LESSON, BECAUSE IT IS THE ONE THIS REPOSITORY KEEPS RE-LEARNING:
   * a test that cannot execute is not a weaker test, it is a comment.
   */
  it("FINDING (fixed): the trial balance now declares `journal_entries`, the table that holds the money", async () => {
    const csv =
      "Account code,Account name,As at,Debit,Credit\n" +
      `${CODE_DEBIT},Opening Bank,2026-06-30,55000.00,\n` +
      `${CODE_CREDIT},Opening Capital,2026-06-30,,55000.00`;

    const verdict = await verify("opening-trial-balance", csv, "fail");

    expect(verdict.problems).toEqual([]);

    const { declaredDestinations } = await import("@/server/import/dryrun");
    const { ALL_IMPORT_ENTITIES } = await import("@/lib/import/entities");
    const declared = declaredDestinations(ALL_IMPORT_ENTITIES["opening-trial-balance"]);

    /* The fix: the writer inserts into both, and the contract says both. */
    expect(declared).toContain("transactions");
    expect(declared).toContain("journal_entries");

    /*
     * ⚠️ AND NOTHING IS LEFT UNDECLARED. A reversal reads the declared
     * targets to decide what it may undo; a target the writer touches and
     * the contract omits is a leg the undo leaves behind.
     */
    expect(verdict.undeclaredDestinations).toEqual([]);
  });

  /**
   * 🔴 AND THE FILTER IS NOT A BLINDFOLD. `change_log` is excluded from the
   * undeclared REPORT and still measured, so the recorders cannot become a
   * place a write hides.
   */
  it("the change recorder is measured even though it is not reported as a destination", async () => {
    const { NEVER_A_DESTINATION } = await import("@/server/import/dryrun");
    expect(NEVER_A_DESTINATION).toContain("change_log");
    expect(NEVER_A_DESTINATION).not.toContain("transactions");
    expect(NEVER_A_DESTINATION).not.toContain("import_row_provenance");
  });

  it("FINDING: an atomic file with one unresolvable account promises rows that cannot land", async () => {
    const csv =
      "Account code,Account name,As at,Debit,Credit\n" +
      `${CODE_DEBIT},Opening Bank,2026-09-30,70000.00,\n` +
      `${CODE_ABSENT},Ghost Account,2026-09-30,30000.00,\n` +
      `${CODE_CREDIT},Opening Capital,2026-09-30,,100000.00`;

    const verdict = await verify("opening-trial-balance", csv, "fail");

    /* The preview moved nothing — claim ① holds even where claim ② does not. */
    expect(verdict.previewMoved).toEqual([]);
    expect(verdict.commitMoved).toEqual([]);

    /* The preview promised two creations. */
    expect(verdict.preview.counts).toEqual({ create: 2, update: 0, skip: 0, error: 1 });

    /* The commit created none of them. */
    expect(verdict.commit.counts.create).toBe(0);
    expect(verdict.commit.counts.error).toBe(3);
    expect(verdict.exact).toBe(false);
    expect(verdict.comparison.writeResidue).toHaveLength(2);

    /*
     * 🔴 FINDING 3, WHICH FELL OUT OF FINDING 2 AND IS ITS OWN DEFECT.
     *
     * The ledger's refusal is a real sentence — see the next test — and
     * the customer is shown "This row was refused by the database and has
     * not been imported."
     *
     * ⚠️ `describeWriteFailure` DOES pass a 23514 through. The reason it
     * does not here is that `journal_entries_balance_check` is a DEFERRED
     * constraint trigger: it fires at COMMIT, so the error is raised by
     * the driver's `COMMIT` rather than by an INSERT, and arrives wrapped
     * by Drizzle with `code` on `cause` instead of on the error itself.
     * `describeWriteFailure` reads `err.code`, finds nothing, and falls
     * through to its last line.
     */
    expect(verdict.comparison.writeResidue[0]?.commitErrors.join(" ")).toBe(
      "This row was refused by the database and has not been imported.",
    );
  });

  it("FINDING: and the sentence that was discarded is a good one", async () => {
    /*
     * ⭐ THE SAME WRITE, ISSUED DIRECTLY, SO THE MESSAGE THE CUSTOMER DID
     * NOT SEE CAN BE SHOWN TO EXIST. A finding that says "the error is
     * unhelpful" without producing the helpful one it replaced is a
     * complaint; this is the diff.
     */
    const { withTenant } = await import("@/db");
    const { sql } = await import("drizzle-orm");

    let captured: { code?: unknown; message?: unknown } | null = null;
    try {
      await withTenant(tenantId, async (tx) => {
        const txn = await tx.execute(sql`
          INSERT INTO transactions
            (tenant_id, transaction_number, description, transaction_date,
             status, reference_type, currency, total_amount, created_by)
          VALUES (${tenantId}, ${`P3-UNBAL-${RUN}`}, 'Deliberately unbalanced',
                  '2026-10-31', 'posted', 'opening_balance', 'INR', '700.00',
                  ${String(h.ctx.user.id)})
          RETURNING id
        `);
        const id = (txn.rows[0] as { id: string }).id;
        await tx.execute(sql`
          INSERT INTO journal_entries
            (tenant_id, transaction_id, ledger_id, entry_type, amount_minor, reference_type)
          SELECT ${tenantId}, ${id}, l.id, 'debit', 70000, 'opening_balance'
            FROM ledgers l WHERE l.tenant_id = ${tenantId} AND l.code = ${CODE_DEBIT}
        `);
      });
    } catch (err) {
      for (let cause: unknown = err, depth = 0; cause && depth < 5; depth += 1) {
        const candidate = cause as { code?: unknown; message?: unknown; cause?: unknown };
        if (typeof candidate.code === "string") {
          captured = candidate;
          break;
        }
        cause = candidate.cause;
      }
    }

    expect(captured).not.toBeNull();
    expect(captured?.code).toBe("23514");
    expect(String(captured?.message)).toMatch(/unbalanced|balance/i);
  });
});

/* ================================================================== */
/* 8. THE NARROW FOOTPRINT — what a production self-check would use    */
/* ================================================================== */

describe("§8 the cheap footprint, for a rehearsal that cannot afford 307 counts", () => {
  /**
   * ⚠️ `everyTenantScopedDestination()` IS THE COMPLETE ANSWER AND IT IS
   * EXPENSIVE. Three hundred `count(*)`s against a large workspace is a
   * test and a cutover rehearsal, not something to run inside a customer's
   * import. `allDeclaredDestinations()` is the narrow one — and the two are
   * proven here to agree about the tables they share, so choosing the cheap
   * one is a choice about COVERAGE and not about correctness.
   */
  it("covers every declared target of every registered entity, plus the sidecar", async () => {
    const { allDeclaredDestinations, measureFootprint } = await import("@/server/import/dryrun");
    const { ALL_IMPORT_ENTITIES } = await import("@/lib/import/entities");

    const declared = allDeclaredDestinations(ALL_IMPORT_ENTITIES);
    expect(declared).toContain("import_row_provenance");
    expect(declared).toEqual([...declared].sort());
    for (const entity of Object.values(ALL_IMPORT_ENTITIES)) {
      for (const target of entity.contract.provenance.targets) {
        expect(declared).toContain(target);
      }
    }

    const narrow = await measureFootprint(tenantId, declared);
    const wide = await measureFootprint(tenantId, everyDestination);
    for (const [destination, rows] of narrow.counts) {
      expect(wide.counts.get(destination), destination).toBe(rows);
    }
  });

  it("says what happened in one sentence, the same sentence everywhere", async () => {
    const { describeVerdict } = await import("@/server/import/dryrun");

    const clean = await verify(
      "companies",
      "Name,Domain\n" + `Sentence Co ${RUN},sentence-${RUN}.example.com`,
    );
    expect(describeVerdict(clean)).toBe(
      "The dry run moved nothing and the commit did exactly what it said: " +
        "1 created, 0 updated, 0 skipped, 0 refused.",
    );

    const drifted = await verify(
      "opening-trial-balance",
      "Account code,Account name,As at,Debit,Credit\n" +
        `${CODE_DEBIT},Opening Bank,2026-11-30,40000.00,\n` +
        `${CODE_ABSENT},Ghost Account,2026-11-30,10000.00,\n` +
        `${CODE_CREDIT},Opening Capital,2026-11-30,,50000.00`,
      "fail",
    );
    expect(describeVerdict(drifted)).toContain("the database refused 2 row(s) the preview expected to create");
  });
});
