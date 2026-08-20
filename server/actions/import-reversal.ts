"use server";

/**
 * Ordence — ⭐⭐⭐ THE UNDO BUTTON'S CALL SITE, AND THE RIGHT IT ASKS FOR
 * Version: v1.89.0-alpha · Wave 2B
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS
 * ══════════════════════════════════════════════════════════════════════
 * `server/import/reversal.ts` is 1,197 lines, contracted, proven against
 * a real PostgreSQL — and nothing called it. Phase 2's own report says
 * so: *"Nothing calls any of this yet … built-and-not-yet-reached, which
 * is the honest description, and the thing to check first at
 * integration."* This is the call site, and it is the whole of the
 * addition: no reversal logic is re-implemented here and none of it is
 * copied.
 *
 * ⚠️ `reverseImportRun` DOES NO PERMISSION CHECKING, DELIBERATELY, and
 * this file is the reason that is safe rather than merely stated. The
 * repository's own pattern — `server/accounting/post-sales.ts` posts,
 * `server/actions/*` guards — keeps the module runnable outside a
 * request, which is to say verifiable against a real database. A guard
 * inside it would make the Phase 2 proof impossible to run.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE DECISION: "MAY IMPORT" IS **NOT** "MAY UNDO AN IMPORT"
 * ══════════════════════════════════════════════════════════════════════
 * The nearest permission is `entity.createPermission` — the one
 * `guardImport()` in `server/actions/import.ts` asks for. It is refused
 * here, for two reasons that were measured on this tree rather than
 * assumed.
 *
 * ① AN UNDO WRITES TO ROWS THE RUN DID NOT CREATE.
 *
 *    `undoOneRow()` dispatches on `import_row_provenance.operation`, not
 *    on the kind: a `restore-prior` run in `update` mode INSERTED some
 *    rows and UPDATED others, and the undo of the second group is an
 *    UPDATE over records the customer had before the migration ever ran.
 *    Somebody who may add new prospects from a file is not thereby
 *    somebody who may mass-restore the customer master to values chosen
 *    by a spreadsheet. So the floor is the entity's OWN
 *    `updatePermission` — the same key `guardImport()` demands before it
 *    will let an import overwrite anything (`duplicateMode === "update"`).
 *
 *    ⭐ AND IT IS DEMANDED FOR EVERY KIND, INCLUDING `delete`. An undo
 *    that deletes is not gentler than one that restores; both are the
 *    mass rewriting of a table on the strength of a file somebody
 *    uploaded. Asking for the write right in one case and the read-ish
 *    "may create" right in the other would mean the safest-sounding kind
 *    carried the weakest gate.
 *
 * ② `reverseImportRun` CAN POST TO THE GENERAL LEDGER.
 *
 *    A `reverse-entry` run makes a `transactions` row and its journal
 *    legs (`postReversingJournalEntry`) or a compensating
 *    `stock_movements` row (`postReversingStockMovement`). If the undo
 *    button carried only an import permission, it would be a way to post
 *    a reversing entry without the right to post one — the button as a
 *    bypass.
 *
 *    ⚠️ SO WHAT DOES THE ACCOUNTING SIDE ACTUALLY ASK? Measured, not
 *    assumed: `reverseTransaction` in `server/actions/accounting.ts:356`
 *    guards with `requireRole(FINANCE_ROLES)`, `requireAccess(
 *    "accounting:reverseTransaction")` and `requireFeature(
 *    "accounting.ledger")`. The catalogue key `transactions:reverse`
 *    exists, is listed in `DANGEROUS_PERMISSIONS`, and — measured with
 *    `grep -rn "transactions:reverse" --include=*.ts server/ app/
 *    components/` — is asked for by NOTHING in the repository.
 *
 *    ⭐ THIS FILE ASKS FOR IT, and additionally matches the billing gate
 *    and the entitlement the accounting path uses. It is the catalogue's
 *    own name for the act being performed, it is already granted to
 *    `tenant_owner`, `tenant_admin` and the finance templates, and using
 *    it here means the undo button cannot post an entry that
 *    `reverseTransaction` would have refused.
 *
 *    ⚠️ IT IS **NOT** ASKED FOR ON RUNS THAT DO NOT POST. A `delete`
 *    undo of a contacts import is not an accounting act, and requiring a
 *    ledger permission for it would push workspaces to grant
 *    `transactions:reverse` to whoever does migrations — which would
 *    make the control weaker everywhere else. The requirement is derived
 *    per run, from the ledger.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE REQUIREMENT COMES FROM THE LEDGER, NOT FROM TODAY'S REGISTRY —
 *    EXCEPT WHERE IT CANNOT
 * ══════════════════════════════════════════════════════════════════════
 * `reversal.ts` reads the kind from the provenance rows rather than from
 * `ALL_IMPORT_ENTITIES`, because an entity's declaration can be edited
 * between the run and the undo. This file reads the kind the same way,
 * from the same rows, so "does this undo post to the ledger?" is
 * answered by what was written and not by what the registry says today.
 *
 * ⚠️ THE PERMISSION KEY ITSELF STILL COMES FROM THE REGISTRY, BECAUSE
 * NOTHING ELSE RECORDS IT. `import_runs` snapshots `reversal_escapes`
 * (SQL 0208 §0) precisely so the promise shown to the customer survives
 * a product change; it does not snapshot the permission. So an entity
 * REMOVED from `ALL_IMPORT_ENTITIES` cannot be undone through this
 * action — it fails closed, with a sentence saying why, and the refusal
 * is audited. `PATCH-REQUEST-WAVE-2B.md` asks for the column that would
 * close it, and states why guessing a key here would be worse: a wrong
 * guess is a silent downgrade of somebody's data-protection right into
 * whatever key happened to be nearest.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE GATE ORDER IS THE REPOSITORY'S, BROADEST FIRST
 * ══════════════════════════════════════════════════════════════════════
 *   identity → account standing → plan → person.
 * So a workspace whose card expired is told to pay rather than told they
 * lack a permission that would send them to an administrator who is
 * themselves.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ EVERY ENDING IS AUDITED, INCLUDING THE REFUSALS
 * ══════════════════════════════════════════════════════════════════════
 * An `irreversible` entity is exactly the one where somebody will have
 * tried, and a refusal nobody recorded is indistinguishable from nobody
 * having tried. `reverseImportRun` records its own refusal in
 * `import_reversals`; this file records the ATTEMPT in `audit_logs`,
 * which is the table a support question is answered from and the only
 * one that names the human.
 */

