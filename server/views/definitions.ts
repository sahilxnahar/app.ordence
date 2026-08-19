import "server-only";

/**
 * Ordence — Saved View CRUD
 * Version: v0.25.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE TWO RULES EVERY FUNCTION IN THIS FILE OBEYS
 * ══════════════════════════════════════════════════════════════════════
 *
 * 1. A VIEW IS ONLY VISIBLE IF IT IS YOURS OR IT IS SHARED.
 *    Every read is `owner_user_id = me OR is_shared`, in the SQL, not in
 *    a filter afterwards. Somebody else's private view is a personal
 *    working list — an admin browsing other people's saved filters is
 *    reading their notes — and a list that is filtered in TypeScript is
 *    a list that leaks through the count, through the "not found" versus
 *    "denied" distinction, and through the next endpoint somebody adds.
 *
 * 2. ⭐ SAVING A VIEW REQUIRES ACCESS TO THE RECORD TYPE IT IS OVER.
 *    Not just `views:create`. Otherwise a contractor with `views:create`
 *    and no `bookings:read` can author a bookings view, share it, and
 *    hand it to somebody who WILL open it — which is not an escalation
 *    for them but is a way to have somebody else's authority applied to a
 *    question they wrote. More simply: a view over records you cannot see
 *    is a view you cannot test, and it will be wrong.
 */

