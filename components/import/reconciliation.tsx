/**
 * Ordence — ⭐⭐⭐ RECONCILIATION AND CUTOVER
 * Version: v1.89.0-alpha · Wave 2A
 *
 * ══════════════════════════════════════════════════════════════════════
 * XERO'S GRAMMAR: TWO NUMBERS AND THE DISTANCE BETWEEN THEM, NEVER ONE
 * NUMBER ALONE
 * ══════════════════════════════════════════════════════════════════════
 *   Debtors — your trial balance 4,81,200 · invoices imported 4,79,800 ·
 *   difference 1,400 short
 *
 * One number alone — "4,79,800 imported" — is not a check. It is a
 * receipt, and a customer cannot tell a correct receipt from a wrong one.
 * Two numbers and their distance is the smallest thing that can be
 * checked, and it is the whole reason this screen has a grammar rather
 * than a layout.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 "NOT CHECKED YET" AND "ZERO" ARE DIFFERENT FACTS AND MUST NOT LOOK
 *    ALIKE
 * ══════════════════════════════════════════════════════════════════════
 * A migration that reports green with a third of it unmeasured is the
 * failure this whole wave exists to prevent. So an unmeasured line is
 * modelled as a different SHAPE — it has no numbers at all, not a zero —
 * and `cutoverVerdict` cannot return "everything ties" while one exists.
 * The headline counts what was checked out of what there is to check, so
 * an unmeasured line is visible from the top of the page rather than
 * only by scrolling to it.
 *
 * ⚠️ NEVER RED FOR A NEGATIVE NUMBER. A credit balance is ordinary in an
 * Indian ledger. The difference carries its direction in the WORD —
 * `short`, `over` — and the figure itself is unsigned and uncoloured.
 * Red on this screen means one thing: this blocks the cutover.
 *
 * ⚠️ NO `"use client"`, NO DATA FETCHING, NO CLOCK. It is handed lines
 * and renders them, which is what lets a test assert the verdict of a set
 * of lines without a database and without a browser.
 */

import { CircleAlert, CircleCheck, CircleHelp } from "lucide-react";
import { Figure, formatCount, formatMinorIndian } from "@/components/import/figures";

/* ------------------------------------------------------------------ */
/* THE LINE                                                            */
/* ------------------------------------------------------------------ */

export type ReconciliationUnit =
  | { readonly kind: "money"; readonly currency: string }
  | { readonly kind: "count"; readonly noun: string };

/**
 * 🔴 TWO SHAPES, NOT ONE SHAPE WITH NULLS IN IT.
 *
 * `{ declared: null, imported: null }` is the version of this type that
 * gets written first, and it is the bug: every renderer then has to
 * remember to check, one of them does not, and `null` formats as `0`.
 * A discriminated union cannot be forgotten — there is no `declared` to
 * read on a `not-checked` line.
 */
export type ReconciliationMeasure =
  | { readonly kind: "measured"; readonly declared: bigint; readonly imported: bigint }
  /** ⚠️ `why` IS REQUIRED. "Not checked" without a reason is a shrug. */
  | { readonly kind: "not-checked"; readonly why: string };

export type ReconciliationLine = {
  readonly key: string;
  readonly label: string;
  readonly unit: ReconciliationUnit;
  /** What the LEFT number is, in the customer's words: "your trial balance". */
  readonly declaredLabel: string;
  /** What the RIGHT number is: "invoices imported". */
  readonly importedLabel: string;
  readonly measure: ReconciliationMeasure;
};

/* ------------------------------------------------------------------ */
/* THE VERDICT                                                         */
/* ------------------------------------------------------------------ */

export type CutoverVerdict = {
  /**
   * `ties`     every line was checked and every one agrees.
   * `differs`  at least one checked line does not agree. Blocks cutover.
   * `unknown`  everything checked agrees, but something was not checked.
   * `nothing`  there is nothing to check yet.
   */
  readonly verdict: "ties" | "differs" | "unknown" | "nothing";
  readonly checked: number;
  readonly total: number;
  readonly differing: number;
};

/**
 * ⭐ THE FUNCTION THE WHOLE SCREEN TURNS ON, AND IT IS PURE SO THAT IT
 * CAN BE PROVEN.
 *
 * 🔴 THE ORDER OF THE TESTS IS THE SAFETY PROPERTY. A difference beats an
 * unmeasured line — something known to be wrong is more urgent than
 * something not yet looked at — and an unmeasured line beats agreement,
 * which is the clause that makes it impossible for this screen to say
 * "everything ties" about a migration a third of which nobody measured.
 */
export function cutoverVerdict(lines: readonly ReconciliationLine[]): CutoverVerdict {
  const total = lines.length;
  const measured = lines.filter(
    (l): l is ReconciliationLine & { measure: Extract<ReconciliationMeasure, { kind: "measured" }> } =>
      l.measure.kind === "measured",
  );
  const differing = measured.filter((l) => l.measure.declared !== l.measure.imported).length;

  if (total === 0) return { verdict: "nothing", checked: 0, total: 0, differing: 0 };
  if (differing > 0) return { verdict: "differs", checked: measured.length, total, differing };
  if (measured.length < total)
    return { verdict: "unknown", checked: measured.length, total, differing: 0 };
  return { verdict: "ties", checked: measured.length, total, differing: 0 };
}

