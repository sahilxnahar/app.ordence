"use client";

/**
 * Ordence — The Saved-View Bar
 * Version: v0.25.0-alpha
 *
 * The strip above any list, board or calendar: which view am I looking
 * at, what else is saved, and what may I do with this one.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ EVERY AFFORDANCE HERE IS A HINT, NOT A GATE
 * ══════════════════════════════════════════════════════════════════════
 * `canManage` comes from the server, and it is used to decide whether to
 * DRAW the delete button — never to decide whether the delete is allowed.
 * The decision is `canManageView()` in `lib/views/access.ts`, evaluated
 * again inside `server/views/definitions.ts` on every call.
 *
 * That duplication is the point. A UI that hides an action the server
 * would refuse is a good UI; a UI that is the only thing hiding it is an
 * authorisation bug with a nice layout. Both must exist, and the server's
 * copy is the one that counts.
 *
 * ⚠️ AND THE SAME GOES FOR "shared". The badge below says a view is
 * shared. It does not say the reader can see the records in it — that is
 * decided when they open it, against their own permissions, and a shared
 * view they may not open is refused with a sentence that explains why
 * rather than an empty table.
 */

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export type SavedViewOption = {
  id: string;
  name: string;
  viewType: "table" | "kanban" | "calendar";
  isShared: boolean;
  isWorkspaceDefault: boolean;
  isMine: boolean;
  /** From the server. Drives what is drawn; never what is permitted. */
  canManage: boolean;
};

export type SavedViewBarProps = {
  views: SavedViewOption[];
  activeViewId: string | null;
  /** The user's landing view for this object, if they have chosen one. */
  defaultViewId: string | null;
  /** True when this caller sees only the records they own. Announced. */
  scopedToOwnRecords?: boolean;
  /** True when the caller may publish a view to the whole workspace. */
  canShare?: boolean;
  /** True when unsaved changes are pending against the active view. */
  isDirty?: boolean;

  onSelect: (viewId: string | null) => void;
  onSaveAs: (name: string, isShared: boolean) => Promise<string | null>;
  onSaveChanges?: () => Promise<string | null>;
  onDelete?: (viewId: string) => Promise<string | null>;
  onMakeDefault?: (viewId: string | null) => Promise<string | null>;
};

const TYPE_LABELS: Record<SavedViewOption["viewType"], string> = {
  table: "Table",
  kanban: "Board",
  calendar: "Calendar",
};

