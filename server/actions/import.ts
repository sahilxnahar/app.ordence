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
import { and, eq, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenant } from "@/db";
import {
  companies,
  gstParties,
  journalEntries,
  ledgers,
  salesInvoices,
  stockItems,
  stockMovements,
  transactions,
  vendorLedgerEntries,
  vendors,
  warehouses,
} from "@/db/schema";
import { financialPeriods } from "@/db/schema/accounting";
import { requirePermission, writeAudit } from "@/server/audit";
import { requireTenantContext, TenantAccessError } from "@/server/tenant-context";
import { requireAccess, AccessRestrictedError } from "@/server/billing/access";
import { requireFeature, FeatureLockedError } from "@/server/entitlements";
import { PermissionDeniedError } from "@/lib/permissions";
import { financialYearOf } from "@/lib/gst/constants";
import { formatMoneyPlain } from "@/lib/billing/money";
import {
  ALL_IMPORT_ENTITIES,
  buildReport,
  isImportEntityKey,
  openingBatchKey,
  planImport,
  type ImportEntityDefinition,
  type ImportLookup,
  type ImportNaturalKey,
  type ImportReport,
  type ImportRowPlan,
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

  /* ================================================================ */
  /* ⭐⭐ BATCH 58 — THE OPENING-BALANCE DESTINATIONS                   */
  /* ================================================================ */

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THE OPENING TRIAL BALANCE IS KEYED ON THE WHOLE ENTRY, NOT THE
   *    ROW
   * ══════════════════════════════════════════════════════════════════
   * `entity.batchKey` produces ONE key for the whole file —
   * `OPENING:TB:<as-at date>` — and it is looked for in
   * `transactions.transaction_number`, which carries a UNIQUE INDEX per
   * tenant. That index, not this query, is what makes two people
   * pressing the button at the same moment safe; this is what turns the
   * collision into a sentence instead of a `23505`.
   *
   * ⚠️ A REVERSED OR VOIDED ENTRY IS STILL A COLLISION, deliberately.
   * The transaction number stays on a reversed transaction, so posting
   * the same opening key again would hit the index and fail with a
   * database error rather than our message. Reversing an opening entry
   * and wanting a different one is a real need, and the answer is a
   * different as-at date — which is a different opening position and
   * should say so.
   */
  if (entity.table === "transactions") {
    const keyValues = valuesOf("openingEntry");
    if (keyValues.length === 0) return found;

    const rows = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .select({ id: transactions.id, number: transactions.transactionNumber })
        .from(transactions)
        .where(
          and(
            eq(transactions.tenantId, ctx.tenant.id),
            inArray(transactions.transactionNumber, keyValues),
          ),
        )
        .limit(10),
    );

    for (const row of rows) {
      if (row.number) found.set(`openingEntry:${row.number}`, row.id);
    }
    return found;
  }

  /**
   * ⚠️ THE INVOICE NUMBER, COMPARED EXACTLY. `sales_invoices_number_
   * tenant_key` is `UNIQUE (tenant_id, invoice_number)` with no
   * case folding, so lower-casing here would report `AH/2026/0041` and
   * `ah/2026/0041` as the same invoice and then watch Postgres accept
   * both.
   */
  if (entity.table === "sales_invoices") {
    const numbers = valuesOf("invoiceNumber");
    if (numbers.length === 0) return found;

    const rows = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .select({ id: salesInvoices.id, number: salesInvoices.invoiceNumber })
        .from(salesInvoices)
        .where(
          and(
            eq(salesInvoices.tenantId, ctx.tenant.id),
            inArray(salesInvoices.invoiceNumber, numbers),
          ),
        )
        .limit(5000),
    );

    for (const row of rows) found.set(`invoiceNumber:${row.number}`, row.id);
    return found;
  }

  /**
   * ⚠️ A JOIN, BECAUSE THE KEY SPANS TWO TABLES.
   * `vendor_ledger_entries` has no unique index on the reference number
   * — two suppliers both numbering a bill `001` is completely ordinary
   * — so the key is `(vendor code, bill number)` and the vendor's code
   * lives on `vendors`. Keying on the number alone would silently skip
   * the second supplier's bill as a duplicate of the first, and the
   * money would simply never be recorded as owed.
   */
  if (entity.table === "vendor_ledger_entries") {
    const composites = valuesOf("vendorBill");
    if (composites.length === 0) return found;

    const rows = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .select({
          id: vendorLedgerEntries.id,
          code: vendors.code,
          reference: vendorLedgerEntries.referenceNumber,
        })
        .from(vendorLedgerEntries)
        .innerJoin(
          vendors,
          and(
            eq(vendors.id, vendorLedgerEntries.vendorId),
            eq(vendors.tenantId, vendorLedgerEntries.tenantId),
          ),
        )
        .where(
          and(
            eq(vendorLedgerEntries.tenantId, ctx.tenant.id),
            inArray(
              sql`(lower(${vendors.code}) || '|' || coalesce(${vendorLedgerEntries.referenceNumber}, ''))`,
              composites,
            ),
          ),
        )
        .limit(5000),
    );

    for (const row of rows) {
      found.set(`vendorBill:${row.code.toLowerCase()}|${row.reference ?? ""}`, row.id);
    }
    return found;
  }

  /**
   * ⚠️ ONLY MOVEMENTS WHOSE REASON IS `opening_balance` COUNT AS A
   * MATCH. An item that has been received and sold twenty times since
   * go-live has twenty movements against the same slot, and treating any
   * of those as "the opening balance is already in" would make the
   * opening import silently do nothing on a workspace that had traded
   * for a week. The question is not "has this item ever moved" but "has
   * its opening position already been posted".
   */
  if (entity.table === "stock_movements") {
    const slots = valuesOf("stockSlot");
    if (slots.length === 0) return found;

    const rows = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .select({
          id: stockMovements.id,
          sku: stockItems.sku,
          code: warehouses.code,
          batchNo: stockMovements.batchNo,
        })
        .from(stockMovements)
        .innerJoin(
          stockItems,
          and(
            eq(stockItems.id, stockMovements.stockItemId),
            eq(stockItems.tenantId, stockMovements.tenantId),
          ),
        )
        .innerJoin(
          warehouses,
          and(
            eq(warehouses.id, stockMovements.warehouseId),
            eq(warehouses.tenantId, stockMovements.tenantId),
          ),
        )
        .where(
          and(
            eq(stockMovements.tenantId, ctx.tenant.id),
            eq(stockMovements.reason, "opening_balance"),
            inArray(
              sql`(lower(${stockItems.sku}) || '|' || lower(${warehouses.code}) || '|' || lower(coalesce(${stockMovements.batchNo}, '')))`,
              slots,
            ),
          ),
        )
        .limit(5000),
    );

    for (const row of rows) {
      const key = `stockSlot:${row.sku.toLowerCase()}|${row.code.toLowerCase()}|${(row.batchNo ?? "").toLowerCase()}`;
      if (!found.has(key)) found.set(key, row.id);
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
/* ⭐⭐ BATCH 58 — RESOLVING WHAT A ROW REFERS TO                       */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 RESOLVED IN THE PREVIEW, NOT AT THE WRITE
 * ══════════════════════════════════════════════════════════════════════
 * An opening trial balance line names an ACCOUNT CODE; an opening invoice
 * names a CUSTOMER. The obvious implementation looks those up inside the
 * insert and lets a miss become a foreign-key violation — which means the
 * dry run says "412 will be created" and the real run creates 380. That
 * is exactly the drift constraint 1 forbids, and it is the failure that
 * teaches a customer to stop reading the preview.
 *
 * So this runs for BOTH runs, from ONE call site, exactly like
 * `findExistingByNaturalKey` does and for the same reason. A row whose
 * lookup misses becomes an ordinary reported error with the entity's own
 * sentence on it, in the preview, before anything is written.
 *
 * ⚠️ ONE QUERY PER KIND FOR THE WHOLE FILE, not one per row — a thousand
 * rows would otherwise be a thousand round trips before a byte was
 * written, and the preview would be slower than the commit.
 *
 * The map is keyed `"kind:value"`, the same composite the pure layer
 * builds, so the two cannot diverge.
 */
async function resolveLookups(
  ctx: TenantContext,
  rows: readonly ImportRowPlan[],
): Promise<Map<string, string>> {
  const wanted = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const lookup of row.lookups ?? []) {
      const set = wanted.get(lookup.kind) ?? new Set<string>();
      set.add(lookup.value);
      wanted.set(lookup.kind, set);
    }
  }

  const found = new Map<string, string>();
  if (wanted.size === 0) return found;

  await withTenant(ctx.tenant.id, async (tx) => {
    for (const [kind, values] of wanted) {
      const list = Array.from(values);
      /*
       * ⚠️ AN EMPTY LIST NEVER REACHES `inArray`. Drizzle turns
       * `inArray(x, [])` into a predicate that is not the refusal anybody
       * expects, and the same mistake `matchAny` guards against above.
       */
      if (list.length === 0) continue;

      if (kind === "ledger_by_code") {
        /*
         * ⚠️ INACTIVE AND SOFT-DELETED ACCOUNTS ARE NOT MATCHES. Posting
         * an opening balance to an account somebody retired would revive
         * a line on the balance sheet that a human deliberately closed,
         * and it would be invisible: the code matched, so the import
         * reports success.
         */
        const rowsFound = await tx
          .select({ id: ledgers.id, code: ledgers.code })
          .from(ledgers)
          .where(
            and(
              eq(ledgers.tenantId, ctx.tenant.id),
              eq(ledgers.isActive, true),
              isNull(ledgers.deletedAt),
              inArray(sql`lower(${ledgers.code})`, list),
            ),
          )
          .limit(5000);
        for (const row of rowsFound) {
          found.set(`ledger_by_code:${row.code.toLowerCase()}`, row.id);
        }
        continue;
      }

      if (kind === "company_by_name") {
        /*
         * ⚠️ THE SAME NORMALISATION THE COMPANIES IMPORTER USES —
         * lower-cased, runs of whitespace collapsed. `\\s` and not `\s`,
         * because this is a template literal where `\s` collapses to a
         * bare `s` and the pattern would strip the letter s out of every
         * company name before comparing. It matches nothing, silently.
         */
        const rowsFound = await tx
          .select({ id: companies.id, name: companies.name })
          .from(companies)
          .where(
            and(
              eq(companies.tenantId, ctx.tenant.id),
              isNull(companies.deletedAt),
              inArray(
                sql`lower(regexp_replace(${companies.name}, '\\s+', ' ', 'g'))`,
                list,
              ),
            ),
          )
          .limit(5000);
        for (const row of rowsFound) {
          const key = `company_by_name:${row.name.toLowerCase().replace(/\s+/g, " ")}`;
          if (!found.has(key)) found.set(key, row.id);
        }
        continue;
      }

      if (kind === "vendor_by_code") {
        const rowsFound = await tx
          .select({ id: vendors.id, code: vendors.code })
          .from(vendors)
          .where(
            and(
              eq(vendors.tenantId, ctx.tenant.id),
              inArray(sql`lower(${vendors.code})`, list),
            ),
          )
          .limit(5000);
        for (const row of rowsFound) {
          found.set(`vendor_by_code:${row.code.toLowerCase()}`, row.id);
        }
        continue;
      }

      if (kind === "stock_item_by_sku") {
        const rowsFound = await tx
          .select({ id: stockItems.id, sku: stockItems.sku })
          .from(stockItems)
          .where(
            and(
              eq(stockItems.tenantId, ctx.tenant.id),
              eq(stockItems.isActive, true),
              isNull(stockItems.deletedAt),
              inArray(sql`lower(${stockItems.sku})`, list),
            ),
          )
          .limit(5000);
        for (const row of rowsFound) {
          found.set(`stock_item_by_sku:${row.sku.toLowerCase()}`, row.id);
        }
        continue;
      }

      if (kind === "warehouse_by_code") {
        const rowsFound = await tx
          .select({ id: warehouses.id, code: warehouses.code })
          .from(warehouses)
          .where(
            and(
              eq(warehouses.tenantId, ctx.tenant.id),
              eq(warehouses.isActive, true),
              isNull(warehouses.deletedAt),
              inArray(sql`lower(${warehouses.code})`, list),
            ),
          )
          .limit(5000);
        for (const row of rowsFound) {
          found.set(`warehouse_by_code:${row.code.toLowerCase()}`, row.id);
        }
        continue;
      }
    }
  });

  return found;
}

