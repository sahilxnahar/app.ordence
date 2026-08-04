/**
 * Ordence — Telemetry Ingest Endpoint
 * Version: v0.12.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THIS ROUTE IS PUBLIC, AND UNLIKE THE WEBHOOKS THERE IS NO HMAC
 * ══════════════════════════════════════════════════════════════════════
 * The Razorpay and Stripe endpoints are also public, but a signature
 * makes them safe. This one has nothing equivalent, and cannot:
 *
 *   • Web Vitals fire on the sign-in page and on the marketing shell,
 *     where there is no session to authenticate with.
 *   • A crash in the auth bootstrap has no session BY DEFINITION, and
 *     that is the single most important error we could ever record.
 *   • A shared client secret would be in the JavaScript bundle, i.e.
 *     public, i.e. not a secret.
 *
 * So the design accepts anonymous writes and contains the blast radius
 * instead. What an anonymous caller CAN do: insert diagnostics rows with
 * `tenant_id IS NULL`, invisible to every tenant session (Section 1 of
 * SQL-FILES/0011_phase19_telemetry.sql). What they CANNOT do:
 *
 *   • ATTRIBUTE A ROW TO A TENANT. The wire schema has no `tenantId`
 *     field at all — `.strict()` makes sending one a 400 — and the server
 *     resolves it from the session cookie. Poisoning a competitor's error
 *     dashboard is therefore not possible.
 *   • WRITE UNBOUNDED DATA. Body is capped before parsing, batch size is
 *     capped, every string has a max, and every label is an enum or a
 *     scrubbed pattern.
 *   • LEARN ANYTHING. The response is `{ accepted: n }` and nothing else.
 *     No echo of input, no validation detail, no ids. A verbose 400 on a
 *     public endpoint is a free oracle.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT IS STILL MISSING: RATE LIMITING
 * ══════════════════════════════════════════════════════════════════════
 * Nothing here stops one host POSTing a valid 20-event batch in a loop.
 * The caps bound each request, not the request RATE, so the residual risk
 * is table growth and database write load — a cost problem, not a
 * disclosure one.
 *
 * The hook is marked `RATE LIMIT HOOK` below and `lib/redis.ts` already
 * provides the Upstash client the rest of the platform limits with. It is
 * deliberately not wired here because the limiter's key must be an IP,
 * and getting that right behind Vercel's proxy chain (`x-forwarded-for`
 * is a CLIENT-SETTABLE header list, and trusting its first entry is a
 * trivial bypass) is its own small decision. Written up in
 * docs/PHASE-19-NOTES.md rather than half-done here.
 */

import { NextResponse } from "next/server";

import {
  telemetryIngestBodySchema,
  clampOccurredAt,
  MAX_INGEST_BODY_BYTES,
} from "@/lib/telemetry/ingest-schema";
import { scrubUrl, scrubText, scrubMetadata, fingerprintError } from "@/lib/telemetry/scrub";
import { getTenantContext } from "@/server/tenant-context";
import { withPlatformScope } from "@/db";
import { errorEvents, webVitalEvents } from "@/db/schema/telemetry";

/**
 * ⚠️ NODE RUNTIME, NOT EDGE.
 * The insert path goes through the Drizzle/Neon client and
 * `getTenantContext()` reaches Clerk's server SDK. Neither is a supported
 * Edge target here, and this route is not latency-critical — the caller
 * is a beacon that has already stopped caring about the response.
 */
export const runtime = "nodejs";

/**
 * Never cached. A cached telemetry response would acknowledge events that
 * were never written, and the endpoint would look healthy while silently
 * recording nothing.
 */
export const dynamic = "force-dynamic";

