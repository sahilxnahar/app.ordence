/**
 * Ordence — Custom Object Designer, shared presentation
 * Version: v0.27.0-alpha
 *
 * Pure. No React, no `@/db`, no I/O — so the designer's rules can be
 * tested without mounting anything, and so the record pages and the
 * designer cannot disagree about what a field is called.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ EVERY LIST IN THIS FILE IS DERIVED. NONE IS TYPED OUT.
 * ══════════════════════════════════════════════════════════════════════
 * The field types come from `DYNAMIC_FIELD_TYPES`, their labels and their
 * capabilities from `FIELD_TYPE_CATALOG`, the relation targets from
 * `RELATION_CORE_TABLES`, the caps from `lib/dynamic/limits.ts` and every
 * name check from `checkIdentifier`.
 *
 * The tempting alternative is a nice hand-written `{ value, label }` array
 * in the picker. It is what every builder UI starts as and it drifts on
 * the first Monday somebody adds a type to the engine and forgets the
 * screen — or, worse, removes one and leaves the screen offering it. The
 * second failure is expensive: somebody designs a record type around a
 * field type that no longer exists and finds out when the save is refused,
 * after they have entered forty fields.
 *
 * ⚠️ AND THE VALIDATION IS THE ENGINE'S OWN, NOT A COPY OF IT.
 * `checkIdentifier` knows about reserved words, system columns, homoglyphs
 * and BYTE length. A `/^[a-z_]+$/` in this file would pass `select`,
 * `tenant_id` and a Cyrillic `е` — three names the server refuses — so the
 * form would accept what the server will not, which is the one thing a
 * client-side check exists to prevent.
 */

import {
  DYNAMIC_FIELD_TYPES,
  FIELD_TYPE_CATALOG,
  RELATION_CORE_TABLES,
  fieldTypeSpec,
  isValidSelectValue,
  type DynamicFieldType,
  type SelectChoice,
} from "@/lib/dynamic/field-types";
import {
  checkIdentifier,
  suggestApiName,
  MAX_FIELD_API_NAME_LENGTH,
  MAX_OBJECT_API_NAME_LENGTH,
} from "@/lib/dynamic/identifiers";
import {
  MAX_FIELDS_PER_OBJECT,
  MAX_INDEXED_FIELDS_PER_OBJECT,
  MAX_OBJECTS_PER_TENANT,
  MAX_SELECT_OPTIONS,
} from "@/lib/dynamic/limits";

/* ------------------------------------------------------------------ */
/* THE SHAPES THE SCREENS RENDER FROM                                  */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ DECLARED HERE RATHER THAN IMPORTED FROM `@/db/schema`.
 *
 * The same call the inventory grid makes. A client component that names
 * `DynamicField` pulls the drizzle schema graph into its type surface and
 * makes it awkward to render in a test; a plain structural type crosses
 * the server boundary as JSON, which is all that actually travels.
 */
export type ObjectFieldRow = {
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
  options: SelectChoice[];
  relationObjectId: string | null;
  relationCoreTable: string | null;
  sortOrder: number;
};

export type ObjectSummary = {
  id: string;
  apiName: string;
  label: string;
  pluralLabel: string;
  description: string | null;
  icon: string;
  displayFieldApiName: string | null;
  physicalTableName: string;
  /** ISO-8601. A `Date` does not survive the server boundary intact. */
  createdAt: string;
  fieldCount: number;
  /**
   * Live records, `deleted_at IS NULL` — the same predicate
   * `dynamic_drop_object_table` counts with.
   *
   * ⚠️ `null` MEANS "NOT COUNTED", NOT "ZERO". The count is one query per
   * object, and a page that silently renders a failed count as 0 is the
   * page somebody drops a table from believing it was empty.
   */
  recordCount: number | null;
};

/** What a relation field may point at, once it has been resolved. */
export type RelationTargetOption =
  | { kind: "object"; objectId: string; label: string }
  | { kind: "core"; table: string; label: string };

/* ------------------------------------------------------------------ */
/* THE CATALOGUE, AS THE PICKER SEES IT                                */
/* ------------------------------------------------------------------ */

