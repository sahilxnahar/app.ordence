"use server";

/**
 * Ordence — ⭐ Tally Actions
 * Version: v0.37.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION. Schemas live in
 * `lib/validators/tally.ts`, rules in `lib/tally/`. A `"use server"` file
 * that exports anything else publishes it as an RPC endpoint reachable by
 * anyone on the internet.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS RESPONSIBLE FOR, AND WHAT IT IS NOT
 * ══════════════════════════════════════════════════════════════════════
 * It asks the right questions before writing and turns a refusal into a
 * sentence somebody can act on.
 *
 * It does NOT make the guarantees. Those are constraints and triggers in
 * `SQL-FILES/0026_phase37_tally.sql`, because this file is one of several
 * write paths — a re-generation after a code change, a back-fill of a
 * year of historical vouchers and a support fix at a psql prompt are the
 * others — and a rule enforced in one place is a rule the others will
 * bypass. The back-fill is where the volume is, and the back-fill is
 * exactly where a `randomUUID()` gets written into `remote_id` because it
 * looked like an id column.
 *
 * ⭐ AND IT NEVER TAKES A VOUCHER KEY FROM THE CALLER. `generateExport`
 * derives every key in `lib/tally/keys.ts` from the tenant, the voucher
 * type and the source row. A form that posted one would let a person
 * change it, and a changed key is a second voucher in somebody's
 * statutory books that nothing anywhere reports.
 *
 * ⚠️ MONEY CROSSES THE BOUNDARY AS A STRING. `JSON.stringify` throws on a
 * bigint, so every amount returned here goes through `serializeAmount`.
 */

import { and, asc, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenant } from "@/db";
import {
  tallyConnections,
  tallyLedgerMappings,
  tallyCostCentreMappings,
  tallyExportBatches,
  tallyReconciliationItems,
  type TallyVoucherType,
} from "@/db/schema/tally";
/** ⭐ Wave 10 — the three tables a mapping's `sourceId` can point at. */
import { ledgers } from "@/db/schema/accounting";
import { vendors } from "@/db/schema/purchases";
import { companies } from "@/db/schema/crm";
import { requirePermission, writeAudit } from "@/server/audit";
import { guardTallyWrite, tallyFail, toTallyActionError } from "@/server/tally/guards";
import {
  upsertTallyConnectionSchema,
  upsertTallyLedgerMappingSchema,
  upsertTallyCostCentreMappingSchema,
  deleteTallyMappingSchema,
  generateTallyExportSchema,
  markTallyExportDeliveredSchema,
  pushTallyExportSchema,
  importTallyExportSchema,
  resolveReconciliationItemSchema,
  tallyBatchQuerySchema,
} from "@/lib/validators/tally";
import {
  findConnection,
  findExportBatch,
  listConnections,
  listCostCentreMappings,
  listExportBatches,
  listImportBatches,
  listLedgerMappings,
  listReconciliationItems,
  toLedgerMapping,
} from "@/server/tally/registry";
import { buildExport, persistExport } from "@/server/tally/exporter";
import { markDelivered, pushToTally } from "@/server/tally/push";
import { importAndReconcile, recountUnresolved } from "@/server/tally/importer";
import {
  assessMapping,
  findDuplicateNames,
  TALLY_PRIMARY_GROUPS,
  TALLY_TAX_HEADS,
} from "@/lib/tally/ledgers";
import { checkTallyEndpoint } from "@/lib/tally/endpoint";
import { serializeAmount } from "@/lib/billing/money";
import type { ActionResult } from "@/lib/validators/crm";

/* ------------------------------------------------------------------ */
/* SERIALISABLE SHAPES                                                 */
/* ------------------------------------------------------------------ */

export type TallyConnectionRow = {
  id: string;
  name: string;
  companyName: string;
  host: string | null;
  port: number;
  useTls: boolean;
  allowPrivateHost: boolean;
  isActive: boolean;
  lastPushAt: string | null;
  lastPushStatus: string | null;
  lastPushDetail: string | null;
  /** ⭐ What the endpoint policy would say right now, without sending. */
  endpointVerdict: string;
};

export type TallyMappingRow = {
  id: string;
  sourceKind: string;
  sourceId: string | null;
  sourceKey: string | null;
  tallyLedgerName: string;
  tallyParentGroup: string;
  tallyParentGroupLabel: string;
  isParty: boolean;
  partyGstin: string | null;
  createMasterOnExport: boolean;
  isActive: boolean;
  findings: Array<{ severity: string; code: string; message: string }>;
};

export type TallyBatchRow = {
  id: string;
  batchNumber: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  deliveryMode: string;
  companyName: string;
  voucherCount: number;
  totalDebitMinor: string;
  payloadHash: string | null;
  payloadBytes: number | null;
  generatedAt: string | null;
  deliveredAt: string | null;
};

