"use server";

/**
 * Ordence — Company Server Actions
 * Version: v0.7.0-alpha
 *
 * Mirrors `contacts.ts`. Every rule there applies here:
 *   - `tenantId` comes from the verified session, never from the payload
 *   - the tenant filter is written explicitly in every query, even though
 *     Row-Level Security enforces it independently
 *   - soft delete only; `deleted_at` is set and nothing is destroyed
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY DELETING A COMPANY DOES NOT ORPHAN ITS CONTACTS
 * ══════════════════════════════════════════════════════════════════════
 * `contacts.company_id` is `ON DELETE SET NULL`, so a hard delete would
 * silently detach every contact — and there would be no way to tell
 * afterwards whether a contact never had a company or lost one. Since we
 * soft-delete, the link survives and the relationship stays reconstructible.
 * The list query filters deleted companies out, so nothing dangles in the UI.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, eq, isNull, ilike, or, desc, asc, count, sql } from "drizzle-orm";
import { db } from "@/db";
import { companies, contacts } from "@/db/schema";
import { requireTenantContext, TenantAccessError } from "@/server/tenant-context";
import { requireAccess, AccessRestrictedError } from "@/server/billing/access";
import {
  assertImpersonationAllows,
  ImpersonationForbiddenError,
} from "@/server/platform/impersonation";
import {
  createCompanySchema,
  updateCompanySchema,
  listCompaniesSchema,
  uuidSchema,
} from "@/lib/validators/crm";
import type {
  ActionResult,
  CreateCompanyInput,
  UpdateCompanyInput,
  ListCompaniesInput,
} from "@/lib/validators/crm";
import type { Company } from "@/db/schema";

export type { CreateCompanyInput, UpdateCompanyInput, ListCompaniesInput };

function fail(error: string, fieldErrors?: Record<string, string[]>): ActionResult<never> {
  return { ok: false, error, fieldErrors };
}

function toActionError(err: unknown): ActionResult<never> {
  /*
   * ⚠️ FIRST, AND WITH THE BILLING WORDING — S1, v0.83.2.
   * A restricted workspace is in arrears, not broken and not
   * under-permissioned. Four gates, four remedies; see
   * `server/billing/access.ts`.
   */
  if (err instanceof AccessRestrictedError) {
    return fail(err.decision.detail ?? err.decision.headline ?? err.message);
  }
  if (err instanceof TenantAccessError) return fail(err.message);
  if (err instanceof ImpersonationForbiddenError) return fail(err.message);
  if (err instanceof z.ZodError) {
    return fail("Validation failed.", err.flatten().fieldErrors as Record<string, string[]>);
  }
  console.error("[companies action]", err);
  return fail("Something went wrong. Please try again.");
}

/* ------------------------------------------------------------------ */
/* LIST                                                                */
/* ------------------------------------------------------------------ */

export type CompanyWithContactCount = Company & { contactCount: number };

export async function getCompanies(input: ListCompaniesInput = {}): Promise<
  ActionResult<{ rows: CompanyWithContactCount[]; total: number; page: number; pageSize: number }>
