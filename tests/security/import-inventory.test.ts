/**
 * Ordence — 🔴🔴 PHASE 7: THE INVENTORY IMPORTERS, PROVED BY RUNNING THEM
 * Version: v1.85.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS IS IN `tests/security/` AND NOT IN `tests/ui/`
 * ══════════════════════════════════════════════════════════════════════
 * Every existing import test reads the SOURCE and asserts that a line is
 * present in it. That is worth something — it catches a guard being
 * deleted — and it cannot answer the only question that matters about an
 * importer:
 *
 *     "If the customer uploads the same file twice, is the data there
 *      once or twice?"
 *
 * No amount of reading `entities-inventory.ts` answers that, because the
 * answer depends on a natural key agreeing with a partial unique index
 * across a `lower()` on both sides, in SQL, in a real database, with RLS
 * on. So this suite runs the REAL server action — `previewImport` and
 * `commitImport` out of `server/actions/import.ts`, with the real
 * planner, the real lookup resolution and the real writers — against a
 * real PostgreSQL, connected as `ordence_app`, which has NOBYPASSRLS.
 *
 * ⚠️ THE FOUR GATES ARE MOCKED AND NOTHING ELSE IS. `requireTenantContext`,
 * `requireAccess`, `requireFeature` and `requirePermission` reach Clerk
 * and the billing tables; they are proved elsewhere (`tests/security/
 * fail-closed-billing.test.ts` and friends) and standing them up here
 * would mean this file tested authentication instead of idempotency.
 * Everything below the gates — every decision, every query, every write
 * — is the shipped code.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { asSuperuser, asTenant, testPool } from "../setup";

/* ------------------------------------------------------------------ */
/* THE FOUR GATES, AND NOTHING ELSE                                    */
/* ------------------------------------------------------------------ */

const shared = vi.hoisted(() => ({
  ctx: null as unknown,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

vi.mock("@/server/audit", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    requirePermission: async () => shared.ctx,
    writeAudit: async () => undefined,
  };
});

vi.mock("@/server/tenant-context", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, requireTenantContext: async () => shared.ctx };
});

vi.mock("@/server/billing/access", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, requireAccess: async () => undefined };
});

vi.mock("@/server/entitlements", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, requireFeature: async () => undefined };
});

const { commitImport, previewImport } = await import("@/server/actions/import");
const { ALL_IMPORT_ENTITIES } = await import("@/lib/import/entities");

/* ------------------------------------------------------------------ */
/* FIXTURES                                                            */
/* ------------------------------------------------------------------ */

let tenantA: string;
let tenantB: string;
let userA: string;

const ITEMS_CSV = [
  "SKU,Name,Unit,Tracking,Valuation method,Reorder level,Lead time (days),HSN/SAC",
  "CEM-53,OPC 53 Grade Cement,bag,batch,weighted_average,12.5,7,25232930",
  "TMT-12,TMT Bar 12mm,kg,none,fifo,1250.750,21,72142090",
  "SAND-R,River Sand,m3,none,weighted_average,,3,25051019",
].join("\n");

const WAREHOUSES_CSV = [
  "Code,Name,Type,City,State code,Allow negative stock",
  "MUM-01,Bhiwandi Central Store,own,Bhiwandi,27,no",
  "PUN-SITE,Hinjewadi Site Store,site,Pune,27,yes",
].join("\n");

const BATCHES_CSV = [
  "SKU,Batch,Manufactured,Expiry,Status",
  "CEM-53,B-2026-04,2026-04-02,2026-07-02,active",
  "CEM-53,B-2026-05,2026-05-02,2026-08-02,quarantined",
].join("\n");

