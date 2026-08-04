/**
 * Ordence — Workflow Execution Limits
 * Version: v0.23.0-alpha
 *
 * Pure constants. No imports, no I/O — the planner, the validator, the
 * database guard and the UI all read the same numbers.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS FILE IS SEPARATE, AND WHY EVERY NUMBER HERE IS A CEILING
 * ══════════════════════════════════════════════════════════════════════
 * A workflow engine is the first feature in this product where a TENANT
 * WRITES THE PROGRAM. Everything before it — a booking, a payment plan, a
 * contract — is data being pushed through code we wrote. An automation is
 * code a customer wrote, running on our infrastructure, on a shared
 * database, under a shared connection budget.
 *
 * That inverts the usual risk. The dangerous input is no longer a
 * malformed value; it is a PERFECTLY VALID workflow that never stops:
 *
 *   • "When a lead is updated, update the lead."      → infinite loop
 *   • "For each of 400,000 units, send an email."     → the mail budget
 *   • "Wait 10 years, then continue."                 → a run that can
 *                                                       never be cleaned up
 *
 * None of those is malicious. All three are things a real administrator
 * builds on a Tuesday afternoon while learning the product. So the limits
 * are not anti-abuse measures; they are the difference between one
 * customer's mistake staying one customer's mistake and it becoming an
 * outage for everybody on the instance.
 *
 * ⚠️ EVERY LIMIT IS ENFORCED IN AT LEAST TWO PLACES. The planner refuses
 * politely (so the run history explains what happened) and the database
 * refuses absolutely (so an import script, a future API route or a bug in
 * the planner cannot get past it). Where a number appears in
 * `SQL-FILES/0018_phase23_workflows.sql` as well, it is named there.
 */

/* ------------------------------------------------------------------ */
/* THE LOOP CAPS — THE MOST IMPORTANT NUMBERS IN THE PHASE             */
/* ------------------------------------------------------------------ */

/**
 * How many workflow runs may appear in ONE CAUSAL CHAIN.
 *
 * A run whose action updates a record fires the `record_updated` trigger,
 * which starts another run, whose action updates a record… The chain is
 * legitimate up to a point — "when a booking is registered, mark the lead
 * won" then "when a lead is won, notify the manager" is two levels and is
 * exactly what people buy this feature for.
 *
 * Five is the depth at which a chain stops being a design and starts
 * being an accident. It is deliberately SMALL: a workflow author who hits
 * it has built something they cannot reason about either.
 *
 * ⚠️ Depth alone does NOT stop a loop, it only bounds one. A two-workflow
 * ping-pong (A updates a lead → B updates the lead → A …) would still run
 * five times before stopping, five times per triggering event, forever.
 * `ORIGIN_CHAIN` cycle detection below is what actually stops it; this is
 * the backstop for chains that are long rather than circular.
 */
export const MAX_TRIGGER_DEPTH = 5;

/**
 * The hard ceiling the DATABASE enforces on `workflow_runs.depth`.
 *
 * Higher than `MAX_TRIGGER_DEPTH` on purpose. The application refuses at
 * 5 with an explanation the author can read; the check constraint refuses
 * at 10 with a constraint violation. If the second one ever fires, the
 * first one has been bypassed and that is a defect worth a loud error
 * rather than a silent clamp.
 */
export const ABSOLUTE_MAX_TRIGGER_DEPTH = 10;

/**
 * ⭐ CYCLE DETECTION.
 *
 * Every run carries the list of workflow VERSION ids that led to it. A
 * version already in that list cannot start again inside the same chain.
 *
 * ⚠️ VERSION ids, not workflow ids, and the difference is subtle enough to
 * be worth stating: keying on the workflow would stop a workflow being
 * re-entered by a NEWER version of itself, which is a legitimate (if odd)
 * arrangement during a migration. Keying on the version stops the thing
 * that actually loops — the same program running itself.
 *
 * ⚠️ THIS IS DETECTION, NOT PREVENTION-BY-ANALYSIS. Statically proving a
 * workflow graph cannot trigger itself is undecidable in general: whether
 * `update_record` fires a trigger depends on the values it writes, which
 * depend on runtime data. Anything short of that is a guess that either
 * blocks legitimate workflows or misses real loops. So the check is made
 * at run time, on the actual chain that actually happened, where the
 * answer is a fact rather than an estimate.
 */
