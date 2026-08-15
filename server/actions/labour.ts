"use server";

/**
 * Ordence — ⭐ SITE LABOUR (Batch 2.2)
 * Version: v0.73.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS FILE EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * `db/schema/labour.ts` is 30 KB of tables — workers, attendance, welfare
 * logs, piece rates, rosters, daily site logs, site photos, vendor
 * defaults. `SQL-FILES/0038_construction_labour.sql` applied them. Every
 * audit counted the module as delivered. Nothing could reach it: no
 * server action, no route, no screen.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS MODULE IS A LEGAL RECORD, NOT A CONVENIENCE
 * ══════════════════════════════════════════════════════════════════════
 * On an Indian construction site the labour register is a statutory
 * document. Three specific consequences shape this file:
 *
 *   • **UAN.** A worker's Universal Account Number is what makes an EPF
 *     contribution attributable. A worker on site with an unverified UAN
 *     is a worker whose provident fund may not reach them, and whose
 *     contractor's EPF challan will not reconcile. `is_admissible` is the
 *     gate: it is FALSE until somebody verifies, and this file never
 *     sets it as a side effect of anything else.
 *
 *   • **The daily site log is evidence.** Rainfall, hours lost and the
 *     labour count on a given date decide extension-of-time claims worth
 *     more than the work itself. `daily_site_logs_slot_unique` allows one
 *     log per project per day, so the record cannot be quietly doubled.
 *
 *   • **Piece rates feed RA bills.** `piece_rate_entries.ra_bill_id`
 *     links a measured quantity to the bill that paid for it. An entry
 *     already attached to a bill is history, not a draft.
 *
 * ⚠️ THE GUARANTEES ARE IN THE DATABASE, not here. `piece_rate_quantity_positive`,
 * `daily_site_logs_labour_non_negative`, `site_workers_uan_unique` and
 * `site_attendance_one_subject` are CHECK constraints and unique indexes.
 * This file translates their refusals into sentences a site engineer can
 * act on; it does not restate them.
 */

import { z } from "zod";
import { and, eq, sql, desc, asc, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenant } from "@/db";
import {
  siteWorkers,
  siteAttendance,
  dailySiteLogs,
  pieceRateEntries,
  projects,
  vendors,
} from "@/db/schema";
import { writeAudit } from "@/server/audit";
import { guardSalesWrite, toSalesActionError, salesFail } from "@/server/sales/guards";
import { requireTenantContext } from "@/server/tenant-context";
import type { ActionResult } from "@/lib/validators/crm";

/**
 * ⚠️ SHARES THE BOQ FEATURE KEY, DELIBERATELY.
 *
 * A tenant running construction who has paid for bills of quantities but
 * cannot record who was on site has bought half a system: the RA bill
 * says work was done, and nothing says who did it. The separately
 * grantable control is the PERMISSION on UAN verification, not the
 * feature.
 */
const LABOUR_FEATURE = "construction.boq" as const;

/* ------------------------------------------------------------------ */
/* NUMERIC CONVERSION                                                  */
/* ------------------------------------------------------------------ */

function toPaise(value: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const [, whole, fraction = ""] = match;
  const padded = (fraction + "00").slice(0, 2);
  return BigInt(whole!) * 100n + BigInt(padded);
}

