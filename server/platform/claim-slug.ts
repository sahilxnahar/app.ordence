import "server-only";

/**
 * Ordence — Claiming a tenant slug
 * Version: v1.56.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⭐ THE PRINCIPLE, RESTATED HERE BECAUSE THIS FILE IS WHERE IT IS OBEYED
 * ══════════════════════════════════════════════════════════════════════════
 *
 *       The availability check is advisory.
 *       The unique index is the truth.
 *       The insert is the claim.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS AT ALL — IT INVENTS NOTHING
 * ══════════════════════════════════════════════════════════════════════════
 * `server/platform/provisioning.ts` already got the hard part right. Its
 * `INSERT ... ON CONFLICT (slug) DO NOTHING RETURNING id`, followed by a
 * check of how many rows came back, is what actually prevents a duplicate —
 * not the existence check in the dry run. Its own comment says so.
 *
 * That mechanism is about to have a SECOND caller: self-serve signup. A
 * second copy of it is the two-reserved-word-lists incident rebuilt in a new
 * shape — one copy gets a fix, the other does not, and the difference is
 * invisible until two people sign up in the same second. So the mechanism
 * moved here, unchanged, and provisioning calls it.
 *
 * 🔴 DO NOT REPLACE THE `ON CONFLICT` WITH A `SELECT ... WHERE NOT EXISTS`.
 *    That is the race, written out longhand. Between the SELECT and the
 *    INSERT there is a window whose width is the network, and under
 *    READ COMMITTED both concurrent transactions see "free".
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴 A REFUSAL LEAVES THE CALLER'S TRANSACTION ABORTED. THIS IS NOT A BUG.
 * ══════════════════════════════════════════════════════════════════════════
 * `claimSlug` runs INSIDE the caller's transaction and deliberately does not
 * open one of its own — not a nested one, not a SAVEPOINT. So when the guard
 * trigger raises `P0091` or an index raises `23505`, PostgreSQL puts the
 * WHOLE transaction into the aborted state, and every later statement on it
 * fails with `25P02 current transaction is aborted`.
 *
 * ⚠️ THEREFORE: a caller that receives `{ ok: false }` MUST stop writing and
 *    unwind the transaction — throw out of the `withPlatformScope` callback,
 *    or return in a way that rolls back. It must NOT try to record an audit
 *    row, or a "failed signup" row, on the same handle. Do that bookkeeping
 *    in a NEW transaction after this one has rolled back.
 *
 *    That is the correct shape anyway: a slug that was refused was never
 *    claimed, so nothing that depended on the claim should survive.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ TWO TABLES, TWO DIFFERENT KINDS OF `slug_fold`. GET THIS RIGHT.
 * ══════════════════════════════════════════════════════════════════════════
 *   `tenants.slug_fold`              GENERATED ALWAYS AS (...) STORED.
 *                                    🔴 NEVER NAMED IN AN INSERT OR UPDATE.
 *                                    PostgreSQL rejects the whole statement
 *                                    (42601) if you do.
 *
 *   `tenant_slug_history.slug_fold`  An ORDINARY NOT NULL column. It MUST be
 *                                    written, with `foldSlug()`, or the row
 *                                    fails its NOT NULL — and if it were
 *                                    somehow allowed to drift from the SQL
 *                                    expression, the 365-day retention check
 *                                    would silently narrow and a released
 *                                    `acme-corp` would stop blocking a fresh
 *                                    `acmecorp`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ SQLSTATE, NEVER MESSAGE TEXT
 * ══════════════════════════════════════════════════════════════════════════
 * `0091_slug_authority.sql` raises distinct SQLSTATEs precisely so that no
 * application ever has to read an English sentence to decide what happened.
 * The mapping lives in ONE place — `rejectionFromPgError()` in `lib/slug.ts`
 * — and this file does nothing but hand it the code and the constraint name.
 * A `message.includes("reserved")` here would break the first time the
 * database runs under a non-English `lc_messages`.
 */

import { sql } from "drizzle-orm";

