/**
 * Ordence — Telemetry Ingest Contract
 * Version: v0.12.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE WIRE SCHEMA LIVES IN ITS OWN FILE
 * ══════════════════════════════════════════════════════════════════════
 * The client reporter and the ingest route must agree on this shape
 * exactly. Defining it inside the route handler would mean the browser
 * bundle either imports a server module or — far more likely — grows a
 * second, hand-maintained copy that drifts. A drifted telemetry contract
 * does not fail loudly; it just stops recording one metric and nobody
 * notices for a quarter.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THIS IS THE VALIDATION BOUNDARY FOR A PUBLIC ENDPOINT
 * ══════════════════════════════════════════════════════════════════════
 * `/api/telemetry` accepts POSTs from the open internet (see the route
 * for why it cannot require auth). Everything below is therefore
 * ATTACKER-CONTROLLED until it has been through this schema:
 *
 *   • `.strict()` on every object — an unknown key is a REJECTION, not a
 *     silently-dropped field. A permissive parse is how `{"tenantId":
 *     "<someone else's uuid>"}` would get somewhere; here it is a 400.
 *     Note there is NO tenantId in this schema at all: the server
 *     resolves it from the session and refuses to be told.
 *   • every string has a `.max()` — an unbounded string on a public
 *     endpoint is a storage-exhaustion primitive.
 *   • every enum is closed — this is where the cardinality bound is
 *     actually enforced, before anything reaches a label.
 *   • numbers are `.finite()` — NaN and Infinity serialise to `null` in
 *     JSON and would poison a numeric column.
 */

import { z } from "zod";

/**
 * How many events one beacon may carry.
 *
 * Batching exists because a page emits 5 vitals and firing 5 requests
 * during unload is how you lose 3 of them. 20 is generous headroom over
 * the 5 metrics plus a handful of errors, and it caps how much work one
 * unauthenticated request can ask the database to do.
 */
export const MAX_BATCH_EVENTS = 20;

/**
 * Body size cap in bytes, enforced before parsing.
 *
 * `navigator.sendBeacon` itself refuses payloads over ~64 KB, so a body
 * larger than this did not come from our reporter. 32 KB is comfortably
 * above a full 20-event batch and far below anything worth buffering
 * from an anonymous caller.
 */
export const MAX_INGEST_BODY_BYTES = 32 * 1024;

export const webVitalMetricValues = ["LCP", "INP", "CLS", "FCP", "TTFB"] as const;
export const webVitalRatingValues = ["good", "needs-improvement", "poor"] as const;
export const deviceClassValues = ["mobile", "tablet", "desktop", "unknown"] as const;
export const connectionValues = ["slow-2g", "2g", "3g", "4g", "unknown"] as const;
export const navigationTypeValues = [
  "navigate",
  "reload",
  "back-forward",
  "back-forward-cache",
  "prerender",
  "route-change",
] as const;

/**
 * A Web Vital measurement.
 *
 * `route` arrives RAW and is scrubbed server-side. The client scrubs it
 * too — belt and braces — but the server never trusts that it did, because
 * "the client already sanitised it" is the assumption behind most
 * injection bugs ever written.
 */
export const webVitalEventSchema = z
  .object({
    kind: z.literal("web-vital"),
    metric: z.enum(webVitalMetricValues),
    // Upper bound matches the CHECK constraint on the column. Ten minutes
    // is absurd for a page load but genuinely reachable on a dying
    // connection, so it is not narrower.
    value: z.number().finite().min(0).max(600_000),
    rating: z.enum(webVitalRatingValues),
    route: z.string().max(2_048),
    deviceClass: z.enum(deviceClassValues).optional(),
    connection: z.enum(connectionValues).optional(),
    viewportBucket: z.number().int().min(0).max(20_000).optional(),
    navigationType: z.enum(navigationTypeValues).optional(),
    /**
     * Client clock, milliseconds since epoch. NOT trusted as truth — the
     * server sanity-bounds it and falls back to its own clock, because a
     * device with a wrong date would otherwise write rows dated 2031 and
     * quietly break every time-ranged dashboard.
     */
    occurredAt: z.number().int().finite().optional(),
  })
  .strict();

/**
 * A browser-side error.
 *
 * `stack` is capped well below the column's 8 KB limit: a stack longer
 * than 4 KB is a runaway recursion, and its first 20 frames say
 * everything the remaining 400 do.
 */
export const clientErrorEventSchema = z
  .object({
    kind: z.literal("error"),
    name: z.string().max(120).optional(),
    message: z.string().min(1).max(4_000),
    stack: z.string().max(4_000).optional(),
    // `fatal` is accepted from the client because an error boundary
    // genuinely knows the user could not continue. It is the only
    // severity a browser can assert about itself.
    severity: z.enum(["fatal", "error", "warning"]).optional(),
    route: z.string().max(2_048),
    /**
     * Arbitrary keys are permitted HERE and filtered by `scrubMetadata`
     * against the allow-list before storage. Rejecting unknown metadata
     * keys outright would mean a reporter from an older deploy has its
     * whole event dropped over one stale field.
     */
    metadata: z.record(z.string().max(64), z.unknown()).optional(),
    occurredAt: z.number().int().finite().optional(),
  })
  .strict();

export const telemetryIngestEventSchema = z.discriminatedUnion("kind", [
  webVitalEventSchema,
  clientErrorEventSchema,
]);

export const telemetryIngestBodySchema = z
  .object({
    events: z.array(telemetryIngestEventSchema).min(1).max(MAX_BATCH_EVENTS),
  })
  .strict();

export type TelemetryIngestEvent = z.infer<typeof telemetryIngestEventSchema>;
export type TelemetryIngestBody = z.infer<typeof telemetryIngestBodySchema>;
export type ClientWebVitalEvent = z.infer<typeof webVitalEventSchema>;
export type ClientErrorEvent = z.infer<typeof clientErrorEventSchema>;

/**
 * Clamp a client-supplied timestamp into something a dashboard can use.
 *
 * THE FAILURE THIS PREVENTS: a device with a wrong system clock — far
 * more common than it sounds, and universal on machines that lost their
 * CMOS battery — reports `occurredAt` in 2031. Stored as-is, that row
 * sits permanently at the right edge of every chart and drags any
 * "last 24 hours" window with it.
 *
 * A beacon may legitimately be delivered late (queued while offline), so
 * the past window is generous. The future window is not, because a
 * measurement cannot legitimately be from the future.
 */
export function clampOccurredAt(
  clientMillis: number | undefined,
  now: Date = new Date(),
): Date {
  if (typeof clientMillis !== "number" || !Number.isFinite(clientMillis)) return now;

  const SIX_HOURS = 6 * 60 * 60 * 1000;
  const FIVE_MINUTES = 5 * 60 * 1000;

  const candidate = clientMillis;
  if (candidate < now.getTime() - SIX_HOURS) return now;
  if (candidate > now.getTime() + FIVE_MINUTES) return now;
  return new Date(candidate);
}
