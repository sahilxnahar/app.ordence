/**
 * Ordence — Restore Drill
 * Version: v0.21.0-alpha
 *
 * Run with:  npm run drill:restore
 *
 * ══════════════════════════════════════════════════════════════════════
 * A BACKUP YOU HAVE NEVER RESTORED IS NOT A BACKUP
 * ══════════════════════════════════════════════════════════════════════
 * It is a file you believe in. The failure mode of untested backups is
 * not "the restore is slow" — it is discovering, at the worst possible
 * moment, that the file was empty for eight months, or that it restores
 * a schema the application no longer understands, or that nobody knows
 * the procedure.
 *
 * This script performs a real restore against a REAL DATABASE and
 * reports what it found. It is the difference between "we have backups"
 * and "we restored one on Tuesday".
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS SCRIPT REFUSES TO RUN AGAINST PRODUCTION
 * ══════════════════════════════════════════════════════════════════════
 * It writes and deletes rows. The same guard as the test suite applies,
 * and for the same reason: a drill that destroys the thing it is meant
 * to protect is the most expensive kind of irony available.
 */

import { config } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

/* ------------------------------------------------------------------ */
/* THE GUARD                                                           */
/* ------------------------------------------------------------------ */

const ENV_TEST_PATH = resolve(process.cwd(), ".env.test");
if (existsSync(ENV_TEST_PATH)) config({ path: ENV_TEST_PATH, override: true });

const TARGET = process.env.TEST_DATABASE_URL ?? process.env.DRILL_DATABASE_URL;

const PRODUCTION_MARKERS = [
  ".neon.tech", ".supabase.co", ".rds.amazonaws.com", ".render.com",
  ".railway.app", "prod", "production",
];
const TEST_MARKERS = ["localhost", "127.0.0.1", "test", "_test"];

function abort(reason: string, detail: string): never {
  const line = "═".repeat(66);
  console.error(`\n${line}\n  DRILL ABORTED — ${reason}\n${line}\n`);
  console.error(`${detail}\n`);
  process.exit(1);
}

if (!TARGET) {
  abort(
    "no target database",
    "Set TEST_DATABASE_URL (or DRILL_DATABASE_URL) to a THROWAWAY database.\n" +
      "This drill writes and deletes rows; it must never point at production.",
  );
}

if (PRODUCTION_MARKERS.some((m) => TARGET.includes(m))) {
  abort(
    "the target looks like PRODUCTION",
    `The connection string contains a production marker.\n\n` +
      `A restore drill against production would delete live customer data —\n` +
      `the exact outcome the drill exists to prevent.\n\n` +
      `Point it at a restored copy of a backup instead. That is also a\n` +
      `better drill: it proves the BACKUP works, not just the code.`,
  );
}

if (!TEST_MARKERS.some((m) => TARGET.includes(m))) {
  abort(
    "the target is not recognisably a test database",
    "The URL must contain one of: localhost, 127.0.0.1, test, _test.\n" +
      "Fail closed — refusing rather than guessing.",
  );
}

/* ------------------------------------------------------------------ */
/* THE DRILL                                                           */
/* ------------------------------------------------------------------ */

type Step = { name: string; ok: boolean; detail: string; ms: number };
const steps: Step[] = [];

async function step(name: string, fn: () => Promise<string>): Promise<boolean> {
  const started = Date.now();
  try {
    const detail = await fn();
    steps.push({ name, ok: true, detail, ms: Date.now() - started });
    return true;
  } catch (error) {
    steps.push({
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      ms: Date.now() - started,
    });
    return false;
  }
}