import type { withPlatformScope } from "@/db";
import type { PlanTier } from "@/db/schema/core";
import { tenantSlugHistory } from "@/db/schema/slugs";
import {
  foldSlug,
  rejection,
  rejectionFromPgError,
  type SlugRejection,
} from "@/lib/slug";

/**
 * The caller's open handle.
 *
 * ⚠️ DERIVED FROM `withPlatformScope`, NOT `withTenant`, and the difference
 * is load-bearing. `tenant_slug_history` has `WITH CHECK (app_platform_scope())`
 * on its write policy: a tenant session writing its own slug history is
 * exactly what that policy refuses, because the history row is the evidence
 * of what the PLATFORM did. The two handles are structurally identical, so
 * TypeScript will not catch a `withTenant` caller — RLS will, at runtime,
 * by refusing the insert.
 */
type PlatformTx = Parameters<Parameters<typeof withPlatformScope>[1]>[0];

/* ------------------------------------------------------------------ */
/* INPUT                                                               */
/* ------------------------------------------------------------------ */

/**
 * Everything about a brand-new tenant row that is NOT the slug.
 *
 * ⚠️ THE WHOLE ROW GOES IN ONE STATEMENT, ON PURPOSE. The claim is the
 * insert. Splitting it into "reserve the slug, then fill in the rest" would
 * create a window in which a half-built tenant holds a public hostname.
 */
export type NewTenantRow = {
  /**
   * ⚠️ A PLACEHOLDER AT PROVISIONING TIME, AND IT HAS TO BE SOMETHING.
   * `tenants.clerk_org_id` is NOT NULL with no default, and the real Clerk
   * organisation cannot be created inside this transaction — an external
   * call cannot be rolled back with it. The caller supplies a deterministic
   * `pending:<slug>` marker so an unfinished provision stays greppable.
   */
  clerkOrgId: string;
  name: string;
  legalName: string | null;
  planTier: PlanTier;
  seatLimit: number;
  storageLimitMb: number;
  /** ISO timestamp, or null for "no trial". */
  trialEndsAt: string | null;
  customDomain: string | null;
  settings: Record<string, unknown>;
  branding: Record<string, unknown>;
};

export type ClaimSlugParams = {
  /**
   * The slug to claim. Lowercased and trimmed here as well as by the
   * caller's schema, because `tenants_slug_lowercase` is a hard CHECK and
   * "the caller definitely normalised it" is how the second caller differs
   * from the first.
   */
  slug: string;

  /**
   * The tenant this slug is FOR.
   *
   *   absent / null → a fresh claim. `tenant` must be supplied and a new
   *                   row is inserted; the new id comes back in the result.
   *   present       → an existing workspace is renaming. The row is updated
   *                   in place and the same id comes back.
   */
  tenantId?: string | null;

  /** Required for a fresh claim, ignored on a rename. */
  tenant?: NewTenantRow;

  /**
   * Who is claiming — an operator email, or `signup:<email>` for self-serve.
   *
   * ⚠️ NOT WRITTEN TO `tenant_slug_history`: that table has no actor column,
   * because the actor belongs in the audit trail, which is chained and
   * tamper-evident, and duplicating it here would create a second version of
   * the truth that nothing reconciles. It is carried so that an UNEXPECTED
   * failure names the caller in the log instead of naming the trigger.
   */
  actor: string;
};

export type ClaimSlugResult =
  | { ok: true; tenantId: string }
  | { ok: false; rejection: SlugRejection };

/* ------------------------------------------------------------------ */
/* THE CLAIM                                                           */
/* ------------------------------------------------------------------ */

/**
 * Claim `slug` for a tenant, inside the caller's already-open transaction.
 *
 * Returns a rejection — it does NOT throw — for every refusal the database
 * is expected to produce: reserved, taken, too similar, recently released.
 * Those are answers, not faults. Anything else propagates, because a caller
 * that cannot tell "someone beat you to it" apart from "the database is
 * down" will report the second as the first.
 *
 * ⚠️ SEE THE HEADER: on `{ ok: false }` the caller's transaction is aborted
 *    and must be unwound.
 */
