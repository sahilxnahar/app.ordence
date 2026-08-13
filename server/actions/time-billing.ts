"use server";

/**
 * Ordence — ⭐ Time & billing
 * Version: v1.2.0-alpha
 *
 * The engine a law firm, a CA practice and a consultancy all run on.
 * Ordence could invoice an hour, tax it, collect it and post it to the
 * ledger — and had nowhere to record that it happened.
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT.
 */

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import { billingRates, timeEntries } from "@/db/schema/accounting";
import { companies } from "@/db/schema/crm";
import { salesInvoices, salesInvoiceLines } from "@/db/schema/sales-invoices";
import { users } from "@/db/schema/core";
import { requirePermission, writeAudit } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import {
  billableMinutes,
  resolveRate,
  summariseUnbilled,
  realisationPercent,
  timeValueMinor,
  minutesToHoursLabel,
  type BillingIncrement,
  type RateRow,
} from "@/lib/billing/time";
import { buildInvoice } from "@/lib/invoicing/build";
import { serializeAmount, toBigIntAmount } from "@/lib/billing/money";
import type { ActionResult } from "@/lib/validators/crm";

const civilDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

const rateSchema = z
  .object({
    userId: z.string().uuid().nullish(),
    roleName: z.string().trim().max(60).nullish(),
    companyId: z.string().uuid().nullish(),
    rateMinor: z.string().regex(/^\d+$/, "Rates are whole paise."),
    effectiveFrom: civilDay,
    effectiveTo: civilDay.nullish(),
    note: z.string().trim().max(500).optional(),
  })
  /**
   * ⚠️ A ROW NAMING NOBODY AND NO CLIENT IS UNEXPLAINABLE. The database
   * refuses it too; catching it here produces a sentence instead of a
   * constraint violation.
   */
  .refine((d) => d.userId || d.roleName || d.companyId, {
    message: "A rate must name a person, a role or a client — otherwise nothing can apply it.",
  });

const entrySchema = z.object({
  userId: z.string().uuid().optional(),
  companyId: z.string().uuid().nullish(),
  subjectType: z.string().trim().max(40).nullish(),
  subjectId: z.string().uuid().nullish(),
  subjectLabel: z.string().trim().max(255).nullish(),
  entryDate: civilDay,
  minutes: z.number().int().positive("Time has to be more than nothing."),
  isBillable: z.boolean().default(true),
  increment: z
    .enum(["six_minutes", "fifteen_minutes", "thirty_minutes", "exact"])
    .default("six_minutes"),
  narrative: z.string().trim().max(2000).optional(),
});

const READ = "sales.invoices.read" as const;
const WRITE = "sales.invoices.create" as const;
const APPROVE = "sales.invoices.issue" as const;

/* ================================================================== */

