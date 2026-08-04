"use server";

/**
 * Ordence — ⭐ GSTR-2B Reconciliation Actions
 * Version: v0.34.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION. Schemas live in
 * `lib/validators/gstr2b.ts`, rules in `lib/gstr2b/`. A `"use server"`
 * file that exports anything else publishes it as an RPC endpoint
 * reachable by anyone on the internet.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE IMPORT IS **TWO** TRANSACTIONS, AND THAT IS THE MOST IMPORTANT
 *    DECISION IN THIS FILE
 * ══════════════════════════════════════════════════════════════════════
 * The natural implementation is one transaction: store the file, parse
 * it, write the rows, commit. It has a failure mode that defeats the
 * entire design of the phase.
 *
 *     If ANYTHING after the store throws — a parser defect on an
 *     unfamiliar shape, a constraint on one row of nine thousand, a
 *     connection dropped — the transaction rolls back and THE RAW FILE
 *     GOES WITH IT. The user sees an error, tries again, gets the same
 *     error, and gives up. Nothing is stored. The one artefact that
 *     would let somebody diagnose the parser a year later, at a notice,
 *     was held in memory for four milliseconds and discarded.
 *
 * So:
 *     TX 1 — store the raw document, `parse_status = 'pending'`. Nothing
 *            else. This is the transaction that must succeed.
 *     TX 2 — parse, write the rows, set `parsed` or `failed`.
 *
 * If TX 2 fails outright the document survives as `pending` and can be
 * re-parsed by a fixed parser against the ORIGINAL BYTES. That is the
 * whole point, and it is only reachable by giving up atomicity between
 * the two — which is the correct trade, because the second half is
 * derived and the first half is evidence.
 *
 * ⚠️ MONEY CROSSES THE BOUNDARY AS A STRING. `JSON.stringify` throws on a
 * bigint, so every amount returned here goes through `serializeAmount`.
 */

import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenant } from "@/db";
import {
  gstr2bDocuments,
  gstr2bMatches,
  gstr2bReconciliations,
  gstr2bRows,
} from "@/db/schema/gstr2b";
import { itcRegister } from "@/db/schema/purchases";
import { requirePermission, writeAudit } from "@/server/audit";
import {
  guardGstr2bWrite,
  gstr2bFail,
  toGstr2bActionError,
} from "@/server/gstr2b/guards";
import {
  bulkDecideMatchesSchema,
  chaseQuerySchema,
  decideMatchSchema,
  fileReconciliationSchema,
  importGstr2bSchema,
  runReconciliationSchema,
  worklistQuerySchema,
} from "@/lib/validators/gstr2b";
import {
  chaseVendors,
  parseGstr2bDelimited,
  parseGstr2bJson,
  reconcileGstr2b,
  summariseReconciliation,
  totalItcAtRisk,
  totalItcLost,
  DEFAULT_MATCH_TOLERANCE,
  MATCH_ENGINE_VERSION,
  type Gstr2bParseResult,
} from "@/lib/gstr2b";
import {
  findGstr2bDocument,
  findLatestParsedStatement,
  findMatch,
  findReconciliation,
  listGstr2bDocuments,
  listGstr2bRows,
  listMatches,
  listReconciliations,
  loadBookInvoicesForPeriod,
  toTwoBRowFacts,
} from "@/server/gstr2b/registry";
import { serializeAmount, toBigIntAmount } from "@/lib/billing/money";
import type { ActionResult } from "@/lib/validators/crm";

/* ------------------------------------------------------------------ */
/* SERIALISABLE SHAPES                                                 */
/* ------------------------------------------------------------------ */

export type Gstr2bDocumentRow = {
  id: string;
  gstin: string;
  returnPeriod: string;
  sourceFormat: string;
  fileName: string | null;
  fileHash: string;
  generatedOn: string | null;
  parseStatus: string;
  parseError: string | null;
  parseIssues: { path: string; message: string; severity: string }[];
  rowCount: number;
  createdAt: string;
};

export type Gstr2bMatchRow = {
  id: string;
  category: string;
  confidence: string;
  score: number;
  supplierGstin: string | null;
  gstr2bRowId: string | null;
  purchaseInvoiceId: string | null;
  matchedOn: unknown;
  differences: unknown;
  taxableDeltaMinor: string;
  taxDeltaMinor: string;
  itcAtRiskMinor: string;
  ambiguousCandidates: number;
  explanation: string;
  action: string;
  actionReason: string | null;
  actionBy: string | null;
};

/* ------------------------------------------------------------------ */
/* ⭐ IMPORT                                                           */
/* ------------------------------------------------------------------ */

/**
 * ⭐ Import a GSTR-2B statement.
 *
 * ⚠️ THE HASH IS OF THE BYTES AS RECEIVED, taken before anything is
 * parsed or normalised. Its only job is to let a later reader say "this
 * is the file the portal gave us", and a hash taken after our own
 * normalisation cannot say that.
 *
 * ⚠️ AND A FILED PERIOD IS REFUSED BY THE DATABASE, NOT HERE. The
 * trigger in SQL 0024 §6 raises a sentence that explains what to do
 * instead — import it against the period being filed now — and that
 * sentence is passed through by `toGstr2bActionError` rather than
 * replaced. Checking it here as well would put the rule in two places
 * and the explanation in one.
 */