export async function claimSlug(
  tx: PlatformTx,
  params: ClaimSlugParams,
): Promise<ClaimSlugResult> {
  const slug = params.slug.trim().toLowerCase();
  const fold = foldSlug(slug);
  const existingTenantId = params.tenantId ?? null;

  if (!params.actor) {
    throw new Error("[claimSlug] called without an actor. Every claim is attributable.");
  }
  if (existingTenantId === null && !params.tenant) {
    throw new Error(
      "[claimSlug] a fresh claim needs the rest of the tenant row. " +
        "Pass `tenant`, or pass `tenantId` to rename an existing workspace.",
    );
  }

  let claimedId: string | null;
  try {
    claimedId =
      existingTenantId === null
        ? await insertTenant(tx, slug, params.tenant as NewTenantRow)
        : await renameTenant(tx, slug, existingTenantId);
  } catch (error) {
    const pg = asPgError(error);
    const mapped = rejectionFromPgError(pg?.code, pg?.constraint);
    if (mapped) {
      /*
       * ⚠️ A SHAPE REFUSAL FROM THE DATABASE SHOULD BE UNREACHABLE and is
       * logged loudly rather than returned quietly. `checkSlugShape()` and
       * `tenants_slug_shape` are supposed to agree byte for byte; if the
       * CHECK fires, one of them has drifted and every caller is now
       * showing users a form that lies about what it will accept.
       */
      if (mapped.code === "bad_characters") {
        console.error(
          `[claimSlug] DRIFT: the database refused the SHAPE of "${slug}" (${pg?.code}/${pg?.constraint}), ` +
            `but checkSlugShape() accepted it. Actor: ${params.actor}. ` +
            `lib/slug.ts and 0091_slug_authority.sql no longer agree.`,
        );
      }
      return { ok: false, rejection: mapped };
    }
    throw error;
  }

  /*
   * ⭐ ZERO ROWS IS THE REFUSAL, AND IT ARRIVES WITHOUT AN ERROR.
   *
   * `ON CONFLICT (slug) DO NOTHING` does not raise; it simply inserts
   * nothing and returns nothing. Two callers racing for the same slug both
   * pass every advisory check and both reach this statement; the database
   * picks one, and the loser lands exactly here.
   *
   * ⚠️ Only the EXACT-slug conflict is swallowed by the ON CONFLICT clause.
   * A confusable-fold collision comes back as a 23505 from
   * `tenants_slug_fold_unique` and is handled in the catch above, which is
   * correct: the two mean different things to the person reading the
   * message.
   */
  if (claimedId === null) {
    return { ok: false, rejection: rejection("taken") };
  }

  /*
   * ⭐ THE HISTORY ROW IS PART OF THE CLAIM, NOT A LOG OF IT.
   *
   * It is written in the SAME transaction, so a tenant can never exist
   * without the record of when its hostname started being live. That record
   * is what makes the 365-day retention rule enforceable on the day the
   * workspace is renamed or closed — and the retention rule is the only
   * thing standing between a released hostname and a different company
   * receiving its bookmarked links, emailed invoices and CT-log identity.
   *
   * 🔴 `slugFold` IS WRITTEN HERE. This is the ordinary column, not the
   *    generated one on `tenants`. See the header.
   *
   * `claimedAt` is left to the column default (`now()`), which is the
   * transaction timestamp — so it is identical for every row written by
   * this claim rather than drifting by a few milliseconds.
   */
  await tx.insert(tenantSlugHistory).values({
    tenantId: claimedId,
    slug,
    slugFold: fold,
  });

  return { ok: true, tenantId: claimedId };
}

/* ------------------------------------------------------------------ */
/* THE TWO STATEMENTS                                                  */
/* ------------------------------------------------------------------ */

/**
 * A fresh claim. Lifted from `provisionWorkspace` unchanged in substance.
 *
 * ⚠️ NO BACKTICKS ANYWHERE INSIDE THE sql`` TEMPLATE. One backtick in a
 * comment terminates the template literal and the file stops parsing —
 * which is why this note is out here.
 *
 * 🔴 `slug_fold` IS NOT IN THE COLUMN LIST AND MUST NEVER BE. It is
 *    GENERATED ALWAYS AS ... STORED; naming it fails the whole statement.
 */
