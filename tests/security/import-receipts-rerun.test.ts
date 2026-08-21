/**
 * Ordence — 🔴🔴 PHASE 5 · A RE-RUN CREATES NOTHING THE SECOND TIME
 * Version: v1.85.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE SINGLE MOST IMPORTANT TEST IN THIS TRACK, AND IT NEEDS A DATABASE
 * ══════════════════════════════════════════════════════════════════════
 * `tests/ui/import-sales-entities.test.ts` proves the half of re-run
 * safety that lives in the pure layer: the natural key is stable, and
 * folding survives case and spacing. It cannot prove the other half,
 * which is that `findExisting` MATCHES that key against rows already in
 * Postgres — an expression index, a `||` composite and a `regexp_replace`
 * that has to agree, character for character, with a `.replace()` in
 * TypeScript.
 *
 * So this suite loads a file, loads THE SAME FILE AGAIN, and counts.
 *
 * ⚠️ IT CONNECTS AS `ordence_app`, WHICH HAS NOBYPASSRLS. `withTenant` is
 * re-implemented over the suite's own pool — transport swapped, nothing
 * else: the same `BEGIN`, the same
 * `set_config('app.current_tenant_id', …, true)`, the same transaction
 * scope as `db/index.ts`. The writer under test is imported unmodified.
 *
 * 🔴 WHAT IT DOES NOT PROVE, AND WHY. Undo. There is no undo:
 * `import_row_provenance` does not exist in this tree (see
 * `TRACK-REPORT.md §2`), so "delete the rows this run created" has no
 * source of truth to read. The last test here demonstrates exactly what
 * IS available today — a delete by id — and the comment says why that is
 * not the same thing.
 */

import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";

import { asSuperuser, asTenant, testPool } from "../setup";

/**
 * ⭐ WAVE 2C. The planner takes the workspace's currency as data — see
 * `ImportContext`. These files are all about entities whose amounts are
 * in rupees, so every call passes the same one; the exponent behaviour
 * itself is proven in `tests/ui/import-money-exponent.test.ts`.
 */
const IMPORT_CONTEXT = { workspaceCurrency: "INR" } as const;


/**
 * ⚠️ MOCKED BEFORE THE WRITER IS IMPORTED, because the writer imports
 * `withTenant` at module load. The replacement is `db/index.ts`'s own
 * body over `drizzle-orm/node-postgres` and the suite's pool: the tenant
 * setting is transaction-scoped (`true`), so RLS is in force for every
 * statement the writer runs.
 */
vi.mock("@/db", () => ({
  withTenant: async <T>(
    tenantId: string,
    fn: (tx: ReturnType<typeof drizzle>) => Promise<T>,
  ): Promise<T> => {
    const client = await testPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      const tx = drizzle(client);
      const result = await fn(tx as never);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  },
}));

const { customerReceiptsWriter } = await import(
  "@/server/import/writers/sales/customer-receipts"
);
const { SALES_IMPORT_ENTITIES } = await import("@/lib/import/entities-sales");
const { planImportRecords } = await import("@/lib/import");

const RUN = Math.random().toString(36).slice(2, 8);
const F = {} as { tenant: string; user: string; acme: string; beta: string };

/** The context the writer takes. Only these two fields are read. */
const ctx = () =>
  ({ tenant: { id: F.tenant }, user: { id: F.user } }) as never;

beforeAll(async () => {
  await asSuperuser(async (c) => {
    const t = await c.query(
      `INSERT INTO tenants (clerk_org_id, name, slug, status)
       VALUES ($1, 'Receipts Import Co', $2, 'active') RETURNING id`,
      [`org_rcpt_${RUN}`, `rcpt-${RUN}`],
    );
    F.tenant = t.rows[0].id;

    const u = await c.query(
      `INSERT INTO users (tenant_id, clerk_user_id, email, role, status)
       VALUES ($1, $2, $3, 'tenant_owner', 'active') RETURNING id`,
      [F.tenant, `user_rcpt_${RUN}`, `rcpt-${RUN}@test.local`],
    );
    F.user = u.rows[0].id;

    /*
     * ⚠️ THE NAME HAS DOUBLE SPACES AND MIXED CASE ON PURPOSE. The file
     * loaded below spells it differently again. If the two foldings
     * disagree by one character, `findExisting` returns nothing and the
     * second run duplicates — which is the whole failure this suite is
     * here to catch.
     */
    const a = await c.query(
      `INSERT INTO companies (tenant_id, name) VALUES ($1, $2) RETURNING id`,
      [F.tenant, "ACME   Cements  Ltd"],
    );
    F.acme = a.rows[0].id;

    const b = await c.query(
      `INSERT INTO companies (tenant_id, name) VALUES ($1, $2) RETURNING id`,
      [F.tenant, "Beta Traders"],
    );
    F.beta = b.rows[0].id;
  });
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    await c.query(`DELETE FROM tenants WHERE id = $1`, [F.tenant]);
  });
});