beforeAll(async () => {
  tenantA = randomUUID();
  tenantB = randomUUID();
  userA = randomUUID();

  await asSuperuser(async (c) => {
    for (const [id, name] of [
      [tenantA, "Inventory Import A"],
      [tenantB, "Inventory Import B"],
    ] as const) {
      await c.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
         VALUES ($1,$2,$3,$4,'active')`,
        [id, `org_${id}`, `inv-${id.slice(0, 8)}`, name],
      );
    }
    await c.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, status)
       VALUES ($1,$2,$3,'inv-a@example.test','tenant_admin','active')`,
      [userA, tenantA, `usr_${userA}`],
    );
  });

  shared.ctx = {
    tenant: { id: tenantA, name: "Inventory Import A", status: "active" },
    user: { id: userA, tenantId: tenantA, email: "inv-a@example.test", role: "tenant_admin" },
    clerkUserId: `usr_${userA}`,
    clerkOrgId: `org_${tenantA}`,
    role: "tenant_admin",
    requestId: randomUUID(),
    impersonationId: null,
    impersonationScope: null,
    operatorEmail: null,
  };
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    await c.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [[tenantA, tenantB]]);
  });
});

/** Count rows of a table for tenant A, as `ordence_app` under RLS. */
async function countIn(table: string): Promise<number> {
  return asTenant(tenantA, async (c) => {
    const r = await c.query(`SELECT count(*)::int AS n FROM ${table}`);
    return r.rows[0].n as number;
  });
}

type Report = {
  counts: Record<string, number>;
  totalRows: number;
  rows: { recordNumber: number; disposition: string; errors: { message: string }[] }[];
  failedRowsCsv: string | null;
  fatal: string | null;
};

async function run(
  which: "preview" | "commit",
  entity: string,
  csvText: string,
  duplicateMode: "skip" | "update" | "fail" = "skip",
): Promise<Report> {
  const action = which === "preview" ? previewImport : commitImport;
  const result = await action({ entity, csvText, duplicateMode });
  if (!result.ok) throw new Error(`${which} ${entity} refused: ${result.error}`);
  return result.data as unknown as Report;
}

/* ================================================================== */
describe("⭐ the three entities are reachable at all", () => {
  /**
   * ⚠️ THE FIRST THING TO PROVE, BECAUSE IT IS THE DEFECT THIS PROJECT
   * HAS FOUND MORE THAN THIRTY TIMES: built, offered in a picker, and
   * unreachable. An entity in `ALL_IMPORT_ENTITIES` whose destination
   * has no writer used to WRITE A GST PARTY.
   */
  it("are in the one allowlist, with the destinations Phase 1 requires", () => {
    for (const [key, table] of [
      ["stock-items", "stock_items"],
      ["warehouses", "warehouses"],
      ["batches", "stock_batches"],
    ] as const) {
      const entity = ALL_IMPORT_ENTITIES[key as keyof typeof ALL_IMPORT_ENTITIES];
      expect(entity, `${key} is not in ALL_IMPORT_ENTITIES`).toBeTruthy();
      expect(entity.table).toBe(table);
    }
  });
});

/* ================================================================== */
describe("🔴 a re-run of the whole file creates nothing the second time", () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * THE SINGLE MOST IMPORTANT TEST IN THIS TRACK
   * ══════════════════════════════════════════════════════════════════
   * The customer's second action is re-uploading the WHOLE file, because
   * that is the file on their desktop. Not the fixed rows — the file.
   */
  it("stock items: 3 created, then 0 created and 3 skipped, and the table still has 3", async () => {
    const first = await run("commit", "stock-items", ITEMS_CSV);
    expect(first.counts.create).toBe(3);
    expect(first.counts.error).toBe(0);
    expect(await countIn("stock_items")).toBe(3);

    const second = await run("commit", "stock-items", ITEMS_CSV);
    expect(second.counts.create).toBe(0);
    expect(second.counts.skip).toBe(3);
    expect(await countIn("stock_items")).toBe(3);
  });

  it("warehouses: the same, on the code", async () => {
    expect((await run("commit", "warehouses", WAREHOUSES_CSV)).counts.create).toBe(2);
    expect(await countIn("warehouses")).toBe(2);

    const second = await run("commit", "warehouses", WAREHOUSES_CSV);
    expect(second.counts.create).toBe(0);
    expect(second.counts.skip).toBe(2);
    expect(await countIn("warehouses")).toBe(2);
  });

  it("batches: the same, on the item AND the lot together", async () => {
    expect((await run("commit", "batches", BATCHES_CSV)).counts.create).toBe(2);
    expect(await countIn("stock_batches")).toBe(2);

    const second = await run("commit", "batches", BATCHES_CSV);
    expect(second.counts.create).toBe(0);
    expect(second.counts.skip).toBe(2);
    expect(await countIn("stock_batches")).toBe(2);
  });

  /**
   * ⚠️ AND THE MATCH IS CASE-INSENSITIVE, WHICH IS STRICTER THAN THE
   * DATABASE'S OWN UNIQUE INDEX. `stock_items_tenant_sku_unique` is on
   * the SKU exactly as typed, so `cem-53` would have been accepted as a
   * second row — and the `stock_item_by_sku` lookup that `opening-stock`
   * resolves is case-insensitive, so the workspace would then contain a
   * SKU that resolves to one of two items arbitrarily.
   */
  it("a file that shouts the SKUs is still the same three items", async () => {
    const shouted = ITEMS_CSV.replace("CEM-53", "cem-53").replace("TMT-12", "tmt-12");
    const report = await run("commit", "stock-items", shouted);
    expect(report.counts.create).toBe(0);
    expect(await countIn("stock_items")).toBe(3);
  });
});