export function SavedViewBar({
  views,
  activeViewId,
  defaultViewId,
  scopedToOwnRecords = false,
  canShare = false,
  isDirty = false,
  onSelect,
  onSaveAs,
  onSaveChanges,
  onDelete,
  onMakeDefault,
}: SavedViewBarProps) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [shareIt, setShareIt] = useState(false);

  const active = views.find((view) => view.id === activeViewId) ?? null;

  const run = (work: () => Promise<string | null>) => {
    setError(null);
    startTransition(async () => {
      const failure = await work();
      // ⚠️ The server's sentence is shown verbatim. "This view is shared
      // with the whole workspace, so only the person who created it or an
      // administrator can change it" tells somebody what to do next;
      // "Something went wrong" sends them to support.
      if (failure) setError(failure);
      else setNaming(false);
    });
  };

  return (
    <div className="flex flex-col gap-2" aria-busy={pending}>
      {error ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {/*
          ⚠️ A REAL <select>, NOT A CUSTOM DROPDOWN. The view picker is the
          control every keyboard and screen-reader user needs first, and a
          div-with-role="listbox" is where that support goes to die.
        */}
        <label className="flex items-center gap-2">
          <span className="sr-only">Saved view</span>
          <select
            value={activeViewId ?? ""}
            onChange={(event) => onSelect(event.target.value || null)}
            className="rounded border border-input bg-background px-2 py-1.5 text-sm"
          >
            <option value="">All records (no saved view)</option>
            {views.map((view) => (
              <option key={view.id} value={view.id}>
                {view.name}
                {view.isShared ? " · shared" : ""}
                {view.id === defaultViewId ? " · default" : ""}
              </option>
            ))}
          </select>
        </label>

        {active ? (
          <>
            <Badge variant="outline" className="text-[10px]">
              {TYPE_LABELS[active.viewType]}
            </Badge>
            {active.isShared ? (
              <Badge variant="outline" className="text-[10px]">
                Shared with the workspace
              </Badge>
            ) : null}
            {active.isWorkspaceDefault ? (
              <Badge variant="outline" className="text-[10px]">
                Workspace default
              </Badge>
            ) : null}
            {!active.isMine ? (
              <Badge variant="outline" className="text-[10px]">
                Created by someone else
              </Badge>
            ) : null}
          </>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          {/*
            ⚠️ "Save changes" IS ONLY OFFERED WHEN THERE ARE CHANGES AND THE
            VIEW CAN BE MANAGED. Offering it on somebody else's shared view
            produces a refusal every single time it is pressed — the exact
            pattern the lead board avoids by not offering `won` as a drop
            target.
          */}
          {active && isDirty && active.canManage && onSaveChanges ? (
            <Button
              variant="secondary"
              className="h-8 text-xs"
              onClick={() => run(() => onSaveChanges())}
            >
              Save changes
            </Button>
          ) : null}

          {isDirty && active && !active.canManage ? (
            <span className="text-xs text-muted-foreground">
              You can save this as your own view — this one belongs to somebody else.
            </span>
          ) : null}

          <Button
            variant="outline"
            className="h-8 text-xs"
            onClick={() => {
              setNaming((open) => !open);
              setDraftName(active ? `${active.name} (copy)` : "");
            }}
          >
            Save as…
          </Button>

          {active && onMakeDefault ? (
            <Button
              variant="ghost"
              className="h-8 text-xs"
              onClick={() =>
                run(() => onMakeDefault(active.id === defaultViewId ? null : active.id))
              }
            >
              {active.id === defaultViewId ? "Stop opening to this" : "Open to this"}
            </Button>
          ) : null}

          {active && active.canManage && onDelete ? (
            <Button
              variant="ghost"
              className="h-8 text-xs text-destructive"
              onClick={() => run(() => onDelete(active.id))}
            >
              Delete
            </Button>
          ) : null}
        </div>
      </div>

      {naming ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
          <label className="flex items-center gap-2 text-sm">
            <span>Name</span>
            <input
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              maxLength={80}
              className="rounded border border-input bg-background px-2 py-1 text-sm"
              placeholder="Hot leads, north tower"
            />
          </label>

          {/*
            ⚠️ THE SHARE CHECKBOX IS ABSENT, NOT DISABLED, WHEN THE CALLER
            CANNOT SHARE. A disabled control that nobody explains reads as
            a bug in the product; an absent one reads as a feature they do
            not have — and the server refuses either way.
          */}
          {canShare ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={shareIt}
                onChange={(event) => setShareIt(event.target.checked)}
              />
              <span>Share with the whole workspace</span>
            </label>
          ) : null}

          <Button
            className="h-8 text-xs"
            disabled={draftName.trim().length === 0}
            onClick={() => run(() => onSaveAs(draftName.trim(), shareIt))}
          >
            Save
          </Button>
          <Button
            variant="ghost"
            className="h-8 text-xs"
            onClick={() => setNaming(false)}
          >
            Cancel
          </Button>

          {shareIt ? (
            // ⭐ The sentence that stops "shared" being misunderstood as
            // "everybody can now see these records". It cannot: opening a
            // shared view is authorised against the reader, every time.
            <p className="w-full text-xs text-muted-foreground">
              Sharing puts this view in everybody&rsquo;s list. It does not give anybody
              access to records they could not already see.
            </p>
          ) : null}
        </div>
      ) : null}

      {scopedToOwnRecords ? (
        <p className="text-xs text-muted-foreground">
          Every view on this record type shows only the records assigned to you.
        </p>
      ) : null}
    </div>
  );
}
