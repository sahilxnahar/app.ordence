import "server-only";

/**
 * Ordence — Server → Screen Mapping For Custom Objects
 * Version: v0.27.0-alpha
 *
 * The one place a `dynamic_objects` / `dynamic_fields` row becomes the
 * plain structural shape the client components render from.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE MAPPING IS HERE AND NOT IN EACH PAGE
 * ══════════════════════════════════════════════════════════════════════
 * Six screens read the same two tables. A `Date` that survives as a `Date`
 * on one of them and as an ISO string on another is a hydration mismatch
 * on whichever one nobody opened during review; a `bigint` that is not
 * turned into a string does not cross the server boundary at all. Doing it
 * once means all six agree.
 */

import {
  listDynamicRecords,
  getDynamicObject,
} from "@/server/actions/dynamic-objects";
import type {
  ObjectFieldRow,
  ObjectSummary,
  RelationTargetOption,
} from "@/components/dynamic/presentation";
import { recordTitle } from "@/components/dynamic/presentation";
import type { DynamicFieldType, SelectChoice } from "@/lib/dynamic/field-types";

/** The subset of a `dynamic_fields` row the screens use. */
type RawField = {
  id: string;
  apiName: string;
  label: string;
  helpText: string | null;
  placeholder: string | null;
  fieldType: DynamicFieldType;
  isRequired: boolean;
  isUnique: boolean;
  isIndexed: boolean;
  isHidden: boolean;
  showInGrid: boolean;
  options: SelectChoice[] | null;
  relationObjectId: string | null;
  relationCoreTable: string | null;
  sortOrder: number;
};

type RawObject = {
  id: string;
  apiName: string;
  label: string;
  pluralLabel: string;
  description: string | null;
  icon: string;
  displayFieldApiName: string | null;
  physicalTableName: string;
  createdAt: Date | string;
  fields: RawField[];
};

export function toFieldRow(field: RawField): ObjectFieldRow {
  return {
    id: field.id,
    apiName: field.apiName,
    label: field.label,
    helpText: field.helpText,
    placeholder: field.placeholder,
    fieldType: field.fieldType,
    isRequired: field.isRequired,
    isUnique: field.isUnique,
    isIndexed: field.isIndexed,
    isHidden: field.isHidden,
    showInGrid: field.showInGrid,
    options: field.options ?? [],
    relationObjectId: field.relationObjectId,
    relationCoreTable: field.relationCoreTable,
    sortOrder: field.sortOrder,
  };
}

export function toFieldRows(fields: RawField[]): ObjectFieldRow[] {
  return [...fields].sort((a, b) => a.sortOrder - b.sortOrder).map(toFieldRow);
}

export function toObjectSummary(
  object: RawObject,
  recordCount: number | null,
): ObjectSummary {
  return {
    id: object.id,
    apiName: object.apiName,
    label: object.label,
    pluralLabel: object.pluralLabel,
    description: object.description,
    icon: object.icon,
    displayFieldApiName: object.displayFieldApiName,
    physicalTableName: object.physicalTableName,
    createdAt:
      object.createdAt instanceof Date
        ? object.createdAt.toISOString()
        : String(object.createdAt),
    fieldCount: object.fields.length,
    recordCount,
  };
}

/**
 * ⭐ THE LIVE RECORD COUNT, WHICH IS THE NUMBER THE DROP DIALOG DEMANDS.
 *
 * `listDynamicRecords` with a page size of one returns `total`, which is a
 * `count(*)` over the same predicate `dynamic_drop_object_table` uses —
 * `deleted_at IS NULL`. Asking for the count any other way would risk two
 * numbers that disagree, and one of them would be the one somebody typed
 * into a confirmation.
 *
 * ⚠️ A FAILURE RETURNS `null`, NEVER `0`. The screens render `null` as
 * "not counted" and the drop dialog refuses to offer the drop at all. A
 * failed count rendered as zero is how a full table gets dropped.
 */
export async function liveRecordCount(objectId: string): Promise<number | null> {
  try {
    const result = await listDynamicRecords({ objectId, page: 1, pageSize: 1 });
    return result.ok ? result.data.total : null;
  } catch {
    return null;
  }
}

/**
 * What a `relation` field on THIS object may point at.
 *
 * Only the tenant's other record types are listed here; the built-in
 * allowlist is added by the field editor from `RELATION_CORE_TABLES`, so
 * that list cannot drift from the engine's.
 */
export function relationTargets(
  objects: readonly { id: string; label: string }[],
  excludeObjectId?: string,
): RelationTargetOption[] {
  return objects
    .filter((object) => object.id !== excludeObjectId)
    .map((object) => ({
      kind: "object" as const,
      objectId: object.id,
      label: object.label,
    }));
}

/**
 * Options for every `relation` field that points at another CUSTOM record
 * type, so the form can render a picker instead of a box for a uuid.
 *
 * ⚠️ NOTHING IS RESOLVED FOR A LINK INTO A CORE TABLE. There is no generic
 * reader for `contacts`, `units`, `leads` and the rest — each has its own
 * permission and its own idea of what a row is called — and inventing one
 * here would be a second query layer with none of the first one's checks.
 * The form says so where the picker would have been.
 *
 * ⚠️ CAPPED AT ONE PAGE PER TARGET. A dropdown is not a search, and
 * loading forty thousand rows to render one is how a form page times out.
 */
const RELATION_CHOICE_LIMIT = 200;

export async function relationChoices(
  fields: readonly ObjectFieldRow[],
): Promise<Record<string, { id: string; label: string }[]>> {
  const targets = fields.filter(
    (field) => field.fieldType === "relation" && field.relationObjectId,
  );
  if (targets.length === 0) return {};

  const entries = await Promise.all(
    targets.map(async (field) => {
      const targetId = field.relationObjectId!;
      try {
        const [definition, page] = await Promise.all([
          getDynamicObject({ objectId: targetId }),
          listDynamicRecords({
            objectId: targetId,
            page: 1,
            pageSize: RELATION_CHOICE_LIMIT,
          }),
        ]);
        if (!definition.ok || !page.ok) return [field.apiName, []] as const;

        const targetFields = toFieldRows(definition.data.fields as RawField[]);
        const choices = page.data.rows.map((row) => ({
          id: String(row.id),
          label: recordTitle(
            targetFields,
            definition.data.displayFieldApiName,
            row,
          ),
        }));
        return [field.apiName, choices] as const;
      } catch {
        return [field.apiName, []] as const;
      }
    }),
  );

  return Object.fromEntries(entries.filter(([, choices]) => choices.length > 0));
}
