/**
 * Ordence — ⭐⭐⭐ THE INBOUND ENQUIRY ENDPOINT
 * Version: v1.13.0-alpha
 *
 * ⚠️ NODE RUNTIME. `timingSafeEqual` and `createHmac` have no Edge
 * equivalent.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE ADDRESS IS THE ONLY THING PROTECTING TWO OF THESE THREE
 * ══════════════════════════════════════════════════════════════════════
 * IndiaMART's push documents no signature, no key and no header at all.
 * JustDial signs nothing either. So for both of them the unguessable
 * token in this path IS the security, which is why 0064 refuses one
 * under 32 characters at the database level rather than trusting
 * whatever generated it.
 *
 * ⭐ AND THE TENANT IS RESOLVED FROM THE TOKEN, never from anything in
 * the body. A body-supplied tenant id on a public endpoint is a
 * cross-tenant write waiting to be found.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 WHY THIS RETURNS 200 FOR AN ENQUIRY IT COULD NOT FILE
 * ══════════════════════════════════════════════════════════════════════
 * IndiaMART retries until it gets a 200 and **deactivates the push
 * entirely after 48 hours of continuous rejection** — after which a
 * person has to switch it back on in their seller panel.
 *
 * ⚠️ SO A BUG HERE THAT RETURNS 500 FOR TWO DAYS DOES NOT DELAY LEADS.
 * IT SILENTLY UNSUBSCRIBES THE CUSTOMER. And nothing on our side reports
 * it, because the requests simply stop arriving, which looks exactly
 * like a quiet week.
 *
 * ⭐ THEREFORE: ONCE THE BYTES ARE DURABLY STORED, WE ANSWER 200. The
 * enquiry is safe in `webhook_deliveries`, anything unfilable is visible
 * in `lead_intake_failures`, and a person can file it by hand. A non-200
 * is reserved for the one case where a retry genuinely helps — we did
 * not manage to store it.
 */

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db";
import {
  connections,
  webhookDeliveries,
  webhookEndpoints,
} from "@/db/schema/integrations";
import { readForRunner } from "@/server/vault/secrets";
import {
  assessDelivery,
  constantTimeEquals,
  purgeAfterFor,
  type EndpointSnapshot,
  type VerificationMethod,
} from "@/lib/integrations/verify";
import { policyFor } from "@/lib/integrations/policy";
import { parseIndiamartRecord, pushAcknowledgement } from "@/lib/integrations/adapters/indiamart";
import { parseJustdialLead } from "@/lib/integrations/adapters/justdial";
import { parseLeadgenNotices, verifySubscription } from "@/lib/integrations/adapters/meta";
import { ingestEnquiry } from "@/server/integrations/ingest";
import { redactPayloadObject } from "@/lib/billing/redact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ⚠️ THE PATH TOKEN IS LOOKED UP WITHOUT A TENANT IN CONTEXT, so this
 * one query runs outside `withTenant`. It selects by a 48-character
 * random token and returns exactly the tenant it belongs to, which is
 * then used for everything else.
 */
