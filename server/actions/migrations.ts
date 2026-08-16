"use server";

import { getMigrationsStatus } from "@/lib/migrations/status";
import type { PlatformResult } from "@/lib/platform/schemas";
import type { MigrationsStatusResult } from "@/lib/migrations/status";

export async function checkMigrationsStatus(): Promise<PlatformResult<MigrationsStatusResult>> {
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