/* ------------------------------------------------------------------ */
/* CONNECTIONS                                                         */
/* ------------------------------------------------------------------ */

export async function getTallyConnections(
  includeInactive?: boolean,
): Promise<ActionResult<{ rows: TallyConnectionRow[] }>> {
  try {
    // ⚠️ READ: permission only. An entitlement gate here would refuse to
    // RENDER the page rather than refusing the button on it.
    const ctx = await requirePermission("tally:read");
    const rows = await listConnections(ctx.tenant.id, {
      includeInactive: includeInactive === true,
    });

    return {
      ok: true,
      data: {
        rows: rows.map((row) => ({
          id: row.id,
          name: row.name,
          companyName: row.companyName,
          host: row.host,
          port: row.port,
          useTls: row.useTls,
          allowPrivateHost: row.allowPrivateHost,
          isActive: row.isActive,
          lastPushAt: row.lastPushAt?.toISOString() ?? null,
          lastPushStatus: row.lastPushStatus,
          lastPushDetail: row.lastPushDetail,
          /**
           * ⭐ SHOWN BEFORE ANYTHING IS SENT. "Why did nothing arrive in
           * Tally?" has two very different answers — Tally was not running,
           * or our own policy refused the address — and without this the
           * second is invisible until somebody reads a log.
           */
          endpointVerdict: row.host
            ? describeVerdict(row)
            : "File export only — no host configured.",
        })),
      },
    };
  } catch (err) {
    return toTallyActionError(err, "getTallyConnections");
  }
}

function describeVerdict(row: {
  host: string | null;
  port: number;
  useTls: boolean;
  allowPrivateHost: boolean;
}): string {
  const verdict = checkTallyEndpoint({
    host: row.host ?? "",
    port: row.port,
    useTls: row.useTls,
    allowPrivateHost: row.allowPrivateHost,
  });
  if (verdict.allowed) {
    return verdict.reachesPrivateNetwork
      ? "Allowed — private address, permitted deliberately for this connection."
      : "Allowed.";
  }
  return `Refused — ${verdict.reason} ${verdict.remedy}`;
}

export async function upsertTallyConnection(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    /**
     * ⚠️ `integrations:manage`, NOT `tally:manage_mappings`.
     *
     * A connection carries `allow_private_host`, which decides whether
     * this server may open a connection into the customer's office
     * network. That is an infrastructure decision, not an accounting one,
     * and the accountant deliberately does not hold it — see the role
     * template in `db/schema/auth.ts`.
     */
    const ctx = await guardTallyWrite({
      operation: "tally:connection",
      feature: "accounting.tally",
      permission: "integrations:manage",
    });

    const data = upsertTallyConnectionSchema.parse(input);

    const id = await withTenant(ctx.tenant.id, async (tx) => {
      const values = {
        tenantId: ctx.tenant.id,
        name: data.name,
        companyName: data.companyName,
        host: data.host ?? null,
        port: data.port,
        useTls: data.useTls,
        allowPrivateHost: data.allowPrivateHost,
        isActive: data.isActive,
        notes: data.notes ?? null,
      };

      if (data.id) {
        const [row] = await tx
          .update(tallyConnections)
          .set(values)
          .where(
            and(
              eq(tallyConnections.tenantId, ctx.tenant.id),
              eq(tallyConnections.id, data.id),
            ),
          )
          .returning({ id: tallyConnections.id });
        return row?.id ?? null;
      }

      const [row] = await tx
        .insert(tallyConnections)
        .values({ ...values, createdBy: ctx.user.id })
        .returning({ id: tallyConnections.id });
      return row?.id ?? null;
    });

    if (!id) return tallyFail("That connection no longer exists.");

    await writeAudit(ctx, {
      action: data.id ? "update" : "create",
      resourceType: "tally_connection",
      resourceId: id,
      /**
       * ⭐ `allowPrivateHost` AND THE HOST ARE BOTH LOGGED, DELIBERATELY.
       * Together they are the record of who opened a path from our
       * servers into a private network and where it points. An audit log
       * that omits it cannot answer the only question a security review
       * will ask about this feature.
       */
      newValue: {
        name: data.name,
        companyName: data.companyName,
        host: data.host ?? null,
        port: data.port,
        allowPrivateHost: data.allowPrivateHost,
      },
    });

    revalidatePath("/settings/tally");
    return { ok: true, data: { id } };
  } catch (err) {
    return toTallyActionError(err, "upsertTallyConnection");
  }
}

/* ------------------------------------------------------------------ */
/* ⭐ MAPPINGS                                                          */
/* ------------------------------------------------------------------ */

