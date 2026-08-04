import "server-only";

/**
 * Ordence — Resolving "which record type is this view over?"
 * Version: v0.25.0-alpha
 *
 * Two kinds of answer, and they are reached very differently:
 *
 *   • A BUILT-IN object (`lead`, `unit`, `booking`, `project`, `contact`,
 *     `company`, `deal`) is a key into a frozen registry compiled into
 *     the program. No database, no tenant, no request — the same
 *     definition for everybody, always.
 *
 *   • A PHASE 24 RUNTIME object is a row in `dynamic_objects` plus its
 *     `dynamic_fields`, read UNDER THE CALLER'S OWN TENANT SCOPE. Two
 *     workspaces have different ones; the same uuid resolves for one
 *     tenant and to nothing for another.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE SECOND CASE IS WHERE THE PHASE'S GUARANTEE IS WEAKEST, SO IT IS
 * WHERE THE CHECKING IS HEAVIEST
 * ══════════════════════════════════════════════════════════════════════
 * For a built-in object, `descriptor.column` is a constant of the
 * compiled program — it came out of `getTableColumns()`. Nothing a
 * customer can do changes it.
 *
 * For a runtime object it is a varchar out of a row: written months ago,
 * into a table that a restore, a support fix, a bulk edit or a bug could
 * since have touched. "It came out of our own database" is the assumption
 * behind a large share of second-order SQL injection, and this is exactly
 * the shape of it — a name that WAS validated, stored, and is now being
 * interpolated on the strength of that past validation.
 *
 * So every name is re-validated on the way out, on every request, by
 * `assertPhysicalTableName` / `assertPhysicalColumnName` — the same
 * functions Phase 24's own CRUD layer calls, for the same reason, at a
 * cost of one regex per query. `lib/views/planner.ts` then quotes them
 * again on the way into a statement.
 *
 * ⚠️ AND THE LOOKUP IS TENANT-SCOPED IN THE QUERY AS WELL AS BY RLS. The
 * policy would refuse another workspace's object anyway; the explicit
 * `tenant_id =` is what makes that refusal survive somebody running this
 * from a context where the setting was not pinned.
 */

import { and, eq, isNull } from "drizzle-orm";
import { withTenant } from "@/db";
import { dynamicObjects, dynamicFields } from "@/db/schema";
import {
  assertPhysicalColumnName,
  assertPhysicalTableName,
} from "@/lib/dynamic/identifiers";
import {
  buildDynamicViewObject,
  viewObject,
  DYNAMIC_OBJECT_KEY,
  type ViewObjectDefinition,
} from "@/lib/views/registry";
import type { SelectChoice } from "@/lib/dynamic/field-types";

export type ObjectSelector = {
  objectKey: string;
  dynamicObjectId?: string | null;
};

/**
 * Resolve a selector into a definition, or into `null`.
 *
 * ⚠️ RETURNS `null` FOR "NO SUCH OBJECT KEY", "NO SUCH RUNTIME OBJECT"
 * AND "THAT RUNTIME OBJECT BELONGS TO ANOTHER WORKSPACE" ALIKE, AND THE
 * CALLER MUST TREAT ALL THREE THE SAME. Distinguishing them turns this
 * function into an existence oracle across tenants: "does workspace B
 * have a record type with this id?" answered by the difference between
 * two error messages.
 */
export async function resolveViewObject(
  tenantId: string,
  selector: ObjectSelector,
): Promise<ViewObjectDefinition | null> {
  if (selector.objectKey !== DYNAMIC_OBJECT_KEY) {
    // Frozen registry. `viewObject` uses `Object.hasOwn`, so a key of
    // "constructor" resolves to nothing rather than to a function.
    return viewObject(selector.objectKey);
  }

  const objectId = selector.dynamicObjectId;
  if (!objectId) return null;

  return withTenant(tenantId, async (tx) => {
    const [object] = await tx
      .select()
      .from(dynamicObjects)
      .where(
        and(
          eq(dynamicObjects.id, objectId),
          eq(dynamicObjects.tenantId, tenantId),
          isNull(dynamicObjects.archivedAt),
        ),
      )
      .limit(1);

    if (!object) return null;

    const fields = await tx
      .select()
      .from(dynamicFields)
      .where(
        and(
          eq(dynamicFields.objectId, object.id),
          eq(dynamicFields.tenantId, tenantId),
          isNull(dynamicFields.deletedAt),
        ),
      );

    return buildDynamicViewObject({
      apiName: object.apiName,
      label: object.label,
      pluralLabel: object.pluralLabel,
      // ⚠️ RE-VALIDATED. See the header. It throws rather than returning
      // null, because a metadata row pointing at a name this rejects is a
      // corrupted row and not a missing object — and silently treating it
      // as "no such object" would hide that.
      physicalTableName: assertPhysicalTableName(object.physicalTableName),
      displayFieldApiName: object.displayFieldApiName,
      fields: fields
        // A hidden field is not offered to a view. It is still readable
        // through Phase 24's own record API — this is a UI decision made
        // by the person who defined the object, not a security boundary,
        // and calling it one would be misleading.
        .filter((field) => !field.isHidden)
        .map((field) => ({
          apiName: field.apiName,
          label: field.label,
          fieldType: field.fieldType,
          physicalColumnName: assertPhysicalColumnName(field.physicalColumnName),
          options: (field.options as SelectChoice[]).map((option) => ({
            value: option.value,
          })),
        })),
    });
  });
}

/**
 * The label to show for an object the caller may not be able to name.
 *
 * ⚠️ Falls back to a generic phrase rather than echoing the key. Echoing
 * it puts a caller-supplied string into a message, which is how a
 * reflected-XSS report arrives about a product that renders errors as
 * text everywhere except the one place somebody used `dangerouslySet…`.
 */
export function describeSelector(selector: ObjectSelector): string {
  const object = viewObject(selector.objectKey);
  return object ? object.pluralLabel : "these records";
}
