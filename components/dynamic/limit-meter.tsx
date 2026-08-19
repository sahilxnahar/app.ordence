"use client";

/**
 * Ordence — A Limit, Shown Before It Is Hit
 * Version: v0.27.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE NUMBER IS THE MESSAGE. THE BAR IS DECORATION.
 * ══════════════════════════════════════════════════════════════════════
 * "43 of 50 record types" is readable in a printout, by a screen reader,
 * and by somebody who cannot distinguish the amber bar from the grey one.
 * A bar alone is colour-only meaning — the same argument the inventory
 * grid makes about unit status, and it applies with more force here
 * because the consequence of missing it is discovering the cap halfway
 * through defining something.
 *
 * ⚠️ AND IT IS SHOWN WHEN THERE IS STILL ROOM, not only when it is full.
 * A limit that first appears as a refusal is a limit the product hid.
 * Every one of these numbers is read from `lib/dynamic/limits.ts`, which
 * is the same file the validator and the SQL functions read.
 */

import { readLimit } from "./presentation";

export function LimitMeter({
  label,
  used,
  max,
  explanation,
}: {
  label: string;
  used: number;
  max: number;
  explanation: string;
}) {
  const reading = readLimit(used, max);

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p className="text-sm font-semibold tabular-nums">
          {reading.used.toLocaleString("en-IN")} of {reading.max.toLocaleString("en-IN")}
        </p>
      </div>

      <div
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={reading.used}
        aria-valuemin={0}
        aria-valuemax={reading.max}
        aria-label={`${label}: ${reading.used} of ${reading.max} used`}
      >
        <div
          className={
            reading.full
              ? "h-full bg-destructive"
              : reading.nearlyFull
                ? "h-full bg-amber-500"
                : "h-full bg-primary"
          }
          style={{ width: `${reading.pct}%` }}
        />
      </div>

      {/*
        The state in WORDS as well as in the bar. Somebody reading this in
        a screenshot of a support ticket gets the same information as
        somebody looking at the colour.
      */}
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        {reading.full
          ? "Full — nothing more can be added until something is removed."
          : reading.nearlyFull
            ? `Nearly full — ${reading.max - reading.used} left.`
            : `${reading.max - reading.used} left.`}{" "}
        {explanation}
      </p>
    </div>
  );
}
