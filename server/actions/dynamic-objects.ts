"use server";

/**
 * Ordence — Runtime Custom Object Actions
 * Version: v0.24.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION.
 *
 * Next.js turns every export of a `"use server"` module into a callable
 * RPC endpoint. A constant, a schema or a type exported from here would
 * be published to the internet as one — six schemas were found doing
 * exactly that in Phase 7. The catalogues live in `lib/dynamic/`, the
 * schemas in `lib/validators/dynamic.ts`, and the implementations in
 * `server/dynamic/`. This file is the boundary and nothing else.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE ACTIONS ARE THIN AND THE DDL IS NOT HERE
 * ══════════════════════════════════════════════════════════════════════
 * A record type gets created from more than one place before long: this
 * file today, an industry template seeder, an import, and eventually an
 * API route. If the transaction lived here, each of those would grow its
 * own copy — and the one that mattered (metadata and table together, RLS
 * attached, caps counted) would be right in one of them and forgotten in
 * the rest.
 *
 * So `server/dynamic/objects.ts` is the single door and this file knocks
 * on it.
 */

import { revalidatePath } from "next/cache";
import {
  addDynamicField as addDynamicFieldImpl,
  archiveDynamicObject as archiveDynamicObjectImpl,
  createDynamicObject as createDynamicObjectImpl,
  dropDynamicObject as dropDynamicObjectImpl,
  getDynamicObject as getDynamicObjectImpl,
  listDynamicObjects as listDynamicObjectsImpl,
  removeDynamicField as removeDynamicFieldImpl,
  renameDynamicObject as renameDynamicObjectImpl,
  updateDynamicField as updateDynamicFieldImpl,
} from "@/server/dynamic/objects";
import {
  createDynamicRecord as createDynamicRecordImpl,
  deleteDynamicRecord as deleteDynamicRecordImpl,
  getDynamicRecord as getDynamicRecordImpl,
  listDynamicRecords as listDynamicRecordsImpl,
  updateDynamicRecord as updateDynamicRecordImpl,
} from "@/server/dynamic/records";

/* ------------------------------------------------------------------ */
/* SCHEMA                                                              */
/* ------------------------------------------------------------------ */

export async function listDynamicObjects() {
  return listDynamicObjectsImpl();
}

export async function getDynamicObject(input: { objectId: string }) {
  return getDynamicObjectImpl(input);
}

export async function createDynamicObject(input: unknown) {
  const result = await createDynamicObjectImpl(input);
  if (result.ok) revalidatePath("/objects");
  return result;
}

export async function renameDynamicObject(input: unknown) {
  const result = await renameDynamicObjectImpl(input);
  if (result.ok) revalidatePath("/objects");
  return result;
}

export async function archiveDynamicObject(input: unknown) {
  const result = await archiveDynamicObjectImpl(input);
  if (result.ok) revalidatePath("/objects");
  return result;
}

/**
 * ⭐ THE DESTRUCTIVE ONE. Requires `custom_objects:drop_object` (on the
 * dangerous list), the object's api name typed back, AND the live record
 * count the caller believes they are destroying — checked against the
 * real count inside the database.
 */
export async function dropDynamicObject(input: unknown) {
  const result = await dropDynamicObjectImpl(input);
  if (result.ok) revalidatePath("/objects");
  return result;
}

/* ------------------------------------------------------------------ */
/* FIELDS                                                              */
/* ------------------------------------------------------------------ */

export async function addDynamicField(input: unknown) {
  const result = await addDynamicFieldImpl(input);
  if (result.ok) revalidatePath("/objects");
  return result;
}

export async function updateDynamicField(input: unknown) {
  const result = await updateDynamicFieldImpl(input);
  if (result.ok) revalidatePath("/objects");
  return result;
}

/** ⚠️ Drops the column and every value in it. See the implementation. */
export async function removeDynamicField(input: unknown) {
  const result = await removeDynamicFieldImpl(input);
  if (result.ok) revalidatePath("/objects");
  return result;
}

/* ------------------------------------------------------------------ */
/* RECORDS                                                             */
/* ------------------------------------------------------------------ */

export async function listDynamicRecords(input: unknown) {
  return listDynamicRecordsImpl(input);
}

export async function getDynamicRecord(input: unknown) {
  return getDynamicRecordImpl(input);
}

export async function createDynamicRecord(input: unknown) {
  const result = await createDynamicRecordImpl(input);
  if (result.ok) revalidatePath("/objects");
  return result;
}

export async function updateDynamicRecord(input: unknown) {
  const result = await updateDynamicRecordImpl(input);
  if (result.ok) revalidatePath("/objects");
  return result;
}

export async function deleteDynamicRecord(input: unknown) {
  const result = await deleteDynamicRecordImpl(input);
  if (result.ok) revalidatePath("/objects");
  return result;
}
