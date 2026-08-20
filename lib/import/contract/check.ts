/**
 * Ordence — ⭐⭐ THE CONTRACT CHECKS ITSELF
 * Version: v1.84.0-alpha · Track M1
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY A CHECKER AND NOT JUST TYPES
 * ══════════════════════════════════════════════════════════════════════
 * Making `contract` a required member gets TypeScript to insist the
 * object exists. It does not get TypeScript to insist the object means
 * anything. Every one of these is type-correct and wrong:
 *
 *   · `reversal: { kind: "restore-prior", capturePriorFields: [] }`
 *     — an undo that runs, reports success, and restores nothing.
 *   · `provenance: { targets: [] }` on an entity that writes `companies`
 *     — rows that cannot be attributed and therefore cannot be reversed.
 *   · `duplicateModes: ["update"]` with `reversal.kind: "delete"`
 *     — an undo that deletes records the customer had BEFORE the run.
 *   · `requiredness.structural: ["customerId"]` with no message for it
 *     — a row refused with a blank reason in the failed-rows CSV.
 *   · `dependsOn: [{ entity: "custmoers" }]`
 *     — a typo that silently drops an ordering constraint.
 *
 * ⚠️ THE THIRD ONE IS THE ONE THAT MATTERS. It is not a style problem.
 * It is a data-destroying combination that reads as complete, and it is
 * the combination a hurried author will write, because `delete` is the
 * obvious answer and `update` is the mode customers ask for.
 *
 * ⭐ AND THIS FILE IS WIRED TO CI GATE 29 (`scripts/check-import-contract.mjs`).
 * A checker nobody runs is the defect it was written to prevent.
 *
 * ⚠️ PURE. No database. Runs in a unit test and in the gate.
 */

import type { ContractedImportEntity } from "../types";
import { resolveImportOrder } from "./graph";

export type ContractProblem = {
  entity: string;
  /** The member at fault, for grouping. */
  member: string;
  /** What is wrong, and what breaks because of it. Written for a reader. */
  problem: string;
};

export type ContractCheckResult = {
  ok: boolean;
  problems: readonly ContractProblem[];
  /** How many entities were examined. Printed on success — see below. */
  examined: number;
};

/**
 * ⚠️ EVERY PROBLEM, NOT THE FIRST.
 *
 * A checker that stops at the first fault turns a five-minute fix into
 * five CI rounds, and the sixth entity's author never sees the pattern.
 */
