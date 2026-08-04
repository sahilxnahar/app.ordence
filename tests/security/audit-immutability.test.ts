/**
 * Ordence — Audit Immutability Test Suite
 * Version: v0.6.0-alpha
 *
 * An audit trail that can be edited proves nothing.
 *
 * If a row can be changed after the fact, then in a dispute the log is not
 * evidence — it is just a claim. The whole value of these four tables rests on
 * one property: **once written, never changed.**
 *
 * This suite attacks that property directly. It writes a row, then tries every
 * way it can think of to alter or remove it, and asserts the database refuses
 * each time.
 *
 * Four tables are under test:
 *   audit_logs         — who did what
 *   contract_versions  — what the document said on a given date
 *   journal_entries    — the financial record
 *   permission_denials — who tried to do something they could not
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { asTenant, asSuperuser, expectError } from "../setup";

const RUN = randomUUID().slice(0, 8);

type F = {
  tenant: string;
  user: string;
  auditId: string;
  denialId: string;
  contractId: string;
  versionId: string;
  ledgerA: string;
  ledgerB: string;
  txnId: string;
  entryId: string;
};
const F = {} as F;

beforeAll(async () => {
  await asSuperuser(async (c) => {
    const t = await c.query(
      `INSERT INTO tenants (clerk_org_id, name, slug, status)
       VALUES ($1, 'Audit Test Co', $2, 'active') RETURNING id`,
      [`org_audit_${RUN}`, `audit-${RUN}`],
    );
    F.tenant = t.rows[0].id;

    const u = await c.query(
      `INSERT INTO users (tenant_id, clerk_user_id, email, role, status)
       VALUES ($1, $2, $3, 'tenant_owner', 'active') RETURNING id`,
      [F.tenant, `user_audit_${RUN}`, `audit-${RUN}@test.local`],
    );
    F.user = u.rows[0].id;
  });

  // Write the evidence rows through the normal (non-superuser) path.
  await asTenant(F.tenant, async (c) => {
    const a = await c.query(
      `INSERT INTO audit_logs
         (tenant_id, actor_user_id, actor_email, actor_role, action,
          resource_type, resource_id, reason, severity, metadata)
       VALUES ($1, $2, $3, 'tenant_owner', 'delete', 'contract', $4,
               'Contract deleted by owner', 'critical', $5)
       RETURNING id`,
      [
        F.tenant, F.user, `audit-${RUN}@test.local`, randomUUID(),
        JSON.stringify({ originalValue: "IMPORTANT EVIDENCE", ip: "203.0.113.42" }),
      ],
    );
    F.auditId = a.rows[0].id;

    const d = await c.query(
      `INSERT INTO permission_denials
         (tenant_id, user_id, actor_role, permission, was_dangerous, ip_address)
       VALUES ($1, $2, 'member', 'periods:close', true, '203.0.113.42')
       RETURNING id`,
      [F.tenant, F.user],
    );
    F.denialId = d.rows[0].id;

    const contract = await c.query(
      `INSERT INTO contracts (tenant_id, title, contract_type, status, document_data)
       VALUES ($1, 'Evidence Contract', 'sale_agreement', 'signed', $2) RETURNING id`,
      [F.tenant, JSON.stringify({ sections: [{ id: "s1", heading: "Price", body: "₹4.8 Cr", order: 0 }] })],
    );
    F.contractId = contract.rows[0].id;

    const v = await c.query(
      `INSERT INTO contract_versions
         (tenant_id, contract_id, version_number, change_type, document_data,
          content_hash, status_at_version)
       VALUES ($1, $2, 1, 'created', $3, $4, 'signed') RETURNING id`,
      [
        F.tenant, F.contractId,
        JSON.stringify({ sections: [{ id: "s1", heading: "Price", body: "₹4.8 Cr", order: 0 }] }),
        "a".repeat(64),
      ],
    );
    F.versionId = v.rows[0].id;

    const la = await c.query(
      `INSERT INTO ledgers (tenant_id, name, code, type, account_type)
       VALUES ($1, 'Cash', $2, 'operating', 'asset') RETURNING id`,
      [F.tenant, `CASH-${RUN}`],
    );
    const lb = await c.query(
      `INSERT INTO ledgers (tenant_id, name, code, type, account_type)
       VALUES ($1, 'Revenue', $2, 'operating', 'revenue') RETURNING id`,
      [F.tenant, `REV-${RUN}`],
    );
    F.ledgerA = la.rows[0].id;
    F.ledgerB = lb.rows[0].id;

    const txn = await c.query(
      `INSERT INTO transactions (tenant_id, description, transaction_date, currency, total_amount)
       VALUES ($1, 'Evidence transaction', '2026-08-10', 'INR', 250000.00) RETURNING id`,
      [F.tenant],
    );
    F.txnId = txn.rows[0].id;

    const e1 = await c.query(
      `INSERT INTO journal_entries (tenant_id, transaction_id, ledger_id, entry_type, amount)
       VALUES ($1, $2, $3, 'debit', 250000.00) RETURNING id`,
      [F.tenant, F.txnId, F.ledgerA],
    );
    await c.query(
      `INSERT INTO journal_entries (tenant_id, transaction_id, ledger_id, entry_type, amount)
       VALUES ($1, $2, $3, 'credit', 250000.00)`,
      [F.tenant, F.txnId, F.ledgerB],
    );
    F.entryId = e1.rows[0].id;
  });
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    const tables = ["audit_logs", "journal_entries", "contract_versions", "permission_denials"];
    for (const t of tables) await c.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
    try {
      await c.query("DELETE FROM journal_entries WHERE tenant_id = $1", [F.tenant]);
      await c.query("DELETE FROM transactions WHERE tenant_id = $1", [F.tenant]);
      await c.query("DELETE FROM contract_versions WHERE tenant_id = $1", [F.tenant]);
      await c.query("DELETE FROM audit_logs WHERE tenant_id = $1", [F.tenant]);
      await c.query("DELETE FROM permission_denials WHERE tenant_id = $1", [F.tenant]);
      await c.query("DELETE FROM tenants WHERE id = $1", [F.tenant]);
    } finally {
      for (const t of tables) await c.query(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
    }
  });
});

/* ================================================================== */
/* 1. AUDIT LOGS                                                       */
/* ================================================================== */