/**
 * The response body. A CONSTANT, not a function of the input.
 *
 * Every failure path returns 204 with an empty body rather than a 4xx
 * with a reason. Two arguments for that:
 *   1. The client cannot act on the difference — there is no retry.
 *   2. A distinguishable "invalid schema" vs "too large" vs "rejected"
 *      response tells an attacker exactly which of our bounds they hit,
 *      for free, on an endpoint with no auth to slow them down.
 * The one exception is 413, which is returned before the body is read so
 * that a genuinely oversized upload is refused rather than buffered.
 */
function noContent(): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  /* ---- 0. RATE LIMIT HOOK --------------------------------------
   *
   * TODO(phase-20): apply an IP-keyed Upstash limiter here, BEFORE the
   * body is read, using a trusted client address rather than the raw
   * `x-forwarded-for` header (which the client sets, and whose first
   * entry is therefore attacker-chosen — trusting it is a one-line
   * bypass of any limit built on it). Fail OPEN on limiter errors:
   * telemetry going dark because Redis blipped is a worse outcome than
   * telemetry being briefly unlimited.
   */

  /* ---- 1. Size cap BEFORE reading the body ---------------------- */

  // `content-length` is advisory — a chunked request omits it, and a
  // hostile client can lie. It is checked anyway because when it IS
  // present and honest it lets us refuse without buffering anything, and
  // the post-read check below catches the case where it lied.
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_INGEST_BODY_BYTES) {
    return new NextResponse(null, { status: 413, headers: { "cache-control": "no-store" } });
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    // Truncated upload or a client that hung up mid-beacon. Nothing to do.
    return noContent();
  }

  // The check that actually holds, against a lying or absent
  // `content-length`. Measured in BYTES, not characters: `.length` counts
  // UTF-16 code units, so a body of astral-plane characters is up to 4x
  // the bytes its `.length` suggests and would slip a cap built on it.
  if (new TextEncoder().encode(raw).length > MAX_INGEST_BODY_BYTES) {
    return new NextResponse(null, { status: 413, headers: { "cache-control": "no-store" } });
  }

  /* ---- 2. Parse and validate strictly --------------------------- */

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return noContent();
  }

  const parsed = telemetryIngestBodySchema.safeParse(parsedJson);
  if (!parsed.success) {
    // ⚠️ `parsed.error` is NEVER returned and NEVER logged in full: a Zod
    // issue embeds the offending VALUE, so echoing it back would take the
    // PII we just refused to store and put it in a response body and a
    // log line instead.
    return noContent();
  }

  /* ---- 3. Resolve tenant from the SESSION, never from the body --- */

  /**
   * ⭐ THE ATTRIBUTION BOUNDARY.
   *
   * The tenant and user come from the Clerk session and from nowhere
   * else. If this were read from the payload, any anonymous caller could
   * write fabricated `fatal` errors into another tenant's health
   * dashboard — and, once a later phase alerts on that dashboard, page
   * their engineers at will.
   *
   * `getTenantContext()` is the NON-throwing variant on purpose: the
   * overwhelmingly common case for this endpoint is genuinely having no
   * session, and that must produce a null-tenant row, not a 500.
   */
  let tenantId: string | null = null;
  let userId: string | null = null;
  try {
    const ctx = await getTenantContext();
    if (ctx) {
      tenantId = ctx.tenant.id;
      userId = ctx.user.id;
    }
  } catch {
    // Auth resolution failing is itself a normal outcome here (expired
    // session, Clerk unreachable). Record the events unattributed rather
    // than losing them — an outage in auth is when they matter most.
  }

  /* ---- 4. Scrub, shape and write -------------------------------- */

  const now = new Date();
  const release = (
    process.env.TELEMETRY_RELEASE ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    "unknown"
  ).slice(0, 80);
  const environment = (process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development").slice(
    0,
    24,
  );

  const errorRows: (typeof errorEvents.$inferInsert)[] = [];
  const vitalRows: (typeof webVitalEvents.$inferInsert)[] = [];

  for (const event of parsed.data.events) {
    if (event.kind === "web-vital") {
      vitalRows.push({
        tenantId,
        metric: event.metric,
        // `numeric` columns take a string in Drizzle. Formatting here
        // rather than letting the driver coerce keeps the precision
        // explicit — the same rule the money columns follow.
        value: event.value.toFixed(4),
        rating: event.rating,
        // Scrubbed AGAIN server-side. The client scrubs too, but a
        // hand-crafted POST never ran that code, and the CHECK constraint
        // on the column would reject a raw URL — turning a hostile
        // payload into a failed batch rather than a stored one.
        routePattern: scrubUrl(event.route),
        deviceClass: event.deviceClass ?? "unknown",
        connection: event.connection ?? "unknown",
        viewportBucket: event.viewportBucket ?? null,
        navigationType: event.navigationType ?? null,
        release,
        environment,
        occurredAt: clampOccurredAt(event.occurredAt, now),
        capturedAt: now,
      });
      continue;
    }

    const message = scrubText(event.message) || "(no message)";
    const stack = event.stack ? scrubText(event.stack, 8_000) : null;

    errorRows.push({
      tenantId,
      userId,
      fingerprint: fingerprintError({
        message,
        stack,
        name: event.name ?? "Error",
      }),
      message,
      errorName: (event.name ?? "Error").slice(0, 120),
      stack: stack && stack.length > 0 ? stack : null,
      severity: event.severity ?? "error",
      // Hardcoded, not taken from the payload. This endpoint is the
      // browser's door; a client claiming `source: "server"` would be
      // laundering a fabricated backend error into our triage queue.
      source: "client",
      routePattern: scrubUrl(event.route),
      release,
      environment,
      occurredAt: clampOccurredAt(event.occurredAt, now),
      capturedAt: now,
      metadata: scrubMetadata(event.metadata),
    });
  }

  try {
    /**
     * WHY `withPlatformScope` AND NOT `withTenant`.
     *
     * The same reasoning as the payment reconciler: a request that may
     * have NO tenant cannot enter a tenant-pinned transaction, and the
     * null-tenant rows are precisely the ones that matter most. The
     * tenant id written into each row came from the SESSION and was never
     * attacker-supplied, so attribution is exactly as trustworthy as the
     * session is. RLS still governs every READ of these tables.
     *
     * ⚠️ The write is AWAITED. Returning before it lands would let the
     * serverless function freeze mid-INSERT, and on a beacon-driven
     * endpoint that loses the event silently — the caller is already
     * gone and will never retry.
     */
    await withPlatformScope(
      "telemetry ingest: writes diagnostics rows whose tenant_id is resolved " +
        "from the session, including null-tenant rows from pre-auth page views",
      async (database) => {
        if (vitalRows.length > 0) await database.insert(webVitalEvents).values(vitalRows);
        if (errorRows.length > 0) await database.insert(errorEvents).values(errorRows);
      },
    );
  } catch (writeError) {
    // Swallowed. A telemetry write failure is not the client's problem
    // and there is no useful retry — see the file header, rule 3 of the
    // reporter. Logged only outside production so an incident does not
    // amplify itself into a log-volume problem.
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[telemetry] ingest write failed (swallowed by design):",
        writeError instanceof Error ? writeError.message : String(writeError),
      );
    }
  }

  // Constant response. `accepted` is a COUNT of rows we shaped, not a
  // description of what we did with them — deliberately uninformative
  // about validation, storage and attribution alike.
  return NextResponse.json(
    { accepted: vitalRows.length + errorRows.length },
    { status: 202, headers: { "cache-control": "no-store" } },
  );
}

/**
 * Anything other than POST gets 405 with no body.
 *
 * Next.js would return 405 anyway, but stating it means a GET cannot be
 * turned into a cached response by a CDN that decided to be helpful.
 */
export function GET(): NextResponse {
  return new NextResponse(null, {
    status: 405,
    headers: { allow: "POST", "cache-control": "no-store" },
  });
}
