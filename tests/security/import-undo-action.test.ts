/**
 * Ordence — ⭐⭐⭐ THE UNDO BUTTON, AND THE RIGHT IT ASKS FOR
 * Version: v1.89.0-alpha · Wave 2B
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT IS BEING PROVED, AND WHY EACH PROOF IS SHAPED THIS WAY
 * ══════════════════════════════════════════════════════════════════════
 * Not "the action ran". Three claims, each induced:
 *
 *   ① The permission this action chose actually REFUSES. Induced with a
 *      user who holds the entity's `createPermission` — they may import —
 *      and not its `updatePermission`. The refusal is measured by COUNTING
 *      ROWS (`import_reversals`, the destination table, `reversed_at`),
 *      never by reading the error text, because an error message is a
 *      string and a string can be produced by a gate that did not run.
 *      The same user, the same run, one override flipped, then reaches the
 *      reversal — so the counting proves the GATE, not an unrelated fault.
 *
 *   ② A partial reversal reaches the caller AS PARTIAL: `ok: true` with
 *      `status: "partial"`, every unreversed row named with what blocked
 *      it, and `superseded_at` still NULL so the file cannot be imported
 *      again on top of rows that were never removed.
 *
 *   ③ The audit row is written even when the reversal REFUSES. An
 *      `irreversible` refusal is a thing somebody tried, and a refusal
 *      nobody recorded is indistinguishable from nobody having tried.
 *
 * ⚠️ AND A FOURTH, WHICH IS A FINDING RATHER THAN A FEATURE: §④ shows
 * that with the twelve unapplied migrations applied as one ordered pack,
 * NO undo of any kind can complete, because SQL 0215 §4 refuses the very
 * UPDATE that SQL 0205 §5 exists to permit. It is proved by induction
 * from both sides — with the trigger, 0 of 3; without it, 3 of 3.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT IS MOCKED, AND WHAT IS DELIBERATELY NOT
 * ══════════════════════════════════════════════════════════════════════
 * Mocked: `requireTenantContext` (there is no Clerk session in a test),
 * `requireAccess` (billing standing has its own suite — `billing-gate`,
 * `fail-closed-billing`) and `requireFeature` (entitlements likewise).
 *
 * 🔴 NOT MOCKED, AND THIS IS THE POINT OF THE FILE: `requirePermission`,
 * `requireAllPermissions`, `evaluatePermission`, `recordDenial` and
 * `writeAudit` are the REAL ones, running against the real tables. The
 * precedent files in this directory stub `requirePermission` to `() =>
 * ctx` — correct for a suite about row counts, and fatal for a suite
 * about a permission. A permission proof that stubs the permission check
 * proves the stub.
 *
 * ⚠️ OWNERSHIP. `tests/security/**` belongs to track D. This file is
 * OFFERED rather than claimed — see `PATCH-REQUEST-WAVE-2B.md`. It lives
 * here because this is the only directory in the repository wired to a
 * real database, and a proof about an undo that does not touch one is not
 * a proof of anything.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql as drizzleSql } from "drizzle-orm";

/** `sql.raw` — the fixtures build literal statements, never user input. */
const sqlRaw = (text: string) => drizzleSql.raw(text);
import { asSuperuser } from "../setup";
import { withTenant } from "@/db";
import { ALL_IMPORT_ENTITIES } from "@/lib/import/entities";
import type { ContractedImportEntity } from "@/lib/import/types";
import { writeRowWithLedger } from "@/server/import/ledger";
import { startImportRun, importSourceFingerprint } from "@/server/import/runs";
import type { TenantContext } from "@/server/tenant-context";

/** The context the action will see. Mutated per test — see the mock below. */
const h: { ctx: TenantContext } = { ctx: null as unknown as TenantContext };

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
    getTenantContext: async () => h.ctx,
    requireRole: async () => h.ctx,
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

const { undoImportRun } = await import("@/server/actions/import-reversal");

/* ================================================================== */
/* FIXTURES                                                            */
/* ================================================================== */