export async function importGstr2b(
  input: unknown,
): Promise<
  ActionResult<{
    documentId: string;
    rowCount: number;
    parseStatus: string;
    issues: { path: string; message: string; severity: string }[];
  }>
> {
  try {
    const ctx = await guardGstr2bWrite({
      operation: "gstr2b:import",
      feature: "gst.gstr2b",
      permission: "gstr2b:import",
    });

    const data = importGstr2bSchema.parse(input);

    const fileHash = createHash("sha256").update(data.content, "utf8").digest("hex");

    /* --- TX 1 — THE EVIDENCE. Nothing else. -------------------- */
    //
    // ⚠️ The raw document is stored as `{ format, text }` for a delimited
    // file rather than as parsed columns, because a CSV that has been
    // through a column mapper is no longer the file the accountant sent.
    const rawDocument: unknown =
      data.sourceFormat === "portal_json"
        ? safeJson(data.content)
        : { format: data.sourceFormat, text: data.content };

    if (rawDocument === undefined) {
      return gstr2bFail(
        "That file is not valid JSON at all — it could not even be read as text " +
          "before parsing began. If it is the portal's Excel export, choose the " +
          "Excel/CSV format instead.",
      );
    }

    const documentId = await withTenant(ctx.tenant.id, async (tx) => {
      const [row] = await tx
        .insert(gstr2bDocuments)
        .values({
          tenantId: ctx.tenant.id,
          registrationId: data.registrationId ?? null,
          gstin: data.gstin,
          returnPeriod: data.returnPeriod,
          sourceFormat: data.sourceFormat,
          fileName: data.fileName ?? null,
          fileHash,
          fileByteSize: BigInt(Buffer.byteLength(data.content, "utf8")),
          rawDocument,
          parseStatus: "pending",
          importedBy: ctx.user.id,
        })
        .returning({ id: gstr2bDocuments.id });
      return row?.id ?? null;
    });

    if (!documentId) return gstr2bFail("The statement could not be stored.");

    await writeAudit(ctx, {
      action: "create",
      resourceType: "gstr2b_document",
      resourceId: documentId,
      newValue: { gstin: data.gstin, period: data.returnPeriod, fileHash },
    });

    /* --- TX 2 — THE INTERPRETATION. May fail; evidence survives. -- */

    const parsed: Gstr2bParseResult =
      data.sourceFormat === "portal_json"
        ? parseGstr2bJson(rawDocument)
        : parseGstr2bDelimited(data.content, {
            defaultSection: data.defaultSection,
            gstin: data.gstin,
            returnPeriod: data.returnPeriod,
            dateOrder: data.dateOrder,
          });

    /**
     * ⚠️ THE STATEMENT'S OWN GSTIN AND PERIOD OUTRANK WHAT THE FORM SAID.
     *
     * Picking July's file on the August screen is one wrong click and it
     * is completely silent: the credit lands in the wrong month, the
     * wrong month's suppliers are chased, and the return is filed on
     * figures for a period nobody was reconciling. The file knows which
     * month it is; the form is a guess.
     */
    if (parsed.ok && parsed.statement) {
      if (parsed.statement.gstin !== data.gstin) {
        return await failParse(
          ctx.tenant.id,
          documentId,
          `This statement was generated for GSTIN ${parsed.statement.gstin}, not ` +
            `${data.gstin}. Input tax credit belongs to the electronic credit ledger ` +
            `of the registration that received the supply (Section 16(1)) — importing ` +
            `it against another registration sets the credit in a state with nothing ` +
            `to set it against. The file has been stored and can be imported against ` +
            `the correct registration.`,
          parsed.issues,
        );
      }
      if (parsed.statement.returnPeriod !== data.returnPeriod) {
        return await failParse(
          ctx.tenant.id,
          documentId,
          `This statement covers ${parsed.statement.returnPeriod}, not ` +
            `${data.returnPeriod}. Whether a supplier filed IN THIS PERIOD is the ` +
            `entire question Section 16(2)(aa) turns on. The file has been stored.`,
          parsed.issues,
        );
      }
    }

    if (!parsed.ok) {
      const first = parsed.issues.find((i) => i.severity === "error");
      return await failParse(
        ctx.tenant.id,
        documentId,
        first
          ? `${first.path}: ${first.message}`
          : "The statement could not be parsed.",
        parsed.issues,
      );
    }

    const rowCount = await withTenant(ctx.tenant.id, async (tx) => {
      // ⚠️ Replace, never append. A re-parse of the SAME document must
      // produce the same rows, not twice as many — and the rows are
      // derived, so deleting them costs nothing. The raw document, which
      // is not derived, has no DELETE grant at all.
      await tx
        .delete(gstr2bRows)
        .where(
          and(
            eq(gstr2bRows.tenantId, ctx.tenant.id),
            eq(gstr2bRows.documentId, documentId),
          ),
        );

      if (parsed.rows.length > 0) {
        await tx.insert(gstr2bRows).values(
          parsed.rows.map((row) => ({
            tenantId: ctx.tenant.id,
            documentId,
            section: row.section,
            supplierGstin: row.supplierGstin,
            supplierLegalName: row.supplierLegalName,
            supplierTradeName: row.supplierTradeName,
            invoiceNumber: row.invoiceNumber,
            normalisedNumber: row.normalisedNumber,
            invoiceDate: row.invoiceDate,
            documentType: row.documentType,
            documentValueMinor: row.documentValueMinor,
            taxableValueMinor: row.taxableValueMinor,
            cgstMinor: row.cgstMinor,
            sgstMinor: row.sgstMinor,
            igstMinor: row.igstMinor,
            cessMinor: row.cessMinor,
            placeOfSupplyCode: row.placeOfSupplyCode,
            isReverseCharge: row.isReverseCharge,
            itcAvailable: row.itcAvailable,
            itcUnavailableReason: row.itcUnavailableReason,
            supplierFilingPeriod: row.supplierFilingPeriod,
            supplierFilingDate: row.supplierFilingDate,
            isAmendment: row.isAmendment,
            originalInvoiceNumber: row.originalInvoiceNumber,
            originalInvoiceDate: row.originalInvoiceDate,
            isCancelled: row.isCancelled,
            rateBreakup: row.rateBreakup,
            sourceRef: row.sourceRef,
          })),
        );
      }

      await tx
        .update(gstr2bDocuments)
        .set({
          parseStatus: "parsed",
          parseError: null,
          parseIssues: parsed.issues,
          rowCount: parsed.rows.length,
          parsedAt: new Date(),
          generatedOn: parsed.statement?.generatedOn ?? null,
          portalVersion: parsed.statement?.version ?? null,
        })
        .where(
          and(
            eq(gstr2bDocuments.tenantId, ctx.tenant.id),
            eq(gstr2bDocuments.id, documentId),
          ),
        );

      return parsed.rows.length;
    });

    revalidatePath("/gst/gstr2b");
    return {
      ok: true,
      data: { documentId, rowCount, parseStatus: "parsed", issues: parsed.issues },
    };
  } catch (err) {
    return toGstr2bActionError(err, "importGstr2b");
  }
}