export type FieldTypeOption = {
  value: DynamicFieldType;
  label: string;
  hint: string;
  /** The physical column type. Shown, because it is what "fixed" means. */
  pgType: string;
  requiresOptions: boolean;
  requiresTarget: boolean;
  supportsUnique: boolean;
  supportsIndex: boolean;
};

/**
 * ⭐ THE PICKER'S ONLY SOURCE OF OPTIONS.
 *
 * Order is the engine's order, which is the Postgres enum's order. Not
 * sorted alphabetically here: a picker whose order differs from every
 * other listing of the same vocabulary is one more thing to reconcile
 * when two people are looking at different screens.
 */
export const FIELD_TYPE_OPTIONS: readonly FieldTypeOption[] = DYNAMIC_FIELD_TYPES.map(
  (value) => {
    const spec = FIELD_TYPE_CATALOG[value];
    return {
      value,
      label: spec.label,
      hint: spec.hint,
      pgType: spec.pgType,
      requiresOptions: spec.requiresOptions,
      requiresTarget: spec.requiresTarget,
      supportsUnique: spec.supportsUnique,
      supportsIndex: spec.supportsIndex,
    };
  },
);

export function fieldTypeOption(type: DynamicFieldType): FieldTypeOption {
  const found = FIELD_TYPE_OPTIONS.find((o) => o.value === type);
  // Fails closed, like `fieldTypeSpec`. A type the screen cannot describe
  // must not render as a blank row that somebody then saves.
  if (!found) {
    throw new Error(
      `[dynamic] No presentation for field type "${String(type)}". The screen ` +
        `is behind the engine — refusing to render a field it cannot describe.`,
    );
  }
  return found;
}

/**
 * The sentence shown where a type dropdown would be, on a field that
 * already exists.
 *
 * ⚠️ THE ENGINE HAS NO "CHANGE THE TYPE" OPERATION AND THIS IS WHY.
 * `updateDynamicFieldSchema` accepts neither `apiName` nor `fieldType`:
 * an `ALTER COLUMN … TYPE` rewrites the whole table under an ACCESS
 * EXCLUSIVE lock and either fails halfway or succeeds DESTRUCTIVELY —
 * `currency` → `number` silently reinterprets paise as rupees. So the UI
 * must not draw the control. A disabled dropdown reads as a permission
 * problem; a sentence reads as a rule, and it names the way forward.
 */
export const FIELD_TYPE_IS_FIXED_EXPLANATION =
  "The type is fixed once the column exists. Changing it would rewrite every " +
  "row under a full table lock and can lose data silently — money stored in " +
  "paise reinterpreted as rupees, for instance. Add a new field of the type " +
  "you want, copy the values across, then remove this one.";

/** Same argument, one level up, for an object's api name. */
export const API_NAME_IS_PERMANENT_EXPLANATION =
  "Permanent. It is part of the physical table name, so it cannot be changed " +
  "later without moving the table. The name people see is the label above, " +
  "and that can be changed as often as you like.";

export const LABEL_IS_SAFE_EXPLANATION =
  "Safe to change at any time. Renaming touches one row of metadata — no " +
  "table is locked, no data moves, nothing that points at this record type " +
  "breaks.";

/* ------------------------------------------------------------------ */
/* DRAFT FIELDS                                                        */
/* ------------------------------------------------------------------ */

export type DraftRelation =
  | { kind: "object"; objectId: string }
  | { kind: "core"; table: string };

/**
 * A field as the designer holds it, before it is a column.
 *
 * `id` is the seam between the two halves of the screen: `null` means
 * "not yet a column, everything is still editable", non-null means "a
 * real column exists and the type and name are now facts".
 */
export type DraftField = {
  /** React list key. Never sent anywhere. */
  key: string;
  id: string | null;
  apiName: string;
  /** False until somebody edits the name by hand; see `effectiveApiName`. */
  apiNameTouched: boolean;
  label: string;
  fieldType: DynamicFieldType;
  helpText: string;
  placeholder: string;
  isRequired: boolean;
  isUnique: boolean;
  isIndexed: boolean;
  isHidden: boolean;
  showInGrid: boolean;
  options: SelectChoice[];
  relation: DraftRelation | null;
};

