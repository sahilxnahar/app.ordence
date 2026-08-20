/**
 * Ordence — writer: `leads`
 * Version: v1.85.0-alpha · Phase 4
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS WRITER MIRRORS `createLead()` IN `server/actions/sales-leads.ts`
 *    AND THE PLACES IT DELIBERATELY DOES NOT ARE THE INTERESTING PART
 * ══════════════════════════════════════════════════════════════════════
 * What it copies, because a lead created by an import must be the same
 * kind of object as a lead created by the form:
 *
 *   · the reference, allocated through `withGeneratedReference("lead")`,
 *     which retries on the tenant-unique index rather than guessing;
 *   · the score, computed by `scoreLead` rather than stored from a file —
 *     a score is derived, and a derived value accepted from a spreadsheet
 *     is a derived value that is wrong the moment anything changes;
 *   · `consent_at` set to the moment of the write when a consent source
 *     is given, never taken from the file;
 *   · the first `lead_activities` row, which is the permanent record of
 *     where the lead came from.
 *
 * 🔴 WHAT IT DOES NOT COPY, ON THE UPDATE PATH, AND WHY EACH ONE WOULD BE
 *    A LOSS OF CUSTOMER DATA:
 *
 *   · `status` — the file says an enquiry arrived. The workspace may
 *     already know it was qualified, visited the site and was lost.
 *     Writing "new" over that is not an update, it is an erasure, and
 *     `leads_lost_has_reason` would not even complain.
 *   · `reference` — a human-facing number people quote on the phone.
 *   · `cp_locked_until` and `channel_partner_id` — the commission
 *     protection window is set AT REGISTRATION and re-stamping it on
 *     every re-upload extends a broker's claim by however long the
 *     migration took.
 *   · `consent_at` for a lead that already has one — the earliest
 *     recorded basis is the evidence; overwriting it with today's date
 *     destroys the only thing that made the contact lawful.
 *   · `duplicate_of` — a duplicate that was decided is recorded, never
 *     unrecorded.
 *
 * ⚠️ AND NO `lead_activities` ROW ON UPDATE. That table is append-only in
 * practice and appending is not reversible: an undo restores the lead's
 * prior columns and cannot un-say a note. A run that logged "updated by
 * import" on ten thousand leads would leave ten thousand entries behind
 * after the undo reported success.
 */

import "server-only";

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { withTenant } from "@/db";
import { leadActivities, leads } from "@/db/schema";
import type { LeadSource, LeadTemperature } from "@/db/schema/sales";
import { scoreLead } from "@/lib/sales/pipeline";
import { toMinorUnits } from "@/lib/validators/accounting";
import { withGeneratedReference } from "@/server/sales/references";
import { describeWriteFailure, matchAny } from "../shared";
import type { ImportNaturalKey } from "@/lib/import";
import type { TenantContext } from "@/server/tenant-context";
import type { ImportWriter, WriteOutcome } from "../types";

/*
 * ⚠️ THE ENUM TYPES COME FROM THE ENUM, NOT FROM `$inferInsert`.
 * `leads.source` and `leads.temperature` carry database defaults, so
 * their inferred INSERT types include `undefined` — and a local alias of
 * that would have made `source` nullable here and pushed the fallback
 * into the database, where "blank means website" is written down nowhere.
 */
/**
 * 🔴 THE MATCH IS AGAINST THE GENERATED COLUMNS, NOT AGAINST `phone` AND
 *    `email`.
 *
 * `leads.phone_digits` is `GENERATED ALWAYS AS right(regexp_replace(
 * coalesce(phone,''),'[^0-9]','','g'), 10)` and `leads.email_key` is
 * `lower(btrim(coalesce(email,'')))`. The database computes both on every
 * write from any path, including this one, so comparing against them
 * cannot drift from what is stored. Comparing against `phone` instead
 * would miss +91 98765 43210 against 09876543210 — the same man, twice,
 * which is the duplicate this product's own schema comment names.
 *
 * ⚠️ AN EMPTY-STRING KEY IS NOT A MATCH. Both generated columns are
 * `coalesce(...,'')`, so every lead with no email has `email_key = ''`.
 * A row keyed on `''` would match all of them at once. The pure layer
 * never emits an empty key — but "never emits" is a property of another
 * file, and this is the one holding the customer's data, so the guard is
 * restated here.
 */
async function findExisting(
  ctx: TenantContext,
  keys: readonly ImportNaturalKey[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (keys.length === 0) return found;

  const valuesOf = (kind: string) =>
    Array.from(
      new Set(
        keys.filter((k) => k.kind === kind).map((k) => k.value).filter((v) => v.trim() !== ""),
      ),
    );

  const emailKeys = valuesOf("emailKey");
  const phoneDigits = valuesOf("phoneDigits");
  if (emailKeys.length === 0 && phoneDigits.length === 0) return found;

  const rows = await withTenant(ctx.tenant.id, (tx) =>
    tx
      .select({
        id: leads.id,
        emailKey: leads.emailKey,
        phoneDigits: leads.phoneDigits,
      })
      .from(leads)
      .where(
        and(
          eq(leads.tenantId, ctx.tenant.id),
          isNull(leads.deletedAt),
          matchAny([
            emailKeys.length > 0 ? inArray(leads.emailKey, emailKeys) : null,
            phoneDigits.length > 0 ? inArray(leads.phoneDigits, phoneDigits) : null,
          ]),
        ),
      )
      /*
       * ⚠️ OLDEST FIRST. Two leads can legitimately share a phone number —
       * a husband and wife enquiring separately, or the same buyer twice
       * before anybody merged them. Which one an `update` run overwrites
       * must not depend on the planner.
       */
      .orderBy(asc(leads.createdAt), asc(leads.id))
      .limit(5000),
  );

  for (const row of rows) {
    if (row.emailKey && row.emailKey !== "") {
      const key = `emailKey:${row.emailKey}`;
      if (!found.has(key)) found.set(key, row.id);
    }
    if (row.phoneDigits && row.phoneDigits.length === 10) {
      const key = `phoneDigits:${row.phoneDigits}`;
      if (!found.has(key)) found.set(key, row.id);
    }
  }
  return found;
}

/** The schema hands rupees as a string; the column holds paise. */
function budgetMinor(raw: unknown): bigint | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  return toMinorUnits(raw);
}