/**
 * Record a parse failure against a document that is ALREADY STORED.
 *
 * ⚠️ THIS IS THE FUNCTION THE WHOLE TWO-TRANSACTION DESIGN EXISTS FOR. It
 * returns an error to the caller while leaving the raw file, the hash and
 * the reason on record — so a parser fixed six months later can be run
 * against the original bytes rather than against nothing.
 */
async function failParse(
  tenantId: string,
  documentId: string,
  message: string,
  issues: { path: string; message: string; severity: "error" | "warning" }[],
): Promise<ActionResult<never>> {
  await withTenant(tenantId, async (tx) =>
    tx
      .update(gstr2bDocuments)
      .set({
        parseStatus: "failed",
        parseError: message,
        parseIssues: issues,
        rowCount: 0,
        parsedAt: new Date(),
      })
      .where(
        and(eq(gstr2bDocuments.tenantId, tenantId), eq(gstr2bDocuments.id, documentId)),
      ),
  );

  return gstr2bFail(
    `${message} ⚠️ The file itself has been stored exactly as received and is not ` +
      `lost — it can be re-parsed once the problem is fixed.`,
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* ⭐ RUNNING THE ENGINE                                               */
/* ------------------------------------------------------------------ */

/**
 * ⭐ Match a period's 2B against the purchase register, and store the
 * result with its reasoning.
 *
 * ⚠️ ONE TRANSACTION, AND HERE THAT IS RIGHT — the opposite of the
 * import. Matches, the summary and the identity checks on them are a
 * single fact; a half-written run whose totals describe matches that were
 * never inserted is exactly what the deferred trigger in SQL 0024 §7
 * refuses. Nothing here is evidence that cannot be rebuilt: every match
 * is derived, deterministically, from rows that are themselves stored.
 *
 * ⚠️ AND THE OLD MATCHES ARE DELETED FIRST. Appending would match one
 * invoice to two things — the unique indexes refuse it, but by then the
 * run has half-written. Deleting is refused outright on a FILED period
 * (SQL 0024 §6), which is the case that matters.
 */
export async function runGstr2bReconciliation(input: unknown): Promise<
  ActionResult<{
    reconciliationId: string;
    matchCount: number;
    itcAtRiskMinor: string;
    reconciles: boolean;
    identityFailures: string[];
  }>
> {
  try {
    const ctx = await guardGstr2bWrite({
      operation: "gstr2b:reconcile",
      feature: "gst.gstr2b",
      permission: "gstr2b:reconcile",
    });

    const data = runReconciliationSchema.parse(input);

    /**
     * ⚠️ THE **LATEST** PARSED STATEMENT, UNLESS ONE IS NAMED.
     *
     * A period legitimately has several statements: the portal
     * regenerates 2B whenever a supplier files late, so July downloaded
     * in August and July downloaded in November are different documents
     * describing the same month, and both are evidence. Reconciling
     * against the newest is right — but `documentId` lets a working
     * paper be reproduced against the statement that WAS current when a
     * decision was taken, which is the only way "the credit was not
     * available when we filed" can be defended.
     */
    const statement = data.documentId
      ? await findGstr2bDocument(ctx.tenant.id, data.documentId)
      : await findLatestParsedStatement(ctx.tenant.id, {
          gstin: data.gstin,
          returnPeriod: data.taxPeriod,
        });

    if (!statement) {
      return gstr2bFail(
        `No GSTR-2B has been imported for ${data.gstin} for ${data.taxPeriod}. ` +
          `Reconciling against nothing would report every supplier as not having ` +
          `filed and every rupee of credit as at risk, which is indistinguishable ` +
          `from the real thing.`,
      );
    }

    const [rawRows, bookInvoices] = await Promise.all([
      listGstr2bRows(ctx.tenant.id, statement.id),
      loadBookInvoicesForPeriod(ctx.tenant.id, {
        gstin: data.gstin,
        taxPeriod: data.taxPeriod,
      }),
    ]);

    const twoBRows = rawRows.map(toTwoBRowFacts);

    const tolerance =
      data.toleranceMinor === undefined
        ? DEFAULT_MATCH_TOLERANCE
        : {
            taxableValueMinor: BigInt(data.toleranceMinor),
            headMinor: BigInt(data.toleranceMinor),
            totalTaxMinor: BigInt(data.toleranceMinor),
            invoiceDateDays: 0,
          };

    const matches = reconcileGstr2b({ twoBRows, bookInvoices, tolerance });

    /* --- What the ITC register says was actually claimed --------- */
    const claimed = await withTenant(ctx.tenant.id, async (tx) => {
      const rows = await tx
        .select({
          total: sql<string>`COALESCE(sum(${itcRegister.cgstMinor}
            + ${itcRegister.sgstMinor} + ${itcRegister.igstMinor}
            + ${itcRegister.cessMinor}) FILTER (WHERE ${itcRegister.status} = 'claimed'), 0)
            - COALESCE(sum(${itcRegister.cgstMinor} + ${itcRegister.sgstMinor}
            + ${itcRegister.igstMinor} + ${itcRegister.cessMinor})
            FILTER (WHERE ${itcRegister.status} = 'reversed'), 0)`,
        })
        .from(itcRegister)
        .where(
          and(
            eq(itcRegister.tenantId, ctx.tenant.id),
            eq(itcRegister.taxPeriod, data.taxPeriod),
          ),
        );
      return toBigIntAmount(rows[0]?.total ?? 0);
    });

    const summary = summariseReconciliation({
      taxPeriod: data.taxPeriod,
      matches,
      bookInvoices,
      twoBRows,
      itcClaimedMinor: claimed,
    });

    const reconciliationId = await withTenant(ctx.tenant.id, async (tx) => {
      const existing = await tx
        .select({ id: gstr2bReconciliations.id })
        .from(gstr2bReconciliations)
        .where(
          and(
            eq(gstr2bReconciliations.tenantId, ctx.tenant.id),
            eq(gstr2bReconciliations.gstin, data.gstin),
            eq(gstr2bReconciliations.taxPeriod, data.taxPeriod),
          ),
        )
        .limit(1);

      const totals = {
        registrationId: data.registrationId ?? statement.registrationId ?? null,
        documentId: statement.id,
        status: "in_progress" as const,
        booksInvoiceCount: summary.books.count,
        booksTaxableMinor: summary.books.taxableMinor,
        booksTaxMinor: summary.books.totalTaxMinor,
        booksItcEligibleMinor: summary.itcAsPerBooksMinor,
        twobRowCount: summary.twoB.count,
        twobTaxableMinor: summary.twoB.taxableMinor,
        twobTaxMinor: summary.twoB.totalTaxMinor,
        twobItcAvailableMinor: summary.itcAsPerTwoBMinor,
        matchedCount: summary.matched.count,
        matchedBooksTaxMinor: summary.matched.booksTaxMinor,
        matchedTwobTaxMinor: summary.matched.twoBTaxMinor,
        inBooksNotIn2bCount: summary.inBooksNotIn2B.count,
        inBooksNotIn2bTaxMinor: summary.inBooksNotIn2B.totalTaxMinor,
        itcAtRiskMinor: summary.inBooksNotIn2B.itcAtRiskMinor,
        in2bNotInBooksCount: summary.in2BNotInBooks.count,
        in2bNotInBooksTaxMinor: summary.in2BNotInBooks.totalTaxMinor,
        itcClaimedMinor: claimed,
        engineVersion: MATCH_ENGINE_VERSION,
        lastRunAt: new Date(),
      };

      let id = existing[0]?.id ?? null;
      if (id) {
        // ⚠️ Matches first. The deferred summary trigger compares the
        // stored totals against the matches AT COMMIT, so the order
        // inside the transaction does not matter to it — but the unique
        // one-to-one indexes are immediate, and re-inserting before
        // deleting would collide with the previous run.
        await tx
          .delete(gstr2bMatches)
          .where(
            and(
              eq(gstr2bMatches.tenantId, ctx.tenant.id),
              eq(gstr2bMatches.reconciliationId, id),
            ),
          );
        await tx
          .update(gstr2bReconciliations)
          .set(totals)
          .where(
            and(
              eq(gstr2bReconciliations.tenantId, ctx.tenant.id),
              eq(gstr2bReconciliations.id, id),
            ),
          );
      } else {
        const [row] = await tx
          .insert(gstr2bReconciliations)
          .values({
            tenantId: ctx.tenant.id,
            gstin: data.gstin,
            taxPeriod: data.taxPeriod,
            createdBy: ctx.user.id,
            ...totals,
          })
          .returning({ id: gstr2bReconciliations.id });
        id = row?.id ?? null;
      }

      if (!id) return null;

      if (matches.length > 0) {
        await tx.insert(gstr2bMatches).values(
          matches.map((match) => ({
            tenantId: ctx.tenant.id,
            reconciliationId: id,
            gstr2bRowId: match.twoBRowId,
            purchaseInvoiceId: match.bookInvoiceId,
            vendorId: match.vendorId,
            supplierGstin: match.supplierGstin,
            matchCategory: match.category,
            confidence: match.confidence,
            matchScore: match.score,
            matchedOn: match.matchedOn,
            differences: match.differences,
            taxableDeltaMinor: match.taxableDeltaMinor,
            taxDeltaMinor: match.taxDeltaMinor,
            itcAtRiskMinor: match.itcAtRiskMinor,
            ambiguousCandidates: match.ambiguousCandidates,
            explanation: match.explanation,
            engineVersion: match.engineVersion,
            // ⭐ ONLY AN EXACT MATCH IS ACCEPTED WITHOUT A HUMAN. The
            // database refuses anything else with no `action_by`
            // (`gstr2b_matches_no_silent_auto_accept`); this is the
            // engine agreeing with it rather than testing it.
            action: match.autoAcceptable ? ("accepted" as const) : ("pending" as const),
            actionAt: match.autoAcceptable ? new Date() : null,
          })),
        );
      }

      return id;
    });

    if (!reconciliationId) return gstr2bFail("The reconciliation could not be stored.");

    await writeAudit(ctx, {
      action: "update",
      resourceType: "gstr2b_reconciliation",
      resourceId: reconciliationId,
      newValue: {
        gstin: data.gstin,
        period: data.taxPeriod,
        matches: matches.length,
        itcAtRisk: summary.inBooksNotIn2B.itcAtRiskMinor.toString(),
        engineVersion: MATCH_ENGINE_VERSION,
      },
    });

    revalidatePath("/gst/gstr2b");
    return {
      ok: true,
      data: {
        reconciliationId,
        matchCount: matches.length,
        itcAtRiskMinor: serializeAmount(summary.inBooksNotIn2B.itcAtRiskMinor),
        reconciles: summary.reconciles,
        identityFailures: summary.identityFailures,
      },
    };
  } catch (err) {
    return toGstr2bActionError(err, "runGstr2bReconciliation");
  }
}

/* ------------------------------------------------------------------ */
/* READS                                                               */
/* ------------------------------------------------------------------ */

export async function getGstr2bDocuments(
  gstin?: string,
  returnPeriod?: string,
): Promise<ActionResult<{ rows: Gstr2bDocumentRow[] }>> {
  try {
    // ⚠️ READ: permission only. An entitlement gate here would refuse to
    // RENDER the page rather than refusing the button on it.
    const ctx = await requirePermission("gstr2b:read");
    const rows = await listGstr2bDocuments(ctx.tenant.id, { gstin, returnPeriod });
    return {
      ok: true,
      data: {
        rows: rows.map((row) => ({
          id: row.id,
          gstin: row.gstin,
          returnPeriod: row.returnPeriod,
          sourceFormat: row.sourceFormat,
          fileName: row.fileName,
          fileHash: row.fileHash,
          generatedOn: row.generatedOn,
          parseStatus: row.parseStatus,
          parseError: row.parseError,
          parseIssues: row.parseIssues ?? [],
          rowCount: row.rowCount,
          createdAt: row.createdAt.toISOString(),
        })),
      },
    };
  } catch (err) {
    return toGstr2bActionError(err, "getGstr2bDocuments");
  }
}

export async function getGstr2bReconciliations(): Promise<
  ActionResult<{
    rows: {
      id: string;
      gstin: string;
      taxPeriod: string;
      status: string;
      itcAtRiskMinor: string;
      booksItcEligibleMinor: string;
      twobItcAvailableMinor: string;
      itcClaimedMinor: string;
      filedAt: string | null;
      filedReference: string | null;
    }[];
  }>
> {
  try {
    const ctx = await requirePermission("gstr2b:read");
    const rows = await listReconciliations(ctx.tenant.id);
    return {
      ok: true,
      data: {
        rows: rows.map((row) => ({
          id: row.id,
          gstin: row.gstin,
          taxPeriod: row.taxPeriod,
          status: row.status,
          itcAtRiskMinor: serializeAmount(row.itcAtRiskMinor),
          booksItcEligibleMinor: serializeAmount(row.booksItcEligibleMinor),
          twobItcAvailableMinor: serializeAmount(row.twobItcAvailableMinor),
          itcClaimedMinor: serializeAmount(row.itcClaimedMinor),
          filedAt: row.filedAt?.toISOString() ?? null,
          filedReference: row.filedReference,
        })),
      },
    };
  } catch (err) {
    return toGstr2bActionError(err, "getGstr2bReconciliations");
  }
}

/** ⭐ The mismatch workbench. */
export async function getGstr2bWorklist(
  input: unknown,
): Promise<ActionResult<{ reconciliationId: string; rows: Gstr2bMatchRow[] }>> {
  try {
    const ctx = await requirePermission("gstr2b:read");
    const data = worklistQuerySchema.parse(input);

    const reconciliation = await findReconciliation(ctx.tenant.id, {
      gstin: data.gstin,
      taxPeriod: data.taxPeriod,
    });
    if (!reconciliation) {
      return gstr2bFail(
        `Nothing has been reconciled for ${data.gstin} for ${data.taxPeriod} yet.`,
      );
    }

    const rows = await listMatches(ctx.tenant.id, reconciliation.id, {
      category: data.category,
      action: data.action,
      limit: data.limit,
    });

    return {
      ok: true,
      data: {
        reconciliationId: reconciliation.id,
        rows: rows.map((row) => ({
          id: row.id,
          category: row.matchCategory,
          confidence: row.confidence,
          score: row.matchScore,
          supplierGstin: row.supplierGstin,
          gstr2bRowId: row.gstr2bRowId,
          purchaseInvoiceId: row.purchaseInvoiceId,
          matchedOn: row.matchedOn,
          differences: row.differences,
          taxableDeltaMinor: serializeAmount(row.taxableDeltaMinor),
          taxDeltaMinor: serializeAmount(row.taxDeltaMinor),
          itcAtRiskMinor: serializeAmount(row.itcAtRiskMinor),
          ambiguousCandidates: row.ambiguousCandidates,
          explanation: row.explanation,
          action: row.action,
          actionReason: row.actionReason,
          actionBy: row.actionBy,
        })),
      },
    };
  } catch (err) {
    return toGstr2bActionError(err, "getGstr2bWorklist");
  }
}

/**
 * ⭐ The reconciliation summary: books vs 2B vs claimed, reconciling
 * exactly.
 *
 * ⚠️ RE-COMPUTED FROM THE ROWS RATHER THAN READ OFF THE STORED TOTALS,
 * for an UNFILED period. The stored totals are what the last run
 * produced; the rows are what is true now, and between the two somebody
 * may have entered the missing bill. For a FILED period the stored totals
 * ARE the answer — they are what the return was built from — and that is
 * why they are frozen rather than derived.
 */
export async function getGstr2bSummary(input: unknown): Promise<
  ActionResult<{
    taxPeriod: string;
    itcAsPerBooksMinor: string;
    itcAsPerTwoBMinor: string;
    itcClaimedMinor: string;
    booksVsTwoBMinor: string;
    claimedVsTwoBMinor: string;
    booksTaxMinor: string;
    matchedBooksTaxMinor: string;
    inBooksNotIn2BTaxMinor: string;
    twoBTaxMinor: string;
    matchedTwoBTaxMinor: string;
    in2BNotInBooksTaxMinor: string;
    reconciles: boolean;
    identityFailures: string[];
  }>
> {
  try {
    const ctx = await requirePermission("gstr2b:read");
    const data = runReconciliationSchema.parse(input);

    const statement = await findLatestParsedStatement(ctx.tenant.id, {
      gstin: data.gstin,
      returnPeriod: data.taxPeriod,
    });
    const reconciliation = await findReconciliation(ctx.tenant.id, {
      gstin: data.gstin,
      taxPeriod: data.taxPeriod,
    });

    if (!statement || !reconciliation) {
      return gstr2bFail(
        `Nothing has been reconciled for ${data.gstin} for ${data.taxPeriod} yet.`,
      );
    }

    const [rawRows, bookInvoices, storedMatches] = await Promise.all([
      listGstr2bRows(ctx.tenant.id, statement.id),
      loadBookInvoicesForPeriod(ctx.tenant.id, {
        gstin: data.gstin,
        taxPeriod: data.taxPeriod,
      }),
      listMatches(ctx.tenant.id, reconciliation.id, { limit: 100_000 }),
    ]);

    const summary = summariseReconciliation({
      taxPeriod: data.taxPeriod,
      matches: storedMatches.map((row) => ({
        category: row.matchCategory,
        confidence: row.confidence,
        score: row.matchScore,
        twoBRowId: row.gstr2bRowId,
        bookInvoiceId: row.purchaseInvoiceId,
        supplierGstin: row.supplierGstin,
        vendorId: row.vendorId,
        matchedOn: [],
        differences: [],
        taxableDeltaMinor: toBigIntAmount(row.taxableDeltaMinor),
        taxDeltaMinor: toBigIntAmount(row.taxDeltaMinor),
        itcAtRiskMinor: toBigIntAmount(row.itcAtRiskMinor),
        ambiguousCandidates: row.ambiguousCandidates,
        autoAcceptable: row.matchCategory === "exact",
        explanation: row.explanation,
        engineVersion: row.engineVersion,
      })),
      bookInvoices,
      twoBRows: rawRows.map(toTwoBRowFacts),
      itcClaimedMinor: toBigIntAmount(reconciliation.itcClaimedMinor),
    });

    return {
      ok: true,
      data: {
        taxPeriod: summary.taxPeriod,
        itcAsPerBooksMinor: serializeAmount(summary.itcAsPerBooksMinor),
        itcAsPerTwoBMinor: serializeAmount(summary.itcAsPerTwoBMinor),
        itcClaimedMinor: serializeAmount(summary.itcClaimedMinor),
        booksVsTwoBMinor: serializeAmount(summary.booksVsTwoBMinor),
        claimedVsTwoBMinor: serializeAmount(summary.claimedVsTwoBMinor),
        booksTaxMinor: serializeAmount(summary.books.totalTaxMinor),
        matchedBooksTaxMinor: serializeAmount(summary.matched.booksTaxMinor),
        inBooksNotIn2BTaxMinor: serializeAmount(summary.inBooksNotIn2B.totalTaxMinor),
        twoBTaxMinor: serializeAmount(summary.twoB.totalTaxMinor),
        matchedTwoBTaxMinor: serializeAmount(summary.matched.twoBTaxMinor),
        in2BNotInBooksTaxMinor: serializeAmount(summary.in2BNotInBooks.totalTaxMinor),
        reconciles: summary.reconciles,
        identityFailures: summary.identityFailures,
      },
    };
  } catch (err) {
    return toGstr2bActionError(err, "getGstr2bSummary");
  }
}

/** ⭐ Who has not filed, how much is at stake, and how old it is. */
export async function getVendorChase(input: unknown): Promise<
  ActionResult<{
    asOf: string;
    totalAtRiskMinor: string;
    totalLostMinor: string;
    rows: {
      supplierGstin: string | null;
      vendorId: string | null;
      vendorName: string | null;
      invoiceCount: number;
      itcAtRiskMinor: string;
      itcLostMinor: string;
      oldestInvoiceDate: string;
      oldestAgeDays: number;
      buckets: { label: string; invoiceCount: number; itcAtRiskMinor: string }[];
    }[];
  }>
> {
  try {
    const ctx = await requirePermission("gstr2b:read");
    const data = chaseQuerySchema.parse(input);
    const asOf = data.asOf ?? new Date().toISOString().slice(0, 10);

    const reconciliation = await findReconciliation(ctx.tenant.id, {
      gstin: data.gstin,
      taxPeriod: data.taxPeriod,
    });
    if (!reconciliation) {
      return gstr2bFail(
        `Nothing has been reconciled for ${data.gstin} for ${data.taxPeriod} yet.`,
      );
    }

    const [storedMatches, bookInvoices] = await Promise.all([
      listMatches(ctx.tenant.id, reconciliation.id, { limit: 100_000 }),
      loadBookInvoicesForPeriod(ctx.tenant.id, {
        gstin: data.gstin,
        taxPeriod: data.taxPeriod,
      }),
    ]);

    const rows = chaseVendors({
      asOf,
      bookInvoices,
      matches: storedMatches.map((row) => ({
        category: row.matchCategory,
        confidence: row.confidence,
        score: row.matchScore,
        twoBRowId: row.gstr2bRowId,
        bookInvoiceId: row.purchaseInvoiceId,
        supplierGstin: row.supplierGstin,
        vendorId: row.vendorId,
        matchedOn: [],
        differences: [],
        taxableDeltaMinor: toBigIntAmount(row.taxableDeltaMinor),
        taxDeltaMinor: toBigIntAmount(row.taxDeltaMinor),
        itcAtRiskMinor: toBigIntAmount(row.itcAtRiskMinor),
        ambiguousCandidates: row.ambiguousCandidates,
        autoAcceptable: false,
        explanation: row.explanation,
        engineVersion: row.engineVersion,
      })),
    });

    return {
      ok: true,
      data: {
        asOf,
        totalAtRiskMinor: serializeAmount(totalItcAtRisk(rows)),
        totalLostMinor: serializeAmount(totalItcLost(rows)),
        rows: rows.map((row) => ({
          supplierGstin: row.supplierGstin,
          vendorId: row.vendorId,
          vendorName: row.vendorName,
          invoiceCount: row.invoiceCount,
          itcAtRiskMinor: serializeAmount(row.itcAtRiskMinor),
          itcLostMinor: serializeAmount(row.itcLostMinor),
          oldestInvoiceDate: row.oldestInvoiceDate,
          oldestAgeDays: row.oldestAgeDays,
          buckets: row.buckets.map((bucket) => ({
            label: bucket.label,
            invoiceCount: bucket.invoiceCount,
            itcAtRiskMinor: serializeAmount(bucket.itcAtRiskMinor),
          })),
        })),
      },
    };
  } catch (err) {
    return toGstr2bActionError(err, "getVendorChase");
  }
}

/* ------------------------------------------------------------------ */
/* ⭐ THE WORKBENCH                                                    */
/* ------------------------------------------------------------------ */

/**
 * Accept, reject or defer one proposed match.
 *
 * ⚠️ `actionBy` IS ALWAYS SET HERE, INCLUDING ON AN ACCEPT OF AN EXACT
 * MATCH. The database only REQUIRES it below `exact`, but a person who
 * clicked accept did decide, and recording that they did is free. What
 * the constraint prevents is the reverse — a machine accepting something
 * with nobody named.
 */
export async function decideGstr2bMatch(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardGstr2bWrite({
      operation: "gstr2b:reconcile",
      feature: "gst.gstr2b",
      permission: "gstr2b:reconcile",
    });

    const data = decideMatchSchema.parse(input);

    const existing = await findMatch(ctx.tenant.id, data.matchId);
    if (!existing) return gstr2bFail("That exception no longer exists.");

    await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .update(gstr2bMatches)
        .set({
          action: data.action,
          actionReason: data.reason ?? null,
          actionBy: ctx.user.id,
          actionAt: new Date(),
        })
        .where(
          and(eq(gstr2bMatches.tenantId, ctx.tenant.id), eq(gstr2bMatches.id, data.matchId)),
        ),
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "gstr2b_match",
      resourceId: data.matchId,
      oldValue: { action: existing.action },
      newValue: { action: data.action, category: existing.matchCategory },
      reason: data.reason ?? undefined,
    });

    revalidatePath("/gst/gstr2b");
    return { ok: true, data: { id: data.matchId } };
  } catch (err) {
    return toGstr2bActionError(err, "decideGstr2bMatch");
  }
}