let draftCounter = 0;

export function newDraftField(overrides: Partial<DraftField> = {}): DraftField {
  draftCounter += 1;
  return {
    key: `draft-${draftCounter}`,
    id: null,
    apiName: "",
    apiNameTouched: false,
    label: "",
    fieldType: DYNAMIC_FIELD_TYPES[0],
    helpText: "",
    placeholder: "",
    isRequired: false,
    isUnique: false,
    isIndexed: false,
    isHidden: false,
    showInGrid: true,
    options: [],
    relation: null,
    ...overrides,
  };
}

export function draftFromField(row: ObjectFieldRow): DraftField {
  draftCounter += 1;
  return {
    key: `field-${row.id}`,
    id: row.id,
    apiName: row.apiName,
    apiNameTouched: true,
    label: row.label,
    fieldType: row.fieldType,
    helpText: row.helpText ?? "",
    placeholder: row.placeholder ?? "",
    isRequired: row.isRequired,
    isUnique: row.isUnique,
    isIndexed: row.isIndexed,
    isHidden: row.isHidden,
    showInGrid: row.showInGrid,
    options: row.options ?? [],
    relation: row.relationObjectId
      ? { kind: "object", objectId: row.relationObjectId }
      : row.relationCoreTable
        ? { kind: "core", table: row.relationCoreTable }
        : null,
  };
}

/**
 * The api name a draft would be saved under.
 *
 * ⚠️ `suggestApiName` IS A SUGGESTION, NOT A SANITISER. Its output goes
 * in a box a person can see and edit, and whatever they finally submit is
 * checked by `checkIdentifier` exactly as submitted — never repaired. See
 * the header of `lib/dynamic/identifiers.ts` for why a pipeline that
 * repairs before it validates has validated a different string from the
 * one that was typed.
 */
export function effectiveApiName(draft: DraftField): string {
  if (draft.apiNameTouched) return draft.apiName;
  return suggestApiName(draft.label, "field");
}

export function suggestObjectApiName(label: string): string {
  return suggestApiName(label, "object");
}

/* ------------------------------------------------------------------ */
/* CLIENT-SIDE REFUSALS — THE ENGINE'S, NOT A SECOND OPINION           */
/* ------------------------------------------------------------------ */

export type DraftProblem = { where: string; message: string };

/**
 * Everything wrong with one draft field, in the engine's own words.
 *
 * ⚠️ THIS IS A COURTESY, NOT A GATE. `planField` runs again on the server
 * and the database checks a third time. What it buys is that the person
 * finds out while they are still looking at the box, rather than after a
 * round trip that discards nothing but tells them nothing either.
 */
