"use server";

/**
 * Ordence — Contact Server Actions
 * Version: v0.2.0-alpha
 *
 * THE IDOR DEFENSE, stated plainly:
 * Every function here derives `tenantId` from `requireTenantContext()`, which
 * reads the Clerk session on the server. `tenantId` is NEVER accepted as a
 * parameter — if it were, a caller could pass someone else's.
 *
 * Every mutation is scoped with `and(eq(table.id, id), eq(table.tenantId, ctx.tenant.id))`.
 * Filtering by id alone is the classic IDOR bug; the tenant predicate is what makes
 * "update contact 123" mean "update MY contact 123".
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, eq, isNull, desc, asc, ilike, or, sql, count } from "drizzle-orm";
import { db, withTenant } from "@/db";
import { contacts, companies } from "@/db/schema";
import { requirePermission } from "@/server/audit";
import { requireTenantContext, TenantAccessError } from "@/server/tenant-context";
import {
  assertImpersonationAllows,
  ImpersonationForbiddenError,
} from "@/server/platform/impersonation";
import { requireAccess, AccessRestrictedError } from "@/server/billing/access";
import {
  uuidSchema,
  createContactSchema,
  updateContactSchema,
  listContactsSchema,
  stripUndefined,
  type ActionResult,
  type CreateContactInput,
  type UpdateContactInput,
  type ListContactsInput,
} from "@/lib/validators/crm";
import type { Contact } from "@/db/schema";

/* ------------------------------------------------------------------ */
/* ERROR HANDLING                                                      */
/* ------------------------------------------------------------------ */

function fail(error: string, fieldErrors?: Record<string, string[]>): ActionResult<never> {
  return { ok: false, error, fieldErrors };
}

/** Convert thrown errors into a safe envelope — never leak internals to the client. */
function toActionError(err: unknown): ActionResult<never> {
  /*
   * ⚠️ FIRST, AND WITH THE BILLING WORDING — S1, v0.83.2.
   *
   * `AccessRestrictedError` means the WORKSPACE is in arrears, not that
   * anything is broken and not that this person lacks a permission. It
   * carries a headline and a call to action written for a customer; folding
   * it into "Something went wrong. Please try again." would tell somebody
   * whose card expired that the software is faulty — the one message
   * guaranteed to produce a support ticket instead of a payment.
   *
   * `server/billing/access.ts` states the rule this obeys: four gates, four
   * remedies. Collapsing any two guarantees somebody is eventually told to
   * solve the wrong problem.
   */
  if (err instanceof AccessRestrictedError) {
    return fail(err.decision.detail ?? err.decision.headline ?? err.message);
  }
  if (err instanceof TenantAccessError) return fail(err.message);
  // ⚠️ Surfaced with its own sentence, not folded into "something went
  // wrong". The operator is our own staff member and the message tells
  // them exactly which rule refused them — an unexplained failure during
  // a support session is how somebody concludes the product is broken
  // and opens a database client instead.
  if (err instanceof ImpersonationForbiddenError) return fail(err.message);
  if (err instanceof z.ZodError) {
    return fail("Validation failed.", err.flatten().fieldErrors as Record<string, string[]>);
  }
  console.error("[contacts action]", err);
  return fail("Something went wrong. Please try again.");
}

/* ------------------------------------------------------------------ */
/* READ                                                               */
/* ------------------------------------------------------------------ */

export type ContactWithCompany = Contact & { companyName: string | null };

