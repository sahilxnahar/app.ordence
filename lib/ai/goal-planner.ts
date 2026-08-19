/**
 * Ordence — ⭐ THE GOAL PLANNER
 * Version: v0.77.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS IS
 * ══════════════════════════════════════════════════════════════════════
 * Takes a natural-language goal ("Send a reminder email to every client
 * with an overdue invoice over ₹50,000") and asks the AI to produce a
 * workflow program — a JSON array of steps in the Ordence workflow
 * vocabulary. The program is then validated by the existing
 * `validateDefinition` function, the same one that checks a hand-built
 * workflow at publish time.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 SECURITY: THE PLANNER PRODUCES A DRAFT, NOT A LIVE WORKFLOW
 * ══════════════════════════════════════════════════════════════════════
 * The output is a workflow *draft*. It must go through the existing
 * publish flow, which:
 *
 *   - Validates every step, every record type, every column reference
 *   - Checks the publisher's own permissions against what the steps need
 *   - Writes an audit entry
 *
 * The AI does not publish, does not run, does not bypass validation.
 * It is a faster way to write the same JSON the builder produces — not
 * a shortcut around the safety checks.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE AI IS INSTRUCTED TO USE ONLY KNOWN ACTIONS AND RECORD TYPES
 * ══════════════════════════════════════════════════════════════════════
 * The system prompt lists every action type, every record type, and every
 * condition operator. The AI is told to use only those. The validator
 * catches anything it gets wrong — a record type that does not exist, a
 * column that is not writable, a step key that is malformed — and the
 * caller can send the errors back to the AI for a second attempt.
 */

import "server-only";

import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
} from "@/lib/ai/client";
import {
  ACTION_TYPES,
  CONDITION_OPERATORS,
  type WorkflowActionType,
  type ConditionOperator,
  type WorkflowProgram,
  type WorkflowStep,
  type WorkflowTriggerType,
} from "@/lib/workflows/program";
import { RECORD_TYPES, RECORD_TYPE_KEYS } from "@/lib/workflows/records";
import { validateDefinition } from "@/lib/workflows/validation";
import type { TriggerConfig } from "@/lib/workflows/program";

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type GoalPlanResult = {
  ok: boolean;
  /** The generated workflow program (valid JSON, may have validation issues). */
  program?: WorkflowProgram;
  /** The trigger type the AI chose. */
  triggerType?: WorkflowTriggerType;
  /** The trigger config the AI chose. */
  triggerConfig?: TriggerConfig;
  /** A human-readable name for the workflow. */
  name?: string;
  /** A human-readable description. */
  description?: string;
  /** Validation errors (empty if the program is valid). */
  errors: string[];
  /** Validation warnings (non-blocking). */
  warnings: string[];
  /** If the AI call itself failed, the reason. */
  reason?: string;
};

/* ------------------------------------------------------------------ */
/* THE SYSTEM PROMPT                                                   */
/* ------------------------------------------------------------------ */

/**
 * Builds the system prompt that tells the AI what vocabulary it can use.
 *
 * ⚠️ This is the load-bearing part of the planner. The AI can only use
 * actions, record types, and operators that are listed here. Anything
 * else it produces will be caught by the validator, but the prompt is
 * the first line of defence — a model that does not know about
 * `iterator` will not try to use it.
 */
function buildPlannerPrompt(): string {
  const actions = ACTION_TYPES.join(", ");
  const operators = CONDITION_OPERATORS.join(", ");
  const recordTypes = RECORD_TYPE_KEYS.join(", ");

  // Build a summary of each record type's writable columns
  const recordTypeDetails = RECORD_TYPE_KEYS.map((key) => {
    const rt = RECORD_TYPES[key];
    return `  - ${key}: writable columns = [${rt.writableColumns.join(", ")}]`;
  }).join("\n");

  return `You are the Ordence Goal Planner. You convert natural-language business goals into workflow programs.

YOU OUTPUT JSON ONLY. No prose, no markdown, no explanation — just a JSON object.

AVAILABLE ACTIONS (use only these):
  ${actions}

AVAILABLE RECORD TYPES (use only these):
  ${recordTypes}

${recordTypeDetails}

AVAILABLE CONDITION OPERATORS:
  ${operators}

TRIGGER TYPES:
  - manual: when someone presses a button
  - record_created: when a new record is saved
  - record_updated: when a record changes (name the fields to watch)
  - scheduled: on a cron schedule (five-field cron expression)
  - webhook: when an external system calls in

STEP FORMAT (each step is a JSON object):
  - { "key": "unique_id", "label": "optional label", "action": "find_records", "recordType": "lead", "where": { "match": "all", "conditions": [{ "path": "trigger.record.status", "operator": "eq", "value": "active" }] }, "limit": 50 }
  - { "key": "unique_id", "action": "send_email", "to": "{{ steps.find_leads.records[0].email }}", "subject": "Reminder", "body": "Your invoice is overdue" }
  - { "key": "unique_id", "action": "filter", "conditions": { "match": "all", "conditions": [{ "path": "trigger.record.amount_minor", "operator": "gt", "value": 5000000 }] } }
  - { "key": "unique_id", "action": "if_else", "conditions": { "match": "any", "conditions": [...] }, "then": [...steps...], "otherwise": [...steps...] }
  - { "key": "unique_id", "action": "iterator", "source": "steps.find_leads.records", "itemAlias": "lead", "body": [...steps...] }
  - { "key": "unique_id", "action": "delay", "seconds": 3600 }
  - { "key": "unique_id", "action": "form", "title": "Approve this?", "assignTo": "{{ trigger.record.owner_id }}", "onReject": "stop" }

RULES:
  1. Every step MUST have a unique "key" (lowercase, underscores, max 64 chars).
  2. Use "find_records" to query data, then "iterator" to loop over results.
  3. Use {{ bindings }} to reference data from the run context, e.g. {{ trigger.record.id }} or {{ steps.my_step.records[0].name }}.
  4. For emails, use the "send_email" action with "to", "subject", and "body".
  5. For approvals, use the "form" action.
  6. Keep it simple — prefer fewer steps over more.
  7. Amount values are in paise (1 rupee = 100 paise), suffix _minor.

OUTPUT FORMAT:
{
  "name": "Short workflow name",
  "description": "One-line description",
  "triggerType": "manual" | "record_created" | "record_updated" | "scheduled" | "webhook",
  "triggerConfig": {},
  "program": {
    "steps": [ ... step objects ... ]
  }
}

Output ONLY the JSON object. No markdown fences, no commentary.`;
}

