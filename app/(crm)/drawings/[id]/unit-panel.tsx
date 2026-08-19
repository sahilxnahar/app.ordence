"use client";

/**
 * Ordence — ⭐⭐⭐ SAYING WHAT ONE DRAWING UNIT MEANS
 * Version: v1.75.0-alpha · Wave 7
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS IS A DECISION, NOT A SETTING
 * ══════════════════════════════════════════════════════════════════════
 * It does not produce one quantity. It produces EVERY quantity anybody
 * ever takes off this sheet — and every one of them says who decided it
 * and when.
 *
 * ⚠️ SO THE WORDING SAYS WHAT IS AT STAKE. "Drawing units" as a dropdown
 * label, with no sentence beside it, is a control somebody sets to
 * whatever is first in the list so the page stops complaining.
 */

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { DRAWING_UNITS } from "@/lib/cad/units";
import { setDrawingUnit } from "@/server/actions/drawings";

export function DrawingUnitPanel({
  revisionId,
  assumedUnit,
  frozen,
}: {
  revisionId: string;
  assumedUnit: string | null;
  frozen: boolean;
}) {
  const [unit, setUnit] = useState(assumedUnit ?? "millimetres");
  const [pending, start] = useTransition();

  if (assumedUnit) {
    return (
      <p className="text-sm text-muted-foreground">
        This file does not state its units. Somebody has decided that one drawing unit is one{" "}
        <strong className="text-foreground">{assumedUnit.replace(/s$/, "")}</strong>, and every
        quantity taken off this sheet records that decision alongside the number.
      </p>
    );
  }

  if (frozen) {
    return (
      <p className="text-sm text-muted-foreground">
        This revision has been superseded, so it is frozen. Set the unit on the revision that is
        current instead.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {/*
          ⭐ THE SENTENCE FROM `lib/cad/units.ts`, in the place it applies.
          One argument in the product, not two that drift apart.
        */}
        This drawing does not say what one drawing unit means. That is a real state , about a
        third of DXF files in circulation are exported without it , and it is{" "}
        <strong className="text-foreground">not the same as millimetres</strong>, however often
        it turns out to be. Nothing can be measured off this sheet until somebody says, and
        whoever says it is recorded against every quantity that follows.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="drawing-unit">One drawing unit is one</Label>
          <Select
            id="drawing-unit"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            className="min-w-48"
          >
            {DRAWING_UNITS.filter((u) => u !== "unitless").map((u) => (
              <option key={u} value={u}>
                {u.replace(/s$/, "")}
              </option>
            ))}
          </Select>
        </div>
        <Button
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const result = await setDrawingUnit({ revisionId, unit });
              if (!result.ok) toast.error(result.error);
              else toast.success(`Recorded: one drawing unit is one ${unit.replace(/s$/, "")}.`);
            })
          }
        >
          {pending ? "Recording…" : "Record this decision"}
        </Button>
      </div>
    </div>
  );
}
