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
import { functionalCurrencyFromSettings } from "@/lib/fx/currency";
import {
  ALL_IMPORT_ENTITIES,
  buildReport,
  isImportEntityKey,
  openingBatchKey,
  planImport,
  planImportRecords,
  type ImportContext,
  type ImportEntityDefinition,
  type ImportLookup,
  type ImportNaturalKey,
  type ImportReport,
  type ImportRowPlan,
  type RowOutcome,
} from "@/lib/import";
import type { TenantContext } from "@/server/tenant-context";
import type { ActionResult } from "@/lib/validators/crm";
import { IMPORT_SOURCE_FORMATS } from "@/lib/import/sources";
import { IMPORT_WRITERS } from "@/server/import/writers/registry";
import type { PlannedWrite } from "@/server/import/writers/types";
/**
 * ⭐⭐⭐ WAVE 6 — THE MIGRATION ENGINE'S OWN PIECES.
 *
 * ⚠️ EVERY ONE OF THESE IS PURE OR SERVER-SCOPED, AND NONE OF THEM
 * REPLACES ANYTHING ABOVE. The one-shot import that predates wave 6 is
 * untouched; these add a run around it.
 */
import {
  proposeMapping,
  mayAutoCommit,
  parseAutoCommitPolicy,
  type AutoCommitPolicy,
  type AutoCommitVerdict,
  type MappingProposal,
} from "@/lib/import/proposal";
import { EVIDENCE_SAMPLE_ROWS } from "@/lib/import/shapes";
import { MAX_IMPORT_ROWS } from "@/lib/import/plan";
import {
  proposeMappingWithAi,
  type AiMappingOutcome,
} from "@/server/import/ai-mapper";
import { recordProposal } from "@/server/import/proposals";
import { recordChunk } from "@/server/import/runs";
import {
  startImportRun,
  finishImportRun,
  listImportRuns,
  type FinishResult,
  type ImportRunView,
} from "@/server/import/runs";

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
const importInputSchema = z
  .object({
    entity: z.string().min(1),
    /**
     * The file contents as text. Read in the browser with `File.text()`
     * rather than uploaded as multipart, because the wizard needs the same
     * string to build the failed-rows download and re-run a preview without
     * a second round trip.
     *
     * ⚠️ OPTIONAL SINCE WAVE 6, AND ONLY BECAUSE `records` EXISTS. Every
     * caller that predates wave 6 still sends it and is unchanged.
     */
    csvText: z.string().optional(),
    /**
     * ⭐⭐⭐ WAVE 6 — THE ROW STREAM, WHEN THE SOURCE WAS NOT CSV.
     *
     * `lib/import/sources/` reads Excel, JSON and Tally XML into exactly
     * the shape `parseCsv` produces, IN THE BROWSER, because every reader
     * in that directory is pure. What arrives here is therefore the same
     * records a CSV would have produced, and `planImportRecords` cannot
     * tell the difference — which is the entire cost of supporting every
     * input format.
     *
     * 🔴 SENT AS RECORDS RATHER THAN RE-SERIALISED TO CSV. Round-tripping
     * a spreadsheet back through CSV text to reuse the old entry point
     * would put every CSV ambiguity — quoting, embedded newlines, the
     * formula guard — between the customer's file and the importer, for
     * data that had already been read correctly.
     */
    records: z
      .array(
        z.object({
          recordNumber: z.number().int().nonnegative(),
          cells: z.array(z.string()),
        }),
      )
      .optional(),
    /** Which reader produced the records. Recorded on the run. */
    sourceFormat: z.enum(IMPORT_SOURCE_FORMATS).optional(),
    sourceName: z.string().max(255).optional(),
    sourceSheet: z.string().max(120).optional(),
    /**
     * ⭐ WAVE 6 — WHICH CHUNK OF WHICH MIGRATION THIS IS.
     *
     * Absent for an ordinary one-shot upload, which is still the common
     * case and still behaves exactly as it did.
     */
    run: z
      .object({
        id: z.string().uuid(),
        chunkIndex: z.number().int().nonnegative(),
      })
      .optional(),
    duplicateMode: z.enum(["skip", "update", "fail"], {
      required_error: "Choose what should happen to records that already exist.",
      invalid_type_error: "Choose what should happen to records that already exist.",
    }),
  })
  /**
   * ⚠️ EXACTLY ONE OF THE TWO. Accepting both and preferring one is how a
   * caller ends up importing the file it did not mean to, with nothing
   * saying which was used.
   */
  .refine((v) => Boolean(v.csvText) !== Boolean(v.records), {
    message: "An import needs either the file's text or its parsed rows, and not both.",
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
 * Find rows already in the workspace matching these natural keys.
 *
 * ⚠️ THE FIVE `if (entity.table === ...)` BRANCHES THAT USED TO BE HERE
 * ARE GONE, AND SO IS THE SIXTH THING THAT WAS NOT AN `if`.
 *
 * `gst_parties` was the UNGUARDED CODE AFTER THE LAST BRANCH. A
 * destination nobody had written a branch for did not fall through to
 * nothing , it matched existing GST parties by natural key, and then
 * `writeRow` inserted into `gst_parties`. A stock-item import missing its
 * branch would have put the customer's stock list in their tax master and
 * reported success.
 *
 * ⭐ Dispatch is now `IMPORT_WRITERS[entity.table]`, a `Record` over the
 * destination union, so a destination with no writer is a compile error
 * at the registry rather than a silent write to whichever branch happened
 * to be last.
 */
async function findExistingByNaturalKey(
  ctx: TenantContext,
  entity: ImportEntityDefinition,
  keys: readonly ImportNaturalKey[],
): Promise<Map<string, string>> {
  return IMPORT_WRITERS[entity.table].findExisting(ctx, keys);
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
     * of what is in the file from here, and neither planner takes an
     * argument that could make it behave differently for one of them.
     *
     * ⚠️ THE BRANCH IS OVER WHERE THE ROWS CAME FROM AND NOTHING ELSE.
     * `planImport` parses CSV text and then calls `planImportRecords`;
     * a spreadsheet, a JSON export and a Tally day book have already been
     * turned into records by `lib/import/sources/` in the browser. From
     * this line down there is one code path for every format, which is
     * what stops "we support Excel" from becoming a second importer with
     * its own bugs.
     */
    /*
     * ⭐⭐⭐ WAVE 2C — THE ONE FACT THE PURE LAYER CANNOT KNOW.
     *
     * 🔴 `lib/import/` MUST NOT IMPORT THE DATABASE (rule 4), and the
     * number of decimal places an amount has is a fact about the
     * workspace's currency, which is a row in `tenants`. So it is read
     * HERE — by the same `functionalCurrencyFromSettings()` that
     * `runFxRevaluation` and every sales posting read — and handed down
     * as data.
     *
     * ⚠️ BOTH RUNS GET THE SAME OBJECT, on the same line, for the same
     * reason the planner itself is shared: a preview that read INR and a
     * commit that read KWD would disagree about which rows are valid,
     * which is constraint 1's failure mode with a new cause.
     */
    const planContext: ImportContext = {
      workspaceCurrency: functionalCurrencyFromSettings(ctx.tenant.settings).code,
    };

    const plan = params.records
      ? planImportRecords(entity, params.records, planContext)
      : planImport(entity, params.csvText ?? "", planContext);

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

      revalidatePath(IMPORT_WRITERS[entity.table].revalidatePath);
    }

    /*
     * ══════════════════════════════════════════════════════════════
     * ⭐⭐⭐ WAVE 6 — THIS CHUNK, RECORDED AGAINST ITS RUN
     * ══════════════════════════════════════════════════════════════
     * ⚠️ AFTER THE WRITES AND BEFORE THE RETURN, and only on a commit.
     * A preview writes nothing and must not move a run's totals.
     *
     * 🔴 AND IT IS ALLOWED TO SAY "already done". `recordChunk` inserts
     * against a unique index on (run, chunk) rather than checking first,
     * because a chunk that timed out has often already committed and the
     * browser cannot tell "never arrived" from "arrived and the answer
     * was lost". The insert losing that race is the correct outcome and
     * the note says so.
     *
     * ⚠️ A FAILURE HERE DOES NOT DISCARD THE REPORT. The rows are already
     * written; refusing to hand back the report to protect a counter
     * would leave the customer with no idea what happened to them. The
     * run's totals are recomputed from the chunk table on every
     * subsequent chunk, so one lost record self-corrects — and the run
     * still refuses to call itself completed if it does not.
     */
    let chunkNote: string | null = null;
    if (mode === "commit" && params.run) {
      try {
        const outcome = await recordChunk({
          tenantId: ctx.tenant.id,
          runId: params.run.id,
          chunkIndex: params.run.chunkIndex,
          rowCount: report.totalRows,
          outcome: {
            rowsWritten: report.counts.create + report.counts.update,
            rowsSkipped: report.counts.skip,
            rowsFailed: report.counts.error,
          },
        });
        chunkNote = outcome.note ?? null;
      } catch (chunkFailure) {
        console.error("[import:recordChunk]", chunkFailure);
        chunkNote =
          "This part was imported and Ordence could not update the migration's running total. " +
          "The total is recalculated from the parts on the next one, so this corrects itself — " +
          "and if it does not, the migration will refuse to report itself as finished.";
      }
    }

    return { ok: true, data: chunkNote ? { ...report, chunkNote } : report };
  } catch (err) {
    return toImportActionError(err, mode);
  }
}


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

  /**
   * ⭐ THE ATOMIC PATH IS CHOSEN BY THE WRITER'S SHAPE, NOT BY NAMING A
   * DESTINATION.
   *
   * This used to read `if (entity.table === "transactions")`, which meant
   * a second destination written as one document , a general journal
   * import, say , would silently take the per-row path and write a
   * fraction of a journal entry. Now a writer that declares `writeFile`
   * IS the whole-file case, and the registry refuses a writer declaring
   * both `writeFile` and `writeRow`.
   */
  const writer = IMPORT_WRITERS[entity.table];
  if (writer.writeFile) {
    const written = await writer.writeFile(ctx, planned);
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




/**
 * Write one planned row.
 *
 * ⚠️ SEE `findExistingByNaturalKey` ABOVE for why the branches are gone
 * and what the unguarded final one used to do.
 *
 * 🔴 A DESTINATION WITHOUT `writeRow` IS AN ATOMIC ONE, and reaching here
 *    with it means the caller took the per-row path for a file that is a
 *    single document. That is a programming error rather than a customer
 *    error, so it says so instead of writing a fraction of a journal
 *    entry.
 */
async function writeRow(
  ctx: TenantContext,
  entity: ImportEntityDefinition,
  payload: Record<string, unknown>,
  existingId: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const writer = IMPORT_WRITERS[entity.table];
  if (!writer.writeRow) {
    return {
      ok: false,
      error:
        `"${entity.table}" is written as one document for the whole file, ` +
        `so it cannot be written a row at a time.`,
    };
  }
  return writer.writeRow(ctx, payload, existingId);
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

/* ================================================================== */
/* ⭐⭐⭐ WAVE 6 — THE MIGRATION ENGINE                                */
/* ================================================================== */
/*                                                                     */
/* Everything above imports ONE FILE of at most `MAX_IMPORT_ROWS` rows */
/* and is unchanged. Everything below turns that into a MIGRATION:     */
/* many chunks, one run, a mapping somebody decided, and a finish that */
/* refuses to call itself complete when rows are missing.              */
/*                                                                     */
/* ⚠️ THE FILE NEVER LEAVES THE CUSTOMER'S MACHINE. It is read there   */
/* by `lib/import/sources/`, planned there by `planImportRecords`, and */
/* submitted in chunks. Storing it server-side would be a second copy  */
/* of a workspace's entire master data in a table nobody thinks of as  */
/* sensitive — the same argument `data_exports` makes in 0116.         */
/* ================================================================== */

/**
 * ⭐⭐ WHAT ORDENCE THINKS THE CUSTOMER'S COLUMNS MEAN, AND HOW SURE.
 *
 * ⚠️ NOTHING IS WRITTEN BY THIS ACTION. It reads headers and a sample of
 * values, proposes, and returns. The proposal is recorded — because a
 * proposal nobody recorded is indistinguishable afterwards from a
 * person's decision — and nothing else happens.
 *
 * 🔴 THE SAMPLE VALUES NEVER LEAVE THIS PROCESS WHEN THE MODEL IS USED.
 * `server/import/ai-mapper.ts` sends headings and statistical
 * descriptions only, and `assertPromptIsHeadersOnly` fails the call if a
 * future edit ever puts a value in the prompt.
 */
export async function proposeImportMapping(
  input: unknown,
): Promise<ActionResult<ProposeMappingResult>> {
  try {
    const params = z
      .object({
        entity: z.string().min(1),
        headers: z.array(z.string()).min(1).max(512),
        /** ⚠️ CAPPED. Two hundred rows support every conclusion the
         * detectors draw, and more is bandwidth for nothing. */
        sampleRows: z.array(z.array(z.string())).max(EVIDENCE_SAMPLE_ROWS).default([]),
        useAi: z.boolean().default(false),
      })
      .parse(input);

    if (!isImportEntityKey(params.entity)) {
      return fail("That is not something this can import.");
    }
    const entity: ImportEntityDefinition = ALL_IMPORT_ENTITIES[params.entity];

    /**
     * ⚠️ THE SAME PERMISSION AS THE IMPORT ITSELF. Proposing a mapping
     * reveals the shape of the entity being imported into, and a person
     * who may not import into it has no business asking.
     */
    const ctx = await requirePermission(entity.createPermission);

    let modelOutcome: AiMappingOutcome = { proposal: {}, used: false };
    if (params.useAi) {
      modelOutcome = await proposeMappingWithAi({
        tenantId: ctx.tenant.id,
        entity,
        sourceHeaders: params.headers,
        sampleRows: params.sampleRows,
      });
    }

    const proposal = proposeMapping(entity, params.headers, {
      sampleRows: params.sampleRows,
      ...(modelOutcome.used ? { model: modelOutcome.proposal } : {}),
    });

    const policy = parseAutoCommitPolicy(ctx.tenant.importAutoCommitPolicy);
    const verdict = mayAutoCommit(proposal, entity, policy);

    await recordProposal({
      tenantId: ctx.tenant.id,
      proposedFor: ctx.user.id,
      proposal,
      outcome: "proposed",
      ...(modelOutcome.used && modelOutcome.credentialSource
        ? { modelSource: modelOutcome.credentialSource }
        : {}),
    });

    return {
      ok: true,
      data: {
        proposal,
        autoCommit: verdict,
        policy,
        ...(modelOutcome.refusal ? { aiRefusal: modelOutcome.refusal } : {}),
      },
    };
  } catch (err) {
    return toImportActionError(err, "propose");
  }
}

export type ProposeMappingResult = {
  readonly proposal: MappingProposal;
  readonly autoCommit: AutoCommitVerdict;
  readonly policy: AutoCommitPolicy;
  /** Present when the model could not be reached. Never fatal. */
  readonly aiRefusal?: string;
};

/**
 * ⭐ RECORD WHAT THE PERSON DID WITH THE PROPOSAL.
 *
 * 🔴 `corrected` IS THE INTERESTING OUTCOME AND IT IS THE ONE WITH THE
 * MOST DETAIL. Every correction is a case the matcher got wrong, recorded
 * by the only process that can tell: somebody who knew the answer.
 */
export async function recordMappingDecision(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const params = z
      .object({
        entity: z.string().min(1),
        proposal: z.custom<MappingProposal>((v) => typeof v === "object" && v !== null),
        outcome: z.enum(["confirmed", "corrected", "discarded", "auto"]),
        runId: z.string().uuid().optional(),
        corrections: z
          .record(
            z.object({ from: z.string().nullable(), to: z.string().nullable() }),
          )
          .default({}),
      })
      .parse(input);

    if (!isImportEntityKey(params.entity)) {
      return fail("That is not something this can import.");
    }
    const entity: ImportEntityDefinition = ALL_IMPORT_ENTITIES[params.entity];
    const ctx = await requirePermission(entity.createPermission);

    const id = await recordProposal({
      tenantId: ctx.tenant.id,
      proposedFor: ctx.user.id,
      proposal: params.proposal,
      outcome: params.outcome,
      ...(params.runId ? { runId: params.runId } : {}),
      corrections: params.corrections,
    });

    return { ok: true, data: { id } };
  } catch (err) {
    return toImportActionError(err, "mapping decision");
  }
}

/**
 * ⭐⭐⭐ BEGIN A MIGRATION.
 *
 * ⚠️ `expectedRows` IS DECLARED HERE, BEFORE THE FIRST CHUNK, AND IT IS
 * WHAT MAKES "IT FINISHED" A CLAIM RATHER THAN A HOPE. Without it a run
 * that lost its last chunk to a closed laptop is indistinguishable from
 * one that completed.
 */
export async function beginImportRun(
  input: unknown,
): Promise<ActionResult<{ runId: string; chunkSize: number; resumed: boolean; note: string | null }>> {
  try {
    const params = z
      .object({
        entity: z.string().min(1),
        sourceFormat: z.enum(IMPORT_SOURCE_FORMATS),
        sourceName: z.string().max(255).optional(),
        sourceSheet: z.string().max(120).optional(),
        duplicateMode: z.enum(["skip", "update", "fail"]),
        expectedRows: z.number().int().positive(),
        /**
         * ⭐⭐⭐ PHASE 2 · RUN-LEVEL IDEMPOTENCY. `sha256:<64 lower-case hex>`
         * over the BYTES of the file, computed in the browser with WebCrypto
         * — the server never receives them.
         *
         * 🔴 REQUIRED. Without it two browser tabs start two runs over one
         * file, and in `update` mode the second captures the FIRST run's
         * values as the prior: undoing run 2 restores the migration, undoing
         * run 1 afterwards destroys what run 2 put back. There is no order in
         * which the customer can be told what will happen.
         *
         * ⚠️ VALIDATED IN THREE PLACES ON PURPOSE — here (names the caller),
         * in `startImportRun` (names the mechanism) and by
         * `import_runs_fingerprint_shape` (makes it unavoidable). A
         * fingerprint that is the file NAME creates a claim that never
         * collides, which is idempotency that is present and inert.
         */
        sourceFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/, {
          message:
            "The file could not be fingerprinted in your browser. Nothing has been started — " +
            "without it, starting the same file twice would create two migrations that cannot " +
            "both be undone.",
        }),
      })
      .parse(input);

    if (!isImportEntityKey(params.entity)) {
      return fail("That is not something this can import.");
    }
    const entity: ImportEntityDefinition = ALL_IMPORT_ENTITIES[params.entity];

    /** ⚠️ The same four gates the one-shot import passes. */
    const ctx = await guardImport(entity, params.duplicateMode);

    const run = await startImportRun({
      tenantId: ctx.tenant.id,
      startedBy: ctx.user.id,
      entityKey: entity.key,
      sourceFormat: params.sourceFormat,
      sourceName: params.sourceName ?? null,
      sourceSheet: params.sourceSheet ?? null,
      duplicateMode: params.duplicateMode,
      expectedRows: params.expectedRows,
      sourceFingerprint: params.sourceFingerprint,
    });

    /**
     * ⚠️ `resumed` AND `note` REACH THE WIZARD, they are not swallowed here.
     * "Starting" and "picking up where the last attempt stopped, the rows
     * already here will be recognised rather than duplicated" are different
     * sentences, and a customer shown the first when the second is true will
     * wonder why the progress bar starts at 60%.
     */
    return {
      ok: true,
      data: {
        runId: run.runId,
        chunkSize: MAX_IMPORT_ROWS,
        resumed: run.resumed,
        note: run.note,
      },
    };
  } catch (err) {
    return toImportActionError(err, "begin run");
  }
}