import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { importRuns } from "@/db/schema/import-runs";
import { requireAllPermissions, writeAudit } from "@/server/audit";
import { requireTenantContext, TenantAccessError } from "@/server/tenant-context";
import { requireAccess, AccessRestrictedError } from "@/server/billing/access";
import { requireFeature, FeatureLockedError } from "@/server/entitlements";
import { PermissionDeniedError, type PermissionKey } from "@/lib/permissions";
import { ALL_IMPORT_ENTITIES, isImportEntityKey } from "@/lib/import";
import { reverseImportRun, ImportReversalError, type ReversalResult } from "@/server/import/reversal";
import type { ActionResult } from "@/lib/validators/crm";
import type { TenantContext } from "@/server/tenant-context";

const undoSchema = z.object({
  /**
   * ⚠️ PARSED, NOT TRUSTED. This arrives from a browser: every export of
   * a `"use server"` module is an RPC endpoint anybody can POST to.
   */
  runId: z.string().uuid("Invalid identifier."),
});

/** What the ledger says this run's undo would do. */
type RunFacts = {
  readonly entityKey: string;
  readonly kinds: readonly string[];
};

/**
 * Read the run and the reversal kinds its ROWS were written under.
 *
 * ⚠️ THIS RUNS AFTER IDENTITY AND INSIDE `withTenant`, so RLS pins it to
 * the caller's workspace: a run id belonging to another tenant reads as
 * "not found" rather than leaking that it exists. It grants nothing — it
 * decides WHICH permission the caller is about to be asked for.
 */
async function readRunFacts(ctx: TenantContext, runId: string): Promise<RunFacts | null> {
  return withTenant(ctx.tenant.id, async (tx) => {
    const [run] = await tx
      .select({ entityKey: importRuns.entityKey })
      .from(importRuns)
      .where(and(eq(importRuns.tenantId, ctx.tenant.id), eq(importRuns.id, runId)));

    if (!run) return null;

    const result = await tx.execute(sql`
      SELECT DISTINCT p.reversal_kind AS kind
        FROM import_row_provenance p
       WHERE p.tenant_id = ${ctx.tenant.id}::uuid
         AND p.run_id    = ${runId}::uuid
         AND p.reversed_at IS NULL
    `);
    const rows = Array.isArray(result)
      ? (result as { kind: string }[])
      : (((result as { rows?: unknown })?.rows ?? []) as { kind: string }[]);

    return { entityKey: run.entityKey, kinds: rows.map((r) => String(r.kind)) };
  });
}

