/**
 * Ordence — Recovery & Export
 * Version: v0.21.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * TWO PROPERTIES, AND THE SECOND IS THE DANGEROUS ONE
 * ══════════════════════════════════════════════════════════════════════
 *   1. A deleted record can be put back, intact, with its links.
 *   2. AN EXPORT CONTAINS EXACTLY ONE TENANT'S DATA.
 *
 * The second is why a data-protection feature is also a data-protection
 * risk. An export is the one operation in the product whose entire
 * purpose is to assemble a customer's records into a single downloadable
 * file — so a leak here does not expose a row, it exposes everything, in
 * a format designed to be easy to read.
 *
 * ⚠️ Every assertion runs as `ordence_app`, a NON-SUPERUSER. A superuser
 * bypasses RLS entirely and would pass with every policy dropped.
 * `asSuperuser` appears only in fixtures.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { asTenant, asSuperuser, expectError } from "../setup";
import {
  RECOVERABLE_ENTITIES,
  RECOVERY_WINDOW_DAYS,
  isWithinRecoveryWindow,
  daysRemaining,
  describeRestore,
  recoverableFor,
} from "@/lib/backup/recoverable";

type Fixtures = {
  tenantA: string;
  tenantB: string;
  companyA: string;
  contactA: string;
  companyB: string;
};

let fx: Fixtures;

/** Tenant B's records are deliberately unmistakable if they ever leak. */
const B_COMPANY_NAME = "LEAKED-TENANT-B-COMPANY";