async function freshTenant(label: string): Promise<string> {
  const id = randomUUID();
  await asSuperuser(async (c) => {
    await c.query(
      `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [id, `org_${id}`, `w2b-${id.slice(0, 8)}`, `Wave 2B ${label}`],
    );
  });
  return id;
}

/**
 * A real user row, with a real role and real per-user overrides.
 *
 * ⭐ THE OVERRIDE IS THE INDUCTION INSTRUMENT. `evaluatePermission()`
 * gives an explicit revoke precedence over everything, including the
 * `tenant_owner` template's `"*"`. So one column decides whether the
 * caller holds a single key, with every other key untouched — which is
 * what makes the two runs of the same test differ in exactly one thing.
 */
async function freshUser(
  tenantId: string,
  overrides: Record<string, boolean> | null = null,
): Promise<string> {
  const id = randomUUID();
  await asSuperuser(async (c) => {
    await c.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, first_name, last_name, role,
                          permission_overrides)
       VALUES ($1, $2, $3, $4, 'Wave', 'TwoB', 'tenant_owner', coalesce($5::jsonb, '{}'::jsonb))`,
      [id, tenantId, `clerk_${id}`, `${id.slice(0, 8)}@wave2b.invalid`, overrides],
    );
  });
  return id;
}

async function setOverrides(userId: string, overrides: Record<string, boolean> | null) {
  await asSuperuser((c) =>
    c.query(`UPDATE users SET permission_overrides = coalesce($2::jsonb, '{}'::jsonb) WHERE id = $1`, [
      userId,
      overrides,
    ]),
  );
}

/** Build the context the mocked `requireTenantContext()` will hand back. */
async function contextFor(tenantId: string, userId: string): Promise<TenantContext> {
  return asSuperuser(async (c) => {
    const { rows: tenants } = await c.query(`SELECT * FROM tenants WHERE id = $1`, [tenantId]);
    const { rows: users } = await c.query(`SELECT * FROM users WHERE id = $1`, [userId]);
    const user = users[0];
    return {
      tenant: { id: tenantId, ...tenants[0] },
      user: {
        id: userId,
        email: user.email,
        /** ⚠️ camelCase, because `evaluatePermission` reads the object, not the row. */
        permissionOverrides: user.permission_overrides,
      },
      clerkUserId: user.clerk_user_id,
      clerkOrgId: tenants[0].clerk_org_id,
      role: user.role,
      requestId: randomUUID(),
      impersonationId: null,
      impersonationScope: null,
      operatorEmail: null,
    } as unknown as TenantContext;
  });
}

const fingerprintFor = (text: string) =>
  importSourceFingerprint(new TextEncoder().encode(text));

async function beginRun(args: {
  tenantId: string;
  userId: string;
  entityKey: string;
  duplicateMode: string;
  expectedRows: number;
  file: string;
}) {
  return startImportRun({
    tenantId: args.tenantId,
    startedBy: args.userId,
    entityKey: args.entityKey,
    sourceFormat: "csv",
    sourceName: `${args.entityKey}.csv`,
    duplicateMode: args.duplicateMode,
    expectedRows: args.expectedRows,
    sourceFingerprint: fingerprintFor(args.file),
  });
}

function sqlInsertInvoice(
  id: string,
  tenantId: string,
  companyId: string,
  userId: string,
  n: number,
) {
  return sqlRaw(
    `INSERT INTO sales_invoices
       (id, tenant_id, invoice_number, financial_year, status, company_id, invoice_date,
        currency, subtotal_minor, taxable_value_minor, total_minor, issued_at, issued_by,
        notes, created_by)
     VALUES ('${id}', '${tenantId}', 'W2B-${n}', '2025-26', 'issued', '${companyId}',
             '2026-03-31', 'INR', ${n * 100000}, 0, ${n * 100000},
             '2026-03-31T00:00:00+05:30', '${userId}',
             'Opening balance brought forward from the previous system.', '${userId}')`,
  );
}

/**
 * See `import-reversal.test.ts`: a tenant with books cannot simply be deleted.
 *
 * ⚠️ AND THIS SUITE ADDS A THIRD TABLE TO THAT LIST, WHICH IS ITSELF A
 * FINDING. `audit_logs.tenant_id` is `ON DELETE RESTRICT` and the table
 * carries `audit_logs_no_delete` — so a workspace that has ever been
 * audited cannot be erased at all. Phase 2 found the same shape in
 * `journal_entries` and wave 15 §4.2 in `security_events`; the audit
 * table is the third, and the one every tenant has rows in. The DPDPA
 * erasure work has to solve it rather than inherit it.
 * `PATCH-REQUEST-WAVE-2B.md` records it.
 */
