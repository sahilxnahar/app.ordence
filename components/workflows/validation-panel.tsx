"use client";

/**
 * Ordence — Validation, Shown Where The Mistake Is
 * Version: v0.24.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE ENGINE'S OWN VALIDATOR, RUNNING ON EVERY KEYSTROKE
 * ══════════════════════════════════════════════════════════════════════
 * `validateDefinition` is pure and isomorphic — no database, no network,
 * no Node APIs — which is what makes this possible at all: the builder
 * calls the SAME function the server calls at save and again at publish.
 *
 * That is the entire point. A client-side "helpful" copy of the rules
 * disagrees with the server eventually, and when it does the author is
 * shown a green tick and then a refusal. Here there is one implementation
 * and one answer; the only difference is how early it is asked.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ERRORS AND WARNINGS ARE RENDERED DIFFERENTLY BECAUSE THEY MEAN
 * DIFFERENT THINGS
 * ══════════════════════════════════════════════════════════════════════
 *   ERROR   — this cannot do what it says. Publishing is refused.
 *   WARNING — this can run and may not be what was meant. Publishing
 *             proceeds, but only after somebody says so out loud.
 *
 * Both carry the engine's own `remedy` text. Restating it here in
 * friendlier words would produce two explanations of the same rule, and
 * the friendlier one is the one that goes stale.
 */

import { AlertTriangle, CircleAlert, CheckCircle2 } from "lucide-react";
import type { ValidationResult, WorkflowProblem } from "@/lib/workflows/validation";

/* ------------------------------------------------------------------ */
/* THE SUMMARY, AT THE TOP OF THE BUILDER                              */
/* ------------------------------------------------------------------ */

export function ValidationPanel({
  result,
  summary,
}: {
  result: ValidationResult;
  summary: string;
}) {
  const clean = result.errors.length === 0 && result.warnings.length === 0;

  return (
    <section
      aria-label="Validation"
      // ⚠️ `polite`, not `assertive`. This updates as the author types;
      // an assertive region would interrupt a screen reader mid-word on
      // every character.
      aria-live="polite"
      className="rounded-lg border border-border bg-card p-3"
    >
      <div className="flex items-start gap-2">
        {clean ? (
          <CheckCircle2
            className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600"
            aria-hidden="true"
          />
        ) : result.errors.length > 0 ? (
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
        ) : (
          <AlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0 text-amber-600"
            aria-hidden="true"
          />
        )}
        <p className="text-sm font-medium">{summary}</p>
      </div>

      {result.errors.length > 0 ? (
        <ProblemList problems={result.errors} tone="error" heading="Must be fixed" />
      ) : null}
      {result.warnings.length > 0 ? (
        <ProblemList
          problems={result.warnings}
          tone="warning"
          heading="Worth a second look"
        />
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* INLINE, NEXT TO THE STEP THAT CAUSED IT                             */
/* ------------------------------------------------------------------ */

export function ProblemList({
  problems,
  tone,
  heading,
}: {
  problems: readonly WorkflowProblem[];
  tone: "error" | "warning";
  heading?: string;
}) {
  if (problems.length === 0) return null;

  const isError = tone === "error";

  return (
    <div className="mt-2">
      {heading ? (
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {heading}
        </h4>
      ) : null}
      <ul className="mt-1 space-y-1.5">
        {problems.map((problem) => (
          <li
            key={`${problem.code}:${problem.where}:${problem.message}`}
            // ⚠️ `role="alert"` only on errors. A warning that shouts is a
            // warning people learn to dismiss without reading.
            role={isError ? "alert" : undefined}
            className={[
              "rounded border px-2 py-1.5 text-xs",
              isError
                ? "border-red-500/30 bg-red-500/5 text-red-800"
                : "border-amber-500/30 bg-amber-500/5 text-amber-900",
            ].join(" ")}
          >
            <span className="sr-only">{isError ? "Problem: " : "Warning: "}</span>
            <strong className="font-medium">{problem.message}</strong>{" "}
            <span className="opacity-90">{problem.remedy}</span>
            <span className="ml-1 font-mono text-[10px] opacity-60">
              [{problem.code}]
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The problems belonging to one step key (or `trigger`, or `program`). */
export function problemsFor(
  result: ValidationResult,
  where: string,
): { errors: WorkflowProblem[]; warnings: WorkflowProblem[] } {
  return {
    errors: result.errors.filter((problem) => problem.where === where),
    warnings: result.warnings.filter((problem) => problem.where === where),
  };
}