/**
 * ⭐⭐ CLOSE A MIGRATION — AND THE DATABASE DECIDES WHETHER IT FINISHED.
 *
 * 🔴 `import_runs_completed_is_complete` refuses `completed` unless every
 * expected row is accounted for, so this cannot report a finish that did
 * not happen even if a future caller asks it to.
 */
export async function endImportRun(
  input: unknown,
): Promise<ActionResult<FinishResult>> {
  try {
    const params = z
      .object({
        runId: z.string().uuid(),
        abandoned: z.boolean().default(false),
      })
      .parse(input);

    /**
     * 🔴 A PERMISSION, NOT AN IDENTITY CHECK — AND `check:guards` REFUSED
     * THE FIRST DRAFT OF THIS FUNCTION FOR EXACTLY THAT.
     *
     * The first version used `requireTenantContext()` alone, reasoning
     * that RLS already stops one workspace closing another's run. True,
     * and beside the point: it left ANY MEMBER of the workspace able to
     * close a migration somebody else was running, which marks it
     * incomplete and tells the person who started it that rows are
     * missing. "Who are you" is not "may you do this".
     *
     * ⚠️ THE PERMISSION IS THE RUN'S OWN ENTITY'S, resolved from the run
     * rather than taken from the caller. Letting the caller name the
     * entity would let them name one they happen to have rights to and
     * close a run of one they do not.
     */
    const ctx = await requireTenantContext();
    const runs = await listImportRuns(ctx.tenant.id, 200);
    const run = runs.find((r) => r.id === params.runId);
    if (!run) {
      return fail("That migration is not one this workspace started.");
    }
    if (!isImportEntityKey(run.entityKey)) {
      return fail("That migration refers to something this can no longer import.");
    }
    await requirePermission(ALL_IMPORT_ENTITIES[run.entityKey].createPermission);

    const result = await finishImportRun({
      tenantId: ctx.tenant.id,
      runId: params.runId,
      abandoned: params.abandoned,
    });
    revalidatePath("/settings/import");
    return { ok: true, data: result };
  } catch (err) {
    return toImportActionError(err, "end run");
  }
}

/**
 * ⭐ THE RUNS — AND THE UNFINISHED ONES ARE THE POINT. "Which of my
 * uploads did not finish" is the only question this list is really for.
 */
export async function getImportRuns(): Promise<ActionResult<ImportRunView[]>> {
  try {
    const ctx = await requireTenantContext();
    const runs = await listImportRuns(ctx.tenant.id);
    return { ok: true, data: runs };
  } catch (err) {
    return toImportActionError(err, "runs");
  }
}