export async function getContacts(
  input: ListContactsInput = {},
): Promise<ActionResult<{ rows: ContactWithCompany[]; total: number; page: number; pageSize: number }>> {
  try {
    const ctx = await requireTenantContext();
    const params = listContactsSchema.parse(input);

    // TENANT PREDICATE — first and non-negotiable.
    const conditions = [eq(contacts.tenantId, ctx.tenant.id), isNull(contacts.deletedAt)];

    if (params.companyId) {
      conditions.push(eq(contacts.companyId, params.companyId));
    }

    if (params.search) {
      // ilike args are parameterised by Drizzle — no injection surface.
      const term = `%${params.search}%`;
      const searchClause = or(
        ilike(contacts.firstName, term),
        ilike(contacts.lastName, term),
        ilike(contacts.email, term),
        ilike(contacts.jobTitle, term),
      );
      if (searchClause) conditions.push(searchClause);
    }

    const where = and(...conditions);

    const sortColumn = {
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      createdAt: contacts.createdAt,
      updatedAt: contacts.updatedAt,
    }[params.sortBy];

    const orderBy = params.sortDir === "asc" ? asc(sortColumn) : desc(sortColumn);

    const [rows, totalResult] = await withTenant(ctx.tenant.id, (tx) =>
      Promise.all([
        tx
          .select({
            id: contacts.id,
            tenantId: contacts.tenantId,
            companyId: contacts.companyId,
            firstName: contacts.firstName,
            lastName: contacts.lastName,
            email: contacts.email,
            phone: contacts.phone,
            mobile: contacts.mobile,
            jobTitle: contacts.jobTitle,
            department: contacts.department,
            linkedinUrl: contacts.linkedinUrl,
            customFields: contacts.customFields,
            ownerId: contacts.ownerId,
            notes: contacts.notes,
            lastContactedAt: contacts.lastContactedAt,
            createdAt: contacts.createdAt,
            updatedAt: contacts.updatedAt,
            createdBy: contacts.createdBy,
            deletedAt: contacts.deletedAt,
            deletedBy: contacts.deletedBy,
            companyName: companies.name,
          })
          .from(contacts)
          // Join is also tenant-scoped — prevents a cross-tenant company leaking in.
          .leftJoin(
            companies,
            and(eq(companies.id, contacts.companyId), eq(companies.tenantId, ctx.tenant.id)),
          )
          .where(where)
          .orderBy(orderBy)
          .limit(params.pageSize)
          .offset((params.page - 1) * params.pageSize),
  
        tx.select({ value: count() }).from(contacts).where(where),
      ]),
    );

    return {
      ok: true,
      data: {
        rows: rows as ContactWithCompany[],
        total: totalResult[0]?.value ?? 0,
        page: params.page,
        pageSize: params.pageSize,
      },
    };
  } catch (err) {
    return toActionError(err);
  }
}

