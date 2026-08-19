/**
 * Ordence — Document Storage Isolation
 * Version: v0.8.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * PHASE 8 MANDATORY VERIFICATION #2
 * ══════════════════════════════════════════════════════════════════════
 * "Ensure the RLS policy on the `documents` table perfectly isolates files
 *  by `tenant_id`."
 *
 * Every assertion below runs against a REAL PostgreSQL, connected as a
 * NON-SUPERUSER role. That second part is not a detail: a PostgreSQL
 * superuser bypasses Row-Level Security entirely, so a suite connected as
 * one would report green forever — including on the day every policy was
 * dropped. `tests/setup.ts` aborts if the connection has superuser or
 * BYPASSRLS.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THESE TESTS CAN AND CANNOT PROVE
 * ══════════════════════════════════════════════════════════════════════
 * They prove that ROWS in `documents` are isolated by tenant.
 *
 * They say NOTHING about the file bytes, which live in Vercel Blob, outside
 * PostgreSQL. That half is protected by `access: 'private'` on upload plus
 * the session and tenant checks in `/api/documents/[id]/download`, and is
 * covered by `tests/ui/upload-authorization.test.ts` and by manual
 * verification against a real store.
 *
 * Saying "RLS protects our documents" without that distinction would be the
 * most dangerous kind of half-truth in this phase.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { testPool, asTenant, withoutTenant, asSuperuser, expectError } from "../setup";

type Fixtures = {
  tenantA: string;
  tenantB: string;
  userA: string;
  userB: string;
  contractA: string;
  contractB: string;
  documentA: string;
  documentB: string;
};

let fx: Fixtures;

beforeAll(async () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();
  const contractA = randomUUID();
  const contractB = randomUUID();
  const documentA = randomUUID();
  const documentB = randomUUID();

  // Fixtures are created as superuser because they deliberately span two
  // tenants — something no ordinary session may do. Every ASSERTION below
  // uses the non-superuser pool.
  await asSuperuser(async (c) => {
    for (const [id, slug, name] of [
      [tenantA, `doc-test-a-${Date.now()}`, "Tenant A"],
      [tenantB, `doc-test-b-${Date.now()}`, "Tenant B"],
    ] as const) {
      await c.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
         VALUES ($1, $2, $3, $4, 'active')`,
        [id, `org_${id}`, slug, name],
      );
    }

    for (const [id, tenant, email] of [
      [userA, tenantA, `a-${Date.now()}@example.com`],
      [userB, tenantB, `b-${Date.now()}@example.com`],
    ] as const) {
      await c.query(
        `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, status)
         VALUES ($1, $2, $3, $4, 'tenant_owner', 'active')`,
        [id, tenant, `clerk_${id}`, email],
      );
    }

    for (const [id, tenant, title] of [
      [contractA, tenantA, "Tenant A Sale Agreement"],
      [contractB, tenantB, "Tenant B Lease"],
    ] as const) {
      await c.query(
        `INSERT INTO contracts (id, tenant_id, title, contract_type, status)
         VALUES ($1, $2, $3, 'sale_agreement', 'draft')`,
        [id, tenant, title],
      );
    }

    for (const [id, tenant, contract, fileName] of [
      [documentA, tenantA, contractA, "tenant-a-secret.pdf"],
      [documentB, tenantB, contractB, "tenant-b-secret.pdf"],
    ] as const) {
      await c.query(
        `INSERT INTO documents
           (id, tenant_id, entity_type, entity_id, file_name, file_url,
            blob_pathname, size_bytes, mime_type)
         VALUES ($1, $2, 'contract', $3, $4, $5, $6, 12345, 'application/pdf')`,
        [
          id,
          tenant,
          contract,
          fileName,
          `https://blob.example.com/${id}`,
          `tenants/${tenant}/contract/${contract}/${Date.now()}-${fileName}`,
        ],
      );
    }
  });

  fx = { tenantA, tenantB, userA, userB, contractA, contractB, documentA, documentB };
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    await c.query(`DELETE FROM documents WHERE tenant_id = ANY($1)`, [
      [fx.tenantA, fx.tenantB],
    ]);
    await c.query(`DELETE FROM contracts WHERE tenant_id = ANY($1)`, [
      [fx.tenantA, fx.tenantB],
    ]);
    await c.query(`DELETE FROM audit_logs WHERE tenant_id = ANY($1)`, [
      [fx.tenantA, fx.tenantB],
    ]);
    await c.query(`DELETE FROM users WHERE tenant_id = ANY($1)`, [[fx.tenantA, fx.tenantB]]);
    await c.query(`DELETE FROM tenants WHERE id = ANY($1)`, [[fx.tenantA, fx.tenantB]]);
  });
});

/* ================================================================== */
/* READ                                                               */
/* ================================================================== */