export function checkDraftField(
  draft: DraftField,
  siblings: readonly DraftField[],
): DraftProblem[] {
  const problems: DraftProblem[] = [];
  const apiName = effectiveApiName(draft);

  if (draft.label.trim() === "") {
    problems.push({ where: "label", message: "A label is required." });
  }

  if (apiName === "") {
    problems.push({
      where: "apiName",
      message:
        "A name is required. Nothing could be suggested from the label — type one.",
    });
  } else {
    const verdict = checkIdentifier(apiName, "field");
    if (!verdict.ok) problems.push({ where: "apiName", message: verdict.error });
  }

  const clash = siblings.some(
    (other) => other.key !== draft.key && effectiveApiName(other) === apiName && apiName !== "",
  );
  if (clash) {
    problems.push({
      where: "apiName",
      message: `Another field on this record type is already called "${apiName}".`,
    });
  }

  const spec = fieldTypeSpec(draft.fieldType);
  const typeLabel = spec.label;

  if (spec.requiresOptions) {
    if (draft.options.length === 0) {
      problems.push({
        where: "options",
        message:
          `A "${typeLabel}" field needs at least one choice. With none, the ` +
          `CHECK constraint on the column would allow nothing and every write ` +
          `to the field would fail.`,
      });
    }
    if (draft.options.length > MAX_SELECT_OPTIONS) {
      problems.push({
        where: "options",
        message:
          `At most ${MAX_SELECT_OPTIONS} choices. Beyond that it is a list of ` +
          `records rather than a list of choices — use "Link to a record".`,
      });
    }
    const seen = new Set<string>();
    for (const option of draft.options) {
      if (!isValidSelectValue(option.value)) {
        problems.push({
          where: "options",
          message:
            `"${option.value}" is not a usable choice value. Letters, digits, ` +
            `spaces, dots, hyphens and underscores, up to 59 characters — the ` +
            `value is written into a CHECK constraint, so it has to stay ` +
            `readable in an error message.`,
        });
      } else if (seen.has(option.value)) {
        problems.push({
          where: "options",
          message: `The choice "${option.value}" is listed twice.`,
        });
      }
      seen.add(option.value);
      if (option.label.trim() === "") {
        problems.push({
          where: "options",
          message: `The choice "${option.value}" has no label.`,
        });
      }
    }
  } else if (draft.options.length > 0) {
    problems.push({
      where: "options",
      message: `A "${typeLabel}" field does not take a list of choices.`,
    });
  }

  if (spec.requiresTarget && !draft.relation) {
    problems.push({
      where: "relation",
      message: 'A "Link to a record" field must say what it links to.',
    });
  }
  if (!spec.requiresTarget && draft.relation) {
    problems.push({
      where: "relation",
      message: `A "${typeLabel}" field cannot link to another record.`,
    });
  }

  if (draft.isUnique && !spec.supportsUnique) {
    problems.push({
      where: "isUnique",
      message: `A "${typeLabel}" field cannot be unique.`,
    });
  }
  if (draft.isIndexed && !spec.supportsIndex) {
    problems.push({
      where: "isIndexed",
      message: `A "${typeLabel}" field cannot be indexed.`,
    });
  }

  return problems;
}

/** Everything wrong with the whole record type. */
export function checkObjectDraft(input: {
  label: string;
  pluralLabel: string;
  apiName: string;
  fields: readonly DraftField[];
  /** Omitted on an existing object, whose fields are added one at a time. */
  requireAtLeastOneField?: boolean;
}): DraftProblem[] {
  const problems: DraftProblem[] = [];

  if (input.label.trim() === "") {
    problems.push({ where: "label", message: "A name is required." });
  }
  if (input.pluralLabel.trim() === "") {
    problems.push({ where: "pluralLabel", message: "A plural name is required." });
  }

  if (input.apiName === "") {
    problems.push({
      where: "apiName",
      message:
        "An api name is required. Nothing could be suggested from the label — type one.",
    });
  } else {
    const verdict = checkIdentifier(input.apiName, "object");
    if (!verdict.ok) problems.push({ where: "apiName", message: verdict.error });
  }

  if (input.requireAtLeastOneField !== false && input.fields.length === 0) {
    problems.push({
      where: "fields",
      message:
        "Add at least one field. A record type with none is a table of six " +
        "system columns: every record looks identical and the only thing left " +
        "to do with it is drop it.",
    });
  }

  if (input.fields.length > MAX_FIELDS_PER_OBJECT) {
    problems.push({
      where: "fields",
      message: `At most ${MAX_FIELDS_PER_OBJECT} fields on one record type.`,
    });
  }

  const indexed = input.fields.filter((f) => f.isIndexed).length;
  if (indexed > MAX_INDEXED_FIELDS_PER_OBJECT) {
    problems.push({
      where: "fields",
      message:
        `At most ${MAX_INDEXED_FIELDS_PER_OBJECT} indexed fields. Every index ` +
        `is written on every insert and update — a table with an index on ` +
        `every field is slower to write than to scan.`,
    });
  }

  for (const field of input.fields) {
    for (const problem of checkDraftField(field, input.fields)) {
      problems.push({
        where: `field:${field.key}:${problem.where}`,
        message: `${field.label || effectiveApiName(field) || "New field"}: ${problem.message}`,
      });
    }
  }

  return problems;
}

