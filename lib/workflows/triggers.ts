/**
 * Ordence — Triggers, and When a Run May Start
 * Version: v0.23.0-alpha
 *
 * Pure. The dispatcher in `server/workflows/dispatch.ts` finds candidate
 * versions in the database; every DECISION about whether one of them
 * actually fires is made here, with no I/O, so it can be tested against
 * the cases that matter rather than the cases that are easy to set up.
 */

import {
  MAX_TRIGGER_DEPTH,
  MAX_WORKFLOWS_PER_EVENT,
} from "./limits";
import { evaluateGroup } from "./bindings";
import type {
  RunContext,
  TriggerConfig,
  WorkflowTriggerType,
} from "./program";

/* ------------------------------------------------------------------ */
/* THE CATALOGUE                                                       */
/* ------------------------------------------------------------------ */

export type TriggerDefinition = {
  label: string;
  description: string;
  /** True when the trigger names a record type. */
  recordScoped: boolean;
  /** True when a run has no live human and must borrow an identity. */
  unattended: boolean;
  feature: string | null;
};

export const TRIGGER_CATALOG = {
  record_created: {
    label: "When a record is created",
    description: "Fires once, immediately after a new record is saved.",
    recordScoped: true,
    unattended: false,
    feature: "workflows.builder",
  },
  record_updated: {
    label: "When a record is updated",
    description:
      "Fires when a record changes. Name the fields to watch — an unscoped " +
      "update trigger is the most common cause of a workflow triggering itself.",
    recordScoped: true,
    unattended: false,
    feature: "workflows.builder",
  },
  record_deleted: {
    label: "When a record is deleted",
    description: "Fires when a record is moved to the recycle bin.",
    recordScoped: true,
    unattended: false,
    feature: "workflows.builder",
  },
  manual: {
    label: "When someone runs it",
    description: "Fires from a button. Acts as the person who pressed it.",
    recordScoped: false,
    unattended: false,
    feature: "workflows.builder",
  },
  scheduled: {
    label: "On a schedule",
    description: "Fires on a cron expression, with no record attached.",
    recordScoped: false,
    // ⚠️ Nobody is present. The run borrows the publisher's identity —
    // see the header of `actions.ts`.
    unattended: true,
    feature: "workflows.scheduled",
  },
  webhook: {
    label: "When an external system calls in",
    description: "Fires on an authenticated HTTP callback from another system.",
    recordScoped: false,
    unattended: true,
    feature: "workflows.webhooks",
  },
} as const satisfies Record<WorkflowTriggerType, TriggerDefinition>;

export function triggerDefinition(type: WorkflowTriggerType): TriggerDefinition {
  return TRIGGER_CATALOG[type];
}

/* ------------------------------------------------------------------ */
/* THE EVENT                                                           */
/* ------------------------------------------------------------------ */

/**
 * What the dispatcher is told when something happens.
 *
 * `causedByVersionId` and `causedByDepth` are the interesting fields, and
 * they are what makes loop control possible at all: an event carries the
 * causal history of the write that produced it. A record changed by a
 * person has neither; a record changed by a workflow step has both.
 */
export type TriggerEvent = {
  type: WorkflowTriggerType;
  recordType?: string;
  recordId?: string;
  record?: Record<string, unknown> | null;
  changedFields?: string[];
  input?: Record<string, unknown> | null;
  firedAt: Date;
  /** The run that caused this event, if a workflow caused it. */
  causedByRunId?: string | null;
  causedByVersionId?: string | null;
  causedByDepth?: number;
  /** Version ids already in this causal chain, oldest first. */
  originChain?: string[];
};

export type TriggerCandidate = {
  workflowId: string;
  versionId: string;
  triggerType: WorkflowTriggerType;
  triggerConfig: TriggerConfig;
  isEnabled: boolean;
};

export type TriggerDecision =
  | { fires: true; candidate: TriggerCandidate }
  | { fires: false; candidate: TriggerCandidate; reason: TriggerSkipReason; detail: string };

export type TriggerSkipReason =
  | "disabled"
  | "wrong_trigger_type"
  | "wrong_record_type"
  | "no_watched_field_changed"
  | "conditions_not_met"
  | "self_trigger"
  | "cycle_detected"
  | "depth_exceeded";

/* ------------------------------------------------------------------ */
/* ⭐ THE DECISION                                                     */
/* ------------------------------------------------------------------ */

/**
 * Should this candidate fire for this event?
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE FOUR REFUSALS THAT STOP RUNAWAY EXECUTION
 * ══════════════════════════════════════════════════════════════════════
 * In the order they are checked, cheapest and most specific first:
 *
 *   1. SELF-TRIGGER. The event was caused by a run of THIS VERSION. "When
 *      a lead is updated, update the lead" is the first workflow every
 *      administrator writes, and without this check it is an infinite
 *      loop that begins the moment they save it.
 *
 *   2. CYCLE. This version already appears in the causal chain. Catches
 *      the case rule 1 cannot: A updates a lead, B fires and updates the
 *      lead, A fires again. Neither workflow triggers itself directly and
 *      the pair never stops.
 *
 *   3. DEPTH. The chain is longer than `MAX_TRIGGER_DEPTH`. The backstop
 *      for chains that are long rather than circular, and the only one
 *      that catches a cycle passing through a workflow that has been
 *      republished (a new version id, so rules 1 and 2 see a stranger).
 *
 *   4. FIELD SCOPE. The update did not touch a watched field. Not framed
 *      as loop protection in the UI — it is framed as "what do you care
 *      about?" — but it is the most effective of the four, because a
 *      workflow that watches `status` and writes `owner_id` cannot
 *      re-enter itself at all.
 *
 * ⚠️ ALL FOUR ARE ALSO ENFORCED IN THE DATABASE. `workflow_runs` carries
 * a BEFORE INSERT trigger that recomputes depth and chain from the parent
 * run rather than trusting the caller, and refuses a version already in
 * the chain. This function is what produces a readable "did not fire, and
 * here is why" in the run history; the trigger is what holds when a run
 * is inserted by something that is not this function.
 */