import { and, eq, or, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { savedViews, savedViewDefaults } from "@/db/schema";
import { requirePermission, writeAudit } from "@/server/audit";
import { requireTenantContext } from "@/server/tenant-context";
import {
  guardViewWrite,
  requireViewObjectAccess,
  subjectFor,
  toViewActionError,
  viewFail,
  VIEW_PERMISSIONS,
} from "./guards";
import { resolveViewObject } from "./objects";
import {
  createViewSchema,
  deleteViewSchema,
  listViewsSchema,
  setDefaultViewSchema,
  setWorkspaceDefaultSchema,
  updateViewSchema,
} from "@/lib/validators/views";
import { canManageView, canShareView } from "@/lib/views/access";
import {
  problemsToFieldErrors,
  validateDefinition,
} from "@/lib/views/validation";
import {
  MAX_SAVED_VIEWS_PER_TENANT,
  MAX_VIEWS_PER_OBJECT_PER_USER,
} from "@/lib/views/limits";
import { emptyFilter } from "@/lib/views/types";
import type { ColumnSpec, FilterGroup, SortSpec, ViewType } from "@/lib/views/types";
import type { SavedView } from "@/db/schema";
import type { ActionResult } from "@/lib/validators/crm";

/* ------------------------------------------------------------------ */
/* READ                                                               */
/* ------------------------------------------------------------------ */

export type ViewSummary = {
  id: string;
  name: string;
  description: string | null;
  objectKey: string;
  dynamicObjectId: string | null;
  viewType: ViewType;
  isShared: boolean;
  isWorkspaceDefault: boolean;
  isMine: boolean;
  /** True when the caller may edit or delete it — drives the UI, not the gate. */
  canManage: boolean;
  updatedAt: Date;
};

/**
 * The picker: my views on this object, plus the shared ones.
 *
 * ⚠️ READS USE `requirePermission` ALONE — no `requireAccess`, no
 * `requireFeature`. A gate on a read produces the worst upgrade prompt in
 * the product: a page that will not render rather than a page that
 * renders and refuses the button.
 */
export async function listViews(
  input: unknown,
): Promise<ActionResult<{ views: ViewSummary[]; defaultViewId: string | null }>> {
  try {
    const ctx = await requirePermission(VIEW_PERMISSIONS.read);
    const params = listViewsSchema.parse(input ?? {});

    const rows = await withTenant(ctx.tenant.id, async (tx) => {
      const conditions = [
        eq(savedViews.tenantId, ctx.tenant.id),
        // ⭐ Rule 1, in the SQL.
        or(eq(savedViews.ownerUserId, ctx.user.id), eq(savedViews.isShared, true))!,
      ];

      if (params.objectKey) {
        conditions.push(eq(savedViews.objectKey, params.objectKey));
      }
      if (params.dynamicObjectId) {
        conditions.push(eq(savedViews.dynamicObjectId, params.dynamicObjectId));
      }

      const views = await tx
        .select()
        .from(savedViews)
        .where(and(...conditions))
        .orderBy(savedViews.name);

      const defaults = params.objectKey
        ? await tx
            .select()
            .from(savedViewDefaults)
            .where(
              and(
                eq(savedViewDefaults.tenantId, ctx.tenant.id),
                eq(savedViewDefaults.userId, ctx.user.id),
                eq(savedViewDefaults.objectKey, params.objectKey),
              ),
            )
            .limit(1)
        : [];

      return { views, personalDefault: defaults[0] ?? null };
    });

    const subject = subjectFor(ctx);

    const views = rows.views.map<ViewSummary>((view) => ({
      id: view.id,
      name: view.name,
      description: view.description,
      objectKey: view.objectKey,
      dynamicObjectId: view.dynamicObjectId,
      viewType: view.viewType,
      isShared: view.isShared,
      isWorkspaceDefault: view.isWorkspaceDefault,
      isMine: view.ownerUserId === ctx.user.id,
      canManage: canManageView(
        subject,
        { ownerUserId: view.ownerUserId, isShared: view.isShared },
        ctx.user.id,
      ).allowed,
      updatedAt: view.updatedAt,
    }));

    // The personal choice wins; the workspace default is the fallback for
    // somebody who has never chosen one.
    const defaultViewId =
      rows.personalDefault?.viewId ??
      rows.views.find((view) => view.isWorkspaceDefault)?.id ??
      null;

    return { ok: true, data: { views, defaultViewId } };
  } catch (err) {
    return toViewActionError(err, "listViews");
  }
}

/** Load one view, applying rule 1. Returns null rather than "denied". */
export async function loadView(
  tenantId: string,
  userId: string,
  viewId: string,
): Promise<SavedView | null> {
  return withTenant(tenantId, async (tx) => {
    const [view] = await tx
      .select()
      .from(savedViews)
      .where(
        and(
          eq(savedViews.id, viewId),
          eq(savedViews.tenantId, tenantId),
          // ⚠️ THE SAME CLAUSE AS THE LIST. A `getView` that omitted it
          // would be the endpoint that leaks what the list hides — and it
          // is always the second endpoint, written later, by somebody who
          // read the list and assumed the filtering happened elsewhere.
          or(eq(savedViews.ownerUserId, userId), eq(savedViews.isShared, true))!,
        ),
      )
      .limit(1);

    return view ?? null;
  });
}

export async function getView(input: {
  id: string;
}): Promise<ActionResult<SavedView>> {
  try {
    const ctx = await requirePermission(VIEW_PERMISSIONS.read);
    const view = await loadView(ctx.tenant.id, ctx.user.id, input.id);
    // ⚠️ "Does not exist" for both missing and invisible. The distinction
    // would confirm that somebody else has a view with this id.
    if (!view) return viewFail("That view does not exist.");
    return { ok: true, data: view };
  } catch (err) {
    return toViewActionError(err, "getView");
  }
}

/* ------------------------------------------------------------------ */
/* CREATE                                                             */
/* ------------------------------------------------------------------ */

export async function createView(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardViewWrite({
      operation: "views:create",
      feature: "views.saved",
      permission: VIEW_PERMISSIONS.create,
    });

    const params = createViewSchema.parse(input);

    /* --- ⭐ RULE 2 — access to the RECORD TYPE, not just to views --- */
    const object = await resolveViewObject(ctx.tenant.id, params);
    if (!object) return viewFail("That record type does not exist.");
    requireViewObjectAccess(ctx, object);

    /* --- Sharing is a second permission AND a second entitlement ---- */
    if (params.isShared) {
      if (!canShareView(subjectFor(ctx))) {
        return viewFail(
          "You can save this view for yourself, but sharing it with the whole " +
            "workspace needs permission an administrator grants.",
        );
      }
      const { requireFeature } = await import("@/server/entitlements");
      await requireFeature("views.shared", ctx);
    }

    /* --- The definition has to MEAN something ---------------------- */
    const verdict = validateDefinition(object, {
      name: params.name,
      viewType: params.viewType,
      filter: params.filter,
      sorts: params.sorts,
      groupBy: params.groupBy ?? null,
      dateField: params.dateField ?? null,
      columns: params.columns,
    });
    if (!verdict.ok) {
      return viewFail("Please check the view.", problemsToFieldErrors(verdict.problems));
    }

    const created = await withTenant(ctx.tenant.id, async (tx) => {
      /* --- ⭐ THE CAPS, CHECKED HERE AND IN THE DATABASE ----------- */
      //
      // ⚠️ THIS IS A CHECK-THEN-ACT RACE AND IT IS ALLOWED TO BE. Two
      // concurrent creates can both see 499 and both insert. The
      // consequence is 501 views, which is nothing; the trigger in
      // `SQL-FILES/0020` §6 is what makes the ceiling real, and this
      // check exists only to produce a sentence a person can act on
      // instead of a constraint violation. Locking the table to make the
      // count exact would be a far worse trade.
      const totalRows = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(savedViews)
        .where(eq(savedViews.tenantId, ctx.tenant.id));

      if (Number(totalRows[0]?.total ?? 0) >= MAX_SAVED_VIEWS_PER_TENANT) {
        return { kind: "tenant_full" as const };
      }

      const mineRows = await tx
        .select({ mine: sql<number>`count(*)::int` })
        .from(savedViews)
        .where(
          and(
            eq(savedViews.tenantId, ctx.tenant.id),
            eq(savedViews.ownerUserId, ctx.user.id),
            eq(savedViews.objectKey, params.objectKey),
          ),
        );

      if (Number(mineRows[0]?.mine ?? 0) >= MAX_VIEWS_PER_OBJECT_PER_USER) {
        return { kind: "user_full" as const };
      }

      const [row] = await tx
        .insert(savedViews)
        .values({
          tenantId: ctx.tenant.id,
          objectKey: params.objectKey,
          dynamicObjectId: params.dynamicObjectId ?? null,
          name: params.name,
          description: params.description ?? null,
          viewType: params.viewType,
          filter: params.filter as FilterGroup,
          sorts: params.sorts as SortSpec[],
          groupBy: params.groupBy ?? null,
          dateField: params.dateField ?? null,
          visibleColumns: params.columns as ColumnSpec[],
          ownerUserId: ctx.user.id,
          isShared: params.isShared,
          createdBy: ctx.user.id,
        })
        .returning({ id: savedViews.id });

      return { kind: "created" as const, id: row!.id };
    });

    if (created.kind === "tenant_full") {
      return viewFail(
        `This workspace already has ${MAX_SAVED_VIEWS_PER_TENANT} saved views, ` +
          `which is the maximum. Delete some before creating another.`,
      );
    }
    if (created.kind === "user_full") {
      return viewFail(
        `You already have ${MAX_VIEWS_PER_OBJECT_PER_USER} views on this record ` +
          `type. Tidy some up before adding another.`,
      );
    }

    await writeAudit(ctx, {
      action: "create",
      resourceType: "saved_view",
      resourceId: created.id,
      newValue: {
        name: params.name,
        objectKey: params.objectKey,
        viewType: params.viewType,
        isShared: params.isShared,
      },
      // ⚠️ Sharing is recorded at `notice`. "Who put this board in front
      // of the whole workspace?" is asked in anger, months later, and the
      // current state of the row cannot answer it.
      severity: params.isShared ? "notice" : "info",
    });

    return { ok: true, data: { id: created.id } };
  } catch (err) {
    return toViewActionError(err, "createView");
  }
}

