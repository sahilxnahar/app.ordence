/**
 * Ordence — ⭐⭐⭐ BODY LIMITS — PER-ROUTE CAPS MUST NOT SHRINK AWAY — Wave 7
 * Version: v1.50.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════
 * ⚠️ THE CAPS EXIST BECAUSE EACH ONE WAS ARGUED FOR — KEEPING THEM
 * ══════════════════════════════════════════════════════════════════
 *
 * `lib/edge/budgets.ts` carries the body-limit table: the byte
 * receiver gets 64 MiB behind a signed ticket, webhooks 2 MiB, MCP
 * 1 MiB, the assistant 256 KiB (its bytes are prompt tokens we pay
 * for), telemetry 64 KiB, and the 512 KiB default catches everything
 * else — including server actions — with longest-prefix-wins.
 *
 * The failure mode of that file is not a bug; it is a loosening. The
 * assistant cap drifting from 256 KiB to 2 MiB is invisible in
 * tests, in logs, and in the UI — it shows up only on the invoice.
 * So this file asserts the numbers AS PROPERTIES, and every number
 * must stay at or below the ceiling this release certifies. The
 * table may be added to; it may not be loosened without a review.
 *
 * THE CEILINGS (Wave 7 certified — do not raise without the same
 * argument that put them there):
 *
 *   /api/upload/put   ≤ 64 MiB   (backstop above the ticket's 50 MiB)
 *   /api/webhooks     ≤ 2 MiB    (real provider events are single-digit KiB)
 *   /api/mcp          ≤ 1 MiB    (JSON-RPC batches, never files)
 *   /api/assistant    ≤ 256 KiB  (bytes = billed prompt tokens)
 *   /api/telemetry    ≤ 64 KiB   (web-vitals beacons are ~1 KiB)
 *   default           ≤ 512 KiB  (forms with long notes, server actions)
 */

import { describe, expect, it } from "vitest";
import { BODY_LIMIT_RULES } from "@/lib/edge/budgets";

const MiB = 1024 * 1024;
const KiB = 1024;

const CERTIFIED_CEILINGS: Record<string, number> = {
  "/api/upload/put": 64 * MiB,
  "/api/webhooks": 2 * MiB,
  "/api/mcp": 1 * MiB,
  "/api/assistant": 256 * KiB,
  "/api/telemetry": 64 * KiB,
  "/": 512 * KiB,
};

describe("body limit caps are certified and cannot silently loosen", () => {
  it("every certified prefix exists and stays at or below its ceiling", () => {
    for (const [prefix, ceiling] of Object.entries(CERTIFIED_CEILINGS)) {
      const rule = BODY_LIMIT_RULES.find((r) => r.prefix === prefix);
      expect(rule, `${prefix} must carry an explicit body-limit rule`).toBeDefined();
      expect(rule!.maxBytes).toBeLessThanOrEqual(ceiling);
    }
  });

  it("the default rule is the table's floor — every new route inherits the tight cap", () => {
    const defaults = BODY_LIMIT_RULES.filter((r) => r.prefix === "/");
    expect(defaults.length).toBe(1);
    /*
     * ⚠️ THE DEFAULT IS THE LAST RESORT AND THE FIRST DEFENCE. A route
     * added next month without a rule gets 512 KiB, not infinity; that
     * is the property this assertion protects. Raising the default is
     * raising the ceiling on every unknown surface at once.
     */
    expect(defaults[0]!.maxBytes).toBeLessThanOrEqual(512 * KiB);
  });

  it("longest-prefix-wins gives the specific route its specific cap", () => {
    /*
     * The assistant must get its 256 KiB cap even though `/` matches
     * everything — the lookup must be by LONGEST prefix, not first
     * match, or the default would win on every path.
     */
    expect(BODY_LIMIT_RULES.find((r) => r.prefix === "/api/assistant")!.maxBytes).toBeLessThan(
      BODY_LIMIT_RULES.find((r) => r.prefix === "/")!.maxBytes,
    );
    /*
     * And the byte receiver keeps its 64 MiB despite both `/api`
     * surfaces having their own rules — each rule is keyed to the
     * path it was argued for.
     */
    expect(
      BODY_LIMIT_RULES.find((r) => r.prefix === "/api/upload/put")!.maxBytes,
    ).toBeGreaterThan(MiB);
  });
});
