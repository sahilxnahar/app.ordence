/**
 * Ordence — ⭐⭐⭐ THE SENDER THE DUNNING LADDER HAS BEEN MISSING SINCE 0027
 * Version: v1.14.0-alpha
 *
 * ⚠️ NODE RUNTIME.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 `dunning_events.channel = 'whatsapp'` HAS BEEN A CLAIM, NOT A FACT
 * ══════════════════════════════════════════════════════════════════════
 * That table has recorded WhatsApp service since 0027 — the channel, the
 * recipient, the date, the amount outstanding, who authorised it — and
 * it exists, in its own words, to be "the evidence that the buyer was
 * given every chance".
 *
 * ⚠️ THE ROW WAS WRITTEN BY A PERSON TICKING A BOX. Nothing left the
 * building. A firm could hold a perfect, append-only, legally shaped
 * record that a demand notice was served on a date when no message was
 * sent at all.
 *
 * 🔴 A GAP IN EVIDENCE IS A GAP. Evidence of something that did not
 * happen is a different problem, and it is discovered by the other side.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ SO THE ORDER OF OPERATIONS HERE IS THE WHOLE DESIGN
 * ══════════════════════════════════════════════════════════════════════
 * The `message_sends` row is written **before** the API call, `queued`.
 *
 * 🔴 A row written afterwards is a row that does not exist when the
 * process dies between the send and the insert — and then the message
 * went, the customer got it, and we have no record, so the next run
 * sends it again.
 *
 * ⚠️ THE OTHER ORDER FAILS SAFELY AND THIS ONE FAILS EXPENSIVELY. A
 * queued row with no send is a visible discrepancy; a send with no row
 * is a duplicate payment reminder.
 */

import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { connections } from "@/db/schema/integrations";
import { messageSends, messageTemplates, serviceWindows } from "@/db/schema/messaging";
import { CONNECTION_OWNER_KIND, readForRunner } from "@/server/vault/secrets";
import { mayContact, type ConsentRecord } from "@/lib/crm/consent";
import { maySendMessage, type SendVerdict } from "@/lib/messaging/gate";
import { renderTemplate, TemplateParameterError } from "@/lib/messaging/render";
import {
  windowIsOpen,
  willBeCharged,
  type MessageCategory,
  type ServiceWindow,
  type TemplateSnapshot,
} from "@/lib/messaging/window";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

const GRAPH = "https://graph.facebook.com/v21.0";

export interface SendArgs {
  readonly tx: Tx;
  readonly tenantId: string;
  readonly connectionId: string;
  readonly templateName: string;
  readonly language: string;
  readonly toPhone: string;
  readonly values: readonly string[];
  readonly idempotencyKey: string;
  readonly subjectType?: string | null;
  readonly subjectId?: string | null;
  readonly requestedBy?: string | null;
  readonly consents: readonly ConsentRecord[];
  readonly now: Date;
  readonly fetchImpl?: typeof fetch;
}

export type SendResult =
  | { readonly ok: true; readonly sendId: string; readonly chargeable: boolean }
  | {
      readonly ok: false;
      readonly refusalCode: string;
      readonly reason: string;
      /** ⭐ Recorded as a refusal so the decision is auditable. */
      readonly sendId: string | null;
    };