async function writeRow(
  ctx: TenantContext,
  payload: Record<string, unknown>,
  existingId: string | null,
): Promise<WriteOutcome> {
  try {
    const now = new Date();

    const name = String(payload.name ?? "");
    const email = (payload.email as string | null) ?? null;
    const phone = (payload.phone as string | null) ?? null;
    const source = ((payload.source as LeadSource | undefined) ?? "website") as LeadSource;
    const temperature = ((payload.temperature as LeadTemperature | undefined) ??
      "warm") as LeadTemperature;
    const budgetMinMinor = budgetMinor(payload.budgetMin);
    const budgetMaxMinor = budgetMinor(payload.budgetMax);
    const consentSource = (payload.consentSource as string | null) ?? null;

    const shared = {
      name,
      email,
      phone,
      preferredLang: (payload.preferredLang as string | null) ?? "en",
      source,
      temperature,
      budgetMinMinor,
      budgetMaxMinor,
      requirement: (payload.requirement as string | null) ?? null,
      isNri: payload.isNri === true,
      country: (payload.country as string | null) ?? null,
      timezone: (payload.timezone as string | null) ?? null,
      locality: (payload.locality as string | null) ?? null,
    };

    await withTenant(ctx.tenant.id, async (tx) => {
      if (existingId) {
        /*
         * ⚠️ THE EXISTING ROW IS READ BEFORE IT IS WRITTEN, and not for
         * optimism's sake. `scoreLead` takes the STATUS into account —
         * a lost lead scores zero — and this path does not import a
         * status. Recomputing the score against "new" would raise a dead
         * lead back to the top of every list sorted by score, which is
         * precisely the wrong list.
         */
        const [existing] = await tx
          .select({
            status: leads.status,
            projectId: leads.projectId,
            consentAt: leads.consentAt,
            consentSource: leads.consentSource,
          })
          .from(leads)
          .where(
            and(
              eq(leads.id, existingId),
              eq(leads.tenantId, ctx.tenant.id),
              isNull(leads.deletedAt),
            ),
          )
          .limit(1);

        if (!existing) {
          // Deleted between the preview and the write. Not an error worth
          // a stack trace — say what happened.
          throw Object.assign(new Error("gone"), { code: "IMPORT_LEAD_GONE" });
        }

        const keepsConsent = existing.consentAt !== null;

        await tx
          .update(leads)
          .set({
            ...shared,
            score: scoreLead({
              source,
              status: existing.status,
              temperature,
              phone,
              email,
              budgetMinMinor,
              budgetMaxMinor,
              projectId: existing.projectId,
              consentAt: keepsConsent ? existing.consentAt : consentSource ? now : null,
            }),
            /*
             * 🔴 THE EARLIEST RECORDED BASIS SURVIVES. A lead that
             * already has consent evidence keeps the date it was
             * recorded; only a lead with none can gain it from this file.
             */
            ...(keepsConsent
              ? {}
              : consentSource
                ? { consentAt: now, consentSource }
                : {}),
            updatedAt: now,
          })
          .where(
            and(
              eq(leads.id, existingId),
              eq(leads.tenantId, ctx.tenant.id),
              isNull(leads.deletedAt),
            ),
          );
        return;
      }

      await withGeneratedReference(tx, "lead", async (reference) => {
        const [row] = await tx
          .insert(leads)
          .values({
            ...shared,
            tenantId: ctx.tenant.id,
            reference,
            status: "new",
            score: scoreLead({
              source,
              status: "new",
              temperature,
              phone,
              email,
              budgetMinMinor,
              budgetMaxMinor,
              projectId: null,
              consentAt: consentSource ? now : null,
            }),
            ownerId: ctx.user.id,
            consentAt: consentSource ? now : null,
            consentSource,
          })
          .returning({ id: leads.id });

        if (!row) throw new Error("Insert returned no row.");

        /*
         * The first entry in the lead's history, exactly as `createLead()`
         * writes it, with the file named instead of the form. It goes
         * with the lead if an undo deletes it — `lead_activities.lead_id`
         * is ON DELETE CASCADE — so nothing escapes the reversal.
         */
        await tx.insert(leadActivities).values({
          tenantId: ctx.tenant.id,
          leadId: row.id,
          userId: ctx.user.id,
          type: "note",
          subject: "Lead created",
          notes: `Source: ${source}. Imported.`,
          occurredAt: now,
        });

        return row;
      });
    });

    return { ok: true };
  } catch (err) {
    if ((err as { code?: unknown })?.code === "IMPORT_LEAD_GONE") {
      return {
        ok: false,
        error:
          "This lead was matched in the preview but has since been deleted, so there was nothing to update.",
      };
    }
    return { ok: false, error: describeWriteFailure(err) };
  }
}

export const leadsWriter: ImportWriter = {
  revalidatePath: "/sales/leads",
  findExisting,
  writeRow,
};