async function cleanupTenant(id: string) {
  const APPEND_ONLY: readonly [string, string][] = [
    ["journal_entries", "journal_entries_no_delete"],
    ["stock_movements", "trg_stock_ledger_append_only"],
    ["audit_logs", "audit_logs_no_delete"],
    ["permission_denials", "permission_denials_no_delete"],
  ];
  for (const [table, trigger] of APPEND_ONLY) {
    await asSuperuser((c) => c.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`));
  }
  try {
    await asSuperuser(async (c) => {
      await c.query(`DELETE FROM change_log WHERE tenant_id = $1`, [id]);
      await c.query(`DELETE FROM audit_logs WHERE tenant_id = $1`, [id]);
      await c.query(`DELETE FROM permission_denials WHERE tenant_id = $1`, [id]);
      await c.query(`DELETE FROM tenants WHERE id = $1`, [id]);
    });
  } finally {
    for (const [table, trigger] of APPEND_ONLY) {
      await asSuperuser((c) => c.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`));
    }
  }
}

/* ------------------------------------------------------------------ */
/* COUNTERS — the proofs are made of these, not of error strings        */
/* ------------------------------------------------------------------ */

const countOf = async (table: string, where: string, params: unknown[]): Promise<number> =>
  asSuperuser(async (c) => {
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
      params as never[],
    );
    return rows[0].n as number;
  });

const reversalsFor = (tenantId: string, runId: string) =>
  countOf("import_reversals", "tenant_id = $1 AND run_id = $2", [tenantId, runId]);

const deniedFor = (tenantId: string, permission: string) =>
  countOf("permission_denials", "tenant_id = $1 AND permission = $2", [tenantId, permission]);

const auditFor = (tenantId: string, runId: string) =>
  countOf(
    "audit_logs",
    "tenant_id = $1 AND resource_type = 'import_run' AND resource_id = $2",
    [tenantId, runId],
  );

const supersededAt = (runId: string) =>
  asSuperuser(async (c) => {
    const { rows } = await c.query(`SELECT superseded_at FROM import_runs WHERE id = $1`, [runId]);
    return rows[0].superseded_at as Date | null;
  });

/* ================================================================== */
/* ① "MAY IMPORT" IS NOT "MAY UNDO AN IMPORT"                          */
/* ================================================================== */