async function insertTenant(
  tx: PlatformTx,
  slug: string,
  tenant: NewTenantRow,
): Promise<string | null> {
  const result = await tx.execute(sql`
    INSERT INTO tenants (
      clerk_org_id,
      slug, name, legal_name, plan_tier, status,
      seat_limit, storage_limit_mb, trial_ends_at,
      custom_domain, settings, branding
    ) VALUES (
      ${tenant.clerkOrgId},
      ${slug},
      ${tenant.name},
      ${tenant.legalName},
      ${tenant.planTier},
      'active',
      ${tenant.seatLimit},
      ${tenant.storageLimitMb},
      ${tenant.trialEndsAt},
      ${tenant.customDomain},
      ${JSON.stringify(tenant.settings)}::jsonb,
      ${JSON.stringify(tenant.branding)}::jsonb
    )
    ON CONFLICT (slug) DO NOTHING
    RETURNING id
  `);

  const row = firstRow(result);
  return row?.id === undefined || row.id === null ? null : String(row.id);
}

/**
 * A rename.
 *
 * ⚠️ THERE IS NO `ON CONFLICT` ON AN UPDATE, and none is wanted. A rename
 * that collides comes back as a plain 23505 from whichever index caught it,
 * and the caller gets `taken` or `too_similar` accordingly — which is more
 * informative than the silence `DO NOTHING` produces on the insert path.
 *
 * Zero rows here therefore means the tenant id does not exist, which is a
 * programming error rather than a refusal, and it throws.
 */
async function renameTenant(
  tx: PlatformTx,
  slug: string,
  tenantId: string,
): Promise<string | null> {
  const result = await tx.execute(sql`
    UPDATE tenants
       SET slug = ${slug}
     WHERE id = ${tenantId}::uuid
    RETURNING id
  `);

  const row = firstRow(result);
  if (!row?.id) {
    throw new Error(`[claimSlug] no tenant with id ${tenantId} to rename.`);
  }
  return String(row.id);
}

/* ------------------------------------------------------------------ */
/* DRIVER SHIMS                                                        */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ `tx.execute()` RETURNS TWO DIFFERENT SHAPES depending on which Neon
 * driver built the client: the HTTP driver hands back a bare array of rows,
 * the WebSocket/pool driver hands back a pg-style `QueryResult` with a
 * `.rows` property. Indexing `[0]` on the second one yields `undefined`,
 * which on this code path would read as "the slug was taken" for EVERY
 * claim — a refusal invented out of a shape mismatch. Handle both.
 */
function firstRow(result: unknown): Record<string, unknown> | null {
  if (Array.isArray(result)) {
    return (result[0] as Record<string, unknown> | undefined) ?? null;
  }
  const rows = (result as { rows?: unknown } | null)?.rows;
  if (Array.isArray(rows)) {
    return (rows[0] as Record<string, unknown> | undefined) ?? null;
  }
  return null;
}

type PgErrorShape = { code?: string; constraint?: string };

/**
 * Pull the SQLSTATE and constraint name out of whatever Drizzle threw.
 *
 * ⚠️ DRIZZLE WRAPS DRIVER ERRORS. Since 0.44 a failing query surfaces as a
 * `DrizzleQueryError` whose `cause` is the real `pg` error, so reading
 * `err.code` off the top-level object finds nothing and every refusal
 * silently becomes an unexpected 500. Walking the `cause` chain costs three
 * lines and survives the next wrapper.
 *
 * ⚠️ IT LOOKS AT `code` AND `constraint` ONLY. Not `message`. The SQLSTATEs
 * in 0091 exist precisely so that nothing has to read English.
 */
function asPgError(error: unknown): PgErrorShape | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === "object") {
      const candidate = current as Record<string, unknown>;
      if (typeof candidate.code === "string") {
        return {
          code: candidate.code,
          constraint:
            typeof candidate.constraint === "string" ? candidate.constraint : undefined,
        };
      }
      current = candidate.cause;
      continue;
    }
    return null;
  }
  return null;
}
