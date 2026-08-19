import "server-only";

/**
 * Ordence — Effects
 * Version: v0.23.0-alpha
 *
 * The six actions that change something outside the run. Control flow —
 * filter, branch, loop, wait, approve — is decided in
 * `lib/workflows/planner.ts` and never reaches this file.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ EVERY FUNCTION HERE STARTS WITH THE SAME TWO LINES
 * ══════════════════════════════════════════════════════════════════════
 *   1. `authoriseActor(actor, permission)` — may the person this run is
 *      acting as do this?
 *   2. `recordTypeFor(step.recordType)`    — is this a thing a workflow
 *      may touch at all?
 *
 * Both are re-checked HERE, per step, not once when the workflow was
 * published. Publishing was months ago; the definition has been sitting
 * in a table that a support engineer, an import or a future API route can
 * write to, and the publisher's permissions may have been revoked since.
 * A gate that ran once at publish time is a gate that protects the state
 * of the world as it was on the day somebody clicked a button.
 *
 * ⚠️ NO TABLE NAME AND NO COLUMN NAME IN THIS FILE COMES FROM A WORKFLOW
 * DEFINITION. Every one is looked up in the frozen catalogue in
 * `lib/workflows/records.ts`. Values are parameterised, always — but
 * parameterisation is protection against injection, not against a
 * workflow updating `tenant_id`, and those are different problems.
 */

import { sql } from "drizzle-orm";
import { interpolate, resolveValue } from "@/lib/workflows/bindings";
import {
  isReadableColumn,
  partitionWritableColumns,
  permissionForRecordAction,
  recordTypeFor,
} from "@/lib/workflows/records";
import { checkOutboundUrl, filterHeaders } from "@/lib/workflows/http-policy";
import {
  HTTP_MAX_RESPONSE_BYTES,
  HTTP_TIMEOUT_MS,
  MAX_FIND_RESULTS,
} from "@/lib/workflows/limits";
import { authoriseActor, type RunActor } from "./guards";
import { sendEmail, isValidEmail } from "@/lib/email/resend";
import type { RunContext, WorkflowStep } from "@/lib/workflows/program";

/* ------------------------------------------------------------------ */
/* THE SHAPE OF AN EFFECT                                              */
/* ------------------------------------------------------------------ */

/** A drizzle transaction. Typed loosely so this file does not depend on the
 *  exact generic drizzle produces for a pooled transaction. */
type Tx = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

export type EffectArgs = {
  tx: Tx;
  tenantId: string;
  actor: RunActor;
  step: WorkflowStep;
  /** The run context with any loop bindings already merged in. */
  context: RunContext;
  runId: string;
  now: Date;
};

export type EffectOutcome = {
  /** Stored on the step row and put in the context under the step key. */
  output: Record<string, unknown>;
  /** What was actually sent or written, resolved. For the history. */
  input: Record<string, unknown>;
};

/**
 * Thrown when a step cannot proceed. The message reaches the run history
 * verbatim, so it is written for the person reading it at 9am.
 */
export class EffectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EffectError";
  }
}

export async function runEffect(args: EffectArgs): Promise<EffectOutcome> {
  switch (args.step.action) {
    case "create_record":
      return createRecord(args);
    case "update_record":
      return updateRecord(args);
    case "delete_record":
      return deleteRecord(args);
    case "find_records":
      return findRecords(args);
    case "send_email":
      return sendEmailEffect(args);
    case "http_request":
      return httpRequest(args);
    default:
      // Control actions never reach here — the planner resolves them. If
      // one does, the planner and this switch disagree, which is a defect
      // rather than a workflow problem.
      throw new EffectError(
        `"${args.step.action}" is not an action this engine executes. Report this.`,
      );
  }
}

/* ------------------------------------------------------------------ */
/* RECORD EFFECTS                                                      */
/* ------------------------------------------------------------------ */