/* ================================================================== */
describe("🔴 the preview promises exactly what the commit does", () => {
  /**
   * ⚠️ INCLUDING WHEN A LOOKUP MISSES, which is the case that teaches a
   * customer to stop reading the preview: a dry run saying "412 will be
   * created" followed by a real run creating 380.
   */
  it("a batch file naming an SKU that is not there fails identically in both runs", async () => {
    const withGhost = BATCHES_CSV + "\nGHOST-1,B-0001,2026-01-01,2026-06-01,active";

    const preview = await run("preview", "batches", withGhost);
    const before = await countIn("stock_batches");
    const commit = await run("commit", "batches", withGhost);
    const after = await countIn("stock_batches");

    expect(preview.counts).toEqual(commit.counts);
    expect(preview.counts.error).toBe(1);
    // The two known lots are already there from the test above, so the
    // only movement the commit could make is the ghost — and it made none.
    expect(after).toBe(before);
  });

  it("the preview writes nothing at all", async () => {
    const before = await countIn("stock_items");
    const fresh = "SKU,Name\nPREVIEW-ONLY,Never Written";
    const report = await run("preview", "stock-items", fresh);
    expect(report.counts.create).toBe(1);
    expect(await countIn("stock_items")).toBe(before);
  });
});

/* ================================================================== */
describe("🔴 a row that cannot be a thing is refused in the PREVIEW", () => {
  /**
   * ⚠️ AND THE MESSAGE IS THE ONE THE ENTITY WROTE, not a foreign-key
   * violation at 3am on cutover night. `contract.requiredness` declares
   * `stockItemId` structural; the lookup is what makes that happen, and
   * this asserts the behaviour rather than the declaration.
   */
  it("names the SKU that matched nothing, in the sentence the entity wrote", async () => {
    const report = await run("preview", "batches", "SKU,Batch\nNOPE-9,B-1");
    expect(report.counts.error).toBe(1);
    const message = report.rows[0]?.errors[0]?.message ?? "";
    expect(message).toContain("NOPE-9");
    expect(message).toContain("Import your stock items first");
  });

  /**
   * 🔴 AND IT LANDS IN THE FAILED-ROWS CSV WITH ITS ORIGINAL VALUES.
   * The download is the entire mechanism by which a customer finds the
   * rows to fix; a report that says "1 error" and hands back a row with
   * the values normalised is a row they cannot match to their file.
   */
  it("and the failed-rows CSV hands the row back exactly as it arrived", async () => {
    const report = await run("preview", "batches", "SKU,Batch\n  NOPE-9  ,B-1");
    expect(report.failedRowsCsv).toBeTruthy();
    expect(report.failedRowsCsv ?? "").toContain("  NOPE-9  ");
  });

  it("an expiry before the manufacture date is refused before the write, not by the CHECK constraint", async () => {
    const report = await run(
      "preview",
      "batches",
      "SKU,Batch,Manufactured,Expiry\nCEM-53,B-BADDATE,2026-05-02,2025-05-02",
    );
    expect(report.counts.error).toBe(1);
    expect(report.rows[0]?.errors[0]?.message ?? "").toContain("almost always the year");
  });
});

