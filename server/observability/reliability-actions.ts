"use server";

/**
 * Ordence — Reliability console actions
 *
 * ⚠️ IN `server/observability/` RATHER THAN BESIDE A PAGE, because Track
 * B's assigned `app/` block cannot contain a file — see
 * `reliability-page.tsx` for the security test that establishes it.
 * Version: v1.82.0-alpha (Wave 14 · Track B)
 *
 * 🔴 EVERY EXPORT OF A `"use server"` BOUNDARY IS A PUBLIC HTTP ENDPOINT.
 * It is reachable by anybody who can POST to any page in this
 * application, not only by somebody looking at this screen. Both
 * functions below therefore call `requireCapability()` as their first
 * statement, exactly as `server/platform/access-review.ts` does, and
 * neither trusts anything the form sent about who is asking.
 */

import { requireCapability } from "@/server/platform/guard";
import { commitSiemCursor, exportForSiem } from "@/server/security/siem";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Write a note against an alert and stamp who wrote it.
 *
 * ⭐ THIS IS WHAT MAKES "RECENT INCIDENTS" WORTH READING. An alert that
 * fired and was closed in four minutes and an alert that fired and has
 * sat open for two days are the same row until somebody records the
 * difference. The `observability_alerts_ack_complete` CHECK refuses an
 * acknowledgement with no name on it, so the two columns cannot drift.
 *
 * ⚠️ THE OPERATOR'S EMAIL COMES FROM `requireCapability()`, NEVER FROM
 * THE FORM. A form field naming who acknowledged something is a form
 * field anybody can set.
 */
export async function acknowledgeAlertAction(
  formData: FormData,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const operator = await requireCapability("observatory:read");

  const alertId = String(formData.get("alertId") ?? "");
  if (!UUID_RE.test(alertId)) return { ok: false, error: "That alert id is not a uuid." };

  const note = String(formData.get("note") ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 500);

  try {
    const { withPlatformScope, withTenant } = await import("@/db");
    const { sql } = await import("drizzle-orm");

    /**
     * ⚠️ TWO STEPS, AND THE FIRST ONE EXISTS BECAUSE OF SQL 0135's POLICY.
     *
     * A tenant-attributed alert row can only be UPDATED inside that
     * workspace's own scope — a platform-scoped UPDATE is refused by the
     * WITH CHECK clause, which is the same rule that stops any
     * platform-scoped code path attributing a row to any workspace.
     * Proven refused in TRACK-REPORT.md §3.
     *
     * So: read which workspace the alert belongs to (platform scope, which
     * can see every row), then update in the scope that owns it. The id
     * came from the form and is re-read here rather than trusted; a
     * caller who supplies an id belonging to a workspace they invented
     * gets zero rows, not a write.
     */
    const owner = await withPlatformScope(
      "observability: resolve which workspace an operator alert belongs to before acknowledging it",
      async (tx) => {
        const r = await tx.execute(sql`
          SELECT tenant_id FROM observability_alerts WHERE id = ${alertId}::uuid
        `);
        const rows = (r as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [];
        const first = rows[0];
        if (!first) return null;
        const tenantId = typeof first.tenant_id === "string" ? first.tenant_id : null;
        return { found: true, tenantId };
      },
    );

    if (!owner) return { ok: false, error: "That alert no longer exists." };

    const statement = sql`
      UPDATE observability_alerts
         SET acknowledged_at   = now(),
             acknowledged_by   = ${operator.email},
             acknowledgement_note = ${note.length > 0 ? note : null}
       WHERE id = ${alertId}::uuid
         AND acknowledged_at IS NULL
    `;

    if (owner.tenantId) {
      await withTenant(owner.tenantId, async (tx) => {
        await tx.execute(statement);
      });
    } else {
      await withPlatformScope(
        "observability: record who acknowledged a platform-wide operator alert and what they did",
        async (tx) => {
          await tx.execute(statement);
        },
      );
    }
    return { ok: true };
  } catch {
    // Deliberately vague to the reader. A raw Postgres message on an
    // operator screen is still a Postgres message on a screen.
    return { ok: false, error: "The acknowledgement could not be recorded." };
  }
}

/**
 * Advance the SIEM export high-water mark for the console feed.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS IS A SEPARATE, DELIBERATE ACT AND NOT PART OF THE DOWNLOAD
 * ══════════════════════════════════════════════════════════════════════
 * `GET /admin/health/export` reads and serialises and does NOT move the
 * cursor. If it did, an operator who opened the URL to look, or a browser
 * that cancelled the stream, would silently skip a batch of security
 * evidence — permanently, with no error and nothing to notice.
 *
 * Export is at-least-once by design: a duplicate batch is noise a SOC
 * deduplicates on event id, a missing one is an attack nobody saw. This
 * button is the operator saying "those bytes landed", which is the only
 * fact the system cannot determine for itself.
 *
 * ⚠️ IT RE-READS THE BATCH RATHER THAN TRUSTING A CURSOR FROM THE FORM. A
 * form-supplied cursor is a caller-chosen high-water mark: post a far
 * future timestamp and every security event before it is skipped forever.
 */
export async function commitSiemExportAction(
  formData: FormData,
): Promise<{ ok: true; advanced: number } | { ok: false; error: string }> {
  await requireCapability("observatory:read");

  const format = String(formData.get("format") ?? "ndjson") === "cef" ? "cef" : "ndjson";

  const batch = await exportForSiem({ destination: "console", format, batchSize: 2_000 });
  if ("error" in batch) return { ok: false, error: batch.error };
  if (batch.events.length === 0) return { ok: true, advanced: 0 };

  const committed = await commitSiemCursor({
    destination: "console",
    format,
    cursor: batch.nextCursor,
    exported: batch.events.length,
    error: null,
  });

  return committed
    ? { ok: true, advanced: batch.events.length }
    : { ok: false, error: "The cursor could not be advanced; the batch will be offered again." };
}
