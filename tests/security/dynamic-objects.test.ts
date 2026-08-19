/**
 * Ordence — Runtime Custom Objects: RLS, Injection and the Happy Path
 * Version: v0.24.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS ACTUALLY TRYING TO PROVE
 * ══════════════════════════════════════════════════════════════════════
 * Twenty-three phases say the same thing every time: the defects that
 * survive are the SILENT ones. `writeAudit` discarded the audit trail for
 * fourteen phases with no error. `withPlatformScope` read zero rows and
 * failed closed, so nothing leaked and nothing worked.
 *
 * This phase has two new ways to be silent, and the first is the worst
 * one in the codebase so far:
 *
 *   ⭐ A RUNTIME TABLE WITH NO ROW-LEVEL SECURITY. It works perfectly.
 *      Every query the product issues returns the right rows, because the
 *      product also filters by tenant. Nothing errors, nothing logs, and
 *      every other workspace on the instance can read that customer's
 *      records with one SELECT. The first sign is a support ticket that
 *      is really a breach notification.
 *
 *   ⭐ AN IDENTIFIER THAT REACHES DDL UNCHECKED. A table name cannot be a
 *      bind parameter, so the habit that has kept twenty-three phases
 *      safe — parameterise everything — does not apply here and LOOKS
 *      like it does.
 *
 * So these tests do not inspect the guards. They:
 *
 *   • CREATE REAL TABLES through the factory and read `pg_class` and
 *     `pg_policy` to see what actually came out;
 *   • try to read and write one tenant's runtime table as another;
 *   • feed the identifier gate the attacks, in BOTH languages — the
 *     TypeScript copy in `lib/dynamic/identifiers.ts` and the SQL copy in
 *     `dynamic_assert_identifier()` — because two implementations of one
 *     rule are two chances to be wrong;
 *   • and prove the ordinary path still works, because a gate that
 *     refuses everything is an outage, not a gate.
 *
 * ⚠️ EVERY DATABASE ASSERTION RUNS AS THE ORDINARY APPLICATION ROLE.
 * `asSuperuser` appears only for fixtures and teardown: a superuser
 * bypasses row-level security entirely and a suite written on one proves
 * nothing at all.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { asTenant, asSuperuser, withoutTenant, expectError } from "../setup";

import {
  assertIdentifier,
  checkIdentifier,
  physicalTableName,
  assertPhysicalTableName,
  identifierByteLength,
  suggestApiName,
  IdentifierError,
  PHYSICAL_TABLE_PREFIX,
  SYSTEM_COLUMNS,
} from "@/lib/dynamic/identifiers";
import { planField, planFields, planObject, DdlPlanError } from "@/lib/dynamic/ddl";
import { pgTypeFor, DYNAMIC_FIELD_TYPES } from "@/lib/dynamic/field-types";
import { validateRecordValues, parseMinorUnits } from "@/lib/dynamic/values";
import { MAX_OBJECTS_PER_TENANT } from "@/lib/dynamic/limits";

/* ================================================================== */
/* FIXTURES                                                            */
/* ================================================================== */

let tenantA: string;
let tenantB: string;
let userA: string;
let userB: string;

/** Every physical table this suite creates, so teardown can drop them. */
const createdTables: string[] = [];

type TestField = {
  apiName: string;
  fieldType: string;
  required?: boolean;
  unique?: boolean;
  indexed?: boolean;
  options?: string[];
  relationTable?: string;
};

/**
 * Create a record type the way the server does: metadata row first (the
 * cap is counted in the database), then the factory, then a row-and-column
 * pair per field — all as the ORDINARY APPLICATION ROLE, inside one
 * tenant-scoped transaction.
 */
async function makeObject(
  tenantId: string,
  apiName: string,
  fields: TestField[],
): Promise<{ objectId: string; table: string }> {
  const objectId = randomUUID();
  const table = `${PHYSICAL_TABLE_PREFIX}${apiName}_${objectId.replace(/-/g, "").slice(0, 8)}`;

  await asTenant(tenantId, async (c) => {
    await c.query(
      `INSERT INTO dynamic_objects
         (id, tenant_id, api_name, label, plural_label, physical_table_name,
          display_field_api_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [objectId, tenantId, apiName, apiName, `${apiName}s`, table, fields[0]?.apiName ?? null],
    );

    await c.query(`SELECT dynamic_create_object_table($1::uuid, $2)`, [tenantId, table]);

    for (const field of fields) {
      const options = field.options ?? [];
      await c.query(
        `INSERT INTO dynamic_fields
           (tenant_id, object_id, api_name, label, field_type, physical_column_name,
            is_required, is_unique, is_indexed, options, relation_core_table)
         VALUES ($1,$2,$3,$4,$5::dynamic_field_type,$6,$7,$8,$9,$10::jsonb,$11)`,
        [
          tenantId,
          objectId,
          field.apiName,
          field.apiName,
          field.fieldType,
          field.apiName,
          field.required ?? false,
          field.unique ?? false,
          field.indexed ?? false,
          JSON.stringify(options.map((v) => ({ value: v, label: v }))),
          field.relationTable ?? null,
        ],
      );

      await c.query(
        `SELECT dynamic_add_field_column($1::uuid,$2,$3,$4,$5,$6,$7,$8::text[],$9,$10)`,
        [
          tenantId,
          table,
          field.apiName,
          field.fieldType,
          field.required ?? false,
          field.unique ?? false,
          field.indexed ?? false,
          options.length ? options : null,
          field.relationTable ?? null,
          "set_null",
        ],
      );
    }
  });

  createdTables.push(table);
  return { objectId, table };
}

beforeAll(async () => {
  tenantA = randomUUID();
  tenantB = randomUUID();
  userA = randomUUID();
  userB = randomUUID();

  await asSuperuser(async (c) => {
    for (const [id, name] of [
      [tenantA, "Dynamic Objects A"],
      [tenantB, "Dynamic Objects B"],
    ] as const) {
      await c.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
         VALUES ($1,$2,$3,$4,'active')`,
        [id, `org_${id}`, `dyn-${id.slice(0, 8)}`, name],
      );
    }

    await c.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, status) VALUES
         ($1,$2,$3,'dyn-a@example.test','tenant_admin','active'),
         ($4,$5,$6,'dyn-b@example.test','tenant_admin','active')`,
      [userA, tenantA, `usr_${userA}`, userB, tenantB, `usr_${userB}`],
    );
  });
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    const tenants = [tenantA, tenantB];

    for (const table of createdTables) {
      // ⚠️ The identifier is one this suite generated from a uuid, never
      // from anything a test typed. Interpolating anything else here
      // would make the teardown the injection.
      if (!/^cx_[a-z0-9_]+$/.test(table)) throw new Error(`refusing to drop ${table}`);
      await c.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    }

    await c.query(`DELETE FROM dynamic_fields  WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM dynamic_objects WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM change_log      WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM users           WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM tenants         WHERE id = ANY($1::uuid[])`, [tenants]);

    // Prove the engine is intact for whatever runs next. A teardown that
    // dropped a function or a policy would void the guarantee for every
    // later suite — and everything would still be green, which is the
    // dangerous part.
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM pg_proc
        WHERE proname IN ('dynamic_create_object_table','dynamic_add_field_column',
                          'dynamic_assert_identifier','dynamic_drop_object_table')`,
    );
    expect(rows[0].n).toBe(4);
  });
});

