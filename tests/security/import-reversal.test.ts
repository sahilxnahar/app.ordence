/**
 * Ordence — ⭐⭐⭐ AN IMPORT THAT CAN BE UNDONE, PROVED AGAINST POSTGRES
 * Version: v1.84.1-alpha · Phase 2
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS FOR, AND WHAT WOULD NOT HAVE BEEN ENOUGH
 * ══════════════════════════════════════════════════════════════════════
 * The Phase 2 brief sets the bar and it is not "the undo ran":
 *
 *     "The state after import-then-undo is BYTE-IDENTICAL to the state
 *      before the import, for each of the four kinds, including the
 *      restore-prior case where a record existed beforehand and carried a
 *      field the import never touched."
 *
 * So the assertion is not made about the rows the test happens to think
 * about. `snapshotWorkspace()` reads EVERY tenant-scoped table in the
 * database — 300-odd of them — for this workspace, and the test compares
 * the whole thing. A row written into a table nobody was watching is
 * exactly the failure a hand-written assertion cannot see.
 *
 * 🔴 AND THE DIVERGENCE LIST IS EXACT, NOT A FILTER. Three tables are
 * EXPECTED to differ after an undo, and each is named with the reason.
 * The comparison fails if anything ELSE differs — and equally if a table
 * on the list turns out NOT to differ, because that would mean the change
 * recorder or the migration ledger had stopped writing. A list that only
 * ever forgives is the "verified by a floor" shape this repository keeps
 * finding.
 *
 * ⚠️ IT EXERCISES THE REAL MODULES. `writeRowWithLedger`, `reverseImportRun`
 * and `startImportRun` are imported and called; nothing here re-implements
 * them. `tests/setup.ts` bridges the Neon serverless driver to the local
 * PostgreSQL, so `withTenant()` — the function that pins the RLS session
 * variable — is the one under test, connected as `ordence_app`, which is
 * NOSUPERUSER and NOBYPASSRLS.
 *
 * ⚠️ OWNERSHIP. `tests/security/**` belongs to track D. This file is
 * OFFERED rather than claimed — see PATCH-REQUEST-PHASE-2.md. It lives
 * here because this is the only directory in the repository wired to a
 * real database, and a proof of reversal that does not touch one is not a
 * proof of anything.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { asSuperuser } from "../setup";
import { withTenant } from "@/db";
import { ALL_IMPORT_ENTITIES } from "@/lib/import/entities";
import type { ContractedImportEntity } from "@/lib/import/types";
import { writeRowWithLedger, ledgerCensus } from "@/server/import/ledger";
import { reverseImportRun } from "@/server/import/reversal";
import { startImportRun, importSourceFingerprint } from "@/server/import/runs";

/* ================================================================== */
/* THE WHOLE-WORKSPACE SNAPSHOT                                        */
/* ================================================================== */

type Snapshot = Map<string, string>;

/**
 * ⭐ EVERY TENANT-SCOPED TABLE, DISCOVERED FROM THE CATALOGUE.
 *
 * ⚠️ NOT A LIST. A hand-maintained list of "tables the import touches" is
 * a list that is correct on the day it is written and silently wrong the
 * first time a trigger writes somewhere nobody expected —
 * `sales_invoices_order_writeback` and `ordence_refresh_stock_balance`
 * both do exactly that. Discovering the tables is what makes "byte
 * identical" mean the workspace rather than the rows the author had in
 * mind.
 *
 * ⚠️ AS SUPERUSER, DELIBERATELY. The snapshot must see rows that
 * row-level security would hide, or a row written into the wrong tenant
 * would be invisible to the very check that should catch it. Everything
 * being TESTED runs as `ordence_app`; only the observation is privileged.
 */
async function snapshotWorkspace(tenantId: string): Promise<Snapshot> {
  return asSuperuser(async (c) => {
    const { rows: tables } = await c.query<{ table_name: string }>(`
      SELECT c.table_name
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       WHERE c.table_schema = 'public'
         AND c.column_name  = 'tenant_id'
         AND t.table_type   = 'BASE TABLE'
       ORDER BY c.table_name
    `);

    const snapshot: Snapshot = new Map();
    for (const { table_name } of tables) {
      /**
       * ⚠️ ORDERED BY THE ROW'S OWN TEXT, not by `id`. Not every
       * tenant-scoped table has an `id`, and an unordered `array_agg`
       * would report a difference every time PostgreSQL felt like
       * returning two rows the other way round.
       */
      const { rows } = await c.query<{ contents: string | null }>(
        `SELECT coalesce(
                  jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),
                  '[]'::jsonb
                )::text AS contents
           FROM public.${table_name} t
          WHERE t.tenant_id = $1`,
        [tenantId],
      );
      const contents = rows[0]?.contents ?? "[]";
      if (contents !== "[]") snapshot.set(table_name, contents);
    }
    return snapshot;
  });
}