/* ------------------------------------------------------------------ */
/* UPDATE                                                             */
/* ------------------------------------------------------------------ */

export async function updateView(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardViewWrite({
      operation: "views:update",
      feature: "views.saved",
      permission: VIEW_PERMISSIONS.update,
    });

    const params = updateViewSchema.parse(input);

    const existing = await loadView(ctx.tenant.id, ctx.user.id, params.id);
    if (!existing) return viewFail("That view does not exist.");

    /* --- ⭐ MAY THIS PERSON CHANGE IT? ----------------------------- */
    //
    // Not the same question as "may this person edit views". A shared
    // view is workspace furniture: half the sales floor has it pinned,
    // and the newest hire holding `views:update` must not be able to
    // rewrite the board they all work from.
    const decision = canManageView(
      subjectFor(ctx),
      { ownerUserId: existing.ownerUserId, isShared: existing.isShared },
      ctx.user.id,
    );
    if (!decision.allowed) return viewFail(decision.reason);

    const object = await resolveViewObject(ctx.tenant.id, {
      objectKey: existing.objectKey,
      dynamicObjectId: existing.dynamicObjectId,
    });
    if (!object) return viewFail("The record type this view is over no longer exists.");
    requireViewObjectAccess(ctx, object);

    if (params.isShared === true && !existing.isShared) {
      if (!canShareView(subjectFor(ctx))) {
        return viewFail(
          "Sharing a view with the whole workspace needs permission an " +
            "administrator grants.",
        );
      }
      const { requireFeature } = await import("@/server/entitlements");
      await requireFeature("views.shared", ctx);
    }

    const merged = {
      name: params.name ?? existing.name,
      viewType: params.viewType ?? existing.viewType,
      filter: (params.filter ?? existing.filter) as FilterGroup,
      sorts: (params.sorts ?? existing.sorts) as SortSpec[],
      groupBy: params.groupBy !== undefined ? params.groupBy : existing.groupBy,
      dateField: params.dateField !== undefined ? params.dateField : existing.dateField,
      columns: (params.columns ?? existing.visibleColumns) as ColumnSpec[],
    };

    // ⚠️ VALIDATED AS A WHOLE, NOT FIELD BY FIELD. Changing `viewType` to
    // `kanban` is legal on its own and illegal in combination with the
    // `groupBy` that is already stored — and a per-field validator would
    // accept it, leaving the database check constraint to produce an
    // error message written for a DBA.
    const verdict = validateDefinition(object, merged);
    if (!verdict.ok) {
      return viewFail("Please check the view.", problemsToFieldErrors(verdict.problems));
    }

    await withTenant(ctx.tenant.id, async (tx) => {
      await tx
        .update(savedViews)
        .set({
          name: merged.name,
          description:
            params.description !== undefined ? params.description : existing.description,
          viewType: merged.viewType,
          filter: merged.filter,
          sorts: merged.sorts,
          groupBy: merged.groupBy,
          dateField: merged.dateField,
          visibleColumns: merged.columns,
          ...(params.isShared !== undefined ? { isShared: params.isShared } : {}),
          // ⚠️ Un-sharing must also stop it being the workspace default —
          // the CHECK constraint would refuse the row otherwise, with a
          // message nobody can act on. The trigger in §5 cleans up the
          // per-user defaults that pointed at it.
          ...(params.isShared === false ? { isWorkspaceDefault: false } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(savedViews.id, params.id), eq(savedViews.tenantId, ctx.tenant.id)));
    });

    await writeAudit(ctx, {
      action: "update",
      resourceType: "saved_view",
      resourceId: params.id,
      oldValue: { name: existing.name, isShared: existing.isShared },
      newValue: { name: merged.name, isShared: params.isShared ?? existing.isShared },
      severity: params.isShared !== undefined ? "notice" : "info",
    });

    return { ok: true, data: { id: params.id } };
  } catch (err) {
    return toViewActionError(err, "updateView");
  }
}

