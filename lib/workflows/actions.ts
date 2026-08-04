/**
 * Ordence — The Action Catalogue
 * Version: v0.23.0-alpha
 *
 * Pure. Metadata about each action: what it is for, what it costs, and —
 * the part that matters — what it is allowed to do.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ A WORKFLOW RUNS AS A PERSON, NOT AS THE ENGINE
 * ══════════════════════════════════════════════════════════════════════
 * The single most consequential decision in this phase, and the one every
 * automation product gets wrong at least once.
 *
 * The convenient design is a service identity: the engine holds broad
 * rights and executes whatever the definition says. It is convenient
 * because workflows then never fail with "permission denied", which reads
 * like a feature. What it actually is:
 *
 *   A sales executive with `leads:read` and no `leads:delete` writes a
 *   workflow whose action is "delete every lead older than a year". The
 *   engine has the right. The executive does not. The leads are gone, and
 *   the audit trail says the automation did it.
 *
 * That is privilege escalation with a builder UI, and it is available to
 * anyone who can create a workflow.
 *
 * So: **every step is checked against the permissions of the person the
 * run is acting as.** `permission` below names what each action needs;
 * `server/workflows/executor.ts` evaluates it with `evaluatePermission()`
 * against the actor's role and overrides — the same function the server
 * actions use, so there is one answer to "may this person do this" and
 * not two.
 *
 * The consequences, stated plainly because they are the point:
 *   • A workflow can do NOTHING its author could not do by hand.
 *   • A manually triggered run acts as the person who pressed the button,
 *     which may be someone with FEWER rights than the author. It then
 *     fails a step, visibly, in the run history. That is correct: the
 *     alternative is the button being a rights-elevation device.
 *   • A scheduled or webhook run has no live person, so it acts as the
 *     user who PUBLISHED the version (`workflow_versions.run_as_user_id`).
 *     Publishing is therefore the moment authority is delegated, which is
 *     why it has its own permission and its own audit entry.
 */

import type { WorkflowActionType } from "./program";

export type ActionDefinition = {
  label: string;
  description: string;
  /** Control actions are resolved by the planner; effects are executed. */
  kind: "effect" | "control";
  /**
   * The permission this action needs, beyond any record-level permission.
   * `null` means the action itself grants nothing new — `if_else` reads
   * data already in the run context, so gating it would deny a decision,
   * not an action.
   */
  permission: string | null;
  /** The entitlement key, where the action is separately sold. */
  feature: string | null;
  /** True when the action can suspend a run for an unbounded period. */
  suspends: boolean;
  /** Counted against the run's step budget. */
  billable: boolean;
};

export const ACTION_CATALOG = {
  create_record: {
    label: "Create a record",
    description: "Add a lead, contact, company or deal.",
    kind: "effect",
    // The record-type permission (`leads:create`) is resolved separately
    // in `records.ts` and BOTH are required. This one says the run may
    // write at all; that one says what it may write.
    permission: null,
    feature: "workflows.builder",
    suspends: false,
    billable: true,
  },
  update_record: {
    label: "Update a record",
    description: "Change fields on an existing record.",
    kind: "effect",
    permission: null,
    feature: "workflows.builder",
    suspends: false,
    billable: true,
  },
  delete_record: {
    label: "Delete a record",
    description: "Move a record to the recycle bin.",
    kind: "effect",
    permission: null,
    feature: "workflows.builder",
    suspends: false,
    billable: true,
  },
  find_records: {
    label: "Find records",
    description: "Search for records to act on, and put them in the context.",
    kind: "effect",
    permission: null,
    feature: "workflows.builder",
    suspends: false,
    billable: true,
  },
  send_email: {
    label: "Send an email",
    description: "Send a message to a person inside or outside the workspace.",
    kind: "effect",
    // ⚠️ Its own permission. An email leaves the building — it reaches a
    // buyer, under the company's name, with no human between the
    // definition and the recipient. Someone who may edit a lead has not
    // thereby been authorised to write to that lead's buyer.
    permission: "workflows:send_email",
    feature: "email.transactional",
    suspends: false,
    billable: true,
  },
  http_request: {
    label: "Call an external service",
    description: "Send an HTTP request to a system outside Ordence.",
    kind: "effect",
    // ⚠️ THE MOST DANGEROUS ACTION IN THE PRODUCT, and the permission
    // reflects it. Anything readable in the run context can be posted
    // anywhere the caller chooses; that is data export dressed as an
    // integration. See `http-policy.ts` for the SSRF half of the problem.
    permission: "workflows:http_request",
    feature: "workflows.http_request",
    suspends: false,
    billable: true,
  },

  filter: {
    label: "Only continue if…",
    description: "Stop the run unless the conditions hold.",
    kind: "control",
    permission: null,
    feature: null,
    suspends: false,
    billable: false,
  },
  if_else: {
    label: "Branch",
    description: "Take one path or the other.",
    kind: "control",
    permission: null,
    feature: null,
    suspends: false,
    billable: false,
  },
  iterator: {
    label: "For each",
    description: "Repeat the steps inside for every item in a list.",
    kind: "control",
    permission: null,
    feature: null,
    suspends: false,
    billable: false,
  },
  delay: {
    label: "Wait",
    description: "Pause the run for a period, then continue.",
    kind: "control",
    permission: null,
    feature: null,
    // Suspends: the run stops occupying a worker and becomes a row with a
    // `resume_at`. Cheap while waiting, but it is open state — which is
    // why `MAX_DELAY_SECONDS` exists.
    suspends: true,
    billable: false,
  },
  form: {
    label: "Wait for approval",
    description: "Pause until a person approves or rejects.",
    kind: "control",
    // Creating a task assigns work to somebody. That is not a permission
    // on the responder — it is a permission on the author to interrupt a
    // colleague's day, and it is deliberately not free.
    permission: "workflows:request_approval",
    feature: "workflows.builder",
    suspends: true,
    billable: false,
  },
} as const satisfies Record<WorkflowActionType, ActionDefinition>;

export function actionDefinition(action: WorkflowActionType): ActionDefinition {
  return ACTION_CATALOG[action];
}

/**
 * Actions that need something beyond "may run workflows".
 *
 * Used by the builder to grey out what the author cannot use — a person
 * who discovers at run time that their workflow could never have worked
 * has already told a customer it would.
 */
export function permissionsRequiredBy(
  actions: readonly WorkflowActionType[],
): string[] {
  const required = new Set<string>();
  for (const action of actions) {
    const permission = ACTION_CATALOG[action].permission;
    if (permission) required.add(permission);
  }
  return [...required].sort();
}

export function featuresRequiredBy(
  actions: readonly WorkflowActionType[],
): string[] {
  const required = new Set<string>();
  for (const action of actions) {
    const feature = ACTION_CATALOG[action].feature;
    if (feature) required.add(feature);
  }
  return [...required].sort();
}
