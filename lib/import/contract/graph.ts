/**
 * Ordence — ⭐⭐ THE ORDER A MIGRATION IS LOADED IN
 * Version: v1.84.0-alpha · Track M1
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS IS FOR
 * ══════════════════════════════════════════════════════════════════════
 * A customer arrives with a folder. Twenty exports out of a system that
 * is being switched off on Friday. Nothing in the folder says which one
 * to load first, and the product does not either — so they load the
 * invoices, get nine hundred unresolved-customer errors, and conclude
 * the importer is broken. It is not. The order was.
 *
 * This file turns the per-entity `dependsOn` declarations into ONE
 * ordering the wizard can present and the runner can follow.
 *
 * ⚠️ PURE. No database, no network, no `@/db`. Same reason the rest of
 * `lib/import/` is pure: the wizard imports this to draw the order in the
 * browser, and a test runs it without Postgres.
 */

import type { ContractedImportEntity, ImportDependency } from "../types";

export type ImportOrderStep = {
  entity: string;
  /**
   * ⚠️ THE WAVE, NOT THE INDEX. Entities in the same wave have no
   * dependency between them and may be loaded in any order or at the
   * same time. Presenting a strict 1..20 list would tell the customer
   * that companies must precede stock items, which is false and which
   * costs them a day of serialised uploads they did not need.
   */
  wave: number;
  /** Hard dependencies satisfied by an earlier wave. For the screen. */
  after: readonly string[];
};

export type ImportOrderResult =
  | { ok: true; steps: readonly ImportOrderStep[]; waves: number }
  /**
   * 🔴 A CYCLE OR A DANGLING KEY IS A REFUSAL, NOT A WARNING, AND NOT A
   *    BEST-EFFORT ORDER.
   *
   * The tempting implementation emits whatever order it managed and
   * notes the problem. That is the defect shape this project keeps
   * finding: a function that reports success while the property it exists
   * to guarantee does not hold. A partial order is worse than none,
   * because the customer follows it.
   */
  | { ok: false; problem: string; entities: readonly string[] };

/**
 * ⚠️ ONLY `hard` DEPENDENCIES CONSTRAIN THE ORDER.
 *
 * A `soft` dependency means the rows still load, less completely. Making
 * it order-bearing would mean a customer who does not have the optional
 * file cannot start — and most customers do not have all twenty files on
 * day one. Soft edges are reported to the screen (`softAdvice`) and are
 * deliberately absent from the graph.
 */
function hardEdges(
  deps: readonly ImportDependency[],
): readonly string[] {
  return deps.filter((d) => d.strength === "hard").map((d) => d.entity);
}

/**
 * Kahn's algorithm over the hard edges, emitting waves.
 *
 * ⚠️ THE INPUT IS A MAP AND NOT AN ARRAY BECAUSE THE CALLER ALREADY HAS
 * ONE — `ALL_IMPORT_ENTITIES` — and rebuilding it here would be the
 * second place entity keys are enumerated.
 */
export function resolveImportOrder(
  entities: Readonly<Record<string, ContractedImportEntity>>,
  subset?: readonly string[],
): ImportOrderResult {
  const keys = subset ? [...subset] : Object.keys(entities);
  const known = new Set(keys);

  /* Dangling first: a missing key would otherwise present as a cycle,
   * and "there is a cycle" sends the reader to look for something that
   * is not there. Two different problems get two different sentences. */
  const dangling: string[] = [];
  for (const key of keys) {
    const def = entities[key];
    if (!def) {
      dangling.push(key);
      continue;
    }
    for (const dep of hardEdges(def.contract.dependsOn)) {
      /* ⚠️ A dependency OUTSIDE the requested subset is not dangling.
       * "Load only contacts" is a legitimate request from a customer who
       * already has their companies; the dependency is satisfied by the
       * workspace rather than by this run. It is dangling only if no
       * such entity exists AT ALL. */
      if (!Object.hasOwn(entities, dep)) dangling.push(`${key} -> ${dep}`);
    }
  }
  if (dangling.length > 0) {
    return {
      ok: false,
      problem:
        "One or more entities declare a dependency on an entity that does not exist.",
      entities: dangling,
    };
  }

  const remaining = new Set(keys);
  const steps: ImportOrderStep[] = [];
  let wave = 0;

  while (remaining.size > 0) {
    const ready = [...remaining].filter((key) => {
      const def = entities[key];
      if (!def) return false;
      return hardEdges(def.contract.dependsOn).every(
        (dep) => !remaining.has(dep),
      );
    });

    /* 🔴 NOTHING READY AND SOMETHING REMAINING IS A CYCLE. There is no
     * other way to reach this state, and every remaining entity is part
     * of a cycle or downstream of one — so all of them are named. Naming
     * only the first would send the reader to fix one edge of a loop. */
    if (ready.length === 0) {
      return {
        ok: false,
        problem:
          "These entities depend on each other in a loop, so no order exists that satisfies all of them.",
        entities: [...remaining].sort(),
      };
    }

    /* Sorted so the order is deterministic across runs. An order that
     * shuffles between two invocations is an order nobody can diff, and
     * the screen would reorder itself on every render. */
    for (const key of ready.sort()) {
      const def = entities[key];
      steps.push({
        entity: key,
        wave,
        after: def ? [...hardEdges(def.contract.dependsOn)].sort() : [],
      });
      remaining.delete(key);
    }
    wave += 1;
  }

  return { ok: true, steps, waves: wave };
}

/**
 * The soft dependencies, as sentences, for the screen that shows the
 * order. Kept out of `resolveImportOrder` because they are advice and
 * mixing advice into a computed order is how advice becomes a rule.
 */
export function softAdvice(
  entities: Readonly<Record<string, ContractedImportEntity>>,
  entityKey: string,
): readonly string[] {
  const def = entities[entityKey];
  if (!def) return [];
  return def.contract.dependsOn
    .filter((d) => d.strength === "soft")
    .map((d) => d.because);
}