export const MAX_ORIGIN_CHAIN = ABSOLUTE_MAX_TRIGGER_DEPTH;

/* ------------------------------------------------------------------ */
/* THE PER-RUN BUDGETS                                                 */
/* ------------------------------------------------------------------ */

/**
 * Steps a single run may execute before it is stopped.
 *
 * Counts EXECUTIONS, not steps in the definition: a 4-step body inside a
 * 50-item loop is 200, not 4. That is the number that costs money, and
 * counting the definition instead is how an engine with a "50 step limit"
 * runs eighty thousand steps.
 */
export const MAX_STEPS_PER_RUN = 500;

/** A version may tighten its own budget, never loosen it past this. */
export const MAX_CONFIGURABLE_STEP_BUDGET = MAX_STEPS_PER_RUN;
export const DEFAULT_STEP_BUDGET = 100;

/**
 * Iterations across ALL loops in one run, and iterations in ONE loop.
 *
 * Two numbers because they fail differently. A single loop over 10,000
 * records is a bulk operation somebody meant; ten nested loops of 40 is a
 * combinatorial explosion nobody meant. The per-loop cap keeps the honest
 * bulk case working and the total cap stops the other one.
 */
export const MAX_ITERATIONS_PER_LOOP = 200;
export const MAX_ITERATIONS_PER_RUN = 1_000;

/** How deeply loops and branches may nest inside one definition. */
export const MAX_NESTING_DEPTH = 5;

/** Steps in one definition. A definition this large is a program, not a rule. */
export const MAX_STEPS_PER_DEFINITION = 100;

/* ------------------------------------------------------------------ */
/* TIME                                                                */
/* ------------------------------------------------------------------ */

/**
 * The longest a `delay` step may wait.
 *
 * ⚠️ A delay is not free while it waits. It holds an open run, a cursor,
 * a row that every sweeper has to consider and a promise to the customer
 * that something will happen. Thirty days is the longest anybody can
 * usefully reason about "this workflow is still running"; beyond it the
 * right tool is a scheduled workflow, which has no open state at all.
 */
export const MAX_DELAY_SECONDS = 30 * 24 * 60 * 60;
export const MIN_DELAY_SECONDS = 1;

/** How long a human-approval step waits before it expires. */
export const DEFAULT_FORM_DUE_HOURS = 72;
export const MAX_FORM_DUE_HOURS = 30 * 24;

/** Outbound HTTP. Short, because a slow endpoint must not hold a run open. */
export const HTTP_TIMEOUT_MS = 10_000;
/** Response bytes read from an `http_request` step. The rest is discarded. */
export const HTTP_MAX_RESPONSE_BYTES = 64 * 1024;

/* ------------------------------------------------------------------ */
/* FAN-OUT                                                             */
/* ------------------------------------------------------------------ */

/** Rows a `find_records` step may return into the run context. */
export const MAX_FIND_RESULTS = 200;

/**
 * How many workflows one event may start.
 *
 * ⚠️ Without this, "when a lead is updated" with forty workflows watching
 * turns one UPDATE into forty runs, and each of those may update a lead.
 * The multiplication happens before any depth counter has a chance to.
 */
export const MAX_WORKFLOWS_PER_EVENT = 10;

/**
 * The planner's own internal step ceiling.
 *
 * `planNext` walks control-flow steps (filter, if_else, iterator) without
 * executing anything, so a definition of nothing but empty branches could
 * in principle walk forever inside one call. It cannot — the walk is
 * bounded here — and if this ever trips, the planner has a bug rather
 * than the workflow having a shape.
 */
export const MAX_PLANNER_WALK = 10_000;
