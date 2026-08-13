/**
 * Ordence — ⭐⭐⭐ THE ENQUIRY BECOMES A LEAD, A TIMELINE ENTRY AND A TASK
 * Version: v1.13.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE ONE THING THAT MUST BE TRUE: NOTHING IS LOST SILENTLY
 * ══════════════════════════════════════════════════════════════════════
 * Every path through this file ends in a row somebody can see. A lead, or
 * a `lead_intake_failures` row that names the enquiry and says in words
 * what went wrong. There is no branch that returns quietly.
 *
 * ⚠️ THE CUSTOMER PAID FOR THAT ENQUIRY. IndiaMART charges for the
 * subscription that produced it; Meta charged for the click. An enquiry
 * dropped because a field was missing is money already spent and thrown
 * away, and the customer will never know it happened.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ AND IT IS IDEMPOTENT AT THE DATABASE, NOT IN THIS FILE
 * ══════════════════════════════════════════════════════════════════════
 * `ON CONFLICT DO NOTHING` against the unique index 0065 puts on
 * `(connection_id, external_id)`. A check-then-insert would race two
 * concurrent deliveries of the same retry, and IndiaMART retrying while
 * a poll is running is exactly that race.
 */

import "server-only";

import { and, eq, or, sql } from "drizzle-orm";
import { leads } from "@/db/schema/sales";
import { activities, tasks } from "@/db/schema/work";
import { connections } from "@/db/schema/integrations";
import { withGeneratedReference } from "@/server/sales/references";
import { redactPayloadObject } from "@/lib/billing/redact";
import {
  basisFromEnquiry,
  displayNameFor,
  planIntake,
} from "@/lib/integrations/intake";
import { findDuplicates, type Candidate } from "@/lib/crm/dedupe";
import type { AdapterOutcome, NormalisedEnquiry } from "@/lib/integrations/adapters/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

const IST = "Asia/Kolkata";

/**
 * 🔴 THE BUSINESS DAY IS ASIA/KOLKATA, NOT THE SERVER'S DAY.
 *
 * ⚠️ An enquiry at eleven at night is on that day for the person who has
 * to ring back. Deriving the civil day from a UTC timestamp puts a task
 * due at half past midnight IST onto the previous day, every evening,
 * for four and a half hours.
 */
function istDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: IST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** How long an unfiled enquiry is kept before the purge job removes it. */
export const INTAKE_FAILURE_RETENTION_DAYS = 180;

export interface IntakeContext {
  readonly tx: Tx;
  readonly tenantId: string;
  readonly connectionId: string;
  readonly connectorLabel: string;
  readonly deliveryId?: string | null;
  readonly runId?: string | null;
  readonly now: Date;
}

export type IntakeResult =
  | { readonly outcome: "created"; readonly leadId: string; readonly reference: string; readonly duplicateOfExisting: boolean }
  /** ⭐ The same event, delivered again. Correct, and not an error. */
  | { readonly outcome: "duplicate"; readonly externalId: string }
  | { readonly outcome: "failed"; readonly reasonCode: string; readonly reason: string };

/* ------------------------------------------------------------------ */
/* THE MAIN PATH                                                       */
/* ------------------------------------------------------------------ */

