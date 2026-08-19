import "server-only";

/**
 * Ordence — ⭐ The Direct Push
 * Version: v0.37.0-alpha
 *
 * POST an export straight into a running Tally instance.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THIS IS THE ONLY PLACE IN THE PRODUCT WHERE OUR SERVERS OPEN A
 * CONNECTION TO AN ADDRESS A CUSTOMER TYPED, AND IT IS TREATED THAT WAY
 * ══════════════════════════════════════════════════════════════════════
 * Phase 23's workflow HTTP step is the same shape and is constrained by
 * `lib/workflows/http-policy.ts`, which blocks EVERY private address. It
 * has to: the cloud metadata service at 169.254.169.254 returns
 * credentials for the role this application runs as, and reaching it is
 * one text box away.
 *
 * ⚠️ AND TALLY IS ONLY EVER AT A PRIVATE ADDRESS. It is a Windows
 * application on a desktop in the accounts room, on 127.0.0.1 or
 * 192.168.1.x, speaking plain HTTP on port 9000 with no authentication.
 * The policy that makes workflows safe forbids, by construction, the one
 * address this feature needs.
 *
 * ⭐ THE RESOLUTION IS IN `lib/tally/endpoint.ts` AND IT IS NOT "TURN THE
 * POLICY OFF". Four conditions, all required: the workspace deliberately
 * set `allow_private_host` on this connection; the host is the one stored
 * on that row and not one supplied with the request; the address is in a
 * range a Tally desktop can genuinely be on; and the metadata service,
 * 0.0.0.0/8, carrier-grade NAT and multicast are refused WHATEVER the
 * flag says. Read that file before widening anything here.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND THE PUSH IS NOT THE RECOMMENDED PATH
 * ══════════════════════════════════════════════════════════════════════
 * It needs Tally running, the right company open, the port enabled, and
 * this server on the same network as that desktop — which for a hosted
 * deployment is never true and should never become true. The file export
 * always works, is what most firms actually use, and is the one an
 * accountant can inspect before importing. This exists for the
 * on-premise and VPN cases, which are real and are much of this market.
 */

import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db";
import { tallyConnections, tallyExportBatches } from "@/db/schema/tally";
import { checkTallyEndpoint } from "@/lib/tally/endpoint";
import { parseImportResponse, type TallyImportResponse } from "@/lib/tally/parse";
import { findConnection } from "./registry";

export type PushOutcome =
  | {
      ok: true;
      response: TallyImportResponse;
      raw: string;
      reachedPrivateNetwork: boolean;
    }
  | { ok: false; reason: string; remedy?: string };

/**
 * ⚠️ SHORT, AND DELIBERATELY SO. Tally is single-threaded: while it is
 * importing it answers nothing, and a large file can hold the socket for
 * minutes. A long timeout here would hold one of our request handlers
 * open for the same minutes, and a customer with a slow desktop would
 * become a customer who can exhaust our connection pool. Thirty seconds
 * is enough for a month; anything larger is the file export's job.
 */
const PUSH_TIMEOUT_MS = 30_000;

/**
 * ⚠️ THE RESPONSE IS BOUNDED. Tally's import response is a few hundred
 * bytes; a device answering on port 9000 that is NOT Tally could stream
 * indefinitely, and reading it into memory is the whole attack. One
 * megabyte is two orders of magnitude more than any real response.
 */
const MAX_RESPONSE_BYTES = 1024 * 1024;

