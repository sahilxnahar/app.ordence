"use server";

/**
 * Ordence — ⭐ ENGINE 4 · COMPLIANCE READ ACTIONS
 * Version: v0.68.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION. A `"use server"` file that
 * exports anything else — a constant, a type helper, a plain object —
 * publishes it as an RPC endpoint reachable by anyone on the internet.
 * The two small helpers this file needs are therefore defined below and
 * NOT exported.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE READS, AND WHAT IT DELIBERATELY DOES NOT DECIDE
 * ══════════════════════════════════════════════════════════════════════
 * Due dates, late-fee arithmetic, the day-31 clamp and the transition to
 * `missed` are all triggers in SQL-FILES/0032. Nothing here recomputes
 * any of it.
 *
 * ⚠️ THAT IS NOT TIDINESS, IT IS THE WHOLE POINT. A compliance register
 * gets loaded by bulk import far more often than it gets typed, and the
 * import does not come through a server action. A due date computed here
 * would be correct on the screen and absent everywhere else.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE ONE NULLABLE COLUMN THAT MAKES THIS ENGINE WORK
 * ══════════════════════════════════════════════════════════════════════
 * `subject_company_id` NULL means "this is MY obligation". Set, it means
 * "this is a CLIENT's obligation that I file on their behalf". A CA firm
 * and its four hundred clients share one engine, one reminder ladder and
 * one late-fee calculation — and the two readings never diverge on a bug
 * fix, because there is only one of everything.
 *
 * So the list below reports both, separately, without a second query
 * shape.
 */