/* ------------------------------------------------------------------ */
/* THE ONE RUN                                                         */
/* ------------------------------------------------------------------ */

/** Every mode, for an entity that has not narrowed the list. */
const ALL_DUPLICATE_MODES = ["skip", "update", "fail"] as const;

/** A row that has passed everything and is waiting for the write. */
type PlannedWrite = {
  row: ImportRowPlan;
  /** The payload with every resolved lookup id merged in. */
  payload: Record<string, unknown>;
  existingId: string | null;
};

async function runImport(
  input: unknown,
  mode: "preview" | "commit",
): Promise<ActionResult<ImportReport>> {
  try {
    const params = importInputSchema.parse(input);

    if (!isImportEntityKey(params.entity)) {
      return fail("That is not something this can import.");
    }
    const entity: ImportEntityDefinition = ALL_IMPORT_ENTITIES[params.entity];

    /*
     * ══════════════════════════════════════════════════════════════
     * 🔴 AN ENTITY MAY NARROW THE DUPLICATE MODES, AND THE OPENING
     *    ENTITIES ALL DO — NONE OF THEM HAS AN `update`
     * ══════════════════════════════════════════════════════════════
     * `journal_entries` is append-only by design; an issued invoice is
     * frozen by a database trigger. "Overwrite what is already there" is
     * not a slow or dangerous operation for those, it is an operation
     * the ledger cannot perform — so offering it and failing at the
     * write would be offering it at the worst possible moment. Refused
     * here, before the guard, with the remedy in the sentence.
     */
    const allowedModes = entity.duplicateModes ?? ALL_DUPLICATE_MODES;
    if (!allowedModes.includes(params.duplicateMode)) {
      return fail(
        `${entity.label} cannot be imported with "overwrite what is already there". ` +
          `A posted entry is corrected by reversing it and posting a new one, which ` +
          `leaves a trail, not by rewriting the figures underneath it. Choose to ` +
          `skip what is already here, or to be told about it.`,
      );
    }

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

    const outcomes = new Map<number, RowOutcome>();
    const parsedRows = plan.rows.filter((row) => row.errors.length === 0);

    /*
     * ⭐ THE SECOND SHARED LINE. See `resolveLookups` — an account code
     * or a customer name that names nothing becomes a reported row error
     * in the DRY RUN, not a foreign-key violation in the real one.
     */
    const resolved = await resolveLookups(ctx, parsedRows);

    const validRows: ImportRowPlan[] = [];
    const payloads = new Map<number, Record<string, unknown>>();

    for (const row of parsedRows) {
      const lookups = row.lookups ?? [];
      const missing = lookups.filter(
        (lookup: ImportLookup) => !resolved.has(`${lookup.kind}:${lookup.value}`),
      );

      if (missing.length > 0) {
        outcomes.set(row.recordNumber, {
          disposition: "error",
          matchedOn: null,
          errors: missing.map((lookup: ImportLookup) => ({
            column: null,
            message: lookup.missing,
          })),
        });
        continue;
      }

      /*
       * ⚠️ THE RESOLVED ID IS CARRIED FORWARD RATHER THAN LOOKED UP
       * AGAIN AT THE WRITE. Re-resolving would open a window in which
       * the thing that was previewed and the thing that is written are
       * different rows.
       */
      const payload: Record<string, unknown> = { ...(row.payload ?? {}) };
      for (const lookup of lookups) {
        payload[lookup.into] = resolved.get(`${lookup.kind}:${lookup.value}`);
      }
      payloads.set(row.recordNumber, payload);
      validRows.push(row);
    }

    /*
     * ⭐⭐ ONE KEY FOR THE WHOLE FILE, OR ONE PER ROW — AND EXACTLY ONE
     * CALL SITE EITHER WAY.
     *
     * An opening trial balance is a single journal entry, so what must
     * not happen twice is the ENTRY, not the line. `batchKey` produces
     * `OPENING:TB:<as-at>`; every row of the file then shares its
     * outcome, because they share their fate.
     */
    const batchKey = entity.batchKey?.(validRows) ?? null;
    const existing = await findExistingByNaturalKey(
      ctx,
      entity,
      entity.batchKey
        ? batchKey
          ? [batchKey]
          : []
        : validRows.map((row) => row.naturalKey).filter((k): k is ImportNaturalKey => !!k),
    );

    const planned: PlannedWrite[] = [];

    for (const row of validRows) {
      const identity = batchKey ?? row.naturalKey ?? null;
      const composite = identity ? `${identity.kind}:${identity.value}` : null;
      const existingId = composite ? existing.get(composite) : undefined;

      if (existingId && params.duplicateMode === "skip") {
        outcomes.set(row.recordNumber, {
          disposition: "skip",
          matchedOn: identity?.label ?? null,
        });
        continue;
      }

      if (existingId && params.duplicateMode === "fail") {
        outcomes.set(row.recordNumber, {
          disposition: "error",
          matchedOn: identity?.label ?? null,
          errors: [
            {
              column: null,
              message:
                `A ${entity.noun.one} with ${identity?.label ?? "this identity"} ` +
                `is already in this workspace, and you chose to refuse those rather ` +
                `than skip or overwrite them.`,
            },
          ],
        });
        continue;
      }

      outcomes.set(row.recordNumber, {
        disposition: existingId ? "update" : "create",
        matchedOn: existingId ? (identity?.label ?? null) : null,
      });
      planned.push({
        row,
        payload: payloads.get(row.recordNumber) ?? {},
        existingId: existingId ?? null,
      });
    }

    /*
     * ══════════════════════════════════════════════════════════════
     * 🔴 THE ONLY BRANCH ON `mode` IN THE DECISION PATH, AND IT IS
     *    BELOW EVERY DECISION
     * ══════════════════════════════════════════════════════════════
     * Everything above — validation, coercion, in-file duplicates, the
     * lookup resolution, the existing-record lookup, skip/fail — has
     * already run identically for both runs and has already recorded an
     * outcome for every row. All the write can do is turn a `create`
     * into an `error` when the database refuses it, which is precisely
     * the residue `lib/import/plan.ts` says a preview cannot promise.
     *
     * ⚠️ AND THE BRANCH MOVED OUT OF THE ROW LOOP IN BATCH 58, which is
     * what lets an ATOMIC entity write one document for the whole file
     * without a second `mode` test appearing somewhere below it.
     */
    if (mode === "commit") {
      await performWrites(ctx, entity, planned, outcomes);
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
          /*
           * ⭐ THE KEY GOES IN THE AUDIT ENTRY. Somebody asking in two
           * years "where did this opening position come from" can paste
           * the transaction number from the trial balance into a search
           * and land on the act that created it.
           */
          batchKey: batchKey?.value ?? null,
        },
      });

      revalidatePath(REVALIDATE_AFTER[entity.table]);
    }

    return { ok: true, data: report };
  } catch (err) {
    return toImportActionError(err, mode);
  }
}

