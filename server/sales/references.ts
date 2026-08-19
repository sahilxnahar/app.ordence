import "server-only";

/**
 * Ordence — Human-Facing Reference Numbers
 * Version: v0.22.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY LEADS AND BOOKINGS NEED A NUMBER THAT IS NOT THEIR UUID
 * ══════════════════════════════════════════════════════════════════════
 * A UUID is correct as a primary key and useless as a thing people say
 * out loud. Sales teams read references down the phone, write them on
 * printed forms, and quote them in WhatsApp messages. "LEAD-2044" works;
 * "9f3c1e2a-…" gets transcribed wrong the first time.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY NOT `max(reference) + 1`, WHICH IS WHAT EVERYONE WRITES FIRST
 * ══════════════════════════════════════════════════════════════════════
 * Because it races, and it races the same way the double-booking does:
 * two concurrent creates both read 2044, both write 2045. The difference
 * is that this one does NOT fail loudly — the partial unique index
 * refuses the second insert, so the user sees an error creating a
 * perfectly ordinary lead on a busy afternoon and has no idea why.
 *
 * The unique index is genuine protection, so nothing is corrupted. But
 * "correct and occasionally refuses valid work" is not good enough for
 * the most common write in the product.
 *
 * SO: a bounded retry around a count-derived candidate, INSIDE the
 * caller's transaction. Concurrency is resolved by the index, and the
 * retry means the loser picks a new number instead of surfacing an
 * error. Bounded because an unbounded retry loop under contention is how
 * a busy launch weekend turns into a connection pool exhaustion.
 */

import { sql } from "drizzle-orm";

export const REFERENCE_RETRY_LIMIT = 5;

export type ReferenceScope = "lead" | "booking" | "brokerage";

const PREFIXES: Readonly<Record<ReferenceScope, string>> = Object.freeze({
  lead: "LEAD",
  booking: "BKG",
  /**
   * ⭐ v1.25.0-alpha. A brokerage bill is a document a BROKER reads,
   * chases and quotes back down the phone, so it needs a number for
   * exactly the reason leads and bookings do — and more urgently,
   * because the person on the other end is not an employee.
   */
  brokerage: "BRK",
});

/**
 * Build the next candidate reference for a tenant.
 *
 * ⚠️ MUST run inside `withTenant()` — the count is RLS-scoped, so a
 * plain connection would count zero rows and hand back "LEAD-1" for a
 * workspace that already has four hundred leads.
 */
export async function nextReference(
  tx: {
    execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
  },
  scope: ReferenceScope,
  attempt = 0,
): Promise<string> {
  const table =
    scope === "lead"
      ? sql`leads`
      : scope === "brokerage"
        ? sql`channel_partner_commissions`
        : sql`bookings`;
  const prefix = PREFIXES[scope];

  // Derived from the highest number ALREADY USED rather than from a row
  // count. A count goes backwards when a lead is deleted, which produces
  // a reference that has been used before — and a reused reference on a
  // printed booking form is a conversation nobody wants.
  const result = (await tx.execute(sql`
    SELECT COALESCE(
      MAX(NULLIF(regexp_replace(reference, '^[A-Z]+-', ''), '')::bigint),
      0
    )::bigint AS highest
    FROM ${table}
  `)) as { rows?: { highest: string | number | bigint }[] } | { highest: string }[];

  const highest = extractHighest(result);
  // The attempt offset is what makes the retry pick a different number
  // rather than re-colliding with the same one.
  const next = highest + 1n + BigInt(attempt);

  return `${prefix}-${next.toString().padStart(4, "0")}`;
}

function extractHighest(result: unknown): bigint {
  const rows = Array.isArray(result)
    ? result
    : ((result as { rows?: unknown[] })?.rows ?? []);
  const first = rows[0] as { highest?: string | number | bigint } | undefined;
  if (!first || first.highest == null) return 0n;
  try {
    return BigInt(first.highest as string | number | bigint);
  } catch {
    return 0n;
  }
}

/**
 * Run `write` with a freshly-derived reference, retrying on a uniqueness
 * collision.
 *
 * ⚠️ ONLY retries on 23505 against the reference index. Any other error
 * — a permission failure, a check constraint, the booking collision —
 * propagates immediately. A retry loop that swallows unrelated errors is
 * how a bug becomes five identical bugs.
 */
export async function withGeneratedReference<T>(
  tx: Parameters<typeof nextReference>[0],
  scope: ReferenceScope,
  write: (reference: string) => Promise<T>,
): Promise<T> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < REFERENCE_RETRY_LIMIT; attempt += 1) {
    const reference = await nextReference(tx, scope, attempt);
    try {
      return await write(reference);
    } catch (err) {
      if (!isReferenceCollision(err, scope)) throw err;
      lastError = err;
    }
  }

  throw lastError ??
    new Error(
      `Could not allocate a ${scope} reference after ${REFERENCE_RETRY_LIMIT} attempts.`,
    );
}

function isReferenceCollision(err: unknown, scope: ReferenceScope): boolean {
  if (typeof err !== "object" || err === null) return false;
  const candidate = err as { code?: unknown; constraint?: unknown; message?: unknown };
  if (candidate.code !== "23505") return false;

  /**
   * ⚠️ THE INDEX NAME IS PER SCOPE AND HAS TO BE, because this function
   * decides whether to RETRY or to RETHROW. A brokerage bill that
   * collided on `cp_commissions_one_live_per_tranche` — the same tranche
   * raised twice — must NOT be retried under a new reference; that is a
   * duplicate bill, and retrying it would pay the broker twice with two
   * different numbers on it.
   */
  const indexName =
    scope === "lead"
      ? "leads_reference_tenant_unique"
      : scope === "brokerage"
        ? "cp_commissions_reference_tenant_unique"
        : "bookings_reference_tenant_unique";

  if (candidate.constraint === indexName) return true;
  return typeof candidate.message === "string" && candidate.message.includes(indexName);
}
