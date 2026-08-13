"use server";

/**
 * Ordence — ⭐⭐⭐ MESSAGE TEMPLATES
 * Version: v1.17.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 0066 BUILT THIS TABLE FOR A SYNC THAT DOES NOT EXIST
 * ══════════════════════════════════════════════════════════════════════
 * `message_templates` has `synced_at`, `quality`, `rejection_reason` and
 * a status defaulting to `in_review`. Every one of those columns assumes
 * the row arrived from Meta's API. None of them can be written by a
 * person, and there was no screen that tried.
 *
 * ⚠️ SO BOTH ENGINES WERE INERT. The utility messaging path in v1.14.0
 * and the campaign path in v1.15.0 both require a template id. Neither
 * could ever be given one, because there was no way for a template to
 * come into existence at all.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ AND THE FIRST TEMPLATE IS ALWAYS ONE SOMEBODY TYPED IN
 * ══════════════════════════════════════════════════════════════════════
 * A business writes their template in Meta's dashboard, because that is
 * where templates are submitted and approved. Then they have to tell us
 * it exists. That claim is not a fact, and 0069 refuses to let it
 * masquerade as one: `source = 'declared'` may never carry
 * `status = 'approved'`.
 *
 * 🔴 THE FAILURE THAT CONSTRAINT PREVENTS IS EXPENSIVE AND SILENT.
 * Somebody registers a template, ticks approved because it looks
 * approved on Meta's screen, and a campaign of four thousand recipients
 * resolves against it. Meta then refuses every send for a parameter
 * mismatch — or, worse, accepts them under a category it quietly
 * re-assigned to `marketing`, at roughly seven times the price. The bill
 * arrives a month later and nothing in between says a word.
 */

