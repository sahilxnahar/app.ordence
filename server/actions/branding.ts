"use server";

/**
 * Ordence — White-labelling
 * Version: v1.90.0-alpha (Wave 2E)
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE COLUMN HAD THREE WRITERS AND NO READERS
 * ══════════════════════════════════════════════════════════════════════
 * `tenants.branding` has existed since 0091. The seed script writes it,
 * `claim-slug.ts` writes it on every provision, and the Clerk webhook
 * writes `DEFAULT_BRANDING` plus the organisation's image on every
 * organisation event. Nothing rendered any of it.
 *
 * This action is the first WRITER THE CUSTOMER CONTROLS, and the
 * components in `components/branding/` are the first readers.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS ACTION DELIBERATELY CANNOT DO
 * ══════════════════════════════════════════════════════════════════════
 *   · It cannot set a font, a spacing or a layout. There is no theme
 *     editor here, because every one of those controls is a way for a
 *     customer to make their own ERP unreadable and then open a ticket.
 *   · It cannot set a status colour. `lib/branding/tokens.ts` filters the
 *     emitted custom properties through an allowlist, and green, amber
 *     and red are not in it.
 *   · It cannot reach `app/platform/**`. The style block is scoped to a
 *     class mounted only on the CRM shell — an operator console wearing
 *     one customer's colours is a console where somebody does the right
 *     thing in the wrong workspace.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { withTenant } from "@/db";
import { tenants } from "@/db/schema";
import { requirePermission, writeAudit, auditMeta } from "@/server/audit";
import { TenantAccessError } from "@/server/tenant-context";
import { PermissionDeniedError } from "@/lib/permissions";
import { pathnameBelongsToTenant } from "@/lib/validators/storage";
import {
  brandingUpdateSchema,
  mergeBranding,
  parseBranding,
  type BrandingUpdateInput,
  type StoredBranding,
} from "@/lib/branding/schema";
import { evaluateContrast } from "@/lib/branding/tokens";
import type { ActionResult } from "@/lib/validators/crm";

function fail(error: string, fieldErrors?: Record<string, string[]>): ActionResult<never> {
  return { ok: false, error, fieldErrors };
}

function toActionError(err: unknown): ActionResult<never> {
  if (err instanceof TenantAccessError) return fail(err.message);
  if (err instanceof PermissionDeniedError) return fail(err.message);
  if (err instanceof z.ZodError) {
    return fail("Validation failed.", err.flatten().fieldErrors as Record<string, string[]>);
  }
  console.error("[branding action]", err);
  return fail("Something went wrong. Please try again.");
}

/**
 * Save the workspace's logo and brand colour.
 *
 * ⚠️ GATED ON `settings:update`, THE SAME KEY AS THE REST OF SETTINGS.
 * Branding is what every customer, supplier and bank sees on the
 * invoices this workspace issues; it is not a personal preference like
 * the dark-mode toggle, and an ordinary member must not be able to
 * change the letterhead of a company.
 */