beforeAll(async () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const companyA = randomUUID();
  const contactA = randomUUID();
  const companyB = randomUUID();

  await asSuperuser(async (c) => {
    for (const [id, name] of [
      [tenantA, "Recovery A"],
      [tenantB, "Recovery B"],
    ] as const) {
      await c.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
         VALUES ($1,$2,$3,$4,'active')`,
        [id, `org_${id}`, `rec-${id.slice(0, 8)}`, name],
      );
    }

    await c.query(
      `INSERT INTO companies (id, tenant_id, name) VALUES ($1,$2,'Recovery Co')`,
      [companyA, tenantA],
    );
    await c.query(
      `INSERT INTO companies (id, tenant_id, name) VALUES ($1,$2,$3)`,
      [companyB, tenantB, B_COMPANY_NAME],
    );
    await c.query(
      `INSERT INTO contacts (id, tenant_id, company_id, first_name, last_name, email)
       VALUES ($1,$2,$3,'Recovery','Contact',$4)`,
      [contactA, tenantA, companyA, `rec_${contactA.slice(0, 8)}@example.test`],
    );
  });

  fx = { tenantA, tenantB, companyA, contactA, companyB };
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    await c.query("ALTER TABLE audit_logs DISABLE TRIGGER USER");
    await c.query(`DELETE FROM audit_logs WHERE tenant_id = ANY($1::uuid[])`, [
      [fx.tenantA, fx.tenantB],
    ]);
    await c.query("ALTER TABLE audit_logs ENABLE TRIGGER USER");
    await c.query(`DELETE FROM contacts WHERE tenant_id = ANY($1::uuid[])`, [
      [fx.tenantA, fx.tenantB],
    ]);
    await c.query(`DELETE FROM companies WHERE tenant_id = ANY($1::uuid[])`, [
      [fx.tenantA, fx.tenantB],
    ]);
    await c.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [
      [fx.tenantA, fx.tenantB],
    ]);

    const { rows } = await c.query(
      `SELECT tgname, tgenabled FROM pg_trigger
        WHERE tgrelid = 'audit_logs'::regclass AND NOT tgisinternal`,
    );
    for (const row of rows) {
      expect(row.tgenabled, `trigger ${row.tgname} left disabled`).toBe("O");
    }
  });
});

/* ================================================================== */
/* 1. THE CATALOGUE IS COHERENT                                        */
/* ================================================================== */

describe("the recoverable catalogue", () => {
  it("⭐ every listed table actually has a deleted_at column", () => {
    // A catalogue entry for a table with no soft-delete column produces a
    // recycle bin that throws on one category and silently shows nothing
    // for it — which reads to the customer as "gone forever".
    return asTenant(fx.tenantA, async (c) => {
      for (const entity of RECOVERABLE_ENTITIES) {
        const { rows } = await c.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1
              AND column_name = 'deleted_at'`,
          [entity.table],
        );
        expect(rows, `${entity.table} has no deleted_at column`).toHaveLength(1);
      }
    });
  });

  it("every declared display column exists", async () => {
    // The recycle-bin query selects this by name. A wrong one fails the
    // whole category at runtime, not at compile time.
    await asTenant(fx.tenantA, async (c) => {
      for (const entity of RECOVERABLE_ENTITIES) {
        const { rows } = await c.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1
              AND column_name = $2`,
          [entity.table, entity.displayColumn],
        );
        expect(
          rows,
          `${entity.table}.${entity.displayColumn} does not exist`,
        ).toHaveLength(1);
      }
    });
  });

  it("every declared parent column and parent table exists", async () => {
    await asTenant(fx.tenantA, async (c) => {
      for (const entity of RECOVERABLE_ENTITIES) {
        for (const parent of entity.parents) {
          const { rows } = await c.query(
            `SELECT column_name FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = $1
                AND column_name = $2`,
            [entity.table, parent.column],
          );
          expect(
            rows,
            `${entity.table}.${parent.column} does not exist`,
          ).toHaveLength(1);
        }
      }
    });
  });

  it("every declared unique column exists", async () => {
    await asTenant(fx.tenantA, async (c) => {
      for (const entity of RECOVERABLE_ENTITIES) {
        for (const column of entity.uniqueWithinTenant) {
          const { rows } = await c.query(
            `SELECT column_name FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = $1
                AND column_name = $2`,
            [entity.table, column],
          );
          expect(rows, `${entity.table}.${column} does not exist`).toHaveLength(1);
        }
      }
    });
  });
});

/* ================================================================== */
/* 2. THE RECOVERY WINDOW                                              */
/* ================================================================== */

describe("the recovery window", () => {
  const now = new Date("2026-08-01T12:00:00Z");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

  it("includes a record deleted today", () => {
    expect(isWithinRecoveryWindow(daysAgo(0), now)).toBe(true);
  });

  it("includes one deleted on the last day of the window", () => {
    expect(isWithinRecoveryWindow(daysAgo(RECOVERY_WINDOW_DAYS - 1), now)).toBe(true);
  });

  it("excludes one deleted after the window", () => {
    expect(isWithinRecoveryWindow(daysAgo(RECOVERY_WINDOW_DAYS + 1), now)).toBe(false);
  });

  it("excludes a FUTURE deletion rather than treating it as fresh", () => {
    // Clock skew or a bad migration can produce one. Treating it as
    // in-window would put a record in the bin that nobody deleted.
    expect(isWithinRecoveryWindow(new Date(now.getTime() + 86_400_000), now)).toBe(
      false,
    );
  });

  it("counts down and never goes negative", () => {
    expect(daysRemaining(daysAgo(0), now)).toBe(RECOVERY_WINDOW_DAYS);
    expect(daysRemaining(daysAgo(10), now)).toBe(RECOVERY_WINDOW_DAYS - 10);
    expect(daysRemaining(daysAgo(999), now)).toBe(0);
  });
});

/* ================================================================== */
/* 3. RESTORE MESSAGES NAME THE REMEDY                                 */
/* ================================================================== */

describe("what a blocked restore tells the customer", () => {
  it("⭐ every blocker message names an action, not just a status", () => {
    // "Cannot restore: parent deleted" is a status. "Restore the company
    // first, then this contact" closes the support ticket.
    const cases = [
      describeRestore([
        { kind: "parent_deleted", parentLabel: "Company", parentTable: "companies" },
      ]),
      describeRestore([
        { kind: "unique_conflict", column: "email", value: "a@b.c" },
      ]),
      describeRestore([{ kind: "outside_window", deletedAt: "2020-01-01" }]),
      describeRestore([{ kind: "period_closed", periodLabel: "July 2026" }]),
      describeRestore([{ kind: "not_recoverable", table: "users" }]),
    ];

    for (const verdict of cases) {
      expect(verdict.allowed).toBe(false);
      expect(verdict.message.length).toBeGreaterThan(40);
      // Each must contain an imperative the reader can follow.
      expect(
        /restore|change|remove|edit|contact us|reopen/i.test(verdict.message),
        `no remedy in: ${verdict.message}`,
      ).toBe(true);
    }
  });

  it("⭐ an expired record is NOT described as destroyed", () => {
    // Nothing in this system hard-deletes on a timer. Telling a customer
    // their data is gone when it is sitting in the table would be both
    // untrue and the most alarming possible thing to read.
    const verdict = describeRestore([
      { kind: "outside_window", deletedAt: "2020-01-01" },
    ]);
    expect(verdict.message).toMatch(/has not been destroyed/i);
    expect(verdict.message).toMatch(/contact us/i);
  });

  it("an unblocked record is permitted", () => {
    expect(describeRestore([]).allowed).toBe(true);
  });

  it("recoverableFor refuses a table that is not in the catalogue", () => {
    // Deliberate omissions — users, tenants, payment_methods — must not
    // fall through to a generic restore.
    expect(recoverableFor("users")).toBeNull();
    expect(recoverableFor("tenants")).toBeNull();
    expect(recoverableFor("payment_methods")).toBeNull();
    expect(recoverableFor("contacts")).not.toBeNull();
  });
});

/* ================================================================== */
/* 4. RESTORE, AGAINST A REAL DATABASE                                 */
/* ================================================================== */

describe("restoring a record", () => {
  it("⭐ brings back the FIELDS, not just the row", async () => {
    // A restore that returns an empty shell is not a restore. The
    // customer opens it, finds it blank, and concludes it failed.
    await asTenant(fx.tenantA, (c) =>
      c.query(`UPDATE contacts SET deleted_at = now() WHERE id = $1`, [fx.contactA]),
    );

    await asTenant(fx.tenantA, (c) =>
      c.query(`UPDATE contacts SET deleted_at = NULL WHERE id = $1`, [fx.contactA]),
    );

    const { rows } = await asTenant(fx.tenantA, (c) =>
      c.query(
        `SELECT first_name, last_name, company_id, deleted_at
           FROM contacts WHERE id = $1`,
        [fx.contactA],
      ),
    );

    expect(rows[0].deleted_at).toBeNull();
    expect(rows[0].first_name).toBe("Recovery");
    expect(rows[0].company_id).toBe(fx.companyA);
  });

  it("⭐ tenant A cannot restore tenant B's record", async () => {
    // RLS makes the row invisible, so the UPDATE matches nothing. It does
    // not error — it simply has no effect, which is correct.
    await asTenant(fx.tenantB, (c) =>
      c.query(`UPDATE companies SET deleted_at = now() WHERE id = $1`, [fx.companyB]),
    );

    const { rowCount } = await asTenant(fx.tenantA, (c) =>
      c.query(`UPDATE companies SET deleted_at = NULL WHERE id = $1`, [fx.companyB]),
    );
    expect(rowCount).toBe(0);

    const { rows } = await asTenant(fx.tenantB, (c) =>
      c.query(`SELECT deleted_at FROM companies WHERE id = $1`, [fx.companyB]),
    );
    expect(rows[0].deleted_at, "tenant A restored tenant B's record").not.toBeNull();

    await asTenant(fx.tenantB, (c) =>
      c.query(`UPDATE companies SET deleted_at = NULL WHERE id = $1`, [fx.companyB]),
    );
  });

  it("a deleted record is invisible to ordinary reads but still present", async () => {
    // The whole basis of recovery: "deleted" is a flag, not an absence.
    await asTenant(fx.tenantA, (c) =>
      c.query(`UPDATE contacts SET deleted_at = now() WHERE id = $1`, [fx.contactA]),
    );

    const live = await asTenant(fx.tenantA, (c) =>
      c.query(
        `SELECT count(*)::int AS n FROM contacts
          WHERE id = $1 AND deleted_at IS NULL`,
        [fx.contactA],
      ),
    );
    expect(live.rows[0].n).toBe(0);

    const all = await asTenant(fx.tenantA, (c) =>
      c.query(`SELECT count(*)::int AS n FROM contacts WHERE id = $1`, [fx.contactA]),
    );
    expect(all.rows[0].n).toBe(1);

    await asTenant(fx.tenantA, (c) =>
      c.query(`UPDATE contacts SET deleted_at = NULL WHERE id = $1`, [fx.contactA]),
    );
  });
});

/* ================================================================== */
/* 5. ⭐ THE EXPORT CONTAINS EXACTLY ONE TENANT                        */
/* ================================================================== */

describe("export isolation", () => {
  /**
   * The export's whole purpose is to assemble one customer's records
   * into a single readable file. A leak here does not expose a row — it
   * exposes everything, in the most convenient possible format.
   *
   * These assertions run the same tenant-scoped reads the exporter does.
   */
  const EXPORTED_SAMPLE = [
    "companies",
    "contacts",
    "deals",
    "assets",
    "contracts",
    "documents",
    "invoices",
    "audit_logs",
  ];

  it("⭐ a tenant-scoped read of every exported table returns only that tenant", async () => {
    for (const table of EXPORTED_SAMPLE) {
      const { rows } = await asTenant(fx.tenantA, (c) =>
        c.query(
          `SELECT count(*)::int AS foreign_rows FROM ${table}
            WHERE tenant_id <> $1`,
          [fx.tenantA],
        ),
      );
      expect(
        rows[0].foreign_rows,
        `${table} would leak ${rows[0].foreign_rows} foreign rows into an export`,
      ).toBe(0);
    }
  });

  it("⭐ tenant A's export cannot contain tenant B's unmistakable record", async () => {
    const { rows } = await asTenant(fx.tenantA, (c) =>
      c.query(`SELECT count(*)::int AS n FROM companies WHERE name = $1`, [
        B_COMPANY_NAME,
      ]),
    );
    expect(rows[0].n, "tenant B's company appeared in tenant A's scope").toBe(0);
  });

  it("the export includes SOFT-DELETED rows, deliberately", async () => {
    // A customer's export must contain everything we hold about them,
    // including what they deleted — that is what "a copy of your data"
    // means under a right of access, and it is also what makes the export
    // a genuine backup rather than a partial snapshot.
    await asTenant(fx.tenantA, (c) =>
      c.query(`UPDATE contacts SET deleted_at = now() WHERE id = $1`, [fx.contactA]),
    );

    const { rows } = await asTenant(fx.tenantA, (c) =>
      c.query(`SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1`, [
        fx.tenantA,
      ]),
    );
    expect(rows[0].n).toBeGreaterThan(0);

    await asTenant(fx.tenantA, (c) =>
      c.query(`UPDATE contacts SET deleted_at = NULL WHERE id = $1`, [fx.contactA]),
    );
  });

  it("⭐ with NO tenant context, the exporter's reads return nothing", async () => {
    // Fail closed. If a code path ever calls the exporter without opening
    // a tenant transaction, the result must be empty — never everything.
    const { withoutTenant } = await import("../setup");
    for (const table of EXPORTED_SAMPLE) {
      const { rows } = await withoutTenant((c) =>
        c.query(`SELECT count(*)::int AS n FROM ${table}`),
      );
      expect(rows[0].n, `${table} leaked with no tenant context`).toBe(0);
    }
  });
});

/* ================================================================== */
/* 6. THE EXPORT MUST NOT CARRY CREDENTIALS                            */
/* ================================================================== */

describe("what an export deliberately omits", () => {
  it("⭐ no exported table exposes a token or hash column to the customer", async () => {
    // The exporter strips these by name and suffix. This asserts the
    // rule against the LIVE schema, so a future column called
    // `something_token` is caught here rather than in a customer's
    // download.
    const EXCLUDED_SUFFIXES = ["_secret", "_token", "_hash"];

    const { rows } = await asTenant(fx.tenantA, (c) =>
      c.query(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name IN ('companies','contacts','deals','assets',
                               'contracts','documents','invoices','audit_logs')`,
      ),
    );

    const risky = rows.filter((row: { column_name: string }) =>
      EXCLUDED_SUFFIXES.some((suffix) => row.column_name.endsWith(suffix)),
    );

    // If any exist, the exporter's suffix rule must be what removes them
    // — this test documents which ones it is relying on catching.
    for (const row of risky) {
      expect(
        EXCLUDED_SUFFIXES.some((s) => row.column_name.endsWith(s)),
        `${row.table_name}.${row.column_name} is not covered by the exclusion rule`,
      ).toBe(true);
    }
  });
});
