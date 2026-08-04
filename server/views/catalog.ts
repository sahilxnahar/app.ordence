import "server-only";

/**
 * Ordence — What the Builder Is Allowed to Offer
 * Version: v0.25.0-alpha
 *
 * The field catalogue, sent to the browser so the filter builder can draw
 * a field picker and an operator list.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS IS A CONVENIENCE, NOT A CONTROL, AND THE DISTINCTION MATTERS
 * ══════════════════════════════════════════════════════════════════════
 * It is tempting to read a function like this as "the list of fields a
 * caller may filter on", and then to think of the server as enforcing it.
 * It does not and it must not: the browser can post whatever it likes,
 * and a UI that only offers safe options is a UI, not a boundary.
 *
 * The enforcement is `resolveField()` in `lib/views/registry.ts`, run
 * again on every replay of every view. This function exists so the person
 * building a filter is offered the same set the planner will accept —
 * which is a usability property (no filter that saves and then refuses to
 * run), not a security one.
 *
 * ⚠️ AND IT IS STILL GATED. An unauthenticated field list would tell
 * anybody the column names of every table in the product, and a list
 * scoped to an object the caller cannot read would tell them the shape of
 * data they are not allowed to see. Gate 5 applies here exactly as it
 * applies to running a view.
 */

import { requirePermission } from "@/server/audit";
import { requireViewObjectAccess, toViewActionError, viewFail } from "./guards";
import { resolveViewObject } from "./objects";
import { canOpenObject } from "./guards";
import { operatorsForKind, OPERATORS } from "@/lib/views/operators";
import { VIEW_OBJECTS, viewObject } from "@/lib/views/registry";
import { VIEW_PERMISSIONS } from "@/lib/views/access";
import { listViewsSchema } from "@/lib/validators/views";
import type { FieldKind, FilterOperator, SortSpec } from "@/lib/views/types";
import type { ActionResult } from "@/lib/validators/crm";

export type FieldDescription = {
  name: string;
  label: string;
  kind: FieldKind;
  enumValues: readonly string[] | null;
  filterable: boolean;
  sortable: boolean;
  groupable: boolean;
  /** Which comparisons the builder may offer for this field. */
  operators: Array<{ key: FilterOperator; label: string; arity: string }>;
};

export type ObjectDescription = {
  key: string;
  label: string;
  pluralLabel: string;
  dynamicObjectId: string | null;
  /** True when this caller sees only their own records of this type. */
  scopedToOwnRecords: boolean;
  /**
   * ⭐ The order the planner applies when the view names none.
   *
   * ⚠️ WITHOUT THIS THE BROWSER CANNOT TELL THE TRUTH ABOUT ITS OWN
   * TABLE. `resolveRequest()` substitutes `object.defaultSorts` for an
   * empty sort list, so the rows ARE sorted — and the header, reading
   * an empty `sorts`, drew `aria-sort="none"` on every column. Sending
   * the default is what lets the header match the rows.
   */
  defaultSorts: readonly SortSpec[];
  defaultGroupBy: string | null;
  defaultDateField: string | null;
  defaultColumns: readonly string[];
  fields: FieldDescription[];
};

/**
 * Describe one object, or list the objects this caller can view at all.
 *
 * ⚠️ THE LIST IS FILTERED BY WHAT THE CALLER MAY READ, not by what
 * exists. A navigation menu offering "Bookings" to somebody without
 * `bookings:read` produces a click that fails — and, worse, confirms that
 * this workspace has bookings.
 */
export async function describeViewObjects(
  input: unknown,
): Promise<ActionResult<{ objects: ObjectDescription[] }>> {
  try {
    const ctx = await requirePermission(VIEW_PERMISSIONS.read);
    const params = listViewsSchema.parse(input ?? {});

    /* --- One object, in full ------------------------------------- */
    if (params.objectKey) {
      const object = await resolveViewObject(ctx.tenant.id, {
        objectKey: params.objectKey,
        dynamicObjectId: params.dynamicObjectId ?? null,
      });
      if (!object) return viewFail("That record type does not exist.");

      const scope = requireViewObjectAccess(ctx, object);

      return {
        ok: true,
        data: {
          objects: [
            {
              key: object.key,
              label: object.label,
              pluralLabel: object.pluralLabel,
              dynamicObjectId: params.dynamicObjectId ?? null,
              scopedToOwnRecords: scope.restrictToOwnerUserId !== null,
              defaultSorts: object.defaultSorts,
              defaultGroupBy: object.defaultGroupBy,
              defaultDateField: object.defaultDateField,
              defaultColumns: object.defaultColumns,
              fields: Object.values(object.fields).map(describeField),
            },
          ],
        },
      };
    }

    /* --- The menu: every built-in object this caller may read ----- */
    //
    // Runtime objects are deliberately absent from this branch: listing
    // them needs a per-tenant query, and the navigation that wants them
    // already has Phase 24's own object list. Asking for one by key
    // returns it in full, above.
    const objects: ObjectDescription[] = [];
    for (const key of Object.keys(VIEW_OBJECTS)) {
      const object = viewObject(key);
      if (!object || !canOpenObject(ctx, object)) continue;

      objects.push({
        key: object.key,
        label: object.label,
        pluralLabel: object.pluralLabel,
        dynamicObjectId: null,
        // Cheap to compute and useful in the menu: a rep seeing "My
        // leads" rather than "Leads" is told the truth before they click.
        scopedToOwnRecords:
          requireViewObjectAccess(ctx, object).restrictToOwnerUserId !== null,
        defaultSorts: object.defaultSorts,
        defaultGroupBy: object.defaultGroupBy,
        defaultDateField: object.defaultDateField,
        defaultColumns: object.defaultColumns,
        // ⚠️ The menu carries no field list. It would be seven table
        // schemas in a payload that only needs seven labels, and the
        // builder asks for the one object it is editing.
        fields: [],
      });
    }

    return { ok: true, data: { objects } };
  } catch (err) {
    return toViewActionError(err, "describeViewObjects");
  }
}

function describeField(field: {
  name: string;
  label: string;
  kind: FieldKind;
  enumValues: readonly string[] | null;
  filterable: boolean;
  sortable: boolean;
  groupable: boolean;
}): FieldDescription {
  return {
    name: field.name,
    label: field.label,
    kind: field.kind,
    enumValues: field.enumValues,
    filterable: field.filterable,
    sortable: field.sortable,
    groupable: field.groupable,
    operators: field.filterable
      ? operatorsForKind(field.kind).map((key) => ({
          key,
          label: OPERATORS[key].label,
          arity: OPERATORS[key].arity,
        }))
      : [],
  };
}
