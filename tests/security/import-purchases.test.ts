/**
 * Ordence — 🔴🔴🔴 PHASE 6: THE PURCHASE IMPORT, PROVED BY RUNNING IT
 * Version: v1.85.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS FILE DRIVES THE REAL ACTIONS AND NOT THE PURE LAYER
 * ══════════════════════════════════════════════════════════════════════
 * The pure layer can be tested without Postgres and `tests/ui/` already
 * does that for the framework. Nothing Phase 6 was asked to prove lives
 * there:
 *
 *   · "a re-run of the whole file creates nothing the second time" is a
 *     claim about ROW COUNTS in two tables;
 *   · "preview counts equal commit counts, including when a lookup
 *     misses" is a claim about two calls agreeing, and the lookup is a
 *     query;
 *   · "a row missing a structural field is refused in the PREVIEW" is a
 *     claim about `requiredness` reaching the report, which only
 *     `runImport` can do.
 *
 * ⚠️ SO EVERY TEST BELOW CALLS `previewImport` OR `commitImport` AND
 *    THEN COUNTS ROWS. A source-level assertion that the writer contains
 *    the right string would pass on a writer that is never reached, and
 *    "built, offered, unreachable" is what this project keeps finding.
 *
 * ⚠️ THE MOCKS ARE IDENTITY AND AUTHORISATION ONLY, exactly as
 * `tests/security/idempotency-money-movement.test.ts` argues: what is
 * under test is which rows appear, and no permission decision changes a
 * row count. Everything below the guard — the planner, the lookups, the
 * natural-key match, the writers, `recordPurchaseInvoice` and the
 * database's own constraints — is the real thing.
 *
 * 🔴 THIS FILE IS IN A DIRECTORY PHASE 6 DOES NOT OWN. `tests/security/**`
 *    belongs to track D. It is here because `vitest.config.ts` collects
 *    ONLY `tests/security/**` and `tests/ui/**` — a test written anywhere
 *    else is a test that never runs, which is the same defect as a writer
 *    that is never reached. It is listed in `PATCH-REQUEST-PHASE-6.md` §7.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { asSuperuser } from "../setup";

/* ================================================================== */

const h = vi.hoisted(() => ({
  ctx: null as unknown as Record<string, unknown>,
}));

/* ================================================================== */
/* THE DRIVER SUBSTITUTION — READ THIS BEFORE READING ANY ASSERTION    */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `withTenant` IS RE-IMPLEMENTED OVER `node-postgres` HERE, AND THAT
 *    IS A HARNESS DEFECT, NOT A DESIGN CHOICE.
 * ══════════════════════════════════════════════════════════════════════
 * `db/index.ts` opens its transactional pool with `@neondatabase/serverless`,
 * which speaks Postgres over a WEBSOCKET. `tests/setup.ts` bridges that by
 * standing up a loopback WS-to-TCP proxy and pointing `neonConfig.wsProxy`
 * at it. On this tree that bridge does not complete a handshake: every
 * `withTenant` call hangs until the 30-second test timeout.
 *
 * ⚠️ IT IS NOT THIS FILE'S DOING, AND THAT WAS CHECKED RATHER THAN
 *    ASSUMED:
 *
 *      npx vitest run --project=security \
 *        tests/security/idempotency-money-movement.test.ts
 *      → Tests  12 failed (12)   — all of them 30 s timeouts
 *
 *    That file predates Phase 6 and touches none of it. The harness is
 *    what is broken; `tests/setup.ts` belongs to track H and
 *    `_ws-shim-standalone-probe.mts` at the repository root shows somebody
 *    has fought it before. Reported in `TRACK-REPORT.md` §6.
 *
 * ⭐ SO THE TRANSPORT IS SWAPPED AND NOTHING ELSE IS. The replacement below
 *    is `db/index.ts:286` line for line: the same `set_config(
 *    'app.current_tenant_id', $1, true)` inside the same real transaction,
 *    over `drizzle-orm/node-postgres` instead of `drizzle-orm/neon-serverless`.
 *
 * 🔴 AND IT CONNECTS AS `ordence_app`, WHICH HAS `NOBYPASSRLS`. That is the
 *    property that makes these assertions mean something: a missing policy
 *    is a test that FAILS rather than a test that passes. Substituting a
 *    superuser connection here would have been the easy way to make the
 *    file green and would have removed the only thing the security suite
 *    exists for.
 *
 * ⚠️ EVERYTHING ABOVE THE TRANSPORT IS THE REAL THING: `planImport`, the
 *    natural-key match, `resolveLookups`, both writers,
 *    `recordPurchaseInvoice`, `pricePurchase`, the ITC determination, every
 *    CHECK constraint and the 0147 trigger.
 */