async function createRecord(args: EffectArgs): Promise<EffectOutcome> {
  const step = args.step as Extract<WorkflowStep, { action: "create_record" }>;
  const definition = requireRecordType(step.recordType);
  const permission = requirePermissionFor(step.recordType, "create");
  authoriseActor(args.actor, permission);

  const resolved = resolveValues(step.values, args.context);
  const { allowed, refused } = partitionWritableColumns(step.recordType, Object.keys(resolved));

  if (refused.length > 0) {
    // ⚠️ REFUSED, NOT SILENTLY DROPPED. Quietly ignoring a column means
    // the workflow "works" and does not do what it says — the author sees
    // a green run and a record that never got the field they set.
    throw new EffectError(
      `This step tries to write ${refused.join(", ")} on a ` +
        `${definition.label.toLowerCase()}, which automations may not set. ` +
        `Writable fields: ${definition.writableColumns.join(", ")}.`,
    );
  }

  const missing = definition.requiredOnCreate.filter((column) => !allowed.includes(column));
  if (missing.length > 0) {
    throw new EffectError(
      `Creating a ${definition.label.toLowerCase()} needs ${missing.join(", ")}.`,
    );
  }

  const columns = allowed.map((column) => sql.identifier(column));
  const values = allowed.map((column) => sql`${resolved[column]}`);

  const result = await args.tx.execute(sql`
    INSERT INTO ${sql.identifier(definition.table)}
      (tenant_id, ${sql.join(columns, sql`, `)})
    VALUES
      (${args.tenantId}, ${sql.join(values, sql`, `)})
    RETURNING id
  `);

  const row = firstRow(result);
  if (!row) throw new EffectError("The record was not created.");

  return {
    input: { recordType: step.recordType, values: pick(resolved, allowed) },
    output: { id: row.id, recordType: step.recordType, created: true },
  };
}

async function updateRecord(args: EffectArgs): Promise<EffectOutcome> {
  const step = args.step as Extract<WorkflowStep, { action: "update_record" }>;
  const definition = requireRecordType(step.recordType);
  const permission = requirePermissionFor(step.recordType, "update");
  authoriseActor(args.actor, permission);

  const recordId = requireUuid(
    resolveValue(step.recordId, args.context),
    "The record to update",
  );

  const resolved = resolveValues(step.values, args.context);
  const { allowed, refused } = partitionWritableColumns(step.recordType, Object.keys(resolved));

  if (refused.length > 0) {
    throw new EffectError(
      `This step tries to write ${refused.join(", ")} on a ` +
        `${definition.label.toLowerCase()}, which automations may not set.`,
    );
  }
  if (allowed.length === 0) {
    throw new EffectError("This step sets no fields that a workflow may write.");
  }

  const assignments = allowed.map(
    (column) => sql`${sql.identifier(column)} = ${resolved[column]}`,
  );

  // ⚠️ `tenant_id = :tenant` IS IN THE WHERE CLAUSE AS WELL AS RLS.
  // Belt and braces: RLS makes the row invisible to another tenant, and
  // this makes the statement wrong rather than merely empty if the
  // connection ever loses its tenant context. Both, always.
  const result = await args.tx.execute(sql`
    UPDATE ${sql.identifier(definition.table)}
       SET ${sql.join(assignments, sql`, `)}, updated_at = now()
     WHERE id = ${recordId}::uuid
       AND tenant_id = ${args.tenantId}
    RETURNING id
  `);

  const row = firstRow(result);
  if (!row) {
    throw new EffectError(
      `No ${definition.label.toLowerCase()} with that id exists in this workspace. ` +
        `It may have been deleted since the workflow started.`,
    );
  }

  return {
    input: { recordType: step.recordType, recordId, values: pick(resolved, allowed) },
    output: { id: row.id, recordType: step.recordType, updated: true },
  };
}

/**
 * Delete a record.
 *
 * ⚠️ A SOFT DELETE, ALWAYS, AND NOT BECAUSE IT IS GENTLER.
 *
 * The application role holds no DELETE grant on any of these tables
 * (Phase 22, Section 9 and the same reasoning throughout). A hard DELETE
 * from a workflow step would fail with 42501 halfway through a run,
 * leaving the earlier steps committed and the author reading "permission
 * denied" for an action the builder offered them.
 */