/**
 * ⭐ Bulk accept, reject or defer.
 *
 * ⚠️ THE BATCH IS CAPPED IN THE SCHEMA AT 500, and not for performance.
 * An "accept all 4,000" button is not a review. A cap is the only thing
 * that keeps the action a decision somebody made rather than a gesture,
 * and it is exactly the kind of limit that gets raised in a later phase
 * by somebody who has never had to defend a match.
 */
export async function bulkDecideGstr2bMatches(
  input: unknown,
): Promise<ActionResult<{ updated: number }>> {
  try {
    const ctx = await guardGstr2bWrite({
      operation: "gstr2b:reconcile",
      feature: "gst.gstr2b",
      permission: "gstr2b:reconcile",
    });

    const data = bulkDecideMatchesSchema.parse(input);

    const updated = await withTenant(ctx.tenant.id, async (tx) => {
      const rows = await tx
        .update(gstr2bMatches)
        .set({
          action: data.action,
          actionReason: data.reason ?? null,
          actionBy: ctx.user.id,
          actionAt: new Date(),
        })
        .where(
          and(
            eq(gstr2bMatches.tenantId, ctx.tenant.id),
            inArray(gstr2bMatches.id, data.matchIds),
          ),
        )
        .returning({ id: gstr2bMatches.id });
      return rows.length;
    });

    await writeAudit(ctx, {
      action: "update",
      resourceType: "gstr2b_match",
      resourceId: `bulk:${data.matchIds.length}`,
      newValue: { action: data.action, count: updated },
      reason: data.reason ?? undefined,
    });

    revalidatePath("/gst/gstr2b");
    return { ok: true, data: { updated } };
  } catch (err) {
    return toGstr2bActionError(err, "bulkDecideGstr2bMatches");
  }
}