describe("the permission the undo asks for", () => {
  /**
   * 🔴 THE DECISION UNDER TEST. `companies` is imported behind
   * `companies:create` and overwritten behind `companies:update`. This
   * user holds the first and not the second: they may run the migration
   * that created these rows, and they may not undo it.
   */
  it("refuses a user who may import but may not overwrite — and the reversal never starts", async () => {
    const t = await freshTenant("perm");
    const u = await freshUser(t, { "companies:update": false });

    const entity = ALL_IMPORT_ENTITIES.companies;
    expect(entity.createPermission).toBe("companies:create");
    expect(entity.updatePermission).toBe("companies:update");
    expect(entity.contract.reversal.kind).toBe("restore-prior");

    const run = await beginRun({
      tenantId: t,
      userId: u,
      entityKey: "companies",
      duplicateMode: "update",
      expectedRows: 2,
      file: "companies-perm",
    });

    const created: string[] = [];
    await withTenant(t, async (tx) => {
      for (let i = 1; i <= 2; i += 1) {
        const id = randomUUID();
        created.push(id);
        await writeRowWithLedger(tx, {
          tenantId: t,
          runId: run.runId,
          entityKey: "companies",
          entity,
          inputRowNumber: i,
          existingId: null,
          write: async (inner) => {
            await inner.execute(
              sqlRaw(
                `INSERT INTO companies (id, tenant_id, name) VALUES ('${id}', '${t}', 'Imported ${i} Ltd')`,
              ),
            );
            return id;
          },
        });
      }
    });

    h.ctx = await contextFor(t, u);

    const deniedBefore = await deniedFor(t, "companies:update");
    const refused = await undoImportRun({ runId: run.runId });

    expect(refused.ok).toBe(false);

    /**
     * 🔴 THE REFUSAL, COUNTED. Nothing was written to `import_reversals`,
     * which means `reverseImportRun` was never entered — not that it ran
     * and failed. The two are indistinguishable from the error string.
     */
    expect(await reversalsFor(t, run.runId)).toBe(0);
    expect(await countOf("companies", "tenant_id = $1", [t])).toBe(2);
    expect(
      await countOf("import_row_provenance", "run_id = $1 AND reversed_at IS NULL", [run.runId]),
    ).toBe(2);

    /** And the denial is on the record, naming the key that stopped it. */
    expect(await deniedFor(t, "companies:update")).toBe(deniedBefore + 1);

    /**
     * ⭐ THE CONTRAST THAT MAKES THE COUNT MEAN SOMETHING. Same user, same
     * run, same action — one override removed. If the reversal still did
     * not start, the count above would have been measuring something else.
     */
    await setOverrides(u, null);
    h.ctx = await contextFor(t, u);

    const allowed = await undoImportRun({ runId: run.runId });
    expect(allowed.ok).toBe(true);
    expect(await reversalsFor(t, run.runId)).toBe(1);

    await cleanupTenant(t);
  });

  /**
   * 🔴 THE SECOND HALF OF THE DECISION: a run that POSTS also asks for
   * `transactions:reverse`. Without this, the undo button is a way to put
   * a reversing entry in the general ledger without the right to post one.
   */
  it("asks for transactions:reverse when the run posts to the ledger, and refuses without it", async () => {
    const t = await freshTenant("ledger-perm");
    const u = await freshUser(t, { "transactions:reverse": false });

    /**
     * ⭐ `purchase-bills` IS THE CASE THAT MAKES THE DERIVATION NECESSARY.
     * It declares `reverse-entry` — undoing it posts a reversing entry —
     * and its own keys are `purchases:record_invoice` for BOTH create and
     * update. Nothing in the entity mentions the ledger. A guard built
     * from the entity alone would let somebody who may type a purchase
     * bill post a reversal they could not post from the accounting
     * screen. (`opening-trial-balance` happens to name
     * `transactions:reverse` itself, which is why it is the wrong entity
     * to prove this with.)
     */
    const entity = ALL_IMPORT_ENTITIES["purchase-bills"];
    expect(entity.contract.reversal.kind).toBe("reverse-entry");
    expect(entity.createPermission).toBe("purchases:record_invoice");
    expect(entity.updatePermission).toBe("purchases:record_invoice");
    expect(entity.updatePermission).not.toBe("transactions:reverse");

    const vendor = randomUUID();
    await asSuperuser((c) =>
      c.query(
        `INSERT INTO vendors (id, tenant_id, code, legal_name) VALUES ($1, $2, 'V-001', 'Supplier Ltd')`,
        [vendor, t],
      ),
    );

    const run = await beginRun({
      tenantId: t,
      userId: u,
      entityKey: "purchase-bills",
      duplicateMode: "skip",
      expectedRows: 1,
      file: "bills-perm",
    });

    const billId = randomUUID();
    await withTenant(t, async (tx) => {
      await writeRowWithLedger(tx, {
        tenantId: t,
        runId: run.runId,
        entityKey: "purchase-bills",
        entity,
        inputRowNumber: 1,
        existingId: null,
        write: async (inner) => {
          await inner.execute(
            sqlRaw(
              `INSERT INTO purchase_invoices (id, tenant_id, vendor_id, invoice_number, invoice_date)
               VALUES ('${billId}', '${t}', '${vendor}', 'BILL-1', '2026-03-31')`,
            ),
          );
          return billId;
        },
      });
    });

    h.ctx = await contextFor(t, u);
    const refused = await undoImportRun({ runId: run.runId });

    expect(refused.ok).toBe(false);
    /** 🔴 THE REVERSAL NEVER STARTED — counted, not read off the message. */
    expect(await reversalsFor(t, run.runId)).toBe(0);
    expect(await countOf("purchase_invoices", "tenant_id = $1", [t])).toBe(1);
    expect(await deniedFor(t, "transactions:reverse")).toBe(1);

    /**
     * ⭐ Grant that one key and the same call reaches the reversal — so it
     * was that key, and only that key, that stopped it. (What the reversal
     * then does with a `purchase_invoices` row is Phase 2's business and
     * §④'s finding; the claim here is about the gate.)
     */
    await setOverrides(u, null);
    h.ctx = await contextFor(t, u);
    const allowed = await undoImportRun({ runId: run.runId });
    expect(allowed.ok).toBe(true);
    expect(await reversalsFor(t, run.runId)).toBe(1);

    await cleanupTenant(t);
  });

  /**
   * ⚠️ AND IT IS DERIVED PER RUN, NOT ASKED FOR BLANKET. The same revoke
   * that stops a `reverse-entry` undo must NOT stop a `delete` one — or
   * every workspace would have to hand `transactions:reverse` to whoever
   * does migrations, which weakens the control everywhere else.
   */
  it("does not ask for transactions:reverse on a run that posts nothing", async () => {
    const t = await freshTenant("no-ledger-perm");
    const u = await freshUser(t, { "transactions:reverse": false });

    const company = randomUUID();
    await asSuperuser((c) =>
      c.query(`INSERT INTO companies (id, tenant_id, name) VALUES ($1, $2, 'Held Co')`, [company, t]),
    );

    const entity = ALL_IMPORT_ENTITIES["opening-customer-invoices"];
    expect(entity.contract.reversal.kind).toBe("delete");

    const run = await beginRun({
      tenantId: t,
      userId: u,
      entityKey: "opening-customer-invoices",
      duplicateMode: "skip",
      expectedRows: 1,
      file: "inv-no-ledger",
    });

    await withTenant(t, async (tx) => {
      await writeRowWithLedger(tx, {
        tenantId: t,
        runId: run.runId,
        entityKey: "opening-customer-invoices",
        entity,
        inputRowNumber: 1,
        existingId: null,
        write: async (inner) => {
          const id = randomUUID();
          await inner.execute(sqlInsertInvoice(id, t, company, u, 1));
          return id;
        },
      });
    });

    h.ctx = await contextFor(t, u);
    const result = await undoImportRun({ runId: run.runId });

    /** Reached the reversal — the ledger key was never asked for. */
    expect(result.ok).toBe(true);
    expect(await reversalsFor(t, run.runId)).toBe(1);
    expect(await deniedFor(t, "transactions:reverse")).toBe(0);

    await cleanupTenant(t);
  });
});

