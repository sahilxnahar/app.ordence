"use server";

/**
 * Ordence — Saved View Actions
 * Version: v0.25.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION.
 *
 * Next.js turns every export of a `"use server"` module into a callable
 * RPC endpoint. A constant, a schema or a type exported from here would
 * be published to the internet as one. The registry lives in
 * `lib/views/`, the schemas in `lib/validators/views.ts`, and the
 * implementations in `server/views/` — this file is the boundary and
 * nothing else.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE ACTIONS ARE THIN
 * ══════════════════════════════════════════════════════════════════════
 * A view is run from three places: a list page, a board, and (once the
 * export path lands) a background job. Only the first two are server
 * actions. If the resolution and the gate lived in this file, the third
 * would grow its own copy — and Gate 5, the check that stops a shared
 * view widening access, would exist in two of the three.
 *
 * So `server/views/query.ts` is the single door and this file knocks on
 * it.
 */

import { revalidatePath } from "next/cache";
import {
  createView as createViewImpl,
  defaultDefinitionFor as defaultDefinitionForImpl,
  deleteView as deleteViewImpl,
  getView as getViewImpl,
  listViews as listViewsImpl,
  setDefaultView as setDefaultViewImpl,
  setWorkspaceDefault as setWorkspaceDefaultImpl,
  updateView as updateViewImpl,
} from "@/server/views/definitions";
import { runBoard as runBoardImpl, runView as runViewImpl } from "@/server/views/query";
import { describeViewObjects as describeViewObjectsImpl } from "@/server/views/catalog";

/* ------------------------------------------------------------------ */
/* READS                                                              */
/* ------------------------------------------------------------------ */

export async function listSavedViews(input?: unknown) {
  return listViewsImpl(input ?? {});
}

export async function getSavedView(input: { id: string }) {
  return getViewImpl(input);
}

/** The field catalogue for the builder — what may be filtered and sorted. */
export async function describeViewObject(input: unknown) {
  return describeViewObjectsImpl(input);
}

export async function getDefaultViewDefinition(input: {
  objectKey: string;
  dynamicObjectId?: string | null;
}) {
  return defaultDefinitionForImpl(input);
}

/* ------------------------------------------------------------------ */
/* RUNNING                                                             */
/* ------------------------------------------------------------------ */

export async function runSavedView(input: unknown) {
  return runViewImpl(input);
}

export async function runSavedBoard(input: unknown) {
  return runBoardImpl(input);
}

/* ------------------------------------------------------------------ */
/* WRITES                                                              */
/* ------------------------------------------------------------------ */

export async function createSavedView(input: unknown) {
  const result = await createViewImpl(input);
  if (result.ok) revalidatePath("/");
  return result;
}

export async function updateSavedView(input: unknown) {
  const result = await updateViewImpl(input);
  if (result.ok) revalidatePath("/");
  return result;
}

export async function deleteSavedView(input: unknown) {
  const result = await deleteViewImpl(input);
  if (result.ok) revalidatePath("/");
  return result;
}

export async function setMyDefaultView(input: unknown) {
  const result = await setDefaultViewImpl(input);
  if (result.ok) revalidatePath("/");
  return result;
}

export async function setWorkspaceDefaultView(input: unknown) {
  const result = await setWorkspaceDefaultImpl(input);
  if (result.ok) revalidatePath("/");
  return result;
}