/* ================================================================== */
/* 1. ⭐⭐ EVERY CREATED TABLE IS PROTECTED                            */
/* ================================================================== */

describe("⭐ a runtime table is born protected", () => {
  it("has tenant_id NOT NULL, RLS enabled AND forced, and a policy with USING + WITH CHECK", async () => {
    const { table } = await makeObject(tenantA, "site_visit", [
      { apiName: "visitor_name", fieldType: "text", required: true },
    ]);

    await asSuperuser(async (c) => {
      const { rows } = await c.query(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE oid = $1::regclass`,
        [table],
      );

      expect(rows[0].relrowsecurity, `${table} ENABLE`).toBe(true);
      // ⚠️ FORCE is the half that is usually missing. Without it the table
      // owner reads everything and the policies look correct in every
      // interface — including `\d`, including our own admin screens.
      expect(rows[0].relforcerowsecurity, `${table} FORCE`).toBe(true);

      const policies = await c.query(
        `SELECT pg_get_expr(polqual, polrelid) AS qual,
                pg_get_expr(polwithcheck, polrelid) AS with_check
           FROM pg_policy WHERE polrelid = $1::regclass`,
        [table],
      );

      expect(policies.rows).toHaveLength(1);
      expect(policies.rows[0].qual).toContain("tenant_id");
      // ⚠️ WITHOUT `WITH CHECK`, another tenant can INSERT a row into this
      // table that is invisible to them and fully live for the owner.
      expect(policies.rows[0].with_check).toContain("tenant_id");

      const column = await c.query(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'tenant_id'`,
        [table],
      );
      expect(column.rows[0].is_nullable).toBe("NO");
    });
  });

  it("⭐ carries a CHECK pinning it to one workspace, so a wrong tenant cannot exist in it", async () => {
    const { table } = await makeObject(tenantA, "pinned_thing", [
      { apiName: "title", fieldType: "text" },
    ]);

    await asSuperuser(async (c) => {
      const { rows } = await c.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = $1::regclass AND contype = 'c'`,
        [table],
      );
      expect(rows.some((r: { def: string }) => r.def.includes("tenant_id"))).toBe(true);
    });
  });

  it("EVERY runtime table in the database is enabled, forced and policied", async () => {
    // The drift check, as a test rather than only as a SQL verification.
    // `drizzle-kit push` DROPS POLICIES, so this is the assertion that
    // catches the day somebody skips re-running SQL-FILES afterwards.
    await asSuperuser(async (c) => {
      const { rows } = await c.query(`
        SELECT c.relname,
               c.relrowsecurity AS enabled,
               c.relforcerowsecurity AS forced,
               EXISTS (SELECT 1 FROM pg_policy p
                        WHERE p.polrelid = c.oid
                          AND p.polqual IS NOT NULL
                          AND p.polwithcheck IS NOT NULL) AS policied
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'cx\\_%'
      `);

      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.enabled, `${row.relname} ENABLE`).toBe(true);
        expect(row.forced, `${row.relname} FORCE`).toBe(true);
        expect(row.policied, `${row.relname} policy with USING + WITH CHECK`).toBe(true);
      }
    });
  });

  it("the metadata tables themselves are enabled and forced", async () => {
    await asSuperuser(async (c) => {
      const { rows } = await c.query(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relname = ANY($1::text[])`,
        [["dynamic_objects", "dynamic_fields"]],
      );
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.relrowsecurity, `${row.relname} ENABLE`).toBe(true);
        expect(row.relforcerowsecurity, `${row.relname} FORCE`).toBe(true);
      }
    });
  });

  it("⭐ the application role cannot create a table of its own", async () => {
    // The line that turns "tables are made by the factory" from a
    // convention into a guarantee. With CREATE on the schema, one stray
    // `CREATE TABLE` anywhere in the codebase is an unprotected table.
    const error = await expectError(() =>
      asTenant(tenantA, (c) => c.query(`CREATE TABLE leak_probe (id uuid)`)),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/permission denied/i);
  });
});

/* ================================================================== */
/* 2. ⭐⭐ CROSS-TENANT ISOLATION ON A RUNTIME TABLE                   */
/* ================================================================== */