/* ------------------------------------------------------------------ */
/* REORDERING                                                          */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ UP/DOWN, NOT DRAG.
 *
 * Drag-and-drop is the obvious gesture and it is unreachable from a
 * keyboard, unusable with a screen reader and hostile on a touch screen
 * inside a scrolling page. A pair of buttons is reachable by everybody,
 * and it is what `components/workflows/step-list.tsx` does for the same
 * reason. Returns the same array when the move is a no-op, so a caller
 * can skip a re-render.
 */
export function moveDraft<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) {
    return list as T[];
  }
  const next = [...list];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved!);
  return next;
}

/* ------------------------------------------------------------------ */
/* PAYLOADS                                                            */
/* ------------------------------------------------------------------ */

/** One draft, in the shape `fieldDefinitionSchema` parses. */
export function fieldPayload(draft: DraftField, sortOrder: number) {
  const spec = fieldTypeSpec(draft.fieldType);
  return {
    apiName: effectiveApiName(draft),
    label: draft.label.trim(),
    fieldType: draft.fieldType,
    helpText: draft.helpText.trim() === "" ? undefined : draft.helpText.trim(),
    placeholder: draft.placeholder.trim() === "" ? undefined : draft.placeholder.trim(),
    isRequired: draft.isRequired,
    isUnique: draft.isUnique && spec.supportsUnique,
    isIndexed: draft.isIndexed && spec.supportsIndex,
    isHidden: draft.isHidden,
    showInGrid: draft.showInGrid,
    options: spec.requiresOptions ? draft.options : [],
    relation: spec.requiresTarget ? draft.relation : null,
    sortOrder,
  };
}

/* ------------------------------------------------------------------ */
/* LIMITS, STATED BEFORE THEY ARE HIT                                  */
/* ------------------------------------------------------------------ */

export type LimitReading = {
  used: number;
  max: number;
  /** 0–100, for a bar. The bar is never the only carrier of the number. */
  pct: number;
  /** True once there is no room left. */
  full: boolean;
  /** True in the last fifth, where a warning is still actionable. */
  nearlyFull: boolean;
};

export function readLimit(used: number, max: number): LimitReading {
  const pct = max <= 0 ? 100 : Math.min(100, Math.round((used / max) * 100));
  return { used, max, pct, full: used >= max, nearlyFull: used >= max * 0.8 };
}

export const OBJECT_LIMIT_EXPLANATION =
  `A workspace may define ${MAX_OBJECTS_PER_TENANT} record types. Each one is a ` +
  `real table, and a catalogue full of them slows every deployment down for ` +
  `everybody on the instance — so the cap is a shared cost, not an upsell.`;

export const FIELD_LIMIT_EXPLANATION =
  `A record type may have ${MAX_FIELDS_PER_OBJECT} fields. PostgreSQL's own ` +
  `ceiling is 1600 columns and it is the wrong number to aim at: a table near ` +
  `it is unreadable in any grid, and adding a column to it holds a lock for ` +
  `measurably longer.`;

export const INDEX_LIMIT_EXPLANATION =
  `At most ${MAX_INDEXED_FIELDS_PER_OBJECT} fields on one record type may be ` +
  `indexed. Every index is written on every insert and update.`;

export {
  MAX_FIELDS_PER_OBJECT,
  MAX_OBJECTS_PER_TENANT,
  MAX_INDEXED_FIELDS_PER_OBJECT,
  MAX_SELECT_OPTIONS,
  MAX_FIELD_API_NAME_LENGTH,
  MAX_OBJECT_API_NAME_LENGTH,
  RELATION_CORE_TABLES,
};

/* ------------------------------------------------------------------ */
/* VALUES, FOR READING                                                 */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ Lakh and crore. "₹85,00,000" is how the number is spoken, written and
 * negotiated in this market; "₹8,500,000" makes an Indian reader stop and
 * count digits. Same call as the inventory grid.
 *
 * ⚠️ `BigInt`, never `Number`. Above 2^53 a JavaScript number silently
 * loses the last paise, which is the exact defect the `bigint` column
 * exists to prevent.
 */