/* ------------------------------------------------------------------ */
/* DELETE                                                             */
/* ------------------------------------------------------------------ */

/**
 * ⭐ A SHARED VIEW CANNOT BE DELETED BY SOMEBODY WHO CANNOT MANAGE IT.
 *
 * ⚠️ AND THIS IS A HARD DELETE, WHICH IS WHY THE CHECK MATTERS MORE HERE
 * THAN ANYWHERE ELSE IN THE PHASE. There is no `archived_at` on
 * `saved_views` and no undo — the reasoning is in `SQL-FILES/0020` §8 —
 * so the person who removes the board a team works from at 10am on a
 * Monday has removed it. The change log records who; it does not bring
 * the view back.
 */
export async function deleteView(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardViewWrite({
      operation: "views:delete",
      // A saved view is the customer's own report definition. Deleting
      // one under impersonation destroys work they cannot restore.
      impersonationOperation: "delete:saved_view",
      feature: "views.saved",
      permission: VIEW_PERMISSIONS.delete,
    });

    const params = deleteViewSchema.parse(input);

    const existing = await loadView(ctx.tenant.id, ctx.user.id, params.id);
    if (!existing) return viewFail("That view does not exist.");

    const decision = canManageView(
      subjectFor(ctx),
      { ownerUserId: existing.ownerUserId, isShared: existing.isShared },
      ctx.user.id,
    );
    if (!decision.allowed) return viewFail(decision.reason);

    await withTenant(ctx.tenant.id, async (tx) => {
      // The per-user defaults pointing at it go by cascade — see the
      // composite FK in §3. Deleting them here as well would be a second
      // statement that can be forgotten.
      await tx
        .delete(savedViews)
        .where(and(eq(savedViews.id, params.id), eq(savedViews.tenantId, ctx.tenant.id)));
    });

    await writeAudit(ctx, {
      action: "delete",
      resourceType: "saved_view",
      resourceId: params.id,
      oldValue: {
        name: existing.name,
        objectKey: existing.objectKey,
        isShared: existing.isShared,
      },
      reason: existing.isShared
        ? "A view shared with the whole workspace was deleted."
        : undefined,
      // A shared view's deletion affects everybody. It is a `warning`
      // rather than `info` so it is visible without anybody going looking.
      severity: existing.isShared ? "warning" : "info",
    });

    return { ok: true, data: { id: params.id } };
  } catch (err) {
    return toViewActionError(err, "deleteView");
  }
}

