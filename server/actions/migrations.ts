"use server";

import { requirePlatformAdmin } from "@/server/platform/guard";
import { getMigrationsStatus } from "@/lib/migrations/status";
import type { PlatformResult } from "@/lib/platform/schemas";
import type { MigrationsStatusResult } from "@/lib/migrations/status";

/**
 * ⭐ WHY THE GUARD IS HERE, NOT JUST IN THE LIBRARY
 *
 * `check:guards` must see a guard DIRECTLY in this body: delegation into
 * `lib/migrations/status.ts` is invisible to the census, and a status
 * endpoint that any tenant user could call would hand every workspace a
 * map of exactly which enforcement exists in the database — including
 * which hash-chain columns a bad actor should blank. The rule lives
 * twice: here (visible to the gate) and in the library (visible to
 * every other caller).
 */
export async function checkMigrationsStatus(): Promise<PlatformResult<MigrationsStatusResult>> {
  await requirePlatformAdmin();
  try {
    const data = await getMigrationsStatus();
    return { ok: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `migrations_check_failed: ${message}`,
    };
  }
}
