"use client";

/**
 * Ordence — The Limits Meter
 * Version: v0.24.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE CEILINGS ARE SHOWN WHILE THERE IS STILL ROOM, NOT WHEN IT RUNS OUT
 * ══════════════════════════════════════════════════════════════════════
 * `lib/workflows/limits.ts` caps a definition at a hundred steps, five
 * levels of nesting, two hundred iterations per loop and thirty days of
 * delay. Every one of those is enforced twice — by the validator and by
 * the database — and both refusals arrive at SAVE time.
 *
 * A person who spends twenty minutes assembling a ninety-step workflow
 * and is refused at the end does not trim it. They conclude the product
 * cannot do what they need and go and do it somewhere else — and they are
 * not wrong to, because nothing told them.
 *
 * So the counters are always on screen, they count UP toward the number,
 * and the number is stated. Reaching 78 of 100 is information. Being told
 * "too many steps" after the fact is a bill.
 *
 * ⚠️ EVERY NUMBER HERE IS IMPORTED. Typing `100` into this file would
 * produce a meter that is confidently wrong the day the limit changes,
 * which is worse than no meter.
 */

import {
  DEFAULT_STEP_BUDGET,
  MAX_CONFIGURABLE_STEP_BUDGET,
  MAX_DELAY_SECONDS,
  MAX_ITERATIONS_PER_LOOP,
  MAX_ITERATIONS_PER_RUN,
  MAX_NESTING_DEPTH,
  MAX_STEPS_PER_DEFINITION,
  MAX_TRIGGER_DEPTH,
} from "@/lib/workflows/limits";
import { describeSeconds } from "./presentation";

export type LimitsMeterProps = {
  stepCount: number;
  depth: number;
  stepBudget: number;
};

export function LimitsMeter({ stepCount, depth, stepBudget }: LimitsMeterProps) {
  return (
    <section
      aria-label="Limits"
      className="rounded-lg border border-border bg-muted/20 p-3"
    >
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Limits
      </h3>

      <dl className="mt-2 space-y-2.5">
        <Gauge
          label="Steps in this workflow"
          used={stepCount}
          limit={MAX_STEPS_PER_DEFINITION}
          nearNote="Splitting this into two workflows that trigger each other reads better and debugs better."
          overNote={`A definition may not exceed ${MAX_STEPS_PER_DEFINITION} steps. Publishing will be refused until it does not.`}
        />
        <Gauge
          label="Nesting depth"
          used={depth}
          limit={MAX_NESTING_DEPTH}
          nearNote="A definition nobody can read on one screen is a definition nobody can debug at 6pm."
          overNote={`Steps may not nest more than ${MAX_NESTING_DEPTH} levels deep.`}
        />
        <Gauge
          label="Steps one run may execute"
          used={stepBudget}
          limit={MAX_CONFIGURABLE_STEP_BUDGET}
          hint={`Default ${DEFAULT_STEP_BUDGET}. Counts executions, not steps — four steps inside a loop over fifty records is two hundred.`}
        />
      </dl>

      <ul className="mt-3 space-y-1 border-t border-border pt-2 text-[11px] text-muted-foreground">
        <li>
          A loop may repeat at most{" "}
          <strong className="font-medium text-foreground">
            {MAX_ITERATIONS_PER_LOOP.toLocaleString("en-IN")}
          </strong>{" "}
          times, and one run may repeat{" "}
          <strong className="font-medium text-foreground">
            {MAX_ITERATIONS_PER_RUN.toLocaleString("en-IN")}
          </strong>{" "}
          times across every loop it contains.
        </li>
        <li>
          A wait may last at most{" "}
          <strong className="font-medium text-foreground">
            {describeSeconds(MAX_DELAY_SECONDS)}
          </strong>
          . For anything longer, use a scheduled workflow — it holds no open state
          while it waits.
        </li>
        <li>
          One event may set off at most{" "}
          <strong className="font-medium text-foreground">{MAX_TRIGGER_DEPTH}</strong>{" "}
          workflows in a chain. A workflow cannot re-enter itself from its own event.
        </li>
      </ul>
    </section>
  );
}

function Gauge({
  label,
  used,
  limit,
  hint,
  nearNote,
  overNote,
}: {
  label: string;
  used: number;
  limit: number;
  hint?: string;
  nearNote?: string;
  overNote?: string;
}) {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  const over = used > limit;
  const near = !over && ratio >= 0.8;

  // ⚠️ The state is in the TEXT as well as the bar. A bar that turns red
  // says nothing to a screen reader and nothing in greyscale.
  const state = over ? "over the limit" : near ? "close to the limit" : null;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className="text-xs font-medium tabular-nums">
          {used.toLocaleString("en-IN")} of {limit.toLocaleString("en-IN")}
          {state ? <span className="ml-1 font-normal">({state})</span> : null}
        </dd>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuenow={used}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuetext={`${used} of ${limit}${state ? `, ${state}` : ""}`}
        className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-border"
      >
        <div
          className={[
            "h-full rounded-full transition-all",
            over ? "bg-red-600" : near ? "bg-amber-500" : "bg-primary",
          ].join(" ")}
          style={{ width: `${Math.max(2, ratio * 100)}%` }}
        />
      </div>
      {over && overNote ? (
        <p className="mt-1 text-[11px] text-red-700">{overNote}</p>
      ) : near && nearNote ? (
        <p className="mt-1 text-[11px] text-amber-700">{nearNote}</p>
      ) : hint ? (
        <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