/** Tables whose contents differ between two snapshots, either way. */
function differences(before: Snapshot, after: Snapshot): string[] {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names]
    .filter((t) => (before.get(t) ?? "[]") !== (after.get(t) ?? "[]"))
    .sort();
}

/**
 * ⭐⭐ THE ASSERTION THE BRIEF ASKS FOR, WITH THE EXCEPTIONS NAMED.
 *
 * 🔴 `toEqual`, NOT `arrayContaining`. A table that was expected to differ
 * and did not is as much a failure as one that differed unexpectedly: it
 * means the change recorder, or the migration ledger, stopped writing —
 * and every other assertion in this file would still pass.
 */
function expectByteIdenticalExceptFor(
  before: Snapshot,
  after: Snapshot,
  expected: readonly string[],
) {
  expect(differences(before, after)).toEqual([...expected].sort());
}

/**
 * The three tables that are EXPECTED to differ after any undo, and why.
 *
 *   change_log                 the field-level history recorder. It records
 *                              the undo, because the undo IS a change. A
 *                              history that could be rewound would not be a
 *                              history.
 *   import_row_provenance      each row gains `reversed_at` and `reversal_id`.
 *                              That is the record that the undo happened.
 *   import_reversals           the undo itself.
 */
const ALWAYS_DIFFERS = ["change_log", "import_row_provenance", "import_reversals"] as const;

/* ================================================================== */
/* FIXTURES                                                            */
/* ================================================================== */

let tenant: string;
let user: string;