export async function saveBillingRate(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const data = rateSchema.parse(input);
    const ctx = await requirePermission("settings.manage");

    const id = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        /**
         * ⚠️ INSERTED, NEVER UPDATED IN PLACE. Changing a rate is a new
         * row with a new effective date — that is the entire point of an
         * effective-dated table. An UPDATE here would re-price every
         * unbilled hour ever worked at that rate.
         */
        const [row] = await tx
          .insert(billingRates)
          .values({
            tenantId: ctx.tenant.id,
            userId: data.userId ?? null,
            roleName: data.roleName ?? null,
            companyId: data.companyId ?? null,
            rateMinor: BigInt(data.rateMinor),
            effectiveFrom: data.effectiveFrom,
            effectiveTo: data.effectiveTo ?? null,
            note: data.note ?? null,
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .returning({ id: billingRates.id });

        if (!row) throw new Error("The rate could not be saved.");

        await writeAudit(ctx, {
          action: "create",
          resourceType: "billing_rate",
          resourceId: row.id,
          newValue: {
            rateMinor: data.rateMinor,
            effectiveFrom: data.effectiveFrom,
            userId: data.userId ?? null,
            companyId: data.companyId ?? null,
          },
          /** Changing what an hour is worth is a decision about revenue. */
          severity: "critical",
        });

        return row.id;
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/time");
    return { ok: true, data: { id } };
  } catch (err) {
    return toSalesActionError(err, "saveBillingRate");
  }
}

/**
 * ⭐ Record time, priced at the rate that applied ON THE DAY IT WAS DONE.
 *
 * ⚠️ THE RATE IS RESOLVED AND COPIED ONTO THE ENTRY HERE, not looked up
 * when the invoice is raised. That is what makes the effective-dated
 * rate table actually work: the hour carries the price it was worth.
 *
 * ⚠️ AND A MISSING RATE DOES NOT BLOCK RECORDING. Somebody at 7pm
 * writing up their day must not be stopped by a rate card nobody has
 * filled in — the entry is saved with zero value and shows as unrated,
 * which is a question for a partner rather than a lost hour.
 */
export async function recordTimeEntry(
  input: unknown,
): Promise<ActionResult<{ id: string; valueMinor: string; rated: boolean }>> {
  try {
    const data = entrySchema.parse(input);
    const ctx = await requirePermission(WRITE);

    /**
     * ⚠️ LOGGING TIME FOR SOMEBODY ELSE NEEDS THE APPROVAL PERMISSION.
     * Otherwise anyone could put billable hours against a partner's name
     * and the realisation figures stop meaning anything.
     */
    const forUser = data.userId ?? ctx.user.id;
    if (forUser !== ctx.user.id) {
      await requirePermission(APPROVE);
    }

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const billable = data.isBillable
          ? billableMinutes(data.minutes, data.increment as BillingIncrement)
          : 0;

        let rateMinor = 0n;
        let rated = false;

        if (data.isBillable) {
          const [who] = await tx
            .select({ role: users.role })
            .from(users)
            .where(and(eq(users.tenantId, ctx.tenant.id), eq(users.id, forUser)))
            .limit(1);

          const rateRows = await tx
            .select({
              id: billingRates.id,
              userId: billingRates.userId,
              roleName: billingRates.roleName,
              companyId: billingRates.companyId,
              rateMinor: billingRates.rateMinor,
              effectiveFrom: billingRates.effectiveFrom,
              effectiveTo: billingRates.effectiveTo,
            })
            .from(billingRates)
            .where(eq(billingRates.tenantId, ctx.tenant.id));

          const resolved = resolveRate({
            rates: rateRows.map((r) => ({
              id: r.id,
              userId: r.userId,
              roleName: r.roleName,
              companyId: r.companyId,
              rateMinor: toBigIntAmount(r.rateMinor),
              effectiveFrom: String(r.effectiveFrom),
              effectiveTo: r.effectiveTo ? String(r.effectiveTo) : null,
            })) satisfies RateRow[],
            userId: forUser,
            roleName: who?.role ?? null,
            companyId: data.companyId ?? null,
            /** 🔴 The day the work was done, never today. */
            onDate: data.entryDate,
          });

          if (resolved.found) {
            rateMinor = resolved.rateMinor;
            rated = true;
          }
        }

        const valueMinor = rated
          ? timeValueMinor({ billableMinutes: billable, rateMinorPerHour: rateMinor })
          : 0n;

        const [row] = await tx
          .insert(timeEntries)
          .values({
            tenantId: ctx.tenant.id,
            userId: forUser,
            companyId: data.companyId ?? null,
            subjectType: data.subjectType ?? null,
            subjectId: data.subjectId ?? null,
            subjectLabel: data.subjectLabel ?? null,
            entryDate: data.entryDate,
            minutes: data.minutes,
            billableMinutes: billable,
            isBillable: data.isBillable,
            rateMinor,
            valueMinor,
            narrative: data.narrative ?? null,
            status: "draft",
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .returning({ id: timeEntries.id });

        if (!row) throw new Error("The time entry could not be saved.");
        return { id: row.id, valueMinor: serializeAmount(valueMinor), rated };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/time");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "recordTimeEntry");
  }
}

const approveSchema = z.object({ entryIds: z.array(z.string().uuid()).min(1) });

/**
 * ⚠️ APPROVAL IS A SEPARATE PERMISSION AND A SEPARATE ACT. Approved time
 * is money the firm will stand behind on a bill; unapproved time is a
 * claim. Letting the person who recorded it approve it collapses that
 * distinction and the realisation figure stops being a control.
 */
export async function approveTimeEntries(
  input: unknown,
): Promise<ActionResult<{ approved: number }>> {
  try {
    const data = approveSchema.parse(input);
    const ctx = await requirePermission(APPROVE);

    const approved = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const rows = await tx
          .update(timeEntries)
          .set({
            status: "approved",
            approvedAt: new Date(),
            approvedBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .where(
            and(
              eq(timeEntries.tenantId, ctx.tenant.id),
              inArray(timeEntries.id, data.entryIds),
              /** ⚠️ Billed time cannot be re-approved — it has left. */
              inArray(timeEntries.status, ["draft", "submitted"]),
            ),
          )
          .returning({ id: timeEntries.id });

        if (rows.length > 0) {
          await writeAudit(ctx, {
            action: "update",
            resourceType: "time_entry",
            resourceId: null,
            newValue: { approved: rows.length },
            severity: "warning",
          });
        }
        return rows.length;
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/time");
    return { ok: true, data: { approved } };
  } catch (err) {
    return toSalesActionError(err, "approveTimeEntries");
  }
}

/**
 * ⭐ Write time off — the honest alternative to deleting it.
 *
 * 🔴 IT IS NEVER DELETED. An hour that was worked was worked. Erasing it
 * makes a person's utilisation look better than it was and removes the
 * only record that the firm gave something away. `written_off` keeps the
 * minutes and drops the value.
 */
export async function writeOffTimeEntries(
  input: unknown,
): Promise<ActionResult<{ writtenOff: number }>> {
  try {
    const data = approveSchema.parse(input);
    const ctx = await requirePermission(APPROVE);

    const writtenOff = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const rows = await tx
          .update(timeEntries)
          .set({
            status: "written_off",
            isBillable: false,
            billableMinutes: 0,
            valueMinor: 0n,
            updatedBy: ctx.user.id,
          })
          .where(
            and(
              eq(timeEntries.tenantId, ctx.tenant.id),
              inArray(timeEntries.id, data.entryIds),
              inArray(timeEntries.status, ["draft", "submitted", "approved"]),
            ),
          )
          .returning({ id: timeEntries.id });

        if (rows.length > 0) {
          await writeAudit(ctx, {
            action: "update",
            resourceType: "time_entry",
            resourceId: null,
            newValue: { writtenOff: rows.length },
            severity: "warning",
          });
        }
        return rows.length;
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/time");
    return { ok: true, data: { writtenOff } };
  } catch (err) {
    return toSalesActionError(err, "writeOffTimeEntries");
  }
}

/**
 * What is recorded and not yet on a bill.
 *
 * ⚠️ APPROVED AND PENDING ARE RETURNED SEPARATELY AND NEVER SUMMED —
 * approved time is invoiceable this week; pending time is a claim nobody
 * has stood behind, and some of it will be written down.
 */
export async function getUnbilledTime(input?: { companyId?: string }): Promise<
  ActionResult<{
    rows: {
      id: string;
      userName: string | null;
      companyId: string | null;
      companyName: string | null;
      subjectLabel: string | null;
      entryDate: string;
      minutes: number;
      billableMinutes: number;
      isBillable: boolean;
      rateMinor: string;
      valueMinor: string;
      narrative: string | null;
      status: string;
      rated: boolean;
    }[];
    summary: {
      approvedMinutes: number;
      approvedValueMinor: string;
      pendingMinutes: number;
      pendingValueMinor: string;
      nonBillableMinutes: number;
      realisationPercent: number | null;
      unratedCount: number;
    };
  }>
> {
  try {
    const ctx = await requirePermission(READ);

    const result = await withTenant(ctx.tenant.id, async (tx) => {
      const rows = await tx
        .select({
          id: timeEntries.id,
          userName: users.firstName,
          companyId: timeEntries.companyId,
          companyName: companies.name,
          subjectLabel: timeEntries.subjectLabel,
          entryDate: timeEntries.entryDate,
          minutes: timeEntries.minutes,
          billableMinutes: timeEntries.billableMinutes,
          isBillable: timeEntries.isBillable,
          rateMinor: timeEntries.rateMinor,
          valueMinor: timeEntries.valueMinor,
          narrative: timeEntries.narrative,
          status: timeEntries.status,
        })
        .from(timeEntries)
        .leftJoin(
          users,
          and(eq(users.id, timeEntries.userId), eq(users.tenantId, ctx.tenant.id)),
        )
        .leftJoin(
          companies,
          and(
            eq(companies.id, timeEntries.companyId),
            eq(companies.tenantId, ctx.tenant.id),
          ),
        )
        .where(
          and(
            eq(timeEntries.tenantId, ctx.tenant.id),
            /** ⚠️ Billed and written-off time is not "unbilled". */
            inArray(timeEntries.status, ["draft", "submitted", "approved"]),
            isNull(timeEntries.invoiceId),
            ...(input?.companyId ? [eq(timeEntries.companyId, input.companyId)] : []),
          ),
        )
        .orderBy(desc(timeEntries.entryDate))
        .limit(500);

      const mapped = rows.map((r) => ({
        id: r.id,
        userName: r.userName,
        companyId: r.companyId,
        companyName: r.companyName,
        subjectLabel: r.subjectLabel,
        entryDate: String(r.entryDate),
        minutes: r.minutes,
        billableMinutes: r.billableMinutes,
        isBillable: r.isBillable,
        rateMinor: serializeAmount(toBigIntAmount(r.rateMinor)),
        valueMinor: serializeAmount(toBigIntAmount(r.valueMinor)),
        narrative: r.narrative,
        status: r.status,
        /** ⚠️ Billable, but no rate applied — a question, not a zero. */
        rated: !(r.isBillable && toBigIntAmount(r.rateMinor) === 0n),
      }));

      const s = summariseUnbilled(
        rows.map((r) => ({
          id: r.id,
          isBillable: r.isBillable,
          status: r.status,
          billableMinutes: r.billableMinutes,
          valueMinor: toBigIntAmount(r.valueMinor),
        })),
      );

      return {
        rows: mapped,
        summary: {
          approvedMinutes: s.approvedMinutes,
          approvedValueMinor: serializeAmount(s.approvedValueMinor),
          pendingMinutes: s.pendingMinutes,
          pendingValueMinor: serializeAmount(s.pendingValueMinor),
          nonBillableMinutes: s.nonBillableMinutes,
          realisationPercent: realisationPercent({
            billableMinutes: s.approvedMinutes + s.pendingMinutes,
            totalMinutes: s.totalMinutes,
          }),
          unratedCount: mapped.filter((r) => !r.rated).length,
        },
      };
    });

    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "getUnbilledTime");
  }
}

export async function getBillingRates(): Promise<
  ActionResult<{
    rows: {
      id: string;
      userName: string | null;
      roleName: string | null;
      companyName: string | null;
      rateMinor: string;
      effectiveFrom: string;
      effectiveTo: string | null;
    }[];
  }>
> {
  try {
    const ctx = await requirePermission(READ);

    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select({
          id: billingRates.id,
          userName: users.firstName,
          roleName: billingRates.roleName,
          companyName: companies.name,
          rateMinor: billingRates.rateMinor,
          effectiveFrom: billingRates.effectiveFrom,
          effectiveTo: billingRates.effectiveTo,
        })
        .from(billingRates)
        .leftJoin(
          users,
          and(eq(users.id, billingRates.userId), eq(users.tenantId, ctx.tenant.id)),
        )
        .leftJoin(
          companies,
          and(
            eq(companies.id, billingRates.companyId),
            eq(companies.tenantId, ctx.tenant.id),
          ),
        )
        .where(eq(billingRates.tenantId, ctx.tenant.id))
        .orderBy(desc(billingRates.effectiveFrom)),
    );

    return {
      ok: true,
      data: {
        rows: rows.map((r) => ({
          id: r.id,
          userName: r.userName,
          roleName: r.roleName,
          companyName: r.companyName,
          rateMinor: serializeAmount(toBigIntAmount(r.rateMinor)),
          effectiveFrom: String(r.effectiveFrom),
          effectiveTo: r.effectiveTo ? String(r.effectiveTo) : null,
        })),
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getBillingRates");
  }
}

/* ================================================================== */
/* ⭐ TIME → INVOICE — Phase 64                                         */
/* ================================================================== */

const billTimeSchema = z.object({
  companyId: z.string().uuid(),
  entryIds: z.array(z.string().uuid()).min(1, "Choose at least one entry to bill."),
  invoiceDate: civilDay,
  dueDate: civilDay.nullish(),
  /** SAC code for the service. 9982 = legal, 9982x = accounting/professional. */
  sacCode: z.string().trim().max(10).optional(),
  taxRateBps: z.number().int().min(0).max(10000).default(1800),
  placeOfSupplyCode: z.string().trim().length(2).optional(),
  isInterState: z.boolean().default(false),
  /**
   * ⭐ ONE LINE PER MATTER, or one line per entry.
   *
   * ⚠️ A LITIGATION BILL WITH 240 LINES IS A BILL THAT GETS QUERIED. But
   * a client entitled to see the detail must be able to. Grouping is the
   * default; the narrative of every entry is still carried into the
   * invoice notes, so nothing is lost.
   */
  groupBySubject: z.boolean().default(true),
  notes: z.string().trim().max(2000).optional(),
  terms: z.string().trim().max(2000).optional(),
});

/**
 * ⭐⭐ TURN APPROVED TIME INTO A TAX INVOICE.
 *
 * 🔴 THE INVOICE AND THE MARKING-AS-BILLED HAPPEN IN ONE TRANSACTION.
 *    If the invoice were created and the entries not marked, the same
 *    hours would be billed again next month — and the client would be
 *    charged twice for work done once. That is the failure this whole
 *    function is shaped around.
 *
 * ⚠️ ONE CLIENT PER INVOICE, ENFORCED. Entries belonging to another
 * company are refused rather than silently dropped: a bill that quietly
 * excludes half of what was selected is worse than one that refuses.
 *
 * ⚠️ AND ONLY APPROVED TIME. Draft time is a claim nobody has stood
 * behind. Billing it means a partner discovers what was sent to a client
 * by reading the client's complaint.
 */
export async function raiseInvoiceFromTime(input: unknown): Promise<
  ActionResult<{ invoiceId: string; entriesBilled: number; totalMinor: string }>
> {
  try {
    const data = billTimeSchema.parse(input);
    const ctx = await requirePermission(WRITE);

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const entries = await tx
          .select({
            id: timeEntries.id,
            companyId: timeEntries.companyId,
            status: timeEntries.status,
            isBillable: timeEntries.isBillable,
            billableMinutes: timeEntries.billableMinutes,
            rateMinor: timeEntries.rateMinor,
            valueMinor: timeEntries.valueMinor,
            narrative: timeEntries.narrative,
            subjectLabel: timeEntries.subjectLabel,
            entryDate: timeEntries.entryDate,
            invoiceId: timeEntries.invoiceId,
          })
          .from(timeEntries)
          .where(
            and(
              eq(timeEntries.tenantId, ctx.tenant.id),
              inArray(timeEntries.id, data.entryIds),
            ),
          );

        if (entries.length === 0) throw new Error("None of those time entries exist.");

        /**
         * ⚠️ EVERY REFUSAL NAMES WHAT IS WRONG AND HOW MANY. "Some
         * entries could not be billed" sends somebody hunting through a
         * list of forty.
         */
        const wrongCompany = entries.filter((e) => e.companyId !== data.companyId);
        if (wrongCompany.length > 0) {
          throw new Error(
            `${wrongCompany.length} of the selected entries belong to a different client. One invoice bills one client — a bill mixing two is unreconcilable for both.`,
          );
        }

        const alreadyBilled = entries.filter(
          (e) => e.invoiceId !== null || e.status === "billed",
        );
        if (alreadyBilled.length > 0) {
          throw new Error(
            `${alreadyBilled.length} of these entries are already on an invoice. Billing them again would charge the client twice for the same hours.`,
          );
        }

        const notApproved = entries.filter((e) => e.status !== "approved");
        if (notApproved.length > 0) {
          throw new Error(
            `${notApproved.length} of these entries have not been approved. Approved time is what the firm will stand behind on a bill; unapproved time is a claim.`,
          );
        }

        const nonBillable = entries.filter((e) => !e.isBillable);
        if (nonBillable.length > 0) {
          throw new Error(
            `${nonBillable.length} of these entries are marked non-billable. They were written off deliberately.`,
          );
        }

        const unrated = entries.filter((e) => toBigIntAmount(e.rateMinor) === 0n);
        if (unrated.length > 0) {
          throw new Error(
            `${unrated.length} of these entries have no rate. A ₹0.00 line on a client's bill is not queried until the year-end review — set a rate and re-record them first.`,
          );
        }

        /**
         * ⭐ THE LINES. Grouped by matter, or one per entry.
         *
         * ⚠️ THE VALUE COMES FROM THE ENTRY, NOT FROM RE-PRICING. Each
         * hour already carries the rate that applied on the day it was
         * worked. Re-resolving the rate here would silently re-price a
         * year of unbilled work at today's card — the exact failure the
         * effective-dated rate table exists to prevent.
         */
        type Line = { label: string; minutes: number; valueMinor: bigint };
        const grouped = new Map<string, Line>();

        for (const e of entries) {
          const key = data.groupBySubject ? (e.subjectLabel ?? "Professional services") : e.id;
          const existing = grouped.get(key);
          const label = data.groupBySubject
            ? (e.subjectLabel ?? "Professional services")
            : `${String(e.entryDate)} — ${e.narrative ?? "Professional services"}`;

          if (existing) {
            existing.minutes += e.billableMinutes;
            existing.valueMinor += toBigIntAmount(e.valueMinor);
          } else {
            grouped.set(key, {
              label,
              minutes: e.billableMinutes,
              valueMinor: toBigIntAmount(e.valueMinor),
            });
          }
        }

        const lines = [...grouped.values()];

        /**
         * ⚠️ QUANTITY IS HOURS TO THREE DECIMALS, PRICE IS THE LINE
         * VALUE DIVIDED BY IT — and the DISCOUNT absorbs the rounding.
         *
         * 🔴 A line of 2.4 hours worth ₹19,200 has a clean unit price.
         * A line of 2.567 hours does not, and `unit price × quantity`
         * would not equal the value the time entries actually carry.
         * Rather than let the invoice disagree with the timesheet by a
         * few paise, the quantity is ONE and the unit price IS the line
         * value. The hours are stated in the description, where a client
         * reads them anyway.
         */
        const built = buildInvoice({
          orderLines: lines.map((l, i) => ({
            id: `t-${i}`,
            lineNo: i + 1,
            description: `${l.label} — ${minutesToHoursLabel(l.minutes)} hrs`,
            uom: "hrs",
            quantity: "1.000",
            qtyInvoiced: "0.000",
            qtyCancelled: "0.000",
            unitPriceMinor: l.valueMinor,
            discountMinor: 0n,
            taxRateBps: data.taxRateBps,
            cessRateBps: 0,
            /** SAC, not HSN — this is a service. */
            hsnSacCode: data.sacCode ?? "9982",
          })),
          selection: lines.map((_, i) => ({ orderLineId: `t-${i}` })),
          taxKind: data.isInterState ? "igst" : "cgst_sgst",
          placeOfSupplyCode: data.placeOfSupplyCode ?? "27",
        });

        const [company] = await tx
          .select({ name: companies.name })
          .from(companies)
          .where(
            and(eq(companies.tenantId, ctx.tenant.id), eq(companies.id, data.companyId)),
          )
          .limit(1);

        const [invoice] = await tx
          .insert(salesInvoices)
          .values({
            tenantId: ctx.tenant.id,
            /** ⚠️ A draft carries a placeholder — Rule 46(b) numbering happens at issue. */
            invoiceNumber: `DRAFT-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
            financialYear: data.invoiceDate.slice(0, 4),
            status: "draft",
            companyId: data.companyId,
            invoiceDate: data.invoiceDate,
            dueDate: data.dueDate ?? null,
            customerLegalName: company?.name ?? null,
            placeOfSupplyCode: data.placeOfSupplyCode ?? null,
            isInterState: data.isInterState,
            isUnionTerritory: false,
            /** 🔴 SERVICES, not goods — it changes the Rule 48 copy count. */
            supplyType: "services",
            subtotalMinor: built.tax.grossMinor,
            discountMinor: built.tax.discountMinor,
            taxableValueMinor: built.tax.taxableMinor,
            cgstMinor: built.tax.cgstMinor,
            sgstMinor: built.tax.sgstMinor,
            igstMinor: built.tax.igstMinor,
            cessMinor: built.tax.cessMinor,
            roundOffMinor: built.tax.roundOffMinor,
            totalMinor: built.tax.amountPayableMinor,
            notes: data.notes ?? null,
            terms: data.terms ?? null,
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .returning({ id: salesInvoices.id });

        if (!invoice) throw new Error("The invoice could not be created.");

        const byKey = new Map(built.tax.lines.map((l) => [l.key, l]));
        await tx.insert(salesInvoiceLines).values(
          built.lines.map((l, i) => {
            const c = byKey.get(l.orderLineId);
            return {
              tenantId: ctx.tenant.id,
              invoiceId: invoice.id,
              lineNo: i + 1,
              description: l.description,
              hsnSacCode: l.hsnSacCode,
              taxRateBps: l.taxRateBps,
              quantity: l.quantity,
              uom: l.uom,
              unitPriceMinor: l.unitPriceMinor,
              discountMinor: l.discountMinor,
              taxableValueMinor: c?.taxableMinor ?? 0n,
              cgstMinor: c?.cgstMinor ?? 0n,
              sgstMinor: c?.sgstMinor ?? 0n,
              igstMinor: c?.igstMinor ?? 0n,
              cessMinor: c?.cessMinor ?? 0n,
              lineTotalMinor:
                (c?.taxableMinor ?? 0n) +
                (c?.cgstMinor ?? 0n) +
                (c?.sgstMinor ?? 0n) +
                (c?.igstMinor ?? 0n),
            };
          }),
        );

        /**
         * 🔴 THE LINE THAT PREVENTS DOUBLE-BILLING, AND IT IS INSIDE THE
         *    SAME TRANSACTION AS THE INVOICE ABOVE.
         *
         * ⚠️ The database also refuses the inconsistent state —
         * `time_entries_billed_has_invoice` in 0053 requires
         * `(status = 'billed') = (invoice_id IS NOT NULL)`. So a partial
         * write cannot survive COMMIT even if this code were wrong.
         */
        const marked = await tx
          .update(timeEntries)
          .set({
            status: "billed",
            invoiceId: invoice.id,
            updatedBy: ctx.user.id,
          })
          .where(
            and(
              eq(timeEntries.tenantId, ctx.tenant.id),
              inArray(timeEntries.id, data.entryIds),
              eq(timeEntries.status, "approved"),
            ),
          )
          .returning({ id: timeEntries.id });

        /**
         * ⚠️ IF THE COUNTS DISAGREE, THE WHOLE THING ROLLS BACK. Two
         * people billing the same entries in the same second would each
         * see them approved and each try to bill them; one update wins
         * and the other marks fewer rows than it selected. Throwing here
         * turns a double bill into a retry.
         */
        if (marked.length !== entries.length) {
          throw new Error(
            `Only ${marked.length} of ${entries.length} entries could be marked billed — somebody may be billing the same time right now. Nothing has been saved; please try again.`,
          );
        }

        await writeAudit(ctx, {
          action: "create",
          resourceType: "sales_invoice",
          resourceId: invoice.id,
          newValue: {
            fromTimeEntries: entries.length,
            totalMinor: serializeAmount(built.tax.amountPayableMinor),
          },
          severity: "warning",
        });

        return {
          invoiceId: invoice.id,
          entriesBilled: marked.length,
          totalMinor: serializeAmount(built.tax.amountPayableMinor),
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/time");
    revalidatePath("/invoices");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "raiseInvoiceFromTime");
  }
}