async function main(): Promise<void> {
  /**
   * ══════════════════════════════════════════════════════════════════
   * TWO CONNECTIONS, AND THE DISTINCTION IS THE WHOLE POINT
   * ══════════════════════════════════════════════════════════════════
   * `appPool`   — the APPLICATION role. Subject to RLS, exactly as the
   *               running product is. Every ASSERTION uses it.
   * `adminPool` — an owner/superuser connection. Fixtures and cleanup
   *               only, because creating a tenant is a cross-tenant
   *               write that RLS correctly refuses.
   *
   * The first version of this drill used one connection for everything
   * and failed at "create a workspace" with a row-level security
   * violation. That was RLS doing its job — a drill cannot create a
   * tenant from inside a tenant boundary — but it meant the drill
   * reported five failures that said nothing about whether a restore
   * works.
   *
   * ⚠️ If `adminPool` ever appears inside an assertion, that assertion
   * is worthless: a superuser bypasses RLS entirely and would pass with
   * every policy dropped.
   */
  const appPool = new Pool({ connectionString: TARGET, max: 4 });
  const adminPool = new Pool({
    connectionString: process.env.TEST_ADMIN_DATABASE_URL ?? TARGET,
    max: 2,
  });
  const pool = adminPool; // fixtures and cleanup
  const tenantId = randomUUID();
  const companyId = randomUUID();
  const contactId = randomUUID();

  console.log("\n  RESTORE DRILL\n  " + "─".repeat(60));
  console.log(`  Target: ${TARGET!.replace(/:[^:@]+@/, ":****@")}\n`);

  try {
    /* ---- 1. Can we even connect and read the schema? ------------ */
    await step("Connect and confirm the schema is present", async () => {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM information_schema.tables
          WHERE table_schema = 'public'`,
      );
      const n = rows[0].n as number;
      if (n < 20) {
        throw new Error(
          `only ${n} tables found — this database does not look like a full restore`,
        );
      }
      return `${n} tables present`;
    });

    /* ---- 2. Are the protections actually there? ----------------- */
    //
    // The single most valuable check in the drill. A restored database
    // that comes back WITHOUT its RLS policies looks completely healthy
    // — every page renders — and every tenant can read every other
    // tenant's data. `pg_dump` does carry policies, but a restore
    // performed by hand, or through a console's import tool, often does
    // not.
    await step("⭐ Row-Level Security survived the restore", async () => {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM pg_class c
           JOIN pg_namespace ns ON ns.oid = c.relnamespace
          WHERE ns.nspname = 'public'
            AND c.relrowsecurity AND c.relforcerowsecurity`,
      );
      const n = rows[0].n as number;
      if (n < 25) {
        throw new Error(
          `only ${n} tables have FORCED RLS. A restore that loses policies ` +
            `looks perfectly healthy and lets every tenant read every other ` +
            `tenant's data. Re-run SQL-FILES/ALL-IN-ONE-SETUP.sql before ` +
            `serving traffic.`,
        );
      }
      return `${n} tables under forced RLS`;
    });

    await step("Append-only and integrity triggers survived", async () => {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM pg_trigger
          WHERE NOT tgisinternal`,
      );
      const n = rows[0].n as number;
      if (n < 30) throw new Error(`only ${n} triggers present`);
      return `${n} triggers present`;
    });

    /* ---- 3. Write, delete, restore ------------------------------ */
    await step("Create a workspace and records", async () => {
      await pool.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
         VALUES ($1,$2,$3,'Restore Drill','active')`,
        [tenantId, `org_${tenantId}`, `drill-${tenantId.slice(0, 8)}`],
      );
      await pool.query(
        `INSERT INTO companies (id, tenant_id, name) VALUES ($1,$2,'Drill Co')`,
        [companyId, tenantId],
      );
      await pool.query(
        `INSERT INTO contacts (id, tenant_id, company_id, first_name, last_name, email)
         VALUES ($1,$2,$3,'Drill','Contact',$4)`,
        [contactId, tenantId, companyId, `drill_${contactId.slice(0, 8)}@example.test`],
      );
      return "1 workspace, 1 company, 1 contact";
    });

    await step("Soft-delete the contact", async () => {
      await pool.query(`UPDATE contacts SET deleted_at = now() WHERE id = $1`, [
        contactId,
      ]);
      const { rows } = await pool.query(
        `SELECT deleted_at FROM contacts WHERE id = $1`,
        [contactId],
      );
      if (!rows[0]?.deleted_at) throw new Error("the delete did not take");
      return "deleted_at set";
    });

    await step("⭐ Restore it, and confirm the DATA came back", async () => {
      await pool.query(
        `UPDATE contacts SET deleted_at = NULL, deleted_by = NULL WHERE id = $1`,
        [contactId],
      );
      const { rows } = await pool.query(
        `SELECT first_name, last_name, email, company_id, deleted_at
           FROM contacts WHERE id = $1`,
        [contactId],
      );
      const row = rows[0];
      if (!row) throw new Error("the record is gone entirely");
      if (row.deleted_at) throw new Error("still marked deleted");
      // A restore that returns an empty shell is not a restore. Check the
      // fields, not just the row's existence.
      if (row.first_name !== "Drill" || row.last_name !== "Contact") {
        throw new Error(
          `name came back as "${row.first_name} ${row.last_name}"`,
        );
      }
      if (row.company_id !== companyId) {
        throw new Error("the link to its company did not survive");
      }
      return "row, fields and parent link all intact";
    });

    /* ---- 4. The precondition that actually bites ---------------- */
    await step("⭐ A child cannot be restored under a deleted parent", async () => {
      await pool.query(`UPDATE companies SET deleted_at = now() WHERE id = $1`, [
        companyId,
      ]);
      await pool.query(`UPDATE contacts SET deleted_at = now() WHERE id = $1`, [
        contactId,
      ]);

      const { rows } = await pool.query(
        `SELECT c.id
           FROM contacts c
           JOIN companies co ON co.id = c.company_id
          WHERE c.id = $1 AND co.deleted_at IS NULL`,
        [contactId],
      );

      if (rows.length > 0) {
        throw new Error(
          "the parent check did not detect a deleted company — restoring " +
            "this contact would produce a record that cannot be opened",
        );
      }

      await pool.query(`UPDATE companies SET deleted_at = NULL WHERE id = $1`, [
        companyId,
      ]);
      return "correctly blocked while the company was deleted";
    });

    /* ---- 5. Tenant isolation still holds after all that ---------- */
    await step("⭐ Tenant isolation is intact after the restore", async () => {
      const other = randomUUID();
      await pool.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
         VALUES ($1,$2,$3,'Drill Other','active')`,
        [other, `org_${other}`, `drillb-${other.slice(0, 8)}`],
      );

      // ⚠️ The APPLICATION pool. This is the one assertion in the drill
      // that would be meaningless on the admin connection.
      const client = await appPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [
          other,
        ]);
        const { rows } = await client.query(
          `SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1`,
          [tenantId],
        );
        await client.query("COMMIT");

        // ⚠️ Only meaningful as a NON-superuser. Reported honestly below
        // rather than claimed as proof.
        const { rows: roleRows } = await appPool.query(
          `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
        );
        const bypasses = roleRows[0]?.rolsuper || roleRows[0]?.rolbypassrls;

        if (bypasses) {
          return (
            "SKIPPED — this drill is connected as a superuser, which bypasses " +
            "RLS entirely. Re-run as the application role to make this " +
            "assertion mean anything."
          );
        }

        if (rows[0].n !== 0) {
          throw new Error(
            `tenant B can see ${rows[0].n} of tenant A's contacts — isolation ` +
              `did NOT survive the restore`,
          );
        }
        return "another tenant sees zero rows";
      } finally {
        client.release();
        await pool.query(`DELETE FROM tenants WHERE id = $1`, [other]);
      }
    });

    /* ---- 6. Clean up ------------------------------------------- */
    await step("Clean up the drill data", async () => {
      await pool.query("ALTER TABLE audit_logs DISABLE TRIGGER USER");
      await pool.query(`DELETE FROM audit_logs WHERE tenant_id = $1`, [tenantId]);
      await pool.query("ALTER TABLE audit_logs ENABLE TRIGGER USER");
      await pool.query(`DELETE FROM contacts WHERE tenant_id = $1`, [tenantId]);
      await pool.query(`DELETE FROM companies WHERE tenant_id = $1`, [tenantId]);
      await pool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);

      // The triggers must come back, or the drill has quietly disarmed
      // the append-only guarantee for everything that follows.
      const { rows } = await pool.query(
        `SELECT tgenabled FROM pg_trigger
          WHERE tgrelid = 'audit_logs'::regclass AND NOT tgisinternal`,
      );
      for (const row of rows) {
        if (row.tgenabled !== "O") {
          throw new Error("an audit trigger was left DISABLED by the drill");
        }
      }
      return "removed; triggers re-armed";
    });
  } finally {
    await appPool.end();
    await adminPool.end();
  }

  /* ---- Report ------------------------------------------------- */
  console.log();
  for (const s of steps) {
    console.log(`  ${s.ok ? "✅" : "❌"} ${s.name}`);
    console.log(`       ${s.detail}  (${s.ms}ms)`);
  }

  const failed = steps.filter((s) => !s.ok);
  const line = "═".repeat(70);
  console.log(`\n${line}`);

  if (failed.length === 0) {
    console.log("  ✅ DRILL PASSED — a restore of this database works.");
    console.log(`     Record the date. A drill you ran six months ago is a`);
    console.log(`     drill you have not run.`);
    console.log(`${line}\n`);
    process.exit(0);
  }

  console.log(`  ❌ DRILL FAILED — ${failed.length} step(s) did not pass.`);
  console.log(`     Do NOT treat this database as recoverable until they do.`);
  console.log(`${line}\n`);
  process.exit(1);
}

main().catch((error) => {
  console.error("\n  Drill crashed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