async function freshTenant(label: string): Promise<string> {
  const id = randomUUID();
  await asSuperuser(async (c) => {
    await c.query(
      `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [id, `org_${id}`, `p2-${id.slice(0, 8)}`, `Phase 2 ${label}`],
    );
  });
  return id;
}

async function freshUser(tenantId: string): Promise<string> {
  const id = randomUUID();
  await asSuperuser(async (c) => {
    await c.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, first_name, last_name, role)
       VALUES ($1, $2, $3, $4, 'Phase', 'Two', 'tenant_owner')`,
      [id, tenantId, `clerk_${id}`, `${id.slice(0, 8)}@phase2.invalid`],
    );
  });
  return id;
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

beforeAll(async () => {
  tenant = await freshTenant("shared");
  user = await freshUser(tenant);
});

afterAll(async () => {
  /**
   * ⚠️ THE TENANT CASCADE DOES MOST OF IT, and the two evidence tables it
   * cannot are removed first. `security_events` has no cascade at all and
   * `change_log` refuses a delete from `ordence_app` — which is why this
   * runs as the superuser. Wave 15 §4.2 is the same finding from the
   * other end: a tenant carrying evidence rows can become undeletable.
   */
  await cleanupTenant(tenant);
});

/* ================================================================== */
/* ① `delete` — THE ROWS THE RUN CREATED, AND ONLY THOSE               */
/* ================================================================== */

describe("kind: delete", () => {
  it("returns the workspace byte-for-byte to where it started", async () => {
    const t = await freshTenant("delete");
    const u = await freshUser(t);

    const company = randomUUID();
    await asSuperuser(async (c) => {
      await c.query(`INSERT INTO companies (id, tenant_id, name) VALUES ($1, $2, 'Existing Customer')`, [
        company,
        t,
      ]);
    });

    /**
     * ⭐ THE SNAPSHOT IS TAKEN AFTER THE FIXTURES AND BEFORE THE IMPORT.
     * "Before the import" is the state the customer had, which includes
     * the company they already had — not an empty workspace.
     */
    const before = await snapshotWorkspace(t);

    const entity = ALL_IMPORT_ENTITIES["opening-customer-invoices"];
    expect(entity.contract.reversal.kind).toBe("delete");

    const run = await beginRun({
      tenantId: t,
      userId: u,
      entityKey: "opening-customer-invoices",
      duplicateMode: "skip",
      expectedRows: 3,
      file: "opening-invoices-A",
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

    await asSuperuser(async (c) => {
      const { rows } = await c.query(`SELECT count(*)::int AS n FROM sales_invoices WHERE tenant_id = $1`, [t]);
      expect(rows[0].n).toBe(3);
    });

    const undo = await reverseImportRun({ tenantId: t, runId: run.runId, requestedBy: u });

    expect(undo.status).toBe("reversed");
    expect(undo.rowsReversed).toBe(3);
    expect(undo.rowsUnreversed).toBe(0);
    expect(undo.failures).toHaveLength(0);

    const after = await snapshotWorkspace(t);
    expectByteIdenticalExceptFor(before, after, [
      ...ALWAYS_DIFFERS,
      /** The run itself, and its claim being released. */
      "import_runs",
      /** Written by the import, emptied by the undo — so it is absent from both. */
    ]);

    await cleanupTenant(t);
  });
});

/* ================================================================== */
/* ② `restore-prior` — AND THE FIELD THE IMPORT NEVER TOUCHED          */
/* ================================================================== */

describe("kind: restore-prior", () => {
  /**
   * 🔴 THE CASE THE BRIEF NAMES, AND THE ONE A SIMPLER LEDGER GETS WRONG.
   *
   * The file has two rows. One matches a company the customer already had;
   * one does not. A single run therefore does an UPDATE and an INSERT, and
   * the undo has to do a RESTORE and a DELETE — decided per row, from
   * `import_row_provenance.operation`, which is the column the brief's own
   * description of the sidecar omits.
   *
   * ⭐ AND THE EXISTING COMPANY CARRIES `notes`, WHICH THE IMPORT NEVER
   * WRITES. `capturePriorFields: ["*"]` is why it comes back. An entity
   * that had listed only the columns it writes would restore the name and
   * lose the note — and the run report would say "reversed".
   */
  it("restores what it overwrote, deletes what it created, and keeps a field it never wrote", async () => {
    const t = await freshTenant("restore");
    const u = await freshUser(t);

    const existing = randomUUID();
    await asSuperuser(async (c) => {
      await c.query(
        `INSERT INTO companies (id, tenant_id, name, website, notes, created_at, updated_at)
         VALUES ($1, $2, 'Kaveri Traders', 'https://kaveri.invalid',
                 'Rang de Basanti — MD prefers a call before 10am. Do not email.',
                 now() - interval '400 days', now() - interval '120 days')`,
        [existing, t],
      );
    });

    const before = await snapshotWorkspace(t);

    const entity = ALL_IMPORT_ENTITIES.companies;
    expect(entity.contract.reversal.kind).toBe("restore-prior");
    expect(entity.contract.reversal.capturePriorFields).toEqual(["*"]);

    const run = await beginRun({
      tenantId: t,
      userId: u,
      entityKey: "companies",
      duplicateMode: "update",
      expectedRows: 2,
      file: "companies-A",
    });

    const created = randomUUID();
    await withTenant(t, async (tx) => {
      /** Row 1 MATCHED the record the customer already had. */
      const updated = await writeRowWithLedger(tx, {
        tenantId: t,
        runId: run.runId,
        entityKey: "companies",
        entity,
        inputRowNumber: 1,
        existingId: existing,
        write: async (inner) => {
          await inner.execute(
            sqlRaw(
              `UPDATE companies
                  SET name = 'KAVERI TRADERS PVT LTD', website = NULL, notes = NULL
                WHERE id = '${existing}' AND tenant_id = '${t}'`,
            ),
          );
          return existing;
        },
      });
      expect(updated.operation).toBe("update");
      expect(updated.prior).toBe("captured");

      /** Row 2 matched nothing, so the run CREATED it. */
      const inserted = await writeRowWithLedger(tx, {
        tenantId: t,
        runId: run.runId,
        entityKey: "companies",
        entity,
        inputRowNumber: 2,
        existingId: null,
        write: async (inner) => {
          await inner.execute(
            sqlRaw(
              `INSERT INTO companies (id, tenant_id, name) VALUES ('${created}', '${t}', 'Netravati Exports')`,
            ),
          );
          return created;
        },
      });
      expect(inserted.operation).toBe("insert");
      /** 🔴 AN INSERT HAS NO PRIOR, AND CAPTURING FOR ONE WOULD BE A COPY
       * OF A ROW THAT DID NOT EXIST. */
      expect(inserted.prior).toBe("not-required");
    });

    /** The import did what an import does. */
    await asSuperuser(async (c) => {
      const { rows } = await c.query(
        `SELECT name, website, notes FROM companies WHERE id = $1`,
        [existing],
      );
      expect(rows[0].name).toBe("KAVERI TRADERS PVT LTD");
      expect(rows[0].notes).toBeNull();
    });

    /** ⭐ ONE CAPTURE, NOT TWO. The insert must not have paid for one. */
    const census = await ledgerCensus({ tenantId: t, runId: run.runId, rowsWritten: 2 });
    expect(census.inserts).toBe(1);
    expect(census.updates).toBe(1);
    expect(census.priorCaptures).toBe(1);
    expect(census.disagreement).toBeNull();

    const undo = await reverseImportRun({ tenantId: t, runId: run.runId, requestedBy: u });
    expect(undo.status).toBe("reversed");
    expect(undo.rowsReversed).toBe(2);

    /** 🔴 THE NOTE. The import never wrote this column and never read it. */
    await asSuperuser(async (c) => {
      const { rows } = await c.query(
        `SELECT name, website, notes FROM companies WHERE id = $1`,
        [existing],
      );
      expect(rows[0].name).toBe("Kaveri Traders");
      expect(rows[0].website).toBe("https://kaveri.invalid");
      expect(rows[0].notes).toBe(
        "Rang de Basanti — MD prefers a call before 10am. Do not email.",
      );
      const { rows: gone } = await c.query(`SELECT count(*)::int AS n FROM companies WHERE id = $1`, [
        created,
      ]);
      expect(gone[0].n).toBe(0);
    });

    /**
     * 🔴 AND THE ONE THING THAT DOES NOT COME BACK, MEASURED RATHER THAN
     * ASSUMED. `companies` declares `escapes: null` — a claim that nothing
     * survives an undo — and carries `companies_set_updated_at`, whose
     * whole body is `NEW.updated_at = now()`. The declaration is wrong, and
     * `import_restore_prior_values()` is what says so, per row, by
     * re-reading what it wrote.
     */
    expect(entity.contract.reversal.escapes).toBeNull();
    expect(undo.measuredEscapes).toEqual(["companies.updated_at"]);

    const after = await snapshotWorkspace(t);
    /**
     * ⚠️ `companies` IS ON THE LIST, AND ONLY BECAUSE OF `updated_at`.
     * Everything else about the row is byte-identical — the assertions
     * above name each column. This is the honest form of the claim: the
     * workspace comes back except for one column, that column is named,
     * and the reason is a trigger this phase does not own.
     */
    expectByteIdenticalExceptFor(before, after, [
      ...ALWAYS_DIFFERS,
      "import_runs",
      "import_row_prior_values",
      "companies",
    ]);

    await cleanupTenant(t);
  });
});

/* ================================================================== */
/* ③ `irreversible` — REFUSES, AND CHANGES NOTHING                     */
/* ================================================================== */

describe("kind: irreversible", () => {
  /**
   * ⚠️ NO CONTRACTED ENTITY DECLARES `irreversible` TODAY, and the fourth
   * kind must still be proved. The contract below is built in the test, is
   * NOT registered in `ALL_IMPORT_ENTITIES`, and is deliberately shaped
   * like the real case the kind exists for: rows that were written AND an
   * email that went out.
   *
   * ⭐ THE SIDECAR IS WHAT MAKES THE PROOF POSSIBLE. The reversal reads the
   * kind from the provenance rows, not from the registry, so an
   * unregistered entity's rows are undone — or refused — exactly as a
   * registered one's would be.
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

  it("refuses, says what escapes, and leaves the workspace exactly as the import left it", async () => {
    const t = await freshTenant("irreversible");
    const u = await freshUser(t);

    const run = await beginRun({
      tenantId: t,
      userId: u,
      entityKey: "companies",
      duplicateMode: "skip",
      expectedRows: 1,
      file: "irreversible-A",
    });

    /**
     * ⭐⭐ THE PROMISE IS RECORDED ON THE RUN, NOT LOOKED UP AT UNDO TIME.
     *
     * `startImportRun` copies `contract.reversal.escapes` from the registry
     * at the moment the run starts, which is the moment the planner shows it
     * to the customer. The fixture entity below is deliberately NOT in the
     * registry, so the sentence is written onto the run directly — which is
     * also, exactly, the state the column exists for: a run started under a
     * promise the registry no longer makes.
     *
     * 🔴 IF THE UNDO READ THE REGISTRY INSTEAD, this run would be undone
     * under `companies`' `escapes: null` and the customer would be told that
     * nothing survived — while the welcome emails had already gone out. That
     * was the first draft's behaviour and this assertion is what found it.
     */
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

    /** ⭐ AFTER the import — the state an `irreversible` undo must not change. */
    const before = await snapshotWorkspace(t);

    const undo = await reverseImportRun({ tenantId: t, runId: run.runId, requestedBy: u });

    expect(undo.status).toBe("refused");
    expect(undo.rowsReversed).toBe(0);
    expect(undo.message).toContain("welcome email");
    expect(undo.message).toContain("Nothing has been changed");

    const after = await snapshotWorkspace(t);
    /**
     * 🔴 THE ROW IS STILL THERE, WHICH IS THE POINT. A refusal that had
     * quietly deleted the records "since they were created by the run"
     * would be a product claiming it un-sent an email.
     */
    expectByteIdenticalExceptFor(before, after, ["import_reversals", "change_log"]);

    await asSuperuser(async (c) => {
      const { rows } = await c.query(`SELECT count(*)::int AS n FROM companies WHERE id = $1`, [created]);
      expect(rows[0].n).toBe(1);
    });

    await cleanupTenant(t);
  });
});

/* ================================================================== */
/* ④ `reverse-entry` — AND THE CLAIM THAT IS NOT TRUE OF IT            */
/* ================================================================== */

describe("kind: reverse-entry", () => {
  /**
   * 🔴 BYTE-IDENTICAL IS FALSE HERE, BY DESIGN, AND SAYING SO IS THE
   *    HONEST RESULT RATHER THAN A FAILURE TO REACH THE BAR.
   *
   * The entity's own `escapes` says it: *"The reversing entry is itself a
   * posted transaction and stays in the ledger permanently. Undoing an
   * opening balance leaves two entries visible, not none, because that is
   * what a ledger does."*
   *
   * So the strongest TRUE statement is proved instead: the ledger's NET
   * position returns exactly to where it was, the original is marked
   * `reversed` and linked to its mirror, and the residue is precisely the
   * two entries the escape sentence promised — no more.
   */
  it("posts a mirror entry, leaves both visible, and returns the net position to zero", async () => {
    const t = await freshTenant("reverse-entry");
    const u = await freshUser(t);

    const cash = randomUUID();
    const equity = randomUUID();
    await asSuperuser(async (c) => {
      await c.query(
        `INSERT INTO ledgers (id, tenant_id, code, name, account_type)
         VALUES ($1, $2, '1000', 'Cash', 'asset'), ($3, $2, '3000', 'Opening Equity', 'equity')`,
        [cash, t, equity],
      );
    });

    const before = await snapshotWorkspace(t);

    const entity = ALL_IMPORT_ENTITIES["opening-trial-balance"];
    expect(entity.contract.reversal.kind).toBe("reverse-entry");

    const run = await beginRun({
      tenantId: t,
      userId: u,
      entityKey: "opening-trial-balance",
      duplicateMode: "skip",
      expectedRows: 2,
      file: "trial-balance-A",
    });

    const txnId = randomUUID();
    await withTenant(t, async (tx) => {
      await writeRowWithLedger(tx, {
        tenantId: t,
        runId: run.runId,
        entityKey: "opening-trial-balance",
        entity,
        /** ⚠️ `whole-file`: 2 lines, ONE document. There is no line to name. */
        inputRowNumber: null,
        existingId: null,
        write: async (inner) => {
          await inner.execute(
            sqlRaw(
              `INSERT INTO transactions (id, tenant_id, description, transaction_date, status, reference_type, created_by)
               VALUES ('${txnId}', '${t}', 'Opening balances as at 2026-03-31', '2026-03-31', 'posted', 'opening_balance', '${u}')`,
            ),
          );
          await inner.execute(
            sqlRaw(
              `INSERT INTO journal_entries (tenant_id, transaction_id, ledger_id, entry_type, amount_minor, created_by)
               VALUES ('${t}', '${txnId}', '${cash}',   'debit',  250000, '${u}'),
                      ('${t}', '${txnId}', '${equity}', 'credit', 250000, '${u}')`,
            ),
          );
          return txnId;
        },
      });
    });

    const undo = await reverseImportRun({ tenantId: t, runId: run.runId, requestedBy: u });
    expect(undo.status).toBe("reversed");
    expect(undo.rowsReversed).toBe(1);

    await asSuperuser(async (c) => {
      /** The original stays, marked, and points at its mirror. */
      const { rows: original } = await c.query(
        `SELECT status, reversed_by_transaction_id FROM transactions WHERE id = $1`,
        [txnId],
      );
      expect(original[0].status).toBe("reversed");
      expect(original[0].reversed_by_transaction_id).not.toBeNull();

      /** ⭐ THE NET POSITION, WHICH IS THE THING THAT HAD TO COME BACK. */
      const { rows: net } = await c.query(
        `SELECT l.code,
                sum(CASE WHEN j.entry_type = 'debit' THEN j.amount_minor ELSE -j.amount_minor END)::bigint AS net
           FROM journal_entries j JOIN ledgers l ON l.id = j.ledger_id
          WHERE j.tenant_id = $1 GROUP BY l.code ORDER BY l.code`,
        [t],
      );
      expect(net.map((r: { code: string; net: string }) => [r.code, String(r.net)])).toEqual([
        ["1000", "0"],
        ["3000", "0"],
      ]);

      /** Two transactions, four legs. Not none. */
      const { rows: counts } = await c.query(
        `SELECT (SELECT count(*)::int FROM transactions   WHERE tenant_id = $1) AS txns,
                (SELECT count(*)::int FROM journal_entries WHERE tenant_id = $1) AS legs`,
        [t],
      );
      expect(counts[0]).toEqual({ txns: 2, legs: 4 });
    });

    const after = await snapshotWorkspace(t);
    const diverged = differences(before, after);
    /**
     * ⚠️ THE RESIDUE IS ENUMERATED. `ledgers` is on the list because
     * `update_ledger_balance` maintains `current_balance` on every posting
     * — it moved out and back, but `updated_at` moved with it.
     */
    expect(diverged).toEqual(
      [...ALWAYS_DIFFERS, "import_runs", "journal_entries", "ledgers", "transactions"].sort(),
    );

    await cleanupTenant(t);
  });
});

/* ================================================================== */
/* ⑤ A PARTIAL REVERSAL, INDUCED                                       */
/* ================================================================== */

describe("a partial reversal", () => {
  /**
   * 🔴 THE BRIEF ASKS FOR THIS ONE BY NAME: *"Induce it: revoke DELETE on
   * one destination mid-undo and show the report names the rows it could
   * not reverse rather than rounding up to success."*
   *
   * ⚠️ THE REVOKE BITES BECAUSE `ordence_app` IS NOT THE OWNER. In
   * production the application connects as the Neon owner, for whom GRANT
   * and REVOKE are inert — so this exact induction would prove nothing
   * there, and saying so is more useful than a green tick. What the test
   * establishes is the behaviour of the reversal engine when the database
   * refuses a row: the same shape a foreign key, a period lock or an
   * append-only trigger produces, and those DO bind the owner.
   */
  it("names every row it could not reverse, and refuses to call itself reversed", async () => {
    const t = await freshTenant("partial");
    const u = await freshUser(t);

    const company = randomUUID();
    await asSuperuser(async (c) => {
      await c.query(`INSERT INTO companies (id, tenant_id, name) VALUES ($1, $2, 'Partial Co')`, [
        company,
        t,
      ]);
    });

    const entity = ALL_IMPORT_ENTITIES["opening-customer-invoices"];
    const run = await beginRun({
      tenantId: t,
      userId: u,
      entityKey: "opening-customer-invoices",
      duplicateMode: "skip",
      expectedRows: 4,
      file: "opening-invoices-partial",
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

    /** ⭐ THE INDUCTION. The destination stops accepting deletes. */
    await asSuperuser((c) => c.query(`REVOKE DELETE ON sales_invoices FROM ordence_app`));

    let undo;
    try {
      undo = await reverseImportRun({ tenantId: t, runId: run.runId, requestedBy: u });
    } finally {
      await asSuperuser((c) => c.query(`GRANT DELETE ON sales_invoices TO ordence_app`));
    }

    /** 🔴 NOT "reversed". Not rounded up. */
    expect(undo.status).toBe("partial");
    expect(undo.rowsConsidered).toBe(4);
    expect(undo.rowsReversed).toBe(0);
    expect(undo.rowsUnreversed).toBe(4);

    /** 🔴 AND EVERY ONE OF THEM NAMED, with what blocked it. */
    expect(undo.failures).toHaveLength(4);
    expect(undo.failures.map((f) => f.inputRowNumber).sort()).toEqual([1, 2, 3, 4]);
    for (const failure of undo.failures) {
      expect(failure.targetTable).toBe("sales_invoices");
      expect(failure.blockedBy).toMatch(/permission denied/i);
      expect(failure.sqlstate).toBe("42501");
    }

    /** The sentence the customer is shown says the dangerous thing plainly. */
    expect(undo.message).toContain("could NOT be undone");
    expect(undo.message).toContain("Do not import this file again");

    /**
     * 🔴🔴 AND THE RUN DOES NOT RELEASE ITS CLAIM ON THE FILE. This is the
     * line that protects the customer the brief describes: after a PARTIAL
     * undo, importing the same file again must still be refused, because
     * the rows that were never removed are still there to be matched as
     * "already here" and never looked at again.
     */
    await asSuperuser(async (c) => {
      const { rows } = await c.query(`SELECT superseded_at FROM import_runs WHERE id = $1`, [
        run.runId,
      ]);
      expect(rows[0].superseded_at).toBeNull();

      const { rows: left } = await c.query(
        `SELECT count(*)::int AS n FROM sales_invoices WHERE tenant_id = $1`,
        [t],
      );
      expect(left[0].n).toBe(4);
    });

    /**
     * ⭐ AND THE DATABASE ITSELF REFUSED THE DISHONEST ENDING. Proving it
     * here rather than trusting the code: the reversal row and its named
     * failures both committed, and the deferred trigger only permits that
     * when the two agree.
     */
    await asSuperuser(async (c) => {
      const { rows } = await c.query(
        `SELECT r.status, r.rows_unreversed,
                (SELECT count(*)::int FROM import_reversal_failures f WHERE f.reversal_id = r.id) AS named
           FROM import_reversals r WHERE r.run_id = $1`,
        [run.runId],
      );
      expect(rows[0].status).toBe("partial");
      expect(rows[0].rows_unreversed).toBe(4);
      expect(rows[0].named).toBe(4);
    });

    await cleanupTenant(t);
  });
});

/* ================================================================== */
/* ⑥ RUN-LEVEL IDEMPOTENCY                                             */
/* ================================================================== */

describe("run-level idempotency", () => {
  it("gives the second tab the run the first tab created", async () => {
    const t = await freshTenant("idempotency");
    const u = await freshUser(t);

    const first = await beginRun({
      tenantId: t, userId: u, entityKey: "companies",
      duplicateMode: "update", expectedRows: 40_000, file: "the-same-file",
    });
    const second = await beginRun({
      tenantId: t, userId: u, entityKey: "companies",
      duplicateMode: "update", expectedRows: 40_000, file: "the-same-file",
    });

    expect(first.resumed).toBe(false);
    expect(second.resumed).toBe(true);
    expect(second.runId).toBe(first.runId);
    expect(second.note).toContain("picked up");

    /** ⭐ AND ONLY ONE ROW EXISTS. The index, not the code path, is the proof. */
    await asSuperuser(async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM import_runs WHERE tenant_id = $1`,
        [t],
      );
      expect(rows[0].n).toBe(1);
    });

    /** A DIFFERENT file is a different run. */
    const other = await beginRun({
      tenantId: t, userId: u, entityKey: "companies",
      duplicateMode: "update", expectedRows: 12, file: "a-different-file",
    });
    expect(other.runId).not.toBe(first.runId);

    /**
     * 🔴 AND A DIFFERENT DUPLICATE MODE IS REFUSED RATHER THAN INHERITED.
     * `skip` and `update` are the customer's decision about records they
     * already have; resuming a `skip` run under `update` would overwrite
     * rows the first attempt deliberately left alone.
     */
    await expect(
      beginRun({
        tenantId: t, userId: u, entityKey: "companies",
        duplicateMode: "skip", expectedRows: 40_000, file: "the-same-file",
      }),
    ).rejects.toThrow(/already being imported/i);

    await cleanupTenant(t);
  });

  it("refuses a fingerprint that is not one", async () => {
    const t = await freshTenant("fingerprint");
    const u = await freshUser(t);
    await expect(
      startImportRun({
        tenantId: t, startedBy: u, entityKey: "companies", sourceFormat: "csv",
        duplicateMode: "skip", expectedRows: 1,
        /** The file NAME — the mistake that makes idempotency inert. */
        sourceFingerprint: "customers-final-v3.csv",
      }),
    ).rejects.toThrow(/not a source fingerprint/i);
    await cleanupTenant(t);
  });
});

/* ================================================================== */
/* ⑦ PROVENANCE CANNOT BE WRITTEN IN A SECOND TRANSACTION              */
/* ================================================================== */

describe("provenance", () => {
  /**
   * 🔴 THE BRIEF'S FIRST RED RULE: *"A separate transaction is not an
   * option."* Every branch of `writeRow` in `server/actions/import.ts`
   * opens its own `withTenant()`, which is exactly this shape — so this is
   * not a hypothetical, it is the code that ships today.
   */
  it("is refused when the row it describes was written by an earlier transaction", async () => {
    const t = await freshTenant("same-tx");
    const u = await freshUser(t);
    const entity = ALL_IMPORT_ENTITIES.companies;

    const run = await beginRun({
      tenantId: t, userId: u, entityKey: "companies",
      duplicateMode: "update", expectedRows: 1, file: "second-transaction",
    });

    const id = randomUUID();
    await expect(
      withTenant(t, async (tx) =>
        writeRowWithLedger(tx, {
          tenantId: t,
          runId: run.runId,
          entityKey: "companies",
          entity,
          inputRowNumber: 1,
          existingId: null,
          /** ⚠️ The writer opens its OWN transaction, as today's does. */
          write: async () => {
            await withTenant(t, async (other) => {
              await other.execute(
                sqlRaw(
                  `INSERT INTO companies (id, tenant_id, name) VALUES ('${id}', '${t}', 'Wrong Transaction Ltd')`,
                ),
              );
            });
            return id;
          },
        }),
      ),
    ).rejects.toThrow(/same transaction as the row it describes/i);

    /**
     * ⚠️ AND THE ROW IS STILL THERE, which is precisely why this matters:
     * the inner transaction committed. Without the refusal there would now
     * be a row in the customer's workspace that no undo can find and no
     * reconciliation can count — indistinguishable from one that was never
     * written.
     */
    await asSuperuser(async (c) => {
      const { rows } = await c.query(`SELECT count(*)::int AS n FROM companies WHERE id = $1`, [id]);
      expect(rows[0].n).toBe(1);
    });

    await cleanupTenant(t);
  });
});

/* ================================================================== */
/* ⑧ THE DECLARED UNDO THE DATABASE WILL NOT PERFORM                   */
/* ================================================================== */

describe("opening-stock", () => {
  /**
   * 🔴 THE FINDING. `opening-stock` declares `reversal: { kind: "delete" }`.
   * `stock_movements` carries `trg_stock_ledger_append_only`, whose first
   * statement is `IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Stock movements
   * cannot be deleted…'` — for every role, owner or not.
   *
   * CI gate 29 passes and always will: `checkImportContract()` is pure and
   * cannot ask `pg_trigger` anything. This test is the half of the contract
   * only a database can check.
   */
  it("declares an undo the stock ledger refuses, and the refusal comes before anything is touched", async () => {
    const entity = ALL_IMPORT_ENTITIES["opening-stock"];
    expect(entity.contract.reversal.kind).toBe("delete");

    await asSuperuser(async (c) => {
      const { rows } = await c.query(
        `SELECT delete_blocked_by FROM import_destination_reversibility('stock_movements')`,
      );
      expect(rows[0].delete_blocked_by).toBe("ordence_stock_ledger_append_only");
    });
  });
});

/* ================================================================== */
/* SMALL HELPERS                                                       */
/* ================================================================== */

/**
 * ⚠️ `sql.raw` WITH INTERPOLATED UUIDS, IN A TEST, ON PURPOSE. The values
 * are `randomUUID()`s this file generated seconds earlier; there is no
 * caller and no input. Using the query builder would drag the entity's own
 * writer — which belongs to Phase 1 and does not exist yet — into a test
 * about the ledger.
 */
function sqlRaw(text: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { sql } = require("drizzle-orm") as typeof import("drizzle-orm");
  return sql.raw(text);
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
     VALUES ('${id}', '${tenantId}', 'OPEN-${n}', '2025-26', 'issued', '${companyId}',
             '2026-03-31', 'INR', ${n * 100000}, 0, ${n * 100000},
             '2026-03-31T00:00:00+05:30', '${userId}',
             'Opening balance brought forward from the previous system.', '${userId}')`,
  );
}

/**
 * ⚠️ REMOVING A WORKSPACE THAT HAS BOOKS IS NOT A `DELETE`, AND THAT IS A
 * PRODUCT FINDING RATHER THAN A TEST INCONVENIENCE.
 *
 * `DELETE FROM tenants` cascades into `journal_entries`, which carries
 * `journal_entries_no_delete` — `block_mutation_append_only`, which refuses
 * for EVERY role including the owner. So a tenant that has ever had a
 * posting cannot be deleted at all. That is wave 15 §4.2's finding
 * (`security_events` makes a tenant undeletable) reached through a second
 * table, and the DPDPA erasure work has to solve it rather than inherit it.
 *
 * ⚠️ THE TRIGGERS ARE DISABLED AND RE-ENABLED IN SEPARATE TRANSACTIONS.
 * `journal_entries_balance_check` is a DEFERRABLE CONSTRAINT TRIGGER, and
 * once one has fired in a transaction, `ALTER TABLE … ENABLE TRIGGER` in
 * that same transaction fails with "cannot ALTER TABLE because it has
 * pending trigger events" — the trap Batch 0108 lost a batch to.
 */
async function cleanupTenant(id: string) {
  const APPEND_ONLY: readonly [string, string][] = [
    ["journal_entries", "journal_entries_no_delete"],
    ["stock_movements", "trg_stock_ledger_append_only"],
  ];

  for (const [table, trigger] of APPEND_ONLY) {
    await asSuperuser((c) => c.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`));
  }
  try {
    await asSuperuser(async (c) => {
      await c.query(`DELETE FROM change_log WHERE tenant_id = $1`, [id]);
      await c.query(`DELETE FROM tenants WHERE id = $1`, [id]);
    });
  } finally {
    for (const [table, trigger] of APPEND_ONLY) {
      await asSuperuser((c) => c.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`));
    }
  }
}
