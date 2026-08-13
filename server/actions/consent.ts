"use server";

/**
 * Ordence — ⭐⭐⭐ CONSENT
 * Version: v1.10.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE DEADLINE IS INSIDE THIS PLAN
 * ══════════════════════════════════════════════════════════════════════
 * The DPDP Rules 2025 were notified on 13 November 2025. Consent manager
 * registration closes November 2026 and the penalty regime begins May
 * 2027, with penalties to ₹250 crore.
 *
 * ⭐ AND IT IS A SELLING POINT, NOT ONLY AN OBLIGATION. Every business
 * on the industry list has to solve this in the next eighteen months and
 * almost none of them know how. An ERP that captures consent properly at
 * the point of contact creation, honours withdrawal everywhere, and can
 * produce the record on demand is selling compliance, not marketing.
 */

import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import { consentNotices, consents } from "@/db/schema/front-office";
import { requirePermission, writeAudit } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import type { ActionResult } from "@/lib/validators/crm";
import {
  CONSENT_CHANNELS,
  CONSENT_PURPOSES,
  mayContact,
  type ConsentChannel,
  type ConsentPurpose,
  type ConsentRecord,
} from "@/lib/crm/consent";

const READ = "crm.contacts.read" as const;
const WRITE = "crm.contacts.write" as const;

const purposes = CONSENT_PURPOSES as unknown as [ConsentPurpose, ...ConsentPurpose[]];
const channels = CONSENT_CHANNELS as unknown as [ConsentChannel, ...ConsentChannel[]];

/* ------------------------------------------------------------------ */
/* THE NOTICE                                                          */
/* ------------------------------------------------------------------ */

const noticeSchema = z.object({
  name: z.string().trim().min(1).max(160),
  version: z.number().int().positive().default(1),
  body: z
    .string()
    .trim()
    .min(20, "A notice has to say something. Twenty characters is not a high bar."),
  purposes: z.array(z.enum(purposes)).min(1),
  language: z.string().trim().max(8).default("en"),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * ⭐ PUBLISH A NOTICE.
 *
 * 🔴 THE WORDING IS FROZEN THE MOMENT ANYBODY AGREES TO IT. The trigger
 *    in 0061 refuses to edit the body of a notice with consents against
 *    it. That is the entire point of storing it: a notice that can be
 *    changed after people agree is worth exactly as much as no notice.
 */
export async function publishConsentNotice(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const data = noticeSchema.parse(input);
    const ctx = await requirePermission("settings.manage");

    const id = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [row] = await tx
          .insert(consentNotices)
          .values({
            tenantId: ctx.tenant.id,
            name: data.name,
            version: data.version,
            body: data.body,
            purposes: data.purposes,
            language: data.language,
            effectiveFrom: data.effectiveFrom,
            createdBy: ctx.user.id,
          })
          .returning({ id: consentNotices.id });
        if (!row) throw new Error("The notice could not be saved.");

        await writeAudit(ctx, {
          action: "create",
          resourceType: "consent_notice",
          resourceId: row.id,
          newValue: { name: data.name, version: data.version },
          /** It is the evidence every consent under it depends on. */
          severity: "critical",
        });
        return row.id;
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/crm/consent");
    return { ok: true, data: { id } };
  } catch (err) {
    return toSalesActionError(err, "publishConsentNotice");
  }
}

/* ------------------------------------------------------------------ */
/* GIVING AND TAKING BACK                                              */
/* ------------------------------------------------------------------ */

const partySchema = z
  .object({
    contactId: z.string().uuid().nullish(),
    companyId: z.string().uuid().nullish(),
    leadId: z.string().uuid().nullish(),
  })
  .refine((d) => d.contactId || d.companyId || d.leadId, {
    message: "A consent has to belong to somebody, or it cannot be honoured or produced.",
  });

const grantSchema = partySchema.and(
  z.object({
    purpose: z.enum(purposes),
    channel: z.enum(channels).default("all"),
    noticeId: z.string().uuid(),
    evidence: z.string().trim().min(1).max(200),
    evidenceRef: z.string().trim().max(200).optional(),
  }),
);

/**
 * ⭐⭐ RECORD A CONSENT.
 *
 * 🔴 THE NOTICE IS REQUIRED BY THE SCHEMA, NOT ONLY BY THE DATABASE. A
 *    grant that does not name what the person was shown is a checkbox,
 *    and a checkbox is what an inspection asks about and does not find.
 *
 * 🔴 AND THE TIMESTAMP COMES FROM THE SERVER. A "when did they agree"
 *    that a caller can supply is a date a caller can move.
 */
export async function grantConsent(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const data = grantSchema.parse(input);
    const ctx = await requirePermission(WRITE);

    const id = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [notice] = await tx
          .select({ id: consentNotices.id, purposes: consentNotices.purposes })
          .from(consentNotices)
          .where(
            and(
              eq(consentNotices.tenantId, ctx.tenant.id),
              eq(consentNotices.id, data.noticeId),
            ),
          )
          .limit(1);
        if (!notice) throw new Error("That notice does not exist.");

        /**
         * ⚠️ THE NOTICE HAS TO COVER THE PURPOSE. Recording a marketing
         * consent against a notice that only ever mentioned service
         * messages is worse than no record: it looks like evidence and
         * it is evidence of the opposite.
         */
        const covers =
          notice.purposes.includes(data.purpose) || notice.purposes.includes("all");
        if (!covers) {
          throw new Error(
            `That notice does not cover ${data.purpose}. It covers ${notice.purposes.join(", ")}. Recording a consent against a notice that never mentioned this purpose looks like evidence and is evidence of the opposite.`,
          );
        }

        const [row] = await tx
          .insert(consents)
          .values({
            tenantId: ctx.tenant.id,
            contactId: data.contactId ?? null,
            companyId: data.companyId ?? null,
            leadId: data.leadId ?? null,
            purpose: data.purpose,
            channel: data.channel,
            state: "granted",
            noticeId: data.noticeId,
            /** 🔴 From the server. */
            grantedAt: new Date(),
            evidence: data.evidence,
            evidenceRef: data.evidenceRef ?? null,
            createdBy: ctx.user.id,
          })
          .returning({ id: consents.id });
        if (!row) throw new Error("The consent could not be recorded.");

        await writeAudit(ctx, {
          action: "create",
          resourceType: "consent",
          resourceId: row.id,
          newValue: { purpose: data.purpose, channel: data.channel, state: "granted" },
          severity: "critical",
        });
        return row.id;
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/crm/consent");
    return { ok: true, data: { id } };
  } catch (err) {
    return toSalesActionError(err, "grantConsent");
  }
}