export async function getTallyLedgerMappings(
  includeInactive?: boolean,
): Promise<ActionResult<{ rows: TallyMappingRow[]; duplicateNames: string[] }>> {
  try {
    const ctx = await requirePermission("tally:read");
    const rows = await listLedgerMappings(ctx.tenant.id, {
      includeInactive: includeInactive === true,
    });

    const mappings = rows.map(toLedgerMapping);

    return {
      ok: true,
      data: {
        rows: rows.map((row, i) => ({
          id: row.id,
          sourceKind: row.sourceKind,
          sourceId: row.sourceId,
          sourceKey: row.sourceKey,
          tallyLedgerName: row.tallyLedgerName,
          tallyParentGroup: row.tallyParentGroup,
          tallyParentGroupLabel: TALLY_PRIMARY_GROUPS[row.tallyParentGroup],
          isParty: row.isParty,
          partyGstin: row.partyGstin,
          createMasterOnExport: row.createMasterOnExport,
          isActive: row.isActive,
          // ⭐ The silent failure modes of a syntactically perfect mapping.
          findings: assessMapping(mappings[i]!),
        })),
        /**
         * ⚠️ SHOULD ALWAYS BE EMPTY — SQL 0026 §2 refuses it. A non-empty
         * list here means the data was written by something other than
         * this application, and it is worth surfacing rather than
         * silently collapsing.
         */
        duplicateNames: findDuplicateNames(mappings).map((d) => d.names.join(" / ")),
      },
    };
  } catch (err) {
    return toTallyActionError(err, "getTallyLedgerMappings");
  }
}

export async function upsertTallyLedgerMapping(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardTallyWrite({
      operation: "tally:manage_mappings",
      feature: "accounting.tally",
      permission: "tally:manage_mappings",
    });

    const data = upsertTallyLedgerMappingSchema.parse(input);

    const id = await withTenant(ctx.tenant.id, async (tx) => {
      const values = {
        tenantId: ctx.tenant.id,
        sourceKind: data.sourceKind,
        sourceId: data.sourceId ?? null,
        sourceKey: data.sourceKey ?? null,
        tallyLedgerName: data.tallyLedgerName,
        tallyParentGroup: data.tallyParentGroup,
        isParty: data.isParty,
        partyGstin: data.partyGstin ?? null,
        partyStateCode: data.partyStateCode ?? null,
        createMasterOnExport: data.createMasterOnExport,
        isActive: data.isActive,
        notes: data.notes ?? null,
      };

      if (data.id) {
        const [row] = await tx
          .update(tallyLedgerMappings)
          .set(values)
          .where(
            and(
              eq(tallyLedgerMappings.tenantId, ctx.tenant.id),
              eq(tallyLedgerMappings.id, data.id),
            ),
          )
          .returning({ id: tallyLedgerMappings.id });
        return row?.id ?? null;
      }

      const [row] = await tx
        .insert(tallyLedgerMappings)
        .values({ ...values, createdBy: ctx.user.id })
        .returning({ id: tallyLedgerMappings.id });
      return row?.id ?? null;
    });

    if (!id) return tallyFail("That mapping no longer exists.");

    await writeAudit(ctx, {
      action: data.id ? "update" : "create",
      resourceType: "tally_ledger_mapping",
      resourceId: id,
      newValue: {
        sourceKind: data.sourceKind,
        tallyLedgerName: data.tallyLedgerName,
        tallyParentGroup: data.tallyParentGroup,
      },
    });

    revalidatePath("/settings/tally");
    return { ok: true, data: { id } };
  } catch (err) {
    return toTallyActionError(err, "upsertTallyLedgerMapping");
  }
}

export async function upsertTallyCostCentreMapping(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardTallyWrite({
      operation: "tally:manage_mappings",
      feature: "accounting.tally",
      permission: "tally:manage_mappings",
    });

    const data = upsertTallyCostCentreMappingSchema.parse(input);

    const id = await withTenant(ctx.tenant.id, async (tx) => {
      const values = {
        tenantId: ctx.tenant.id,
        projectId: data.projectId,
        tallyCostCentreName: data.tallyCostCentreName,
        tallyCostCategory: data.tallyCostCategory,
        isActive: data.isActive,
        notes: data.notes ?? null,
      };

      if (data.id) {
        const [row] = await tx
          .update(tallyCostCentreMappings)
          .set(values)
          .where(
            and(
              eq(tallyCostCentreMappings.tenantId, ctx.tenant.id),
              eq(tallyCostCentreMappings.id, data.id),
            ),
          )
          .returning({ id: tallyCostCentreMappings.id });
        return row?.id ?? null;
      }

      const [row] = await tx
        .insert(tallyCostCentreMappings)
        .values({ ...values, createdBy: ctx.user.id })
        .returning({ id: tallyCostCentreMappings.id });
      return row?.id ?? null;
    });

    if (!id) return tallyFail("That cost centre mapping no longer exists.");

    await writeAudit(ctx, {
      action: data.id ? "update" : "create",
      resourceType: "tally_cost_centre_mapping",
      resourceId: id,
      newValue: {
        projectId: data.projectId,
        tallyCostCentreName: data.tallyCostCentreName,
      },
    });

    revalidatePath("/settings/tally");
    return { ok: true, data: { id } };
  } catch (err) {
    return toTallyActionError(err, "upsertTallyCostCentreMapping");
  }
}