/* ================================================================== */
/* ② A PARTIAL REACHES THE CALLER AS PARTIAL                           */
/* ================================================================== */

describe("a partial reversal, through the action", () => {
  /**
   * ⚠️ THE REVOKE BITES BECAUSE `ordence_app` IS NOT THE OWNER; in
   * production it is, and GRANT/REVOKE are inert there. What this proves
   * is the SHAPE the action gives back when the database refuses a row —
   * the same shape a foreign key, a period lock or an append-only trigger
   * produces, and those do bind the owner. (§④ below is exactly that case,
   * on this tree, for every undo.)
   */
  it("returns ok with status partial, names every row, and does NOT release the file claim", async () => {
    const t = await freshTenant("partial");
    const u = await freshUser(t);

    const company = randomUUID();
    await asSuperuser((c) =>
      c.query(`INSERT INTO companies (id, tenant_id, name) VALUES ($1, $2, 'Partial Co')`, [company, t]),
    );

    const entity = ALL_IMPORT_ENTITIES["opening-customer-invoices"];
    const run = await beginRun({
      tenantId: t,
      userId: u,
      entityKey: "opening-customer-invoices",
      duplicateMode: "skip",
      expectedRows: 4,
      file: "inv-partial",
    });

    await withTenant(t, async (tx) => {
      for (let i = 1; i <= 4; i += 1) {
        await writeRowWithLedger(tx, {
          tenantId: t,
          runId: run.runId,
          entityKey: "opening-customer-invoices",
          entity,
          inputRowNumber: i,
          existingId: null,
          write: async (inner) => {
            const id = randomUUID();
            await inner.execute(sqlInsertInvoice(id, t, company, u, i));
            return id;
          },
        });
      }
    });

    h.ctx = await contextFor(t, u);

    await asSuperuser((c) => c.query(`REVOKE DELETE ON sales_invoices FROM ordence_app`));
    let result;
    try {
      result = await undoImportRun({ runId: run.runId });
    } finally {
      await asSuperuser((c) => c.query(`GRANT DELETE ON sales_invoices TO ordence_app`));
    }

    /**
     * 🔴 `ok: true`, NOT AN ERROR. A partial is not a failure to report —
     * it is a report, and it is the one the customer must read. Turning it
     * into `{ ok: false, error }` would throw away the names and leave them
     * with a number, which is the sentence this subsystem exists to
     * prevent.
     */
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(result.data.status).toBe("partial");
    expect(result.data.rowsConsidered).toBe(4);
    expect(result.data.rowsReversed).toBe(0);
    expect(result.data.rowsUnreversed).toBe(4);

    /** Every one of them named, with what blocked it. */
    expect(result.data.failures).toHaveLength(4);
    expect(result.data.failures.map((f) => f.inputRowNumber).sort()).toEqual([1, 2, 3, 4]);
    for (const failure of result.data.failures) {
      expect(failure.targetTable).toBe("sales_invoices");
      expect(failure.targetId).not.toBeNull();
      expect(failure.blockedBy).toMatch(/permission denied/i);
      expect(failure.sqlstate).toBe("42501");
    }
    /** The count and the names agree — 0208 §4, arriving at the caller. */
    expect(
      await countOf("import_reversal_failures", "tenant_id = $1", [t]),
    ).toBe(result.data.rowsUnreversed);

    /**
     * 🔴🔴 AND THE CLAIM ON THE FILE IS NOT RELEASED. This is the line that
     * protects the customer: the four rows are still there, so importing
     * the same file again must still be refused rather than matching them
     * as "already here" and never looking at them again.
     */
    expect(await supersededAt(run.runId)).toBeNull();
    expect(await countOf("sales_invoices", "tenant_id = $1", [t])).toBe(4);

    /** The audit row records the partial as a warning, with the names in it. */
    expect(await auditFor(t, run.runId)).toBe(1);
    await asSuperuser(async (c) => {
      const { rows } = await c.query(
        `SELECT severity, reason, metadata FROM audit_logs
          WHERE tenant_id = $1 AND resource_id = $2`,
        [t, run.runId],
      );
      expect(rows[0].severity).toBe("warning");
      expect(rows[0].reason).toContain("could NOT be undone");
      expect(rows[0].metadata.outcome).toBe("partial");
      expect(rows[0].metadata.unreversed).toHaveLength(4);
    });

    await cleanupTenant(t);
  });
});