import { and, asc, desc, eq, isNull, isNotNull, lte, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import {
  complianceObligations,
  complianceTasks,
  complianceEvidence,
  complianceLicences,
} from "@/db/schema/compliance";
import { companies } from "@/db/schema/crm";
import { requirePermission, writeAudit } from "@/server/audit";
import { guardSalesWrite, toSalesActionError } from "@/server/sales/guards";
import type { ActionResult } from "@/lib/validators/crm";

/**
 * ⚠️ EXACTLY THESE TWO STRINGS. They are the keys in
 * lib/modules/registry.ts and lib/entitlements/features.ts. The calendar
 * and the licence register are billed and gated SEPARATELY — a tenant may
 * hold one and not the other — so a write must be gated against the
 * feature its own table belongs to, not against "compliance" in general.
 */
const CALENDAR_FEATURE = "compliance.calendar" as const;
const LICENCE_FEATURE = "compliance.licences" as const;

const CALENDAR_WRITE = "compliance.calendar.manage";
const LICENCE_WRITE = "compliance.licences.manage";

/* ------------------------------------------------------------------ */
/* SHAPES                                                              */
/* ------------------------------------------------------------------ */

export type ComplianceTaskRow = {
  id: string;
  obligationId: string;
  obligationName: string;
  authority: string;
  frequency: string;
  /** NULL = the tenant's own obligation. Set = a client's. */
  subjectCompanyId: string | null;
  periodLabel: string;
  dueDate: string | null;
  status: string;
  severity: string;
  /** ⚠️ Derived by trigger. Never computed on this side. */
  daysLate: number;
  /** Paise, as a STRING — JSON.stringify throws on a bigint. */
  lateFeeMinor: string;
  filingReference: string | null;
  ownerUserId: string | null;
  /** Negative = overdue. Computed for display ordering only. */
  daysUntilDue: number | null;
};

export type ComplianceLicenceRow = {
  id: string;
  name: string;
  authority: string;
  licenceNumber: string | null;
  subjectCompanyId: string | null;
  validUntil: string | null;
  renewalLeadDays: number;
  status: string;
  severity: string;
  renewalFeeMinor: string;
  /** Negative = already expired. */
  daysUntilExpiry: number | null;
  /** ⭐ Inside the renewal window and not yet being renewed. */
  isRenewalDue: boolean;
};

/* ------------------------------------------------------------------ */
/* HELPERS — deliberately NOT exported. See the header.                */
/* ------------------------------------------------------------------ */

function daysBetweenToday(iso: string | null): number | null {
  if (!iso) return null;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const target = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(target.getTime())) return null;
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

/**
 * ⚠️ MONEY CROSSES THE SERVER/CLIENT BOUNDARY AS A STRING.
 * `JSON.stringify` throws outright on a bigint, and the failure surfaces
 * as an opaque serialisation error a long way from the column that
 * caused it.
 */
function minor(v: bigint | number | string | null | undefined): string {
  if (v === null || v === undefined) return "0";
  return String(v);
}

/* ------------------------------------------------------------------ */
/* THE COMPLIANCE BOARD                                                */
/* ------------------------------------------------------------------ */

/**
 * ⭐ Everything due, everything late, and what the lateness costs.
 *
 * ⚠️ `missed` TASKS ARE RETURNED, NOT FILTERED OUT. A register you can
 * tidy is a register no inspector will accept, and a screen that hides
 * the missed rows is the same thing with extra steps. They are separated
 * out so they lead the page rather than sitting eleventh in a list.
 */
export async function listComplianceBoard(): Promise<
  ActionResult<{
    tasks: ComplianceTaskRow[];
    /** Missed deadlines. These lead the screen. */
    missed: ComplianceTaskRow[];
    /** Due within the next 14 days and not yet filed. */
    dueSoon: ComplianceTaskRow[];
    /** ⭐ Own obligations vs those filed on behalf of clients. */
    ownCount: number;
    clientCount: number;
    /** Total exposure in paise, as a string. */
    lateFeeExposureMinor: string;
    /** Obligations configured but with no task ever generated. */
    obligationsWithoutTasks: Array<{ id: string; name: string; frequency: string }>;
    activeObligations: number;
  }>
> {
  try {
    const ctx = await requirePermission("compliance.calendar.read");

    const payload = await withTenant(ctx.tenant.id, async (tx) => {
      const rows = await tx
        .select({
          id: complianceTasks.id,
          obligationId: complianceTasks.obligationId,
          subjectCompanyId: complianceTasks.subjectCompanyId,
          periodLabel: complianceTasks.periodLabel,
          dueDate: complianceTasks.dueDate,
          status: complianceTasks.status,
          severity: complianceTasks.severity,
          daysLate: complianceTasks.daysLate,
          lateFeeMinor: complianceTasks.lateFeeMinor,
          filingReference: complianceTasks.filingReference,
          ownerUserId: complianceTasks.ownerUserId,
          obligationName: complianceObligations.name,
          authority: complianceObligations.authority,
          frequency: complianceObligations.frequency,
        })
        .from(complianceTasks)
        .innerJoin(
          complianceObligations,
          and(
            eq(complianceObligations.id, complianceTasks.obligationId),
            eq(complianceObligations.tenantId, complianceTasks.tenantId),
          ),
        )
        .where(eq(complianceTasks.tenantId, ctx.tenant.id))
        .orderBy(asc(complianceTasks.dueDate))
        .limit(1000);

      const obligations = await tx
        .select({
          id: complianceObligations.id,
          name: complianceObligations.name,
          frequency: complianceObligations.frequency,
          isActive: complianceObligations.isActive,
        })
        .from(complianceObligations)
        .where(
          and(
            eq(complianceObligations.tenantId, ctx.tenant.id),
            isNull(complianceObligations.deletedAt),
          ),
        );

      return { rows, obligations };
    });

    const tasks: ComplianceTaskRow[] = payload.rows.map((r) => ({
      id: r.id,
      obligationId: r.obligationId,
      obligationName: r.obligationName,
      authority: r.authority,
      frequency: r.frequency,
      subjectCompanyId: r.subjectCompanyId,
      periodLabel: r.periodLabel,
      dueDate: r.dueDate,
      status: r.status,
      severity: r.severity,
      daysLate: r.daysLate ?? 0,
      lateFeeMinor: minor(r.lateFeeMinor),
      filingReference: r.filingReference,
      ownerUserId: r.ownerUserId,
      daysUntilDue: daysBetweenToday(r.dueDate),
    }));

    /**
     * ⚠️ `not_applicable` AND `waived` ARE NOT "DONE", AND NOT "OPEN".
     * They are a stated decision that this obligation did not apply this
     * period — which is a different thing from having filed it, and a
     * different thing from having ignored it. Folding them into either
     * bucket loses the only record that somebody made that call.
     */
    const settled = new Set(["filed", "late_filed", "not_applicable", "waived"]);
    const open = tasks.filter((t) => !settled.has(t.status));

    const missed = tasks.filter((t) => t.status === "missed");
    const dueSoon = open
      .filter(
        (t) =>
          t.status !== "missed" &&
          t.daysUntilDue !== null &&
          t.daysUntilDue >= 0 &&
          t.daysUntilDue <= 14,
      )
      .sort((a, b) => (a.daysUntilDue ?? 0) - (b.daysUntilDue ?? 0));

    const withTasks = new Set(tasks.map((t) => t.obligationId));

    return {
      ok: true,
      data: {
        tasks,
        missed,
        dueSoon,
        ownCount: tasks.filter((t) => t.subjectCompanyId === null).length,
        clientCount: tasks.filter((t) => t.subjectCompanyId !== null).length,
        lateFeeExposureMinor: String(
          tasks.reduce((acc, t) => acc + BigInt(t.lateFeeMinor || "0"), 0n),
        ),
        /**
         * ⭐ AN OBLIGATION WITH NO TASK IS THE QUIET FAILURE.
         *
         * ⚠️ It looks like compliance — the obligation is configured, it
         * appears in the register, somebody ticked a box during setup.
         * But nothing was ever generated from it, so nothing is due,
         * nothing is late, and nothing will ever be reported. A register
         * whose alarms cannot fire is worse than no register, because it
         * is trusted.
         */
        obligationsWithoutTasks: payload.obligations
          .filter((o) => o.isActive && !withTasks.has(o.id))
          .map((o) => ({ id: o.id, name: o.name, frequency: o.frequency })),
        activeObligations: payload.obligations.filter((o) => o.isActive).length,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "The compliance register could not be read.",
    };
  }
}

/* ------------------------------------------------------------------ */
/* LICENCES                                                            */
/* ------------------------------------------------------------------ */

/**
 * ⭐ Permissions that expire, and the window before they do.
 *
 * ⚠️ A LICENCE IS NOT A DEADLINE, AND THAT IS WHY IT IS A SEPARATE
 * TABLE AND A SEPARATE SCREEN. Missing a filing costs a late fee, and
 * the fee is usually knowable in advance. An expired factory licence,
 * fire NOC or drug licence STOPS THE BUSINESS — the premises cannot
 * lawfully operate, and the renewal itself takes weeks. The cost is not
 * a fee, it is the shutdown, and it lands before anyone can react.
 *
 * So the renewal LEAD time is the number that matters, not the expiry
 * date. `renewal_lead_days` is per licence because a fire NOC and a
 * shops-and-establishment registration take wildly different amounts of
 * time to renew.
 */
export async function listComplianceLicences(): Promise<
  ActionResult<{
    licences: ComplianceLicenceRow[];
    /** ⭐ Already expired. The business may be operating unlawfully now. */
    expired: ComplianceLicenceRow[];
    /** Inside the renewal window and nobody has started. */
    renewalDue: ComplianceLicenceRow[];
    renewalFeeDueMinor: string;
  }>
> {
  try {
    const ctx = await requirePermission("compliance.licences.read");

    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select()
        .from(complianceLicences)
        .where(
          and(
            eq(complianceLicences.tenantId, ctx.tenant.id),
            isNull(complianceLicences.deletedAt),
          ),
        )
        .orderBy(asc(complianceLicences.validUntil))
        .limit(1000),
    );

    const licences: ComplianceLicenceRow[] = rows.map((l) => {
      const daysUntilExpiry = daysBetweenToday(l.validUntil);
      const lead = l.renewalLeadDays ?? 30;
      return {
        id: l.id,
        name: l.name,
        authority: l.authority,
        licenceNumber: l.licenceNumber,
        subjectCompanyId: l.subjectCompanyId,
        validUntil: l.validUntil,
        renewalLeadDays: lead,
        status: l.status,
        severity: l.severity,
        renewalFeeMinor: minor(l.renewalFeeMinor),
        daysUntilExpiry,
        /**
         * ⚠️ COMPUTED HERE FROM THE LEAD TIME, NOT READ FROM `status`.
         *
         * `status` is what somebody last set by hand. The renewal window
         * is a fact about today and the expiry date, and it opens whether
         * or not anyone remembered to change a dropdown. Trusting the
         * status column would mean a licence silently stops warning the
         * moment somebody clicks the wrong option.
         */
        isRenewalDue:
          daysUntilExpiry !== null &&
          daysUntilExpiry >= 0 &&
          daysUntilExpiry <= lead &&
          l.status !== "under_renewal" &&
          l.status !== "not_required",
      };
    });

    const expired = licences.filter(
      (l) =>
        l.status !== "not_required" &&
        l.status !== "cancelled" &&
        l.daysUntilExpiry !== null &&
        l.daysUntilExpiry < 0,
    );
    const renewalDue = licences.filter((l) => l.isRenewalDue);

    return {
      ok: true,
      data: {
        licences,
        expired,
        renewalDue,
        renewalFeeDueMinor: String(
          [...expired, ...renewalDue].reduce(
            (acc, l) => acc + BigInt(l.renewalFeeMinor || "0"),
            0n,
          ),
        ),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "The licence register could not be read.",
    };
  }
}

/* ------------------------------------------------------------------ */
/* FORM OPTIONS                                                        */
/* ------------------------------------------------------------------ */

export type ComplianceObligationOption = {
  id: string;
  code: string;
  name: string;
  authority: string;
  frequency: string;
  severity: string;
  /** NULL = the tenant's own obligation. Set = a client's. */
  subjectCompanyId: string | null;
  isActive: boolean;
  dueMonthOffset: number;
  dueDayOfMonth: number;
  /** Paise, as a STRING. See `minor()`. */
  lateFeePerDayMinor: string;
  /** NULL means UNCAPPED, which is not the same as zero. */
  lateFeeCapMinor: string | null;
  reminderLeadDays: number;
};

/**
 * ⭐ What the write forms need in order to ask the one question that
 * matters: WHOSE obligation is this?
 *
 * ⚠️ THE COMPANY LIST IS RETURNED EVEN WHEN IT IS EMPTY, and the forms
 * still make the choice explicit. A subject picker that quietly defaults
 * to "mine" because there are no clients yet trains the operator to skip
 * the field — and then the first client obligation gets filed under the
 * practice's own name, where it will be counted in the wrong bucket on
 * the board and chased by the wrong person.
 */
export async function listComplianceOptions(): Promise<
  ActionResult<{
    obligations: ComplianceObligationOption[];
    /** Client companies this tenant may file on behalf of. */
    companies: Array<{ id: string; name: string }>;
  }>
> {
  try {
    const ctx = await requirePermission("compliance.calendar.read");

    const payload = await withTenant(ctx.tenant.id, async (tx) => {
      const obligations = await tx
        .select()
        .from(complianceObligations)
        .where(
          and(
            eq(complianceObligations.tenantId, ctx.tenant.id),
            isNull(complianceObligations.deletedAt),
          ),
        )
        .orderBy(asc(complianceObligations.name))
        .limit(1000);

      const companyRows = await tx
        .select({ id: companies.id, name: companies.name })
        .from(companies)
        .where(
          and(eq(companies.tenantId, ctx.tenant.id), isNull(companies.deletedAt)),
        )
        .orderBy(asc(companies.name))
        .limit(1000);

      return { obligations, companyRows };
    });

    return {
      ok: true,
      data: {
        obligations: payload.obligations.map((o) => ({
          id: o.id,
          code: o.code,
          name: o.name,
          authority: o.authority,
          frequency: o.frequency,
          severity: o.severity,
          subjectCompanyId: o.subjectCompanyId,
          isActive: o.isActive,
          dueMonthOffset: o.dueMonthOffset,
          dueDayOfMonth: o.dueDayOfMonth,
          lateFeePerDayMinor: minor(o.lateFeePerDayMinor),
          /**
           * ⚠️ NULL IS NOT ZERO HERE. A NULL cap means the late fee runs
           * for ever; zero would mean it is capped at nothing. Flattening
           * the two on the way out would show an uncapped GST late fee as
           * "capped at ₹0.00" — the most reassuring possible rendering of
           * the most expensive possible case.
           */
          lateFeeCapMinor:
            o.lateFeeCapMinor === null ? null : String(o.lateFeeCapMinor),
          reminderLeadDays: o.reminderLeadDays,
        })),
        companies: payload.companyRows,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "The compliance options could not be read.",
    };
  }
}

/* ------------------------------------------------------------------ */
/* WRITE HELPERS — deliberately NOT exported. See the header.          */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE SUBJECT IS A CHOICE, NEVER A DEFAULT.
 *
 * ⚠️ `subject_company_id` NULL means "this is MINE"; set means "this is a
 * CLIENT's, which I file on their behalf". Both are legitimate and they
 * look identical in a form — which is why the form sends a MODE, not an
 * optional id. An optional id means a blank select silently records the
 * obligation as the practice's own.
 *
 * The specific failure this prevents: a CA firm that files four hundred
 * client returns on time and misses its own ROC filing, because its own
 * four obligations were sitting in a list of six hundred labelled the
 * same way. The board splits "yours" from "your clients'" off this exact
 * column, and it can only do that if somebody stated which it was.
 */
const subjectSchema = z
  .object({
    subjectMode: z.enum(["own", "client"], {
      errorMap: () => ({
        message: "Say whose obligation this is — yours, or a client's.",
      }),
    }),
    subjectCompanyId: z.string().uuid().optional().nullable(),
  })
  .refine((d) => d.subjectMode === "own" || !!d.subjectCompanyId, {
    message: "Choose the client this obligation belongs to.",
    path: ["subjectCompanyId"],
  });

/** Resolve the mode + id pair down to the single nullable column. */
function subjectColumn(d: {
  subjectMode: "own" | "client";
  subjectCompanyId?: string | null;
}): string | null {
  // ⚠️ "own" FORCES NULL rather than trusting whatever id came along.
  // A stale hidden field from a half-edited form would otherwise file the
  // practice's own return under a client.
  return d.subjectMode === "client" ? (d.subjectCompanyId ?? null) : null;
}

const moneySchema = z
  .string()
  .trim()
  .regex(/^\d{1,19}$/, "Enter a whole amount in paise, digits only.")
  .transform((v) => BigInt(v));

/** An ISO date string, as `date` columns come back from Drizzle. */
const daySchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-07-01.");

const optionalDay = z
  .union([daySchema, z.literal(""), z.null()])
  .optional()
  .transform((v) => (v ? v : null));

const AUTHORITIES = [
  "gst", "income_tax", "mca_roc", "epfo", "esic", "labour",
  "professional_tax", "customs", "rbi", "sebi", "fssai",
  "pollution_control", "fire", "municipal", "transport_rto",
  "electricity_cea", "health_nmc", "drugs_licensing", "aerb",
  "state_excise", "legal_metrology", "internal", "other",
] as const;

const SEVERITIES = ["informational", "low", "medium", "high", "critical"] as const;

const FREQUENCIES = [
  "monthly", "quarterly", "half_yearly", "annual", "one_time", "event_based",
] as const;

/** Add whole months to an ISO day, in UTC. */
function addMonths(iso: string, months: number): Date {
  const d = new Date(`${iso}T00:00:00.000Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  // Clamp to the target month's real length — the same reasoning as the
  // day-31 clamp in the trigger, applied to the PERIOD rather than to the
  // due date. See `periodFor` below.
  const lastDay = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

function monthLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  return `${MONTHS[d.getUTCMonth()] ?? "?"} ${d.getUTCFullYear()}`;
}

/** How many months one period of this frequency spans. */
function monthsPerPeriod(frequency: string): number {
  if (frequency === "monthly") return 1;
  if (frequency === "quarterly") return 3;
  if (frequency === "half_yearly") return 6;
  if (frequency === "annual") return 12;
  return 0; // one_time, event_based — a single period with no recurrence.
}

/**
 * ⭐ THE FORM COLLECTS THE PERIOD. IT NEVER COLLECTS THE DUE DATE.
 *
 * ⚠️ GSTR-3B FOR JULY IS DUE ON 20 AUGUST — not "twenty days after
 * somebody created the row", and not whatever a person typed while
 * looking at a different month. The obligation carries the RULE
 * (`due_month_offset`, `due_day_of_month`) and the task carries the
 * PERIOD; `compliance_derive_due_date()` in SQL 0032 computes the date
 * from the two on every INSERT and on every UPDATE of `period_end`.
 *
 * ⚠️ AND THE TRIGGER CLAMPS DAY 31 TO THE MONTH'S REAL LAST DAY.
 *
 * Storing 31 to mean "the last day of the month" is the natural thing to
 * do, and typed by hand it is wrong in February, in April, in June, in
 * September and in November. The clamp is what makes "31" read as "the
 * last day" correctly everywhere, without a separate flag somebody has to
 * remember to tick. Recomputing any of it here would produce a second
 * answer that is right on this screen and absent from the bulk import,
 * the back-fill and the nightly generator — which is how a register ends
 * up with two due dates for one filing and no way to tell which was used.
 */
function periodFor(
  frequency: string,
  startIso: string,
  index: number,
): { periodStart: string; periodEnd: string; periodLabel: string } {
  const span = monthsPerPeriod(frequency);

  if (span === 0) {
    // ⚠️ `one_time` and `event_based` do not recur, so index is ignored:
    // a "generate 12 periods" click on an event-based obligation must not
    // manufacture eleven deadlines that no event ever triggered.
    return {
      periodStart: startIso,
      periodEnd: startIso,
      periodLabel: startIso,
    };
  }

  const start = addMonths(startIso, span * index);
  const endExclusive = addMonths(isoDay(start), span);
  const end = new Date(endExclusive.getTime() - 86_400_000);

  const startLabel = monthLabel(isoDay(start));
  const endLabel = monthLabel(isoDay(end));

  return {
    periodStart: isoDay(start),
    periodEnd: isoDay(end),
    periodLabel: span === 1 ? startLabel : `${startLabel} – ${endLabel}`,
  };
}

/**
 * ⭐ TURN THE DATABASE'S REFUSAL INTO A SENTENCE SOMEBODY CAN ACT ON.
 *
 * ⚠️ Every rule that matters in this engine is a trigger, by design — see
 * the file header. That makes the quality of the refusal the quality of
 * the feature. The trigger messages in SQL 0032 are already written for a
 * person ("Cannot mark "Jul 2026" as filed without a filing reference"),
 * so they are surfaced verbatim; paraphrasing them here would throw away
 * the only part that says what to do next.
 */
function explainComplianceError(err: unknown): string | null {
  const message =
    err && typeof err === "object" && "message" in err
      ? String((err as { message: unknown }).message)
      : "";
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code: unknown }).code)
      : "";

  if (/without a filing reference/.test(message)) return message;
  if (/requires a written reason/.test(message)) return message;
  if (/cannot be deleted/.test(message)) return message;
  if (/never deleted/.test(message)) return message;
  if (/content hash of filed evidence/.test(message)) return message;
  if (/repointed at a different document/.test(message)) return message;
  if (/does not exist in this workspace/.test(message)) return message;

  if (code === "23505" && /compliance_tasks_obligation_period_key/.test(message)) {
    return (
      "A deadline already exists for that obligation and period. " +
      "The generator is deliberately idempotent — one task per obligation " +
      "per period — because a board showing every filing twice is a board " +
      "people stop trusting within a week."
    );
  }
  if (code === "23505" && /compliance_obligations_(own|client)_code_key/.test(message)) {
    return (
      "An obligation with that code already exists for this subject. " +
      "Codes are the stable machine key — edit the existing obligation " +
      "rather than adding a second one under the same code."
    );
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* WRITE — OBLIGATIONS (the rule that generates deadlines)             */
/* ------------------------------------------------------------------ */

const obligationSchema = z
  .object({
    id: z.string().uuid().optional(),
    code: z
      .string()
      .trim()
      .min(1, "Give the obligation a stable code, e.g. gst.gstr3b.")
      .max(100),
    name: z.string().trim().min(1, "Name the obligation.").max(300),
    description: z.string().trim().max(5000).optional().nullable(),
    authority: z.enum(AUTHORITIES),
    frequency: z.enum(FREQUENCIES),
    severity: z.enum(SEVERITIES).default("medium"),

    /**
     * ⭐ THE DUE-DATE RULE, NOT A DUE DATE.
     *
     * ⚠️ ZERO IS A LEGITIMATE OFFSET and must not be treated as "unset":
     * advance tax falls due WITHIN the period it relates to. A schema that
     * coerced 0 to the default of 1 would silently push every advance-tax
     * deadline a month late, on the one obligation where being late is
     * charged as interest rather than as a flat fee.
     */
    dueMonthOffset: z.coerce
      .number()
      .int()
      .min(0, "Zero months is allowed — some things fall due inside the period.")
      .max(24)
      .default(1),
    /**
     * ⭐ 31 MEANS "THE LAST DAY", AND THE DATABASE MAKES THAT TRUE.
     *
     * The trigger clamps it to the target month's real length, so this
     * needs no companion flag and February needs no special case.
     */
    dueDayOfMonth: z.coerce.number().int().min(1).max(31).default(20),

    lateFeePerDayMinor: moneySchema.optional().nullable(),
    /**
     * ⚠️ BLANK MEANS UNCAPPED, AND IT IS STORED AS NULL — not as 0.
     * Zero would cap the fee at nothing, which reads on the board as a
     * missed filing that costs nothing at all.
     */
    lateFeeCapMinor: z
      .union([moneySchema, z.literal(""), z.null()])
      .optional()
      .transform((v) => (typeof v === "bigint" ? v : null)),
    interestRateBps: z.coerce.number().int().min(0).max(100_000).default(0),
    penaltyNote: z.string().trim().max(2000).optional().nullable(),
    legalReference: z.string().trim().max(300).optional().nullable(),

    /**
     * ⭐ APPLICABILITY IS A DECISION SOMEBODY MAKES, NOT AN INFERENCE.
     *
     * ⚠️ Deriving it from turnover or from the presence of a registration
     * is wrong often enough to be dangerous: a tenant switched off by a
     * rule nobody remembers writing has no idea they have stopped filing.
     * The conditions go in `applicabilityNote` for a human to read.
     */
    isActive: z.coerce.boolean().default(true),
    applicabilityNote: z.string().trim().max(2000).optional().nullable(),
    effectiveFrom: optionalDay,
    effectiveTo: optionalDay,
    reminderLeadDays: z.coerce.number().int().min(0).max(365).default(7),
  })
  .and(subjectSchema);

/**
 * ⭐ Create or amend the RULE. This does not create a deadline — see
 * `generateComplianceTasks`.
 *
 * ⚠️ AN OBLIGATION THAT GENERATES NOTHING IS THE WORST STATE IN THIS
 * ENGINE, and saving one is the easiest way to reach it. It is configured,
 * it appears in the register, somebody ticked a box during setup — and
 * nothing is due, so nothing is late, so nothing is ever reported. The
 * board calls that out in its own panel; this action's job is simply to
 * not pretend the rule and the deadline are the same act.
 */
export async function saveComplianceObligation(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const data = obligationSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "compliance:obligation:save",
      feature: CALENDAR_FEATURE,
      permission: CALENDAR_WRITE,
      resource: data.id ? { type: "compliance_obligation", id: data.id } : undefined,
    });

    const subjectCompanyId = subjectColumn(data);

    const values = {
      code: data.code,
      name: data.name,
      description: data.description ?? null,
      authority: data.authority,
      frequency: data.frequency,
      severity: data.severity,
      subjectCompanyId,
      dueMonthOffset: data.dueMonthOffset,
      dueDayOfMonth: data.dueDayOfMonth,
      lateFeePerDayMinor: data.lateFeePerDayMinor ?? 0n,
      lateFeeCapMinor: data.lateFeeCapMinor,
      interestRateBps: data.interestRateBps,
      penaltyNote: data.penaltyNote ?? null,
      legalReference: data.legalReference ?? null,
      isActive: data.isActive,
      applicabilityNote: data.applicabilityNote ?? null,
      effectiveFrom: data.effectiveFrom,
      effectiveTo: data.effectiveTo,
      reminderLeadDays: data.reminderLeadDays,
      updatedAt: new Date(),
    };

    const saved = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        if (data.id) {
          const [before] = await tx
            .select({
              name: complianceObligations.name,
              code: complianceObligations.code,
              subjectCompanyId: complianceObligations.subjectCompanyId,
              dueMonthOffset: complianceObligations.dueMonthOffset,
              dueDayOfMonth: complianceObligations.dueDayOfMonth,
              isActive: complianceObligations.isActive,
            })
            .from(complianceObligations)
            .where(
              and(
                eq(complianceObligations.tenantId, ctx.tenant.id),
                eq(complianceObligations.id, data.id),
              ),
            )
            .limit(1);

          if (!before) {
            throw new Error("That obligation no longer exists in this workspace.");
          }

          await tx
            .update(complianceObligations)
            .set(values)
            .where(
              and(
                eq(complianceObligations.tenantId, ctx.tenant.id),
                eq(complianceObligations.id, data.id),
              ),
            );
          return { id: data.id, before };
        }

        const [row] = await tx
          .insert(complianceObligations)
          .values({ tenantId: ctx.tenant.id, ...values })
          .returning({ id: complianceObligations.id });
        if (!row) throw new Error("The obligation could not be created.");
        return { id: row.id, before: null };
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: data.id ? "update" : "create",
      resourceType: "compliance_obligation",
      resourceId: saved.id,
      oldValue: saved.before
        ? {
            code: saved.before.code,
            name: saved.before.name,
            subjectCompanyId: saved.before.subjectCompanyId,
            dueMonthOffset: saved.before.dueMonthOffset,
            dueDayOfMonth: saved.before.dueDayOfMonth,
            isActive: saved.before.isActive,
          }
        : null,
      newValue: {
        code: data.code,
        name: data.name,
        subjectCompanyId,
        dueMonthOffset: data.dueMonthOffset,
        dueDayOfMonth: data.dueDayOfMonth,
        isActive: data.isActive,
      },
      reason: `${data.name} · ${data.frequency.replace("_", " ")} · due day ${
        data.dueDayOfMonth
      } of month +${data.dueMonthOffset} · ${
        subjectCompanyId === null ? "your own" : "a client's"
      }`,
      metadata: {
        authority: data.authority,
        lateFeePerDayMinor: String(data.lateFeePerDayMinor ?? 0n),
        lateFeeCapMinor:
          data.lateFeeCapMinor === null ? null : String(data.lateFeeCapMinor),
        legalReference: data.legalReference,
      },
      /**
       * ⚠️ CHANGING THE DUE-DATE RULE MOVES EVERY FUTURE DEADLINE, so it
       * is a notice rather than an info line. Tasks already generated keep
       * the date the trigger derived at the time — which is correct, that
       * is what was reported — so the two can legitimately disagree, and
       * the audit line is the only place that says when the rule changed.
       */
      severity:
        saved.before &&
        (saved.before.dueDayOfMonth !== data.dueDayOfMonth ||
          saved.before.dueMonthOffset !== data.dueMonthOffset ||
          saved.before.subjectCompanyId !== subjectCompanyId)
          ? "notice"
          : "info",
    });

    revalidatePath("/compliance");
    return { ok: true, data: { id: saved.id } };
  } catch (err) {
    const explained = explainComplianceError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "compliance");
  }
}

/**
 * ⭐ Stop an obligation from applying, WITHOUT deleting anything.
 *
 * ⚠️ THERE IS NO `deleteComplianceObligation`, AND THAT IS DELIBERATE.
 * The composite foreign key from `compliance_tasks` is ON DELETE CASCADE,
 * so removing the rule takes every deadline ever generated from it — the
 * filings, their acknowledgement numbers and their evidence trail — and
 * the register can no longer show that the practice ever filed a GST
 * return at all. Deactivation stops future generation and leaves the
 * history standing, which is the only version of "we stopped doing this"
 * that survives an inspection.
 */
export async function deactivateComplianceObligation(
  input: unknown,
): Promise<ActionResult<{ id: string; isActive: boolean }>> {
  try {
    const data = z
      .object({
        id: z.string().uuid(),
        /** Pass false to deactivate, true to bring it back. */
        isActive: z.coerce.boolean().default(false),
        /**
         * ⚠️ REQUIRED WHEN SWITCHING OFF. "We deregistered in March" and
         * "somebody clicked the wrong row" are the same absence of filings
         * six months later, and only one of them is defensible.
         */
        reason: z.string().trim().max(2000).optional().nullable(),
        effectiveTo: optionalDay,
      })
      .refine((d) => d.isActive || (d.reason && d.reason.length > 0), {
        message:
          "Say why this obligation no longer applies. An obligation that " +
          "silently stopped generating deadlines is indistinguishable from " +
          "one nobody is filing.",
        path: ["reason"],
      })
      .parse(input);

    const ctx = await guardSalesWrite({
      operation: "compliance:obligation:deactivate",
      feature: CALENDAR_FEATURE,
      permission: CALENDAR_WRITE,
      resource: { type: "compliance_obligation", id: data.id },
    });

    const changed = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [row] = await tx
          .update(complianceObligations)
          .set({
            isActive: data.isActive,
            /**
             * ⚠️ APPENDED, NEVER OVERWRITTEN. `applicability_note` is the
             * only place the conditions under which this obligation ever
             * applied are written down, in prose, for a human. Replacing
             * it with "registration surrendered" destroys the answer to
             * "why did we start filing this in the first place" — which is
             * the question asked when somebody wants to switch it back on.
             */
            applicabilityNote: data.reason
              ? sql`COALESCE(${complianceObligations.applicabilityNote} || E'\n', '') || ${data.reason}`
              : undefined,
            effectiveTo: data.effectiveTo ?? undefined,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(complianceObligations.tenantId, ctx.tenant.id),
              eq(complianceObligations.id, data.id),
              isNull(complianceObligations.deletedAt),
            ),
          )
          .returning({
            id: complianceObligations.id,
            name: complianceObligations.name,
          });
        if (!row) throw new Error("That obligation is not on the register.");
        return row;
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "compliance_obligation",
      resourceId: data.id,
      newValue: { isActive: data.isActive },
      reason: data.isActive
        ? `${changed.name} reinstated`
        : `${changed.name} no longer applies — ${data.reason}`,
      metadata: { effectiveTo: data.effectiveTo },
      // ⚠️ Switching an obligation OFF is how filings stop happening. It
      // belongs in the notice band where somebody reviewing the audit log
      // will actually see it.
      severity: data.isActive ? "info" : "notice",
    });

    revalidatePath("/compliance");
    return { ok: true, data: { id: data.id, isActive: data.isActive } };
  } catch (err) {
    const explained = explainComplianceError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "compliance");
  }
}

/* ------------------------------------------------------------------ */
/* WRITE — TASKS (the occurrence)                                      */
/* ------------------------------------------------------------------ */

const generateSchema = z.object({
  obligationId: z.string().uuid("Choose an obligation."),
  /**
   * ⭐ THE FIRST DAY OF THE FIRST PERIOD. NOT A DUE DATE.
   *
   * ⚠️ There is no due-date field on this form and there never will be.
   * See `periodFor` — the date is derived by trigger from this period and
   * the obligation's own rule, including the day-31 clamp.
   */
  periodStart: daySchema,
  /**
   * How many consecutive periods to generate from that start.
   *
   * ⭐ GENERATING AHEAD IS THE POINT. An obligation whose tasks are
   * created only when somebody remembers is an obligation with no alarm:
   * the reminder ladder counts back from a due date, and a task that does
   * not exist yet has no due date to count back from.
   */
  periods: z.coerce.number().int().min(1).max(36).default(12),
  /** Overrides the generated label for the FIRST period only. */
  periodLabel: z.string().trim().max(60).optional().nullable(),
});

/**
 * ⭐ Generate the deadlines for one obligation, for N periods.
 *
 * ⚠️ RUNNING IT TWICE IS SAFE, AND THAT IS LOAD-BEARING. The generator
 * runs nightly and again by hand whenever somebody adds an obligation
 * mid-year; without idempotence the second run doubles every task, and a
 * board that shows each filing twice is one people stop trusting within a
 * week. The unique index `compliance_tasks_obligation_period_key` is what
 * enforces it — this function simply asks the database to skip conflicts
 * and reports how many rows were genuinely new.
 */
export async function generateComplianceTasks(
  input: unknown,
): Promise<
  ActionResult<{ created: number; skipped: number; firstDueDate: string | null }>
> {
  try {
    const data = generateSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "compliance:task:generate",
      feature: CALENDAR_FEATURE,
      permission: CALENDAR_WRITE,
      resource: { type: "compliance_obligation", id: data.obligationId },
    });

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [ob] = await tx
          .select({
            id: complianceObligations.id,
            name: complianceObligations.name,
            frequency: complianceObligations.frequency,
            severity: complianceObligations.severity,
            subjectCompanyId: complianceObligations.subjectCompanyId,
            ownerUserId: complianceObligations.ownerUserId,
            isActive: complianceObligations.isActive,
          })
          .from(complianceObligations)
          .where(
            and(
              eq(complianceObligations.tenantId, ctx.tenant.id),
              eq(complianceObligations.id, data.obligationId),
              isNull(complianceObligations.deletedAt),
            ),
          )
          .limit(1);

        if (!ob) {
          throw new Error("That obligation does not exist in this workspace.");
        }
        if (!ob.isActive) {
          throw new Error(
            "That obligation is switched off. Reinstate it before generating " +
              "deadlines — generating tasks for an obligation somebody " +
              "decided does not apply is how a register grows deadlines " +
              "nobody intends to file.",
          );
        }

        // ⚠️ `one_time` and `event_based` have no schedule. One period only,
        // whatever the count says. See `periodFor`.
        const count = monthsPerPeriod(ob.frequency) === 0 ? 1 : data.periods;

        const rows = Array.from({ length: count }, (_, i) => {
          const p = periodFor(ob.frequency, data.periodStart, i);
          return {
            tenantId: ctx.tenant.id,
            obligationId: ob.id,
            /**
             * ⭐ DENORMALISED AT GENERATION TIME, ON PURPOSE. Changing the
             * obligation's subject later must not silently rewrite the
             * history of who owed what in which period.
             */
            subjectCompanyId: ob.subjectCompanyId,
            periodStart: p.periodStart,
            periodEnd: p.periodEnd,
            periodLabel:
              i === 0 && data.periodLabel ? data.periodLabel : p.periodLabel,
            /**
             * ⚠️ THIS VALUE IS DISCARDED. `due_date` is NOT NULL with no
             * default, so Drizzle's insert type demands something — but
             * `trg_compliance_tasks_010_due_date` overwrites it BEFORE the
             * row lands, every time, from the period and the obligation's
             * rule. `period_end` is passed as the placeholder precisely
             * because it is never a plausible due date on its own: if the
             * trigger were ever missing, the register would show filings
             * due on the last day of their own period and somebody would
             * notice within a day, rather than quietly inheriting a
             * hand-typed date that looks right.
             */
            dueDate: p.periodEnd,
            /**
             * ⚠️ SET EXPLICITLY FROM THE OBLIGATION, not left to the
             * trigger's COALESCE. The column defaults to 'medium', so the
             * trigger's `COALESCE(NEW.severity, ob.severity)` never sees a
             * NULL to fall back from — every generated task would come out
             * medium, and a critical obligation would sort into the middle
             * of the board next to a routine one.
             */
            severity: ob.severity,
            ownerUserId: ob.ownerUserId,
          };
        });

        const inserted = await tx
          .insert(complianceTasks)
          .values(rows)
          // ⚠️ Idempotent by constraint, not by a prior SELECT: two
          // generator runs racing each other would both find the period
          // absent and both insert.
          .onConflictDoNothing({
            target: [complianceTasks.obligationId, complianceTasks.periodStart],
          })
          .returning({
            id: complianceTasks.id,
            dueDate: complianceTasks.dueDate,
            periodLabel: complianceTasks.periodLabel,
          });

        return { ob, attempted: rows.length, inserted };
      },
      { impersonationId: ctx.impersonationId },
    );

    const created = outcome.inserted.length;
    const skipped = outcome.attempted - created;

    await writeAudit(ctx, {
      action: "create",
      resourceType: "compliance_task",
      resourceId: outcome.inserted[0]?.id ?? null,
      newValue: {
        obligationId: data.obligationId,
        periodStart: data.periodStart,
        created,
        skipped,
      },
      reason: `${created} deadline(s) generated for ${outcome.ob.name}${
        skipped > 0 ? ` · ${skipped} already existed` : ""
      }`,
      metadata: {
        frequency: outcome.ob.frequency,
        subjectCompanyId: outcome.ob.subjectCompanyId,
        // ⭐ Recorded because it is the trigger's answer, not ours — the
        // audit line is where you look when somebody asks why a filing
        // fell on the 28th.
        firstDueDate: outcome.inserted[0]?.dueDate ?? null,
      },
    });

    revalidatePath("/compliance");
    return {
      ok: true,
      data: {
        created,
        skipped,
        firstDueDate: outcome.inserted[0]?.dueDate ?? null,
      },
    };
  } catch (err) {
    const explained = explainComplianceError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "compliance");
  }
}

const completeSchema = z.object({
  id: z.string().uuid(),
  /**
   * ⚠️ REQUIRED, AND THE DATABASE AGREES. ARN, challan number, SRN,
   * receipt number — whatever the authority handed back. The completion
   * trigger refuses `filed` and `late_filed` without one, because "I
   * definitely filed it" has never won an argument with a regulator.
   */
  filingReference: z
    .string()
    .trim()
    .min(1, "Enter the acknowledgement the authority gave back (ARN / challan / receipt).")
    .max(200),
  notes: z.string().trim().max(5000).optional().nullable(),
});

/**
 * ⭐ Record a filing as done.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ `missed` IS TERMINAL. THIS NEVER RETURNS A TASK TO `pending`.
 * ══════════════════════════════════════════════════════════════════════
 * Filing a missed return records it as `late_filed` — a distinct, final
 * state that says the work was done AND that it was done late. It is not
 * a scolding: the pattern of `late_filed` is the only leading indicator
 * of a compliance failure that exists, because by the time something is
 * `missed` the damage has already landed. A register you can tidy is a
 * register no inspector accepts, and one that quietly relabels late
 * filings as on-time cannot answer the single question that predicts the
 * next penalty.
 *
 * ⚠️ AND THE DATES DECIDE, NOT THIS FUNCTION. `filed` is submitted; the
 * completion trigger compares the filing date against the derived due
 * date and rewrites the status to `late_filed` if it is late, computes
 * `days_late`, and computes the fee from the obligation's own rate and
 * cap. NONE of that is calculated in TypeScript — last year's penalty
 * must not change when this year's rate does.
 */
export async function completeComplianceTask(
  input: unknown,
): Promise<
  ActionResult<{
    id: string;
    status: string;
    daysLate: number;
    lateFeeMinor: string;
  }>
> {
  try {
    const data = completeSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "compliance:task:complete",
      feature: CALENDAR_FEATURE,
      permission: CALENDAR_WRITE,
      resource: { type: "compliance_task", id: data.id },
    });

    const saved = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [before] = await tx
          .select({
            status: complianceTasks.status,
            periodLabel: complianceTasks.periodLabel,
            dueDate: complianceTasks.dueDate,
          })
          .from(complianceTasks)
          .where(
            and(
              eq(complianceTasks.tenantId, ctx.tenant.id),
              eq(complianceTasks.id, data.id),
            ),
          )
          .limit(1);

        if (!before) {
          throw new Error("That deadline does not exist in this workspace.");
        }

        const [row] = await tx
          .update(complianceTasks)
          .set({
            /**
             * ⭐ A MISSED TASK IS SUBMITTED AS `late_filed`, NEVER AS
             * `pending` AND NEVER AS PLAIN `filed`.
             *
             * ⚠️ The trigger would correct a plain `filed` anyway, since
             * the filing date is past the due date. Stating it here is
             * belt and braces for the one case the clock cannot settle —
             * a task marked missed by the sweep and filed the same day —
             * and it makes the INTENT visible in the audit trail: this
             * was recorded knowing it was already late.
             */
            status: before.status === "missed" ? "late_filed" : "filed",
            filingReference: data.filingReference,
            notes: data.notes ?? undefined,
            completedByUserId: ctx.user.id,
            // ⚠️ `completed_at` is left to the trigger (COALESCE to now()),
            // and `days_late` / `late_fee_minor` are NEVER sent from here.
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(complianceTasks.tenantId, ctx.tenant.id),
              eq(complianceTasks.id, data.id),
            ),
          )
          .returning({
            id: complianceTasks.id,
            status: complianceTasks.status,
            daysLate: complianceTasks.daysLate,
            lateFeeMinor: complianceTasks.lateFeeMinor,
            periodLabel: complianceTasks.periodLabel,
          });

        if (!row) throw new Error("That deadline does not exist in this workspace.");
        return { row, before };
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "compliance_task",
      resourceId: data.id,
      oldValue: { status: saved.before.status, dueDate: saved.before.dueDate },
      newValue: {
        status: saved.row.status,
        filingReference: data.filingReference,
        daysLate: saved.row.daysLate,
        lateFeeMinor: minor(saved.row.lateFeeMinor),
      },
      reason: `${saved.row.periodLabel} recorded as ${saved.row.status.replace(
        "_",
        " ",
      )} · ref ${data.filingReference}`,
      metadata: { dueDate: saved.before.dueDate, previousStatus: saved.before.status },
      /**
       * ⚠️ A LATE FILING IS A NOTICE. It cost money and it is the signal
       * that predicts the next missed one; logging it at the same level as
       * an on-time filing buries the only pattern worth watching.
       */
      severity: saved.row.status === "late_filed" ? "notice" : "info",
    });

    revalidatePath("/compliance");
    return {
      ok: true,
      data: {
        id: saved.row.id,
        status: saved.row.status,
        daysLate: saved.row.daysLate ?? 0,
        // ⚠️ bigint → string. JSON.stringify throws outright on a bigint.
        lateFeeMinor: minor(saved.row.lateFeeMinor),
      },
    };
  } catch (err) {
    const explained = explainComplianceError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "compliance");
  }
}

const exemptSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["not_applicable", "waived"]),
  /**
   * ⚠️ REQUIRED HERE AND ENFORCED AGAIN BY TRIGGER. "We did not file
   * because we are not registered for it" and "we did not file" are
   * completely different facts that a status alone cannot tell apart, and
   * six months later nobody remembers which it was.
   */
  reason: z
    .string()
    .trim()
    .min(1, "Say why this period did not apply. A status with no reason is not a record.")
    .max(2000),
});

/**
 * ⭐ Record that a period did not apply, or was waived.
 *
 * ⚠️ THIS IS NOT "DONE" AND IT IS NOT "IGNORED". It is a stated decision
 * that somebody made and signed, which is a third thing — the board keeps
 * it out of both buckets for exactly that reason. Folding it into `filed`
 * would claim a return was submitted that never was; folding it into the
 * open list would chase a deadline that nobody owes.
 *
 * ⚠️ AND IT DOES NOT ERASE LATENESS THAT ALREADY HAPPENED. The trigger
 * zeroes `days_late` and the fee for these statuses because there is
 * nothing to be late for — so waiving a `missed` task is a decision worth
 * making deliberately, and it is logged at notice severity below.
 */
export async function exemptComplianceTask(
  input: unknown,
): Promise<ActionResult<{ id: string; status: string }>> {
  try {
    const data = exemptSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "compliance:task:exempt",
      feature: CALENDAR_FEATURE,
      permission: CALENDAR_WRITE,
      resource: { type: "compliance_task", id: data.id },
    });

    const saved = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [before] = await tx
          .select({
            status: complianceTasks.status,
            periodLabel: complianceTasks.periodLabel,
            daysLate: complianceTasks.daysLate,
            lateFeeMinor: complianceTasks.lateFeeMinor,
          })
          .from(complianceTasks)
          .where(
            and(
              eq(complianceTasks.tenantId, ctx.tenant.id),
              eq(complianceTasks.id, data.id),
            ),
          )
          .limit(1);

        if (!before) {
          throw new Error("That deadline does not exist in this workspace.");
        }

        const [row] = await tx
          .update(complianceTasks)
          .set({
            status: data.status,
            exemptionReason: data.reason,
            completedByUserId: ctx.user.id,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(complianceTasks.tenantId, ctx.tenant.id),
              eq(complianceTasks.id, data.id),
            ),
          )
          .returning({
            id: complianceTasks.id,
            status: complianceTasks.status,
            periodLabel: complianceTasks.periodLabel,
          });

        if (!row) throw new Error("That deadline does not exist in this workspace.");
        return { row, before };
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "compliance_task",
      resourceId: data.id,
      oldValue: {
        status: saved.before.status,
        daysLate: saved.before.daysLate,
        lateFeeMinor: minor(saved.before.lateFeeMinor),
      },
      newValue: { status: data.status, exemptionReason: data.reason },
      reason: `${saved.row.periodLabel} marked ${data.status.replace(
        "_",
        " ",
      )} — ${data.reason}`,
      metadata: { previousStatus: saved.before.status },
      /**
       * ⚠️ WAIVING A MISSED DEADLINE ZEROES A LATE FEE THAT HAD ALREADY
       * ACCRUED. That is sometimes exactly right and sometimes somebody
       * making a red number go away; either way it is the one action on
       * this page that removes a fact from the register, so it is logged
       * where a reviewer will find it.
       */
      severity: saved.before.status === "missed" ? "notice" : "info",
    });

    revalidatePath("/compliance");
    return { ok: true, data: { id: data.id, status: saved.row.status } };
  } catch (err) {
    const explained = explainComplianceError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "compliance");
  }
}

/* ------------------------------------------------------------------ */
/* WRITE — EVIDENCE (append-only)                                      */
/* ------------------------------------------------------------------ */

const evidenceSchema = z.object({
  taskId: z.string().uuid("Choose the deadline this proves."),
  kind: z.string().trim().min(1, "What kind of document is this?").max(60),
  title: z.string().trim().min(1, "Name the document.").max(300),
  /** Points at `documents`. Bytes live in R2, never in Postgres. */
  documentId: z.string().uuid().optional().nullable(),
  /**
   * ⭐ SHA-256 OF THE BYTES AT UPLOAD. This is what makes the evidence
   * worth having.
   *
   * ⚠️ Without it, "here is the acknowledgement we filed" is a PDF
   * somebody could have edited last week. With it, the file either hashes
   * to the recorded value or it has changed since — and which of those is
   * true is not a matter of opinion. The trigger makes it immutable once
   * written, so a wrong hash is corrected by superseding, never by an
   * edit.
   */
  contentSha256: z
    .union([
      z.string().trim().regex(/^[0-9a-fA-F]{64}$/, "A SHA-256 is 64 hex characters."),
      z.literal(""),
      z.null(),
    ])
    .optional()
    .transform((v) => (v ? v.toLowerCase() : null)),
  filingReference: z.string().trim().max(200).optional().nullable(),
  filedOn: optionalDay,
  notes: z.string().trim().max(5000).optional().nullable(),
  /**
   * ⭐ THE ONLY WAY TO REPLACE EVIDENCE: point the old row at the new one.
   *
   * ⚠️ A revised return does not erase the original — being able to show
   * BOTH is what a revision IS. So this writes a pointer and leaves the
   * earlier row exactly as it was.
   */
  supersedesEvidenceId: z.string().uuid().optional().nullable(),
});

/**
 * ⭐ Attach proof to a filing. APPEND-ONLY.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THERE IS NO `deleteComplianceEvidence`, AND ADDING ONE WOULD FAIL.
 * ══════════════════════════════════════════════════════════════════════
 * The app role holds no DELETE privilege on `compliance_evidence` at all
 * — section 10 of SQL-FILES/0032 GRANTs `SELECT, INSERT, UPDATE` and then
 * explicitly REVOKEs DELETE, because privileges accumulate and the
 * bootstrap's blanket `GRANT ALL` had already handed it over. The
 * append-only trigger refuses the delete too, but a trigger is a rule and
 * a revoked privilege is a wall: `drizzle-kit push` drops triggers it does
 * not know about, and the wall is what remains standing that day.
 *
 * So the UI offers no delete button. Superseding is the correction path.
 */
export async function attachComplianceEvidence(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const data = evidenceSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "compliance:evidence:attach",
      feature: CALENDAR_FEATURE,
      permission: CALENDAR_WRITE,
      resource: { type: "compliance_task", id: data.taskId },
    });

    const saved = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [task] = await tx
          .select({
            id: complianceTasks.id,
            periodLabel: complianceTasks.periodLabel,
            status: complianceTasks.status,
          })
          .from(complianceTasks)
          .where(
            and(
              eq(complianceTasks.tenantId, ctx.tenant.id),
              eq(complianceTasks.id, data.taskId),
            ),
          )
          .limit(1);

        if (!task) {
          throw new Error("That deadline does not exist in this workspace.");
        }

        const [row] = await tx
          .insert(complianceEvidence)
          .values({
            tenantId: ctx.tenant.id,
            taskId: data.taskId,
            kind: data.kind,
            title: data.title,
            documentId: data.documentId ?? null,
            contentSha256: data.contentSha256,
            filingReference: data.filingReference ?? null,
            filedOn: data.filedOn,
            notes: data.notes ?? null,
            uploadedByUserId: ctx.user.id,
          })
          .returning({ id: complianceEvidence.id });

        if (!row) throw new Error("The evidence could not be recorded.");

        if (data.supersedesEvidenceId) {
          /**
           * ⚠️ THE POINTER GOES ON THE OLD ROW, AND NOTHING ELSE ON IT IS
           * TOUCHED. `superseded_at` is stamped by the trigger. The hash
           * and the document id of the superseded row are immutable — the
           * trigger refuses to repoint filed evidence at a different
           * document — which is precisely what makes the earlier filing
           * still provable after it has been revised.
           */
          const updated = await tx
            .update(complianceEvidence)
            .set({ supersededByEvidenceId: row.id })
            .where(
              and(
                eq(complianceEvidence.tenantId, ctx.tenant.id),
                eq(complianceEvidence.id, data.supersedesEvidenceId),
                isNull(complianceEvidence.supersededByEvidenceId),
              ),
            )
            .returning({ id: complianceEvidence.id });

          if (updated.length === 0) {
            throw new Error(
              "That earlier document could not be superseded — it may already " +
                "have been superseded by something else. Evidence is never " +
                "deleted or re-pointed; the new document has still been " +
                "recorded against the filing.",
            );
          }
        }

        return { id: row.id, task };
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "create",
      resourceType: "compliance_evidence",
      resourceId: saved.id,
      newValue: {
        taskId: data.taskId,
        kind: data.kind,
        title: data.title,
        contentSha256: data.contentSha256,
        supersedesEvidenceId: data.supersedesEvidenceId ?? null,
      },
      reason: `${data.title} attached to ${saved.task.periodLabel}${
        data.supersedesEvidenceId ? " (supersedes an earlier document)" : ""
      }`,
      metadata: {
        documentId: data.documentId ?? null,
        filingReference: data.filingReference ?? null,
        filedOn: data.filedOn,
        taskStatus: saved.task.status,
      },
      /**
       * ⚠️ EVIDENCE WITH NO HASH IS A NOTICE. It is still worth keeping —
       * a filed acknowledgement number with a missing file beats nothing —
       * but it proves only that somebody uploaded something, which is a
       * materially weaker claim than the register normally makes.
       */
      severity: data.contentSha256 ? "info" : "notice",
    });

    revalidatePath("/compliance");
    return { ok: true, data: { id: saved.id } };
  } catch (err) {
    const explained = explainComplianceError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "compliance");
  }
}

/* ------------------------------------------------------------------ */
/* WRITE — LICENCES (permissions that expire)                          */
/* ------------------------------------------------------------------ */

const licenceSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1, "Name the licence.").max(300),
    authority: z.enum(AUTHORITIES),
    licenceNumber: z.string().trim().max(200).optional().nullable(),
    /** Where it applies — a property, a vehicle, a person. */
    appliesTo: z.string().trim().max(300).optional().nullable(),
    issuedOn: optionalDay,
    validFrom: optionalDay,
    /**
     * ⚠️ NULLABLE IN THE SCHEMA, AND THE ABSENCE IS ITSELF A PROBLEM.
     * A licence with no expiry recorded is invisible to every alarm on
     * the licence page — there is no date to count back from — so the
     * status trigger marks it `active` and it stays reassuringly green
     * for ever. The page lists those separately for that reason.
     */
    validUntil: optionalDay,
    /**
     * ⭐ HOW LONG A RENEWAL ACTUALLY TAKES. NOT A REMINDER LEAD.
     *
     * ⚠️ Some renewals legally cannot be applied for until a window
     * opens; others take ninety days to process. "Remind me a week
     * before" is useless for a pollution-control consent. This is the
     * date from which being idle is ALREADY a problem, which is why it
     * lives per licence rather than as one global setting.
     */
    renewalLeadDays: z.coerce.number().int().min(0).max(730).default(60),
    severity: z.enum(SEVERITIES).default("high"),
    renewalFeeMinor: moneySchema.optional().nullable(),
    documentId: z.string().uuid().optional().nullable(),
    notes: z.string().trim().max(5000).optional().nullable(),
  })
  .and(subjectSchema)
  .refine(
    (d) => !d.validFrom || !d.validUntil || d.validUntil >= d.validFrom,
    {
      message: "The expiry cannot be before the start of validity.",
      path: ["validUntil"],
    },
  );

/**
 * ⭐ Create or amend a licence.
 *
 * ⚠️ `status` IS NOT ACCEPTED FROM THIS FORM, AND THAT IS THE WHOLE
 * DESIGN. `compliance_licence_status_from_dates()` derives it on every
 * insert and update: expired if the date has passed, `renewal_due` inside
 * the lead window, `active` otherwise. Letting a dropdown set it means a
 * fire NOC reads `active` for eight months after it lapsed — which is the
 * single thing this table exists to prevent. The externally-decided
 * states (`suspended`, `cancelled`, `not_required`) are set through
 * `retireComplianceLicence`, and the trigger leaves those alone.
 */
export async function saveComplianceLicence(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const data = licenceSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "compliance:licence:save",
      feature: LICENCE_FEATURE,
      permission: LICENCE_WRITE,
      resource: data.id ? { type: "compliance_licence", id: data.id } : undefined,
    });

    const subjectCompanyId = subjectColumn(data);

    const values = {
      subjectCompanyId,
      name: data.name,
      authority: data.authority,
      licenceNumber: data.licenceNumber ?? null,
      appliesTo: data.appliesTo ?? null,
      issuedOn: data.issuedOn,
      validFrom: data.validFrom,
      validUntil: data.validUntil,
      renewalLeadDays: data.renewalLeadDays,
      severity: data.severity,
      renewalFeeMinor: data.renewalFeeMinor ?? 0n,
      documentId: data.documentId ?? null,
      notes: data.notes ?? null,
      updatedAt: new Date(),
    };

    const saved = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        if (data.id) {
          const [before] = await tx
            .select({
              name: complianceLicences.name,
              validUntil: complianceLicences.validUntil,
              renewalLeadDays: complianceLicences.renewalLeadDays,
              status: complianceLicences.status,
              subjectCompanyId: complianceLicences.subjectCompanyId,
            })
            .from(complianceLicences)
            .where(
              and(
                eq(complianceLicences.tenantId, ctx.tenant.id),
                eq(complianceLicences.id, data.id),
                isNull(complianceLicences.deletedAt),
              ),
            )
            .limit(1);

          if (!before) {
            throw new Error("That licence is not on the register.");
          }

          const [row] = await tx
            .update(complianceLicences)
            .set(values)
            .where(
              and(
                eq(complianceLicences.tenantId, ctx.tenant.id),
                eq(complianceLicences.id, data.id),
              ),
            )
            .returning({
              id: complianceLicences.id,
              status: complianceLicences.status,
            });

          if (!row) throw new Error("That licence is not on the register.");
          return { id: row.id, status: row.status, before };
        }

        const [row] = await tx
          .insert(complianceLicences)
          .values({ tenantId: ctx.tenant.id, ...values })
          .returning({
            id: complianceLicences.id,
            status: complianceLicences.status,
          });
        if (!row) throw new Error("The licence could not be created.");
        return { id: row.id, status: row.status, before: null };
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: data.id ? "update" : "create",
      resourceType: "compliance_licence",
      resourceId: saved.id,
      oldValue: saved.before
        ? {
            name: saved.before.name,
            validUntil: saved.before.validUntil,
            renewalLeadDays: saved.before.renewalLeadDays,
            status: saved.before.status,
            subjectCompanyId: saved.before.subjectCompanyId,
          }
        : null,
      newValue: {
        name: data.name,
        validUntil: data.validUntil,
        renewalLeadDays: data.renewalLeadDays,
        subjectCompanyId,
        // ⭐ The status the DATABASE decided, not one we sent.
        status: saved.status,
      },
      reason: `${data.name} · ${
        data.validUntil ? `valid until ${data.validUntil}` : "no expiry recorded"
      } · renewal takes ${data.renewalLeadDays}d · ${
        subjectCompanyId === null ? "your own" : "a client's"
      }`,
      metadata: {
        authority: data.authority,
        licenceNumber: data.licenceNumber ?? null,
        appliesTo: data.appliesTo ?? null,
        renewalFeeMinor: String(data.renewalFeeMinor ?? 0n),
      },
      /**
       * ⚠️ A LICENCE WITH NO EXPIRY IS A NOTICE. Nothing errors, nothing
       * looks wrong, and the licence simply never warns anybody again —
       * the failure mode that costs the premises its right to operate.
       */
      severity: data.validUntil === null ? "notice" : "info",
    });

    revalidatePath("/compliance/licences");
    return { ok: true, data: { id: saved.id } };
  } catch (err) {
    const explained = explainComplianceError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "compliance");
  }
}

const renewSchema = z
  .object({
    id: z.string().uuid(),
    /**
     * ⭐ TWO DIFFERENT ACTS, DELIBERATELY NOT ONE.
     *
     * `started` says a human has begun the renewal — the trigger keeps
     * `under_renewal` rather than reverting it to `renewal_due`, so the
     * board stops nagging about a licence somebody is already handling.
     * `renewed` says the new permission is in hand, and carries the new
     * dates. Collapsing them would mean either claiming a licence is
     * renewed while the application sits with the department, or nagging
     * daily about something already in flight until it comes back.
     */
    mode: z.enum(["started", "renewed"]).default("renewed"),
    validFrom: optionalDay,
    validUntil: optionalDay,
    licenceNumber: z.string().trim().max(200).optional().nullable(),
    renewalFeeMinor: moneySchema.optional().nullable(),
    notes: z.string().trim().max(5000).optional().nullable(),
  })
  .refine((d) => d.mode !== "renewed" || !!d.validUntil, {
    message:
      "Enter the new expiry date. A renewal with no new expiry leaves the " +
      "licence counting down to the old one — or to nothing at all.",
    path: ["validUntil"],
  });

/**
 * ⭐ Start a renewal, or record one that came back.
 *
 * ⚠️ THE NEW STATUS IS NOT SENT AND CANNOT BE. The trigger recomputes it
 * from the new dates, so a renewal recorded with an expiry already in the
 * past lands as `expired` rather than as the `active` somebody selected.
 * That is the correct outcome and it is not obtainable any other way: a
 * form that sets the status directly is a form that will eventually mark
 * a lapsed drug licence active because the operator was clicking through
 * a list.
 */
export async function renewComplianceLicence(
  input: unknown,
): Promise<ActionResult<{ id: string; status: string; validUntil: string | null }>> {
  try {
    const data = renewSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "compliance:licence:renew",
      feature: LICENCE_FEATURE,
      permission: LICENCE_WRITE,
      resource: { type: "compliance_licence", id: data.id },
    });

    const saved = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [before] = await tx
          .select({
            name: complianceLicences.name,
            status: complianceLicences.status,
            validUntil: complianceLicences.validUntil,
            licenceNumber: complianceLicences.licenceNumber,
          })
          .from(complianceLicences)
          .where(
            and(
              eq(complianceLicences.tenantId, ctx.tenant.id),
              eq(complianceLicences.id, data.id),
              isNull(complianceLicences.deletedAt),
            ),
          )
          .limit(1);

        if (!before) throw new Error("That licence is not on the register.");

        const [row] = await tx
          .update(complianceLicences)
          .set(
            data.mode === "started"
              ? {
                  /**
                   * ⚠️ THE ONE STATUS THIS FILE EVER SETS ON A LICENCE,
                   * and only because the trigger explicitly preserves it:
                   * `under_renewal` is a statement that a PERSON has
                   * started, which no date can imply. Everything else is
                   * derived.
                   */
                  status: "under_renewal",
                  notes: data.notes ?? undefined,
                  updatedAt: new Date(),
                }
              : {
                  validFrom: data.validFrom ?? undefined,
                  validUntil: data.validUntil,
                  licenceNumber: data.licenceNumber ?? undefined,
                  renewalFeeMinor: data.renewalFeeMinor ?? undefined,
                  notes: data.notes ?? undefined,
                  /**
                   * ⚠️ SET TO `active` ONLY AS AN INPUT TO THE TRIGGER,
                   * never as the answer. It exists to clear a previous
                   * `under_renewal`, which the trigger would otherwise
                   * keep — leaving a freshly renewed licence permanently
                   * described as being in the middle of a renewal. The
                   * dates then decide what it really is.
                   */
                  status: "active",
                  updatedAt: new Date(),
                },
          )
          .where(
            and(
              eq(complianceLicences.tenantId, ctx.tenant.id),
              eq(complianceLicences.id, data.id),
            ),
          )
          .returning({
            id: complianceLicences.id,
            status: complianceLicences.status,
            validUntil: complianceLicences.validUntil,
          });

        if (!row) throw new Error("That licence is not on the register.");
        return { row, before };
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "compliance_licence",
      resourceId: data.id,
      oldValue: {
        status: saved.before.status,
        validUntil: saved.before.validUntil,
        licenceNumber: saved.before.licenceNumber,
      },
      newValue: { status: saved.row.status, validUntil: saved.row.validUntil },
      reason:
        data.mode === "started"
          ? `${saved.before.name} — renewal started`
          : `${saved.before.name} renewed to ${saved.row.validUntil ?? "—"}`,
      metadata: {
        mode: data.mode,
        renewalFeeMinor:
          data.renewalFeeMinor === null || data.renewalFeeMinor === undefined
            ? null
            : String(data.renewalFeeMinor),
      },
      /**
       * ⚠️ A "RENEWAL" THAT LANDS AS `expired` IS A NOTICE. It means the
       * new expiry is already in the past — a typo, or a permission that
       * came back short — and it is the one outcome of this action that
       * nobody expects to see.
       */
      severity: saved.row.status === "expired" ? "notice" : "info",
    });

    revalidatePath("/compliance/licences");
    return {
      ok: true,
      data: {
        id: data.id,
        status: saved.row.status,
        validUntil: saved.row.validUntil,
      },
    };
  } catch (err) {
    const explained = explainComplianceError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "compliance");
  }
}

/**
 * ⭐ Take a licence out of the warning ladder — WITHOUT removing it.
 *
 * ⚠️ THE ROW STAYS ON THE REGISTER, AND `deleted_at` IS NOT SET. Three
 * reasons, in descending order of how expensive they are to learn:
 *
 *   1. An inspector asks whether you HELD a drug licence in 2024. A row
 *      that has been soft-deleted answers nothing; the register's whole
 *      value is that it can be handed over and read.
 *   2. `cancelled`, `suspended` and `not_required` are external facts
 *      about the permission, and the status trigger deliberately leaves
 *      them alone rather than recomputing them from the calendar. A
 *      suspended licence stays suspended whether or not its printed date
 *      has passed.
 *   3. `not_required` said out loud is different from a licence quietly
 *      missing from a list. The second one looks exactly like an
 *      oversight, because most of the time it is.
 */
export async function retireComplianceLicence(
  input: unknown,
): Promise<ActionResult<{ id: string; status: string }>> {
  try {
    const data = z
      .object({
        id: z.string().uuid(),
        status: z.enum(["suspended", "cancelled", "not_required"]),
        reason: z
          .string()
          .trim()
          .min(1, "Say why. A licence that stopped warning for no stated reason reads as an oversight.")
          .max(2000),
      })
      .parse(input);

    const ctx = await guardSalesWrite({
      operation: "compliance:licence:retire",
      feature: LICENCE_FEATURE,
      permission: LICENCE_WRITE,
      resource: { type: "compliance_licence", id: data.id },
      /**
       * ⚠️ Judged as a DESTRUCTIVE act by the impersonation policy even
       * though nothing is deleted. It silences every alarm on a permission
       * the business may need to operate, which is the effect a delete
       * would have had — and a support session wearing the customer's face
       * has no business making that call.
       */
      impersonationOperation: "delete:compliance_licence",
    });

    const saved = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [row] = await tx
          .update(complianceLicences)
          .set({
            status: data.status,
            // ⚠️ Appended. The existing notes may be the only record of
            // which premises this licence covered — retiring it is not a
            // reason to lose that.
            notes: sql`COALESCE(${complianceLicences.notes} || E'\n', '') || ${data.reason}`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(complianceLicences.tenantId, ctx.tenant.id),
              eq(complianceLicences.id, data.id),
              isNull(complianceLicences.deletedAt),
            ),
          )
          .returning({
            id: complianceLicences.id,
            name: complianceLicences.name,
            status: complianceLicences.status,
            validUntil: complianceLicences.validUntil,
          });

        if (!row) throw new Error("That licence is not on the register.");
        return row;
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "compliance_licence",
      resourceId: data.id,
      newValue: { status: saved.status },
      reason: `${saved.name} → ${data.status.replace("_", " ")} — ${data.reason}`,
      metadata: { validUntil: saved.validUntil },
      // ⚠️ Always a notice: this is the action that switches off an alarm.
      severity: "notice",
    });

    revalidatePath("/compliance/licences");
    return { ok: true, data: { id: data.id, status: saved.status } };
  } catch (err) {
    const explained = explainComplianceError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "compliance");
  }
}