describe("⭐ cross-tenant isolation on a table that did not exist an hour ago", () => {
  let table: string;
  let objectId: string;
  let recordId: string;

  beforeAll(async () => {
    ({ table, objectId } = await makeObject(tenantA, "escalation", [
      { apiName: "subject", fieldType: "text", required: true },
      { apiName: "amount_paise", fieldType: "currency" },
    ]));

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO ${table} (tenant_id, subject, amount_paise)
         VALUES ($1, 'Lift not working', 125050) RETURNING id`,
        [tenantA],
      );
      recordId = rows[0].id;
    });
  });

  it("tenant A can read its own record", async () => {
    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(`SELECT subject, amount_paise FROM ${table}`);
      expect(rows).toHaveLength(1);
      expect(rows[0].subject).toBe("Lift not working");
      // ⭐ Money survives the round trip exactly. `bigint` comes back as a
      // string from node-postgres, which is correct — a JS number would
      // lose the last paisa above 2^53.
      expect(rows[0].amount_paise).toBe("125050");
    });
  });

  it("⭐ tenant B cannot read it, even holding the exact row id", async () => {
    // The IDOR shape: the attacker HAS the identifier.
    await asTenant(tenantB, async (c) => {
      const all = await c.query(`SELECT id FROM ${table}`);
      expect(all.rows).toHaveLength(0);

      const byId = await c.query(`SELECT id FROM ${table} WHERE id = $1`, [recordId]);
      expect(byId.rows).toHaveLength(0);
    });
  });

  it("⭐ tenant B cannot plant a row in tenant A's table under A's id", async () => {
    const error = await expectError(() =>
      asTenant(tenantB, (c) =>
        c.query(`INSERT INTO ${table} (tenant_id, subject) VALUES ($1, 'planted')`, [
          tenantA,
        ]),
      ),
    );

    // The WITH CHECK clause. With only USING, this would SUCCEED — the row
    // would be invisible to the writer and fully live for the victim.
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/row-level security/i);
  });

  it("⭐ tenant B cannot plant a row under its OWN id either — the tenant pin", async () => {
    // This one passes the policy (the tenant matches the session) and is
    // stopped by the CHECK constraint that pins the table to one
    // workspace. It is the belt to the policy's braces: it holds even if
    // the policy is dropped, even under a superuser, even after a restore.
    const error = await expectError(() =>
      asTenant(tenantB, (c) =>
        c.query(`INSERT INTO ${table} (tenant_id, subject) VALUES ($1, 'mine')`, [tenantB]),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/check constraint|row-level security/i);
  });

  it("tenant B cannot UPDATE or DELETE tenant A's record", async () => {
    await asTenant(tenantB, async (c) => {
      const updated = await c.query(
        `UPDATE ${table} SET subject = 'hijacked' WHERE id = $1 RETURNING id`,
        [recordId],
      );
      expect(updated.rows).toHaveLength(0);

      const deleted = await c.query(`DELETE FROM ${table} WHERE id = $1 RETURNING id`, [
        recordId,
      ]);
      expect(deleted.rows).toHaveLength(0);
    });

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(`SELECT subject FROM ${table} WHERE id = $1`, [recordId]);
      expect(rows[0].subject).toBe("Lift not working");
    });
  });

  it("no tenant context reads ZERO rows, never all of them", async () => {
    // Fail closed. `tenant_id = NULL` is NULL in SQL, never TRUE.
    await withoutTenant(async (c) => {
      const { rows } = await c.query(`SELECT id FROM ${table}`);
      expect(rows).toHaveLength(0);
    });
  });

  it("tenant B cannot see tenant A's object DEFINITION", async () => {
    // A list of what a business tracks — "Escalation", "Litigation" — is
    // commercially sensitive before a single record exists.
    await asTenant(tenantB, async (c) => {
      const { rows } = await c.query(
        `SELECT api_name FROM dynamic_objects WHERE id = $1`,
        [objectId],
      );
      expect(rows).toHaveLength(0);
    });
  });

  it("⭐ tenant B cannot add a column to tenant A's table", async () => {
    const error = await expectError(() =>
      asTenant(tenantB, (c) =>
        c.query(`SELECT dynamic_add_field_column($1::uuid,$2,$3,$4)`, [
          tenantB,
          table,
          "backdoor",
          "text",
        ]),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/does not exist in this workspace/i);
  });

  it("⭐ a caller cannot create a table pinned to somebody else's workspace", async () => {
    // The privileged-function hazard: `dynamic_create_object_table` runs as
    // its owner, so the workspace it acts on must come from the session
    // rather than from its caller.
    const error = await expectError(() =>
      asTenant(tenantB, (c) =>
        c.query(`SELECT dynamic_create_object_table($1::uuid, $2)`, [
          tenantA,
          "cx_smuggled_deadbeef",
        ]),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/other than the one this session/i);
  });
});

/* ================================================================== */
/* 3. ⭐⭐ SQL INJECTION THROUGH IDENTIFIERS                           */
/* ================================================================== */

/**
 * The attacks, in one list, fed to BOTH validators.
 *
 * ⚠️ Each entry says what it is FOR, because the interesting ones do not
 * look dangerous. `select` is not an injection; it is a column that works
 * until the first query somebody writes by hand. `usеrs` with a Cyrillic
 * е is indistinguishable from `users` in every code review that will ever
 * be done on it.
 */
const IDENTIFIER_ATTACKS: { input: string; why: string }[] = [
  { input: `"; DROP TABLE users; --`, why: "quote breaking, the classic" },
  { input: `users"; DROP TABLE users; --`, why: "the same, with a plausible prefix" },
  { input: `a' OR '1'='1`, why: "literal breaking" },
  { input: `users; DELETE FROM tenants`, why: "statement stacking" },
  { input: `users/*comment*/`, why: "comment smuggling" },
  { input: `SELECT`, why: "capitals — refused, never lower-cased" },
  { input: `select`, why: "a reserved word" },
  { input: `user`, why: "a reserved word that is also a real column elsewhere" },
  { input: `table`, why: "a reserved word" },
  { input: `order`, why: "a reserved word" },
  { input: `tenant_id`, why: "⭐ shadowing the column RLS is enforced on" },
  { input: `id`, why: "shadowing a system column" },
  { input: `created_at`, why: "shadowing a system column" },
  { input: `xmin`, why: "a PostgreSQL system column that is on no CREATE TABLE" },
  { input: `pg_class`, why: "the catalogue prefix" },
  { input: `usеrs`, why: "⚠️ Cyrillic е — a homoglyph, identical on screen" },
  { input: `ｕsers`, why: "fullwidth u" },
  { input: `user​s`, why: "zero-width space" },
  { input: `users\nDROP TABLE tenants`, why: "embedded newline" },
  { input: `café`, why: "non-ASCII, and 5 bytes for 4 characters" },
  { input: `2fast`, why: "leading digit" },
  { input: `_leading`, why: "leading underscore" },
  { input: `has space`, why: "whitespace" },
  { input: `has-hyphen`, why: "a hyphen, which starts a SQL comment when doubled" },
  { input: "a".repeat(64), why: "64 bytes — silently truncated by PostgreSQL" },
  { input: "é".repeat(40), why: "40 characters but 80 BYTES" },
];

describe("⭐ SQL injection through object and field names", () => {
  it("the TypeScript gate refuses every attack", () => {
    for (const { input, why } of IDENTIFIER_ATTACKS) {
      const result = checkIdentifier(input, "field");
      expect(result.ok, `accepted ${JSON.stringify(input)} — ${why}`).toBe(false);
    }
  });

  it("⭐ the DATABASE gate refuses every attack too — the two are one rule", async () => {
    // ⚠️ TypeScript is not the only caller. psql, an import script, a
    // migration hook and a future API route all reach the SQL functions
    // directly, and a validation that lives only at the outermost layer
    // stops applying the first time somebody adds a second entrance.
    await asTenant(tenantA, async (c) => {
      for (const { input, why } of IDENTIFIER_ATTACKS) {
        let refused = false;
        try {
          await c.query(`SELECT dynamic_assert_identifier($1, 'column')`, [input]);
        } catch {
          refused = true;
        }
        expect(refused, `SQL gate accepted ${JSON.stringify(input)} — ${why}`).toBe(true);
      }
    });
  });

  it("⭐ the factory refuses a hostile table name, and `users` is still there", async () => {
    const hostile = [
      `cx_x"; DROP TABLE users; --`,
      `users`,
      `cx_x; DROP TABLE tenants; --`,
      `cx_${"a".repeat(70)}`,
      `CX_UPPER`,
      `cx_café`,
    ];

    await asTenant(tenantA, async (c) => {
      for (const name of hostile) {
        let refused = false;
        try {
          await c.query(`SELECT dynamic_create_object_table($1::uuid, $2)`, [tenantA, name]);
        } catch {
          refused = true;
        }
        expect(refused, `factory accepted ${JSON.stringify(name)}`).toBe(true);
      }
    });

    // The point of the exercise: nothing was dropped.
    await asSuperuser(async (c) => {
      const { rows } = await c.query(
        `SELECT to_regclass('public.users') AS u, to_regclass('public.tenants') AS t`,
      );
      expect(rows[0].u).toBe("users");
      expect(rows[0].t).toBe("tenants");
    });
  });

  it("⭐ a table name without the cx_ prefix is refused — collision is impossible", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, (c) =>
        c.query(`SELECT dynamic_create_object_table($1::uuid, $2)`, [tenantA, "contacts"]),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/must be named "cx_/i);
  });

  it("⭐ a field cannot shadow a system column, in either language", async () => {
    const { table } = await makeObject(tenantA, "shadow_probe", [
      { apiName: "title", fieldType: "text" },
    ]);

    for (const column of SYSTEM_COLUMNS) {
      expect(checkIdentifier(column, "field").ok, `TS accepted ${column}`).toBe(false);
    }

    await asTenant(tenantA, async (c) => {
      for (const column of ["tenant_id", "id", "created_at", "deleted_at"]) {
        let refused = false;
        try {
          await c.query(`SELECT dynamic_add_field_column($1::uuid,$2,$3,'text')`, [
            tenantA,
            table,
            column,
          ]);
        } catch {
          refused = true;
        }
        expect(refused, `SQL accepted a field called ${column}`).toBe(true);
      }
    });

    // And the metadata table refuses the row as well — the check that
    // holds against a hand-written INSERT.
    const error = await expectError(() =>
      asTenant(tenantA, (c) =>
        c.query(
          `INSERT INTO dynamic_fields
             (tenant_id, object_id, api_name, label, field_type, physical_column_name)
           SELECT $1, id, 'tenant_id', 'x', 'text', 'tenant_id'
             FROM dynamic_objects WHERE physical_table_name = $2`,
          [tenantA, table],
        ),
      ),
    );
    expect(error).not.toBeNull();
  });

  it("refuses a metadata row whose physical table is not cx_ prefixed", async () => {
    // The check that survives somebody editing a row by hand. A metadata
    // row pointing at `users` would make the generic CRUD layer read and
    // write the users table under the caller's own tenant scope.
    const error = await expectError(() =>
      asTenant(tenantA, (c) =>
        c.query(
          `INSERT INTO dynamic_objects
             (tenant_id, api_name, label, plural_label, physical_table_name)
           VALUES ($1,'sneaky','S','Ss','users')`,
          [tenantA],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/dynamic_objects_physical_prefixed|check constraint/i);
  });
});

/* ================================================================== */
/* 4. GUARDS                                                           */
/* ================================================================== */

describe("guards", () => {
  it("⭐ refuses to drop a table whose live record count does not match", async () => {
    const { table } = await makeObject(tenantA, "droppable", [
      { apiName: "title", fieldType: "text" },
    ]);

    await asTenant(tenantA, async (c) => {
      await c.query(`INSERT INTO ${table} (tenant_id, title) VALUES ($1,'one'),($1,'two')`, [
        tenantA,
      ]);
    });

    // Wrong count — the caller was looking at a stale screen.
    const wrong = await expectError(() =>
      asTenant(tenantA, (c) =>
        c.query(`SELECT dynamic_drop_object_table($1::uuid,$2,$3::bigint)`, [
          tenantA,
          table,
          0,
        ]),
      ),
    );
    expect(wrong).not.toBeNull();
    expect(wrong!.message).toMatch(/holds 2 live record/i);

    // No confirmation at all.
    const none = await expectError(() =>
      asTenant(tenantA, (c) =>
        c.query(`SELECT dynamic_drop_object_table($1::uuid,$2,NULL::bigint)`, [tenantA, table]),
      ),
    );
    expect(none).not.toBeNull();

    // The table is still there, with its data.
    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(rows[0].n).toBe(2);
    });

    // And with the right count it goes.
    await asTenant(tenantA, async (c) => {
      await c.query(`SELECT dynamic_drop_object_table($1::uuid,$2,$3::bigint)`, [
        tenantA,
        table,
        2,
      ]);
    });

    await asSuperuser(async (c) => {
      const { rows } = await c.query(`SELECT to_regclass('public.' || $1) AS t`, [table]);
      expect(rows[0].t).toBeNull();
    });
  });

  it("⭐ refuses to drop a table this engine did not create", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, (c) =>
        c.query(`SELECT dynamic_drop_object_table($1::uuid,$2,0::bigint)`, [tenantA, "users"]),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/only tables created by this engine/i);

    await asSuperuser(async (c) => {
      const { rows } = await c.query(`SELECT to_regclass('public.users') AS u`);
      expect(rows[0].u).toBe("users");
    });
  });

  it("refuses a required field on a record type that already has records", async () => {
    const { table } = await makeObject(tenantA, "already_full", [
      { apiName: "title", fieldType: "text" },
    ]);

    await asTenant(tenantA, async (c) => {
      await c.query(`INSERT INTO ${table} (tenant_id, title) VALUES ($1,'x')`, [tenantA]);
    });

    const error = await expectError(() =>
      asTenant(tenantA, (c) =>
        c.query(`SELECT dynamic_add_field_column($1::uuid,$2,$3,'text',true)`, [
          tenantA,
          table,
          "mandatory",
        ]),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/required field cannot be added/i);
  });

  it("⭐ enforces the per-tenant object cap", async () => {
    // Metadata rows only — the cap is counted from them, and fifty real
    // `CREATE TABLE`s would make this test the slowest in the suite for
    // no extra assurance.
    await asTenant(tenantB, async (c) => {
      for (let i = 0; i < MAX_OBJECTS_PER_TENANT; i += 1) {
        await c.query(
          `INSERT INTO dynamic_objects
             (tenant_id, api_name, label, plural_label, physical_table_name)
           VALUES ($1, $2, $2, $2, $3)`,
          [tenantB, `filler_${i}`, `cx_filler_${i}_${randomUUID().slice(0, 8)}`],
        );
      }
    });

    const objectId = randomUUID();
    const table = `cx_over_cap_${objectId.replace(/-/g, "").slice(0, 8)}`;

    const error = await expectError(() =>
      asTenant(tenantB, async (c) => {
        await c.query(
          `INSERT INTO dynamic_objects
             (id, tenant_id, api_name, label, plural_label, physical_table_name)
           VALUES ($1,$2,'over_cap','Over','Overs',$3)`,
          [objectId, tenantB, table],
        );
        await c.query(`SELECT dynamic_create_object_table($1::uuid,$2)`, [tenantB, table]);
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/maximum of 50 record types/i);

    // ⭐ AND THE TRANSACTION UNWOUND. The metadata row inserted one
    // statement before the refusal must be gone with it — the whole point
    // of doing the DDL and the metadata together.
    await asSuperuser(async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM dynamic_objects WHERE id = $1`,
        [objectId],
      );
      expect(rows[0].n).toBe(0);
    });

    await asTenant(tenantB, (c) =>
      c.query(`DELETE FROM dynamic_objects WHERE api_name LIKE 'filler\\_%'`),
    );
  });

  it("⭐ a failed field addition unwinds the table it was being added to", async () => {
    // The atomicity claim, tested rather than asserted. DDL is
    // transactional in PostgreSQL and this whole phase rests on it: if it
    // were not, a half-created object would leave either a navigation
    // entry that errors or a table nothing can enumerate.
    const objectId = randomUUID();
    const table = `cx_atomic_${objectId.replace(/-/g, "").slice(0, 8)}`;

    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `INSERT INTO dynamic_objects
             (id, tenant_id, api_name, label, plural_label, physical_table_name)
           VALUES ($1,$2,'atomic','Atomic','Atomics',$3)`,
          [objectId, tenantA, table],
        );
        await c.query(`SELECT dynamic_create_object_table($1::uuid,$2)`, [tenantA, table]);
        // A reserved word. The table exists at this point in the
        // transaction and must not survive the refusal.
        await c.query(`SELECT dynamic_add_field_column($1::uuid,$2,'select','text')`, [
          tenantA,
          table,
        ]);
      }),
    );

    expect(error).not.toBeNull();

    await asSuperuser(async (c) => {
      const { rows } = await c.query(`SELECT to_regclass('public.' || $1) AS t`, [table]);
      expect(rows[0].t, "the table survived a rolled-back transaction").toBeNull();

      const meta = await c.query(
        `SELECT count(*)::int AS n FROM dynamic_objects WHERE id = $1`,
        [objectId],
      );
      expect(meta.rows[0].n).toBe(0);
    });
  });
});

/* ================================================================== */
/* 5. THE HAPPY PATH                                                   */
/* ================================================================== */

describe("the happy path — normal creation and CRUD", () => {
  it("⭐ creates a realistic record type and does full CRUD on it", async () => {
    const { table } = await makeObject(tenantA, "handover", [
      { apiName: "reference", fieldType: "text", required: true, unique: true },
      { apiName: "notes", fieldType: "long_text" },
      { apiName: "agreed_value", fieldType: "currency", indexed: true },
      { apiName: "handover_on", fieldType: "date" },
      { apiName: "is_signed", fieldType: "boolean" },
      { apiName: "stage", fieldType: "select", options: ["pending", "done"] },
      { apiName: "tags", fieldType: "multi_select", options: ["urgent", "vip"] },
      { apiName: "contact_email", fieldType: "email" },
      { apiName: "linked_lead", fieldType: "relation", relationTable: "leads" },
    ]);

    /* --- The columns are real, and typed ------------------------- */
    await asSuperuser(async (c) => {
      const { rows } = await c.query(
        `SELECT column_name, data_type, udt_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name = $1`,
        [table],
      );
      const byName = new Map(
        rows.map((r: { column_name: string; data_type: string; udt_name: string }) => [
          r.column_name,
          r,
        ]),
      );

      // ⭐ Money is a real bigint column, not a JSONB key that sorts as text.
      expect(byName.get("agreed_value")!.data_type).toBe("bigint");
      expect(byName.get("handover_on")!.data_type).toBe("date");
      expect(byName.get("is_signed")!.data_type).toBe("boolean");
      expect(byName.get("tags")!.udt_name).toBe("_text");
      expect(byName.get("linked_lead")!.data_type).toBe("uuid");
    });

    /* --- CREATE --------------------------------------------------- */
    let recordId = "";
    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO ${table}
           (tenant_id, reference, notes, agreed_value, handover_on, is_signed, stage,
            tags, contact_email)
         VALUES ($1,'HO-001','First handover',450000000,'2026-06-01',false,'pending',
                 ARRAY['urgent']::text[],'buyer@example.test')
         RETURNING id`,
        [tenantA],
      );
      recordId = rows[0].id;
    });
    expect(recordId).toBeTruthy();

    /* --- READ ----------------------------------------------------- */
    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT reference, agreed_value, stage, tags, created_at, updated_at
           FROM ${table} WHERE id = $1`,
        [recordId],
      );
      expect(rows[0].reference).toBe("HO-001");
      expect(rows[0].agreed_value).toBe("450000000");
      expect(rows[0].tags).toEqual(["urgent"]);
      expect(rows[0].created_at).toBeInstanceOf(Date);
    });

    /* --- UPDATE, and `updated_at` maintained by the trigger -------- */
    await asTenant(tenantA, async (c) => {
      const before = await c.query(`SELECT updated_at FROM ${table} WHERE id = $1`, [recordId]);
      await c.query(`UPDATE ${table} SET stage = 'done' WHERE id = $1`, [recordId]);
      const after = await c.query(
        `SELECT stage, updated_at FROM ${table} WHERE id = $1`,
        [recordId],
      );
      expect(after.rows[0].stage).toBe("done");
      expect(after.rows[0].updated_at >= before.rows[0].updated_at).toBe(true);
    });

    /* --- The constraints actually constrain ----------------------- */
    const badStage = await expectError(() =>
      asTenant(tenantA, (c) =>
        c.query(`UPDATE ${table} SET stage = 'invented' WHERE id = $1`, [recordId]),
      ),
    );
    expect(badStage, "a value outside the choice list was accepted").not.toBeNull();

    const badTag = await expectError(() =>
      asTenant(tenantA, (c) =>
        c.query(`UPDATE ${table} SET tags = ARRAY['nope']::text[] WHERE id = $1`, [recordId]),
      ),
    );
    expect(badTag, "a multi-select value outside the list was accepted").not.toBeNull();

    const duplicate = await expectError(() =>
      asTenant(tenantA, (c) =>
        c.query(`INSERT INTO ${table} (tenant_id, reference) VALUES ($1,'HO-001')`, [tenantA]),
      ),
    );
    expect(duplicate, "the unique constraint did not hold").not.toBeNull();

    const missingRequired = await expectError(() =>
      asTenant(tenantA, (c) =>
        c.query(`INSERT INTO ${table} (tenant_id, notes) VALUES ($1,'no reference')`, [tenantA]),
      ),
    );
    expect(missingRequired, "a required field was allowed to be null").not.toBeNull();

    /* --- ⭐ THE RELATION IS A REAL, TENANT-SCOPED FOREIGN KEY ------ */
    //
    // ⚠️ Foreign-key checks run as the SYSTEM and ignore row-level
    // security, so a single-column key to leads(id) would ACCEPT another
    // tenant's lead. The composite (col, tenant_id) key is what refuses it.
    const foreignLead = randomUUID();
    await asSuperuser(async (c) => {
      await c.query(
        `INSERT INTO leads (id, tenant_id, reference, name, source, status)
         VALUES ($1,$2,$3,'Someone Else','website','new')`,
        [foreignLead, tenantB, `L-${foreignLead.slice(0, 8)}`],
      );
    });

    const crossTenantFk = await expectError(() =>
      asTenant(tenantA, (c) =>
        c.query(`UPDATE ${table} SET linked_lead = $1 WHERE id = $2`, [foreignLead, recordId]),
      ),
    );
    expect(
      crossTenantFk,
      "a relation accepted another workspace's record — the FK is not composite",
    ).not.toBeNull();

    const ownLead = randomUUID();
    await asSuperuser(async (c) => {
      await c.query(
        `INSERT INTO leads (id, tenant_id, reference, name, source, status)
         VALUES ($1,$2,$3,'Our Buyer','website','new')`,
        [ownLead, tenantA, `L-${ownLead.slice(0, 8)}`],
      );
    });

    await asTenant(tenantA, async (c) => {
      await c.query(`UPDATE ${table} SET linked_lead = $1 WHERE id = $2`, [ownLead, recordId]);
      const { rows } = await c.query(`SELECT linked_lead FROM ${table} WHERE id = $1`, [
        recordId,
      ]);
      expect(rows[0].linked_lead).toBe(ownLead);
    });

    /* --- SOFT DELETE ---------------------------------------------- */
    await asTenant(tenantA, async (c) => {
      await c.query(`UPDATE ${table} SET deleted_at = now() WHERE id = $1`, [recordId]);
      const live = await c.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE deleted_at IS NULL`,
      );
      expect(live.rows[0].n).toBe(0);

      // ⚠️ And the unique index is partial, so the reference is free
      // again. "That reference number is taken" about a record nobody can
      // see is unanswerable support.
      await c.query(`INSERT INTO ${table} (tenant_id, reference) VALUES ($1,'HO-001')`, [
        tenantA,
      ]);
    });

    await asSuperuser(async (c) => {
      await c.query(`DELETE FROM leads WHERE id = ANY($1::uuid[])`, [[ownLead, foreignLead]]);
    });
  });

  it("the change log records writes to a runtime table", async () => {
    // A table created at 3pm on a Tuesday must be covered by the change
    // feed immediately. `0017_change_log.sql` only discovers tables when
    // it is re-run, so the factory attaches the trigger itself.
    const { table } = await makeObject(tenantA, "logged_thing", [
      { apiName: "title", fieldType: "text" },
    ]);

    await asTenant(tenantA, async (c) => {
      await c.query(`INSERT INTO ${table} (tenant_id, title) VALUES ($1,'logged')`, [tenantA]);
    });

    await asSuperuser(async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM change_log
          WHERE tenant_id = $1 AND table_name = $2 AND operation = 'insert'`,
        [tenantA, table],
      );
      expect(rows[0].n).toBe(1);
    });
  });

  it("two workspaces can define the same record type without colliding", async () => {
    // The expected case, not an edge case. Without the uuid discriminator
    // the second CREATE TABLE would fail with "relation already exists",
    // telling one customer about the existence of another.
    const a = await makeObject(tenantA, "property", [{ apiName: "title", fieldType: "text" }]);
    const b = await makeObject(tenantB, "property", [{ apiName: "title", fieldType: "text" }]);

    expect(a.table).not.toBe(b.table);

    await asTenant(tenantA, (c) =>
      c.query(`INSERT INTO ${a.table} (tenant_id, title) VALUES ($1,'A''s flat')`, [tenantA]),
    );
    await asTenant(tenantB, (c) =>
      c.query(`INSERT INTO ${b.table} (tenant_id, title) VALUES ($1,'B''s flat')`, [tenantB]),
    );

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(`SELECT title FROM ${a.table}`);
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe("A's flat");
    });
  });
});

/* ================================================================== */
/* 6. THE PURE LAYER — no database at all                              */
/* ================================================================== */

describe("identifiers (pure)", () => {
  it("accepts the names people actually type", () => {
    for (const name of ["site_visit", "unit", "a", "x1", "handover_date_2"]) {
      expect(assertIdentifier(name, "field")).toBe(name);
    }
  });

  it("⚠️ never repairs its input — a capital is a refusal, not a lower-casing", () => {
    // The Unicode case-folding trap: "İ".toLowerCase() is TWO code points,
    // and `toLocaleLowerCase` depends on the server's locale, so a
    // fold-then-validate pipeline can accept on one machine and refuse on
    // another. What the customer typed is what gets checked.
    const result = checkIdentifier("SiteVisit", "field");
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/capitals are refused rather than corrected/);
  });

  it("measures length in BYTES, not characters", () => {
    expect(identifierByteLength("café")).toBe(5);
    expect(identifierByteLength("cafe")).toBe(4);
  });

  it("explains a homoglyph as a homoglyph, not as a shape problem", () => {
    // Telling somebody to "use lowercase letters" about a character that
    // already looks like a lowercase letter is a support ticket.
    const result = checkIdentifier("usеrs", "field");
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("non_ascii");
  });

  it("throws IdentifierError, so callers can catch one family", () => {
    expect(() => assertIdentifier("select", "field")).toThrow(IdentifierError);
  });

  it("⭐ derives a physical name that is prefixed, bounded and stable", () => {
    const id = "1a2b3c4d-0000-4000-8000-000000000000";
    const name = physicalTableName("site_visit", id);

    expect(name).toBe("cx_site_visit_1a2b3c4d");
    expect(identifierByteLength(name)).toBeLessThanOrEqual(63);

    // ⭐ STABLE. The same object id always yields the same table, which is
    // what makes a rename a metadata edit rather than an ALTER TABLE.
    expect(physicalTableName("site_visit", id)).toBe(name);

    // Longest legal api name still fits, with room for index names.
    const longest = physicalTableName("a".repeat(40), id);
    expect(identifierByteLength(longest)).toBeLessThanOrEqual(52);
  });

  it("⭐ refuses a stored table name that is not ours — second-order injection", () => {
    // The metadata row was validated when it was written. This is the
    // check for the day it was not: a restore, a support fix, a bug.
    expect(() => assertPhysicalTableName("users")).toThrow(IdentifierError);
    expect(() => assertPhysicalTableName(`cx_x"; DROP TABLE users; --`)).toThrow(
      IdentifierError,
    );
    expect(assertPhysicalTableName("cx_ok_1a2b3c4d")).toBe("cx_ok_1a2b3c4d");
  });

  it("⭐ suggests a name from a label — and the suggestion is NOT a gate", () => {
    expect(suggestApiName("Site Visit", "object")).toBe("site_visit");
    expect(suggestApiName("Société Générale", "object")).toBe("societe_generale");

    // ══════════════════════════════════════════════════════════════
    // ⚠️ THE MOST IMPORTANT ASSERTION IN THIS DESCRIBE BLOCK.
    //
    // Feed the sanitiser an injection and it returns something PERFECTLY
    // VALID: `drop_table_users`. That is exactly the failure this file's
    // header warns about — a sanitiser used as a gate would have created
    // a table nobody asked for, with a name that reads like an attack, and
    // reported success.
    //
    // So the test asserts both halves:
    //   • the suggestion is clean (it is meant to be shown to a person);
    //   • and the RAW input is still refused by the gate, which is the
    //     only thing that decides whether anything gets created.
    // ══════════════════════════════════════════════════════════════
    const hostile = `"; DROP TABLE users; --`;
    const suggested = suggestApiName(hostile, "object");

    expect(suggested).toBe("drop_table_users");
    expect(suggested).not.toBe(hostile);
    expect(checkIdentifier(hostile, "object").ok).toBe(false);
    expect(() => assertIdentifier(hostile, "object")).toThrow(IdentifierError);

    // And when there is nothing usable left, it returns an empty string
    // rather than inventing one.
    expect(suggestApiName("!!! ???", "object")).toBe("");
  });
});

