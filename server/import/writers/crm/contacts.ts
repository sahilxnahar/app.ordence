/**
 * Ordence — writer: `contacts`
 * Version: v1.85.0-alpha · Phase 4
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS FILE IS THE POINT OF PHASE 4's FIRST ENTITY
 * ══════════════════════════════════════════════════════════════════════
 * Track M1 shipped a complete, contracted, typechecked `contacts` entity
 * and deliberately did NOT register it, because the write path had no
 * `contacts` branch. Before Phase 1 an unhandled destination did not fail
 * to compile and did not write nothing — `gst_parties` was the unguarded
 * code after the last `if`, so it WROTE A GST PARTY.
 *
 * The definition was never the missing part. This is.
 *
 * ⚠️ SHAPED ON `server/import/writers/companies.ts`, which is the closest
 * relative: same table family, same soft-delete rule, same lower-cased
 * matching. What is new here is the SECOND natural key — a name
 * qualified by a company that lives in another table — and the FIRST
 * resolved lookup arriving in the payload.
 */

import "server-only";

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { companies, contacts } from "@/db/schema";
import { matchAny, describeWriteFailure } from "../shared";
import type { ImportNaturalKey } from "@/lib/import";
import type { TenantContext } from "@/server/tenant-context";
import type { ImportWriter, WriteOutcome } from "../types";

/**
 * The pure layer's normalisation, restated for the values that come back
 * out of the database.
 *
 * ⚠️ IT MUST AGREE WITH `naturalKey` IN `lib/import/entities-crm.ts`
 * EXACTLY, because the map this function returns is keyed with the same
 * `"kind:value"` composite the pure layer builds and a disagreement does
 * not fail — it reports every row as new and duplicates the workspace.
 * Restated rather than imported because `lib/import/` must stay free of
 * anything server-side and this file is `server-only`; the two are five
 * lines apart and both are tested against the same fixture.
 */