/* ================================================================== */
/* ③ THE REFUSAL IS AUDITED                                            */
/* ================================================================== */

describe("an irreversible refusal", () => {
  /**
   * ⚠️ NO REGISTERED ENTITY DECLARES `irreversible`, and the case must
   * still be proved. The contract below is built in the test and is NOT in
   * `ALL_IMPORT_ENTITIES`; the reversal reads the kind from the provenance
   * rows, so it behaves exactly as a registered entity's would.
   */
  const irreversibleEntity = {
    ...ALL_IMPORT_ENTITIES.companies,
    contract: {
      ...ALL_IMPORT_ENTITIES.companies.contract,
      reversal: {
        kind: "irreversible" as const,
        escapes:
          "The welcome email has already been sent to every contact in this file. " +
          "Removing the records does not un-send it.",
        because: "Test fixture for the fourth reversal kind. Not registered.",
      },
    },
  } as ContractedImportEntity;

  it("is recorded in audit_logs, because a refusal nobody recorded is nobody having tried", async () => {
    const t = await freshTenant("irreversible");
    const u = await freshUser(t);

    const run = await beginRun({
      tenantId: t,
      userId: u,
      entityKey: "companies",
      duplicateMode: "skip",
      expectedRows: 1,
      file: "companies-irreversible",
    });
    await asSuperuser((c) =>
      c.query(`UPDATE import_runs SET reversal_escapes = $1 WHERE id = $2`, [
        irreversibleEntity.contract.reversal.escapes,
        run.runId,
      ]),
    );

    const created = randomUUID();
    await withTenant(t, async (tx) => {
      await writeRowWithLedger(tx, {
        tenantId: t,
        runId: run.runId,
        entityKey: "companies",
        entity: irreversibleEntity,
        inputRowNumber: 1,
        existingId: null,
        write: async (inner) => {
          await inner.execute(
            sqlRaw(
              `INSERT INTO companies (id, tenant_id, name) VALUES ('${created}', '${t}', 'Sent An Email Ltd')`,
            ),
          );
          return created;
        },
      });
    });

    h.ctx = await contextFor(t, u);
    expect(await auditFor(t, run.runId)).toBe(0);

    const result = await undoImportRun({ runId: run.runId });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.status).toBe("refused");
    expect(result.data.rowsReversed).toBe(0);
    expect(result.data.message).toContain("welcome email");

    /** 🔴 THE ROW SOMEBODY WILL LOOK FOR. */
    expect(await auditFor(t, run.runId)).toBe(1);
    await asSuperuser(async (c) => {
      const { rows } = await c.query(
        `SELECT action, actor_email, severity, reason, metadata FROM audit_logs
          WHERE tenant_id = $1 AND resource_id = $2`,
        [t, run.runId],
      );
      expect(rows[0].action).toBe("delete");
      expect(rows[0].severity).toBe("warning");
      expect(rows[0].reason).toContain("welcome email");
      expect(rows[0].metadata.outcome).toBe("refused");
      /** It names the human, which is the whole reason to look here. */
      expect(rows[0].actor_email).toContain("@wave2b.invalid");
    });

    /** And the record it refused to touch is still there. */
    expect(await countOf("companies", "id = $1", [created])).toBe(1);

    await cleanupTenant(t);
  });

  /** A run that is not in this workspace is a probe, and it is recorded too. */
  it("records an undo aimed at a run this workspace does not have", async () => {
    const t = await freshTenant("stranger");
    const u = await freshUser(t);
    h.ctx = await contextFor(t, u);

    const stranger = randomUUID();
    const result = await undoImportRun({ runId: stranger });

    expect(result.ok).toBe(false);
    expect(await auditFor(t, stranger)).toBe(1);

    await cleanupTenant(t);
  });
});