export async function ingestEnquiry(
  ctx: IntakeContext,
  parsed: AdapterOutcome,
  rawPayload: unknown,
): Promise<IntakeResult> {
  // ① The adapter already refused it. Record it and say why, in words.
  if (!parsed.ok) {
    await recordFailure(ctx, parsed.reasonCode, parsed.reason, parsed.externalId, rawPayload);
    return { outcome: "failed", reasonCode: parsed.reasonCode, reason: parsed.reason };
  }

  const enquiry = parsed.enquiry;

  const [connection] = await ctx.tx
    .select({
      leadSourceId: connections.leadSourceId,
      stageId: connections.intakeStageId,
      ownerId: connections.intakeOwnerId,
      createsTask: connections.intakeCreatesTask,
      dueMinutes: connections.intakeTaskDueMinutes,
    })
    .from(connections)
    .where(
      and(
        eq(connections.tenantId, ctx.tenantId),
        eq(connections.id, ctx.connectionId),
      ),
    )
    .limit(1);

  const plan = planIntake(enquiry, ctx.now, {
    dueMinutes: connection?.dueMinutes ?? undefined,
    connectorLabel: ctx.connectorLabel,
    istDay,
  });

  const basis = basisFromEnquiry(enquiry);

  /**
   * ⭐ THE DUPLICATE CHECK RUNS BEFORE THE INSERT AND DOES NOT BLOCK IT.
   *
   * 🔴 THESE ARE TWO DIFFERENT QUESTIONS AND 0065 SAYS SO. `external_id`
   * asks "is this the same EVENT" and the answer refuses the row.
   * `phone_digits` asks "is this the same PERSON" and the answer is shown
   * to a salesman, never enforced — a genuine second enquiry six months
   * later is real business, and refusing it teaches people to type fake
   * numbers.
   */
  const duplicates = await findPersonDuplicates(ctx, enquiry);

  const created = await withGeneratedReference(
    ctx.tx,
    "lead",
    async (reference: string) => {
      const rows = await ctx.tx
        .insert(leads)
        .values({
          tenantId: ctx.tenantId,
          reference,
          name: displayNameFor(enquiry),
          email: enquiry.email,
          phone: enquiry.phone ?? enquiry.altPhone,
          // ⚠️ `portal` is the existing enum value for a marketplace.
          // A new enum value would need a migration on a type half the
          // reports group by, for no gain: `connection_id` already says
          // exactly which portal, which is the question people ask.
          source: "portal" as const,
          status: "new" as const,
          leadSourceId: connection?.leadSourceId ?? null,
          stageId: connection?.stageId ?? null,
          ownerId: connection?.ownerId ?? null,
          connectionId: ctx.connectionId,
          externalId: enquiry.externalId,
          intakeDeliveryId: ctx.deliveryId ?? null,
          intakeRunId: ctx.runId ?? null,
          intakePayload: safePayload(rawPayload),
          interestLabel: enquiry.interestLabel,
          requirement: enquiry.message,
          country: enquiry.countryIso,
          locality: enquiry.city,
          // ⭐ THE NARROW BASIS, AND NOTHING WIDER. They asked to be
          // contacted about THIS. It is not a marketing list.
          consentAt: ctx.now,
          consentSource: `${ctx.connectorLabel}:${basis.purpose}`,
        })
        // 🔴 IDEMPOTENT AT THE DATABASE. A check-then-insert races the
        // retry that arrives while a poll is already running.
        .onConflictDoNothing()
        .returning({ id: leads.id, reference: leads.reference });

      const row = rows[0] as { id: string; reference: string } | undefined;
      return row ?? null;
    },
  );

  // ② The unique index refused it: we have had this event before.
  if (!created) {
    return { outcome: "duplicate", externalId: enquiry.externalId };
  }

  // ③ The timeline entry. Append-only, and marked as machine-made.
  await ctx.tx.insert(activities).values({
    tenantId: ctx.tenantId,
    subjectType: "lead",
    subjectId: created.id,
    subjectLabel: created.reference,
    kind: plan.activityKind,
    occurredAt: enquiry.occurredAt ?? ctx.now,
    direction: "in",
    summary: plan.activitySummary,
    body: enquiry.message,
    // ⚠️ `integration`, which 0060's guard makes uneditable and
    // undeletable. A machine-made record of what a buyer said is not
    // something a salesman may quietly tidy up.
    source: "integration",
    sourceName: ctx.connectorLabel,
    externalRef: enquiry.externalId,
  });

  // ④ 🔴 AND THE PART THAT MAKES ANY OF IT MATTER.
  if (connection?.createsTask !== false) {
    await ctx.tx.insert(tasks).values({
      tenantId: ctx.tenantId,
      title: plan.title,
      detail: plan.detail,
      subjectType: "lead",
      subjectId: created.id,
      subjectLabel: created.reference,
      assignedTo: connection?.ownerId ?? null,
      dueOn: plan.dueOn,
      dueAt: plan.dueAt,
      priority: plan.priority,
      status: "open",
    });
  }

  return {
    outcome: "created",
    leadId: created.id,
    reference: created.reference,
    duplicateOfExisting: duplicates.length > 0,
  };
}

