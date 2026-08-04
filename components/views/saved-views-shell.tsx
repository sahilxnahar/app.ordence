import "server-only";

/**
 * Ordence — Wiring a List Page to the Views Engine
 * Version: v0.28.0-alpha
 * Runtime: Node (it reads the tenant context)
 *
 * A SERVER component. It fetches the three things `<RecordListPage>` needs
 * — the object's field catalogue, the reader's saved views, and whether
 * they may share one — and hands the client shell the server actions.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THIS EXISTS RATHER THAN SEVEN COPIES IN SEVEN PAGES
 * ══════════════════════════════════════════════════════════════════════
 * Every list page needs the identical four calls. Copied into each one,
 * the copies drift — and the way they drift is that one of them forgets
 * to pass `objectKey` to `listSavedViews`, so a page shows every saved
 * view in the workspace including the ones over other record types. It
 * looks like a cosmetic bug and it tells a rep what the finance team have
 * named their reports.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ IT FAILS SOFT, AND THAT IS THE WHOLE POINT OF THE PHASE
 * ══════════════════════════════════════════════════════════════════════
 * If the catalogue call is refused — no `views:read`, an entitlement
 * lapse, an object this caller cannot open — this component renders
 * `children` and NOTHING ELSE. The page is exactly the page it was before
 * Phase 28.
 *
 * The alternative, throwing, would mean a permission change to a
 * saved-view permission takes the LEADS PAGE down. A layer that is
 * additive when it works must also be absent when it does not.
 */

import { canShareView } from "@/lib/views/access";
import { getTenantContext } from "@/server/tenant-context";
import { subjectFor } from "@/server/views/guards";
import { describeViewObject, listSavedViews } from "@/server/actions/views";
import {
  createSavedView,
  deleteSavedView,
  getSavedView,
  runSavedBoard,
  runSavedView,
  setMyDefaultView,
  updateSavedView,
} from "@/server/actions/views";
import { RecordListPage } from "./record-list-page";
import type { ViewObjectDescription } from "./types";

export type SavedViewsShellProps = {
  /** A key of `VIEW_OBJECTS`, written as a literal at the call site. */
  objectKey: string;
  /** Where a record lives, `{id}` marking the identifier: `/contacts/{id}/edit`. */
  hrefPattern?: string;
  /** The page as it is today. Shown until a view is chosen. */
  children: React.ReactNode;
};

export async function SavedViewsShell({
  objectKey,
  hrefPattern,
  children,
}: SavedViewsShellProps) {
  const [described, listed, ctx] = await Promise.all([
    describeViewObject({ objectKey }),
    listSavedViews({ objectKey }),
    getTenantContext(),
  ]);

  const object: ViewObjectDescription | null =
    described.ok && described.data.objects[0] ? described.data.objects[0] : null;

  // ⭐ FAIL SOFT. See the header.
  if (!object || !ctx) return <>{children}</>;

  return (
    <RecordListPage
      object={object}
      views={listed.ok ? listed.data.views : []}
      defaultViewId={listed.ok ? listed.data.defaultViewId : null}
      /*
        ⚠️ A HINT, NOT A GATE. It decides whether the "share with the whole
        workspace" checkbox is DRAWN. `createView` re-checks
        `canShareView` and the entitlement on every call, and refuses with
        a sentence if this was wrong. See the header of `saved-view-bar.tsx`.
      */
      canShare={canShareView(subjectFor(ctx))}
      hrefPattern={hrefPattern ?? null}
      actions={{
        runView: runSavedView,
        runBoard: runSavedBoard,
        getView: getSavedView,
        createView: createSavedView,
        updateView: updateSavedView,
        deleteView: deleteSavedView,
        setDefaultView: setMyDefaultView,
      }}
    >
      {children}
    </RecordListPage>
  );
}