export async function updateBranding(
  input: BrandingUpdateInput,
): Promise<ActionResult<{ id: string; branding: StoredBranding }>> {
  try {
    const ctx = await requirePermission("settings:update", { type: "tenant" });
    const data = brandingUpdateSchema.parse(input);

    /*
     * ══════════════════════════════════════════════════════════════
     * 🔴 THE KEY CAME FROM A BROWSER. IT IS CHECKED AGAINST THE
     *    SESSION'S TENANT, NOT AGAINST ITS OWN SHAPE.
     * ══════════════════════════════════════════════════════════════
     * `/api/upload` builds the object path server-side from the
     * session's tenant id and hands it back, so an honest client always
     * returns a key inside its own prefix. A dishonest one can post any
     * string it likes. Storing `tenants/<victim>/...` here would make
     * the (session-less) logo route publish another workspace's object,
     * and would do it with a perfectly ordinary-looking row.
     *
     * `pathnameBelongsToTenant()` is the same function the document
     * download route uses, and it also refuses `..`.
     */
    let logoPatch: { logoKey?: string | null; logoUpdatedAt?: number | null } = {};

    if (data.removeLogo) {
      /*
       * Clearing the KEY, and clearing `logoUrl` with it. Leaving the
       * Clerk URL behind would mean "remove logo" removed the logo and
       * then showed a different one, which reads as the control not
       * working.
       */
      logoPatch = { logoKey: null, logoUpdatedAt: null };
    } else if (data.logoKey) {
      if (!pathnameBelongsToTenant(data.logoKey, ctx.tenant.id)) {
        return fail("That upload does not belong to this workspace.", {
          logoKey: ["Refused."],
        });
      }
      logoPatch = { logoKey: data.logoKey, logoUpdatedAt: Date.now() };
    }

    const previous = parseBranding(ctx.tenant.branding);

    const merged = mergeBranding(ctx.tenant.branding, {
      primaryColor: data.primaryColor,
      /* Saving IS deciding — see `completeBrandingSetup` below. */
      setupCompletedAt: previous.setupCompletedAt ?? Date.now(),
      ...logoPatch,
      ...(data.removeLogo ? { logoUrl: null } : {}),
    });

    const [updated] = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .update(tenants)
        .set({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          branding: merged as any,
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, ctx.tenant.id))
        .returning({ id: tenants.id }),
    );

    if (!updated) return fail("Could not save your branding.");

    /*
     * ⚠️ THE CONTRAST VERDICT IS RECORDED, NOT JUST SHOWN. When a
     * customer later asks why their headings are darker than their logo,
     * the answer is a line in their own audit log with the ratio in it,
     * rather than an argument about what the screen said at the time.
     */
    const verdict = evaluateContrast(data.primaryColor, "light");

    await writeAudit(ctx, {
      action: "update",
      resourceType: "tenant",
      resourceId: ctx.tenant.id,
      severity: "info",
      metadata: auditMeta({
        event: "branding_updated",
        previousColor: previous.primaryColor ?? null,
        newColor: data.primaryColor,
        logoChanged: Boolean(data.logoKey) || Boolean(data.removeLogo),
        logoRemoved: Boolean(data.removeLogo),
        contrastRatio: verdict ? Number(verdict.chosenRatio.toFixed(2)) : null,
        contrastAdjusted: verdict ? !verdict.passesText : null,
      }),
    });

    /*
     * Every surface that paints the brand. `/dashboard` and `/settings`
     * because the shell is branded on both; the layout itself is
     * `force-dynamic`, so this is belt-and-braces for the cached page
     * bodies rather than the shell.
     */
    revalidatePath("/settings/branding");
    revalidatePath("/settings");
    revalidatePath("/dashboard");

    return { ok: true, data: { id: updated.id, branding: merged } };
  } catch (err) {
    return toActionError(err);
  }
}

/**
 * Mark the first-run branding screen as decided.
 *
 * ⚠️ CALLED BY "SKIP FOR NOW" AS WELL AS BY SAVING. A person who looked
 * at the screen and chose to keep Ordence's own colours has made a
 * decision; sending them back to it on the next sign-in would be the
 * product refusing to hear the answer. See
 * `lib/branding/first-run.ts#shouldPromptBrandingSetup`.
 *
 * ⚠️ IT IS A WRITE AND IS GATED LIKE ONE. The key is `settings:update`,
 * not a read key, because it changes a stored row — and because only the
 * roles that can complete the setup should be able to dismiss it.
 */
export async function completeBrandingSetup(): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requirePermission("settings:update", { type: "tenant" });

    const merged = mergeBranding(ctx.tenant.branding, { setupCompletedAt: Date.now() });

    const [updated] = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .update(tenants)
        .set({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          branding: merged as any,
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, ctx.tenant.id))
        .returning({ id: tenants.id }),
    );

    if (!updated) return fail("Could not save that.");

    await writeAudit(ctx, {
      action: "update",
      resourceType: "tenant",
      resourceId: ctx.tenant.id,
      severity: "info",
      metadata: auditMeta({ event: "branding_setup_completed" }),
    });

    revalidatePath("/dashboard");
    return { ok: true, data: { id: updated.id } };
  } catch (err) {
    return toActionError(err);
  }
}