/**
 * The file, exactly as a customer's export would be: names, not uuids.
 * Two referenced payments and one cash payment with no reference.
 */
const FILE = [
  { recordNumber: 1, cells: ["Customer", "Received on", "Amount", "Method", "Reference"] },
  { recordNumber: 2, cells: ["Acme Cements Ltd", "2026-03-14", "1,25,000.50", "neft", "UTR9931"] },
  { recordNumber: 3, cells: ["Beta Traders", "2026-03-15", "9000", "cheque", "  chq-0042 "] },
  { recordNumber: 4, cells: ["Acme Cements Ltd", "2026-03-16", "5000", "cash", ""] },
];

const companyIdFor = (name: string) =>
  name.toLowerCase().includes("acme") ? F.acme : F.beta;

/**
 * One import run, doing what `server/actions/import.ts` does: plan, resolve
 * the lookup, ask `findExisting`, and write only what `skip` mode allows.
 *
 * ⚠️ THE LOOKUP IS RESOLVED HERE, ONCE, BEFORE ANY WRITE — the same
 * ordering the real action uses, and the reason the preview cannot promise
 * a row the commit does not land.
 */
async function runImport(): Promise<{ created: number; skipped: number }> {
  const plan = planImportRecords(SALES_IMPORT_ENTITIES.receipts, FILE, IMPORT_CONTEXT);
  expect(plan.fatal).toBeNull();
  expect(plan.rows.every((r) => r.errors.length === 0)).toBe(true);

  const keys = plan.rows.map((r) => r.naturalKey).filter((k) => k !== null);
  const existing = await customerReceiptsWriter.findExisting(ctx(), keys as never);

  let created = 0;
  let skipped = 0;
  for (const row of plan.rows) {
    const key = row.naturalKey;
    if (key && existing.has(`${key.kind}:${key.value}`)) {
      skipped += 1;
      continue;
    }
    const payload = { ...row.payload };
    for (const lookup of row.lookups ?? []) {
      payload[lookup.into] = companyIdFor(String(payload.customerName));
    }
    const written = await customerReceiptsWriter.writeRow!(ctx(), payload, null);
    expect(written).toEqual({ ok: true });
    created += 1;
  }
  return { created, skipped };
}

const countReceipts = () =>
  asTenant(F.tenant, async (c) => {
    const r = await c.query(`SELECT count(*)::int AS n FROM customer_receipts`);
    return r.rows[0].n as number;
  });

/* ================================================================== */
describe("🔴 a re-run of the whole file creates nothing the second time", () => {
  it("first run writes every row", async () => {
    expect(await countReceipts()).toBe(0);
    const first = await runImport();
    expect(first).toEqual({ created: 3, skipped: 0 });
    expect(await countReceipts()).toBe(3);
  });

  it("🔴 second run of the SAME file writes nothing, and the count does not move", async () => {
    const before = await countReceipts();
    const second = await runImport();
    expect(second).toEqual({ created: 0, skipped: 3 });
    expect(await countReceipts()).toBe(before);
  });

  it("matches through the fold — the file's spelling is not the database's", async () => {
    /*
     * The company is stored as "ACME   Cements  Ltd" and the file says
     * "Acme Cements Ltd". Both sides fold to "acme cements ltd", one in
     * TypeScript and one in `regexp_replace`. The skip above is that
     * agreement; this asserts what was actually stored, so a future reader
     * can see the two spellings were genuinely different.
     */
    const names = await asTenant(F.tenant, async (c) => {
      const r = await c.query(`SELECT name FROM companies ORDER BY name`);
      return r.rows.map((x) => x.name as string);
    });
    expect(names).toContain("ACME   Cements  Ltd");
  });

  it("the reference is matched case-insensitively and trimmed, as the key says", async () => {
    const stored = await asTenant(F.tenant, async (c) => {
      const r = await c.query(
        `SELECT instrument_ref FROM customer_receipts WHERE instrument_ref IS NOT NULL ORDER BY instrument_ref`,
      );
      return r.rows.map((x) => x.instrument_ref as string);
    });
    /* "  chq-0042 " arrived with spaces and lower case; the schema trimmed it. */
    expect(stored).toContain("chq-0042");
    expect(stored).toContain("UTR9931");
  });
});