describe("DDL planning (pure)", () => {
  const noRelations = () => null;

  it("maps every field type to a column type", () => {
    for (const type of DYNAMIC_FIELD_TYPES) {
      expect(pgTypeFor(type), type).toBeTruthy();
    }
    // ⭐ Money is bigint minor units. The one mapping whose silent change
    // costs actual money.
    expect(pgTypeFor("currency")).toBe("bigint");
    expect(pgTypeFor("number")).toBe("numeric(38,10)");
  });

  it("refuses a choice field with no choices", () => {
    expect(() =>
      planField({ apiName: "stage", fieldType: "select", options: [] }, noRelations),
    ).toThrow(DdlPlanError);
  });

  it("refuses a unique index on unbounded text", () => {
    expect(() =>
      planField({ apiName: "notes", fieldType: "long_text", isUnique: true }, noRelations),
    ).toThrow(/cannot be unique/);
  });

  it("⭐ picks RESTRICT for a required relation and SET NULL for an optional one", () => {
    const optional = planField(
      { apiName: "lead", fieldType: "relation", relation: { kind: "core", table: "leads" } },
      noRelations,
    );
    expect(optional.onDelete).toBe("set_null");

    const required = planField(
      {
        apiName: "lead",
        fieldType: "relation",
        isRequired: true,
        relation: { kind: "core", table: "leads" },
      },
      noRelations,
    );
    // A NOT NULL column cannot be set to null by a cascade, so the delete
    // is refused instead — with a message about the records that depend
    // on it rather than a constraint violation.
    expect(required.onDelete).toBe("restrict");
  });

  it("⭐ refuses a relation to a table outside the allowlist", () => {
    expect(() =>
      planField(
        {
          apiName: "evidence",
          fieldType: "relation",
          relation: { kind: "core", table: "audit_logs" } as never,
        },
        noRelations,
      ),
    ).toThrow(/cannot link to/);
  });

  it("refuses duplicate field names within one object", () => {
    expect(() =>
      planFields(
        [
          { apiName: "title", fieldType: "text" },
          { apiName: "title", fieldType: "number" },
        ],
        noRelations,
      ),
    ).toThrow(/already has a field/);
  });

  it("counts existing fields against the cap", () => {
    const existing = Array.from({ length: 100 }, (_, i) => ({
      apiName: `f${i}`,
      isIndexed: false,
    }));
    expect(() =>
      planFields([{ apiName: "one_more", fieldType: "text" }], noRelations, existing),
    ).toThrow(/at most 100 fields/);
  });

  it("plans an object without ever building SQL", () => {
    const plan = planObject({
      apiName: "site_visit",
      objectId: "1a2b3c4d-0000-4000-8000-000000000000",
    });
    expect(plan.tableName.startsWith("cx_")).toBe(true);
  });
});