/**
 * Where a successful import invalidates a cached page.
 *
 * ⚠️ A MAP RATHER THAN A TERNARY. The ternary this replaced read
 * `entity.table === "companies" ? "/companies" : "/settings/gst"`, which
 * meant every entity added after the second one revalidated the GST
 * settings page — a wrong page refreshed and the right one left stale, in
 * silence. A `Record` keyed on the union makes TypeScript refuse to
 * compile when a destination is added without one.
 */
const REVALIDATE_AFTER: Record<ImportEntityDefinition["table"], string> = {
  companies: "/companies",
  gst_parties: "/settings/gst",
  transactions: "/accounting",
  sales_invoices: "/invoices",
  vendor_ledger_entries: "/purchases",
  stock_movements: "/inventory",
};

/**
 * ⭐⭐ BATCH 58 — WRITE WHAT WAS PLANNED.
 *
 * Two shapes, and the difference is the whole reason `atomic` exists:
 *
 *   ONE DOCUMENT PER FILE — the opening trial balance. Every row is a leg
 *   of a single balanced journal entry, so they are written in one
 *   transaction and share one outcome. There is no such thing as
 *   importing four-fifths of a journal entry.
 *
 *   ONE DOCUMENT PER ROW — everything else. N transactions, partial
 *   success by design, for the reasons `lib/import/report.ts` sets out.
 *
 * ⚠️ IT MUTATES `outcomes` RATHER THAN RETURNING, so a write failure
 * turns exactly the affected rows into errors and leaves the rest of the
 * report — which was computed identically in the preview — untouched.
 */