import { and, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import { connections } from "@/db/schema/integrations";
import { messageTemplates } from "@/db/schema/messaging";
import { requirePermission, writeAudit } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import { checkTemplateBody, variableCountOf } from "@/lib/messaging/render";
import type { ActionResult } from "@/lib/validators/crm";

const MANAGE = "settings.manage" as const;
const READ = "crm.contacts.read" as const;

/* ------------------------------------------------------------------ */
/* DECLARE                                                             */
/* ------------------------------------------------------------------ */

const declareSchema = z.object({
  connectionId: z.string().uuid(),
  /**
   * ⚠️ META'S OWN NAMING RULE, ENFORCED HERE RATHER THAN DISCOVERED ON
   * SEND. Lower case, digits and underscores. A person who types
   * "Order Update" in this box has a template that cannot be sent, and
   * finding that out at send time means finding it out in front of a
   * customer.
   */
  name: z
    .string()
    .min(1)
    .max(120)
    .regex(
      /^[a-z0-9_]+$/,
      "Template names may only contain lower case letters, digits and underscores. That is Meta's rule, not ours, and a name that breaks it is refused at send time.",
    ),
  language: z.string().min(2).max(10).default("en"),
  category: z.enum(["utility", "marketing", "authentication"]),
  body: z.string().min(1).max(4000),
  headerText: z.string().max(200).optional().nullable(),
  footerText: z.string().max(200).optional().nullable(),
});

/**
 * ⭐ RECORD THAT A TEMPLATE EXISTS. NOT THAT IT IS APPROVED.
 *
 * 🔴 THE STATUS IS NOT AN ARGUMENT. It is always `in_review`, whatever
 * the person believes, because the only honest thing we know is that
 * somebody told us about it. Accepting a status here would put the most
 * consequential field on the screen under the control of the person
 * least able to verify it.
 */
export async function declareTemplate(
  input: unknown,
): Promise<ActionResult<{ id: string; variableCount: number }>> {
  try {
    const data = declareSchema.parse(input);
    const ctx = await requirePermission(MANAGE);
    const now = new Date();

    // ⭐ COUNTED, NOT TYPED. Asking a person how many variables their
    // template has produces a number that is right on the day and wrong
    // after the first edit, and Meta refuses any send whose parameter
    // count disagrees with the approved template.
    const variableCount = variableCountOf(data.body);

    // 🔴 CHECKED BEFORE IT IS STORED, AND THE REMEDY IS RETURNED WITH
    // THE PROBLEM.
    //
    // ⚠️ `checkTemplateBody` has existed since v1.14.0 and, like
    // everything else in this session, nothing called it. Its whole
    // value is that it catches the things Meta rejects for — a body that
    // opens with a variable, two variables touching, a placeholder
    // numbered out of sequence — at the moment somebody can still fix
    // them, rather than a day later in an email from Meta that says
    // "INVALID_FORMAT" and nothing else.
    const problems = checkTemplateBody(data.body);
    if (problems.length > 0) {
      const first = problems[0]!;
      return {
        ok: false,
        error: `${first.problem} ${first.remedy}`,
      };
    }

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [connection] = await tx
          .select({ id: connections.id, connectorKey: connections.connectorKey })
          .from(connections)
          .where(
            and(
              eq(connections.tenantId, ctx.tenant.id),
              eq(connections.id, data.connectionId),
            ),
          )
          .limit(1);

        if (!connection) throw new Error("No such connection.");
        if (connection.connectorKey !== "whatsapp") {
          throw new Error(
            "Templates belong to a WhatsApp connection. This one is something else.",
          );
        }

        const [row] = await tx
          .insert(messageTemplates)
          .values({
            tenantId: ctx.tenant.id,
            connectionId: connection.id,
            name: data.name,
            language: data.language,
            category: data.category,
            // ⭐ KEPT SO A RE-CATEGORISATION IS VISIBLE LATER. Meta moves
            // a utility template that reads like an advertisement into
            // marketing, and the identical send silently costs about
            // seven times more.
            requestedCategory: data.category,
            body: data.body,
            headerText: data.headerText ?? null,
            footerText: data.footerText ?? null,
            variableCount,
            // 🔴 NEVER `approved`. 0069 enforces this as well, so a
            // future caller cannot get it wrong either.
            status: "in_review",
            source: "declared",
            declaredAt: now,
            createdBy: ctx.user.id,
          })
          .returning({ id: messageTemplates.id });

        if (!row) throw new Error("The template could not be saved.");

        await writeAudit(ctx, {
          action: "create",
          resourceType: "message_template",
          resourceId: row.id,
          newValue: { name: data.name, category: data.category, variableCount },
          severity: "notice",
        });

        return { id: row.id, variableCount };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/messaging/templates");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "declareTemplate");
  }
}

/* ------------------------------------------------------------------ */
/* WITHDRAW                                                            */
/* ------------------------------------------------------------------ */

const withdrawSchema = z.object({
  templateId: z.string().uuid(),
  reason: z.string().min(3).max(500),
});

/**
 * ⚠️ `disabled`, NOT DELETED. A template that has sent messages is
 * referenced by every one of them, and a business asked "what did you
 * send me in March" cannot answer with a missing row.
 */
export async function disableTemplate(
  input: unknown,
): Promise<ActionResult<{ disabled: true }>> {
  try {
    const data = withdrawSchema.parse(input);
    const ctx = await requirePermission(MANAGE);

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        await tx
          .update(messageTemplates)
          .set({ status: "disabled", rejectionReason: data.reason, updatedAt: new Date() })
          .where(
            and(
              eq(messageTemplates.tenantId, ctx.tenant.id),
              eq(messageTemplates.id, data.templateId),
            ),
          );

        await writeAudit(ctx, {
          action: "update",
          resourceType: "message_template",
          resourceId: data.templateId,
          newValue: { status: "disabled", reason: data.reason },
          severity: "notice",
        });
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/messaging/templates");
    return { ok: true, data: { disabled: true } };
  } catch (err) {
    return toSalesActionError(err, "disableTemplate");
  }
}

/* ------------------------------------------------------------------ */
/* READ                                                               */
/* ------------------------------------------------------------------ */

export interface TemplateCard {
  readonly id: string;
  readonly connectionId: string;
  readonly connectionName: string;
  readonly name: string;
  readonly language: string;
  readonly category: string;
  readonly status: string;
  readonly source: string;
  readonly variableCount: number;
  readonly body: string;
  readonly pausedUntil: string | null;
  /** ⭐ Why a send using this would be refused right now. Null when it would go. */
  readonly blockedReason: string | null;
}

export async function getTemplates(): Promise<
  ActionResult<{
    readonly templates: readonly TemplateCard[];
    readonly whatsappConnections: ReadonlyArray<{ id: string; name: string }>;
  }>
> {
  try {
    const ctx = await requirePermission(READ);
    const now = new Date();

    return await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const rows = await tx
          .select({
            id: messageTemplates.id,
            connectionId: messageTemplates.connectionId,
            connectionName: connections.name,
            name: messageTemplates.name,
            language: messageTemplates.language,
            category: messageTemplates.category,
            status: messageTemplates.status,
            source: messageTemplates.source,
            variableCount: messageTemplates.variableCount,
            body: messageTemplates.body,
            pausedUntil: messageTemplates.pausedUntil,
          })
          .from(messageTemplates)
          .innerJoin(connections, eq(connections.id, messageTemplates.connectionId))
          .where(eq(messageTemplates.tenantId, ctx.tenant.id))
          .orderBy(desc(messageTemplates.createdAt))
          .limit(200);

        const whatsappConnections = await tx
          .select({ id: connections.id, name: connections.name })
          .from(connections)
          .where(
            and(
              eq(connections.tenantId, ctx.tenant.id),
              eq(connections.connectorKey, "whatsapp"),
            ),
          );

        return {
          ok: true as const,
          data: {
            templates: rows.map((r: Record<string, unknown>) => ({
              id: r.id as string,
              connectionId: r.connectionId as string,
              connectionName: r.connectionName as string,
              name: r.name as string,
              language: r.language as string,
              category: r.category as string,
              status: r.status as string,
              source: r.source as string,
              variableCount: r.variableCount as number,
              body: r.body as string,
              pausedUntil: (r.pausedUntil as Date | null)?.toISOString() ?? null,
              blockedReason: blockedReasonFor(
                r.status as string,
                r.source as string,
                r.pausedUntil as Date | null,
                now,
              ),
            })),
            whatsappConnections,
          },
        };
      },
      { impersonationId: ctx.impersonationId },
    );
  } catch (err) {
    return toSalesActionError(err, "getTemplates");
  }
}

/**
 * ⭐⭐ THE SENTENCE THAT SAVES THE SUPPORT CALL.
 *
 * ⚠️ "Why did my reminder not go out" is the question, and the answer is
 * almost always one of these four. Putting it on the template rather
 * than in a log means it is read before the send instead of after it.
 */
function blockedReasonFor(
  status: string,
  source: string,
  pausedUntil: Date | null,
  now: Date,
): string | null {
  if (status === "disabled") {
    return "This template is switched off. Meta disables a template permanently after a third pause, and that cannot be undone.";
  }
  if (status === "rejected") {
    return "Meta rejected this template. It has to be edited and resubmitted in their dashboard, then declared here again.";
  }
  if (pausedUntil && pausedUntil.getTime() > now.getTime()) {
    return `Paused by Meta until ${pausedUntil.toISOString()}. Pauses escalate: three hours, then six, then permanent, so waiting is the only correct response.`;
  }
  if (status !== "approved") {
    return source === "declared"
      ? "Recorded, but not yet confirmed approved by Meta. Sends will be attempted and may be refused. Only a reply from Meta can move this to approved."
      : "Not approved yet.";
  }
  return null;
}