/**
 * ⭐ THE PERMISSIONS THIS PARTICULAR UNDO NEEDS — see the header.
 *
 * `null` means the entity that wrote these rows is no longer in the
 * allowlist, so no key can be named and the action fails closed.
 */
function permissionsForUndo(facts: RunFacts): readonly PermissionKey[] | null {
  /**
   * ⚠️ `isImportEntityKey` RATHER THAN AN INDEX, EVEN THOUGH THE KEY CAME
   * FROM OUR OWN TABLE. Rule 9: `ALL_IMPORT_ENTITIES` is the one
   * allowlist and membership in it is the only way to reach a definition.
   * A dynamic lookup on an unchecked string is one prototype away from
   * `Object.prototype.constructor`, and "it came from the database" is
   * how that stops being checked.
   */
  if (!isImportEntityKey(facts.entityKey)) return null;
  const entity = ALL_IMPORT_ENTITIES[facts.entityKey];

  const required: PermissionKey[] = [entity.updatePermission];

  /**
   * 🔴 THE LEDGER DECIDES, NOT THE REGISTRY. A run written under
   * `reverse-entry` posts a compensating record; the entity's CURRENT
   * declaration may say something else entirely.
   */
  if (facts.kinds.includes("reverse-entry") && !required.includes("transactions:reverse")) {
    required.push("transactions:reverse");
  }

  return required;
}

/* ------------------------------------------------------------------ */

/**
 * Undo an import run: the four kinds, the partial report, and the refusal.
 *
 * Returns the reversal result untouched — including `status: "partial"`,
 * every unreversed row named with what blocked it, and the sentence to
 * put in front of the customer. A partial is NOT converted into an error:
 * the caller needs the names, and `ok: false` would throw them away.
 */