describe("documents — read isolation", () => {
  it("a tenant sees ONLY its own documents", async () => {
    const rows = await asTenant(fx.tenantA, async (c) => {
      const r = await c.query(`SELECT id, file_name FROM documents`);
      return r.rows;
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(fx.documentA);
    expect(rows[0].file_name).toBe("tenant-a-secret.pdf");
  });

  it("tenant B cannot read tenant A's document BY ITS EXACT ID", async () => {
    // The realistic attack: not SQL injection, just a legitimate session
    // plus a UUID learned from somewhere.
    const rows = await asTenant(fx.tenantB, async (c) => {
      const r = await c.query(`SELECT * FROM documents WHERE id = $1`, [fx.documentA]);
      return r.rows;
    });

    expect(rows).toHaveLength(0);
  });

  it("tenant B cannot read tenant A's document by its blob pathname", async () => {
    // The pathname is the value that would let someone reach the actual
    // bytes. It must be as unreachable as the row itself.
    const rows = await asTenant(fx.tenantB, async (c) => {
      const r = await c.query(
        `SELECT * FROM documents WHERE blob_pathname LIKE $1`,
        [`tenants/${fx.tenantA}/%`],
      );
      return r.rows;
    });

    expect(rows).toHaveLength(0);
  });

  it("NO tenant context returns ZERO rows, never all rows", async () => {
    // The fail-closed property. A policy that returned everything when the
    // setting was absent would be worse than no policy — it would look
    // like it worked in every test that set a tenant.
    const rows = await withoutTenant(async (c) => {
      const r = await c.query(`SELECT * FROM documents`);
      return r.rows;
    });

    expect(rows).toHaveLength(0);
  });

  it("a garbage tenant context returns zero rows", async () => {
    const rows = await asTenant(randomUUID(), async (c) => {
      const r = await c.query(`SELECT * FROM documents`);
      return r.rows;
    });

    expect(rows).toHaveLength(0);
  });
});

/* ================================================================== */
/* WRITE                                                              */
/* ================================================================== */

describe("documents — write isolation", () => {
  it("tenant B cannot UPDATE tenant A's document", async () => {
    const updated = await asTenant(fx.tenantB, async (c) => {
      const r = await c.query(
        `UPDATE documents SET file_name = 'hacked.pdf' WHERE id = $1 RETURNING id`,
        [fx.documentA],
      );
      return r.rowCount;
    });

    expect(updated).toBe(0);

    // And the row is genuinely untouched — not merely un-returned.
    const stillOriginal = await asTenant(fx.tenantA, async (c) => {
      const r = await c.query(`SELECT file_name FROM documents WHERE id = $1`, [
        fx.documentA,
      ]);
      return r.rows[0]?.file_name;
    });

    expect(stillOriginal).toBe("tenant-a-secret.pdf");
  });

  it("tenant B cannot DELETE tenant A's document", async () => {
    const deleted = await asTenant(fx.tenantB, async (c) => {
      const r = await c.query(`DELETE FROM documents WHERE id = $1 RETURNING id`, [
        fx.documentA,
      ]);
      return r.rowCount;
    });

    expect(deleted).toBe(0);

    const stillThere = await asTenant(fx.tenantA, async (c) => {
      const r = await c.query(`SELECT id FROM documents WHERE id = $1`, [fx.documentA]);
      return r.rows.length;
    });

    expect(stillThere).toBe(1);
  });

  it("a tenant cannot INSERT a document stamped with ANOTHER tenant's id", async () => {
    // This is what WITH CHECK exists for. A USING-only policy would allow
    // this insert: the row would be invisible to its creator afterwards,
    // but it would be sitting inside the victim's workspace.
    const error = await expectError(async () => {
      await asTenant(fx.tenantB, async (c) => {
        await c.query(
          `INSERT INTO documents
             (tenant_id, entity_type, entity_id, file_name, file_url,
              blob_pathname, size_bytes, mime_type)
           VALUES ($1, 'contract', $2, 'planted.pdf', 'https://x/y',
                   $3, 100, 'application/pdf')`,
          [fx.tenantA, fx.contractA, `tenants/${fx.tenantA}/planted-${randomUUID()}`],
        );
      });
    });

    expect(error).not.toBeNull();
    // 42501 — insufficient_privilege, raised by the RLS WITH CHECK.
    expect(error?.code).toBe("42501");
  });

  it("no document can be written with no tenant context at all", async () => {
    const error = await expectError(async () => {
      await withoutTenant(async (c) => {
        await c.query(
          `INSERT INTO documents
             (tenant_id, entity_type, entity_id, file_name, file_url,
              blob_pathname, size_bytes, mime_type)
           VALUES ($1, 'contract', $2, 'orphan.pdf', 'https://x/y',
                   $3, 100, 'application/pdf')`,
          [fx.tenantA, fx.contractA, `tenants/${fx.tenantA}/orphan-${randomUUID()}`],
        );
      });
    });

    expect(error).not.toBeNull();
  });
});

/* ================================================================== */
/* IMMUTABILITY TRIGGERS                                              */
/* ================================================================== */

describe("documents — immutability guards", () => {
  it("a document CANNOT be moved to another tenant, even by its owner", async () => {
    // RLS alone already blocks this for a normal session. The trigger makes
    // it hold for any future path that runs elevated — a migration, a
    // background job, a console. A document is evidence; moving evidence
    // between tenants must never be an accident.
    const error = await expectError(async () => {
      await asTenant(fx.tenantA, async (c) => {
        await c.query(`UPDATE documents SET tenant_id = $1 WHERE id = $2`, [
          fx.tenantB,
          fx.documentA,
        ]);
      });
    });

    expect(error).not.toBeNull();
  });

  it("the tenant-immutability trigger fires even for a SUPERUSER", async () => {
    // The decisive test. A superuser bypasses RLS completely, so if the
    // guarantee lived only in the policy this would succeed. It is a
    // trigger precisely so that it does not.
    const error = await expectError(async () => {
      await asSuperuser(async (c) => {
        await c.query(`UPDATE documents SET tenant_id = $1 WHERE id = $2`, [
          fx.tenantB,
          fx.documentA,
        ]);
      });
    });

    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");

    const owner = await asSuperuser(async (c) => {
      const r = await c.query(`SELECT tenant_id FROM documents WHERE id = $1`, [
        fx.documentA,
      ]);
      return r.rows[0]?.tenant_id;
    });

    expect(owner).toBe(fx.tenantA);
  });

  it("a document cannot be re-attached to a different parent record", async () => {
    const error = await expectError(async () => {
      await asTenant(fx.tenantA, async (c) => {
        await c.query(`UPDATE documents SET entity_id = $1 WHERE id = $2`, [
          randomUUID(),
          fx.documentA,
        ]);
      });
    });

    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("a document's storage location is immutable", async () => {
    // Rewriting the pathname would point an existing row — with its audit
    // history intact — at a DIFFERENT object, and a later delete would
    // then remove bytes this row never described.
    const error = await expectError(async () => {
      await asTenant(fx.tenantA, async (c) => {
        await c.query(`UPDATE documents SET blob_pathname = $1 WHERE id = $2`, [
          `tenants/${fx.tenantB}/stolen.pdf`,
          fx.documentA,
        ]);
      });
    });

    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("permitted fields on one's own document CAN still be updated", async () => {
    // A guard that blocked everything would be easy to pass and useless.
    // Soft-deleting must still work.
    const updated = await asTenant(fx.tenantA, async (c) => {
      const r = await c.query(
        `UPDATE documents SET description = 'Filed under annexures'
         WHERE id = $1 RETURNING description`,
        [fx.documentA],
      );
      return r.rows[0]?.description;
    });

    expect(updated).toBe("Filed under annexures");
  });
});

/* ================================================================== */
/* POLICY SHAPE                                                       */
/* ================================================================== */

describe("documents — policy configuration", () => {
  it("has RLS both ENABLED and FORCED", async () => {
    const row = await asSuperuser(async (c) => {
      const r = await c.query(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'documents'`,
      );
      return r.rows[0];
    });

    expect(row.relrowsecurity).toBe(true);
    // FORCE is the one people forget. Without it, the table's OWNER — which
    // in many deployments is the application's own role — bypasses every
    // policy and the isolation is decorative.
    expect(row.relforcerowsecurity).toBe(true);
  });

  it("its policy defines BOTH a USING and a WITH CHECK clause", async () => {
    const row = await asSuperuser(async (c) => {
      const r = await c.query(
        `SELECT qual, with_check FROM pg_policies
         WHERE tablename = 'documents' AND policyname = 'documents_tenant_isolation'`,
      );
      return r.rows[0];
    });

    expect(row).toBeDefined();
    expect(row.qual).not.toBeNull();
    // USING governs reads; WITH CHECK governs writes. A policy with only
    // the former lets a tenant plant rows it can never see.
    expect(row.with_check).not.toBeNull();
  });

  it("both immutability triggers are installed", async () => {
    const names = await asSuperuser(async (c) => {
      const r = await c.query(
        `SELECT tgname FROM pg_trigger
         WHERE tgrelid = 'documents'::regclass AND NOT tgisinternal
         ORDER BY tgname`,
      );
      return r.rows.map((x: { tgname: string }) => x.tgname);
    });

    expect(names).toContain("documents_tenant_immutable");
    expect(names).toContain("documents_parent_immutable");
  });
});