async function deleteRecord(args: EffectArgs): Promise<EffectOutcome> {
  const step = args.step as Extract<WorkflowStep, { action: "delete_record" }>;
  const definition = requireRecordType(step.recordType);
  const permission = requirePermissionFor(step.recordType, "delete");
  authoriseActor(args.actor, permission);

  if (!definition.softDelete) {
    throw new EffectError(
      `A ${definition.label.toLowerCase()} cannot be deleted by an automation.`,
    );
  }

  const recordId = requireUuid(
    resolveValue(step.recordId, args.context),
    "The record to delete",
  );

  const result = await args.tx.execute(sql`
    UPDATE ${sql.identifier(definition.table)}
       SET deleted_at = now(),
           deleted_by = ${args.actor.userId}::uuid,
           updated_at = now()
     WHERE id = ${recordId}::uuid
       AND tenant_id = ${args.tenantId}
       AND deleted_at IS NULL
    RETURNING id
  `);

  const row = firstRow(result);
  if (!row) {
    // Already gone is not a failure. A workflow that cleans up records is
    // frequently racing a person doing the same thing by hand, and
    // failing the run for winning that race helps nobody.
    return {
      input: { recordType: step.recordType, recordId },
      output: { id: recordId, recordType: step.recordType, deleted: false, alreadyGone: true },
    };
  }

  return {
    input: { recordType: step.recordType, recordId },
    output: { id: row.id, recordType: step.recordType, deleted: true },
  };
}

/**
 * Find records to act on.
 *
 * ⚠️ THE CONDITION `path` HERE IS A COLUMN NAME, NOT A CONTEXT PATH.
 *
 * Everywhere else in the engine a condition's `path` reads from the run
 * context. In a find step it names a column to filter on, because the
 * filtering happens in the database rather than in memory — the whole
 * point being to avoid pulling the table into the process. The column is
 * checked against the readable list; anything else is refused rather than
 * ignored, so a typo is visible instead of silently widening the search.
 */
async function findRecords(args: EffectArgs): Promise<EffectOutcome> {
  const step = args.step as Extract<WorkflowStep, { action: "find_records" }>;
  const definition = requireRecordType(step.recordType);
  const permission = requirePermissionFor(step.recordType, "read");
  authoriseActor(args.actor, permission);

  const limit = Math.min(Math.max(1, step.limit ?? 50), MAX_FIND_RESULTS);
  const conditions: ReturnType<typeof sql>[] = [];

  for (const condition of step.where?.conditions ?? []) {
    const column = condition.path;
    if (!isReadableColumn(step.recordType, column)) {
      throw new EffectError(
        `A workflow cannot filter a ${definition.label.toLowerCase()} on ` +
          `"${column}". Available fields: ${definition.readableColumns.join(", ")}.`,
      );
    }

    const identifier = sql.identifier(column);
    const value = resolveValue(condition.value, args.context);

    switch (condition.operator) {
      case "eq":
        conditions.push(sql`${identifier} = ${value}`);
        break;
      case "neq":
        conditions.push(sql`${identifier} IS DISTINCT FROM ${value}`);
        break;
      case "gt":
        conditions.push(sql`${identifier} > ${value}`);
        break;
      case "gte":
        conditions.push(sql`${identifier} >= ${value}`);
        break;
      case "lt":
        conditions.push(sql`${identifier} < ${value}`);
        break;
      case "lte":
        conditions.push(sql`${identifier} <= ${value}`);
        break;
      case "contains":
        conditions.push(sql`${identifier}::text ILIKE ${"%" + String(value ?? "") + "%"}`);
        break;
      case "not_contains":
        conditions.push(
          sql`COALESCE(${identifier}::text NOT ILIKE ${"%" + String(value ?? "") + "%"}, true)`,
        );
        break;
      case "is_empty":
        conditions.push(sql`(${identifier} IS NULL OR ${identifier}::text = '')`);
        break;
      case "is_not_empty":
        conditions.push(sql`(${identifier} IS NOT NULL AND ${identifier}::text <> '')`);
        break;
      default:
        // `in` and `changed` are context-shaped, not column-shaped. Rather
        // than half-support them in SQL, they are refused here and remain
        // available on filter and branch steps, where they mean something.
        throw new EffectError(
          `The "${condition.operator}" test cannot be used when searching for ` +
            `records. Use it in a Filter or Branch step instead.`,
        );
    }
  }

  const match = step.where?.match === "any" ? sql` OR ` : sql` AND `;
  const whereExtra =
    conditions.length > 0 ? sql` AND (${sql.join(conditions, match)})` : sql``;
  const notDeleted = definition.softDelete ? sql` AND deleted_at IS NULL` : sql``;

  const columns = definition.readableColumns.map((column) => sql.identifier(column));

  const result = await args.tx.execute(sql`
    SELECT ${sql.join(columns, sql`, `)}
      FROM ${sql.identifier(definition.table)}
     WHERE tenant_id = ${args.tenantId}${notDeleted}${whereExtra}
     ORDER BY created_at DESC
     LIMIT ${limit}
  `);

  const records = allRows(result);

  return {
    input: { recordType: step.recordType, limit, conditions: conditions.length },
    output: {
      recordType: step.recordType,
      count: records.length,
      records,
      // ⚠️ Says so explicitly rather than leaving the author to compare
      // `count` with the limit they set. A loop that silently processed
      // the first 200 of 900 overdue milestones is the sort of thing that
      // is discovered a month later.
      truncated: records.length >= limit,
    },
  };
}