export async function getTallyCostCentreMappings(): Promise<
  ActionResult<{
    rows: Array<{
      id: string;
      projectId: string;
      tallyCostCentreName: string;
      tallyCostCategory: string;
      isActive: boolean;
    }>;
  }>
> {
  try {
    const ctx = await requirePermission("tally:read");
    const rows = await listCostCentreMappings(ctx.tenant.id, {
      includeInactive: true,
    });
    return {
      ok: true,
      data: {
        rows: rows.map((row) => ({
          id: row.id,
          projectId: row.projectId,
          tallyCostCentreName: row.tallyCostCentreName,
          tallyCostCategory: row.tallyCostCategory,
          isActive: row.isActive,
        })),
      },
    };
  } catch (err) {
    return toTallyActionError(err, "getTallyCostCentreMappings");
  }
}

/**
 * ⚠️ RETIRE, NOT DELETE — and the difference matters here more than it
 * usually does. A mapping cannot retrospectively change a voucher (the
 * voucher stores the ledger names it was rendered with), but the mapping
 * IS the explanation of why April went where it went. Setting
 * `is_active` false frees the Tally ledger name for a replacement and
 * keeps the answer.
 */
export async function retireTallyLedgerMapping(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardTallyWrite({
      operation: "tally:manage_mappings",
      feature: "accounting.tally",
      permission: "tally:manage_mappings",
    });

    const data = deleteTallyMappingSchema.parse(input);

    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .update(tallyLedgerMappings)
        .set({ isActive: false })
        .where(
          and(
            eq(tallyLedgerMappings.tenantId, ctx.tenant.id),
            eq(tallyLedgerMappings.id, data.id),
          ),
        )
        .returning({ id: tallyLedgerMappings.id }),
    );

    if (rows.length === 0) return tallyFail("That mapping no longer exists.");

    await writeAudit(ctx, {
      action: "update",
      resourceType: "tally_ledger_mapping",
      resourceId: data.id,
      newValue: { isActive: false },
    });

    revalidatePath("/settings/tally");
    return { ok: true, data: { id: data.id } };
  } catch (err) {
    return toTallyActionError(err, "retireTallyLedgerMapping");
  }
}

/** The closed set of tax heads a mapping may name. For the form's dropdown. */
export async function getTallyTaxHeads(): Promise<
  ActionResult<{ heads: string[]; groups: Record<string, string> }>
> {
  try {
    await requirePermission("tally:read");
    return {
      ok: true,
      data: {
        heads: [...TALLY_TAX_HEADS],
        groups: { ...TALLY_PRIMARY_GROUPS },
      },
    };
  } catch (err) {
    return toTallyActionError(err, "getTallyTaxHeads");
  }
}

/* ------------------------------------------------------------------ */
/* ⭐⭐ EXPORT                                                          */
/* ------------------------------------------------------------------ */

export async function getTallyExportBatches(
  input?: unknown,
): Promise<ActionResult<{ rows: TallyBatchRow[] }>> {
  try {
    const ctx = await requirePermission("tally:read");
    const query = tallyBatchQuerySchema.parse(input ?? {});
    const rows = await listExportBatches(ctx.tenant.id, { limit: query.limit });

    return {
      ok: true,
      data: {
        rows: rows
          .filter((row) => !query.status || row.status === query.status)
          .map(toBatchRow),
      },
    };
  } catch (err) {
    return toTallyActionError(err, "getTallyExportBatches");
  }
}

function toBatchRow(row: {
  id: string;
  batchNumber: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  deliveryMode: string;
  companyName: string;
  voucherCount: number;
  totalDebitMinor: bigint;
  payloadHash: string | null;
  payloadBytes: number | null;
  generatedAt: Date | null;
  deliveredAt: Date | null;
}): TallyBatchRow {
  return {
    id: row.id,
    batchNumber: row.batchNumber,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    status: row.status,
    deliveryMode: row.deliveryMode,
    companyName: row.companyName,
    voucherCount: row.voucherCount,
    totalDebitMinor: serializeAmount(row.totalDebitMinor),
    payloadHash: row.payloadHash,
    payloadBytes: row.payloadBytes,
    generatedAt: row.generatedAt?.toISOString() ?? null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
  };
}

/**
 * ⭐⭐ GENERATE THE FILE.
 *
 * ⚠️ THE XML IS RETURNED, NOT STORED. A month of vouchers is megabytes,
 * and storing it would put a customer's entire ledger — party names,
 * amounts, GSTINs — into a second table for no purpose the HASH does not
 * already serve. The hash answers "is this the file we sent?"; the
 * vouchers answer "what was in it"; the bytes themselves are
 * reproducible from both.
 */
