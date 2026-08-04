import "server-only";

/**
 * Ordence — Soft-Delete Restore
 * Version: v0.21.0-alpha
 *
 * The recycle bin, and the checks that make putting a record back
 * actually work rather than merely succeed.
 *
 * ══════════════════════════════════════════════════════════════════════
 * PRECONDITIONS ARE CHECKED BEFORE WRITING, NOT CAUGHT AFTERWARDS
 * ══════════════════════════════════════════════════════════════════════
 * Catching a 23505 and reporting "restore failed" is technically
 * correct and useless. The customer needs to know that another contact
 * has taken the email address, and what to do about it.
 *
 * More importantly, some failures do NOT raise. Restoring a contact
 * whose company is still deleted violates no constraint — it produces a
 * record that renders as broken. Only an explicit check catches that,
 * and only an explicit check can explain it.
 */

import { sql } from "drizzle-orm";
import { withTenant } from "@/db";
import {
  RECOVERABLE_ENTITIES,
  recoverableFor,
  describeRestore,
  isWithinRecoveryWindow,
  daysRemaining,
  RECOVERY_WINDOW_DAYS,
  type RestoreBlocker,
  type RestoreVerdict,
} from "@/lib/backup/recoverable";
import { recordSystemAudit } from "@/server/billing/audit-billing";

/* ------------------------------------------------------------------ */
/* THE RECYCLE BIN                                                     */
/* ------------------------------------------------------------------ */

export type DeletedRecord = {
  table: string;
  entityLabel: string;
  id: string;
  displayName: string;
  deletedAt: string;
  deletedBy: string | null;
  daysLeft: number;
};

/**
 * Everything a tenant deleted inside the recovery window.
 *
 * ⚠️ Queries each table separately rather than building one UNION.
 *
 * A UNION would need every branch to project an identical column list,
 * which means casting `full_name`, `title`, `name` and `file_name` into
 * one column — and the moment a table is added with a different display
 * column, the whole query breaks rather than that one table being
 * missing. Seven small indexed queries against `(tenant_id, deleted_at)`
 * are a few milliseconds and degrade one table at a time.
 */
export async function listDeletedRecords(
  tenantId: string,
  now: Date = new Date(),
): Promise<{ records: DeletedRecord[]; failures: string[] }> {
  const records: DeletedRecord[] = [];
  const failures: string[] = [];

  const cutoff = new Date(now.getTime() - RECOVERY_WINDOW_DAYS * 86_400_000);

  await withTenant(tenantId, async (tx) => {
    for (const entity of RECOVERABLE_ENTITIES) {
      try {
        // `sql.raw` is safe here for the same reason as in export.ts:
        // the values come from a frozen literal in `lib/backup/`, never
        // from a request. The tenant filter is for the index; RLS is the
        // boundary.
        const result = await tx.execute(
          sql`SELECT id,
                     COALESCE(${sql.raw(entity.displayColumn)}::text, '(untitled)') AS display_name,
                     deleted_at,
                     deleted_by
                FROM ${sql.raw(entity.table)}
               WHERE tenant_id = ${tenantId}
                 AND deleted_at IS NOT NULL
                 AND deleted_at >= ${cutoff.toISOString()}
               ORDER BY deleted_at DESC
               LIMIT 500`,
        );

        for (const row of (result.rows ?? []) as Record<string, unknown>[]) {
          const deletedAt = new Date(String(row.deleted_at));
          records.push({
            table: entity.table,
            entityLabel: entity.label,
            id: String(row.id),
            displayName: String(row.display_name ?? "(untitled)"),
            deletedAt: deletedAt.toISOString(),
            deletedBy: row.deleted_by ? String(row.deleted_by) : null,
            daysLeft: daysRemaining(deletedAt, now),
          });
        }
      } catch (error) {
        // One table missing a column must not empty the whole bin.
        failures.push(entity.table);
        console.error(
          `[restore] could not list deleted ${entity.table}:`,
          error instanceof Error ? error.message : "unknown",
        );
      }
    }
  });

  records.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  return { records, failures };
}

/* ------------------------------------------------------------------ */
/* PRECONDITIONS                                                       */
/* ------------------------------------------------------------------ */

/**
 * Can this row be put back?
 *
 * Read-only. Called both to render the button's state and again inside
 * the restore transaction — because the first call races with anything
 * another user is doing, and the second one does not.
 */
