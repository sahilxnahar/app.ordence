import "server-only";

/**
 * Ordence — SIEM / security-review export handler
 * Version: v1.82.0-alpha (Wave 14 · Track B)
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS IS FOR
 * ══════════════════════════════════════════════════════════════════════
 * `lib/security/siem.ts` has produced NDJSON and CEF since Phase 20 and
 * has never been called. This route is the download button behind it —
 * the answer to "can you give us your security event log for our
 * review", which until now was no.
 *
 * Two modes, and the difference is which scope reads the database:
 *
 *   GET ?format=ndjson              every workspace, platform-scoped.
 *                                   Our own SOC feed.
 *   GET ?format=ndjson&tenant=<id>  ONE workspace, and the filtering is
 *                                   done by row-level security inside
 *                                   `withTenant()`, not by a WHERE clause.
 *
 * 🔴 THE CURSOR IS NOT ADVANCED BY THIS ROUTE. A download that moved the
 * high-water mark would make the export at-most-once: a browser that
 * cancelled mid-stream, or an operator who opened the URL to look, would
 * silently skip a batch of security evidence forever. Advancing it is a
 * separate, deliberate act — `commitSiemCursor()`, called from the
 * console action, after the bytes are known to have landed.
 *
 * ⚠️ THIS HANDLER GUARDS ITSELF. `requireCapability` is called before
 * anything is read, so it is safe wherever the route file that re-exports
 * it is eventually mounted. See `reliability-page.tsx` for why the route
 * file cannot live in Track B's block.
 */

import { NextResponse } from "next/server";

import { requireCapability } from "@/server/platform/guard";
import { exportForSiem, exportTenantReview } from "@/server/security/siem";
import { withObservedApiRoute, attributeObservationTo } from "@/server/observability/observe";

/**
 * ⚠️ `runtime` AND `dynamic` ARE EXPORTED BY THE ROUTE FILE, NOT HERE.
 * Next.js reads segment config only from a file it recognises as a route;
 * exported from a module the route imports they are inert, and an inert
 * `runtime = "nodejs"` on a handler that opens a database connection is
 * an edge bundle that fails at build time naming neither. The route file
 * in PATCH-REQUEST-B.md carries both.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * ⭐ WRAPPED, AND THE WRAPPER IS THE POINT AS MUCH AS THE ROUTE IS.
 *
 * `withObservedApiRoute` enters a trace context, times the handler,
 * records the outcome into `request_outcomes`, and hands a thrown error
 * to `captureError()`. Twenty-one `route.ts` files in this repository do
 * none of that because there is no shared API wrapper — which is why the
 * availability of this product has never been measured. This is the first
 * route through it.
 *
 * ⚠️ `meterAsApiCall` IS FALSE. This is a platform operator downloading
 * an operational artefact, not a customer's integration calling the API.
 * Metering it would put our own console traffic on a customer's invoice.
 */
export const handleSiemExport = withObservedApiRoute(
  { route: "/platform/reliability/export", meterAsApiCall: false },
  async (request: Request): Promise<Response> => {
    try {
      await requireCapability("observatory:read");
    } catch {
      // 404, not 403. Same reasoning as the console layout: a bespoke
      // denial confirms the endpoint exists.
      return new NextResponse(null, { status: 404 });
    }

    const url = new URL(request.url);
    const format = url.searchParams.get("format") === "cef" ? "cef" : "ndjson";
    const tenant = url.searchParams.get("tenant");

    if (tenant !== null) {
      if (!UUID_RE.test(tenant)) {
        return NextResponse.json({ error: "tenant must be a uuid" }, { status: 400 });
      }

      /**
       * ⭐ LABEL THE OBSERVATION WITH THE WORKSPACE IT WAS ABOUT. Without
       * this the row lands with a null tenant and the per-workspace view —
       * the entire argument of this track — has nothing to show for the
       * one request that was explicitly about one workspace.
       */
      attributeObservationTo({ tenantId: tenant });

      const review = await exportTenantReview({ tenantId: tenant, format, fromDays: 365 });
      if ("error" in review) {
        return NextResponse.json({ error: review.error }, { status: 503 });
      }

      return new NextResponse(review.payload, {
        status: 200,
        headers: {
          "content-type": format === "cef" ? "text/plain; charset=utf-8" : "application/x-ndjson",
          "content-disposition": `attachment; filename="ordence-security-review-${tenant}.${format === "cef" ? "log" : "ndjson"}"`,
          // ⚠️ SAID IN A HEADER, NOT ONLY IN THE FILE. An export that
          // silently stopped at its cap is a file somebody will hand over
          // saying "this is everything".
          "x-ordence-truncated": review.truncated ? "true" : "false",
          "x-ordence-events": String(review.events.length),
          "cache-control": "no-store",
        },
      });
    }

    const batch = await exportForSiem({ destination: "console", format, batchSize: 2_000 });
    if ("error" in batch) {
      return NextResponse.json({ error: batch.error }, { status: 503 });
    }

    return new NextResponse(batch.payload, {
      status: 200,
      headers: {
        "content-type": format === "cef" ? "text/plain; charset=utf-8" : "application/x-ndjson",
        "content-disposition": `attachment; filename="ordence-security-events.${format === "cef" ? "log" : "ndjson"}"`,
        "x-ordence-events": String(batch.events.length),
        // "There is more waiting" — the operator needs to know the file is
        // a page, not the archive.
        "x-ordence-more": batch.more ? "true" : "false",
        "cache-control": "no-store",
      },
    });
  },
);