export async function generateTallyExport(input: unknown): Promise<
  ActionResult<{
    batchId: string;
    batchNumber: string;
    voucherCount: number;
    action: "Create" | "Alter";
    amendedCount: number;
    hash: string;
    bytes: number;
    xml: string;
    warning: string | null;
  }>
> {
  try {
    const ctx = await guardTallyWrite({
      operation: "tally:export",
      feature: "accounting.tally",
      permission: "tally:export",
      impersonationOperation: "tally:export",
    });

    const data = generateTallyExportSchema.parse(input);

    const built = await buildExport({
      tenantId: ctx.tenant.id,
      companyName: data.companyName,
      periodStart: data.periodStart,
      periodEnd: data.periodEnd,
      voucherTypes: data.voucherTypes as TallyVoucherType[],
      includeMasters: data.includeMasters,
    });

    if (built.drafts.length === 0) {
      return tallyFail(
        "There are no posted transactions in that period, so there is nothing " +
          "to export. Nothing has been recorded — an empty batch would show up " +
          'later as "April was exported" and it would not have been.',
      );
    }

    const batchId = await persistExport({
      tenantId: ctx.tenant.id,
      userId: ctx.user.id,
      connectionId: data.connectionId ?? null,
      built,
      notes: data.notes ?? null,
    });

    await writeAudit(ctx, {
      action: "create",
      resourceType: "tally_export_batch",
      resourceId: batchId,
      newValue: {
        batchNumber: built.batchNumber,
        periodStart: built.periodStart,
        periodEnd: built.periodEnd,
        voucherCount: built.drafts.length,
        // ⭐ The hash goes in the audit log too. It is what ties a later
        // "which file did I import?" to a moment and a person.
        payloadHash: built.hash,
        action: built.action,
      },
    });

    revalidatePath("/accounting/tally");

    return {
      ok: true,
      data: {
        batchId,
        batchNumber: built.batchNumber,
        voucherCount: built.drafts.length,
        action: built.action,
        amendedCount: built.amendedRemoteIds.length,
        hash: built.hash,
        bytes: built.bytes,
        xml: built.xml,
        /**
         * ⭐ THE SENTENCE THAT PREVENTS THE DOUBLE POST IN PRACTICE.
         *
         * The database guarantees the keys are stable. What it cannot do
         * is tell the accountant that re-importing is SAFE — and without
         * being told, the reasonable thing for them to do with a second
         * file covering a period they have already imported is to not
         * import it, which leaves the correction unapplied.
         */
        warning:
          built.action === "Alter"
            ? "Every voucher in this file has been sent before, so it is marked " +
              "as an amendment. ⭐ Importing it again is SAFE: Tally matches on " +
              "the key each voucher carries and will UPDATE the existing ones " +
              "rather than adding copies." +
              (built.amendedRemoteIds.length > 0
                ? ` ${built.amendedRemoteIds.length} voucher(s) have actually changed since they were last sent.`
                : " Nothing has actually changed since they were last sent.")
            : null,
      },
    };
  } catch (err) {
    return toTallyActionError(err, "generateTallyExport");
  }
}

/**
 * ⭐ MARK IT IMPORTED. The act that flips the next export of the same
 * source rows from CREATE to ALTER.
 *
 * ⚠️ A SEPARATE ACT FROM GENERATING, DELIBERATELY. A file that was
 * generated and never imported must not make the next export an ALTER of
 * vouchers Tally does not have — Tally reports those as "ignored",
 * cheerfully, and the period would silently never arrive at all.
 */
export async function markTallyExportDelivered(
  input: unknown,
): Promise<ActionResult<{ batchId: string }>> {
  try {
    const ctx = await guardTallyWrite({
      operation: "tally:export",
      feature: "accounting.tally",
      permission: "tally:export",
      impersonationOperation: "tally:export",
    });

    const data = markTallyExportDeliveredSchema.parse(input);

    const batch = await findExportBatch(ctx.tenant.id, data.batchId);
    if (!batch) return tallyFail("That export batch no longer exists.");
    if (batch.status === "delivered") {
      return tallyFail("That batch is already recorded as imported.");
    }
    if (batch.status !== "generated") {
      return tallyFail(
        `A batch in the "${batch.status}" state cannot be marked imported. Only ` +
          "a generated file can have been given to Tally.",
      );
    }

    const done = await markDelivered({
      tenantId: ctx.tenant.id,
      batchId: data.batchId,
      userId: ctx.user.id,
      deliveryMode: "file",
      responsePayload: data.responsePayload ?? null,
    });
    if (!done) return tallyFail("That export batch no longer exists.");

    /**
     * ⭐ SUPERSEDE THE EARLIER BATCHES FOR THE SAME PERIOD.
     *
     * ⚠️ THEY ARE NOT DELETED. "Which file did I import?" is the question
     * this whole table exists to answer, and the earlier attempts are
     * part of the answer — particularly when one of them WAS imported by
     * somebody else and this one is the second.
     */
    await withTenant(ctx.tenant.id, async (tx) => {
      await tx
        .update(tallyExportBatches)
        .set({ status: "superseded" })
        .where(
          and(
            eq(tallyExportBatches.tenantId, ctx.tenant.id),
            eq(tallyExportBatches.periodStart, batch.periodStart),
            eq(tallyExportBatches.periodEnd, batch.periodEnd),
            eq(tallyExportBatches.status, "generated"),
          ),
        );
    });

    await writeAudit(ctx, {
      action: "update",
      resourceType: "tally_export_batch",
      resourceId: data.batchId,
      newValue: { status: "delivered", payloadHash: batch.payloadHash },
    });

    revalidatePath("/accounting/tally");
    return { ok: true, data: { batchId: data.batchId } };
  } catch (err) {
    return toTallyActionError(err, "markTallyExportDelivered");
  }
}

