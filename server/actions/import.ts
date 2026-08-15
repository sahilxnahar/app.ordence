"use server";

/**
 * Ordence — CSV Import: preview and commit
 * Version: v1.57.0-alpha (Mega-wave 2, Batch 57)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE PRODUCT HAD NO DATA IMPORT OF ANY KIND
 * ══════════════════════════════════════════════════════════════════════
 * Every workspace started empty and everything in it was typed by hand.
 * That is the largest single obstacle between a demo and a paying
 * customer: a firm with 800 counterparties on file is being asked to
 * re-key 800 counterparties before the software does anything for them.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ EVERY EXPORT HERE IS A BROWSER-REACHABLE URL
 * ══════════════════════════════════════════════════════════════════════
 * Next.js compiles each export of a `"use server"` module into an RPC
 * endpoint anybody on the internet can POST to. That is true of a
 * "preview" as much as of a "commit", and it is why BOTH functions below
 * carry the full four-gate stack rather than an identity check. See the
 * long note on `guardImport`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 CONSTRAINT 1, RESTATED WHERE IT IS ENFORCED: ONE CODE PATH
 * ══════════════════════════════════════════════════════════════════════
 * `previewImport` and `commitImport` are two thin wrappers over ONE
 * private function, `runImport`, which takes `mode` and branches on it
 * exactly once — at the write, AFTER every decision about every row has
 * already been made. Nothing above that branch reads `mode`. There is no
 * "quick validation" path, no `skipChecks` argument, and no second entry
 * point, because a dry run that disagrees with the real run is worse than
 * no dry run at all: it spends the customer's trust and then teaches them
 * to skip the one safety rail the import has.
 *
 * ⚠️ WHAT A PREVIEW STILL CANNOT PROMISE, AND WHY WE SAY SO RATHER THAN
 * PRETEND. Two things are genuinely unknowable before the write:
 *
 *   1. A database constraint that nothing in the schema layer models.
 *      Every rule we know about is in the Zod schema the preview runs, so
 *      this is rare — but `gst_parties` alone carries four CHECK
 *      constraints and a partial unique index, and the database is the
 *      authority, not us.
 *   2. Anything a colleague writes in the seconds between the two clicks.
 *      A preview is a photograph, not a lock, and taking a lock over a
 *      customer's whole company table for the duration of a human
 *      decision would be a far worse trade.
 *
 * Both are stated in the wizard. A row that fails at write time appears
 * in the commit report as an error with its reason, and lands in the
 * downloadable failed-rows CSV like any other — so even the case the
 * preview could not foresee ends up somewhere the customer can act on.
 */

import { z } from "zod";
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenant } from "@/db";
import { companies, gstParties } from "@/db/schema";
import { requirePermission, writeAudit } from "@/server/audit";
import { requireTenantContext, TenantAccessError } from "@/server/tenant-context";
import { requireAccess, AccessRestrictedError } from "@/server/billing/access";
import { requireFeature, FeatureLockedError } from "@/server/entitlements";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  IMPORT_ENTITIES,
  buildReport,
  isImportEntityKey,
  planImport,
  type ImportEntityDefinition,
  type ImportNaturalKey,
  type ImportReport,
  type RowOutcome,
} from "@/lib/import";
import type { TenantContext } from "@/server/tenant-context";
import type { ActionResult } from "@/lib/validators/crm";

/* ------------------------------------------------------------------ */
/* INPUT                                                               */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ `duplicateMode` HAS NO DEFAULT, AND THAT IS THE POINT (constraint 3).
 *
 * A `.default("skip")` here would read as a kindness and would be the
 * mechanism by which the decision stops being made. The customer has to
 * choose what happens to records that already exist BEFORE the run —
 * asked afterwards, when they have already waited for an upload and are
 * committed to finishing, the answer is always "yes, update", and
 * `update` is the destructive one. A required field makes the wizard
 * unable to submit until a radio is ticked, which is exactly the
 * behaviour wanted.
 */
const importInputSchema = z.object({
  entity: z.string().min(1),
  /**
   * The file contents as text. Read in the browser with `File.text()`
   * rather than uploaded as multipart, because the wizard needs the same
   * string to build the failed-rows download and re-run a preview without
   * a second round trip.
   */
  csvText: z.string(),
  duplicateMode: z.enum(["skip", "update", "fail"], {
    required_error: "Choose what should happen to records that already exist.",
    invalid_type_error: "Choose what should happen to records that already exist.",
  }),
});