export async function sendUtilityMessage(args: SendArgs): Promise<SendResult> {
  const digits = args.toPhone.replace(/\D/g, "").slice(-10);

  const [connection] = await args.tx
    .select({
      id: connections.id,
      state: connections.state,
      isActive: connections.isActive,
      sendCap: connections.dailySendCap,
      spendCap: connections.dailySpendCapMinor,
      config: connections.config,
    })
    .from(connections)
    .where(
      and(
        eq(connections.tenantId, args.tenantId),
        eq(connections.id, args.connectionId),
      ),
    )
    .limit(1);

  if (!connection) {
    return { ok: false, refusalCode: "no_connection", reason: "No such connection.", sendId: null };
  }

  const [templateRow] = await args.tx
    .select()
    .from(messageTemplates)
    .where(
      and(
        eq(messageTemplates.tenantId, args.tenantId),
        eq(messageTemplates.connectionId, args.connectionId),
        eq(messageTemplates.name, args.templateName),
        eq(messageTemplates.language, args.language),
      ),
    )
    .limit(1);

  const template: TemplateSnapshot | null = templateRow
    ? {
        name: templateRow.name,
        status: templateRow.status,
        category: templateRow.category as MessageCategory,
        requestedCategory: (templateRow.requestedCategory as MessageCategory) ?? null,
        variableCount: templateRow.variableCount,
        pausedUntil: templateRow.pausedUntil,
        pauseCount: templateRow.pauseCount,
        quality: templateRow.quality,
        rejectionReason: templateRow.rejectionReason,
      }
    : null;

  const category: MessageCategory = template?.category ?? "utility";

  /**
   * ⭐ THE WINDOW, READ RATHER THAN ASSUMED. It decides whether this
   * costs anything, and it is the only part of the price the business
   * can influence.
   */
  const [windowRow] = await args.tx
    .select()
    .from(serviceWindows)
    .where(
      and(
        eq(serviceWindows.tenantId, args.tenantId),
        eq(serviceWindows.connectionId, args.connectionId),
        eq(serviceWindows.phoneDigits, digits),
      ),
    )
    .limit(1);

  const window: ServiceWindow | null = windowRow
    ? {
        openedAt: windowRow.openedAt,
        expiresAt: windowRow.expiresAt,
        isFreeEntryPoint: windowRow.isFreeEntryPoint,
      }
    : null;

  /**
   * 🔴 CONSENT FIRST. `mayContact` has existed since v1.10.0 and this is
   * the first path that has ever consulted it before doing something
   * irreversible.
   */
  const consent = mayContact({
    records: args.consents,
    channel: "whatsapp",
    purpose: category === "marketing" ? "marketing" : "transactional",
    /**
     * ⭐ A UTILITY MESSAGE ABOUT SOMETHING THEY BOUGHT DOES NOT NEED
     * MARKETING CONSENT, and `mayContact` has said so since v1.10.0.
     *
     * 🔴 IT DOES NOT UNLOCK MARKETING. The purpose asked for above is
     * still `marketing` when the template is one, so this flag cannot be
     * used to smuggle an offer out under a contract.
     */
    hasLegitimateContractualBasis: category !== "marketing",
  });

  const spend = await args.tx.execute(sql`
    SELECT count(*)::int AS sent, COALESCE(sum(cost_minor), 0)::bigint AS spent
      FROM message_sends
     WHERE tenant_id = ${args.tenantId}::uuid
       AND connection_id = ${args.connectionId}::uuid
       AND status <> 'refused'
       AND queued_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata')
  `);
  const totals = firstRow<{ sent: number; spent: string }>(spend);

  const seen = await args.tx
    .select({ id: messageSends.id })
    .from(messageSends)
    .where(
      and(
        eq(messageSends.tenantId, args.tenantId),
        eq(messageSends.idempotencyKey, args.idempotencyKey),
      ),
    )
    .limit(1);

  const verdict: SendVerdict = maySendMessage(
    {
      category,
      template,
      window,
      consentAllows: consent.allowed,
      consentReason: consent.reason,
      toPhoneDigits: digits,
      alreadySent: seen.length > 0,
      caps: {
        sentToday: totals?.sent ?? 0,
        spentTodayMinor: BigInt(totals?.spent ?? "0"),
        dailySendCap: connection.sendCap ?? null,
        dailySpendCapMinor:
          connection.spendCap === null || connection.spendCap === undefined
            ? null
            : BigInt(connection.spendCap),
      },
    },
    args.now,
  );

  if (!verdict.maySend) {
    /**
     * ⭐ A REFUSAL IS RECORDED, NOT SWALLOWED — except for a duplicate,
     * which is already recorded by definition.
     *
     * ⚠️ "Why did the buyer never get the notice" has to be answerable,
     * and "we decided not to send it, on this date, for this reason" is
     * the answer. A silent skip leaves the dunning ladder looking as
     * though nobody tried.
     */
    if (verdict.refusalCode === "already_sent") {
      return {
        ok: false,
        refusalCode: verdict.refusalCode,
        reason: verdict.reason,
        sendId: seen[0]?.id ?? null,
      };
    }

    const refused = await args.tx
      .insert(messageSends)
      .values({
        tenantId: args.tenantId,
        connectionId: args.connectionId,
        templateId: templateRow?.id ?? null,
        idempotencyKey: `${args.idempotencyKey}:refused:${args.now.toISOString()}`,
        subjectType: args.subjectType ?? null,
        subjectId: args.subjectId ?? null,
        toPhoneDigits: digits,
        toPhone: args.toPhone,
        category,
        language: args.language,
        renderedBody: "(not sent)",
        insideServiceWindow: windowIsOpen(window, args.now),
        status: "refused",
        errorCode: verdict.refusalCode,
        errorMessage: verdict.reason.slice(0, 500),
        requestedBy: args.requestedBy ?? null,
      })
      .returning({ id: messageSends.id });

    return {
      ok: false,
      refusalCode: verdict.refusalCode ?? "refused",
      reason: verdict.reason,
      sendId: (refused[0]?.id as string) ?? null,
    };
  }

  // ⚠️ Rendered BEFORE the row is written, so a bad parameter list is a
  // refusal rather than a queued message that can never go.
  let rendered;
  try {
    rendered = renderTemplate(templateRow?.body ?? "", args.values);
  } catch (e) {
    const message =
      e instanceof TemplateParameterError
        ? `${e.message} ${e.remedy}`
        : "The message could not be prepared.";
    return { ok: false, refusalCode: "bad_parameters", reason: message, sendId: null };
  }

  const insideWindow = windowIsOpen(window, args.now);
  const charge = willBeCharged(category, window, args.now);

  /**
   * 🔴 THE ROW GOES IN FIRST, `queued`. See the header: the other order
   * fails expensively.
   *
   * ⚠️ And the unique index on the idempotency key means two concurrent
   * attempts collide here rather than both reaching the API.
   */
  const inserted = await args.tx
    .insert(messageSends)
    .values({
      tenantId: args.tenantId,
      connectionId: args.connectionId,
      templateId: templateRow?.id ?? null,
      idempotencyKey: args.idempotencyKey,
      subjectType: args.subjectType ?? null,
      subjectId: args.subjectId ?? null,
      toPhoneDigits: digits,
      toPhone: args.toPhone,
      category,
      language: args.language,
      renderedBody: rendered.body,
      insideServiceWindow: insideWindow,
      status: "queued",
      requestedBy: args.requestedBy ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: messageSends.id });

  const sendId = inserted[0]?.id as string | undefined;
  if (!sendId) {
    // ⭐ Lost the race. Somebody else is sending this exact message.
    return {
      ok: false,
      refusalCode: "already_sent",
      reason: "This exact message is already being sent.",
      sendId: null,
    };
  }

  const token = await readForRunner({
    tx: args.tx,
    tenantId: args.tenantId,
    ownerKind: CONNECTION_OWNER_KIND,
    ownerId: args.connectionId,
    label: "access_token",
    syncRunId: `send:${sendId}`,
  });

  if (!token.ok) {
    await args.tx
      .update(messageSends)
      .set({
        status: "failed",
        failedAt: args.now,
        errorCode: "no_credential",
        errorMessage: token.error.slice(0, 500),
      })
      .where(eq(messageSends.id, sendId));
    return { ok: false, refusalCode: "no_credential", reason: token.error, sendId };
  }

  const phoneNumberId = readConfig(connection.config, "phone_number_id");
  if (!phoneNumberId) {
    await args.tx
      .update(messageSends)
      .set({
        status: "failed",
        failedAt: args.now,
        errorCode: "not_configured",
        errorMessage:
          "This connection has no WhatsApp phone number id, so nothing can be sent from it.",
      })
      .where(eq(messageSends.id, sendId));
    return {
      ok: false,
      refusalCode: "not_configured",
      reason: "This connection has no WhatsApp phone number id.",
      sendId,
    };
  }

  const doFetch = args.fetchImpl ?? fetch;

  try {
    const response = await doFetch(`${GRAPH}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.value}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: digits.length === 10 ? `91${digits}` : digits,
        type: "template",
        template: {
          name: args.templateName,
          language: { code: args.language },
          components: rendered.parameters.length
            ? [
                {
                  type: "body",
                  parameters: rendered.parameters.map((text) => ({
                    type: "text",
                    text,
                  })),
                },
              ]
            : [],
        },
      }),
    });

    const body = (await response.json().catch(() => null)) as
      | { messages?: { id?: string }[]; error?: { message?: string; code?: number } }
      | null;

    if (!response.ok) {
      const detail = body?.error?.message ?? `HTTP ${response.status}`;
      await args.tx
        .update(messageSends)
        .set({
          status: "failed",
          failedAt: args.now,
          errorCode: String(body?.error?.code ?? response.status),
          errorMessage: detail.slice(0, 500),
        })
        .where(eq(messageSends.id, sendId));
      return { ok: false, refusalCode: "provider_refused", reason: detail, sendId };
    }

    /**
     * ⚠️ `sent`, NOT `delivered`, AND NO COST YET.
     *
     * 🔴 Meta charges only when the message is DELIVERED. Booking the
     * cost here would count messages that were never charged, and the
     * spend ceiling built on that figure would stop a business from
     * sending messages it was never going to be billed for. 0066 refuses
     * a cost on anything undelivered.
     */
    await args.tx
      .update(messageSends)
      .set({
        status: "sent",
        sentAt: args.now,
        providerMessageId: body?.messages?.[0]?.id ?? null,
      })
      .where(eq(messageSends.id, sendId));

    return { ok: true, sendId, chargeable: charge.chargeable };
  } catch (e) {
    /**
     * 🔴 THE WORST CASE, AND IT IS NOT AN ERROR STATE.
     *
     * ⚠️ A timeout means we do not know whether it went. The row stays
     * `queued` with the reason recorded, because marking it `failed`
     * would invite a retry that sends a second copy of a message the
     * customer may already have. The status callback settles it.
     */
    await args.tx
      .update(messageSends)
      .set({
        errorCode: "timeout",
        errorMessage:
          "We could not tell whether this was sent. It is deliberately left pending rather than retried, because a retry may deliver a second copy. The delivery receipt will settle it.",
      })
      .where(eq(messageSends.id, sendId));

    return {
      ok: false,
      refusalCode: "unknown",
      reason:
        e instanceof Error
          ? `Could not reach WhatsApp: ${e.message.slice(0, 200)}`
          : "Could not reach WhatsApp.",
      sendId,
    };
  }
}

/* ------------------------------------------------------------------ */
/* THE DELIVERY RECEIPT                                                */
/* ------------------------------------------------------------------ */

export interface StatusUpdate {
  readonly providerMessageId: string;
  readonly status: "sent" | "delivered" | "read" | "failed";
  readonly at: Date;
  readonly errorMessage?: string | null;
  /** ⭐ Where Meta reports it. Minor units. */
  readonly costMinor?: bigint | null;
  readonly rateMinor?: bigint | null;
}

/**
 * 🔴🔴 THE ONLY PLACE A COST IS EVER WRITTEN.
 *
 * ⚠️ Receipts arrive out of order often enough that this matters: a
 * `sent` callback landing after a `delivered` one must not walk the row
 * backwards, or a delivered message reports as merely sent and its cost
 * is lost. 0066's trigger refuses that as well, because a rule this
 * easy to get wrong deserves writing down twice.
 */
export async function applyStatus(
  tx: Tx,
  tenantId: string,
  update: StatusUpdate,
): Promise<boolean> {
  const patch: Record<string, unknown> = {};

  if (update.status === "sent") patch.sentAt = update.at;

  if (update.status === "delivered") {
    patch.status = "delivered";
    patch.deliveredAt = update.at;
    // ⭐ THE MONEY, AT THE ONLY MOMENT IT IS REAL.
    if (update.costMinor !== null && update.costMinor !== undefined) {
      patch.costMinor = update.costMinor;
    }
    if (update.rateMinor !== null && update.rateMinor !== undefined) {
      patch.rateMinor = update.rateMinor;
    }
  }

  if (update.status === "read") {
    patch.status = "read";
    patch.readAt = update.at;
  }

  if (update.status === "failed") {
    patch.status = "failed";
    patch.failedAt = update.at;
    patch.errorMessage = (
      update.errorMessage ?? "WhatsApp could not deliver this message."
    ).slice(0, 500);
  }

  const result = await tx
    .update(messageSends)
    .set(patch)
    .where(
      and(
        eq(messageSends.tenantId, tenantId),
        eq(messageSends.providerMessageId, update.providerMessageId),
      ),
    )
    .returning({ id: messageSends.id });

  return (result as unknown[]).length > 0;
}

/* ------------------------------------------------------------------ */
/* THE WINDOW, OPENED BY THEM                                          */
/* ------------------------------------------------------------------ */

/**
 * ⭐ AN INBOUND MESSAGE OPENS OR EXTENDS THE FREE WINDOW.
 *
 * ⚠️ 0066's trigger refuses to move the expiry backwards and refuses to
 * downgrade a running free-entry-point window, because either would
 * start charging for messages that are free.
 */
export async function noteInboundMessage(
  tx: Tx,
  args: {
    readonly tenantId: string;
    readonly connectionId: string;
    readonly phoneDigits: string;
    readonly at: Date;
    readonly freeEntryPoint?: boolean;
  },
): Promise<void> {
  const hours = args.freeEntryPoint ? 72 : 24;
  const expires = new Date(args.at.getTime() + hours * 3_600_000);

  await tx
    .insert(serviceWindows)
    .values({
      tenantId: args.tenantId,
      connectionId: args.connectionId,
      phoneDigits: args.phoneDigits.replace(/\D/g, "").slice(-10),
      openedAt: args.at,
      expiresAt: expires,
      isFreeEntryPoint: args.freeEntryPoint ?? false,
    })
    .onConflictDoUpdate({
      target: [serviceWindows.connectionId, serviceWindows.phoneDigits],
      set: {
        openedAt: args.at,
        expiresAt: expires,
        isFreeEntryPoint: args.freeEntryPoint ?? false,
      },
    });
}

/* ------------------------------------------------------------------ */

function readConfig(config: unknown, key: string): string | null {
  if (!config || typeof config !== "object") return null;
  const v = (config as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function firstRow<T>(result: unknown): T | null {
  const r = result as { rows?: T[] };
  if (Array.isArray(r?.rows)) return r.rows[0] ?? null;
  return Array.isArray(result) ? ((result as T[])[0] ?? null) : null;
}