/* ================================================================== */
describe("⭐ what the writer actually wrote", () => {
  it("money is paise, exactly, with no float anywhere near it", async () => {
    const rows = await asTenant(F.tenant, async (c) => {
      const r = await c.query(
        `SELECT amount_minor::text AS amount, tds_credit_minor::text AS tds,
                allocated_minor::text AS allocated, status::text, method::text,
                received_on::text, receipt_number
           FROM customer_receipts ORDER BY received_on`,
      );
      return r.rows;
    });

    expect(rows.map((r) => r.amount)).toEqual(["12500050", "900000", "500000"]);
    expect(rows.every((r) => r.allocated === "0")).toBe(true);
    expect(rows.every((r) => r.status === "cleared")).toBe(true);
    expect(rows.map((r) => r.method)).toEqual(["neft", "cheque", "cash"]);
    expect(rows.map((r) => r.received_on)).toEqual(["2026-03-14", "2026-03-15", "2026-03-16"]);
  });

  it("every receipt number announces that it came from an import, and none repeats", async () => {
    const numbers = await asTenant(F.tenant, async (c) => {
      const r = await c.query(`SELECT receipt_number FROM customer_receipts`);
      return r.rows.map((x) => x.receipt_number as string);
    });
    expect(numbers.every((n) => n.startsWith("IMP-RCP/"))).toBe(true);
    expect(new Set(numbers).size).toBe(numbers.length);
    /* ⚠️ AND NONE OF THEM IS IN THE `RCP/` SERIES the product hands out. */
    expect(numbers.some((n) => n.startsWith("RCP/"))).toBe(false);
  });

  /**
   * 🔴🔴 THE DOUBLE-COUNT DECISION, PROVED AGAINST THE LEDGER ITSELF.
   *
   * The single-record action posts Dr Bank / Dr TDS / Cr Sundry Debtors.
   * This writer does not, because the opening trial balance is what
   * carries both figures — see `TRACK-REPORT.md §4`. If somebody adds the
   * posting call, this test fails, which is the point of it.
   */
  it("🔴 posts NOTHING to the general ledger", async () => {
    const posted = await asTenant(F.tenant, async (c) => {
      const r = await c.query(
        `SELECT (SELECT count(*)::int FROM transactions)   AS txns,
                (SELECT count(*)::int FROM journal_entries) AS legs`,
      );
      return r.rows[0];
    });
    expect(posted.txns).toBe(0);
    expect(posted.legs).toBe(0);
  });

  it("🔴 writes no allocation rows, so nothing is settled twice", async () => {
    const allocations = await asTenant(F.tenant, async (c) => {
      const r = await c.query(`SELECT count(*)::int AS n FROM customer_receipt_allocations`);
      return r.rows[0].n as number;
    });
    expect(allocations).toBe(0);
  });

  it("refuses an `update`, because a receipt is not editable in this product", async () => {
    const id = await asTenant(F.tenant, async (c) => {
      const r = await c.query(`SELECT id FROM customer_receipts LIMIT 1`);
      return r.rows[0].id as string;
    });
    const outcome = await customerReceiptsWriter.writeRow!(
      ctx(),
      {
        companyId: F.acme,
        receivedOn: "2026-03-14",
        amountMinor: "12500050",
        method: "neft",
        instrumentRef: "UTR9931",
      },
      id,
    );
    expect(outcome.ok).toBe(false);
  });
});

