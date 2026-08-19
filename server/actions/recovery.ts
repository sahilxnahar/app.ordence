"use server";

/**
 * Ordence — Recovery Actions
 * Version: v0.21.0-alpha
 *
 * The recycle bin and the data export, exposed to the customer.
 *
 * ⚠️ Every export is an async function — a `"use server"` file may
 * export nothing else. The catalogue and its rules live in
 * `lib/backup/recoverable.ts`.
 */

import { and, eq } from "drizzle-orm";
import { db, withTenant } from "@/db";
import { tenants } from "@/db/schema";
import { requirePermission, writeAudit } from "@/server/audit";
import { TenantAccessError } from "@/server/tenant-context";
import {
  assertImpersonationAllows,
  ImpersonationForbiddenError,
} from "@/server/platform/impersonation";
import { PermissionDeniedError } from "@/lib/permissions";
import { AccessRestrictedError } from "@/server/billing/access";
import {
  listDeletedRecords,
  checkRestorable,
  restoreRecord,
  RestoreBlockedError,
  type DeletedRecord,
} from "@/server/backup/restore";
import {
  exportTenantData,
  serialiseExport,
  exportFileName,
} from "@/server/backup/export";
import {
  RECOVERY_WINDOW_DAYS,
  recoverableFor,
} from "@/lib/backup/recoverable";
import {
  checkRateLimit,
  tenantRateLimitKey,
} from "@/lib/security/rate-limit";
import type { ActionResult } from "@/lib/validators/crm";

function fail(error: string): ActionResult<never> {
  return { ok: false, error };
}

function toActionError(err: unknown, scope: string): ActionResult<never> {
  if (err instanceof TenantAccessError) return fail(err.message);
  if (err instanceof PermissionDeniedError) return fail(err.message);
  if (err instanceof ImpersonationForbiddenError) return fail(err.message);
  if (err instanceof RestoreBlockedError) return fail(err.message);
  /**
   * ⚠️ Should never fire on this file's paths.
   *
   * Export is on the always-permitted write list precisely so a locked
   * workspace can still leave with its data — under DPDP the right of
   * access does not lapse because an invoice is outstanding. Mapped
   * anyway rather than surfacing as "something went wrong", so that if
   * the exemption list is ever edited the failure is legible.
   */
  if (err instanceof AccessRestrictedError) return fail(err.message);

  console.error(`[recovery:${scope}]`, err);
  return fail("Something went wrong. Please try again.");
}

/* ------------------------------------------------------------------ */
/* THE RECYCLE BIN                                                     */
/* ------------------------------------------------------------------ */

export async function getRecycleBin(): Promise<
  ActionResult<{
    records: DeletedRecord[];
    windowDays: number;
    partial: boolean;
  }>
> {
  try {
    /**
     * `*:read` rather than a delete or admin permission.
     *
     * Someone who can see a record should be able to see that it was
     * deleted and ask for it back. Gating the bin behind an admin
     * permission means the person who made the mistake cannot fix it and
     * has to find someone who can — which is how a two-second correction
     * becomes a two-day one.
     *
     * Restoring is gated harder. Looking is not.
     */
    const ctx = await requirePermission("contacts:read");

    const { records, failures } = await listDeletedRecords(ctx.tenant.id);

    return {
      ok: true,
      data: {
        records,
        windowDays: RECOVERY_WINDOW_DAYS,
        // Stated rather than hidden: a bin that quietly omits a category
        // tells the customer their record is gone forever.
        partial: failures.length > 0,
      },
    };
  } catch (err) {
    return toActionError(err, "getRecycleBin");
  }
}

export async function canRestore(input: {
  table: string;
  id: string;
}): Promise<ActionResult<{ allowed: boolean; message: string }>> {
  try {
    const ctx = await requirePermission("contacts:read");
    const verdict = await checkRestorable(ctx.tenant.id, input.table, input.id);
    return { ok: true, data: { allowed: verdict.allowed, message: verdict.message } };
  } catch (err) {
    return toActionError(err, "canRestore");
  }
}