function collapse(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

async function findExisting(
  ctx: TenantContext,
  keys: readonly ImportNaturalKey[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (keys.length === 0) return found;

  const valuesOf = (kind: string) =>
    Array.from(new Set(keys.filter((k) => k.kind === kind).map((k) => k.value)));

  const emails = valuesOf("email");
  const nameCompanies = valuesOf("nameCompany");
  if (emails.length === 0 && nameCompanies.length === 0) return found;

  /*
   * ⚠️ THE COMPOSITE IS BUILT IN SQL AS WELL AS IN JS, and the two must
   * be the same expression.
   *
   * ① `first || ' ' || last` WITH A NULL LAST NAME IS NULL IN POSTGRES,
   *    not "Rajesh " — concatenation propagates NULL — so every contact
   *    without a surname would drop out of the comparison silently and
   *    be reported as new on every re-run. Hence the `coalesce`.
   *
   * ② `concat_ws` WOULD READ BETTER AND CANNOT BE USED. It is STABLE,
   *    not IMMUTABLE, so an index carrying it is refused by Postgres —
   *    and SQL 0227 indexes exactly this expression. An expression the
   *    index cannot carry turns the duplicate check on a 200,000-row
   *    contacts table into a sequential scan per import, which is slow
   *    enough that somebody eventually "fixes" it by dropping the check.
   *    Verified: `CREATE INDEX ... (lower(concat_ws(...)))` fails with
   *    "functions in index expression must be marked IMMUTABLE".
   */
  const nameCompositeSql = sql`
    lower(regexp_replace(btrim(${contacts.firstName} || ' ' || coalesce(${contacts.lastName}, '')), '\\s+', ' ', 'g'))
    || '|' ||
    coalesce(lower(regexp_replace(btrim(${companies.name}), '\\s+', ' ', 'g')), '')`;

  const rows = await withTenant(ctx.tenant.id, (tx) =>
    tx
      .select({
        id: contacts.id,
        email: contacts.email,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        companyName: companies.name,
        createdAt: contacts.createdAt,
      })
      .from(contacts)
      /*
       * ⚠️ LEFT, NOT INNER. A contact with no company is a real contact —
       * that judgement is the whole point of the entity's empty
       * `requiredness` — and an inner join would hide every one of them
       * from the duplicate check, so a re-run would create them all a
       * second time.
       */
      .leftJoin(companies, and(eq(companies.id, contacts.companyId), isNull(companies.deletedAt)))
      .where(
        and(
          // Written even though RLS enforces it independently. Relying on
          // a single layer is how single layers become the only layer.
          eq(contacts.tenantId, ctx.tenant.id),
          /*
           * ⚠️ SOFT-DELETED ROWS ARE NOT MATCHES. The partial unique
           * index on (tenant_id, email) excludes them too, so treating
           * one as an existing record would mean `skip` silently
           * discarded a row the database would have accepted, and the
           * customer's deleted contact would stay deleted with nothing
           * new created.
           */
          isNull(contacts.deletedAt),
          matchAny([
            emails.length > 0 ? inArray(sql`lower(btrim(${contacts.email}))`, emails) : null,
            nameCompanies.length > 0 ? inArray(nameCompositeSql, nameCompanies) : null,
          ]),
        ),
      )
      /*
       * ⚠️ OLDEST FIRST, AND IT DECIDES A REAL CASE. The database's
       * uniqueness on email is CASE-SENSITIVE (a plain unique index on
       * the column), while this match is case-INSENSITIVE by design — so
       * "A@x.com" and "a@x.com" can both be present, legally, and the
       * key "email:a@x.com" matches two rows. Without an order the row
       * `update` overwrites would depend on the planner. With it, the
       * one the customer created first wins, every run.
       */
      .orderBy(asc(contacts.createdAt), asc(contacts.id))
      .limit(5000),
  );

  for (const row of rows) {
    if (row.email) {
      const key = `email:${collapse(row.email)}`;
      if (!found.has(key)) found.set(key, row.id);
    }
    const full = collapse(`${row.firstName} ${row.lastName ?? ""}`);
    if (full !== "") {
      const key = `nameCompany:${full}|${row.companyName ? collapse(row.companyName) : ""}`;
      if (!found.has(key)) found.set(key, row.id);
    }
  }
  return found;
}

async function writeRow(
  ctx: TenantContext,
  payload: Record<string, unknown>,
  existingId: string | null,
): Promise<WriteOutcome> {
  try {
    const values = {
      firstName: String(payload.firstName ?? ""),
      lastName: (payload.lastName as string | null) ?? null,
      email: (payload.email as string | null) ?? null,
      phone: (payload.phone as string | null) ?? null,
      mobile: (payload.mobile as string | null) ?? null,
      jobTitle: (payload.jobTitle as string | null) ?? null,
      department: (payload.department as string | null) ?? null,
      linkedinUrl: (payload.linkedinUrl as string | null) ?? null,
      notes: (payload.notes as string | null) ?? null,
    };

    /*
     * 🔴 THE RESOLVED LOOKUP, AND `undefined` IS NOT `null` HERE.
     *
     * `companyId` is written into the payload by `resolveLookups` ONLY
     * for a row that named a company. A row that named none has no such
     * member, and setting the column to NULL on an update would UNLINK a
     * contact from the company somebody linked them to by hand — a
     * deletion of data the file never mentioned, performed by a column
     * the file does not have.
     *
     * So: present means set it, absent means leave it alone.
     */
    const resolvedCompanyId =
      typeof payload.companyId === "string" && payload.companyId !== ""
        ? payload.companyId
        : undefined;

    await withTenant(ctx.tenant.id, async (tx) => {
      if (existingId) {
        await tx
          .update(contacts)
          .set({
            ...values,
            ...(resolvedCompanyId ? { companyId: resolvedCompanyId } : {}),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(contacts.id, existingId),
              eq(contacts.tenantId, ctx.tenant.id),
              isNull(contacts.deletedAt),
            ),
          );
        return;
      }
      await tx.insert(contacts).values({
        ...values,
        companyId: resolvedCompanyId ?? null,
        tenantId: ctx.tenant.id,
        customFields: {},
        ownerId: ctx.user.id,
        createdBy: ctx.user.id,
      });
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeWriteFailure(err) };
  }
}

export const contactsWriter: ImportWriter = {
  revalidatePath: "/contacts",
  findExisting,
  writeRow,
};