const withdrawSchema = partySchema.and(
  z.object({
    /** ⭐ Defaults to everything, because that is what "stop" means. */
    purpose: z.enum(purposes).default("all"),
    channel: z.enum(channels).default("all"),
    evidence: z.string().trim().min(1).max(200),
  }),
);

/**
 * ⭐⭐ WITHDRAW.
 *
 * 🔴 THE DEFAULT IS EVERYTHING. Somebody who says stop means stop, not
 *    stop-on-email-and-keep-the-WhatsApp. A product that defaults a
 *    withdrawal to the single channel it arrived on generates exactly
 *    the complaint the Act is about.
 *
 * ⭐ AND IT IS A NEW ROW, NEVER AN EDIT. The existing grants stay
 *    exactly as they are, because the question afterwards is always
 *    "what did they agree to, and when did they stop", and an edited
 *    row can only answer one of those.
 */
export async function withdrawConsent(
  input: unknown,
): Promise<ActionResult<{ id: string; supersedes: number }>> {
  try {
    const data = withdrawSchema.parse(input);
    const ctx = await requirePermission(WRITE);

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [row] = await tx
          .insert(consents)
          .values({
            tenantId: ctx.tenant.id,
            contactId: data.contactId ?? null,
            companyId: data.companyId ?? null,
            leadId: data.leadId ?? null,
            purpose: data.purpose,
            channel: data.channel,
            state: "withdrawn",
            /** ⚠️ A withdrawal needs no notice. Nobody has to be told to stop. */
            noticeId: null,
            withdrawnAt: new Date(),
            evidence: data.evidence,
            createdBy: ctx.user.id,
          })
          .returning({ id: consents.id });
        if (!row) throw new Error("The withdrawal could not be recorded.");

        /** ⭐ For the confirmation message: how much this switched off. */
        const [count] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(consents)
          .where(
            and(
              eq(consents.tenantId, ctx.tenant.id),
              eq(consents.state, "granted"),
              data.contactId
                ? eq(consents.contactId, data.contactId)
                : data.leadId
                  ? eq(consents.leadId, data.leadId)
                  : eq(consents.companyId, data.companyId ?? ""),
            ),
          );

        await writeAudit(ctx, {
          action: "create",
          resourceType: "consent",
          resourceId: row.id,
          newValue: { purpose: data.purpose, channel: data.channel, state: "withdrawn" },
          severity: "critical",
        });

        return { id: row.id, supersedes: count?.n ?? 0 };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/crm/consent");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "withdrawConsent");
  }
}

/* ------------------------------------------------------------------ */
/* MAY WE SEND THIS?                                                   */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ THE QUESTION THE CAMPAIGN SCREEN ASKS BEFORE IT SPENDS ANY MONEY.
 *
 * ⚠️ The answer always carries its reason, so an excluded person can be
 * shown as excluded and why, rather than silently dropped off a list.
 */