async function performWrites(
  ctx: TenantContext,
  entity: ImportEntityDefinition,
  planned: readonly PlannedWrite[],
  outcomes: Map<number, RowOutcome>,
): Promise<void> {
  if (planned.length === 0) return;

  if (entity.table === "transactions") {
    const written = await writeOpeningTrialBalance(ctx, planned);
    if (written.ok) return;
    for (const item of planned) {
      outcomes.set(item.row.recordNumber, {
        disposition: "error",
        matchedOn: null,
        errors: [{ column: null, message: written.error }],
      });
    }
    return;
  }

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
   * transaction around the whole file means the one row Postgres refuses
   * rolls back the other 999 — which is precisely the all-or-nothing
   * behaviour that makes an importer unusable against real exported
   * data. And "no record of where it stopped" is exactly what the report
   * is: every row's outcome, named, with the failures downloadable.
   *
   * ⚠️ SEQUENTIAL, NOT `Promise.all`. Parallel writes would open a
   * connection per row against a serverless Postgres, and the first
   * consequence of exhausting the pool is unrelated requests failing
   * elsewhere in the workspace.
   */
  for (const item of planned) {
    const written = await writeRow(ctx, entity, item.payload, item.existingId);
    if (!written.ok) {
      outcomes.set(item.row.recordNumber, {
        disposition: "error",
        matchedOn: null,
        errors: [{ column: null, message: written.error }],
      });
    }
  }
}