/* ------------------------------------------------------------------ */
/* DEFAULTS                                                           */
/* ------------------------------------------------------------------ */

/** "When I open Leads, show me this view." A personal preference. */
export async function setDefaultView(
  input: unknown,
): Promise<ActionResult<{ viewId: string | null }>> {
  try {
    // ⚠️ `views:read`, not `views:update`. Choosing which view YOU open
    // to changes nothing anybody else can see, and requiring an edit
    // permission for it would mean a read-only role cannot set a landing
    // view — which is precisely the role that most wants one.
    const ctx = await requirePermission(VIEW_PERMISSIONS.read);
    const params = setDefaultViewSchema.parse(input);

    await withTenant(ctx.tenant.id, async (tx) => {
      if (params.viewId === null) {
        await tx
          .delete(savedViewDefaults)
          .where(
            and(
              eq(savedViewDefaults.tenantId, ctx.tenant.id),
              eq(savedViewDefaults.userId, ctx.user.id),
              eq(savedViewDefaults.objectKey, params.objectKey),
            ),
          );
        return;
      }

      await tx
        .delete(savedViewDefaults)
        .where(
          and(
            eq(savedViewDefaults.tenantId, ctx.tenant.id),
            eq(savedViewDefaults.userId, ctx.user.id),
            eq(savedViewDefaults.objectKey, params.objectKey),
          ),
        );

      // ⚠️ The trigger `saved_view_defaults_visible` refuses a view that
      // is neither shared nor the caller's own — in the database, so it
      // holds for an import or a future API route as well.
      await tx.insert(savedViewDefaults).values({
        tenantId: ctx.tenant.id,
        userId: ctx.user.id,
        objectKey: params.objectKey,
        dynamicObjectId: params.dynamicObjectId ?? null,
        viewId: params.viewId,
      });
    });

    return { ok: true, data: { viewId: params.viewId } };
  } catch (err) {
    return toViewActionError(err, "setDefaultView");
  }
}