/* ================================================================== */
/* ④ ⭐ THE FINDING, NOW FIXED: 0215 REFUSED WHAT 0205 EXISTS TO PERMIT */
/* ================================================================== */

describe("the import pack, as it now ships, permits an undo to complete", () => {
  /**
   * ══════════════════════════════════════════════════════════════════════
   * 🔴 WHAT THIS SECTION FOUND, AND WHAT WAS DONE ABOUT IT
   * ══════════════════════════════════════════════════════════════════════
   * Phase 2 and Phase 3 each wrote `import_row_provenance` without seeing
   * the other, and each gave it an update rule:
   *
   *   0205 `import_row_provenance_immutable` — every evidential column is
   *        frozen EXCEPT `reversed_at` and `reversal_id`, which is exactly
   *        how a reversal marks a row undone, in the same transaction as
   *        the undo.
   *
   *   0215 `import_row_provenance_is_append_only` — RAISE EXCEPTION on
   *        BEFORE UPDATE, unconditionally, for every role.
   *
   * Two different trigger NAMES on one table, so the second did not
   * replace the first — it sat beside it and refused first. Applied as the
   * ordered pack, NO undo of any kind could complete: every one reported
   * `partial`, 0 of N, SQLSTATE 23001, and correctly kept the file claimed
   * forever. This section proved it by induction from both sides.
   *
   * ⭐ WAVE 4 INTEGRATION RECONCILED THE TWO FILES. 0215 no longer creates
   * the table and no longer carries the blanket trigger; it keeps only the
   * change-log decision, and refuses if the blanket trigger is found. The
   * shape that ships is 0205's, because that is the one
   * `db/schema/import-runs.ts` declares and `server/import/reversal.ts`
   * writes.
   *
   * ⚠️ THE TEST IS INVERTED, NOT DELETED, AND THE INDUCTION IS KEPT. It now
   * proves the undo completes as shipped, AND re-creates the superseded
   * trigger to prove the failure was real and would be caught again. A
   * finding that is merely deleted once fixed is a finding that can come
   * back quietly.
   */
  const BLANKET = "import_row_provenance_no_update";

  async function triggersOnProvenance(): Promise<string[]> {
    return asSuperuser(async (c) => {
      const { rows } = await c.query(
        `SELECT tgname FROM pg_trigger
          WHERE tgrelid = 'public.import_row_provenance'::regclass AND NOT tgisinternal
          ORDER BY tgname`,
      );
      return rows.map((r: { tgname: string }) => r.tgname);
    });
  }

  async function undoThreeInvoices(label: string) {
    const t = await freshTenant(label);
    const u = await freshUser(t);
    const company = randomUUID();
    await asSuperuser((c) =>
      c.query(`INSERT INTO companies (id, tenant_id, name) VALUES ($1, $2, 'Pack Co')`, [company, t]),
    );

    const entity = ALL_IMPORT_ENTITIES["opening-customer-invoices"];
    const run = await beginRun({
      tenantId: t,
      userId: u,
      entityKey: "opening-customer-invoices",
      duplicateMode: "skip",
      expectedRows: 3,
      file: `pack-${label}`,
    });

    await withTenant(t, async (tx) => {
      for (let i = 1; i <= 3; i += 1) {
        await writeRowWithLedger(tx, {
          tenantId: t,
          runId: run.runId,
          entityKey: "opening-customer-invoices",
          entity,
          inputRowNumber: i,
          existingId: null,
          write: async (inner) => {
            const id = randomUUID();
            await inner.execute(sqlInsertInvoice(id, t, company, u, i));
            return id;
          },
        });
      }
    });

    h.ctx = await contextFor(t, u);
    const result = await undoImportRun({ runId: run.runId });
    return { t, runId: run.runId, result };
  }

  it("undoes 3 of 3 with the pack as it now ships", async () => {
    const triggers = await triggersOnProvenance();
    /** 0205's trigger is the one that survived, and it is still there. */
    expect(triggers).toContain("import_row_provenance_immutable");
    /** The blanket trigger is gone, and its absence is the fix. */
    expect(triggers).not.toContain(BLANKET);

    const freed = await undoThreeInvoices("pack-shipped");
    expect(freed.result.ok).toBe(true);
    if (!freed.result.ok) throw new Error("unreachable");
    expect(freed.result.data.status).toBe("reversed");
    expect(freed.result.data.rowsReversed).toBe(3);
    expect(freed.result.data.rowsUnreversed).toBe(0);
    expect(await countOf("sales_invoices", "tenant_id = $1", [freed.t])).toBe(0);
    /** A COMPLETE undo releases the claim — the other half of the rule. */
    expect(await supersededAt(freed.runId)).not.toBeNull();
    await cleanupTenant(freed.t);
  });

  it("and the superseded trigger, re-created, still breaks every undo — so the fix is load-bearing", async () => {
    await asSuperuser((c) =>
      c.query(
        `CREATE OR REPLACE FUNCTION public.import_row_provenance_is_append_only()
         RETURNS trigger LANGUAGE plpgsql AS $fn$
         BEGIN
           RAISE EXCEPTION 'import_row_provenance is append-only. Row %', OLD.id
             USING ERRCODE = 'restrict_violation';
         END $fn$`,
      ),
    );
    await asSuperuser((c) =>
      c.query(
        `CREATE TRIGGER ${BLANKET} BEFORE UPDATE ON public.import_row_provenance
           FOR EACH ROW EXECUTE FUNCTION public.import_row_provenance_is_append_only()`,
      ),
    );

    try {
      const blocked = await undoThreeInvoices("pack-superseded");
      expect(blocked.result.ok).toBe(true);
      if (!blocked.result.ok) throw new Error("unreachable");
      expect(blocked.result.data.status).toBe("partial");
      expect(blocked.result.data.rowsReversed).toBe(0);
      expect(blocked.result.data.rowsUnreversed).toBe(3);
      for (const failure of blocked.result.data.failures) {
        expect(failure.sqlstate).toBe("23001");
        expect(failure.blockedBy).toContain("append-only");
      }
      /** The rows stay, and the file stays claimed. Both are correct. */
      expect(await countOf("sales_invoices", "tenant_id = $1", [blocked.t])).toBe(3);
      expect(await supersededAt(blocked.runId)).toBeNull();
      await cleanupTenant(blocked.t);
    } finally {
      await asSuperuser((c) => c.query(`DROP TRIGGER ${BLANKET} ON public.import_row_provenance`));
      await asSuperuser((c) =>
        c.query(`DROP FUNCTION IF EXISTS public.import_row_provenance_is_append_only()`),
      );
    }

    expect(await triggersOnProvenance()).not.toContain(BLANKET);
  });
});
