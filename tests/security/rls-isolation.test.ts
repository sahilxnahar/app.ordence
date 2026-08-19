/**
 * Ordence — Cross-Tenant Isolation Test Suite
 * Version: v0.6.0-alpha  ·  Resolves SEC-004
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS PROVES
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Five phases of the platform have claimed "tenant data cannot leak." This file
 * turns that claim into something a machine checks on every commit.
 *
 * It does NOT go through Drizzle. Every query is raw SQL against the database.
 * Testing through the ORM would partly test the ORM's own `WHERE tenant_id`
 * filtering — which is the layer we already know exists. The question here is
 * narrower and harder: **if the application forgets, does the DATABASE still
 * refuse?**
 *
 * The attack simulated throughout is the realistic one: an authenticated user of
 * Tenant B who has somehow learned a record ID belonging to Tenant A, and asks
 * for it directly. No SQL injection, no stolen credentials — just a UUID and a
 * legitimate session.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { testPool, asTenant, withoutTenant, asSuperuser } from "../setup";

/* ------------------------------------------------------------------ */
/* FIXTURES                                                            */
/* ------------------------------------------------------------------ */

type Fixtures = {
  tenantA: string;
  tenantB: string;
  userA: string;
  userB: string;
  companyA: string;
  contactA: string;
  dealA: string;
  assetA: string;
  contractA: string;
  ledgerA: string;
  auditA: string;
};

const F = {} as Fixtures;

/** Unique suffix so parallel CI runs never collide on unique constraints. */
const RUN = randomUUID().slice(0, 8);

beforeAll(async () => {
  await asSuperuser(async (c) => {
    /* ---- Two tenants -------------------------------------------- */
    const a = await c.query(
      `INSERT INTO tenants (clerk_org_id, name, slug, status)
       VALUES ($1, 'Tenant A — Ordence Developers', $2, 'active') RETURNING id`,
      [`org_test_a_${RUN}`, `tenant-a-${RUN}`],
    );
    const b = await c.query(
      `INSERT INTO tenants (clerk_org_id, name, slug, status)
       VALUES ($1, 'Tenant B — Rival Builders', $2, 'active') RETURNING id`,
      [`org_test_b_${RUN}`, `tenant-b-${RUN}`],
    );
    F.tenantA = a.rows[0].id;
    F.tenantB = b.rows[0].id;

    /* ---- One user each ------------------------------------------ */
    const ua = await c.query(
      `INSERT INTO users (tenant_id, clerk_user_id, email, role, status)
       VALUES ($1, $2, $3, 'tenant_owner', 'active') RETURNING id`,
      [F.tenantA, `user_a_${RUN}`, `owner-a-${RUN}@test.local`],
    );
    const ub = await c.query(
      `INSERT INTO users (tenant_id, clerk_user_id, email, role, status)
       VALUES ($1, $2, $3, 'tenant_owner', 'active') RETURNING id`,
      [F.tenantB, `user_b_${RUN}`, `owner-b-${RUN}@test.local`],
    );
    F.userA = ua.rows[0].id;
    F.userB = ub.rows[0].id;

    /* ---- Tenant A's confidential data --------------------------- */
    const company = await c.query(
      `INSERT INTO companies (tenant_id, name, domain, industry)
       VALUES ($1, 'Confidential Client Pvt Ltd', $2, 'Real Estate') RETURNING id`,
      [F.tenantA, `confidential-${RUN}.example`],
    );
    F.companyA = company.rows[0].id;

    const contact = await c.query(
      `INSERT INTO contacts (tenant_id, company_id, first_name, last_name, email, job_title)
       VALUES ($1, $2, 'Priya', 'Confidential', $3, 'Managing Director') RETURNING id`,
      [F.tenantA, F.companyA, `priya-${RUN}@confidential.example`],
    );
    F.contactA = contact.rows[0].id;

    const deal = await c.query(
      `INSERT INTO deals (tenant_id, contact_id, company_id, title, amount, currency, stage)
       VALUES ($1, $2, $3, 'SECRET — Penthouse booking ₹4.8 Cr', 48000000.00, 'INR', 'negotiation')
       RETURNING id`,
      [F.tenantA, F.contactA, F.companyA],
    );
    F.dealA = deal.rows[0].id;

    const asset = await c.query(
      `INSERT INTO assets
         (tenant_id, asset_type, name, code, status, value_amount, currency,
          locality, city, dynamic_attributes)
       VALUES ($1, 'unit', 'Penthouse A-1401 — Basaveshwar Nagar', $2, 'reserved',
               48000000.00, 'INR', 'Basaveshwar Nagar', 'Bengaluru', $3)
       RETURNING id`,
      [
        F.tenantA,
        `SECRET-PH-${RUN}`,
        JSON.stringify({
          confidential: true,
          negotiatedDiscountPct: 12.5,
          buyerBudgetCeiling: "52000000.00",
        }),
      ],
    );
    F.assetA = asset.rows[0].id;

    const contract = await c.query(
      `INSERT INTO contracts
         (tenant_id, asset_id, contact_id, title, contract_number, contract_type,
          status, value, currency, document_data)
       VALUES ($1, $2, $3, 'CONFIDENTIAL — Sale Agreement PH-1401', $4,
               'sale_agreement', 'counterparty_review', 48000000.00, 'INR', $5)
       RETURNING id`,
      [
        F.tenantA, F.assetA, F.contactA, `SECRET-CON-${RUN}`,
        JSON.stringify({ sections: [{ id: "s1", heading: "Price", body: "Confidential terms.", order: 0 }] }),
      ],
    );
    F.contractA = contract.rows[0].id;

    const ledger = await c.query(
      `INSERT INTO ledgers (tenant_id, name, code, type, account_type, current_balance)
       VALUES ($1, 'Trust — Client Funds', $2, 'trust', 'asset', 15000000.00) RETURNING id`,
      [F.tenantA, `TRUST-${RUN}`],
    );
    F.ledgerA = ledger.rows[0].id;

    const audit = await c.query(
      `INSERT INTO audit_logs (tenant_id, action, resource_type, resource_id, reason, severity)
       VALUES ($1, 'create', 'deal', $2, 'Confidential deal created', 'notice') RETURNING id`,
      [F.tenantA, F.dealA],
    );
    F.auditA = audit.rows[0].id;
  });
});