/** Minor units held as a digit string, as the coercion layer produces them. */
function minorOf(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value !== "string" || value.trim() === "") return 0n;
  /*
   * 🔴 NEVER `Number(value)`. These are paise and routinely run past
   * 2^53 — a crore of rupees is 10^9 paise and a balance-sheet total is
   * a hundred times that. `BigInt` of a digit string cannot lose a digit
   * it never converted.
   */
  return BigInt(value);
}

/**
 * Integer thousandths to the `numeric(18,3)` literal Postgres wants.
 *
 * ⚠️ ASSEMBLED FROM THE QUOTIENT AND THE REMAINDER, never
 * `Number(n) / 1000`. That division is exact for small numbers and
 * silently lossy for large ones, and the symptom is a stock ledger that
 * is a fraction out on the movements nobody looks at.
 */
function thousandthsToDecimal(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / 1000n;
  const fraction = magnitude % 1000n;
  return `${negative ? "-" : ""}${whole.toString()}.${fraction.toString().padStart(3, "0")}`;
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE OPENING POSITION POSTS AS A REAL JOURNAL ENTRY
 * ══════════════════════════════════════════════════════════════════════
 * Not an `opening_balance` column beside the ledger, not a number the
 * balance sheet adds on afterwards. One row in `transactions` and one
 * `journal_entries` leg per account, which means the opening position is
 * in the trial balance, the P&L, the balance sheet, the statement of
 * every account it touches and the Tally export — all of which read the
 * ledger and only the ledger — without any of them being taught about
 * it. A figure the ledger cannot explain is a figure that will disagree
 * with every report, and disagree quietly.
 *
 * ⭐ `reference_type` IS `opening_balance`, WHICH ALREADY EXISTED IN THE
 * ENUM AND HAD NEVER BEEN USED. Somebody anticipated this. It means the
 * entry is classifiable — a reader, a report or the Tally exporter can
 * tell a migration artefact from a trade — and `classifyVoucherType`
 * maps it to a plain journal voucher, which is what it is.
 *
 * ⚠️ THE WHOLE ENTRY IS ONE DATABASE TRANSACTION. The deferred constraint
 * trigger from Phase 4 checks that debits equal credits PER TRANSACTION
 * at commit, so a half-written opening entry cannot survive. That is the
 * third of three gates: the pure layer refuses an unbalanced file, the
 * schema refuses an unbalanced payload, and the database refuses an
 * unbalanced commit. All three would have to be removed to corrupt the
 * ledger.
 */
async function writeOpeningTrialBalance(
  ctx: TenantContext,
  planned: readonly PlannedWrite[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const first = planned[0];
  if (!first) return { ok: true };

  const asAt = String(first.payload.asAt ?? "");
  const key = openingBatchKey("trial_balance", asAt);

  let debitTotal = 0n;
  for (const item of planned) debitTotal += minorOf(item.payload.debitMinor);

  try {
    const refusal = await withTenant(ctx.tenant.id, async (tx) => {
      /*
       * 🔴🔴 THE PERIOD LOCK. `server/accounting/post-sales.ts` makes the
       * same check and says why: closing a period is a statement made to
       * an auditor that the numbers are final, and an import that keeps
       * landing entries inside a closed month is worse than having no
       * period close at all.
       *
       * ⚠️ AND AN OPENING BALANCE IS THE MOST LIKELY THING TO HIT IT,
       * because it is dated in the PAST by definition — usually the last
       * day of a financial year, which is exactly the period somebody
       * closes first.
       */
      const [locked] = await tx
        .select({ name: financialPeriods.name })
        .from(financialPeriods)
        .where(
          and(
            eq(financialPeriods.tenantId, ctx.tenant.id),
            lte(financialPeriods.startDate, asAt),
            gte(financialPeriods.endDate, asAt),
            inArray(financialPeriods.status, ["closed", "locked"]),
          ),
        )
        .limit(1);

      if (locked) {
        return (
          `${asAt} falls inside "${locked.name}", which is closed. Nothing has been ` +
          `posted. Reopen that period deliberately, or date the opening position ` +
          `to a day that is still open — closing a period is a statement that its ` +
          `numbers are final, so this refuses rather than quietly making it untrue.`
        );
      }

      const [txn] = await tx
        .insert(transactions)
        .values({
          tenantId: ctx.tenant.id,
          /*
           * 🔴 THE IDEMPOTENCY KEY, AND THE DATABASE HOLDS IT UNIQUE PER
           * TENANT. Our own check ran in `findExistingByNaturalKey`
           * above and produced a readable outcome; this index is what
           * makes two people pressing the button at the same moment
           * safe, and it cannot be forgotten by a future caller.
           */
          transactionNumber: key,
          description: `Opening balances as at ${asAt}`,
          transactionDate: asAt,
          status: "posted",
          referenceType: "opening_balance",
          currency: "INR",
          /*
           * ⚠️ THE DEBIT SIDE, NOT THE SUM OF EVERY LEG. Adding both
           * sides reports an opening position of ₹20,00,000 as
           * ₹40,00,000 — exactly twice the truth, and entirely plausible
           * on a list of transactions.
           */
          totalAmount: formatMoneyPlain(debitTotal, "INR"),
          createdBy: ctx.user.id,
          postedAt: new Date(),
          metadata: { source: "import", asAt, lines: planned.length },
        })
        .returning({ id: transactions.id });

      if (!txn) throw new Error("The opening journal entry could not be created.");

      await tx.insert(journalEntries).values(
        planned.map((item) => {
          const debit = minorOf(item.payload.debitMinor);
          const credit = minorOf(item.payload.creditMinor);
          const isDebit = debit > 0n;
          return {
            tenantId: ctx.tenant.id,
            transactionId: txn.id,
            ledgerId: String(item.payload.ledgerId),
            entryType: isDebit ? ("debit" as const) : ("credit" as const),
            /*
             * ⚠️ `numeric(18,2)` FROM `bigint` PAISE BY STRING, never by
             * dividing. `Number(n) / 100` for a large n loses precision,
             * and the failure is a rounded rupee in a ledger that is
             * supposed to balance to the paisa.
             */
            amount: formatMoneyPlain(isDebit ? debit : credit, "INR"),
            description: `Opening balance as at ${asAt}`,
            referenceType: "opening_balance" as const,
          };
        }),
      );

      return null;
    });

    if (refusal) return { ok: false, error: refusal };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeWriteFailure(err) };
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

    /* ============================================================== */
    /* ⭐⭐ BATCH 58 — THE OPENING SUB-LEDGERS                          */
    /* ============================================================== */

    /**
     * ══════════════════════════════════════════════════════════════
     * 🔴🔴 AN OPENING INVOICE IS A BALANCE BROUGHT FORWARD, NOT A TAX
     *      INVOICE, AND THE DIFFERENCE IS A RETURN FILED TWICE
     * ══════════════════════════════════════════════════════════════
     * The customer's unpaid invoices were raised in the system they are
     * leaving. Their supply was reported in that system's GSTR-1 and the
     * tax on it has been paid. Re-creating them here as full tax
     * invoices — with a taxable value and a tax split — would put the
     * same supplies into an Ordence return, and the Government would be
     * told about them twice.
     *
     * ⭐ SO `taxable_value_minor` AND EVERY TAX COLUMN ARE ZERO. What is
     * carried is `total_minor`, which is what the customer owes, and
     * that is what a statement of account, an ageing report and a
     * reminder letter need. There are no invoice LINES either: this
     * document has no HSN summary to contribute, because the supply it
     * records was not made in Ordence.
     *
     * 🔴 AND `issued_at` IS THE INVOICE'S OWN DATE, NOT `now()`.
     * `loadGstr1Documents` filters on `issued_at` — its own comment says
     * "THE FILTER IS ON `issued_at`, NOT ON `invoice_date`, AND THE
     * DIFFERENCE IS A LATE FILING". Stamping today's date would sweep
     * every historical invoice into THIS month's return, which is the
     * single most expensive mistake available in this file. Dated at the
     * invoice's own day it lands in a period that closed before the
     * workspace existed and that nobody will ever file from here.
     *
     * ⚠️ THE ROW IS `issued` AND NOT `draft`, DELIBERATELY. A draft is
     * excluded from the customer ledger and from ageing, which would
     * make the whole import invisible — the one thing it exists to
     * prevent.
     */
    if (entity.table === "sales_invoices") {
      const invoiceDate = String(payload.invoiceDate ?? "");
      const outstanding = minorOf(payload.outstandingMinor);
      const invoiceNumber = String(payload.invoiceNumber ?? "");

      await withTenant(ctx.tenant.id, async (tx) => {
        await tx.insert(salesInvoices).values({
          tenantId: ctx.tenant.id,
          invoiceNumber,
          /*
           * ⚠️ THE FINANCIAL YEAR OF THE INVOICE'S OWN DATE. Rule 46(b)
           * makes a serial unique for a financial year, and the Indian
           * one runs 1 April to 31 March — `financialYearOf` is the
           * single place that decides where the boundary is, so this
           * cannot drift from the numbering the rest of the product does.
           */
          financialYear: financialYearOf(invoiceDate),
          status: "issued",
          companyId: String(payload.companyId),
          invoiceDate,
          dueDate: (payload.dueDate as string | null) ?? null,
          currency: "INR",
          subtotalMinor: outstanding,
          taxableValueMinor: 0n,
          totalMinor: outstanding,
          issuedAt: new Date(`${invoiceDate}T00:00:00+05:30`),
          issuedBy: ctx.user.id,
          notes:
            (payload.notes as string | null) ??
            "Opening balance brought forward from the previous system.",
          createdBy: ctx.user.id,
        });
      });
      return { ok: true };
    }

    /**
     * ⚠️ A CREDIT, BECAUSE A VENDOR ACCOUNT IS A PAYABLE.
     * `lib/purchases/vendor-ledger.ts` states the convention and warns
     * that copying the customer side's by analogy produces a report on
     * which every counterparty is in credit — "which looks like a data
     * problem and gets debugged in the wrong place for a day". A bill
     * INCREASES what we owe, so it is a credit.
     *
     * ⭐ `entry_type` IS `purchase_invoice` EVEN THOUGH THERE IS NO
     * `purchase_invoices` ROW BEHIND IT. That is what this is — a bill —
     * and `purchase_invoice_id` is nullable precisely so a ledger entry
     * can exist without the document. Calling it an `adjustment` would
     * be filing a genuine liability under "miscellaneous", where the
     * MSME ageing report is entitled to ignore it.
     */
    if (entity.table === "vendor_ledger_entries") {
      await withTenant(ctx.tenant.id, async (tx) => {
        await tx.insert(vendorLedgerEntries).values({
          tenantId: ctx.tenant.id,
          vendorId: String(payload.vendorId),
          entryDate: String(payload.billDate ?? ""),
          entryType: "purchase_invoice",
          referenceNumber: String(payload.billNumber ?? ""),
          description:
            (payload.notes as string | null) ??
            "Opening balance brought forward from the previous system.",
          debitMinor: 0n,
          creditMinor: minorOf(payload.outstandingMinor),
          dueDate: (payload.dueDate as string | null) ?? null,
          createdBy: ctx.user.id,
        });
      });
      return { ok: true };
    }

    /**
     * ⚠️ THE BALANCE IS NOT WRITTEN — THE MOVEMENT IS.
     * `stock_balances` is maintained by a trigger from `stock_movements`,
     * and `stock_movements.quantity` is `SUM`med to get it. Writing a
     * balance directly would be a second writer of a column that has one,
     * and the two would disagree the first time anything else moved.
     *
     * ⭐ `reason` IS `opening_balance`, WHICH THE ENUM ALREADY HAD. It is
     * also what makes the re-run check above answerable: the question is
     * not "has this item ever moved" but "has its opening position
     * already been posted", and only a reason can tell those apart.
     */
    if (entity.table === "stock_movements") {
      const asAt = String(payload.asAt ?? "");
      const quantityThousandths = minorOf(payload.quantityThousandths);
      const unitCostMinor = minorOf(payload.unitCostMinor);

      await withTenant(ctx.tenant.id, async (tx) => {
        await tx.insert(stockMovements).values({
          tenantId: ctx.tenant.id,
          stockItemId: String(payload.stockItemId),
          warehouseId: String(payload.warehouseId),
          /*
           * ⚠️ `numeric(18,3)` FROM INTEGER THOUSANDTHS BY STRING, never
           * by dividing. `Number(n) / 1000` is where `0.1 + 0.2 !== 0.3`
           * gets into a stock ledger, and a ledger that is out by a
           * millionth on every movement stops reconciling after a few
           * thousand of them.
           */
          quantity: thousandthsToDecimal(quantityThousandths),
          reason: "opening_balance",
          /*
           * ⚠️ THE DAY IT WAS COUNTED, NOT THE DAY IT WAS UPLOADED. A
           * count done on the 31st and imported on the 4th is a count as
           * at the 31st, and every valuation report that reads
           * `moved_at` would otherwise put four days of trading on the
           * wrong side of it.
           */
          movedAt: new Date(`${asAt}T00:00:00+05:30`),
          unitCostMinor,
          /*
           * ⚠️ VALUE IS COMPUTED IN `BigInt` FROM THE THOUSANDTHS AND
           * THE PAISE, then divided by 1000 — integer arithmetic
           * throughout. The rounding is toward zero, which is worth at
           * most a paisa on a line, and it is the same direction every
           * time rather than whichever way a float happened to land.
           */
          valueMinor: (quantityThousandths * unitCostMinor) / 1000n,
          batchNo: (payload.batchNo as string | null) ?? null,
          referenceType: "opening_balance",
          documentNo: openingBatchKey("stock", asAt),
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