/* ------------------------------------------------------------------ */
/* ⭐ FILING — THE ONE-WAY DOOR                                        */
/* ------------------------------------------------------------------ */

/**
 * ⭐ Freeze a period.
 *
 * ⚠️ THE PRE-CONDITION IS THE INTERESTING PART: a reconciliation that
 * does not add up may not be filed. The identity is checked here, on the
 * rows as they are NOW — not on the totals the last run stored — because
 * between the run and the filing somebody may have entered the missing
 * bill, and filing on stale figures is the specific accident this whole
 * phase exists to prevent.
 *
 * ⚠️ AND THERE IS NO WAY BACK. A return that has been filed cannot be
 * unfiled. A period that turns out to be wrong is corrected in a LATER
 * period, which is how the electronic credit ledger itself behaves and
 * the only way the books can go on agreeing with the returns already
 * submitted.
 */
export async function fileGstr2bReconciliation(
  input: unknown,
): Promise<ActionResult<{ id: string; filedAt: string }>> {
  try {
    const ctx = await guardGstr2bWrite({
      operation: "gstr2b:file",
      feature: "gst.gstr2b",
      permission: "gstr2b:file",
    });

    const data = fileReconciliationSchema.parse(input);

    const reconciliation = await findReconciliation(ctx.tenant.id, {
      gstin: data.gstin,
      taxPeriod: data.taxPeriod,
    });
    if (!reconciliation) {
      return gstr2bFail(
        `There is no reconciliation for ${data.gstin} for ${data.taxPeriod}. A return ` +
          `filed without one is a return nobody checked against 2B.`,
      );
    }
    if (reconciliation.status === "filed") {
      return gstr2bFail(
        `${data.taxPeriod} has already been filed (${reconciliation.filedReference ?? "no ARN recorded"}). ` +
          `A return that has been filed cannot be unfiled — correct it in a later ` +
          `period, which is how the electronic credit ledger itself behaves.`,
      );
    }

    const summary = await getGstr2bSummary({
      gstin: data.gstin,
      taxPeriod: data.taxPeriod,
    });
    if (!summary.ok) return summary;
    if (!summary.data.reconciles) {
      return gstr2bFail(
        `This reconciliation does not add up and must not be filed from. ` +
          summary.data.identityFailures.join(" "),
      );
    }

    const filedAt = new Date();

    await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .update(gstr2bReconciliations)
        .set({
          status: "filed",
          filedAt,
          filedBy: ctx.user.id,
          filedReference: data.filedReference,
          itcClaimedMinor: data.itcClaimedMinor
            ? BigInt(data.itcClaimedMinor)
            : reconciliation.itcClaimedMinor,
          notes: data.notes ?? reconciliation.notes,
        })
        .where(
          and(
            eq(gstr2bReconciliations.tenantId, ctx.tenant.id),
            eq(gstr2bReconciliations.id, reconciliation.id),
          ),
        ),
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "gstr2b_reconciliation",
      resourceId: reconciliation.id,
      oldValue: { status: reconciliation.status },
      newValue: { status: "filed", filedReference: data.filedReference },
      reason: data.notes ?? undefined,
    });

    revalidatePath("/gst/gstr2b");
    return { ok: true, data: { id: reconciliation.id, filedAt: filedAt.toISOString() } };
  } catch (err) {
    return toGstr2bActionError(err, "fileGstr2bReconciliation");
  }
}