/* ------------------------------------------------------------------ */
/* THE SAME PERSON, ENQUIRING AGAIN                                    */
/* ------------------------------------------------------------------ */

async function findPersonDuplicates(
  ctx: IntakeContext,
  enquiry: NormalisedEnquiry,
): Promise<readonly { id: string }[]> {
  const phoneDigits = (enquiry.phone ?? enquiry.altPhone ?? "")
    .replace(/\D/g, "")
    .slice(-10);
  const emailKey = (enquiry.email ?? "").trim().toLowerCase();

  if (!phoneDigits && !emailKey) return [];

  /**
   * ⭐ MATCHED ON THE GENERATED COLUMNS 0061 ADDED, so the database does
   * the normalising and the answer cannot disagree with `lib/crm/dedupe`.
   *
   * ⚠️ The same man arriving as `+91 98765 43210`, `098765 43210` and
   * `9876543210` is three leads and three salesmen ringing him in one
   * afternoon, which is how a business loses an order by trying too hard.
   */
  const existing = await ctx.tx
    .select({
      id: leads.id,
      name: leads.name,
      phone: leads.phone,
      email: leads.email,
    })
    .from(leads)
    .where(
      and(
        eq(leads.tenantId, ctx.tenantId),
        or(
          phoneDigits ? eq(sql`${leads.phoneDigits}`, phoneDigits) : sql`false`,
          emailKey ? eq(sql`${leads.emailKey}`, emailKey) : sql`false`,
        ),
      ),
    )
    .limit(20);

  const candidates = existing as Candidate[];
  if (candidates.length === 0) return [];

  return findDuplicates({
    incoming: {
      id: "incoming",
      name: enquiry.name,
      phone: enquiry.phone ?? enquiry.altPhone,
      email: enquiry.email,
    },
    existing: candidates,
  }).map((m) => ({ id: m.id }));
}

/* ------------------------------------------------------------------ */
/* THE ENQUIRY NOBODY COULD FILE                                       */
/* ------------------------------------------------------------------ */

/**
 * 🔴 THE ROW THAT MEANS SOMEBODY ENQUIRED AND NEVER GOT A CALL.
 *
 * ⚠️ Deliberately not written to `webhook_deliveries`. That table
 * answers "did the bytes arrive", which is a developer's question. This
 * one answers "did a person get lost", which is the owner's, and the two
 * screens have different readers.
 */
export async function recordFailure(
  ctx: IntakeContext,
  reasonCode: string,
  reason: string,
  externalId: string | null,
  rawPayload: unknown,
): Promise<void> {
  const purgeAfter = new Date(
    ctx.now.getTime() + INTAKE_FAILURE_RETENTION_DAYS * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);

  await ctx.tx.execute(sql`
    INSERT INTO lead_intake_failures
      (tenant_id, connection_id, delivery_id, run_id, external_id,
       occurred_at, reason, reason_code, payload, purge_after)
    VALUES (
      ${ctx.tenantId}::uuid,
      ${ctx.connectionId}::uuid,
      ${ctx.deliveryId ?? null},
      ${ctx.runId ?? null},
      ${externalId},
      ${ctx.now.toISOString()}::timestamptz,
      ${reason.slice(0, 500)},
      ${reasonCode},
      ${JSON.stringify(safePayload(rawPayload) ?? {})}::jsonb,
      ${purgeAfter}::date
    )
  `);
}

/**
 * ⚠️ REDACTED BEFORE IT IS STORED, using the same pass the payment
 * webhooks have used since v0.11.0. A buyer's enquiry is personal data
 * and this column is in every backup.
 */
function safePayload(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  try {
    return redactPayloadObject(raw);
  } catch {
    return null;
  }
}