export async function pushToTally(args: {
  tenantId: string;
  connectionId: string;
  xml: string;
}): Promise<PushOutcome> {
  const connection = await findConnection(args.tenantId, args.connectionId);
  if (!connection) {
    return { ok: false, reason: "That Tally connection no longer exists." };
  }
  if (!connection.isActive) {
    return { ok: false, reason: "That Tally connection has been switched off." };
  }
  if (!connection.host) {
    return {
      ok: false,
      reason: "That connection has no host, so it is file-only.",
      remedy:
        "Download the file and import it from Tally's Gateway → Import Data. " +
        "That is what most firms use, and it always works.",
    };
  }

  /* --- ⭐⭐ THE GATE. Everything above is bookkeeping. ----------- */

  const verdict = checkTallyEndpoint({
    host: connection.host,
    port: connection.port,
    useTls: connection.useTls,
    allowPrivateHost: connection.allowPrivateHost,
  });

  if (!verdict.allowed) {
    await recordPushResult(args.tenantId, args.connectionId, "refused", verdict.reason);
    return { ok: false, reason: verdict.reason, remedy: verdict.remedy };
  }

  /* --- The request. --------------------------------------------- */

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);

  try {
    const response = await fetch(verdict.url, {
      method: "POST",
      // ⚠️ Tally's XML socket wants `text/xml` and ignores a charset it
      // does not know. The declaration inside the document is what
      // actually decides the encoding — see `lib/tally/xml.ts`.
      headers: { "content-type": "text/xml; charset=utf-8" },
      body: args.xml,
      signal: controller.signal,
      // ⚠️ NO REDIRECTS. A 302 from whatever is listening on that port
      // would take the request somewhere the endpoint policy never saw,
      // which is how an allowed address becomes a forbidden one after the
      // check has passed. Tally never redirects.
      redirect: "manual",
      cache: "no-store",
    });

    const raw = await readBounded(response);

    /**
     * ⚠️ A TALLY IMPORT THAT FAILED COMPLETELY RETURNS HTTP 200.
     *
     * The socket is happy; the import is not. The counts inside the body
     * are the only truth, and "CREATED 0 / ERRORS 0" is a cheerful
     * response that imported nothing at all — usually because the company
     * name in the envelope matched no open company. Treating a 200 as
     * success is the single most common way this integration lies.
     */
    const parsed = parseImportResponse(raw);

    const succeeded =
      response.status >= 200 &&
      response.status < 300 &&
      (parsed.errors ?? 0) === 0 &&
      parsed.lineErrors.length === 0;

    await recordPushResult(
      args.tenantId,
      args.connectionId,
      succeeded ? "ok" : "rejected",
      succeeded
        ? `created ${parsed.created ?? 0}, altered ${parsed.altered ?? 0}`
        : parsed.lineErrors.join("; ") ||
            `HTTP ${response.status}, errors ${parsed.errors ?? "unknown"}`,
    );

    if (!succeeded) {
      return {
        ok: false,
        reason:
          `Tally accepted the connection and refused the data: ` +
          `${parsed.errors ?? 0} error(s), ${parsed.created ?? 0} created, ` +
          `${parsed.ignored ?? 0} ignored.` +
          (parsed.lineErrors.length > 0
            ? ` Tally said: ${parsed.lineErrors.slice(0, 3).join("; ")}`
            : ""),
        remedy:
          parsed.created === 0 && (parsed.errors ?? 0) === 0
            ? "⚠️ Nothing was created and nothing errored, which almost always " +
              "means the company name did not match any company open in Tally. " +
              "It must match character for character, including any year in " +
              "brackets."
            : "Download the file and import it from Tally's Gateway → Import " +
              "Data, where the error is shown against the voucher.",
      };
    }

    return {
      ok: true,
      response: parsed,
      raw,
      reachedPrivateNetwork: verdict.reachesPrivateNetwork,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    const reason = aborted
      ? `Tally did not answer within ${PUSH_TIMEOUT_MS / 1000} seconds.`
      : "Could not reach Tally.";
    await recordPushResult(args.tenantId, args.connectionId, "failed", reason);
    return {
      ok: false,
      reason,
      remedy: aborted
        ? "Tally is single-threaded — while it is importing it answers nothing. " +
          "It may still have imported. ⚠️ Check Tally before sending again: " +
          "sending again after a successful import is safe (the keys are " +
          "stable and it will ALTER rather than duplicate), but confirming is " +
          "cheaper than assuming."
        : "Check that Tally is running, that the company is open, and that its " +
          "XML port is enabled under F12 → Advanced Configuration. Or download " +
          "the file and import it by hand, which always works.",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ⚠️ READ AT MOST `MAX_RESPONSE_BYTES`. `response.text()` on a stream
 * that never ends is an out-of-memory crash, and the thing on the other
 * end of a customer-configured port is not guaranteed to be Tally.
 */
async function readBounded(response: Response): Promise<string> {
  const body = response.body;
  if (!body) return await response.text();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        chunks.push(value.slice(0, Math.max(0, value.byteLength - (total - MAX_RESPONSE_BYTES))));
        break;
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

/**
 * ⭐ Evidence of the last attempt, whatever it was.
 *
 * ⚠️ A REFUSAL IS RECORDED TOO. "Is it even switched on?" and "did our
 * own policy stop it?" are different questions with the same symptom —
 * nothing arrived in Tally — and without this row the second one is
 * unanswerable from the product.
 */
async function recordPushResult(
  tenantId: string,
  connectionId: string,
  status: string,
  detail: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(tallyConnections)
      .set({
        lastPushAt: new Date(),
        lastPushStatus: status,
        lastPushDetail: detail.slice(0, 2000),
      })
      .where(
        and(
          eq(tallyConnections.tenantId, tenantId),
          eq(tallyConnections.id, connectionId),
        ),
      );
  });
}

/**
 * ⭐ MARK THE BATCH DELIVERED — and this is the write that flips the next
 * export of the same source rows from CREATE to ALTER.
 *
 * ⚠️ ONLY CALLED ON A CONFIRMED SUCCESS. Setting it on a push that failed
 * would make the next export an ALTER of vouchers Tally does not have,
 * which Tally reports as "ignored" — cheerfully — so the period would
 * silently never arrive at all.
 */
export async function markDelivered(args: {
  tenantId: string;
  batchId: string;
  userId: string | null;
  deliveryMode: "file" | "http_push";
  responsePayload?: string | null;
  response?: TallyImportResponse | null;
}): Promise<boolean> {
  const rows = await withTenant(args.tenantId, async (tx) =>
    tx
      .update(tallyExportBatches)
      .set({
        status: "delivered",
        deliveryMode: args.deliveryMode,
        deliveredAt: new Date(),
        deliveredBy: args.userId,
        responsePayload: args.responsePayload ?? null,
        responseCreated: args.response?.created ?? null,
        responseAltered: args.response?.altered ?? null,
        responseIgnored: args.response?.ignored ?? null,
        responseErrors: args.response?.errors ?? null,
      })
      .where(
        and(
          eq(tallyExportBatches.tenantId, args.tenantId),
          eq(tallyExportBatches.id, args.batchId),
        ),
      )
      .returning({ id: tallyExportBatches.id }),
  );
  return rows.length > 0;
}