/**
 * Make a shared view the workspace's default for its object.
 *
 * ⚠️ `views:share` RATHER THAN `views:update`. This decides what every
 * new hire sees the first time they open a list page, which is a
 * workspace-configuration act rather than an edit to one row.
 */
export async function setWorkspaceDefault(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardViewWrite({
      operation: "views:share",
      feature: "views.shared",
      permission: VIEW_PERMISSIONS.share,
    });

    const params = setWorkspaceDefaultSchema.parse(input);

    const existing = await loadView(ctx.tenant.id, ctx.user.id, params.id);
    if (!existing) return viewFail("That view does not exist.");

    if (params.isWorkspaceDefault && !existing.isShared) {
      return viewFail(
        "Only a shared view can be the workspace default — otherwise everybody " +
          "would open a view they cannot see in their own picker.",
      );
    }

    await withTenant(ctx.tenant.id, async (tx) => {
      if (params.isWorkspaceDefault) {
        // ⚠️ CLEARED FIRST, IN THE SAME TRANSACTION. The partial unique
        // index allows exactly one, so setting a second without clearing
        // the first is a constraint violation rather than a replacement —
        // and "23505" is not what somebody clicking "make this the
        // default" expects to see.
        await tx
          .update(savedViews)
          .set({ isWorkspaceDefault: false })
          .where(
            and(
              eq(savedViews.tenantId, ctx.tenant.id),
              eq(savedViews.objectKey, existing.objectKey),
              eq(savedViews.isWorkspaceDefault, true),
            ),
          );
      }

      await tx
        .update(savedViews)
        .set({ isWorkspaceDefault: params.isWorkspaceDefault, updatedAt: new Date() })
        .where(and(eq(savedViews.id, params.id), eq(savedViews.tenantId, ctx.tenant.id)));
    });

    await writeAudit(ctx, {
      action: "config_change",
      resourceType: "saved_view",
      resourceId: params.id,
      newValue: { isWorkspaceDefault: params.isWorkspaceDefault },
      reason: "Changed the workspace's default view for a record type.",
      severity: "notice",
    });

    return { ok: true, data: { id: params.id } };
  } catch (err) {
    return toViewActionError(err, "setWorkspaceDefault");
  }
}

/* ------------------------------------------------------------------ */
/* THE STARTING POINT                                                  */
/* ------------------------------------------------------------------ */

/**
 * The definition a list page uses when nobody has saved anything.
 *
 * ⚠️ NOT STORED. A row created on first visit would mean every workspace
 * accumulates seven views nobody asked for, each one counting against the
 * cap, each one appearing in the picker as though somebody had made a
 * choice. The default is code, and it becomes a row the moment a person
 * presses Save.
 */
export async function defaultDefinitionFor(
  selector: { objectKey: string; dynamicObjectId?: string | null },
): Promise<
  ActionResult<{
    viewType: ViewType;
    filter: FilterGroup;
    sorts: SortSpec[];
    groupBy: string | null;
    dateField: string | null;
    columns: ColumnSpec[];
  }>
> {
  try {
    const ctx = await requireTenantContext();
    const object = await resolveViewObject(ctx.tenant.id, selector);
    if (!object) return viewFail("That record type does not exist.");
    requireViewObjectAccess(ctx, object);

    return {
      ok: true,
      data: {
        viewType: "table",
        filter: emptyFilter(),
        sorts: [...object.defaultSorts],
        groupBy: object.defaultGroupBy,
        dateField: object.defaultDateField,
        columns: object.defaultColumns.map((field) => ({ field })),
      },
    };
  } catch (err) {
    return toViewActionError(err, "defaultDefinitionFor");
  }
}
