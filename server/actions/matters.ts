"use server";

/**
 * Ordence — ⭐⭐ MATTERS, LIMITATION AND THE DIARY
 * Version: v1.7.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT. The
 * statute lives in `lib/legal/limitation.ts`, which is pure and has no
 * clock.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE LIMITATION DATE IS COMPUTED, NEVER TYPED
 * ══════════════════════════════════════════════════════════════════════
 * A field where somebody enters the expiry is a field where somebody
 * enters last year's arithmetic, or the filing date plus three, or the
 * date from the matter they copied it from. It is derived from the
 * cause-of-action date and the Article, with the workings kept.
 */

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import {
  legalMatters,
  legalMatterEvents,
  legalHearings,
  courtHolidays,
} from "@/db/schema/legal";
import { companies } from "@/db/schema/crm";
import { users } from "@/db/schema/core";
import { requirePermission, writeAudit } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import {
  LIMITATION_ARTICLES,
  applyAcknowledgement,
  chequeDishonourDeadlines,
  computeLimitation,
  limitationHealth,
} from "@/lib/legal/limitation";
import { serializeAmount, toBigIntAmount } from "@/lib/billing/money";
import type { ActionResult } from "@/lib/validators/crm";

const READ = "sales.invoices.read" as const;
const WRITE = "sales.invoices.create" as const;

const civilDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Every court holiday the workspace knows about, as civil days. */
async function holidaysFor(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
  courtName: string | null,
): Promise<string[]> {
  const rows = await tx
    .select({ d: courtHolidays.holidayDate, court: courtHolidays.courtName })
    .from(courtHolidays)
    .where(eq(courtHolidays.tenantId, tenantId))
    .limit(5000);
  /**
   * ⚠️ MATCHED BY COURT NAME WHERE ONE IS GIVEN. A High Court vacation
   * does not close a district court, and applying one to the other moves
   * a deadline that never moved.
   */
  return rows
    .filter((r) => !courtName || r.court === courtName)
    .map((r) => String(r.d));
}

/* ================================================================== */
/* ① CREATE / UPDATE A MATTER                                          */
/* ================================================================== */

const matterSchema = z.object({
  matterNo: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(500),
  companyId: z.string().uuid().nullish(),
  matterType: z
    .enum([
      "litigation",
      "arbitration",
      "advisory",
      "transaction",
      "compliance",
      "notice",
      "execution",
      "appeal",
    ])
    .default("litigation"),
  ourSide: z.string().trim().max(30).nullish(),
  opposingParty: z.string().trim().max(500).nullish(),
  courtName: z.string().trim().max(255).nullish(),
  jurisdiction: z.string().trim().max(120).nullish(),
  caseNumber: z.string().trim().max(120).nullish(),
  filingDate: civilDay.nullish(),
  causeOfActionDate: civilDay.nullish(),
  limitationArticle: z.string().trim().max(40).nullish(),
  /** ⚠️ s.12(2) — days spent obtaining a certified copy. */
  excludedDays: z.number().int().min(0).max(3650).default(0),
  responsibleUserId: z.string().uuid().nullish(),
  notes: z.string().trim().max(4000).optional(),
});

/**
 * ⭐⭐ OPEN A MATTER, AND WORK OUT WHEN THE CLAIM DIES.
 *
 * 🔴 A CONTENTIOUS MATTER WITHOUT A CAUSE-OF-ACTION DATE IS REFUSED.
 *    Without it there is no limitation date, and a matter with no
 *    limitation date never appears on the report that would have saved
 *    it. Advisory and transactional work is exempt — nothing is being
 *    sued on.
 */
export async function saveMatter(input: unknown): Promise<
  ActionResult<{
    id: string;
    limitationExpiresOn: string | null;
    workings: string[];
    extendedByCourtClosure: boolean;
  }>
