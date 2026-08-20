"use client";

/**
 * Ordence — ⭐⭐⭐ THE LOAD ORDER
 * Version: v1.89.0-alpha · Wave 2A
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE SCREEN THAT DECIDES WHETHER A MIGRATION SUCCEEDS, AND NO
 *    PRODUCT ANYWHERE HAS IT
 * ══════════════════════════════════════════════════════════════════════
 * A customer arrives with a folder. Twenty exports out of a system that
 * is switched off on Friday. Nothing in the folder says which one to load
 * first, so they load the invoices, get nine hundred unresolved-customer
 * errors, and conclude the importer is broken. It is not. The order was.
 *
 * `resolveImportOrder(ALL_IMPORT_ENTITIES)` has computed that order since
 * v1.84.0-alpha and nothing has ever shown it to anybody.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WAVES, NOT STEPS — AND IT IS NOT A PRESENTATION CHOICE
 * ══════════════════════════════════════════════════════════════════════
 * Entities in one wave have NO dependency between them and load in any
 * order, or at the same time. A strict 1..18 list would tell a customer
 * that companies must precede stock items, which is false, and it costs
 * them a day of serialised uploads they did not need. So a wave is a
 * heading with several entities under it, and the copy says "in any
 * order" out loud rather than leaving it to be inferred from the layout.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ DERIVED, NEVER TRANSCRIBED
 * ══════════════════════════════════════════════════════════════════════
 * Every wave, every edge and every sentence on this screen comes out of
 * `resolveImportOrder` and out of each entity's own `dependsOn[].because`
 * at render time. Nothing here enumerates an entity. That is what makes
 * the screen still right when Wave 3 adds a nineteenth — and it is why
 * `entities` is a PROP with a default rather than a module-level import
 * used directly: a test can hand it a map with an extra entity in it and
 * watch the waves move, which is the only way to prove a list is computed
 * rather than typed.
 *
 * 🔴 AND A REFUSAL IS RENDERED AS A REFUSAL. When `resolveImportOrder`
 * returns `ok: false` — a cycle, or a dependency on an entity that does
 * not exist — this screen shows the problem and NO ORDER AT ALL. The
 * tempting alternative is to draw whatever waves came back with a warning
 * above them; there are none to draw, and a partial order is worse than
 * none because the customer follows it.
 */

import Link from "next/link";
import { useMemo } from "react";
import { ArrowRight, CircleAlert, Info, TriangleAlert } from "lucide-react";
import {
  resolveImportOrder,
  softAdvice,
  type ImportOrderStep,
} from "@/lib/import/contract";
import {
  ALL_IMPORT_ENTITIES,
  OPENING_IMPORT_ENTITY_KEYS,
} from "@/lib/import";
import type { ContractedImportEntity } from "@/lib/import/types";
import { Figure, formatCount } from "@/components/import/figures";

export type LoadOrderProps = {
  /**
   * ⚠️ THE ALLOWLIST, HANDED IN. Defaulted rather than imported at the
   * use site so a test can add an entity and prove the waves are
   * computed. It is NOT a second registry: nothing here enumerates a key.
   */
  entities?: Readonly<Record<string, ContractedImportEntity>>;
  /** Which entity the wizard currently has selected, when it is on screen. */
  selected?: string | null;
  /** Provided by the wizard. Absent on the standalone plan page. */
  onChoose?: (key: string) => void;
};

/**
 * ⭐ THE FOUR OPENING-BALANCE ENTITIES HAVE THEIR OWN SCREEN, AND THIS
 * ONE STILL LISTS THEM.
 *
 * ⚠️ HIDING THEM WOULD BE THE DEFECT THIS WAVE EXISTS TO FIX, ONE LEVEL
 * DOWN. They are part of the migration and part of the order — an opening
 * trial balance sits in wave 1 BECAUSE the chart of accounts is in wave 0
 * — and a plan that silently omits four of the eighteen is a plan that is
 * wrong about the shape of the job. They appear with a link to the screen
 * that runs them instead of a "choose" control.
 */
const OPENING_KEYS: ReadonlySet<string> = new Set<string>(OPENING_IMPORT_ENTITY_KEYS);
const OPENING_HREF = "/settings/opening-balances";

function byWave(steps: readonly ImportOrderStep[]): Map<number, ImportOrderStep[]> {
  const out = new Map<number, ImportOrderStep[]>();
  for (const step of steps) {
    const list = out.get(step.wave);
    if (list) list.push(step);
    else out.set(step.wave, [step]);
  }
  return out;
}

