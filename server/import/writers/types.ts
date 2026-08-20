/**
 * Ordence — ⭐⭐ WHAT A DESTINATION CONTRIBUTES
 * Version: v1.85.0-alpha · Phase 1
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS EXISTS: THE FALL-THROUGH WROTE A GST PARTY
 * ══════════════════════════════════════════════════════════════════════
 * Before this file, `server/actions/import.ts` dispatched on
 * `entity.table` with `if` chains in three places. Adding a destination
 * meant remembering all three, and the compiler could not help , an `if`
 * chain has no exhaustiveness.
 *
 * ⚠️ AND THE FAILURE WAS NOT "THE ROW GOES NOWHERE", WHICH IS WHAT
 *    EVERYONE ASSUMED. `gst_parties` was the UNGUARDED FINAL BRANCH of
 *    both `findExistingByNaturalKey` and `writeRow` , not an
 *    `if (entity.table === "gst_parties")`, just the code after the last
 *    `if`. So an unhandled destination did not write nothing.
 *
 *    **It wrote a GST party.**
 *
 *    A Phase 7 `stock-items` entity that forgot its branch would have
 *    matched existing GST parties by natural key and inserted rows into
 *    `gst_parties`, reporting success, with the customer's stock list
 *    landing in their tax master. Verified by reading lines 566 and 1586
 *    of the pre-Phase-1 file: neither is guarded by a condition.
 *
 * ⭐ SO A DESTINATION NOW CONTRIBUTES AN OBJECT, AND THE REGISTRY IS A
 * `Record` OVER THE DESTINATION UNION. Omitting one is a compile error at
 * the registry, in the same way and for the same reason `REVALIDATE_AFTER`
 * already was , that `Record` is the only one of the four dispatch sites
 * that ever refused a missing destination, and it is the model for all of
 * them now.
 *
 * ⚠️ NO DEFAULT MEMBER, NO FALLBACK WRITER, NO `Partial<>`. Any of those
 * restores the fall-through this file exists to delete.
 */

import type { ImportNaturalKey, ImportRowPlan } from "@/lib/import";
import type { TenantContext } from "@/server/tenant-context";

export type WriteOutcome = { ok: true } | { ok: false; error: string };

/**
 * One row that survived planning, with every resolved lookup id merged
 * into its payload.
 *
 * ⚠️ MOVED HERE FROM `server/actions/import.ts`. It was local to that
 * file when the destinations were `if` branches inside it; the atomic
 * writer needs it now, and a second copy of this shape is a second thing
 * to keep in step.
 */
export type PlannedWrite = {
  row: ImportRowPlan;
  payload: Record<string, unknown>;
  existingId: string | null;
};

export type ImportWriter = {
  /**
   * Which page a successful import invalidates.
   *
   * ⚠️ IT LIVES ON THE WRITER RATHER THAN IN A SECOND `Record`. The
   * previous `REVALIDATE_AFTER` map was correct and was still a second
   * place a destination had to be remembered. One object per
   * destination is one place.
   */
  readonly revalidatePath: string;

  /**
   * Find rows already in the workspace matching these natural keys.
   *
   * ⚠️ RETURNS A MAP KEYED `"kind:value"`, the same composite the pure
   * layer builds, so the two cannot diverge. The kind is part of the key
   * because `"name:acme"` must never match `"domain:acme"`.
   */
  findExisting(
    ctx: TenantContext,
    keys: readonly ImportNaturalKey[],
  ): Promise<Map<string, string>>;

  /**
   * Write one planned row. `existingId` is non-null only in `update`
   * mode and only when `findExisting` matched.
   *
   * ⚠️ ABSENT ON A DESTINATION THAT IS WRITTEN AS ONE DOCUMENT FOR THE
   * WHOLE FILE. See `writeFile`.
   */
  writeRow?(
    ctx: TenantContext,
    payload: Record<string, unknown>,
    existingId: string | null,
  ): Promise<WriteOutcome>;

  /**
   * ⭐ ONE DOCUMENT PER FILE, NOT ONE PER ROW.
   *
   * An opening trial balance is a single balanced journal entry: every
   * row is a leg, they are written in one transaction, and they share one
   * outcome. There is no such thing as importing four fifths of a journal
   * entry.
   *
   * 🔴 EXACTLY ONE OF `writeRow` AND `writeFile` IS PRESENT, and the
   *    registry's own check refuses a writer carrying both or neither.
   *    A destination with both would have two write paths and the second
   *    is the one nobody tests.
   */
  writeFile?(
    ctx: TenantContext,
    planned: readonly PlannedWrite[],
  ): Promise<WriteOutcome>;
};