afterAll(async () => {
  await cleanupTenants([F.tenantA, F.tenantB]);
});

/**
 * Remove test tenants and everything they own.
 *
 * `audit_logs.tenant_id` is ON DELETE RESTRICT — deliberately, so production
 * history can never be erased by deleting a tenant. That same protection blocks
 * cleanup here, so the trigger is disabled and the audit rows removed explicitly.
 *
 * This runs on the ADMIN pool only, and only against tenants this file created.
 */
async function cleanupTenants(tenantIds: string[]): Promise<void> {
  await asSuperuser(async (c) => {
    const appendOnly = [
      "audit_logs",
      "journal_entries",
      "contract_versions",
      "permission_denials",
    ];

    for (const table of appendOnly) {
      await c.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    }

    try {
      // Order matters: children before parents.
      await c.query("DELETE FROM journal_entries WHERE tenant_id = ANY($1)", [tenantIds]);
      await c.query("DELETE FROM transactions    WHERE tenant_id = ANY($1)", [tenantIds]);
      await c.query("DELETE FROM contract_versions WHERE tenant_id = ANY($1)", [tenantIds]);
      await c.query("DELETE FROM audit_logs       WHERE tenant_id = ANY($1)", [tenantIds]);
      await c.query("DELETE FROM permission_denials WHERE tenant_id = ANY($1)", [tenantIds]);
      // The rest cascades from tenants.
      await c.query("DELETE FROM tenants WHERE id = ANY($1)", [tenantIds]);
    } finally {
      for (const table of appendOnly) {
        await c.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
      }
    }
  });
}

/* ================================================================== */
/* 1. READ ISOLATION                                                   */
/* ================================================================== */