export function formatPaise(raw: unknown): string {
  if (raw === null || raw === undefined || raw === "") return "—";
  let minor: bigint;
  try {
    minor = BigInt(typeof raw === "string" ? raw.trim() : (raw as number));
  } catch {
    return String(raw);
  }
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const rupees = abs / 100n;
  const paise = abs % 100n;
  const grouped = new Intl.NumberFormat("en-IN").format(rupees);
  return `${negative ? "−" : ""}₹${grouped}.${paise.toString().padStart(2, "0")}`;
}

/**
 * One stored value, as text.
 *
 * ⚠️ DETERMINISTIC, AND UTC WHERE IT MATTERS. `toLocaleString()` renders
 * differently on the server and in the browser, which React reports as a
 * hydration mismatch and a reader reports as the time changing when the
 * page finishes loading. A `datetime` is an instant and the column stores
 * a timezone, so the zone is named rather than assumed.
 */
export function formatFieldValue(field: ObjectFieldRow, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";

  switch (field.fieldType) {
    case "boolean":
      return value === true || value === "true" ? "Yes" : "No";

    case "currency":
      return formatPaise(value);

    case "select": {
      const match = field.options.find((o) => o.value === value);
      return match ? match.label : String(value);
    }

    case "multi_select": {
      const list = Array.isArray(value) ? value : [value];
      if (list.length === 0) return "—";
      return list
        .map((item) => field.options.find((o) => o.value === item)?.label ?? String(item))
        .join(", ");
    }

    case "date":
      return toDateInputValue(value);

    case "datetime": {
      const iso = toIsoOrNull(value);
      return iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : String(value);
    }

    case "number":
      return String(value);

    default:
      return String(value);
  }
}

function toIsoOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

/** `YYYY-MM-DD`, which is what `<input type="date">` wants and stores. */
export function toDateInputValue(value: unknown): string {
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const iso = toIsoOrNull(value);
    return iso ? iso.slice(0, 10) : value;
  }
  const iso = toIsoOrNull(value);
  return iso ? iso.slice(0, 10) : "";
}

/**
 * `YYYY-MM-DDTHH:mm` in the READER'S timezone, which is what
 * `<input type="datetime-local">` requires.
 *
 * ⚠️ The conversion back is `new Date(local).toISOString()` in
 * `datetimeInputToIso`. Sending the local string to the server instead
 * would have it parsed in the SERVER'S zone — the classic "the meeting
 * moved by five and a half hours" defect.
 */
export function toDateTimeInputValue(value: unknown): string {
  const iso = toIsoOrNull(value);
  if (!iso) return "";
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export function datetimeInputToIso(local: string): string {
  if (local.trim() === "") return "";
  const parsed = new Date(local);
  return Number.isNaN(parsed.getTime()) ? local : parsed.toISOString();
}

/**
 * How a record identifies itself: the display field's value, or the id.
 *
 * ⚠️ NEVER an empty string. A picker of blank rows is unusable, and the
 * engine already refuses to remove the display field for the same reason.
 */
export function recordTitle(
  fields: readonly ObjectFieldRow[],
  displayFieldApiName: string | null,
  row: Record<string, unknown>,
): string {
  const field = fields.find((f) => f.apiName === displayFieldApiName);
  if (field) {
    const rendered = formatFieldValue(field, row[field.apiName]);
    if (rendered !== "—") return rendered;
  }
  return `Record ${String(row.id ?? "").slice(0, 8)}`;
}

/** The columns a grid shows: visible, in the field order, capped. */
export function gridFields(fields: readonly ObjectFieldRow[], limit = 8): ObjectFieldRow[] {
  return fields.filter((f) => f.showInGrid && !f.isHidden).slice(0, limit);
}

export function relationTargetLabel(
  field: ObjectFieldRow,
  objects: readonly { id: string; label: string }[],
): string {
  if (field.relationCoreTable) return field.relationCoreTable;
  if (field.relationObjectId) {
    return (
      objects.find((o) => o.id === field.relationObjectId)?.label ??
      "another record type"
    );
  }
  return "—";
}