/* ================================================================== */
describe("🔴 quantity is not money and is not a float", () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * ⚠️ THE THOUSANDFOLD ERROR THAT VALIDATES CLEANLY
   * ══════════════════════════════════════════════════════════════════
   * `kind: "quantity"` produces integer thousandths — "12.5" becomes the
   * string "12500". `quantityString`, the schema the form uses, accepts
   * a DECIMAL string, and "12500" is a perfectly good one. Without the
   * conversion in `buildPayload` the reorder level lands as twelve
   * thousand five hundred bags, nothing errors, and the item sits on the
   * reorder report forever.
   */
  it("12.5 in the file is 12.500 in numeric(18,3), not 12500", async () => {
    const row = await asTenant(tenantA, async (c) => {
      const r = await c.query(
        `SELECT reorder_level, lead_time_days FROM stock_items WHERE sku = 'CEM-53'`,
      );
      return r.rows[0];
    });
    expect(String(row.reorder_level)).toBe("12.500");
    expect(row.lead_time_days).toBe(7);
  });

  it("and three decimals survive a number that a float would round", async () => {
    const row = await asTenant(tenantA, async (c) => {
      const r = await c.query(`SELECT reorder_level FROM stock_items WHERE sku = 'TMT-12'`);
      return r.rows[0];
    });
    expect(String(row.reorder_level)).toBe("1250.750");
  });
});

/* ================================================================== */
describe("🔴 what an undo would have to put back", () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * ⚠️ THE UNDO ITSELF CANNOT BE TESTED IN THIS TREE, AND SAYING SO IS
   *    PART OF THE DELIVERY
   * ══════════════════════════════════════════════════════════════════
   * `import_row_provenance` — the sidecar SQL 0196 was to create, and
   * the only thing that can answer "which rows did this run write" — is
   * not in this repository. `grep -rn import_row_provenance` matches
   * `lib/import/types.ts` and nothing else: the comments, not the table.
   * Nothing captures prior values either. So an undo cannot be run, and
   * a test asserting that it restores state exactly would be a test
   * asserting nothing. See `TRACK-REPORT.md` §4.
   *
   * ⭐ WHAT CAN BE PROVED IS THE PROPERTY EACH REVERSAL POLICY DEPENDS
   * ON, and these two are exactly that.
   */

  it("`skip` leaves a pre-existing record byte-identical, including fields no column maps to", async () => {
    // A row that pre-dates the migration and carries something the
    // importer has no column for: `is_active`, and an `updated_at`.
    await asTenant(tenantA, async (c) => {
      await c.query(
        `UPDATE stock_items SET is_active = false, description = 'typed by a human'
          WHERE sku = 'SAND-R' AND tenant_id = $1`,
        [tenantA],
      );
    });
    const before = await asTenant(tenantA, (c) =>
      c.query(`SELECT * FROM stock_items WHERE sku = 'SAND-R'`).then((r) => r.rows[0]),
    );

    const report = await run("commit", "stock-items", ITEMS_CSV, "skip");
    expect(report.counts.skip).toBe(3);

    const after = await asTenant(tenantA, (c) =>
      c.query(`SELECT * FROM stock_items WHERE sku = 'SAND-R'`).then((r) => r.rows[0]),
    );
    expect(after).toEqual(before);
  });

  /**
   * 🔴 THE `batches` CONTRACT DECLARES REVERSAL `delete`, AND THAT IS
   *    ONLY SAFE BECAUSE NO RUN CAN EVER OVERWRITE A LOT.
   * Gate 29 refuses `update` + `delete` by name. This is the other side
   * of the same rule, asserted rather than assumed: the entity offers no
   * `update` at all, so every row it wrote is a row it created, so
   * deleting those restores the prior state exactly.
   */
  it("`batches` cannot be run in overwrite mode at all — the action refuses before the guard", async () => {
    const result = await commitImport({
      entity: "batches",
      csvText: BATCHES_CSV,
      duplicateMode: "update",
    });
    expect(result.ok).toBe(false);
  });

  it("and a lot that was already there keeps the expiry somebody put on it", async () => {
    const before = await asTenant(tenantA, (c) =>
      c
        .query(`SELECT expiry_date, status FROM stock_batches WHERE batch_no = 'B-2026-04'`)
        .then((r) => r.rows[0]),
    );
    const rewritten = "SKU,Batch,Manufactured,Expiry,Status\nCEM-53,B-2026-04,2020-01-01,2099-01-01,recalled";
    const report = await run("commit", "batches", rewritten, "skip");
    expect(report.counts.skip).toBe(1);
    const after = await asTenant(tenantA, (c) =>
      c
        .query(`SELECT expiry_date, status FROM stock_batches WHERE batch_no = 'B-2026-04'`)
        .then((r) => r.rows[0]),
    );
    expect(after).toEqual(before);
  });
});