/**
 * ⭐ THE DIRECT PUSH. See `server/tally/push.ts` and
 * `lib/tally/endpoint.ts` — this is the only capability in the product
 * that makes our servers open a connection to an address a customer
 * typed.
 */
export async function pushTallyExport(input: unknown): Promise<
  ActionResult<{
    batchId: string;
    created: number | null;
    altered: number | null;
    ignored: number | null;
  }>
> {
  try {
    const ctx = await guardTallyWrite({
      operation: "tally:push",
      feature: "accounting.tally",
      permission: "tally:push",
      impersonationOperation: "tally:push",
    });

    const data = pushTallyExportSchema.parse(input);

    const [batch, connection] = await Promise.all([
      findExportBatch(ctx.tenant.id, data.batchId),
      findConnection(ctx.tenant.id, data.connectionId),
    ]);

    if (!batch) return tallyFail("That export batch no longer exists.");
    if (!connection) return tallyFail("That Tally connection no longer exists.");
    if (batch.status === "delivered") {
      return tallyFail(
        "That batch has already been imported. Generate a fresh export for the " +
          "period instead — it will carry the same voucher keys, so Tally will " +
          "update rather than duplicate.",
      );
    }

    /**
     * ⚠️ THE XML IS REBUILT, NOT STORED AND REPLAYED.
     *
     * Rebuilding could in principle produce different bytes if the source
     * data changed since the batch was generated — so the hash is
     * compared, and a difference is a REFUSAL rather than a silent
     * substitution. The accountant asked to send THIS file.
     */
    const built = await buildExport({
      tenantId: ctx.tenant.id,
      companyName: batch.companyName,
      periodStart: batch.periodStart,
      periodEnd: batch.periodEnd,
      voucherTypes: (batch.voucherTypes as TallyVoucherType[]) ?? [],
      includeMasters: batch.masterCount > 0,
    });

    if (built.hash !== batch.payloadHash) {
      return tallyFail(
        "The data behind this export has changed since it was generated, so the " +
          "file would no longer be the one you reviewed. Generate a fresh export " +
          "and send that. ⭐ It will carry the same voucher keys, so Tally will " +
          "update the vouchers it has rather than adding copies.",
      );
    }

    const outcome = await pushToTally({
      tenantId: ctx.tenant.id,
      connectionId: data.connectionId,
      xml: built.xml,
    });

    if (!outcome.ok) {
      await withTenant(ctx.tenant.id, async (tx) => {
        await tx
          .update(tallyExportBatches)
          .set({ failureReason: outcome.reason, deliveryMode: "http_push" })
          .where(
            and(
              eq(tallyExportBatches.tenantId, ctx.tenant.id),
              eq(tallyExportBatches.id, data.batchId),
            ),
          );
      });
      return tallyFail(
        outcome.remedy ? `${outcome.reason} ${outcome.remedy}` : outcome.reason,
      );
    }

    await markDelivered({
      tenantId: ctx.tenant.id,
      batchId: data.batchId,
      userId: ctx.user.id,
      deliveryMode: "http_push",
      responsePayload: outcome.raw.slice(0, 100_000),
      response: outcome.response,
    });

    await writeAudit(ctx, {
      action: "update",
      resourceType: "tally_export_batch",
      resourceId: data.batchId,
      newValue: {
        status: "delivered",
        deliveryMode: "http_push",
        // ⭐ Logged: whether this push reached a private address. It is
        // the fact a security review will ask about.
        reachedPrivateNetwork: outcome.reachedPrivateNetwork,
        created: outcome.response.created,
        altered: outcome.response.altered,
      },
    });

    revalidatePath("/accounting/tally");
    return {
      ok: true,
      data: {
        batchId: data.batchId,
        created: outcome.response.created,
        altered: outcome.response.altered,
        ignored: outcome.response.ignored,
      },
    };
  } catch (err) {
    return toTallyActionError(err, "pushTallyExport");
  }
}