/* ------------------------------------------------------------------ */
/* SEND EMAIL                                                          */
/* ------------------------------------------------------------------ */

async function sendEmailEffect(args: EffectArgs): Promise<EffectOutcome> {
  const step = args.step as Extract<WorkflowStep, { action: "send_email" }>;
  authoriseActor(args.actor, "workflows:send_email");

  const to = interpolate(step.to, args.context).trim();
  const subject = interpolate(step.subject, args.context).trim();
  const body = interpolate(step.body ?? "", args.context);

  if (!isValidEmail(to)) {
    // ⚠️ REFUSED RATHER THAN SENT SOMEWHERE ELSE. An unresolved binding
    // interpolates to an empty string (see `bindings.ts`), and an engine
    // that "helpfully" fell back to the actor's own address would send a
    // customer's letter to a member of staff.
    throw new EffectError(
      `"${to || "(empty)"}" is not a valid email address. The recipient came ` +
        `from "${step.to}" — check that binding resolves on this record.`,
    );
  }

  const result = await sendEmail({
    to,
    subject: subject || "(no subject)",
    html: escapeHtml(body).replace(/\n/g, "<br />"),
    text: body,
    // ⚠️ IDEMPOTENCY KEYED ON THE RUN AND THE STEP.
    //
    // A resumed run must not re-send. The cursor is advanced before the
    // step is dispatched precisely so this cannot happen — but a retry at
    // the provider, or a worker restarting between the send and the
    // commit, would still produce a second message to a buyer. This is the
    // belt to that pair of braces.
    idempotencyKey: `${args.runId}:${step.key}`,
    logContext: { runId: args.runId, step: step.key },
  });

  if (!result.ok) {
    if (result.reason === "not_configured") {
      // Not an error worth failing a run over in an environment where
      // email was never set up — but it must be visible, not silent.
      return {
        input: { to, subject },
        output: { sent: false, reason: "email_not_configured", message: result.message },
      };
    }
    throw new EffectError(`The email could not be sent: ${result.message}`);
  }

  return {
    input: { to, subject },
    output: { sent: true, id: result.id, recipients: result.recipients },
  };
}

/* ------------------------------------------------------------------ */
/* HTTP REQUEST                                                        */
/* ------------------------------------------------------------------ */

/**
 * Call an external service.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE REMAINING GAP, STATED RATHER THAN GLOSSED OVER
 * ══════════════════════════════════════════════════════════════════════
 * `checkOutboundUrl` refuses private addresses, loopback, link-local and
 * the cloud metadata hostnames — see `lib/workflows/http-policy.ts` for
 * why each one matters. What it CANNOT stop is DNS rebinding:
 * `evil.example.com` resolves to a public address when the policy checks
 * it and to 169.254.169.254 when `fetch` connects a millisecond later.
 *
 * Closing that needs resolution and connection to happen together — a
 * custom HTTP agent that inspects the resolved peer address at socket
 * level and aborts. That is a real piece of work and it is not done here.
 * It is written down instead of assumed, because the failure mode of
 * assuming is that the next person reads this file, sees a URL policy,
 * and concludes the problem is handled.
 *
 * Mitigating in the meantime: the response is capped at 64KB and only its
 * status and a truncated body reach the run context, so a successful
 * rebind yields a slow and noisy exfiltration channel rather than a
 * silent one — and the deployment guide asks for IMDSv2, which requires a
 * PUT to obtain a token and so cannot be reached by a bare GET at all.
 */