/* ------------------------------------------------------------------ */
/* RENDERING                                                           */
/* ------------------------------------------------------------------ */

function render(value: bigint, unit: ReconciliationUnit): string {
  return unit.kind === "money"
    ? formatMinorIndian(value, unit.currency)
    : formatCount(Number(value));
}

/**
 * ⚠️ THE WORD CARRIES THE SIGN. `short` when less arrived than was
 * declared, `over` when more did. Both are unsigned figures.
 */
export function describeDifference(
  declared: bigint,
  imported: bigint,
  unit: ReconciliationUnit,
): { figure: string; word: string; ties: boolean } {
  const delta = imported - declared;
  if (delta === 0n) return { figure: render(0n, unit), word: "they tie", ties: true };
  const abs = delta < 0n ? -delta : delta;
  return {
    figure: render(abs, unit),
    word: delta < 0n ? "short" : "over",
    ties: false,
  };
}

function Line({ line }: { line: ReconciliationLine }) {
  if (line.measure.kind === "not-checked") {
    return (
      <li className="p-3">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-sm font-medium">{line.label}</span>
          {/*
            🔴 NO NUMBERS AT ALL, AND THE WORDS SAY WHY. Not a zero, not a
            dash beside a zero — a line that says out loud that nobody has
            measured this, in amber, which in this product means "a person
            must look".
          */}
          <span className="rounded-md border border-amber-500/40 bg-amber-500/5 px-2 py-0.5 text-xs font-medium text-amber-800">
            Not checked yet
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{line.measure.why}</p>
      </li>
    );
  }

  const { declared, imported } = line.measure;
  const diff = describeDifference(declared, imported, line.unit);

  return (
    <li className="p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <span className="font-medium">{line.label}</span>
        <span className="text-muted-foreground">
          {line.declaredLabel}{" "}
          <Figure className="font-medium text-foreground">
            {render(declared, line.unit)}
          </Figure>
        </span>
        <span aria-hidden="true" className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">
          {line.importedLabel}{" "}
          <Figure className="font-medium text-foreground">
            {render(imported, line.unit)}
          </Figure>
        </span>
        <span aria-hidden="true" className="text-muted-foreground">·</span>
        {/*
          ⚠️ THE DIFFERENCE IS A SENTENCE, NOT A SIGNED NUMBER. "-1,400"
          asks the reader to work out which side is short; "1,400 short"
          tells them. And it is never coloured red for being negative —
          only for being a difference at all, which is a fact about the
          migration rather than about the sign.
        */}
        {diff.ties ? (
          <span className="font-medium text-emerald-700">they tie</span>
        ) : (
          <span className="font-medium text-destructive">
            difference <Figure>{diff.figure}</Figure> {diff.word}
          </span>
        )}
      </div>
    </li>
  );
}

export function Reconciliation({
  lines,
  title = "Does it tie?",
}: {
  lines: readonly ReconciliationLine[];
  title?: string;
}) {
  const verdict = cutoverVerdict(lines);

  const headline =
    verdict.verdict === "nothing"
      ? "Nothing has been imported into this workspace yet, so there is nothing to check."
      : verdict.verdict === "differs"
        ? `${formatCount(verdict.differing)} of ${formatCount(verdict.total)} ${
            verdict.differing === 1 ? "check does" : "checks do"
          } not agree. Do not switch your old system off yet.`
        : verdict.verdict === "unknown"
          ? `${formatCount(verdict.checked)} of ${formatCount(
              verdict.total,
            )} checks ran and agree. The rest have not been measured, so this migration is not proven.`
          : `All ${formatCount(verdict.total)} checks ran and agree.`;

  const Icon =
    verdict.verdict === "differs"
      ? CircleAlert
      : verdict.verdict === "ties"
        ? CircleCheck
        : CircleHelp;

  return (
    <section className="space-y-3">
      <div
        className={`flex gap-2 rounded-lg border p-3 ${
          verdict.verdict === "differs"
            ? "border-destructive/50 bg-destructive/5"
            : verdict.verdict === "ties"
              ? "border-emerald-500/40 bg-emerald-500/5"
              : "border-amber-500/40 bg-amber-500/5"
        }`}
      >
        <Icon
          className={`mt-0.5 h-4 w-4 shrink-0 ${
            verdict.verdict === "differs"
              ? "text-destructive"
              : verdict.verdict === "ties"
                ? "text-emerald-700"
                : "text-amber-600"
          }`}
          aria-hidden="true"
        />
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="mt-0.5 text-sm">{headline}</p>
        </div>
      </div>

      {lines.length > 0 ? (
        <ul className="divide-y rounded-lg border bg-card">
          {lines.map((line) => (
            <Line key={line.key} line={line} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