export function LoadOrder({ entities = ALL_IMPORT_ENTITIES, selected, onChoose }: LoadOrderProps) {
  const order = useMemo(() => resolveImportOrder(entities), [entities]);

  /**
   * 🔴 THE REFUSAL PATH. No waves, no "best effort", no list.
   */
  if (!order.ok) {
    return (
      <section
        role="alert"
        className="space-y-2 rounded-lg border border-destructive/50 bg-destructive/5 p-4"
      >
        <h2 className="flex items-center gap-2 text-sm font-semibold text-destructive">
          <CircleAlert className="h-4 w-4" aria-hidden="true" />
          There is no order that works, so none is shown
        </h2>
        <p className="text-sm">{order.problem}</p>
        <ul className="list-inside list-disc text-sm text-muted-foreground">
          {order.entities.map((entity) => (
            <li key={entity}>{entity}</li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          Nothing is wrong with your files. This is a fault in Ordence&apos;s own
          description of how these records depend on each other, and importing in a
          guessed order would put rows in the wrong places. Please send this page to
          support.
        </p>
      </section>
    );
  }

  const waves = byWave(order.steps);

  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <h2 className="text-sm font-semibold">The order to load your files in</h2>
        <p className="text-sm text-muted-foreground">
          Ordence can import{" "}
          <Figure>{formatCount(order.steps.length)}</Figure> kinds of record. They fall
          into <Figure>{formatCount(order.waves)}</Figure>{" "}
          {order.waves === 1 ? "group" : "groups"}: everything in a group can be
          loaded in <strong>any order, or at the same time</strong>, and each group
          needs the one before it to be in first.
        </p>
      </header>

      {[...waves.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([wave, steps]) => (
          <div key={wave} className="rounded-lg border bg-card">
            <div className="border-b p-3">
              <h3 className="text-sm font-semibold">
                Group {wave + 1}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {formatCount(steps.length)} of {formatCount(order.steps.length)} —{" "}
                  {wave === 0
                    ? "nothing has to come before these"
                    : "load these once group " + wave + " is in"}
                </span>
              </h3>
              {/*
                ⚠️ SAID IN WORDS, NOT LEFT TO THE LAYOUT. A customer who
                reads a list as ordered serialises their uploads and loses
                a day to it.
              */}
              <p className="mt-1 text-xs text-muted-foreground">
                These {steps.length === 1 ? "does" : "do"} not depend on each other.
                Load them in whatever order your files are ready in.
              </p>
            </div>

            <ul className="divide-y">
              {steps.map((step) => {
                const def = entities[step.entity];
                if (!def) return null;
                const hard = def.contract.dependsOn.filter((d) => d.strength === "hard");
                const soft = softAdvice(entities, step.entity);
                const opening = OPENING_KEYS.has(step.entity);
                const escapes = def.contract.reversal.escapes;

                return (
                  <li
                    key={step.entity}
                    className={`p-3 ${selected === step.entity ? "bg-primary/5" : ""}`}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-sm font-medium">{def.label}</span>
                      {opening ? (
                        <Link
                          href={OPENING_HREF}
                          className="text-xs underline underline-offset-2"
                        >
                          Opening balances screen
                          <ArrowRight className="ml-1 inline h-3 w-3" aria-hidden="true" />
                        </Link>
                      ) : onChoose ? (
                        <button
                          type="button"
                          className="text-xs underline underline-offset-2"
                          onClick={() => onChoose(step.entity)}
                        >
                          Import this
                        </button>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{def.description}</p>

                    {/*
                      ⭐ THE `because`, VERBATIM, ON EVERY EDGE. It is
                      written for a customer and it is the reason this
                      screen persuades rather than instructs. Summarising
                      it here would be a second copy that drifts.
                    */}
                    {hard.length > 0 ? (
                      <ul className="mt-2 space-y-1.5">
                        {hard.map((dep) => (
                          <li
                            key={dep.entity}
                            className="flex gap-2 rounded-md border border-border bg-muted/40 p-2 text-xs"
                          >
                            <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            <span>
                              <strong className="font-medium">
                                {entities[dep.entity]?.label ?? dep.entity} first.
                              </strong>{" "}
                              {dep.because}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}

                    {/*
                      🔴 ADVICE, AND IT MUST NOT LOOK LIKE A RULE.
                      `softAdvice()` returns these separately for exactly
                      this reason: a migration that refuses to start until
                      every optional file is present is a migration nobody
                      can start, because most customers do not have all
                      twenty files on day one. Different words, different
                      box, no warning colour.
                    */}
                    {soft.length > 0 ? (
                      <div className="mt-2 rounded-md border border-dashed border-border p-2">
                        <p className="text-xs font-medium">
                          Better if you have it — not required
                        </p>
                        <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                          {soft.map((advice) => (
                            <li key={advice}>{advice}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {/*
                      ⚠️ WHAT AN UNDO CANNOT TAKE BACK, SAID BEFORE THE
                      RUN. `escapes: null` is a claim somebody made, and
                      it produces no line — a note under every entity is
                      how the one that matters gets skipped.
                    */}
                    {escapes ? (
                      <p className="mt-2 flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs">
                        <TriangleAlert
                          className="mt-px h-3.5 w-3.5 shrink-0 text-amber-600"
                          aria-hidden="true"
                        />
                        <span>
                          If you undo this import: {escapes}
                        </span>
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
    </section>
  );
}