async function httpRequest(args: EffectArgs): Promise<EffectOutcome> {
  const step = args.step as Extract<WorkflowStep, { action: "http_request" }>;
  authoriseActor(args.actor, "workflows:http_request");

  const url = interpolate(step.url, args.context).trim();

  // ⚠️ CHECKED AGAIN, ON THE RESOLVED URL. The validator checked the
  // template at publish time; a template containing `{{ }}` could not be
  // checked then, and a binding is exactly how somebody would smuggle a
  // host past a static check.
  const verdict = checkOutboundUrl(url);
  if (!verdict.allowed) {
    throw new EffectError(`${verdict.reason} ${verdict.remedy}`);
  }

  const { headers, refused } = filterHeaders(step.headers);
  if (refused.length > 0) {
    throw new EffectError(
      `These headers cannot be set by a workflow: ${refused.join(", ")}.`,
    );
  }

  const resolvedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    resolvedHeaders[key] = interpolate(value, args.context);
  }

  const body =
    step.method === "GET" || step.method === "DELETE"
      ? undefined
      : interpolate(step.body ?? "", args.context);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  try {
    const response = await fetch(verdict.url.toString(), {
      method: step.method,
      headers: resolvedHeaders,
      body,
      signal: controller.signal,
      // ⚠️ NO REDIRECTS. A 302 to http://169.254.169.254/ walks straight
      // through every check above, because the check ran on the URL the
      // author wrote and the redirect is chosen by the server they called.
      redirect: "manual",
    });

    const text = await readCapped(response);

    return {
      input: { method: step.method, url, headers: Object.keys(resolvedHeaders) },
      output: {
        status: response.status,
        ok: response.ok,
        // ⚠️ Not the parsed JSON. Handing a workflow author an arbitrary
        // object from a third party, which then gets written into records
        // by a later step, is how somebody else's API becomes a write
        // primitive against this workspace. A string is inert.
        body: text,
        truncated: text.length >= HTTP_MAX_RESPONSE_BYTES,
      },
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new EffectError(
        `The request to ${verdict.url.host} did not answer within ` +
          `${HTTP_TIMEOUT_MS / 1000} seconds and was abandoned. A run cannot wait ` +
          `on a slow endpoint — it holds a worker while it does.`,
      );
    }
    throw new EffectError(
      `The request to ${verdict.url.host} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;

  // ⚠️ Read incrementally rather than `await response.text()`. A hostile
  // or merely broken endpoint that streams gigabytes would otherwise be
  // buffered in full before anybody looked at the size.
  while (total < HTTP_MAX_RESPONSE_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  await reader.cancel().catch(() => {});

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk.subarray(0, Math.min(chunk.length, total - offset)), offset);
    offset += chunk.length;
    if (offset >= total) break;
  }

  return new TextDecoder().decode(merged).slice(0, HTTP_MAX_RESPONSE_BYTES);
}

/* ------------------------------------------------------------------ */
/* HELPERS                                                             */
/* ------------------------------------------------------------------ */

function requireRecordType(recordType: unknown) {
  const definition = recordTypeFor(recordType);
  if (!definition) {
    throw new EffectError(
      `"${String(recordType)}" is not a record type a workflow may touch. The ` +
        `list is deliberately short — it is what stops an automation writing to ` +
        `the audit log or the user table.`,
    );
  }
  return definition;
}

function requirePermissionFor(
  recordType: unknown,
  operation: "read" | "create" | "update" | "delete",
): string {
  const permission = permissionForRecordAction(recordType, operation);
  if (!permission) {
    throw new EffectError(
      `Automations cannot ${operation} that kind of record. See the notes in ` +
        `lib/workflows/records.ts for why each exclusion is there.`,
    );
  }
  return permission;
}

function resolveValues(
  values: Record<string, unknown> | undefined,
  context: RunContext,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    // ⚠️ `Object.hasOwn`-safe by construction: `Object.entries` only
    // yields own enumerable keys, so `__proto__` cannot arrive here as a
    // prototype reference. It could still arrive as a literal column name
    // — which the writable-column check then refuses.
    resolved[key] = resolveValue(value, context);
  }
  return resolved;
}

function pick(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) picked[key] = source[key];
  return picked;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireUuid(value: unknown, what: string): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!UUID_PATTERN.test(candidate)) {
    throw new EffectError(
      `${what} did not resolve to a record id. Got "${candidate || "(empty)"}" — ` +
        `check the binding.`,
    );
  }
  return candidate;
}

/**
 * Drizzle's `execute` returns different shapes depending on the driver —
 * an array for neon-http, `{ rows }` for the pooled client. Both are
 * handled, the same way `server/actions/sales-bookings.ts` does it.
 */
function allRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const candidate = result as { rows?: Record<string, unknown>[] };
  return candidate?.rows ?? [];
}

function firstRow(result: unknown): Record<string, unknown> | null {
  return allRows(result)[0] ?? null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
