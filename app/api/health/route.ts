import { NextResponse } from "next/server";

/**
 * ⚠️ NO `export const runtime = "edge"`.
 *
 * It was here, and on Vercel it was the right call — a liveness probe
 * should be the cheapest possible response. On Cloudflare it is both
 * unnecessary and fatal: the whole Worker already runs at the edge, so
 * the declaration buys nothing, and OpenNext requires edge-runtime routes
 * to be bundled as separate functions, so the build refuses outright:
 *
 *     app/api/health/route cannot use the edge runtime.
 *
 * Removing it costs nothing and is what lets the Worker build at all.
 */
export const dynamic = "force-dynamic";

/**
 * Liveness probe. Deliberately reveals nothing about internals —
 * no version leakage, no dependency status, no environment detail.
 */
export function GET() {
  return NextResponse.json(
    { status: "ok", timestamp: new Date().toISOString() },
    { headers: { "cache-control": "no-store" } },
  );
}