async function resolveEndpoint(token: string) {
  const { db } = await import("@/db");
  const rows = await db
    .select({
      endpointId: webhookEndpoints.id,
      tenantId: webhookEndpoints.tenantId,
      connectionId: webhookEndpoints.connectionId,
      verification: webhookEndpoints.verification,
      signatureHeader: webhookEndpoints.signatureHeader,
      tolerance: webhookEndpoints.timestampToleranceSeconds,
      isActive: webhookEndpoints.isActive,
      connectorKey: connections.connectorKey,
      connectionActive: connections.isActive,
    })
    .from(webhookEndpoints)
    .innerJoin(connections, eq(connections.id, webhookEndpoints.connectionId))
    .where(eq(webhookEndpoints.pathToken, token))
    .limit(1);
  return rows[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* GET — Meta's subscription handshake                                 */
/* ------------------------------------------------------------------ */

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;
  const endpoint = await resolveEndpoint(token);

  // ⚠️ 404 AND NOTHING ELSE for an unknown token. A distinct message for
  // "no such endpoint" versus "wrong signature" tells somebody probing
  // which tokens exist.
  if (!endpoint) return new NextResponse("Not found", { status: 404 });

  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");

  // ⭐ Meta confirms an endpoint by GETting it with a verify token and
  // expecting the challenge echoed back as plain text.
  if (mode) {
    const verifyToken = await withTenant(endpoint.tenantId, async (tx) =>
      readForRunner({
        tx,
        tenantId: endpoint.tenantId,
        ownerKind: "connection",
        ownerId: endpoint.connectionId,
        label: "verify_token",
        // ⚠️ Not a sync run, but a real accounted-for read: the handshake
        // is a one-off setup event and this is the id recorded for it.
        syncRunId: `subscribe:${endpoint.endpointId}`,
      }),
    );

    const verdict = verifySubscription(
      {
        mode,
        token: url.searchParams.get("hub.verify_token"),
        challenge: url.searchParams.get("hub.challenge"),
      },
      verifyToken.ok ? verifyToken.value : null,
      constantTimeEquals,
    );

    if (!verdict.ok) return new NextResponse("Forbidden", { status: 403 });
    // 🔴 PLAIN TEXT, NOT JSON. Meta compares the body byte for byte.
    return new NextResponse(verdict.challenge, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }

  /**
   * ⭐ JUSTDIAL DELIVERS BY GET WITH QUERY-STRING PARAMETERS, which is
   * why this route answers GET at all beyond the handshake.
   */
  if (endpoint.connectorKey === "justdial") {
    const params: Record<string, string> = {};
    url.searchParams.forEach((v, k) => {
      params[k] = v;
    });
    return handleDelivery(endpoint, params, JSON.stringify(params), null);
  }

  return new NextResponse("OK", { status: 200 });
}

/* ------------------------------------------------------------------ */
/* POST — everything else                                              */
/* ------------------------------------------------------------------ */

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;
  const endpoint = await resolveEndpoint(token);
  if (!endpoint) return new NextResponse("Not found", { status: 404 });

  /**
   * 🔴 THE RAW BODY, READ ONCE, BEFORE ANYTHING PARSES IT.
   *
   * ⚠️ A signature is over the bytes that arrived. Parsing and
   * re-serialising reorders keys and changes number formatting, and the
   * signature then never matches for a reason that is invisible, because
   * the parsed object looks identical to the one the sender signed.
   */
  const rawBody = await request.text();

  let parsed: unknown = null;
  try {
    parsed = rawBody.length > 0 ? JSON.parse(rawBody) : {};
  } catch {
    parsed = null;
  }

  const signatureHeader = endpoint.signatureHeader
    ? request.headers.get(endpoint.signatureHeader)
    : null;

  return handleDelivery(endpoint, parsed, rawBody, signatureHeader);
}

/* ------------------------------------------------------------------ */
/* THE SHARED PATH                                                     */
/* ------------------------------------------------------------------ */

type Endpoint = NonNullable<Awaited<ReturnType<typeof resolveEndpoint>>>;

async function handleDelivery(
  endpoint: Endpoint,
  parsed: unknown,
  rawBody: string,
  presentedSignature: string | null,
): Promise<Response> {
  const now = new Date();
  const policy = policyFor(endpoint.connectorKey);
  const connectorLabel = policy?.label ?? endpoint.connectorKey;

  const payloadHash = createHash("sha256").update(rawBody).digest("hex");

  const snapshot: EndpointSnapshot = {
    verification: endpoint.verification as VerificationMethod,
    signatureHeader: endpoint.signatureHeader,
    timestampToleranceSeconds: endpoint.tolerance,
    isActive: endpoint.isActive && endpoint.connectionActive,
  };

  const externalId = externalIdOf(endpoint.connectorKey, parsed);

  try {
    const stored = await withTenant(endpoint.tenantId, async (tx) => {
      // ⭐ THE SIGNING SECRET, WHERE THERE IS ONE. IndiaMART and JustDial
      // have none, and `not_required` is recorded rather than `verified`.
      let secret: string | null = null;
      if (snapshot.verification !== "none") {
        const read = await readForRunner({
          tx,
          tenantId: endpoint.tenantId,
          ownerKind: "connection",
          ownerId: endpoint.connectionId,
          label: "app_secret",
          syncRunId: `delivery:${endpoint.endpointId}`,
        });
        secret = read.ok ? read.value : null;
      }

      // ⚠️ HAVE WE SEEN THIS EVENT BEFORE? Asked before the row is
      // written, because the answer changes what we write.
      const seen = externalId
        ? await tx
            .select({ id: webhookDeliveries.id })
            .from(webhookDeliveries)
            .where(
              and(
                eq(webhookDeliveries.tenantId, endpoint.tenantId),
                eq(webhookDeliveries.endpointId, endpoint.endpointId),
                eq(webhookDeliveries.externalId, externalId),
              ),
            )
            .limit(1)
        : [];

      const verdict = assessDelivery(
        snapshot,
        {
          rawBody,
          presentedSignature,
          externalId,
          alreadySeen: seen.length > 0,
          secret,
        },
        now,
      );

      // 🔴 THE DELIVERY ROW GOES IN WHATEVER THE VERDICT WAS. An invalid
      // signature is kept and not acted on; a replay is kept and not
      // acted on. Both are worth seeing.
      const rows = await tx
        .insert(webhookDeliveries)
        .values({
          tenantId: endpoint.tenantId,
          endpointId: endpoint.endpointId,
          receivedAt: now,
          externalId,
          signatureState: verdict.signatureState,
          isReplay: verdict.isReplay,
          payloadHash,
          payload: safeBody(parsed),
          purgeAfter: purgeAfterFor(now, verdict.outcome),
          outcome: verdict.outcome,
          errorMessage: verdict.errorMessage,
        })
        .returning({ id: webhookDeliveries.id });

      const deliveryId = rows[0]?.id as string | undefined;
      if (!deliveryId) throw new Error("The delivery could not be stored.");

      await tx
        .update(webhookEndpoints)
        .set({ lastDeliveryAt: now })
        .where(eq(webhookEndpoints.id, endpoint.endpointId));

      if (!verdict.mayProcess) return { deliveryId, filed: false };

      await fileEnquiries(tx, {
        endpoint,
        connectorLabel,
        deliveryId,
        parsed,
        now,
      });

      // ⚠️ MARKED PROCESSED, which 0064 permits and permits ONLY for a
      // delivery whose signature was not invalid and which is not a
      // replay.
      await tx
        .update(webhookDeliveries)
        .set({ outcome: "processed", processedAt: now })
        .where(eq(webhookDeliveries.id, deliveryId));

      return { deliveryId, filed: true };
    });

    const ack = pushAcknowledgement(Boolean(stored.deliveryId));
    return NextResponse.json(ack.body, { status: ack.status });
  } catch {
    // 🔴 THE ONE CASE WHERE A RETRY GENUINELY HELPS. See the header:
    // this is the only path that may refuse, because refusing for two
    // days switches IndiaMART's push off entirely.
    const ack = pushAcknowledgement(false);
    return NextResponse.json(ack.body, { status: ack.status });
  }
}

/**
 * ⭐ ONE DELIVERY MAY CARRY SEVERAL ENQUIRIES. Meta batches under load,
 * which is exactly when a campaign is working.
 *
 * ⚠️ Reading only the first is the standard mistake and it drops every
 * enquiry after it, silently, only when things are going well.
 */
async function fileEnquiries(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  args: {
    endpoint: Endpoint;
    connectorLabel: string;
    deliveryId: string;
    parsed: unknown;
    now: Date;
  },
): Promise<void> {
  const ctx = {
    tx,
    tenantId: args.endpoint.tenantId,
    connectionId: args.endpoint.connectionId,
    connectorLabel: args.connectorLabel,
    deliveryId: args.deliveryId,
    now: args.now,
  };

  if (args.endpoint.connectorKey === "indiamart") {
    // ⚠️ The push sends one record, but the same shape wrapped in
    // `RESPONSE` has been seen. Both are handled rather than assumed.
    const doc = asRecord(args.parsed);
    const records = Array.isArray(doc?.RESPONSE) ? doc.RESPONSE : [args.parsed];
    for (const record of records) {
      await ingestEnquiry(ctx, parseIndiamartRecord(record), record);
    }
    return;
  }

  if (args.endpoint.connectorKey === "justdial") {
    await ingestEnquiry(
      ctx,
      parseJustdialLead(args.parsed, args.deliveryId),
      args.parsed,
    );
    return;
  }

  if (args.endpoint.connectorKey === "meta_lead_ads") {
    /**
     * 🔴 THE META WEBHOOK IS A NOTIFICATION, NOT A LEAD. It carries ids
     * and no answers, so each one is recorded as an intake failure
     * naming the `leadgen_id` until the Graph fetch is built.
     *
     * ⚠️ THE NOTICE IS NOT DISCARDED. Losing it loses the only trace
     * that somebody enquired, and the id is what lets a person open
     * Meta's own Leads Center and retrieve the enquiry by hand.
     */
    const notices = parseLeadgenNotices(args.parsed);
    for (const notice of notices) {
      await ingestEnquiry(
        ctx,
        {
          ok: false,
          reasonCode: "lead_fetch_failed",
          reason: `Meta reported an enquiry (${notice.leadgenId}) and the answers are fetched separately, which is not built yet. Open Meta's Leads Center and download it; the reference is recorded here.`,
          externalId: notice.leadgenId,
        },
        notice,
      );
    }
    return;
  }

  await ingestEnquiry(
    ctx,
    {
      ok: false,
      reasonCode: "unknown_shape",
      reason: `A delivery arrived for ${args.connectorLabel}, which Ordence does not yet know how to file.`,
      externalId: null,
    },
    args.parsed,
  );
}

/* ------------------------------------------------------------------ */
/* HELPERS                                                             */
/* ------------------------------------------------------------------ */

function externalIdOf(connectorKey: string, parsed: unknown): string | null {
  const doc = asRecord(parsed);
  if (!doc) return null;

  if (connectorKey === "indiamart") {
    const v = doc.UNIQUE_QUERY_ID;
    return typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null;
  }
  if (connectorKey === "meta_lead_ads") {
    // ⚠️ A batched delivery has several. The first is used for the
    // delivery-level replay key; every lead keeps its own on the lead.
    const first = parseLeadgenNotices(parsed)[0];
    return first?.leadgenId ?? null;
  }
  for (const key of ["leadid", "lead_id", "id"]) {
    const v = doc[key] ?? doc[key.toUpperCase()];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 200);
  }
  return null;
}

function safeBody(parsed: unknown): Record<string, unknown> | null {
  if (parsed === null || parsed === undefined) return null;
  try {
    return redactPayloadObject(parsed);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