/* ================================================================== */
describe("⚠️ the two indexes SQL 0230 creates, read back from the catalogue", () => {
  it("both exist and are VALID — a CONCURRENTLY build that failed leaves an unused index", async () => {
    const rows = await asSuperuser(async (c) => {
      const r = await c.query(
        `SELECT c.relname, i.indisvalid, i.indisready, i.indisunique
           FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
          WHERE c.relname LIKE 'customer_receipts_import%'
          ORDER BY c.relname`,
      );
      return r.rows;
    });
    expect(rows.map((r) => r.relname)).toEqual([
      "customer_receipts_import_ref_idx",
      "customer_receipts_import_unreferenced_idx",
    ]);
    expect(rows.every((r) => r.indisvalid && r.indisready)).toBe(true);
    /* ⚠️ AND NEITHER IS UNIQUE. Two cash payments of the same amount on the
     * same day are two receipts; a cheque number is unique within a bank
     * account, not within a workspace. A unique index here would turn a
     * real second payment into a 23505 on a counter clerk's screen. */
    expect(rows.every((r) => r.indisunique === false)).toBe(true);
  });

  it("customer_receipts is still under FORCE row level security", async () => {
    const row = await asSuperuser(async (c) => {
      const r = await c.query(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'customer_receipts'`,
      );
      return r.rows[0];
    });
    expect(row.relrowsecurity).toBe(true);
    /* 🔴 Only FORCE binds the owner, and production connects as the owner. */
    expect(row.relforcerowsecurity).toBe(true);
  });
});

/* ================================================================== */
describe("⭐ undo — what was missing when this file was written, and is not now", () => {
  /**
   * ⚠️ WHEN THIS FILE WAS WRITTEN THIS COULD NOT BE AN UNDO TEST.
   *
   * `reversal: { kind: "delete" }` means "delete the rows THIS RUN
   * created", and the only source of truth for which those are is
   * `import_row_provenance` — which did not exist in the tree Phase 5 was
   * given. The available alternative, "everything created between two
   * timestamps", would sweep up every receipt the customer's staff keyed
   * in by hand during the migration window, and a migration takes hours
   * while the office does not stop.
   *
   * ⭐ BOTH HALVES LANDED AFTERWARDS. Phase 2 wrote
   * `server/import/reversal.ts`, and SQL 0205 creates the sidecar. The
   * second test below used to assert their ABSENCE; it now asserts their
   * presence, so the narrow claim in the first test is joined to the
   * mechanism that makes `delete` an honest reversal kind.
   */
  it("a row this entity wrote deletes cleanly, leaving nothing that referenced it", async () => {
    const before = await countReceipts();
    await asTenant(F.tenant, async (c) => {
      await c.query(`DELETE FROM customer_receipts WHERE receipt_number LIKE 'IMP-RCP/%'`);
    });
    const after = await countReceipts();
    expect(before).toBe(3);
    expect(after).toBe(0);

    const leftovers = await asTenant(F.tenant, async (c) => {
      const r = await c.query(
        `SELECT (SELECT count(*)::int FROM customer_receipt_allocations) AS allocs,
                (SELECT count(*)::int FROM journal_entries)              AS legs`,
      );
      return r.rows[0];
    });
    expect(leftovers.allocs).toBe(0);
    expect(leftovers.legs).toBe(0);
  });

  /**
   * ⚠️ INVERTED AT WAVE 4 INTEGRATION, NOT DELETED. This test recorded a
   * gap; the gap was closed, so it now records the closure. Deleting it
   * would have left nothing asserting that the mechanism the entity's
   * `delete` kind depends on is actually there.
   */
  it("and the tree now HAS what identifies those rows — both halves", async () => {
    const { existsSync } = await import("node:fs");
    expect(existsSync("server/import/reversal.ts")).toBe(true);

    const present = await asSuperuser(async (c) => {
      const r = await c.query(`SELECT to_regclass('public.import_row_provenance') AS t`);
      return r.rows[0].t;
    });
    /* ⭐ The table the whole reversal design rests on, created by SQL 0205. */
    expect(present).not.toBeNull();

    /*
     * 🔴 AND IT IS THE SHAPE A REVERSAL CAN USE. A sidecar with no
     * `reversal_id` records what happened and cannot record that it was
     * undone, which is the half of the design that identifies the rows.
     */
    const columns = await asSuperuser(async (c) => {
      const r = await c.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'import_row_provenance'`,
      );
      return r.rows.map((row: { column_name: string }) => row.column_name);
    });
    expect(columns).toContain("run_id");
    expect(columns).toContain("target_id");
    expect(columns).toContain("reversed_at");
    expect(columns).toContain("reversal_id");
  });
});