describe("record values (pure)", () => {
  const fields = [
    { apiName: "title", label: "Title", fieldType: "text" as const, isRequired: true, options: [] },
    {
      apiName: "price",
      label: "Price",
      fieldType: "currency" as const,
      isRequired: false,
      options: [],
    },
    {
      apiName: "stage",
      label: "Stage",
      fieldType: "select" as const,
      isRequired: false,
      options: [
        { value: "pending", label: "Pending" },
        { value: "done", label: "Done" },
      ],
    },
  ];

  it("⭐ money is paise, and a decimal is refused rather than rounded", () => {
    expect(parseMinorUnits(125050, "Price")).toBe(125050n);
    expect(parseMinorUnits("125050", "Price")).toBe(125050n);
    // ⚠️ 1250.50 almost certainly means "₹1250.50 in the wrong unit", and
    // the two readings differ by a factor of a hundred. Rounding picks one
    // silently; refusing makes the caller say which they meant.
    expect(() => parseMinorUnits(1250.5, "Price")).toThrow(/whole number of paise/);
    // Above 2^53 a JS number has already lost the last paisa before we see it.
    expect(() => parseMinorUnits(9_007_199_254_740_993, "Price")).toThrow(/too large/);
    expect(parseMinorUnits("9007199254740993", "Price")).toBe(9007199254740993n);
  });

  it("refuses an unknown key rather than dropping it", () => {
    // Dropping it means a typo silently discards what somebody typed and
    // the form reports success — and it tells a prober which keys are
    // filtered.
    const result = validateRecordValues(fields, { title: "x", emial: "y" }, "create");
    expect(result.ok).toBe(false);
    expect((result as { fieldErrors: Record<string, string[]> }).fieldErrors.emial).toBeTruthy();
  });

  it("reports every bad value at once, not the first", () => {
    const result = validateRecordValues(
      fields, { title: "", price: "not money", stage: "invented" }, "create",
    );
    expect(result.ok).toBe(false);
    const errors = (result as { fieldErrors: Record<string, string[]> }).fieldErrors;
    expect(Object.keys(errors).sort()).toEqual(["price", "stage", "title"]);
  });

  it("update mode is a PATCH — an absent required field is fine", () => {
    const result = validateRecordValues(fields, { price: "1" }, "update");
    expect(result.ok).toBe(true);
  });

  it("⚠️ but an EXPLICIT null on a required field is still refused", () => {
    const result = validateRecordValues(fields, { title: null }, "update");
    expect(result.ok).toBe(false);
  });

  it("refuses a javascript: link before it is ever stored", () => {
    const urlField = [
      { apiName: "link", label: "Link", fieldType: "url" as const, isRequired: false, options: [] },
    ];
    // Stored XSS is refused where it is written, not in every component
    // that might one day render it.
    expect(
      validateRecordValues(urlField, { link: "javascript:alert(1)" }, "create").ok,
    ).toBe(false);
    expect(validateRecordValues(urlField, { link: "https://example.test/a" }, "create").ok).toBe(
      true,
    );
  });
});