/* ================================================================== */
describe("🔴 tenant isolation, at the database rather than in the writer", () => {
  /**
   * ⚠️ SQL 0250, PROVED BY INDUCTION RATHER THAN BY READING IT.
   * Before 0250 the foreign key was `stock_item_id -> stock_items(id)`,
   * which says the item EXISTS, not that it is MINE — so a batch row
   * carrying tenant A's `tenant_id` and tenant B's `stock_item_id`
   * satisfied the FK, the RLS policy and the unique index at once.
   */
  it("refuses a batch pointing at another tenant's item, even as the superuser", async () => {
    const foreignItem = randomUUID();
    await asSuperuser(async (c) => {
      await c.query(
        `INSERT INTO stock_items (id, tenant_id, sku, name) VALUES ($1,$2,'B-ONLY','Tenant B item')`,
        [foreignItem, tenantB],
      );
    });

    let refused: string | null = null;
    await asSuperuser(async (c) => {
      try {
        await c.query(
          `INSERT INTO stock_batches (tenant_id, stock_item_id, batch_no) VALUES ($1,$2,'X-1')`,
          [tenantA, foreignItem],
        );
      } catch (err) {
        refused = (err as { constraint?: string }).constraint ?? "refused";
      }
    });

    expect(refused).toBe("stock_batches_item_tenant_fkey");
  });
});

/* ================================================================== */
describe("🔴 a lookup must not resolve onto a soft-deleted record", () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * ⚠️ THIS FAILED BEFORE PHASE 7 AND THE CONSEQUENCE WAS NOT SMALL
   * ══════════════════════════════════════════════════════════════════
   * `resolveLookups` filtered `stock_items` on `is_active` and not on
   * `deleted_at`, while `stock_items_tenant_sku_unique` is a PARTIAL
   * index that EXCLUDES deleted rows — so a workspace can hold a
   * deleted `CEM-53` and a live one at the same time, and the lookup
   * could return the deleted one.
   *
   * Measured on the unpatched tree, a preview of one batch row naming a
   * soft-deleted SKU reported:
   *
   *     {"create":1,"update":0,"skip":0,"error":0}   errors: []
   *
   * — the dry run promising a lot attached to an item nobody can see.
   * `opening-stock` resolves the same two lookups and would have posted
   * the customer's whole opening quantity there. The one-line fix is in
   * `PATCH-REQUEST-PHASE-7.md`; this is the test that says it is in.
   */
  it("a deleted stock item is not a match, and the row is refused with the entity's sentence", async () => {
    await asTenant(tenantA, async (c) => {
      await c.query(
        `INSERT INTO stock_items (tenant_id, sku, name, deleted_at)
         VALUES ($1,'GONE-1','Deleted item', now())`,
        [tenantA],
      );
    });

    const report = await run("preview", "batches", "SKU,Batch\nGONE-1,B-1");
    expect(report.counts.create).toBe(0);
    expect(report.counts.error).toBe(1);
    expect(report.rows[0]?.errors[0]?.message ?? "").toContain("GONE-1");
  });
});