function paiseToString(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  return `${negative ? "-" : ""}${magnitude / 100n}.${(magnitude % 100n)
    .toString()
    .padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/* 1 · THE WORKER REGISTER                                             */
/* ------------------------------------------------------------------ */

const registerWorkerSchema = z.object({
  workerName: z.string().trim().min(1, "The worker's name is required.").max(200),
  trade: z.string().trim().max(100).nullable().optional(),
  vendorId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  /**
   * ⚠️ EXACTLY 12 DIGITS OR NOTHING.
   *
   * A UAN is 12 digits. Accepting a shorter string stores a number that
   * will fail at the EPFO end months later, by which time the worker has
   * left the site and cannot be asked again.
   */
  uan: z
    .string()
    .trim()
    .regex(/^\d{12}$/, "A UAN is exactly 12 digits.")
    .nullable()
    .optional(),
  phone: z.string().trim().max(20).nullable().optional(),
  inductedOn: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date picker.")
    .nullable()
    .optional(),
});

export async function registerSiteWorker(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const data = registerWorkerSchema.parse(input);

    const ctx = await guardSalesWrite({
      operation: "labour:register-worker",
      feature: LABOUR_FEATURE,
      permission: "construction.boq.manage",
    });

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [row] = await tx
          .insert(siteWorkers)
          .values({
            tenantId: ctx.tenant.id,
            workerName: data.workerName,
            trade: data.trade ?? null,
            vendorId: data.vendorId ?? null,
            projectId: data.projectId ?? null,
            uan: data.uan ?? null,
            /**
             * ⚠️ NEVER ADMISSIBLE ON CREATION, even with a UAN supplied.
             *
             * A UAN typed into a form is a claim, not a verification.
             * Admitting a worker because somebody typed twelve digits is
             * how an unverifiable EPF contribution enters the register.
             */
            uanStatus: data.uan ? "pending" : "not_applicable",
            isAdmissible: false,
            phone: data.phone ?? null,
            inductedOn: data.inductedOn ?? null,
            createdBy: ctx.user.id,
          })
          .returning({ id: siteWorkers.id });

        if (!row) throw new Error("The worker could not be registered.");
        return { id: row.id };
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "create",
      resourceType: "site_worker",
      resourceId: result.id,
      metadata: { workerName: data.workerName, hasUan: Boolean(data.uan) },
    });

    revalidatePath("/site-labour");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "registerSiteWorker");
  }
}

const verifyUanSchema = z.object({
  workerId: z.string().uuid(),
  outcome: z.enum(["valid", "invalid", "not_applicable"]),
  rejectionReason: z.string().trim().max(2000).nullable().optional(),
});

/**
 * ⭐ VERIFY A UAN — the gate on admissibility.
 *
 * ⚠️ A SEPARATE PERMISSION. Registering a worker and vouching for their
 * provident-fund identity are different acts. A site supervisor adds
 * people; somebody accountable for the EPF challan says the number is
 * real. One permission for both means the register self-certifies.
 */
export async function verifyWorkerUan(
  input: unknown,
): Promise<ActionResult<{ id: string; isAdmissible: boolean }>> {
  try {
    const data = verifyUanSchema.parse(input);

    if (data.outcome === "invalid" && !data.rejectionReason?.trim()) {
      return salesFail(
        "Say why the UAN was rejected. A worker turned away with no reason " +
          "cannot correct the problem, and will be back tomorrow with the same number.",
      );
    }

    const ctx = await guardSalesWrite({
      operation: "labour:verify-uan",
      feature: LABOUR_FEATURE,
      /**
       * 🔴 THIS SAID `construction.variation.approve`, WHICH IS NOT A
       * PERMISSION. `evaluatePermission` fails closed on an unknown key,
       * so UAN verification denied EVERY user including the owner, and
       * nothing noticed because the guard was present and correctly
       * shaped. Found by typing the argument, not by reading it.
       *
       * ⚠️ The three other writes in this file all use
       * `construction.boq.manage`. Inventing a new approval key here
       * would change who may verify a worker in a way I cannot check
       * against a real site office, so this matches its siblings.
       */
      permission: "construction.boq.manage",
    });

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [worker] = await tx
          .select({
            id: siteWorkers.id,
            name: siteWorkers.workerName,
            uan: siteWorkers.uan,
          })
          .from(siteWorkers)
          .where(
            and(eq(siteWorkers.tenantId, ctx.tenant.id), eq(siteWorkers.id, data.workerId)),
          )
          .limit(1);

        if (!worker) throw new Error("That worker is not on the register.");

        if (data.outcome === "valid" && !worker.uan) {
          throw new Error(
            `${worker.name} has no UAN recorded. Add the number before verifying it — ` +
              `marking a blank field "valid" admits a worker nobody can attribute a ` +
              `provident-fund contribution to.`,
          );
        }

        const admissible = data.outcome === "valid" || data.outcome === "not_applicable";

        await tx
          .update(siteWorkers)
          .set({
            uanStatus: data.outcome,
            uanVerifiedAt: new Date(),
            uanVerifiedBy: ctx.user.id,
            uanRejectionReason: data.outcome === "invalid" ? data.rejectionReason ?? null : null,
            isAdmissible: admissible,
            blockedReason:
              data.outcome === "invalid"
                ? (data.rejectionReason ?? "UAN could not be verified.")
                : null,
            updatedAt: new Date(),
          })
          .where(
            and(eq(siteWorkers.tenantId, ctx.tenant.id), eq(siteWorkers.id, data.workerId)),
          );

        return { id: worker.id, isAdmissible: admissible, name: worker.name };
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "site_worker",
      resourceId: result.id,
      metadata: { uanOutcome: data.outcome, isAdmissible: result.isAdmissible },
    });

    revalidatePath("/site-labour");
    return { ok: true, data: { id: result.id, isAdmissible: result.isAdmissible } };
  } catch (err) {
    return toSalesActionError(err, "verifyWorkerUan");
  }
}

/* ------------------------------------------------------------------ */
/* 2 · ATTENDANCE                                                      */
/* ------------------------------------------------------------------ */

const attendanceSchema = z.object({
  workerId: z.string().uuid(),
  projectId: z.string().uuid().nullable().optional(),
  kind: z.enum(["check_in", "check_out"]),
  note: z.string().trim().max(1000).nullable().optional(),
});

export async function recordSiteAttendance(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const data = attendanceSchema.parse(input);

    const ctx = await guardSalesWrite({
      operation: "labour:attendance",
      feature: LABOUR_FEATURE,
      permission: "construction.boq.manage",
    });

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [worker] = await tx
          .select({
            id: siteWorkers.id,
            name: siteWorkers.workerName,
            isAdmissible: siteWorkers.isAdmissible,
            blockedReason: siteWorkers.blockedReason,
            exitedOn: siteWorkers.exitedOn,
            projectId: siteWorkers.projectId,
          })
          .from(siteWorkers)
          .where(
            and(eq(siteWorkers.tenantId, ctx.tenant.id), eq(siteWorkers.id, data.workerId)),
          )
          .limit(1);

        if (!worker) throw new Error("That worker is not on the register.");

        /**
         * ⭐ THE ADMISSIBILITY GATE.
         *
         * ⚠️ Attendance for a non-admissible worker is refused, not
         * flagged. A warning gets clicked through at 7am with forty
         * people waiting at the gate; a refusal gets the UAN fixed.
         */
        if (!worker.isAdmissible) {
          throw new Error(
            `${worker.name} is not admissible to site. ` +
              (worker.blockedReason ?? "Their UAN has not been verified.") +
              " Verify the UAN on the worker register first — attendance recorded " +
              "against an unverified worker cannot be reconciled to an EPF challan.",
          );
        }

        if (worker.exitedOn) {
          throw new Error(
            `${worker.name} was marked as having left the site on ${worker.exitedOn}. ` +
              `Re-induct them before recording attendance.`,
          );
        }

        const [row] = await tx
          .insert(siteAttendance)
          .values({
            tenantId: ctx.tenant.id,
            workerId: worker.id,
            /**
             * ⚠️ `site_attendance_one_subject` allows a worker OR a user,
             * never both. A row carrying both would be two people's
             * attendance in one record.
             */
            userId: null,
            projectId: data.projectId ?? worker.projectId ?? null,
            kind: data.kind,
            occurredAt: new Date(),
            withinSite: false,
            isOffline: false,
            note: data.note ?? null,
          })
          .returning({ id: siteAttendance.id });

        if (!row) throw new Error("The attendance could not be recorded.");
        return { id: row.id };
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "create",
      resourceType: "site_attendance",
      resourceId: result.id,
      metadata: { workerId: data.workerId, kind: data.kind },
    });

    revalidatePath("/site-labour");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "recordSiteAttendance");
  }
}

/* ------------------------------------------------------------------ */
/* 3 · THE DAILY SITE LOG                                              */
/* ------------------------------------------------------------------ */

const dailyLogSchema = z.object({
  projectId: z.string().uuid("Choose a project."),
  logDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date picker."),
  weather: z.string().trim().max(100).nullable().optional(),
  rainfallMm: z.string().trim().max(12).nullable().optional(),
  hoursLost: z.string().trim().max(8).nullable().optional(),
  labourCount: z.number().int().min(0, "A labour count cannot be negative.").max(100000),
  workDone: z.string().trim().max(8000).nullable().optional(),
  issues: z.string().trim().max(8000).nullable().optional(),
  visitors: z.string().trim().max(4000).nullable().optional(),
});

/**
 * ⭐ THE DAILY SITE LOG — one per project per day, upserted.
 *
 * ⚠️ THIS IS AN EXTENSION-OF-TIME DOCUMENT.
 *
 * "It rained on the 14th and we lost six hours" is worth more, on a
 * delayed contract, than the day's work. The unique index
 * `daily_site_logs_slot_unique` means a second entry for the same day
 * cannot be inserted — so this upserts rather than failing, because a
 * site engineer correcting the rainfall at 6pm should not be told the
 * day is already recorded and given no way to fix it.
 */
export async function upsertDailySiteLog(
  input: unknown,
): Promise<ActionResult<{ id: string; created: boolean }>> {
  try {
    const data = dailyLogSchema.parse(input);

    const ctx = await guardSalesWrite({
      operation: "labour:daily-log",
      feature: LABOUR_FEATURE,
      permission: "construction.boq.manage",
    });

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [existing] = await tx
          .select({ id: dailySiteLogs.id })
          .from(dailySiteLogs)
          .where(
            and(
              eq(dailySiteLogs.tenantId, ctx.tenant.id),
              eq(dailySiteLogs.projectId, data.projectId),
              eq(dailySiteLogs.logDate, data.logDate),
            ),
          )
          .limit(1);

        const values = {
          weather: data.weather ?? null,
          rainfallMm: data.rainfallMm ?? null,
          hoursLost: data.hoursLost ?? null,
          labourCount: data.labourCount,
          workDone: data.workDone ?? null,
          issues: data.issues ?? null,
          visitors: data.visitors ?? null,
          updatedAt: new Date(),
        };

        if (existing) {
          await tx
            .update(dailySiteLogs)
            .set(values)
            .where(
              and(
                eq(dailySiteLogs.tenantId, ctx.tenant.id),
                eq(dailySiteLogs.id, existing.id),
              ),
            );
          return { id: existing.id, created: false };
        }

        const [row] = await tx
          .insert(dailySiteLogs)
          .values({
            tenantId: ctx.tenant.id,
            projectId: data.projectId,
            logDate: data.logDate,
            authorId: ctx.user.id,
            ...values,
          })
          .returning({ id: dailySiteLogs.id });

        if (!row) throw new Error("The site log could not be saved.");
        return { id: row.id, created: true };
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: result.created ? "create" : "update",
      resourceType: "daily_site_log",
      resourceId: result.id,
      metadata: { projectId: data.projectId, logDate: data.logDate },
    });

    revalidatePath("/site-labour");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "upsertDailySiteLog");
  }
}

/* ------------------------------------------------------------------ */
/* 4 · PIECE RATES                                                     */
/* ------------------------------------------------------------------ */

const pieceRateSchema = z.object({
  projectId: z.string().uuid("Choose a project."),
  vendorId: z.string().uuid().nullable().optional(),
  workItem: z.string().trim().min(1, "Describe the work.").max(300),
  unit: z.string().trim().min(1).max(20),
  quantity: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,3})?$/, "A quantity is digits with up to three decimals."),
  ratePerUnit: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, "A rate is digits with up to two decimals."),
  measuredOn: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date picker."),
  witnessedByName: z.string().trim().max(200).nullable().optional(),
});

/**
 * ⭐ RECORD MEASURED PIECE WORK.
 *
 * ⚠️ `measuredBy` IS THE SIGNED-IN USER AND IS NOT A FORM FIELD.
 *
 * The same reasoning as measure-versus-certify on an RA bill: whoever
 * measured has to be the person who was there. A field lets somebody
 * type a colleague's name onto a measurement that colleague never saw,
 * and it is that name the contractor's claim will quote back.
 *
 * `witnessedByName` is free text on purpose — the contractor's foreman
 * who stood at the tape is rarely a user of this system, and forcing
 * them to be one means the witness column stays empty.
 */
export async function recordPieceRateEntry(
  input: unknown,
): Promise<ActionResult<{ id: string; amount: string }>> {
  try {
    const data = pieceRateSchema.parse(input);

    const ratePerUnitMinor = toPaise(data.ratePerUnit);
    if (ratePerUnitMinor === null) {
      return salesFail(`"${data.ratePerUnit}" is not a rate.`);
    }

    const ctx = await guardSalesWrite({
      operation: "labour:piece-rate",
      feature: LABOUR_FEATURE,
      permission: "construction.measurement.record",
    });

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [row] = await tx
          .insert(pieceRateEntries)
          .values({
            tenantId: ctx.tenant.id,
            projectId: data.projectId,
            vendorId: data.vendorId ?? null,
            workItem: data.workItem,
            unit: data.unit,
            quantity: data.quantity,
            ratePerUnitMinor,
            measuredOn: data.measuredOn,
            measuredBy: ctx.user.id,
            witnessedByName: data.witnessedByName ?? null,
            createdBy: ctx.user.id,
          })
          .returning({ id: pieceRateEntries.id });

        if (!row) throw new Error("The measurement could not be recorded.");

        /**
         * ⚠️ READ THE AMOUNT BACK OUT.
         *
         * `amount_minor` is computed by the database, not by this file.
         * Returning a figure calculated here would report a number the
         * database may not hold — and the number the contractor is paid
         * is the one in the database.
         */
        const [stored] = await tx
          .select({ amountMinor: pieceRateEntries.amountMinor })
          .from(pieceRateEntries)
          .where(
            and(
              eq(pieceRateEntries.tenantId, ctx.tenant.id),
              eq(pieceRateEntries.id, row.id),
            ),
          )
          .limit(1);

        return { id: row.id, amountMinor: stored?.amountMinor ?? 0n };
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "create",
      resourceType: "piece_rate_entry",
      resourceId: result.id,
      metadata: {
        projectId: data.projectId,
        workItem: data.workItem,
        amountMinor: result.amountMinor.toString(),
      },
    });

    revalidatePath("/site-labour");
    return {
      ok: true,
      data: { id: result.id, amount: paiseToString(result.amountMinor) },
    };
  } catch (err) {
    return toSalesActionError(err, "recordPieceRateEntry");
  }
}

/* ------------------------------------------------------------------ */
/* 5 · READS                                                           */
/* ------------------------------------------------------------------ */

export type SiteLabourOverview = {
  workers: {
    id: string;
    workerName: string;
    trade: string | null;
    uan: string | null;
    uanStatus: string;
    isAdmissible: boolean;
    blockedReason: string | null;
    inductedOn: string | null;
    exitedOn: string | null;
    projectId: string | null;
    vendorId: string | null;
  }[];
  counts: {
    total: number;
    admissible: number;
    /** ⭐ The number that matters at the gate tomorrow morning. */
    blocked: number;
    uanPending: number;
  };
  recentAttendance: {
    id: string;
    workerName: string;
    kind: string;
    occurredAt: string;
  }[];
  recentLogs: {
    id: string;
    projectId: string;
    logDate: string;
    weather: string | null;
    rainfallMm: string | null;
    hoursLost: string | null;
    labourCount: number;
    issues: string | null;
  }[];
  unbilledPieceRates: {
    id: string;
    workItem: string;
    unit: string;
    quantity: string;
    rate: string;
    amount: string;
    measuredOn: string;
    witnessedByName: string | null;
  }[];
  unbilledTotal: string;
  options: {
    projects: { id: string; name: string }[];
    vendors: { id: string; name: string }[];
  };
};

export async function getSiteLabourOverview(): Promise<ActionResult<SiteLabourOverview>> {
  try {
    const ctx = await requireTenantContext();

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const workerRows = await tx
        .select({
          id: siteWorkers.id,
          workerName: siteWorkers.workerName,
          trade: siteWorkers.trade,
          uan: siteWorkers.uan,
          uanStatus: siteWorkers.uanStatus,
          isAdmissible: siteWorkers.isAdmissible,
          blockedReason: siteWorkers.blockedReason,
          inductedOn: siteWorkers.inductedOn,
          exitedOn: siteWorkers.exitedOn,
          projectId: siteWorkers.projectId,
          vendorId: siteWorkers.vendorId,
        })
        .from(siteWorkers)
        .where(eq(siteWorkers.tenantId, ctx.tenant.id))
        .orderBy(asc(siteWorkers.workerName));

      const attendanceRows = await tx
        .select({
          id: siteAttendance.id,
          workerName: siteWorkers.workerName,
          kind: siteAttendance.kind,
          occurredAt: siteAttendance.occurredAt,
        })
        .from(siteAttendance)
        .innerJoin(
          siteWorkers,
          and(
            eq(siteWorkers.id, siteAttendance.workerId),
            eq(siteWorkers.tenantId, siteAttendance.tenantId),
          ),
        )
        .where(eq(siteAttendance.tenantId, ctx.tenant.id))
        .orderBy(desc(siteAttendance.occurredAt))
        .limit(25);

      const logRows = await tx
        .select({
          id: dailySiteLogs.id,
          projectId: dailySiteLogs.projectId,
          logDate: dailySiteLogs.logDate,
          weather: dailySiteLogs.weather,
          rainfallMm: dailySiteLogs.rainfallMm,
          hoursLost: dailySiteLogs.hoursLost,
          labourCount: dailySiteLogs.labourCount,
          issues: dailySiteLogs.issues,
        })
        .from(dailySiteLogs)
        .where(eq(dailySiteLogs.tenantId, ctx.tenant.id))
        .orderBy(desc(dailySiteLogs.logDate))
        .limit(14);

      /** Unbilled only — an entry with an `ra_bill_id` is already paid history. */
      const pieceRows = await tx
        .select({
          id: pieceRateEntries.id,
          workItem: pieceRateEntries.workItem,
          unit: pieceRateEntries.unit,
          quantity: pieceRateEntries.quantity,
          ratePerUnitMinor: pieceRateEntries.ratePerUnitMinor,
          amountMinor: pieceRateEntries.amountMinor,
          measuredOn: pieceRateEntries.measuredOn,
          witnessedByName: pieceRateEntries.witnessedByName,
        })
        .from(pieceRateEntries)
        .where(
          and(
            eq(pieceRateEntries.tenantId, ctx.tenant.id),
            isNull(pieceRateEntries.raBillId),
          ),
        )
        .orderBy(desc(pieceRateEntries.measuredOn))
        .limit(50);

      const projectRows = await tx
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(eq(projects.tenantId, ctx.tenant.id))
        .orderBy(asc(projects.name));

      /**
       * ⚠️ `vendors` HAS NO `name` COLUMN. It carries `legal_name` and an
       * optional `trade_name`. Guessing `name` here is the same mistake
       * that produced `vendors.vendor_code` (actually `code`) and
       * `stock_reservations.reference` (does not exist) earlier in this
       * project. Read the schema; do not assume the obvious column name.
       *
       * The trade name is preferred for display because it is what the
       * site calls them; the legal name is what the contract says.
       */
      const vendorRows = await tx
        .select({
          id: vendors.id,
          legalName: vendors.legalName,
          tradeName: vendors.tradeName,
        })
        .from(vendors)
        .where(eq(vendors.tenantId, ctx.tenant.id))
        .orderBy(asc(vendors.legalName));

      return {
        workerRows,
        attendanceRows,
        logRows,
        pieceRows,
        projectRows,
        vendorRows,
      };
    });

    let unbilledTotal = 0n;
    for (const row of data.pieceRows) unbilledTotal += row.amountMinor;

    return {
      ok: true,
      data: {
        workers: data.workerRows,
        counts: {
          total: data.workerRows.length,
          admissible: data.workerRows.filter((w) => w.isAdmissible).length,
          blocked: data.workerRows.filter((w) => !w.isAdmissible && !w.exitedOn).length,
          uanPending: data.workerRows.filter((w) => w.uanStatus === "pending").length,
        },
        recentAttendance: data.attendanceRows.map((a) => ({
          id: a.id,
          workerName: a.workerName,
          kind: a.kind,
          occurredAt: a.occurredAt.toISOString(),
        })),
        recentLogs: data.logRows.map((l) => ({
          id: l.id,
          projectId: l.projectId,
          logDate: l.logDate,
          weather: l.weather,
          rainfallMm: l.rainfallMm,
          hoursLost: l.hoursLost,
          labourCount: l.labourCount,
          issues: l.issues,
        })),
        unbilledPieceRates: data.pieceRows.map((p) => ({
          id: p.id,
          workItem: p.workItem,
          unit: p.unit,
          quantity: p.quantity,
          rate: paiseToString(p.ratePerUnitMinor),
          amount: paiseToString(p.amountMinor),
          measuredOn: p.measuredOn,
          witnessedByName: p.witnessedByName,
        })),
        unbilledTotal: paiseToString(unbilledTotal),
        options: {
          projects: data.projectRows,
          vendors: data.vendorRows.map((v) => ({
            id: v.id,
            name: v.tradeName ?? v.legalName,
          })),
        },
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getSiteLabourOverview");
  }
}