export async function getContactById(id: string): Promise<ActionResult<ContactWithCompany>> {
  try {
    const ctx = await requireTenantContext();
    const contactId = uuidSchema.parse(id);

    const row = await withTenant(ctx.tenant.id, (tx) =>
      tx.query.contacts.findFirst({
        // id AND tenantId — never id alone.
        where: and(
          eq(contacts.id, contactId),
          eq(contacts.tenantId, ctx.tenant.id),
          isNull(contacts.deletedAt),
        ),
        with: { company: { columns: { name: true } } },
      })
    );

    if (!row) return fail("Contact not found.");

    const { company, ...rest } = row as Contact & { company: { name: string } | null };
    return { ok: true, data: { ...rest, companyName: company?.name ?? null } };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* CREATE                                                              */
/* ------------------------------------------------------------------ */

export async function createContact(
  input: CreateContactInput,
): Promise<ActionResult<Contact>> {
  try {
    const ctx = await requireTenantContext();

    /*
     * ⚠️ ACCESS BEFORE ANYTHING ELSE — S1, v0.83.2.
     *
     * `server/billing/access.ts` prescribes the order and the reason:
     *
     *     requireAccess()      ← is the account in good standing?
     *     requireFeature()     ← is it in the plan?
     *     requirePermission()  ← may this person do it?
     *
     * Broadest first, so the customer hears the outermost reason rather
     * than an inner one they cannot act on.
     *
     * ⚠️ IT IS ALSO BEFORE `parse()`. A restricted workspace should be told
     * it is read-only, not handed a validation error for a form it was
     * never going to be allowed to submit.
     */
    await requireAccess("contacts:create", ctx);
    /**
     * 🔴 THE THIRD STEP, ADDED IN v1.26.0-alpha. The comment above has
     * prescribed this order since v0.83.2 and the code stopped after
     * the second line — so this write was reachable by ANY member of
     * the workspace, including the Accountant role, which the
     * permission table grants `contacts:read` and not `contacts:create`.
     *
     * ⚠️ `requireAccess()` READS LIKE A PERMISSION CHECK AND IS NOT
     * ONE. It takes `"contacts:create"` as an argument and uses it only to
     * look up a write exemption; what it actually answers is whether
     * the WORKSPACE is in good billing standing. That is a property of
     * the account, not of the person, and it is true for everybody in
     * a paid-up workspace.
     */
    await requirePermission("contacts:create");

    const data = createContactSchema.parse(input);

    // A supplied companyId must belong to THIS tenant. Without this check a
    // caller could attach their contact to another tenant's company record.
    if (data.companyId) {
      /**
       * ⚠️ HOISTED OUT OF THE CLOSURE. The `if` above narrows this away
       * from null, and TypeScript cannot carry that into a callback it
       * cannot prove runs synchronously. Binding it keeps the guard
       * meaningful; a non-null assertion would delete the check the
       * `if` exists for.
       */
      const companyId = data.companyId;
      const owned = await withTenant(ctx.tenant.id, (tx) =>
        tx.query.companies.findFirst({
          where: and(
            eq(companies.id, companyId),
            eq(companies.tenantId, ctx.tenant.id),
            isNull(companies.deletedAt),
          ),
          columns: { id: true },
        })
      );
      if (!owned) return fail("Selected company does not exist.");
    }

    if (data.email) {
      /**
       * ⚠️ HOISTED OUT OF THE CLOSURE. The `if` above narrows this away
       * from null, and TypeScript cannot carry that into a callback it
       * cannot prove runs synchronously. Binding it keeps the guard
       * meaningful; a non-null assertion would delete the check the
       * `if` exists for.
       */
      const email = data.email;
      const duplicate = await withTenant(ctx.tenant.id, (tx) =>
        tx.query.contacts.findFirst({
          where: and(
            eq(contacts.tenantId, ctx.tenant.id),
            eq(contacts.email, email),
            isNull(contacts.deletedAt),
          ),
          columns: { id: true },
        })
      );
      if (duplicate) {
        return fail("Validation failed.", { email: ["A contact with this email already exists."] });
      }
    }

    const [created] = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .insert(contacts)
        .values({
          // tenantId comes from the session, never from `input`.
          tenantId: ctx.tenant.id,
          firstName: data.firstName,
          lastName: data.lastName ?? null,
          email: data.email ?? null,
          phone: data.phone ?? null,
          mobile: data.mobile ?? null,
          jobTitle: data.jobTitle ?? null,
          department: data.department ?? null,
          linkedinUrl: data.linkedinUrl ?? null,
          companyId: data.companyId ?? null,
          notes: data.notes ?? null,
          customFields: data.customFields,
          ownerId: ctx.user.id,
          createdBy: ctx.user.id,
        })
        .returning()
    );

    if (!created) return fail("Failed to create contact.");

    revalidatePath("/contacts");
    return { ok: true, data: created };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* UPDATE                                                              */
/* ------------------------------------------------------------------ */

export async function updateContact(
  input: UpdateContactInput,
): Promise<ActionResult<Contact>> {
  try {
    const ctx = await requireTenantContext();
    // Access before validation — see `createContact`.
    await requireAccess("contacts:update", ctx);
    /**
     * 🔴 THE THIRD STEP, ADDED IN v1.26.0-alpha. The comment above has
     * prescribed this order since v0.83.2 and the code stopped after
     * the second line — so this write was reachable by ANY member of
     * the workspace, including the Accountant role, which the
     * permission table grants `contacts:read` and not `contacts:update`.
     *
     * ⚠️ `requireAccess()` READS LIKE A PERMISSION CHECK AND IS NOT
     * ONE. It takes `"contacts:update"` as an argument and uses it only to
     * look up a write exemption; what it actually answers is whether
     * the WORKSPACE is in good billing standing. That is a property of
     * the account, not of the person, and it is true for everybody in
     * a paid-up workspace.
     */
    await requirePermission("contacts:update");

    const { id, ...data } = updateContactSchema.parse(input);

    const existing = await withTenant(ctx.tenant.id, (tx) =>
      tx.query.contacts.findFirst({
        where: and(
          eq(contacts.id, id),
          eq(contacts.tenantId, ctx.tenant.id),
          isNull(contacts.deletedAt),
        ),
        columns: { id: true },
      })
    );
    if (!existing) return fail("Contact not found.");

    if (data.companyId) {
      /** ⚠️ Same narrowing hoist as `createContact` above. */
      const companyId = data.companyId;
      const owned = await withTenant(ctx.tenant.id, (tx) =>
        tx.query.companies.findFirst({
          where: and(
            eq(companies.id, companyId),
            eq(companies.tenantId, ctx.tenant.id),
            isNull(companies.deletedAt),
          ),
          columns: { id: true },
        })
      );
      if (!owned) return fail("Selected company does not exist.");
    }

    if (data.email) {
      /** ⚠️ Same narrowing hoist as `createContact` above. */
      const email = data.email;
      const duplicate = await withTenant(ctx.tenant.id, (tx) =>
        tx.query.contacts.findFirst({
          where: and(
            eq(contacts.tenantId, ctx.tenant.id),
            eq(contacts.email, email),
            isNull(contacts.deletedAt),
            sql`${contacts.id} <> ${id}`,
          ),
          columns: { id: true },
        })
      );
      if (duplicate) {
        return fail("Validation failed.", { email: ["Another contact already uses this email."] });
      }
    }

    const [updated] = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .update(contacts)
        .set({ ...stripUndefined(data), updatedAt: new Date() })
        // Both predicates. Dropping the tenant one here would be the IDOR.
        .where(and(eq(contacts.id, id), eq(contacts.tenantId, ctx.tenant.id)))
        .returning()
    );

    if (!updated) return fail("Failed to update contact.");

    revalidatePath("/contacts");
    revalidatePath(`/contacts/${id}`);
    return { ok: true, data: updated };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* DELETE (soft)                                                       */
/* ------------------------------------------------------------------ */

export async function deleteContact(id: string): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requireTenantContext();
    // Access before anything else — see `createContact`.
    await requireAccess("contacts:delete", ctx);
    /**
     * 🔴 THE THIRD STEP, ADDED IN v1.26.0-alpha. The comment above has
     * prescribed this order since v0.83.2 and the code stopped after
     * the second line — so this write was reachable by ANY member of
     * the workspace, including the Accountant role, which the
     * permission table grants `contacts:read` and not `contacts:delete`.
     *
     * ⚠️ `requireAccess()` READS LIKE A PERMISSION CHECK AND IS NOT
     * ONE. It takes `"contacts:delete"` as an argument and uses it only to
     * look up a write exemption; what it actually answers is whether
     * the WORKSPACE is in good billing standing. That is a property of
     * the account, not of the person, and it is true for everybody in
     * a paid-up workspace.
     */
    await requirePermission("contacts:delete");
    /*
      ⭐ A SOFT DELETE IS AN UPDATE, SO THE DATABASE GUARD NEVER SEES IT.
      `refuse_delete_under_impersonation()` fires on DELETE. This row is
      never deleted — `deleted_at` is stamped — so the trigger is silent
      and THIS is the only thing standing between a support session and
      a customer's contact disappearing from their own screen with no
      trace they can find. Same reasoning at every soft-delete call site.
    */
    await assertImpersonationAllows("delete:contact", ctx);
    const contactId = uuidSchema.parse(id);

    const [deleted] = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .update(contacts)
        .set({ deletedAt: new Date(), deletedBy: ctx.user.id, updatedAt: new Date() })
        .where(
          and(
            eq(contacts.id, contactId),
            eq(contacts.tenantId, ctx.tenant.id),
            isNull(contacts.deletedAt),
          ),
        )
        .returning({ id: contacts.id })
    );

    if (!deleted) return fail("Contact not found.");

    revalidatePath("/contacts");
    return { ok: true, data: { id: deleted.id } };
  } catch (err) {
    return toActionError(err);
  }
}

