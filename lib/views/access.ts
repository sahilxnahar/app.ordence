/**
 * Ordence — Who May See What Through a View
 * Version: v0.25.0-alpha
 *
 * Pure. Takes a permission subject and a view; returns a decision. No
 * database, no request, no `server-only` — the server actions, the
 * builder UI (which must grey out "share" rather than offer it and fail)
 * and the tests all reach the same verdict from the same code.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE ONE IDEA THIS FILE ENFORCES
 * ══════════════════════════════════════════════════════════════════════
 *
 *     A VIEW SUPPLIES THE FILTER. THE CALLER SUPPLIES THE SCOPE.
 *
 * A saved view is a saved QUESTION, not a saved ANSWER, and it is not a
 * grant. Sharing one must never let the reader see a record they could
 * not have seen by any other route in the product.
 *
 * That sounds obvious and the obvious implementation gets it wrong, in a
 * way that is almost impossible to spot in review. The natural way to
 * build "shared views" is:
 *
 *     the view is saved with the author's context
 *       → the reader opens it
 *       → the server replays the saved query
 *       → rows come back
 *
 * Nothing in that sequence checks the READER against the OBJECT. The
 * author had `bookings:read`; the reader does not; the query does not
 * care because it was authorised when it was saved. An external
 * contractor with `assets:read` and nothing else opens "All bookings this
 * quarter", shared by the sales director, and reads the company's entire
 * order book. No exploit, no injection, no bug in any single function —
 * just an authorisation that happened at the wrong time, against the
 * wrong person.
 *
 * So this file makes the timing explicit and structural:
 *
 *   1. `canReadObject` is evaluated against the person OPENING the view,
 *      every time it is opened, never against the person who saved it.
 *      The `saved_views` row contributes no authority whatsoever.
 *
 *   2. `resolveViewerScope` derives the ownership narrowing from the
 *      READER's permissions, and `compileWhere` ANDs it OUTSIDE the
 *      view's filter — so the filter can only ever remove rows from a set
 *      the reader was already entitled to. Set intersection has no way to
 *      widen.
 *
 *   3. There is no code path that takes the author's identity into a
 *      query. `saved_views.owner_user_id` decides who may EDIT the view.
 *      It never decides what the view returns.
 */

import { can, type PermissionSubject } from "@/lib/permissions";
import type { ViewObjectDefinition } from "./registry";
import type { ViewerScope } from "./planner";

/* ------------------------------------------------------------------ */
/* THE PERMISSIONS THIS PHASE ADDS                                     */
/* ------------------------------------------------------------------ */

/**
 * Named here as well as in `db/schema/auth.ts` so the pure layer does not
 * have to import the whole catalogue to say what it needs. They are
 * checked through `can()`, which fails CLOSED on a key it does not
 * recognise — so a typo here denies rather than grants.
 */
export const VIEW_PERMISSIONS = Object.freeze({
  read: "views:read",
  create: "views:create",
  update: "views:update",
  delete: "views:delete",
  share: "views:share",
  /** Edit or delete somebody else's shared view. */
  manageShared: "views:manage_shared",
  /** ⭐ See records owned by other people. The scope permission. */
  readAllRecords: "views:read_all_records",
} as const);

/* ------------------------------------------------------------------ */
/* OBJECT-LEVEL ACCESS                                                 */
/* ------------------------------------------------------------------ */

/**
 * May this person read this record type AT ALL?
 *
 * ⭐ THE GATE THAT STOPS A SHARED VIEW BEING A PRIVILEGE ESCALATION.
 * Checked against the caller, on every open, before any SQL is compiled.
 *
 * ⚠️ BOTH PERMISSIONS ARE REQUIRED AND THEY ARE NOT THE SAME QUESTION.
 * `views:read` is "may you use saved views" — a feature. The object's own
 * permission is "may you see leads" — the data. A role that has been
 * given saved views and not given leads must not read leads through one,
 * and collapsing the two is precisely how it would.
 */
export function canReadObject(
  subject: PermissionSubject,
  object: ViewObjectDefinition,
): boolean {
  return can(subject, VIEW_PERMISSIONS.read) && can(subject, object.readPermission);
}

