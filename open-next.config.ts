/**
 * Ordence — Cloudflare Workers build configuration
 *
 * ⚠️ R2 holds the incremental cache, not KV.
 *
 * KV is the more common choice and is wrong for us: it is eventually
 * consistent, so a page revalidated on one edge location can serve stale
 * for up to a minute elsewhere. For a CRM where somebody books a flat and
 * a colleague refreshes the inventory board, "eventually" is how two
 * people see different availability.
 */
import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";

export default defineCloudflareConfig({
  incrementalCache: r2IncrementalCache,
});