export async function checkConsent(input: unknown): Promise<
  ActionResult<{
    allowed: boolean;
    reason: string;
    remedy: string | null;
    records: number;
  }>
> {
  try {
    const data = z
      .object({
        contactId: z.string().uuid().nullish(),
        companyId: z.string().uuid().nullish(),
        leadId: z.string().uuid().nullish(),
        purpose: z.enum(["marketing", "transactional", "service", "profiling"]),
        channel: z.enum(channels),
        hasLegitimateContractualBasis: z.boolean().default(false),
      })
      .parse(input);
    const ctx = await requirePermission(READ);

    const records = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const where = [eq(consents.tenantId, ctx.tenant.id)];
        const party = data.contactId
          ? eq(consents.contactId, data.contactId)
          : data.leadId
            ? eq(consents.leadId, data.leadId)
            : data.companyId
              ? eq(consents.companyId, data.companyId)
              : null;
        if (party === null) {
          throw new Error("Ask about somebody. A consent question needs a party.");
        }
        where.push(party);

        return tx
          .select({
            id: consents.id,
            purpose: consents.purpose,
            channel: consents.channel,
            state: consents.state,
            noticeId: consents.noticeId,
            grantedAt: consents.grantedAt,
            withdrawnAt: consents.withdrawnAt,
          })
          .from(consents)
          .where(and(...where))
          .orderBy(desc(consents.createdAt))
          .limit(200);
      },
      { impersonationId: ctx.impersonationId },
    );

    const shaped: ConsentRecord[] = records.map((r) => ({
      id: r.id,
      purpose: r.purpose as ConsentPurpose,
      channel: r.channel as ConsentChannel,
      state: r.state as "granted" | "withdrawn",
      noticeId: r.noticeId,
      grantedAt: r.grantedAt ? r.grantedAt.toISOString() : null,
      withdrawnAt: r.withdrawnAt ? r.withdrawnAt.toISOString() : null,
    }));

    const verdict = mayContact({
      records: shaped,
      purpose: data.purpose,
      channel: data.channel,
      hasLegitimateContractualBasis: data.hasLegitimateContractualBasis,
    });

    return {
      ok: true,
      data: {
        allowed: verdict.allowed,
        reason: verdict.reason,
        remedy: verdict.remedy ?? null,
        records: shaped.length,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "checkConsent");
  }
}

/** ⭐ The state of the consent file, for the screen. */
export async function getConsentOverview(): Promise<
  ActionResult<{
    notices: {
      id: string;
      name: string;
      version: number;
      purposes: string[];
      effectiveFrom: string;
      usedBy: number;
      frozen: boolean;
    }[];
    granted: number;
    withdrawn: number;
    /** 🔴 Grants with no notice behind them. These are not evidence. */
    unevidenced: number;
  }>
> {
  try {
    const ctx = await requirePermission(READ);

    const data = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const notices = await tx
          .select()
          .from(consentNotices)
          .where(eq(consentNotices.tenantId, ctx.tenant.id))
          .orderBy(desc(consentNotices.effectiveFrom))
          .limit(100);

        const [counts] = await tx
          .select({
            granted: sql<number>`count(*) FILTER (WHERE ${consents.state} = 'granted')::int`,
            withdrawn: sql<number>`count(*) FILTER (WHERE ${consents.state} = 'withdrawn')::int`,
            unevidenced: sql<number>`count(*) FILTER (WHERE ${consents.state} = 'granted' AND ${consents.noticeId} IS NULL)::int`,
          })
          .from(consents)
          .where(eq(consents.tenantId, ctx.tenant.id));

        const usage = await tx
          .select({
            noticeId: consents.noticeId,
            n: sql<number>`count(*)::int`,
          })
          .from(consents)
          .where(eq(consents.tenantId, ctx.tenant.id))
          .groupBy(consents.noticeId);

        const usedBy = new Map(usage.map((u) => [u.noticeId, u.n]));

        return {
          notices: notices.map((n) => ({
            id: n.id,
            name: n.name,
            version: n.version,
            purposes: n.purposes,
            effectiveFrom: n.effectiveFrom,
            usedBy: usedBy.get(n.id) ?? 0,
            /** ⭐ Once anybody has agreed, the wording cannot change. */
            frozen: (usedBy.get(n.id) ?? 0) > 0,
          })),
          granted: counts?.granted ?? 0,
          withdrawn: counts?.withdrawn ?? 0,
          unevidenced: counts?.unevidenced ?? 0,
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    return { ok: true, data };
  } catch (err) {
    return toSalesActionError(err, "getConsentOverview");
  }
}