export type ImportInput = z.input<typeof importInputSchema>;

/* ------------------------------------------------------------------ */
/* GATES                                                               */
/* ------------------------------------------------------------------ */

function fail(error: string): ActionResult<never> {
  return { ok: false, error };
}

function toImportActionError(err: unknown, scope: string): ActionResult<never> {
  // Billing first — a workspace in arrears is in arrears, not
  // under-permissioned. Four gates, four remedies.
  if (err instanceof AccessRestrictedError) return fail(err.message);
  if (err instanceof TenantAccessError) return fail(err.message);
  if (err instanceof FeatureLockedError) return fail(err.message);
  if (err instanceof PermissionDeniedError) return fail(err.message);
  if (err instanceof z.ZodError) {
    const first = err.issues[0];
    return fail(first?.message ?? "Please check the form.");
  }
  console.error(`[import:${scope}]`, err);
  return fail("Something went wrong. Please try again.");
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 CONSTRAINT 5: A `requirePermission` GUARD, NOT AN IDENTITY CHECK
 * ══════════════════════════════════════════════════════════════════════
 * The four gates in the order `server/billing/access.ts` prescribes:
 *
 *   1. ACCESS      — may this WORKSPACE write at all? An account in
 *                    arrears is read-only.
 *   2. ENTITLEMENT — has it paid for bulk import, and for the module the
 *                    entity belongs to? Two keys, deliberately: "may you
 *                    use companies at all" and "may you load them from a
 *                    file" are different purchases.
 *   3. PERMISSION  — may this PERSON create one of these?
 *   4. Tenant isolation — the database, unconditionally, via `withTenant`.
 *
 * ⚠️ THE ORDER DECIDES WHO GETS THE MESSAGE. Reversed, a workspace owner
 * whose card expired is told "you do not have permission" and sent to an
 * administrator who is themselves.
 *
 * ⚠️ THE UPDATE PERMISSION IS CHECKED ONLY IN `update` MODE, AND THAT IS
 * A REAL DISTINCTION RATHER THAN PEDANTRY. Choosing "overwrite what is
 * already there" converts an import from "add records" into a mass edit
 * of the existing master data. Someone trusted to load a list of new
 * prospects is not automatically someone trusted to rewrite every
 * customer record in the workspace from a spreadsheet, and folding the
 * two into one key would make the second the default consequence of the
 * first.
 *
 * ⚠️ AND THE PREVIEW CARRIES THE IDENTICAL STACK. Two reasons. First,
 * constraint 1 — a preview a user can run and a commit they cannot is a
 * dry run that does not match the real run, at the coarsest possible
 * granularity. Second, the preview is not free of disclosure: it reports
 * which of the natural keys in an uploaded file ALREADY EXIST in the
 * workspace, which is an oracle for "is this GSTIN one of your
 * customers?" A gate on the commit alone would leave that oracle open to
 * anyone who can reach the endpoint.
 */
async function guardImport(
  entity: ImportEntityDefinition,
  duplicateMode: "skip" | "update" | "fail",
): Promise<TenantContext> {
  const ctx = await requireTenantContext();

  await requireAccess(entity.createPermission, ctx);
  await requireFeature("crm.bulk_import", ctx);
  await requireFeature(entity.feature, ctx);

  await requirePermission(entity.createPermission);
  if (duplicateMode === "update") {
    await requirePermission(entity.updatePermission);
  }

  return ctx;
}

/* ------------------------------------------------------------------ */
/* THE EXISTING-ROW LOOKUP — shared by preview and commit              */
/* ------------------------------------------------------------------ */

/**
 * Which of these natural keys already exist in the workspace.
 *
 * ⚠️ ONE QUERY FOR THE WHOLE FILE, NOT ONE PER ROW. A thousand rows would
 * otherwise be a thousand round trips before a single byte was written,
 * and the preview would be slower than the commit.
 *
 * ⚠️ AND IT IS CALLED BY BOTH RUNS FROM THE SAME LINE. The dedupe
 * decision is as much a part of "what will happen" as validation is; a
 * preview that guessed at it — or skipped it "because it needs the
 * database" — would report creations that turn into updates. That is the
 * exact drift constraint 1 forbids.
 *
 * The returned map is keyed `"kind:value"`, matching the composite the
 * pure layer builds for in-file duplicate detection, so the two notions
 * of "the same record" cannot diverge.
 */
async function findExistingByNaturalKey(
  ctx: TenantContext,
  entity: ImportEntityDefinition,
  keys: readonly ImportNaturalKey[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (keys.length === 0) return found;

  const valuesOf = (kind: string) =>
    Array.from(new Set(keys.filter((k) => k.kind === kind).map((k) => k.value)));

  if (entity.table === "companies") {
    const domains = valuesOf("domain");
    const names = valuesOf("name");
    if (domains.length === 0 && names.length === 0) return found;

    const rows = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .select({
          id: companies.id,
          domain: companies.domain,
          name: companies.name,
        })
        .from(companies)
        .where(
          and(
            // The tenant predicate is written even though RLS enforces it
            // independently. Relying on a single layer is how single
            // layers become the only layer.
            eq(companies.tenantId, ctx.tenant.id),
            // ⚠️ SOFT-DELETED ROWS ARE NOT MATCHES. The partial unique
            // index excludes them too, so treating one as an existing
            // record would mean `skip` silently discarded a row the
            // database would have happily accepted — and the customer's
            // deleted company would stay deleted with no new one created.
            isNull(companies.deletedAt),
            matchAny([
              /*
               * ⚠️ `lower(...)` ON BOTH SIDES. The pure layer lower-cases
               * the key it built from the file; comparing that against a
               * mixed-case column would find nothing, and "finds nothing"
               * here does not fail loudly — it reports every row as a
               * creation and then duplicates the workspace.
               */
              domains.length > 0
                ? inArray(sql`lower(${companies.domain})`, domains)
                : null,
              names.length > 0
                ? inArray(
                    // ⚠️ `\\s` NOT `\s`. This is a template literal, where
                    // `\s` is a NonEscapeCharacter and collapses to a bare
                    // `s` — so the pattern would become `'s+'` and the
                    // query would strip the letter s out of every company
                    // name before comparing. It matches nothing, silently,
                    // and "matches nothing" here reports every row as new
                    // and duplicates the workspace.
                    sql`lower(regexp_replace(${companies.name}, '\\s+', ' ', 'g'))`,
                    names,
                  )
                : null,
            ]),
          ),
        )
        .limit(5000),
    );

    for (const row of rows) {
      if (row.domain) {
        const key = `domain:${row.domain.toLowerCase()}`;
        if (!found.has(key)) found.set(key, row.id);
      }
      const nameKey = `name:${row.name.toLowerCase().replace(/\s+/g, " ")}`;
      if (!found.has(nameKey)) found.set(nameKey, row.id);
    }
    return found;
  }

  // gst_parties. The key is composite — `partyType|gstin` — because the
  // database's own unique index is `(tenant_id, party_type, gstin)`.
  const gstinValues = valuesOf("gstin");
  const nameValues = valuesOf("legalName");
  if (gstinValues.length === 0 && nameValues.length === 0) return found;

  const rows = await withTenant(ctx.tenant.id, (tx) =>
    tx
      .select({
        id: gstParties.id,
        partyType: gstParties.partyType,
        gstin: gstParties.gstin,
        legalName: gstParties.legalName,
      })
      .from(gstParties)
      .where(
        and(
          eq(gstParties.tenantId, ctx.tenant.id),
          // ⚠️ THE INDEX IS `WHERE ... AND is_active`, so a retired row is
          // not a collision. Matching one would mean a party whose
          // registration lapsed could never be re-added.
          eq(gstParties.isActive, true),
          matchAny([
            gstinValues.length > 0
              ? inArray(
                  sql`(${gstParties.partyType}::text || '|' || ${gstParties.gstin})`,
                  gstinValues,
                )
              : null,
            nameValues.length > 0
              ? inArray(
                  // `\\s`, for the reason spelled out on the companies branch.
                  sql`(${gstParties.partyType}::text || '|' || lower(regexp_replace(${gstParties.legalName}, '\\s+', ' ', 'g')))`,
                  nameValues,
                )
              : null,
          ]),
        ),
      )
      .limit(5000),
  );

  for (const row of rows) {
    if (row.gstin) {
      const key = `gstin:${row.partyType}|${row.gstin}`;
      if (!found.has(key)) found.set(key, row.id);
    }
    const nameKey = `legalName:${row.partyType}|${row.legalName.toLowerCase().replace(/\s+/g, " ")}`;
    if (!found.has(nameKey)) found.set(nameKey, row.id);
  }
  return found;
}

/**
 * OR together the predicates that are actually present.
 *
 * ⚠️ AN EMPTY LIST MUST BECOME `false`, NEVER `true`. Drizzle's `or()`
 * with nothing in it returns `undefined`, which `and()` then drops — and
 * a dropped predicate here would turn "find the rows matching these
 * keys" into "find every row in the table". The caller returns early when
 * both lists are empty, and this is the second layer that makes the
 * mistake impossible rather than merely unlikely.
 */
function matchAny(parts: Array<SQL | undefined | null>): SQL {
  const present = parts.filter((p): p is SQL => p !== null && p !== undefined);
  if (present.length === 0) return sql`false`;
  return or(...present) ?? sql`false`;
}

/* ------------------------------------------------------------------ */
/* THE ONE RUN                                                         */
/* ------------------------------------------------------------------ */

async function runImport(
  input: unknown,
  mode: "preview" | "commit",
): Promise<ActionResult<ImportReport>> {
  try {
    const params = importInputSchema.parse(input);

    if (!isImportEntityKey(params.entity)) {
      return fail("That is not something this can import.");
    }
    const entity: ImportEntityDefinition = IMPORT_ENTITIES[params.entity];

    const ctx = await guardImport(entity, params.duplicateMode);

    /*
     * ⭐ THE SHARED LINE. Preview and commit both get their entire idea
     * of what is in the file from here, and `planImport` takes no
     * argument that could make it behave differently for one of them.
     */
    const plan = planImport(entity, params.csvText);

    if (plan.fatal) {
      return {
        ok: true,
        data: buildReport(entity, plan, {
          mode,
          duplicateMode: params.duplicateMode,
          outcomes: new Map(),
        }),
      };
    }

    const validRows = plan.rows.filter((row) => row.errors.length === 0);
    const existing = await findExistingByNaturalKey(
      ctx,
      entity,
      validRows.map((row) => row.naturalKey).filter((k): k is ImportNaturalKey => !!k),
    );

    const outcomes = new Map<number, RowOutcome>();

    /*
     * ══════════════════════════════════════════════════════════════
     * ⚠️ ONE TRANSACTION PER ROW, AND IT IS THE PRICE OF CONSTRAINT 2
     * ══════════════════════════════════════════════════════════════
     * `server/actions/bulk.ts` argues at length that a loop of
     * single-record calls is wrong because it is N transactions and a
     * failure at row 140 leaves 139 committed with no record of where it
     * stopped. That reasoning is correct THERE and inverted here.
     *
     * Partial success is the requirement, not the failure mode. A single
     * transaction around the whole file means the one row Postgres
     * refuses rolls back the other 999 — which is precisely the
     * all-or-nothing behaviour that makes an importer unusable against
     * real exported data. And "no record of where it stopped" is exactly
     * what the report below is: every row's outcome, named, with the
     * failures downloadable.
     *
     * The cost is real — a thousand round trips is slow, and it is why
     * `MAX_IMPORT_ROWS` is 1000 rather than 100,000. A customer with more
     * than that has a migration, not an upload, and the refusal says so.
     *
     * ⚠️ SEQUENTIAL, NOT `Promise.all`. Parallel writes would open a
     * connection per row against a serverless Postgres, and the first
     * consequence of exhausting the pool is unrelated requests failing
     * elsewhere in the workspace.
     */
    for (const row of validRows) {
      const key = row.naturalKey ? `${row.naturalKey.kind}:${row.naturalKey.value}` : null;
      const existingId = key ? existing.get(key) : undefined;

      if (existingId && params.duplicateMode === "skip") {
        outcomes.set(row.recordNumber, {
          disposition: "skip",
          matchedOn: row.naturalKey?.label ?? null,
        });
        continue;
      }

      if (existingId && params.duplicateMode === "fail") {
        outcomes.set(row.recordNumber, {
          disposition: "error",
          matchedOn: row.naturalKey?.label ?? null,
          errors: [
            {
              column: null,
              message:
                `A ${entity.noun.one} with ${row.naturalKey?.label ?? "this identity"} ` +
                `is already in this workspace, and you chose to refuse those rather ` +
                `than skip or overwrite them.`,
            },
          ],
        });
        continue;
      }

      const disposition = existingId ? "update" : "create";

      /*
       * 🔴 THE ONLY LINE IN THIS FUNCTION THAT READS `mode`, and it is
       * below every decision. Everything above — validation, coercion,
       * in-file duplicates, the existing-row lookup, skip/update/fail —
       * has already run identically for both.
       */
      if (mode === "commit") {
        const written = await writeRow(ctx, entity, row.payload ?? {}, existingId ?? null);
        if (!written.ok) {
          outcomes.set(row.recordNumber, {
            disposition: "error",
            matchedOn: row.naturalKey?.label ?? null,
            errors: [{ column: null, message: written.error }],
          });
          continue;
        }
      }

      outcomes.set(row.recordNumber, {
        disposition,
        matchedOn: existingId ? (row.naturalKey?.label ?? null) : null,
      });
    }

    const report = buildReport(entity, plan, {
      mode,
      duplicateMode: params.duplicateMode,
      outcomes,
    });

    if (mode === "commit" && report.counts.create + report.counts.update > 0) {
      /*
       * ⚠️ ONE AUDIT ENTRY FOR THE WHOLE IMPORT, NOT ONE PER ROW. A
       * reviewer reading nine hundred separate creations sees nine
       * hundred unrelated acts; one entry with the counts on it is the
       * deliberate act that actually happened. Same reasoning as
       * `batchId` in `server/actions/bulk.ts`.
       */
      await writeAudit(ctx, {
        action: "create",
        resourceType: `import:${entity.key}`,
        resourceId: crypto.randomUUID(),
        newValue: {
          entity: entity.key,
          duplicateMode: params.duplicateMode,
          created: report.counts.create,
          updated: report.counts.update,
          skipped: report.counts.skip,
          failed: report.counts.error,
          totalRows: report.totalRows,
        },
      });

      revalidatePath(entity.table === "companies" ? "/companies" : "/settings/gst");
    }

    return { ok: true, data: report };
  } catch (err) {
    return toImportActionError(err, mode);
  }
}

/**
 * Insert or update one row.
 *
 * ⚠️ IT RETURNS A RESULT INSTEAD OF THROWING, because a database refusal
 * of ONE row must not end the run — that is constraint 2 again, at the
 * lowest level. The message is passed through where Postgres wrote one
 * for a human (the CHECK constraints on `gst_parties` do), because
 * replacing "the registration type and the GSTIN disagree" with
 * "something went wrong" throws away the whole explanation.
 */
async function writeRow(
  ctx: TenantContext,
  entity: ImportEntityDefinition,
  payload: Record<string, unknown>,
  existingId: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (entity.table === "companies") {
      const values = {
        name: String(payload.name ?? ""),
        domain: (payload.domain as string | null) ?? null,
        industry: (payload.industry as string | null) ?? null,
        employeeCount: (payload.employeeCount as number | null) ?? null,
        companySize: (payload.companySize as (typeof companies.$inferInsert)["companySize"]) ?? null,
        website: (payload.website as string | null) ?? null,
        phone: (payload.phone as string | null) ?? null,
        addressLine1: (payload.addressLine1 as string | null) ?? null,
        addressLine2: (payload.addressLine2 as string | null) ?? null,
        city: (payload.city as string | null) ?? null,
        state: (payload.state as string | null) ?? null,
        postalCode: (payload.postalCode as string | null) ?? null,
        country: (payload.country as string | null) ?? null,
        notes: (payload.notes as string | null) ?? null,
      };

      await withTenant(ctx.tenant.id, async (tx) => {
        if (existingId) {
          await tx
            .update(companies)
            .set({ ...values, updatedAt: new Date() })
            .where(
              and(
                eq(companies.id, existingId),
                eq(companies.tenantId, ctx.tenant.id),
                isNull(companies.deletedAt),
              ),
            );
          return;
        }
        await tx.insert(companies).values({
          ...values,
          tenantId: ctx.tenant.id,
          customFields: {},
          ownerId: ctx.user.id,
          createdBy: ctx.user.id,
        });
      });
      return { ok: true };
    }

    const gstin = (payload.gstin as string | null) ?? null;
    const values = {
      partyType: payload.partyType as (typeof gstParties.$inferInsert)["partyType"],
      legalName: String(payload.legalName ?? ""),
      tradeName: (payload.tradeName as string | null) ?? null,
      gstin,
      panNumber: (payload.panNumber as string | null) ?? null,
      registrationType: payload.registrationType as (typeof gstParties.$inferInsert)["registrationType"],
      /*
       * ⚠️ DERIVED FROM THE GSTIN WHERE THERE IS ONE, exactly as
       * `saveParty` does. A GSTIN's first two digits ARE its state and
       * the CHECK constraint holds them equal; taking the CSV's value in
       * preference would let a mistyped state column flip an invoice
       * between IGST and CGST+SGST.
       */
      stateCode: gstin ? gstin.slice(0, 2) : ((payload.stateCode as string | null) ?? null),
      address:
        (payload.address as (typeof gstParties.$inferInsert)["address"]) ?? {},
      effectiveFrom: String(payload.effectiveFrom ?? ""),
      effectiveTo: (payload.effectiveTo as string | null) ?? null,
      notes: (payload.notes as string | null) ?? null,
    };

    await withTenant(ctx.tenant.id, async (tx) => {
      if (existingId) {
        await tx
          .update(gstParties)
          .set(values)
          .where(and(eq(gstParties.id, existingId), eq(gstParties.tenantId, ctx.tenant.id)));
        return;
      }
      await tx.insert(gstParties).values({ ...values, tenantId: ctx.tenant.id });
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeWriteFailure(err) };
  }
}

/**
 * ⚠️ THE DATABASE'S OWN SENTENCE, WHERE IT WROTE ONE FOR A PERSON.
 *
 * `server/gst/guards.ts` makes the same argument: the CHECK constraints
 * and triggers in this product raise messages written to be read, and
 * replacing them with a generic string discards the only explanation of
 * a rule nobody understands on first encounter. What is NOT passed
 * through is anything without a recognised SQLSTATE — an unexpected error
 * could carry internals, and a row-level message ends up in a CSV the
 * customer may forward.
 */
function describeWriteFailure(err: unknown): string {
  const candidate = err as { code?: unknown; constraint?: unknown; message?: unknown };
  const code = typeof candidate?.code === "string" ? candidate.code : null;
  const constraint =
    typeof candidate?.constraint === "string" ? candidate.constraint : "";

  if (code === "23505") {
    return (
      `The database already has a record this would collide with (${constraint || "unique constraint"}). ` +
      `Another user may have created it since the preview ran.`
    );
  }
  if (code === "23514" && typeof candidate.message === "string") {
    return candidate.message.replace(/^error:\s*/i, "").split("\nCONTEXT:")[0] ?? "Refused.";
  }
  if (code === "23503") {
    return "Something this row refers to no longer exists.";
  }

  console.error("[import:writeRow]", err);
  return "This row was refused by the database and has not been imported.";
}

/* ------------------------------------------------------------------ */
/* THE TWO EXPORTS                                                     */
/* ------------------------------------------------------------------ */

/**
 * The dry run. Reads the file, decides every row, writes nothing.
 *
 * ⚠️ IT RETURNS `ok: true` WITH A REPORT EVEN WHEN THE FILE IS UNUSABLE.
 * A `fatal` on the report — unbalanced quotes, a missing required column
 * — is information about the customer's file, not a failure of the
 * action, and rendering it in the report panel next to the column mapping
 * is what lets them see WHY. `ok: false` is reserved for the four gates
 * and for things that are genuinely our problem.
 */
export async function previewImport(input: ImportInput): Promise<ActionResult<ImportReport>> {
  return runImport(input, "preview");
}

/**
 * The real run. Identical to the preview in every respect except that it
 * writes — see `runImport`, where the single `mode` branch sits below
 * every decision.
 */
export async function commitImport(input: ImportInput): Promise<ActionResult<ImportReport>> {
  return runImport(input, "commit");
}