export async function undoImportRun(input: unknown): Promise<ActionResult<ReversalResult>> {
  let ctx: TenantContext | null = null;
  let runId = "unknown";

  try {
    const params = undoSchema.parse(input);
    runId = params.runId;

    /* ---- identity, and the tenant RLS will be pinned to ------------ */
    ctx = await requireTenantContext();

    /* ---- what would this undo actually do? ------------------------- */
    const facts = await readRunFacts(ctx, runId);
    if (!facts) {
      /**
       * ⚠️ AUDITED. "Somebody asked to undo a run that is not in this
       * workspace" is exactly the probe worth having a record of, and it
       * is indistinguishable from a stale browser tab without one.
       */
      await writeAudit(ctx, {
        action: "delete",
        resourceType: "import_run",
        resourceId: runId,
        reason: "Undo refused: no such migration run in this workspace.",
        severity: "warning",
        metadata: { outcome: "not_found" },
      });
      return {
        ok: false,
        error:
          "That migration run is not in this workspace. Nothing has been undone.",
      };
    }

    const required = permissionsForUndo(facts);
    if (!required) {
      await writeAudit(ctx, {
        action: "delete",
        resourceType: "import_run",
        resourceId: runId,
        reason:
          `Undo refused: "${facts.entityKey}" is no longer an importable entity, so the ` +
          `permission this undo requires cannot be named.`,
        severity: "warning",
        metadata: { outcome: "unknown_entity", entityKey: facts.entityKey },
      });
      return {
        ok: false,
        error:
          `These rows were imported as "${facts.entityKey}", which this version of Ordence no ` +
          `longer imports, so we cannot tell who is allowed to undo them. Nothing has been ` +
          `changed. Please contact support — the run and everything it wrote are still recorded.`,
      };
    }

    const entity = ALL_IMPORT_ENTITIES[facts.entityKey as keyof typeof ALL_IMPORT_ENTITIES];
    const postsToLedger = required.includes("transactions:reverse");

    /* ---- account standing, then plan, then person ------------------ */
    await requireAccess("import:undo", ctx);
    await requireFeature("crm.bulk_import", ctx);
    await requireFeature(entity.feature, ctx);
    /**
     * ⭐ THE ENTITLEMENT THE ACCOUNTING PATH USES, ON THE RUNS THAT POST.
     * A plan without the ledger must not gain a reversing journal entry
     * through the migration screen.
     */
    if (postsToLedger) await requireFeature("accounting.ledger", ctx);

    /**
     * 🔴 EVERY key, not any of them. `requireAllPermissions` throws
     * `PermissionDeniedError` on the FIRST one the caller lacks and
     * records the denial in `permission_denials` on the way out — which
     * is what makes "the reversal never started" provable by counting
     * rows rather than by reading an error message.
     */
    await requireAllPermissions(required, { type: "import_run", id: runId });

    /* ---- and only now, the undo ------------------------------------ */
    const result = await reverseImportRun({
      tenantId: ctx.tenant.id,
      runId,
      requestedBy: ctx.user.id,
    });

    await writeAudit(ctx, {
      action: "delete",
      resourceType: "import_run",
      resourceId: runId,
      reason: result.message,
      /**
       * ⚠️ A PARTIAL IS NOT AN `info` EVENT. Rows the customer believes
       * are gone are still in their workspace; that is the state this
       * whole subsystem exists to keep visible.
       */
      severity:
        result.status === "reversed"
          ? "info"
          : result.status === "failed"
            ? "critical"
            : "warning",
      metadata: {
        outcome: result.status,
        kind: result.kind,
        entityKey: facts.entityKey,
        reversalId: result.reversalId,
        rowsConsidered: result.rowsConsidered,
        rowsReversed: result.rowsReversed,
        rowsUnreversed: result.rowsUnreversed,
        /** The names, not just the count — 0208 §4's rule, carried up. */
        unreversed: result.failures.map((f) => ({
          targetTable: f.targetTable,
          targetId: f.targetId,
          inputRowNumber: f.inputRowNumber,
          blockedBy: f.blockedBy,
          sqlstate: f.sqlstate,
        })),
        escapes: result.escapes,
        measuredEscapes: result.measuredEscapes,
        permissionsChecked: required,
      },
    });

    return { ok: true, data: result };
  } catch (error) {
    /**
     * ⚠️ THE REFUSALS KEEP THEIR OWN SENTENCES. Each of these four
     * answers a different question and sends the customer somewhere
     * different: pay, upgrade, ask an administrator, sign in again.
     * Collapsing them into one message guarantees somebody is eventually
     * told to solve the wrong problem.
     */
    if (
      error instanceof AccessRestrictedError ||
      error instanceof FeatureLockedError ||
      error instanceof PermissionDeniedError ||
      error instanceof TenantAccessError
    ) {
      if (ctx && error instanceof PermissionDeniedError) {
        /**
         * ⭐ A DENIED UNDO IS AUDITED TOO. `permission_denials` records
         * that a check failed; `audit_logs` records WHAT was being
         * attempted, which is the question support is asked.
         */
        await writeAudit(ctx, {
          action: "delete",
          resourceType: "import_run",
          resourceId: runId,
          reason: `Undo refused: ${error.message}`,
          severity: "warning",
          metadata: { outcome: "permission_denied", permission: error.permission },
        });
      }
      return { ok: false, error: error.message };
    }

    if (error instanceof z.ZodError) {
      return { ok: false, error: "That is not a migration run identifier." };
    }

    if (error instanceof ImportReversalError) {
      if (ctx) {
        await writeAudit(ctx, {
          action: "delete",
          resourceType: "import_run",
          resourceId: runId,
          reason: `Undo did not complete: ${error.message}`,
          severity: "critical",
          metadata: { outcome: "failed" },
        });
      }
      return { ok: false, error: error.message };
    }

    /**
     * ⚠️ NOTHING ELSE IS RE-SHAPED INTO A FRIENDLY SENTENCE. An unknown
     * failure in an undo is not a thing to reassure somebody about: the
     * workspace may be half-changed, and the honest answer says so.
     */
    if (ctx) {
      await writeAudit(ctx, {
        action: "delete",
        resourceType: "import_run",
        resourceId: runId,
        reason: `Undo failed with an unexpected error: ${String(error)}`,
        severity: "critical",
        metadata: { outcome: "error" },
      });
    }
    return {
      ok: false,
      error:
        "Undoing this migration did not complete, and we cannot say how far it got. Do not " +
        "import this file again until somebody has looked at the run.",
    };
  }
}
