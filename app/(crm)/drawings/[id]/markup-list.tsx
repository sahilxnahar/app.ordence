"use client";

/**
 * Ordence — ⭐ THE COMMENTS ON A REVISION
 * Version: v1.75.0-alpha · Wave 7
 *
 * ⚠️ OPEN ONES FIRST. A design review works from the list of things not
 * yet answered, and a reverse-chronological list buries the oldest
 * unanswered comment under this morning's resolved one.
 */

import { useTransition } from "react";
import { CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { resolveDrawingMarkup, addDrawingMarkup } from "@/server/actions/drawings";
import type { MarkupRow } from "@/lib/cad/view-types";

export function MarkupList({ markups }: { markups: readonly MarkupRow[] }) {
  const [pending, start] = useTransition();

  if (markups.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No comments on this revision. Comments are raised from the viewer, on the sheet itself,
        and stay in the drawing&apos;s own coordinates so they do not move when somebody resizes
        their window.
      </p>
    );
  }

  const ordered = [...markups].sort((a, b) => {
    const aOpen = a.resolvedAt === null ? 0 : 1;
    const bOpen = b.resolvedAt === null ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  return (
    <ul className="space-y-2">
      {ordered.map((markup) => (
        <li key={markup.id} className="flex items-start gap-3 rounded-md border p-3 text-sm">
          <span className="flex-1">
            <span className="mr-2 text-xs uppercase text-muted-foreground">{markup.kind}</span>
            {markup.body ?? <span className="text-muted-foreground">no text</span>}
            <span className="mt-1 block text-xs text-muted-foreground">
              {markup.createdAt.toISOString().slice(0, 16).replace("T", " ")}
            </span>
          </span>
          {markup.resolvedAt ? (
            <Badge variant="secondary">resolved</Badge>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const result = await resolveDrawingMarkup({ markupId: markup.id });
                  if (!result.ok) toast.error(result.error);
                  else toast.success("Marked as resolved.");
                })
              }
            >
              <CheckCircle2 className="mr-1.5 h-4 w-4" aria-hidden="true" />
              Resolve
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * ⚠️ RE-EXPORTED SO THE VIEWER CAN RAISE ONE WITHOUT IMPORTING THE ACTION
 * MODULE TWICE. `addDrawingMarkup` is passed down as a prop from the page
 * for the same reason `preview` and `commit` are on the import wizard:
 * the component stays a pure function of what it is given.
 */
export { addDrawingMarkup };