> {
  try {
    const data = matterSchema.parse(input);
    const ctx = await requirePermission(WRITE);

    const contentious = !["advisory", "transaction", "compliance"].includes(
      data.matterType,
    );
    if (contentious && !data.causeOfActionDate) {
      throw new Error(
        "A contentious matter needs the date the cause of action arose — the day the contract was broken, the goods delivered, the demand made. Without it there is no limitation date, and a matter with no limitation date never appears on the report that would have caught it.",
      );
    }

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        let expiresOn: string | null = null;
        let workings: string[] = [];
        let extended = false;

        if (data.causeOfActionDate && data.limitationArticle) {
          const holidays = await holidaysFor(
            tx,
            ctx.tenant.id,
            data.courtName ?? null,
          );
          const computed = computeLimitation({
            articleKey: data.limitationArticle,
            causeOfActionDate: data.causeOfActionDate,
            courtHolidays: holidays,
            excludedDays: data.excludedDays,
          });
          expiresOn = computed.expiresOn;
          workings = computed.workings;
          extended = computed.extendedByCourtClosure;
        }

        const article = data.limitationArticle
          ? LIMITATION_ARTICLES[data.limitationArticle]
          : undefined;

        const [row] = await tx
          .insert(legalMatters)
          .values({
            tenantId: ctx.tenant.id,
            matterNo: data.matterNo,
            title: data.title,
            companyId: data.companyId ?? null,
            matterType: data.matterType,
            ourSide: data.ourSide ?? null,
            opposingParty: data.opposingParty ?? null,
            courtName: data.courtName ?? null,
            jurisdiction: data.jurisdiction ?? null,
            caseNumber: data.caseNumber ?? null,
            filingDate: data.filingDate ?? null,
            causeOfActionDate: data.causeOfActionDate ?? null,
            limitationArticle: data.limitationArticle ?? null,
            limitationDays: article
              ? article.unit === "days"
                ? article.period
                : null
              : null,
            limitationExpiresOn: expiresOn,
            /** ⭐ The workings, kept — this is a file note, not a number. */
            limitationNote: workings.join(" "),
            responsibleUserId: data.responsibleUserId ?? null,
            notes: data.notes ?? null,
            status: "open",
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .returning({ id: legalMatters.id });

        if (!row) throw new Error("The matter could not be created.");

        await writeAudit(ctx, {
          action: "create",
          resourceType: "legal_matter",
          resourceId: row.id,
          newValue: {
            matterNo: data.matterNo,
            limitationArticle: data.limitationArticle ?? null,
            limitationExpiresOn: expiresOn,
          },
          /** The date on this record can end a client's claim. */
          severity: "critical",
        });

        return {
          id: row.id,
          limitationExpiresOn: expiresOn,
          workings,
          extendedByCourtClosure: extended,
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/legal/matters");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "saveMatter");
  }
}

/* ================================================================== */
/* ② THE ACKNOWLEDGEMENT THAT RESTARTS THE CLOCK                       */
/* ================================================================== */

const eventSchema = z.object({
  matterId: z.string().uuid(),
  eventType: z.enum([
    "acknowledgement",
    "part_payment",
    "legal_notice",
    "reply_notice",
    "filing",
    "service",
    "order",
    "other",
  ]),
  eventDate: civilDay,
  description: z.string().trim().min(1).max(2000),
  documentRef: z.string().trim().max(255).optional(),
  amountMinor: z.string().regex(/^\d+$/).optional(),
});

/**
 * ⭐⭐ RECORD AN EVENT — AND EXTEND LIMITATION IF THE LAW ALLOWS IT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHETHER IT EXTENDS IS DECIDED HERE, NOT BY WHOEVER IS TYPING
 * ══════════════════════════════════════════════════════════════════════
 * Section 18 starts a fresh period only where the acknowledgement was
 * made **before** the period expired. The same letter two days later
 * gives nothing — the right was already dead and nothing in the Act
 * revives it.
 *
 * ⚠️ A tick-box saying "this extends limitation" produces a diary entry
 * that is comforting and false, which is worse than no entry at all. So
 * there is no tick-box: the event is recorded, and the extension is
 * computed.
 */
export async function recordMatterEvent(input: unknown): Promise<
  ActionResult<{
    id: string;
    extended: boolean;
    newExpiry: string | null;
    reason: string;
  }>
> {
  try {
    const data = eventSchema.parse(input);
    const ctx = await requirePermission(WRITE);

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [m] = await tx
          .select()
          .from(legalMatters)
          .where(
            and(
              eq(legalMatters.tenantId, ctx.tenant.id),
              eq(legalMatters.id, data.matterId),
            ),
          )
          .limit(1);
        if (!m) throw new Error("That matter does not exist.");

        let extended = false;
        let newExpiry: string | null = null;
        let reason = "Recorded on the file. It does not affect limitation.";

        const canExtend =
          (data.eventType === "acknowledgement" || data.eventType === "part_payment") &&
          m.limitationArticle !== null &&
          m.limitationExpiresOn !== null;

        if (canExtend) {
          const holidays = await holidaysFor(tx, ctx.tenant.id, m.courtName);
          const verdict = applyAcknowledgement({
            articleKey: m.limitationArticle as string,
            currentExpiry: String(m.limitationExpiresOn),
            acknowledgementDate: data.eventDate,
            courtHolidays: holidays,
          });
          extended = verdict.accepted;
          newExpiry = verdict.newExpiry;
          reason = verdict.reason;
        } else if (
          data.eventType === "acknowledgement" ||
          data.eventType === "part_payment"
        ) {
          reason =
            "This matter has no limitation date recorded, so there is nothing for the acknowledgement to extend. Set the cause-of-action date and the Article first.";
        }

        const [row] = await tx
          .insert(legalMatterEvents)
          .values({
            tenantId: ctx.tenant.id,
            matterId: data.matterId,
            eventType: data.eventType,
            eventDate: data.eventDate,
            description: data.description,
            documentRef: data.documentRef ?? null,
            amountMinor: data.amountMinor ? BigInt(data.amountMinor) : null,
            resetsLimitation: extended,
            /** ⚠️ Both dates, or the audit trail says nothing. */
            previousExpiry: extended ? String(m.limitationExpiresOn) : null,
            newExpiry: extended ? newExpiry : null,
            resetNote: reason,
            createdBy: ctx.user.id,
          })
          .returning({ id: legalMatterEvents.id });

        if (!row) throw new Error("The event could not be recorded.");

        if (extended && newExpiry) {
          await tx
            .update(legalMatters)
            .set({
              limitationExpiresOn: newExpiry,
              limitationNote: reason,
              updatedAt: new Date(),
              updatedBy: ctx.user.id,
            })
            .where(
              and(
                eq(legalMatters.tenantId, ctx.tenant.id),
                eq(legalMatters.id, data.matterId),
              ),
            );
        }

        await writeAudit(ctx, {
          action: "create",
          resourceType: "legal_matter_event",
          resourceId: row.id,
          newValue: {
            eventType: data.eventType,
            eventDate: data.eventDate,
            extended,
            newExpiry,
          },
          severity: extended ? "critical" : "warning",
        });

        return { id: row.id, extended, newExpiry, reason };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/legal/matters");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "recordMatterEvent");
  }
}

/* ================================================================== */
/* ③ THE DIARY                                                         */
/* ================================================================== */

const hearingSchema = z.object({
  matterId: z.string().uuid(),
  hearingDate: civilDay,
  purpose: z.string().trim().max(255).optional(),
  beforeJudge: z.string().trim().max(255).optional(),
  courtHall: z.string().trim().max(60).optional(),
  causeListItem: z.string().trim().max(40).optional(),
  status: z
    .enum(["listed", "held", "adjourned", "not_reached", "cancelled"])
    .default("listed"),
  appearedBy: z.string().uuid().nullish(),
  counselName: z.string().trim().max(255).optional(),
  outcome: z.string().trim().max(4000).optional(),
  adjournedReason: z.string().trim().max(255).optional(),
  nextDate: civilDay.nullish(),
  disposed: z.boolean().default(false),
  notes: z.string().trim().max(4000).optional(),
});

/**
 * ⭐⭐ RECORD A HEARING.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A HEARING THAT HAPPENED AND HAS NO NEXT DATE IS REFUSED
 * ══════════════════════════════════════════════════════════════════════
 * A matter with no future date is a matter nobody is listed to attend —
 * and that is how a suit is dismissed for default of appearance. Not
 * because anybody decided to abandon it; because the next date was never
 * written down.
 *
 * ⚠️ `not_reached` IS INCLUDED DELIBERATELY. A matter that was not
 * reached still gets a next date, and it is the one most commonly
 * forgotten precisely because nothing happened.
 */
export async function saveHearing(
  input: unknown,
): Promise<ActionResult<{ id: string; nextDate: string | null }>> {
  try {
    const data = hearingSchema.parse(input);
    const ctx = await requirePermission(WRITE);

    if (
      ["held", "adjourned", "not_reached"].includes(data.status) &&
      !data.nextDate &&
      !data.disposed
    ) {
      throw new Error(
        `This hearing is marked "${data.status.replace("_", " ")}" with no next date and no disposal. A matter with neither is a matter nobody is listed to attend — which is how a suit gets dismissed for default of appearance. Record the next date the court gave, or mark it disposed.`,
      );
    }
    if (data.status === "adjourned" && !data.adjournedReason) {
      throw new Error(
        "An adjournment says why. \"Adjourned\" with no reason is the entry a client asks about six months later and nobody can answer.",
      );
    }
    if (data.nextDate && data.nextDate <= data.hearingDate) {
      throw new Error("The next date has to be after this hearing.");
    }

    const id = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [row] = await tx
          .insert(legalHearings)
          .values({
            tenantId: ctx.tenant.id,
            matterId: data.matterId,
            hearingDate: data.hearingDate,
            purpose: data.purpose ?? null,
            beforeJudge: data.beforeJudge ?? null,
            courtHall: data.courtHall ?? null,
            causeListItem: data.causeListItem ?? null,
            status: data.status,
            appearedBy: data.appearedBy ?? null,
            counselName: data.counselName ?? null,
            outcome: data.outcome ?? null,
            adjournedReason: data.adjournedReason ?? null,
            nextDate: data.nextDate ?? null,
            disposed: data.disposed,
            notes: data.notes ?? null,
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .returning({ id: legalHearings.id });
        if (!row) throw new Error("The hearing could not be recorded.");

        /**
         * ⭐ A DISPOSAL CLOSES THE MATTER, so it stops appearing on the
         * limitation report. Leaving it open would keep an expired
         * deadline on a list that is meant to be actionable.
         */
        if (data.disposed) {
          await tx
            .update(legalMatters)
            .set({
              status: "disposed",
              closedOn: data.hearingDate,
              outcome: data.outcome ?? null,
              updatedBy: ctx.user.id,
            })
            .where(
              and(
                eq(legalMatters.tenantId, ctx.tenant.id),
                eq(legalMatters.id, data.matterId),
              ),
            );
        }

        await writeAudit(ctx, {
          action: "create",
          resourceType: "legal_hearing",
          resourceId: row.id,
          newValue: {
            hearingDate: data.hearingDate,
            status: data.status,
            nextDate: data.nextDate ?? null,
            disposed: data.disposed,
          },
          severity: "warning",
        });

        return row.id;
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/legal/matters");
    return { ok: true, data: { id, nextDate: data.nextDate ?? null } };
  } catch (err) {
    return toSalesActionError(err, "saveHearing");
  }
}

/* ================================================================== */
/* ④ READS                                                             */
/* ================================================================== */

export type MatterRowView = {
  id: string;
  matterNo: string;
  title: string;
  clientName: string | null;
  matterType: string;
  ourSide: string | null;
  courtName: string | null;
  caseNumber: string | null;
  status: string;
  causeOfActionDate: string | null;
  limitationArticle: string | null;
  limitationCitation: string | null;
  limitationExpiresOn: string | null;
  limitationNote: string | null;
  ownerName: string | null;
  healthTone: string;
  healthLabel: string;
  healthDetail: string;
  daysLeft: number | null;
  nextHearing: string | null;
  hearingCount: number;
};

/**
 * ⭐ THE LIMITATION REPORT — and the counters are the whole point.
 *
 * 🔴 "NO LIMITATION DATE" IS ITS OWN COUNTER, and it is the most
 *    dangerous number on the screen: those matters will never appear on
 *    the list that would have saved them, whatever the date.
 */
export async function getMatters(): Promise<
  ActionResult<{
    rows: MatterRowView[];
    expired: number;
    within30: number;
    noLimitationDate: number;
    /** Matters whose last hearing produced no next date. */
    offDiary: number;
    today: string;
  }>
> {
  try {
    const ctx = await requirePermission(READ);
    const day = today();

    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select({
          id: legalMatters.id,
          matterNo: legalMatters.matterNo,
          title: legalMatters.title,
          clientName: companies.name,
          matterType: legalMatters.matterType,
          ourSide: legalMatters.ourSide,
          courtName: legalMatters.courtName,
          caseNumber: legalMatters.caseNumber,
          status: legalMatters.status,
          causeOfActionDate: legalMatters.causeOfActionDate,
          limitationArticle: legalMatters.limitationArticle,
          limitationExpiresOn: legalMatters.limitationExpiresOn,
          limitationNote: legalMatters.limitationNote,
          ownerFirst: users.firstName,
          ownerLast: users.lastName,
          nextHearing: sql<string | null>`(
            SELECT MIN(h.hearing_date) FROM legal_hearings h
             WHERE h.tenant_id = ${ctx.tenant.id} AND h.matter_id = ${legalMatters.id}
               AND h.status = 'listed' AND h.hearing_date >= ${day}
          )`,
          hearingCount: sql<number>`(
            SELECT COUNT(*)::int FROM legal_hearings h
             WHERE h.tenant_id = ${ctx.tenant.id} AND h.matter_id = ${legalMatters.id}
          )`,
          /**
           * ⭐ THE LAST HEARING THAT HAPPENED AND GAVE NOTHING BACK.
           * A matter whose most recent hearing produced no next date and
           * no disposal is off the diary.
           */
          offDiary: sql<boolean>`EXISTS (
            SELECT 1 FROM legal_hearings h
             WHERE h.tenant_id = ${ctx.tenant.id} AND h.matter_id = ${legalMatters.id}
               AND h.status IN ('held','adjourned','not_reached')
               AND h.next_date IS NULL AND h.disposed = false
          ) AND NOT EXISTS (
            SELECT 1 FROM legal_hearings h2
             WHERE h2.tenant_id = ${ctx.tenant.id} AND h2.matter_id = ${legalMatters.id}
               AND h2.status = 'listed' AND h2.hearing_date >= ${day}
          )`,
        })
        .from(legalMatters)
        .leftJoin(
          companies,
          and(
            eq(companies.id, legalMatters.companyId),
            eq(companies.tenantId, ctx.tenant.id),
          ),
        )
        .leftJoin(
          users,
          and(
            eq(users.id, legalMatters.responsibleUserId),
            eq(users.tenantId, ctx.tenant.id),
          ),
        )
        .where(eq(legalMatters.tenantId, ctx.tenant.id))
        .orderBy(asc(legalMatters.limitationExpiresOn))
        .limit(1000),
    );

    let offDiary = 0;
    const mapped: MatterRowView[] = rows.map((r) => {
      const health = limitationHealth({
        expiresOn: r.limitationExpiresOn ? String(r.limitationExpiresOn) : null,
        today: day,
      });
      const isOpen = r.status !== "disposed" && r.status !== "closed";
      if (isOpen && r.offDiary) offDiary += 1;
      const article = r.limitationArticle
        ? LIMITATION_ARTICLES[r.limitationArticle]
        : undefined;
      return {
        id: r.id,
        matterNo: r.matterNo,
        title: r.title,
        clientName: r.clientName,
        matterType: r.matterType,
        ourSide: r.ourSide,
        courtName: r.courtName,
        caseNumber: r.caseNumber,
        status: r.status,
        causeOfActionDate: r.causeOfActionDate ? String(r.causeOfActionDate) : null,
        limitationArticle: r.limitationArticle,
        limitationCitation: article?.citation ?? null,
        limitationExpiresOn: r.limitationExpiresOn
          ? String(r.limitationExpiresOn)
          : null,
        limitationNote: r.limitationNote,
        ownerName:
          [r.ownerFirst, r.ownerLast].filter(Boolean).join(" ").trim() || null,
        healthTone: health.tone,
        healthLabel: health.label,
        healthDetail: health.detail,
        daysLeft: health.daysLeft,
        nextHearing: r.nextHearing ? String(r.nextHearing) : null,
        hearingCount: r.hearingCount,
      };
    });

    const live = mapped.filter(
      (m) => m.status !== "disposed" && m.status !== "closed",
    );

    return {
      ok: true,
      data: {
        rows: mapped,
        expired: live.filter((m) => m.healthTone === "expired").length,
        within30: live.filter(
          (m) => m.daysLeft !== null && m.daysLeft >= 0 && m.daysLeft <= 30,
        ).length,
        /** 🔴 The most dangerous number on the screen. */
        noLimitationDate: live.filter((m) => m.healthTone === "unknown").length,
        offDiary,
        today: day,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getMatters");
  }
}

export async function getMatterDetail(id: string): Promise<
  ActionResult<{
    matter: MatterRowView;
    hearings: {
      id: string;
      hearingDate: string;
      purpose: string | null;
      status: string;
      beforeJudge: string | null;
      outcome: string | null;
      adjournedReason: string | null;
      nextDate: string | null;
      disposed: boolean;
      offDiary: boolean;
    }[];
    events: {
      eventType: string;
      eventDate: string;
      description: string;
      amountMinor: string | null;
      resetsLimitation: boolean;
      previousExpiry: string | null;
      newExpiry: string | null;
      resetNote: string | null;
    }[];
  }>
> {
  try {
    const ctx = await requirePermission(READ);
    const day = today();

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const [m] = await tx
        .select({
          id: legalMatters.id,
          matterNo: legalMatters.matterNo,
          title: legalMatters.title,
          clientName: companies.name,
          matterType: legalMatters.matterType,
          ourSide: legalMatters.ourSide,
          courtName: legalMatters.courtName,
          caseNumber: legalMatters.caseNumber,
          status: legalMatters.status,
          causeOfActionDate: legalMatters.causeOfActionDate,
          limitationArticle: legalMatters.limitationArticle,
          limitationExpiresOn: legalMatters.limitationExpiresOn,
          limitationNote: legalMatters.limitationNote,
          ownerFirst: users.firstName,
          ownerLast: users.lastName,
        })
        .from(legalMatters)
        .leftJoin(
          companies,
          and(
            eq(companies.id, legalMatters.companyId),
            eq(companies.tenantId, ctx.tenant.id),
          ),
        )
        .leftJoin(
          users,
          and(
            eq(users.id, legalMatters.responsibleUserId),
            eq(users.tenantId, ctx.tenant.id),
          ),
        )
        .where(and(eq(legalMatters.tenantId, ctx.tenant.id), eq(legalMatters.id, id)))
        .limit(1);

      if (!m) throw new Error("That matter does not exist.");

      const hearings = await tx
        .select()
        .from(legalHearings)
        .where(
          and(
            eq(legalHearings.tenantId, ctx.tenant.id),
            eq(legalHearings.matterId, id),
          ),
        )
        .orderBy(desc(legalHearings.hearingDate))
        .limit(500);

      const events = await tx
        .select()
        .from(legalMatterEvents)
        .where(
          and(
            eq(legalMatterEvents.tenantId, ctx.tenant.id),
            eq(legalMatterEvents.matterId, id),
          ),
        )
        .orderBy(desc(legalMatterEvents.eventDate))
        .limit(500);

      const health = limitationHealth({
        expiresOn: m.limitationExpiresOn ? String(m.limitationExpiresOn) : null,
        today: day,
      });
      const article = m.limitationArticle
        ? LIMITATION_ARTICLES[m.limitationArticle]
        : undefined;

      return {
        matter: {
          id: m.id,
          matterNo: m.matterNo,
          title: m.title,
          clientName: m.clientName,
          matterType: m.matterType,
          ourSide: m.ourSide,
          courtName: m.courtName,
          caseNumber: m.caseNumber,
          status: m.status,
          causeOfActionDate: m.causeOfActionDate ? String(m.causeOfActionDate) : null,
          limitationArticle: m.limitationArticle,
          limitationCitation: article?.citation ?? null,
          limitationExpiresOn: m.limitationExpiresOn
            ? String(m.limitationExpiresOn)
            : null,
          limitationNote: m.limitationNote,
          ownerName:
            [m.ownerFirst, m.ownerLast].filter(Boolean).join(" ").trim() || null,
          healthTone: health.tone,
          healthLabel: health.label,
          healthDetail: health.detail,
          daysLeft: health.daysLeft,
          nextHearing: null,
          hearingCount: hearings.length,
        },
        hearings: hearings.map((h) => ({
          id: h.id,
          hearingDate: String(h.hearingDate),
          purpose: h.purpose,
          status: h.status,
          beforeJudge: h.beforeJudge,
          outcome: h.outcome,
          adjournedReason: h.adjournedReason,
          nextDate: h.nextDate ? String(h.nextDate) : null,
          disposed: h.disposed,
          /** 🔴 Held, and it gave nothing back. */
          offDiary:
            ["held", "adjourned", "not_reached"].includes(h.status) &&
            !h.nextDate &&
            !h.disposed,
        })),
        events: events.map((e) => ({
          eventType: e.eventType,
          eventDate: String(e.eventDate),
          description: e.description,
          amountMinor:
            e.amountMinor === null
              ? null
              : serializeAmount(toBigIntAmount(e.amountMinor)),
          resetsLimitation: e.resetsLimitation,
          previousExpiry: e.previousExpiry ? String(e.previousExpiry) : null,
          newExpiry: e.newExpiry ? String(e.newExpiry) : null,
          resetNote: e.resetNote,
        })),
      };
    });

    return { ok: true, data };
  } catch (err) {
    return toSalesActionError(err, "getMatterDetail");
  }
}

/**
 * ⭐ WHAT IS LISTED, AND WHEN. The one thing a clerk opens the product
 * for at eight in the morning.
 */
export async function getDiary(days = 14): Promise<
  ActionResult<{
    rows: {
      id: string;
      hearingDate: string;
      matterNo: string;
      title: string;
      courtName: string | null;
      caseNumber: string | null;
      purpose: string | null;
      causeListItem: string | null;
      appearedByName: string | null;
    }[];
    today: string;
  }>
> {
  try {
    const ctx = await requirePermission(READ);
    const day = today();
    const until = new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select({
          id: legalHearings.id,
          hearingDate: legalHearings.hearingDate,
          matterNo: legalMatters.matterNo,
          title: legalMatters.title,
          courtName: legalMatters.courtName,
          caseNumber: legalMatters.caseNumber,
          purpose: legalHearings.purpose,
          causeListItem: legalHearings.causeListItem,
          appearedFirst: users.firstName,
          appearedLast: users.lastName,
        })
        .from(legalHearings)
        .innerJoin(
          legalMatters,
          and(
            eq(legalMatters.id, legalHearings.matterId),
            eq(legalMatters.tenantId, ctx.tenant.id),
          ),
        )
        .leftJoin(
          users,
          and(
            eq(users.id, legalHearings.appearedBy),
            eq(users.tenantId, ctx.tenant.id),
          ),
        )
        .where(
          and(
            eq(legalHearings.tenantId, ctx.tenant.id),
            eq(legalHearings.status, "listed"),
            sql`${legalHearings.hearingDate} BETWEEN ${day} AND ${until}`,
          ),
        )
        .orderBy(asc(legalHearings.hearingDate))
        .limit(500),
    );

    return {
      ok: true,
      data: {
        rows: rows.map((r) => ({
          id: r.id,
          hearingDate: String(r.hearingDate),
          matterNo: r.matterNo,
          title: r.title,
          courtName: r.courtName,
          caseNumber: r.caseNumber,
          purpose: r.purpose,
          causeListItem: r.causeListItem,
          appearedByName:
            [r.appearedFirst, r.appearedLast].filter(Boolean).join(" ").trim() || null,
        })),
        today: day,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getDiary");
  }
}

/**
 * ⭐ THE COMPOUND DEADLINE UNDER s.138 OF THE NEGOTIABLE INSTRUMENTS
 * ACT — three deadlines in a row, each starting the next, and the one
 * everybody gets wrong.
 */
export async function chequeDeadlines(input: {
  dishonourInformedOn: string;
  noticeServedOn?: string | null;
  paidWithinNoticePeriod?: boolean;
}): Promise<
  ActionResult<{
    noticeDueBy: string;
    drawerPayBy: string | null;
    causeOfActionOn: string | null;
    complaintDueBy: string | null;
    workings: string[];
  }>
> {
  try {
    await requirePermission(READ);
    return { ok: true, data: chequeDishonourDeadlines(input) };
  } catch (err) {
    return toSalesActionError(err, "chequeDeadlines");
  }
}

export async function getLegalOptions(): Promise<
  ActionResult<{
    clients: { id: string; name: string }[];
    people: { id: string; name: string }[];
    articles: {
      key: string;
      citation: string;
      description: string;
      runsFrom: string;
      period: string;
      note: string | null;
    }[];
  }>
> {
  try {
    const ctx = await requirePermission(READ);
    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const clients = await tx
        .select({ id: companies.id, name: companies.name })
        .from(companies)
        .where(and(eq(companies.tenantId, ctx.tenant.id), isNull(companies.deletedAt)))
        .orderBy(asc(companies.name))
        .limit(500);
      const people = await tx
        .select({
          id: users.id,
          first: users.firstName,
          last: users.lastName,
          email: users.email,
        })
        .from(users)
        .where(eq(users.tenantId, ctx.tenant.id))
        .limit(500);
      return {
        clients,
        people: people.map((p) => ({
          id: p.id,
          name: [p.first, p.last].filter(Boolean).join(" ").trim() || p.email,
        })),
      };
    });

    return {
      ok: true,
      data: {
        ...data,
        articles: Object.values(LIMITATION_ARTICLES).map((a) => ({
          key: a.key,
          citation: a.citation,
          description: a.description,
          runsFrom: a.runsFrom,
          period: `${a.period} ${a.unit}`,
          note: a.note ?? null,
        })),
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getLegalOptions");
  }
}