describe("audit_logs immutability", () => {
  it("the evidence row exists and is readable", async () => {
    const rows = await asTenant(F.tenant, async (c) => {
      const r = await c.query("SELECT reason, severity FROM audit_logs WHERE id = $1", [F.auditId]);
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("Contract deleted by owner");
  });

  it("BLOCKS an UPDATE of the reason field", async () => {
    const err = await expectError(() =>
      asTenant(F.tenant, async (c) => {
        await c.query("UPDATE audit_logs SET reason = 'nothing happened' WHERE id = $1", [F.auditId]);
      }),
    );
    expect(err, "UPDATE on audit_logs must be rejected").not.toBeNull();
    expect(err!.message).toContain("append-only");
    expect(err!.code).toBe("42501"); // insufficient_privilege
  });

  it("BLOCKS an UPDATE of the severity field", async () => {
    // Downgrading 'critical' to 'info' would hide the event from a review filter.
    const err = await expectError(() =>
      asTenant(F.tenant, async (c) => {
        await c.query("UPDATE audit_logs SET severity = 'info' WHERE id = $1", [F.auditId]);
      }),
    );
    expect(err).not.toBeNull();
    expect(err!.message).toContain("append-only");
  });

  it("BLOCKS an UPDATE of the metadata JSONB", async () => {
    const err = await expectError(() =>
      asTenant(F.tenant, async (c) => {
        await c.query("UPDATE audit_logs SET metadata = '{}'::jsonb WHERE id = $1", [F.auditId]);
      }),
    );
    expect(err).not.toBeNull();
    expect(err!.message).toContain("append-only");
  });

  it("BLOCKS a DELETE of the row", async () => {
    const err = await expectError(() =>
      asTenant(F.tenant, async (c) => {
        await c.query("DELETE FROM audit_logs WHERE id = $1", [F.auditId]);
      }),
    );
    expect(err, "DELETE on audit_logs must be rejected").not.toBeNull();
    expect(err!.message).toContain("append-only");
    expect(err!.code).toBe("42501");
  });

  it("BLOCKS a bulk DELETE across the whole table", async () => {
    // The panic move: wipe everything rather than one row.
    const err = await expectError(() =>
      asTenant(F.tenant, async (c) => {
        await c.query("DELETE FROM audit_logs");
      }),
    );
    expect(err).not.toBeNull();
    expect(err!.message).toContain("append-only");
  });

  it("BLOCKS an UPDATE that would match nothing (trigger fires regardless)", async () => {
    // A row-level trigger only fires on matched rows, so this is really a probe:
    // if it silently succeeds, the protection is per-row and a crafted WHERE
    // could be used to explore. Either outcome is acceptable, but a SUCCESS on a
    // MATCHING row is not — asserted above.
    const err = await expectError(() =>
      asTenant(F.tenant, async (c) => {
        await c.query("UPDATE audit_logs SET reason = 'x' WHERE tenant_id = $1", [F.tenant]);
      }),
    );
    expect(err).not.toBeNull();
  });

  it("the row is STILL intact after every attack", async () => {
    const rows = await asTenant(F.tenant, async (c) => {
      const r = await c.query(
        "SELECT reason, severity, metadata FROM audit_logs WHERE id = $1",
        [F.auditId],
      );
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("Contract deleted by owner");
    expect(rows[0].severity).toBe("critical");
    expect(rows[0].metadata.originalValue).toBe("IMPORTANT EVIDENCE");
  });

  it("new rows CAN still be appended (append-only, not read-only)", async () => {
    const inserted = await asTenant(F.tenant, async (c) => {
      const r = await c.query(
        `INSERT INTO audit_logs (tenant_id, action, resource_type, reason)
         VALUES ($1, 'create', 'test', 'Appending still works') RETURNING id`,
        [F.tenant],
      );
      return r.rows[0].id;
    });
    expect(inserted).toBeTruthy();
  });
});

/* ================================================================== */
/* 2. PERMISSION DENIALS                                               */
/* ================================================================== */

describe("permission_denials immutability", () => {
  it("BLOCKS an UPDATE", async () => {
    const err = await expectError(() =>
      asTenant(F.tenant, async (c) => {
        await c.query("UPDATE permission_denials SET was_dangerous = false WHERE id = $1", [F.denialId]);
      }),
    );
    expect(err).not.toBeNull();
    expect(err!.message).toContain("append-only");
  });

  it("BLOCKS a DELETE", async () => {
    // This is the record of someone probing the system. If it can be erased,
    // an attacker removes the trace of having tried.
    const err = await expectError(() =>
      asTenant(F.tenant, async (c) => {
        await c.query("DELETE FROM permission_denials WHERE id = $1", [F.denialId]);
      }),
    );
    expect(err).not.toBeNull();
    expect(err!.message).toContain("append-only");
  });

  it("the denial record survives", async () => {
    const rows = await asTenant(F.tenant, async (c) => {
      const r = await c.query(
        "SELECT permission, was_dangerous FROM permission_denials WHERE id = $1",
        [F.denialId],
      );
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].permission).toBe("periods:close");
    expect(rows[0].was_dangerous).toBe(true);
  });
});

/* ================================================================== */
/* 3. CONTRACT VERSIONS                                                */
/* ================================================================== */

describe("contract_versions immutability", () => {
  it("BLOCKS an UPDATE of the document body", async () => {
    // Rewriting what a signed contract said is the single most damaging edit
    // possible in this system.
    const err = await expectError(() =>
      asTenant(F.tenant, async (c) => {
        await c.query(
          `UPDATE contract_versions SET document_data = $1 WHERE id = $2`,
          [JSON.stringify({ sections: [{ id: "s1", heading: "Price", body: "₹1.00", order: 0 }] }), F.versionId],
        );
      }),
    );
    expect(err).not.toBeNull();
    expect(err!.message).toContain("append-only");
  });

  it("BLOCKS an UPDATE of the content hash", async () => {
    // If the hash could be rewritten, the integrity chain would validate against
    // tampered content.
    const err = await expectError(() =>
      asTenant(F.tenant, async (c) => {
        await c.query("UPDATE contract_versions SET content_hash = $1 WHERE id = $2", ["b".repeat(64), F.versionId]);
      }),
    );
    expect(err).not.toBeNull();
    expect(err!.message).toContain("append-only");
  });

  it("BLOCKS a DELETE", async () => {
    const err = await expectError(() =>
      asTenant(F.tenant, async (c) => {
        await c.query("DELETE FROM contract_versions WHERE id = $1", [F.versionId]);
      }),
    );
    expect(err).not.toBeNull();
    expect(err!.message).toContain("append-only");
  });

  it("the original document body is unchanged", async () => {
    const rows = await asTenant(F.tenant, async (c) => {
      const r = await c.query("SELECT document_data, content_hash FROM contract_versions WHERE id = $1", [F.versionId]);
      return r.rows;
    });
    expect(rows[0].document_data.sections[0].body).toBe("₹4.8 Cr");
    expect(rows[0].content_hash).toBe("a".repeat(64));
  });
});

/* ================================================================== */
/* 4. JOURNAL ENTRIES                                                  */
/* ================================================================== */

describe("journal_entries immutability", () => {
  it("BLOCKS an UPDATE of the amount", async () => {
    const err = await expectError(() =>
      asTenant(F.tenant, async (c) => {
        await c.query("UPDATE journal_entries SET amount = 1.00 WHERE id = $1", [F.entryId]);
      }),
    );
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/append-only|closed accounting period/);
  });

  it("BLOCKS flipping a debit into a credit", async () => {
    const err = await expectError(() =>
      asTenant(F.tenant, async (c) => {
        await c.query("UPDATE journal_entries SET entry_type = 'credit' WHERE id = $1", [F.entryId]);
      }),
    );
    expect(err).not.toBeNull();
  });

  it("BLOCKS a DELETE", async () => {
    const err = await expectError(() =>
      asTenant(F.tenant, async (c) => {
        await c.query("DELETE FROM journal_entries WHERE id = $1", [F.entryId]);
      }),
    );
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/append-only|closed accounting period/);
  });

  it("the entry is unchanged", async () => {
    const rows = await asTenant(F.tenant, async (c) => {
      const r = await c.query("SELECT amount::text, entry_type FROM journal_entries WHERE id = $1", [F.entryId]);
      return r.rows;
    });
    expect(rows[0].amount).toBe("250000.00");
    expect(rows[0].entry_type).toBe("debit");
  });
});

/* ================================================================== */
/* 5. TRIGGER COVERAGE                                                 */
/* ================================================================== */

describe("Append-only trigger coverage", () => {
  it("all four evidence tables have BOTH an update and a delete guard", async () => {
    // The regression this catches: someone adds an evidence table later and
    // protects only one of the two operations.
    const expected = [
      "audit_logs",
      "contract_versions",
      "journal_entries",
      "permission_denials",
    ];

    const found = await asSuperuser(async (c) => {
      const r = await c.query(`
        SELECT c.relname AS table_name,
               bool_or(t.tgname LIKE '%_no_update') AS has_update_guard,
               bool_or(t.tgname LIKE '%_no_delete') AS has_delete_guard
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal
          AND c.relname = ANY($1)
        GROUP BY c.relname
      `, [expected]);
      return r.rows as Array<{ table_name: string; has_update_guard: boolean; has_delete_guard: boolean }>;
    });

    for (const table of expected) {
      const row = found.find((f) => f.table_name === table);
      expect(row, `${table} has no append-only triggers at all`).toBeDefined();
      expect(row!.has_update_guard, `${table} is missing its UPDATE guard`).toBe(true);
      expect(row!.has_delete_guard, `${table} is missing its DELETE guard`).toBe(true);
    }
  });

  it("the guard raises insufficient_privilege (42501), not a generic error", async () => {
    // The specific SQLSTATE matters: application code branches on it to give
    // the user "post a reversing entry" rather than "something went wrong".
    const err = await expectError(() =>
      asTenant(F.tenant, async (c) => {
        await c.query("DELETE FROM audit_logs WHERE id = $1", [F.auditId]);
      }),
    );
    expect(err!.code).toBe("42501");
  });
});