export function checkImportContract(
  entities: Readonly<Record<string, ContractedImportEntity>>,
): ContractCheckResult {
  const problems: ContractProblem[] = [];
  const keys = Object.keys(entities);

  for (const key of keys) {
    const def = entities[key];
    if (!def) continue;
    const c = def.contract;

    /* ---- dependencies name real entities ---- */
    for (const dep of c.dependsOn) {
      if (!Object.hasOwn(entities, dep.entity)) {
        problems.push({
          entity: key,
          member: "contract.dependsOn",
          problem: `depends on "${dep.entity}", which is not an entity. The ordering constraint it was meant to express does not exist, so this entity will be offered before its prerequisite.`,
        });
      }
      if (dep.entity === key) {
        problems.push({
          entity: key,
          member: "contract.dependsOn",
          problem: `depends on itself, which no order can satisfy.`,
        });
      }
      if (dep.because.trim() === "") {
        problems.push({
          entity: key,
          member: "contract.dependsOn",
          problem: `declares a dependency on "${dep.entity}" with no reason. The reason is what the wizard shows the customer next to the order; without it the screen says only "do this first", which is the sentence customers ignore.`,
        });
      }
    }

    /* ---- provenance covers the destination ---- */
    if (c.provenance.targets.length === 0) {
      problems.push({
        entity: key,
        member: "contract.provenance.targets",
        problem: `names no destination table. Rows it writes cannot be attributed to a run, so they cannot be reversed and cannot be reconciled. The undo would report success and do nothing.`,
      });
    } else if (!c.provenance.targets.includes(def.table)) {
      problems.push({
        entity: key,
        member: "contract.provenance.targets",
        problem: `does not include its own destination "${def.table}". Every row this entity writes into that table is unattributable while the contract reads as complete.`,
      });
    }

    /* ---- reversal is coherent with the modes offered ---- */
    const modes = def.duplicateModes ?? (["skip", "update", "fail"] as const);
    const offersUpdate = modes.includes("update");

    if (offersUpdate && c.reversal.kind === "delete") {
      problems.push({
        entity: key,
        member: "contract.reversal",
        problem: `offers duplicate mode "update" but declares reversal "delete". In update mode this entity OVERWRITES records that existed before the migration; deleting them on undo destroys customer data that was never part of the run. Either declare "restore-prior" and capture the prior values, or remove "update" from duplicateModes.`,
      });
    }

    if (c.reversal.kind === "restore-prior") {
      const fields = c.reversal.capturePriorFields ?? [];
      if (fields.length === 0) {
        problems.push({
          entity: key,
          member: "contract.reversal.capturePriorFields",
          problem: `declares reversal "restore-prior" but captures nothing. By the time an undo runs the prior values are gone, so this undo restores nothing while reporting that it did. Name the fields, or "*" for the whole row.`,
        });
      }
    }

    if (c.reversal.kind !== "restore-prior" && (c.reversal.capturePriorFields?.length ?? 0) > 0) {
      problems.push({
        entity: key,
        member: "contract.reversal.capturePriorFields",
        problem: `captures prior values but its reversal kind is "${c.reversal.kind}", which never reads them. Either the kind is wrong or the capture is dead weight written into every row.`,
      });
    }

    if (c.reversal.because.trim() === "") {
      problems.push({
        entity: key,
        member: "contract.reversal.because",
        problem: `gives no reason for its reversal kind. The next author to touch this entity has to guess whether the choice was considered or inherited by copy-paste.`,
      });
    }

    /* ---- append-only destinations cannot be updated ---- */
    if (c.reversal.kind === "reverse-entry" && offersUpdate) {
      problems.push({
        entity: key,
        member: "contract.reversal",
        problem: `writes to an append-only ledger (reversal "reverse-entry") but offers duplicate mode "update". A posted entry is corrected by reversing it, not by rewriting the numbers under a transaction somebody has reconciled against.`,
      });
    }

    /* ---- every structural field has a message ---- */
    for (const field of c.requiredness.structural) {
      const msg = c.requiredness.messages[field];
      if (typeof msg !== "string" || msg.trim() === "") {
        problems.push({
          entity: key,
          member: "contract.requiredness.messages",
          problem: `field "${field}" is structurally required but has no message. A row refused for a blank reason is a row the customer cannot fix, and the failed-rows CSV is the entire mechanism by which they find it.`,
        });
      }
    }
    /* ⚠️ AND THE OTHER DIRECTION. A message for a field that is not
     * structural is a message nobody will ever see, which usually means
     * the field name was changed and the message was not. */
    for (const field of Object.keys(c.requiredness.messages)) {
      if (!c.requiredness.structural.includes(field)) {
        problems.push({
          entity: key,
          member: "contract.requiredness.messages",
          problem: `has a message for "${field}", which is not in structural. The message is unreachable — most often because the field was renamed on one side only.`,
        });
      }
    }

    /* ---- the recommended duplicate mode is one that is offered ---- */
    if (!modes.includes(c.duplicateDecision.recommended)) {
      problems.push({
        entity: key,
        member: "contract.duplicateDecision.recommended",
        problem: `recommends "${c.duplicateDecision.recommended}", which is not in duplicateModes. The wizard would pre-select an option the server refuses.`,
      });
    }
    if (c.duplicateDecision.because.trim() === "") {
      problems.push({
        entity: key,
        member: "contract.duplicateDecision.because",
        problem: `recommends a duplicate mode with no reason. This sentence sits next to the radio button where the customer decides what happens to data they already have.`,
      });
    }
  }

  /* ---- the whole graph must resolve ---- */
  const order = resolveImportOrder(entities);
  if (!order.ok) {
    problems.push({
      entity: order.entities.join(", "),
      member: "contract.dependsOn",
      problem: order.problem,
    });
  }

  return { ok: problems.length === 0, problems, examined: keys.length };
}
