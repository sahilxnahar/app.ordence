import "server-only";

import { sql } from "drizzle-orm";

import { withPlatformScope } from "@/db";
import {
  interpretRlsPosture,
  type RlsPosture,
  type RlsPostureFacts,
} from "@/lib/platform/rls-posture";

/**
 * Ask the database which role THIS connection authenticated as, and
 * whether row-level security applies to it.
 *
 * ⚠️ IT MUST BE THE APPLICATION'S OWN CONNECTION, NOT A DESCRIPTION OF
 *    ONE. `current_user` is the only trustworthy source: reading
 *    `DATABASE_URL` and parsing a username out of it would report what
 *    the configuration says rather than what the database sees, and
 *    those differ the moment a pooler, a proxy or a fallback URL is in
 *    play. This project already lost ten sessions to the gap between a
 *    file saying something and the database doing it.
 *
 * ⚠️ NEVER THROWS. A diagnostic that can take down the surface it is
 *    reporting on is worse than no diagnostic. On any failure the
 *    posture is `unknown`, which reads as "unverified", never as "safe".
 */
export async function readRlsPosture(): Promise<RlsPosture> {
  try {
    const facts = await withPlatformScope(
      "Diagnostic: report whether row-level security applies to this connection",
      async (tx) => {
        const result = await tx.execute(sql`
          SELECT
            current_user::text                    AS role,
            COALESCE(r.rolbypassrls, false)       AS bypasses_rls,
            COALESCE(r.rolsuper,     false)       AS is_superuser
          FROM pg_roles r
          WHERE r.rolname = current_user
        `);

        /**
         * ⚠️ TWO DRIVER SHAPES. `neon-http` returns a bare array;
         *    the pooled driver returns `{ rows }`. Indexing `[0]`
         *    directly yields `undefined` on one of them, which here
         *    would silently become "unknown" and hide the answer.
         */
        const rows = Array.isArray(result)
          ? (result as Record<string, unknown>[])
          : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);

        const row = rows[0];
        if (!row) return null;

        return {
          role: String(row.role ?? "unknown"),
          bypassesRls: row.bypasses_rls === true,
          isSuperuser: row.is_superuser === true,
        } satisfies RlsPostureFacts;
      },
    );

    return interpretRlsPosture(facts);
  } catch {
    return interpretRlsPosture(null);
  }
}
