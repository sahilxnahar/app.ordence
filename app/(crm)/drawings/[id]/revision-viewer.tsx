"use client";

/**
 * Ordence — ⭐ FETCHING THE SHEET, THEN DRAWING IT
 * Version: v1.75.0-alpha · Wave 7
 *
 * ⚠️ THE FILE IS FETCHED ON DEMAND, NOT WITH THE PAGE. A drawing register
 * row is a few hundred bytes; the sheet behind it is megabytes. Loading
 * every sheet with its page would make the register unusable on a site
 * connection to show something most visits do not look at.
 */

import { useState, useTransition } from "react";
import { Eye } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DrawingViewer } from "@/components/drawings/drawing-viewer";
import {
  addDrawingMarkup,
  getRevisionSource,
  takeMeasurement,
} from "@/server/actions/drawings";
import type { DrawingUnit } from "@/lib/cad/types";

export function RevisionViewer({
  revisionId,
  unit,
  assumed,
}: {
  revisionId: string;
  unit: string | null;
  assumed: boolean;
}) {
  const [dxf, setDxf] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (dxf) {
    return (
      <DrawingViewer
        revisionId={revisionId}
        dxfText={dxf}
        unit={(unit as DrawingUnit | null) ?? null}
        unitWasAssumed={assumed}
        /*
          ⚠️ THE BUTTONS ARE SHOWN OPTIMISTICALLY AND THE SERVER DECIDES.
          A person without `drawings:measure` sees the tool and is refused
          with the sentence explaining that taking a quantity off a
          drawing is a different act from looking at one — which is more
          useful than a control that is simply absent and unexplained.
        */
        canMarkup
        canMeasure
        addMarkup={addDrawingMarkup}
        takeMeasurement={takeMeasurement}
      />
    );
  }

  return (
    <Button
      type="button"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const result = await getRevisionSource({ revisionId });
          if (!result.ok) {
            toast.error(result.error);
            return;
          }
          setDxf(result.data.dxf);
        })
      }
    >
      <Eye className="mr-1.5 h-4 w-4" aria-hidden="true" />
      {pending ? "Loading the sheet…" : "Open the drawing"}
    </Button>
  );
}