/** The message shown when they may not. Names the DATA, not the feature. */
export function describeObjectDenial(object: ViewObjectDefinition): string {
  return (
    `This view is over ${object.pluralLabel.toLowerCase()}, and you do not have ` +
    `permission to see them. Sharing a view does not share the records in it — ` +
    `ask an administrator for access to ${object.pluralLabel.toLowerCase()}.`
  );
}

/* ------------------------------------------------------------------ */
/* ⭐ ROW-LEVEL SCOPE                                                   */
/* ------------------------------------------------------------------ */

/**
 * Build the scope clause for this caller, on this object.
 *
 * ⚠️ THE ARGUMENT IS THE CALLER'S SUBJECT AND THE CALLER'S USER ID. There
 * is deliberately no parameter for the view, because there is no question
 * a view could answer here — every attempt to add one is the escalation.
 *
 * The narrowing applies when the caller lacks `views:read_all_records`,
 * which the standard roles hold and which an administrator can revoke per
 * user (`overrides`). A revoked user keeps their `leads:read` and sees
 * only the leads they own — through EVERY view, their own included, so
 * there is no view they can build to get around it.
 *
 * ⚠️ AN OBJECT WITH NO OWNER COLUMN IS NOT NARROWED, AND THAT IS A
 * DELIBERATE LIMIT OF THE MODEL RATHER THAN AN OVERSIGHT. A unit belongs
 * to a building, not to a rep. Inventing an owner for it (the person
 * currently holding it, the project's manager) would make records appear
 * and disappear as unrelated state changed, and "why did that flat vanish
 * from my list?" is a worse outcome than "everyone with units:read sees
 * all units", which is what the rest of the product already does.
 */
export function resolveViewerScope(
  subject: PermissionSubject,
  object: ViewObjectDefinition,
  callerUserId: string,
  tenantId: string,
): ViewerScope {
  const seesEverything = can(subject, VIEW_PERMISSIONS.readAllRecords);

  return {
    tenantId,
    restrictToOwnerUserId:
      seesEverything || object.ownerColumn === null ? null : callerUserId,
  };
}

/* ------------------------------------------------------------------ */
/* MANAGING THE VIEW ITSELF                                            */
/* ------------------------------------------------------------------ */

/** The fields of a saved view that decide who may change it. */
export type ManageableView = {
  ownerUserId: string;
  isShared: boolean;
};

export type ManageDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * May this person edit or delete this view?
 *
 * ⚠️ A SHARED VIEW IS NOT ITS AUTHOR'S PROPERTY ANY MORE, AND THAT CUTS
 * BOTH WAYS.
 *
 *   • Somebody else's PRIVATE view is invisible and untouchable. It is a
 *     personal working list, and an admin browsing other people's saved
 *     filters is reading their notes.
 *
 *   • A SHARED view is workspace furniture. Half the sales team has it
 *     pinned. Letting anybody with `views:delete` remove it means the
 *     newest hire can delete the board the whole team works from, at
 *     10am on a Monday, by clicking the wrong icon — and there is no undo
 *     because a view is a preference, not history.
 *
 * So a shared view is changed by its author or by somebody holding
 * `views:manage_shared`, and by nobody else. `views:delete` alone is
 * enough for your own views and not enough for the team's.
 */
export function canManageView(
  subject: PermissionSubject,
  view: ManageableView,
  callerUserId: string,
): ManageDecision {
  const isAuthor = view.ownerUserId === callerUserId;

  if (view.isShared) {
    if (isAuthor || can(subject, VIEW_PERMISSIONS.manageShared)) return { allowed: true };
    return {
      allowed: false,
      reason:
        "This view is shared with the whole workspace, so only the person who " +
        "created it or an administrator can change or delete it. Make a copy if " +
        "you want your own version of it.",
    };
  }

  if (!isAuthor) {
    // ⚠️ The same message as "it does not exist" would be better still,
    // and the caller gives it: `server/views/definitions.ts` never returns
    // another person's private view at all, so this branch is a backstop
    // for a caller that fetched one some other way.
    return {
      allowed: false,
      reason: "That view does not exist.",
    };
  }

  return { allowed: true };
}

/**
 * May this person publish a view to the whole workspace?
 *
 * Separate from creating one. A shared view appears in everybody's picker
 * and becomes the thing a team looks at every morning; that is a small act
 * of workspace administration, not a personal preference.
 */
export function canShareView(subject: PermissionSubject): boolean {
  return can(subject, VIEW_PERMISSIONS.share);
}