/* ------------------------------------------------------------------ */
/* ⭐ IMPORT AND RECONCILE                                              */
/* ------------------------------------------------------------------ */

export async function importTallyExport(input: unknown): Promise<
  ActionResult<{
    importBatchId: string;
    companyName: string | null;
    theirVoucherCount: number;
    matched: number;
    differences: number;
    actionable: number;
    warnings: number;
  }>
> {
  try {
    const ctx = await guardTallyWrite({
      operation: "tally:import",
      feature: "accounting.tally",
      permission: "tally:import",
    });

    const data = importTallyExportSchema.parse(input);

    const outcome = await importAndReconcile({
      tenantId: ctx.tenant.id,
      userId: ctx.user.id,
      connectionId: data.connectionId ?? null,
      sourceLabel: data.sourceLabel,
      periodStart: data.periodStart,
      periodEnd: data.periodEnd,
      payload: data.payload,
      notes: data.notes ?? null,
    });

    await writeAudit(ctx, {
      action: "create",
      resourceType: "tally_import_batch",
      resourceId: outcome.importBatchId,
      newValue: {
        sourceLabel: data.sourceLabel,
        companyName: outcome.companyName,
        theirVoucherCount: outcome.theirVoucherCount,
        differences: outcome.differences,
      },
    });

    revalidatePath("/accounting/tally");
    return { ok: true, data: outcome };
  } catch (err) {
    return toTallyActionError(err, "importTallyExport");
  }
}

export async function getTallyImportBatches(): Promise<
  ActionResult<{
    rows: Array<{
      id: string;
      sourceLabel: string;
      companyName: string | null;
      periodStart: string;
      periodEnd: string;
      status: string;
      voucherCount: number;
      differenceCount: number;
      unresolvedCount: number;
      warningCount: number;
    }>;
  }>
> {
  try {
    const ctx = await requirePermission("tally:read");
    const rows = await listImportBatches(ctx.tenant.id);
    return {
      ok: true,
      data: {
        rows: rows.map((row) => ({
          id: row.id,
          sourceLabel: row.sourceLabel,
          companyName: row.companyName,
          periodStart: row.periodStart,
          periodEnd: row.periodEnd,
          status: row.status,
          voucherCount: row.voucherCount,
          differenceCount: row.differenceCount,
          unresolvedCount: row.unresolvedCount,
          warningCount: row.parseWarnings.length,
        })),
      },
    };
  } catch (err) {
    return toTallyActionError(err, "getTallyImportBatches");
  }
}

export async function getTallyReconciliation(
  importBatchId: string,
): Promise<
  ActionResult<{
    rows: Array<{
      id: string;
      kind: string;
      status: string;
      remoteId: string | null;
      ourVoucherNumber: string | null;
      ourAmountMinor: string | null;
      theirVoucherNumber: string | null;
      theirAmountMinor: string | null;
      explanation: string;
    }>;
  }>
> {
  try {
    const ctx = await requirePermission("tally:read");
    const rows = await listReconciliationItems(ctx.tenant.id, importBatchId);
    return {
      ok: true,
      data: {
        rows: rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          status: row.status,
          remoteId: row.remoteId,
          ourVoucherNumber: row.ourVoucherNumber,
          ourAmountMinor:
            row.ourAmountMinor === null ? null : serializeAmount(row.ourAmountMinor),
          theirVoucherNumber: row.theirVoucherNumber,
          theirAmountMinor:
            row.theirAmountMinor === null
              ? null
              : serializeAmount(row.theirAmountMinor),
          explanation: row.explanation,
        })),
      },
    };
  } catch (err) {
    return toTallyActionError(err, "getTallyReconciliation");
  }
}

export async function resolveTallyReconciliationItem(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardTallyWrite({
      operation: "tally:import",
      feature: "accounting.tally",
      permission: "tally:import",
    });

    const data = resolveReconciliationItemSchema.parse(input);

    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .update(tallyReconciliationItems)
        .set({
          status: data.status,
          resolutionNote: data.resolutionNote ?? null,
          // ⚠️ The CHECK refuses `resolved` with no timestamp. Set here so
          // the constraint is never the thing that teaches somebody that.
          resolvedAt: data.status === "resolved" ? new Date() : null,
          resolvedBy: data.status === "resolved" ? ctx.user.id : null,
        })
        .where(
          and(
            eq(tallyReconciliationItems.tenantId, ctx.tenant.id),
            eq(tallyReconciliationItems.id, data.itemId),
          ),
        )
        .returning({
          id: tallyReconciliationItems.id,
          importBatchId: tallyReconciliationItems.importBatchId,
        }),
    );

    const row = rows[0];
    if (!row) return tallyFail("That finding no longer exists.");

    await recountUnresolved(ctx.tenant.id, row.importBatchId);

    await writeAudit(ctx, {
      action: "update",
      resourceType: "tally_reconciliation_item",
      resourceId: row.id,
      newValue: { status: data.status },
    });

    revalidatePath("/accounting/tally");
    return { ok: true, data: { id: row.id } };
  } catch (err) {
    return toTallyActionError(err, "resolveTallyReconciliationItem");
  }
}