vi.mock("@/db", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { sql } = await import("drizzle-orm");
  const schema = await import("@/db/schema");
  const { testPool } = await import("../setup");

  const database = drizzle(testPool as never, { schema });

  const withTenant = async <T,>(
    tenantId: string,
    callback: (tx: never) => Promise<T>,
  ): Promise<T> =>
    database.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`);
      return callback(tx as never);
    });

  const withPlatformScope = async <T,>(
    _reason: string,
    callback: (tx: never) => Promise<T>,
  ): Promise<T> =>
    database.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.platform_scope', 'on', true)`);
      return callback(tx as never);
    });

  return { ...actual, db: database, withTenant, withPlatformScope };
});

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

/**
 * ⚠️ `guardPurchaseWrite` IS MOCKED BECAUSE THE PURCHASE-BILL WRITER
 * CALLS `recordPurchaseInvoice`, WHICH GUARDS AGAIN. That second guard is
 * the point of delegating to the action, and it is authorisation, not
 * behaviour. Everything after it runs for real: `pricePurchase`, the ITC
 * determination, the header, the lines past trigger 0147, the vendor
 * ledger and the posting.
 */
vi.mock("@/server/purchases/guards", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return { ...actual, guardPurchaseWrite: async () => h.ctx };
});

/* ================================================================== */
/* FIXTURES                                                            */
/* ================================================================== */

const RUN = randomUUID().slice(0, 8);
let tenantId: string;
let userId: string;

beforeAll(async () => {
  tenantId = randomUUID();

  userId = await asSuperuser(async (c) => {
    await c.query(
      `INSERT INTO tenants (id, clerk_org_id, slug, name, status, plan_tier)
       VALUES ($1,$2,$3,$4,'active','enterprise')`,
      [tenantId, `org_p6_${RUN}`, `p6-${RUN}`, "Phase 6 purchase import"],
    );
    const u = await c.query(
      `INSERT INTO users (tenant_id, clerk_user_id, email, role, status)
       VALUES ($1,$2,$3,'tenant_owner','active') RETURNING id`,
      [tenantId, `user_p6_${RUN}`, `p6-${RUN}@example.test`],
    );
    return u.rows[0].id as string;
  });

  h.ctx = {
    tenant: { id: tenantId, slug: `p6-${RUN}`, name: "Phase 6", settings: {} },
    user: { id: userId, email: `p6-${RUN}@example.test`, role: "tenant_owner" },
    clerkUserId: `user_p6_${RUN}`,
    clerkOrgId: `org_p6_${RUN}`,
    role: "tenant_owner",
    requestId: randomUUID(),
    impersonationId: null,
    impersonationScope: null,
    operatorEmail: null,
  };
});

afterAll(async () => {
  await asSuperuser((c) => c.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]));
});