export function decideTrigger(
  candidate: TriggerCandidate,
  event: TriggerEvent,
): TriggerDecision {
  const skip = (reason: TriggerSkipReason, detail: string): TriggerDecision => ({
    fires: false,
    candidate,
    reason,
    detail,
  });

  if (!candidate.isEnabled) {
    return skip("disabled", "The workflow is switched off.");
  }

  if (candidate.triggerType !== event.type) {
    return skip("wrong_trigger_type", "This workflow listens for a different event.");
  }

  const definition = TRIGGER_CATALOG[candidate.triggerType];

  if (definition.recordScoped) {
    if (
      candidate.triggerConfig.recordType &&
      candidate.triggerConfig.recordType !== event.recordType
    ) {
      return skip(
        "wrong_record_type",
        `Listens for ${candidate.triggerConfig.recordType}, event was ${event.recordType ?? "unknown"}.`,
      );
    }
  }

  /* --- 1. Self-trigger ------------------------------------------- */
  if (event.causedByVersionId && event.causedByVersionId === candidate.versionId) {
    return skip(
      "self_trigger",
      "This event was caused by this same workflow. A workflow does not " +
        "re-enter itself — that is an infinite loop, not an automation.",
    );
  }

  /* --- 2. Cycle in the causal chain ------------------------------ */
  const chain = event.originChain ?? [];
  if (chain.includes(candidate.versionId)) {
    return skip(
      "cycle_detected",
      "This workflow already ran earlier in the chain of events that led " +
        "here. Continuing would loop between workflows.",
    );
  }

  /* --- 3. Depth --------------------------------------------------- */
  const nextDepth = (event.causedByDepth ?? -1) + 1;
  if (nextDepth > MAX_TRIGGER_DEPTH) {
    return skip(
      "depth_exceeded",
      `Workflows have already chained ${MAX_TRIGGER_DEPTH} deep from the ` +
        `original change. Stopping here.`,
    );
  }

  /* --- 4. Field scope --------------------------------------------- */
  if (candidate.triggerType === "record_updated") {
    const watched = candidate.triggerConfig.watchFields ?? [];
    if (watched.length > 0) {
      const changed = event.changedFields ?? [];
      // ⚠️ An update with NO recorded changed fields does not fire a
      // scoped trigger. The alternative — "we do not know what changed,
      // so assume everything did" — turns every scoped trigger into an
      // unscoped one the moment a write path forgets to report, which is
      // exactly when loop protection is most needed.
      const touched = watched.some((field) => changed.includes(field));
      if (!touched) {
        return skip(
          "no_watched_field_changed",
          `Watches ${watched.join(", ")}; this update changed ${
            changed.length > 0 ? changed.join(", ") : "nothing it watches"
          }.`,
        );
      }
    }
  }

  /* --- 5. The author's own conditions ------------------------------ */
  if (candidate.triggerConfig.conditions) {
    const context = contextFromEvent(event, { userId: "", role: "" });
    if (!evaluateGroup(candidate.triggerConfig.conditions, context)) {
      return skip("conditions_not_met", "The record does not match the trigger conditions.");
    }
  }

  return { fires: true, candidate };
}

/**
 * Decide for a whole set of candidates and cap the fan-out.
 *
 * ⚠️ THE CAP IS NOT A PERFORMANCE MEASURE. One UPDATE matching forty
 * workflows is forty runs, each of which may update a record, before any
 * depth counter has seen a single one. The multiplication happens at
 * breadth, and depth limits do not touch it.
 *
 * Ordering is the caller's (oldest workflow first, deterministically), so
 * the ones that are dropped are at least always the same ones and the
 * situation is diagnosable rather than random.
 */
export function decideAll(
  candidates: readonly TriggerCandidate[],
  event: TriggerEvent,
): { firing: TriggerDecision[]; skipped: TriggerDecision[]; overflow: TriggerCandidate[] } {
  const firing: TriggerDecision[] = [];
  const skipped: TriggerDecision[] = [];
  const overflow: TriggerCandidate[] = [];

  for (const candidate of candidates) {
    const decision = decideTrigger(candidate, event);
    if (!decision.fires) {
      skipped.push(decision);
      continue;
    }
    if (firing.length >= MAX_WORKFLOWS_PER_EVENT) {
      overflow.push(candidate);
      continue;
    }
    firing.push(decision);
  }

  return { firing, skipped, overflow };
}

/* ------------------------------------------------------------------ */
/* CONTEXT                                                             */
/* ------------------------------------------------------------------ */

/** Build the initial run context from an event. */
export function contextFromEvent(
  event: TriggerEvent,
  actor: { userId: string; role: string },
): RunContext {
  return {
    trigger: {
      type: event.type,
      recordType: event.recordType,
      record: event.record ?? null,
      changedFields: event.changedFields ?? [],
      input: event.input ?? null,
      firedAt: event.firedAt.toISOString(),
    },
    steps: {},
    actor,
  };
}

/** The chain a child run inherits. Kept here so it is stated once. */
export function nextOriginChain(event: TriggerEvent, versionId: string): string[] {
  return [...(event.originChain ?? []), versionId];
}