export async function restoreFromRecycleBin(input: {
  table: string;
  id: string;
}): Promise<ActionResult<{ label: string }>> {
  try {
    /**
     * 🔴 WAS A FLAT `contacts:update` FOR EVERY TABLE.
     *
     * Restoring changes data, so a write permission was right. Using
     * the CONTACTS write permission to restore a CONTRACT was not: a
     * `member` holds `contacts:update` and holds neither
     * `contracts:update` nor `documents:create`, so the recycle bin was
     * a way around both.
     *
     * ⚠️ THE PERMISSION NOW COMES FROM THE CATALOGUE ENTRY, so a new
     * recoverable entity cannot be added without deciding who may bring
     * one back — the type requires it.
     */
    const entity = recoverableFor(input.table);
    if (!entity) {
      return fail(
        "That is not something the recycle bin can restore. If you reached " +
          "this from a link, the link is out of date.",
      );
    }
    const ctx = await requirePermission(entity.restorePermission);

    const result = await restoreRecord({
      tenantId: ctx.tenant.id,
      table: input.table,
      id: input.id,
      actor: {
        userId: ctx.user.id,
        clerkId: ctx.clerkUserId,
        email: ctx.user.email,
        role: ctx.role,
      },
    });

    return { ok: true, data: { label: result.label } };
  } catch (err) {
    return toActionError(err, "restoreFromRecycleBin");
  }
}

/* ------------------------------------------------------------------ */
/* EXPORT                                                              */
/* ------------------------------------------------------------------ */

/**
 * A complete copy of the workspace's data.
 *
 * ⚠️ Requires `workspace:export`. It required `settings:read` until
 * v1.31.0, and the `read_only` role holds `settings:read` — so the role
 * handed out for "let them see the numbers", deliberately denied
 * `contacts:export`, `reports:export`, `leads:export` and `tds:read`,
 * could pull all of it in one call with nothing recorded.
 *
 * The line the old comment described was right; the key was not. An
 * owner or admin holds `workspace:export`, and a customer trying to
 * leave can still always get their data out — it stays on the
 * always-permitted list for a locked account.
 */
export async function exportWorkspace(): Promise<
  ActionResult<{ json: string; fileName: string; counts: Record<string, number> }>
> {
  try {
    const ctx = await requirePermission("workspace:export");
    /*
      ⭐ THE ONE THAT TURNS SUPPORT INTO AN EXFILTRATION CHANNEL.
      This action returns the ENTIRE workspace as a JSON file. It is
      on the always-permitted list for a locked account precisely so a
      customer can always leave with their data — and that same
      openness is why an impersonated caller must never reach it. The
      customer consented to us diagnosing a bug, not to us taking a
      copy of everything they have.
    */
    await assertImpersonationAllows("export:workspace", ctx);

    /**
     * 🔴 A BUDGET, BECAUSE ONE EXPORT IS A BACKUP AND FIFTY IS A LEAK.
     *
     * There was no limit of any kind on this action. A departing
     * employee could call it in a loop and nothing counted. The budget
     * is deliberately generous — a customer leaving must not be
     * throttled out of their own data — and deliberately finite.
     */
    const budget = await checkRateLimit(
      "search",
      tenantRateLimitKey(ctx.tenant.id, ctx.user.id),
    );
    if (!budget.allowed) {
      return fail(
        "You have exported this workspace several times in a short period. " +
          "Wait a few minutes and try again. If you are migrating away and " +
          "need this repeatedly, contact support and we will help directly.",
      );
    }

    const [tenant] = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .select({ name: tenants.name, legalName: tenants.legalName })
        .from(tenants)
        .where(and(eq(tenants.id, ctx.tenant.id)))
        .limit(1)
    );

    const exported = await exportTenantData(
      ctx.tenant.id,
      tenant?.legalName ?? tenant?.name ?? "workspace",
    );

    /**
     * 🔴 RECORDED BEFORE THE PAYLOAD LEAVES, AND AT `critical`.
     *
     * Nothing on this path wrote an audit row before v1.31.0. The
     * single largest read in the product left no trace at all, so
     * "did anyone take a copy of everything before they left?" was
     * unanswerable.
     *
     * ⚠️ The counts go in the row. "Exported the workspace" is not
     * evidence; "exported 4,182 contacts and 11,904 journal entries at
     * 02:14" is.
     */
    await writeAudit(ctx, {
      action: "export",
      resourceType: "workspace",
      resourceId: ctx.tenant.id,
      severity: "critical",
      reason:
        "Complete workspace export downloaded. Every record in every module, " +
        "including the audit log.",
      metadata: {
        counts: exported.manifest.counts,
        totalRows: Object.values(exported.manifest.counts).reduce(
          (a, b) => a + b,
          0,
        ),
        exportedAt: exported.manifest.exportedAt,
      },
    });

    return {
      ok: true,
      data: {
        json: serialiseExport(exported),
        fileName: exportFileName(
          tenant?.name ?? "workspace",
          new Date(exported.manifest.exportedAt),
        ),
        counts: exported.manifest.counts,
      },
    };
  } catch (err) {
    return toActionError(err, "exportWorkspace");
  }
}
