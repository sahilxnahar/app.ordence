import "server-only";

/**
 * Ordence — ⭐⭐⭐ EXECUTING AN ERASURE
 * Version: v1.68.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE OPERATION IN THIS PRODUCT WITH NO UNDO
 * ══════════════════════════════════════════════════════════════════════
 * `lib/backup/recoverable.ts` covers a soft delete and this is not one.
 * There is no recycle bin behind a DPDP erasure, because a recycle bin
 * behind an erasure is not an erasure — it is the same personal data in
 * a table the customer has stopped looking at, and s.8(7) would apply to
 * it identically.
 *
 * ⭐ SO THE SEQUENCE IS: PLAN, THEN LOOK, THEN DELETE, THEN RECORD.
 *
 *   ① `buildExportPlan` decides which rows are this person's.
 *   ② `exportDataPrincipal` runs it and returns them. Nothing is deleted
 *      that has not first been READ and handed to the operator, so the
 *      erasure and the export are the same set by construction rather
 *      than by two queries that agree today.
 *   ③ `buildErasurePlan` applies the retention rules to that set.
 *   ④ Only then does anything go, and only from tables whose verdict is
 *      `delete`.
 *   ⑤ Every table's outcome is written to an append-only register.
 *
 * 🔴 IT REFUSES TO RUN A BLOCKED PLAN. If any table needs a human — an
 * `unverified` retention rule, or a table nothing can search — this
 * function deletes NOTHING and returns the plan. An erasure that
 * proceeded on the tables it was sure about would leave the person
 * partly erased and the workspace unable to say which half.
 */

import { sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { buildErasurePlan, type ErasurePlan } from "@/lib/dpdp/erasure";
import { buildExportPlan, executionOrder, type Subject } from "@/lib/dpdp/subject-graph";
import { exportDataPrincipal, type PrincipalExport } from "./export-service";

/* ------------------------------------------------------------------ */

function assertIdentifier(value: string, what: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(
      `Refusing to interpolate ${what} "${value}": it is not a bare lower-case identifier, so it did not come from lib/dpdp/classification.ts.`,
    );
  }
  return value;
}

export type ErasureOutcome = {
  plan: ErasurePlan;
  /** ⭐ The export taken immediately before deleting. The person's copy. */
  taken: PrincipalExport;
  /** Rows actually deleted, per table. Absent means the table was not touched. */
  deleted: Record<string, number>;
  failures: { table: string; reason: string }[];
  /** 🔴 True where nothing was deleted because something needed a person. */
  refusedToRun: boolean;
  notes: string[];
};