/* ------------------------------------------------------------------ */
/* THE PLANNER                                                         */
/* ------------------------------------------------------------------ */

export type GoalPlannerRequest = {
  goal: string;
  tenantId: string;
  /**
   * ⭐⭐ 0105 · THE COMPLETION IS INJECTED, AND IT IS REQUIRED.
   *
   * ⚠️ THIS FILE IS IN `lib/` AND MUST STAY THERE. It is pure planning —
   * it builds a prompt and validates the JSON that comes back. Reaching
   * a workspace's own provider key means reading the database and
   * opening the vault, and `npm run check:boundaries` would correctly
   * refuse an `@/db` import from here.
   *
   * 🔴 REQUIRED RATHER THAN DEFAULTING TO `chatCompletion`. A default
   * would mean a caller who forgets it silently falls back to Ordence's
   * key while believing it is using the customer's — the exact shape of
   * "declared, displayed, and wired to nothing" that this codebase keeps
   * producing. There is one caller, and TypeScript makes it supply this.
   */
  chat: (request: ChatRequest) => Promise<ChatResponse>;
};

export async function planGoal(request: GoalPlannerRequest): Promise<GoalPlanResult> {
  const { goal } = request;

  if (!goal || goal.trim().length < 5) {
    return {
      ok: false,
      errors: [],
      warnings: [],
      reason: "The goal is too short. Describe what you want to automate in a sentence.",
    };
  }

  if (goal.length > 2000) {
    return {
      ok: false,
      errors: [],
      warnings: [],
      reason: "The goal is too long. Keep it under 2000 characters.",
    };
  }

  const messages: ChatMessage[] = [
    { role: "system", content: buildPlannerPrompt() },
    { role: "user", content: goal },
  ];

  /**
   * ⚠️ `sensitivity: "tenant"` IS UNCHANGED. A goal describes what the
   * workspace wants automated and routinely names its own customers,
   * projects and money. The injected completion changes whose key pays;
   * it does not change which lane may be asked.
   */
  const response = await request.chat({
    messages,
    temperature: 0.2,
    sensitivity: "tenant",
  });

  if (!response.ok) {
    return {
      ok: false,
      errors: [],
      warnings: [],
      reason: response.reason,
    };
  }

  const content = response.result.message.content;
  if (!content) {
    return {
      ok: false,
      errors: [],
      warnings: [],
      reason: "The AI returned an empty response. Try rephrasing the goal.",
    };
  }

  // ⚠️ The AI may wrap the JSON in markdown fences despite instructions.
  // Strip them before parsing.
  const cleaned = content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  let parsed: {
    name?: string;
    description?: string;
    triggerType?: WorkflowTriggerType;
    triggerConfig?: TriggerConfig;
    program?: { steps?: WorkflowStep[] };
  };

  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return {
      ok: false,
      errors: ["The AI produced invalid JSON. Try rephrasing the goal."],
      warnings: [],
      reason: "JSON parse error",
    };
  }

  if (!parsed.program?.steps || !Array.isArray(parsed.program.steps)) {
    return {
      ok: false,
      errors: ["The AI did not produce a valid workflow program. Try rephrasing the goal."],
      warnings: [],
      reason: "Missing program.steps",
    };
  }

  if (!parsed.triggerType) {
    return {
      ok: false,
      errors: ["The AI did not specify a trigger type. Try rephrasing the goal."],
      warnings: [],
      reason: "Missing triggerType",
    };
  }

  const program: WorkflowProgram = { steps: parsed.program.steps };
  const triggerConfig: TriggerConfig = parsed.triggerConfig ?? {};

  // ⚠️ VALIDATE BEFORE RETURNING. The same validator that checks a
  // hand-built workflow at publish time checks the AI's output here.
  const validation = validateDefinition({
    triggerType: parsed.triggerType,
    triggerConfig,
    program,
  });

  return {
    ok: validation.ok,
    program,
    triggerType: parsed.triggerType,
    triggerConfig,
    name: parsed.name ?? "AI-generated workflow",
    description: parsed.description ?? goal.slice(0, 200),
    errors: validation.errors.map((e) => `[${e.where}] ${e.message}`),
    warnings: validation.warnings.map((w) => `[${w.where}] ${w.message}`),
  };
}