export async function checkRestorable(
  tenantId: string,
  table: string,
  id: string,
  now: Date = new Date(),
): Promise<RestoreVerdict> {
  const entity = recoverableFor(table);
  if (!entity) {
    return describeRestore([{ kind: "not_recoverable", table }]);
  }

  const blockers: RestoreBlocker[] = [];

  await withTenant(tenantId, async (tx) => {
    const target = await tx.execute(
      sql`SELECT * FROM ${sql.raw(entity.table)}
           WHERE id = ${id} AND tenant_id = ${tenantId}
           LIMIT 1`,
    );

    const row = (target.rows ?? [])[0] as Record<string, unknown> | undefined;
    if (!row) {
      blockers.push({ kind: "not_recoverable", table });
      return;
    }

    if (!row.deleted_at) {
      // Already live. Not an error — the customer probably clicked twice,
      // or a colleague restored it first.
      return;
    }

    const deletedAt = new Date(String(row.deleted_at));
    if (!isWithinRecoveryWindow(deletedAt, now)) {
      blockers.push({ kind: "outside_window", deletedAt: deletedAt.toISOString() });
    }

    /* ---- Parents must be live ------------------------------------ */
    for (const parent of entity.parents) {
      const parentId = row[parent.column];
      if (!parentId) continue;

      const parentRow = await tx.execute(
        sql`SELECT deleted_at FROM ${sql.raw(parent.table)}
             WHERE id = ${String(parentId)} AND tenant_id = ${tenantId}
             LIMIT 1`,
      );

      const found = (parentRow.rows ?? [])[0] as
        | { deleted_at: unknown }
        | undefined;

      // Missing entirely, or deleted — both leave a broken child.
      if (!found || found.deleted_at) {
        blockers.push({
          kind: "parent_deleted",
          parentLabel: parent.label,
          parentTable: parent.table,
        });
      }
    }

    /* ---- A live row may have taken a unique value ---------------- */
    for (const column of entity.uniqueWithinTenant) {
      const value = row[column];
      if (value === null || value === undefined || value === "") continue;

      const clash = await tx.execute(
        sql`SELECT 1 FROM ${sql.raw(entity.table)}
             WHERE tenant_id = ${tenantId}
               AND ${sql.raw(column)} = ${String(value)}
               AND deleted_at IS NULL
               AND id <> ${id}
             LIMIT 1`,
      );

      if ((clash.rows ?? []).length > 0) {
        blockers.push({ kind: "unique_conflict", column, value: String(value) });
      }
    }

    /* ---- Financial records inside a closed period ---------------- */
    //
    // Restoring into a closed month changes a figure that has already
    // been reported. That is a restatement, not a restore, and it needs
    // a deliberate decision by someone who understands the consequence.
    if (entity.financiallySignificant) {
      const closed = await tx.execute(
        sql`SELECT name FROM financial_periods
             WHERE tenant_id = ${tenantId}
               AND status = 'closed'
               AND ${String(row.created_at ?? new Date().toISOString())}::timestamptz
                   BETWEEN start_date AND end_date
             LIMIT 1`,
      );

      const period = (closed.rows ?? [])[0] as { name?: string } | undefined;
      if (period) {
        blockers.push({
          kind: "period_closed",
          periodLabel: period.name ?? "a closed period",
        });
      }
    }
  });

  return describeRestore(blockers);
}

/* ------------------------------------------------------------------ */
/* THE RESTORE                                                         */
/* ------------------------------------------------------------------ */

export class RestoreBlockedError extends Error {
  constructor(readonly verdict: RestoreVerdict) {
    super(verdict.message);
    this.name = "RestoreBlockedError";
  }
}

/**
 * Put a record back.
 *
 * ⚠️ THE PRECONDITIONS ARE RE-CHECKED INSIDE THE TRANSACTION.
 *
 * The check that rendered the button ran seconds or minutes ago. In
 * between, a colleague may have created a contact with the same email,
 * or deleted the parent company. Re-checking inside the same transaction
 * as the write is what makes the answer true at the moment it matters —
 * the earlier call is for the UI, not for correctness.
 */
export async function restoreRecord(args: {
  tenantId: string;
  table: string;
  id: string;
  actor: {
    userId: string;
    clerkId: string | null;
    email: string | null;
    role: string;
  };
}): Promise<{ restored: true; label: string }> {
  const entity = recoverableFor(args.table);
  if (!entity) {
    throw new RestoreBlockedError(
      describeRestore([{ kind: "not_recoverable", table: args.table }]),
    );
  }

  const verdict = await checkRestorable(args.tenantId, args.table, args.id);
  if (!verdict.allowed) throw new RestoreBlockedError(verdict);

  return withTenant(args.tenantId, async (tx) => {
    const result = await tx.execute(
      sql`UPDATE ${sql.raw(entity.table)}
             SET deleted_at = NULL,
                 deleted_by = NULL,
                 updated_at = now()
           WHERE id = ${args.id}
             AND tenant_id = ${args.tenantId}
             AND deleted_at IS NOT NULL
       RETURNING id`,
    );

    const rows = result.rows ?? [];

    if (rows.length === 0) {
      // Nothing matched: either already restored by someone else, or the
      // row moved out from under us. Reported as success rather than
      // failure — the customer's intent ("this should exist") is
      // satisfied either way, and a scary error over a double-click is
      // its own support ticket.
      return { restored: true as const, label: entity.label };
    }

    /**
     * ⚠️ The audit row is written INSIDE this transaction, and it is
     * allowed to fail the restore.
     *
     * A restore with no record of who did it is exactly the kind of
     * change that gets questioned later — "this record reappeared, who
     * brought it back?" — and an unanswerable question about data
     * reappearing is worse than a restore the customer has to retry.
     */
    await recordSystemAudit(tx, {
      tenantId: args.tenantId,
      action: "update",
      resourceType: entity.table,
      resourceId: args.id,
      severity: "notice",
      reason: `${entity.label} restored from the recycle bin`,
      metadata: {
        restoredBy: args.actor.email ?? args.actor.userId,
        restoredByRole: args.actor.role,
        table: entity.table,
      },
    });

    return { restored: true as const, label: entity.label };
  });
}