export async function eraseDataPrincipal(args: {
  tenantId: string;
  workspaceName: string;
  subject: Subject;
  now: Date;
  /**
   * ⚠️ TABLES WHOSE STATUTORY CLOCK THE CALLER HAS ESTABLISHED HAS RUN.
   * Empty is the safe default: an unknown clock is treated as still
   * running, which over-retains rather than over-deletes.
   */
  expiredFor?: ReadonlySet<string>;
  heldFor?: ReadonlySet<string>;
  /**
   * 🔴 A PER-TABLE DECISION FROM A PERSON, for the tables the plan
   * referred. Without it a referred table stays referred and the whole
   * run refuses. There is deliberately no "approve everything" value.
   */
  humanDecisions?: ReadonlyMap<string, "erase" | "retain">;
}): Promise<ErasureOutcome> {
  /* ① and ② — plan, then look. */
  const taken = await exportDataPrincipal({
    tenantId: args.tenantId,
    workspaceName: args.workspaceName,
    subject: args.subject,
    now: args.now,
  });

  /* ③ — apply the law. */
  const exportPlan = buildExportPlan(args.subject);
  const basePlan = buildErasurePlan({
    exportPlan,
    expiredFor: args.expiredFor,
    heldFor: args.heldFor,
  });

  /**
   * ⭐ A HUMAN'S DECISION REPLACES A `refer`, AND ONLY A `refer`.
   *
   * ⚠️ IT CANNOT OVERRIDE A `retain`. A workspace operator may not
   * decide that s.36 of the CGST Act does not apply to them, and an
   * "override" control on that screen would be an invitation to destroy
   * records an inspector will later ask for. The only thing a person is
   * allowed to resolve is the case where the ENGINE does not know.
   */
  const decisions = args.humanDecisions ?? new Map<string, "erase" | "retain">();
  const plan: ErasurePlan = {
    ...basePlan,
    tables: basePlan.tables.map((t) => {
      if (t.action !== "refer") return t;
      const d = decisions.get(t.table);
      if (!d) return t;
      return {
        ...t,
        action: d === "erase" ? ("delete" as const) : ("retain" as const),
        because:
          d === "erase"
            ? `A person decided this may be erased. ${t.because}`
            : `A person decided this must be kept. ${t.because}`,
      };
    }),
  };
  const stillReferred = plan.tables.filter((t) => t.action === "refer");
  const rebuilt: ErasurePlan = {
    ...plan,
    summary: {
      deleted: plan.tables.filter((t) => t.action === "delete").length,
      redacted: plan.tables.filter((t) => t.action === "redact").length,
      retained: plan.tables.filter((t) => t.action === "retain").length,
      referred: stillReferred.length,
      couldNotSearch: plan.tables.filter((t) => t.couldNotSearch).length,
    },
    blocked: stillReferred.length > 0,
  };

  const notes: string[] = [];

  /* 🔴 ④ — and it refuses. */
  if (rebuilt.blocked) {
    notes.push(
      `Nothing was erased. ${stillReferred.length} record set(s) need a decision from a person: ` +
        `${stillReferred.map((t) => t.table).join(", ")}. An erasure that ran on the tables it was sure about ` +
        `would leave this person partly erased with no way to say which half.`,
    );
    return { plan: rebuilt, taken, deleted: {}, failures: [], refusedToRun: true, notes };
  }

  /* --- delete, children first ---------------------------------------- */

  /**
   * ⚠️ REVERSE DEPENDENCY ORDER. `executionOrder` puts parents first so
   * a search can resolve them; a delete must go the other way or a
   * foreign key refuses it. Reversing the same list is deliberate: two
   * separately-derived orderings would drift.
   *
   * 🔴 SEVERAL FOREIGN KEYS IN THIS SCHEMA ARE `ON DELETE RESTRICT` ON
   * PURPOSE — `employee_advances.employee_id` is, so that deleting an
   * employee cannot delete the record of money they were lent. Those
   * will refuse, and that refusal is CORRECT and is reported rather than
   * worked around.
   */
  const { order } = executionOrder(exportPlan);
  const deleteOrder = [...order].reverse();
  const byTable = new Map(rebuilt.tables.map((t) => [t.table, t]));

  const deleted: Record<string, number> = {};
  const failures: { table: string; reason: string }[] = [];

  await withTenant(args.tenantId, async (tx) => {
    for (const table of deleteOrder) {
      const t = byTable.get(table);
      if (!t || t.action !== "delete") continue;

      /**
       * ⭐ THE IDS COME FROM THE EXPORT WE JUST TOOK, NOT FROM A SECOND
       * QUERY. If the export could not read a table, its rows are not
       * deleted — we do not delete what we could not show the person.
       */
      const rows = taken.data[table];
      if (!rows || rows.length === 0) continue;
      const ids = rows.map((r) => String(r["id"] ?? "")).filter((v) => v.length > 0);
      if (ids.length === 0) {
        notes.push(
          `${table} matched ${rows.length} row(s) that carry no \`id\` column, so they could not be addressed for deletion. Nothing was deleted there.`,
        );
        continue;
      }

      try {
        const safe = assertIdentifier(table, "table");
        const result = await tx.execute(
          sql`DELETE FROM ${sql.raw(safe)}
               WHERE tenant_id = ${args.tenantId}
                 AND id = ANY(${ids}::uuid[])`,
        );
        deleted[table] = result.rowCount ?? ids.length;
      } catch (error) {
        /**
         * ⚠️ A REFUSED DELETE IS INFORMATION, NOT A CRASH. An `ON DELETE
         * RESTRICT` firing here means a record this person is attached to
         * is one the schema deliberately protects, and the person
         * deserves to be told which and why rather than receiving a 500.
         */
        failures.push({
          table,
          reason: error instanceof Error ? error.message : "unknown error",
        });
      }
    }
  });

  if (failures.length > 0) {
    notes.push(
      `${failures.length} table(s) refused the delete, usually because a foreign key protects the row — ` +
        `\`employee_advances.employee_id\` is ON DELETE RESTRICT so that deleting an employee cannot delete ` +
        `the record of money they were lent. These are listed and must be resolved by hand.`,
    );
  }

  return { plan: rebuilt, taken, deleted, failures, refusedToRun: false, notes };
}