> {
  try {
    const ctx = await requireTenantContext();
    const params = listCompaniesSchema.parse(input);

    // The tenant predicate is FIRST in the AND chain, not last. It is the
    // most selective condition and the one that must never be optional.
    const conditions = [eq(companies.tenantId, ctx.tenant.id), isNull(companies.deletedAt)];

    if (params.search) {
      const term = `%${params.search}%`;
      const searchCondition = or(
        ilike(companies.name, term),
        ilike(companies.domain, term),
        ilike(companies.industry, term),
        ilike(companies.city, term),
      );
      if (searchCondition) conditions.push(searchCondition);
    }

    const where = and(...conditions);

    const sortColumn =
      params.sortBy === "name"
        ? companies.name
        : params.sortBy === "industry"
          ? companies.industry
          : params.sortBy === "updatedAt"
            ? companies.updatedAt
            : companies.createdAt;

    const [rows, totalResult] = await Promise.all([
      db
        .select({
          company: companies,
          contactCount: sql<number>`(
            SELECT COUNT(*)::int FROM ${contacts}
            WHERE ${contacts.companyId} = ${companies.id}
              AND ${contacts.tenantId} = ${ctx.tenant.id}
              AND ${contacts.deletedAt} IS NULL
          )`,
        })
        .from(companies)
        .where(where)
        .orderBy(params.sortDir === "asc" ? asc(sortColumn) : desc(sortColumn))
        .limit(params.pageSize)
        .offset((params.page - 1) * params.pageSize),
      db.select({ value: count() }).from(companies).where(where),
    ]);

    return {
      ok: true,
      data: {
        rows: rows.map((r) => ({ ...r.company, contactCount: r.contactCount })),
        total: totalResult[0]?.value ?? 0,
        page: params.page,
        pageSize: params.pageSize,
      },
    };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* READ ONE                                                            */
/* ------------------------------------------------------------------ */

export async function getCompanyById(id: string): Promise<ActionResult<Company>> {
  try {
    const ctx = await requireTenantContext();
    const parsedId = uuidSchema.parse(id);

    const row = await db.query.companies.findFirst({
      where: and(
        eq(companies.id, parsedId),
        eq(companies.tenantId, ctx.tenant.id),
        isNull(companies.deletedAt),
      ),
    });

    if (!row) return fail("Company not found.");
    return { ok: true, data: row };
  } catch (err) {
    return toActionError(err);
  }
}

/**
 * Minimal list for populating a <select>. Deliberately returns only id and
 * name — a picker has no business shipping every column of every company
 * to the browser.
 */
export async function getCompanyOptions(): Promise<
  ActionResult<Array<{ id: string; name: string }>>
> {
  try {
    const ctx = await requireTenantContext();
    const rows = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(and(eq(companies.tenantId, ctx.tenant.id), isNull(companies.deletedAt)))
      .orderBy(asc(companies.name))
      .limit(1000);
    return { ok: true, data: rows };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* CREATE                                                              */
/* ------------------------------------------------------------------ */

export async function createCompany(
  input: CreateCompanyInput,
): Promise<ActionResult<Company>> {
  try {
    const ctx = await requireTenantContext();

    /*
     * ⚠️ ACCESS BEFORE ANYTHING ELSE — S1, v0.83.2.
     *
     * The order prescribed by `server/billing/access.ts`:
     *     requireAccess() → requireFeature() → requirePermission()
     * Broadest first, so a customer in arrears is told to pay rather than
     * told they lack a permission and sent to an administrator who is
     * themselves.
     *
     * Placed before `parse()` deliberately: a read-only workspace should
     * hear that it is read-only, not receive a validation error for a form
     * it was never going to be allowed to submit.
     */
    await requireAccess("companies:create", ctx);

    const data = createCompanySchema.parse(input);

    if (data.domain) {
      const duplicate = await db.query.companies.findFirst({
        where: and(
          eq(companies.tenantId, ctx.tenant.id),
          eq(companies.domain, data.domain),
          isNull(companies.deletedAt),
        ),
        columns: { id: true },
      });
      if (duplicate) {
        return fail("Validation failed.", {
          domain: ["A company with this domain already exists."],
        });
      }
    }

    const [created] = await db
      .insert(companies)
      .values({
        tenantId: ctx.tenant.id,
        name: data.name,
        domain: data.domain ?? null,
        industry: data.industry ?? null,
        employeeCount: data.employeeCount ?? null,
        companySize: data.companySize ?? null,
        website: data.website ?? null,
        phone: data.phone ?? null,
        addressLine1: data.addressLine1 ?? null,
        addressLine2: data.addressLine2 ?? null,
        city: data.city ?? null,
        state: data.state ?? null,
        postalCode: data.postalCode ?? null,
        country: data.country ?? null,
        notes: data.notes ?? null,
        customFields: data.customFields,
        ownerId: ctx.user.id,
        createdBy: ctx.user.id,
      })
      .returning();

    if (!created) return fail("Failed to create company.");

    revalidatePath("/companies");
    return { ok: true, data: created };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* UPDATE                                                              */
/* ------------------------------------------------------------------ */

export async function updateCompany(
  input: UpdateCompanyInput,
): Promise<ActionResult<Company>> {
  try {
    const ctx = await requireTenantContext();
    // Access before validation — see `createCompany`.
    await requireAccess("companies:update", ctx);

    const data = updateCompanySchema.parse(input);
    const { id, ...changes } = data;

    if (changes.domain) {
      const duplicate = await db.query.companies.findFirst({
        where: and(
          eq(companies.tenantId, ctx.tenant.id),
          eq(companies.domain, changes.domain),
          isNull(companies.deletedAt),
        ),
        columns: { id: true },
      });
      if (duplicate && duplicate.id !== id) {
        return fail("Validation failed.", {
          domain: ["Another company already uses this domain."],
        });
      }
    }

    const [updated] = await db
      .update(companies)
      .set({ ...changes, updatedAt: new Date() })
      .where(
        and(
          eq(companies.id, id),
          // Without this predicate the WHERE would match another tenant's
          // row by id alone. RLS would still refuse it — but relying on a
          // single layer is how single layers become the only layer.
          eq(companies.tenantId, ctx.tenant.id),
          isNull(companies.deletedAt),
        ),
      )
      .returning();

    if (!updated) return fail("Company not found.");

    revalidatePath("/companies");
    revalidatePath(`/companies/${id}`);
    return { ok: true, data: updated };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* DELETE (SOFT)                                                       */
/* ------------------------------------------------------------------ */

export async function deleteCompany(id: string): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requireTenantContext();
    // Access before anything else — see `createCompany`.
    await requireAccess("companies:delete", ctx);

    await assertImpersonationAllows("delete:company", ctx);
    const parsedId = uuidSchema.parse(id);

    const [deleted] = await db
      .update(companies)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(companies.id, parsedId),
          eq(companies.tenantId, ctx.tenant.id),
          isNull(companies.deletedAt),
        ),
      )
      .returning({ id: companies.id });

    if (!deleted) return fail("Company not found.");

    revalidatePath("/companies");
    return { ok: true, data: { id: deleted.id } };
  } catch (err) {
    return toActionError(err);
  }
}