/* ------------------------------------------------------------------ */
/* ⭐⭐ WAVE 10 — WHAT A MAPPING CAN POINT AT                          */
/* ------------------------------------------------------------------ */

export type TallyMappableSource = {
  readonly kind: "ledger" | "vendor" | "customer";
  readonly id: string;
  readonly label: string;
  /** A second line the picker shows: a code, a GSTIN, a trade name. */
  readonly hint: string | null;
};

/**
 * ⭐⭐⭐ THE LIST A MAPPING EDITOR NEEDS, UNDER THE TALLY PERMISSION.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS IS NOT THREE CALLS TO THREE EXISTING ACTIONS
 * ══════════════════════════════════════════════════════════════════════
 * A ledger mapping's `sourceId` points at `ledgers`, `vendors` or
 * `companies` depending on `sourceKind`. The obvious way to fill a picker
 * is to call the existing read action for each — and each of those asks
 * for a DIFFERENT permission: `ledgers:read`, a purchases key, a CRM key.
 *
 * That would mean the Tally screen only works for somebody who holds
 * accounting AND purchasing AND CRM read rights, which is not who
 * maintains a Tally mapping. It is the accounts person who reconciles
 * with the CA. `tally:read` is the permission that describes them, and
 * this is the module's own door onto exactly the three columns a mapping
 * needs and nothing else.
 *
 * ⚠️ NAME AND IDENTIFIER ONLY. No balances, no addresses, no contact
 * details, no PAN. Widening a read because it was convenient is how a
 * narrow permission quietly becomes a broad one, and the picker needs a
 * label and an id.
 *
 * ⚠️ NO `tax_head` HERE. A tax head has no row — it is a key from the
 * closed set `getTallyTaxHeads` returns. Mixing the two into one list
 * would invite a mapping carrying both an id and a key, which the
 * validator and the database both refuse for good reason.
 *
 * ⚠️ CAPPED AT 500 PER KIND. A picker is not a report. A workspace past
 * that has an import problem rather than a mapping problem, and the cap
 * is stated in the response so the screen can say so rather than
 * silently showing the first few hundred.
 */
export async function getTallyMappableSources(): Promise<
  ActionResult<{ rows: TallyMappableSource[]; truncated: boolean }>
> {
  try {
    const ctx = await requirePermission("tally:read");
    const LIMIT = 500;

    const [ledgerRows, vendorRows, customerRows] = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const l = await tx
          .select({ id: ledgers.id, name: ledgers.name, code: ledgers.code })
          .from(ledgers)
          .where(and(eq(ledgers.tenantId, ctx.tenant.id), isNull(ledgers.deletedAt)))
          .orderBy(asc(ledgers.code))
          .limit(LIMIT + 1);

        const v = await tx
          .select({
            id: vendors.id,
            legalName: vendors.legalName,
            tradeName: vendors.tradeName,
            code: vendors.code,
          })
          .from(vendors)
          .where(and(eq(vendors.tenantId, ctx.tenant.id), eq(vendors.isActive, true)))
          .orderBy(asc(vendors.legalName))
          .limit(LIMIT + 1);

        const c = await tx
          .select({ id: companies.id, name: companies.name })
          .from(companies)
          .where(and(eq(companies.tenantId, ctx.tenant.id), isNull(companies.deletedAt)))
          .orderBy(asc(companies.name))
          .limit(LIMIT + 1);

        return [l, v, c] as const;
      },
    );

    const truncated =
      ledgerRows.length > LIMIT || vendorRows.length > LIMIT || customerRows.length > LIMIT;

    const rows: TallyMappableSource[] = [
      ...ledgerRows.slice(0, LIMIT).map((r) => ({
        kind: "ledger" as const,
        id: r.id,
        label: r.name,
        hint: r.code,
      })),
      ...vendorRows.slice(0, LIMIT).map((r) => ({
        kind: "vendor" as const,
        id: r.id,
        label: r.legalName,
        /** The trade name is what the invoice says and the ledger is usually named after. */
        hint: r.tradeName ?? r.code,
      })),
      ...customerRows.slice(0, LIMIT).map((r) => ({
        kind: "customer" as const,
        id: r.id,
        label: r.name,
        hint: null,
      })),
    ];

    return { ok: true, data: { rows, truncated } };
  } catch (err) {
    return toTallyActionError(err, "getTallyMappableSources");
  }
}