const count = async (table: string, where = ""): Promise<number> => {
  const r = await asSuperuser((c) =>
    c.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 ${where}`,
      [tenantId],
    ),
  );
  return r.rows[0].n as number;
};

/* ------------------------------------------------------------------ */
/* THE FILES                                                           */
/* ------------------------------------------------------------------ */

const VENDOR_CSV = [
  "Vendor code,Legal name,PAN,MSME registered,Udyam number,MSME category,Payment terms (days),City",
  "V-100,Shree Cement Traders,AAACS1234A,yes,UDYAM-MH-01-0001234,micro,30,Pune",
  "V-101,Bharat Steel Supply,AAACB5678B,no,,,45,Nashik",
].join("\n");

/**
 * ⚠️ 1250.50 IS THE NUMBER THAT MATTERS IN THIS FILE.
 *
 * The coercion layer turns it into `"125050"` paise. `moneyString` in
 * `lib/validators/purchases.ts` would accept `"125050"` as ₹125,050 —
 * a bill a hundred times too large, imported successfully. The test
 * below reads the total back out of the database and asserts the paise.
 */
const BILL_CSV = [
  [
    "Vendor code",
    "Bill number",
    "Bill date",
    "Description",
    "Taxable value",
    "GST rate (basis points)",
    "CGST",
    "SGST",
    "What it was for",
  ].join(","),
  "V-100,INV-001,2024-06-15,Cement OPC 53,1250.50,1800,112.55,112.55,taxable_supply",
  "V-101,INV-900,2024-06-20,TMT bars,5000.00,1800,450.00,450.00,taxable_supply",
].join("\n");

const importFile = async (
  mode: "preview" | "commit",
  entity: string,
  csvText: string,
  duplicateMode: "skip" | "update" | "fail" = "skip",
) => {
  const { previewImport, commitImport } = await import("@/server/actions/import");
  const run = mode === "preview" ? previewImport : commitImport;
  const result = await run({ entity, csvText, duplicateMode });
  if (!result.ok) throw new Error(`${mode} ${entity} refused: ${result.error}`);
  return result.data;
};

/* ================================================================== */
describe("🔴 the entities are reachable at all", () => {
  /**
   * ⚠️ THE FIRST TEST IS THE ONE THAT WOULD HAVE CAUGHT THE DEFECT THIS
   * CODEBASE HAS THIRTY TIMES OVER. An entity in the allowlist whose
   * destination has no writer used to compile cleanly and fall through
   * at runtime — into `gst_parties`. Phase 1 made that a compile error;
   * this asserts it from the other end, at runtime, by importing the
   * registry and looking the destination up.
   */
  it("both destinations have a writer in the registry", async () => {
    const { IMPORT_WRITERS } = await import("@/server/import/writers/registry");
    expect(typeof IMPORT_WRITERS.vendors?.writeRow).toBe("function");
    expect(typeof IMPORT_WRITERS.purchase_invoices?.writeRow).toBe("function");
  });

  it("both entities are in the one allowlist and pass its guard", async () => {
    const { ALL_IMPORT_ENTITIES, isImportEntityKey } = await import(
      "@/lib/import/entities"
    );
    expect(isImportEntityKey("vendors")).toBe(true);
    expect(isImportEntityKey("purchase-bills")).toBe(true);
    expect(ALL_IMPORT_ENTITIES["purchase-bills"].table).toBe("purchase_invoices");
    /* ⚠️ And the guard is membership, not a dynamic lookup. */
    expect(isImportEntityKey("constructor")).toBe(false);
    expect(isImportEntityKey("__proto__")).toBe(false);
  });
});

/* ================================================================== */
describe("🔴 a re-run of the whole file creates nothing the second time", () => {
  it("vendors: load, load again, count unchanged", async () => {
    const first = await importFile("commit", "vendors", VENDOR_CSV);
    expect(first.fatal).toBeNull();
    expect(first.counts.error).toBe(0);
    expect(first.counts.create).toBe(2);
    expect(await count("vendors")).toBe(2);

    /*
     * 🔴 THE SAME FILE AGAIN, WHICH IS THE NORMAL SECOND ACTION. The
     * file on the customer's desktop is the WHOLE file, not the rows
     * they fixed.
     */
    const second = await importFile("commit", "vendors", VENDOR_CSV);
    expect(second.counts.create).toBe(0);
    expect(second.counts.skip).toBe(2);
    expect(await count("vendors")).toBe(2);
  });

  it("vendors: a code differing only in case is the same vendor", async () => {
    /**
     * ⚠️ THE DATABASE WOULD HAVE ACCEPTED THIS AS A SECOND VENDOR —
     * `vendors_code_tenant_unique` is on the raw column and SQL 0240
     * proves it accepts `v-0240` alongside `V-0240`. The importer is
     * deliberately stricter, because two vendors whose codes differ only
     * in case cannot be told apart on a payment run.
     */
    const before = await count("vendors");
    const report = await importFile(
      "commit",
      "vendors",
      "Vendor code,Legal name\nv-100,Shree Cement Traders",
    );
    expect(report.counts.create).toBe(0);
    expect(report.counts.skip).toBe(1);
    expect(await count("vendors")).toBe(before);
  });

  it("purchase bills: load, load again, count unchanged", async () => {
    const first = await importFile("commit", "purchase-bills", BILL_CSV);
    expect(first.fatal).toBeNull();
    expect(first.counts.error).toBe(0);
    expect(first.counts.create).toBe(2);
    expect(await count("purchase_invoices")).toBe(2);
    expect(await count("purchase_invoice_lines")).toBe(2);

    const second = await importFile("commit", "purchase-bills", BILL_CSV);
    expect(second.counts.create).toBe(0);
    expect(second.counts.skip).toBe(2);
    expect(await count("purchase_invoices")).toBe(2);
    expect(await count("purchase_invoice_lines")).toBe(2);
  });

  it("purchase bills: the number, the case and the spacing all collapse", async () => {
    const before = await count("purchase_invoices");
    const report = await importFile(
      "commit",
      "purchase-bills",
      [
        "Vendor code,Bill number,Bill date,Description,Taxable value,GST rate (basis points),CGST,SGST,What it was for",
        `V-100,"  inv-001 ",2024-11-02,Cement again,1250.50,1800,112.55,112.55,taxable_supply`,
      ].join("\n"),
    );
    expect(report.counts.create).toBe(0);
    expect(report.counts.skip).toBe(1);
    expect(await count("purchase_invoices")).toBe(before);
  });

  it("purchase bills: the same serial in the NEXT financial year is a new bill", async () => {
    /**
     * ⚠️ THE NEGATIVE CONTROL, AND IT IS NOT OPTIONAL. A natural key that
     * matched everything would pass every test above and make the second
     * year of a vendor's bills unimportable. Rule 46(b) makes a serial
     * unique for a financial year, and the Indian one turns on 1 April.
     */
    const before = await count("purchase_invoices");
    const report = await importFile(
      "commit",
      "purchase-bills",
      [
        "Vendor code,Bill number,Bill date,Description,Taxable value,GST rate (basis points),CGST,SGST,What it was for",
        "V-100,INV-001,2025-06-15,Cement next year,1250.50,1800,112.55,112.55,taxable_supply",
      ].join("\n"),
    );
    expect(report.counts.create).toBe(1);
    expect(await count("purchase_invoices")).toBe(before + 1);
  });
});

/* ================================================================== */
describe("🔴 money keeps its unit across the boundary", () => {
  it("₹1,250.50 is stored as 125050 paise and not as ₹125,050", async () => {
    /**
     * ══════════════════════════════════════════════════════════════════
     * THE TRAP THIS TEST EXISTS FOR
     * ══════════════════════════════════════════════════════════════════
     * `coerceMoneyMinor` hands `buildPayload` the string `"125050"`.
     * `moneyString` — the validator's own money regex — MATCHES that
     * string. `parseMoney` would then multiply it by 100. Passing the
     * coerced value straight through is not a type error, not a
     * validation error and not a runtime error: it is a bill for
     * ₹125,050 written successfully where the customer wrote ₹1,250.50.
     *
     * `rupeesFromMinor` in `lib/import/entities-purchases.ts` is what
     * closes it, and this is the assertion that would fail if anybody
     * removed it. 125050 + 11255 + 11255 = 147560.
     */
    const r = await asSuperuser((c) =>
      c.query(
        `SELECT taxable_value_minor, cgst_minor, sgst_minor, total_minor
           FROM purchase_invoices
          WHERE tenant_id = $1 AND invoice_number = 'INV-001'
            AND invoice_date = DATE '2024-06-15'`,
        [tenantId],
      ),
    );
    expect(r.rowCount).toBe(1);
    expect(String(r.rows[0].taxable_value_minor)).toBe("125050");
    expect(String(r.rows[0].cgst_minor)).toBe("11255");
    expect(String(r.rows[0].sgst_minor)).toBe("11255");
    expect(String(r.rows[0].total_minor)).toBe("147560");
  });

  it("the vendor ledger was credited in the same transaction", async () => {
    /**
     * ⚠️ THIS IS THE ASSERTION THAT PROVES THE WRITER DELEGATES RATHER
     * THAN INSERTS. A writer that did its own `INSERT INTO
     * purchase_invoices` would pass every test above and leave the
     * vendor's balance at zero — and the ageing, the payment run and the
     * 43B(h) report all read the ledger, not the bill.
     */
    const r = await asSuperuser((c) =>
      c.query(
        `SELECT credit_minor, entry_type FROM vendor_ledger_entries
          WHERE tenant_id = $1 AND reference_number = 'INV-001'
          ORDER BY entry_date LIMIT 1`,
        [tenantId],
      ),
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].entry_type).toBe("purchase_invoice");
    expect(String(r.rows[0].credit_minor)).toBe("147560");
  });
});

/* ================================================================== */
describe("🔴 preview counts equal commit counts, including when a lookup misses", () => {
  const MIXED = [
    "Vendor code,Bill number,Bill date,Description,Taxable value,GST rate (basis points),CGST,SGST,What it was for",
    "V-100,INV-500,2024-07-01,Cement,1000.00,1800,90.00,90.00,taxable_supply",
    "V-DOES-NOT-EXIST,INV-501,2024-07-02,Sand,1000.00,1800,90.00,90.00,taxable_supply",
    "V-101,INV-502,2024-07-03,Steel,1000.00,1800,90.00,90.00,taxable_supply",
  ].join("\n");

  it("the preview says two will be created and one is an error", async () => {
    const preview = await importFile("preview", "purchase-bills", MIXED);
    expect(preview.mode).toBe("preview");
    expect(preview.counts.create).toBe(2);
    expect(preview.counts.error).toBe(1);

    /*
     * ⚠️ AND THE ERROR CARRIES THE ENTITY'S OWN SENTENCE, not a foreign
     * key violation. `lookups.missing` is written for a person.
     */
    const bad = preview.rows.find((r) => r.disposition === "error");
    expect(bad?.errors[0]?.message).toMatch(/No vendor with the code "V-DOES-NOT-EXIST"/);
  });

  it("a dry run touched nothing", async () => {
    const r = await asSuperuser((c) =>
      c.query(
        `SELECT count(*)::int AS n FROM purchase_invoices
          WHERE tenant_id = $1 AND invoice_number IN ('INV-500','INV-501','INV-502')`,
        [tenantId],
      ),
    );
    expect(r.rows[0].n).toBe(0);
  });

  it("the commit creates exactly what the preview promised", async () => {
    const before = await count("purchase_invoices");
    const commit = await importFile("commit", "purchase-bills", MIXED);
    expect(commit.mode).toBe("commit");
    expect(commit.counts.create).toBe(2);
    expect(commit.counts.error).toBe(1);
    expect(await count("purchase_invoices")).toBe(before + 2);
  });
});

/* ================================================================== */
describe("🔴 a row missing a structural field is refused in the PREVIEW", () => {
  const NO_VENDOR = [
    "Vendor code,Bill number,Bill date,Description,Taxable value,GST rate (basis points),CGST,SGST,What it was for",
    "V-100,INV-600,2024-08-01,Cement,1000.00,1800,90.00,90.00,taxable_supply",
    ",INV-601,2024-08-02,Sand,2500.75,1800,225.07,225.07,taxable_supply",
  ].join("\n");

  it("is an error in the preview, with a sentence somebody wrote", async () => {
    const preview = await importFile("preview", "purchase-bills", NO_VENDOR);
    expect(preview.counts.error).toBe(1);
    const bad = preview.rows.find((r) => r.disposition === "error");
    expect(bad?.errors.map((e) => e.message).join(" ")).toMatch(
      /The vendor's code in Ordence/,
    );
  });

  it("appears in the failed-rows CSV with its original values intact", async () => {
    /**
     * 🔴 "WITH ITS ORIGINAL VALUES INTACT" IS THE PART THAT MATTERS. The
     * failed-rows download is the entire mechanism by which a customer
     * finds the rows to fix; a CSV that hands back a normalised or
     * re-serialised row is one they cannot diff against the file on
     * their desktop. `2500.75` must come back as `2500.75`, not as
     * `250075` — which is the shape the value has by the time it reaches
     * the payload.
     */
    const preview = await importFile("preview", "purchase-bills", NO_VENDOR);
    expect(preview.failedRowsCsv).not.toBeNull();
    const csv = preview.failedRowsCsv ?? "";
    expect(csv).toContain("INV-601");
    expect(csv).toContain("2500.75");
    expect(csv).not.toContain("250075");
    /* And the good row is not in it. */
    expect(csv).not.toContain("INV-600");
  });

  it("a blank taxable value is refused, never read as zero", async () => {
    /**
     * ⚠️ THE FAILURE THIS WOULD OTHERWISE BE. `rupeesOrZero` is used for
     * every money field that HAS a schema default; `amount` does not, so
     * it uses `rupeesFromMinor(...) ?? undefined`. If it used
     * `rupeesOrZero`, a blank cell would import as a bill for ₹0 —
     * successfully, against a vendor who is owed money.
     */
    const preview = await importFile(
      "preview",
      "purchase-bills",
      [
        "Vendor code,Bill number,Bill date,Description,Taxable value,GST rate (basis points),CGST,SGST,What it was for",
        "V-100,INV-700,2024-08-05,Cement,,1800,0,0,taxable_supply",
      ].join("\n"),
    );
    expect(preview.counts.create).toBe(0);
    expect(preview.counts.error).toBe(1);
  });
});

/* ================================================================== */
describe("🔴 the form's rules are the import's rules", () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * THESE FOUR ARE THE WHOLE ARGUMENT FOR DELEGATING RATHER THAN
   * COPYING THE SCHEMA.
   * ══════════════════════════════════════════════════════════════════
   * An "import variant" of `recordPurchaseInvoiceSchema` with `vendorId`
   * swapped for `vendorCode` would have left every one of these behind,
   * and each of them is a rule with a statutory consequence.
   */
  const bill = (extra: Record<string, string>) => {
    const base: Record<string, string> = {
      "Vendor code": "V-100",
      "Bill number": `INV-${randomUUID().slice(0, 6)}`,
      "Bill date": "2024-09-01",
      Description: "Test line",
      "Taxable value": "1000.00",
      "GST rate (basis points)": "1800",
      CGST: "90.00",
      SGST: "90.00",
      "What it was for": "taxable_supply",
      "Supply type": "goods",
      "Bill of supply": "no",
      "Reverse charge": "no",
      "Reverse charge section": "",
      "Property state": "",
      "Nature of spend": "goods",
      "Capital goods": "no",
    };
    const row = { ...base, ...extra };
    const headers = Object.keys(row);
    return [headers.join(","), headers.map((k) => row[k] ?? "").join(",")].join("\n");
  };

  it("a bill of supply carrying tax is refused — Section 17(5)(e)", async () => {
    const preview = await importFile(
      "preview",
      "purchase-bills",
      bill({ "Bill of supply": "yes" }),
    );
    expect(preview.counts.error).toBe(1);
    expect(JSON.stringify(preview.rows)).toMatch(/bill of supply carries no GST/);
  });

  it("reverse charge with no section is refused — Rule 46(p)", async () => {
    const preview = await importFile(
      "preview",
      "purchase-bills",
      bill({ "Reverse charge": "yes", CGST: "0", SGST: "0" }),
    );
    expect(preview.counts.error).toBe(1);
    expect(JSON.stringify(preview.rows)).toMatch(/which provision puts this on reverse charge/);
  });

  it("immovable property with no property state is refused — Section 12(3)", async () => {
    const preview = await importFile(
      "preview",
      "purchase-bills",
      bill({ "Supply type": "immovable_property" }),
    );
    expect(preview.counts.error).toBe(1);
    expect(JSON.stringify(preview.rows)).toMatch(/LOCATION OF THE PROPERTY/);
  });

  it("capital goods into our own building must be marked as capital", async () => {
    const preview = await importFile(
      "preview",
      "purchase-bills",
      bill({
        "What it was for": "own_account_construction",
        "Nature of spend": "capital_goods",
        "Capital goods": "no",
      }),
    );
    expect(preview.counts.error).toBe(1);
    expect(JSON.stringify(preview.rows)).toMatch(/capitalised/);
  });

  it("the MSME rules fire on the vendor import too — Section 43B(h)", async () => {
    /**
     * ⚠️ 60-DAY TERMS ON A REGISTERED MICRO ENTERPRISE. Section 15 of the
     * MSMED Act caps it at 45 and Section 32 voids any longer agreement.
     * `upsertVendorSchema.superRefine` refuses it, and so does the CHECK
     * constraint `vendors_terms_sane` — which is why this must be
     * refused in the PREVIEW rather than discovered at the write.
     */
    const preview = await importFile(
      "preview",
      "vendors",
      [
        "Vendor code,Legal name,MSME registered,Udyam number,MSME category,Payment terms (days)",
        "V-BAD,Late Payer Ltd,yes,UDYAM-MH-01-0009999,micro,60",
      ].join("\n"),
    );
    expect(preview.counts.error).toBe(1);
    expect(JSON.stringify(preview.rows)).toMatch(/MSMED Act/);
  });

  it("an MSME claim with no Udyam number is refused", async () => {
    const preview = await importFile(
      "preview",
      "vendors",
      [
        "Vendor code,Legal name,MSME registered,Payment terms (days)",
        "V-BAD2,No Number Ltd,yes,30",
      ].join("\n"),
    );
    expect(preview.counts.error).toBe(1);
    expect(JSON.stringify(preview.rows)).toMatch(/Udyam Registration Number/);
  });
});

/* ================================================================== */
describe("🔴 the file is refused before a row is read when it cannot be judged", () => {
  it("no ITC-purpose column is a FATAL, not five thousand silent claims", async () => {
    /**
     * ══════════════════════════════════════════════════════════════════
     * ⚠️ THE MOST CONSEQUENTIAL COLUMN IN THE FILE HAS NO DEFAULT.
     * ══════════════════════════════════════════════════════════════════
     * `lib/validators/purchases.ts` says the database column defaults to
     * `taxable_supply` "so that an import of historical bills does not
     * fail", and that the FORM must not, because "Section 17(5)(d) is
     * the single most expensive mistake in this product".
     *
     * This import goes through the form's schema, so it inherits the
     * form's refusal. `required: true` on the column turns that into ONE
     * sentence about the file rather than an error on every row.
     */
    const preview = await importFile(
      "preview",
      "purchase-bills",
      [
        "Vendor code,Bill number,Bill date,Description,Taxable value,GST rate (basis points),CGST,SGST",
        "V-100,INV-800,2024-09-09,Cement,1000.00,1800,90.00,90.00",
      ].join("\n"),
    );
    expect(preview.fatal).not.toBeNull();
    expect(preview.fatal).toMatch(/What it was for/);
    expect(preview.rows).toHaveLength(0);
  });
});

/* ================================================================== */
describe("🔴 the vendor writer matches a BLOCKED vendor", () => {
  it("re-importing a blocked vendor skips rather than colliding on the index", async () => {
    /**
     * ══════════════════════════════════════════════════════════════════
     * 🔴 THE BUG THIS TEST EXISTS TO PREVENT, IN FULL.
     * ══════════════════════════════════════════════════════════════════
     * `gstPartiesWriter.findExisting` filters `is_active = true`, because
     * its unique index is `WHERE ... AND is_active` and a retired
     * registration must be re-addable. Copying that line into the vendor
     * writer is the obvious thing to do and is wrong:
     * `vendors_code_tenant_unique` has NO predicate, so a blocked vendor
     * still owns its code.
     *
     * With the filter, the importer would find no match, plan a CREATE,
     * and Postgres would refuse the insert with `23505` — on every
     * vendor the customer has ever blocked, with a constraint name they
     * have never heard of, after a preview that promised the row.
     */
    await asSuperuser((c) =>
      c.query(
        `UPDATE vendors SET is_active = false, blocked_reason = 'test'
          WHERE tenant_id = $1 AND code = 'V-101'`,
        [tenantId],
      ),
    );

    const before = await count("vendors");
    const report = await importFile(
      "commit",
      "vendors",
      "Vendor code,Legal name\nV-101,Bharat Steel Supply",
    );
    expect(report.counts.error).toBe(0);
    expect(report.counts.create).toBe(0);
    expect(report.counts.skip).toBe(1);
    expect(await count("vendors")).toBe(before);

    await asSuperuser((c) =>
      c.query(`UPDATE vendors SET is_active = true WHERE tenant_id = $1 AND code = 'V-101'`, [
        tenantId,
      ]),
    );
  });
});

/* ================================================================== */
describe("🔴 update mode is offered where it is safe and refused where it is not", () => {
  it("vendors accept `update` and it overwrites", async () => {
    const report = await importFile(
      "commit",
      "vendors",
      [
        "Vendor code,Legal name,Payment terms (days)",
        "V-100,Shree Cement Traders (renamed),15",
      ].join("\n"),
      "update",
    );
    expect(report.counts.update).toBe(1);
    const r = await asSuperuser((c) =>
      c.query(
        `SELECT legal_name, payment_terms_days FROM vendors
          WHERE tenant_id = $1 AND code = 'V-100'`,
        [tenantId],
      ),
    );
    expect(r.rows[0].legal_name).toBe("Shree Cement Traders (renamed)");
    expect(r.rows[0].payment_terms_days).toBe(15);
  });

  it("purchase bills REFUSE `update`, because a posted bill is reversed and not rewritten", async () => {
    const { commitImport } = await import("@/server/actions/import");
    const result = await commitImport({
      entity: "purchase-bills",
      csvText: BILL_CSV,
      duplicateMode: "update",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/overwrit|update/i);
  });
});