describe("Cross-tenant READ isolation", () => {
  it("Tenant B cannot read Tenant A's deal by its exact ID", async () => {
    const rows = await asTenant(F.tenantB, async (c) => {
      const r = await c.query("SELECT * FROM deals WHERE id = $1", [F.dealA]);
      return r.rows;
    });
    // The row exists. RLS makes it invisible.
    expect(rows).toHaveLength(0);
  });

  it("Tenant A CAN read its own deal (proves the test is meaningful)", async () => {
    const rows = await asTenant(F.tenantA, async (c) => {
      const r = await c.query("SELECT title, amount FROM deals WHERE id = $1", [F.dealA]);
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toContain("SECRET");
  });

  it("Tenant B cannot read Tenant A's asset — including its JSONB attributes", async () => {
    const rows = await asTenant(F.tenantB, async (c) => {
      const r = await c.query("SELECT dynamic_attributes FROM assets WHERE id = $1", [F.assetA]);
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("Tenant B cannot read Tenant A's contract", async () => {
    const rows = await asTenant(F.tenantB, async (c) => {
      const r = await c.query("SELECT * FROM contracts WHERE id = $1", [F.contractA]);
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("Tenant B cannot read Tenant A's ledger balance", async () => {
    const rows = await asTenant(F.tenantB, async (c) => {
      const r = await c.query("SELECT current_balance FROM ledgers WHERE id = $1", [F.ledgerA]);
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("Tenant B cannot read Tenant A's audit log", async () => {
    const rows = await asTenant(F.tenantB, async (c) => {
      const r = await c.query("SELECT * FROM audit_logs WHERE id = $1", [F.auditA]);
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("An unfiltered SELECT * returns ONLY the caller's rows", async () => {
    // The classic bug: developer forgets `WHERE tenant_id = ...`.
    // RLS must silently scope it anyway.
    const rows = await asTenant(F.tenantB, async (c) => {
      const r = await c.query("SELECT id, tenant_id FROM deals");
      return r.rows;
    });
    for (const row of rows) {
      expect(row.tenant_id).toBe(F.tenantB);
    }
    expect(rows.find((r: { id: string }) => r.id === F.dealA)).toBeUndefined();
  });

  it("Aggregates do not leak across tenants", async () => {
    // COUNT/SUM must respect RLS too — otherwise a total reveals another
    // tenant's book size even when the rows are hidden.
    const result = await asTenant(F.tenantB, async (c) => {
      const r = await c.query(
        "SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::text AS total FROM deals",
      );
      return r.rows[0];
    });
    expect(result.n).toBe(0);
    expect(Number(result.total)).toBe(0);
  });

  it("A JOIN cannot pull another tenant's rows in through the back door", async () => {
    const rows = await asTenant(F.tenantB, async (c) => {
      const r = await c.query(
        `SELECT d.title, co.name
         FROM deals d
         LEFT JOIN companies co ON co.id = d.company_id
         WHERE d.id = $1`,
        [F.dealA],
      );
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });
});

/* ================================================================== */
/* 2. FAIL-CLOSED DEFAULT                                              */
/* ================================================================== */

describe("Fail-closed: no tenant context means NO rows", () => {
  it("returns zero deals when tenant context is unset", async () => {
    // The most important property in the whole file. A misconfiguration must
    // yield NOTHING, never EVERYTHING.
    const rows = await withoutTenant(async (c) => {
      const r = await c.query("SELECT id FROM deals");
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("returns zero rows across every tenant table with no context", async () => {
    const tables = [
      "tenants", "users", "companies", "contacts", "deals",
      "assets", "asset_relationships", "contracts", "contract_versions",
      "clause_library", "ledgers", "transactions", "journal_entries",
      "custom_object_definitions", "custom_field_definitions", "custom_object_records",
      "audit_logs", "financial_periods", "permission_denials",
      "roles", "role_permissions", "user_roles",
    ];

    const counts = await withoutTenant(async (c) => {
      const out: Record<string, number> = {};
      for (const t of tables) {
        const r = await c.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
        out[t] = r.rows[0].n;
      }
      return out;
    });

    for (const [table, n] of Object.entries(counts)) {
      expect(n, `${table} leaked ${n} rows with no tenant context`).toBe(0);
    }
  });

  it("an empty-string tenant context is treated as unset, not as a wildcard", async () => {
    const rows = await asTenant("", async (c) => {
      const r = await c.query("SELECT id FROM deals");
      return r.rows;
    }).catch(() => []);
    expect(rows).toHaveLength(0);
  });
});

/* ================================================================== */
/* 3. WRITE ISOLATION                                                  */
/* ================================================================== */

describe("Cross-tenant WRITE isolation", () => {
  it("Tenant B's UPDATE of Tenant A's deal affects zero rows", async () => {
    const affected = await asTenant(F.tenantB, async (c) => {
      const r = await c.query(
        "UPDATE deals SET amount = 1.00, title = 'HIJACKED' WHERE id = $1",
        [F.dealA],
      );
      return r.rowCount;
    });
    expect(affected).toBe(0);

    // And the original is untouched.
    const original = await asTenant(F.tenantA, async (c) => {
      const r = await c.query("SELECT title, amount FROM deals WHERE id = $1", [F.dealA]);
      return r.rows[0];
    });
    expect(original.title).toContain("SECRET");
    expect(Number(original.amount)).toBe(48000000);
  });

  it("Tenant B's DELETE of Tenant A's deal affects zero rows", async () => {
    const affected = await asTenant(F.tenantB, async (c) => {
      const r = await c.query("DELETE FROM deals WHERE id = $1", [F.dealA]);
      return r.rowCount;
    });
    expect(affected).toBe(0);

    const stillThere = await asTenant(F.tenantA, async (c) => {
      const r = await c.query("SELECT id FROM deals WHERE id = $1", [F.dealA]);
      return r.rows;
    });
    expect(stillThere).toHaveLength(1);
  });

  it("Tenant B cannot UPDATE Tenant A's asset pricing", async () => {
    const affected = await asTenant(F.tenantB, async (c) => {
      const r = await c.query("UPDATE assets SET value_amount = 1.00 WHERE id = $1", [F.assetA]);
      return r.rowCount;
    });
    expect(affected).toBe(0);
  });

  it("Tenant B cannot DELETE Tenant A's contract", async () => {
    const affected = await asTenant(F.tenantB, async (c) => {
      const r = await c.query("DELETE FROM contracts WHERE id = $1", [F.contractA]);
      return r.rowCount;
    });
    expect(affected).toBe(0);
  });

  it("Tenant B cannot forge a row stamped with Tenant A's ID", async () => {
    // WITH CHECK is what stops this: you may not write a row you would not
    // be allowed to read.
    let failed = false;
    try {
      await asTenant(F.tenantB, async (c) => {
        await c.query(
          `INSERT INTO deals (tenant_id, title, amount, currency, stage)
           VALUES ($1, 'Injected by Tenant B', 1.00, 'INR', 'lead')`,
          [F.tenantA],
        );
      });
    } catch {
      failed = true;
    }
    expect(failed, "RLS WITH CHECK should reject the insert").toBe(true);
  });

  it("Tenant B cannot move its own row into Tenant A by rewriting tenant_id", async () => {
    const ownDeal = await asTenant(F.tenantB, async (c) => {
      const r = await c.query(
        `INSERT INTO deals (tenant_id, title, amount, currency, stage)
         VALUES ($1, 'B own deal', 100.00, 'INR', 'lead') RETURNING id`,
        [F.tenantB],
      );
      return r.rows[0].id;
    });

    let failed = false;
    try {
      await asTenant(F.tenantB, async (c) => {
        await c.query("UPDATE deals SET tenant_id = $1 WHERE id = $2", [F.tenantA, ownDeal]);
      });
    } catch {
      failed = true;
    }
    expect(failed, "Rewriting tenant_id must be rejected").toBe(true);
  });
});

/* ================================================================== */
/* 4. CROSS-TENANT REFERENCE GUARDS                                    */
/* ================================================================== */

describe("Cross-tenant reference guards", () => {
  it("blocks attaching a contact to another tenant's company", async () => {
    // A plain FK proves the company EXISTS. It does not prove it belongs to
    // the same tenant. The trigger closes that gap.
    let error: string | null = null;
    try {
      await asSuperuser(async (c) => {
        await c.query(
          `INSERT INTO contacts (tenant_id, company_id, first_name)
           VALUES ($1, $2, 'Cross-tenant attempt')`,
          [F.tenantB, F.companyA],
        );
      });
    } catch (err) {
      error = (err as Error).message;
    }
    expect(error).toBeTruthy();
    expect(error).toContain("Cross-tenant reference blocked");
  });

  it("blocks an asset relationship spanning two tenants", async () => {
    const assetB = await asSuperuser(async (c) => {
      const r = await c.query(
        `INSERT INTO assets (tenant_id, asset_type, name, status)
         VALUES ($1, 'building', 'Tenant B Tower', 'draft') RETURNING id`,
        [F.tenantB],
      );
      return r.rows[0].id;
    });

    let error: string | null = null;
    try {
      await asSuperuser(async (c) => {
        await c.query(
          `INSERT INTO asset_relationships (tenant_id, parent_asset_id, child_asset_id)
           VALUES ($1, $2, $3)`,
          [F.tenantB, assetB, F.assetA],
        );
      });
    } catch (err) {
      error = (err as Error).message;
    }
    expect(error).toBeTruthy();
    expect(error).toContain("Cross-tenant asset relationship blocked");
  });

  it("blocks an asset from containing itself (infinite traversal guard)", async () => {
    let error: string | null = null;
    try {
      await asSuperuser(async (c) => {
        await c.query(
          `INSERT INTO asset_relationships (tenant_id, parent_asset_id, child_asset_id)
           VALUES ($1, $2, $2)`,
          [F.tenantA, F.assetA],
        );
      });
    } catch (err) {
      error = (err as Error).message;
    }
    expect(error).toBeTruthy();
    expect(error).toContain("cannot contain itself");
  });

  it("blocks a contract referencing another tenant's asset", async () => {
    let error: string | null = null;
    try {
      await asSuperuser(async (c) => {
        await c.query(
          `INSERT INTO contracts (tenant_id, asset_id, title, contract_type, status)
           VALUES ($1, $2, 'Cross-tenant contract', 'other', 'draft')`,
          [F.tenantB, F.assetA],
        );
      });
    } catch (err) {
      error = (err as Error).message;
    }
    expect(error).toBeTruthy();
    expect(error).toContain("Cross-tenant reference blocked");
  });
});

/* ================================================================== */
/* 5. COVERAGE — every tenant table must be protected                  */
/* ================================================================== */

describe("RLS coverage", () => {
  it("every table with a tenant_id column has RLS ENABLED and FORCED", async () => {
    // The regression this catches: someone adds a table in Phase 9 and forgets
    // the policy. Without this test, that table would leak silently for months.
    const gaps = await asSuperuser(async (c) => {
      const r = await c.query(`
        SELECT t.tablename
        FROM pg_tables t
        JOIN information_schema.columns col
          ON col.table_name = t.tablename
         AND col.table_schema = t.schemaname
         AND col.column_name = 'tenant_id'
        LEFT JOIN pg_class pc ON pc.relname = t.tablename
        WHERE t.schemaname = 'public'
          AND (t.rowsecurity = false OR pc.relforcerowsecurity = false)
        ORDER BY t.tablename
      `);
      return r.rows.map((row: { tablename: string }) => row.tablename);
    });

    expect(
      gaps,
      `These tables have a tenant_id but are NOT fully protected: ${gaps.join(", ")}`,
    ).toEqual([]);
  });

  it("every protected table has an isolation policy attached", async () => {
    const missing = await asSuperuser(async (c) => {
      const r = await c.query(`
        SELECT t.tablename
        FROM pg_tables t
        LEFT JOIN pg_policies p
          ON p.tablename = t.tablename AND p.schemaname = t.schemaname
        WHERE t.schemaname = 'public'
          AND t.rowsecurity = true
          AND p.policyname IS NULL
      `);
      return r.rows.map((row: { tablename: string }) => row.tablename);
    });
    expect(missing, `RLS enabled but no policy: ${missing.join(", ")}`).toEqual([]);
  });
});
